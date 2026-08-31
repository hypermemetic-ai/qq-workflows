#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  FOLD_REPLACEMENT_TEXT,
  createFolder,
  decideFold,
  guardContext,
  pairBoundaries,
} from "../src/fold.mjs";

function appendTurn(events, {
  turn,
  source = { kind: "operator" },
  reason = "complete",
  close = true,
  text = `message ${turn}`,
} = {}) {
  let seq = (events.at(-1)?.seq ?? -1) + 1;
  events.push({ seq: seq++, type: "turn/start", data: { turn } });
  events.push({
    seq: seq++,
    type: "user/message",
    data: { turn, source, content: [{ type: "text", text }] },
  });
  if (close) {
    events.push({
      seq: seq++,
      type: "assistant/message",
      data: { turn, message: { content: [{ type: "text", text: `answer ${turn}` }] } },
    });
    events.push({ seq: seq++, type: "turn/end", data: { turn, reason } });
  }
  return events;
}

function conversation(pairTexts) {
  const events = [];
  let seq = 0;
  for (let index = 0; index < pairTexts.length; index++) {
    const turn = index + 1;
    events.push({ seq: seq++, type: "turn/start", data: { turn } });
    events.push({
      seq: seq++,
      type: "user/message",
      data: {
        turn,
        source: { kind: "operator" },
        content: [{ type: "text", text: `operator ${turn}` }],
      },
    });
    events.push({
      seq: seq++,
      type: "assistant/message",
      data: { turn, message: { content: [{ type: "text", text: pairTexts[index] }] } },
    });
    events.push({ seq: seq++, type: "turn/end", data: { turn, reason: "complete" } });
  }
  return events;
}

{
  const events = conversation(["first", "second"]);
  assert.deepEqual(decideFold({ events, q: 1 }), {
    action: "keep",
    reason: "two-turn-floor",
    pairs: 2,
  });
}

{
  const events = conversation(["one", "two", "three"]);
  const beforeOpen = decideFold({ events, q: 10_000 });
  appendTurn(events, { turn: 4, close: false, text: "current direct request" });

  assert.equal(pairBoundaries(events).length, 3, "the completed-only boundary view remains available");
  const withOpen = pairBoundaries(events, { includeOpen: true });
  assert.equal(withOpen.length, 4, "an open direct operator request is a protected current pair");
  assert.equal(withOpen.at(-1).turn, 4);
  assert.equal(withOpen.at(-1).endSeq, events.at(-1).seq);

  const refreshed = decideFold({ events, q: 10_000 });
  assert.equal(beforeOpen.endSeq, 3, "the stale N-1/N tail would drop only the first pair");
  assert.equal(refreshed.endSeq, 7, "N/current N+1 protects the open request and evicts the older completed pair");
}

{
  const events = conversation(["one", "two"]);
  appendTurn(events, {
    turn: 3,
    source: { kind: "plugin", plugin: "qq-workflows", form: "relay" },
    close: false,
    text: "relay packet",
  });

  assert.equal(pairBoundaries(events, { includeOpen: true }).length, 2, "an open relay-only turn is not a pair");
  assert.deepEqual(decideFold({ events, q: 10_000 }), {
    action: "keep",
    reason: "two-turn-floor",
    pairs: 2,
  });

  let seq = events.at(-1).seq + 1;
  events.push({
    seq: seq++,
    type: "assistant/message",
    data: { turn: 3, message: { content: [{ type: "text", text: "relay response" }] } },
  });
  events.push({ seq: seq++, type: "turn/end", data: { turn: 3, reason: "complete" } });
  assert.equal(pairBoundaries(events, { includeOpen: true }).length, 2, "a completed relay-only turn is not a pair");
  assert.equal(decideFold({ events, q: 10_000 }).pairs, 2, "relay completion cannot evict a protected direct pair");
}

