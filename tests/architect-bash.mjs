#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  sanitizeArchitectBashArguments,
  sanitizeArchitectBashParameters,
  wrapArchitectBash,
} from "../src/architect-bash.mjs";
import { capObservationTool, OBSERVATION_MAX_CHARS } from "../src/observation.mjs";

const parameters = {
  type: "object",
  properties: {
    command: { type: "string" },
    description: { type: "string" },
    timeoutMs: { type: "number" },
    workdir: { type: "string" },
    run_in_background: { type: "boolean" },
    sandbox_permissions: { type: "string", enum: ["workspace-write", "danger-full-access"] },
    justification: { type: "string" },
  },
  required: ["command", "sandbox_permissions", "justification"],
  allOf: [
    { required: ["command", "sandbox_permissions"] },
    { if: { properties: { workdir: { type: "string" } } }, then: { required: ["workdir", "justification"] } },
  ],
};
const hostCalls = [];
const hostResult = { kind: "foreground", content: [{ type: "text", text: "ok" }] };
const output = {
  render(_args, value) {
    return value.content;
  },
};
function isConcurrencySafe() { return true; }
function finalizeContent(_exec, result) { return result.content; }
const base = {
  name: "bash",
  description: "Host bash",
  parameters,
  output,
  isConcurrencySafe,
  finalizeContent,
  execute(args, exec) {
    hostCalls.push({ args, exec });
    return hostResult;
  },
};

const sanitizedSchema = sanitizeArchitectBashParameters(parameters);
assert.notEqual(sanitizedSchema, parameters);
assert.deepEqual(Object.keys(sanitizedSchema.properties), [
  "command",
  "description",
  "timeoutMs",
  "workdir",
  "run_in_background",
]);
assert.deepEqual(sanitizedSchema.required, ["command"]);
assert.deepEqual(sanitizedSchema.allOf[0].required, ["command"]);
assert.deepEqual(sanitizedSchema.allOf[1].then.required, ["workdir"]);
assert.ok(parameters.properties.sandbox_permissions, "the host schema is not mutated");
assert.deepEqual(parameters.required, ["command", "sandbox_permissions", "justification"]);

const originalArgs = {
  command: "pwd",
  description: "inspect workspace",
  timeoutMs: 1_000,
  workdir: "/workspace",
  run_in_background: false,
  sandbox_permissions: "danger-full-access",
  justification: "must never reach host bash",
};
assert.deepEqual(sanitizeArchitectBashArguments(originalArgs), {
  command: "pwd",
  description: "inspect workspace",
  timeoutMs: 1_000,
  workdir: "/workspace",
  run_in_background: false,
});
assert.equal(originalArgs.sandbox_permissions, "danger-full-access", "caller arguments are not mutated");

const wrapped = wrapArchitectBash(base);
assert.notEqual(wrapped, base);
assert.equal(wrapped.name, base.name);
assert.equal(wrapped.description, base.description);
assert.equal(wrapped.output, output);
assert.equal(wrapped.isConcurrencySafe, isConcurrencySafe);
assert.equal(wrapped.finalizeContent, finalizeContent);
assert.equal(wrapped.isConcurrencySafe(), true);
assert.equal(wrapArchitectBash(wrapped), wrapped, "architect bash wrapping is idempotent");

const exec = { marker: "exec context" };
assert.equal(wrapped.execute(originalArgs, exec), hostResult, "the base executor result is preserved");
assert.deepEqual(hostCalls, [{
  args: {
    command: "pwd",
    description: "inspect workspace",
    timeoutMs: 1_000,
    workdir: "/workspace",
    run_in_background: false,
  },
  exec,
}]);
assert.equal("sandbox_permissions" in hostCalls[0].args, false);
assert.equal("justification" in hostCalls[0].args, false);

// Observation capping remains a separate, composable wrapper and retains the
// architect marker, so either wrapper can encounter its own HMR-era result.
const capped = capObservationTool(wrapped);
assert.notEqual(capped, wrapped);
assert.equal(wrapArchitectBash(capped), capped);
assert.equal(capObservationTool(capped), capped);
const oversized = "x".repeat(OBSERVATION_MAX_CHARS + 1);
const rendered = capped.output.render({}, { content: [{ type: "text", text: oversized }] });
assert.match(rendered[0].text, /environment output truncated/);
const finalized = capped.finalizeContent({}, { content: [{ type: "text", text: oversized }] });
assert.match(finalized[0].text, /environment output truncated/);

// Non-bash inherited definitions continue to receive observation capping only.
const read = {
  name: "read",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  execute() { return "read"; },
};
const cappedRead = capObservationTool(read);
assert.equal(cappedRead.parameters, read.parameters);
assert.equal(cappedRead.execute, read.execute);
assert.deepEqual(cappedRead.parameters.required, ["path"]);

console.log("architect bash: ok");
