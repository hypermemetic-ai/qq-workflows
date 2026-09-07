import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
export const AGY_ROLE_ENTRY = join(PLUGIN_ROOT, "host", "agy-role.mjs");

export const ARCHITECT_PROVIDER_ID = "architect";
export const ARCHITECT_MODEL_ID = "Gemini 3.8 Flash";
export const ARCHITECT_PROFILE_ID = "architect";
export const ARCHITECT_ROLES = Object.freeze(["architect", "teacher", "implementer", "researcher", "reviewer"]);

export function realAgyBin(env = process.env) {
  return env.REAL_AGY_BIN || "/home/qqp/.local/bin/agy";
}

export function ensureAgentsAndMcpInstalled({ home = homedir(), pluginRoot = PLUGIN_ROOT } = {}) {
  const agentsDir = join(home, ".gemini", "config", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const role of ARCHITECT_ROLES) {
    const sourceFile = join(pluginRoot, "agents", role, "agent.md");
    if (!existsSync(sourceFile)) continue;
    const targetRoleDir = join(agentsDir, role);
    mkdirSync(targetRoleDir, { recursive: true });
    const targetFile = join(targetRoleDir, "agent.md");
    try {
      const stat = lstatSync(targetFile, { throwIfNoEntry: false });
      if (stat) {
        rmSync(targetFile, { force: true });
      }
      symlinkSync(sourceFile, targetFile);
    } catch {
      try {
        writeFileSync(targetFile, readFileSync(sourceFile, "utf8"), "utf8");
      } catch (copyErr) {
        console.error(`Failed to install agent.md for ${role}`, copyErr);
      }
    }
  }

  const mcpConfigPath = join(home, ".gemini", "config", "mcp_config.json");
  let mcpConfig = { mcpServers: {} };
  try {
    if (existsSync(mcpConfigPath)) {
      mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
    }
  } catch {
    mcpConfig = { mcpServers: {} };
  }
  mcpConfig.mcpServers = mcpConfig.mcpServers || {};
  mcpConfig.mcpServers.architect = {
    command: process.execPath,
    args: [CHILD_MCP_ENTRY],
  };
  try {
    mkdirSync(dirname(mcpConfigPath), { recursive: true });
    writeFileSync(mcpConfigPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, "utf8");
  } catch (error) {
    console.error("Failed to write mcp_config.json", error);
  }
}

export const ASTRA_THINKING = Object.freeze([
  { id: "low", label: "low", description: "Fast responses with lighter reasoning" },
  { id: "medium", label: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { id: "high", label: "high", description: "Greater reasoning depth for complex problems", isDefault: true },
  { id: "xhigh", label: "xhigh", description: "Extra high reasoning depth for complex problems" },
]);

export const ASTRA_MODEL = Object.freeze({
  id: "gpt-6-astra",
  label: "GPT-6 Astra",
  description: "GPT-6 Astra",
  isDefault: true,
  defaultThinkingOptionId: "high",
  thinkingOptions: ASTRA_THINKING,
});

export const GEMINI_FLASH_THINKING = Object.freeze([
  { id: "High", label: "High", description: "High reasoning effort", isDefault: true },
]);

export const GEMINI_FLASH_MODEL = Object.freeze({
  id: ARCHITECT_MODEL_ID,
  label: "Gemini 3.8 Flash",
  description: "Gemini 3.8 Flash",
  isDefault: true,
  defaultThinkingOptionId: "High",
  thinkingOptions: GEMINI_FLASH_THINKING,
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
    description: "Ticket-driven architect with Google Antigravity Gemini 3.8 Flash.",
    command: ["npx", "-y", "agy-acp@0.5.2"],
    env: {
      AGY_BIN: AGY_ROLE_ENTRY,
      REAL_AGY_BIN: realAgyBin(),
      ARCHITECT_ROLE: "architect",
      PATH: process.env.PATH || "/home/qqp/.local/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin",
    },
    models: [GEMINI_FLASH_MODEL],
  };
}

export function architectProfile() {
  return {
    id: ARCHITECT_PROFILE_ID,
    name: "Architect",
    icon: "compass",
    provider: ARCHITECT_PROVIDER_ID,
    model: ARCHITECT_MODEL_ID,
    thinkingOptionId: "High",
    notes:
      "Ticket-driven architect using Antigravity Gemini 3.8 Flash. Pins `.architect/ticket.md`, and delegates implementer, teacher, or researcher.",
  };
}

export function daemonConfigPatch(config) {
  try {
    ensureAgentsAndMcpInstalled();
  } catch (err) {
    console.error("ensureAgentsAndMcpInstalled failed:", err);
  }
  const next = structuredClone(config ?? {});
  const providers = next.providers ?? {};
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
  if (providers.agy) {
    providers.agy = {
      ...providers.agy,
      env: {
        ...(providers.agy.env ?? {}),
        AGY_BIN: AGY_ROLE_ENTRY,
        REAL_AGY_BIN: providers.agy.env?.REAL_AGY_BIN || realAgyBin(),
      },
    };
  }
  const codex = providers.codex && typeof providers.codex === "object" ? providers.codex : {};
  const additional = Array.isArray(codex.additionalModels) ? [...codex.additionalModels] : [];
  const existing = additional.findIndex((model) => model?.id === ASTRA_MODEL.id);
  if (existing >= 0) additional[existing] = { ...additional[existing], ...ASTRA_MODEL, isDefault: additional[existing].isDefault };
  else additional.push({ ...ASTRA_MODEL, isDefault: false });
  providers.codex = { ...codex, additionalModels: additional };

  const profiles = Array.isArray(next.agentProfiles) ? [...next.agentProfiles] : [];
  const profile = architectProfile();
  const index = profiles.findIndex((item) => item?.id === ARCHITECT_PROFILE_ID);
  if (index >= 0) profiles[index] = { ...profiles[index], ...profile };
  else profiles.unshift(profile);
  return { providers, agentProfiles: profiles };
}

export const PASEO_HOME = process.env.PASEO_HOME || join(homedir(), ".paseo");
export const STATE_DIR = join(PASEO_HOME, "architect");
export const HOST_META_PATH = join(STATE_DIR, "host.json");
