// qq-workflows: one repository, one plugin. Cordis entry point.
//
// The wrapper lists registered workflows and selects which one this chair
// is running, if any. Architect, find, and base are selectable. Land is git
// machinery: official Mini completion and the architect/base land tool.
// Architect owns working memory, two-pair fold, delegate, and role settings.
// Session context and awaitable leave/transition live on service.workflows;
// /workflows select and clear stay the command path.

import { createCaseStore, defaultCaseDir, titleOf } from "./casefile.mjs";
import { DEFAULT_H, createFolder } from "./fold.mjs";
import { buildArchitectTools } from "./tools.mjs";
import { CHILD_ORIGIN, createArchitect, isArchitectCandidate } from "./architect.mjs";
import { ensureMiniMounted, isMiniAgent, MINI_SWE_MIGRATION } from "./official-mini.mjs";
import { ensureMiniReviewMounted, isMiniReviewAgent } from "./mini-review.mjs";
import {
  hideHarnessTools,
  stripAgentInstructionsPreStep,
  stripHiddenHarnessTools,
  toolsOf,
} from "./hide-harness.mjs";
import { runCommand } from "./git.mjs";
import { capObservationTool } from "./observation.mjs";
import { createLand } from "./land.mjs";
import { createLandStore, defaultLandDir } from "./land-store.mjs";
import { createJournalStore, defaultJournalDir } from "./journal.mjs";
import { createWikiStore, defaultWikiDir } from "./wiki.mjs";
import { createSelectionStore, defaultSelectionDir } from "./selection.mjs";
import { buildLandTool } from "./land-tools.mjs";
import {
  ARCHITECT_ROLES,
  BASE_ROLES,
  LAND_ROLES,
  createArchitectSettings,
  createBaseSettings,
  createLandSettings,
  formatSettingsList,
} from "./settings.mjs";
import { completeComposerLine, formatWorkflowList, parseWorkflowsInput } from "./command.mjs";
import { DEFAULT_ACCEPTED_CONTEXTS, normalizeAcceptedContexts } from "./context.mjs";
import { createWorkflowSessionApi } from "./transition.mjs";

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

const WORKFLOW_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const EXTERNAL_WORKFLOW_RESERVED = new Set([
  "none",
  "off",
  "settings",
  "architect",
  "iterate",
  "land",
  "find",
  "base",
]);
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

function syncLiveLandChild(land, agent) {
  if (isMiniAgent(agent)) ensureMiniMounted(agent);
  if (isMiniReviewAgent(agent)) ensureMiniReviewMounted(agent);
  return land?.resumeChild?.(agent) ?? false;
}

