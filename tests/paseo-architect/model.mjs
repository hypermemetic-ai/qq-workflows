#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  completeArchitect,
  createResponsesAccumulator,
  parseResponsesBody,
  parseSseJsonEvents,
} from "../../paseo-plugin/host/model.mjs";

const sse = [
  "event: response.output_text.delta",
  'data: {"type":"response.output_text.delta","delta":"Hello"}',
  "",
  "event: response.output_item.done",
  'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"Hello"}]}}',
  "",
  "event: response.completed",
  'data: {"type":"response.completed","response":{"output":null}}',
  "",
].join("\n");

const events = parseSseJsonEvents(sse);
assert.equal(events[0].delta, "Hello");
assert.equal(events.at(-1).response.output, null);

const acc = createResponsesAccumulator();
for (const event of events) await acc.push(event);
const parsed = acc.result();
assert.equal(parsed.text, "Hello");
assert.deepEqual(parsed.toolCalls, []);

function sseEvent(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const args = JSON.stringify({ text: "# Ticket\n" });
const toolSse = [
  sseEvent({
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", call_id: "c1", name: "ticket_write", arguments: "" },
  }),
  sseEvent({ type: "response.function_call_arguments.delta", output_index: 0, delta: args.slice(0, 8) }),
  sseEvent({ type: "response.function_call_arguments.done", output_index: 0, arguments: args }),
  sseEvent({
    type: "response.output_item.done",
    item: { type: "function_call", call_id: "c1", name: "ticket_write", arguments: args },
  }),
  sseEvent({ type: "response.completed", response: { output: null } }),
].join("");
const tools = createResponsesAccumulator();
for (const event of parseSseJsonEvents(toolSse)) await tools.push(event);
const toolResult = tools.result();
assert.equal(toolResult.toolCalls[0].name, "ticket_write");
assert.equal(toolResult.toolCalls[0].id, "c1");
assert.equal(toolResult.functionCalls[0].type, "function_call");

const deltas = [];
const bodies = [];
const streamed = await completeArchitect({
  instructions: "You are the architect.",
  input: [{ role: "user", content: "hi" }],
  tools: [],
  auth: { accessToken: "tok", accountId: "acct" },
  onDelta: async (delta) => {
    deltas.push(delta);
  },
  fetchFn: async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      async text() {
        return sse;
      },
    };
  },
});
assert.equal(bodies[0].stream, true);
assert.equal(bodies[0].store, false);
assert.equal(streamed.text, "Hello");
assert.deepEqual(deltas, ["Hello"]);

const rejected = await completeArchitect({
  instructions: "You are the architect.",
  input: [{ role: "user", content: "hi" }],
  auth: { accessToken: "tok" },
  fetchFn: async () => ({
    ok: false,
    status: 400,
    async text() {
      return JSON.stringify({ detail: "Stream must be set to true" });
    },
  }),
}).then(
  () => null,
  (error) => error.message,
);
assert.match(rejected, /Stream must be set to true/);

assert.equal(parseResponsesBody({ output: [], output_text: "fallback" }).text, "fallback");
