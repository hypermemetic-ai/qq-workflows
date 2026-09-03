#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  optionalizeArchitectBashParameters,
  wrapArchitectBash,
} from "../src/architect-bash.mjs";
import {
  sanitizeProjectsBashArguments,
  sanitizeProjectsBashParameters,
  wrapProjectsBash,
} from "../src/projects-bash.mjs";
import { capObservationTool, OBSERVATION_MAX_CHARS } from "../src/observation.mjs";
import { WRITABLE_PATHS_SCHEMA, exposeWritablePaths } from "../src/writable-paths.mjs";

// Reproduce the live host composition: escalation controls exist as properties
// and are model-required in both top-level and nested schema branches.
const parameters = {
  type: "object",
  title: "Host bash input",
  properties: {
    command: { type: "string" },
    description: { type: "string" },
    timeoutMs: { type: "number" },
    workdir: { type: "string" },
    run_in_background: { type: "boolean" },
    sandbox_permissions: { type: "string", enum: ["workspace-write", "danger-full-access"] },
    justification: { type: "string", minLength: 1 },
  },
  required: ["command", "sandbox_permissions", "justification"],
  allOf: [
    { required: ["command", "sandbox_permissions"] },
    {
      if: { properties: { workdir: { type: "string" } } },
      then: { required: ["workdir", "justification"] },
    },
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

const optionalSchema = optionalizeArchitectBashParameters(parameters);
assert.notEqual(optionalSchema, parameters);
assert.notEqual(optionalSchema.properties, parameters.properties);
assert.deepEqual(
  Object.fromEntries(Object.entries(optionalSchema.properties).filter(([name]) => name !== "writable_paths")),
  parameters.properties,
  "architect keeps every host property and its exact schema contract",
);
assert.deepEqual(optionalSchema.properties.writable_paths, WRITABLE_PATHS_SCHEMA);
assert.equal(Object.hasOwn(parameters.properties, "writable_paths"), false, "fallback exposure does not mutate the host schema");
const hostWritableSchema = {
  ...parameters,
  properties: {
    ...parameters.properties,
    writable_paths: { type: "array", items: { type: "string", format: "host-path" }, maxItems: 8 },
  },
};
assert.deepEqual(
  optionalizeArchitectBashParameters(hostWritableSchema).properties.writable_paths,
  hostWritableSchema.properties.writable_paths,
  "a newer host's exact writable_paths schema wins over the compatibility fallback",
);
assert.notEqual(exposeWritablePaths(hostWritableSchema).properties.writable_paths, hostWritableSchema.properties.writable_paths);
assert.ok(optionalSchema.properties.sandbox_permissions, "escalation mode remains model-visible");
assert.ok(optionalSchema.properties.justification, "escalation justification remains model-visible");
assert.deepEqual(optionalSchema.required, ["command"]);
assert.deepEqual(optionalSchema.allOf[0].required, ["command"]);
assert.deepEqual(optionalSchema.allOf[1].then.required, ["workdir"]);
assert.equal(optionalSchema.title, parameters.title, "non-required schema fields are unchanged");
assert.deepEqual(
  parameters.required,
  ["command", "sandbox_permissions", "justification"],
  "the host schema is not mutated",
);
assert.deepEqual(parameters.allOf[0].required, ["command", "sandbox_permissions"]);
assert.deepEqual(parameters.allOf[1].then.required, ["workdir", "justification"]);
assert.equal(optionalizeArchitectBashParameters(null), null);

const architectBash = wrapArchitectBash(base);
assert.notEqual(architectBash, base);
assert.equal(architectBash.name, base.name);
assert.equal(architectBash.description, base.description);
assert.equal(architectBash.output, output);
assert.equal(architectBash.isConcurrencySafe, isConcurrencySafe);
assert.equal(architectBash.finalizeContent, finalizeContent);
assert.equal(architectBash.isConcurrencySafe(), true);
assert.deepEqual(architectBash.parameters, optionalSchema);
assert.equal(wrapArchitectBash(architectBash), architectBash, "architect wrapping is HMR-idempotent");

const exec = { marker: "exec context" };
const routineArgs = {
  command: "pwd",
  description: "inspect workspace",
  timeoutMs: 1_000,
  workdir: "/workspace",
  run_in_background: false,
};
assert.equal(architectBash.execute(routineArgs, exec), hostResult);
assert.equal(hostCalls[0].args, routineArgs, "routine architect arguments reach the host unchanged");
assert.equal(hostCalls[0].exec, exec, "the execution context reaches the host unchanged");
assert.equal("sandbox_permissions" in hostCalls[0].args, false, "routine calls omit escalation mode");
assert.equal("justification" in hostCalls[0].args, false, "routine calls omit escalation justification");

const escalationArgs = {
  command: "cargo build --release --locked --package qq-session-indexd --bin qq-session-indexd",
  description: "retry a sandbox-denied repository build",
  timeoutMs: 1_000,
  workdir: "/workspace",
  run_in_background: false,
  sandbox_permissions: "danger-full-access",
  justification: "Cargo needs to update the user registry cache outside the workspace.",
};
assert.equal(architectBash.execute(escalationArgs, exec), hostResult);
assert.equal(hostCalls[1].args, escalationArgs, "architect escalation arguments reach the host unchanged");
assert.equal(hostCalls[1].exec, exec);
assert.equal(hostCalls[1].args.sandbox_permissions, "danger-full-access");
assert.equal(hostCalls[1].args.justification, escalationArgs.justification);

// Observation capping remains a transparent, composable wrapper. Either order
// preserves the optionalized schema and exact execute arguments across HMR.
const cappedArchitectBash = capObservationTool(architectBash);
assert.notEqual(cappedArchitectBash, architectBash);
assert.equal(wrapArchitectBash(cappedArchitectBash), cappedArchitectBash);
assert.equal(capObservationTool(cappedArchitectBash), cappedArchitectBash);
const cappedRoutineArgs = { command: "git status --short" };
assert.equal(cappedArchitectBash.execute(cappedRoutineArgs, exec), hostResult);
assert.equal(hostCalls[2].args, cappedRoutineArgs);
assert.equal("sandbox_permissions" in hostCalls[2].args, false);
assert.equal("justification" in hostCalls[2].args, false);
const cappedFirst = wrapArchitectBash(capObservationTool(base));
assert.deepEqual(cappedFirst.parameters, optionalSchema);
const cappedFirstEscalationArgs = { ...escalationArgs };
assert.equal(cappedFirst.execute(cappedFirstEscalationArgs, exec), hostResult);
assert.equal(hostCalls[3].args, cappedFirstEscalationArgs);
const writableArgs = {
  command: "cargo build && tool-index refresh",
  writable_paths: ["~/.cargo", "/var/tmp/tool-index"],
};
assert.equal(architectBash.execute(writableArgs, exec), hostResult);
assert.equal(hostCalls[4].args, writableArgs, "multi-root path requests reach the host unchanged");
assert.equal(hostCalls[4].args.writable_paths, writableArgs.writable_paths);
assert.equal("sandbox_permissions" in hostCalls[4].args, false, "path grants do not require coarse escalation");

const oversized = "x".repeat(OBSERVATION_MAX_CHARS + 1);
const rendered = cappedArchitectBash.output.render({}, { content: [{ type: "text", text: oversized }] });
assert.match(rendered[0].text, /environment output truncated/);
const finalized = cappedArchitectBash.finalizeContent({}, { content: [{ type: "text", text: oversized }] });
assert.match(finalized[0].text, /environment output truncated/);

// Projects has standing danger-full-access/never and therefore uses a distinct
// sanitizer: the controls are hidden and dropped because no wider mode exists.
const projectsSchema = sanitizeProjectsBashParameters(parameters);
assert.notEqual(projectsSchema, parameters);
assert.deepEqual(Object.keys(projectsSchema.properties), [
  "command",
  "description",
  "timeoutMs",
  "workdir",
  "run_in_background",
]);
assert.deepEqual(projectsSchema.required, ["command"]);
assert.deepEqual(projectsSchema.allOf[0].required, ["command"]);
assert.deepEqual(projectsSchema.allOf[1].then.required, ["workdir"]);
assert.ok(parameters.properties.sandbox_permissions, "Projects does not mutate the host schema");
const projectsInapplicableArgs = { ...escalationArgs, writable_paths: ["~/.cargo"] };
assert.deepEqual(sanitizeProjectsBashArguments(projectsInapplicableArgs), {
  command: escalationArgs.command,
  description: escalationArgs.description,
  timeoutMs: escalationArgs.timeoutMs,
  workdir: escalationArgs.workdir,
  run_in_background: false,
});
assert.equal(projectsInapplicableArgs.sandbox_permissions, "danger-full-access", "Projects does not mutate caller args");
assert.deepEqual(projectsInapplicableArgs.writable_paths, ["~/.cargo"]);

const projectsBash = wrapProjectsBash(base);
assert.notEqual(projectsBash, base);
assert.equal(projectsBash.name, base.name);
assert.equal(projectsBash.description, base.description);
assert.equal(projectsBash.output, output);
assert.equal(projectsBash.isConcurrencySafe, isConcurrencySafe);
assert.equal(projectsBash.finalizeContent, finalizeContent);
assert.equal(wrapProjectsBash(projectsBash), projectsBash, "Projects wrapping is HMR-idempotent");
const legacyProjectsBash = {
  ...projectsBash,
  [Symbol.for("qq.workflows.architectWrappedBash")]: true,
};
assert.equal(
  wrapProjectsBash(legacyProjectsBash),
  legacyProjectsBash,
  "Projects recognizes the pre-split non-escalating wrapper across HMR",
);

hostCalls.length = 0;
assert.equal(projectsBash.execute(projectsInapplicableArgs, exec), hostResult);
assert.deepEqual(hostCalls, [{
  args: {
    command: escalationArgs.command,
    description: escalationArgs.description,
    timeoutMs: escalationArgs.timeoutMs,
    workdir: escalationArgs.workdir,
    run_in_background: false,
  },
  exec,
}]);
assert.equal("sandbox_permissions" in hostCalls[0].args, false);
assert.equal("justification" in hostCalls[0].args, false);

const cappedProjectsBash = capObservationTool(projectsBash);
assert.notEqual(cappedProjectsBash, projectsBash);
assert.equal(wrapProjectsBash(cappedProjectsBash), cappedProjectsBash);
assert.equal(capObservationTool(cappedProjectsBash), cappedProjectsBash);

// Non-bash inherited definitions still receive observation capping only.
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
