#!/usr/bin/env node
/**
 * Acceptance 7: the PRODUCTION entrypoint.
 *
 * Every case here goes through the central `buildWorkerLaunch` with an explicit
 * seat (never the adapter directly), under an operator config whose harness is
 * `deepseek-minimal`, against the real pinned runtime and a loopback provider
 * double that stands in for the configured Messages endpoint. Covered:
 *
 *   * every worker seat (runner/implementer/reviewer) launches the production
 *     adapter with an explicit, never-inferred seat; `--seat researcher` is
 *     rejected as a retired seat rather than aliased
 *   * literal model / effort / max_output_tokens on the outgoing request
 *   * the configured production credential is presented (never the dummy)
 *   * read_image bytes and bash output reach the model
 *   * the harness forwards no credential/transport env to a shell child
 *   * reviewer closing-answer semantics through the parent's own parser
 *   * runner completion through the existing completeTask + transport + backstop
 *   * production refuses to run without a credential (no dummy fallback)
 *   * a mismatched/unpinned runtime root fails closed
 *   * terminal gates (max_tokens, over-cap) and bounded cancellation
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWorkerLaunch,
  loadRoleContract,
  WORKER_DEEPSEEK_ADAPTER,
} from "../../../workflow/worker-config.mjs";
import {
  COMPLETE_TASK_RESPONSE_MAX,
  checkRunnerTransportBackstop,
  evaluateReviewPassed,
  handleExecutionStreamEvent,
  readAuthoritativeRunnerResult,
  validateRunnerResultPayload,
} from "../../../bin/mcp-server.mjs";
import { startMockProvider } from "../mock/mock-provider.mjs";
import { encodePng } from "../mock/png.mjs";
import { adaptSeatInstructions, runtimeLayout, verifyRuntimeProvenance } from "../adapter/runtime.mjs";
import { SessionTranslator } from "../adapter/translate.mjs";
import { cleanOutput, isolatedRuntime, parseLines, runLaunch, scrubRoutingEnv, tempDir } from "./harness.mjs";

// The test process itself must never wake a live architect session when it
// exercises the parent's completion/backstop helpers.
scrubRoutingEnv();
process.env.QQ_CODEX_BIN = "/usr/bin/true";
process.env.QQ_RUNNER_FINDINGS_DIR = join(tempDir("t7-findings"), "findings");

const PRODUCTION_KEY = "t7-production-key-value";
/**
 * The runtime root every case boots. It is a PRIVATE root materialized from the
 * same built pinned upstream by the same `setup-runtime.mjs` the deployment
 * runs, not the operator's shared root: these cases exercise the production
 * entrypoint, and the shared root is never written to (or required to be
 * re-materialized) by a test run.
 */
const RUNTIME_ROOT = isolatedRuntime();
const SEARCH_TOOL = "mcp__zvec_grep__zvec_grep_search";
const SEARCH_SEAT_TOOLS = ["bash", SEARCH_TOOL, "read_image"].sort();
const BASELINE_SEAT_TOOLS = ["bash", "read_image"];
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const sha256Text = (text) => createHash("sha256").update(Buffer.from(text)).digest("hex");
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// The runtime this suite exercises must be the pinned one materialized by
// scripts/setup-runtime.mjs; a stale root fails the run here, not silently.
const provenance = verifyRuntimeProvenance(runtimeLayout({ runtimeRoot: RUNTIME_ROOT }));
assert.equal(provenance.globalDshUsed, false);

/** The operator entrypoint under test: one harness selection, one config file. */
function productionEnv(root, { apiKey = PRODUCTION_KEY, runtimeRoot = RUNTIME_ROOT, extra = {} } = {}) {
  const env = {
    ...process.env,
    QQ_WORKER_CONFIG_FILE: join(root, "worker-config.json"),
    QQ_DEEPSEEK_RUNTIME_ROOT: runtimeRoot,
    ...extra,
  };
  if (apiKey) env.DEEPSEEK_API_KEY = apiKey;
  else delete env.DEEPSEEK_API_KEY;
  for (const key of ["QQ_RUNNER_ID", "QQ_RUNNER_RESULT_FILE", "QQ_RUNNER_MARKER_FILE", "QQ_SUBAGENT_BIN", "QQ_RUNNER_FINDINGS_DIR"]) {
    delete env[key];
  }
  return env;
}

function writeProductionConfig(root, mockUrl, extra = {}) {
  const file = join(root, "worker-config.json");
  writeFileSync(file, JSON.stringify({
    provider: "deepseek",
    model: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    wire_api: "responses",
    env_key: "DEEPSEEK_API_KEY",
    api_key_file: join(root, "missing-key-file"),
    harness: "deepseek-minimal",
    reasoning_effort: "max",
    max_output_tokens: 2048,
    messages_base_url: mockUrl,
    ...extra,
  }));
  return file;
}

