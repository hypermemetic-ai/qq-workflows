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
export const ITERATE_SETTINGS_SCHEMA = "qq.workflows-iterate-settings/v1";
export const LAND_SETTINGS_SCHEMA = "qq.workflows-land-settings/v1";
export const BASE_SETTINGS_SCHEMA = "qq.workflows-base-settings/v1";
export const ARCHITECT_ROLES = Object.freeze(["talking", "scribe"]);
export const ITERATE_ROLES = Object.freeze(["desk", "hands", "reviewer"]);
export const LAND_ROLES = Object.freeze(["router", "qa", "implementer"]);
export const BASE_ROLES = Object.freeze(["talking"]);

function emptyArchitectRoles() {
  return { talking: null, scribe: null };
}

function emptyIterateRoles() {
  return { desk: null, hands: null, reviewer: null };
}

function emptyLandRoles() {
  return { router: null, qa: null, implementer: null };
}

function emptyBaseRoles() {
  return { talking: null };
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

function normalizeIterateSection(raw) {
  if (!raw || typeof raw !== "object") return { schema: ITERATE_SETTINGS_SCHEMA, roles: emptyIterateRoles() };
  if (raw.schema && raw.schema !== ITERATE_SETTINGS_SCHEMA) {
    throw new Error("qq-workflows: iterate settings are malformed");
  }
  const roles = raw.roles && typeof raw.roles === "object" ? raw.roles : raw;
  return {
    schema: ITERATE_SETTINGS_SCHEMA,
    roles: {
      desk: normalizeBinding(roles.desk),
      hands: normalizeBinding(roles.hands),
      reviewer: normalizeBinding(roles.reviewer),
    },
  };
}

function persist(path, record) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function readRaw(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`qq-workflows: settings ${path} are malformed`, { cause: error });
  }
}

/** Keep unknown keys (iterate section) when architect rewrites roles. */
function persistArchitect(path, record) {
  const previous = readRaw(path) ?? {};
  persist(path, { ...previous, schema: record.schema, roles: record.roles });
}

/** Workflow-owned settings for architect: talking + scribe. */
export function createArchitectSettings({ settingsFile } = {}) {
  const path = typeof settingsFile === "string" && isAbsolute(settingsFile) ? settingsFile : null;

  function load() {
    if (!path || !existsSync(path)) {
      return { schema: ARCHITECT_SETTINGS_SCHEMA, roles: emptyArchitectRoles(), unbound: true };
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
      const current = existsSync(path) ? load() : { schema: ARCHITECT_SETTINGS_SCHEMA, roles: emptyArchitectRoles() };
      current.roles[role] = next;
      persistArchitect(path, { schema: ARCHITECT_SETTINGS_SCHEMA, roles: current.roles });
      return next;
    },
  });
}

/** Workflow-owned settings for iterate: desk + hands + reviewer. Same settingsFile. */
export function createIterateSettings({ settingsFile } = {}) {
  const path = typeof settingsFile === "string" && isAbsolute(settingsFile) ? settingsFile : null;

  function load() {
    if (!path || !existsSync(path)) {
      return { schema: ITERATE_SETTINGS_SCHEMA, roles: emptyIterateRoles(), unbound: true };
    }
    const parsed = readRaw(path);
    const section = parsed?.iterate;
    return { ...normalizeIterateSection(section), unbound: false };
  }

  return Object.freeze({
    path,
    unbound: () => path === null || !existsSync(path),
    list() {
      const loaded = load();
      return {
        unbound: loaded.unbound,
        roles: {
          desk: loaded.roles.desk,
          hands: loaded.roles.hands,
          reviewer: loaded.roles.reviewer,
        },
      };
    },
    get(role) {
      if (!ITERATE_ROLES.includes(role)) return null;
      return load().roles[role];
    },
    write(role, binding) {
      if (!path) {
        throw new Error("qq-workflows: iterate settings are unbound (no settingsFile)");
      }
      if (!ITERATE_ROLES.includes(role)) {
        throw new Error(`qq-workflows: unknown iterate role ${role}`);
      }
      const next = normalizeBinding(binding);
      if (!next) {
        throw new Error("qq-workflows: role binding requires provider and model");
      }
      const previous = readRaw(path) ?? {
        schema: ARCHITECT_SETTINGS_SCHEMA,
        roles: emptyArchitectRoles(),
      };
      const iterate = normalizeIterateSection(previous.iterate);
      iterate.roles[role] = next;
      persist(path, { ...previous, iterate });
      return next;
    },
  });
}

