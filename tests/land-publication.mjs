#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createGitHubClient,
  formatOutcome,
  githubRepositoryFromOrigin,
  landWorktree,
  publishCandidate,
  runCommand,
  reconcileReviewBase,
} from "../src/land.mjs";

assert.equal(githubRepositoryFromOrigin("git@github.com:owner/repo.git"), "owner/repo");
assert.equal(githubRepositoryFromOrigin("https://github.com/owner/repo.git"), "owner/repo");
assert.equal(githubRepositoryFromOrigin("ssh://git@ghe.example/owner/repo.git"), "ghe.example/owner/repo");
assert.equal(githubRepositoryFromOrigin("/local/not-github"), "");

const CANDIDATE = "a".repeat(40);
const OTHER = "b".repeat(40);
const state = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  delegationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  mainRoot: "/main",
  worktree: "/worktree",
  baseBranch: "main",
  baseRef: "c".repeat(40),
  branch: "feat/exact-candidate",
  ref: CANDIDATE,
};

async function reviewBaseFixture({ contained = 1 } = {}) {
  const originHead = "d".repeat(40);
  const calls = [];
  const run = async (command, args, options = {}) => {
    calls.push({ command, args: [...args], cwd: options.cwd });
    const key = args.join(" ");
    if (key === "fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main") return { code: 0, stdout: "", stderr: "" };
    if (key === "rev-parse --verify origin/main^{commit}") return { code: 0, stdout: `${originHead}\n`, stderr: "" };
    if (key === `merge-base --is-ancestor ${CANDIDATE} ${originHead}`) return { code: contained, stdout: "", stderr: "" };
    throw new Error(`unexpected review-base command: ${command} ${key}`);
  };
  return { run, calls, originHead };
}

{
  const fixture = await reviewBaseFixture();
  const reconciled = await reconcileReviewBase(fixture.run, state, CANDIDATE);
  assert.deepEqual(reconciled, { baseRef: state.baseRef, originRef: fixture.originHead, baseBranch: "main" });
  assert.equal(reconciled.baseRef, state.baseRef, "delegated ancestry base is retained for triple-dot review");
  assert.deepEqual(fixture.calls.map(({ args }) => args.slice(0, 2).join(" ")), [
    "fetch --no-tags",
    "rev-parse --verify",
    "merge-base --is-ancestor",
  ]);
  assert.deepEqual(fixture.calls.map(({ cwd }) => cwd), ["/main", "/main", "/worktree"]);
}

for (const label of ["equal head", "candidate already merged before QA"]) {
  const fixture = await reviewBaseFixture({ contained: 0 });
  await assert.rejects(
    reconcileReviewBase(fixture.run, state, CANDIDATE),
    /candidate is pre-landed: .* already contained by origin\/main \(ahead=0\)/,
    label,
  );
  assert.equal(fixture.calls.some(({ args }) => args[0] === "diff"), false, `${label} is rejected before QA packet work`);
}

{
  const fixture = await reviewBaseFixture({ contained: 1 });
  const reconciled = await reconcileReviewBase(fixture.run, state, CANDIDATE);
  assert.equal(reconciled.baseRef, state.baseRef, "normal parallel main/candidate divergence proceeds");
  assert.equal(reconciled.originRef, fixture.originHead);
}

