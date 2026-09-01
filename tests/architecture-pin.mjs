#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createArchitect } from "../src/architect.mjs";
import { effectiveApprovalPolicy, pinInteractiveApproval } from "../src/approval-policy.mjs";
import { DEFAULT_Q } from "../src/fold.mjs";
import { apply } from "../src/plugin.mjs";
import { createSelectionStore } from "../src/selection.mjs";
import { WORKFLOW_SETTINGS_SCHEMA } from "../src/settings.mjs";

const SESSION_ID = "session-a0000000-0000-4000-8000-000000000001";
const HOST = Object.freeze({ provider: "xai-auth", model: "grok-4.6", reasoningEffort: "high" });
const ARCHITECTURE = Object.freeze({
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "xhigh",
});
const ALTERNATE = Object.freeze({
  provider: "openai-codex",
  model: "gpt-5.6-alt",
  reasoningEffort: "high",
});

function waterfallContext() {
  const listeners = new Map();

  function on(type, listener, options = {}) {
    const records = listeners.get(type) ?? [];
    const record = { listener };
    if (options.prepend === true) records.unshift(record);
    else records.push(record);
    listeners.set(type, records);
    return () => {
      const index = records.indexOf(record);
      if (index >= 0) records.splice(index, 1);
    };
  }

  async function emit(type, args, terminal) {
    const records = [...(listeners.get(type) ?? [])];
    const dispatch = async (index) => {
      if (index >= records.length) return terminal();
      return records[index].listener(...args, () => dispatch(index + 1));
    };
    return dispatch(0);
  }

  const assemble = () => emit(
    "system-prompt/assemble",
    [{}, {}],
    async () => ({ variables: { cwd: "/work" } }),
  );
  let nextRequestError = null;
  const requestOnly = () => emit(
    "agent/request",
    [{ turn: 1, step: 1 }],
    async () => {
      if (nextRequestError) {
        const error = nextRequestError;
        nextRequestError = null;
        throw error;
      }
      return { provider: "terminal", model: "terminal", reasoningEffort: "terminal" };
    },
  );

  return {
    on,
    get() { return undefined; },
    assemble,
    requestOnly,
    failNextRequest(error) {
      nextRequestError = error;
    },
    async request() {
      const prompt = await assemble();
      const request = await requestOnly();
      return { prompt, request };
    },
    count(type) {
      return listeners.get(type)?.length ?? 0;
    },
  };
}

function hostSelectedAgent(cwd) {
  const agentCtx = waterfallContext();
  // qq-core selectionSetup is registered while creating the Agent. The
  // workflow pin is necessarily installed later from agent/created or HMR.
  agentCtx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const result = await next();
    return {
      ...result,
      variables: {
        ...result.variables,
        provider: HOST.provider,
        model: HOST.model,
      },
    };
  });
  agentCtx.on("agent/request", async (_payload, next) => {
    const result = await next();
    return { ...result, ...HOST };
  });

  const session = {
    id: SESSION_ID,
    events: [
      { type: "sandbox/mode", data: { mode: "workspace-write" } },
      { type: "approval/policy", data: { policy: "never" } },
    ],
    header: { cwd },
    append(type, data) {
      this.events.push({ type, data });
    },
  };
  return {
    id: SESSION_ID,
    status: "running",
    options: { ...HOST },
    session,
    ctx: agentCtx,
  };
}

function writeSettings(path, architecture = ARCHITECTURE) {
  const binding = architecture && {
    provider: architecture.provider,
    model: architecture.model,
    ...(architecture.reasoningEffort ? { effort: architecture.reasoningEffort } : {}),
  };
  writeFileSync(path, `${JSON.stringify({
    schema: WORKFLOW_SETTINGS_SCHEMA,
    roles: { architecture: binding, implementation: null, qa: null },
  }, null, 2)}\n`);
}

function assertRoute(actual, expected) {
  assert.deepEqual(
    {
      provider: actual.provider,
      model: actual.model,
      reasoningEffort: actual.reasoningEffort,
    },
    expected,
  );
}

function assertPrompt(actual, expected) {
  assert.deepEqual(
    { provider: actual.variables.provider, model: actual.variables.model },
    { provider: expected.provider, model: expected.model },
  );
}

