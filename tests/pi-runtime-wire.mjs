#!/usr/bin/env node
// Real-runtime wire proof for the one Pi worker runtime.
//
// Unlike tests/pi-worker.mjs (a fake `pi --mode rpc` binary), this test drives
// the *installed* pi runtime through the *real* adapter, so what is proven is
// the integration itself: the RPC event names the adapter translates, the tool
// surface the runtime actually registers, the request body the model provider
// receives, and the authoritative runner transport.
//
// No provider traffic and no paid calls: every request is answered by a
// localhost mock server with a dummy key, exactly like tests/worker-effort-wire.mjs
// does for the installed Codex client. If no pi runtime is installed the test
// reports a skip (exit 0) rather than failing, since it cannot fabricate one.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const ADAPTER = join(repoRoot, "workflow", "pi-worker", "adapter.mjs");
const DUMMY_KEY = "dummy-key-for-localhost-capture";
const MODEL = "wire-test-model";
const PROVIDER = "wire-local";

// Locate a real `pi` executable (the suite-wide QQ_WORKER_PI_BIN override is a
// fake runtime, so it is deliberately not consulted here).
function resolveInstalledPi(env = process.env) {
  if (env.QQ_WORKER_PI_WIRE_BIN) {
    return existsSync(env.QQ_WORKER_PI_WIRE_BIN) ? env.QQ_WORKER_PI_WIRE_BIN : null;
  }
  for (const dir of String(env.PATH || "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "pi");
    try {
      if (existsSync(candidate) && statSync(candidate).isFile() && (statSync(candidate).mode & 0o111)) return candidate;
    } catch {
      // Unreadable PATH entry: keep searching.
    }
  }
  return null;
}

const piBin = resolveInstalledPi();
if (!piBin) {
  console.log("pi runtime wire test SKIPPED: no installed pi runtime on PATH (set QQ_WORKER_PI_WIRE_BIN to pin one).");
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "qq-pi-runtime-wire-"));

/** One scripted OpenAI-completions SSE turn from the local mock provider. */
function scriptedTurn({ callIndex, nonceFile, nonce, mode }) {
  const id = `chatcmpl-${callIndex}`;
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: "chat.completion.chunk", created, model: MODEL };
  const chunks = [];
  if (callIndex === 1) {
    // Turn 1: call the runtime's own native `read` tool on the nonce file.
    chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_read_1", type: "function", function: { name: "read", arguments: "" } }] }, finish_reason: null }] });
    chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: nonceFile }) } }] }, finish_reason: null }] });
    chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    return chunks;
  }
  if (mode === "error") {
    // Turn 2 (error case): stream text, then end the message with a
    // non-retryable failure reason. The runtime keeps that partial text inside
    // an assistant message whose stopReason is `error`.
    chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "partial hypothes" }, finish_reason: null }] });
    chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] });
    return chunks;
  }
  chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: nonce }, finish_reason: null }] });
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  return chunks;
}

const received = [];
let calls = 0;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    received.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
    if (!String(req.url).includes("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":{"message":"not found"}}');
      return;
    }
    calls += 1;
    const plan = SCRIPT;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const chunk of scriptedTurn({ callIndex: calls, nonceFile: plan.nonceFile, nonce: plan.nonce, mode: plan.mode })) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let SCRIPT = { nonceFile: null, nonce: "unset", mode: "ok" };

function writeAgentDir(dir, { contextWindow = 200_000, maxTokens = 8192 } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "models.json"), `${JSON.stringify({
    providers: {
      [PROVIDER]: {
        name: "Local Wire Mock",
        api: "openai-completions",
        baseUrl: `${origin}/v1`,
        apiKey: DUMMY_KEY,
        models: [{
          id: MODEL,
          name: "Wire Test Model",
          reasoning: true,
          input: ["text"],
          contextWindow,
          maxTokens,
          thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
          compat: { supportsReasoningEffort: true, maxTokensField: "max_tokens", supportsStrictMode: false },
        }],
      },
    },
  }, null, 2)}\n`, "utf8");
}

function writeConfig(file, extra = {}) {
  writeFileSync(file, `${JSON.stringify({
    harness: "pi",
    provider: PROVIDER,
    model: MODEL,
    reasoning_effort: "xhigh",
    context: { enabled: true, reserve_tokens: 8192, keep_recent_tokens: 2000 },
    ...extra,
  }, null, 2)}\n`, "utf8");
  return file;
}

