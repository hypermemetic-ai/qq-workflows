// Iterate journal: append-only store keyed to a DSH session.
//
// Beside DSH_HOME (config.journalDir overrides), mode 0600, atomic write.
// Restart-safe. Not a second transcript; DSH log is authority.
//
// Four objects, projected from the log:
//   directive — one living sentence
//   note      — nit / praise, same object, polarity flipped, cited by DSH seq
//   theory    — one living paragraph
//   open/closed on nits — close by appending, never rewrite

import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

export const JOURNAL_SCHEMA = "qq.workflows-iterate-journal/v1";

const KINDS = new Set(["directive", "note", "theory", "close", "go", "select"]);

function requireAbsolute(path, label) {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new Error(`qq-workflows: ${label} must be an absolute path`);
  }
  return path;
}

/** Default journal directory: a folder beside DSH_HOME. */
export function defaultJournalDir(env = process.env, config = {}) {
  if (config.journalDir !== undefined) {
    return requireAbsolute(config.journalDir, "journalDir");
  }
  const dshHome = env.DSH_HOME?.trim();
  if (dshHome) {
    return join(dirname(requireAbsolute(dshHome, "DSH_HOME")), ".qq-workflows-journals");
  }
  const home = env.HOME || homedir();
  return join(requireAbsolute(home, "HOME"), ".qq-workflows-journals");
}

function emptyJournal(sessionId) {
  return {
    schema: JOURNAL_SCHEMA,
    session: sessionId,
    entries: [],
  };
}

function validEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (!KINDS.has(entry.kind)) return false;
  if (typeof entry.id !== "string" || entry.id.length === 0) return false;
  if (!Number.isSafeInteger(entry.seq)) return false;
  if (entry.kind === "note") {
    if (entry.polarity !== "nit" && entry.polarity !== "praise") return false;
    if (typeof entry.text !== "string" || entry.text.trim().length === 0) return false;
    if (!Number.isSafeInteger(entry.breath)) return false;
  }
  if (entry.kind === "directive" || entry.kind === "theory") {
    if (typeof entry.text !== "string" || entry.text.trim().length === 0) return false;
  }
  if (entry.kind === "close") {
    if (typeof entry.target !== "string" || entry.target.length === 0) return false;
  }
  if (entry.kind === "go") {
    if (!Number.isSafeInteger(entry.breath)) return false;
    if (!Array.isArray(entry.nitIds)) return false;
  }
  if (entry.kind === "select") {
    if (!Array.isArray(entry.ids)) return false;
  }
  return true;
}

function normalizeEntry(entry) {
  const next = {
    kind: entry.kind,
    id: entry.id,
    seq: entry.seq,
  };
  if (typeof entry.text === "string") next.text = entry.text;
  if (entry.polarity === "nit" || entry.polarity === "praise") next.polarity = entry.polarity;
  if (Number.isSafeInteger(entry.breath)) next.breath = entry.breath;
  if (typeof entry.target === "string") next.target = entry.target;
  if (typeof entry.reason === "string") next.reason = entry.reason;
  if (Array.isArray(entry.nitIds)) next.nitIds = entry.nitIds.filter((id) => typeof id === "string");
  if (Array.isArray(entry.ids)) next.ids = entry.ids.filter((id) => typeof id === "string");
  if (typeof entry.child === "string") next.child = entry.child;
  return next;
}

function normalize(raw, sessionId) {
  if (!raw || raw.schema !== JOURNAL_SCHEMA || raw.session !== sessionId || !Array.isArray(raw.entries)) {
    throw new Error(`qq-workflows: journal for ${sessionId} is malformed`);
  }
  const entries = raw.entries.map(normalizeEntry);
  if (!entries.every(validEntry)) {
    throw new Error(`qq-workflows: journal for ${sessionId} is malformed`);
  }
  return { schema: JOURNAL_SCHEMA, session: sessionId, entries };
}

function snapshot(journal) {
  return {
    schema: journal.schema,
    session: journal.session,
    entries: journal.entries.map((entry) => ({ ...entry })),
  };
}

