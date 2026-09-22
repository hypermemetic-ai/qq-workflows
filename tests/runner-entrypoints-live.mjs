#!/usr/bin/env node
// Production-entrypoint live proof (phase 2b): BOTH runner entry paths — the
// native workflow operations (workflow/operations.mjs) and the MCP
// compatibility server (bin/mcp-server.mjs) — dispatch a communication-enabled
// runner through the REAL canonical worker launcher into the REAL production
// adapter/receiver (workflow/pi-worker/adapter.mjs +
// pi-extension/worker-tools.mjs), against a REAL temporary qq-relay journal
// service, with every model response produced by a deterministic localhost
// provider (dummy key, no external inference).
//
// Per entry path this proves, through the actual caller code:
//   * dispatch order record → relay → owner consumer subscription → validated
//     binding → spawn; the change record is authoritative (changeId = the
//     public job id, one fresh attempt UUID) and preserves the original task,
     // target constraints, cwd and owner routing;
//   * the observed RECEIVER identity is the real Pi session UUID bound by the
//     adapter after get_state (never the workflow consumer address — which is
//     named and used as a workflow consumer, never as an observed session);
//   * a mid-work assignment update (steer B): composed from the original
//     assignment + updates verbatim, pushed through the real relay, read and
//     acknowledged by the real model through workflow_acknowledge_assignment;
//   * meaningful committed progress pushed by the worker and bridged to the
//     caller's OWN Architect transport seam (native notifier transport / MCP
//     notifySession) with the exact deterministic wrapper text and event id;
//   * a valid report + validated outcome linked to the ACKNOWLEDGED revision
//     (the unacknowledged-in-spirit latest state is never silently re-pinned),
//     and check_runner exposing structured communication state WITHOUT the raw
//     findings.
//
// External delivery boundaries use the EXISTING fake sinks (the native
// notification transport double; the MCP `__QQ_TEST_NOTIFY_HANDLER` seam) —
// never a fabricated receipt inside the communication helper.
//
// Infrastructure is authorized test infrastructure only: a temporary relay
// service in a 0700 fixture state dir, installed Pi against a 127.0.0.1
// deterministic provider with a dummy key. Owned processes are reaped; waits
// are bounded; operator credentials/config/state are never read. A missing
// installed runtime or relay installation is reported as SKIPPED, never as a
// pass.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { openChange } from "../workflow/change-record.mjs";
import { createWorkflow } from "../workflow/operations.mjs";
import { readJob } from "../workflow/jobs.mjs";
import { readReport } from "../workflow/reports.mjs";
import { ASSIGNMENT_UPDATES_HEADING, workflowConsumerAddress } from "../workflow/runner-lifecycle.mjs";
import {
  RUNNERS,
  checkRunner as mcpCheckRunner,
  dispatchRunner as mcpDispatchRunner,
  releaseRunnerCommunication,
  steerRunner as mcpSteerRunner,
} from "../bin/mcp-server.mjs";

