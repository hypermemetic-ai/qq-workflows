// Iterate this-loop wiki: unstructured nodes dumped by hands after review
// passes, filed by the desk. Not T-67. Not a page graph.
//
// Store: node + labels, append-only. Nodes stay unlabeled until the desk
// files. Next packet gets a cheap index and only the selected full nodes.

import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

export const WIKI_SCHEMA = "qq.workflows-iterate-wiki/v1";

function requireAbsolute(path, label) {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new Error(`qq-workflows: ${label} must be an absolute path`);
  }
  return path;
}

/** Default wiki directory: a folder beside DSH_HOME. */
export function defaultWikiDir(env = process.env, config = {}) {
  if (config.wikiDir !== undefined) {
    return requireAbsolute(config.wikiDir, "wikiDir");
  }
  const dshHome = env.DSH_HOME?.trim();
  if (dshHome) {
    return join(dirname(requireAbsolute(dshHome, "DSH_HOME")), ".qq-workflows-wiki");
  }
  const home = env.HOME || homedir();
  return join(requireAbsolute(home, "HOME"), ".qq-workflows-wiki");
}

function emptyWiki(sessionId) {
  return {
    schema: WIKI_SCHEMA,
    session: sessionId,
    entries: [],
  };
}

function validEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.kind !== "node" && entry.kind !== "file") return false;
  if (typeof entry.id !== "string" || entry.id.length === 0) return false;
  if (!Number.isSafeInteger(entry.seq)) return false;
  if (entry.kind === "node") {
    if (typeof entry.text !== "string" || entry.text.trim().length === 0) return false;
  }
  if (entry.kind === "file") {
    if (typeof entry.target !== "string" || entry.target.length === 0) return false;
    if (!Array.isArray(entry.labels) || entry.labels.length === 0) return false;
  }
  return true;
}

function normalizeEntry(entry) {
  const next = { kind: entry.kind, id: entry.id, seq: entry.seq };
  if (typeof entry.text === "string") next.text = entry.text;
  if (typeof entry.target === "string") next.target = entry.target;
  if (Array.isArray(entry.labels)) {
    next.labels = entry.labels.filter((label) => typeof label === "string" && label.trim().length > 0);
  }
  if (typeof entry.source === "string") next.source = entry.source;
  return next;
}

function normalize(raw, sessionId) {
  if (!raw || raw.schema !== WIKI_SCHEMA || raw.session !== sessionId || !Array.isArray(raw.entries)) {
    throw new Error(`qq-workflows: wiki for ${sessionId} is malformed`);
  }
  const entries = raw.entries.map(normalizeEntry);
  if (!entries.every(validEntry)) {
    throw new Error(`qq-workflows: wiki for ${sessionId} is malformed`);
  }
  return { schema: WIKI_SCHEMA, session: sessionId, entries };
}

function snapshot(wiki) {
  return {
    schema: wiki.schema,
    session: wiki.session,
    entries: wiki.entries.map((entry) => ({ ...entry, ...(entry.labels ? { labels: [...entry.labels] } : {}) })),
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

function latestLabels(entries) {
  const labels = new Map();
  for (const entry of entries) {
    if (entry.kind === "file") labels.set(entry.target, [...entry.labels]);
  }
  return labels;
}

/** Living nodes with latest labels. Unlabeled until the desk files. */
export function projectWiki(wiki) {
  const entries = wiki?.entries ?? [];
  const labels = latestLabels(entries);
  const nodes = [];
  for (const entry of entries) {
    if (entry.kind !== "node") continue;
    const tagged = labels.get(entry.id) ?? [];
    nodes.push({
      id: entry.id,
      text: entry.text,
      seq: entry.seq,
      labels: tagged,
      unlabeled: tagged.length === 0,
      source: entry.source ?? "hands",
    });
  }
  return { nodes, unlabeled: nodes.filter((node) => node.unlabeled) };
}

/** Cheap index: id + labels + one line. Not the full dump. */
export function formatWikiIndex(wiki) {
  const { nodes } = projectWiki(wiki);
  return nodes.map((node) => ({
    id: node.id,
    labels: node.labels,
    line: node.text.trim().replace(/\s+/g, " ").slice(0, 80),
    unlabeled: node.unlabeled,
  }));
}

export function createWikiStore(dirPath) {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });

  function fileFor(sessionId) {
    return join(dirPath, `${sessionId}.json`);
  }

  function load(sessionId) {
    const file = fileFor(sessionId);
    if (!existsSync(file)) return emptyWiki(sessionId);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`qq-workflows: wiki ${file} is malformed`, { cause: error });
    }
    return normalize(parsed, sessionId);
  }

  function persist(wiki) {
    const file = fileFor(wiki.session);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(wiki, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  }

  function mutate(sessionId, fn) {
    const wiki = load(sessionId);
    const result = fn(wiki);
    persist(wiki);
    return result;
  }

  const store = {
    dirPath,
    fileFor,
    load: (sessionId) => snapshot(load(sessionId)),
    project: (sessionId) => projectWiki(load(sessionId)),
    index: (sessionId) => formatWikiIndex(load(sessionId)),

    ensure(sessionId) {
      if (!existsSync(fileFor(sessionId))) persist(emptyWiki(sessionId));
      return store.load(sessionId);
    },

    /**
     * Hands dump after review passes. Nodes stay unlabeled until the desk
     * files. Reviewer writes nothing.
     */
    dump(sessionId, { text, seq, source = "hands" } = {}) {
      if (typeof text !== "string" || text.trim().length === 0 || !Number.isSafeInteger(seq)) {
        throw new Error("qq-workflows: wiki dump requires text and seq");
      }
      return mutate(sessionId, (wiki) => {
        const entry = {
          kind: "node",
          id: nextId(wiki.entries, "w"),
          text: text.trim(),
          seq,
          source,
        };
        wiki.entries.push(entry);
        return { ...entry, unlabeled: true };
      });
    },

    /**
     * Desk files a node. Labels are invented here. Merge when two labels
     * name the same thing by writing the same string.
     */
    file(sessionId, { target, labels, seq } = {}) {
      const tagged = (Array.isArray(labels) ? labels : [])
        .map((label) => String(label).trim())
        .filter((label) => label.length > 0);
      if (typeof target !== "string" || target.length === 0 || tagged.length === 0 || !Number.isSafeInteger(seq)) {
        throw new Error("qq-workflows: wiki file requires target, labels, and seq");
      }
      return mutate(sessionId, (wiki) => {
        const node = wiki.entries.find((entry) => entry.kind === "node" && entry.id === target);
        if (!node) throw new Error(`qq-workflows: unknown wiki node ${target}`);
        const entry = {
          kind: "file",
          id: nextId(wiki.entries, "f"),
          target,
          labels: tagged,
          seq,
        };
        wiki.entries.push(entry);
        return { ...entry };
      });
    },

    /** Full nodes for the selected ids only. Missable on purpose. */
    selected(sessionId, ids = []) {
      const wanted = new Set(ids);
      return projectWiki(load(sessionId)).nodes.filter((node) => wanted.has(node.id));
    },
  };

  return store;
}
