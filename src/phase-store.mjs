// Durable semantic chair phase projection: one JSON file per parent session.
//
// Mutation paths update this ledger after their authoritative write. Readers
// only load it, so dashboard snapshots never create files or move timestamps.

import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

export const PHASE_PROJECTION_SCHEMA = "qq.workflows-phase/v1";
export const CHAIR_PHASES = Object.freeze(["planning", "plan", "work", "none", "unknown"]);

const PHASE_SET = new Set(CHAIR_PHASES);
const TIMED_PHASES = new Set(["planning", "plan", "work"]);
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireAbsolute(path, label) {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new Error(`qq-workflows: ${label} must be an absolute path`);
  }
  return path;
}

/** Default phase directory: a folder beside DSH_HOME. */
export function defaultPhaseDir(env = process.env, config = {}) {
  if (config.phaseDir !== undefined) return requireAbsolute(config.phaseDir, "phaseDir");
  // Custom store roots are primarily used by isolated hosts/tests. Keep the
  // new sibling store inside that same configured parent by default.
  const configuredSibling = config.caseDir ?? config.selectionDir;
  if (configuredSibling !== undefined) {
    return join(dirname(requireAbsolute(configuredSibling, "caseDir/selectionDir")), ".qq-workflows-phases");
  }
  const dshHome = env.DSH_HOME?.trim();
  if (dshHome) {
    return join(dirname(requireAbsolute(dshHome, "DSH_HOME")), ".qq-workflows-phases");
  }
  const home = env.HOME || homedir();
  return join(requireAbsolute(home, "HOME"), ".qq-workflows-phases");
}

function assertSessionUuid(sessionUuid) {
  if (!SESSION_ID.test(sessionUuid ?? "")) {
    throw new Error(`qq-workflows: invalid phase parent session UUID: ${String(sessionUuid ?? "")}`);
  }
  return sessionUuid;
}

function assertPhase(phase) {
  if (!PHASE_SET.has(phase)) throw new Error(`qq-workflows: invalid chair phase: ${String(phase ?? "")}`);
  return phase;
}

function normalizeTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new Error("qq-workflows: phaseStartedAt must be epoch milliseconds");
  }
  return Math.trunc(timestamp);
}

function normalize(raw, expectedSession) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || raw.schema !== PHASE_PROJECTION_SCHEMA
    || raw.sessionUuid !== expectedSession
    || !PHASE_SET.has(raw.phase)) {
    throw new Error(`qq-workflows: phase projection for ${expectedSession} is malformed`);
  }
  const timed = TIMED_PHASES.has(raw.phase);
  if ((timed && (typeof raw.phaseStartedAt !== "number" || !Number.isSafeInteger(raw.phaseStartedAt) || raw.phaseStartedAt < 0))
    || (!timed && raw.phaseStartedAt !== null)) {
    throw new Error(`qq-workflows: phase projection for ${expectedSession} is malformed`);
  }
  return {
    schema: PHASE_PROJECTION_SCHEMA,
    sessionUuid: expectedSession,
    phase: raw.phase,
    phaseStartedAt: raw.phaseStartedAt,
  };
}

function cloneProjection(record) {
  return record ? { phase: record.phase, phaseStartedAt: record.phaseStartedAt } : null;
}

export function createPhaseStore(dirPath, { now = Date.now } = {}) {
  requireAbsolute(dirPath, "phaseDir");
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });

  function fileFor(sessionUuid) {
    return join(dirPath, `${assertSessionUuid(sessionUuid)}.json`);
  }

  function load(sessionUuid) {
    const file = fileFor(sessionUuid);
    if (!existsSync(file)) return null;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`qq-workflows: phase projection ${file} is malformed`, { cause: error });
    }
    return normalize(parsed, sessionUuid);
  }

  function persist(record) {
    const file = fileFor(record.sessionUuid);
    const temporary = join(dirPath, `.${record.sessionUuid}.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    });
    renameSync(temporary, file);
  }

  return Object.freeze({
    dirPath,
    fileFor,
    get(sessionUuid) {
      return cloneProjection(load(sessionUuid));
    },
    transition(sessionUuid, phase, options = {}) {
      assertSessionUuid(sessionUuid);
      assertPhase(phase);
      const previous = load(sessionUuid);
      if (previous?.phase === phase) return cloneProjection(previous);
      const phaseStartedAt = TIMED_PHASES.has(phase)
        ? normalizeTimestamp(options.phaseStartedAt ?? (typeof now === "function" ? now() : Date.now()))
        : null;
      const next = {
        schema: PHASE_PROJECTION_SCHEMA,
        sessionUuid,
        phase,
        phaseStartedAt,
      };
      persist(next);
      return cloneProjection(next);
    },
  });
}
