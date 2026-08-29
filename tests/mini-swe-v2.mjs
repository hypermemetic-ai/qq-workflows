#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  MINI_SWE_COMPLETION_COMMAND,
  renderMiniSweTask,
} from "../src/mini-swe-v2.mjs";
import { miniSetup } from "../src/official-mini.mjs";

assert.equal(MINI_SWE_COMPLETION_COMMAND, "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT");

const task = renderMiniSweTask("Fix the issue", {
  system: "TestOS",
  release: "1",
  version: "test",
  machine: "test-machine",
});
const submitInstruction = `Commit your changes, then submit and finish your work by issuing the following command: \`${MINI_SWE_COMPLETION_COMMAND}\`.`;
const completionWarning = "Do not combine it with any other command. <important>After this command, you cannot continue working on this task.</important>";

assert.ok(task.includes(`6. ${submitInstruction}\n   ${completionWarning}`));
assert.ok(task.includes(`- ${submitInstruction}\n  ${completionWarning}`));
assert.equal(task.split(submitInstruction).length - 1, 2);

const operations = [];
const miniAgent = { id: "official-mini-setup" };
const hostBash = {
  name: "bash",
  parameters: { type: "object", properties: {} },
  async execute() { return {}; },
};
const miniCtx = {
  agent: miniAgent,
  get(name) {
    assert.equal(name, "qq-core");
    return { surface: { allow(agent, names) {
      operations.push("allow");
      assert.equal(agent, miniAgent);
      assert.deepEqual(names, ["bash"]);
    } } };
  },
  systemPrompt: {
    section() { return () => {}; },
    suppressRuntimeContext() {},
  },
  tools: {
    get(name) { operations.push(`get:${name}`); return name === "bash" ? hostBash : undefined; },
    register(tool) { operations.push(`register:${tool.name}`); return () => {}; },
  },
  on() { return () => {}; },
};
miniSetup(miniCtx);
assert.deepEqual(operations, ["allow", "get:bash", "get:bash", "register:bash"]);

let failedLookups = 0;
let failedRegistrations = 0;
const failedSurfaceCtx = {
  agent: { id: "official-mini-failed-surface" },
  get() { return { surface: { allow() { throw new Error("official Mini surface failed"); } } }; },
  tools: {
    get() { failedLookups++; return hostBash; },
    register() { failedRegistrations++; return () => {}; },
  },
};
assert.throws(() => miniSetup(failedSurfaceCtx), /official Mini surface failed/);
assert.equal(failedLookups, 0);
assert.equal(failedRegistrations, 0);

console.log("mini-swe-v2 tests passed");
