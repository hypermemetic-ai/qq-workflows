import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPaseoApi } from '../paseo-plugin/node_modules/@getpaseo/client/dist/index.js';
import { createPlacedAgent } from '../paseo-plugin/host/spawn-agent.mjs';
import { createRuntime } from '../paseo-plugin/host/runtime.mjs';
import { ticketWrite } from '../paseo-plugin/host/workflow/ticket.mjs';

// Spawning delegates must not create top-level workspaces; subagents belong to parent workspace.
const requests = [];
let workspaceCreated = false;
const sdk = createPaseoApi({
  createWorkspace: async input => {
    workspaceCreated = true;
    requests.push(input);
    return { workspace: { id: 'worktree', workspaceDirectory: input.source.path } };
  },
  getWorkspace: async ({ id }) => ({ workspace: { id, workspaceDirectory: '/parent-ws-dir' } }),
  createAgent: async input => {
    requests.push(input);
    return { id: 'child', cwd: input.config?.cwd, workspaceId: input.workspaceId };
  },
});
const handle = await createPlacedAgent(sdk, {
  workspaceId: 'parent-ws',
  config: { provider: 'architect-mini/grok-4.6' }, parent: 'parent',
  cwd: '/prepared', labels: { role: 'implementer' },
});
assert.equal(workspaceCreated, false, 'spawning delegates must not call createWorkspace');
assert.equal(handle.cwd, '/prepared');
assert.equal(requests.length, 1);
assert.equal(requests[0].workspaceId, 'parent-ws');
assert.equal(requests[0].callerAgentId, 'parent');
assert.equal(requests[0].config.cwd, '/prepared');

// Mismatched cwd is accepted without throwing; placement preserves child checkout.
let workspaceAgentsCreated = false;
const mismatched = await createPlacedAgent({
  workspaces: { ref: () => ({ directory: '/parent-dir', agents: { create() { workspaceAgentsCreated = true; } } }) },
  agents: { create: async (opts, placement) => ({ id: 'child', cwd: opts.cwd, workspaceId: placement.workspaceId }) },
}, { cwd: '/prepared', workspaceId: 'parent-ws' });
assert.equal(workspaceAgentsCreated, false);
assert.equal(mismatched.cwd, '/prepared');
assert.equal(mismatched.workspaceId, 'parent-ws');

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
  let preparations = 0, indexes = 0, preparationSpawns = 0;
  const preparation = createRuntime({
    createWorktree: async () => { preparations++; return { cwd: '/prepared-retry', workspaceId: null }; },
    indexWorkspace: async () => { if (++indexes === 1) throw new Error('Index permission denied'); },
    spawnExec: async () => { preparationSpawns++; return { stdout: JSON.stringify({ id: 'prepared-child', cwd: '/prepared-retry' }) }; },
  });
  const context = { cwd: root, agentId: 'preparation-parent' };
  await assert.rejects(preparation.handleTool('delegate', { to: 'implementer', kind: 'open' }, context), /permission denied/);
  const [preparedJob] = preparation.jobs.values();
  assert.equal(preparedJob.status, 'failed');
  assert.equal(preparedJob.worktreeCwd, '/prepared-retry', 'persist checkout before indexing');
  assert.equal(preparation.store.get('job', preparedJob.id).worktreeCwd, '/prepared-retry');
  assert.equal(preparationSpawns, 0);
  await ticketWrite(root, { text: '# Ticket\n\n## Kind\n\nopen\n\nRead-only discovery.\n' });
  const resumed = await preparation.handleTool('delegate', { to: 'implementer', kind: 'open', completion: 'report' }, context);
  assert.equal(resumed.started, true);
  assert.equal(preparation.jobs.size, 1, 'retry owns the same job');
  assert.equal(preparedJob.completion, 'report', 'use the authorized completion contract at retry');
  assert.match(preparedJob.task, /Read-only discovery/);
  assert.match(preparedJob.preparationFailures[0].error, /permission denied/);
  assert.equal(indexes, 1, 'report-only retry skips semantic indexing');
  assert.equal(preparations, 1);
  assert.equal(preparationSpawns, 1);
  assert.equal((await preparation.handleTool('delegate', { to: 'implementer', kind: 'open', completion: 'report' }, context)).started, false);
  await preparation.close();
  let busySpawns = 0;
  const busyPreparation = createRuntime({
    createWorktree: async () => ({ cwd: '/busy-prepared', workspaceId: null }),
    indexWorkspace: async (cwd, options) => { assert.equal(options.waitForLock, false); throw new Error('ZVEC_GREP.ENGINE.LOCK.BUSY'); },
    spawnExec: async (command, args, options) => {
      busySpawns++;
      assert.match(options.input, /Semantic indexing is busy/);
      return { stdout: JSON.stringify({ id: 'busy-child', cwd: '/busy-prepared' }) };
    },
  });
  const busyResult = await busyPreparation.handleTool('delegate', { to: 'implementer', kind: 'open' }, context);
  assert.equal(busyResult.started, true);
  assert.equal(busySpawns, 1, 'lock contention does not fail workspace preparation');
  assert.match([...busyPreparation.jobs.values()][0].indexWarning, /exact search/);
  await busyPreparation.close();

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
