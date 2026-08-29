#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ARCHITECT_INHERITED_TOOLS, PROJECTS_INHERITED_TOOLS } from "../src/hide-harness.mjs";
import { apply, PROJECTS_LABEL } from "../src/plugin.mjs";
import { isProjectsCandidate, PROJECTS_PRESET, PROJECTS_PROMPT_NAME } from "../src/projects.mjs";
import { createSelectionStore } from "../src/selection.mjs";

const PROJECTS_ID = "session-10000000-0000-4000-8000-000000000001";
const ORDINARY_ID = "session-20000000-0000-4000-8000-000000000002";
const TOOL_NAMES = [...PROJECTS_INHERITED_TOOLS];

function toolHarness() {
  const definitions = new Map(TOOL_NAMES.map((name) => [name, { name, async execute() {} }]));
  const registered = [];
  return {
    registered,
    schemas() {
      return [...definitions.values()].map(({ name }) => ({ name }));
    },
    get(name) {
      return definitions.get(name);
    },
    register(definition) {
      registered.push(definition.name);
      const previous = definitions.get(definition.name);
      definitions.set(definition.name, definition);
      return () => {
        if (previous) definitions.set(definition.name, previous);
        else definitions.delete(definition.name);
      };
    },
  };
}

function fakeAgent(id, cwd) {
  const tools = toolHarness();
  const contexts = [];
  const variables = [];
  const listeners = [];
  const systemPrompt = {
    context(spec) {
      contexts.push(spec);
      return () => contexts.splice(contexts.indexOf(spec), 1);
    },
    variable(name, value) {
      const record = { name, value };
      variables.push(record);
      return () => variables.splice(variables.indexOf(record), 1);
    },
    suppressRuntimeContext() {},
  };
  const agent = {
    id,
    status: "idle",
    session: {
      id,
      events: [],
      header: { cwd },
      append(type, data) {
        this.events.push({ type, data });
      },
    },
    ctx: {
      tools,
      systemPrompt,
      get(name) {
        if (name === "tools") return tools;
        if (name === "systemPrompt") return systemPrompt;
        return undefined;
      },
      on(type, listener) {
        const record = { type, listener };
        listeners.push(record);
        return () => listeners.splice(listeners.indexOf(record), 1);
      },
    },
  };
  return { agent, contexts, listeners, systemPrompt, tools, variables };
}

