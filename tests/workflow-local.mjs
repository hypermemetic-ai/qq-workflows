import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPaseoApi } from '../paseo-plugin/node_modules/@getpaseo/client/dist/index.js';
import { createPlacedAgent } from '../paseo-plugin/host/spawn-agent.mjs';
import { createRuntime } from '../paseo-plugin/host/runtime.mjs';

// Exercise one complete host workflow with real worktrees, commits, review
// packets and local landing. Only model/daemon execution is a fixture.
const root = mkdtempSync(join(tmpdir(), 'architect-workflow-local-'));
const priorHome = process.env.PASEO_HOME;
process.env.PASEO_HOME = join(root, 'paseo');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  for (const scenario of ['bounded', 'open', 'correction', 'report']) {
    const repo = join(root, scenario);
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.name', 'Workflow fixture');
    git(repo, 'config', 'user.email', 'fixture@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    mkdirSync(join(repo, '.architect'));
    const kind = scenario === 'bounded' ? 'bounded' : 'open';
    writeFileSync(join(repo, '.architect/ticket.md'), `# Fixture\n\n## Kind\n\n${kind}\n`);
    writeFileSync(join(repo, 'result.txt'), 'baseline\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Baseline');
    const baseline = git(repo, 'rev-parse', 'HEAD');
    let workspaceCreated = false;
    const workers = [];
    const sdk = createPaseoApi({
      createWorkspace: async input => {
        workspaceCreated = true;
        return { workspace: { id: 'workspace-unexpected', workspaceDirectory: input.source.path } };
      },
      createAgent: async input => {
        assert.equal(input.callerAgentId, 'architect-parent');
        const cwd = input.config?.cwd;
        assert.ok(cwd && cwd !== repo);
        const id = `worker-${workers.length}`;
        workers.push({ id, cwd });
        if (scenario !== 'report') writeFileSync(join(cwd, 'result.txt'), `implementation ${workers.length}\n`);
        return { id, cwd, workspaceId: input.workspaceId };
      },
    });
    let reviews = 0;
    const runtime = createRuntime({
      indexWorkspace: async () => {},
      spawnExec: async (command, args, { input }) => {
        const child = await createPlacedAgent(sdk, JSON.parse(input));
        return { stdout: JSON.stringify({ id: child.id, cwd: child.cwd, workspaceId: child.workspaceId }) };
      },
      ocrReview: async (cwd, { from, to }) => {
        reviews++;
        assert.equal(from, baseline);
        assert.equal(to, git(cwd, 'rev-parse', 'HEAD'));
        assert.equal(git(cwd, 'diff', '--name-only', from, to), 'result.txt');
        assert.equal(git(repo, 'rev-parse', 'HEAD'), baseline, 'review precedes landing');
        return scenario === 'correction' && reviews === 1
          ? [{ path: 'result.txt', line: 1, body: 'Apply the correction' }] : [];
      },
    });
    try {
      const created = await runtime.handleTool('delegate', { to: 'implementer', kind, completion: scenario === 'report' ? 'report' : 'implement' }, { cwd: repo, agentId: 'architect-session', paseoAgentId: 'architect-parent' });
      assert.equal(workspaceCreated, false, 'must not create workspace for delegate');
      assert.equal(git(repo, 'rev-parse', 'HEAD'), baseline);
      assert.equal(readFileSync(join(repo, 'result.txt'), 'utf8'), 'baseline\n');
      await runtime.handleTool('done', { answer: 'Fixture findings' }, { agentId: created.agentId });
      await runtime.flush();
      if (scenario === 'correction') {
        assert.equal(workers.length, 2);
        assert.equal(workers[1].cwd, workers[0].cwd);
        await runtime.handleTool('done', {}, { agentId: workers[1].id });
        await runtime.flush();
      }
      const original = [...runtime.jobs.values()].find(job => job.agentId === created.agentId);
      assert.equal(original.status, 'succeeded', original.error);
      assert.equal(reviews, scenario === 'correction' ? 2 : scenario === 'open' ? 1 : 0);
      if (scenario === 'report') {
        assert.equal(git(repo, 'rev-parse', 'HEAD'), baseline);
        assert.equal(git(workers[0].cwd, 'rev-parse', 'HEAD'), baseline);
        assert.equal(runtime.peekWakes('architect-session')[0].text, 'Fixture findings');
      } else {
        assert.equal(git(repo, 'rev-parse', 'HEAD'), git(workers[0].cwd, 'rev-parse', 'HEAD'));
        assert.equal(readFileSync(join(repo, 'result.txt'), 'utf8'), `implementation ${workers.length}\n`);
        assert.equal(git(repo, 'status', '--porcelain'), '');
        assert.ok(runtime.peekWakes('architect-session').some(wake => wake.text.startsWith('Implementation landed')));
      }
    } finally { await runtime.close(); runtime.store.close(); }
  }
  console.log('Complete local workflows: SDK placement, bounded/open landing, correction and report-only completion passed');
} finally {
  if (priorHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = priorHome;
  rmSync(root, { recursive: true, force: true });
}
