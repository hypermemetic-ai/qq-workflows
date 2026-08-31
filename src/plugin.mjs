import { randomUUID } from "node:crypto";
// qq-workflows: one repository, one plugin. Cordis entry point.
//
// The wrapper lists registered workflows and selects which one this chair
// is running, if any. Architect, find, and base are selectable. Land is git
// machinery: mini-code completion and the architect/base land tool.
// The reserved Projects chair implicitly receives its own non-selectable workflow.
// Architect owns working memory, two-pair fold, delegate/research, and role settings.
// Session context and awaitable leave/transition live on service.workflows;
// /workflows select and clear stay the command path.

import { createCaseStore, defaultCaseDir, isWorkingMemoryEmpty, titleOf } from "./casefile.mjs";
import { DEFAULT_H, createFolder } from "./fold.mjs";
import { buildArchitectTools } from "./tools.mjs";
import { createArchitect, isArchitectCandidate } from "./architect.mjs";
import { ensureMiniMounted, isMiniAgent, MINI_SWE_MIGRATION } from "./official-mini.mjs";
import { ensureMiniQaMounted, isMiniQaAgent } from "./mini-qa.mjs";
import { ensureMiniDocsMounted, isMiniDocsAgent } from "./mini-docs.mjs";
import { allowInherited, ARCHITECT_INHERITED_TOOLS } from "./hide-harness.mjs";
import { runCommand } from "./git.mjs";
import { capObservationTool } from "./observation.mjs";
import { wrapArchitectBash } from "./architect-bash.mjs";
import { createLand } from "./land.mjs";
import { createDelegationStore, defaultDelegationDir } from "./delegation-store.mjs";
import { createResearch } from "./research.mjs";
import { createResearchStore } from "./research-store.mjs";
import { defaultResearchDir } from "./research-evidence.mjs";
import { createSelectionStore, defaultSelectionDir } from "./selection.mjs";
import { createPhaseStore, defaultPhaseDir } from "./phase-store.mjs";
import { buildLandTool } from "./land-tools.mjs";
import {
  HOST_ROLES,
  createHostSettings,
  formatSettingsList,
} from "./settings.mjs";
import { completeComposerLine, formatWorkflowList, parseWorkflowsInput } from "./command.mjs";
import { DEFAULT_ACCEPTED_CONTEXTS, normalizeAcceptedContexts } from "./context.mjs";
import { createWorkflowSessionApi } from "./transition.mjs";
import { createProjectsWorkflow, PROJECTS_LABEL } from "./projects.mjs";
import { installBenchmarkHostLauncher } from "./grok-benchmark-host.mjs";

export {
  DEFAULT_ACCEPTED_CONTEXTS,
  LEAVE_REASONS,
  SESSION_CONTEXTS,
} from "./context.mjs";

export const name = "qq-workflows";
// Same load gate as qq-relay. Commands and tools stay optional.
export const inject = ["agents", "sessions"];
export const provide = "qq-workflows";
export const FIND_LABEL = "workflows:find";
export { PROJECTS_LABEL };

const WORKFLOW_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const EXTERNAL_WORKFLOW_RESERVED = new Set([
  "none",
  "off",
  "settings",
  "architect",
  "find",
  "base",
  "projects",
]);
const DELEGATION_KIND = /^[a-z][a-z0-9-]{0,31}$/;
const DELEGATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const REGISTERED_WORKFLOW_METHODS = [
  "candidate",
  "ensureAttached",
  "ensureDetached",
  "listSettings",
  "writeSettings",
];

function registeredWorkflowSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("invalid workflow spec");
  }
  const workflow = {
    name: spec.name,
    candidate: spec.candidate,
    ensureAttached: spec.ensureAttached,
    ensureDetached: spec.ensureDetached,
    listSettings: spec.listSettings,
    writeSettings: spec.writeSettings,
    acceptedContexts: normalizeAcceptedContexts(spec.acceptedContexts),
  };
  if (typeof workflow.name !== "string" || !WORKFLOW_NAME.test(workflow.name)) {
    throw new Error(`invalid workflow name: ${String(workflow.name ?? "")}`);
  }
  if (EXTERNAL_WORKFLOW_RESERVED.has(workflow.name)) {
    throw new Error(`workflow name is reserved: ${workflow.name}`);
  }
  for (const method of REGISTERED_WORKFLOW_METHODS) {
    if (typeof workflow[method] !== "function") {
      throw new Error(`workflow ${workflow.name} must define ${method}()`);
    }
  }
  return Object.freeze(workflow);
}

const REGISTERED_DELEGATION_METHODS = ["invoke", "status", "send", "stop"];

function registeredDelegationSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec) || !DELEGATION_KIND.test(spec.kind ?? "")) {
    throw new Error("invalid delegation kind spec");
  }
  if (spec.kind === "implementation" || spec.kind === "research") {
    throw new Error(`delegation kind is reserved: ${spec.kind}`);
  }
  for (const method of REGISTERED_DELEGATION_METHODS) {
    if (typeof spec[method] !== "function") throw new Error(`delegation kind ${spec.kind} must define ${method}()`);
  }
  return Object.freeze({
    kind: spec.kind,
    invoke: spec.invoke,
    status: spec.status,
    send: spec.send,
    stop: spec.stop,
    owns: typeof spec.owns === "function" ? spec.owns : null,
    resume: typeof spec.resume === "function" ? spec.resume : null,
    resumeChild: typeof spec.resumeChild === "function" ? spec.resumeChild : null,
    releaseChild: typeof spec.releaseChild === "function" ? spec.releaseChild : null,
    activeProjection: typeof spec.activeProjection === "function" ? spec.activeProjection : null,
    listSettings: typeof spec.listSettings === "function" ? spec.listSettings : null,
    writeSettings: typeof spec.writeSettings === "function" ? spec.writeSettings : null,
  });
}

function sessionIdOf(agent) {
  return agent?.session?.id ?? agent?.id ?? "";
}

function toolsService(holder) {
  return holder?.tools
    ?? holder?.get?.("tools", false)
    ?? holder?.ctx?.tools
    ?? holder?.ctx?.get?.("tools", false)
    ?? null;
}

/**
 * DSH binds Agent create/resume lifecycle to the accessing fiber. Create
 * through the host root so qq-workflows owns teardown order: durable state and
 * relay reports settle before the retained AgentHandle unregisters the child.
 */
function hostAgents(ctx) {
  const host = ctx?.root && typeof ctx.root.get === "function" ? ctx.root : ctx;
  const agents = typeof host.get === "function" ? host.get("agents") : undefined;
  if (agents) return agents;
  return typeof ctx?.get === "function" ? ctx.get("agents") : undefined;
}

function syncLiveDelegationChild(land, agent) {
  if (isMiniAgent(agent)) ensureMiniMounted(agent);
  if (isMiniQaAgent(agent)) ensureMiniQaMounted(agent);
  if (isMiniDocsAgent(agent)) ensureMiniDocsMounted(agent);
  return land?.resumeChild?.(agent) ?? false;
}


export function compactActivityProjection(record) {
  return Object.freeze({
    id: String(record?.id ?? ""),
    parentSessionUuid: String(record?.parentSessionUuid ?? ""),
    status: String(record?.status ?? ""),
  });
}

