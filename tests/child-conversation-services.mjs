#!/usr/bin/env node
import assert from "node:assert/strict";

import { installChildConversationServices, messageHasChildAction } from "../src/child-conversation-services.mjs";
import { miniSetup } from "../src/official-mini.mjs";
import { miniResearchSetup } from "../src/mini-research.mjs";
import { miniQaSetup } from "../src/mini-qa.mjs";
import { miniDocsSetup } from "../src/mini-docs.mjs";

const SESSION = "session-33333333-3333-4333-8333-333333333333";
class FakeBasic {
  constructor(ctx, config) { ctx.engines.push({ instance: this, config }); }
  async compactIfNeeded() {}
  async compactRegion() {}
  async summarize() { assert.fail("base summarizer is not used"); }
}

function harness(kind) {
  const tools = [];
  const listeners = [];
  const engines = [];
  let disposedEngines = 0;
  const agent = { session: { id: SESSION, header: { kind }, events: [] } };
  const sessionQuery = {
    async searchEvents() { return { session: { id: SESSION }, items: [] }; },
    async readEvent() { throw new Error("not used"); },
    async traceEvent() { throw new Error("not used"); },
  };
  const hostBash = { name: "bash", parameters: { type: "object", properties: {} }, async execute() { return {}; } };
  const qq = { surface: { allow() {} } };
  const ctx = {
    agent,
    engines,
    get(name) {
      if (name === "qq-core") return qq;
      if (name === "sessionQuery") return sessionQuery;
      if (name === "compaction") return Object.create(FakeBasic.prototype);
      if (name === "tools") return this.tools;
      if (name === "systemPrompt") return this.systemPrompt;
      return undefined;
    },
    systemPrompt: { section() { return () => {}; }, suppressRuntimeContext() {} },
    tools: {
      get(name) { return [...tools].reverse().find((tool) => tool.name === name) ?? (name === "bash" ? hostBash : undefined); },
      register(tool) {
        tools.push(tool);
        return () => { const index = tools.indexOf(tool); if (index >= 0) tools.splice(index, 1); };
      },
    },
    on(type, fn) { const item = { type, fn }; listeners.push(item); return () => listeners.splice(listeners.indexOf(item), 1); },
    isolate(name, label) { assert.equal(name, "compaction"); assert.equal(typeof label, "symbol"); return this; },
    plugin(Engine, config) {
      new Engine(this, config);
      return { dispose() { disposedEngines++; } };
    },
  };
  agent.ctx = ctx;
  return { agent, ctx, tools, listeners, engines, disposedEngines: () => disposedEngines };
}

const setups = [
  ["mini-code", (ctx) => miniSetup(ctx), ["bash", "session_history", "workflow_send"]],
  ["mini-research", (ctx) => miniResearchSetup(ctx), ["bash", "session_history", "workflow_send"]],
  ["mini-qa", (ctx) => miniQaSetup(ctx), ["bash", "submit_review", "session_history", "workflow_send"]],
  ["mini-docs", (ctx) => miniDocsSetup(ctx, { env: { QQ_INDEX_WRITER_PROMPT: "writer" } }), ["bash", "session_history", "workflow_send"]],
];
for (const [kind, setup, expectedTools] of setups) {
  const mounted = harness(kind);
  setup(mounted.ctx);
  assert.deepEqual(mounted.tools.map(({ name }) => name), expectedTools, kind);
  assert.equal(mounted.engines.length, 1, `${kind} mounts one child engine`);
  assert.deepEqual(mounted.engines[0].config, {
    auto: true,
    thresholdRatio: 0.8,
    retainTokens: 25_000,
    compactionRetries: 1,
    maxOverflowRetries: 1,
  });
  assert.equal(Object.getPrototypeOf(mounted.engines[0].instance.constructor.prototype), FakeBasic.prototype);
}

const historyOnly = {
  type: "assistant/message",
  data: { message: { content: [{ type: "tool-call", name: "session_history", arguments: { action: "search", queries: ["clue"] } }] } },
};
for (const tools of [["bash"], ["bash", "submit_review"]]) assert.equal(messageHasChildAction(historyOnly, tools), true);
const workflowSendOnly = {
  type: "assistant/message",
  data: { message: { content: [{ type: "tool-call", name: "workflow_send", arguments: { message: "update" } }] } },
};
for (const tools of [["bash"], ["bash", "submit_review"]]) assert.equal(messageHasChildAction(workflowSendOnly, tools), true);
assert.equal(messageHasChildAction({ type: "assistant/message", data: { message: { content: [{ type: "text", text: "no action" }] } } }, ["bash"]), false);

// A rejected nested engine startup rolls back the paired recall tool as one service unit.
const rejected = harness("mini-code");
let rejectedDisposals = 0;
rejected.ctx.plugin = () => ({
  then(_resolve, reject) { queueMicrotask(() => reject(new Error("engine startup failed"))); },
  dispose() { rejectedDisposals++; },
});
const rejectedLift = installChildConversationServices(rejected.ctx);
assert.deepEqual(rejected.tools.map(({ name }) => name), ["session_history", "workflow_send"]);
await assert.rejects(rejectedLift.ready, /engine startup failed/);
assert.deepEqual(rejected.tools, []);
assert.equal(rejectedDisposals, 1);

// HMR replacement owns and removes the first generation's history tool and engine.
const mounted = harness("mini-code");
miniSetup(mounted.ctx);
const nextGeneration = await import(`../src/official-mini.mjs?child-services-hmr=${Date.now()}`);
nextGeneration.miniSetup(mounted.ctx);
assert.equal(mounted.tools.filter(({ name }) => name === "session_history").length, 1);
assert.equal(mounted.tools.filter(({ name }) => name === "bash").length, 1);
assert.equal(mounted.tools.filter(({ name }) => name === "workflow_send").length, 1);
assert.equal(mounted.disposedEngines(), 1);

console.log("child conversation services: ok");
