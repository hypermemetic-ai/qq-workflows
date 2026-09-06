#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  LOOP_STOP_AT,
  LOOP_WARN_AT,
  classifyFailure,
  createCircuit,
  createLedger,
  createLoopGuard,
  formatRecoveryWake,
  formatSpentProviderWake,
  operationKey,
  parseResearcherResult,
  retryProviderOperation,
  summarizeFailure,
} from "../../paseo-plugin/host/recovery.mjs";
import { formatReviewerWake as findingsWake } from "../../paseo-plugin/host/done.mjs";

assert.equal(classifyFailure(new Error("HTTP 500 Internal error during token generation")), "transient");
assert.equal(classifyFailure({ stderr: "httpx.ReadTimeout\ntimeout after 600.0 seconds" }), "transient");
assert.equal(classifyFailure(new Error("set BRAVE_API_KEY and/or EXA_API_KEY")), "permanent");
const maxPrompt = 'Error while generating output: provider recovery exhausted: litellm.BadRequestError: XaiException - {"code":"invalid-argument","error":"This model\'s maximum prompt length is 2 million tokens"}';
assert.equal(classifyFailure(new Error(maxPrompt)), "permanent");
assert.equal(summarizeFailure(new Error(maxPrompt)), "This model's maximum prompt length is 2 million tokens");
assert.match(
  formatRecoveryWake(new Error(maxPrompt), { role: "research", details: "job-x" }),
  /Research could not complete: This model's maximum prompt length is 2 million tokens/,
);
assert.match(
  formatRecoveryWake(new Error(maxPrompt), { role: "research", details: "job-x" }),
  /Automatic recovery was not attempted/,
);
assert.doesNotMatch(
  formatRecoveryWake(new Error(maxPrompt), { role: "research", details: "job-x" }),
  /Automatic recovery is exhausted/,
);
assert.equal(classifyFailure(new Error("mini-researcher produced no output")), "invalid_output");
assert.equal(classifyFailure(new Error("repeated-action loop persisted despite a warning")), "degeneration");
assert.equal(summarizeFailure({ stderr: "litellm XaiException: timeout after 600.0 seconds" }), "ReadTimeout at the provider's 600.0-second timeout");
assert.equal(summarizeFailure(new Error("Internal error during token generation HTTP 500")), "HTTP 500");

const result = parseResearcherResult("noise\nRESEARCHER_RESULT {\"ok\":false,\"class\":\"transient\",\"attempts\":[\"HTTP 500\"],\"exhausted\":true}\n");
assert.equal(result.class, "transient");
assert.deepEqual(result.attempts, ["HTTP 500"]);

assert.equal(operationKey("/ws", "research", "q"), operationKey("/ws", "research", "q"));
assert.notEqual(operationKey("/ws", "research", "q"), operationKey("/ws", "research", "other"));

const spent = formatSpentProviderWake({
  role: "research",
  attempts: ["HTTP 500", "ReadTimeout at the provider's 600.0-second timeout", "HTTP 500"],
  details: "job-1",
});
assert.match(spent, /Research could not complete after 3 provider attempts/);
assert.match(spent, /HTTP 500 → ReadTimeout at the provider's 600.0-second timeout → HTTP 500/);
assert.match(spent, /No answer was accepted/);
assert.doesNotMatch(spent, /Mini|OCR|ocr/);

const reviewSpent = formatRecoveryWake({
  failureClass: "transient",
  attempts: ["HTTP 500", "HTTP 500", "HTTP 500"],
  exhausted: true,
}, { role: "review", details: "job-2", headSha: "abc", worktree: "/tmp/wt" });
assert.match(reviewSpent, /Review could not complete after 3 provider attempts/);
assert.match(reviewSpent, /abc/);
assert.match(reviewSpent, /correction allowance was not consumed/);

const findings = findingsWake({
  findings: [{ path: "src/a.ts", line: 3, body: "still wrong" }],
  packet: {
    headSha: "def",
    files: [{ path: "src/a.ts", sha: "abc", hunks: [{ header: "@@ -1,1 +1,1 @@", newStart: 1 }] }],
  },
});
assert.match(findings, /Review still has findings after one correction pass/);
assert.doesNotMatch(findings, /Reviewer failed a second time/);

const guard = createLoopGuard();
let last;
for (let i = 0; i < LOOP_WARN_AT; i++) last = guard.observe({ name: "search", args: { q: "x" }, result: "none" });
assert.equal(last.action, "warn");
for (let i = LOOP_WARN_AT; i < LOOP_STOP_AT - 1; i++) last = guard.observe({ name: "search", args: { q: "x" }, result: "none" });
last = guard.observe({ name: "search", args: { q: "x" }, result: "none" });
assert.equal(last.action, "stop");

const ledger = createLedger();
let calls = 0;
await assert.rejects(() => retryProviderOperation(async () => {
  calls += 1;
  throw new Error("HTTP 500");
}, { ledger, sleep: async () => {}, random: () => 0 }));
assert.equal(calls, 3);
assert.equal(ledger.recoveryActions, 2);

const circuit = createCircuit({ now: () => 0, cooldownMs: 60_000 });
circuit.recordFailure("research", "transient", { newRequest: true });
circuit.recordFailure("research", "transient", { newRequest: false });
circuit.recordFailure("research", "transient", { newRequest: false });
assert.equal(circuit.isOpen("research"), false);
circuit.recordFailure("research", "transient", { newRequest: true });
circuit.recordFailure("research", "transient", { newRequest: false });
assert.equal(circuit.isOpen("research"), true);

assert.equal(await retryProviderOperation(async () => "ok", { sleep: async () => {}, random: () => 0 }), "ok");
