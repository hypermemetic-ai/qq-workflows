#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  CHILD_COMPACTION_POLICY,
  CHILD_COMPILER_IDENTITY,
  adaptDshMessages,
  createChildCompactionEngineClass,
  installChildCompaction,
  isPreviousCompiledCheckpoint,
} from "../src/child-compaction.mjs";
import { COMPILER_MARKER } from "../src/conversation-compiler/index.mjs";

class FakeBasicCompactionEngine {
  static instances = [];
  constructor(ctx, config) { this.ctx = ctx; this.config = config; FakeBasicCompactionEngine.instances.push(this); }
  async summarize() { assert.fail("base LLM summarizer must never run"); }
  async compactIfNeeded() {}
  async compactRegion() {}
}

const prior = {
  id: "prior", role: "user", source: { kind: "plugin", plugin: "compact" },
  content: [{ type: "text", text: `checkpoint wrapper\n${COMPILER_MARKER}\n\n## Session Goal\n- #0 old goal\n\n## Commits\n- None recorded.\n\n## Outstanding Context\n- #0 stale task\n\n## User Preferences\n- None recorded.\n\n## Chronological Brief\n- #0 user: old goal` }],
};
const user = { id: "u1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "new goal" }] };
const assistant = { id: "a1", role: "assistant", source: { kind: "model", provider: "x", model: "y" }, content: [{ type: "text", text: "work complete; no outstanding tasks remain" }] };
const result = { id: "r1", role: "user", source: { kind: "tool", callId: "c1" }, content: [{ type: "tool-result", callId: "c1", isError: false, content: [{ type: "text", text: "large output" }] }] };
const events = [
  { seq: 0, type: "user/message", data: prior },
  { seq: 3, type: "user/message", data: user },
  { seq: 8, type: "assistant/message", data: { message: assistant } },
  { seq: 9, type: "tool/result", data: { message: result } },
];
const agent = { session: { events } };
const adapted = adaptDshMessages({ messages: [prior, user, assistant, result] }, agent);
assert.equal(isPreviousCompiledCheckpoint(prior), true);
assert.deepEqual(adapted.records.map(({ seq, role }) => [seq, role]), [[3, "user"], [8, "assistant"], [9, "tool-result"]]);
assert.match(adapted.previousSummary, /old goal/);
assert.throws(() => adaptDshMessages({ messages: [{ ...user, id: "unknown" }] }, agent), /cannot resolve/);

const Child = createChildCompactionEngineClass(FakeBasicCompactionEngine);
assert.equal(Object.getPrototypeOf(Child.prototype), FakeBasicCompactionEngine.prototype);
assert.deepEqual(Object.getOwnPropertyNames(Child.prototype), ["constructor", "summarize"]);
const streamCalls = [];
const engine = new Child({ llm: { stream() { streamCalls.push(true); } } }, CHILD_COMPACTION_POLICY);
const summary = await engine.summarize({ messages: [prior, user, assistant, result] }, agent, new AbortController().signal);
assert.deepEqual(streamCalls, []);
assert.deepEqual({ provider: summary.provider, model: summary.model }, CHILD_COMPILER_IDENTITY);
assert.match(summary.summary[0].text, /#3 user: new goal/);
assert.match(summary.summary[0].text, /#8 assistant: work complete/);
assert.doesNotMatch(summary.summary[0].text, /large output/);
assert.doesNotMatch(summary.summary[0].text.match(/## Outstanding Context([\s\S]*?)## User Preferences/)[1], /stale task/);

let receivedClass;
let receivedConfig;
let fiberDisposed = 0;
const base = Object.create(FakeBasicCompactionEngine.prototype);
const fakeCtx = {
  agent,
  get(name) { return name === "compaction" ? base : undefined; },
  isolate(name, label) { assert.equal(name, "compaction"); assert.equal(typeof label, "symbol"); return this; },
  plugin(EngineClass, config) {
    receivedClass = EngineClass;
    receivedConfig = config;
    return { dispose() { fiberDisposed++; } };
  },
};
const dispose = installChildCompaction(fakeCtx);
assert.equal(Object.getPrototypeOf(receivedClass.prototype), FakeBasicCompactionEngine.prototype);
assert.deepEqual(receivedConfig, { auto: true, thresholdRatio: 0.8, retainTokens: 25_000, compactionRetries: 1, maxOverflowRetries: 1 });
dispose();
dispose();
assert.equal(fiberDisposed, 1);

console.log("child compaction: ok");
