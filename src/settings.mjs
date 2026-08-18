// Architect-owned role bindings. The wrapper never opens this file.
//
// Attach config requires an absolute settingsFile. Missing or relative path,
// or a missing file at a declared path, is unbound. Writes create the file.
// This is not ~/.config/qq/execution-profiles.json.

import { dirname, isAbsolute } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

export const ARCHITECT_SETTINGS_SCHEMA = "qq.workflows-architect-settings/v1";
export const ARCHITECT_ROLES = Object.freeze(["talking", "scribe"]);

function emptyRoles() {
  return { talking: null, scribe: null };
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

function normalize(raw) {
  if (!raw || raw.schema !== ARCHITECT_SETTINGS_SCHEMA || !raw.roles || typeof raw.roles !== "object") {
    throw new Error("qq-workflows: architect settings are malformed");
  }
  return {
    schema: ARCHITECT_SETTINGS_SCHEMA,
    roles: {
      talking: normalizeBinding(raw.roles.talking),
      scribe: normalizeBinding(raw.roles.scribe),
    },
  };
}

function persist(path, record) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Workflow-owned settings for architect: talking + scribe. */
export function createArchitectSettings({ settingsFile } = {}) {
  const path = typeof settingsFile === "string" && isAbsolute(settingsFile) ? settingsFile : null;

  function load() {
    if (!path || !existsSync(path)) {
      return { schema: ARCHITECT_SETTINGS_SCHEMA, roles: emptyRoles(), unbound: true };
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`qq-workflows: architect settings ${path} are malformed`, { cause: error });
    }
    return { ...normalize(parsed), unbound: false };
  }

  return Object.freeze({
    path,
    unbound: () => path === null || !existsSync(path),
    list() {
      const loaded = load();
      return {
        unbound: loaded.unbound,
        roles: { talking: loaded.roles.talking, scribe: loaded.roles.scribe },
      };
    },
    get(role) {
      if (!ARCHITECT_ROLES.includes(role)) return null;
      return load().roles[role];
    },
    write(role, binding) {
      if (!path) {
        throw new Error("qq-workflows: architect settings are unbound (no settingsFile)");
      }
      if (!ARCHITECT_ROLES.includes(role)) {
        throw new Error(`qq-workflows: unknown architect role ${role}`);
      }
      const next = normalizeBinding(binding);
      if (!next) {
        throw new Error("qq-workflows: role binding requires provider and model");
      }
      const current = existsSync(path) ? load() : { schema: ARCHITECT_SETTINGS_SCHEMA, roles: emptyRoles() };
      current.roles[role] = next;
      persist(path, { schema: ARCHITECT_SETTINGS_SCHEMA, roles: current.roles });
      return next;
    },
  });
}

export function formatSettingsList(name, snapshot) {
  if (!snapshot || snapshot.unbound) return `${name} roles: unbound`;
  const lines = [`${name} roles:`];
  for (const role of ARCHITECT_ROLES) {
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
