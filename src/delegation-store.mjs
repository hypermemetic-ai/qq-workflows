// Durable implementation delegations: one JSON file per delegation UUID.
//
// Mode 0600, atomic write, restart-safe. Indexed by delegation UUID and live
// implementation/QA session so completion handlers can find the delegation.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

export const DELEGATION_SCHEMA = "qq.delegation/v2";
export const DELEGATION_STATUSES = Object.freeze([
  "running",
  "reviewing",
  "revising",
  "landing",
  "landed",
  "blocked",
]);

const STATUS_SET = new Set(DELEGATION_STATUSES);
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DELEGATION_ID = UUID_ID;
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DELEGATION_PHASE_ROLES = Object.freeze(["implementation", "qa"]);
const WORKFLOW_ROLE_SET = new Set(DELEGATION_PHASE_ROLES);
const TERMINAL_STATUSES = new Set(["landed", "blocked"]);

function requireAbsolute(path, label) {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new Error(`qq-workflows: ${label} must be an absolute path`);
  }
  return path;
}

function containsDelegationRecords(path) {
  try {
    return readdirSync(path).some((name) => name.endsWith(".json"));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

/** Default delegation directory: a folder beside DSH_HOME. */
export function defaultDelegationDir(env = process.env, config = {}) {
  const configured = config.delegationDir ?? config.landDir;
  if (configured !== undefined) return requireAbsolute(configured, "delegationDir");
  const dshHome = env.DSH_HOME?.trim();
  const parent = dshHome
    ? dirname(requireAbsolute(dshHome, "DSH_HOME"))
    : requireAbsolute(env.HOME || homedir(), "HOME");
  const current = join(parent, ".qq-workflows-delegations");
  const legacy = join(parent, ".qq-workflows-land");

  // Existing installations may still have live qq.land-run/v1 records in the
  // old default directory. Prefer it while the new directory has no records,
  // including when a prior buggy startup already created the new directory.
  return containsDelegationRecords(legacy) && !containsDelegationRecords(current)
    ? legacy
    : current;
}

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : "";
}

function snapshot(record) {
  return structuredClone(record);
}

function normalizePacket(packet) {
  if (!packet || typeof packet !== "object") return null;
  if (packet.schema !== "qq.delegation-packet/v1" && packet.schema !== "qq.route-packet/v1") return null;
  const files = Array.isArray(packet.files)
    ? packet.files.map((file) => ({
      path: String(file?.path ?? ""),
      added: file?.added ?? null,
      deleted: file?.deleted ?? null,
    }))
    : [];
  const fileCount = Number.isSafeInteger(packet.fileCount) && packet.fileCount >= files.length
    ? packet.fileCount
    : files.length;
  return {
    schema: "qq.delegation-packet/v1",
    // Legacy packets may contain a full brief. New compilers omit this field;
    // retaining it here keeps active/recovering legacy records lossless.
    ...(optionalString(packet.brief) ? { brief: optionalString(packet.brief) } : {}),
    fileCount,
    omittedFiles: Number.isSafeInteger(packet.omittedFiles) && packet.omittedFiles >= 0
      ? Math.max(packet.omittedFiles, fileCount - files.length)
      : Math.max(0, fileCount - files.length),
    files,
    pointers: Array.isArray(packet.pointers) ? packet.pointers.map((item) => String(item)) : [],
    pointersOmitted: packet.pointersOmitted === true,
    mark: packet.mark ?? null,
  };
}

const TASK_ARTIFACT_SCHEMA = "qq.task-artifact/v1";
const PHASE_INPUT_SCHEMA = "qq.delegation-phase-input/v1";
const SHA256 = /^[0-9a-f]{64}$/;

function normalizeTaskArtifact(raw) {
  if (raw == null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || raw.schema !== TASK_ARTIFACT_SCHEMA
    || !optionalString(raw.path) || !optionalString(raw.pointer)
    || !SHA256.test(raw.sha256 ?? "")
    || !Number.isSafeInteger(raw.bytes) || raw.bytes < 0) {
    throw new Error("qq-workflows: delegation task artifact is malformed");
  }
  return {
    schema: TASK_ARTIFACT_SCHEMA,
    path: raw.path,
    pointer: raw.pointer,
    sha256: raw.sha256,
    bytes: raw.bytes,
  };
}

function normalizePhaseInput(raw) {
  if (raw == null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || raw.schema !== PHASE_INPUT_SCHEMA
    || !optionalString(raw.taskArtifact)
    || !SHA256.test(raw.taskSha256 ?? "")
    || typeof raw.proposal !== "string" || raw.proposal.length > 12_000
    || typeof raw.delta !== "string" || raw.delta.length > 4_000) {
    throw new Error("qq-workflows: delegation pending phase input is malformed");
  }
  return {
    schema: PHASE_INPUT_SCHEMA,
    taskArtifact: raw.taskArtifact,
    taskSha256: raw.taskSha256,
    proposal: raw.proposal,
    delta: raw.delta,
  };
}

function legacyRole(raw, sessionUuid) {
  if (raw.qaSession === sessionUuid) return "qa";
  if (raw.implementationSession === sessionUuid) return "implementation";
  return "";
}

function legacyEpoch(raw, role) {
  if (role === "implementation") return raw.look === 1 ? 3 : 1;
  if (role === "qa") return raw.look === 2 ? 4 : 2;
  if (raw.look === 2) return 4;
  if (raw.look === 1 && raw.qaVerdict) return 2;
  return 0;
}

function upgradeLegacy(raw) {
  const next = { ...raw };
  let changed = false;
  const legacyMachine = next.schema === "qq.land-run/v1";
  if (legacyMachine) { next.schema = DELEGATION_SCHEMA; changed = true; }
  if (next.implementationSession === undefined) { next.implementationSession = optionalString(raw.implementerSession); changed = true; }
  if (next.originalImplementationSession === undefined) { next.originalImplementationSession = optionalString(raw.originalImplementerSession) || next.implementationSession; changed = true; }
  if (next.status === "waiting_fix") { next.status = "revising"; changed = true; }
  if (!Object.hasOwn(next, "delegationId")) {
    next.delegationId = randomUUID();
    changed = true;
  }
  if (legacyMachine && next.id !== next.delegationId) {
    next.id = next.delegationId;
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
      else if (next.status === "revising" && next.implementationSession) sessionUuid = optionalString(next.implementationSession);
      else sessionUuid = optionalString(next.implementationSession || next.qaSession);
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
      || (next.status === "revising" && !next.implementationSession)
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
    throw new Error("qq-workflows: delegation current pointer is malformed");
  }
  const sessionUuid = optionalString(raw.sessionUuid);
  let role = optionalString(raw.role);
  if (role === "implementer" || role === "fixer") role = "implementation";
  if (role === "qa-look-1" || role === "qa-look-2") role = "qa";
  if (!SESSION_ID.test(sessionUuid) || !WORKFLOW_ROLE_SET.has(role)) {
    throw new Error("qq-workflows: delegation current pointer is malformed");
  }
  if (!Number.isSafeInteger(raw.phaseEpoch) || raw.phaseEpoch < 1 || raw.phaseEpoch !== phaseEpoch) {
    throw new Error("qq-workflows: delegation current pointer epoch is invalid");
  }
  return { sessionUuid, role, phaseEpoch };
}

function normalizePendingPhase(raw, phaseEpoch) {
  if (raw == null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("qq-workflows: delegation pending phase is malformed");
  }
  const sessionUuid = optionalString(raw.sessionUuid);
  let role = optionalString(raw.role);
  if (role === "implementer" || role === "fixer") role = "implementation";
  if (role === "qa-look-1" || role === "qa-look-2") role = "qa";
  if (!SESSION_ID.test(sessionUuid) || !WORKFLOW_ROLE_SET.has(role)) {
    throw new Error("qq-workflows: delegation pending phase is malformed");
  }
  if (!Number.isSafeInteger(raw.phaseEpoch) || raw.phaseEpoch !== phaseEpoch + 1) {
    throw new Error("qq-workflows: delegation pending phase epoch is invalid");
  }
  const messageId = optionalString(raw.messageId);
  const message = optionalString(raw.message);
  const input = normalizePhaseInput(raw.input);
  const renderable = Boolean(message || input);
  if ((messageId || renderable) && (!UUID_ID.test(messageId) || !renderable)) {
    throw new Error("qq-workflows: delegation pending phase packet is malformed");
  }
  const messageDelivered = raw.messageDelivered === true;
  if (messageDelivered && (!messageId || !renderable)) {
    throw new Error("qq-workflows: delegation pending phase delivered packet is missing");
  }
  return {
    sessionUuid,
    role,
    phaseEpoch: raw.phaseEpoch,
    messageId,
    message,
    input,
    messageDelivered,
  };
}

function normalize(raw) {
  if (!raw || raw.schema !== DELEGATION_SCHEMA || raw.version !== 1 || typeof raw.id !== "string" || !raw.id) {
    throw new Error("qq-workflows: delegation is malformed");
  }
  if (!STATUS_SET.has(raw.status)) {
    throw new Error(`qq-workflows: delegation ${raw.id} has unknown status ${raw.status}`);
  }
  if (!Number.isSafeInteger(raw.look) || raw.look < 0 || raw.look > 2) {
    throw new Error(`qq-workflows: delegation ${raw.id} look is invalid`);
  }
  if (!DELEGATION_ID.test(raw.delegationId ?? "")) {
    throw new Error(`qq-workflows: delegation ${raw.id} delegation id is invalid`);
  }
  if (!DELEGATION_ID.test(raw.id) || raw.id.toLowerCase() !== raw.delegationId.toLowerCase()) {
    throw new Error("qq-workflows: delegation id must be its authoritative UUID");
  }
  if (!Number.isSafeInteger(raw.phaseEpoch) || raw.phaseEpoch < 0) {
    throw new Error(`qq-workflows: delegation ${raw.id} phase epoch is invalid`);
  }
  const parentSessionUuid = optionalString(raw.parentSessionUuid) || optionalString(raw.architectSession);
  if (parentSessionUuid && !SESSION_ID.test(parentSessionUuid)) {
    throw new Error(`qq-workflows: delegation ${raw.id} parent session is invalid`);
  }
  const current = normalizeCurrent(raw.current, raw.phaseEpoch);
  const pendingPhase = normalizePendingPhase(raw.pendingPhase, raw.phaseEpoch);
  if (pendingPhase && raw.transitioning !== true) {
    throw new Error(`qq-workflows: delegation ${raw.id} has a pending phase outside a transition`);
  }
  if (pendingPhase && pendingPhase.sessionUuid === current?.sessionUuid) {
    throw new Error(`qq-workflows: delegation ${raw.id} pending phase repeats the current child`);
  }
  if (TERMINAL_STATUSES.has(raw.status) && (current || pendingPhase || raw.transitioning === true)) {
    throw new Error(`qq-workflows: terminal delegation ${raw.id} has an active phase pointer`);
  }
  const reportEnvelopeId = optionalString(raw.reportEnvelopeId);
  if (reportEnvelopeId && !UUID_ID.test(reportEnvelopeId)) {
    throw new Error(`qq-workflows: delegation ${raw.id} report envelope id is invalid`);
  }
  if (raw.reportPending === true && parentSessionUuid && !reportEnvelopeId) {
    throw new Error(`qq-workflows: delegation ${raw.id} pending report has no envelope id`);
  }
  return {
    schema: DELEGATION_SCHEMA,
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
    implementationSession: optionalString(raw.implementationSession),
    originalImplementationSession: optionalString(raw.originalImplementationSession),
    qaSession: optionalString(raw.qaSession),
    worktree: optionalString(raw.worktree),
    mainRoot: optionalString(raw.mainRoot),
    branch: optionalString(raw.branch),
    baseBranch: optionalString(raw.baseBranch) || "main",
    baseRef: optionalString(raw.baseRef),
    ref: optionalString(raw.ref),
    brief: optionalString(raw.brief),
    taskArtifact: normalizeTaskArtifact(raw.taskArtifact),
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

export function createDelegationStore(dirPath, { onChange } = {}) {
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
      throw new Error(`qq-workflows: delegation ${file} is malformed`, { cause: error });
    }
    const upgraded = upgradeLegacy(parsed);
    const record = normalize(upgraded.raw);
    if (upgraded.changed) {
      persist(record);
      if (record.id !== id) {
        try { unlinkSync(file); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
    }
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
      const delegationId = optionalString(fields.delegationId) || randomUUID();
      const id = optionalString(fields.id) || delegationId;
      if (existsSync(fileFor(id))) throw new Error(`qq-workflows: delegation ${id} already exists`);
      const implementation = optionalString(fields.implementationSession);
      if (store.byDelegation(delegationId)) {
        throw new Error(`qq-workflows: delegation ${delegationId} already exists`);
      }
      const initialEpoch = Number.isSafeInteger(fields.phaseEpoch)
        ? fields.phaseEpoch
        : (implementation ? 1 : 0);
      const initialCurrent = fields.current === undefined
        ? (implementation ? { sessionUuid: implementation, role: "implementation", phaseEpoch: initialEpoch } : null)
        : fields.current;
      const record = normalize({
        schema: DELEGATION_SCHEMA,
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
        implementationSession: implementation,
        originalImplementationSession: fields.originalImplementationSession || implementation,
        qaSession: fields.qaSession,
        worktree: fields.worktree,
        mainRoot: fields.mainRoot,
        branch: fields.branch,
        baseBranch: fields.baseBranch,
        baseRef: fields.baseRef,
        ref: fields.ref,
        brief: fields.brief,
        taskArtifact: fields.taskArtifact,
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
      const result = snapshot(record);
      onChange?.(result);
      return result;
    },

    load(id) {
      const record = readFile(id);
      return record ? snapshot(record) : null;
    },

    save(record) {
      const previous = readFile(record?.id);
      if (!previous) throw new Error(`qq-workflows: delegation ${String(record?.id ?? "")} does not exist`);
      const next = normalize({
        ...record,
        schema: DELEGATION_SCHEMA,
        version: 1,
        updatedAt: new Date().toISOString(),
      });
      if (next.delegationId !== previous.delegationId) {
        throw new Error(`qq-workflows: delegation ${next.id} delegation id is immutable`);
      }
      if (next.parentSessionUuid !== previous.parentSessionUuid) {
        throw new Error(`qq-workflows: delegation ${next.id} parent session is immutable`);
      }
      if (previous.reportEnvelopeId && next.reportEnvelopeId !== previous.reportEnvelopeId) {
        throw new Error(`qq-workflows: delegation ${next.id} report envelope id is immutable`);
      }
      if (next.phaseEpoch < previous.phaseEpoch) {
        throw new Error(`qq-workflows: delegation ${next.id} phase epoch cannot regress`);
      }
      const pointerChanged = Boolean(next.current) && (
        !previous.current
        || next.current.sessionUuid !== previous.current.sessionUuid
        || next.current.role !== previous.current.role
      );
      if (pointerChanged && next.phaseEpoch <= previous.phaseEpoch) {
        throw new Error(`qq-workflows: delegation ${next.id} phase pointer requires a newer epoch`);
      }
      if (previous.pendingPhase) {
        const samePlan = next.pendingPhase
          && next.pendingPhase.sessionUuid === previous.pendingPhase.sessionUuid
          && next.pendingPhase.role === previous.pendingPhase.role
          && next.pendingPhase.phaseEpoch === previous.pendingPhase.phaseEpoch
          && next.pendingPhase.messageId === previous.pendingPhase.messageId
          && next.pendingPhase.message === previous.pendingPhase.message
          && JSON.stringify(next.pendingPhase.input) === JSON.stringify(previous.pendingPhase.input);
        if (next.pendingPhase && !samePlan) {
          throw new Error(`qq-workflows: delegation ${next.id} pending phase is immutable`);
        }
        if (previous.pendingPhase.messageDelivered && next.pendingPhase && !next.pendingPhase.messageDelivered) {
          throw new Error(`qq-workflows: delegation ${next.id} pending phase delivery cannot be retracted`);
        }
        const promoted = next.current
          && next.current.sessionUuid === previous.pendingPhase.sessionUuid
          && next.current.role === previous.pendingPhase.role
          && next.current.phaseEpoch === previous.pendingPhase.phaseEpoch;
        if (promoted && !previous.pendingPhase.messageDelivered) {
          throw new Error(`qq-workflows: delegation ${next.id} cannot promote an unseeded pending phase`);
        }
        if (!next.pendingPhase && !promoted && !TERMINAL_STATUSES.has(next.status)) {
          throw new Error(`qq-workflows: delegation ${next.id} must promote its pending phase exactly`);
        }
      }
      persist(next);
      const result = snapshot(next);
      onChange?.(result);
      return result;
    },

    list() {
      return listIds().map((id) => store.load(id)).filter(Boolean);
    },

    byDelegation(delegationId) {
      if (!DELEGATION_ID.test(delegationId ?? "")) return null;
      // v2 enforces id === delegationId, so the canonical UUID is the filename.
      return store.load(String(delegationId).toLowerCase());
    },

    bySession(sessionId) {
      if (!sessionId) return null;
      for (const record of store.list()) {
        if (
          record.implementationSession === sessionId
          || record.originalImplementationSession === sessionId
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
