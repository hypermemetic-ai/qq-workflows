#!/usr/bin/env node
/**
 * Acceptance 4: a successful final turn reaches the runner's authoritative
 * transport through the existing `completeTask`, and the existing validator +
 * backstop accept it; cap overflow and every non-success terminal produce NO
 * successful result; foreign-session events are ignored; `data_points` is an
 * explicit empty array.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  checkRunnerTransportBackstop,
  COMPLETE_TASK_RESPONSE_MAX,
  readAuthoritativeRunnerResult,
  validateRunnerResultPayload,
} from "../../../bin/mcp-server.mjs";
import { loadRoleContract } from "../../../workflow/worker-config.mjs";
import { startMockProvider } from "../mock/mock-provider.mjs";
import { adaptSeatInstructions } from "../adapter/runtime.mjs";
import { SessionTranslator } from "../adapter/translate.mjs";
import { cleanOutput, parseLines, runWorker, scrubRoutingEnv, tempDir, workerEnv } from "./harness.mjs";

scrubRoutingEnv();

const REASONING_MARKER = "reasoning-must-not-escape-4f21";
const runnerRoot = tempDir("t4");
// `workerEnv` pins the PRIVATE runtime root (a fresh materialization of the
// same pinned runtime): this suite never boots - or writes session state into -
// the operator's shared root.
const env = workerEnv({
  QQ_CODEX_BIN: "/usr/bin/true",
  QQ_RUNNER_FINDINGS_DIR: join(runnerRoot, "findings"),
  QQ_RUNNER_MARKER_FILE: join(runnerRoot, "marker.json"),
});

async function runRunnerCase(name, turns) {
  const runnerId = `proto-${name}-${randomUUID()}`;
  const resultFile = join(runnerRoot, `result-${name}.json`);
  const mock = await startMockProvider({ scenario: { turns } });
  const result = await runWorker(
    ["--seat", "runner", "--cwd", runnerRoot, "--prompt", `runner task ${name}`, "--base-url", mock.url, "--summary-file", join(runnerRoot, `summary-${name}.json`)],
    { env: workerEnv({ ...env, QQ_RUNNER_ID: runnerId, QQ_RUNNER_RESULT_FILE: resultFile }) },
  );
  const firstRequest = mock.messageRequests[0];
  await mock.close();
  return { runnerId, resultFile, result, firstRequest, summary: existsSync(join(runnerRoot, `summary-${name}.json`)) ? JSON.parse(readFileSync(join(runnerRoot, `summary-${name}.json`), "utf8")) : null };
}

// --- A. completed turn bridges through completeTask --------------------------
const ok = await runRunnerCase("ok", [
  { blocks: [{ type: "thinking", thinking: REASONING_MARKER }, { type: "text", text: "FINAL: runner completed" }], stopReason: "end_turn" },
]);
assert.equal(ok.result.code, 0, `runner must succeed: ${ok.result.stderr}`);
assert.ok(existsSync(ok.resultFile), "complete_task must write the authoritative transport file");
const payload = JSON.parse(readFileSync(ok.resultFile, "utf8"));
assert.deepEqual(Object.keys(payload).sort(), ["calledAt", "data_points", "response", "runnerId"]);
assert.deepEqual(payload.data_points, [], "data_points must be an explicit empty array");
assert.equal(payload.runnerId, ok.runnerId, "the transport is bound to this runner id");
const validated = validateRunnerResultPayload(payload, { id: ok.runnerId, resultFile: ok.resultFile });
assert.equal(validated.ok, true, "the existing validator must accept the bridged result");
assert.deepEqual(validated.result, { response: "FINAL: runner completed", data_points: [] });
const authoritative = readAuthoritativeRunnerResult({ id: ok.runnerId, resultFile: ok.resultFile });
assert.equal(authoritative.ok, true);
// The parent's own backstop is what authorizes success.
// `cwd` keeps the parent backstop's terminal report/notification state in this
// test's disposable temp root instead of the checkout the suite runs from.
const runner = { id: ok.runnerId, sessionId: null, status: "running", resultFile: ok.resultFile, cwd: runnerRoot, activeTool: null };
assert.equal(checkRunnerTransportBackstop(runner), true, "the existing backstop must complete the runner");
assert.equal(runner.status, "completed");
assert.deepEqual(runner.result.data_points, []);
// Reasoning must not reach stderr or the reviewer-visible clean output.
assert.ok(!ok.result.stderr.includes(REASONING_MARKER), "reasoning must never be written to stderr");
assert.ok(!cleanOutput(parseLines(ok.result.stdout)).includes(REASONING_MARKER), "reasoning must not ride clean output");
assert.equal(cleanOutput(parseLines(ok.result.stdout)), "FINAL: runner completed");
assert.equal(ok.summary.terminal, "completed");
assert.equal(ok.summary.outcome, "completed");
assert.equal(ok.summary.foreignEvents, 0);
// The runner role contract names a completion tool; the prototype must hand the
// model the adapted completion instruction instead (no unavailable tool).
const rawRunnerRole = loadRoleContract("runner").body;
assert.match(rawRunnerRole, /complete_task/u, "the production runner contract does name the completion tool");
const adapted = adaptSeatInstructions("runner", rawRunnerRole);
const sha256 = (text) => createHash("sha256").update(Buffer.from(text)).digest("hex");
assert.equal(ok.firstRequest.systemPromptSha256, sha256(adapted), "the runtime must receive the adapted runner instructions");
assert.equal(ok.firstRequest.systemPromptMentionsCompletionTool, false, "the runtime prompt must not name an unavailable completion tool");
assert.ok(!adapted.includes("mcp__qq_workflows"), "the qualified completion tool name must be gone");
assert.match(adapted, /bounded, capable engineering and research runner/u, "role boundaries are preserved verbatim");

// --- B. cap boundary: exactly the cap succeeds, one char past fails closed ---
const atCapText = "A".repeat(COMPLETE_TASK_RESPONSE_MAX);
const capped = await runRunnerCase("atcap", [{ blocks: [{ type: "text", text: atCapText }], stopReason: "end_turn" }]);
assert.equal(capped.result.code, 0, `an exactly-cap final answer must succeed: ${capped.result.stderr}`);
assert.equal(capped.summary.outcome, "completed");
assert.equal(capped.summary.completeTask.responseLength, COMPLETE_TASK_RESPONSE_MAX);
assert.equal(
  JSON.parse(readFileSync(capped.resultFile, "utf8")).response.length,
  COMPLETE_TASK_RESPONSE_MAX,
  "the authoritative transport must carry exactly the cap length",
);

// --- B2. oversized final answer fails closed --------------------------------
const oversized = "X".repeat(COMPLETE_TASK_RESPONSE_MAX + 1);
const over = await runRunnerCase("overcap", [{ blocks: [{ type: "text", text: oversized }], stopReason: "end_turn" }]);
assert.equal(over.result.code, 1, "an over-cap answer must fail closed");
assert.ok(!existsSync(over.resultFile), "no transport file may be written for an over-cap answer");
assert.match(over.result.stderr, /final_answer_over_cap/u);
assert.match(over.result.stderr, new RegExp(`above the ${COMPLETE_TASK_RESPONSE_MAX}-char transport cap`, "u"));
assert.ok(!over.result.stderr.includes("XXXX"), "the diagnostic must be bounded and must not echo the answer");
assert.equal(over.result.stdout.trim(), "", "no success protocol lines for a failed answer");
assert.equal(over.summary.outcome, "final_answer_over_cap");
assert.equal(checkRunnerTransportBackstop({ id: over.runnerId, status: "running", resultFile: over.resultFile }), false);

// --- C. token-limit terminal fails even with partial text -------------------
const tokenLimited = await runRunnerCase("maxtokens", [{ blocks: [{ type: "text", text: "partial answer" }], stopReason: "max_tokens" }]);
assert.equal(tokenLimited.result.code, 1, "a max-tokens turn must not deliver success");
assert.ok(!existsSync(tokenLimited.resultFile), "no transport file may be written for a token-limited turn");
assert.equal(tokenLimited.summary.terminal, "max-tokens");
assert.equal(tokenLimited.summary.outcome, "turn_end_max-tokens");
assert.match(tokenLimited.result.stderr, /only 'completed' delivers success/u);

// --- D. error terminal fails closed -----------------------------------------
const errored = await runRunnerCase("error", [{ error: { message: "scripted provider failure" } }]);
assert.equal(errored.result.code, 1, "a provider error turn must not deliver success");
assert.ok(!existsSync(errored.resultFile));
assert.equal(errored.summary.outcome, "turn_end_error");

// --- E. foreign-session events are ignored (unit level) ---------------------
const emitted = [];
const translator = new SessionTranslator({ sessionId: "own", onLine: event => emitted.push(event) });
translator.handleNotification({ params: { sessionId: "foreign", event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "FOREIGN ANSWER" }] } }, seq: 1 } } });
translator.handleNotification({ params: { sessionId: "own", event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "OWN ANSWER" }] } }, seq: 2 } } });
translator.handleNotification({ params: { sessionId: "own", event: { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } }, seq: 3 } } });
assert.equal(translator.foreignEvents, 1, "foreign session events must be counted and dropped");
assert.equal(translator.lastAssistantText, "OWN ANSWER", "only the owned session may produce the answer");
assert.ok(!emitted.some(event => JSON.stringify(event).includes("FOREIGN")), "foreign content must never reach the parent contract");
const childLine = translator.finalAnswerLine();
assert.equal(childLine.item.text, "OWN ANSWER");

console.log("ok t4-completion");
console.log(JSON.stringify({ ok: ok.summary, atcap: capped.summary, overcap: over.summary, maxTokens: tokenLimited.summary, error: errored.summary, foreignEvents: translator.foreignEvents }, null, 2));