export function apply(ctx, config = {}) {
  const cases = createCaseStore(defaultCaseDir(process.env, config));
  const selection = createSelectionStore(defaultSelectionDir(process.env, config));
  const architectSettings = createArchitectSettings({ settingsFile: config.settingsFile });
  const landSettings = createLandSettings({ settingsFile: config.settingsFile });
  const baseSettings = createBaseSettings({ settingsFile: config.settingsFile });
  const journal = createJournalStore(defaultJournalDir(process.env, config));
  const wiki = createWikiStore(defaultWikiDir(process.env, config));
  const landStore = createLandStore(defaultLandDir(process.env, config));
  const llm = ctx.get("llm", false);
  const tokenMeter = ctx.get("tokenMeter", false);
  const agents = hostAgents(ctx);
  const folder = createFolder({
    tokenMeter,
    h: config.h ?? DEFAULT_H,
    q: config.q,
    now: config.now,
  });
  const land = createLand({
    ctx,
    store: landStore,
    settings: landSettings,
    agents,
    llm,
    tasks: null,
    run: config.runCommand,
    github: config.github,
  });
  const architect = createArchitect({
    ctx,
    cases,
    folder,
    agents,
    tasks: null,
    talking: () => architectSettings.get("talking") ?? baseSettings.get("talking"),
    hands: () => architectSettings.get("hands"),
    run: config.runCommand ?? runCommand,
    onInvokeChild: (child, info) => land.adoptImplementer(child, info),
  });

  const workflows = new Map();
  const toolDisposers = new Map();
  const hideDisposers = new Map();

  function originOf(agent) {
    return agent?.session?.header?.origin;
  }

  function shouldHideHarness(agent) {
    if (!agent) return false;
    if (originOf(agent) === CHILD_ORIGIN) return true;
    const selected = selectedName(sessionIdOf(agent));
    return selected === "architect";
  }

  function installHide(agent) {
    const sessionId = sessionIdOf(agent);
    if (!sessionId || hideDisposers.has(sessionId)) return;
    const install = (toolCtx) => {
      if (hideDisposers.has(sessionId)) return;
      const tools = toolsOf(toolCtx) ?? toolsService(agent);
      const dispose = hideHarnessTools(tools);
      if (!dispose) return;
      hideDisposers.set(sessionId, () => {
        dispose();
        hideDisposers.delete(sessionId);
      });
    };
    if (typeof agent?.ctx?.inject === "function") agent.ctx.inject(["tools"], install);
    else install(agent?.ctx);
  }

  function liftHide(agentOrId) {
    const sessionId = typeof agentOrId === "string" ? agentOrId : sessionIdOf(agentOrId);
    hideDisposers.get(sessionId)?.();
    hideDisposers.delete(sessionId);
  }

  function capVisibleArchitectTools(tools, agent) {
    if (typeof tools?.schemas !== "function" || typeof tools?.get !== "function") return [];
    let schemas;
    try { schemas = tools.schemas(agent); } catch { return []; }
    if (!Array.isArray(schemas)) return [];
    const disposers = [];
    for (const schema of schemas) {
      try {
        const definition = tools.get(schema?.name, agent);
        const capped = capObservationTool(definition);
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
      if (selected === "architect") installHide(agent);
      const tasks = null;
      const invokeLand = (args) => land.invoke(args);
      const inheritedCaps = selected === "architect" ? capVisibleArchitectTools(tools, agent) : [];
      const definitions = selected === "architect"
        ? buildArchitectTools({
            cases,
            delegate: (args) => architect.delegate(args),
            workflowStatus: (args) => land.workflowStatus(args),
            workflowSend: (args) => land.workflowSend(args),
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

  const architectWorkflow = Object.freeze({
    name: "architect",
    candidate: isArchitectCandidate,
    acceptedContexts: DEFAULT_ACCEPTED_CONTEXTS,
    settings: architectSettings,
    ensureAttached(agent) {
      if (!isArchitectCandidate(agent)) return null;
      const handle = architect.attach(agent);
      registerAgentTools(agent);
      return handle;
    },
    ensureDetached(agentOrId) {
      disposeAgentTools(agentOrId, "architect");
      liftHide(agentOrId);
      return architect.detach(agentOrId);
    },
    listSettings() {
      return formatSettingsList("architect", architectSettings.list());
    },
    writeSettings(role, binding) {
      architectSettings.write(role, binding);
      return formatSettingsList("architect", architectSettings.list());
    },
  });
  workflows.set("architect", architectWorkflow);

  const landSettingsFacade = Object.freeze({
    listSettings() {
      return formatSettingsList("land", landSettings.list(), LAND_ROLES);
    },
    writeSettings(role, binding) {
      landSettings.write(role, binding);
      return formatSettingsList("land", landSettings.list(), LAND_ROLES);
    },
  });

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
    candidate: isArchitectCandidate,
    acceptedContexts: DEFAULT_ACCEPTED_CONTEXTS,
    ensureAttached(agent) {
      if (!isArchitectCandidate(agent)) return null;
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
    candidate: isArchitectCandidate,
    acceptedContexts: DEFAULT_ACCEPTED_CONTEXTS,
    settings: baseSettings,
    ensureAttached(agent) {
      if (!isArchitectCandidate(agent)) return null;
      registerAgentTools(agent);
      return sessionIdOf(agent);
    },
    ensureDetached(agentOrId) {
      disposeAgentTools(agentOrId, "base");
      return null;
    },
    listSettings() {
      return formatSettingsList("base", baseSettings.list(), BASE_ROLES);
    },
    writeSettings(role, binding) {
      baseSettings.write(role, binding);
      return formatSettingsList("base", baseSettings.list(), BASE_ROLES);
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
    const sessionId = sessionIdOf(agent);
    const chosen = selectedName(sessionId);
    for (const [name, workflow] of workflows) {
      if (name === chosen && workflow.candidate(agent) === true) workflow.ensureAttached(agent);
      else workflow.ensureDetached(agent);
    }
  }

  function registerWorkflow(spec) {
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

  function selectWorkflow(sessionId, name) {
    if (name === "land") throw new Error("land is not a selectable workflow");
    const workflow = workflows.get(name);
    if (!workflow) throw new Error(`unknown workflow: ${name}`);
    const agent = liveAgent(sessionId);
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
    if (name === "land") return landSettingsFacade;
    const workflow = workflows.get(name);
    if (!workflow) throw new Error(`unknown workflow: ${name}`);
    return workflow;
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

  const service = Object.freeze({
    cases,
    folder,
    architect,
    caseFile(sessionId) {
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
    journal,
    wiki,
    selection,
    settings: architectSettings,
    landSettings,
    baseSettings,
    complete: (line) => completeComposerLine(line, {
      names: userFacingNames(),
      roles: {
        ...Object.fromEntries(
          [...workflows.keys()].map((name) => {
            if (name === "architect") return [name, [...ARCHITECT_ROLES]];
            if (name === "base") return [name, [...BASE_ROLES]];
            return [name, []];
          }),
        ),
        land: [...LAND_ROLES],
      },
    }),
    workflows: Object.freeze({
      names: userFacingNames,
      selected: selectedName,
      select: selectWorkflow,
      clear: clearWorkflow,
      register: registerWorkflow,
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
      const label = selected === "architect"
        ? architect.label
        : selected === "find"
          ? FIND_LABEL
          : "";
      if (!sessionId || !label) continue;
      try { relay.hang(sessionId, label); } catch {}
    }
    // Relay HMR replaces the in-memory label board without recreating live
    // workflow children. Reproject their durable run/role topology as well.
    land.refreshLabels?.();
  };
  if (typeof ctx.inject === "function") ctx.inject(["qq-relay"], syncRelayLabels);

  const talkingOff = new Map();
  function talkingBinding(sessionId) {
    const selected = selectedName(sessionId);
    if (selected === "architect") return architectSettings.get("talking") ?? baseSettings.get("talking");
    return baseSettings.get("talking");
  }
  function unpinTalking(agentOrId) {
    const sessionId = typeof agentOrId === "string" ? agentOrId : sessionIdOf(agentOrId);
    const off = talkingOff.get(sessionId);
    if (!off) return;
    talkingOff.delete(sessionId);
    try { off(); } catch {}
  }
  function pinTalking(agent) {
    const sessionId = sessionIdOf(agent);
    if (!sessionId || talkingOff.has(sessionId) || !isArchitectCandidate(agent)) return;
    if (typeof agent.ctx?.on !== "function") return;
    const off = agent.ctx.on("agent/request", async (_payload, next) => {
      const result = await next();
      const binding = talkingBinding(sessionId);
      if (!binding) return result;
      const { reasoningEffort: _inherited, ...rest } = result;
      return {
        ...rest,
        provider: binding.provider,
        model: binding.model,
        ...(binding.effort ? { reasoningEffort: binding.effort } : {}),
      };
    });
    talkingOff.set(sessionId, typeof off === "function" ? off : () => {});
  }

  function syncMini(agent) {
    return syncLiveLandChild(land, agent);
  }

  ctx.on("agent/created", ({ agent }) => {
    pinTalking(agent);
    syncMini(agent);
    if (originOf(agent) === CHILD_ORIGIN) installHide(agent);
    syncSession(agent);
  });
  ctx.on("agent/disposed", async ({ agent }) => {
    await land.releaseChild?.(agent);
    for (const workflow of workflows.values()) workflow.ensureDetached(agent);
    const sessionId = sessionIdOf(agent);
    unpinTalking(sessionId);
    liftHide(agent);
  });
  ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    const agent = context?.agent ?? context?.scope;
    const result = await next();
    if (!shouldHideHarness(agent)) return result;
    const tools = stripHiddenHarnessTools(result?.tools);
    if (tools === result?.tools) return result;
    return { ...result, tools };
  });
  // Prepend: agent-instructions injects after next(). Wrapping it is the
  // only way the dump does not re-enter the batch we just stripped.
  ctx.on("agent/pre-step", stripAgentInstructionsPreStep, { prepend: true });

  if (typeof agents?.list === "function") {
    for (const agent of agents.list()) {
      try {
        pinTalking(agent);
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
  // drains these per-run recovery promises if HMR starts immediately.
  void land.recoverPendingPhases?.().then((results) => {
    for (const result of results ?? []) {
      if (result.status !== "rejected") continue;
      ctx.logger?.warn?.(
        `qq-workflows: pending land phase recovery failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
    }
  }).catch((error) => {
    ctx.logger?.warn?.(
      `qq-workflows: pending land phase recovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  ctx.effect(() => async () => {
    if (typeof agents?.list === "function") {
      for (const agent of agents.list()) {
        for (const workflow of workflows.values()) workflow.ensureDetached(agent);
      }
    }
    await architect.dispose?.();
    await land.dispose?.();
    for (const record of [...toolDisposers.values()]) record.dispose();
    for (const dispose of [...hideDisposers.values()]) dispose();
    hideDisposers.clear();
    for (const sessionId of [...talkingOff.keys()]) unpinTalking(sessionId);
    findAttached.clear();
  }, "qq-workflows: live attachments");
}

export const internals = Object.freeze({
  sessionIdOf,
  toolsService,
  hostAgents,
  syncLiveLandChild,
});
