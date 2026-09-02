#!/usr/bin/env node
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CHILD_COMPILER_IDENTITY, installChildCompaction } from "../src/child-compaction.mjs";
import { RECALL_NOTE } from "../src/conversation-compiler/index.mjs";

const candidates = [
  process.env.QQ_DSH_NODE_MODULES,
  join(homedir(), "projects", "qq-core", "dsh", "node_modules", "@deepseek-ai"),
  resolve(process.cwd(), "..", "qq-core", "dsh", "node_modules", "@deepseek-ai"),
  resolve(process.cwd(), "../../..", "qq-core", "dsh", "node_modules", "@deepseek-ai"),
].filter(Boolean);
let modules;
for (const candidate of candidates) {
  try {
    await access(join(candidate, "dsh-compaction-basic", "lib", "index.js"));
    modules = candidate;
    break;
  } catch { /* try the next known toolchain location */ }
}
if (!modules) {
  console.log("child compaction DSH: skipped (toolchain unavailable)");
  process.exit(0);
}
const load = (name) => import(pathToFileURL(join(modules, name, "lib", "index.js")));
const { Context } = await load("cordis");
const { BasicCompactionEngine } = await load("dsh-compaction-basic");
const { TokenMeter } = await load("dsh-token-meter");
const { Session } = await load("dsh-session");
const { createUserMessage, createAssistantMessage, createToolResultMessage } = await load("dsh-llm");

const root = new Context();
const llmCalls = [];
const dependencies = root.plugin((ctx) => {
  ctx.provide("llm", {
    stream() { llmCalls.push(true); },
    async resolveModelInfo() { return { context: { contextWindow: 100_000 } }; },
  });
  ctx.provide("sessions", {});
});
await dependencies;
const meterFiber = root.plugin(TokenMeter, {});
await meterFiber;
const baseFiber = root.plugin(BasicCompactionEngine, { auto: false });
await baseFiber;
const rootEngine = root.get("compaction", false);
assert.equal(rootEngine.config.auto, false, "the root compactor remains disabled");

async function mounted(session) {
  const agent = { session, options: { provider: "test-provider", model: "test-model" } };
  let lift;
  const owner = root.plugin((ctx) => { lift = installChildCompaction(ctx.extend({ agent })); });
  await owner;
  await lift.ready;
  const engine = lift.engineFiber.ctx.get("compaction", false);
  assert.ok(engine instanceof BasicCompactionEngine);
  assert.notEqual(engine, rootEngine);
  assert.equal(engine.config.auto, true);
  assert.equal(engine.config.retainTokens, 25_000);
  return { agent, engine, owner };
}

function userText(prefix, words = 1_800) {
  return createUserMessage({
    source: { kind: "user" },
    content: [{ type: "text", text: Array.from({ length: words }, (_, index) => `${prefix}${index}`).join(" ") }],
  });
}
function assistantText(text) {
  return createAssistantMessage({
    source: { provider: "test-provider", model: "test-model" },
    content: [{ type: "text", text }],
  });
}

const session = Session.create("session-55555555-5555-4555-8555-555555555555");
session.append("turn/start", { turn: 1 });
session.append("user/message", userText("requirement"), { surfaceOp: "append" });
session.append("step/start", { turn: 1, step: 1 });
session.append("assistant/message", {
  turn: 1, step: 1, message: assistantText("Implemented the retry workflow and tests pass."),
}, { surfaceOp: "append" });
const mountedSession = await mounted(session);
const first = await mountedSession.engine.compactRegion(1, 3, mountedSession.agent, new AbortController().signal);
assert.deepEqual(first.shadowedSeqs, [1, 3]);
assert.equal(session.surface.nodes.length, 1);
let replacementSeq = session.surface.nodes[0];
let summaryEvent = session.events[first.summarySeq];
let replacement = session.events[replacementSeq];
assert.equal(summaryEvent.type, "compaction/summary");
assert.equal(summaryEvent.data.provider, CHILD_COMPILER_IDENTITY.provider);
assert.equal(summaryEvent.data.model, CHILD_COMPILER_IDENTITY.model);
assert.equal(summaryEvent.data.llmStreamCall, undefined);
assert.deepEqual(replacement.sourceEventSeqs, [first.startSeq, first.summarySeq, 1, 3]);
assert.equal(session.events[first.endSeq].type, "compaction/end");

