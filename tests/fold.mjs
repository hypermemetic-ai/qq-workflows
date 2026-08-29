#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  FOLD_REPLACEMENT_TEXT,
  createFolder,
  decideFold,
  guardContext,
} from "../src/fold.mjs";

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
