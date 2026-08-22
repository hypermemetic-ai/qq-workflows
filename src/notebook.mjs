// Workflow-owned notebook store for qq-workflows.
//
// One JSON file per DSH session, beside DSH_HOME (config.notebookDir
// overrides). Mode 0600, atomic write. Restart does not lose notes.
// Cards are append-only; supersede by appending a withdraw line.

import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

export const NOTEBOOK_SCHEMA = "qq.workflows-notebook/v1";
export const DEFAULT_CARD_NAME = "concern";
const HANDLED_CAP = 32;

function requireAbsolute(path, label) {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new Error(`qq-workflows: ${label} must be an absolute path`);
  }
  return path;
}

/** Default notebook directory: a folder beside DSH_HOME. */
export function defaultNotebookDir(env = process.env, config = {}) {
  if (config.notebookDir !== undefined) {
    return requireAbsolute(config.notebookDir, "notebookDir");
  }
  const dshHome = env.DSH_HOME?.trim();
  if (dshHome) {
    return join(dirname(requireAbsolute(dshHome, "DSH_HOME")), ".qq-workflows-notebooks");
  }
  const home = env.HOME || homedir();
  return join(requireAbsolute(home, "HOME"), ".qq-workflows-notebooks");
}

function defaultCard(name = DEFAULT_CARD_NAME) {
  return { name, open: true, notes: [], stubs: [] };
}

function emptyNotebook(sessionId) {
  return {
    schema: NOTEBOOK_SCHEMA,
    session: sessionId,
    cards: [defaultCard()],
    leftoverHandled: [],
  };
}

function validNote(note) {
  return note
    && typeof note.text === "string"
    && Number.isSafeInteger(note.startSeq)
    && Number.isSafeInteger(note.endSeq);
}

function validStub(stub) {
  return stub
    && typeof stub.text === "string"
    && Number.isSafeInteger(stub.startSeq)
    && Number.isSafeInteger(stub.endSeq);
}

function validCard(card) {
  return card
    && typeof card.name === "string"
    && card.name.length > 0
    && card.name.length <= 64
    && typeof card.open === "boolean"
    && Array.isArray(card.notes)
    && card.notes.every(validNote)
    && Array.isArray(card.stubs ?? [])
    && (card.stubs ?? []).every(validStub);
}

function normalize(raw, sessionId) {
  if (!raw || raw.schema !== NOTEBOOK_SCHEMA || raw.session !== sessionId || !Array.isArray(raw.cards)) {
    throw new Error(`qq-workflows: notebook for ${sessionId} is malformed`);
  }
  const cards = raw.cards.map((card) => ({
    name: card.name,
    open: card.open,
    notes: card.notes.map((note) => ({
      text: note.text,
      startSeq: note.startSeq,
      endSeq: note.endSeq,
    })),
    stubs: (card.stubs ?? []).map((stub) => ({
      text: stub.text,
      startSeq: stub.startSeq,
      endSeq: stub.endSeq,
    })),
  }));
  if (!cards.every(validCard)) {
    throw new Error(`qq-workflows: notebook for ${sessionId} is malformed`);
  }
  const open = cards.filter((card) => card.open);
  if (open.length === 0) {
    if (cards.length === 0) cards.push(defaultCard());
    else cards[cards.length - 1].open = true;
  } else if (open.length > 1) {
    for (const card of cards.slice(0, cards.lastIndexOf(open.at(-1)))) {
      if (card.open && card !== open.at(-1)) card.open = false;
    }
  }
  const leftoverHandled = Array.isArray(raw.leftoverHandled)
    ? raw.leftoverHandled.filter((item) => typeof item === "string" && item.length > 0).slice(-HANDLED_CAP)
    : [];
  return { schema: NOTEBOOK_SCHEMA, session: sessionId, cards, leftoverHandled };
}

function snapshot(notebook) {
  return {
    schema: notebook.schema,
    session: notebook.session,
    leftoverHandled: [...(notebook.leftoverHandled ?? [])],
    cards: notebook.cards.map((card) => ({
      name: card.name,
      open: card.open,
      notes: card.notes.map((note) => ({ ...note })),
      stubs: card.stubs.map((stub) => ({ ...stub })),
    })),
  };
}

function notesInSpan(notes, startSeq, endSeq) {
  return notes.filter((note) => note.startSeq <= endSeq && note.endSeq >= startSeq);
}

/** Format the frozen stand-in for a dropped surface span. */
export function formatStub(notes, startSeq, endSeq) {
  const lines = notes.map((note) => `- ${note.text} [${note.startSeq}-${note.endSeq}]`);
  return [
    `Dropped conversation seq ${startSeq}-${endSeq}.`,
    ...(lines.length > 0 ? lines : ["(no notes)"]),
  ].join("\n");
}

