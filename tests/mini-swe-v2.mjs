#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  MINI_SWE_COMPLETION_COMMAND,
  renderMiniSweTask,
} from "../src/mini-swe-v2.mjs";

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

console.log("mini-swe-v2 tests passed");