function nextId(entries, prefix) {
  let max = 0;
  for (const entry of entries) {
    if (typeof entry.id !== "string" || !entry.id.startsWith(prefix)) continue;
    const value = Number(entry.id.slice(prefix.length));
    if (Number.isSafeInteger(value) && value > max) max = value;
  }
  return `${prefix}${max + 1}`;
}

function closedTargets(entries) {
  const closed = new Set();
  for (const entry of entries) {
    if (entry.kind === "close") closed.add(entry.target);
  }
  return closed;
}

/** Project the living journal: latest directive/theory, open nits, praise, breath. */
export function projectJournal(journal) {
  const entries = journal?.entries ?? [];
  const closed = closedTargets(entries);
  let directive = null;
  let theory = null;
  const nits = [];
  const praise = [];
  let breath = 1;
  let selected = [];
  const sent = new Set();
  for (const entry of entries) {
    if (entry.kind === "directive") directive = { id: entry.id, text: entry.text, seq: entry.seq };
    else if (entry.kind === "theory") theory = { id: entry.id, text: entry.text, seq: entry.seq };
    else if (entry.kind === "note" && entry.polarity === "nit") {
      nits.push({
        id: entry.id,
        text: entry.text,
        seq: entry.seq,
        breath: entry.breath,
        open: !closed.has(entry.id),
      });
    } else if (entry.kind === "note" && entry.polarity === "praise") {
      praise.push({ id: entry.id, text: entry.text, seq: entry.seq });
    } else if (entry.kind === "go") {
      breath = entry.breath + 1;
      for (const id of entry.nitIds ?? []) sent.add(id);
    } else if (entry.kind === "select") {
      selected = [...entry.ids];
    }
  }
  return {
    directive,
    theory,
    nits,
    praise,
    openNits: nits.filter((note) => note.open),
    breath,
    selected,
    sent,
  };
}

/** Format the stable desk projection. Same order every turn; new items append. */
export function formatProjection(journal, wikiIndex = []) {
  const projected = projectJournal(journal);
  const lines = [];
  lines.push(`directive: ${projected.directive?.text ?? "(none)"}`);
  lines.push(`theory: ${projected.theory?.text ?? "(none)"}`);
  lines.push("open nits:");
  const open = projected.openNits;
  if (open.length === 0) lines.push("  (none)");
  else for (const note of open) lines.push(`  ${note.id} [seq ${note.seq} breath ${note.breath}] ${note.text}`);
  lines.push("praise:");
  if (projected.praise.length === 0) lines.push("  (none)");
  else for (const note of projected.praise) lines.push(`  ${note.id} [seq ${note.seq}] ${note.text}`);
  lines.push("wiki:");
  if (!Array.isArray(wikiIndex) || wikiIndex.length === 0) lines.push("  (none)");
  else for (const item of wikiIndex) {
    const label = item.labels?.length ? item.labels.join(", ") : "(unlabeled)";
    lines.push(`  ${item.id} ${label}: ${item.line ?? item.text ?? ""}`);
  }
  return lines.join("\n");
}

/**
 * This breath's open nits. Earlier open pile is included only when asked
 * (same area). justThese keeps the send to this breath.
 */
export function collectBreath(journal, { justThese = false, includeIds = [] } = {}) {
  const projected = projectJournal(journal);
  const include = new Set(includeIds);
  const nits = projected.openNits.filter((note) => {
    if (note.breath === projected.breath) return true;
    if (justThese) return false;
    return include.has(note.id);
  });
  return {
    breath: projected.breath,
    directive: projected.directive,
    theory: projected.theory,
    praise: projected.praise,
    nits,
    selected: projected.selected,
  };
}