function publicationFixture({ localType = "commit", rows, fetchedOid = CANDIDATE, remoteType = "commit" } = {}) {
  const calls = [];
  const remoteRef = `refs/heads/${state.branch}`;
  const outputRows = rows === undefined ? `${CANDIDATE}\t${remoteRef}\n` : rows;
  const run = async (command, args, options = {}) => {
    calls.push({ command, args: [...args], cwd: options.cwd });
    const key = `${command} ${args.join(" ")}`;
    if (key === `git rev-parse --verify ${state.ref}`) return { code: 0, stdout: `${CANDIDATE}\n`, stderr: "" };
    if (key === `git cat-file -t ${CANDIDATE}`) return { code: 0, stdout: `${localType}\n`, stderr: "" };
    if (key.startsWith("git cat-file -t refs/qq-workflows/published/")) return { code: 0, stdout: `${remoteType}\n`, stderr: "" };
    if (key.startsWith("git rev-parse --verify refs/qq-workflows/published/")) return { code: 0, stdout: `${fetchedOid}\n`, stderr: "" };
    if (key === `git ls-remote --refs origin ${remoteRef}`) return { code: 0, stdout: outputRows, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls, remoteRef };
}

{
  const fixture = publicationFixture();
  const result = await publishCandidate(fixture.run, state);
  assert.deepEqual(result, {
    candidateOid: CANDIDATE,
    localType: "commit",
    remoteOid: CANDIDATE,
    remoteType: "commit",
    remoteRef: fixture.remoteRef,
    evidenceRef: `refs/qq-workflows/published/${state.delegationId}`,
  });
  const push = fixture.calls.find((call) => call.args[0] === "push");
  assert.deepEqual(push.args, ["push", "origin", `${CANDIDATE}:${fixture.remoteRef}`], "push uses full OID and full heads ref");
  const importFetch = fixture.calls.find((call) => call.args[0] === "fetch" && call.args[2] === state.worktree);
  assert.deepEqual(importFetch.args, ["fetch", "--no-tags", state.worktree, CANDIDATE]);
}

for (const test of [
  { name: "missing", fixture: { rows: "" }, pattern: /published proposal ref .* missing/ },
  { name: "OID mismatch", fixture: { rows: `${OTHER}\trefs/heads/${state.branch}\n` }, pattern: /OID mismatch/ },
  { name: "ambiguous ref names", fixture: { rows: `${CANDIDATE}\trefs/heads/${state.branch}\n${CANDIDATE}\trefs/heads/${state.branch}\/nested\n` }, pattern: /ambiguous/ },
  { name: "fetched OID mismatch", fixture: { fetchedOid: OTHER }, pattern: /fetched proposal OID mismatch/ },
  { name: "non-commit remote object", fixture: { remoteType: "blob" }, pattern: /object type blob, not commit/ },
  { name: "non-commit local object", fixture: { localType: "tag" }, pattern: /object type tag, not commit/ },
]) {
  const fixture = publicationFixture(test.fixture);
  await assert.rejects(publishCandidate(fixture.run, state), test.pattern, test.name);
}

{
  const calls = [];
  let listCount = 0;
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "git") return { code: 0, stdout: "git@github.com:owner/repo.git\n", stderr: "" };
    if (args[0] === "repo") return { code: 0, stdout: "owner/repo\n", stderr: "" };
    if (args[0] === "pr" && args[1] === "list") {
      listCount++;
      const rows = listCount === 1 ? [] : [{
        url: "https://github.com/owner/repo/pull/7",
        headRefOid: CANDIDATE,
        headRefName: state.branch,
        baseRefName: "main",
      }];
      return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "create") return { code: 1, stdout: "", stderr: "GraphQL 504 Gateway Timeout" };
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  const github = createGitHubClient(run);
  assert.equal(await github.openPullRequest({
    mainRoot: "/main", baseBranch: "main", headBranch: state.branch, headRef: CANDIDATE, title: "exact",
  }), "https://github.com/owner/repo/pull/7");
  assert.equal(calls.filter((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "create").length, 1);
  assert.equal(calls.filter((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "list").length, 2);
  for (const call of calls.filter((parts) => parts[0] === "gh" && parts[1] === "pr")) {
    assert.ok(call.includes("--repo") && call.includes("owner/repo"), "every PR command is explicitly repository-bound");
  }
}

{
  const calls = [];
  const existing = [{
    url: "https://github.com/owner/repo/pull/8",
    headRefOid: CANDIDATE,
    headRefName: state.branch,
    baseRefName: "main",
  }];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "git") return { code: 0, stdout: "https://github.com/owner/repo.git\n", stderr: "" };
    if (args[0] === "repo") return { code: 0, stdout: "owner/repo\n", stderr: "" };
    if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: JSON.stringify(existing), stderr: "" };
    throw new Error("PR create must not run when exact open PR already exists");
  };
  const github = createGitHubClient(run);
  assert.equal(await github.openPullRequest({
    mainRoot: "/main", baseBranch: "main", headBranch: state.branch, headRef: CANDIDATE,
  }), existing[0].url);
  assert.equal(calls.some((call) => call.includes("create")), false);
}

{
  const calls = [];
  const merged = [{
    url: "https://github.com/owner/repo/pull/9",
    headRefOid: CANDIDATE,
    headRefName: state.branch,
    baseRefName: "main",
    state: "MERGED",
    mergedAt: "2026-08-29T00:00:00Z",
  }];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "git") return { code: 0, stdout: "git@github.com:owner/repo.git\n", stderr: "" };
    if (args[0] === "repo") return { code: 0, stdout: "owner/repo\n", stderr: "" };
    if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: JSON.stringify(merged), stderr: "" };
    throw new Error(`unexpected merged-PR command: ${command} ${args.join(" ")}`);
  };
  const github = createGitHubClient(run);
  const pullRequest = await github.openPullRequest({
    mainRoot: "/main", baseBranch: "main", headBranch: state.branch, headRef: CANDIDATE,
  });
  await github.mergePullRequest({ mainRoot: "/main", pullRequest, headRef: CANDIDATE });
  assert.equal(pullRequest, merged[0].url);
  assert.equal(calls.some((call) => call.includes("create") || call.includes("merge")), false, "exact-head merged PR is resumed without mutation");
}

