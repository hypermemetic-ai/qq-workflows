// Junction 1 leftover offer: classify, split the compiled brief, bank/ignore/handoff.
// Detection is a hop after the talking turn. It does not write into architect talk.

const UNFINISHED = /\b(todo\b|tbd\b|wip\b|unfinished|placeholder|not sure yet|need to think|coming soon|\?\?\?)/i;
const ASKED_HANDOFF = /\b(hand[\s-]?off|handoff|delegate this|file this(?: as a (?:task|ticket))?|run this)\b/i;
const RUNNER_LINE = /^(return address\b|results are delivered through qq-relay\b|for the runner\b|runner[- ]only\b|child session\b|parent session\b)/i;

export function askedHandoff(text) {
  return ASKED_HANDOFF.test(String(text ?? ""));
}

export function isObviouslyUnfinished(prose) {
  const trimmed = String(prose ?? "").trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length < 8) return true;
  return UNFINISHED.test(trimmed) && trimmed.length < 280;
}

/**
 * Low bar: skip empty, bank obviously unfinished, offer ambiguous-or-better.
 * Operator asking to hand off always offers the same popup.
 */
export function classifyLeftover(card, { asked = false } = {}) {
  const notes = liveNotes(card);
  const prose = notes.map((note) => note.text.trim()).filter(Boolean).join("\n");
  if (asked) return prose ? "offer" : "skip";
  if (!prose) return "skip";
  if (notes.every((note) => isObviouslyUnfinished(note.text))) return "bank";
  return "offer";
}

export function liveNotes(card) {
  if (!card || !Array.isArray(card.notes)) return [];
  return card.notes.filter((note) => {
    const text = String(note?.text ?? "").trim();
    return text.length > 0 && !/\bwithdrawn\b/i.test(text);
  });
}

export function leftoverProse(card) {
  return liveNotes(card).map((note) => note.text.trim()).join("\n");
}

export function leftoverDigest(card, { asked = false } = {}) {
  const notes = liveNotes(card);
  const body = notes.map((note) => `${note.startSeq ?? ""}:${note.endSeq ?? ""}:${note.text}`).join("|");
  return `${asked ? "ask:" : ""}${card?.name ?? ""}:${body}`;
}

export function leftoverTitle(card, prose = leftoverProse(card)) {
  const name = typeof card?.name === "string" ? card.name.trim() : "";
  if (name && name !== "concern") return name.slice(0, 80);
  const notes = liveNotes(card);
  const defined = notes.map((note) => note.text.trim()).filter((text) => !isObviouslyUnfinished(text));
  const source = defined.at(-1) || String(prose ?? "").trim();
  const line = source.split(/\n/)[0]?.replace(/^[-*]\s+/, "") ?? "";
  if (!line) return "Leftover";
  return line.length > 80 ? `${line.slice(0, 77).trimEnd()}...` : line;
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