/** One search seat's model-facing surface through the production entrypoint. */
function assertSearchSeatSurface(request) {
  assert.deepEqual(request.toolNames, SEARCH_SEAT_TOOLS, "a search seat exposes bash + read_image + the qualified search tool");
  assert.ok(!request.toolNames.includes("zvec_grep_search"), "the bare upstream name is never model-facing");
  for (const name of ["list_mcp_resources", "read_mcp_resource", "list_mcp_resource_templates", "read", "write", "edit", "complete_task"]) {
    assert.ok(!request.toolNames.includes(name), `tool '${name}' must not be exposed to a search seat`);
  }
}

function assertProductionWire(request) {
  assert.equal(request.model, "deepseek-flash", "the literal pinned model must be on the wire");
  assert.equal(request.effort, "max", "the literal configured effort must be on the wire");
  assert.equal(request.maxTokens, 2048, "the configured output cap must be on the wire");
  assert.equal(request.apiKeyIsDummy, false, "production must present the configured credential, never the dummy");
  assert.equal(request.apiVersion, "2023-06-01");
}

// --- A. implementer: bash + read_image + closing answer ---------------------
{
  const workdir = tempDir("t7-impl");
  const png = encodePng(3, 2, (x, y) => [x * 90, y * 120, 200]);
  const fixture = join(workdir, "fixture.png");
  writeFileSync(fixture, png);
  const mock = await startMockProvider({
    scenario: {
      filesMode: "ok",
      turns: [
        { blocks: [{ type: "tool_use", name: "bash", input: { command: "env | grep -E 'DEEPSEEK_API_KEY|QQ_RUNNER' >/dev/null && echo CREDENTIAL_LEAK || echo NO_CREDENTIAL_LEAK; echo SHELL_OK" } }], stopReason: "tool_use" },
        { blocks: [{ type: "tool_use", name: "read_image", input: { file_path: fixture } }], stopReason: "tool_use" },
        { blocks: [{ type: "text", text: "FINAL: production implementer verified" }], stopReason: "end_turn" },
      ],
    },
  });
  writeProductionConfig(workdir, mock.url);
  const env = productionEnv(workdir);
  const launch = buildWorkerLaunch({ seat: "implementer", cwd: workdir, prompt: "inspect the fixture and report", env });
  assert.equal(launch.harness, "deepseek-minimal");
  const res = await runLaunch(launch, { cwd: workdir });
  const requests = mock.messageRequests;
  const uploads = mock.journal.filter(entry => entry.kind === "files-upload");
  await mock.close();

  assert.equal(res.code, 0, `production implementer must succeed: ${res.stderr}`);
  assert.equal(cleanOutput(parseLines(res.stdout)), "FINAL: production implementer verified");
  assert.equal(requests.length, 3, "one request per scripted turn");
  for (const request of requests) assertProductionWire(request);
  assertSearchSeatSurface(requests[0]);
  const withImage = requests.find(request => request.hasImage);
  assert.ok(withImage !== undefined, "read_image must produce an image on the next outbound request");
  assert.equal(withImage.images[0].source, "file");
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].sha256, sha256(png), "uploaded bytes must be the fixture bytes");
  assert.equal(uploads[0].decodable, true);
  const toolText = requests.at(-1).toolResults.map(entry => entry.text).join("\n");
  assert.match(toolText, /NO_CREDENTIAL_LEAK/u, "the provider credential must not reach a shell child");
  assert.match(toolText, /SHELL_OK/u, "the harmless shell operation must reach the model");
}