// Full Land stops before GitHub and cleanup when publication evidence is missing.
{
  const scratch = mkdtempSync(join(tmpdir(), "qq-land-publication."));
  const mainRoot = join(scratch, "main");
  const worktree = join(scratch, "worktree");
  mkdirSync(join(mainRoot, ".git"), { recursive: true });
  mkdirSync(join(worktree, ".git"), { recursive: true });
  const calls = [];
  let githubCalls = 0;
  const fullState = { ...state, mainRoot, worktree };
  const fixture = publicationFixture({ rows: "" });
  const run = async (command, args, options = {}) => {
    calls.push([command, ...args]);
    const key = `${command} ${args.join(" ")}`;
    if (key === "git symbolic-ref --quiet --short HEAD") return { code: 0, stdout: "main\n", stderr: "" };
    if (key === "git status --porcelain --untracked-files=all") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "diff" && args[1] === "--quiet") return { code: 1, stdout: "", stderr: "" };
    if (args[0] === "diff") return { code: 0, stdout: "src/change.mjs\0", stderr: "" };
    if (args[0] === "show") return { code: 0, stdout: "candidate title\n", stderr: "" };
    return fixture.run(command, args, options);
  };
  const github = {
    async openPullRequest() { githubCalls++; return "unexpected"; },
    async mergePullRequest() { githubCalls++; },
  };
  try {
    await assert.rejects(landWorktree(run, fullState, { github }), /published proposal ref .* missing/);
    assert.equal(githubCalls, 0, "PR creation never runs before publication verification");
    assert.equal(existsSync(worktree), true, "failed publication preserves the worktree");
    assert.equal(calls.some((call) => call[0] === "rm" || call.includes("remove") || call.includes("-D")), false, "failed publication performs no cleanup");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// A valid commit with no reviewed diff fails before push or PR creation.
{
  const scratch = mkdtempSync(join(tmpdir(), "qq-land-no-diff."));
  const mainRoot = join(scratch, "main");
  const worktree = join(scratch, "worktree");
  mkdirSync(mainRoot); mkdirSync(worktree);
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "symbolic-ref") return { code: 0, stdout: "main\n", stderr: "" };
    if (args[0] === "status" || args[0] === "diff") return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    await assert.rejects(landWorktree(run, { ...state, mainRoot, worktree }, { github: {} }), /no changes relative/);
    assert.equal(calls.some((call) => call.includes("push")), false);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}


