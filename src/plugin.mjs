// qq-workflows: one repository, one plugin. Cordis entry point.
//
// The wrapper lists registered workflows and selects which one this chair
// is running, if any. Architect, iterate, and find are standalone workflows.
// Architect and iterate own tools, hang, notes/journal, and role settings.
// Find owns the image-finder sitting: hang, arm, leave. No roles.
// Session context and awaitable leave/transition live on service.workflows;
// /workflows select and clear stay the command path.

import { createNotebookStore, defaultNotebookDir } from "./notebook.mjs";
import { createClerk } from "./clerk.mjs";
import { DEFAULT_H, createFolder } from "./fold.mjs";
import { resolveScribeBinding } from "./scribe.mjs";
import { buildArchitectTools } from "./tools.mjs";
import { CHILD_ORIGIN, createArchitect, isArchitectCandidate } from "./architect.mjs";
import {
  hideHarnessTools,
  stripHiddenHarnessTools,
  toolsOf,
} from "./hide-harness.mjs";
import { createIterate, isIterateCandidate } from "./iterate.mjs";
import { createJournalStore, defaultJournalDir } from "./journal.mjs";
import { createWikiStore, defaultWikiDir } from "./wiki.mjs";
import { buildDeskTools, buildHandsTools } from "./iterate-tools.mjs";
import { createSelectionStore, defaultSelectionDir } from "./selection.mjs";
import {
  ARCHITECT_ROLES,
  BASE_ROLES,
  ITERATE_ROLES,
  createArchitectSettings,
  createBaseSettings,
  createIterateSettings,
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
 * DSH binds Agent create/resume lifecycle to the accessing fiber. Plugin HMR
 * unloads that fiber and would abort in-flight turns. Workflow children must
 * outlive a qq-workflows replacement, so create/resume through the host root.
 */
function hostAgents(ctx) {
  const host = ctx?.root && typeof ctx.root.get === "function" ? ctx.root : ctx;
  const agents = typeof host.get === "function" ? host.get("agents") : undefined;
  if (agents) return agents;
  return typeof ctx?.get === "function" ? ctx.get("agents") : undefined;
}

export function apply(ctx, config = {}) {
  const store = createNotebookStore(defaultNotebookDir(process.env, config), {
    now: config.now,
  });
  const selection = createSelectionStore(defaultSelectionDir(process.env, config));
  const architectSettings = createArchitectSettings({ settingsFile: config.settingsFile });
  const iterateSettings = createIterateSettings({ settingsFile: config.settingsFile });
  const baseSettings = createBaseSettings({ settingsFile: config.settingsFile });
  const journal = createJournalStore(defaultJournalDir(process.env, config));
  const wiki = createWikiStore(defaultWikiDir(process.env, config));
  const llm = ctx.get("llm", false);
  const tokenMeter = ctx.get("tokenMeter", false);
  const sessionQuery = ctx.get("sessionQuery", false);
  const agents = hostAgents(ctx);
  const clerk = createClerk({
    store,
    llm,
    resolveBinding: () => resolveScribeBinding({ ...config, settings: architectSettings }),
    run: config.runScribe,
  });
  const folder = createFolder({
    store,
    tokenMeter,
    h: config.h ?? DEFAULT_H,
    q: config.q,
    now: config.now,
  });
  const architect = createArchitect({
    ctx,
    store,
    clerk,
    folder,
    agents,
    tasks: () => ctx.get?.("qq-tasks", false) ?? null,
    talking: () => architectSettings.get("talking"),
  });
  const iterate = createIterate({
    ctx,
    journal,
    wiki,
    settings: iterateSettings,
    llm,
    agents,
    run: config.runScribe,
    registerHandsTools: (child, queue) => registerHandsTools(child, queue),
  });

  const workflows = new Map();
  const toolDisposers = new Map();
  const handsToolDisposers = new Map();
  const hideDisposers = new Map();

  function originOf(agent) {
    return agent?.session?.header?.origin;
  }

  function shouldHideHarness(agent) {
    if (!agent) return false;
    if (originOf(agent) === CHILD_ORIGIN) return true;
    const selected = selectedName(sessionIdOf(agent));
    return selected === "architect" || selected === "iterate";
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

  function registerAgentTools(agent) {
    const sessionId = sessionIdOf(agent);
    const install = (toolCtx) => {
      if (toolDisposers.has(sessionId)) return;
      const selected = selectedName(sessionId);
      if (selected !== "architect" && selected !== "iterate") return;
      const tools = toolsService(toolCtx) ?? toolsService(agent);
      if (!tools || typeof tools.register !== "function") return;
      installHide(agent);
      const tasks = ctx.get?.("qq-tasks", false) ?? null;
      const definitions = selected === "architect"
        ? buildArchitectTools({
            store,
            sessionQuery,
            invoke: (args) => architect.invoke(args),
            tasks,
          })
        : buildDeskTools({
            journal,
            wiki,
            go: (args) => iterate.go(args),
          });
      const disposers = definitions.map((tool) => tools.register(tool));
      toolDisposers.set(sessionId, {
        owner: selected,
        dispose() {
          for (const dispose of disposers) dispose();
          toolDisposers.delete(sessionId);
        },
      });
    };
    if (typeof agent?.ctx?.inject === "function") agent.ctx.inject(["tools"], install);
    else install(agent?.ctx);
  }

  function registerHandsTools(child, queue) {
    const sessionId = sessionIdOf(child);
    const install = (toolCtx) => {
      if (handsToolDisposers.has(sessionId)) return;
      const tools = toolsService(toolCtx) ?? toolsService(child);
      if (!tools || typeof tools.register !== "function") return;
      installHide(child);
      const disposers = buildHandsTools({
        designLoop: config.designLoop,
        onDump: ({ text }) => {
          if (Array.isArray(queue)) queue.push(text);
        },
      }).map((tool) => tools.register(tool));
      handsToolDisposers.set(sessionId, () => {
        for (const dispose of disposers) dispose();
        handsToolDisposers.delete(sessionId);
      });
    };
    if (typeof child?.ctx?.inject === "function") child.ctx.inject(["tools"], install);
    else install(child?.ctx);
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

  const iterateWorkflow = Object.freeze({
    name: "iterate",
    candidate: isIterateCandidate,
    acceptedContexts: DEFAULT_ACCEPTED_CONTEXTS,
    settings: iterateSettings,
    ensureAttached(agent) {
      if (!isIterateCandidate(agent)) return null;
      const handle = iterate.attach(agent);
      registerAgentTools(agent);
      return handle;
    },
    ensureDetached(agentOrId) {
      disposeAgentTools(agentOrId, "iterate");
      liftHide(agentOrId);
      return iterate.detach(agentOrId);
    },
    listSettings() {
      return formatSettingsList("iterate", iterateSettings.list(), ITERATE_ROLES);
    },
    writeSettings(role, binding) {
      iterateSettings.write(role, binding);
      return formatSettingsList("iterate", iterateSettings.list(), ITERATE_ROLES);
    },
  });
  workflows.set("iterate", iterateWorkflow);

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
      return sessionIdOf(agent);
    },
    ensureDetached() {
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

  const sessionApi = createWorkflowSessionApi({
    getWorkflow: (name) => workflows.get(name) ?? null,
    selectedName,
    persistSelection: (sessionId, name) => selection.set(sessionId, name),
    liveAgent,
    names: () => [...workflows.keys()],
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
          text: formatWorkflowList([...workflows.keys()], selectedName(sessionId)),
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
    store,
    clerk,
    folder,
    architect,
    offer: (sessionId) => architect.offer(sessionId),
    choose: (sessionId, args) => architect.choose(sessionId, args),
    iterate,
    journal,
    wiki,
    selection,
    settings: architectSettings,
    iterateSettings,
    baseSettings,
    complete: (line) => completeComposerLine(line, {
      names: [...workflows.keys()],
      roles: Object.fromEntries(
        [...workflows.entries()].map(([name, workflow]) => {
          if (name === "architect") return [name, [...ARCHITECT_ROLES]];
          if (name === "iterate") return [name, [...ITERATE_ROLES]];
          if (name === "base") return [name, [...BASE_ROLES]];
          return [name, []];
        }),
      ),
    }),
    scribe: () => resolveScribeBinding({ ...config, settings: architectSettings }),
    workflows: Object.freeze({
      names: () => [...workflows.keys()],
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
        input: { hint: "architect | iterate | find | base | none | settings [workflow] [role provider model [effort]]" },
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
        : selected === "iterate"
          ? iterate.label
          : selected === "find"
            ? FIND_LABEL
            : "";
      if (!sessionId || !label) continue;
      try { relay.hang(sessionId, label); } catch {}
    }
  };
  if (typeof ctx.inject === "function") ctx.inject(["qq-relay"], syncRelayLabels);

  const talkingPinned = new WeakSet();
  function talkingBinding(sessionId) {
    const selected = selectedName(sessionId);
    if (selected === "architect") return architectSettings.get("talking") ?? baseSettings.get("talking");
    if (selected === "iterate") return iterateSettings.get("desk") ?? baseSettings.get("talking");
    return baseSettings.get("talking");
  }
  function pinTalking(agent) {
    if (!agent || talkingPinned.has(agent) || !isArchitectCandidate(agent)) return;
    if (typeof agent.ctx?.on !== "function") return;
    talkingPinned.add(agent);
    agent.ctx.on("agent/request", async (_payload, next) => {
      const result = await next();
      const binding = talkingBinding(sessionIdOf(agent));
      if (!binding) return result;
      const { reasoningEffort: _inherited, ...rest } = result;
      return {
        ...rest,
        provider: binding.provider,
        model: binding.model,
        ...(binding.effort ? { reasoningEffort: binding.effort } : {}),
      };
    });
  }

  ctx.on("agent/created", ({ agent }) => {
    pinTalking(agent);
    if (originOf(agent) === CHILD_ORIGIN) installHide(agent);
    syncSession(agent);
  });
  ctx.on("agent/disposed", ({ agent }) => {
    for (const workflow of workflows.values()) workflow.ensureDetached(agent);
    const sessionId = sessionIdOf(agent);
    handsToolDisposers.get(sessionId)?.();
    handsToolDisposers.delete(sessionId);
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

  if (typeof agents?.list === "function") {
    for (const agent of agents.list()) {
      try {
        pinTalking(agent);
        syncSession(agent);
      } catch {
        // One live agent must not unload the plugin.
      }
    }
  }

  ctx.effect(() => () => {
    if (typeof agents?.list === "function") {
      for (const agent of agents.list()) {
        for (const workflow of workflows.values()) workflow.ensureDetached(agent);
      }
    }
    architect.dispose?.();
    iterate.dispose?.();
    for (const record of [...toolDisposers.values()]) record.dispose();
    for (const dispose of [...handsToolDisposers.values()]) dispose();
    for (const dispose of [...hideDisposers.values()]) dispose();
    hideDisposers.clear();
    findAttached.clear();
  }, "qq-workflows: live attachments");
}

export const internals = Object.freeze({
  sessionIdOf,
  toolsService,
  hostAgents,
});