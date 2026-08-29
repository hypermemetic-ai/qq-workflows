#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_HANDLE } from "../src/agent-handle.mjs";
import { createDelegationStore } from "../src/delegation-store.mjs";
import { createLand, DELEGATION_LABEL_PREFIX, DELEGATION_PHASE_LABEL_PREFIX } from "../src/land.mjs";
import { buildArchitectTools } from "../src/tools.mjs";

const PARENT = "session-10000000-0000-4000-8000-000000000001";
const OTHER_PARENT = "session-10000000-0000-4000-8000-000000000002";
const CURRENT = "session-20000000-0000-4000-8000-000000000001";
const LIVE_CURRENT = "session-20000000-0000-4000-8000-000000000002";
const FAILED_CURRENT = "session-20000000-0000-4000-8000-000000000003";
const TRANSITION_CURRENT = "session-20000000-0000-4000-8000-000000000004";
const TERMINAL_CURRENT = "session-20000000-0000-4000-8000-000000000005";
const CORRUPT_CURRENT = "session-20000000-0000-4000-8000-000000000006";
const FOREIGN_CURRENT = LIVE_CURRENT;
const QA_CURRENT = "session-20000000-0000-4000-8000-000000000007";
const QA_IMPLEMENTATION = "session-20000000-0000-4000-8000-000000000008";
const WAKE_FAILED_CURRENT = "session-20000000-0000-4000-8000-000000000009";
const DELEGATION = "30000000-0000-4000-8000-000000000001";
const LIVE_DELEGATION = "30000000-0000-4000-8000-000000000002";
const FAILED_DELEGATION = "30000000-0000-4000-8000-000000000003";
const TRANSITION_DELEGATION = "30000000-0000-4000-8000-000000000004";
const TERMINAL_DELEGATION = "30000000-0000-4000-8000-000000000005";
const CORRUPT_DELEGATION = "30000000-0000-4000-8000-000000000006";
const FOREIGN_DELEGATION = "30000000-0000-4000-8000-000000000007";
const QA_DELEGATION = "30000000-0000-4000-8000-000000000008";
const WAKE_FAILED_DELEGATION = "30000000-0000-4000-8000-000000000009";

function toolHarness() {
  const definitions = new Map([["bash", {
    name: "bash",
    description: "synthetic bash",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    async execute() { return { output: "" }; },
  }]]);
  return {
    definitions,
    tools: {
      get(name) { return definitions.get(name); },
      schemas() { return [...definitions.values()].map(({ name }) => ({ name })); },
      register(definition) {
        const prior = definitions.get(definition.name);
        definitions.set(definition.name, definition);
        return () => prior ? definitions.set(definition.name, prior) : definitions.delete(definition.name);
      },
    },
  };
}

function fakeChild({ id, delegationId, parent = PARENT, role = "implementation", epoch = 1, cwd }) {
  const { definitions, tools } = toolHarness();
  const listeners = [];
  const steers = [];
  const events = [
    { type: "test/preserved", seq: 1, data: { marker: "durable transcript" } },
    { type: "turn/start", seq: 2, data: { turn: 1 } },
    { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "interrupted" } } },
  ];
  const systemPrompt = { section() { return () => {}; }, suppressRuntimeContext() {} };
  const agent = {
    id,
    status: "idle",
    inbox: { nextTurn: [], nextStep: [] },
    session: {
      id,
      events,
      header: {
        cwd,
        parentSession: parent,
        origin: "subagent",
        delegationRole: role,
        delegationPhaseRole: role,
        delegationId,
        delegationPhaseEpoch: epoch,
        kind: role === "qa" ? "mini-qa" : "mini-code",
        agentPreset: role === "qa" ? "mini-qa" : "mini-code",
      },
      append(type, data) { this.events.push({ type, data }); },
    },
    steer(message) { steers.push(message); this.inbox.nextStep.push(message); },
    followup(message) { this.inbox.nextTurn.push(message); },
  };
  agent.ctx = {
    agent,
    tools,
    systemPrompt,
    get(name, optional) {
      assert.equal(optional, false, `service ${name} must be looked up optionally`);
      if (name === "tools") return tools;
      if (name === "systemPrompt") return systemPrompt;
      if (name === "qq-core") return { surface: { allow() {} } };
      if (name === "sandboxPolicy") return {
        resolve() { return { mode: role === "qa" ? "read-only" : "workspace-write", workspaceRoot: cwd }; },
      };
      if (name === "shell") return { sandboxMode: role === "qa" ? "read-only" : "workspace-write" };
      if (name === "sandbox") return { confine() { return { enforcement: "full" }; } };
      return null;
    },
    on(type, listener) {
      const record = { type, listener };
      listeners.push(record);
      return () => listeners.splice(listeners.indexOf(record), 1);
    },
  };
  let disposed = 0;
  const handle = {
    agent,
    async dispose() { disposed += 1; },
  };
  return { agent, definitions, handle, listeners, steers, disposed: () => disposed };
}