function normalizeLandSection(raw) {
  if (!raw || typeof raw !== "object") return { schema: LAND_SETTINGS_SCHEMA, roles: emptyLandRoles() };
  if (raw.schema && raw.schema !== LAND_SETTINGS_SCHEMA) {
    throw new Error("qq-workflows: land settings are malformed");
  }
  const roles = raw.roles && typeof raw.roles === "object" ? raw.roles : raw;
  return {
    schema: LAND_SETTINGS_SCHEMA,
    roles: {
      router: normalizeBinding(roles.router),
      qa: normalizeBinding(roles.qa),
      implementer: normalizeBinding(roles.implementer),
    },
  };
}

/** Workflow-owned settings for land: router + qa + implementer. Same settingsFile. */
export function createLandSettings({ settingsFile } = {}) {
  const path = typeof settingsFile === "string" && isAbsolute(settingsFile) ? settingsFile : null;

  function load() {
    if (!path || !existsSync(path)) {
      return { schema: LAND_SETTINGS_SCHEMA, roles: emptyLandRoles(), unbound: true };
    }
    const parsed = readRaw(path);
    const section = parsed?.land;
    return { ...normalizeLandSection(section), unbound: false };
  }

  return Object.freeze({
    path,
    unbound: () => path === null || !existsSync(path),
    list() {
      const loaded = load();
      return {
        unbound: loaded.unbound,
        roles: {
          router: loaded.roles.router,
          qa: loaded.roles.qa,
          implementer: loaded.roles.implementer,
        },
      };
    },
    get(role) {
      if (!LAND_ROLES.includes(role)) return null;
      return load().roles[role];
    },
    write(role, binding) {
      if (!path) {
        throw new Error("qq-workflows: land settings are unbound (no settingsFile)");
      }
      if (!LAND_ROLES.includes(role)) {
        throw new Error(`qq-workflows: unknown land role ${role}`);
      }
      const next = normalizeBinding(binding);
      if (!next) {
        throw new Error("qq-workflows: role binding requires provider and model");
      }
      const previous = readRaw(path) ?? {
        schema: ARCHITECT_SETTINGS_SCHEMA,
        roles: emptyArchitectRoles(),
      };
      const land = normalizeLandSection(previous.land);
      land.roles[role] = next;
      persist(path, { ...previous, land });
      return next;
    },
  });
}

function normalizeBaseSection(raw) {
  if (!raw || typeof raw !== "object") return { schema: BASE_SETTINGS_SCHEMA, roles: emptyBaseRoles() };
  if (raw.schema && raw.schema !== BASE_SETTINGS_SCHEMA) {
    throw new Error("qq-workflows: base settings are malformed");
  }
  const roles = raw.roles && typeof raw.roles === "object" ? raw.roles : raw;
  return {
    schema: BASE_SETTINGS_SCHEMA,
    roles: { talking: normalizeBinding(roles.talking) },
  };
}

/** Workflow-owned settings for the floor chair: one talking seat. Same settingsFile. */
export function createBaseSettings({ settingsFile } = {}) {
  const path = typeof settingsFile === "string" && isAbsolute(settingsFile) ? settingsFile : null;

  function load() {
    if (!path || !existsSync(path)) {
      return { schema: BASE_SETTINGS_SCHEMA, roles: emptyBaseRoles(), unbound: true };
    }
    const parsed = readRaw(path);
    const section = parsed?.base;
    return { ...normalizeBaseSection(section), unbound: false };
  }

  return Object.freeze({
    path,
    unbound: () => path === null || !existsSync(path),
    list() {
      const loaded = load();
      return { unbound: loaded.unbound, roles: { talking: loaded.roles.talking } };
    },
    get(role) {
      if (!BASE_ROLES.includes(role)) return null;
      return load().roles[role];
    },
    write(role, binding) {
      if (!path) {
        throw new Error("qq-workflows: base settings are unbound (no settingsFile)");
      }
      if (!BASE_ROLES.includes(role)) {
        throw new Error(`qq-workflows: unknown base role ${role}`);
      }
      const next = normalizeBinding(binding);
      if (!next) {
        throw new Error("qq-workflows: role binding requires provider and model");
      }
      const previous = readRaw(path) ?? {
        schema: ARCHITECT_SETTINGS_SCHEMA,
        roles: emptyArchitectRoles(),
      };
      const base = normalizeBaseSection(previous.base);
      base.roles[role] = next;
      persist(path, { ...previous, base });
      return next;
    },
  });
}

export function formatSettingsList(name, snapshot, roles = ARCHITECT_ROLES) {
  if (!snapshot || snapshot.unbound) return `${name} roles: unbound`;
  const lines = [`${name} roles:`];
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
