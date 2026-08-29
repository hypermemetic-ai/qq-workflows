#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCaseStore } from "../src/casefile.mjs";
import { createDelegationStore } from "../src/delegation-store.mjs";
import { apply, compactActivityProjection } from "../src/plugin.mjs";
import { createSelectionStore } from "../src/selection.mjs";

assert.deepEqual(compactActivityProjection({
  id: "delegation-id",
  parentSessionUuid: "parent-id",
  status: "reviewing",
  brief: "must not be retained",
  packet: { huge: true },
}), { id: "delegation-id", parentSessionUuid: "parent-id", status: "reviewing" });

const NONE = "session-10000000-0000-4000-8000-000000000001";
const UNKNOWN = "session-20000000-0000-4000-8000-000000000002";
const PLANNING = "session-30000000-0000-4000-8000-000000000003";
const WORK = "session-40000000-0000-4000-8000-000000000004";
const PROJECTS = "session-50000000-0000-4000-8000-000000000005";
const CHILD = "session-60000000-0000-4000-8000-000000000006";
const WORK_CHILD_1 = "session-70000000-0000-4000-8000-000000000007";
const WORK_CHILD_2 = "session-80000000-0000-4000-8000-000000000008";
const WORK_CHILD_3 = "session-b0000000-0000-4000-8000-00000000000b";
const DELEGATION_1 = "90000000-0000-4000-8000-000000000009";
const DELEGATION_2 = "a0000000-0000-4000-8000-00000000000a";
const DELEGATION_3 = "c0000000-0000-4000-8000-00000000000c";

function fakeAgent(id, cwd, header = {}) {
  const definitions = new Map();
  const tools = {
    schemas: () => [...definitions.values()].map(({ name }) => ({ name })),
    get: (name) => definitions.get(name),
    register(definition) {
      const prior = definitions.get(definition.name);
      definitions.set(definition.name, definition);
      return () => prior ? definitions.set(definition.name, prior) : definitions.delete(definition.name);
    },
  };
  const contexts = [];
  const variables = [];
  const systemPrompt = {
    context(spec) { contexts.push(spec); return () => contexts.splice(contexts.indexOf(spec), 1); },
    variable(name, value) {
      const item = { name, value };
      variables.push(item);
      return () => variables.splice(variables.indexOf(item), 1);
    },
    suppressRuntimeContext() {},
  };
  return {
    id,
    status: "idle",
    session: {
      id,
      events: [],
      header: { cwd, ...header },
      append(type, data) { this.events.push({ type, data }); },
    },
    ctx: {
      tools,
      systemPrompt,
      get(name) {
        if (name === "tools") return tools;
        if (name === "systemPrompt") return systemPrompt;
        return undefined;
      },
      on() { return () => {}; },
    },
  };
}

function harness({ agents, projectsRoot }) {
  const provided = {};
  const effects = [];
  const listeners = new Map();
  const services = {
    agents: {
      list: () => agents,
      get: (id) => agents.find((agent) => agent.session.id === id) ?? null,
    },
    sessions: {},
    "qq-core": {
      projectsRoot,
      surface: { allow() {} },
    },
    "qq-relay": {
      hang() {},
      clear() { return true; },
      alias() { return undefined; },
      async send() { return { status: "sent" }; },
    },
    permissionPresets: { set() {} },
  };
  const ctx = {
    get(name) { return services[name] ?? provided[name]; },
    provide(name, value) { provided[name] = value; },
    effect(factory) { effects.push(factory()); return () => {}; },
    on(name, listener) {
      const group = listeners.get(name) ?? [];
      group.push(listener);
      listeners.set(name, group);
      return () => group.splice(group.indexOf(listener), 1);
    },
    logger: { info() {}, warn() {} },
  };
  return { ctx, effects, service: () => provided["qq-workflows"] };
}

function row(service, sessionUuid) {
  return service.workflows.snapshots().find((item) => item.sessionUuid === sessionUuid);
}

