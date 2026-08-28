#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  ARCHITECT_INHERITED_TOOLS,
  ARCHITECT_PLUGIN_TOOLS,
  ARCHITECT_VISIBLE_TOOLS,
  HIDDEN_HARNESS_TOOLS,
  hideHarnessTools,
  restrictArchitectTools,
  stripAgentInstructionsPreStep,
  stripHiddenHarnessTools,
  stripUnlistedArchitectTools,
} from "../src/hide-harness.mjs";

assert.equal(Object.isFrozen(ARCHITECT_INHERITED_TOOLS), true);
assert.equal(Object.isFrozen(ARCHITECT_PLUGIN_TOOLS), true);
assert.equal(Object.isFrozen(ARCHITECT_VISIBLE_TOOLS), true);
assert.equal(Object.isFrozen(HIDDEN_HARNESS_TOOLS), true);
assert.deepEqual(ARCHITECT_INHERITED_TOOLS, [
  "read",
  "grep",
  "glob",
  "bash",
  "relay_list",
  "relay_send",
  "relay_status",
]);
assert.deepEqual(ARCHITECT_PLUGIN_TOOLS, [
  "case_write",
  "delegate",
  "workflow_status",
  "workflow_send",
  "land",
]);
assert.deepEqual(ARCHITECT_VISIBLE_TOOLS, [
  ...ARCHITECT_INHERITED_TOOLS,
  ...ARCHITECT_PLUGIN_TOOLS,
]);
assert.deepEqual(HIDDEN_HARNESS_TOOLS, [
  "subagent",
  "subagent_fork",
  "send_message",
  "list_agents",
  "interrupt_agent",
  "create_goal",
  "get_goal",
  "update_goal",
  "ralph",
  "workflow",
]);

function toolHarness() {
  const restrictions = [];
  const guards = [];
  const lifted = [];
  return {
    restrictions,
    guards,
    lifted,
    restrict(spec) {
      restrictions.push(spec);
      return () => lifted.push(["restrict", spec]);
    },
    guard(fn) {
      guards.push(fn);
      return () => lifted.push(["guard", fn]);
    },
  };
}

const architectTools = toolHarness();
const liftArchitect = restrictArchitectTools(architectTools);
assert.deepEqual(architectTools.restrictions, [{ allow: [...ARCHITECT_INHERITED_TOOLS] }]);
assert.equal(Object.hasOwn(architectTools.restrictions[0], "deny"), false);
assert.equal(architectTools.guards.length, 1);
const architectGuard = architectTools.guards[0];
assert.equal(typeof architectGuard({ name: "todo_write" }), "string");
for (const name of ["case_write", "bash", "relay_send"]) {
  assert.equal(architectGuard({ name }), undefined, `${name} is architect-visible`);
}
liftArchitect();
assert.equal(architectTools.lifted.length, 2);

const childTools = toolHarness();
const liftChild = hideHarnessTools(childTools);
assert.deepEqual(childTools.restrictions, [{ deny: [...HIDDEN_HARNESS_TOOLS] }]);
assert.equal(Object.hasOwn(childTools.restrictions[0], "allow"), false);
assert.equal(childTools.guards.length, 1);
for (const name of HIDDEN_HARNESS_TOOLS) {
  assert.equal(typeof childTools.guards[0]({ name }), "string", `${name} remains denied for children`);
}
assert.equal(childTools.guards[0]({ name: "bash" }), undefined);
liftChild();
assert.equal(childTools.lifted.length, 2);

const toolSchemas = ARCHITECT_VISIBLE_TOOLS.map((name) => ({ name }));
const withUnknown = [...toolSchemas, { name: "future_harness_extra" }];
assert.equal(stripUnlistedArchitectTools(toolSchemas), toolSchemas);
assert.deepEqual(stripUnlistedArchitectTools(withUnknown), toolSchemas);
const childSchemas = [{ name: "bash" }, { name: "workflow" }];
assert.deepEqual(stripHiddenHarnessTools(childSchemas), [{ name: "bash" }]);

const rolePrompt = {
  source: { kind: "plugin", plugin: "qq-workflows:role" },
  content: "Role prompt",
};
const workingMemory = {
  source: { kind: "plugin", plugin: "qq-workflows:working-memory" },
  content: "Working memory",
};
const wikiIndex = {
  source: { kind: "plugin", plugin: "qq-workflows:wiki-index" },
  content: "Repository wiki index",
};
const nativeDump = {
  source: { kind: "agent-instructions" },
  content: "Contents of AGENTS.md",
};
const pluginDump = {
  source: { kind: "plugin", plugin: "agent-instructions" },
  content: "Nested AGENTS.md",
};

const chairs = [
  ["architect", { session: { id: "architect", header: {} } }],
  ["Mini", { session: { id: "mini", header: { origin: "subagent", kind: "mini" } } }],
  ["QA", { session: { id: "qa", header: { origin: "subagent", kind: "mini-review" } } }],
  ["Hands child", { session: { id: "hands", header: { origin: "subagent" } } }],
  ["other child", { session: { id: "child", header: { origin: "subagent" } } }],
  ["unselected", { session: { id: "unselected", header: {} } }],
  ["base", { session: { id: "base", header: {} } }],
];

for (const [chair, agent] of chairs) {
  const decision = {
    kind: "accept",
    marker: chair,
    messages: [rolePrompt, nativeDump, workingMemory, pluginDump, wikiIndex],
  };
  let nextFinished = false;
  const result = await stripAgentInstructionsPreStep({ agent }, async () => {
    await Promise.resolve();
    nextFinished = true;
    return decision;
  });

  assert.equal(nextFinished, true, `${chair}: next() must finish before filtering`);
  assert.notEqual(result, decision, `${chair}: changed decisions are copied`);
  assert.equal(result.marker, chair, `${chair}: other decision fields survive`);
  assert.deepEqual(
    result.messages,
    [rolePrompt, workingMemory, wikiIndex],
    `${chair}: only agent-instructions messages are stripped`,
  );
  assert.equal(decision.messages.length, 5, `${chair}: the original decision is not mutated`);
}

// Rejections and batches without an instructions dump retain object identity.
for (const decision of [
  { kind: "reject", messages: [nativeDump] },
  { kind: "accept", messages: [rolePrompt, workingMemory, wikiIndex] },
  { kind: "accept" },
  null,
]) {
  const result = await stripAgentInstructionsPreStep({}, async () => decision);
  assert.equal(result, decision);
}

console.log("hide harness: ok");