const scratch = mkdtempSync(join(tmpdir(), "qq-projects-workflow-"));
try {
  const projectsRoot = join(scratch, "projects");
  const ordinaryRoot = join(projectsRoot, "ordinary");
  mkdirSync(ordinaryRoot, { recursive: true });
  const selectionDir = join(scratch, "selection");
  const selection = createSelectionStore(selectionDir);
  selection.set(PROJECTS_ID, "architect");
  selection.set(ORDINARY_ID, "architect");

  const projects = fakeAgent(PROJECTS_ID, join(projectsRoot, "."));
  const ordinary = fakeAgent(ORDINARY_ID, ordinaryRoot);
  const allowed = [];
  const coreService = {
    projectsRoot: realpathSync(projectsRoot),
    surface: {
      allow(agent, names) { allowed.push({ agent, names: [...names] }); },
    },
  };
  const childAtProjectsRoot = fakeAgent(
    "session-30000000-0000-4000-8000-000000000003",
    projectsRoot,
  ).agent;
  childAtProjectsRoot.session.header.origin = "subagent";
  assert.equal(isProjectsCandidate(childAtProjectsRoot, { get: () => coreService }), false);
  const agentsById = new Map([
    [PROJECTS_ID, projects.agent],
    [ORDINARY_ID, ordinary.agent],
  ]);
  const commands = [];
  const effects = [];
  const eventListeners = new Map();
  const hung = [];
  const cleared = [];
  const pinned = [];
  const provided = {};
  const services = {
    agents: {
      list: () => [...agentsById.values()],
      get: (id) => agentsById.get(id),
    },
    sessions: {},
    "qq-core": coreService,
    "qq-relay": {
      hang(id, label) { hung.push({ id, label }); },
      clear(id, label) { cleared.push({ id, label }); return true; },
      alias: () => "ephemeral",
    },
    permissionPresets: {
      set(session, preset) { pinned.push({ id: session.id, preset }); },
    },
    commands: {
      register(definition) {
        commands.push(definition);
        return () => {};
      },
    },
  };
  const ctx = {
    get(name) {
      return services[name] ?? provided[name];
    },
    provide(name, value) {
      provided[name] = value;
    },
    effect(factory) {
      effects.push(factory());
      return () => {};
    },
    on(type, listener) {
      const records = eventListeners.get(type) ?? [];
      records.push(listener);
      eventListeners.set(type, records);
      return () => records.splice(records.indexOf(listener), 1);
    },
    logger: { info() {}, warn() {} },
  };

  apply(ctx, {
    selectionDir,
    journalDir: join(scratch, "journals"),
    landDir: join(scratch, "land"),
    caseDir: join(scratch, "cases"),
  });

  const service = provided["qq-workflows"];
  assert.ok(service);
  assert.equal(service.selection.get(PROJECTS_ID), "architect", "implicit attach must not rewrite stale selection");
  assert.deepEqual(service.workflows.names(), ["architect", "find", "base"]);
  assert.equal(service.workflows.names().includes("projects"), false);
  assert.equal(service.complete("/workflows proj").candidates.includes("projects"), false);
  assert.deepEqual(service.workflows.kinds(), ["implementation", "research"]);
  const docsCalls = [];
  const docsRecords = new Set();
  const disposeDocs = service.workflows.register({
    kind: "docs",
    async invoke(args) {
      docsCalls.push(["invoke", args]);
      docsRecords.add(args.delegationId);
      return { status: "ok", delegationId: args.delegationId, child: "session-docs", role: "mini-docs", phaseEpoch: 1 };
    },
    status(args) { docsCalls.push(["status", args]); return { status: "ok", delegationId: args.delegationId, delegationStatus: "writing" }; },
    send(args) { docsCalls.push(["send", args]); return { status: "sent", delegationId: args.delegationId }; },
    stop(args) { docsCalls.push(["stop", args]); return { status: "ok", delegationId: args.delegationId, delegationStatus: "blocked" }; },
    owns(id) { return docsRecords.has(id); },
  });
  assert.deepEqual(service.workflows.names(), ["architect", "find", "base"], "docs is not a chair");
  assert.deepEqual(service.workflows.kinds(), ["implementation", "research", "docs"]);
  const docsStarted = await service.workflows.delegate({ kind: "docs", parentSessionUuid: ORDINARY_ID, packet: "docs packet" });
  assert.equal(docsStarted.status, "ok");
  assert.match(docsStarted.delegationId, /^[0-9a-f-]{36}$/);
  assert.equal(service.workflows.status({ delegationId: docsStarted.delegationId }).delegationStatus, "writing");
  assert.equal((await service.workflows.send({ delegationId: docsStarted.delegationId, message: "focus" })).status, "sent");
  assert.equal((await service.workflows.stop({ delegationId: docsStarted.delegationId })).delegationStatus, "blocked");
  disposeDocs();
  assert.deepEqual(service.workflows.kinds(), ["implementation", "research"]);

  assert.deepEqual(allowed, [
    { agent: projects.agent, names: [...PROJECTS_INHERITED_TOOLS] },
    { agent: ordinary.agent, names: [...ARCHITECT_INHERITED_TOOLS] },
  ]);
  for (const name of ["case_write", "delegate", "land", "workflow_status", "workflow_send", "workflow_stop"]) {
    assert.equal(projects.tools.registered.includes(name), false, `${name} must not be registered on Projects`);
  }
  assert.ok(ordinary.tools.registered.includes("case_write"), "ordinary architect still receives architect tools");

  const prompt = projects.contexts.find((entry) => entry.name === PROJECTS_PROMPT_NAME);
  assert.ok(prompt, "Projects prompt is attached");
  assert.match(prompt.text(), /immediate-child git repositories/);
  assert.match(prompt.text(), /qq-ui/);
  assert.match(prompt.text(), /Do not implement product code/);
  assert.match(prompt.text(), /catalog group/);
  assert.equal(projects.contexts.some((entry) => entry.name === "qq-workflows:architect"), false);
  assert.equal(service.caseFile(PROJECTS_ID), null);

  assert.deepEqual(pinned, [{ id: PROJECTS_ID, preset: PROJECTS_PRESET }]);
  assert.ok(hung.some((entry) => entry.id === PROJECTS_ID && entry.label === PROJECTS_LABEL));
  assert.ok(hung.some((entry) => entry.id === ORDINARY_ID && entry.label === "workflows:architect"));

  assert.throws(
    () => service.workflows.select(PROJECTS_ID, "base"),
    /this session is not a workflow picker/,
  );
  const workflowsCommand = commands.find((definition) => definition.name === "workflows");
  assert.ok(workflowsCommand);
  const refused = workflowsCommand.handler({ agent: projects.agent, rawInput: "base" });
  assert.deepEqual(refused, { kind: "error", text: "this session is not a workflow picker" });

  // A repeated attach path re-pins access; the real service appends no events
  // once this preset is already selected and effective.
  await eventListeners.get("agent/created")?.[0]?.({ agent: projects.agent });
  assert.deepEqual(pinned.at(-1), { id: PROJECTS_ID, preset: PROJECTS_PRESET });
  assert.equal(pinned.length, 2);
  assert.equal(allowed.filter(({ agent }) => agent === projects.agent).length, 1);

  for (const dispose of effects.reverse()) await dispose?.();
  assert.ok(cleared.some((entry) => entry.id === PROJECTS_ID && entry.label === PROJECTS_LABEL));

  console.log("projects workflow: ok");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