export function createJournalStore(dirPath) {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });

  function fileFor(sessionId) {
    return join(dirPath, `${sessionId}.json`);
  }

  function load(sessionId) {
    const file = fileFor(sessionId);
    if (!existsSync(file)) return emptyJournal(sessionId);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`qq-workflows: journal ${file} is malformed`, { cause: error });
    }
    return normalize(parsed, sessionId);
  }

  function persist(journal) {
    const file = fileFor(journal.session);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  }

  function mutate(sessionId, fn) {
    const journal = load(sessionId);
    const result = fn(journal);
    persist(journal);
    return result;
  }

  const store = {
    dirPath,
    fileFor,
    load: (sessionId) => snapshot(load(sessionId)),
    project: (sessionId) => projectJournal(load(sessionId)),

    ensure(sessionId) {
      if (!existsSync(fileFor(sessionId))) persist(emptyJournal(sessionId));
      return store.load(sessionId);
    },

    /** Append a living directive sentence. */
    recordDirective(sessionId, { text, seq } = {}) {
      if (typeof text !== "string" || text.trim().length === 0 || !Number.isSafeInteger(seq)) {
        throw new Error("qq-workflows: directive requires text and seq");
      }
      return mutate(sessionId, (journal) => {
        const entry = { kind: "directive", id: nextId(journal.entries, "d"), text: text.trim(), seq };
        journal.entries.push(entry);
        return { ...entry };
      });
    },

    /** Append a living theory paragraph. Off the send path. */
    recordTheory(sessionId, { text, seq } = {}) {
      if (typeof text !== "string" || text.trim().length === 0 || !Number.isSafeInteger(seq)) {
        throw new Error("qq-workflows: theory requires text and seq");
      }
      return mutate(sessionId, (journal) => {
        const entry = { kind: "theory", id: nextId(journal.entries, "t"), text: text.trim(), seq };
        journal.entries.push(entry);
        return { ...entry };
      });
    },

    /**
     * Append a nit or praise. Same object, polarity flipped.
     * A nit is work. Praise is a keep-out.
     */
    recordNote(sessionId, { polarity, text, seq, breath } = {}) {
      if (polarity !== "nit" && polarity !== "praise") {
        throw new Error("qq-workflows: note polarity must be nit or praise");
      }
      if (typeof text !== "string" || text.trim().length === 0 || !Number.isSafeInteger(seq)) {
        throw new Error("qq-workflows: note requires text and seq");
      }
      return mutate(sessionId, (journal) => {
        const current = projectJournal(journal);
        const entry = {
          kind: "note",
          id: nextId(journal.entries, "n"),
          polarity,
          text: text.trim(),
          seq,
          breath: Number.isSafeInteger(breath) ? breath : current.breath,
        };
        journal.entries.push(entry);
        return { ...entry };
      });
    },

    /** Close a nit by appending. Review pass or operator take-back. */
    closeNote(sessionId, { target, seq, reason } = {}) {
      if (typeof target !== "string" || target.length === 0 || !Number.isSafeInteger(seq)) {
        throw new Error("qq-workflows: close requires target and seq");
      }
      return mutate(sessionId, (journal) => {
        const note = journal.entries.find((entry) => entry.kind === "note" && entry.id === target);
        if (!note) throw new Error(`qq-workflows: unknown note ${target}`);
        const entry = {
          kind: "close",
          id: nextId(journal.entries, "c"),
          target,
          seq,
          reason: typeof reason === "string" && reason.length > 0 ? reason : "operator",
        };
        journal.entries.push(entry);
        return { ...entry };
      });
    },

    /** Record a sent breath. Does not rewrite earlier notes. */
    recordGo(sessionId, { breath, nitIds, child, seq } = {}) {
      if (!Number.isSafeInteger(breath) || !Array.isArray(nitIds) || !Number.isSafeInteger(seq)) {
        throw new Error("qq-workflows: go requires breath, nitIds, and seq");
      }
      return mutate(sessionId, (journal) => {
        const entry = {
          kind: "go",
          id: nextId(journal.entries, "g"),
          breath,
          nitIds: nitIds.filter((id) => typeof id === "string"),
          seq,
          ...(typeof child === "string" ? { child } : {}),
        };
        journal.entries.push(entry);
        return { ...entry };
      });
    },

    /** Remember which wiki nodes go in the next packet. */
    selectWiki(sessionId, { ids, seq } = {}) {
      if (!Array.isArray(ids) || !Number.isSafeInteger(seq)) {
        throw new Error("qq-workflows: select requires ids and seq");
      }
      return mutate(sessionId, (journal) => {
        const entry = {
          kind: "select",
          id: nextId(journal.entries, "s"),
          ids: ids.filter((id) => typeof id === "string"),
          seq,
        };
        journal.entries.push(entry);
        return { ...entry };
      });
    },

    collectBreath: (sessionId, options) => collectBreath(load(sessionId), options),
  };

  return store;
}
