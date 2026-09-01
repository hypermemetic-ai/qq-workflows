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
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ scripts: { test: "node tests/economic-exploration.test.mjs" } }, null, 2)}\n`);
  mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, "tests", "economic-exploration.test.mjs"), "if (process.env.QQ_FORCE_FAILURE) process.exit(2);\n");
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
  const inferred = await runRequiredTests(runCommand, state);
  assert.equal(inferred.status, "pass", "a projected package script selects the npm convention");
  assert.equal(inferred.command, "npm test");
  assert.equal(inferred.selection, "repository-package-script");
  assert.equal(testEvidenceMatches(inferred, inferred.postTree, undefined, state), true);
  const pass = await runRequiredTests(runCommand, state, {
    testCommand: { command: "node", args: ["-e", "if(require('fs').readFileSync('value.txt','utf8').trim()!=='new')process.exit(2)"] },
  });
  assert.equal(pass.status, "pass");
  assert.equal(pass.preTree, pass.postTree);
  const scratchGit = await runRequiredTests(runCommand, state, {
    testCommand: {
      command: "bash",
      args: ["-c", "test -z \"${GIT_DIR+x}\" && test -z \"${GIT_WORK_TREE+x}\" && scratch=$(mktemp -d) && trap 'rm -rf \"$scratch\"' EXIT && git init -q \"$scratch\" && test \"$(git -C \"$scratch\" rev-parse --git-dir)\" = .git"],
    },
  });
  assert.equal(scratchGit.status, "pass", `required tests use their own scratch Git repositories: ${scratchGit.output}`);
  assert.equal(scratchGit.preTree, scratchGit.postTree);
  assert.equal(testEvidenceMatches(pass, pass.postTree, { command: "node", args: ["-e", "if(require('fs').readFileSync('value.txt','utf8').trim()!=='new')process.exit(2)"] }), true, "done reuses exact matching pass evidence");
  assert.equal(testEvidenceMatches(pass, "f".repeat(40), { command: "node", args: [] }), false, "workspace or suite change invalidates evidence");
  const candidate = await commitDelegatedWorkspace(runCommand, state, pass.postTree);
  assert.equal(await git(prepared.worktree, "cat-file", "-t", candidate), "commit");
  await git(prepared.worktree, "merge-base", "--is-ancestor", baseRef, candidate);
  assert.equal(readFileSync(join(prepared.worktree, "value.txt"), "utf8"), "new\n");

  // The projected candidate intentionally removes the repository's former npm
  // harness. Absence selects no required suite; it is never recorded as a pass.
  rmSync(join(prepared.workspace, "package.json"));
  rmSync(join(prepared.workspace, "tests"), { recursive: true });
  const noHarness = await runRequiredTests(runCommand, state);
  assert.equal(noHarness.status, "not-required");
  assert.equal(noHarness.command, "<none>");
  assert.equal(noHarness.exitCode, null);
  assert.equal(noHarness.selection, "repository-none");
  assert.match(noHarness.output, /projected tree has no package.json test declaration/);
  assert.equal(noHarness.preTree, noHarness.postTree);
  assert.equal(testEvidenceMatches(noHarness, noHarness.postTree, undefined, state), true, "the no-suite selection is bound to its projected tree");

  const explicitMissingHarness = await runRequiredTests(runCommand, state, {
    testCommand: { command: "npm", args: ["test"] },
  });
  assert.equal(explicitMissingHarness.status, "fail", "an explicitly required missing harness never silently passes");
  assert.equal(explicitMissingHarness.selection, "configured");
  assert.match(explicitMissingHarness.output, /package.json|ENOENT/i);

  const deletionCandidate = await commitDelegatedWorkspace(runCommand, state, noHarness.postTree);
  assert.equal(await git(prepared.worktree, "rev-parse", `${deletionCandidate}^{tree}`), noHarness.postTree, "selection proof names the exact candidate tree");
  assert.notEqual((await runCommand("git", ["cat-file", "-e", `${deletionCandidate}:package.json`], { cwd: prepared.worktree })).code, 0);
  assert.notEqual((await runCommand("git", ["cat-file", "-e", `${deletionCandidate}:tests/economic-exploration.test.mjs`], { cwd: prepared.worktree })).code, 0);

  writeFileSync(join(prepared.workspace, "value.txt"), "changed after selection\n");
  const changedTree = await stageDelegatedWorkspace(runCommand, state);
  assert.notEqual(changedTree, noHarness.postTree);
  assert.equal(testEvidenceMatches(noHarness, changedTree, undefined, state), false, "no-suite evidence cannot authorize another projected tree");

  writeFileSync(join(prepared.workspace, "package.json"), "{ not-json\n");
  await assert.rejects(
    runRequiredTests(runCommand, state),
    /cannot select required validation for projected tree [0-9a-f]+: package.json is invalid JSON.*configure testCommand explicitly/,
    "invalid repository evidence produces an actionable failure rather than an arbitrary pass",
  );
  rmSync(join(prepared.workspace, "package.json"));

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
