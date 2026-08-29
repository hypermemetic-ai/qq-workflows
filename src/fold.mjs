// Fold: decide after a turn, apply at the next request. Never mid-turn.
//
// Keep the current and previous operator+architect pair and replace the whole
// older span. The short replacement points back to the visible working-memory
// document instead of maintaining another standing store. A fold is forbidden
// while working memory is empty: replacing history would otherwise erase the plan.

import { isWorkingMemoryEmpty } from "./casefile.mjs";

export const DEFAULT_H = 0.1;
export const DEFAULT_Q = 256_000;
export const GROK_Q = 200_000;
export const MIN_PAIRS = 2;
export const CHARS_PER_TOKEN = 4;
export const FOLD_REPLACEMENT_TEXT = "Earlier conversation omitted. Non-empty working memory contains the durable plan.";
export const EMPTY_FOLD_MESSAGE = "qq-workflows: fold refused because working memory is empty; write working memory before more history is omitted.";
export const OVERFLOW_MESSAGE = "qq-workflows: open tail cannot fit after pruning; fold refused.";

const GROK_PROVIDERS = new Set(["xai-auth", "xai"]);

export function qualityCeiling(route) {
  const provider = route?.provider;
  const model = route?.model;
  if (GROK_PROVIDERS.has(provider) || /grok/i.test(String(model ?? ""))) {
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

function reasonKind(reason) {
  return reason && typeof reason === "object" ? reason.kind : reason;
}

function isIncompleteSlice(slice) {
  const end = [...slice].reverse().find((event) => event.type === "turn/end");
  if (!end) return true;
  const kind = reasonKind(end.data?.reason);
  return kind === "aborted" || kind === "interrupted";
}

function hasOperator(slice) {
  return slice.some((event) =>
    event.type === "user/message" && event.data?.source?.kind !== "plugin");
}

/**
 * Operator+architect pairs from a turn-bounded event log. A pair starts at
 * the first operator user/message of a stretch and ends at a completed
 * turn/end. Aborted or interrupted turns are not pairs; a resume after abort
 * (operator continue, host continue) stays the same open stretch. Plugin-only
 * turns are not pairs.
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
  let open = null;
  for (const [turn, slice] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
    const operator = hasOperator(slice);
    const incomplete = isIncompleteSlice(slice);
    if (open) {
      open.events.push(...slice);
      if (operator && open.turn == null) open.turn = turn;
      open.hasOperator = open.hasOperator || operator;
      if (!incomplete) {
        if (open.hasOperator) {
          pairs.push({
            turn: open.turn ?? turn,
            startSeq: open.startSeq,
            endSeq: slice.at(-1).seq,
            events: open.events,
          });
        }
        open = null;
      }
      continue;
    }
    if (!operator) continue;
    if (incomplete) {
      open = { turn, startSeq: slice[0].seq, events: [...slice], hasOperator: true };
      continue;
    }
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
 * never drops the latest pair.
 */
export function decideFold({
  events,
  session,
  tokenMeter,
  h = DEFAULT_H,
  q,
  route,
} = {}) {
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
  if (tailTokens > ceiling) {
    return { action: "fail", reason: "tail-exceeds-q", oldTokens, tailTokens, talking, q: ceiling };
  }
  // Drop the whole Old prefix as one span. Do not nibble.
  const dropFrom = old[0].startSeq;
  const dropTo = old.at(-1).endSeq;
  return {
    action: "drop",
    reason: "two-turn",
    startSeq: dropFrom,
    endSeq: dropTo,
    oldTokens,
    tailTokens,
    talking,
    q: ceiling,
  };
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
  let startIdx = -1;
  let endIdx = -1;
  for (let index = 0; index < nodes.length; index += 1) {
    const seq = nodes[index];
    if (seq >= startSeq && seq <= endSeq) {
      if (startIdx < 0) startIdx = index;
      endIdx = index;
    }
  }
  if (startIdx < 0) return null;
  // Surface replacements can land in the span with a later seq. DSH shadows
  // by index between start and end, so provenance includes those inserts.
  const seqs = nodes.slice(startIdx, endIdx + 1);
  return { start: seqs[0], end: seqs.at(-1), seqs };
}

export function talkingTokens(session, events, tokenMeter) {
  const list = Array.isArray(events) ? events : [];
  return surfaceNodes(session, list).reduce((sum, event) => {
    if (event.type === "user/message" || event.type === "assistant/message" || event.type === "tool/result") {
      return sum + estimateEventTokens(event, tokenMeter);
    }
    return sum;
  }, 0);
}

/** Prune closed result middles first, then report whether talking exceeds Q. */
export function guardContext({ ctx, session, route, tokenMeter, q } = {}) {
  let pruneError = null;
  const pruner = ctx?.get?.("toolResultPruner", false);
  if (pruner && typeof pruner.pruneSession === "function") {
    try { pruner.pruneSession(session); } catch (error) { pruneError = error; }
  }
  const meter = tokenMeter ?? ctx?.get?.("tokenMeter", false) ?? null;
  const ceiling = q ?? qualityCeiling(route);
  const talking = talkingTokens(session, session?.events ?? [], meter);
  return {
    action: "keep",
    reason: talking > ceiling ? "overflow" : "within-budget",
    q: ceiling,
    talking,
    pruneError,
    overflow: talking > ceiling,
  };
}

export function createFolder({ tokenMeter, h = DEFAULT_H, q, now } = {}) {
  const pending = new Map();

  function queue(sessionId, decision) {
    if (decision?.action === "drop" || decision?.action === "fail") pending.set(sessionId, decision);
    else pending.delete(sessionId);
    return decision;
  }

  function decide(sessionId, { events, session, route } = {}) {
    const decision = decideFold({
      events,
      session,
      tokenMeter,
      h,
      q: q ?? qualityCeiling(route),
      route,
    });
    return queue(sessionId, decision);
  }

  function take(sessionId) {
    const decision = pending.get(sessionId);
    pending.delete(sessionId);
    return decision;
  }

  function apply(sessionId, { events, session, workingMemory } = {}) {
    const decision = pending.get(sessionId);
    if (!decision || decision.action !== "drop") return null;
    if (isWorkingMemoryEmpty(workingMemory)) {
      pending.delete(sessionId);
      return { action: "fail", reason: "working-memory-empty", message: EMPTY_FOLD_MESSAGE };
    }
    if (!session || typeof session.append !== "function") {
      throw new Error("qq-workflows: fold apply requires a live session.append");
    }
    const range = surfaceRange(session, events ?? session.events ?? [], decision.startSeq, decision.endSeq);
    if (!range) {
      pending.delete(sessionId);
      return { action: "skip", reason: "no-surface-range" };
    }
    const text = FOLD_REPLACEMENT_TEXT;
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
    return { ...decision, applied: true, at: now?.() ?? Date.now() };
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
  tokensForEvents,
  reasonKind,
  isIncompleteSlice,
  hasOperator,
});
