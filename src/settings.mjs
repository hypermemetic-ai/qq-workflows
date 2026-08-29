// Host-wide model bindings. Chairs and delegation kinds consume the same three
// seats; adopted plugins may expose additional settings through their own
// listSettings/writeSettings methods.

import { dirname, isAbsolute } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const WORKFLOW_SETTINGS_SCHEMA = "qq.workflows-settings/v2";
export const HOST_ROLES = Object.freeze(["architecture", "implementation", "qa"]);

function emptyRoles() {
  return { architecture: null, implementation: null, qa: null };
}

function normalizeBinding(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.provider !== "string" || value.provider.length === 0) return null;
  if (typeof value.model !== "string" || value.model.length === 0) return null;
  return {
    provider: value.provider,
    model: value.model,
    ...(typeof value.effort === "string" && value.effort.length > 0 ? { effort: value.effort } : {}),
  };
}

function readRaw(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object");
    return parsed;
  } catch (error) {
    throw new Error(`qq-workflows: settings ${path} are malformed`, { cause: error });
  }
}

/** Read legacy seat names once without continuing to expose them publicly. */
function normalize(raw) {
  const roles = raw?.roles && typeof raw.roles === "object" ? raw.roles : {};
  const oldLand = raw?.land?.roles && typeof raw.land.roles === "object"
    ? raw.land.roles
    : (raw?.land && typeof raw.land === "object" ? raw.land : {});
  const oldBase = raw?.base?.roles && typeof raw.base.roles === "object"
    ? raw.base.roles
    : (raw?.base && typeof raw.base === "object" ? raw.base : {});
  return {
    schema: WORKFLOW_SETTINGS_SCHEMA,
    roles: {
      architecture: normalizeBinding(roles.architecture ?? roles.talking ?? oldBase.talking),
      implementation: normalizeBinding(roles.implementation ?? roles.hands ?? oldLand.implementer),
      qa: normalizeBinding(roles.qa ?? oldLand.qa),
    },
  };
}

function persist(path, record) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function createHostSettings({ settingsFile } = {}) {
  const path = typeof settingsFile === "string" && isAbsolute(settingsFile) ? settingsFile : null;

  function load() {
    if (!path || !existsSync(path)) {
      return { schema: WORKFLOW_SETTINGS_SCHEMA, roles: emptyRoles(), unbound: true };
    }
    return { ...normalize(readRaw(path)), unbound: false };
  }

  return Object.freeze({
    path,
    unbound: () => path === null || !existsSync(path),
    list() {
      const loaded = load();
      return { unbound: loaded.unbound, roles: { ...loaded.roles } };
    },
    get(role) {
      if (!HOST_ROLES.includes(role)) return null;
      return load().roles[role];
    },
    write(role, binding) {
      if (!path) throw new Error("qq-workflows: host settings are unbound (no settingsFile)");
      if (!HOST_ROLES.includes(role)) throw new Error(`qq-workflows: unknown host binding ${role}`);
      const next = normalizeBinding(binding);
      if (!next) throw new Error("qq-workflows: binding requires provider and model");
      const previous = readRaw(path) ?? {};
      const current = normalize(previous);
      current.roles[role] = next;
      // Preserve adopted-plugin settings but remove dead built-in workflow sections.
      const { iterate: _iterate, land: _land, base: _base, ...extensions } = previous;
      persist(path, { ...extensions, schema: WORKFLOW_SETTINGS_SCHEMA, roles: current.roles });
      return next;
    },
  });
}

export function formatSettingsList(name, snapshot, roles = HOST_ROLES) {
  if (!snapshot || snapshot.unbound) return `${name} bindings: unbound`;
  const lines = [`${name} bindings:`];
  for (const role of roles) {
    const binding = snapshot.roles?.[role];
    if (!binding) {
      lines.push(`  ${role}: unbound`);
      continue;
    }
    const effort = binding.effort ? ` ${binding.effort}` : "";
    lines.push(`  ${role}: ${binding.provider} ${binding.model}${effort}`);
  }
  return lines.join("\n");
}
