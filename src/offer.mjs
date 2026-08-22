// Leftover coverage hop after the talking turn. Unfinished stubs silent-bank.
// A new leftover on the same card is the live board, not a topic switch.
// Invoke is the handoff path. This hop does not write into architect talk.

import { boardKind, isClerkDump } from "./scribe.mjs";

const UNFINISHED = /\b(todo\b|tbd\b|wip\b|unfinished|placeholder|not sure yet|need to think|coming soon|\?\?\?)/i;
const RUNNER_LINE = /^(return address\b|results are delivered through qq-relay\b|for the runner\b|runner[- ]only\b|child session\b|parent session\b)/i;

export function isObviouslyUnfinished(prose) {
  const trimmed = String(prose ?? "").trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length < 8) return true;
  return UNFINISHED.test(trimmed) && trimmed.length < 280;
}

function noteKind(note) {
  const text = String(note?.text ?? "").trim();
  if (!text || isClerkDump(text)) return null;
  return boardKind(text);
}

export function liveNotes(card) {
  if (!card || !Array.isArray(card.notes)) return [];
  return card.notes.filter((note) => {
    const text = String(note?.text ?? "").trim();
    return text.length > 0 && !/\bwithdrawn\b/i.test(text);
  });
}

/** FACT and LEFTOVER lines that still state the current board. */
export function standingNotes(card) {
  return liveNotes(card).filter((note) => noteKind(note) != null);
}

export function leftoverNotes(card) {
  return liveNotes(card).filter((note) => noteKind(note) === "leftover");
}

export function priorLeftoverNotes(card, turnStartSeq) {
  const notes = leftoverNotes(card);
  if (!Number.isSafeInteger(turnStartSeq)) return notes;
  return notes.filter((note) => Number(note.endSeq) < turnStartSeq);
}

export function incomingLeftoverNotes(card, turnStartSeq) {
  const notes = leftoverNotes(card);
  if (!Number.isSafeInteger(turnStartSeq)) return [];
  return notes.filter((note) => Number(note.startSeq) >= turnStartSeq);
}

/**
 * Leftover is coverage of the live concern.
 * Incoming leftover stays on the board — settling one topic is not a branch.
 * Prior leftover stays, except unfinished stubs which silent-bank.
 * This hop does not popup. A later explicit branch signal can still return
 * switch; leftover notes are not that signal. Invoke is the handoff.
 */
export function classifyJunction(card, { turnStartSeq } = {}) {
  const prior = priorLeftoverNotes(card, turnStartSeq);
  const incoming = incomingLeftoverNotes(card, turnStartSeq);
  if (incoming.length > 0) return "skip";
  if (prior.length === 0) return "skip";
  if (prior.every((note) => isObviouslyUnfinished(note.text))) return "bank";
  return "skip";
}

/** @deprecated use classifyJunction */
export function classifyLeftover(card, extra) {
  return classifyJunction(card, extra);
}

export function switchBrief(prior, incoming) {
  const lines = (notes) => notes.map((note) => note.text.trim()).filter(Boolean).join("\n") || "(none)";
  return [
    "New conversation.",
    "",
    "Previous leftover:",
    lines(prior),
    "",
    "New:",
    lines(incoming),
    "",
    "Start this now (bank previous if it is still open), abandon previous, or bank this for later.",
  ].join("\n");
}

export function leftoverProse(card) {
  return leftoverNotes(card).map((note) => note.text.trim()).join("\n");
}

export function leftoverDigest(card) {
  const notes = leftoverNotes(card);
  const body = notes.map((note) => `${note.startSeq ?? ""}:${note.endSeq ?? ""}:${note.text}`).join("|");
  return `${card?.name ?? ""}:${body}`;
}

export function leftoverTitle(card, prose = leftoverProse(card)) {
  const name = typeof card?.name === "string" ? card.name.trim() : "";
  if (name && name !== "concern") return name.slice(0, 80);
  const notes = leftoverNotes(card);
  const defined = notes.map((note) => note.text.trim()).filter((text) => !isObviouslyUnfinished(text));
  const source = defined.at(-1) || String(prose ?? "").trim();
  const line = source.split(/\n/)[0]?.replace(/^[-*]\s+/, "") ?? "";
  const title = line.replace(/^leftover\b\s*:?\s*/i, "");
  if (!title) return "Leftover";
  return title.length > 80 ? `${title.slice(0, 77).trimEnd()}...` : title;
}

/** Same compiled packet run gets; runner-only lines move to the bottom. */
export function splitOperatorBrief(packet) {
  const text = String(packet ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return { brief: "", operatorBrief: "", runnerBrief: "" };
  const operator = [];
  const runner = [];
  for (const line of text.split("\n")) {
    if (RUNNER_LINE.test(line.trim())) runner.push(line);
    else operator.push(line);
  }
  const operatorBrief = operator.join("\n").trim();
  const runnerBrief = runner.join("\n").trim();
  return {
    brief: text,
    operatorBrief: operatorBrief || text,
    runnerBrief,
  };
}

export function createOfferBook() {
  const pending = new Map();
  const handled = new Map();

  return Object.freeze({
    get(sessionId) {
      return pending.get(sessionId) ?? null;
    },
    put(sessionId, offer) {
      pending.set(sessionId, offer);
      return offer;
    },
    clear(sessionId) {
      pending.delete(sessionId);
    },
    remember(sessionId, digest) {
      if (digest) handled.set(sessionId, digest);
    },
    alreadyHandled(sessionId, digest) {
      return Boolean(digest) && handled.get(sessionId) === digest;
    },
  });
}
