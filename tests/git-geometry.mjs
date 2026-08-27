import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createDelegatedWorktree,
  repoRootFor,
  runCommand,
} from "../src/git.mjs";

const scratch = mkdtempSync(join(tmpdir(), "qq-workflows-git-geometry-"));
const repo = join(scratch, "qq-ui");
const capsules = join(scratch, "capsules");
try {
  mkdirSync(repo, { recursive: true });
  assert.equal((await runCommand("git", ["init", "-b", "main"], { cwd: repo })).code, 0);
  await runCommand("git", ["config", "user.name", "Geometry Test"], { cwd: repo });
  await runCommand("git", ["config", "user.email", "geometry@example.invalid"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# repository root\n");
  assert.equal((await runCommand("git", ["add", "README.md"], { cwd: repo })).code, 0);
  assert.equal((await runCommand("git", ["commit", "-m", "seed"], { cwd: repo })).code, 0);

  // A directory name in the parent can never redirect the session cwd.
  mkdirSync(join(scratch, "qq-ui-marker"));
  assert.equal(repoRootFor(repo), repo);
  assert.equal(repoRootFor(join(repo, "src")), join(repo, "src"));
  assert.equal(repoRootFor(undefined), undefined);

  const capsule = await createDelegatedWorktree(runCommand, {
    cwd: repo,
    brief: "prove self-contained capsule",
    id: "b3441ef8-fd38-4dcf-93ce-10a6c2ad310a",
    env: { QQ_WORKTREES_ROOT: capsules },
  });
  assert.equal(capsule.mainRoot, repo);
  assert.notEqual(capsule.worktree, repo);
  assert.ok(statSync(join(capsule.worktree, ".git")).isDirectory(), "capsule .git must be a directory");
  assert.ok(existsSync(join(capsule.worktree, ".git", "HEAD")));
  assert.ok(!existsSync(join(dirname(capsule.worktree), ".git")), "capsule must not depend on a parent .git");

  // Ordinary architect/QA Git writes stay entirely inside the selected clone.
  await runCommand("git", ["config", "user.name", "Geometry Test"], { cwd: capsule.worktree });
  await runCommand("git", ["config", "user.email", "geometry@example.invalid"], { cwd: capsule.worktree });
  writeFileSync(join(capsule.worktree, "proof.txt"), "workspace-write owns this repository\n");
  assert.equal((await runCommand("git", ["add", "proof.txt"], { cwd: capsule.worktree })).code, 0);
  assert.equal((await runCommand("git", ["commit", "-m", "prove in-repo writes"], { cwd: capsule.worktree })).code, 0);

  const commands = [];
  const refuseClone = async (command, args, options) => {
    commands.push([command, ...args]);
    if (command === "git" && args[0] === "clone") {
      return { code: 128, stdout: "", stderr: "injected clone refusal" };
    }
    return runCommand(command, args, options);
  };
  await assert.rejects(
    createDelegatedWorktree(refuseClone, {
      cwd: repo,
      brief: "clone must fail closed",
      id: "session-77d89720-11c1-4b1e-95a0-024b28fe6070",
      env: { QQ_WORKTREES_ROOT: capsules },
    }),
    /delegation capsule clone failed: injected clone refusal/,
  );
  assert.equal(commands.some((parts) => parts[0] === "git" && parts[1] === "worktree"), false);

  console.log("qq-workflows git geometry: ok");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