// --- B. reviewer: closing answer drives the parent's verdict parser --------
{
  const workdir = tempDir("t7-review");
  const mock = await startMockProvider({
    scenario: {
      turns: [
        { blocks: [{ type: "thinking", thinking: "scratch: Verdict: FAIL (must not be parsed)" }, { type: "text", text: "scratch note: Verdict: FAIL" }, { type: "tool_use", name: "bash", input: { command: "echo review" } }], stopReason: "tool_use" },
        { blocks: [{ type: "text", text: "Verdict: PASS\n- production reviewer closing answer" }], stopReason: "end_turn" },
      ],
    },
  });
  writeProductionConfig(workdir, mock.url);
  const env = productionEnv(workdir);
  const launch = buildWorkerLaunch({ seat: "reviewer", cwd: workdir, prompt: "review it", env });
  const res = await runLaunch(launch, { cwd: workdir });
  const requests = mock.messageRequests;
  await mock.close();

  assert.equal(res.code, 0, `production reviewer must succeed: ${res.stderr}`);
  const execution = { trajectory: [], status: "running", startedAt: Date.now(), lastActivityAt: Date.now() };
  for (const line of parseLines(res.stdout)) handleExecutionStreamEvent(execution, line);
  const output = (execution._cleanOutput ?? "").trim();
  assert.equal(output, "Verdict: PASS\n- production reviewer closing answer", "only the closing answer may be parsed");
  assert.equal(evaluateReviewPassed({ ok: true, output }), true);
  const reviewerRole = adaptSeatInstructions("reviewer", loadRoleContract("reviewer").body);
  for (const request of requests) {
    assertProductionWire(request);
    assert.equal(request.systemPromptSha256, sha256Text(reviewerRole), "the reviewer seat contract must be the system prompt");
  }
  assertSearchSeatSurface(requests[0]);
}

// --- C. retired researcher seat is rejected, never aliased ------------------
{
  const workdir = tempDir("t7-research");
  const mock = await startMockProvider({
    scenario: { turns: [{ blocks: [{ type: "text", text: "must never run" }], stopReason: "end_turn" }] },
  });
  writeProductionConfig(workdir, mock.url);
  const env = productionEnv(workdir);

  // The launch boundary refuses the retired seat outright.
  assert.throws(
    () => buildWorkerLaunch({ seat: "researcher", cwd: workdir, prompt: "research it", env }),
    /unknown worker seat 'researcher'/u,
  );

  // Even a hand-built adapter argv naming the retired seat fails closed before
  // any provider contact, so it can never silently become the runner.
  const res = await runLaunch({
    bin: process.execPath,
    args: [WORKER_DEEPSEEK_ADAPTER, "--production", "--seat", "researcher", "--cwd", workdir, "--prompt", "research it"],
    env,
  });
  const requests = mock.messageRequests;
  await mock.close();

  assert.equal(res.code, 2, `a retired seat must fail closed: ${res.stderr}`);
  assert.equal(res.stdout, "", "no protocol lines may be emitted for a retired seat");
  assert.match(res.stderr, /--seat must be one of runner, implementer, reviewer \(got "researcher"\)/u);
  assert.equal(requests.length, 0, "no provider request may be made for a retired seat");
}

// --- D. runner: complete_task transport + backstop + env containment --------
{
  const workdir = tempDir("t7-runner");
  const runnerId = `t7-runner-${randomUUID()}`;
  const resultFile = join(tmpdir(), `qq-runner-result-${runnerId}.json`);
  const mock = await startMockProvider({
    scenario: {
      turns: [
        { blocks: [{ type: "tool_use", name: "bash", input: { command: "env | grep -E 'QQ_RUNNER' >/dev/null && echo TRANSPORT_LEAK || echo NO_TRANSPORT_LEAK" } }], stopReason: "tool_use" },
        { blocks: [{ type: "text", text: "FINAL: runner production result" }], stopReason: "end_turn" },
      ],
    },
  });
  writeProductionConfig(workdir, mock.url);
  const env = productionEnv(workdir);
  const launch = buildWorkerLaunch({
    seat: "runner",
    cwd: workdir,
    prompt: "run the bounded task",
    env,
    mcpEnv: { QQ_RUNNER_ID: runnerId, QQ_RUNNER_RESULT_FILE: resultFile },
  });
  assert.equal(launch.env.QQ_RUNNER_ID, runnerId);
  assert.equal(launch.env.QQ_RUNNER_RESULT_FILE, resultFile);
  assert.ok(!launch.args.join(" ").includes(PRODUCTION_KEY), "the credential must never enter argv");
  const res = await runLaunch(launch, { cwd: workdir });
  const mockUrl = mock.url;
  const requests = mock.messageRequests;
  await mock.close();

  assert.equal(res.code, 0, `production runner must succeed: ${res.stderr}`);
  assert.ok(existsSync(resultFile), "the existing completeTask must write the authoritative transport");
  const payload = JSON.parse(readFileSync(resultFile, "utf8"));
  assert.deepEqual(payload.data_points, [], "data_points stays an explicit empty array");
  assert.equal(payload.runnerId, runnerId);
  const validated = validateRunnerResultPayload(payload, { id: runnerId, resultFile });
  assert.equal(validated.ok, true, validated.error);
  assert.equal(readAuthoritativeRunnerResult({ id: runnerId, resultFile }).ok, true);
  // `cwd` is the disposable workdir: the backstop's report/notification state
  // is written there, never into the checkout under test.
  const runner = { id: runnerId, sessionId: null, status: "running", resultFile, cwd: workdir, activeTool: null };
  assert.equal(checkRunnerTransportBackstop(runner), true, "the parent backstop must authorize success");
  assert.equal(runner.status, "completed");
  const toolText = requests.at(-1).toolResults.map(entry => entry.text).join("\n");
  assert.match(toolText, /NO_TRANSPORT_LEAK/u, "runner transport identity must not reach the shell");
  assert.deepEqual(requests[0].toolNames, BASELINE_SEAT_TOOLS, "the runner seat must NOT gain the search tool");
  for (const request of requests) assertProductionWire(request);
  // The runner's own env legitimately carries identity; the harness child must not.
  const { harnessEnv, resolveRuntime } = await import("../adapter/runtime.mjs");
  const runtime = resolveRuntime({ seat: "runner", mode: "production", endpoint: mockUrl, apiKey: PRODUCTION_KEY, env });
  const childEnv = harnessEnv({ env: launch.env, runtime, apiKey: PRODUCTION_KEY });
  assert.equal(childEnv.QQ_RUNNER_ID, undefined);
  assert.equal(childEnv.QQ_RUNNER_RESULT_FILE, undefined);
  assert.equal(childEnv.DEEPSEEK_API_KEY, PRODUCTION_KEY);
  assert.equal(childEnv.DEEPSEEK_BASE_URL, runtime.endpoint);
}