/**
 * One persistent notebook keyed to a DSH session id. Notes are append-only.
 * Stubs freeze once; a later withdraw stays in the store and does not rewrite
 * an already-frozen stub.
 */
export function createNotebookStore(dirPath, options = {}) {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });

  function fileFor(sessionId) {
    return join(dirPath, `${sessionId}.json`);
  }

  function load(sessionId) {
    const file = fileFor(sessionId);
    if (!existsSync(file)) return emptyNotebook(sessionId);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`qq-workflows: notebook ${file} is malformed`, { cause: error });
    }
    return normalize(parsed, sessionId);
  }

  function persist(notebook) {
    const file = fileFor(notebook.session);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(notebook, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  }

  function mutate(sessionId, fn) {
    const notebook = load(sessionId);
    const result = fn(notebook);
    persist(notebook);
    return result;
  }

  const store = {
    dirPath,
    fileFor,
    load: (sessionId) => snapshot(load(sessionId)),

    ensure(sessionId) {
      if (!existsSync(fileFor(sessionId))) persist(emptyNotebook(sessionId));
      return store.load(sessionId);
    },

    openCard(notebook) {
      return notebook.cards.find((card) => card.open) ?? notebook.cards.at(-1);
    },

    /** Append one note to the open card. */
    appendNote(sessionId, note) {
      if (!validNote(note) || note.text.trim().length === 0) {
        throw new Error("qq-workflows: note must have text and seq citations");
      }
      return mutate(sessionId, (notebook) => {
        const card = store.openCard(notebook);
        if (!card) throw new Error("qq-workflows: notebook has no open card");
        const entry = { text: note.text, startSeq: note.startSeq, endSeq: note.endSeq };
        card.notes.push(entry);
        return { ...entry };
      });
    },

    /**
     * Supersede by appending a withdraw line. The store is never rewritten
     * in place; later list/expand see both the original and this line.
     */
    appendWithdraw(sessionId, note) {
      const text = note?.text?.startsWith("X withdrawn") || note?.text?.includes("withdrawn")
        ? note.text
        : `X withdrawn / replaced by ${note?.text ?? ""}`.trim();
      return store.appendNote(sessionId, { ...note, text });
    },

    /**
     * Freeze the stand-in for a dropped span once. A matching stub is returned
     * unchanged when the same span is asked again; later notes stay in the
     * store and do not rewrite it.
     */
    freezeStub(sessionId, { startSeq, endSeq, cardName } = {}) {
      if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq)) {
        throw new Error("qq-workflows: stub requires startSeq and endSeq");
      }
      return mutate(sessionId, (notebook) => {
        const card = (cardName && notebook.cards.find((item) => item.name === cardName))
          || store.openCard(notebook);
        if (!card) throw new Error("qq-workflows: notebook has no card to freeze");
        const existing = card.stubs.find((stub) => stub.startSeq === startSeq && stub.endSeq === endSeq);
        if (existing) return { ...existing, frozen: true };
        const stub = {
          text: formatStub(notesInSpan(card.notes, startSeq, endSeq), startSeq, endSeq),
          startSeq,
          endSeq,
        };
        card.stubs.push(stub);
        return { ...stub, frozen: false };
      });
    },

    closeCard(sessionId, name) {
      return mutate(sessionId, (notebook) => {
        const card = notebook.cards.find((item) => item.name === name && item.open);
        if (!card) return false;
        card.open = false;
        if (!notebook.cards.some((item) => item.open)) {
          notebook.cards.push(defaultCard(`${name}-next`));
        }
        return true;
      });
    },

    replaceCard(sessionId, name) {
      return mutate(sessionId, (notebook) => {
        for (const card of notebook.cards) card.open = false;
        const next = defaultCard(name || DEFAULT_CARD_NAME);
        notebook.cards.push(next);
        return { name: next.name };
      });
    },

    handledLeftovers(sessionId) {
      return [...(load(sessionId).leftoverHandled ?? [])];
    },

    rememberLeftover(sessionId, digest) {
      if (typeof digest !== "string" || digest.length === 0) return [];
      return mutate(sessionId, (notebook) => {
        const next = [...(notebook.leftoverHandled ?? []).filter((item) => item !== digest), digest];
        notebook.leftoverHandled = next.slice(-HANDLED_CAP);
        return [...notebook.leftoverHandled];
      });
    },

    notesInSpan,
  };

  return store;
}
