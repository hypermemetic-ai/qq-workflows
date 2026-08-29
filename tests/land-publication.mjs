#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createGitHubClient,
  githubRepositoryFromOrigin,
  landWorktree,
  publishCandidate,
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

async function reviewBaseFixture({ contained = 1, descends = 0 } = {}) {
  const originHead = "d".repeat(40);
  const calls = [];
  const run = async (command, args, options = {}) => {
    calls.push({ command, args: [...args], cwd: options.cwd });
    const key = args.join(" ");
    if (key === "fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main") return { code: 0, stdout: "", stderr: "" };
    if (key === "rev-parse --verify origin/main^{commit}") return { code: 0, stdout: `${originHead}\n`, stderr: "" };
    if (key === `merge-base --is-ancestor ${CANDIDATE} ${originHead}`) return { code: contained, stdout: "", stderr: "" };
    if (key === `merge-base --is-ancestor ${originHead} ${CANDIDATE}`) return { code: descends, stdout: "", stderr: "" };
    throw new Error(`unexpected review-base command: ${command} ${key}`);
  };
  return { run, calls, originHead };
}

{
  const fixture = await reviewBaseFixture();
  const reconciled = await reconcileReviewBase(fixture.run, state, CANDIDATE);
  assert.deepEqual(reconciled, { baseRef: fixture.originHead, baseBranch: "main" });
  assert.notEqual(reconciled.baseRef, state.baseRef, "stale delegated base is replaced by actual origin/main");
  assert.deepEqual(fixture.calls.map(({ args }) => args.slice(0, 2).join(" ")), [
    "fetch --no-tags",
    "rev-parse --verify",
    "merge-base --is-ancestor",
    "merge-base --is-ancestor",
  ]);
  assert.deepEqual(fixture.calls.map(({ cwd }) => cwd), ["/main", "/main", "/worktree", "/worktree"]);
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
  const fixture = await reviewBaseFixture({ contained: 1, descends: 1 });
  await assert.rejects(
    reconcileReviewBase(fixture.run, state, CANDIDATE),
    /candidate diverges from origin\/main/,
  );
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

console.log("land publication: ok");