{
  const events = [];
  appendTurn(events, { turn: 1, reason: "interrupted" });
  assert.equal(pairBoundaries(events).length, 0, "an interrupted operator stretch is not complete");
  assert.equal(pairBoundaries(events, { includeOpen: true }).length, 1, "the interrupted operator stretch remains protected while open");

  appendTurn(events, { turn: 2, text: "resume" });
  const resumed = pairBoundaries(events, { includeOpen: true });
  assert.equal(resumed.length, 1, "interrupted and resumed turns form one operator+architect pair");
  assert.equal(resumed[0].turn, 1);
  assert.equal(resumed[0].startSeq, 0);
  assert.equal(resumed[0].endSeq, events.at(-1).seq);
  assert.equal(resumed[0].events.length, events.length);
}

{
  // Old is tiny relative to Tail: neither h nor total talking may delay the fold.
  const events = conversation(["o", "x".repeat(2_000), "y".repeat(2_000)]);
  const decision = decideFold({ events, q: 10_000, h: 0.000_001 });
  assert.equal(decision.action, "drop");
  assert.equal(decision.reason, "two-turn");
  assert.equal(decision.startSeq, 0);
  assert.equal(decision.endSeq, 3);
  assert.ok(decision.oldTokens < decision.tailTokens);
}

{
  const events = conversation(["one", "two", "three", "four"]);
  const decision = decideFold({ events, q: 10_000 });
  assert.equal(decision.action, "drop");
  assert.equal(decision.startSeq, 0);
  assert.equal(decision.endSeq, 7, "the complete Old span drops as one range");
}

{
  const events = conversation(["old", "x".repeat(100), "y".repeat(100)]);
  const decision = decideFold({ events, q: 10 });
  assert.equal(decision.action, "fail");
  assert.equal(decision.reason, "tail-exceeds-q");
  assert.ok(decision.tailTokens > decision.q);
}

{
  const events = conversation(["old", "previous", "current"]);
  const appended = [];
  const session = {
    events,
    surface: { nodes: events.map((event) => event.seq) },
    append(type, data, options) { appended.push({ type, data, options }); },
  };
  const folder = createFolder({ q: 10_000, now: () => 123 });
  assert.equal(folder.decide("architect", { events, session }).action, "drop");
  const applied = folder.apply("architect", { events, session, workingMemory: "# Plan\n\nPersisted plan." });
  assert.equal(applied.applied, true);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].data.content[0].text, FOLD_REPLACEMENT_TEXT);
  assert.equal(FOLD_REPLACEMENT_TEXT, "Earlier conversation omitted. Non-empty working memory contains the durable plan.");
  assert.doesNotMatch(appended[0].data.content[0].text, /\d/);
  assert.deepEqual(appended[0].options.surfaceOp, { op: "replace", start: 0, end: 3 });
}


{
  const events = conversation(["old", "previous", "current"]);
  const appended = [];
  const session = {
    events,
    surface: { nodes: events.map((event) => event.seq) },
    append(...args) { appended.push(args); },
  };
  const folder = createFolder({ q: 10_000 });
  assert.equal(folder.decide("empty", { events, session }).action, "drop");
  const refused = folder.apply("empty", { events, session, workingMemory: "# Working memory" });
  assert.equal(refused.action, "fail");
  assert.equal(refused.reason, "working-memory-empty");
  assert.match(refused.message, /working memory is empty/i);
  assert.equal(appended.length, 0);
}

{
  let pruned = 0;
  const session = { events: conversation(["x".repeat(100)]) };
  const guard = guardContext({
    ctx: {
      get(name) {
        if (name === "toolResultPruner") return { pruneSession(target) { assert.equal(target, session); pruned++; } };
        return null;
      },
    },
    session,
    q: 1,
  });
  assert.equal(pruned, 1);
  assert.equal(guard.overflow, true);
  assert.ok(guard.talking > guard.q);
}

console.log("fold tests passed");
