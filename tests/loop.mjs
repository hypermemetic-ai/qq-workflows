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
          output: [{ type: "reasoning", encrypted_content: "opaque-test-reasoning", summary: [] }, {
            type: "function_call",
            call_id: "1",
            name: "ticket_write",
            arguments: JSON.stringify({ text: "# Ticket\n\n## Kind\n\nbounded\n" }),
          }],
        },
      };
    }
    assert.ok(input.some(item => item.type === "reasoning" && item.encrypted_content === "opaque-test-reasoning"));
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
  await runArchitectTurn({ cwd: dir, pairs: JSON.parse(JSON.stringify(result.pairs)), operatorText: "followup", complete: async ({ input }) => {
    assert.ok(input.some(item => item.type === 'reasoning'));
    assert.ok(input.some(item => item.type === 'function_call_output' && item.output === 'ok'));
    assert.ok(input.some(item => item.content === 'Ticket is bounded.'));
    return { text: 'retained', toolCalls: [] };
  } });
  const history = Array.from({ length: 4 }, (_, i) => ({ operator: `short ${i}`, architect: 'yes', messageId: `m${i}` }));
  const windows = [];
  const controller = new AbortController();
  await assert.rejects(runArchitectTurn({
    cwd: dir, pairs: history, operatorText: 'aborted', messageId: 'aborted-id', signal: controller.signal,
    onContextWindow: ids => windows.push(ids),
    complete: async ({ input }) => {
      assert.ok(!input.some(item => item.content === 'short 0'));
      assert.ok(input.some(item => item.content === 'short 3'));
      controller.abort(new Error('cancel generation'));
      return { text: 'unfinished', toolCalls: [] };
    },
  }), /cancel generation/);
  assert.equal(history.length, 4);
  assert.deepEqual(windows, [{ userMessageIds: ['m3', 'aborted-id'] }]);
  const resumed = await runArchitectTurn({ cwd: dir, pairs: history, operatorText: 'next', messageId: 'next-id', complete: async () => ({ text: 'done', toolCalls: [] }) });
  assert.equal(resumed.pairs.length, 2);
  assert.ok(!resumed.pairs.some(pair => pair.operator === 'aborted'));
  assert.equal(resumed.pairs.at(-1).messageId, 'next-id');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
