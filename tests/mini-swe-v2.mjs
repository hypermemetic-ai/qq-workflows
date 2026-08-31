#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  MINI_SWE_COMPLETION_COMMAND,
  renderMiniSweTask,
} from "../src/mini-swe-v2.mjs";
import {
  bindMiniSubmit,
  miniSetup,
  wrapMiniBash,
} from "../src/official-mini.mjs";

assert.equal(MINI_SWE_COMPLETION_COMMAND, "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT");

const task = renderMiniSweTask("Fix the issue", {
  system: "TestOS",
  release: "1",
  version: "test",
  machine: "test-machine",
});
const completionWarning = "Do not combine it with any other command. <important>After this command, you cannot continue working on this task.</important>";
assert.match(task, /Optionally call run_tests once/);
assert.match(task, /host stages and commits/);
assert.match(task, /no writable Git metadata or network credentials/);
assert.equal(task.split(MINI_SWE_COMPLETION_COMMAND).length - 1, 2);
assert.equal(task.split(completionWarning).length - 1, 2);


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
      assert.deepEqual(names, ["bash", "read_image"]);
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


// A stale HMR generation must not erase a newer completion binding when DSH
// exposes non-extensible Agent/Session/Context proxies and the WeakMap is the
// only writable capability store.
const reboundSession = Object.preventExtensions({});
const reboundCtx = Object.preventExtensions({});
const reboundAgent = Object.preventExtensions({ session: reboundSession, ctx: reboundCtx });
const submissions = [];
const disposeOldSubmit = bindMiniSubmit(reboundAgent, async () => {
  submissions.push("old");
  return { status: "ok" };
});
const disposeNewSubmit = bindMiniSubmit(reboundAgent, async () => {
  submissions.push("new");
  return { status: "ok" };
});
disposeOldSubmit();
let concluded = 0;
const reboundBash = wrapMiniBash({
  name: "bash",
  parameters: { type: "object", properties: {} },
  async execute() { throw new Error("completion sentinel reached the underlying shell"); },
});
const reboundResult = await reboundBash.execute(
  { command: MINI_SWE_COMPLETION_COMMAND },
  { agent: reboundAgent, callId: "rebound-submit", concludeTurn() { concluded++; } },
);
assert.deepEqual(submissions, ["new"]);
assert.equal(reboundResult.exitCode, 0);
assert.equal(reboundResult.stdout.text, "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\n");
assert.equal(concluded, 1);
disposeNewSubmit();

console.log("mini-swe-v2 tests passed");
