// qq-workflows: one repository, one plugin. Cordis entry point.
//
// The wrapper lists registered workflows and selects which one this chair
// is running, if any. Architect and iterate are standalone workflows:
// own tools, own hang, own notes/journal, own role settings.

import { createNotebookStore, defaultNotebookDir } from "./notebook.mjs";
import { createClerk } from "./clerk.mjs";
import { DEFAULT_H, createFolder } from "./fold.mjs";
import { resolveScribeBinding } from "./scribe.mjs";
import { buildArchitectTools } from "./tools.mjs";
import { createArchitect, isArchitectCandidate } from "./architect.mjs";
import { createIterate, isIterateCandidate } from "./iterate.mjs";
import { createJournalStore, defaultJournalDir } from "./journal.mjs";
import { createWikiStore, defaultWikiDir } from "./wiki.mjs";
import { buildDeskTools, buildHandsTools } from "./iterate-tools.mjs";
import { createSelectionStore, defaultSelectionDir } from "./selection.mjs";
import {
  ARCHITECT_ROLES,
  ITERATE_ROLES,
  createArchitectSettings,
  createIterateSettings,
  formatSettingsList,
} from "./settings.mjs";
import { formatWorkflowList, parseWorkflowsInput } from "./command.mjs";

export const name = "qq-workflows";
// Same load gate as qq-relay. Commands and tools stay optional.
export const inject = ["agents", "sessions"];
export const provide = "qq-workflows";

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

export function apply(ctx, config = {}) {
  const store = createNotebookStore(defaultNotebookDir(process.env, config), {
    now: config.now,
  });
  const selection = createSelectionStore(defaultSelectionDir(process.env, config));
  const architectSettings = createArchitectSettings({ settingsFile: config.settingsFile });
  const iterateSettings = createIterateSettings({ settingsFile: config.settingsFile });
  const journal = createJournalStore(defaultJournalDir(process.env, config));
  const wiki = createWikiStore(defaultWikiDir(process.env, config));
  const llm = ctx.get("llm", false);
  const tokenMeter = ctx.get("tokenMeter", false);
  const sessionQuery = ctx.get("sessionQuery", false);
  const agents = ctx.get("agents");
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

  function registerAgentTools(agent) {
    const sessionId = sessionIdOf(agent);
    const install = (toolCtx) => {
      if (toolDisposers.has(sessionId)) return;
      const selected = selectedName(sessionId);
      if (selected !== "architect" && selected !== "iterate") return;
      const tools = toolsService(toolCtx) ?? toolsService(agent);
      if (!tools || typeof tools.register !== "function") return;
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
    settings: architectSettings,
    ensureAttached(agent) {
      if (!isArchitectCandidate(agent)) return null;
      const handle = architect.attach(agent);
      registerAgentTools(agent);
      return handle;
    },
    ensureDetached(agentOrId) {
      disposeAgentTools(agentOrId, "architect");
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
    settings: iterateSettings,
    ensureAttached(agent) {
      if (!isIterateCandidate(agent)) return null;
      const handle = iterate.attach(agent);
      registerAgentTools(agent);
      return handle;
    },
    ensureDetached(agentOrId) {
      disposeAgentTools(agentOrId, "iterate");
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

  function liveAgent(sessionId) {
    if (!sessionId || typeof agents?.get !== "function") return null;
    return agents.get(sessionId) ?? null;
  }

  function syncSession(agent) {
    if (!agent) return;
    const sessionId = sessionIdOf(agent);
    const chosen = selectedName(sessionId);
    for (const [name, workflow] of workflows) {
      if (name === chosen) workflow.ensureAttached(agent);
      else workflow.ensureDetached(agent);
    }
  }

  function selectWorkflow(sessionId, name) {
    const workflow = workflows.get(name);
    if (!workflow) throw new Error(`unknown workflow: ${name}`);
    const agent = liveAgent(sessionId);
    if (agent && !workflow.candidate(agent)) {
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
    iterate,
    journal,
    wiki,
    selection,
    settings: architectSettings,
    iterateSettings,
    scribe: () => resolveScribeBinding({ ...config, settings: architectSettings }),
    workflows: Object.freeze({
      names: () => [...workflows.keys()],
      selected: selectedName,
      select: selectWorkflow,
      clear: clearWorkflow,
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
        input: { hint: "architect | iterate | none | settings [workflow] [role provider model [effort]]" },
        handler: handleWorkflows,
      }),
      "qq-workflows: /workflows",
    );
  };
  if (typeof ctx.inject === "function") ctx.inject(["commands"], registerCommand);
  else registerCommand(ctx);

  ctx.on("agent/created", ({ agent }) => {
    syncSession(agent);
  });
  ctx.on("agent/disposed", ({ agent }) => {
    for (const workflow of workflows.values()) workflow.ensureDetached(agent);
    const sessionId = sessionIdOf(agent);
    handsToolDisposers.get(sessionId)?.();
    handsToolDisposers.delete(sessionId);
  });

  if (typeof agents?.list === "function") {
    for (const agent of agents.list()) {
      try {
        syncSession(agent);
      } catch {
        // One live agent must not unload the plugin.
      }
    }
  }
}

export const internals = Object.freeze({
  sessionIdOf,
  toolsService,
});