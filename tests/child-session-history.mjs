#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  CHILD_SESSION_HISTORY_INSTRUCTIONS,
  createChildSessionHistoryAdapter,
  sessionHistoryToolDefinition,
} from "../src/child-session-history.mjs";

const SESSION = "session-11111111-1111-4111-8111-111111111111";
const OTHER = "session-22222222-2222-4222-8222-222222222222";
const raw = [
  { seq: 0, time: 1, type: "user/message", data: { id: "m0", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "fix alpha cancellation" }] } },
  { seq: 1, time: 2, type: "assistant/message", data: { message: { id: "m1", role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "inspect alpha" }, { type: "tool-call", id: "call-bash", name: "bash", arguments: "{\"command\":\"rg alpha\"}" }] } } },
  { seq: 2, time: 3, type: "tool/call", data: { callId: "call-bash", name: "bash", arguments: "{\"command\":\"rg alpha\"}" } },
  { seq: 3, time: 4, type: "tool/result", data: { message: { id: "m3", role: "user", source: { kind: "tool", callId: "call-bash" }, content: [{ type: "tool-result", toolCallId: "call-bash", isError: false, content: [{ type: "text", text: "alpha result" }] }] } } },
  { seq: 4, time: 5, type: "assistant/message", data: { message: { id: "m4", role: "assistant", source: { kind: "model" }, content: [{ type: "tool-call", id: "call-history", name: "session_history", arguments: "{\"action\":\"search\",\"queries\":[\"alpha\"]}" }] } } },
  { seq: 5, time: 6, type: "tool/call", data: { callId: "call-history", name: "session_history", arguments: "{\"action\":\"search\"}" } },
  { seq: 6, time: 7, type: "tool/result", data: { message: { id: "m6", role: "user", source: { kind: "tool", callId: "call-history" }, content: [{ type: "tool-result", toolCallId: "call-history", isError: false, content: [{ type: "text", text: "alpha feedback" }] }] } } },
];
const requests = [];
const traces = [];
const sessionQuery = {
  async searchEvents(request) {
    requests.push(request);
    return {
      session: { id: SESSION },
      items: [
        { sessionId: SESSION, seq: 4, type: "assistant/message", time: 5, surface: "current", snippet: "alpha query feedback" },
        { sessionId: SESSION, seq: 6, type: "tool/result", time: 7, surface: "current", snippet: "alpha result feedback" },
        { sessionId: SESSION, seq: 0, type: "user/message", time: 1, surface: "shadowed", snippet: "fix alpha cancellation" },
      ],
      nextCursor: `cursor:${request.query}`,
    };
  },
  async readEvent({ sessionId, seq, before, after }) {
    assert.equal(sessionId, SESSION);
    return { session: { id: SESSION }, target: raw[seq], events: raw.slice(Math.max(0, seq - before), seq + after + 1), startSeq: Math.max(0, seq - before), endSeq: Math.min(raw.length - 1, seq + after) };
  },
  async traceEvent({ sessionId, seq }) {
    traces.push({ sessionId, seq });
    return { session: { id: SESSION }, target: { sessionId: SESSION, seq, type: raw[seq].type, time: raw[seq].time, surface: seq === 5 ? "log-only" : (seq < 4 ? "shadowed" : "current") }, replacementChain: [], replacedEventSeqs: [], sourceEventSeqs: [], derivedEventSeqs: [] };
  },
};
const agent = { session: { id: SESSION, events: raw } };
const adapter = createChildSessionHistoryAdapter(sessionQuery, agent);
const found = await adapter.execute({ action: "search", queries: [" Alpha ", "cancellation"], limit: 3 }, { signal: new AbortController().signal });
assert.deepEqual(requests.map(({ sessionId, query }) => ({ sessionId, query })), [
  { sessionId: SESSION, query: "Alpha" },
  { sessionId: SESSION, query: "cancellation" },
]);
for (const request of requests) assert.deepEqual(request.filters, [
  { kind: "type", values: ["user/message", "assistant/message", "tool/call", "tool/result"] },
  { kind: "surface", values: ["current", "shadowed"] },
]);
assert.deepEqual(found.results[0].events.map(({ seq }) => seq), [0], "self query and result are removed without reranking");
assert.equal(found.results[0].nextCursor, "cursor:Alpha");
assert.equal(found.sessionId, undefined, "session identity is not exposed as a mutable argument");
await assert.rejects(adapter.execute({ action: "search", queries: ["x"], sessionId: OTHER }), /does not accept sessionId/);
await assert.rejects(adapter.execute({ action: "search", queries: [] }), /1 to 5/);
await assert.rejects(adapter.execute({ action: "search", queries: ["x", "y"], cursor: "c" }), /one query/);