function createRunning(store, { delegationId, child, transitioning = false, status = "running", current } = {}) {
  return store.create({
    delegationId,
    parentSessionUuid: PARENT,
    architectSession: PARENT,
    status,
    implementationSession: child,
    originalImplementationSession: child,
    phaseEpoch: current?.phaseEpoch ?? 1,
    current: current ?? (status === "blocked" ? null : { sessionUuid: child, role: "implementation", phaseEpoch: 1 }),
    transitioning,
    brief: "synthetic exact-session recovery",
    worktree: workspace,
    workspace,
    mainRoot: workspace,
    branch: `feat/${delegationId}`,
    baseBranch: "main",
    baseRef: "a".repeat(40),
  });
}

function createReviewing(store, { delegationId, child }) {
  return store.create({
    delegationId,
    parentSessionUuid: PARENT,
    architectSession: PARENT,
    status: "reviewing",
    implementationSession: QA_IMPLEMENTATION,
    originalImplementationSession: QA_IMPLEMENTATION,
    qaSession: child,
    phaseEpoch: 2,
    current: { sessionUuid: child, role: "qa", phaseEpoch: 2 },
    brief: "synthetic exact-session QA recovery",
    worktree: workspace,
    workspace,
    mainRoot: workspace,
    branch: `feat/${delegationId}`,
    baseBranch: "main",
    baseRef: "a".repeat(40),
    ref: "b".repeat(40),
  });
}

