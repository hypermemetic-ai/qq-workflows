#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDelegationStore } from "../src/delegation-store.mjs";
import { createDelegatedWorktree, runCommand } from "../src/git.mjs";
import { createLand, stageDelegatedWorkspace } from "../src/land.mjs";

async function git(cwd, ...args) {
  const result = await runCommand("git", args, { cwd });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

const root = mkdtempSync(join(tmpdir(), "qq-host-candidate."));
const repo = join(root, "repo");
const origin = join(root, "origin.git");
mkdirSync(repo);
mkdirSync(origin);
try {
  await git(origin, "init", "--bare");
  await git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "value.txt"), "old\n");
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ scripts: { test: "node tests/economic-exploration.test.mjs" } }, null, 2)}\n`);
  mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, "tests", "economic-exploration.test.mjs"), "process.exit(99);\n");
  await git(repo, "add", ".");
  await git(repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base");
  await git(repo, "remote", "add", "origin", `file://${origin}`);
  await git(repo, "push", "-u", "origin", "main");
  await git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  const baseRef = await git(repo, "rev-parse", "HEAD");
  const prepared = await createDelegatedWorktree(runCommand, {
    cwd: repo,
    brief: "intentionally remove the former test harness",
    id: "session-22222222-2222-4222-8222-222222222222",
    env: { QQ_WORKTREES_ROOT: join(root, "worktrees") },
  });
  assert.equal(existsSync(join(prepared.workspace, ".git")), false, "child checkout is metadata-free");

  writeFileSync(join(prepared.workspace, "value.txt"), "new\n");
  rmSync(join(prepared.workspace, "package.json"));
  rmSync(join(prepared.workspace, "tests", "economic-exploration.test.mjs"));
  const state = { ...prepared, baseRef, brief: "intentionally remove the former test harness" };
  const commands = [];
  const observedRun = async (command, args, options) => {
    commands.push([command, ...args]);
    return runCommand(command, args, options);
  };

  const delegationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const implementationSession = "session-22222222-2222-4222-8222-222222222222";
  const store = createDelegationStore(join(root, "store"));
  store.create({
    id: delegationId,
    delegationId,
    implementationSession,
    originalImplementationSession: implementationSession,
    ...state,
  });
  const land = createLand({
    ctx: { get() { return null; }, logger: { info() {}, warn() {} } },
    store,
    run: observedRun,
    agents: { get() { return null; }, list() { return []; } },
  });
  const agent = {
    id: implementationSession,
    session: { id: implementationSession, header: { cwd: prepared.workspace, origin: "subagent" } },
  };

  const submitted = await land.done({ agent, delegationId, postTool: true });
  assert.equal(submitted.status, "ok", submitted.reason);
  assert.equal(submitted.mark, "review");
  const handedOff = store.load(delegationId);
  assert.equal(handedOff.status, "reviewing", "candidate preservation immediately hands implementation off to review");
  assert.equal(handedOff.transitioning, true);
  const candidate = handedOff.ref;
  assert.equal(await git(prepared.worktree, "cat-file", "-t", candidate), "commit");
  await git(prepared.worktree, "merge-base", "--is-ancestor", baseRef, candidate);
  assert.equal(await git(prepared.worktree, "rev-list", "--count", `${baseRef}..${candidate}`), "1", "one submit creates exactly one candidate commit");
  assert.equal(readFileSync(join(prepared.worktree, "value.txt"), "utf8"), "new\n");
  assert.equal((await runCommand("git", ["cat-file", "-e", `${candidate}:package.json`], { cwd: prepared.worktree })).code, 128);
  assert.equal((await runCommand("git", ["cat-file", "-e", `${candidate}:tests/economic-exploration.test.mjs`], { cwd: prepared.worktree })).code, 128);
  assert.equal(commands.every(([command]) => command === "git"), true, "candidate submission never launches a host-required test command");

  const durableHandoff = readFileSync(store.fileFor(delegationId), "utf8");
  const commandCount = commands.length;
  const replay = await land.done({ agent, delegationId, postTool: true });
  assert.equal(replay.status, "refused");
  assert.match(replay.reason, /reviewing, not ready for done/);
  assert.equal(readFileSync(store.fileFor(delegationId), "utf8"), durableHandoff, "a repeated controller call cannot duplicate the terminal handoff");
  assert.equal(commands.length, commandCount, "a repeated controller call cannot create another candidate");
  await land.dispose();

  mkdirSync(join(prepared.workspace, ".git"));
  await assert.rejects(stageDelegatedWorkspace(runCommand, state), /must not contain Git metadata/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("host candidate: ok");
