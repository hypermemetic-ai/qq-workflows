#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as miniReviewModuleForHmr from "../src/mini-review.mjs";
import {
  bindMiniReviewSubmit,
  buildMiniReviewTools,
  MINI_REVIEW_SYSTEM_PROMPT,
  MINI_REVIEW_TOOL_NAMES,
  renderMiniReviewTask,
  reviewFindingsToVerdictInput,
} from "../src/mini-review.mjs";
import {
  MINI_REVIEW_GLOB_LIMIT,
  MINI_REVIEW_GREP_LIMIT,
  MINI_REVIEW_INSPECT_LIMIT,
  MINI_REVIEW_VIEW_LINE_LIMIT,
} from "../src/mini-review-v2.mjs";
import { RepoOracle } from "../src/repo-oracle.mjs";
import { withChildSettlement } from "../src/child-settlement.mjs";

const root = mkdtempSync(join(tmpdir(), "qq-mini-review."));
const repo = join(root, "repo");
mkdirSync(repo);
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "mini-review-test",
  GIT_AUTHOR_EMAIL: "mini-review@test",
  GIT_COMMITTER_NAME: "mini-review-test",
  GIT_COMMITTER_EMAIL: "mini-review@test",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const git = (...args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
git("init", "-b", "main");
git("config", "user.name", "mini-review-test");
git("config", "user.email", "mini-review@test");
mkdirSync(join(repo, "src"));
mkdirSync(join(repo, "many"));
writeFileSync(join(repo, "src/auth.py"), "def authorize(user):\n    return False\nunchanged = True\n");
writeFileSync(join(repo, "src/delete.txt"), "anchor\nremove me\ntail\n");
writeFileSync(join(repo, "src/delete-first.txt"), "only line\n");
writeFileSync(join(repo, "src/long.txt"), `${Array.from({ length: 140 }, (_, i) => `line-${i + 1}`).join("\n")}\n`);
writeFileSync(join(repo, "src/huge.txt"), `${"x".repeat(40_000)}\n`);
writeFileSync(join(repo, "asset.bin"), Buffer.from([0, 1, 2, 3]));
symlinkSync("src/auth.py", join(repo, "auth-link"));
for (let i = 0; i < 105; i++) writeFileSync(join(repo, "many", `file-${String(i).padStart(3, "0")}.txt`), `needle ${i}\n`);
git("add", ".");
git("commit", "-m", "base");
const base = git("rev-parse", "HEAD");
writeFileSync(join(repo, "src/auth.py"), "def authorize(user):\n    return user.is_admin\nunchanged = True\n");
writeFileSync(join(repo, "src/delete.txt"), "anchor\ntail\n");
writeFileSync(join(repo, "src/delete-first.txt"), "");
writeFileSync(join(repo, "head-only.txt"), "head evidence\n");
git("add", ".");
git("commit", "-m", "head");
const head = git("rev-parse", "HEAD");

const oracle = new RepoOracle(base, head, { gitDir: join(repo, ".git") });
assert.equal(Object.isFrozen(oracle), true);
assert.throws(() => { oracle.headSha = base; }, /only a getter|read only|Cannot set/);
assert.equal(oracle.headSha, head);
assert.equal(await oracle.grep({ query: "is_admin" }), "MATCHES 1\nsrc/auth.py:2|    return user.is_admin");
assert.equal(await oracle.grep({ query: "is_admin", side: "base" }), "MATCHES 0");
assert.equal(await oracle.grep({ query: "return False", side: "base", path: "src" }), "MATCHES 1\nsrc/auth.py:2|    return False");
assert.equal(await oracle.glob({ pattern: "**/*.py" }), "PATHS 1\nsrc/auth.py");
assert.equal(await oracle.glob({ pattern: "head-*.txt", side: "head" }), "PATHS 1\nhead-only.txt");
assert.equal(await oracle.glob({ pattern: "head-*.txt", side: "base" }), "PATHS 0");
assert.match(await oracle.view({ path: "src/auth.py", start_line: 2, end_line: 3 }), /^FILE src\/auth\.py @ head\nLINES 2-3 OF 3\n2\|    return user\.is_admin\n3\|unchanged = True$/);
assert.match(await oracle.view({ path: "src/auth.py", start_line: 2, end_line: 2, side: "base" }), /2\|    return False/);

// Shared-clone proposal objects exist only in the capsule Git directory.
const capsule = join(root, "capsule");
execFileSync("git", ["clone", "--shared", repo, capsule], { env, encoding: "utf8", stdio: "pipe" });
const capsuleGit = (...args) => execFileSync("git", args, { cwd: capsule, env, encoding: "utf8" }).trim();
const capsuleBase = capsuleGit("rev-parse", "HEAD");
writeFileSync(join(capsule, "capsule-only.txt"), "proposal object\n");
capsuleGit("add", "capsule-only.txt");
capsuleGit("commit", "-m", "capsule proposal");
const capsuleHead = capsuleGit("rev-parse", "HEAD");
const capsuleOracle = new RepoOracle(capsuleBase, capsuleHead, { gitDir: join(capsule, ".git") });
assert.equal(await capsuleOracle.grep({ query: "proposal object" }), "MATCHES 1\ncapsule-only.txt:1|proposal object");

await assert.rejects(oracle.view({ path: "../secret", start_line: 1, end_line: 1 }), /must not contain \.\./);
await assert.rejects(oracle.glob({ pattern: "/tmp/**" }), /repository-relative/);
await assert.rejects(oracle.grep({ query: "x", path: "src\\auth.py" }), /use \/ separators/);
await assert.rejects(oracle.view({ path: "src/auth.py" }), /requires integer start_line and end_line/);
assert.match(await oracle.view({ path: "missing.txt", start_line: 1, end_line: 1 }), /^ERROR path not found/);
assert.match(await oracle.view({ path: "asset.bin", start_line: 1, end_line: 1 }), /^BINARY /);
assert.match(await oracle.view({ path: "auth-link", start_line: 1, end_line: 1 }), /^SYMLINK .*not followed/);
assert.match(await oracle.view({ path: "src/long.txt", start_line: 1, end_line: 140 }), new RegExp(`LINES 1-${MINI_REVIEW_VIEW_LINE_LIMIT} OF 140`));

const capOracle = new RepoOracle(base, head, { gitDir: join(repo, ".git") });
const grepCap = await capOracle.grep({ query: "needle" });
assert.match(grepCap, new RegExp(`MATCHES 105`));
assert.match(grepCap, new RegExp(`TRUNCATED: showing ${MINI_REVIEW_GREP_LIMIT} of 105 matches`));
const globCap = await capOracle.glob({ pattern: "many/**" });
assert.match(globCap, new RegExp(`PATHS 105`));
assert.match(globCap, new RegExp(`TRUNCATED: showing ${MINI_REVIEW_GLOB_LIMIT} of 105 paths`));
const hugeView = await capOracle.view({ path: "src/huge.txt", start_line: 1, end_line: 1 });
assert.match(hugeView, /TRUNCATED/);
assert.ok(Buffer.byteLength(hugeView, "utf8") <= 32 * 1024);
for (let i = 3; i < MINI_REVIEW_INSPECT_LIMIT; i++) await capOracle.glob({ pattern: "no-match" });
assert.match(await capOracle.glob({ pattern: "**" }), /INSPECTION LIMIT REACHED.*submit_review/);

const findings = await new RepoOracle(base, head, { gitDir: join(repo, ".git") }).validateFindings([
  { path: "src/auth.py", line: 2, body: "Non-admin users can now authorize when is_admin is truthy." },
  { path: "src/delete.txt", line: 1, body: "Deleting the second record joins incompatible entries at the anchor." },
  { path: "src/delete-first.txt", line: 0, body: "Deleting the only line leaves the required record empty." },
]);
assert.equal(findings.length, 3);
await assert.rejects(
  new RepoOracle(base, head, { gitDir: join(repo, ".git") }).validateFindings([
    { path: "src/auth.py", line: 3, body: "unchanged" },
  ]),
  /not a HEAD-side changed line/,
);
await assert.rejects(
  new RepoOracle(base, head, { gitDir: join(repo, ".git") }).validateFindings([
    { path: "README.md", line: 1, body: "unknown" },
  ]),
  /path is not in the diff/,
);

assert.equal(MINI_REVIEW_SYSTEM_PROMPT, "You are a helpful assistant that can review code changes in a repository.");
const rendered = renderMiniReviewTask({
  task: "look 1 packet\n\nFiles:\nsrc/auth.py +1/-1\n\nPointers:\nsrc/auth.py:2",
  diff: "diff --git a/src/auth.py b/src/auth.py\n+changed",
});
assert.ok(rendered.startsWith("Please review this change: look 1 packet"));
assert.match(rendered, /Files:\nsrc\/auth\.py \+1\/-1/);
assert.match(rendered, /Pointers:\nsrc\/auth\.py:2/);
assert.doesNotMatch(rendered, /<diff>|diff --git|\+changed/);
assert.match(rendered, /Start from the packet/);
assert.match(rendered, /grep.*glob.*view/is);
assert.ok(rendered.endsWith('- Finish with "submit_review".'));
assert.deepEqual(MINI_REVIEW_TOOL_NAMES, ["grep", "glob", "view", "submit_review"]);
for (const schema of [
  miniReviewModuleForHmr.MINI_REVIEW_GREP_SCHEMA,
  miniReviewModuleForHmr.MINI_REVIEW_GLOB_SCHEMA,
  miniReviewModuleForHmr.MINI_REVIEW_VIEW_SCHEMA,
  miniReviewModuleForHmr.MINI_REVIEW_SUBMIT_SCHEMA,
]) {
  assert.equal(Object.isFrozen(schema), true);
  assert.equal(Object.isFrozen(schema.parameters), true);
}
assert.deepEqual(reviewFindingsToVerdictInput([]), {
  verdict: "pass",
  summary: "no defects introduced by this change",
  feedback: "",
  tests_modified: false,
});
const mapped = reviewFindingsToVerdictInput(findings);
assert.equal(mapped.verdict, "fail");
assert.equal(mapped.tests_modified, false);
assert.equal(mapped.summary, findings[0].body);
assert.equal(mapped.feedback, findings.map((finding) => `${finding.path}:${finding.line}: ${finding.body}`).join("\n\n"));
assert.equal(reviewFindingsToVerdictInput([{ ...findings[0], body: "z".repeat(300) }]).summary.length, 240);

const tools = buildMiniReviewTools();
assert.deepEqual(tools.map((tool) => tool.name), MINI_REVIEW_TOOL_NAMES);
assert.ok(tools.slice(0, 3).every((tool) => tool.isConcurrencySafe() === true));
assert.equal(tools[3].isConcurrencySafe(), false);
const fakeAgent = { session: { id: "session-review", header: { kind: "mini-review" } }, ctx: {} };
const order = [];
let submitCount = 0;
bindMiniReviewSubmit(fakeAgent, {
  oracle: { validateFindings: async (value) => value },
  submit: async ({ verdict }) => {
    assert.equal(verdict.verdict, "pass");
    submitCount++;
    if (submitCount === 1) {
      return withChildSettlement({ status: "ok", verdict: "pass" }, { arm() { order.push("arm"); } });
    }
    return { status: "ok", verdict: "pass", alreadySubmitted: true };
  },
});
const submitted = await tools[3].execute({ findings: [] }, {
  agent: fakeAgent,
  callId: "review-submit",
  concludeTurn() { order.push("conclude"); },
});
assert.equal(submitted.status, "ok");
assert.deepEqual(Reflect.ownKeys(submitted), ["status", "verdict"]);
assert.deepEqual(order, ["arm", "conclude"]);
const submittedAgain = await tools[3].execute({ findings: [] }, {
  agent: fakeAgent,
  callId: "review-submit-again",
  concludeTurn() { order.push("conclude-again"); },
});
assert.equal(submittedAgain.status, "ok");
assert.equal(submittedAgain.alreadySubmitted, true);
assert.deepEqual(order, ["arm", "conclude", "conclude-again"]);

const persistedAgent = { session: { id: "session-persisted-review", header: { kind: "mini-review" } }, ctx: {} };
let persistedConcluded = 0;
bindMiniReviewSubmit(persistedAgent, {
  oracle: { validateFindings: async () => assert.fail("idempotent closer must not revalidate findings") },
  isCompleted: () => true,
  submit: async ({ verdict }) => {
    assert.equal(verdict, undefined);
    return { status: "ok", verdict: "pass", alreadySubmitted: true };
  },
});
const persistedSubmit = await buildMiniReviewTools().at(-1).execute({ findings: [] }, {
  agent: persistedAgent,
  concludeTurn() { persistedConcluded++; },
});
assert.equal(persistedSubmit.status, "ok");
assert.equal(persistedSubmit.alreadySubmitted, true);
assert.equal(persistedConcluded, 1);

const invalidAgent = { session: { id: "session-invalid-review", header: { kind: "mini-review" } }, ctx: {} };
bindMiniReviewSubmit(invalidAgent, {
  oracle: { validateFindings: async () => assert.fail("unknown submit fields must refuse before validation") },
  submit: async () => assert.fail("unknown submit fields must not settle"),
});
const invalidSubmit = await buildMiniReviewTools().at(-1).execute({ findings: [], extra: true }, { agent: invalidAgent });
assert.equal(invalidSubmit.status, "refused");
assert.match(invalidSubmit.reason, /only the findings field/);

// A new module generation replaces, rather than stacks on, a live mount.
const mountedTools = [];
const mountedSections = [];
const mountedRestrictions = [];
const mountedListeners = [];
const mountOperations = [];
let runtimeSuppressed = false;
const mountCtx = {
  systemPrompt: {
    section(section) {
      mountedSections.push(section);
      return () => mountedSections.splice(mountedSections.indexOf(section), 1);
    },
    suppressRuntimeContext() { runtimeSuppressed = true; },
  },
  tools: {
    register(tool) {
      mountOperations.push(`register:${tool.name}`);
      mountedTools.push(tool);
      return () => mountedTools.splice(mountedTools.indexOf(tool), 1);
    },
    restrict(spec) {
      mountOperations.push("restrict");
      const record = { spec, active: true };
      mountedRestrictions.push(record);
      return () => { record.active = false; };
    },
  },
  effect(effect) { return effect(); },
  on(type, fn) {
    const record = { type, fn };
    mountedListeners.push(record);
    return () => mountedListeners.splice(mountedListeners.indexOf(record), 1);
  },
};
miniReviewModuleForHmr.miniReviewSetup(mountCtx);
assert.equal(runtimeSuppressed, true);
assert.equal(mountedSections.length, 1);
assert.equal(mountedSections[0].complete, true);
assert.equal(mountedSections[0].text, MINI_REVIEW_SYSTEM_PROMPT);
assert.deepEqual(mountedTools.map((tool) => tool.name), MINI_REVIEW_TOOL_NAMES);
assert.deepEqual(mountedRestrictions.filter((record) => record.active).map((record) => record.spec.allow), [[]]);
assert.deepEqual(mountOperations.slice(0, 5), [
  "restrict",
  "register:grep",
  "register:glob",
  "register:view",
  "register:submit_review",
]);
assert.equal(mountedListeners.length, 2);
assert.equal(miniReviewModuleForHmr.assembleMiniReviewPrompt(mountedSections, { runtimeSuppressed }), MINI_REVIEW_SYSTEM_PROMPT);
const durablyCompletedAgent = {
  session: { id: "session-durable-review", header: { kind: "mini-review" } },
  ctx: mountCtx,
  steer() { assert.fail("format recovery must not steer after a verdict is durably persisted"); },
};
bindMiniReviewSubmit(durablyCompletedAgent, {
  oracle: { validateFindings: async (value) => value },
  submit: async () => ({ status: "ok", verdict: "pass" }),
  isCompleted: () => true,
});
mountedListeners.find((item) => item.type === "agent/turn-stopping").fn({ agent: durablyCompletedAgent });
const nextGeneration = await import(`../src/mini-review.mjs?hmr=${Date.now()}`);
nextGeneration.miniReviewSetup(mountCtx);
assert.equal(mountedSections.length, 1);
assert.deepEqual(mountedTools.map((tool) => tool.name), MINI_REVIEW_TOOL_NAMES);
assert.deepEqual(mountedRestrictions.filter((record) => record.active).map((record) => record.spec.allow), [[]]);
assert.equal(mountedListeners.length, 2);

// Restriction is mandatory and precedes every plugin registration.
let registrationsAfterRestrictionFailure = 0;
const failedRestrictionCtx = {
  systemPrompt: {
    section() { return () => {}; },
    suppressRuntimeContext() {},
  },
  tools: {
    restrict(spec) {
      assert.deepEqual(spec, { allow: [] });
      throw new Error("global catalog restriction failed");
    },
    register() {
      registrationsAfterRestrictionFailure++;
      return () => {};
    },
  },
  effect(effect) { return effect(); },
};
assert.throws(
  () => miniReviewModuleForHmr.miniReviewSetup(failedRestrictionCtx),
  /global catalog restriction failed/,
);
assert.equal(registrationsAfterRestrictionFailure, 0);

console.log("mini-review tests passed");
