// Fold: after the turn, after clerk. Decision off-session. Apply at the next
// request assemble. Never mid-turn. Never block send. Clerk late → skip.
//
// Drop Old when Old >= ((1-h)/h) * Tail. Default h = 0.1. Keep at least two
// operator+architect pairs. Snap to turn boundaries. Never split a pair.
// Never drop the latest pair. Quality ceiling Q = 256000 tokens of the
// talking blob (Grok uses 200000). Durable omit is a plugin-source
// user/message with surfaceOp: replace carrying the frozen stub.

import { formatStub } from "./notebook.mjs";

export const DEFAULT_H = 0.1;
export const DEFAULT_Q = 256_000;
export const GROK_Q = 200_000;
export const MIN_PAIRS = 2;
export const CHARS_PER_TOKEN = 4;

const GROK_PROVIDERS = new Set(["xai-auth", "xai"]);

export function qualityCeiling(route = {}) {
  if (GROK_PROVIDERS.has(route.provider) || /grok/i.test(String(route.model ?? ""))) {
    return GROK_Q;
  }
  return DEFAULT_Q;
}

/** Old >= ((1-h)/h) * Tail. */
export function shouldDropOld(oldTokens, tailTokens, h = DEFAULT_H) {
  if (!(h > 0 && h < 1)) throw new Error("qq-workflows: h must be in (0, 1)");
  if (tailTokens <= 0) return false;
  return oldTokens >= ((1 - h) / h) * tailTokens;
}