export function apply(ctx, config = {}) {
  installBenchmarkHostLauncher(ctx);
  const agents = hostAgents(ctx);
  const phaseStore = createPhaseStore(defaultPhaseDir(process.env, config), { now: config.now ?? Date.now });
  const implementationRecords = new Map();
  const researchRecords = new Map();
  const delegationKinds = new Map();
  const externalDelegationOwners = new Map();
  let projectsWorkflow = null;

  const activeImplementation = new Set(["running", "reviewing", "revising", "landing"]);
  const activeResearch = new Set(["researching", "reviewing"]);

  function activeBuiltIn(parentSessionUuid) {
    for (const record of implementationRecords.values()) {
      if (record.parentSessionUuid === parentSessionUuid && activeImplementation.has(record.status)) return true;
    }
    for (const record of researchRecords.values()) {
      if (record.parentSessionUuid === parentSessionUuid && activeResearch.has(record.status)) return true;
    }
    return false;
  }

  function adoptedActiveProjection(parentSessionUuid) {
    let inactiveStartedAt = null;
    for (const spec of delegationKinds.values()) {
      if (typeof spec.activeProjection !== "function") continue;
      try {
        const projection = spec.activeProjection({ parentSessionUuid });
        // The dashboard read is synchronous. Async or ambiguous adopted state
        // is deliberately ignored rather than guessed.
        if (projection && typeof projection.then === "function") continue;
        if (projection === true) return { active: true, phaseStartedAt: null };
        if (!projection || typeof projection !== "object") continue;
        const timestamp = projection.phaseStartedAt;
        const phaseStartedAt = Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
        if (projection.active === true) return { active: true, phaseStartedAt };
        if (projection.active === false && phaseStartedAt != null) {
          inactiveStartedAt = inactiveStartedAt == null
            ? phaseStartedAt
            : Math.max(inactiveStartedAt, phaseStartedAt);
        }
      } catch {
        // One adopted kind cannot hide authoritative built-in state.
      }
    }
    return { active: false, phaseStartedAt: inactiveStartedAt };
  }

  function effectiveWorkflow(sessionUuid, agent = agents?.get?.(sessionUuid) ?? null) {
    if (agent && projectsWorkflow?.candidate(agent)) return "projects";
    return selection.get(sessionUuid);
  }

  function semanticProjection(sessionUuid, agent) {
    const workflow = effectiveWorkflow(sessionUuid, agent);
    if (!workflow) return { workflow: null, phase: "none", phaseStartedAt: null };
    if (workflow !== "architect") return { workflow, phase: "unknown", phaseStartedAt: null };
    const adopted = adoptedActiveProjection(sessionUuid);
    if (activeBuiltIn(sessionUuid)) return { workflow, phase: "work", phaseStartedAt: null };
    if (adopted.active) return { workflow, phase: "work", phaseStartedAt: adopted.phaseStartedAt };
    const memory = cases.load(sessionUuid).text;
    return {
      workflow,
      phase: isWorkingMemoryEmpty(memory) ? "planning" : "plan",
      phaseStartedAt: adopted.phaseStartedAt,
    };
  }

  function reconcileSemanticPhase(sessionUuid) {
    if (!sessionUuid) return null;
    const projection = semanticProjection(sessionUuid);
    return phaseStore.transition(sessionUuid, projection.phase, {
      ...(projection.phaseStartedAt == null ? {} : { phaseStartedAt: projection.phaseStartedAt }),
    });
  }

  function safeReconcileSemanticPhase(sessionUuid) {
    try {
      return reconcileSemanticPhase(sessionUuid);
    } catch (error) {
      ctx.logger?.warn?.(
        `qq-workflows: phase projection update failed for ${sessionUuid}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  const cases = createCaseStore(defaultCaseDir(process.env, config), {
    onChange: ({ sessionUuid }) => safeReconcileSemanticPhase(sessionUuid),
  });
  const selection = createSelectionStore(defaultSelectionDir(process.env, config), {
    onChange: ({ sessionUuid }) => safeReconcileSemanticPhase(sessionUuid),
  });
  const hostSettings = createHostSettings({ settingsFile: config.settingsFile });
  const delegationStore = createDelegationStore(defaultDelegationDir(process.env, config), {
    onChange: (record) => {
      implementationRecords.set(record.id, compactActivityProjection(record));
      safeReconcileSemanticPhase(record.parentSessionUuid);
    },
  });
  for (const record of delegationStore.list()) implementationRecords.set(record.id, compactActivityProjection(record));
  const researchDir = defaultResearchDir(process.env, config);
  const researchStore = createResearchStore(researchDir, {
    onChange: (record) => {
      researchRecords.set(record.id, compactActivityProjection(record));
      safeReconcileSemanticPhase(record.parentSessionUuid);
    },
  });
  for (const record of researchStore.list()) researchRecords.set(record.id, compactActivityProjection(record));
  const tokenMeter = ctx.get("tokenMeter", false);
  const folder = createFolder({
    tokenMeter,
    h: config.h ?? DEFAULT_H,
    q: config.q,
    now: config.now,
  });
  const land = createLand({
    ctx,
    store: delegationStore,
    settings: hostSettings,
    agents,
    tasks: null,
    run: config.runCommand,
    github: config.github,
    testCommand: config.testCommand,
  });
  const research = createResearch({
    ctx,
    store: researchStore,
    agents,
    parentDir: researchDir,
    sessionQuery: config.sessionQuery ?? (() => ctx.get?.("sessionQuery", false)),
    implementation: () => hostSettings.get("implementation"),
    architecture: () => hostSettings.get("architecture"),
    qa: () => hostSettings.get("qa"),
    env: config.env ?? process.env,
    webProvider: config.webProvider,
    fetch: config.fetch,
  });
  const architect = createArchitect({
    ctx,
    cases,
    folder,
    agents,
    tasks: null,
    architecture: () => hostSettings.get("architecture"),
    implementation: () => hostSettings.get("implementation"),
    run: config.runCommand ?? runCommand,
    onInvokeImplementation: (child, info) => land.adoptImplementation(child, info),
    onResearch: (args) => research.invoke(args),
    onDelegateKind: async (args) => {
      const spec = delegationKinds.get(args.kind);
      if (!spec) return { status: "refused", reason: `unknown delegation kind: ${args.kind}` };
      const result = await spec.invoke(args);
      if (result?.status === "ok") {
        externalDelegationOwners.set(args.delegationId, spec);
        safeReconcileSemanticPhase(args.parentSessionUuid);
        return { ...result, delegationId: args.delegationId };
      }
      return result;
    },
  });

  projectsWorkflow = createProjectsWorkflow({ ctx });
  const workflows = new Map();
  const toolDisposers = new Map();

  function capVisibleArchitectTools(tools, agent) {
    if (typeof tools?.schemas !== "function" || typeof tools?.get !== "function") return [];
    let schemas;
    try { schemas = tools.schemas(agent); } catch { return []; }
    if (!Array.isArray(schemas)) return [];
    const disposers = [];
    for (const schema of schemas) {
      try {
        const definition = tools.get(schema?.name, agent);
        const visible = schema?.name === "bash" ? wrapArchitectBash(definition) : definition;
        const capped = capObservationTool(visible);
        if (!capped || capped === definition) continue;
        const dispose = tools.register(capped);
        if (typeof dispose === "function") disposers.push(dispose);
      } catch {
        // A same-layer definition cannot be shadowed; the capture listener still caps it.
      }
    }
    return disposers;
  }

  function registerAgentTools(agent) {
    const sessionId = sessionIdOf(agent);
    const install = (toolCtx) => {
      if (toolDisposers.has(sessionId)) return;
      const selected = selectedName(sessionId);
      if (selected !== "architect" && selected !== "base") return;
      const tools = toolsService(toolCtx) ?? toolsService(agent);
      if (!tools || typeof tools.register !== "function") return;
      if (selected === "architect") allowInherited(ctx, agent, ARCHITECT_INHERITED_TOOLS);
      const tasks = null;
      const invokeLand = (args) => land.invoke(args);
      const inheritedCaps = selected === "architect" ? capVisibleArchitectTools(tools, agent) : [];
      const definitions = selected === "architect"
        ? buildArchitectTools({
            cases,
            delegate: (args) => architect.delegate(args),
            workflowStatus,
            workflowSend,
            workflowResume,
            workflowStop,
            tasks,
            land: invokeLand,
          }).map(capObservationTool)
        : [buildLandTool({ invoke: invokeLand })];
      const disposers = [...inheritedCaps];
      try {
        for (const tool of definitions) disposers.push(tools.register(tool));
      } catch (error) {
        for (const dispose of [...disposers].reverse()) dispose();
        throw error;
      }
      toolDisposers.set(sessionId, {
        owner: selected,
        dispose() {
          for (const dispose of [...disposers].reverse()) dispose();
          toolDisposers.delete(sessionId);
        },
      });
    };
    if (typeof agent?.ctx?.inject === "function") agent.ctx.inject(["tools"], install);
    else install(agent?.ctx);
  }

  function disposeAgentTools(agentOrId, owner) {
    const sessionId = typeof agentOrId === "string" ? agentOrId : sessionIdOf(agentOrId);
    const record = toolDisposers.get(sessionId);
    if (!record || (owner && record.owner !== owner)) return;
    record.dispose();
  }

  const selectableCandidate = (agent) => (
    isArchitectCandidate(agent) && !projectsWorkflow.candidate(agent)
  );

  const architectWorkflow = Object.freeze({
    name: "architect",
    candidate: selectableCandidate,
    acceptedContexts: DEFAULT_ACCEPTED_CONTEXTS,
    settings: hostSettings,
    ensureAttached(agent) {
      if (!selectableCandidate(agent)) return null;
      const handle = architect.attach(agent);
      registerAgentTools(agent);
      return handle;
    },
    ensureDetached(agentOrId) {
      disposeAgentTools(agentOrId, "architect");
      return architect.detach(agentOrId);
    },
    listSettings() {
      return formatSettingsList("host", hostSettings.list());
    },
    writeSettings(role, binding) {
      hostSettings.write(role, binding);
      return formatSettingsList("host", hostSettings.list());
    },
  });
  workflows.set("architect", architectWorkflow);

  function selectedName(sessionId) {
    return selection.get(sessionId);
  }

  function finderOf() {
    return ctx.get?.("image-finder", false) ?? null;
  }

  function hangFind(sessionId) {
    const relay = ctx.get?.("qq-relay", false) ?? null;
    if (!relay || typeof relay.hang !== "function") return false;
    try {
      relay.hang(sessionId, FIND_LABEL);
      return true;
    } catch (error) {
      ctx.logger?.warn?.(
        `qq-workflows: failed to hang ${FIND_LABEL} on ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  function clearFind(sessionId) {
    const relay = ctx.get?.("qq-relay", false) ?? null;
    if (!relay || typeof relay.clear !== "function") return false;
    try {
      return Boolean(relay.clear(sessionId, FIND_LABEL));
    } catch {
      return false;
    }
  }

  const findAttached = new Set();
  const findWorkflow = Object.freeze({
    name: "find",
    candidate: selectableCandidate,
    acceptedContexts: DEFAULT_ACCEPTED_CONTEXTS,
    ensureAttached(agent) {
      if (!selectableCandidate(agent)) return null;
      const sessionId = sessionIdOf(agent);
      if (!sessionId) return null;
      if (!findAttached.has(sessionId)) {
        hangFind(sessionId);
        findAttached.add(sessionId);
      }
      finderOf()?.arm?.(sessionId);
      return sessionId;
    },
    ensureDetached(agentOrId) {
      const sessionId = typeof agentOrId === "string" ? agentOrId : sessionIdOf(agentOrId);
      if (!sessionId || !findAttached.has(sessionId)) return null;
      findAttached.delete(sessionId);
      clearFind(sessionId);
      finderOf()?.leave?.(sessionId);
      return sessionId;
    },
    listSettings() {
      return "find has no roles";
    },
    writeSettings() {
      throw new Error("find has no roles");
    },
  });
  workflows.set("find", findWorkflow);

  const baseWorkflow = Object.freeze({
    name: "base",
    candidate: selectableCandidate,
    acceptedContexts: DEFAULT_ACCEPTED_CONTEXTS,
    settings: hostSettings,
    ensureAttached(agent) {
      if (!selectableCandidate(agent)) return null;
      registerAgentTools(agent);
      return sessionIdOf(agent);
    },
    ensureDetached(agentOrId) {
      disposeAgentTools(agentOrId, "base");
      return null;
    },
    listSettings() {
      return formatSettingsList("host", hostSettings.list());
    },
    writeSettings(role, binding) {
      hostSettings.write(role, binding);
      return formatSettingsList("host", hostSettings.list());
    },
  });
  workflows.set("base", baseWorkflow);

  function liveAgent(sessionId) {
    if (!sessionId || typeof agents?.get !== "function") return null;
    return agents.get(sessionId) ?? null;
  }

  function userFacingNames() {
    return [...workflows.keys()];
  }

  const sessionApi = createWorkflowSessionApi({
    getWorkflow: (name) => workflows.get(name) ?? null,
    selectedName,
    persistSelection: (sessionId, name) => selection.set(sessionId, name),
    liveAgent,
    names: userFacingNames,
  });

  function syncSession(agent) {
    if (!agent) return;
    if (projectsWorkflow.candidate(agent)) {
      for (const workflow of workflows.values()) workflow.ensureDetached(agent);
      projectsWorkflow.ensureAttached(agent);
      safeReconcileSemanticPhase(sessionIdOf(agent));
      return;
    }
    projectsWorkflow.ensureDetached(agent);
    const sessionId = sessionIdOf(agent);
    const chosen = selectedName(sessionId);
    for (const [name, workflow] of workflows) {
      if (name === chosen && workflow.candidate(agent) === true) workflow.ensureAttached(agent);
      else workflow.ensureDetached(agent);
    }
    safeReconcileSemanticPhase(sessionId);
  }

  function delegationKindNames() {
    return ["implementation", "research", ...delegationKinds.keys()];
  }

  function controllerForDelegation(delegationId) {
    if (land.byDelegation?.(delegationId)) return land;
    if (research.byDelegation?.(delegationId)) return research;
    const owned = externalDelegationOwners.get(delegationId);
    if (owned) return owned;
    for (const spec of delegationKinds.values()) {
      try {
        if (spec.owns?.(delegationId)) return spec;
      } catch { /* one adopted kind must not hide another */ }
    }
    return null;
  }

  function workflowStatus(args = {}) {
    const controller = controllerForDelegation(args.delegationId);
    if (!controller) return { status: "refused", reason: "delegation was not found" };
    return controller === land || controller === research
      ? controller.workflowStatus(args)
      : controller.status(args);
  }

  function workflowSend(args = {}) {
    const controller = controllerForDelegation(args.delegationId);
    if (!controller) return { status: "refused", reason: "delegation was not found" };
    return controller === land || controller === research
      ? controller.workflowSend(args)
      : controller.send(args);
  }

  function workflowResume(args = {}) {
    const controller = controllerForDelegation(args.delegationId);
    if (!controller) return { status: "refused", reason: "delegation was not found" };
    const resume = controller === land ? controller.workflowResume : controller.resume;
    if (typeof resume !== "function") {
      return { status: "refused", reason: "delegation kind does not support workflow_resume" };
    }
    return resume.call(controller, args);
  }

  function workflowStop(args = {}) {
    const controller = controllerForDelegation(args.delegationId);
    if (!controller) return { status: "refused", reason: "delegation was not found" };
    const result = controller === land || controller === research
      ? controller.workflowStop(args)
      : controller.stop(args);
    if (result && typeof result.then === "function") {
      return result.then((settled) => {
        if (settled?.status === "ok") safeReconcileSemanticPhase(args.parentSessionUuid);
        return settled;
      });
    }
    if (result?.status === "ok") safeReconcileSemanticPhase(args.parentSessionUuid);
    return result;
  }

  async function invokeDelegation(args = {}) {
    if (args.agent) return architect.delegate(args);
    const spec = delegationKinds.get(args.kind);
    if (!spec) return { status: "refused", reason: `delegation kind ${String(args.kind ?? "")} requires an architect chair` };
    const delegationId = String(args.delegationId || randomUUID()).toLowerCase();
    if (!DELEGATION_ID.test(delegationId)) return { status: "refused", reason: "delegation requires an authoritative UUID" };
    const result = await spec.invoke({ ...args, delegationId });
    if (result?.status === "ok") {
      externalDelegationOwners.set(delegationId, spec);
      safeReconcileSemanticPhase(args.parentSessionUuid);
      return { ...result, delegationId };
    }
    return result;
  }

  function registerDelegationKind(input) {
    const spec = registeredDelegationSpec(input);
    if (delegationKinds.has(spec.kind)) throw new Error(`delegation kind already registered: ${spec.kind}`);
    delegationKinds.set(spec.kind, spec);
    if (typeof agents?.list === "function") {
      for (const agent of agents.list()) {
        if (spec.resumeChild) spec.resumeChild(agent);
        if (isArchitectCandidate(agent)) safeReconcileSemanticPhase(sessionIdOf(agent));
      }
    }
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (delegationKinds.get(spec.kind) === spec) delegationKinds.delete(spec.kind);
      for (const [id, owner] of externalDelegationOwners) {
        if (owner === spec) externalDelegationOwners.delete(id);
      }
      if (typeof agents?.list === "function") {
        for (const agent of agents.list()) {
          if (isArchitectCandidate(agent)) safeReconcileSemanticPhase(sessionIdOf(agent));
        }
      }
    };
  }

  function registerChairWorkflow(spec) {
    const workflow = registeredWorkflowSpec(spec);
    if (workflows.has(workflow.name)) {
      throw new Error(`workflow already registered: ${workflow.name}`);
    }
    workflows.set(workflow.name, workflow);

    if (typeof agents?.list === "function") {
      for (const agent of agents.list()) {
        if (selectedName(sessionIdOf(agent)) !== workflow.name) continue;
        syncSession(agent);
      }
    }

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      try {
        if (typeof agents?.list === "function") {
          for (const agent of agents.list()) {
            if (selectedName(sessionIdOf(agent)) !== workflow.name) continue;
            workflow.ensureDetached(agent);
          }
        }
      } finally {
        if (workflows.get(workflow.name) === workflow) workflows.delete(workflow.name);
      }
    };
  }

  function registerWorkflow(spec) {
    return spec?.kind ? registerDelegationKind(spec) : registerChairWorkflow(spec);
  }

  function selectWorkflow(sessionId, name) {
    const agent = liveAgent(sessionId);
    if (projectsWorkflow.candidate(agent)) {
      throw new Error("this session is not a workflow picker");
    }
    const workflow = workflows.get(name);
    if (!workflow) throw new Error(`unknown workflow: ${name}`);
    if (agent && workflow.candidate(agent) !== true) {
      throw new Error(`a child session cannot select ${name}`);
    }
    selection.set(sessionId, name);
    if (agent) syncSession(agent);
    return name;
  }

  function clearWorkflow(sessionId) {
    selection.set(sessionId, null);
    const agent = liveAgent(sessionId);
    if (agent) syncSession(agent);
    return null;
  }

  function settingsOf(name) {
    const workflow = workflows.get(name);
    if (workflow) return workflow;
    const delegation = delegationKinds.get(name);
    if (!delegation) throw new Error(`unknown workflow or delegation kind: ${name}`);
    if (!delegation.listSettings || !delegation.writeSettings) {
      throw new Error(`${name} has no settings`);
    }
    return {
      listSettings: delegation.listSettings,
      writeSettings: delegation.writeSettings,
    };
  }

  function handleWorkflows({ agent, rawInput }) {
    const sessionId = sessionIdOf(agent);
    const parsed = parseWorkflowsInput(rawInput);
    try {
      if (parsed.action === "error") return { kind: "error", text: parsed.text };
      if (parsed.action === "list") {
        return {
          kind: "success",
          text: formatWorkflowList(userFacingNames(), selectedName(sessionId)),
        };
      }
      if (parsed.action === "clear") {
        clearWorkflow(sessionId);
        return { kind: "success", text: "none selected" };
      }
      if (parsed.action === "select") {
        selectWorkflow(sessionId, parsed.workflow);
        return { kind: "success", text: `${parsed.workflow} selected` };
      }
      if (parsed.action === "settings-list") {
        const name = parsed.workflow ?? selectedName(sessionId);
        if (!name) return { kind: "error", text: "no workflow selected" };
        return { kind: "success", text: settingsOf(name).listSettings() };
      }
      if (parsed.action === "settings-write") {
        return { kind: "success", text: settingsOf(parsed.workflow).writeSettings(parsed.role, parsed.binding) };
      }
      return { kind: "error", text: "unknown /workflows usage" };
    } catch (error) {
      return { kind: "error", text: error instanceof Error ? error.message : String(error) };
    }
  }

  function snapshots() {
    if (typeof agents?.list !== "function") return [];
    const rows = [];
    for (const agent of agents.list()) {
      if (!isArchitectCandidate(agent)) continue;
      const sessionUuid = sessionIdOf(agent);
      const semantic = semanticProjection(sessionUuid, agent);
      let phaseStartedAt = null;
      if (semantic.phase === "planning" || semantic.phase === "plan" || semantic.phase === "work") {
        let durable = null;
        try { durable = phaseStore.get(sessionUuid); } catch { /* keep the batch readable */ }
        phaseStartedAt = durable?.phase === semantic.phase
          ? durable.phaseStartedAt
          : semantic.phaseStartedAt;
      }
      rows.push({
        sessionUuid,
        workflow: semantic.workflow,
        phase: semantic.phase,
        phaseStartedAt,
      });
    }
    return rows;
  }

  const service = Object.freeze({
    cases,
    folder,
    architect,
    caseFile(sessionId) {
      if (projectsWorkflow.candidate(liveAgent(sessionId))) return null;
      if (selectedName(sessionId) !== "architect") return null;
      const loaded = cases.ensure(sessionId);
      const id = cases.taskId?.(sessionId);
      return {
        title: titleOf(loaded.text),
        text: loaded.text,
        kind: "markdown",
        identity: id ? `working memory · ${id}` : "working memory",
        ...(id ? { id } : {}),
      };
    },
    land,
    research,
    selection,
    settings: hostSettings,
    complete: (line) => completeComposerLine(line, {
      names: userFacingNames(),
      roles: {
        ...Object.fromEntries(
          [...workflows.keys()].map((name) => {
            if (name === "architect" || name === "base") return [name, [...HOST_ROLES]];
            return [name, []];
          }),
        ),
      },
    }),
    workflows: Object.freeze({
      names: userFacingNames,
      selected: selectedName,
      snapshots,
      select: selectWorkflow,
      clear: clearWorkflow,
      register: registerWorkflow,
      kinds: delegationKindNames,
      delegate: invokeDelegation,
      status: workflowStatus,
      send: workflowSend,
      resume: workflowResume,
      stop: workflowStop,
      acceptedContexts: sessionApi.acceptedContexts,
      accepts: sessionApi.accepts,
      accepting: sessionApi.accepting,
      describe: sessionApi.describe,
      compatible: sessionApi.compatible,
      leave: sessionApi.leave,
      transition: sessionApi.transition,
    }),
    handleWorkflows,
  });
  ctx.provide("qq-workflows", service);

  const registerCommand = (commandCtx) => {
    const commands = commandCtx.get("commands", false);
    if (!commands || typeof commands.register !== "function") return;
    commandCtx.effect(
      () => commands.register({
        name: "workflows",
        description: "List, select, or configure loaded workflow plugins for this session.",
        input: { hint: "architect | find | base | none | settings [workflow] [role provider model [effort]]" },
        handler: handleWorkflows,
      }),
      "qq-workflows: /workflows",
    );
  };
  if (typeof ctx.inject === "function") ctx.inject(["commands"], registerCommand);
  else registerCommand(ctx);

  const armSelectedFind = () => {
    if (typeof agents?.list !== "function") return;
    for (const agent of agents.list()) {
      if (selectedName(sessionIdOf(agent)) === "find") findWorkflow.ensureAttached(agent);
    }
  };
  if (typeof ctx.inject === "function") ctx.inject(["image-finder"], armSelectedFind);
  else armSelectedFind();

  // Relay labels are projections of the durable workflow selection. A relay
  // fiber replacement starts with an empty label board, so republish them when
  // that coeffect becomes available again.
  let observedRelay = ctx.get?.("qq-relay", false) ?? null;
  const syncRelayLabels = () => {
    const relay = ctx.get?.("qq-relay", false) ?? null;
    if (!relay || relay === observedRelay) return;
    observedRelay = relay;
    if (typeof relay.hang !== "function" || typeof agents?.list !== "function") return;
    for (const agent of agents.list()) {
      const sessionId = sessionIdOf(agent);
      const selected = selectedName(sessionId);
      const label = projectsWorkflow.candidate(agent)
        ? PROJECTS_LABEL
        : selected === "architect"
          ? architect.label
          : selected === "find"
            ? FIND_LABEL
            : "";
      if (!sessionId || !label) continue;
      try { relay.hang(sessionId, label); } catch {}
    }
    // Relay HMR replaces the in-memory label board without recreating live
    // workflow children. Reproject their durable run/role topology and retry
    // any terminal research report that could not be delivered earlier.
    land.refreshLabels?.();
    void research.recoverReports?.();
  };
  if (typeof ctx.inject === "function") ctx.inject(["qq-relay"], syncRelayLabels);

  const architectureOff = new Map();
  function architectureBinding(sessionId) {
    return hostSettings.get("architecture");
  }
  function unpinArchitecture(agentOrId) {
    const sessionId = typeof agentOrId === "string" ? agentOrId : sessionIdOf(agentOrId);
    const off = architectureOff.get(sessionId);
    if (!off) return;
    architectureOff.delete(sessionId);
    try { off(); } catch {}
  }
  function pinArchitecture(agent) {
    const sessionId = sessionIdOf(agent);
    if (!sessionId || architectureOff.has(sessionId) || !isArchitectCandidate(agent)) return;
    if (typeof agent.ctx?.on !== "function") return;
    let assembled = null;
    const offs = [];
    const dispose = () => {
      while (offs.length) {
        try { offs.pop()?.(); } catch {}
      }
    };
    try {
      offs.push(agent.ctx.on(
        "system-prompt/assemble",
        async (_assembly, _context, next) => {
          const result = await next();
          assembled = architectureBinding(sessionId);
          if (!assembled) return result;
          return {
            ...result,
            variables: {
              ...result.variables,
              provider: assembled.provider,
              model: assembled.model,
            },
          };
        },
        { prepend: true },
      ));
      offs.push(agent.ctx.on(
        "agent/request",
        async (_payload, next) => {
          const result = await next();
          // One assembled prompt may drive multiple request attempts. Keep its
          // route through retries; only the next assembly may replace it (with
          // either another binding or an explicit unbound null snapshot).
          const binding = assembled;
          if (!binding) return result;
          const { reasoningEffort: _inherited, ...rest } = result;
          return {
            ...rest,
            provider: binding.provider,
            model: binding.model,
            ...(binding.effort ? { reasoningEffort: binding.effort } : {}),
          };
        },
        { prepend: true },
      ));
    } catch (error) {
      dispose();
      throw error;
    }
    architectureOff.set(sessionId, dispose);
  }

  function syncMini(agent) {
    const researchChild = research.resumeChild?.(agent) ?? false;
    const implementationChild = syncLiveDelegationChild(land, agent);
    let adopted = false;
    for (const spec of delegationKinds.values()) adopted = spec.resumeChild?.(agent) === true || adopted;
    return implementationChild || researchChild || adopted;
  }

  ctx.on("agent/created", ({ agent }) => {
    pinArchitecture(agent);
    syncMini(agent);
    syncSession(agent);
  });
  ctx.on("agent/disposed", async ({ agent }) => {
    await research.releaseChild?.(agent);
    await land.releaseChild?.(agent);
    for (const spec of delegationKinds.values()) await spec.releaseChild?.(agent);
    projectsWorkflow.ensureDetached(agent);
    for (const workflow of workflows.values()) workflow.ensureDetached(agent);
    const sessionId = sessionIdOf(agent);
    unpinArchitecture(sessionId);
  });

  if (typeof agents?.list === "function") {
    for (const agent of agents.list()) {
      try {
        pinArchitecture(agent);
        syncMini(agent);
        syncSession(agent);
      } catch (error) {
        ctx.logger?.warn?.(
          `qq-workflows: live agent sync failed (${MINI_SWE_MIGRATION}): ${error instanceof Error ? error.message : String(error)}`,
        );
        // One live agent must not unload the plugin.
      }
    }
  }
  // A true process restart has no live Agent to drive syncMini. Recover every
  // durable pending phase after adopting live handles; land.dispose owns and
  // drains these per-delegation recovery promises if HMR starts immediately.
  void research.recoverReports?.();
  void land.recoverPendingPhases?.().then((results) => {
    for (const result of results ?? []) {
      if (result.status !== "rejected") continue;
      ctx.logger?.warn?.(
        `qq-workflows: pending delegation phase recovery failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
    }
  }).catch((error) => {
    ctx.logger?.warn?.(
      `qq-workflows: pending delegation phase recovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  ctx.effect(() => async () => {
    if (typeof agents?.list === "function") {
      for (const agent of agents.list()) {
        projectsWorkflow.ensureDetached(agent);
        for (const workflow of workflows.values()) workflow.ensureDetached(agent);
      }
    }
    await architect.dispose?.();
    research.dispose?.();
    await land.dispose?.();
    for (const record of [...toolDisposers.values()]) record.dispose();
    for (const sessionId of [...architectureOff.keys()]) unpinArchitecture(sessionId);
    findAttached.clear();
  }, "qq-workflows: live attachments");
}

export const internals = Object.freeze({
  sessionIdOf,
  toolsService,
  hostAgents,
  syncLiveDelegationChild,
  compactActivityProjection,
});