const scratch = mkdtempSync(join(tmpdir(), "qq-workflow-snapshots."));
try {
  const projectsRoot = join(scratch, "projects");
  const ordinaryRoot = join(projectsRoot, "repo");
  mkdirSync(ordinaryRoot, { recursive: true });
  const paths = {
    selectionDir: join(scratch, "selection"),
    caseDir: join(scratch, "cases"),
    delegationDir: join(scratch, "delegations"),
    phaseDir: join(scratch, "phases"),
    researchDir: join(scratch, "research"),
    settingsFile: join(scratch, "settings.json"),
  };

  const selection = createSelectionStore(paths.selectionDir);
  selection.set(UNKNOWN, "base");
  selection.set(PLANNING, "architect");
  selection.set(WORK, "architect");
  // Projects is effective even if an old selectable-chair record remains.
  selection.set(PROJECTS, "architect");

  createCaseStore(paths.caseDir).write(WORK, "# Settled plan\n\nImplement it.\n");
  const delegations = createDelegationStore(paths.delegationDir);
  for (const [delegationId, child, status] of [
    [DELEGATION_1, WORK_CHILD_1, "reviewing"],
    [DELEGATION_2, WORK_CHILD_2, "revising"],
    [DELEGATION_3, WORK_CHILD_3, "landing"],
  ]) {
    delegations.create({
      id: delegationId,
      delegationId,
      parentSessionUuid: WORK,
      architectSession: WORK,
      implementationSession: child,
      status,
    });
  }

  const agents = [
    fakeAgent(NONE, ordinaryRoot),
    fakeAgent(UNKNOWN, ordinaryRoot),
    fakeAgent(PLANNING, ordinaryRoot),
    fakeAgent(WORK, ordinaryRoot),
    fakeAgent(PROJECTS, projectsRoot),
    fakeAgent(CHILD, ordinaryRoot, { origin: "subagent", parentSession: PLANNING }),
  ];
  let clock = 1_000;
  const first = harness({ agents, projectsRoot });
  apply(first.ctx, { ...paths, now: () => clock });
  const service = first.service();

  const initial = service.workflows.snapshots();
  assert.equal(initial.length, 5, "child/subagent sessions are excluded");
  assert.deepEqual(row(service, NONE), {
    sessionUuid: NONE, workflow: null, phase: "none", phaseStartedAt: null,
  });
  assert.deepEqual(row(service, UNKNOWN), {
    sessionUuid: UNKNOWN, workflow: "base", phase: "unknown", phaseStartedAt: null,
  });
  assert.deepEqual(row(service, PLANNING), {
    sessionUuid: PLANNING, workflow: "architect", phase: "planning", phaseStartedAt: 1_000,
  });
  assert.deepEqual(row(service, WORK), {
    sessionUuid: WORK, workflow: "architect", phase: "work", phaseStartedAt: 1_000,
  });
  assert.deepEqual(row(service, PROJECTS), {
    sessionUuid: PROJECTS, workflow: "projects", phase: "unknown", phaseStartedAt: null,
  });
  assert.equal(row(service, CHILD), undefined);

  const planningPhaseFile = join(paths.phaseDir, `${PLANNING}.json`);
  const bytesBeforeReads = readFileSync(planningPhaseFile, "utf8");
  const mtimeBeforeReads = statSync(planningPhaseFile).mtimeMs;
  assert.deepEqual(service.workflows.snapshots(), initial, "repeated reads are stable");
  assert.equal(readFileSync(planningPhaseFile, "utf8"), bytesBeforeReads, "snapshot does not rewrite phase state");
  assert.equal(statSync(planningPhaseFile).mtimeMs, mtimeBeforeReads, "snapshot does not touch phase state");
  assert.equal(statSync(planningPhaseFile).mode & 0o777, 0o600);

  clock = 2_000;
  service.cases.write(PLANNING, "# Plan\n\nFirst step.\n");
  assert.equal(row(service, PLANNING).phase, "plan");
  assert.equal(row(service, PLANNING).phaseStartedAt, 2_000);
  clock = 3_000;
  service.cases.write(PLANNING, "# Plan\n\nFirst step, clarified.\n");
  assert.equal(row(service, PLANNING).phaseStartedAt, 2_000, "same-phase case edits retain the timestamp");

  clock = 3_500;
  service.workflows.select(NONE, "architect");
  assert.deepEqual(row(service, NONE), {
    sessionUuid: NONE, workflow: "architect", phase: "planning", phaseStartedAt: 3_500,
  });
  service.workflows.clear(NONE);
  assert.deepEqual(row(service, NONE), {
    sessionUuid: NONE, workflow: null, phase: "none", phaseStartedAt: null,
  });
  service.workflows.select(NONE, "base");
  assert.deepEqual(row(service, NONE), {
    sessionUuid: NONE, workflow: "base", phase: "unknown", phaseStartedAt: null,
  });

  const workStartedAt = row(service, WORK).phaseStartedAt;
  clock = 4_000;
  await service.workflows.stop({ delegationId: DELEGATION_1, parentSessionUuid: WORK, reason: "first done" });
  assert.equal(row(service, WORK).phase, "work", "another active delegation keeps the chair in work");
  assert.equal(row(service, WORK).phaseStartedAt, workStartedAt);
  clock = 4_500;
  await service.workflows.stop({ delegationId: DELEGATION_2, parentSessionUuid: WORK, reason: "second done" });
  assert.equal(row(service, WORK).phase, "work");
  assert.equal(row(service, WORK).phaseStartedAt, workStartedAt);
  clock = 5_000;
  await service.workflows.stop({ delegationId: DELEGATION_3, parentSessionUuid: WORK, reason: "third done" });
  assert.deepEqual(row(service, WORK), {
    sessionUuid: WORK, workflow: "architect", phase: "plan", phaseStartedAt: 5_000,
  });

  let adoptedActive = false;
  let adoptedStartedAt = null;
  const disposeAdopted = service.workflows.register({
    kind: "docs",
    async invoke() {
      adoptedActive = true;
      adoptedStartedAt = clock;
      return { status: "ok" };
    },
    status() { return { status: "ok" }; },
    send() { return { status: "sent" }; },
    stop() {
      adoptedActive = false;
      adoptedStartedAt = clock;
      return { status: "ok" };
    },
    activeProjection({ parentSessionUuid }) {
      return parentSessionUuid === PLANNING
        ? { active: adoptedActive, phaseStartedAt: adoptedStartedAt }
        : { active: false };
    },
  });
  clock = 6_000;
  const adopted = await service.workflows.delegate({ kind: "docs", parentSessionUuid: PLANNING });
  assert.equal(row(service, PLANNING).phase, "work");
  assert.equal(row(service, PLANNING).phaseStartedAt, 6_000);
  clock = 7_000;
  await service.workflows.stop({ delegationId: adopted.delegationId, parentSessionUuid: PLANNING });
  assert.equal(row(service, PLANNING).phase, "plan");
  assert.equal(row(service, PLANNING).phaseStartedAt, 7_000);
  disposeAdopted();

  let unprojectedInvoked = false;
  const disposeUnprojected = service.workflows.register({
    kind: "opaque",
    async invoke() { unprojectedInvoked = true; return { status: "ok" }; },
    status() { return { status: "ok" }; },
    send() { return { status: "sent" }; },
    stop() { return { status: "ok" }; },
  });
  clock = 8_000;
  await service.workflows.delegate({ kind: "opaque", parentSessionUuid: PLANNING });
  assert.equal(unprojectedInvoked, true);
  assert.equal(row(service, PLANNING).phase, "plan", "adopted state without a projection is not guessed");
  assert.equal(row(service, PLANNING).phaseStartedAt, 7_000);
  disposeUnprojected();

  // Simulate plugin replacement. Startup reconciliation must retain the
  // persisted semantic starts instead of assigning the new clock value or
  // rewriting the same-phase ledger record.
  const phaseMtimeBeforeHmr = statSync(planningPhaseFile).mtimeMs;
  for (const dispose of [...first.effects].reverse()) await dispose?.();
  clock = 9_000;
  const second = harness({ agents, projectsRoot });
  apply(second.ctx, { ...paths, now: () => clock });
  const afterHmr = second.service();
  assert.equal(row(afterHmr, PLANNING).phaseStartedAt, 7_000);
  assert.equal(row(afterHmr, WORK).phaseStartedAt, 5_000);
  assert.equal(statSync(planningPhaseFile).mtimeMs, phaseMtimeBeforeHmr);
  for (const dispose of [...second.effects].reverse()) await dispose?.();

  console.log("workflow snapshots: ok");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