// A dirty primary checkout defers only local synchronization. Publication and
// remote merge proceed from the clean reviewed capsule without changing one
// byte in the primary index, tracked file, or untracked file.
{
  const scratch = mkdtempSync(join(tmpdir(), "qq-land-dirty-primary."));
  const origin = join(scratch, "origin.git");
  const seed = join(scratch, "seed");
  const mainRoot = join(scratch, "main");
  const worktree = join(scratch, "reviewed");
  const integration = join(scratch, "integration");
  const branch = "feat/dirty-primary-publication";
  const calls = [];
  const cleanEnv = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"] ) {
    delete cleanEnv[name];
  }
  const run = async (command, args, options = {}) => {
    calls.push({ command, args: [...args], cwd: options.cwd });
    const env = { ...cleanEnv, ...(options.env ?? {}) };
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"] ) {
      delete env[name];
    }
    return runCommand(command, args, { ...options, env });
  };
  const git = async (cwd, ...args) => {
    const result = await run("git", args, { cwd });
    assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
  };

  try {
    mkdirSync(seed);
    await git(scratch, "init", "--bare", "--initial-branch=main", origin);
    await git(seed, "init", "--initial-branch=main");
    await git(seed, "config", "user.name", "Land Test");
    await git(seed, "config", "user.email", "land-test@example.invalid");
    writeFileSync(join(seed, "tracked.txt"), "base\n");
    await git(seed, "add", "tracked.txt");
    await git(seed, "commit", "-m", "base");
    const baseRef = await git(seed, "rev-parse", "HEAD");
    await git(seed, "remote", "add", "origin", origin);
    await git(seed, "push", "-u", "origin", "main");

    await git(scratch, "clone", origin, mainRoot);
    await git(scratch, "clone", origin, worktree);
    await git(worktree, "config", "user.name", "Land Test");
    await git(worktree, "config", "user.email", "land-test@example.invalid");
    await git(worktree, "checkout", "-b", branch);
    writeFileSync(join(worktree, "proposal.txt"), "reviewed change\n");
    await git(worktree, "add", "proposal.txt");
    await git(worktree, "commit", "-m", "publish despite dirty primary");
    const candidate = await git(worktree, "rev-parse", "HEAD");

    // Give the primary simultaneous staged, unstaged, and untracked state.
    // Snapshot after the final index write and before Land observes it.
    writeFileSync(join(mainRoot, "tracked.txt"), "staged local work\n");
    await git(mainRoot, "add", "tracked.txt");
    writeFileSync(join(mainRoot, "tracked.txt"), "staged plus unstaged local work\n");
    writeFileSync(join(mainRoot, "untracked.txt"), "untracked local work\n");
    const primaryHeadBefore = await git(mainRoot, "rev-parse", "HEAD");
    const indexBefore = readFileSync(join(mainRoot, ".git", "index"));
    const trackedBefore = readFileSync(join(mainRoot, "tracked.txt"));
    const untrackedBefore = readFileSync(join(mainRoot, "untracked.txt"));

    let opened = false;
    let merged = false;
    const github = {
      async openPullRequest({ headRef, headBranch, baseBranch }) {
        assert.equal(headRef, candidate);
        assert.equal(headBranch, branch);
        assert.equal(baseBranch, "main");
        opened = true;
        return "https://github.example/owner/repo/pull/77";
      },
      async mergePullRequest({ headRef, headBranch }) {
        assert.equal(opened, true, "publication opens the reviewed PR before merge");
        assert.equal(headRef, candidate);
        assert.equal(headBranch, branch);
        await git(scratch, "clone", origin, integration);
        await git(integration, "config", "user.name", "Land Test");
        await git(integration, "config", "user.email", "land-test@example.invalid");
        await git(integration, "fetch", "origin", branch);
        await git(integration, "merge", "--no-ff", `origin/${branch}`, "-m", "merge reviewed proposal");
        await git(integration, "push", "origin", "main");
        merged = true;
      },
    };

    const landed = await landWorktree(run, {
      id: state.id,
      delegationId: state.delegationId,
      mainRoot,
      worktree,
      baseBranch: "main",
      baseRef,
      branch,
      ref: candidate,
    }, { github });

    assert.equal(merged, true);
    assert.equal(landed.landedRef, candidate);
    assert.equal(landed.publishedRef, `refs/heads/${branch}`);
    assert.equal(landed.pullRequest, "https://github.example/owner/repo/pull/77");
    assert.equal(landed.localSyncStatus, "deferred");
    assert.match(landed.localSyncReason, /staged, unstaged, or untracked changes; left untouched/);
    assert.equal(existsSync(worktree), true, "deferred local sync retains the reviewed clean worktree");
    const outcome = formatOutcome(landed, "landed");
    assert.match(outcome, new RegExp(`Implementation delegation ${state.delegationId}: landed\.`));
    assert.match(outcome, new RegExp(`Landed commit: ${candidate}`));
    assert.match(outcome, new RegExp(`Published ref: refs/heads/${branch}`));
    assert.match(outcome, /Pull request: https:\/\/github\.example\/owner\/repo\/pull\/77/);
    assert.match(outcome, /Local main sync: deferred .* staged, unstaged, or untracked changes; left untouched/);
    assert.doesNotMatch(outcome, /blocked|Mark: fail/i);

    // Check byte identity before issuing any further command in the primary.
    assert.deepEqual(readFileSync(join(mainRoot, ".git", "index")), indexBefore, "Land does not refresh or rewrite the dirty primary index");
    assert.deepEqual(readFileSync(join(mainRoot, "tracked.txt")), trackedBefore, "Land preserves staged and unstaged bytes");
    assert.deepEqual(readFileSync(join(mainRoot, "untracked.txt")), untrackedBefore, "Land preserves untracked bytes");
    assert.equal(await git(mainRoot, "rev-parse", "HEAD"), primaryHeadBefore, "dirty local main is not fast-forwarded");
    const remoteHead = await git(scratch, `--git-dir=${origin}`, "rev-parse", "main");
    await git(scratch, `--git-dir=${origin}`, "merge-base", "--is-ancestor", candidate, remoteHead);
    assert.equal(
      calls.some((call) => call.cwd === mainRoot && call.args[0] === "merge"),
      false,
      "no local merge is attempted for a dirty primary",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

console.log("land publication: ok");