const context = await adapter.execute({ action: "context", seq: 2, before: 2, after: 2 });
assert.equal(context.targetSeq, 2);
assert.deepEqual(context.events.map(({ role }) => role), ["user", "assistant", "tool-call", "tool-result"]);
assert.deepEqual(context.events.map(({ seq }) => seq), [0, 1, 2, 3]);
assert.equal(context.events.find(({ seq }) => seq === 2).target, true);
assert.ok(traces.some(({ sessionId, seq }) => sessionId === SESSION && seq === 2));
await assert.rejects(adapter.execute({ action: "context", seq: 5 }), /current or shadowed/);
await assert.rejects(adapter.execute({ action: "context", seq: 4 }), /feedback/);

const hugeEvent = {
  seq: 0,
  time: 1,
  type: "tool/result",
  data: { message: { source: { kind: "tool", callId: "ordinary" }, content: [{ type: "tool-result", toolCallId: "ordinary", content: [{ type: "text", text: "z".repeat(50_000) }] }] } },
};
const hugeAgent = { session: { id: SESSION, events: [hugeEvent] } };
const hugeAdapter = createChildSessionHistoryAdapter({
  async searchEvents() { return { session: { id: SESSION }, items: [] }; },
  async readEvent() { return { session: { id: SESSION }, target: hugeEvent, events: [hugeEvent], startSeq: 0, endSeq: 0 }; },
  async traceEvent() { return { session: { id: SESSION }, target: { sessionId: SESSION, seq: 0, type: "tool/result", time: 1, surface: "current" } }; },
}, hugeAgent);
const hugeContext = await hugeAdapter.execute({ action: "context", seq: 0, before: 12, after: 12 });
assert.equal(hugeContext.truncated, true);
assert.ok(hugeContext.events[0].text.length <= 900);
assert.ok(Buffer.byteLength(JSON.stringify(hugeContext), "utf8") <= 16 * 1024);

// Backend identity is checked independently of immutable input shape.
const crossSessionSearch = createChildSessionHistoryAdapter({
  ...sessionQuery,
  async searchEvents() { return { session: { id: OTHER }, items: [] }; },
}, agent);
await assert.rejects(crossSessionSearch.execute({ action: "search", queries: ["alpha"] }), /cross-session response/);
const crossSessionHit = createChildSessionHistoryAdapter({
  ...sessionQuery,
  async searchEvents() { return { session: { id: SESSION }, items: [{ sessionId: OTHER, seq: 0, type: "user/message", time: 1, surface: "current", snippet: "alpha" }] }; },
}, agent);
await assert.rejects(crossSessionHit.execute({ action: "search", queries: ["alpha"] }), /cross-session hit/);
const oversizedPage = createChildSessionHistoryAdapter({
  ...sessionQuery,
  async searchEvents() { return { session: { id: SESSION }, items: Array.from({ length: 2 }, () => ({ sessionId: SESSION, seq: 0, type: "user/message", time: 1, surface: "current", snippet: "alpha" })) }; },
}, agent);
await assert.rejects(oversizedPage.execute({ action: "search", queries: ["alpha"], limit: 1 }), /oversized backend page/);
const malformedCursor = createChildSessionHistoryAdapter({
  ...sessionQuery,
  async searchEvents() { return { session: { id: SESSION }, items: [], nextCursor: 42 }; },
}, agent);
await assert.rejects(malformedCursor.execute({ action: "search", queries: ["alpha"] }), /cursor must be/);

const crossSessionTrace = createChildSessionHistoryAdapter({
  ...sessionQuery,
  async traceEvent({ seq }) { return { session: { id: OTHER }, target: { sessionId: OTHER, seq, type: "user/message", surface: "current" } }; },
}, agent);
await assert.rejects(crossSessionTrace.execute({ action: "context", seq: 0 }), /cross-session response/);

assert.match(CHILD_SESSION_HISTORY_INSTRUCTIONS, /1.?5 distinctive literal/i);
assert.match(CHILD_SESSION_HISTORY_INSTRUCTIONS, /verify referenced files/i);
const definition = sessionHistoryToolDefinition(() => {});
assert.equal(definition.name, "session_history");
assert.equal(definition.parameters.properties.sessionId, undefined);
assert.deepEqual(definition.parameters.properties.action.enum, ["search", "context"]);
adapter.dispose();
await assert.rejects(adapter.execute({ action: "search", queries: ["x"] }), /disposed/);

console.log("child session history: ok");
