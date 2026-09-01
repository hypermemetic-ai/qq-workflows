#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as miniQaModuleForHmr from "../src/mini-qa.mjs";
import {
  bindMiniQaSubmit,
  buildMiniQaTools,
  MINI_QA_SYSTEM_PROMPT,
  MINI_QA_TOOL_NAMES,
  renderMiniQaTask,
  reviewFindingsToVerdictInput,
} from "../src/mini-qa.mjs";
import {
  MINI_PAGER_EXPORT,
  MINI_SWE_COMPLETION_COMMAND,
  OBSERVATION_MAX_CHARS,
} from "../src/official-mini.mjs";
import { RepoOracle } from "../src/repo-oracle.mjs";
import { withChildSettlement } from "../src/child-settlement.mjs";

const root = mkdtempSync(join(tmpdir(), "qq-mini-qa."));
const repo = join(root, "repo");
mkdirSync(repo);
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "mini-qa-test",
  GIT_AUTHOR_EMAIL: "mini-qa@test",
  GIT_COMMITTER_NAME: "mini-qa-test",
  GIT_COMMITTER_EMAIL: "mini-qa@test",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const git = (...args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
git("init", "-b", "main");
git("config", "user.name", "mini-qa-test");
git("config", "user.email", "mini-qa@test");
mkdirSync(join(repo, "src"));
writeFileSync(join(repo, "src/auth.py"), "def authorize(user):\n    return False\nunchanged = True\n");
writeFileSync(join(repo, "src/delete.txt"), "anchor\nremove me\ntail\n");
writeFileSync(join(repo, "src/delete-first.txt"), "only line\n");
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

// RepoOracle is only the two-SHA changed-line validator used by submit_review.
const oracle = new RepoOracle(base, head, { gitDir: join(repo, ".git") });
assert.equal(Object.isFrozen(oracle), true);
assert.throws(() => { oracle.headSha = base; }, /only a getter|read only|Cannot set/);
assert.equal(oracle.baseSha, base);
assert.equal(oracle.headSha, head);
assert.equal(oracle.gitDir, join(repo, ".git"));
assert.throws(() => new RepoOracle("HEAD", head, { gitDir: join(repo, ".git") }), /full base and head commit SHAs/);
assert.throws(() => new RepoOracle(base, head), /capsule git directory/);
assert.equal(typeof oracle.grep, "undefined");
assert.equal(typeof oracle.glob, "undefined");
assert.equal(typeof oracle.view, "undefined");

const findings = await oracle.validateFindings([
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
await assert.rejects(
  new RepoOracle(base, head, { gitDir: join(repo, ".git") }).validateFindings([
    { path: "../src/auth.py", line: 2, body: "escape" },
  ]),
  /must not contain \.\./,
);

assert.equal(MINI_QA_SYSTEM_PROMPT, "You are a helpful assistant that can review code changes in a repository.");
const rendered = renderMiniQaTask({
  task: `look 1 packet\n\nBase: ${base}\nHead: ${head}\n\nFiles:\nsrc/auth.py +1/-1\n\nPointers:\nsrc/auth.py:2`,
  diff: "diff --git a/src/auth.py b/src/auth.py\n+changed",
});
assert.ok(rendered.startsWith("Please review this change: look 1 packet"));
assert.match(rendered, /Files:\nsrc\/auth\.py \+1\/-1/);
assert.match(rendered, /Pointers:\nsrc\/auth\.py:2/);
assert.doesNotMatch(rendered, /<diff>|diff --git|\+changed/);
assert.match(rendered, /starting point/);
for (const command of ["git diff", "git show", "git grep", "rg", "sed -n"]) assert.match(rendered, new RegExp(command));
assert.match(rendered, /Do not edit files, commit, or otherwise change the worktree/);
assert.match(rendered, /Do not run the Mini completion command/);
assert.match(rendered, /Every response must call bash or submit_review/);
assert.doesNotMatch(rendered, /sed -i|COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT/);
assert.ok(rendered.endsWith('- Finish with "submit_review".'));
assert.deepEqual(MINI_QA_TOOL_NAMES, ["bash", "submit_review"]);
for (const removed of [
  "MINI_QA_GREP_SCHEMA",
  "MINI_QA_GLOB_SCHEMA",
  "MINI_QA_VIEW_SCHEMA",
  "MINI_QA_GREP_LIMIT",
  "MINI_QA_GLOB_LIMIT",
  "MINI_QA_VIEW_LINE_LIMIT",
  "MINI_QA_VIEW_BYTE_LIMIT",
]) assert.equal(miniQaModuleForHmr[removed], undefined);
assert.equal(Object.isFrozen(miniQaModuleForHmr.MINI_QA_SUBMIT_SCHEMA), true);
assert.equal(Object.isFrozen(miniQaModuleForHmr.MINI_QA_SUBMIT_SCHEMA.parameters), true);

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

// The plugin owns only typed completion. Bash is the wrapped host catalog tool.
const tools = buildMiniQaTools();
assert.deepEqual(tools.map((tool) => tool.name), ["submit_review"]);
assert.equal(tools[0].isConcurrencySafe(), false);
const fakeAgent = { session: { id: "session-review", header: { kind: "mini-qa" } }, ctx: {} };
const order = [];
let submitCount = 0;
let validationCount = 0;
bindMiniQaSubmit(fakeAgent, {
  oracle: { validateFindings: async (value) => { validationCount++; return value; } },
  submit: async ({ verdict }) => {
    assert.equal(verdict.verdict, "pass");
    submitCount++;
    if (submitCount === 1) {
      return withChildSettlement({ status: "ok", verdict: "pass" }, { arm() { order.push("arm"); } });
    }
    return { status: "ok", verdict: "pass", alreadySubmitted: true };
  },
});
const submitted = await tools[0].execute({ findings: [] }, {
  agent: fakeAgent,
  callId: "review-submit",
  concludeTurn() { order.push("conclude"); },
});
assert.equal(submitted.status, "ok");
assert.deepEqual(Reflect.ownKeys(submitted), ["status", "verdict"]);
assert.deepEqual(order, ["arm", "conclude"]);
const submittedAgain = await tools[0].execute({ findings: [] }, {
  agent: fakeAgent,
  callId: "review-submit-again",
  concludeTurn() { order.push("conclude-again"); },
});
assert.equal(submittedAgain.status, "ok");
assert.equal(submittedAgain.alreadySubmitted, true);
assert.equal(submitCount, 1, "accepted review cannot re-enter its durable submit sink");
assert.equal(validationCount, 1, "accepted review cannot restart validation");
assert.deepEqual(order, ["arm", "conclude", "conclude-again"]);

const persistedAgent = { session: { id: "session-persisted-review", header: { kind: "mini-qa" } }, ctx: {} };
let persistedConcluded = 0;
bindMiniQaSubmit(persistedAgent, {
  oracle: { validateFindings: async () => assert.fail("idempotent closer must not revalidate findings") },
  isCompleted: () => true,
  submit: async ({ verdict }) => {
    assert.equal(verdict, undefined);
    return { status: "ok", verdict: "pass", alreadySubmitted: true };
  },
});
const persistedSubmit = await buildMiniQaTools()[0].execute({ findings: [] }, {
  agent: persistedAgent,
  concludeTurn() { persistedConcluded++; },
});
assert.equal(persistedSubmit.status, "ok");
assert.equal(persistedSubmit.alreadySubmitted, true);
assert.equal(persistedConcluded, 1);

const invalidAgent = { session: { id: "session-invalid-review", header: { kind: "mini-qa" } }, ctx: {} };
bindMiniQaSubmit(invalidAgent, {
  oracle: { validateFindings: async () => assert.fail("unknown submit fields must refuse before validation") },
  submit: async () => assert.fail("unknown submit fields must not settle"),
});
const invalidSubmit = await buildMiniQaTools()[0].execute({ findings: [], extra: true }, { agent: invalidAgent });
assert.equal(invalidSubmit.status, "refused");
assert.match(invalidSubmit.reason, /only the findings field/);
assert.throws(
  () => bindMiniQaSubmit({ session: {} }, { submit() {} }),
  /requires an oracle and submit function/,
);

// A new module generation replaces, rather than stacks on, a live mount.
const mountedTools = [];
const mountedSections = [];
const surfaceCalls = [];
const mountedListeners = [];
const mountOperations = [];
const hostCalls = [];
const hostBash = {
  name: "bash",
  description: "Host bash",
  parameters: { type: "object", properties: { command: { type: "string" } } },
  async execute(args) {
    hostCalls.push(args);
    const text = args.command.includes("long-output") ? "x".repeat(OBSERVATION_MAX_CHARS + 2_000) : "host bash ran\n";
    return {
      kind: "foreground",
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 0,
      stdout: { text, truncated: false },
      stderr: { text: "", truncated: false },
    };
  },
};
let runtimeSuppressed = false;
const mountAgent = { id: "mini-qa-mount" };
const mountCtx = {
  agent: mountAgent,
  get(name) {
    assert.equal(name, "qq-core");
    return { surface: { allow(agent, names) {
      mountOperations.push("allow");
      surfaceCalls.push({ agent, names: [...names] });
    } } };
  },
  systemPrompt: {
    section(section) {
      mountedSections.push(section);
      return () => mountedSections.splice(mountedSections.indexOf(section), 1);
    },
    suppressRuntimeContext() { runtimeSuppressed = true; },
  },
  tools: {
    get(name) {
      if (name !== "bash") return undefined;
      return [...mountedTools].reverse().find((tool) => tool.name === name) ?? hostBash;
    },
    register(tool) {
      mountOperations.push(`register:${tool.name}`);
      mountedTools.push(tool);
      return () => {
        const index = mountedTools.indexOf(tool);
        if (index >= 0) mountedTools.splice(index, 1);
      };
    },
  },
  effect(effect) { return effect(); },
  on(type, fn) {
    const record = { type, fn };
    mountedListeners.push(record);
    return () => mountedListeners.splice(mountedListeners.indexOf(record), 1);
  },
};
miniQaModuleForHmr.miniQaSetup(mountCtx);
assert.equal(runtimeSuppressed, true);
assert.equal(mountedSections.length, 1);
assert.equal(mountedSections[0].complete, true);
assert.equal(mountedSections[0].text, MINI_QA_SYSTEM_PROMPT);
assert.deepEqual(mountedTools.map((tool) => tool.name), MINI_QA_TOOL_NAMES);
assert.deepEqual(surfaceCalls, [{ agent: mountAgent, names: ["bash", "read_image"] }]);
assert.deepEqual(mountOperations.slice(0, 3), ["allow", "register:bash", "register:submit_review"]);
assert.equal(mountedTools[0].isConcurrencySafe(), false);
assert.equal(mountedListeners.length, 2);
assert.equal(miniQaModuleForHmr.assembleMiniQaPrompt(mountedSections, { runtimeSuppressed }), MINI_QA_SYSTEM_PROMPT);

const bashResult = await mountedTools[0].execute({ command: "long-output" }, {});
assert.equal(hostCalls.length, 1);
assert.equal(hostCalls[0].description, "Execute Mini SWE bash command");
assert.equal(hostCalls[0].command, `${MINI_PAGER_EXPORT}; long-output`);
const observation = JSON.parse(mountedTools[0].finalizeContent({}, bashResult)[0].text);
assert.equal(observation.returncode, 0);
assert.equal(observation.output_head.length, 5_000);
assert.equal(observation.output_tail.length, 5_000);
assert.equal(observation.elided_chars, 2_000);
assert.equal(observation.warning, "Output too long.");

// Review bash deliberately bypasses Mini implementation completion interception.
const sentinelResult = await mountedTools[0].execute({ command: MINI_SWE_COMPLETION_COMMAND }, {});
assert.equal(sentinelResult.exitCode, 0);
assert.equal(hostCalls.length, 2);
assert.equal(hostCalls[1].command, `${MINI_PAGER_EXPORT}; ${MINI_SWE_COMPLETION_COMMAND}`);

const steers = [];
const formatAgent = {
  session: { id: "session-format-review", header: { kind: "mini-qa" } },
  ctx: mountCtx,
  steer(message) { steers.push(message); },
};
mountedListeners.find((item) => item.type === "agent/turn-stopping").fn({ agent: formatAgent });
assert.equal(steers.length, 1);
const steerText = steers[0].content[0].text;
assert.match(steerText, /bash or submit_review/);
assert.doesNotMatch(steerText, /\b(?:grep|glob|view)\b|COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT/);

const durablyCompletedAgent = {
  session: { id: "session-durable-review", header: { kind: "mini-qa" } },
  ctx: mountCtx,
  steer() { assert.fail("format recovery must not steer after a verdict is durably persisted"); },
};
bindMiniQaSubmit(durablyCompletedAgent, {
  oracle: { validateFindings: async (value) => value },
  submit: async () => ({ status: "ok", verdict: "pass" }),
  isCompleted: () => true,
});
mountedListeners.find((item) => item.type === "agent/turn-stopping").fn({ agent: durablyCompletedAgent });
const nextGeneration = await import(`../src/mini-qa.mjs?hmr=${Date.now()}`);
nextGeneration.miniQaSetup(mountCtx);
assert.equal(mountedSections.length, 1);
assert.deepEqual(mountedTools.map((tool) => tool.name), MINI_QA_TOOL_NAMES);
assert.deepEqual(surfaceCalls, [
  { agent: mountAgent, names: ["bash", "read_image"] },
  { agent: mountAgent, names: ["bash", "read_image"] },
]);
assert.equal(mountedListeners.length, 2);

// A host bash is mandatory.
const missingBashCtx = {
  agent: { id: "missing-bash" },
  get() { return { surface: { allow() {} } }; },
  systemPrompt: {
    section() { return () => {}; },
    suppressRuntimeContext() {},
  },
  tools: {
    get() { return undefined; },
    register() { return () => {}; },
  },
};
assert.throws(() => miniQaModuleForHmr.miniQaSetup(missingBashCtx), /requires a bash tool to wrap/);

// Surface assignment is mandatory and fails before bash lookup or registration.
let lookupsAfterSurfaceFailure = 0;
let registrationsAfterSurfaceFailure = 0;
const failedSurfaceCtx = {
  agent: { id: "failed-surface" },
  get(name) {
    assert.equal(name, "qq-core");
    return { surface: { allow(agent, names) {
      assert.equal(agent, failedSurfaceCtx.agent);
      assert.deepEqual(names, ["bash", "read_image"]);
      throw new Error("inherited surface assignment failed");
    } } };
  },
  systemPrompt: {
    section() { return () => {}; },
    suppressRuntimeContext() {},
  },
  tools: {
    get() { lookupsAfterSurfaceFailure++; return hostBash; },
    register() { registrationsAfterSurfaceFailure++; return () => {}; },
  },
};
assert.throws(
  () => miniQaModuleForHmr.miniQaSetup(failedSurfaceCtx),
  /inherited surface assignment failed/,
);
assert.equal(lookupsAfterSurfaceFailure, 0);
assert.equal(registrationsAfterSurfaceFailure, 0);

console.log("mini-qa tests passed");