// Repeated compaction consumes the prior deterministic checkpoint, merges it once,
// and keeps retained older chronology before the fresh chronological tail.
session.append("step/end", { turn: 1, step: 1 });
const freshUser = session.append("user/message", userText("followup"), { surfaceOp: "append" });
session.append("step/start", { turn: 1, step: 2 });
const freshAssistant = session.append("assistant/message", {
  turn: 1, step: 2, message: assistantText("Fresh cancellation verification passed. Work is complete; no outstanding tasks remain."),
}, { surfaceOp: "append" });
const second = await mountedSession.engine.compactRegion(replacementSeq, freshAssistant.seq, mountedSession.agent, new AbortController().signal);
replacementSeq = session.surface.nodes[0];
summaryEvent = session.events[second.summarySeq];
replacement = session.events[replacementSeq];
const compiled = summaryEvent.data.summary[0].text;
assert.ok(compiled.length <= 8_000);
assert.equal(compiled.split(RECALL_NOTE).length - 1, 1);
for (const match of compiled.matchAll(/#(\d+)/g)) {
  const seq = Number(match[1]);
  assert.equal(session.events[seq]?.seq, seq, `compiled seq ${seq} resolves in the exact DSH log`);
}
assert.match(compiled, new RegExp(`Fresh cancellation verification passed[\\s\\S]*\\(#${freshAssistant.seq}\\)`));
const retainedOlder = compiled.indexOf("Implemented the retry workflow");
if (retainedOlder >= 0) assert.ok(retainedOlder < compiled.indexOf("Fresh cancellation verification passed"));
assert.deepEqual(replacement.sourceEventSeqs, [second.startSeq, second.summarySeq, ...second.shadowedSeqs]);
assert.deepEqual(llmCalls, []);
await mountedSession.owner.dispose();

// The inherited range selection keeps an assistant tool call paired with its result;
// the compiler retains the call arguments but deliberately omits the result body.
const tools = Session.create("session-77777777-7777-4777-8777-777777777777");
tools.append("turn/start", { turn: 1 });
tools.append("user/message", userText("toolwork"), { surfaceOp: "append" });
tools.append("step/start", { turn: 1, step: 1 });
const callId = "call-balanced-1";
tools.append("assistant/message", {
  turn: 1,
  step: 1,
  message: createAssistantMessage({
    source: { provider: "test-provider", model: "test-model" },
    content: [{ type: "tool-call", id: callId, name: "bash", arguments: '{"command":"npm test"}' }],
  }),
}, { surfaceOp: "append" });
tools.append("tool/call", { turn: 1, step: 1, callId, name: "bash", arguments: '{"command":"npm test"}' });
tools.append("tool/result", {
  turn: 1,
  step: 1,
  message: createToolResultMessage({
    callId,
    content: [{ type: "text", text: "SECRET_TOOL_BODY" }],
    isError: false,
  }),
}, { surfaceOp: "append" });
const mountedTools = await mounted(tools);
const paired = await mountedTools.engine.compactRegion(1, 5, mountedTools.agent, new AbortController().signal);
assert.deepEqual(paired.shadowedSeqs, [1, 3, 5]);
const pairedText = tools.events[paired.summarySeq].data.summary[0].text;
assert.match(pairedText, /\* bash "npm test" \(#3\)/);
assert.doesNotMatch(pairedText, /SECRET_TOOL_BODY/);
assert.deepEqual(tools.events[tools.surface.nodes[0]].sourceEventSeqs, [paired.startSeq, paired.summarySeq, 1, 3, 5]);
await mountedTools.owner.dispose();

// The inherited shrink check records a failed transaction but leaves the surface untouched.
const tiny = Session.create("session-66666666-6666-4666-8666-666666666666");
tiny.append("turn/start", { turn: 1 });
tiny.append("user/message", userText("x", 1), { surfaceOp: "append" });
const before = [...tiny.surface.nodes];
const mountedTiny = await mounted(tiny);
await assert.rejects(
  mountedTiny.engine.compactRegion(1, 1, mountedTiny.agent, new AbortController().signal),
  /summary is not smaller/,
);
assert.deepEqual([...tiny.surface.nodes], before);
assert.deepEqual(tiny.events.slice(-2).map(({ type }) => type), ["compaction/start", "compaction/end"]);
assert.match(tiny.events.at(-1).data.error, /not smaller/);
assert.deepEqual(llmCalls, []);

await mountedTiny.owner.dispose();
await baseFiber.dispose();
await meterFiber.dispose();
await dependencies.dispose();
console.log("child compaction DSH: ok");