/** Run one real adapter turn (real pi, mock provider) and collect its evidence. */
async function runTurn({ name, mode = "ok", seat = "runner", extraConfig = {} }) {
  const dir = join(root, name);
  const agentDir = join(dir, "agent");
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  writeAgentDir(agentDir);
  const configFile = writeConfig(join(dir, "worker-config.json"), extraConfig);
  const nonce = `NONCE-${Math.random().toString(36).slice(2, 10)}`;
  const nonceFile = join(work, "nonce.txt");
  writeFileSync(nonceFile, `${nonce}\n`, "utf8");
  SCRIPT = { nonceFile, nonce, mode };
  const runnerId = `pi-wire-${name}`;
  const resultFile = join(tmpdir(), `qq-runner-result-${runnerId}.json`);
  rmSync(resultFile, { force: true });
  const summaryFile = join(dir, "summary.json");
  const before = received.length;

  const env = {
    ...process.env,
    PATH: process.env.PATH,
    // Default-on session recording resolves under XDG_STATE_HOME; pointing it
    // into the fixture keeps the operator's real worker-session store
    // untouched by test runs.
    XDG_STATE_HOME: join(dir, "state"),
    PI_CODING_AGENT_DIR: agentDir,
    QQ_WORKER_PI_AGENT_DIR: agentDir,
    QQ_WORKER_CONFIG_FILE: configFile,
    QQ_WORKER_PI_BIN: piBin,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    QQ_ZVEC_GREP_ROOT: work,
    QQ_ZVEC_GREP_SEAT: seat,
    QQ_RUNNER_ID: runnerId,
    QQ_RUNNER_RESULT_FILE: resultFile,
  };
  const child = spawn(process.execPath, [
    ADAPTER, "--production", "--seat", seat, "--cwd", work,
    "--prompt", "Read nonce.txt with your read tool and report its exact contents.",
    "--summary-file", summaryFile,
  ], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  const code = await new Promise((resolve) => child.on("exit", (value) => { clearTimeout(timer); resolve(value); }));
  const events = stdout.split("\n").filter((line) => line.trim() !== "").map((line) => {
    try { return JSON.parse(line); } catch { return { unparsed: line }; }
  });
  return {
    code,
    stderr,
    events,
    resultFile,
    nonce,
    nonceFile,
    wire: received.slice(before),
    transport: existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : null,
    summary: existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, "utf8")) : null,
  };
}

try {
  // 1. Happy path: the real runtime, driven through the real adapter, calls its
  // own native tool and delivers the closing message as the authoritative
  // runner result - and the request body proves the configured protocol knobs.
  const ok = await runTurn({ name: "ok" });
  assert.equal(ok.code, 0, `the real runtime run must succeed (stderr: ${ok.stderr})`);
  assert.equal(ok.transport?.response, ok.nonce, "the closing assistant message is the runner's authoritative result");
  assert.equal(ok.transport?.runnerId, "pi-wire-ok");
  assert.ok(
    ok.events.some((event) => event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text === ok.nonce),
    "the final answer is published on the parent event contract",
  );
  assert.ok(
    ok.events.some((event) => event.event === "step_update" && event.step_update?.tool_name === "read" && event.step_update.state === "ACTIVE"),
    "real tool execution is reported as parent step updates",
  );
  assert.ok(
    ok.events.some((event) => event.type === "item.started" && event.item?.type === "tool_call" && event.item.tool === "read" && event.item.path === ok.nonceFile),
    "the tool call target is reported",
  );
  assert.equal(ok.wire.length, 2, `expected exactly two provider turns, saw ${ok.wire.length}`);
  for (const request of ok.wire) {
    assert.equal(request.method, "POST");
    assert.ok(String(request.url).includes("/chat/completions"), `unexpected request path '${request.url}'`);
    assert.equal(request.body.model, MODEL, "the configured model is the one requested");
    assert.equal(request.body.max_tokens, 8192, "the output cap comes from the registry entry");
    assert.equal(request.body.reasoning_effort, "xhigh", "the configured effort is emitted verbatim");
    assert.equal(request.body.tool_choice, undefined, "tool_choice stays the provider default (auto), never forced");
    const toolNames = (request.body.tools ?? []).map((tool) => tool.function?.name);
    for (const expected of ["read", "bash", "zvec_grep_search"]) {
      assert.ok(toolNames.includes(expected), `the shared tool surface must include '${expected}': ${toolNames.join(", ")}`);
    }
    assert.ok(
      String(request.headers.authorization || "").includes(DUMMY_KEY),
      "the local capture authenticates with the injected dummy key",
    );
  }
  const systemPrompt = String(ok.wire[0].body.messages?.[0]?.content ?? "");
  assert.ok(systemPrompt.includes("closing assistant message"), "the runtime receives the adapted seat contract");
  assert.equal(systemPrompt.includes("complete_task"), false, "the runtime is never told to call a tool this session has no server for");
  assert.deepEqual(ok.summary?.selectedModel, { provider: PROVIDER, model: MODEL, confirmed: true }, "the runtime's reported selection is confirmed against the configuration");
  assert.deepEqual(ok.summary?.availableThinkingLevels, ["minimal", "low", "medium", "high", "xhigh"], "capability comes from the model's own registry map");
  assert.equal(ok.summary?.autoCompactionEnabled, true, "the configured compaction policy is verified on the runtime, not assumed");
  assert.match(String(ok.summary?.capacity?.note ?? ""), /not an enforced hard input bound/);
  assert.deepEqual(ok.summary?.instructions?.adaptedSections, ["Completion"]);

  // 2. Failure path: a message that ends in a non-retryable error carries the
  // text streamed before the failure. That partial text must never be delivered
  // as a result, and the run must fail closed with a named code.
  const failed = await runTurn({ name: "failed", mode: "error" });
  assert.equal(failed.code, 1, "a failed message must fail the run");
  assert.match(failed.stderr, /message_error/, `the failure must be named (stderr: ${failed.stderr})`);
  assert.equal(
    failed.events.some((event) => event.item?.type === "agent_message"),
    false,
    "partial text from a failed message is never published as a final answer",
  );
  assert.equal(failed.transport, null, "nothing lands in the authoritative transport");
} finally {
  server.close();
  for (const name of ["ok", "failed"]) rmSync(join(tmpdir(), `qq-runner-result-pi-wire-${name}.json`), { force: true });
  rmSync(root, { recursive: true, force: true });
}

console.log("Pi runtime wire test passed (installed runtime, localhost mock provider, no provider traffic).");
