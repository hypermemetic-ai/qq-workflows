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
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DELEGATION_ID = UUID_ID;
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const LAND_WORKFLOW_ROLES = Object.freeze(["implementer", "qa-look-1", "fixer", "qa-look-2"]);
const WORKFLOW_ROLE_SET = new Set(LAND_WORKFLOW_ROLES);
const TERMINAL_STATUSES = new Set(["landed", "blocked"]);

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

function legacyRole(raw, sessionUuid) {
  if (raw.qaSession === sessionUuid) return raw.look === 2 ? "qa-look-2" : "qa-look-1";
  if (raw.implementerSession === sessionUuid) {
    return raw.originalImplementerSession === sessionUuid ? "implementer" : "fixer";
  }
  return "";
}

function legacyEpoch(raw, role) {
  if (role === "implementer") return 1;
  if (role === "qa-look-1") return 2;
  if (role === "fixer") return 3;
  if (role === "qa-look-2") return 4;
  if (raw.look === 2) return 4;
  if (raw.look === 1 && raw.qaVerdict) return 2;
  return 0;
}

function upgradeLegacy(raw) {
  const next = { ...raw };
  let changed = false;
  if (!Object.hasOwn(next, "delegationId")) {
    next.delegationId = randomUUID();
    changed = true;
  }
  if (!Object.hasOwn(next, "parentSessionUuid")) {
    next.parentSessionUuid = optionalString(next.architectSession);
    changed = true;
  }
  if (!Object.hasOwn(next, "current")) {
    let sessionUuid = "";
    if (!TERMINAL_STATUSES.has(next.status)) {
      if (next.status === "reviewing" && next.qaSession) sessionUuid = optionalString(next.qaSession);
      else if (next.status === "waiting_fix" && next.implementerSession) sessionUuid = optionalString(next.implementerSession);
      else sessionUuid = optionalString(next.implementerSession || next.qaSession);
    }
    const role = legacyRole(next, sessionUuid);
    const epoch = legacyEpoch(next, role);
    next.current = sessionUuid && role ? { sessionUuid, role, phaseEpoch: epoch } : null;
    if (!Object.hasOwn(next, "phaseEpoch")) next.phaseEpoch = epoch;
    changed = true;
  }
  if (!Object.hasOwn(next, "phaseEpoch")) {
    next.phaseEpoch = Number.isSafeInteger(next.current?.phaseEpoch) ? next.current.phaseEpoch : 0;
    changed = true;
  }
  if (!Object.hasOwn(next, "transitioning")) {
    next.transitioning = !TERMINAL_STATUSES.has(next.status) && (
      next.status === "landing"
      || (next.status === "reviewing" && !next.qaSession)
      || (next.status === "waiting_fix" && !next.implementerSession)
    );
    changed = true;
  }
  if (!Object.hasOwn(next, "pendingPhase")) {
    next.pendingPhase = null;
    changed = true;
  }
  if (!Object.hasOwn(next, "reportEnvelopeId")) {
    next.reportEnvelopeId = next.reportPending === true ? randomUUID() : "";
    changed = true;
  }
  return { raw: next, changed };
}

function normalizeCurrent(raw, phaseEpoch) {
  if (raw == null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("qq-workflows: land run current pointer is malformed");
  }
  const sessionUuid = optionalString(raw.sessionUuid);
  const role = optionalString(raw.role);
  if (!SESSION_ID.test(sessionUuid) || !WORKFLOW_ROLE_SET.has(role)) {
    throw new Error("qq-workflows: land run current pointer is malformed");
  }
  if (!Number.isSafeInteger(raw.phaseEpoch) || raw.phaseEpoch < 1 || raw.phaseEpoch !== phaseEpoch) {
    throw new Error("qq-workflows: land run current pointer epoch is invalid");
  }
  return { sessionUuid, role, phaseEpoch };
}

