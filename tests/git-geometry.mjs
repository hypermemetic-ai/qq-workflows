import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createDelegatedWorktree,
  repoRootFor,
  runCommand,
} from "../src/git.mjs";

function isolatedGitEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_AUTHOR_") || key.startsWith("GIT_COMMITTER_")
      || key === "GIT_CONFIG_PARAMETERS" || /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) {
      delete env[key];
    }
  }
  delete env.EMAIL;
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...overrides,
  };
}

function runnerFor(env) {
  return (command, args, options = {}) => runCommand(command, args, { ...options, env });
}

async function gitOk(run, cwd, args) {
  const result = await run("git", args, { cwd });
  assert.equal(result.code, 0, result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  return result.stdout.replace(/\r?\n$/, "");
}

async function assertConfigMissing(run, cwd, args) {
  const result = await run("git", ["config", ...args], { cwd });
  assert.equal(result.code, 1, `expected missing config from: git config ${args.join(" ")}`);
  assert.equal(result.stdout, "");
}

const scratch = mkdtempSync(join(tmpdir(), "qq-workflows-git-geometry-"));
const repo = join(scratch, "qq-ui");
const capsules = join(scratch, "capsules");
const localOnlyEnv = isolatedGitEnv();
const localOnlyRun = runnerFor(localOnlyEnv);
try {
  mkdirSync(repo, { recursive: true });
  await gitOk(localOnlyRun, repo, ["init", "-b", "main"]);
  await gitOk(localOnlyRun, repo, ["config", "user.name", "Geometry Test"]);
  await gitOk(localOnlyRun, repo, ["config", "user.email", "geometry@example.invalid"]);
  writeFileSync(join(repo, "README.md"), "# repository root\n");
  await gitOk(localOnlyRun, repo, ["add", "README.md"]);
  await gitOk(localOnlyRun, repo, ["commit", "-m", "seed"]);

  // A directory name in the parent can never redirect the session cwd.
  mkdirSync(join(scratch, "qq-ui-marker"));
  assert.equal(repoRootFor(repo), repo);
  assert.equal(repoRootFor(join(repo, "src")), join(repo, "src"));
  assert.equal(repoRootFor(undefined), undefined);

  const capsule = await createDelegatedWorktree(localOnlyRun, {
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
  assert.equal(await gitOk(localOnlyRun, capsule.worktree, ["config", "--local", "--get", "user.name"]), "Geometry Test");
  assert.equal(
    await gitOk(localOnlyRun, capsule.worktree, ["config", "--local", "--get", "user.email"]),
    "geometry@example.invalid",
  );

  // Ordinary architect/QA Git writes use only the identity stamped in the clone.
  assert.equal(Object.keys(localOnlyEnv).some((key) => key.startsWith("GIT_AUTHOR_")
    || key.startsWith("GIT_COMMITTER_")), false);
  writeFileSync(join(capsule.worktree, "proof.txt"), "workspace-write owns this repository\n");
  await gitOk(localOnlyRun, capsule.worktree, ["add", "proof.txt"]);
  await gitOk(localOnlyRun, capsule.worktree, ["commit", "-m", "prove in-repo writes"]);

  // Effective global identity on the source is persisted locally in the capsule.
  const globalConfig = join(scratch, "source-global.gitconfig");
  const globalRepo = join(scratch, "global-source");
  await gitOk(localOnlyRun, scratch, ["config", "--file", globalConfig, "user.name", "Global Geometry"]);
  await gitOk(localOnlyRun, scratch, ["config", "--file", globalConfig, "user.email", "global@example.invalid"]);
  const globalRun = runnerFor(isolatedGitEnv({ GIT_CONFIG_GLOBAL: globalConfig }));
  mkdirSync(globalRepo);
  await gitOk(globalRun, globalRepo, ["init", "-b", "main"]);
  await assertConfigMissing(globalRun, globalRepo, ["--local", "--get", "user.name"]);
  await assertConfigMissing(globalRun, globalRepo, ["--local", "--get", "user.email"]);
  writeFileSync(join(globalRepo, "README.md"), "# global identity source\n");
  await gitOk(globalRun, globalRepo, ["add", "README.md"]);
  await gitOk(globalRun, globalRepo, ["commit", "-m", "seed global source"]);

  const globalCapsule = await createDelegatedWorktree(globalRun, {
    cwd: globalRepo,
    brief: "copy effective global identity",
    id: "session-c433929f-4987-4da5-9b76-c5c4feea6e32",
    env: { QQ_WORKTREES_ROOT: capsules },
  });
  assert.equal(
    await gitOk(localOnlyRun, globalCapsule.worktree, ["config", "--local", "--get", "user.name"]),
    "Global Geometry",
  );
  assert.equal(
    await gitOk(localOnlyRun, globalCapsule.worktree, ["config", "--local", "--get", "user.email"]),
    "global@example.invalid",
  );
  writeFileSync(join(globalCapsule.worktree, "global-proof.txt"), "local identity survives global isolation\n");
  await gitOk(localOnlyRun, globalCapsule.worktree, ["add", "global-proof.txt"]);
  await gitOk(localOnlyRun, globalCapsule.worktree, ["commit", "-m", "prove copied global identity"]);

  // A source with no configured identity still creates a capsule and stays unset.
  const anonymousRepo = join(scratch, "anonymous-source");
  mkdirSync(anonymousRepo);
  await gitOk(localOnlyRun, anonymousRepo, ["init", "-b", "main"]);
  writeFileSync(join(anonymousRepo, "README.md"), "# anonymous source\n");
  await gitOk(localOnlyRun, anonymousRepo, ["add", "README.md"]);
  const seedOnlyRun = runnerFor({
    ...localOnlyEnv,
    GIT_AUTHOR_NAME: "One-time Seed",
    GIT_AUTHOR_EMAIL: "seed@example.invalid",
    GIT_COMMITTER_NAME: "One-time Seed",
    GIT_COMMITTER_EMAIL: "seed@example.invalid",
  });
  await gitOk(seedOnlyRun, anonymousRepo, ["commit", "-m", "seed anonymous source"]);
  await assertConfigMissing(localOnlyRun, anonymousRepo, ["--get", "user.name"]);
  await assertConfigMissing(localOnlyRun, anonymousRepo, ["--get", "user.email"]);

  const anonymousCapsule = await createDelegatedWorktree(localOnlyRun, {
    cwd: anonymousRepo,
    brief: "leave absent identity unset",
    id: "session-605163fb-5a42-497f-aa0a-26d19205b4cd",
    env: { QQ_WORKTREES_ROOT: capsules },
  });
  await assertConfigMissing(localOnlyRun, anonymousCapsule.worktree, ["--local", "--get", "user.name"]);
  await assertConfigMissing(localOnlyRun, anonymousCapsule.worktree, ["--local", "--get", "user.email"]);

  const commands = [];
  const refuseClone = async (command, args, options) => {
    commands.push([command, ...args]);
    if (command === "git" && args[0] === "clone") {
      return { code: 128, stdout: "", stderr: "injected clone refusal" };
    }
    return localOnlyRun(command, args, options);
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
