#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createArchitect } from "../src/architect.mjs";
import { DEFAULT_Q } from "../src/fold.mjs";
import { apply } from "../src/plugin.mjs";
import {
  ARCHITECT_SETTINGS_SCHEMA,
  BASE_SETTINGS_SCHEMA,
} from "../src/settings.mjs";
import { createSelectionStore } from "../src/selection.mjs";

const ARCHITECT_ID = "session-a0000000-0000-4000-8000-000000000001";
const BASE_ID = "session-b0000000-0000-4000-8000-000000000002";
const PROJECTS_ID = "session-c0000000-0000-4000-8000-000000000003";
const HOST = Object.freeze({ provider: "xai-auth", model: "grok-4.6", reasoningEffort: "high" });
const ARCHITECT = Object.freeze({ provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
const BASE = Object.freeze({ provider: "openai-codex", model: "gpt-5.6-base", reasoningEffort: "high" });

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

  return {
    listeners,
    on,
    get() { return undefined; },
    async request() {
      // DSH assembles the claimed prompt first; child-model.mjs snapshots that
      // event and applies its route when agent/request subsequently unwinds.
      const prompt = await emit(
        "system-prompt/assemble",
        [{}, {}],
        async () => ({ variables: { cwd: "/work" } }),
      );
      const request = await emit(
        "agent/request",
        [{ turn: 1, step: 1 }],
        async () => ({ provider: "terminal", model: "terminal", reasoningEffort: "terminal" }),
      );
      return { prompt, request };
    },
    count(type) {
      return listeners.get(type)?.length ?? 0;
    },
  };
}

function hostSelectedAgent(id, cwd) {
  const agentCtx = waterfallContext();
  // qq-core selectionSetup is installed during agents.create, before
  // qq-workflows observes agent/created or adopts the live agent after HMR.
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
    id,
    events: [],
    header: { cwd },
    append(type, data) {
      this.events.push({ type, data });
    },
  };
  return {
    id,
    status: "running",
    options: { ...HOST },
    session,
    ctx: agentCtx,
  };
}

function writeSettings(path, { architect = ARCHITECT, base = BASE } = {}) {
  const binding = (route) => route && ({
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort ? { effort: route.reasoningEffort } : {}),
  });
  writeFileSync(path, `${JSON.stringify({
    schema: ARCHITECT_SETTINGS_SCHEMA,
    roles: { talking: binding(architect), hands: null },
    base: {
      schema: BASE_SETTINGS_SCHEMA,
      roles: { talking: binding(base) },
    },
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

const scratch = mkdtempSync(join(tmpdir(), "qq-talking-pin-"));
try {
  const projectsRoot = join(scratch, "projects");
  const ordinaryRoot = join(projectsRoot, "ordinary");
  mkdirSync(ordinaryRoot, { recursive: true });

  const settingsFile = join(scratch, "workflows-settings.json");
  writeSettings(settingsFile);

  const selectionDir = join(scratch, "selection");
  const selection = createSelectionStore(selectionDir);
  selection.set(ARCHITECT_ID, "architect");
  selection.set(BASE_ID, "base");
  // Projects is implicit; this stale selectable workflow must not affect its route.
  selection.set(PROJECTS_ID, "architect");

  const architect = hostSelectedAgent(ARCHITECT_ID, ordinaryRoot);
  const base = hostSelectedAgent(BASE_ID, ordinaryRoot);
  const projects = hostSelectedAgent(PROJECTS_ID, realpathSync(projectsRoot));
  const agents = [architect, base, projects];
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const effects = [];
  const provided = new Map();
  const services = {
    agents: { list: () => agents, get: (id) => byId.get(id) },
    sessions: {},
    "qq-core": { projectsRoot: realpathSync(projectsRoot) },
  };
  const ctx = {
    get(name) { return services[name] ?? provided.get(name); },
    provide(name, value) { provided.set(name, value); },
    on() { return () => {}; },
    effect(factory) {
      const off = factory();
      effects.push(off);
      return () => {};
    },
    logger: { info() {}, warn() {} },
  };
  const config = {
    settingsFile,
    selectionDir,
    journalDir: join(scratch, "journals"),
    wikiDir: join(scratch, "wiki"),
    landDir: join(scratch, "land"),
    researchDir: join(scratch, "research"),
    caseDir: join(scratch, "cases"),
  };

  apply(ctx, config);

  const architectCall = await architect.ctx.request();
  assertPrompt(architectCall.prompt, ARCHITECT);
  assertRoute(architectCall.request, ARCHITECT);
  const assembleMark = architect.session.events.find((event) => event.type === "hook/result");
  assert.equal(assembleMark?.data?.q, DEFAULT_Q, "guard ceiling must use live talking, not create-time Grok options");

  const baseCall = await base.ctx.request();
  assertPrompt(baseCall.prompt, BASE);
  assertRoute(baseCall.request, BASE);

  const projectsCall = await projects.ctx.request();
  assertPrompt(projectsCall.prompt, BASE);
  assertRoute(projectsCall.request, BASE);

  // Settings are live. If neither selected nor base talking has a binding,
  // both hooks must fall through to the host selection rather than retaining a
  // previous request's assembled snapshot.
  writeSettings(settingsFile, { architect: null, base: null });
  const unboundCall = await architect.ctx.request();
  assertPrompt(unboundCall.prompt, HOST);
  assertRoute(unboundCall.request, HOST);

  // HMR removes both hooks, then adopts the same live agents. Re-pinning must
  // remain outermost even though selectionSetup is still the oldest listener.
  writeSettings(settingsFile);
  assert.equal(effects.length, 1);
  await effects[0]?.();
  for (const agent of agents) {
    assert.equal(agent.ctx.count("system-prompt/assemble"), 1);
    assert.equal(agent.ctx.count("agent/request"), 1);
  }

  apply(ctx, config);
  assert.equal(effects.length, 2);
  const repinnedCall = await architect.ctx.request();
  assertPrompt(repinnedCall.prompt, ARCHITECT);
  assertRoute(repinnedCall.request, ARCHITECT);

  await effects[1]?.();

  // The post-turn fold decision reads the same live route on every call.
  const foldRoutes = [];
  const foldListeners = [];
  let liveRoute = ARCHITECT;
  const directArchitect = createArchitect({
    ctx: { get: () => null },
    cases: { open() {}, ensure() {} },
    talking: () => liveRoute,
    folder: {
      decide(_sessionId, { route }) {
        foldRoutes.push(route);
        return { action: "keep" };
      },
    },
  });
  const foldSession = {
    id: "session-d0000000-0000-4000-8000-000000000004",
    header: { cwd: ordinaryRoot },
    events: [],
  };
  const foldAgent = {
    status: "running",
    options: { ...HOST },
    session: foldSession,
    ctx: {
      on(type, listener) {
        const record = { type, listener };
        foldListeners.push(record);
        return () => foldListeners.splice(foldListeners.indexOf(record), 1);
      },
    },
  };
  directArchitect.attach(foldAgent);
  const end = { type: "turn/end", data: { turn: 1, reason: "complete" } };
  for (const record of foldListeners.filter(({ type }) => type === "session/event")) {
    await record.listener(foldSession, end);
  }
  assertRoute(foldRoutes.at(-1), ARCHITECT);
  liveRoute = BASE;
  for (const record of foldListeners.filter(({ type }) => type === "session/event")) {
    await record.listener(foldSession, end);
  }
  assertRoute(foldRoutes.at(-1), BASE);
  directArchitect.detach(foldAgent);

  console.log("talking pin: ok");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