const scratch = mkdtempSync(join(tmpdir(), "qq-architecture-pin-"));
try {
  const projectsRoot = join(scratch, "projects");
  const ordinaryRoot = join(projectsRoot, "ordinary");
  mkdirSync(ordinaryRoot, { recursive: true });

  const settingsFile = join(scratch, "workflows-settings.json");
  writeSettings(settingsFile);

  const selectionDir = join(scratch, "selection");
  const selection = createSelectionStore(selectionDir);
  selection.set(SESSION_ID, "architect");

  const agent = hostSelectedAgent(ordinaryRoot);
  const effects = [];
  const provided = new Map();
  const services = {
    agents: { list: () => [agent], get: (id) => id === SESSION_ID ? agent : null },
    sessions: {},
    "qq-core": { projectsRoot },
  };
  const ctx = {
    get(name) { return services[name] ?? provided.get(name); },
    provide(name, value) { provided.set(name, value); },
    on() { return () => {}; },
    effect(factory) {
      effects.push(factory());
      return () => {};
    },
    logger: { info() {}, warn() {} },
  };
  const config = {
    settingsFile,
    selectionDir,
    delegationDir: join(scratch, "delegations"),
    researchDir: join(scratch, "research"),
    caseDir: join(scratch, "cases"),
  };

  apply(ctx, config);

  assert.equal(effectiveApprovalPolicy(agent.session.events), "ask");
  assert.deepEqual(
    agent.session.events.filter((event) => event.type === "sandbox/mode"),
    [{ type: "sandbox/mode", data: { mode: "workspace-write" } }],
    "architect approval pin preserves the sandbox override",
  );
  assert.deepEqual(
    agent.session.events.filter((event) => event.type === "approval/policy"),
    [
      { type: "approval/policy", data: { policy: "never" } },
      { type: "approval/policy", data: { policy: "ask" } },
    ],
    "an already-live architect ending in never is migrated to interactive approval",
  );
  assert.equal(pinInteractiveApproval(agent), false, "interactive approval pin is idempotent");

  const pinned = await agent.ctx.request();
  assertPrompt(pinned.prompt, ARCHITECTURE);
  assertRoute(pinned.request, ARCHITECTURE);
  const assembleMark = agent.session.events.find((event) => event.type === "hook/result");
  assert.equal(assembleMark?.data?.q, DEFAULT_Q, "guard ceiling must use the live architecture route");

  // Keep the route captured during prompt assembly for every request attempt
  // in that step, even if settings change or a stream failure triggers a retry.
  // Only the next prompt assembly may replace the snapshot.
  const capturedPrompt = await agent.ctx.assemble();
  assertPrompt(capturedPrompt, ARCHITECTURE);
  writeSettings(settingsFile, ALTERNATE);
  agent.ctx.failNextRequest(new Error("stream failed"));
  await assert.rejects(agent.ctx.requestOnly(), /stream failed/);
  assertRoute(await agent.ctx.requestOnly(), ARCHITECTURE);
  assertRoute(await agent.ctx.requestOnly(), ARCHITECTURE);

  const alternate = await agent.ctx.request();
  assertPrompt(alternate.prompt, ALTERNATE);
  assertRoute(alternate.request, ALTERNATE);

  // Settings are loaded live. A new assembly with an unbound architecture seat
  // snapshots null and falls through to qq-core for prompt and request routing.
  writeSettings(settingsFile, null);
  const unbound = await agent.ctx.request();
  assertPrompt(unbound.prompt, HOST);
  assertRoute(unbound.request, HOST);

  // HMR removes workflow hooks while preserving qq-core's old listeners. The
  // replacement plugin must prepend its hooks and remain outermost.
  writeSettings(settingsFile);
  assert.equal(effects.length, 1);
  await effects[0]?.();
  assert.equal(agent.ctx.count("system-prompt/assemble"), 1);
  assert.equal(agent.ctx.count("agent/request"), 1);

  apply(ctx, config);
  assert.equal(effects.length, 2);
  const repinned = await agent.ctx.request();
  assert.equal(agent.session.events.filter((event) => event.type === "approval/policy").length, 2, "HMR does not duplicate the migrated approval pin");
  assertPrompt(repinned.prompt, ARCHITECTURE);
  assertRoute(repinned.request, ARCHITECTURE);
  await effects[1]?.();

  // Fold decisions resolve the architecture function on every turn and request
  // refresh instead of retaining create-time Agent.options.
  const foldRoutes = [];
  const foldListeners = [];
  let liveBinding = {
    provider: ARCHITECTURE.provider,
    model: ARCHITECTURE.model,
    effort: ARCHITECTURE.reasoningEffort,
  };
  const directArchitect = createArchitect({
    ctx: { get: () => null },
    cases: { open() {}, ensure() {} },
    architecture: () => liveBinding,
    folder: {
      decide(_sessionId, { route }) {
        foldRoutes.push(route);
        return { action: "keep" };
      },
    },
    env: {},
  });
  const foldSession = {
    id: "session-d0000000-0000-4000-8000-000000000004",
    header: { cwd: ordinaryRoot },
    events: [],
    append(type, data) { this.events.push({ type, data }); },
  };
  const foldAgent = {
    status: "running",
    options: { ...HOST },
    session: foldSession,
    ctx: {
      on(type, listener) {
        const record = { type, listener };
        foldListeners.push(record);
        return () => {
          const index = foldListeners.indexOf(record);
          if (index >= 0) foldListeners.splice(index, 1);
        };
      },
    },
  };
  directArchitect.attach(foldAgent);
  const turnEnd = { type: "turn/end", data: { turn: 1, reason: "complete" } };
  for (const { listener } of foldListeners.filter(({ type }) => type === "session/event")) {
    await listener(foldSession, turnEnd);
  }
  assertRoute(foldRoutes.at(-1), ARCHITECTURE);

  liveBinding = {
    provider: ALTERNATE.provider,
    model: ALTERNATE.model,
    effort: ALTERNATE.reasoningEffort,
  };
  for (const { listener } of foldListeners.filter(({ type }) => type === "session/event")) {
    await listener(foldSession, turnEnd);
  }
  assertRoute(foldRoutes.at(-1), ALTERNATE);

  const foldRequest = foldListeners.find(({ type }) => type === "agent/request")?.listener;
  assert.equal(typeof foldRequest, "function");
  const decisionsBeforeRequest = foldRoutes.length;
  const requestResult = await foldRequest({ turn: 2, step: 1 }, async () => "assembled");
  assert.equal(requestResult, "assembled");
  assert.equal(foldRoutes.length, decisionsBeforeRequest + 1, "request assembly refreshes the pending fold decision");
  assertRoute(foldRoutes.at(-1), ALTERNATE);
  directArchitect.detach(foldAgent);

  // The architect's direct ctx.agents.create path bypasses native subagent
  // composition, so it must stamp the child before Land adoption or followup.
  const delegationParentId = "session-e0000000-0000-4000-8000-000000000005";
  const delegationEvents = [];
  let delegatedChild = null;
  const relay = { hang() {}, clear() {}, alias() { return undefined; } };
  const delegationArchitect = createArchitect({
    ctx: { get(name) { return name === "qq-relay" ? relay : null; } },
    cases: {
      open() {},
      ensure() {},
      load() { return { text: "# Approved plan\n\nImplement the change.\n" }; },
      consume() {},
    },
    folder: { decide: () => ({ action: "keep" }) },
    agents: {
      async create(options) {
        const session = {
          id: options.sessionId,
          header: { ...options.meta },
          events: [{ type: "sandbox/mode", data: { mode: "workspace-write" } }],
          append(type, data) { this.events.push({ type, data }); },
        };
        delegatedChild = {
          status: "running",
          session,
          ctx: { on() { return () => {}; } },
          followup(message) { this.message = message; },
        };
        return { agent: delegatedChild, async dispose() {} };
      },
    },
    run: async () => ({ code: 1, stdout: "", stderr: "not a git worktree" }),
    onInvokeImplementation(child, info) {
      delegationEvents.push(...child.session.events);
      assert.equal(info.brief, "# Approved plan\n\nImplement the change.\n");
      assert.equal(Object.hasOwn(info, "packet"), false, "adoption receives semantic task, not a routing envelope");
      assert.equal(effectiveApprovalPolicy(child.session.events), "never", "child is pinned before workflow adoption");
      return { status: "ok", owned: true, delegationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "implementation", phaseEpoch: 1 };
    },
    env: {},
  });
  const delegationParent = {
    status: "running",
    options: { ...HOST },
    session: {
      id: delegationParentId,
      header: { cwd: ordinaryRoot },
      events: [],
      append(type, data) { this.events.push({ type, data }); },
    },
    ctx: { on() { return () => {}; } },
  };
  delegationArchitect.attach(delegationParent);
  const delegated = await delegationArchitect.delegate({ agent: delegationParent, kind: "implementation" });
  assert.equal(delegated.status, "ok", delegated.reason);
  assert.ok(delegatedChild?.message, "delegated child receives its work packet");
  const delegatedText = delegatedChild.message.content[0].text;
  assert.equal(delegatedText.split("# Approved plan").length - 1, 1);
  assert.doesNotMatch(delegatedText, /Delegation ID \(authoritative\)|Authoritative parent session UUID|Workflow phase|auto-return/i);
  assert.deepEqual(
    delegationEvents.filter((event) => event.type === "approval/policy"),
    [{ type: "approval/policy", data: { policy: "never", source: "delegation" } }],
  );
  assert.deepEqual(
    delegationEvents.filter((event) => event.type === "sandbox/mode"),
    [{ type: "sandbox/mode", data: { mode: "workspace-write" } }],
    "child approval pin preserves its sandbox policy",
  );
  await delegationArchitect.dispose();

  console.log("architecture pin: ok");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