function normalizePendingPhase(raw, phaseEpoch) {
  if (raw == null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("qq-workflows: land run pending phase is malformed");
  }
  const sessionUuid = optionalString(raw.sessionUuid);
  const role = optionalString(raw.role);
  if (!SESSION_ID.test(sessionUuid) || !WORKFLOW_ROLE_SET.has(role)) {
    throw new Error("qq-workflows: land run pending phase is malformed");
  }
  if (!Number.isSafeInteger(raw.phaseEpoch) || raw.phaseEpoch !== phaseEpoch + 1) {
    throw new Error("qq-workflows: land run pending phase epoch is invalid");
  }
  return { sessionUuid, role, phaseEpoch: raw.phaseEpoch };
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
  if (!DELEGATION_ID.test(raw.delegationId ?? "")) {
    throw new Error(`qq-workflows: land run ${raw.id} delegation id is invalid`);
  }
  if (!Number.isSafeInteger(raw.phaseEpoch) || raw.phaseEpoch < 0) {
    throw new Error(`qq-workflows: land run ${raw.id} phase epoch is invalid`);
  }
  const parentSessionUuid = optionalString(raw.parentSessionUuid) || optionalString(raw.architectSession);
  if (parentSessionUuid && !SESSION_ID.test(parentSessionUuid)) {
    throw new Error(`qq-workflows: land run ${raw.id} parent session is invalid`);
  }
  const current = normalizeCurrent(raw.current, raw.phaseEpoch);
  const pendingPhase = normalizePendingPhase(raw.pendingPhase, raw.phaseEpoch);
  if (pendingPhase && raw.transitioning !== true) {
    throw new Error(`qq-workflows: land run ${raw.id} has a pending phase outside a transition`);
  }
  if (pendingPhase && pendingPhase.sessionUuid === current?.sessionUuid) {
    throw new Error(`qq-workflows: land run ${raw.id} pending phase repeats the current child`);
  }
  if (TERMINAL_STATUSES.has(raw.status) && (current || pendingPhase || raw.transitioning === true)) {
    throw new Error(`qq-workflows: terminal land run ${raw.id} has an active phase pointer`);
  }
  const reportEnvelopeId = optionalString(raw.reportEnvelopeId);
  if (reportEnvelopeId && !UUID_ID.test(reportEnvelopeId)) {
    throw new Error(`qq-workflows: land run ${raw.id} report envelope id is invalid`);
  }
  if (raw.reportPending === true && parentSessionUuid && !reportEnvelopeId) {
    throw new Error(`qq-workflows: land run ${raw.id} pending report has no envelope id`);
  }
  return {
    schema: LAND_RUN_SCHEMA,
    version: 1,
    id: raw.id,
    status: raw.status,
    look: raw.look,
    delegationId: raw.delegationId.toLowerCase(),
    parentSessionUuid,
    phaseEpoch: raw.phaseEpoch,
    current,
    transitioning: raw.transitioning === true,
    pendingPhase,
    architectSession: optionalString(raw.architectSession) || optionalString(raw.parentSessionUuid),
    taskId: optionalString(raw.taskId),
    archivedTaskId: optionalString(raw.archivedTaskId),
    archiveError: optionalString(raw.archiveError),
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
    reportPending: raw.reportPending === true,
    reportEnvelopeId,
    reportKind: optionalString(raw.reportKind),
    reportFromSession: optionalString(raw.reportFromSession),
    settlementSession: optionalString(raw.settlementSession),
    settlementCallId: optionalString(raw.settlementCallId),
    settlementTransition: optionalString(raw.settlementTransition),
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
    const upgraded = upgradeLegacy(parsed);
    const record = normalize(upgraded.raw);
    if (upgraded.changed) persist(record);
    return record;
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
      if (existsSync(fileFor(id))) throw new Error(`qq-workflows: land run ${id} already exists`);
      const implementer = optionalString(fields.implementerSession);
      const delegationId = optionalString(fields.delegationId) || randomUUID();
      if (store.byDelegation(delegationId)) {
        throw new Error(`qq-workflows: delegation ${delegationId} already exists`);
      }
      const initialEpoch = Number.isSafeInteger(fields.phaseEpoch)
        ? fields.phaseEpoch
        : (implementer ? 1 : 0);
      const initialCurrent = fields.current === undefined
        ? (implementer ? { sessionUuid: implementer, role: "implementer", phaseEpoch: initialEpoch } : null)
        : fields.current;
      const record = normalize({
        schema: LAND_RUN_SCHEMA,
        version: 1,
        id,
        status: fields.status ?? "running",
        look: Number.isSafeInteger(fields.look) ? fields.look : 0,
        delegationId,
        parentSessionUuid: fields.parentSessionUuid || fields.architectSession,
        phaseEpoch: initialEpoch,
        current: initialCurrent,
        transitioning: fields.transitioning === true,
        pendingPhase: fields.pendingPhase ?? null,
        architectSession: fields.architectSession || fields.parentSessionUuid,
        taskId: fields.taskId,
        archivedTaskId: fields.archivedTaskId,
        archiveError: fields.archiveError,
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
        reportPending: fields.reportPending,
        reportEnvelopeId: fields.reportEnvelopeId,
        reportKind: fields.reportKind,
        reportFromSession: fields.reportFromSession,
        settlementSession: fields.settlementSession,
        settlementCallId: fields.settlementCallId,
        settlementTransition: fields.settlementTransition,
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
      const previous = readFile(record?.id);
      if (!previous) throw new Error(`qq-workflows: land run ${String(record?.id ?? "")} does not exist`);
      const next = normalize({
        ...record,
        schema: LAND_RUN_SCHEMA,
        version: 1,
        updatedAt: new Date().toISOString(),
      });
      if (next.delegationId !== previous.delegationId) {
        throw new Error(`qq-workflows: land run ${next.id} delegation id is immutable`);
      }
      if (next.parentSessionUuid !== previous.parentSessionUuid) {
        throw new Error(`qq-workflows: land run ${next.id} parent session is immutable`);
      }
      if (previous.reportEnvelopeId && next.reportEnvelopeId !== previous.reportEnvelopeId) {
        throw new Error(`qq-workflows: land run ${next.id} report envelope id is immutable`);
      }
      if (next.phaseEpoch < previous.phaseEpoch) {
        throw new Error(`qq-workflows: land run ${next.id} phase epoch cannot regress`);
      }
      const pointerChanged = Boolean(next.current) && (
        !previous.current
        || next.current.sessionUuid !== previous.current.sessionUuid
        || next.current.role !== previous.current.role
      );
      if (pointerChanged && next.phaseEpoch <= previous.phaseEpoch) {
        throw new Error(`qq-workflows: land run ${next.id} phase pointer requires a newer epoch`);
      }
      if (previous.pendingPhase) {
        const samePlan = next.pendingPhase
          && next.pendingPhase.sessionUuid === previous.pendingPhase.sessionUuid
          && next.pendingPhase.role === previous.pendingPhase.role
          && next.pendingPhase.phaseEpoch === previous.pendingPhase.phaseEpoch;
        if (next.pendingPhase && !samePlan) {
          throw new Error(`qq-workflows: land run ${next.id} pending phase is immutable`);
        }
        const promoted = next.current
          && next.current.sessionUuid === previous.pendingPhase.sessionUuid
          && next.current.role === previous.pendingPhase.role
          && next.current.phaseEpoch === previous.pendingPhase.phaseEpoch;
        if (!next.pendingPhase && !promoted && !TERMINAL_STATUSES.has(next.status)) {
          throw new Error(`qq-workflows: land run ${next.id} must promote its pending phase exactly`);
        }
      }
      persist(next);
      return snapshot(next);
    },

    list() {
      return listIds().map((id) => store.load(id)).filter(Boolean);
    },

    byDelegation(delegationId) {
      if (!DELEGATION_ID.test(delegationId ?? "")) return null;
      let found = null;
      for (const record of store.list()) {
        if (record.delegationId !== delegationId.toLowerCase()) continue;
        if (found) throw new Error(`qq-workflows: duplicate delegation id ${delegationId}`);
        found = record;
      }
      return found;
    },

    bySession(sessionId) {
      if (!sessionId) return null;
      for (const record of store.list()) {
        if (
          record.implementerSession === sessionId
          || record.originalImplementerSession === sessionId
          || record.qaSession === sessionId
          || record.pendingPhase?.sessionUuid === sessionId
        ) {
          return record;
        }
      }
      return null;
    },
  };

  return Object.freeze(store);
}