// --- E. production without a credential fails closed (no dummy auth) -------
{
  const workdir = tempDir("t7-nocred");
  const mock = await startMockProvider({
    scenario: { turns: [{ blocks: [{ type: "text", text: "must never run" }], stopReason: "end_turn" }] },
  });
  writeProductionConfig(workdir, mock.url);
  const env = productionEnv(workdir, { apiKey: null });
  const launch = buildWorkerLaunch({ seat: "implementer", cwd: workdir, prompt: "x", env });
  const res = await runLaunch(launch, { cwd: workdir });
  const requests = mock.messageRequests;
  await mock.close();
  assert.equal(res.code, 2, `a missing credential must be a launch refusal: ${res.stderr}`);
  assert.match(res.stderr, /provider_credential_required/u);
  assert.equal(res.stdout, "", "a refused run must not emit protocol lines");
  assert.equal(requests.length, 0, "no request may be attempted without a credential");
}

// --- F. an unpinned/mismatched runtime root fails closed -------------------
{
  const workdir = tempDir("t7-badroot");
  const mock = await startMockProvider({
    scenario: { turns: [{ blocks: [{ type: "text", text: "must never run" }], stopReason: "end_turn" }] },
  });
  writeProductionConfig(workdir, mock.url);
  const tamperedRoot = tempDir("t7-badroot-runtime");
  writeFileSync(join(tamperedRoot, "provenance.json"), `${JSON.stringify({ ...provenance, head: "0".repeat(40) }, null, 2)}\n`);
  const env = productionEnv(workdir, { runtimeRoot: tamperedRoot });
  const launch = buildWorkerLaunch({ seat: "implementer", cwd: workdir, prompt: "x", env });
  const res = await runLaunch(launch, { cwd: workdir });
  const requests = mock.messageRequests;
  await mock.close();
  assert.equal(res.code, 2, `a mismatched runtime must fail closed: ${res.stderr}`);
  assert.match(res.stderr, /expected pinned/u);
  assert.equal(requests.length, 0);
}

// --- G. terminal gates through the production entrypoint -------------------
{
  for (const [name, turns, pattern] of [
    ["maxtokens", [{ blocks: [{ type: "text", text: "partial answer" }], stopReason: "max_tokens" }], /turn_end_|missing_terminal|maxtokens/u],
    ["overcap", [{ blocks: [{ type: "text", text: "x".repeat(COMPLETE_TASK_RESPONSE_MAX + 1) }], stopReason: "end_turn" }], /final_answer_over_cap/u],
  ]) {
    const workdir = tempDir(`t7-${name}`);
    const mock = await startMockProvider({ scenario: { turns } });
    writeProductionConfig(workdir, mock.url);
    const env = productionEnv(workdir);
    const launch = buildWorkerLaunch({ seat: "implementer", cwd: workdir, prompt: "x", env });
    const res = await runLaunch(launch, { cwd: workdir });
    await mock.close();
    assert.equal(res.code, 1, `${name} must not report success: ${res.stderr}`);
    // No closing answer may reach the parent's clean output (an intermediate
    // trajectory line is allowed and is explicitly not an agent_message).
    assert.equal(cleanOutput(parseLines(res.stdout)), "", `${name} must deliver no closing answer`);
    assert.ok(!res.stdout.includes("agent_message"), `${name} must not emit an agent_message`);
    assert.match(res.stderr, pattern);
  }
}

