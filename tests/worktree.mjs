import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImplementerWorktree, implementerBranchName } from '../paseo-plugin/host/workflow/worktree.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'architect-worktree-'));
const previous = process.env.PASEO_HOME;
process.env.PASEO_HOME = join(scratch, 'paseo');
try {
  const repo = join(scratch, 'repo');
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'Baseline'], { stdio: 'pipe' });
  const branch = implementerBranchName('bounded', 'abcdef12-xxxx');
  const result = await createImplementerWorktree({ cwd: repo, branch });
  assert.equal(branch, 'architect/bounded/abcdef12');
  assert.equal(result.cwd, join(process.env.PASEO_HOME, 'worktrees/architect/architect-bounded-abcdef12'));
  assert.equal(execFileSync('git', ['-C', result.cwd, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), branch);
  await assert.rejects(createImplementerWorktree({ cwd: repo, branch }), /already exists/);
  assert.equal(execFileSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'main');
} finally {
  if (previous === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previous;
  await rm(scratch, { recursive: true, force: true });
}
