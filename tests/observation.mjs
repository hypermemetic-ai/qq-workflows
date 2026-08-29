#!/usr/bin/env node
import assert from "node:assert/strict";

import { capArchitectToolObservation, createArchitect } from "../src/architect.mjs";
import {
  OBSERVATION_HEAD_CHARS,
  OBSERVATION_MAX_CHARS,
  OBSERVATION_TAIL_CHARS,
  capObservationTool,
  codePointCount,
  truncateObservation,
  truncateObservationContent,
  truncationMarker,
} from "../src/observation.mjs";
import {
  OBSERVATION_MAX_CHARS as MINI_OBSERVATION_MAX_CHARS,
  truncateObservation as truncateMiniObservation,
} from "../src/official-mini.mjs";

assert.equal(MINI_OBSERVATION_MAX_CHARS, OBSERVATION_MAX_CHARS);
assert.equal(truncateMiniObservation, truncateObservation, "Mini re-exports the shared helper");

{
  const text = `small 😀 ${"x".repeat(9_000)}`;
  assert.equal(truncateObservation(text), text);
}

{
  const text = `${"H".repeat(6_000)}${"😀".repeat(2_000)}${"T".repeat(6_000)}`;
  const truncated = truncateObservation(text);
  assert.equal(
    truncated,
    `${Array.from(text).slice(0, OBSERVATION_HEAD_CHARS).join("")}${truncationMarker(4_000)}${Array.from(text).slice(-OBSERVATION_TAIL_CHARS).join("")}`,
  );
  assert.equal(truncateObservation(truncated), truncated, "already-capped observations stay byte-stable");
  const markerInLongText = `prefix${truncationMarker(1)}${"x".repeat(12_000)}`;
  assert.notEqual(truncateObservation(markerInLongText), markerInLongText);
}

{
  const content = [
    { type: "text", text: "A".repeat(4_000) },
    { type: "image", attachment: { id: "proof" } },
    { type: "text", text: "B".repeat(8_000) },
  ];
  const capped = truncateObservationContent(content);
  assert.equal(capped.find((block) => block.type === "image"), content[1]);
  const text = capped.filter((block) => block.type === "text").map((block) => block.text).join("");
  assert.equal(text, truncateObservation("A".repeat(4_000) + "B".repeat(8_000)));
}

{
  const full = "m".repeat(14_000);
  const base = {
    name: "mcp_result",
    output: { render: () => [{ type: "text", text: "fallback" }] },
    finalizeContent: () => [{ type: "text", text: full }],
    execute() {},
  };
  const capped = capObservationTool(base);
  assert.equal(capped.name, base.name);
  assert.equal(capped.execute, base.execute);
  assert.equal(capped.finalizeContent({}, { content: [] })[0].text, truncateObservation(full));
  assert.equal(capObservationTool(capped), capped, "tool wrapping is idempotent");
}

{
  const fat = "head\n" + "x".repeat(14_000) + "\ntail";
  const result = { content: [{ type: "text", text: fat }], isError: false, value: {} };
  const decision = await capArchitectToolObservation({}, result, async () => ({ kind: "accept" }));
  assert.equal(decision.kind, "accept");
  assert.equal(decision.content[0].text, truncateObservation(fat));
  assert.doesNotMatch(decision.content[0].text, /\[tool result omitted/i);
}

{
  const listeners = [];
  const sessionId = "session-63a11000-0000-4000-8000-000000000099";
  const architect = createArchitect({
    ctx: { get: () => null },
    cases: { open() {}, ensure() {} },
    folder: { decide: () => ({ action: "keep" }) },
  });
  const agent = {
    status: "running",
    options: {},
    session: {
      id: sessionId,
      header: {},
      events: [],
      append(type, data) { this.events.push({ type, data }); },
    },
    ctx: {
      on(type, fn) {
        listeners.push({ type, fn });
        return () => {};
      },
    },
  };
  architect.attach(agent);
  const capture = listeners.find((listener) => listener.type === "tools/post-execute");
  assert.ok(capture, "architect installs a capture-time tool-result cap");
  const text = "z".repeat(OBSERVATION_MAX_CHARS + 2_000);
  const decision = await capture.fn(
    {},
    { content: [{ type: "text", text }], isError: false, value: null },
    async () => ({ kind: "accept" }),
  );
  assert.equal(decision.content[0].text, truncateObservation(text));
  assert.equal(codePointCount(decision.content[0].text), OBSERVATION_MAX_CHARS + codePointCount(truncationMarker(2_000)));
  architect.detach(agent);
}

console.log("observation tests passed");