export function estimateTokensFromChars(chars) {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function eventChars(event) {
  const data = event?.data;
  const message = data?.message ?? data;
  const content = message?.content;
  if (!Array.isArray(content)) return JSON.stringify(data ?? "").length;
  return content.reduce((sum, block) => {
    if (typeof block?.text === "string") return sum + block.text.length;
    return sum + JSON.stringify(block ?? "").length;
  }, 0);
}

export function estimateEventTokens(event, tokenMeter) {
  if (tokenMeter && typeof tokenMeter.estimateMessage === "function") {
    const message = event?.data?.message ?? (event?.type === "user/message" ? event.data : null);
    if (message && Array.isArray(message.content)) {
      try { return tokenMeter.estimateMessage(message); } catch { /* fall through */ }
    }
  }
  return estimateTokensFromChars(eventChars(event));
}

/**
 * Operator+architect pairs from a turn-bounded event log. A pair starts at
 * the first operator user/message of a turn and ends at that turn's
 * turn/end (or the last event of the turn). Plugin-only turns are not pairs.
 */
export function pairBoundaries(events) {
  const byTurn = new Map();
  let current;
  for (const event of events) {
    if (event.type === "turn/start") current = event.data?.turn;
    const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : current;
    if (!Number.isSafeInteger(turn)) {
      if (event.type === "turn/end") current = undefined;
      continue;
    }
    if (!byTurn.has(turn)) byTurn.set(turn, []);
    byTurn.get(turn).push(event);
    if (event.type === "turn/end") current = undefined;
  }
  const pairs = [];
  for (const [turn, slice] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
    const operator = slice.some((event) =>
      event.type === "user/message" && event.data?.source?.kind !== "plugin");
    if (!operator) continue;
    pairs.push({
      turn,
      startSeq: slice[0].seq,
      endSeq: slice.at(-1).seq,
      events: slice,
    });
  }
  return pairs;
}

function tokensForEvents(events, tokenMeter) {
  return events.reduce((sum, event) => {
    if (event.type === "user/message" || event.type === "assistant/message" || event.type === "tool/result") {
      return sum + estimateEventTokens(event, tokenMeter);
    }
    return sum;
  }, 0);
}

function surfaceNodes(session, events) {
  const nodes = session?.surface?.nodes;
  if (Array.isArray(nodes) && nodes.length > 0) {
    const bySeq = new Map(events.map((event) => [event.seq, event]));
    return nodes.map((seq) => bySeq.get(seq)).filter(Boolean);
  }
  return events.filter((event) =>
    event.surfaceOp === "append"
    || event.surfaceOp?.op === "replace"
    || event.type === "user/message"
    || event.type === "assistant/message"
    || event.type === "tool/result");
}

/**
 * Decide a fold. Returns null when nothing drops. Never splits a pair and
 * never drops the latest pair. Clerk late (pendingClerk) skips this turn.
 */
export function decideFold({
  events,
  session,
  tokenMeter,
  h = DEFAULT_H,
  q,
  route,
  pendingClerk = false,
} = {}) {
  if (pendingClerk) return { action: "skip", reason: "clerk-late" };
  const pairs = pairBoundaries(events);
  if (pairs.length <= MIN_PAIRS) return { action: "keep", reason: "two-turn-floor", pairs: pairs.length };
  const surface = surfaceNodes(session, events);
  const priced = pairs.map((pair) => ({
    ...pair,
    tokens: tokensForEvents(
      surface.filter((event) => event.seq >= pair.startSeq && event.seq <= pair.endSeq),
      tokenMeter,
    ),
  }));
  const tail = priced.slice(-MIN_PAIRS);
  const old = priced.slice(0, -MIN_PAIRS);
  const tailTokens = tail.reduce((sum, pair) => sum + pair.tokens, 0);
  const oldTokens = old.reduce((sum, pair) => sum + pair.tokens, 0);
  const talking = oldTokens + tailTokens;
  const ceiling = q ?? qualityCeiling(route);
  const overQ = talking > ceiling;
  const dropByH = shouldDropOld(oldTokens, tailTokens, h);
  if (tailTokens > ceiling) {
    return { action: "fail", reason: "tail-exceeds-q", oldTokens, tailTokens, talking, q: ceiling };
  }
  if (!overQ && !dropByH) {
    return { action: "keep", reason: "within-budget", oldTokens, tailTokens, talking, q: ceiling };
  }
  // Drop the whole Old prefix as one span. Do not nibble.
  const dropFrom = old[0].startSeq;
  const dropTo = old.at(-1).endSeq;
  return {
    action: "drop",
    reason: overQ ? "quality-ceiling" : "h",
    startSeq: dropFrom,
    endSeq: dropTo,
    oldTokens,
    tailTokens,
    talking,
    q: ceiling,
  };
}

function notesForSpan(notebook, startSeq, endSeq) {
  const notes = [];
  for (const card of notebook?.cards ?? []) {
    for (const note of card.notes) {
      if (note.startSeq <= endSeq && note.endSeq >= startSeq) notes.push(note);
    }
  }
  return notes;
}

function surfaceRange(session, events, startSeq, endSeq) {
  const nodes = Array.isArray(session?.surface?.nodes) ? [...session.surface.nodes] : [];
  if (nodes.length === 0) {
    const surface = events.filter((event) =>
      event.type === "user/message" || event.type === "assistant/message" || event.type === "tool/result");
    const inRange = surface.filter((event) => event.seq >= startSeq && event.seq <= endSeq);
    if (inRange.length === 0) return null;
    return { start: inRange[0].seq, end: inRange.at(-1).seq, seqs: inRange.map((event) => event.seq) };
  }
  const inRange = nodes.filter((seq) => seq >= startSeq && seq <= endSeq);
  if (inRange.length === 0) return null;
  return { start: inRange[0], end: inRange.at(-1), seqs: inRange };
}

export function createFolder({ store, tokenMeter, h = DEFAULT_H, q, now } = {}) {
  const pending = new Map();

  function queue(sessionId, decision) {
    if (decision?.action === "drop" || decision?.action === "fail") pending.set(sessionId, decision);
    else pending.delete(sessionId);
    return decision;
  }

  function decide(sessionId, { events, session, route, pendingClerk } = {}) {
    const decision = decideFold({
      events,
      session,
      tokenMeter,
      h,
      q: q ?? qualityCeiling(route),
      route,
      pendingClerk,
    });
    return queue(sessionId, decision);
  }

  function take(sessionId) {
    const decision = pending.get(sessionId);
    pending.delete(sessionId);
    return decision;
  }

  function apply(sessionId, { events, session } = {}) {
    const decision = pending.get(sessionId);
    if (!decision || decision.action !== "drop") return null;
    if (!session || typeof session.append !== "function") {
      throw new Error("qq-workflows: fold apply requires a live session.append");
    }
    const range = surfaceRange(session, events ?? session.events ?? [], decision.startSeq, decision.endSeq);
    if (!range) {
      pending.delete(sessionId);
      return { action: "skip", reason: "no-surface-range" };
    }
    const notebook = store.load(sessionId);
    const stub = store.freezeStub(sessionId, {
      startSeq: decision.startSeq,
      endSeq: decision.endSeq,
    });
    const notes = notesForSpan(notebook, decision.startSeq, decision.endSeq);
    const text = stub.text || formatStub(notes, decision.startSeq, decision.endSeq);
    const message = {
      id: `qq-workflows-fold-${sessionId}-${decision.startSeq}-${decision.endSeq}`,
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "plugin", plugin: "qq-workflows", form: "recall" },
    };
    session.append("user/message", message, {
      surfaceOp: { op: "replace", start: range.start, end: range.end },
      sourceEventSeqs: range.seqs,
    });
    pending.delete(sessionId);
    return { ...decision, applied: true, stub, at: now?.() ?? Date.now() };
  }

  return Object.freeze({
    decide,
    take,
    apply,
    pending: (sessionId) => pending.get(sessionId),
    clear: (sessionId) => pending.delete(sessionId),
  });
}

export const internals = Object.freeze({
  GROK_PROVIDERS,
  eventChars,
  surfaceNodes,
  surfaceRange,
  notesForSpan,
  tokensForEvents,
});
