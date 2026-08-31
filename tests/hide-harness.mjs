#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  allowInherited,
  ARCHITECT_INHERITED_TOOLS,
  ITERATE_HANDS_INHERITED_TOOLS,
  MINI_INHERITED_TOOLS,
  PROJECTS_INHERITED_TOOLS,
} from "../src/hide-harness.mjs";

const expected = [
  [ARCHITECT_INHERITED_TOOLS, [
    "read",
    "grep",
    "glob",
    "bash",
    "relay_list",
    "relay_send",
    "relay_status",
  ]],
  [MINI_INHERITED_TOOLS, ["bash", "read_image"]],
  [ITERATE_HANDS_INHERITED_TOOLS, [
    "read",
    "write",
    "edit",
    "read_image",
    "grep",
    "glob",
    "bash",
  ]],
  [PROJECTS_INHERITED_TOOLS, [
    "read",
    "write",
    "edit",
    "read_image",
    "grep",
    "glob",
    "bash",
    "job_output",
    "job_list",
    "job_kill",
    "skill",
    "relay_list",
    "relay_send",
    "relay_status",
  ]],
];

for (const [actual, names] of expected) {
  assert.equal(Object.isFrozen(actual), true);
  assert.deepEqual(actual, names);
}

const agent = { id: "chair" };
const calls = [];
const core = {
  surface: {
    allow(actualAgent, names) {
      calls.push({ agent: actualAgent, names });
    },
  },
};
const ctx = {
  get(name) {
    assert.equal(name, "qq-core");
    return core;
  },
};
assert.equal(allowInherited(ctx, agent, ARCHITECT_INHERITED_TOOLS), undefined);
assert.deepEqual(calls, [{ agent, names: ARCHITECT_INHERITED_TOOLS }]);
assert.equal(calls[0].names, ARCHITECT_INHERITED_TOOLS, "the complete named list is passed in one call");

assert.throws(
  () => allowInherited({ get: () => null }, agent, MINI_INHERITED_TOOLS),
  /qq-core surface\.allow is required/,
);
assert.throws(
  () => allowInherited({ get: () => ({ surface: {} }) }, agent, MINI_INHERITED_TOOLS),
  /qq-core surface\.allow is required/,
);
const failure = new Error("surface assignment failed");
assert.throws(
  () => allowInherited({ get: () => ({ surface: { allow() { throw failure; } } }) }, agent, MINI_INHERITED_TOOLS),
  (error) => error === failure,
);

console.log("hide harness: ok");
