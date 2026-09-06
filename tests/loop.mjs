#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runArchitectTurn } from "../paseo-plugin/host/loop.mjs";
import { TICKET_BLOCK_HEADING } from "../paseo-plugin/host/fold.mjs";
import { ARCHITECT_SYSTEM_PROMPT } from "../paseo-plugin/host/workflow/prompts.mjs";

const dir = mkdtempSync(join(tmpdir(), "architect-loop-"));
try {
  let calls = 0;
  const complete = async ({ instructions, input }) => {
    calls += 1;
    assert.equal(instructions, ARCHITECT_SYSTEM_PROMPT);
    assert.match(input[0].content, new RegExp(TICKET_BLOCK_HEADING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    if (calls === 1) {
      assert.equal(input.at(-1).content, "hello");
      return {
        text: "",
        toolCalls: [{ id: "1", name: "ticket_write", arguments: { text: "# Ticket\n\n## Kind\n\nbounded\n" } }],
        raw: {
          output: [{
            type: "function_call",
            call_id: "1",
            name: "ticket_write",
            arguments: JSON.stringify({ text: "# Ticket\n\n## Kind\n\nbounded\n" }),
          }],
        },
      };
    }
    const callItem = input.find((item) => item.type === "function_call");
    const outputItem = input.find((item) => item.type === "function_call_output");
    assert.equal(callItem?.call_id, "1");
    assert.equal(callItem?.name, "ticket_write");
    assert.equal(outputItem?.type, "function_call_output");
    assert.equal(outputItem?.call_id, "1");
    assert.equal(outputItem?.output, "ok");
    assert.equal(input.some((item) => item.tool_call_id || item.role === "tool"), false);
    assert.equal(input.some((item) => item.role === "assistant" && item.tool_calls), false);
    return { text: "Ticket is bounded.", toolCalls: [] };
  };
  const executed = [];
  const result = await runArchitectTurn({
    cwd: dir,
    operatorText: "hello",
    pairs: [{ operator: "prev", architect: "prev-reply" }],
    complete,
    executeTool: async (name, args) => {
      executed.push({ name, args });
      return "ok";
    },
  });
  assert.equal(result.architectText, "Ticket is bounded.");
  assert.deepEqual(result.pairs.map((pair) => pair.operator), ["prev", "hello"]);
  assert.equal(executed[0].name, "ticket_write");
  assert.equal(calls, 2);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
