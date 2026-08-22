// Land-run store: one JSON file per land run, beside DSH_HOME.
//
// Mode 0600, atomic write, restart-safe. Indexed by run id and by the live
// implementer/QA session so `done` and `qa_verdict` can find the handoff.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

export const LAND_RUN_SCHEMA = "qq.land-run/v1";
export const LAND_STATUSES = Object.freeze([
  "running",
  "reviewing",
  "waiting_fix",
  "landing",
  "landed",
  "blocked",
]);

const STATUS_SET = new Set(LAND_STATUSES);

function requireAbsolute(path, label) {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new Error(`qq-workflows: ${label} must be an absolute path`);
  }
  return path;
}

/** Default land-run directory: a folder beside DSH_HOME. */
export function defaultLandDir(env = process.env, config = {}) {
  if (config.landDir !== undefined) {
    return requireAbsolute(config.landDir, "landDir");
  }
  const dshHome = env.DSH_HOME?.trim();
  if (dshHome) {
    return join(dirname(requireAbsolute(dshHome, "DSH_HOME")), ".qq-workflows-land");
  }
  const home = env.HOME || homedir();
  return join(requireAbsolute(home, "HOME"), ".qq-workflows-land");
}

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : "";
}

function snapshot(record) {
  return structuredClone(record);
}

function normalizePacket(packet) {
  if (!packet || typeof packet !== "object") return null;
  if (packet.schema !== "qq.route-packet/v1") return null;
  return {
    schema: packet.schema,
    brief: optionalString(packet.brief),
    files: Array.isArray(packet.files)
      ? packet.files.map((file) => ({
        path: String(file?.path ?? ""),
        added: file?.added ?? null,
        deleted: file?.deleted ?? null,
      }))
      : [],
    pointers: Array.isArray(packet.pointers) ? packet.pointers.map((item) => String(item)) : [],
    mark: packet.mark ?? null,
  };
}

function normalize(raw) {
  if (!raw || raw.schema !== LAND_RUN_SCHEMA || raw.version !== 1 || typeof raw.id !== "string" || !raw.id) {
    throw new Error("qq-workflows: land run is malformed");
  }
  if (!STATUS_SET.has(raw.status)) {
    throw new Error(`qq-workflows: land run ${raw.id} has unknown status ${raw.status}`);
  }
  if (!Number.isSafeInteger(raw.look) || raw.look < 0 || raw.look > 2) {
    throw new Error(`qq-workflows: land run ${raw.id} look is invalid`);
  }
  return {
    schema: LAND_RUN_SCHEMA,
    version: 1,
    id: raw.id,
    status: raw.status,
    look: raw.look,
    architectSession: optionalString(raw.architectSession),
    implementerSession: optionalString(raw.implementerSession),
    originalImplementerSession: optionalString(raw.originalImplementerSession),
    qaSession: optionalString(raw.qaSession),
    worktree: optionalString(raw.worktree),
    mainRoot: optionalString(raw.mainRoot),
    branch: optionalString(raw.branch),
    baseBranch: optionalString(raw.baseBranch) || "main",
    baseRef: optionalString(raw.baseRef),
    ref: optionalString(raw.ref),
    brief: optionalString(raw.brief),
    packet: normalizePacket(raw.packet),
    qaVerdict: raw.qaVerdict && typeof raw.qaVerdict === "object" ? { ...raw.qaVerdict } : null,
    blockedReason: optionalString(raw.blockedReason),
    landedAt: optionalString(raw.landedAt),
    inspectError: optionalString(raw.inspectError),
    createdAt: optionalString(raw.createdAt),
    updatedAt: optionalString(raw.updatedAt),
  };
}

export function createLandStore(dirPath) {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });

  function fileFor(id) {
    return join(dirPath, `${id}.json`);
  }

  function persist(record) {
    const file = fileFor(record.id);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  }

  function readFile(id) {
    const file = fileFor(id);
    if (!existsSync(file)) return null;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`qq-workflows: land run ${file} is malformed`, { cause: error });
    }
    return normalize(parsed);
  }

  function listIds() {
    try {
      return readdirSync(dirPath).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
    } catch {
      return [];
    }
  }

  const store = {
    dirPath,
    fileFor,

    create(fields = {}) {
      const now = new Date().toISOString();
      const id = optionalString(fields.id) || `land-${randomUUID().slice(0, 8)}`;
      const implementer = optionalString(fields.implementerSession);
      const record = normalize({
        schema: LAND_RUN_SCHEMA,
        version: 1,
        id,
        status: fields.status ?? "running",
        look: Number.isSafeInteger(fields.look) ? fields.look : 0,
        architectSession: fields.architectSession,
        implementerSession: implementer,
        originalImplementerSession: fields.originalImplementerSession || implementer,
        qaSession: fields.qaSession,
        worktree: fields.worktree,
        mainRoot: fields.mainRoot,
        branch: fields.branch,
        baseBranch: fields.baseBranch,
        baseRef: fields.baseRef,
        ref: fields.ref,
        brief: fields.brief,
        packet: fields.packet,
        qaVerdict: fields.qaVerdict,
        blockedReason: fields.blockedReason,
        landedAt: fields.landedAt,
        inspectError: fields.inspectError,
        createdAt: fields.createdAt ?? now,
        updatedAt: fields.updatedAt ?? now,
      });
      persist(record);
      return snapshot(record);
    },

    load(id) {
      const record = readFile(id);
      return record ? snapshot(record) : null;
    },

    save(record) {
      const next = normalize({
        ...record,
        schema: LAND_RUN_SCHEMA,
        version: 1,
        updatedAt: new Date().toISOString(),
      });
      persist(next);
      return snapshot(next);
    },

    list() {
      return listIds().map((id) => store.load(id)).filter(Boolean);
    },

    bySession(sessionId) {
      if (!sessionId) return null;
      for (const record of store.list()) {
        if (
          record.implementerSession === sessionId
          || record.originalImplementerSession === sessionId
          || record.qaSession === sessionId
        ) {
          return record;
        }
      }
      return null;
    },
  };

  return Object.freeze(store);
}
