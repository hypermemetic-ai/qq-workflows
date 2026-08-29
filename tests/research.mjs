#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_HANDLE } from "../src/agent-handle.mjs";
import {
  RESEARCH_INLINE_ANSWER_MAX_CHARS,
  RESEARCH_REPORT_MAX_CHARS,
  createResearch,
  reportText,
} from "../src/research.mjs";
import { createResearchStore, RESEARCH_DELEGATION_SCHEMA } from "../src/research-store.mjs";
import { MINI_QA_SYSTEM_PROMPT } from "../src/mini-qa-v2.mjs";
import { MINI_SWE_COMPLETION_COMMAND } from "../src/mini-swe-v2.mjs";

const scratch = mkdtempSync(join(tmpdir(), "qq-research-run."));
const repo = join(scratch, "repo"); mkdirSync(repo);
writeFileSync(join(repo, "README.md"), "fixture repository\n");
const parentId = "session-44444444-4444-4444-8444-444444444444";
const parent = { session: { id: parentId, header: { cwd: repo } }, options: {} };
const sent = [];
const children = [];

function childContext() {
  const registered = [];
  const surfaceCalls = [];
  const sections = [];
  const listeners = [];
  const hostBashCommands = [];
  const baseBash = {
    name: "bash",
    description: "bash",
    parameters: { command: { type: "string" } },
    async execute(args) {
      hostBashCommands.push(args?.command);
      return {
        kind: "foreground",
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: 0,
        stdout: { text: "host bash fixture", truncated: false },
        stderr: { text: "", truncated: false },
      };
    },
  };
  const ctx = {
    registered, surfaceCalls, sections, listeners, hostBashCommands,
    systemPrompt: {
      section(value) { sections.push(value); return () => {}; },
      suppressRuntimeContext() {},
    },
    tools: {
      get(name) { return name === "bash" ? (registered.find((tool) => tool.name === name) ?? baseBash) : registered.find((tool) => tool.name === name); },
      register(tool) { registered.push(tool); return () => {}; },
    },
    effect(fn) { return fn(); },
    on(type, fn) {
      const record = { type, fn };
      listeners.push(record);
      return () => {
        const index = listeners.indexOf(record);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    async emit(type, ...args) {
      for (const { fn } of [...listeners].filter((record) => record.type === type)) await fn(...args);
    },
    get(name) {
      if (name === "tools") return this.tools;
      if (name === "systemPrompt") return this.systemPrompt;
      if (name === "qq-core") return {
        surface: { allow(agent, names) { surfaceCalls.push({ agent, names: [...names] }); } },
      };
      return undefined;
    },
  };
  return ctx;
}

const agents = {
  get(id) { return children.find((child) => child.session.id === id); },
  async create(options) {
    const ctx = childContext();
    const child = {
      status: "running",
      session: {
        id: options.sessionId,
        header: { ...options.meta },
        events: [],
        append(type, data) { this.events.push({ type, data }); },
      },
      ctx,
      options: options.agentOptions ?? {},
      followups: [],
      disposeCount: 0,
      followup(message) { this.followups.push(message); },
    };
    ctx.agent = child;
    options.setup?.(ctx);
    const handle = { agent: child, async dispose() { child.disposeCount++; child.disposed = true; } };
    children.push(child);
    return handle;
  },
};

async function commitToolResult(child, callId, { isError = false } = {}) {
  const message = {
    role: "user",
    source: { kind: "tool", callId },
    content: [{ type: "tool-result", toolCallId: callId, isError, content: [] }],
  };
  const event = { type: "tool/result", data: { message } };
  child.session.events.push(event);
  await child.ctx.emit("session/event", child.session, event);
}

async function setAgentStatus(child, status) {
  child.status = status;
  await child.ctx.emit("agent/status", { agent: child, status });
}

let coreRootLookups = 0;
const ctx = {
  get(name) {
    if (name === "qq-relay") return {
      async send(message) { sent.push(message); return { status: "sent" }; },
    };
    if (name === "qq-core") return {
      gitRootForDelegate(cwd) {
        coreRootLookups++;
        assert.equal(cwd, repo);
        return repo;
      },
    };
    if (name === "qq") throw new Error("research must prefer the qq-core handle");
    return null;
  },
};
// A restart/HMR must discover and re-key live v1 research children before
// their completion handlers try to resolve the old research-* machine id.
const restartDir = join(scratch, "legacy-restart");
mkdirSync(restartDir);
const legacyCapsule = join(scratch, "legacy-capsule");
const legacyRepo = join(scratch, "legacy-repo");
mkdirSync(join(legacyCapsule, "repo"), { recursive: true });
mkdirSync(legacyRepo);
const legacyResearchId = "research-a8b4e673";
const legacyResearchSession = "session-55555555-5555-4555-8555-555555555555";
const legacyReviewSession = "session-66666666-6666-4666-8666-666666666666";
const legacyCreatedAt = "2026-08-29T12:12:58.375Z";
const legacyUpdatedAt = "2026-08-29T12:54:47.769Z";
const legacyReviewing = {
  schema: "qq.research-run/v1",
  id: legacyResearchId,
  status: "reviewing",
  parentSessionUuid: parentId,
  root: legacyCapsule,
  repoRoot: legacyRepo,
  question: "Can a live reviewing child survive restart?",
  researchSession: legacyResearchSession,
  reviewSession: legacyReviewSession,
  webCandidates: [{ ref: "W001", url: "https://fixture.test/restart", title: "Restart", snippet: "durable evidence" }],
  sessionCandidates: [{ ref: "S001", sessionId: parentId, seq: 7, title: "Session", snippet: "durable context" }],
  citationCheck: { ok: true, citations: ["W001", "S001"] },
  reviewFindings: [{ line: 3, body: "preserve this finding" }],
  blockedReason: "",
  reportMessageId: "77777777-7777-4777-8777-777777777777",
  reported: false,
  createdAt: legacyCreatedAt,
  updatedAt: legacyUpdatedAt,
};
writeFileSync(join(restartDir, `${legacyResearchId}.json`), `${JSON.stringify(legacyReviewing, null, 2)}\n`);

const legacyBlockedId = "research-deadbeef";
const blockedResearchSession = "session-88888888-8888-4888-8888-888888888888";
writeFileSync(join(restartDir, `${legacyBlockedId}.json`), `${JSON.stringify({
  ...legacyReviewing,
  id: legacyBlockedId,
  status: "blocked",
  researchSession: blockedResearchSession,
  reviewSession: "",
  webCandidates: [],
  sessionCandidates: [],
  citationCheck: null,
  reviewFindings: [],
  blockedReason: "mini-research child closed before completion",
  reportMessageId: "99999999-9999-4999-8999-999999999999",
  reported: true,
}, null, 2)}\n`);

const legacyResearchingId = "research-feedface";
const activeResearchSession = "session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
writeFileSync(join(restartDir, `${legacyResearchingId}.json`), `${JSON.stringify({
  ...legacyReviewing,
  id: legacyResearchingId,
  status: "researching",
  researchSession: activeResearchSession,
  reviewSession: "",
  reviewFindings: [],
  blockedReason: "",
  reportMessageId: "",
}, null, 2)}\n`);

const restartedStore = createResearchStore(restartDir);
const existingV2Id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
restartedStore.create({
  id: existingV2Id,
  status: "completed",
  parentSessionUuid: parentId,
  root: legacyCapsule,
  repoRoot: legacyRepo,
  question: "Existing v2 record",
});
writeFileSync(join(restartDir, "research-nothex00.json"), "ignored\n");
writeFileSync(join(restartDir, "notes.json"), "ignored\n");

const mixedRecords = restartedStore.list();
assert.equal(mixedRecords.length, 4, "list discovers mixed v1 and v2 research files");
assert.ok(mixedRecords.some((record) => record.id === existingV2Id));
assert.ok(mixedRecords.every((record) => record.schema === RESEARCH_DELEGATION_SCHEMA));
assert.ok(mixedRecords.every((record) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.id)));

const reviewByQa = restartedStore.bySession(legacyReviewSession);
const reviewByResearch = restartedStore.bySession(legacyResearchSession);
assert.equal(reviewByQa.id, reviewByResearch.id, "both live child sessions resolve the upgraded delegation");
assert.notEqual(reviewByQa.id, legacyResearchId);
assert.equal(reviewByQa.schema, RESEARCH_DELEGATION_SCHEMA);
for (const field of [
  "status", "parentSessionUuid", "root", "repoRoot", "question", "researchSession", "reviewSession",
  "webCandidates", "sessionCandidates", "citationCheck", "reviewFindings", "blockedReason",
  "reportMessageId", "reported", "createdAt", "updatedAt",
]) {
  assert.deepEqual(reviewByQa[field], legacyReviewing[field], `legacy research upgrade preserves ${field}`);
}
assert.equal(existsSync(join(restartDir, `${legacyResearchId}.json`)), false);
assert.equal(existsSync(restartedStore.fileFor(reviewByQa.id)), true);
assert.equal(JSON.parse(readFileSync(restartedStore.fileFor(reviewByQa.id), "utf8")).schema, RESEARCH_DELEGATION_SCHEMA);
assert.equal(restartedStore.load(legacyResearchId.toUpperCase()).id, reviewByQa.id, "legacy id remains an alias until child rebind");

const researchingAfterRestart = restartedStore.bySession(activeResearchSession);
assert.equal(researchingAfterRestart.status, "researching");
assert.equal(existsSync(join(restartDir, `${legacyResearchingId}.json`)), false);

const blockedAfterRestart = restartedStore.bySession(blockedResearchSession);
assert.equal(blockedAfterRestart.status, "blocked");
assert.equal(blockedAfterRestart.blockedReason, "mini-research child closed before completion");
assert.equal(blockedAfterRestart.reported, true);
assert.equal(existsSync(join(restartDir, `${legacyBlockedId}.json`)), false);
assert.deepEqual(
  readdirSync(restartDir).filter((name) => name.endsWith(".json") && name !== "notes.json" && name !== "research-nothex00.json").sort(),
  [existingV2Id, reviewByQa.id, researchingAfterRestart.id, blockedAfterRestart.id].sort().map((id) => `${id}.json`),
);

const resumedReviewCtx = childContext();
const resumedReview = {
  status: "idle",
  session: {
    id: legacyReviewSession,
    header: { kind: "mini-qa" },
    events: [],
    append(type, data) { this.events.push({ type, data }); },
  },
  ctx: resumedReviewCtx,
  options: {},
};
resumedReviewCtx.agent = resumedReview;
let resumedReviewDisposed = 0;
const resumedReviewHandle = { agent: resumedReview, async dispose() { resumedReviewDisposed++; } };
Object.defineProperty(resumedReview, AGENT_HANDLE, { value: resumedReviewHandle, configurable: true });
const restartedResearch = createResearch({ ctx, store: restartedStore, agents, parentDir: restartDir, env: {} });
assert.equal(restartedResearch.resumeChild(resumedReview), true, "resumeChild rebinds the upgraded reviewing child");
assert.deepEqual(resumedReviewCtx.registered.map((tool) => tool.name), ["bash", "submit_review"]);
restartedResearch.dispose();
assert.equal(resumedReview[AGENT_HANDLE], resumedReviewHandle, "HMR detaches without dropping the live handle capability");
const completedLegacy = restartedStore.load(reviewByQa.id);
restartedStore.save({ ...completedLegacy, status: "completed" });
const replacementResearch = createResearch({ ctx, store: restartedStore, agents, parentDir: restartDir, env: {} });
assert.equal(replacementResearch.resumeChild(resumedReview), true, "replacement controller recognizes a completed but unreported review child");
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(resumedReviewDisposed, 0, "unreported review child stays retained until report delivery and durable tool-result settlement");
assert.equal(resumedReview[AGENT_HANDLE], resumedReviewHandle);
replacementResearch.dispose();

const parentDir = join(scratch, "research");
const store = createResearchStore(parentDir);
const provider = {
  async search() { return [{ title: "Fixture", url: "https://fixture.test/evidence", snippet: "lead" }]; },
  async get(url) { return { source: url, status: 200, contentType: "text/html", content: "<p>fixture evidence supports the answer</p>" }; },
};
const research = createResearch({ ctx, store, agents, parentDir, webProvider: provider, env: {} });
const delegationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const started = await research.invoke({ agent: parent, question: "What does the fixture show?", delegationId });
assert.equal(started.status, "ok", started.reason);
const mixedCaseDelegationId = delegationId.toUpperCase();
assert.equal(store.load(mixedCaseDelegationId).id, delegationId, "research filenames are addressed by canonical UUID");
const mixedCaseStatus = research.workflowStatus({ delegationId: mixedCaseDelegationId, parentSessionUuid: parentId });
assert.equal(mixedCaseStatus.status, "ok", mixedCaseStatus.reason);
assert.equal(mixedCaseStatus.delegationId, delegationId);
const mixedCaseSend = await research.workflowSend({
  delegationId: mixedCaseDelegationId,
  parentSessionUuid: parentId,
  message: "Check the fixture carefully.",
});
assert.equal(mixedCaseSend.status, "sent", mixedCaseSend.reason);
assert.equal(coreRootLookups, 1);
assert.equal(children.length, 1);
assert.equal(children[0].session.header.kind, "mini-research");
assert.deepEqual(
  children[0].session.events.filter((event) => event.type === "approval/policy"),
  [{ type: "approval/policy", data: { policy: "never", source: "delegation" } }],
  "custom research child starts non-interactive",
);
assert.equal(children[0].session.events.some((event) => event.type === "sandbox/mode"), false, "approval pin does not replace the child sandbox");
const spawnedResearchTask = children[0].followups[0].content[0].text;
assert.match(spawnedResearchTask, /^Please research the exact question in question\.md\./);
assert.doesNotMatch(spawnedResearchTask, /What does the fixture show\?/);
assert.match(spawnedResearchTask, /## Recommended Workflow/);
assert.deepEqual(children[0].ctx.surfaceCalls, [{ agent: children[0], names: ["bash"] }]);
const researchBash = children[0].ctx.registered.find((tool) => tool.name === "bash");
assert.equal((await researchBash.execute({ command: "web-search 'fixture'" }, { agent: children[0] })).exitCode, 0);
assert.equal((await researchBash.execute({ command: "web-get W001" }, { agent: children[0] })).exitCode, 0);
writeFileSync(join(started.workspace, "answer.md"), "The fixture supports the answer [W001].\n");
let concluded = 0;
const researchCallId = "research-complete-call";
const completed = await researchBash.execute({ command: MINI_SWE_COMPLETION_COMMAND }, {
  agent: children[0], callId: researchCallId, concludeTurn() { concluded++; },
});
assert.equal(completed.exitCode, 0, completed.stderr?.text);
assert.equal(concluded, 1);
assert.equal(children.length, 2, "accepted research spawns one fresh review context");
assert.equal(children[0].disposeCount, 0, "accepted handler does not dispose before its tool result commits");
await commitToolResult(children[0], "unrelated-call");
assert.equal(children[0].disposeCount, 0, "unrelated tool results cannot settle the child");
await commitToolResult(children[0], researchCallId);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(children[0].disposeCount, 0, "matching result alone does not dispose a running child");
await setAgentStatus(children[0], "idle");
assert.equal(await research.whenSettled(children[0].session.id), true);
assert.equal(children[0].disposeCount, 1, "research child disposes after exact result commit and idle");
const review = children[1];
assert.equal(review.session.header.kind, "mini-qa");
assert.deepEqual(
  review.session.events.filter((event) => event.type === "approval/policy"),
  [{ type: "approval/policy", data: { policy: "never", source: "delegation" } }],
  "custom QA child starts non-interactive",
);
assert.deepEqual(review.ctx.surfaceCalls, [{ agent: review, names: ["bash"] }]);
assert.deepEqual(review.ctx.registered.map((tool) => tool.name), ["bash", "submit_review"]);
const reviewBash = review.ctx.registered.find((tool) => tool.name === "bash");
assert.equal(reviewBash.isConcurrencySafe(), false);
assert.deepEqual(Object.keys(reviewBash.parameters.properties), ["command"]);
const ordinaryBash = await reviewBash.execute({ command: "web-search 'not intercepted'" }, { agent: review });
assert.equal(ordinaryBash.exitCode, 0);
assert.equal(review.ctx.hostBashCommands.length, 1);
assert.match(review.ctx.hostBashCommands[0], /; web-search 'not intercepted'$/);
assert.equal(
  review.ctx.sections.find((section) => section.name === "deployment:persona").text,
  MINI_QA_SYSTEM_PROMPT,
  "research review uses the standard Mini QA persona",
);
const spawnedReviewTask = review.followups[0].content[0].text;
assert.match(spawnedReviewTask, /^Please review the proposed research answer using the exact capsule artifacts\./);
assert.ok(spawnedReviewTask.includes("question.md"));
assert.ok(spawnedReviewTask.includes("answer.md"));
assert.ok(spawnedReviewTask.includes("evidence/manifest.jsonl"));
assert.doesNotMatch(spawnedReviewTask, /What does the fixture show\?/);
assert.doesNotMatch(spawnedReviewTask, /The fixture supports the answer/);
assert.doesNotMatch(spawnedReviewTask, /"ref":"W001"/);
assert.match(spawnedReviewTask, /Use ordinary bash in this capsule/);
assert.match(spawnedReviewTask, /unsupported claims/);
const submit = review.ctx.registered.find((tool) => tool.name === "submit_review");
const reviewCallId = "research-review-call";
const reviewResult = await submit.execute({ findings: [] }, { agent: review, callId: reviewCallId, concludeTurn() {} });
assert.equal(reviewResult.status, "ok", reviewResult.reason);
assert.equal(review.disposeCount, 0, "QA remains live until its result is durable and idle");
await setAgentStatus(review, "idle");
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(review.disposeCount, 0, "idle alone cannot settle QA before the matching result");
await commitToolResult(review, reviewCallId, { isError: true });
assert.equal(await research.whenSettled(review.session.id), true);
assert.equal(review.disposeCount, 1, "saved QA pass settles after its matching error envelope commits and the child is idle");
assert.equal(sent.length, 2);
assert.equal(sent[0].to, children[0].session.id);
assert.equal(sent[0].message, "Check the fixture carefully.");
assert.equal(sent[1].to, parentId);
assert.match(sent[1].message, /Citation check: passed/);
assert.match(sent[1].message, /Review findings: 0/);
assert.match(sent[1].message, /Immutable answer path:/);
assert.equal(store.load(started.delegationId).status, "completed");
const mixedCaseStop = await research.workflowStop({
  delegationId: mixedCaseDelegationId,
  parentSessionUuid: parentId,
});
assert.equal(mixedCaseStop.status, "refused");
assert.match(mixedCaseStop.reason, /terminal \(completed\)/);
const maximumAnswer = "A".repeat(256 * 1024);
const largeReport = reportText({
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  root: "/private/research-capsule",
  answerBytes: Buffer.byteLength(maximumAnswer),
  answerSha256: "f".repeat(64),
  citationCheck: { ok: true },
  reviewFindings: [],
}, maximumAnswer);
assert.ok(maximumAnswer.length > RESEARCH_INLINE_ANSWER_MAX_CHARS);
assert.ok(largeReport.length <= RESEARCH_REPORT_MAX_CHARS);
assert.match(largeReport, /BOUNDED PREVIEW ONLY/);
assert.match(largeReport, /Answer bytes: 262144/);
assert.match(largeReport, /Answer SHA-256: f{64}/);
assert.match(largeReport, /Immutable answer path:/);
assert.ok(!largeReport.includes("A".repeat(RESEARCH_INLINE_ANSWER_MAX_CHARS)));

console.log("research fixture: ok");
