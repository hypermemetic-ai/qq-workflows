#!/usr/bin/env node
// Wire proof for default-on native per-attempt session recording.
//
// Unlike tests/pi-worker.mjs (a fake `pi --mode rpc` binary), this test drives
// the *installed* pi runtime through the *real* adapter, so what is proven is
// the recording behavior itself, on the same integration the production
// workers run:
//
//   * success: default-ON recording under the dedicated private worker-session
//     directory; pi writes the FULL native session (header, user message,
//     assistant toolCall, toolResult with the read file contents, final
//     assistant message) into an exclusively created 0600 file inside a 0700
//     directory, with a 0600 metadata sidecar associating the attempt; the
//     selection argv is preserved exactly (`--session` only replaces
//     `--no-session`); no new stdout event types appear;
//   * controlled abort: the evidence persisted up to the abort (toolResult plus
//     the in-flight assistant message finalized with stopReason "aborted" and
//     its partial text) is discovered through the bounded stderr trace line;
//   * refusal: a recording-initialization failure exits 2 with the named
//     diagnostic BEFORE any runtime is spawned and with zero provider traffic.
//
// No provider traffic and no external inference: every request is answered by
// a deterministic localhost mock provider with a dummy key, exactly like
// tests/pi-runtime-wire.mjs. The fixture state is entirely temporary
// (XDG_STATE_HOME points into the fixture, so the default recording directory
// is inside the fixture and the production session store is never touched),
// every owned child process is reaped, all waits are bounded, and no user
// secret is ever read. If no pi runtime is installed the test reports a skip
// (exit 0) rather than failing, since it cannot fabricate one; a skip is
// reported as SKIPPED, never as a pass.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WORKER_PI_EXTENSION } from "../workflow/worker-config.mjs";
import { buildPiArgs } from "../workflow/pi-worker/adapter.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;
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
  console.log("native session recording wire test SKIPPED: no installed pi runtime on PATH (set QQ_WORKER_PI_WIRE_BIN to pin one); the offline recording checks in tests/pi-worker.mjs still run.");
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "qq-pi-recording-wire-"));
const received = [];
let calls = 0;
let SCRIPT = { nonceFile: null, nonce: "unset", mode: "ok", stallMs: 30_000 };
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
    SCRIPT.turn = (SCRIPT.turn ?? 0) + 1; // per-run turn index, not the server-global counter
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const base = { id: `chatcmpl-${calls}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL };
    const choice = (delta, finish) => ({ ...base, choices: [{ index: 0, delta, finish_reason: finish ?? null }] });
    const chunks = [];
    if (SCRIPT.turn === 1) {
      // Turn 1: native read tool call on the nonce file.
      chunks.push(choice({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_read_1", type: "function", function: { name: "read", arguments: "" } }] }));
      chunks.push(choice({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: SCRIPT.nonceFile }) } }] }));
      chunks.push(choice({}, "tool_calls"));
    } else if (SCRIPT.mode === "stall" && SCRIPT.turn >= 2) {
      // Turn 2 (abort script): stream one text chunk, then stall long enough
      // for the test to abort deterministically mid-message.
      chunks.push(choice({ role: "assistant", content: SCRIPT.nonce }));
      chunks.push(choice({ content: " more-partial" }));
    } else {
      chunks.push(choice({ role: "assistant", content: SCRIPT.nonce }));
      chunks.push(choice({}, "stop"));
    }
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    if (SCRIPT.mode === "stall" && SCRIPT.turn >= 2) {
      const timer = setTimeout(() => { try { res.write("data: [DONE]\n\n"); res.end(); } catch {} }, SCRIPT.stallMs);
      timer.unref?.();
      res.on("close", () => clearTimeout(timer));
      return;
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

function writeAgentDir(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "models.json"), `${JSON.stringify({ providers: { [PROVIDER]: {
    name: "Local Wire Mock", api: "openai-completions", baseUrl: `${origin}/v1`, apiKey: DUMMY_KEY,
    models: [{ id: MODEL, name: "Wire Test Model", reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 8192,
      thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
      compat: { supportsReasoningEffort: true, maxTokensField: "max_tokens", supportsStrictMode: false } }] } } }, null, 2)}\n`, "utf8");
}
function writeConfig(file) {
  writeFileSync(file, `${JSON.stringify({ harness: "pi", provider: PROVIDER, model: MODEL, reasoning_effort: "xhigh", context: { enabled: true, reserve_tokens: 8192, keep_recent_tokens: 2000 } }, null, 2)}\n`, "utf8");
}

const childProcs = new Set();
async function runAdapter({ name, mode = "ok", abortTrigger = null, extraEnv = {} }) {
  const dir = join(root, name);
  const agentDir = join(dir, "agent");
  const work = join(dir, "work");
  const stateHome = join(dir, "state"); // default-on recording resolves to <stateHome>/qq-workflows/worker-sessions
  mkdirSync(work, { recursive: true });
  writeAgentDir(agentDir);
  const configFile = join(dir, "worker-config.json"); writeConfig(configFile);
  const nonce = `NONCE-${Math.random().toString(36).slice(2, 10)}`;
  const nonceFile = join(work, "nonce.txt");
  writeFileSync(nonceFile, `${nonce}\n`, "utf8");
  SCRIPT = { nonceFile, nonce, mode, stallMs: 30_000, turn: 0 };
  const runnerId = `rec-wire-${name}`;
  const resultFile = join(tmpdir(), `qq-runner-result-${runnerId}.json`);
  rmSync(resultFile, { force: true });
  const summaryFile = join(dir, "summary.json");
  const before = received.length;
  const beforeCalls = calls;

  const env = {
    ...process.env,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_STATE_HOME: stateHome, // NO QQ_WORKER_SESSION_DIR anywhere: the default path is what is exercised
    PI_CODING_AGENT_DIR: agentDir,
    QQ_WORKER_PI_AGENT_DIR: agentDir,
    QQ_WORKER_CONFIG_FILE: configFile,
    QQ_WORKER_PI_BIN: piBin,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    QQ_ZVEC_GREP_ROOT: work,
    QQ_ZVEC_GREP_SEAT: "runner",
    QQ_RUNNER_ID: runnerId,
    QQ_RUNNER_RESULT_FILE: resultFile,
    ...extraEnv,
  };
  const child = spawn(process.execPath, [
    ADAPTER, "--production", "--seat", "runner", "--cwd", work,
    "--prompt", "Read nonce.txt with your read tool and report its exact contents.",
    "--summary-file", summaryFile,
  ], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
  childProcs.add(child);
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });

  let triggerDone = null;
  const triggerPromise = abortTrigger
    ? new Promise((resolve) => { triggerDone = resolve; })
    : null;
  if (abortTrigger) {
    // The trigger gets everything it needs; it resolves after it sent the signal.
    abortTrigger({
      child,
      sessionDir: join(stateHome, "qq-workflows/worker-sessions"),
      turnTwoInFlight: () => calls > beforeCalls + 1,
    }).then(triggerDone, (error) => { triggerDone?.(); console.error(`abort trigger failed: ${error?.message ?? error}`); });
  }
  const timer = setTimeout(() => child.kill("SIGKILL"), 150_000);
  const code = await new Promise((resolve) => {
    if (triggerPromise) triggerPromise.catch(() => {});
    child.on("exit", (value) => { clearTimeout(timer); childProcs.delete(child); resolve(value); });
  });
  const events = stdout.split("\n").filter((l) => l.trim() !== "").map((l) => { try { return JSON.parse(l); } catch { return { unparsed: l }; } });
  return {
    code, stderr, events, resultFile, nonce, nonceFile, work,
    wire: received.slice(before),
    defaultDir: join(stateHome, "qq-workflows/worker-sessions"),
    transport: existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : null,
    summary: existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, "utf8")) : null,
  };
}

async function waitFor(what, predicate, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try { if (predicate()) return true; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out after ${deadlineMs}ms waiting for ${what}`);
}
const readSession = (path) => existsSync(path) && statSync(path).size > 0
  ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => { try { return JSON.parse(l); } catch { return { unparsed: l }; } })
  : [];