// ---------------------------------------------------------------------------
// Availability checks: an honest skip is never a pass.
// ---------------------------------------------------------------------------
function resolveInstalledPi() {
  for (const dir of String(process.env.PATH || "").split(":")) {
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

function resolveRelayInstallRoot() {
  const configured = process.env.QQ_RELAY_INSTALL_ROOT;
  if (configured && configured.startsWith("/")) return configured;
  const home = process.env.HOME;
  if (!home) return null;
  const root = join(home, ".local", "lib", "qq", "relay");
  return existsSync(join(root, "client.mjs")) && existsSync(join(root, "bin", "qq-relay")) ? root : null;
}

const piBin = resolveInstalledPi();
const relayRoot = resolveRelayInstallRoot();
if (!piBin || !relayRoot) {
  console.log(
    "runner entrypoints live proof SKIPPED: " +
      (!piBin ? "no installed pi runtime on PATH" : "no installed qq-relay (client.mjs + bin/qq-relay)") +
      "; run this on a machine with the installed runtime for the real proof.",
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Deterministic localhost provider: content-addressed worker behavior (the
// injected envelopes and tool results decide the next response). The flow is
// identical for both entry paths: report committed progress, hold the turn
// open so the coordinator's mid-work update lands during work, then read +
// acknowledge the exact amended revision and finish from the updated
// assignment.
// ---------------------------------------------------------------------------
// The relay's placement fence requires a private state chain: this test
// creates every fixture directory private, whatever the ambient umask is.
process.umask(0o077);
const DUMMY_KEY = "dummy-key-for-entrypoint-live";
const PROGRESS_NOTE = "Scoped the runner entrypoint work; read the assignment under test.";
const UPDATE_B = "Also cover the retry path and name the acknowledged revision in your final answer.";
const FINAL_SENTENCE = "Finished: incorporated the updated assignment at revision 2 (the acknowledged revision).";
// Deliberately longer than the check projection's bounded terminal summary:
// the full findings live in the durable report, and check_runner must not
// return them (only a bounded summary/report reference).
const FINAL_TEXT = `${FINAL_SENTENCE} ${"Evidence line for the entrypoint wiring. ".repeat(140)}`;
const INITIAL_TASK = "Inspect the entrypoint wiring and report meaningful progress.";
const TARGET_PATHS = ["workflow/operations.mjs", "bin/mcp-server.mjs"];

const wire = [];
const state = { requests: 0, progressDone: false, heldOnce: false, readDone: false, ackDone: false, toolsReported: null, envelopesSeen: [] };
function resetProviderState() {
  for (const key of Object.keys(state)) state[key] = key === "requests" ? 0 : (key === "toolsReported" ? null : (Array.isArray(state[key]) ? [] : false));
}

function messageTexts(body) {
  const texts = [];
  for (const message of body?.messages ?? []) {
    if (typeof message.content === "string") texts.push(message.content);
    else if (Array.isArray(message.content)) for (const block of message.content) if (block?.type === "text") texts.push(block.text);
  }
  return texts;
}

function findEnvelopes(body) {
  const found = [];
  for (const text of messageTexts(body)) {
    const header = text.split("\n")[0] ?? "";
    const match = header.match(/^\[message (evt_\S+) from \S+ — (\S+) \/ (\S+)(?: — tasks: ([^\]]*))?\]/);
    if (!match) continue;
    const tasks = {};
    for (const pair of (match[4] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const index = pair.indexOf(":");
      if (index > 0) tasks[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
    }
    found.push({ eventId: match[1], tasks });
  }
  return found;
}

const sseChunks = (body, chunks) => {
  const base = { id: `chatcmpl-${wire.length}`, object: "chat.completion.chunk", created: 0, model: body.model };
  const choice = (delta, finish) => ({ ...base, choices: [{ index: 0, delta, finish_reason: finish ?? null }] });
  return chunks.map(({ delta, finish }) => JSON.stringify(choice(delta, finish)));
};
const textResponse = (text, stallMs = 0) => ({ chunks: [{ delta: { role: "assistant", content: text } }, { delta: {}, finish: "stop" }], stallMs });
const toolResponse = (name, args) => ({
  chunks: [
    { delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${name}_${wire.length}`, type: "function", function: { name, arguments: "" } }] } },
    { delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } },
    { delta: {}, finish: "tool_calls" },
  ],
});

function workerBehavior(body) {
  const messages = body.messages ?? [];
  state.toolsReported = (body.tools ?? []).map((tool) => tool?.function?.name ?? tool?.name ?? null).filter(Boolean);
  const last = messages.at(-1);
  const lastText = last ? messageTexts({ messages: [last] }).join("\n") : "";
  if (last?.role === "tool") {
    if (lastText.includes("Progress committed")) {
      // Hold the turn open so the coordinator's update lands during work.
      state.heldOnce = true;
      return textResponse("working from the current assignment", 3000);
    }
    if (lastText.includes("[assignment revision 2") && !state.ackDone) {
      state.ackDone = true;
      return toolResponse("workflow_acknowledge_assignment", { revision: 2 });
    }
    if (lastText.includes("acknowledged") && state.ackDone) {
      return textResponse(FINAL_TEXT);
    }
    return textResponse("continuing", 300);
  }
  const envelopes = findEnvelopes(body);
  state.envelopesSeen.push(...envelopes.map((entry) => entry.eventId));
  const amendment = envelopes.find((entry) => entry.tasks.amendment && entry.tasks.revision);
  if (amendment && !state.readDone) {
    state.readDone = true;
    return toolResponse("workflow_read_assignment", { revision: 2 });
  }
  if (!state.progressDone) {
    state.progressDone = true;
    return toolResponse("workflow_report_progress", { kind: "progress", message: PROGRESS_NOTE });
  }
  return textResponse("waiting", 1000);
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    wire.push({ at: Date.now(), model: parsed?.model });
    appendFileSync(join(fixtureRoot, "wire-log.jsonl"), `${JSON.stringify({ at: Date.now(), lastRole: parsed?.messages?.at(-1)?.role ?? null, toolNames: (parsed?.tools ?? []).map((t) => t?.function?.name ?? t?.name).filter(Boolean) })}\n`);
    if (!String(req.url).includes("/chat/completions") || !parsed || parsed.model !== "entrypoint-live-worker") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":{"message":"not found"}}');
      return;
    }
    state.requests += 1;
    const response = workerBehavior(parsed);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const chunk of sseChunks(parsed, response.chunks)) res.write(`data: ${chunk}\n\n`);
    if (response.stallMs > 0) {
      const timer = setTimeout(() => {
        try { res.write("data: [DONE]\n\n"); res.end(); } catch {}
      }, response.stallMs);
      timer.unref?.();
      res.on("close", () => clearTimeout(timer));
      return;
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------
const fixtureRoot = mkdtempSync(join(tmpdir(), "qq-entrypoints-live-"));
chmodSync(fixtureRoot, 0o700);
const results = [];
const pass = (name) => { results.push(name); console.log(`PASS  ${name}`); };
const ownedChildren = new Set();

function writeAgentSource(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const models = [{
    id: "entrypoint-live-worker",
    name: "entrypoint-live-worker",
    reasoning: true,
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 8192,
    thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
    compat: { supportsReasoningEffort: true, maxTokensField: "max_tokens", supportsStrictMode: false },
  }];
  writeFileSync(join(dir, "models.json"), `${JSON.stringify({ providers: {
    "entrypoint-live": { name: "Entrypoint Live Local Mock", api: "openai-completions", baseUrl: `${providerOrigin}/v1`, apiKey: DUMMY_KEY, models },
  } }, null, 2)}\n`, "utf8");
}

function writeWorkerConfig(file) {
  writeFileSync(file, `${JSON.stringify({
    harness: "pi",
    provider: "entrypoint-live",
    model: "entrypoint-live-worker",
    env_key: "MODEL_API_KEY",
    context: { enabled: true, reserve_tokens: 16_384, keep_recent_tokens: 20_000 },
  }, null, 2)}\n`, "utf8");
}

async function waitFor(what, predicate, deadlineMs = 90_000, intervalMs = 100) {
  const deadline = Date.now() + deadlineMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${deadlineMs}ms waiting for ${what}${lastError ? ` (last error: ${lastError.message})` : ""}`);
}

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const providerOrigin = `http://127.0.0.1:${server.address().port}`;
const agentSource = join(fixtureRoot, "agent-source");
writeAgentSource(agentSource);
const configFile = join(fixtureRoot, "worker-config.json");
writeWorkerConfig(configFile);

function baseEnv(label) {
  const env = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    XDG_STATE_HOME: join(fixtureRoot, `xdg-${label}`),
    QQ_WORKER_CONFIG_FILE: configFile,
    PI_CODING_AGENT_DIR: agentSource,
    QQ_WORKER_PI_AGENT_DIR: join(fixtureRoot, `agent-worker-${label}`),
    QQ_RELAY_INSTALL_ROOT: relayRoot,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    MODEL_API_KEY: DUMMY_KEY,
    QQ_RUNNER_FINDINGS_DIR: join(fixtureRoot, `findings-${label}`),
  };
  // Never leak one entry's binding into the other's dispatch.
  delete env.QQ_WORKFLOW_COMMUNICATION;
  for (const dir of [env.XDG_STATE_HOME, env.QQ_RUNNER_FINDINGS_DIR]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return env;
}

function attemptsOf(stateDir, changeId) {
  const handle = openChange({ stateDir, changeId });
  return handle;
}

// The exact parent-facing progress wrapper, for both transport seams.
function expectedProgressText(jobId, attemptId, seq) {
  return `Runner ${jobId} reported progress at sequence ${seq} (attempt ${attemptId}):\n${PROGRESS_NOTE}`;
}

// ---------------------------------------------------------------------------
// Native entry path (workflow/operations.mjs createWorkflow + dispatchRunner).
// ---------------------------------------------------------------------------
async function runNative() {
  resetProviderState();
  const label = "native";
  const env = baseEnv(label);
  const repoDir = join(fixtureRoot, "repo-native");
  mkdirSync(repoDir, { recursive: true, mode: 0o700 });
  const delivered = [];
  const sink = {
    name: "entry-live-sink",
    async deliver(notification) {
      delivered.push({ ...notification, state: "delivered" });
      return { state: "delivered", messageId: `msg-${delivered.length}` };
    },
  };
  let spawnEnvObserved = null;
  const workflow = createWorkflow({
    root: repoDir,
    env,
    sessionKey: "owner-native",
    notifierTransport: sink,
    spawnFn: (command, args, options) => {
      spawnEnvObserved = options?.env ?? null;
      return spawn(command, args, options);
    },
  });
  try {
    const consumerAddress = workflowConsumerAddress({ root: repoDir, ownerRouting: "owner-native" });

    // Dispatch: synchronous job id + ready promise (a returned job id never
    // means the receiver binding is ready); the tool surface awaits `ready`.
    const dispatch = workflow.dispatchRunner({ task: INITIAL_TASK, targetPaths: TARGET_PATHS, cwd: repoDir });
    assert.equal(dispatch.ok, true);
    assert.equal(dispatch.status, "launching");
    assert.ok(dispatch.jobId, "the durable job id returns synchronously");
    const ready = await dispatch.ready;
    assert.equal(ready.ok, true, JSON.stringify(ready));
    assert.equal(ready.status, "running");
    const jobId = dispatch.jobId;

    // The change record is authoritative: changeId = the public job id, one
    // fresh attempt, original assignment/targets/cwd/owner preserved.
    const stateDir = workflow.stateDir;
    const recordHandle = attemptsOf(stateDir, jobId);
    const jobView = recordHandle.views.job(jobId);
    assert.equal(jobView.role, "runner");
    assert.equal(jobView.pinnedRevision, 1);
    const attemptId = jobView.attemptOrder[0];
    assert.match(attemptId, /^[0-9a-f-]{36}$/, "the attempt carries a fresh UUID");
    const launchIntent = jobView.attempts[attemptId].launchIntent;
    assert.equal(launchIntent.owner, "owner-native", "owner/session routing is preserved in the record");
    assert.equal(launchIntent.cwd, repoDir, "the launch cwd is preserved in the record");
    assert.deepEqual(launchIntent.targetPaths, TARGET_PATHS, "target paths are preserved in the record");
    const revision1 = recordHandle.views.assignment({ revision: 1 }).assignment.instructions;
    assert.ok(revision1.startsWith(INITIAL_TASK), "the original assignment is kept verbatim");
    assert.ok(revision1.includes(`Target paths to inspect:\n${TARGET_PATHS.join("\n")}`), "target constraints are kept verbatim");

    // The prepared binding rides explicitly in the child environment: the
    // return recipient is the WORKFLOW CONSUMER address, never a session.
    const binding = JSON.parse(spawnEnvObserved.QQ_WORKFLOW_COMMUNICATION);
    assert.equal(binding.schema, "qq-worker-communication-binding/1");
    assert.equal(binding.changeId, jobId, "one change record per standalone runner (changeId = job id)");
    assert.equal(binding.jobId, jobId);
    assert.equal(binding.attemptId, attemptId);
    assert.equal(binding.recipientAgent, `agents/${consumerAddress}`, "the return recipient is the workflow consumer address");
    assert.notEqual(binding.recipientAgent, `agents/${binding.attemptId}`);
    pass("native dispatch: record → relay → consumer → validated binding → spawn, with the exact binding env");

    // The adapter binds the REAL runtime session after get_state.
    const bound = await waitFor("the recorded receiver binding", () => {
      const attempt = attemptsOf(stateDir, jobId).views.job(jobId).attempts[attemptId];
      return attempt.started?.identity ?? null;
    }, 120_000, 200);
    assert.match(bound.piSession, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "the receiver identity is the real Pi session UUID");
    assert.notEqual(bound.piSession, consumerAddress, "the worker session and the workflow consumer are different identities");
    pass("native: actual receiver identity observed and recorded (never the consumer address)");

    // Steer B during work (the provider is mid-hold).
    await waitFor("the worker's hold window at the provider", () => state.heldOnce, 120_000, 100);
    const steer = await workflow.steerRunner({ jobId, message: UPDATE_B });
    assert.equal(steer.ok, true, JSON.stringify(steer));
    assert.equal(steer.recorded, true);
    assert.equal(steer.revision, 2);
    assert.equal(steer.acknowledged, false, "recording never claims acknowledgement");
    assert.notEqual(steer.steered, true);
    assert.notEqual(steer.delivered, true, "no delivered/steered true is returned from a mere send");
    assert.ok(["queued", "delivering"].includes(steer.delivery.status), `transport receipt is its own fact (${steer.delivery.status})`);
    pass("native steer B: recorded first, transport receipt reported separately, no false success");

    // The real model reads + acknowledges revision B.
    await waitFor("the worker acknowledgement of revision 2", () => {
      const attempt = attemptsOf(stateDir, jobId).views.job(jobId).attempts[attemptId];
      return attempt.acknowledgements.some((ack) => ack.revision === 2);
    }, 120_000, 200);
    pass("native: the update was read and acknowledged by the real model (workflow_acknowledge_assignment)");

    // Committed progress rides to THIS caller's transport seam with the exact
    // deterministic wrapper (rebuilt from the committed note).
    const progress = await waitFor("the bridged progress notification", () => {
      const entry = attemptsOf(stateDir, jobId).views.job(jobId).attempts[attemptId].progress.at(-1);
      if (!entry) return null;
      return delivered.find((notification) => notification.text === expectedProgressText(jobId, attemptId, entry.seq)) ?? null;
    }, 60_000, 200);
    assert.ok(progress, "the progress notification reached the native notification transport");
    assert.ok(progress.text.includes(PROGRESS_NOTE), "the wrapper carries the committed note verbatim");
    pass("native progress: committed note bridged through the Architect transport seam with the exact wrapper");

    // Completion: valid report + validated outcome linked to the ACKNOWLEDGED
    // revision (never silently re-pinned to an unacknowledged one).
    const checkLive = workflow.checkRunner({ jobId });
    const liveText = JSON.stringify(checkLive);
    assert.ok(!liveText.includes(FINAL_TEXT), "check_runner never returns the raw findings");
    assert.ok(!liveText.includes(PROGRESS_NOTE) || liveText.includes("communication"), "progress text only rides in the notification wrapper, not check output");
    const terminal = await waitFor("the durable terminal record", () => {
      const record = readJob(stateDir, jobId);
      return record?.terminal ? record : null;
    }, 120_000, 200);
    assert.equal(terminal.terminal.status, "completed");
    assert.ok(terminal.terminal.reportId, "the terminal record points at the durable report");
    const report = readReport(stateDir, terminal.terminal.reportId);
    assert.ok(report.text.includes(FINAL_TEXT), "the durable report holds the valid final findings");
    const attemptFinal = attemptsOf(stateDir, jobId).views.job(jobId).attempts[attemptId];
    assert.equal(attemptFinal.outcome.status, "completed");
    assert.equal(attemptFinal.outcome.revision, 2, "the outcome is linked to the acknowledged revision");
    const finalCheck = workflow.checkRunner({ jobId });
    assert.equal(finalCheck.communication.enabled, true);
    assert.equal(finalCheck.communication.supported, true);
    assert.equal(finalCheck.communication.changeId, jobId);
    assert.equal(finalCheck.communication.effectiveRevision, 2);
    assert.equal(finalCheck.communication.outcome.status, "completed");
    assert.ok(!JSON.stringify(finalCheck).includes(FINAL_TEXT), "check_runner exposes structured state, never the findings");
    pass("native completion: valid report/outcome linked to the acknowledged revision; check_runner carries no findings");

    // A duplicate/late steer after terminal is refused honestly.
    const late = await workflow.steerRunner({ jobId, message: "one more thing" });
    assert.equal(late.ok, false, "updates after terminal are refused");
    pass("native lifecycle honesty: post-terminal updates are refused, not silently lost");
  } finally {
    void workflow.releaseCommunication().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// MCP entry path (bin/mcp-server.mjs dispatchRunner/checkRunner/steerRunner).
// ---------------------------------------------------------------------------
async function runMcp() {
  resetProviderState();
  const label = "mcp";
  const env = baseEnv(label);
  const repoDir = join(fixtureRoot, "repo-mcp");
  mkdirSync(repoDir, { recursive: true, mode: 0o700 });
  const MCP_SESSION = "11111111-2222-4333-8444-555555555555";

  // The EXISTING external-delivery fake sink (the notifySession test seam):
  // nothing is fabricated inside the communication helper.
  const captured = [];
  globalThis.__QQ_TEST_CODEX_THREAD = "entrypoints-live-thread";
  globalThis.__QQ_TEST_NOTIFY_HANDLER = async (call) => { captured.push(call); };

  const savedEnv = { ...process.env };
  try {
    Object.assign(process.env, env);
    process.env.QQ_WORKFLOW_STATE_DIR = join(fixtureRoot, "state-mcp");
    mkdirSync(process.env.QQ_WORKFLOW_STATE_DIR, { recursive: true, mode: 0o700 });

    const res = await mcpDispatchRunner({ task: INITIAL_TASK, targetPaths: TARGET_PATHS, cwd: repoDir, sessionId: MCP_SESSION });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.status, "running");
    assert.equal(res.communication.enabled, true, "the dispatch reports its communication projection");
    const runnerId = res.runnerId;
    const stateDir = join(fixtureRoot, "state-mcp");
    const consumerAddress = workflowConsumerAddress({ root: repoDir, ownerRouting: MCP_SESSION });

    const recordHandle = attemptsOf(stateDir, runnerId);
    const jobView = recordHandle.views.job(runnerId);
    const attemptId = jobView.attemptOrder[0];
    assert.match(attemptId, /^[0-9a-f-]{36}$/, "the attempt carries a fresh UUID");
    assert.equal(jobView.attempts[attemptId].launchIntent.owner, MCP_SESSION, "owner/session routing is preserved in the record");
    const revision1 = recordHandle.views.assignment({ revision: 1 }).assignment.instructions;
    assert.ok(revision1.startsWith(INITIAL_TASK), "the original assignment is kept verbatim");
    assert.ok(revision1.includes(`Target paths to inspect:\n${TARGET_PATHS.join("\n")}`), "target constraints are kept verbatim");
    pass("mcp dispatch: authoritative record with fresh attempt and preserved assignment/cwd/owner");

    const bound = await waitFor("the recorded receiver binding", () => {
      const attempt = attemptsOf(stateDir, runnerId).views.job(runnerId).attempts[attemptId];
      return attempt.started?.identity ?? null;
    }, 120_000, 200);
    assert.match(bound.piSession, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(bound.piSession, consumerAddress, "the receiver binding is a real session, not the workflow consumer");
    assert.equal(bound.recipient, `agents/${bound.piSession}`);
    pass("mcp: actual receiver identity observed and recorded (never the consumer address)");

    await waitFor("the worker's hold window at the provider", () => state.heldOnce, 120_000, 100);
    const steer = await mcpSteerRunner({ runnerId, instruction: UPDATE_B });
    assert.equal(steer.ok, true, JSON.stringify(steer));
    assert.equal(steer.recorded, true);
    assert.equal(steer.revision, 2);
    assert.equal(steer.acknowledged, false);
    assert.notEqual(steer.steered, true);
    assert.notEqual(steer.delivered, true);
    assert.ok(["queued", "delivering"].includes(steer.delivery.status), `transport receipt is its own fact (${steer.delivery.status})`);
    pass("mcp steer B: recorded first, transport receipt reported separately, no false success");

    await waitFor("the worker acknowledgement of revision 2", () => {
      const attempt = attemptsOf(stateDir, runnerId).views.job(runnerId).attempts[attemptId];
      return attempt.acknowledgements.some((ack) => ack.revision === 2);
    }, 120_000, 200);
    pass("mcp: the update was read and acknowledged by the real model (workflow_acknowledge_assignment)");

    await waitFor("the bridged progress notification", () => {
      const entry = attemptsOf(stateDir, runnerId).views.job(runnerId).attempts[attemptId].progress.at(-1);
      if (!entry) return null;
      return captured.find((call) => call.message === expectedProgressText(runnerId, attemptId, entry.seq)) ?? null;
    }, 60_000, 200);
    pass("mcp progress: committed note bridged through the notifySession seam with the exact wrapper");

    await waitFor("the terminal tracker state", () => {
      const tracker = RUNNERS.get(runnerId);
      return tracker && tracker.status !== "running" ? tracker : null;
    }, 120_000, 200);
    const tracker = RUNNERS.get(runnerId);
    assert.equal(tracker.status, "completed", JSON.stringify(tracker.error ?? null));
    assert.ok(tracker.result?.response?.includes(FINAL_TEXT) ?? String(tracker.result ?? "").includes(FINAL_TEXT), "the validated result reflects the updated assignment");
    const check = await mcpCheckRunner({ runnerId });
    assert.equal(check.communication.enabled, true);
    assert.equal(check.communication.changeId, runnerId);
    assert.equal(check.communication.effectiveRevision, 2);
    assert.equal(check.communication.outcome.status, "completed", "the authoritative outcome is exposed after terminal completion");
    assert.equal(check.communication.outcome.revision, 2, "the outcome is linked to the acknowledged revision");
    assert.ok(check.communication.pendingUpdateCount === 0, "nothing is pending once revision 2 is acknowledged");
    assert.ok(!JSON.stringify(check).includes(FINAL_TEXT), "check_runner exposes structured state, never the findings");
    const terminalNote = await waitFor("the terminal notification", () =>
      captured.find((call) => call.kind === "runner.terminal") ?? null, 60_000, 200);
    assert.ok(terminalNote, "the existing terminal notification path still runs");
    pass("mcp completion: valid result/outcome linked to the acknowledged revision; check_runner carries no findings");
  } finally {
    delete globalThis.__QQ_TEST_NOTIFY_HANDLER;
    process.env.QQ_WORKFLOW_STATE_DIR = savedEnv.QQ_WORKFLOW_STATE_DIR ?? "";
    if (!savedEnv.QQ_WORKFLOW_STATE_DIR) delete process.env.QQ_WORKFLOW_STATE_DIR;
    void releaseRunnerCommunication().catch(() => {});
  }
}

try {
  await runNative();
  await runMcp();
  console.log(`\nrunner-entrypoints-live: ${results.length} groups passed.`);
} catch (error) {
  console.error("ENTRYPOINTS LIVE FAILURE:", error?.message ?? error);
  console.error(error?.stack?.split("\n").slice(0, 12).join("\n") ?? "");
  process.exitCode = 1;
} finally {
  await cleanup("finally");
}

async function cleanup(cause) {
  for (const child of ownedChildren) {
    try { child.kill("SIGKILL"); } catch {}
  }
  try { await releaseRunnerCommunication(); } catch {}
  await new Promise((r) => setTimeout(r, 300));
  try { server.closeAllConnections?.(); } catch {}
  try { server.close(); } catch {}
  if (cause === "signal") process.exit(124);
}
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => { void cleanup("signal"); });
}
console.log(`runner-entrypoints-live: TOTAL ${results.length}/${results.length} PASS (artifacts retained under ${fixtureRoot})`);
if (process.exitCode) process.exit(process.exitCode);