// --- G2. the exact 16,384-character cap succeeds, whole, through production --
{
  const workdir = tempDir("t7-atcap");
  const atCapText = "y".repeat(COMPLETE_TASK_RESPONSE_MAX);
  const mock = await startMockProvider({
    scenario: { turns: [{ blocks: [{ type: "text", text: atCapText }], stopReason: "end_turn" }] },
  });
  writeProductionConfig(workdir, mock.url);
  const env = productionEnv(workdir);
  const launch = buildWorkerLaunch({ seat: "implementer", cwd: workdir, prompt: "x", env });
  const res = await runLaunch(launch, { cwd: workdir });
  await mock.close();
  assert.equal(res.code, 0, `an exactly-cap production answer must succeed: ${res.stderr}`);
  assert.equal(
    cleanOutput(parseLines(res.stdout)).length,
    COMPLETE_TASK_RESPONSE_MAX,
    "the closing answer must be delivered whole at exactly the cap (never truncated)",
  );
}

// --- G3. an over-cap reviewer closing answer can never produce PASS ---------
{
  const workdir = tempDir("t7-review-overcap");
  const overCapReview = `Verdict: PASS\n${"z".repeat(COMPLETE_TASK_RESPONSE_MAX)}`;
  const mock = await startMockProvider({
    scenario: { turns: [{ blocks: [{ type: "text", text: overCapReview }], stopReason: "end_turn" }] },
  });
  writeProductionConfig(workdir, mock.url);
  const env = productionEnv(workdir);
  const launch = buildWorkerLaunch({ seat: "reviewer", cwd: workdir, prompt: "review it", env });
  const res = await runLaunch(launch, { cwd: workdir });
  await mock.close();
  assert.equal(res.code, 1, `an over-cap reviewer answer must fail closed: ${res.stderr}`);
  const execution = { trajectory: [], status: "running", startedAt: Date.now(), lastActivityAt: Date.now() };
  for (const line of parseLines(res.stdout)) handleExecutionStreamEvent(execution, line);
  const output = (execution._cleanOutput ?? "").trim();
  assert.equal(output, "", "no closing answer may reach the reviewer parser");
  assert.equal(evaluateReviewPassed({ ok: false, output }), false, "an over-cap reviewer answer must never be PASS");
  assert.match(res.stderr, /final_answer_over_cap/u);
}

// --- H. bounded cancellation through the production entrypoint -------------
{
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const spawnList = (pid) => {
    const pids = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/u.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        if (ppid === pid) pids.push(Number(entry));
      } catch { /* process vanished */ }
    }
    return pids;
  };
  const waitFor = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const waitGone = async (pid, timeoutMs, label) => {
    await waitFor(() => !alive(pid), timeoutMs, `${label} (pid ${pid}) to exit`);
  };

  const workdir = tempDir("t7-cancel");
  const pidFile = join(workdir, "grandchild.pid");
  const mock = await startMockProvider({
    scenario: { turns: [{ blocks: [{ type: "tool_use", name: "bash", input: { command: `bash -c 'sleep 601 & echo $! > ${pidFile}; wait'` } }], stopReason: "tool_use" }] },
  });
  writeProductionConfig(workdir, mock.url);
  const env = productionEnv(workdir);
  const launch = buildWorkerLaunch({ seat: "implementer", cwd: workdir, prompt: "start a long-lived child", env });
  const child = spawn(launch.bin, launch.args, { cwd: workdir, stdio: ["ignore", "pipe", "pipe"], env: launch.env });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const grandchild = Number(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim(), 90_000, "the shell grandchild pid file"));
  const harness = await waitFor(() => spawnList(child.pid)[0], 60_000, "the harness child of the adapter");
  assert.equal(alive(grandchild), true, "the shell grandchild must be running before cancel");
  const started = Date.now();
  child.kill("SIGTERM");
  const exit = await new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  await mock.close();
  assert.equal(exit.code, 143, `a cancelled production worker must exit 143: ${JSON.stringify(exit)}`);
  assert.ok(Date.now() - started < 15_000, "cancellation must be bounded");
  assert.match(stderr, /received SIGTERM/u);
  await waitGone(harness, 5_000, "harness");
  await waitGone(grandchild, 10_000, "shell grandchild");
}

console.log("ok t7-production-adapter");
console.log(JSON.stringify({ runtimeRoot: RUNTIME_ROOT, provenanceHead: provenance.head, seats: ["runner", "implementer", "reviewer"], retiredSeats: ["researcher"] }, null, 2));
