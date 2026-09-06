import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function findPluginRoot({
  startDir,
  env = process.env,
  metaUrl = import.meta.url,
  cwd = process.cwd(),
  paseoConfigPath,
} = {}) {
  if (env.ARCHITECT_PLUGIN_ROOT) return env.ARCHITECT_PLUGIN_ROOT;
  const starts = [];
  if (startDir) starts.push(startDir);
  else {
    const fromMeta = dirFromMetaUrl(metaUrl);
    if (fromMeta) starts.push(fromMeta);
    if (cwd) starts.push(cwd);
  }
  for (const start of starts) {
    const found = walkForPluginRoot(start);
    if (found) return found;
  }
  if (!startDir) {
    const installed = pluginPathFromPaseoConfig(paseoConfigPath, env);
    if (installed) return installed;
  }
  throw new Error("architect plugin root not found");
}

function dirFromMetaUrl(metaUrl) {
  if (typeof metaUrl !== "string" || metaUrl.length === 0) return null;
  try {
    return dirname(fileURLToPath(metaUrl));
  } catch {
    return null;
  }
}

function walkForPluginRoot(start) {
  let dir = start;
  for (let i = 0; i < 10; i += 1) {
    if (isPluginRoot(dir)) return dir;
    const nested = join(dir, "paseo-plugin");
    if (isPluginRoot(nested)) return nested;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function isPluginRoot(dir) {
  return existsSync(join(dir, "paseo-plugin.json")) && existsSync(join(dir, "host", "acp.mjs"));
}

function pluginPathFromPaseoConfig(paseoConfigPath, env = process.env) {
  const path = paseoConfigPath
    ?? (env.PASEO_HOME ? join(env.PASEO_HOME, "config.json") : join(homedir(), ".paseo", "config.json"));
  try {
    const config = JSON.parse(readFileSync(path, "utf8"));
    const architect = config?.plugins?.architect?.path;
    if (typeof architect === "string" && isPluginRoot(architect)) return architect;
  } catch {
    return null;
  }
  return null;
}

export const PLUGIN_ROOT = findPluginRoot();
export const ACP_ENTRY = join(PLUGIN_ROOT, "host", "acp.mjs");
export const CHILD_MCP_ENTRY = join(PLUGIN_ROOT, "host", "child-mcp.mjs");
export const SPAWN_ENTRY = join(PLUGIN_ROOT, "host", "spawn-agent.mjs");

export const ARCHITECT_PROVIDER_ID = "architect";
export const ARCHITECT_MODEL_ID = "gpt-6-astra";
export const ARCHITECT_PROFILE_ID = "architect";

export const ASTRA_THINKING = Object.freeze([
  { id: "low", label: "low", description: "Fast responses with lighter reasoning" },
  { id: "medium", label: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { id: "high", label: "high", description: "Greater reasoning depth for complex problems", isDefault: true },
  { id: "xhigh", label: "xhigh", description: "Extra high reasoning depth for complex problems" },
]);

export const ASTRA_MODEL = Object.freeze({
  id: ARCHITECT_MODEL_ID,
  label: "GPT-6 Astra",
  description: "GPT-6 Astra",
  isDefault: true,
  defaultThinkingOptionId: "high",
  thinkingOptions: ASTRA_THINKING,
});

export function astraThoughtConfig(currentValue = "high") {
  const current = ASTRA_THINKING.some((item) => item.id === currentValue) ? currentValue : "high";
  return {
    id: "thought_level",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: current,
    options: ASTRA_THINKING.map((item) => ({
      value: item.id,
      name: item.label,
      description: item.description,
    })),
  };
}

export function architectProvider(nodePath = process.execPath) {
  return {
    extends: "acp",
    label: "Architect",
    description: "Ticket-driven architect with a two-pair model loop.",
    command: [nodePath, ACP_ENTRY],
    models: [ASTRA_MODEL],
  };
}

export function architectProfile() {
  return {
    id: ARCHITECT_PROFILE_ID,
    name: "Architect",
    icon: "compass",
    provider: ARCHITECT_PROVIDER_ID,
    model: ARCHITECT_MODEL_ID,
    thinkingOptionId: "high",
    notes:
      "Ticket-driven architect. Pins `.architect/ticket.md`, keeps two operator/architect pairs, and delegates implementer or researcher. Codex gpt-6-astra with high thinking.",
  };
}

export function applyDaemonPatch(config) {
  const next = structuredClone(config ?? {});
  next.agents = next.agents ?? {};
  next.agents.providers = next.agents.providers ?? {};
  const providers = next.agents.providers;
  providers["architect-teacher"] = {
    extends: "acp", label: "Architect Teacher",
    command: [process.execPath, join(PLUGIN_ROOT, "host", "teacher-acp.mjs")],
    models: [{ id: "grok-4.6", label: "Grok 4.6", isDefault: true, defaultThinkingOptionId: "high", thinkingOptions: [{ id: "high", label: "high", isDefault: true }] }],
  };
  providers["architect-mini"] = {
    extends: "acp", label: "Mini v2 Implementer",
    command: [process.execPath, join(PLUGIN_ROOT, "host", "mini-acp.mjs")],
    models: providers["architect-teacher"].models,
  };
  providers[ARCHITECT_PROVIDER_ID] = {
    ...(providers[ARCHITECT_PROVIDER_ID] ?? {}),
    ...architectProvider(),
  };
  const codex = providers.codex && typeof providers.codex === "object" ? providers.codex : {};
  const additional = Array.isArray(codex.additionalModels) ? [...codex.additionalModels] : [];
  const existing = additional.findIndex((model) => model?.id === ARCHITECT_MODEL_ID);
  if (existing >= 0) additional[existing] = { ...additional[existing], ...ASTRA_MODEL, isDefault: additional[existing].isDefault };
  else additional.push({ ...ASTRA_MODEL, isDefault: false });
  providers.codex = { ...codex, additionalModels: additional };

  next.daemon = next.daemon ?? {};
  const profiles = Array.isArray(next.daemon.agentProfiles) ? [...next.daemon.agentProfiles] : [];
  const profile = architectProfile();
  const index = profiles.findIndex((item) => item?.id === ARCHITECT_PROFILE_ID);
  if (index >= 0) profiles[index] = { ...profiles[index], ...profile };
  else profiles.unshift(profile);
  next.daemon.agentProfiles = profiles;
  return next;
}

export function sdkConfigPatch() {
  return {
    providers: {
      [ARCHITECT_PROVIDER_ID]: architectProvider(),
      codex: { additionalModels: [{ ...ASTRA_MODEL, isDefault: false }] },
    },
    agentProfiles: undefined,
  };
}
