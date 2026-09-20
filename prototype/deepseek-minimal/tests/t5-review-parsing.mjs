#!/usr/bin/env node
/**
 * Acceptance 5: the existing reviewer PASS/FAIL parsing receives exactly the
 * final answer. Intermediate text and reasoning that mention the other verdict
 * must not reach the parsed output, so they cannot decide success.
 */
import assert from "node:assert/strict";
import {
  evaluateReviewPassed,
  handleExecutionStreamEvent,
  isTrustworthyReviewFail,
  parseReviewVerdict,
} from "../../../bin/mcp-server.mjs";
import { startMockProvider } from "../mock/mock-provider.mjs";
import { parseLines, runWorker, scrubRoutingEnv, tempDir } from "./harness.mjs";

scrubRoutingEnv();
const workdir = tempDir("t5");

/** Accumulate a reviewer child's clean output exactly like runChildSubagent does. */
function reviewerOutput(lines) {
  const execution = { trajectory: [], status: "running", startedAt: Date.now(), lastActivityAt: Date.now() };
  for (const line of lines) handleExecutionStreamEvent(execution, line);
  return (execution._cleanOutput ?? "").trim();
}

async function runReviewerCase(name, firstBlocks, finalText) {
  const mock = await startMockProvider({
    scenario: {
      turns: [
        { blocks: [...firstBlocks, { type: "tool_use", name: "bash", input: { command: `echo ${name}` } }], stopReason: "tool_use" },
        { blocks: [{ type: "text", text: finalText }], stopReason: "end_turn" },
      ],
    },
  });
  const result = await runWorker(["--seat", "reviewer", "--cwd", workdir, "--prompt", `review ${name}`, "--base-url", mock.url]);
  await mock.close();
  assert.equal(result.code, 0, `reviewer run must succeed: ${result.stderr}`);
  return { result, output: reviewerOutput(parseLines(result.stdout)) };
}

// --- A. scratch text claims PASS, the final verdict is FAIL ----------------
const failCase = await runReviewerCase(
  "case-a",
  [
    { type: "thinking", thinking: "Draft (must never be parsed): Verdict: PASS" },
    { type: "text", text: "Preliminary scratch note (must never be parsed): Verdict: PASS" },
  ],
  "Verdict: FAIL\n- one finding",
);
assert.equal(failCase.output, "Verdict: FAIL\n- one finding", "clean output must be exactly the final answer");
assert.deepEqual(parseReviewVerdict(failCase.output), { verdict: "FAIL" });
assert.equal(evaluateReviewPassed({ ok: true, output: failCase.output }), false);
assert.equal(isTrustworthyReviewFail({ ok: true, output: failCase.output }), true);
assert.ok(!failCase.result.stderr.includes("Draft"), "reasoning must never be written to stderr");

// --- B. scratch text grumbles FAIL, the final verdict is PASS --------------
const passCase = await runReviewerCase(
  "case-b",
  [
    { type: "thinking", thinking: "I expect to say Verdict: FAIL" },
    { type: "text", text: "Preliminary (must never be parsed): Verdict: FAIL" },
  ],
  "Verdict: PASS\n- verified",
);
assert.equal(passCase.output, "Verdict: PASS\n- verified");
assert.deepEqual(parseReviewVerdict(passCase.output), { verdict: "PASS" });
assert.equal(evaluateReviewPassed({ ok: true, output: passCase.output }), true);
assert.equal(isTrustworthyReviewFail({ ok: true, output: passCase.output }), false);

// Naively concatenating the superseded scratch text with the final answer IS
// ambiguous — proof that the separation above is what keeps the decision sound.
const naive = "Verdict: PASS\nVerdict: FAIL\n- one finding";
assert.deepEqual(parseReviewVerdict(naive), { verdict: "FAIL", conflicting: true, reason: "conflicting_verdict" });
assert.equal(evaluateReviewPassed({ ok: true, output: naive }), false);
// The prototype's contract keeps `prototype_intermediate_text` out of clean
// output: it is a distinct item type the parent records as trajectory only.
assert.ok(parseLines(failCase.result.stdout).some(line => line.item?.type === "prototype_intermediate_text"),
  "the superseded text must still be visible as trajectory evidence");

console.log("ok t5-review-parsing");
console.log(JSON.stringify({ failOutput: failCase.output, passOutput: passCase.output }, null, 2));
