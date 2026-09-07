import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPaseoApi } from '../paseo-plugin/node_modules/@getpaseo/client/dist/index.js';
import { createPlacedAgent } from '../paseo-plugin/host/spawn-agent.mjs';
import { createRuntime } from '../paseo-plugin/host/runtime.mjs';
import { ticketWrite } from '../paseo-plugin/host/workflow/ticket.mjs';

// Use the actual SDK adapter: parent ownership must not override placement.
const requests = [];
const sdk = createPaseoApi({
  createWorkspace: async input => {
    requests.push(input);
    return { workspace: { id: 'worktree', workspaceDirectory: input.source.path } };
  },
  createAgent: async input => {
    requests.push(input);
    const cwd = input.workspaceId === 'worktree' ? '/prepared' : '/parent';
    return { id: 'child', cwd, workspaceId: input.workspaceId };
  },
});
const handle = await createPlacedAgent(sdk, {
  config: { provider: 'architect-mini/grok-4.6' }, parent: 'parent',
  cwd: '/prepared', labels: { role: 'implementer' },
});
assert.equal(handle.cwd, '/prepared');
assert.deepEqual(requests[0].source, { kind: 'directory', path: '/prepared' });
assert.equal(requests[1].workspaceId, 'worktree');
assert.equal(requests[1].callerAgentId, 'parent');
let created = false;
await assert.rejects(createPlacedAgent({ workspaces: { ref: () => ({ directory: '/wrong', agents: { create() { created = true; } } }) } }, { cwd: '/prepared', workspaceId: 'wrong' }), /does not match/);
assert.equal(created, false);

const root = mkdtempSync(join(tmpdir(), 'architect-recovery-routing-'));
try {
  for (const kind of ['bounded', 'open']) {
    for (const completion of ['implement', 'report']) {
      const effects = [];
      const runtime = createRuntime({
        isGitRepo: async () => true,
        commitIfDirty: async () => { effects.push('commit'); return { committed: false, sha: 'same' }; },
        buildReviewPacket: async () => ({ baseSha: 'same', headSha: 'same', files: [] }),
        ocrReview: async () => { effects.push('review'); return []; },
        createAndMergePr: async () => { effects.push('publish'); },
        hasRemote: async () => true,
      });
      const job = { id: `${kind}-${completion}`, agentId: 'child', role: 'implementer', kind, completion, status: 'running', cwd: root, parent: 'parent' };
      runtime.jobs.set(job.id, job);
      await runtime.handleTool('done', { answer: 'Collected evidence.' }, { jobId: job.id });
      await runtime.flush();
      assert.equal(runtime.jobs.get(job.id).result.action, 'wake_architect');
      if (completion === 'report') {
        assert.deepEqual(effects, []);
        assert.equal(runtime.jobs.get(job.id).status, 'succeeded');
        assert.equal(runtime.takeWakes('parent')[0].text, 'Collected evidence.');
      } else {
        assert.deepEqual(effects, ['commit']);
        assert.equal(runtime.jobs.get(job.id).status, 'failed');
        assert.match(runtime.jobs.get(job.id).error, /No changes found/);
      }
      await runtime.close();
    }
  }
  await ticketWrite(root, { text: '# Ticket\n\n## Kind\n\nopen\n' });
  const runtime = createRuntime({
    reconcileSpawn: async () => null,
    createWorktree: async () => ({ cwd: '/prepared', workspaceId: null }), indexWorkspace: async () => {},
    spawnExec: async () => ({ stdout: JSON.stringify({ id: 'misplaced', cwd: '/parent', workspaceId: 'parent' }) }),
  });
  await assert.rejects(runtime.handleTool('delegate', { to: 'implementer', kind: 'open' }, { cwd: root, agentId: 'parent' }), /does not match/);
  const [job] = runtime.jobs.values();
  assert.equal(job.status, 'uncertain');
  assert.equal(job.agentId, 'misplaced');
  const retry = await runtime.handleTool('delegate', { to: 'implementer', kind: 'open' }, { cwd: root, agentId: 'parent' });
  assert.equal(retry.started, false);
  await runtime.close();

  let spawns = 0;
  const correction = createRuntime({
    reconcileSpawn: async () => null,
    createWorktree: async () => ({ cwd: '/prepared', workspaceId: null }), indexWorkspace: async () => {},
    spawnExec: async () => ({ stdout: JSON.stringify({ id: `worker-${++spawns}`, cwd: spawns === 1 ? '/prepared' : '/parent' }) }),
    isGitRepo: async () => true,
    commitIfDirty: async () => ({ committed: true, sha: 'head' }),
    buildReviewPacket: async () => ({ baseSha: 'base', headSha: 'head', files: [{ path: 'fix.mjs' }] }),
    ocrReview: async () => [{ path: 'fix.mjs', line: 1, body: 'Fix the regression' }],
  });
  const initial = await correction.handleTool('delegate', { to: 'implementer', kind: 'open' }, { cwd: root, agentId: 'parent' });
  await correction.handleTool('done', {}, { agentId: initial.agentId });
  await correction.flush();
  const original = [...correction.jobs.values()].find(job => job.agentId === initial.agentId);
  assert.equal(original.status, 'awaiting_correction');
  assert.equal(correction.jobs.get(original.correctionJobId).status, 'uncertain');
  const repeated = await correction.handleTool('delegate', { to: 'implementer', kind: 'open' }, { cwd: root, agentId: 'parent' });
  assert.equal(repeated.started, false);
  assert.equal(spawns, 2, 'a misplaced correction must block a third worker');
  await correction.close();
} finally { rmSync(root, { recursive: true, force: true }); }
