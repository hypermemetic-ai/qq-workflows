import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { wrapProjectsBash } from "./projects-bash.mjs";
import { isArchitectCandidate } from "./architect.mjs";
import { allowInherited, PROJECTS_INHERITED_TOOLS } from "./hide-harness.mjs";

export const PROJECTS_LABEL = "workflows:projects";
export const PROJECTS_PROMPT_NAME = "qq-workflows:projects";
export const PROJECTS_PRESET = "danger-full-access";

function coreOf(ctx) {
  return ctx?.get?.("qq-core", false) ?? ctx?.get?.("qq", false) ?? null;
}

function canonicalPath(path) {
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function systemPromptOf(holder) {
  return holder?.systemPrompt
    ?? holder?.get?.("systemPrompt", false)
    ?? holder?.ctx?.systemPrompt
    ?? holder?.ctx?.get?.("systemPrompt", false)
    ?? null;
}

function toolsOf(holder) {
  return holder?.tools
    ?? holder?.get?.("tools", false)
    ?? holder?.ctx?.tools
    ?? holder?.ctx?.get?.("tools", false)
    ?? null;
}

function relayOf(ctx) {
  return ctx?.get?.("qq-relay", false) ?? null;
}

function permissionPresetsOf(ctx) {
  return ctx?.get?.("permissionPresets", false) ?? null;
}

function projectsRootOf(ctx) {
  return coreOf(ctx)?.projectsRoot;
}

export function isProjectsCandidate(agent, ctx) {
  if (!isArchitectCandidate(agent)) return false;
  const cwd = canonicalPath(agent?.session?.header?.cwd);
  const projectsRoot = canonicalPath(projectsRootOf(ctx));
  return Boolean(cwd && projectsRoot && cwd === projectsRoot);
}

export function projectsPrompt(projectsRoot) {
  return [
    `You are the operator session at ${projectsRoot}.`,
    "You have all basic tools for managing local state and no restrictions.",
    "Work across all projects and repositories, edit code, run commands, and execute tasks directly.",
  ].join(" ");
}

export function createProjectsWorkflow({ ctx } = {}) {
  const attached = new Map();

  function candidate(agent) {
    return isProjectsCandidate(agent, ctx);
  }

  function pinPreset(agent) {
    const presets = permissionPresetsOf(ctx);
    if (typeof presets?.set === "function") presets.set(agent.session, PROJECTS_PRESET);
  }

  function installPrompt(record, holder) {
    if (attached.get(record.sessionId) !== record || record.promptOff) return;
    const prompt = systemPromptOf(holder) ?? systemPromptOf(record.agent);
    if (typeof prompt?.context !== "function") return;
    const off = prompt.context({
      name: PROJECTS_PROMPT_NAME,
      order: 10,
      text: () => projectsPrompt(projectsRootOf(ctx)),
    });
    if (typeof off === "function") record.promptOff = off;
  }

  function installTools(record, holder) {
    if (attached.get(record.sessionId) !== record || record.toolOff) return;
    const tools = toolsOf(holder) ?? toolsOf(record.agent);
    if (!tools || typeof tools.register !== "function" || typeof tools.get !== "function") return;
    const base = tools.get("bash", record.agent);
    if (!base) return;
    const wrapped = wrapProjectsBash(base);
    if (wrapped === base) return;
    const off = tools.register(wrapped);
    if (typeof off === "function") record.toolOff = off;
  }

  function attachServices(record) {
    installPrompt(record, record.agent);
    installTools(record, record.agent);
    if (typeof record.agent?.ctx?.inject !== "function") return;
    if (!record.promptOff || !record.toolOff) {
      record.agent.ctx.inject(["systemPrompt", "tools"], (holder) => {
        installPrompt(record, holder);
        installTools(record, holder);
      });
    }
  }

  function ensureAttached(agent) {
    if (!candidate(agent)) return null;
    // Re-pin on every attach/sync. PermissionPresetService.set() is a no-op
    // when danger-full-access is already the effective selected preset.
    pinPreset(agent);
    const sessionId = agent.session.id;
    const existing = attached.get(sessionId);
    if (existing) return existing;
    allowInherited(ctx, agent, PROJECTS_INHERITED_TOOLS);
    const record = {
      agent,
      sessionId,
      promptOff: null,
      toolOff: null,
    };
    attached.set(sessionId, record);
    attachServices(record);
    try { relayOf(ctx)?.hang?.(sessionId, PROJECTS_LABEL); } catch {}
    return record;
  }

  function ensureDetached(agentOrId) {
    const sessionId = typeof agentOrId === "string"
      ? agentOrId
      : agentOrId?.session?.id ?? agentOrId?.id;
    const record = attached.get(sessionId);
    if (!record) return null;
    attached.delete(sessionId);
    try { record.promptOff?.(); } catch {}
    try { record.toolOff?.(); } catch {}
    try { relayOf(ctx)?.clear?.(sessionId, PROJECTS_LABEL); } catch {}
    return sessionId;
  }

  return Object.freeze({
    name: "projects",
    label: PROJECTS_LABEL,
    candidate,
    ensureAttached,
    ensureDetached,
    attached(sessionId) {
      return attached.has(sessionId);
    },
  });
}

export const internals = Object.freeze({
  canonicalPath,
  coreOf,
  systemPromptOf,
});
