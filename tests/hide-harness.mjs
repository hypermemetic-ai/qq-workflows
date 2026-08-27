#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  stripAgentInstructionsPreStep,
} from "../src/hide-harness.mjs";

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
