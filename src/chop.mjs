// Chop: model-free old tool-result stubs at assemble. Never from session/event.
//
// Fold will not split an operator pair, so a runaway turn can fill the
// quality ceiling with closed tool dumps. compact-basic auto stays off;
// this is the workflow-owned chop that comment promised. Prune fat middles
// first (DSH toolResultPruner), then replace older closed results with a
// one-line stub until talking is under the target, keeping the last few.
// If talking is still over Q, refuse the request instead of hitting the API.

import {
  estimateEventTokens,
  qualityCeiling,
  internals as foldInternals,
} from "./fold.mjs";

export const KEEP_MIN_TOOLS = 8;
export const PRESSURE_RATIO = 0.8;
export const TARGET_RATIO = 0.55;
export const STUB_MAX_CHARS = 240;
export const OVERFLOW_MESSAGE = "qq-workflows: open tail cannot fit after chop; fold refused.";
const STUB_PREFIX = "[tool result omitted";

function lookupEvent(session, seq) {
  const events = session?.events;
  if (!Array.isArray(events)) return null;
  if (events[seq]?.seq === seq) return events[seq];
  return events.find((event) => event?.seq === seq) ?? null;
}

function resultBlocks(event) {
  const block = event?.data?.message?.content?.[0];
  return block?.type === "tool-result" && Array.isArray(block.content) ? block.content : null;
}

function resultChars(event) {
  const blocks = resultBlocks(event);
  if (!blocks) return foldInternals.eventChars(event);
  return blocks.reduce((sum, block) => (
    sum + (typeof block?.text === "string" ? block.text.length : JSON.stringify(block ?? "").length)
  ), 0);
}

function isStubResult(event) {
  const blocks = resultBlocks(event);
  if (!blocks) return false;
  const text = blocks.map((block) => (typeof block?.text === "string" ? block.text : "")).join("");
  return text.startsWith(STUB_PREFIX) || resultChars(event) <= STUB_MAX_CHARS;
}

function surfaceToolResults(session, events) {
  const list = Array.isArray(events) ? events : [];
  const nodes = session?.surface?.nodes;
  const seqs = Array.isArray(nodes) && nodes.length > 0
    ? nodes
    : list.filter((event) => event?.type === "tool/result").map((event) => event.seq);
  const out = [];
  for (const seq of seqs) {
    const event = lookupEvent(session, seq) ?? list.find((item) => item?.seq === seq);
    if (event?.type === "tool/result") out.push(event);
  }
  return out;
}

function talkingTokens(session, events, tokenMeter) {
  const list = Array.isArray(events) ? events : [];
  const nodes = session?.surface?.nodes;
  const surface = Array.isArray(nodes) && nodes.length > 0
    ? nodes.map((seq) => lookupEvent(session, seq) ?? list.find((item) => item?.seq === seq)).filter(Boolean)
    : foldInternals.surfaceNodes(session, list);
  return surface.reduce((sum, event) => {
    if (event.type === "user/message" || event.type === "assistant/message" || event.type === "tool/result") {
      return sum + estimateEventTokens(event, tokenMeter);
    }
    return sum;
  }, 0);
}

/**
 * Decide which closed tool/result surface nodes to stub. Keeps the newest
 * keepMin results. No-op under pressure. Never touches a missing result.
 */
export function decideChop({
  events,
  session,
  tokenMeter,
  q,
  route,
  keepMin = KEEP_MIN_TOOLS,
  pressureRatio = PRESSURE_RATIO,
  targetRatio = TARGET_RATIO,
} = {}) {
  const ceiling = q ?? qualityCeiling(route);
  const talking = talkingTokens(session, events, tokenMeter);
  const pressure = Math.floor(ceiling * pressureRatio);
  const target = Math.floor(ceiling * targetRatio);
  const results = surfaceToolResults(session, events);
  const keep = Math.max(0, Number.isSafeInteger(keepMin) ? keepMin : KEEP_MIN_TOOLS);
  if (talking <= pressure) {
    return { action: "keep", reason: "within-pressure", talking, q: ceiling, target, keep };
  }
  const older = results.slice(0, Math.max(0, results.length - keep)).filter((event) => !isStubResult(event));
  if (older.length === 0) {
    return { action: "keep", reason: "nothing-to-chop", talking, q: ceiling, target, keep };
  }
  const seqs = [];
  let remaining = talking;
  for (const event of older) {
    if (remaining <= target && seqs.length > 0) break;
    seqs.push(event.seq);
    remaining = Math.max(0, remaining - estimateEventTokens(event, tokenMeter) + 16);
  }
  return {
    action: "chop",
    reason: "pressure",
    seqs,
    talking,
    q: ceiling,
    target,
    keep,
  };
}

export function applyChop(session, decision) {
  if (decision?.action !== "chop" || !Array.isArray(decision.seqs) || decision.seqs.length === 0) {
    return { applied: 0 };
  }
  if (!session || typeof session.append !== "function") {
    throw new Error("qq-workflows: chop apply requires a live session.append");
  }
  let applied = 0;
  for (const seq of decision.seqs) {
    const event = lookupEvent(session, seq);
    if (event?.type !== "tool/result" || isStubResult(event)) continue;
    const message = event.data?.message;
    const result = message?.content?.[0];
    if (!result || result.type !== "tool-result") continue;
    const chars = resultChars(event);
    const stub = `${STUB_PREFIX} · ${chars} chars]`;
    session.append("tool/result", {
      ...event.data,
      message: {
        ...message,
        content: [{ ...result, content: [{ type: "text", text: stub }] }],
      },
    }, {
      surfaceOp: { op: "replace", start: seq, end: seq },
      sourceEventSeqs: [seq],
    });
    applied += 1;
  }
  return { applied };
}

/**
 * Assemble-time guard. Prune fat middles, then stub old closed tools.
 * Returns overflow when talking is still over Q. Does not throw overflow;
 * the caller aborts the request.
 */
export function guardContext({ ctx, session, route, tokenMeter, q } = {}) {
  let pruneError = null;
  const pruner = ctx?.get?.("toolResultPruner", false);
  if (pruner && typeof pruner.pruneSession === "function") {
    try { pruner.pruneSession(session); } catch (error) { pruneError = error; }
  }
  const meter = tokenMeter ?? ctx?.get?.("tokenMeter", false) ?? null;
  const events = session?.events ?? [];
  const ceiling = q ?? qualityCeiling(route);
  let decision = decideChop({ events, session, tokenMeter: meter, q: ceiling, route });
  if (decision.action === "chop") {
    applyChop(session, decision);
    decision = session?.surface?.nodes
      ? decideChop({ events: session.events ?? events, session, tokenMeter: meter, q: ceiling, route })
      : { ...decision, action: "keep", reason: "chopped", talking: decision.target };
  }
  const talking = Number.isFinite(decision.talking) ? decision.talking : 0;
  return {
    ...decision,
    q: ceiling,
    talking,
    pruneError,
    overflow: talking > ceiling,
  };
}

export const internals = Object.freeze({
  lookupEvent,
  resultChars,
  isStubResult,
  surfaceToolResults,
  talkingTokens,
});
