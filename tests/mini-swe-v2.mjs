#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  MINI_SWE_BASH_SCHEMA,
  MINI_SWE_COMPLETION_COMMAND,
  renderMiniSweTask,
} from "../src/mini-swe-v2.mjs";
import {
  bindMiniShellIsolation,
  bindMiniSubmit,
  miniSetup,
  wrapMiniBash,
} from "../src/official-mini.mjs";
import { withChildSettlement } from "../src/child-settlement.mjs";
import { buildDoneTool } from "../src/land-tools.mjs";

assert.equal(MINI_SWE_COMPLETION_COMMAND, "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT");

const task = renderMiniSweTask("Fix the issue", {
  system: "TestOS",
  release: "1",
  version: "test",
  machine: "test-machine",
});
const completionWarning = "Do not combine it with any other command. <important>After this command, you cannot continue working on this task.</important>";
assert.match(task, /Run relevant tests with bash as needed/);
assert.doesNotMatch(task, /run_tests|required tests/i);
assert.match(task, /host stages and commits/);
assert.match(task, /MUST call bash, workflow_send, or the read-only session_history/);
assert.match(task, /no writable Git metadata or network credentials/);
assert.match(task, /exact narrow directory roots in bash `writable_paths`/);
assert.match(task, /host remembers approved folders for the logical project/);
assert.match(task, /Do not use `danger-full-access` for routine cache or data folders/);
assert.match(task, /rejection affects only that request/);
assert.deepEqual(Object.keys(MINI_SWE_BASH_SCHEMA.parameters.properties), ["command", "writable_paths"]);
assert.deepEqual(MINI_SWE_BASH_SCHEMA.parameters.required, ["command"]);
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
assert.deepEqual(operations, ["allow", "get:bash", "get:bash", "register:bash", "register:workflow_send"]);

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


// Reduced Mini schemas retain a newer host's exact path contract and ordinary
// execution forwards every declared root through the native bash seam.
const miniNativeCalls = [];
const hostPathProperty = { type: "array", maxItems: 4, items: { type: "string", format: "host-path" } };
const nativeMiniBash = wrapMiniBash({
  name: "bash",
  parameters: { type: "object", properties: { writable_paths: hostPathProperty } },
  async execute(args, exec) {
    miniNativeCalls.push({ args, exec });
    return { kind: "foreground", stdout: { text: "ok", truncated: false }, stderr: { text: "", truncated: false } };
  },
}, { interceptCompletion: false });
assert.deepEqual(nativeMiniBash.parameters.properties.writable_paths, hostPathProperty);
assert.notEqual(nativeMiniBash.parameters.properties.writable_paths, hostPathProperty);
const miniWritableArgs = { command: "cargo check", writable_paths: ["~/.cargo", "/var/tmp/build-cache"] };
const miniExec = { marker: "mini exec" };
await nativeMiniBash.execute(miniWritableArgs, miniExec);
assert.equal(miniNativeCalls.length, 1);
assert.match(miniNativeCalls[0].args.command, /; cargo check$/);
assert.equal(miniNativeCalls[0].args.description, "Execute Mini SWE bash command");
assert.equal(miniNativeCalls[0].args.writable_paths, miniWritableArgs.writable_paths);
assert.equal(miniNativeCalls[0].exec, miniExec);
assert.equal("sandbox_permissions" in miniNativeCalls[0].args, false);

// The workflow-owned inner isolation seam never receives unvalidated model
// paths. It preserves the outer host policy; only base.execute receives the
// declaration so the host can validate and authorize it first.
const isolatedAgent = { session: {}, ctx: {} };
const isolationCalls = [];
const disposeIsolation = bindMiniShellIsolation(isolatedAgent, (...values) => {
  isolationCalls.push(values);
  return `inner:${values[0]}`;
});
await nativeMiniBash.execute(miniWritableArgs, { agent: isolatedAgent });
assert.equal(miniNativeCalls.length, 2);
assert.equal(miniNativeCalls[1].args.writable_paths, miniWritableArgs.writable_paths);
assert.deepEqual(isolationCalls, [[miniNativeCalls[0].args.command]], "raw path declarations never reach the inner isolation seam");
assert.equal(isolationCalls[0][0].includes("~/.cargo"), false);
assert.match(miniNativeCalls[1].args.command, /^inner:/);
disposeIsolation();

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
const reboundReplay = await reboundBash.execute(
  { command: MINI_SWE_COMPLETION_COMMAND },
  { agent: reboundAgent, callId: "rebound-submit-replay", concludeTurn() { concluded++; } },
);
assert.deepEqual(submissions, ["new"], "accepted Mini completion is a monotonic terminal handoff");
assert.equal(reboundReplay.exitCode, 0);
assert.equal(concluded, 2);
disposeNewSubmit();

let doneTerminalTransitions = 0;
let failDoneSettlement;
const doneTool = buildDoneTool({
  async submit() {
    doneTerminalTransitions++;
    return withChildSettlement(
      { status: "ok", outcome: "prepared result" },
      { arm({ onFailure }) { failDoneSettlement = onFailure; } },
    );
  },
});
let doneConcluded = 0;
assert.equal((await doneTool.execute({}, { callId: "done-1", concludeTurn() { doneConcluded++; } })).status, "ok");
assert.equal((await doneTool.execute({}, { callId: "done-2", concludeTurn() { doneConcluded++; } })).status, "ok");
assert.equal(doneTerminalTransitions, 1, "one successful done produces exactly one terminal submit transition");
assert.equal(doneConcluded, 2);
failDoneSettlement();
assert.equal((await doneTool.execute({}, { callId: "done-3", concludeTurn() { doneConcluded++; } })).status, "ok");
assert.equal(doneTerminalTransitions, 2, "a failed authoritative settlement reopens the existing retry path");

console.log("mini-swe-v2 tests passed");