const sessionsIn = (dir) => readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".meta.json")).map((f) => join(dir, f));
const sidecarsIn = (dir) => readdirSync(dir).filter((f) => f.endsWith(".jsonl.meta.json"));

const results = [];
const pass = (n) => { results.push(`PASS  ${n}`); console.log(`PASS  ${n}`); };

try {
  console.log(`installed pi: ${execFileSync(piBin, ["--version"], { encoding: "utf8" }).trim()}`);

  // ---------------------------------------------------------------- W1: success
  const ok = await runAdapter({ name: "ok" });
  assert.equal(ok.code, 0, `success run must exit 0 (stderr: ${ok.stderr})`);
  assert.equal(ok.transport?.response, ok.nonce, "authoritative transport got the closing answer");
  const stderrPaths = [...ok.stderr.matchAll(/pi-worker-adapter: native session file: (\S+)/gu)].map((m) => m[1]);
  assert.equal(stderrPaths.length, 1, `exactly one trace-path stderr line (got ${stderrPaths.length})`);
  const sessionPath = stderrPaths[0];
  assert.ok(sessionPath.startsWith(`${ok.defaultDir}/pi-runner-`), `the fixture default dir was used (production store untouched): ${sessionPath}`);
  assert.equal(ok.summary?.sessionFile, sessionPath, "summary carries the same session path");

  assert.equal(statSync(ok.defaultDir).mode & 0o777, 0o700, "default worker-session dir is 0700");
  assert.equal(statSync(sessionPath).mode & 0o777, 0o600, "session file is 0600 after pi wrote it");
  const metaPath = `${sessionPath}.meta.json`;
  assert.ok(existsSync(metaPath), "sidecar metadata exists next to the session");
  assert.equal(statSync(metaPath).mode & 0o777, 0o600, "sidecar is 0600");
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  assert.deepEqual(Object.keys(meta).sort(), ["cwd", "pid", "runnerId", "schema", "seat", "sessionFile", "startedAt"]);
  assert.equal(meta.schema, "qq-worker-session-meta/1");
  assert.equal(meta.sessionFile, sessionPath);
  assert.equal(meta.seat, "runner");
  assert.equal(meta.cwd, ok.work);
  assert.equal(meta.runnerId, "rec-wire-ok");
  assert.ok(typeof meta.pid === "number" && meta.pid > 0);
  assert.ok(!Number.isNaN(Date.parse(meta.startedAt)));
  assert.ok(!readFileSync(metaPath, "utf8").includes("NONCE-"), "sidecar carries no prompt content");

  const entries = readSession(sessionPath);
  assert.ok(entries[0]?.type === "session", "session header present");
  assert.equal(entries[0].cwd, ok.work, "header cwd is the worker cwd");
  assert.ok(typeof entries[0].id === "string" && entries[0].id.length > 0, "header session id");
  const userMsg = entries.find((e) => e.type === "message" && e.message?.role === "user");
  assert.ok(userMsg, "user message recorded");
  const toolCallMsg = entries.find((e) => e.type === "message" && e.message?.role === "assistant" && Array.isArray(e.message.content) && e.message.content.some((b) => b.type === "toolCall" && b.name === "read"));
  assert.ok(toolCallMsg, "assistant toolCall (read) recorded");
  assert.equal(toolCallMsg.message.provider, PROVIDER, "assistant carries provider");
  assert.equal(toolCallMsg.message.model, MODEL, "assistant carries model");
  const toolResult = entries.find((e) => e.type === "message" && e.message?.role === "toolResult" && e.message?.toolName === "read");
  assert.ok(toolResult, "toolResult recorded");
  assert.ok(JSON.stringify(toolResult.message.content).includes(ok.nonce), "toolResult content includes the read file contents");
  const finalAssistant = entries.filter((e) => e.type === "message" && e.message?.role === "assistant").at(-1);
  assert.equal(finalAssistant.message.stopReason, "stop");
  assert.ok((finalAssistant.message.content ?? []).some((b) => b.type === "text" && b.text === ok.nonce), "final assistant text recorded");
  pass("W1 success: real pi wrote header+user+assistant(toolCall)+toolResult(nonce)+final assistant into the 0600 session file in the 0700 default dir; sidecar associated (seat/cwd/pid/runnerId)");

  {
    const piArgs = ok.summary.piArgs;
    const sIdx = piArgs.indexOf("--session");
    assert.ok(sIdx > 0, "--session present in argv");
    assert.equal(piArgs[sIdx + 1], sessionPath);
    // argv minus recording equals the exact pre-recording selection argv: the
    // repo adapter's own buildPiArgs WITHOUT a sessionPath.
    const reconstructed = [...piArgs.slice(0, sIdx), "--no-session", ...piArgs.slice(sIdx + 2)];
    const baselineArgv = buildPiArgs({
      seat: "runner",
      config: { provider: ok.summary.provider, model: ok.summary.model, reasoningEffort: ok.summary.reasoningEffort, harness: ok.summary.harness },
      extension: WORKER_PI_EXTENSION,
      tools: ok.summary.allowedTools,
      roleInstructions: piArgs[piArgs.indexOf("--append-system-prompt") + 1],
    });
    assert.deepEqual(reconstructed, baselineArgv, "argv minus recording == pre-recording selection argv exactly");
    assert.equal(piArgs.includes("--no-session"), false);
    assert.equal(ok.wire.length, 2, `exactly two provider turns (saw ${ok.wire.length})`);
    for (const request of ok.wire) {
      assert.equal(request.body.model, MODEL);
      assert.equal(request.body.reasoning_effort, "xhigh");
      assert.equal(request.body.tool_choice, undefined);
      assert.ok(String(request.headers.authorization || "").includes(DUMMY_KEY));
    }
    const known = new Set(["step_update", "item.started", "item.completed"]);
    for (const e of ok.events) {
      const t = e.event ?? e.type;
      if (t) assert.ok(known.has(t), `unexpected stdout event type ${t}`);
    }
    assert.ok(ok.events.some((e) => e.event === "step_update" && e.step_update?.tool_name === "read" && e.step_update?.state === "ACTIVE"));
    assert.ok(ok.events.some((e) => e.type === "item.completed" && e.item?.type === "agent_message" && e.item.text === ok.nonce));
  }
  pass("W1 argv/protocol/event-contract preservation (no invented consumer, no new event types)");

  // ---------------------------------------------------------------- W2: abort
  const abortRun = await runAdapter({
    name: "abort",
    mode: "stall",
    abortTrigger: async ({ child, sessionDir, turnTwoInFlight }) => {
      await waitFor("turn-1 toolResult persisted", () => sessionsIn(sessionDir).some((p) => readSession(p).some((e) => e.type === "message" && e.message?.role === "toolResult")), 60_000);
      await waitFor("turn-2 request in flight", turnTwoInFlight, 60_000);
      await new Promise((r) => setTimeout(r, 700)); // first streamed chunk lands; run is mid-message
      child.kill("SIGINT");
    },
  });
  // The adapter races its cancel path (130/143) against the settled-run
  // classification (1, run_aborted) - both are existing behaviors; the
  // recording change alters neither. The point here is evidence persistence.
  assert.ok([1, 130, 143].includes(abortRun.code), `aborted run exits 1/130/143 (got ${abortRun.code}, stderr: ${abortRun.stderr.slice(-300)})`);
  assert.match(abortRun.stderr, /run_aborted|received SIGINT/, "the abort was named on stderr");
  const abortStderrPaths = [...abortRun.stderr.matchAll(/pi-worker-adapter: native session file: (\S+)/gu)].map((m) => m[1]);
  assert.equal(abortStderrPaths.length, 1, "exactly one trace-path stderr line on the abort run");
  const abortPath = abortStderrPaths[0];
  assert.ok(abortPath.startsWith(`${abortRun.defaultDir}/pi-runner-`), abortPath);
  assert.equal(statSync(abortPath).mode & 0o777, 0o600);
  const abortEntries = readSession(abortPath);
  const aUser = abortEntries.find((e) => e.type === "message" && e.message?.role === "user");
  const aToolCall = abortEntries.find((e) => e.type === "message" && e.message?.role === "assistant" && (e.message.content ?? []).some((b) => b.type === "toolCall"));
  const aToolResult = abortEntries.find((e) => e.type === "message" && e.message?.role === "toolResult");
  assert.ok(aUser && aToolCall && aToolResult, "turn-1 user+toolCall+toolResult persisted despite abort");
  const aLast = abortEntries.filter((e) => e.type === "message" && e.message?.role === "assistant").at(-1);
  assert.ok(aLast, "an assistant message after the toolResult exists");
  assert.equal(aLast.message.stopReason, "aborted", `in-flight message finalized as aborted (got ${aLast?.message?.stopReason})`);
  assert.ok((aLast.message.content ?? []).some((b) => b.type === "text" && b.text.includes(abortRun.nonce)), "partial streamed text persisted with the aborted message");
  const abortMeta = JSON.parse(readFileSync(`${abortPath}.meta.json`, "utf8"));
  assert.equal(abortMeta.runnerId, "rec-wire-abort");
  assert.equal(abortMeta.seat, "runner");
  assert.equal(sidecarsIn(abortRun.defaultDir).length, 1, "one sidecar per attempt, no strays");
  assert.equal(statSync(abortRun.defaultDir).mode & 0o777, 0o700);
  pass("W2 abort: evidence persisted (user+toolCall+toolResult+assistant stopReason=aborted with partial text); discovered via stderr line alone; sidecar intact");

  // ---------------------------------------------------------------- W3: refusal
  const leafFile = join(root, "w3-not-a-dir");
  writeFileSync(leafFile, "x\n");
  const refusal = await runAdapter({ name: "refusal", extraEnv: { QQ_WORKER_SESSION_DIR: leafFile } });
  assert.equal(refusal.code, 2, `recording-init failure refuses with exit 2 (got ${refusal.code})`);
  assert.match(refusal.stderr, /native_session_dir_invalid/, "named refusal diagnostic on stderr");
  assert.equal(refusal.wire.length, 0, "no provider traffic on refusal");
  assert.ok(refusal.summary && refusal.summary.ok === false, "refusal summary written");
  pass("W3 recording-init failure -> exit 2, named diagnostic, no runtime spawned, no provider traffic");

  // ------------------------------------------------- reaping + time bounding
  await waitFor("all owned child processes reaped", () => childProcs.size === 0, 20_000);
  const leftover = execFileSync("bash", ["-lc", `ps -eo pid=,args= | grep -F '${root}' | grep -v grep || true`], { encoding: "utf8" }).trim();
  assert.equal(leftover, "", `no leftover processes reference the test tree: ${leftover}`);
  pass("Reaping: no owned adapter/pi/mock process left; mock time bounded (stall 30s < kill timer, aborted early)");
  console.log(`mock provider requests total: ${calls} (2 success + 2 abort + 0 refusal expected)`);
  assert.equal(calls, 4, "exactly the scripted provider traffic reached the mock");
} catch (error) {
  console.error("WIRE FAILURE:", error?.message ?? error);
  process.exitCode = 1;
} finally {
  try { server.closeAllConnections?.(); } catch {}
  try { server.close(); } catch {}
  for (const child of childProcs) { try { child.kill("SIGKILL"); } catch {} }
  await new Promise((r) => setTimeout(r, 300));
  for (const name of ["ok", "abort", "refusal"]) rmSync(join(tmpdir(), `qq-runner-result-rec-wire-${name}.json`), { force: true });
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}
console.log(results.join("\n"));
if (process.exitCode) {
  console.log(`WIRE RESULT: ${results.length} passed before failure`);
  process.exit(process.exitCode);
}
console.log(`TOTAL ${results.length}/${results.length} PASS`);
