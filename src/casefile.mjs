// Architect working memory: one markdown file per DSH session.
// One durable pointer binds fresh sessions to the sole unconsumed qq-task;
// dispatch clears the pointer while land keeps the task live until merge.
// The operator sees this document. The talking model rewrites it in place.

import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

export const CASE_MAX_CHARS = 24_000;
export const CASE_CONTEXT_NAME = "qq-workflows:case";

export const EMPTY_CASE = "# Working memory\n";

function requireAbsolute(path, label) {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new Error(`qq-workflows: ${label} must be an absolute path`);
  }
  return path;
}

/** Default case directory: a folder beside DSH_HOME. */
export function defaultCaseDir(env = process.env, config = {}) {
  if (config.caseDir !== undefined) {
    return requireAbsolute(config.caseDir, "caseDir");
  }
  const dshHome = env.DSH_HOME?.trim();
  if (dshHome) {
    return join(dirname(requireAbsolute(dshHome, "DSH_HOME")), ".qq-workflows-cases");
  }
  const home = env.HOME || homedir();
  return join(requireAbsolute(home, "HOME"), ".qq-workflows-cases");
}

export function titleOf(text) {
  const match = /^#\s+(\S.*)$/m.exec(String(text ?? ""));
  const title = match?.[1]?.trim() ?? "";
  return title || "Working memory";
}

/** Body after the first heading, for the qq-tasks ticket. */
export function bodyOf(text) {
  const raw = String(text ?? "").replace(/\r\n/g, "\n");
  const heading = raw.match(/^#\s+.+?(?:\n|$)/);
  return heading ? raw.slice(heading[0].length).replace(/^\n/, "").replace(/\n$/, "") : raw;
}

function normalizeText(raw) {
  const text = String(raw ?? "").replace(/\r\n/g, "\n");
  if (text.length > CASE_MAX_CHARS) {
    throw new Error(`qq-workflows: case file exceeds ${CASE_MAX_CHARS} characters`);
  }
  return text;
}

export function createCaseStore(dirPath) {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });

  function fileFor(sessionId) {
    return join(dirPath, `${sessionId}.md`);
  }

  function taskFile(sessionId) {
    return join(dirPath, `${sessionId}.task`);
  }

  const unconsumedFile = join(dirPath, "unconsumed.task");

  function atomicLine(file, value) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${value}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  }

  function unconsumedTaskId() {
    if (!existsSync(unconsumedFile)) return null;
    const id = readFileSync(unconsumedFile, "utf8").trim();
    return id || null;
  }

  function clearUnconsumed(id) {
    if (id && unconsumedTaskId() !== String(id)) return false;
    try {
      unlinkSync(unconsumedFile);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  function persist(sessionId, text) {
    const file = fileFor(sessionId);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  }

  const store = {
    dirPath,
    fileFor,

    load(sessionId) {
      const path = fileFor(sessionId);
      if (!existsSync(path)) {
        return { session: sessionId, text: "", path };
      }
      return {
        session: sessionId,
        text: readFileSync(path, "utf8"),
        path,
      };
    },

    ensure(sessionId) {
      if (!existsSync(fileFor(sessionId))) persist(sessionId, EMPTY_CASE);
      return store.load(sessionId);
    },

    write(sessionId, raw) {
      const text = normalizeText(raw);
      persist(sessionId, text);
      return store.load(sessionId);
    },

    taskId(sessionId) {
      const path = taskFile(sessionId);
      if (!existsSync(path)) return null;
      const id = readFileSync(path, "utf8").trim();
      return id || null;
    },

    bind(sessionId, id, options = {}) {
      const name = String(id ?? "").trim();
      if (!name) throw new Error("qq-workflows: bind requires a task id");
      atomicLine(taskFile(sessionId), name);
      if (options.unconsumed !== false) atomicLine(unconsumedFile, name);
      return name;
    },

    /** Open the sole unconsumed document in a fresh architect session. */
    open(sessionId, tasks) {
      if (store.taskId(sessionId)) return store.ensure(sessionId);
      const id = unconsumedTaskId();
      if (!id || !tasks || typeof tasks.read !== "function") return store.ensure(sessionId);
      try {
        const ticket = tasks.read(id);
        const title = String(ticket?.title ?? "Working memory").trim() || "Working memory";
        const body = String(ticket?.body ?? "").trim();
        persist(sessionId, `# ${title}${body ? `\n\n${body}` : ""}`);
        store.bind(sessionId, id, { unconsumed: false });
        return store.load(sessionId);
      } catch {
        // An externally archived ticket is no longer an unconsumed document.
        clearUnconsumed(id);
        return store.ensure(sessionId);
      }
    },

    /** Mark this document dispatched. Its task remains live until land. */
    consume(sessionId) {
      const id = store.taskId(sessionId);
      if (id) clearUnconsumed(id);
      return id;
    },

    unconsumedTaskId,
  };

  return store;
}
