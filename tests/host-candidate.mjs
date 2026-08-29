#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDelegatedWorktree, runCommand } from "../src/git.mjs";
import { commitDelegatedWorkspace, runRequiredTests, stageDelegatedWorkspace, testEvidenceMatches } from "../src/land.mjs";

async function git(cwd, ...args) {
  const result = await runCommand("git", args, { cwd });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

const root = mkdtempSync(join(tmpdir(), "qq-host-candidate."));
const repo = join(root, "repo");
mkdirSync(repo);
try {
  await git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "value.txt"), "old\n");
  await git(repo, "add", ".");
  await git(repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base");
  const baseRef = await git(repo, "rev-parse", "HEAD");
  const prepared = await createDelegatedWorktree(runCommand, {
    cwd: repo,
    brief: "change value",
    id: "session-22222222-2222-4222-8222-222222222222",
    env: { QQ_WORKTREES_ROOT: join(root, "worktrees") },
  });
  assert.equal(existsSync(join(prepared.workspace, ".git")), false, "child checkout is metadata-free");
  writeFileSync(join(prepared.workspace, "value.txt"), "new\n");
  const state = { ...prepared, baseRef, brief: "change value" };
  const pass = await runRequiredTests(runCommand, state, {
    testCommand: { command: "node", args: ["-e", "if(require('fs').readFileSync('value.txt','utf8').trim()!=='new')process.exit(2)"] },
  });
  assert.equal(pass.status, "pass");
  assert.equal(pass.preTree, pass.postTree);
  assert.equal(testEvidenceMatches(pass, pass.postTree, { command: "node", args: ["-e", "if(require('fs').readFileSync('value.txt','utf8').trim()!=='new')process.exit(2)"] }), true, "done reuses exact matching pass evidence");
  assert.equal(testEvidenceMatches(pass, "f".repeat(40), { command: "node", args: [] }), false, "workspace or suite change invalidates evidence");
  const candidate = await commitDelegatedWorkspace(runCommand, state, pass.postTree);
  assert.equal(await git(prepared.worktree, "cat-file", "-t", candidate), "commit");
  await git(prepared.worktree, "merge-base", "--is-ancestor", baseRef, candidate);
  assert.equal(readFileSync(join(prepared.worktree, "value.txt"), "utf8"), "new\n");

  writeFileSync(join(prepared.workspace, "mutating-test.js"), "require('fs').writeFileSync('generated.txt','changed')\n");
  const mutation = await runRequiredTests(runCommand, state, {
    testCommand: { command: "node", args: ["mutating-test.js"] },
  });
  assert.equal(mutation.status, "fail", "test-written commit content invalidates evidence");
  assert.notEqual(mutation.preTree, mutation.postTree);
  assert.match(mutation.output, /changed commit-eligible workspace content/);

  mkdirSync(join(prepared.workspace, ".git"));
  await assert.rejects(stageDelegatedWorkspace(runCommand, state), /must not contain Git metadata/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("host candidate: ok");
