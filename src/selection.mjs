// Per-session workflow selection. Operator-declared, restart-safe, default none.
//
// One file per DSH session, beside DSH_HOME (config.selectionDir overrides).
// Mode 0600, atomic write. This is not a transcript, notebook, or settings file.

import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

export const SELECTION_SCHEMA = "qq.workflows-selection/v1";

function requireAbsolute(path, label) {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new Error(`qq-workflows: ${label} must be an absolute path`);
  }
  return path;
}

/** Default selection directory: a folder beside DSH_HOME. */
export function defaultSelectionDir(env = process.env, config = {}) {
  if (config.selectionDir !== undefined) {
    return requireAbsolute(config.selectionDir, "selectionDir");
  }
  const dshHome = env.DSH_HOME?.trim();
  if (dshHome) {
    return join(dirname(requireAbsolute(dshHome, "DSH_HOME")), ".qq-workflows-selected");
  }
  const home = env.HOME || homedir();
  return join(requireAbsolute(home, "HOME"), ".qq-workflows-selected");
}

function emptyRecord(sessionId) {
  return { schema: SELECTION_SCHEMA, session: sessionId, workflow: null };
}

function normalize(raw, sessionId) {
  if (!raw || raw.schema !== SELECTION_SCHEMA || raw.session !== sessionId) {
    throw new Error(`qq-workflows: selection for ${sessionId} is malformed`);
  }
  const workflow = raw.workflow;
  if (workflow !== null && (typeof workflow !== "string" || workflow.length === 0)) {
    throw new Error(`qq-workflows: selection for ${sessionId} is malformed`);
  }
  return { schema: SELECTION_SCHEMA, session: sessionId, workflow };
}

export function createSelectionStore(dirPath) {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });

  function fileFor(sessionId) {
    return join(dirPath, `${sessionId}.json`);
  }

  function load(sessionId) {
    const file = fileFor(sessionId);
    if (!existsSync(file)) return emptyRecord(sessionId);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`qq-workflows: selection ${file} is malformed`, { cause: error });
    }
    return normalize(parsed, sessionId);
  }

  function persist(record) {
    const file = fileFor(record.session);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  }

  return Object.freeze({
    dirPath,
    fileFor,
    get(sessionId) {
      return load(sessionId).workflow;
    },
    set(sessionId, workflow) {
      const name = workflow == null || workflow === "" ? null : String(workflow);
      persist({ schema: SELECTION_SCHEMA, session: sessionId, workflow: name });
      return name;
    },
  });
}