const root = mkdtempSync(join(tmpdir(), "qq-workflow-resume."));
const workspace = join(root, "workspace");
const store = createDelegationStore(join(root, "store"));
try {
  // The fixture workspace is the preserved physical cwd. No Git operation is
  // run by recovery; tools merely bind their sandbox wrappers around this root.
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
  createRunning(store, { delegationId: DELEGATION, child: CURRENT });
  createRunning(store, { delegationId: LIVE_DELEGATION, child: LIVE_CURRENT });
  createRunning(store, { delegationId: FAILED_DELEGATION, child: FAILED_CURRENT });
  createRunning(store, { delegationId: TRANSITION_DELEGATION, child: TRANSITION_CURRENT, transitioning: true });
  createRunning(store, { delegationId: TERMINAL_DELEGATION, child: TERMINAL_CURRENT, status: "blocked" });
  createReviewing(store, { delegationId: QA_DELEGATION, child: QA_CURRENT });
  createRunning(store, { delegationId: WAKE_FAILED_DELEGATION, child: WAKE_FAILED_CURRENT });

  const live = new Map();
  const resumedChildren = new Map();
  const resumeOptions = [];
  const labels = [];
  let resumeCalls = 0;
  let createCalls = 0;
  let releaseResume;
  const resumeGate = new Promise((resolve) => { releaseResume = resolve; });
  const agents = {
    get(id) { return live.get(id) ?? null; },
    list() { return [...live.values()]; },
    async create() { createCalls += 1; throw new Error("workflow recovery must never create"); },
    async resume(options) {
      resumeCalls += 1;
      resumeOptions.push(options);
      await resumeGate;
      if (options.resumeSessionId === FAILED_CURRENT) throw new Error("persisted session log is missing");
      const state = store.bySession(options.resumeSessionId);
      const fixture = fakeChild({
        id: options.resumeSessionId,
        delegationId: state.delegationId,
        parent: state.parentSessionUuid,
        role: state.current.role,
        epoch: state.current.phaseEpoch,
        cwd: workspace,
      });
      await options.setup?.(fixture.agent.ctx);
      if (options.resumeSessionId === WAKE_FAILED_CURRENT) {
        fixture.agent.steer = () => { throw new Error("recovery wake failed after adoption"); };
      }
      const originalDispose = fixture.handle.dispose;
      fixture.handle.dispose = async () => {
        live.delete(options.resumeSessionId);
        await originalDispose();
      };
      resumedChildren.set(options.resumeSessionId, fixture);
      live.set(options.resumeSessionId, fixture.agent);
      return fixture.handle;
    },
  };
  const relay = {
    hang(id, label) { labels.push({ id, label }); },
    clear() { return true; },
    alias(id) { return id === CURRENT ? "recovering" : "live"; },
  };
  const ctx = {
    get(name) { return name === "qq-relay" ? relay : null; },
    logger: { info() {}, warn() {} },
  };
  const land = createLand({ ctx, store, agents, env: {} });

  // Public tool accepts only the durable UUID and forwards authenticated parent
  // plus optional role/epoch guards. A physical session UUID is not a parameter.
  const calls = [];
  const tools = buildArchitectTools({
    delegate() {},
    workflowStatus() {},
    workflowSend() {},
    workflowResume(args) { calls.push(args); return { status: "already-live" }; },
    workflowStop() {},
  });
  const resumeTool = tools.find(({ name }) => name === "workflow_resume");
  assert.ok(resumeTool);
  assert.equal(Object.hasOwn(resumeTool.parameters, "sessionUuid"), false);
  await resumeTool.execute(
    { delegationId: DELEGATION, expectedRole: "implementation", expectedEpoch: 1 },
    { agent: { session: { id: PARENT } } },
  );
  assert.deepEqual(calls, [{
    delegationId: DELEGATION,
    expectedRole: "implementation",
    expectedEpoch: 1,
    parentSessionUuid: PARENT,
  }]);

  // Ownership and stale guards refuse before touching DSH or the durable file.
  const originalBytes = readFileSync(store.fileFor(DELEGATION), "utf8");
  assert.match((await land.workflowResume({ delegationId: DELEGATION, parentSessionUuid: OTHER_PARENT })).reason, /different parent/);
  assert.match((await land.workflowResume({ delegationId: DELEGATION, parentSessionUuid: PARENT, expectedRole: "qa" })).reason, /stale workflow role/);
  assert.match((await land.workflowResume({ delegationId: DELEGATION, parentSessionUuid: PARENT, expectedEpoch: 2 })).reason, /stale phase epoch/);
  assert.match((await land.workflowResume({ delegationId: TRANSITION_DELEGATION, parentSessionUuid: PARENT })).reason, /ambiguous transitioning or pending/);
  assert.match((await land.workflowResume({ delegationId: TERMINAL_DELEGATION, parentSessionUuid: PARENT })).reason, /terminal \(blocked\)/);
  assert.equal(resumeCalls, 0);
  assert.equal(readFileSync(store.fileFor(DELEGATION), "utf8"), originalBytes);

  // Concurrent recovery is a single fixed-UUID DSH resume. Both callers adopt
  // the same winner; neither can mint or replace a physical child.
  const first = land.workflowResume({
    delegationId: DELEGATION,
    parentSessionUuid: PARENT,
    expectedRole: "implementation",
    expectedEpoch: 1,
  });
  const second = land.workflowResume({ delegationId: DELEGATION, parentSessionUuid: PARENT });
  await Promise.resolve();
  assert.equal(resumeCalls, 1);
  releaseResume();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, "resumed");
  assert.deepEqual(secondResult, firstResult);
  assert.equal(firstResult.sessionUuid, CURRENT);
  assert.equal(firstResult.role, "implementation");
  assert.equal(firstResult.phaseEpoch, 1);
  assert.equal(createCalls, 0);
  assert.equal(resumeOptions.length, 1);
  assert.equal(resumeOptions[0].resumeSessionId, CURRENT);
  assert.equal(Object.hasOwn(resumeOptions[0], "sessionId"), false);
  assert.equal(Object.hasOwn(resumeOptions[0], "meta"), false);
  assert.equal(typeof resumeOptions[0].setup, "function");
  const recovered = resumedChildren.get(CURRENT);
  assert.equal(recovered.agent.session.header.cwd, workspace);
  assert.equal(recovered.agent.session.events[0].data.marker, "durable transcript");
  assert.equal(recovered.steers.length, 1, "the winning inactive resume wakes exactly once");
  assert.equal(recovered.steers[0].source.form, "recovery");
  assert.match(recovered.steers[0].content[0].text, /previous host process did not continue/i);
  assert.match(recovered.steers[0].content[0].text, /Inspect the current diff, git status, and test state/);
  assert.match(recovered.steers[0].content[0].text, /outcome remains unknown/);
  assert.equal(recovered.agent.session.header.kind, "mini-code");
  assert.equal(recovered.definitions.has("bash"), true);
  assert.equal(recovered.definitions.has("run_tests"), true);
  assert.deepEqual(land.ownedChildren(), [CURRENT]);
  assert.ok(labels.some(({ id, label }) => id === CURRENT && label === `${DELEGATION_LABEL_PREFIX}${DELEGATION}`));
  assert.ok(labels.some(({ id, label }) => id === CURRENT && label === `${DELEGATION_PHASE_LABEL_PREFIX}implementation`));
  assert.equal(readFileSync(store.fileFor(DELEGATION), "utf8"), originalBytes, "successful recovery never rewrites delegation state");

  // Idempotent retry is already-live and rebinds the same exact owner without a
  // second resume or continuation.
  const retry = await land.workflowResume({ delegationId: DELEGATION, parentSessionUuid: PARENT });
  assert.equal(retry.status, "already-live");
  assert.equal(resumeCalls, 1);
  assert.equal(recovered.steers.length, 1);

  // Another simultaneously active land controller may observe the child, but
  // cannot steal its exact handle or duplicate its tools/watchers.
  const competingLand = createLand({ ctx, store, agents, env: {} });
  const competing = await competingLand.workflowResume({ delegationId: DELEGATION, parentSessionUuid: PARENT });
  assert.equal(competing.status, "refused");
  assert.match(competing.reason, /owned by another live controller/);
  assert.equal(resumeCalls, 1);
  await competingLand.dispose();

  // Critical generic-/resume timing case: exact child is live with the shared
  // DSH AgentHandle but land has never retained it. Explicit recovery mounts,
  // owns, labels, and installs completion controls before returning already-live.
  const generic = fakeChild({ id: LIVE_CURRENT, delegationId: LIVE_DELEGATION, cwd: workspace });
  Object.defineProperty(generic.agent, AGENT_HANDLE, { value: generic.handle, configurable: true });
  live.set(LIVE_CURRENT, generic.agent);
  const liveBytes = readFileSync(store.fileFor(LIVE_DELEGATION), "utf8");
  const rebound = await land.workflowResume({ delegationId: LIVE_DELEGATION, parentSessionUuid: PARENT });
  assert.equal(rebound.status, "already-live");
  assert.equal(rebound.sessionUuid, LIVE_CURRENT);
  assert.equal(resumeCalls, 1);
  assert.equal(generic.agent.session.header.kind, "mini-code");
  assert.equal(generic.definitions.has("bash"), true);
  assert.equal(generic.definitions.has("run_tests"), true);
  assert.equal(generic.steers.length, 0, "an already-live child is never given a duplicate continuation");
  assert.ok(land.ownedChildren().includes(LIVE_CURRENT));
  assert.ok(labels.some(({ id, label }) => id === LIVE_CURRENT && label === `${DELEGATION_LABEL_PREFIX}${LIVE_DELEGATION}`));
  assert.equal(readFileSync(store.fileFor(LIVE_DELEGATION), "utf8"), liveBytes);

  // QA recovery uses the same exact-session path with the QA persona, read-only
  // sandbox, submit_review completion bridge, settlement watcher, and role-safe
  // continuation. It likewise leaves the durable phase pointer byte-identical.
  const qaBytes = readFileSync(store.fileFor(QA_DELEGATION), "utf8");
  const qaResult = await land.workflowResume({
    delegationId: QA_DELEGATION,
    parentSessionUuid: PARENT,
    expectedRole: "qa",
    expectedEpoch: 2,
  });
  assert.equal(qaResult.status, "resumed");
  assert.equal(qaResult.sessionUuid, QA_CURRENT);
  assert.equal(resumeOptions.at(-1).resumeSessionId, QA_CURRENT);
  const recoveredQa = resumedChildren.get(QA_CURRENT);
  assert.equal(recoveredQa.agent.session.header.kind, "mini-qa");
  assert.equal(recoveredQa.definitions.has("submit_review"), true);
  assert.equal(recoveredQa.definitions.has("run_tests"), false);
  assert.ok(recoveredQa.listeners.filter(({ type }) => type === "session/event").length >= 3, "QA format, owner, and settlement watchers are installed");
  assert.equal(
    recoveredQa.agent.session.events.filter(({ type }) => type === "sandbox/mode").at(-1).data.mode,
    "read-only",
  );
  assert.equal(recoveredQa.steers.length, 1);
  assert.match(recoveredQa.steers[0].content[0].text, /Keep the workspace read-only/);
  assert.match(recoveredQa.steers[0].content[0].text, /rather than rerunning required tests/);
  assert.equal(readFileSync(store.fileFor(QA_DELEGATION), "utf8"), qaBytes);

  // A second durable record cannot steal an exact current child already bound
  // to another live delegation controller.
  createRunning(store, { delegationId: FOREIGN_DELEGATION, child: FOREIGN_CURRENT });
  const foreign = await land.workflowResume({ delegationId: FOREIGN_DELEGATION, parentSessionUuid: PARENT });
  assert.equal(foreign.status, "refused");
  assert.match(foreign.reason, /owned by another live controller/);

  // Missing physical persistence is concrete and leaves the durable delegation
  // byte-for-byte untouched.
  const failedBytes = readFileSync(store.fileFor(FAILED_DELEGATION), "utf8");
  const failed = await land.workflowResume({ delegationId: FAILED_DELEGATION, parentSessionUuid: PARENT });
  assert.equal(failed.status, "refused");
  assert.match(failed.reason, new RegExp(`cannot resume exact current session ${FAILED_CURRENT}`));
  assert.match(failed.reason, /persisted session log is missing/);
  assert.equal(readFileSync(store.fileFor(FAILED_DELEGATION), "utf8"), failedBytes);
  assert.equal(live.has(FAILED_CURRENT), false);
  assert.equal(createCalls, 0);

  // A post-adoption wake failure rolls back only the live controller/handle. It
  // never blocks, replaces, or rewrites the recoverable durable delegation.
  const wakeFailedBytes = readFileSync(store.fileFor(WAKE_FAILED_DELEGATION), "utf8");
  const wakeFailed = await land.workflowResume({ delegationId: WAKE_FAILED_DELEGATION, parentSessionUuid: PARENT });
  assert.equal(wakeFailed.status, "refused");
  assert.match(wakeFailed.reason, /recovery wake failed after adoption/);
  assert.equal(readFileSync(store.fileFor(WAKE_FAILED_DELEGATION), "utf8"), wakeFailedBytes);
  assert.equal(live.has(WAKE_FAILED_CURRENT), false);
  assert.equal(land.ownedChildren().includes(WAKE_FAILED_CURRENT), false);

  await land.dispose();

  // HMR disposal deactivates only this controller generation and deliberately
  // leaves the DSH AgentHandle on the exact live child. A replacement
  // generation can therefore re-adopt and fully rebind without agents.resume.
  const replacementLand = createLand({ ctx, store, agents, env: {} });
  const hmr = await replacementLand.workflowResume({ delegationId: DELEGATION, parentSessionUuid: PARENT });
  assert.equal(hmr.status, "already-live");
  assert.equal(hmr.sessionUuid, CURRENT);
  assert.equal(resumeCalls, 4, "HMR adoption does not perform another DSH resume");
  assert.deepEqual(replacementLand.ownedChildren(), [CURRENT]);
  assert.equal(recovered.definitions.has("run_tests"), true, "replacement controller restores child tools");
  await replacementLand.dispose();

  // Corrupt durable persistence reports the concrete parse error and is not
  // normalized, replaced, stopped, or rewritten by the refusal path.
  const corruptPath = store.fileFor(CORRUPT_DELEGATION);
  const corruptBytes = "{ definitely not a durable record\n";
  writeFileSync(corruptPath, corruptBytes);
  const corruptLand = createLand({ ctx, store, agents, env: {} });
  const corrupt = await corruptLand.workflowResume({ delegationId: CORRUPT_DELEGATION, parentSessionUuid: PARENT });
  assert.equal(corrupt.status, "refused");
  assert.match(corrupt.reason, /persistence is missing or corrupt/);
  assert.equal(readFileSync(corruptPath, "utf8"), corruptBytes);
  await corruptLand.dispose();
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("workflow resume: ok");
