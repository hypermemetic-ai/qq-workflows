#!/usr/bin/env node
// Live proof for runner communication (phase 2a): the REAL installed pi
// runtime driven by the REAL production adapter (workflow/pi-worker/adapter.mjs)
// with the REAL production worker extension (pi-extension/worker-tools.mjs —
// the shared search tool plus the three coordinator-authored workflow tools),
// against a REAL temporary qq-relay journal service, with every model response
// produced by a deterministic localhost provider (dummy key, no external
// inference).
//
// What is proven here that no simulated host can prove:
//   * the production binding path end to end: the adapter validates the
//     binding, binds the runtime's OWN observed session id against the exact
//     started attempt in the change record, exposes the three tools and the
//     coordinator-authored role paragraph to the real model, closes the
//     receiver admission after the first settle, and runs the bounded drain;
//   * a mid-turn amendment: durably submitted by the coordinator
//     (submitAmendment), pushed through the real relay, injected into the
//     RUNNING turn by the production receiver, read and acknowledged by the
//     real model through workflow_acknowledge_assignment, with the final
//     answer reflecting the updated assignment;
//   * the three facts stay distinct in inspection: recorded (change record),
//     receiver receipt observed (relay obligation delivered), worker
//     acknowledgement (worker.acknowledged);
//   * the committed progress note is the only body of the return-direction
//     push, published through the real relay to the architect-side consumer;
//   * the production wire: the shared search tool and the three workflow tools
//     are registered through the real extension mechanism, and the fixture
//     receiver's test-only tools are NOT.
//
// Infrastructure is authorized test infrastructure only: a temporary relay
// service in a 0700 fixture state dir, installed Pi against a 127.0.0.1
// deterministic provider with a dummy key. All owned processes are reaped;
// waits are bounded; operator credentials/config/state are never read. The
// fixture root is RETAINED as the test-artifact transcript (the path is
// printed); owned processes are always cleaned up.
//
// A missing installed runtime or relay installation is reported as SKIPPED,
// never as a pass.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  COMMUNICATION_BINDING_ENV,
  COMMUNICATION_BINDING_SCHEMA,
  pushedUpdateText,
} from "../workflow/communication.mjs";
import {
  acquireRelayRuntime,
  inspectAmendment,
  publishCommittedProgress,
  receiverBindingOf,
  relaySocketPath,
  submitAmendment,
} from "../workflow/communication.mjs";
import { createChange, openChange } from "../workflow/change-record.mjs";
import { WORKER_PI_ADAPTER } from "../workflow/worker-config.mjs";

const repoRoot = dirname(new URL("..", import.meta.url).pathname);
const DUMMY_KEY = "dummy-key-for-localhost-comm-live";
const CHANGE_ID = "comm-live-1";
const JOB_ID = "job-live-1";
const ATTEMPT_ID = "attempt-1";
const RUNTIME_ACTOR = { kind: "runtime", id: "comm-live-runtime" };
const INITIAL_PROMPT = "Communication live fixture. Read your assignment, report progress, and follow any assignment update you receive.";
const PROGRESS_NOTE = "Scoped the communication work; read the current assignment.";

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
    "worker communication live proof SKIPPED: " +
      (!piBin ? "no installed pi runtime on PATH" : "no installed qq-relay (client.mjs + bin/qq-relay)") +
      "; the offline acceptance in tests/worker-communication.mjs still runs.",
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Fixture state
// ---------------------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "qq-comm-live-"));
chmodSync(root, 0o700);
const xdgState = join(root, "xdg");
const relayStateDir = join(xdgState, "qq-relay");
const changeStateDir = join(root, "change-state");
mkdirSync(changeStateDir, { recursive: true, mode: 0o700 });
mkdirSync(relayStateDir, { recursive: true, mode: 0o700 });
mkdirSync(xdgState, { recursive: true, mode: 0o700 });

const results = [];
const pass = (name) => { results.push(name); console.log(`PASS  ${name}`); };
const ownedChildren = new Set();

// ---------------------------------------------------------------------------
// Deterministic localhost provider: one worker model whose behavior is
// content-addressed (the injected envelopes and tool results decide the next
// response). No external inference is reachable.
// ---------------------------------------------------------------------------
const wire = [];
const state = {
  requests: 0,
  readDone: false,
  progressDone: false,
  ackDone: false,
  heldOnce: false,
  envelopesSeen: [],
  toolsReported: null,
};

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
    found.push({ eventId: match[1], tasks, headerLine: header });
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
  const lastTexts = last ? messageTexts({ messages: [last] }) : [];
  const lastText = lastTexts.join("\n");
  // The post-tool follow-up request ENDS with the tool result; each tool's own
  // result text routes the next step of the scripted work.
  if (last?.role === "tool") {
    if (lastText.includes("Progress committed")) {
      return toolResponse("workflow_read_assignment", {});
    }
    if (lastText.includes("[assignment revision 1")) {
      // Hold the turn open so the coordinator's mid-turn push lands while the
      // receiver is busy; the turn then settles and the receiver injects the
      // amendment as a new turn (the postponement path).
      state.heldOnce = true;
      return textResponse("working from the current assignment", 2500);
    }
    if (lastText.includes("[assignment revision 2") && !state.ackDone) {
      state.ackDone = true;
      return toolResponse("workflow_acknowledge_assignment", { revision: 2 });
    }
    if (lastText.includes("acknowledged")) {
      return textResponse("Incorporated the updated assignment; continuing from revision 2.");
    }
    return textResponse("continuing");
  }
  const envelopes = findEnvelopes(body);
  state.envelopesSeen.push(...envelopes.map((entry) => entry.eventId));
  const amendment = envelopes.find((entry) => entry.tasks.amendment && entry.tasks.revision);
  if (amendment && !state.ackDone) {
    // The injected turn starts from the pushed envelope: read the EXACT
    // amended revision before acknowledging it.
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
    wire.push({ at: Date.now(), model: parsed?.model, body: parsed, authorization: req.headers.authorization });
    appendFileSync(join(root, "wire-log.jsonl"), `${JSON.stringify({ at: Date.now(), model: parsed?.model, url: req.url, lastRole: parsed?.messages?.at(-1)?.role ?? null, lastText: String(messageTexts({ messages: (parsed?.messages ?? []).slice(-1) })).slice(0, 200), toolNames: (parsed?.tools ?? []).map((t) => t?.function?.name ?? t?.name).filter(Boolean) })}\n`);
    if (!String(req.url).includes("/chat/completions") || !parsed || parsed.model !== "comm-live-worker") {
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
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const providerOrigin = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------
function writeAgentDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const models = [{
    id: "comm-live-worker",
    name: "comm-live-worker",
    reasoning: true,
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 8192,
    thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
    compat: { supportsReasoningEffort: true, maxTokensField: "max_tokens", supportsStrictMode: false },
  }];
  writeFileSync(join(dir, "models.json"), `${JSON.stringify({ providers: {
    "comm-live": { name: "Comm Live Local Mock", api: "openai-completions", baseUrl: `${providerOrigin}/v1`, apiKey: DUMMY_KEY, models },
  } }, null, 2)}\n`, "utf8");
}

function writeWorkerConfig(file) {
  writeFileSync(file, `${JSON.stringify({
    harness: "pi",
    provider: "comm-live",
    model: "comm-live-worker",
    env_key: "MODEL_API_KEY",
    context: { enabled: true, reserve_tokens: 16_384, keep_recent_tokens: 20_000 },
  }, null, 2)}\n`, "utf8");
}

async function waitFor(what, predicate, deadlineMs = 30_000, intervalMs = 100) {
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

function crHandle() {
  return openChange({ stateDir: changeStateDir, changeId: CHANGE_ID });
}
function crAppend(kind, payload, { context = {}, commandId, actor = RUNTIME_ACTOR } = {}) {
  return crHandle().append(kind, payload, { context: { actor, ...context }, commandId });
}

// ---------------------------------------------------------------------------
// Real temporary journal service + the parent-owned runtime handle (the
// production acquisition path).
// ---------------------------------------------------------------------------
const relayChild = spawn(join(relayRoot, "bin", "qq-relay"), ["serve", "--state-dir", relayStateDir], {
  stdio: ["ignore", "pipe", "pipe"],
});
ownedChildren.add(relayChild);
const relayLog = [];
relayChild.stdout.on("data", (c) => relayLog.push(String(c)));
relayChild.stderr.on("data", (c) => relayLog.push(String(c)));
const relaySocket = join(relayStateDir, "qq-relay.sock");
await waitFor("relay socket", () => existsSync(relaySocket), 15_000, 50);
const { RelayClient } = await import(pathToFileURL(join(relayRoot, "client.mjs")).href);
const journal = new RelayClient(relaySocket);
const health = await journal.inspect({ view: "health" });
assert.equal(health?.service, "qq-relay", "the temporary journal service answered the health view");

// The architect-side consumer is a test-side relay identity (a fixed random
// UUID), not a real architect session: the architect receipt direction is
// already proven by docs/pi-relay-receiver-proof.md, which stays green.
const architectConsumerId = "6c9f2e1a-7b3c-4d8e-9a01-b2c3d4e5f607";

// The parent owns the relay runtime through the production acquisition path;
// the worker process only ever connects as a client.
const runtimeDir = join(changeStateDir, "relay");
mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
const acquired = await acquireRelayRuntime({ stateDir: changeStateDir, env: { ...process.env, QQ_RELAY_INSTALL_ROOT: relayRoot } });
assert.equal(acquired.ok, true, acquired.reason ?? "the parent acquired the relay runtime");
const relayHandle = acquired.relay;

// The architect-side consumer subscribes BEFORE any push exists, so delivery
// obligations bind to a live subscription (a consumer that appears only after
// the push would leave the obligation unrouteable for this test's lifetime).
const architectClient = new RelayClient(relayHandle.socketPath);
const priming = await architectClient.next({
  consumer_type: "recipient",
  consumer_id: `agents/${architectConsumerId}`,
  generation: 0,
  endpoint_token: `agent-messages/${architectConsumerId}`,
  wait_ms: 0,
});
assert.equal(priming?.delivery ?? null, null, "the priming poll sees an empty queue");

// ---------------------------------------------------------------------------
// Change record: revision 1 assignment, a runner job, an unresolved launch
// intent. The ADAPTER binds the attempt after observing the real session.
// ---------------------------------------------------------------------------
createChange({ stateDir: changeStateDir, changeId: CHANGE_ID, actor: RUNTIME_ACTOR, title: "Communication live fixture" });
crAppend("assignment.revised", {
  revision: 1,
  predecessor: null,
  scope: { kind: "change" },
  assignment: { instructions: "Live fixture assignment revision 1. Do the fixture work and report progress." },
});
crAppend("job.registered", { role: "runner", pinnedRevision: 1 }, { context: { jobId: JOB_ID } });
crAppend("attempt.launch_intent", { note: "comm live fixture" }, { context: { jobId: JOB_ID, attemptId: ATTEMPT_ID } });

const configFile = join(root, "worker-config.json");
writeWorkerConfig(configFile);
// The fixture registry is the SYMLINK SOURCE (PI_CODING_AGENT_DIR): the
// adapter materializes an isolated worker agent dir that references the
// source registry files in place. Without this override the adapter would
// link the operator's real registry and the runtime would resolve a real
// provider - exactly what this fixture must never do.
const agentSource = join(root, "agent-source");
writeAgentDir(agentSource);
const agentDir = join(root, "agent-worker");
const workDir = join(root, "work");
mkdirSync(workDir, { recursive: true, mode: 0o700 });
const runnerId = "comm-live-runner";
const resultFile = join(root, "runner-result.json");
const summaryFile = join(root, "adapter-summary.json");

const binding = {
  schema: COMMUNICATION_BINDING_SCHEMA,
  stateDir: changeStateDir,
  changeId: CHANGE_ID,
  jobId: JOB_ID,
  attemptId: ATTEMPT_ID,
  actorId: "comm-live-worker",
  runtimeActorId: "comm-live-runtime",
  role: "runner",
  recipientAgent: `agents/${architectConsumerId}`,
  socketPath: relaySocketPath(changeStateDir),
  installRoot: relayRoot,
  drainMs: 8000,
};

const adapterChild = spawn(process.execPath, [
  WORKER_PI_ADAPTER,
  "--production", "--seat", "runner", "--cwd", workDir,
  "--prompt", INITIAL_PROMPT,
  "--summary-file", summaryFile,
], {
  env: {
    ...process.env,
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    XDG_STATE_HOME: xdgState,
    QQ_WORKER_CONFIG_FILE: configFile,
    QQ_WORKER_PI_AGENT_DIR: agentDir,
    PI_CODING_AGENT_DIR: agentSource,
    QQ_RELAY_INSTALL_ROOT: relayRoot,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    MODEL_API_KEY: DUMMY_KEY,
    QQ_ZVEC_GREP_ROOT: workDir,
    QQ_ZVEC_GREP_SEAT: "runner",
    QQ_RUNNER_ID: runnerId,
    QQ_RUNNER_RESULT_FILE: resultFile,
    [COMMUNICATION_BINDING_ENV]: JSON.stringify(binding),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
ownedChildren.add(adapterChild);
const adapterStderr = [];
adapterChild.stderr.on("data", (chunk) => adapterStderr.push(String(chunk)));

// The adapter binds the observed session BEFORE any delivery admission: wait
// for the recorded binding, then submit the amendment from the coordinator
// side while the worker's first turn is still running.
await waitFor("the recorded receiver binding", () => {
  const attemptView = crHandle().views.attempt(JOB_ID, ATTEMPT_ID);
  return receiverBindingOf(attemptView);
}, 60_000, 200);
const boundIdentity = receiverBindingOf(crHandle().views.attempt(JOB_ID, ATTEMPT_ID));
assert.match(boundIdentity.piSession, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "the bound identity is a bare Pi session UUID observed from the real runtime");
assert.equal(boundIdentity.recipient, `agents/${boundIdentity.piSession}`, "the recipient is derived from the observed session");
pass("adapter bound the real runtime session against the exact started attempt before any admission");

// Wait until the worker is actually busy (the provider saw the hold request),
// then submit + push the amendment through the production path.
await waitFor("the worker's hold-window request at the provider", () => state.heldOnce, 90_000, 100);
  await new Promise((r) => setTimeout(r, 300)); // the worker is mid-stall (busy)
const submitted = await submitAmendment({
  stateDir: changeStateDir,
  changeId: CHANGE_ID,
  jobId: JOB_ID,
  attemptId: ATTEMPT_ID,
  instructions: "Live fixture revision 2: after the update, the worker must mention 'updated assignment' in its final answer.",
  amendmentId: "amend-live-1",
  actor: RUNTIME_ACTOR,
  relay: relayHandle,
});
assert.equal(submitted.ok, true, `the amendment was submitted: ${JSON.stringify(submitted).slice(0, 300)}`);
assert.equal(submitted.revision, 2);
assert.ok(
    ["queued", "delivering"].includes(submitted.delivery.status),
    `the real relay accepted the pushed update (status ${submitted.delivery.status}: queued or already claimed by the receiver)`,
  );
assert.match(submitted.delivery.eventId ?? "", /^evt_/);

// Wait for the adapter run to finish (bounded; the drain window is 1.5s).
const exitCode = await new Promise((resolve) => {
  adapterChild.on("exit", (code) => resolve(code));
  setTimeout(() => resolve(null), 120_000).unref?.();
});
assert.equal(exitCode, 0, `the adapter exited 0 (stderr tail: ${adapterStderr.join("").slice(-600)})`);
const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
pass("the adapter ran the communication-enabled runner to completion");

try {
// ---------------------------------------------------------------------------
// Assertions over the record, the summary, the wire, and the inspection layers.
// ---------------------------------------------------------------------------
assert.equal(summary.outcome, "completed");
assert.equal(summary.communication.enabled, true);
assert.equal(summary.communication.changeId, CHANGE_ID);
assert.equal(summary.communication.jobId, JOB_ID);
assert.equal(summary.communication.attemptId, ATTEMPT_ID);
assert.equal(summary.communication.bound.recorded, true, "the binding was recorded by the adapter (fresh, not a dedupe)");
assert.equal(summary.communication.bound.recipient, `agents/${boundIdentity.piSession}`);
assert.equal(typeof summary.communication.admissionClosed.seq, "number", "the adapter closed the receiver admission after the first settle");
assert.ok(summary.communication.drain, "the drain report exists");
assert.equal(summary.communication.drain.injectedTurns, 0, "no idle injection happened after the settle");
for (const tool of ["zvec_grep_search", "workflow_read_assignment", "workflow_acknowledge_assignment", "workflow_report_progress"]) {
  assert.ok(summary.allowedTools.includes(tool), `the production tool surface includes ${tool}`);
}
assert.equal(summary.instructions.communicationRoleParagraph, true, "the coordinator-authored paragraph was appended");
pass("adapter summary: enabled, bound, admission closed, drained, full production tool surface + paragraph");

// The record holds the whole production story, in the right order.
const attemptView = crHandle().views.attempt(JOB_ID, ATTEMPT_ID);
assert.equal(attemptView.started.identity.piSession, boundIdentity.piSession);
assert.ok(attemptView.admissionClosed, "the admission closure is in the record");
const jobView = crHandle().views.job(JOB_ID);
const amendmentView = jobView.amendments.find((entry) => entry.amendmentId === "amend-live-1");
assert.ok(amendmentView, "the amendment is recorded");
assert.equal(amendmentView.revision, 2);
assert.ok(amendmentView.acknowledged, "the worker acknowledged the amendment");
assert.ok(amendmentView.acknowledged.seq < attemptView.admissionClosed.seq, "the incorporation committed BEFORE the admission closure");
const progressEntries = attemptView.progress;
assert.ok(progressEntries.length >= 1, "the worker's progress is committed");
assert.equal(progressEntries.at(-1).note, PROGRESS_NOTE, "the committed progress note is the tool message verbatim");
pass("change record: binding, submission, acknowledgement (before closure), closure, and committed progress");

// The three facts are distinct and all observable.
const inspection = await inspectAmendment({
  stateDir: changeStateDir,
  changeId: CHANGE_ID,
  jobId: JOB_ID,
  amendmentId: "amend-live-1",
  relay: relayHandle,
  eventId: submitted.delivery.eventId,
});
assert.deepEqual(
  inspection.layers,
  { recorded: true, receiverReceiptObserved: true, workerAcknowledged: true },
  "recorded, receiver receipt observed (relay obligation delivered), and worker acknowledgement are three distinct TRUE facts",
);
assert.equal(inspection.transport.status, "delivered", "the receiver acknowledged after a durable session receipt existed");
pass("inspection: recorded / receiverReceiptObserved / workerAcknowledged are distinct and all observed");

// The production wire: the real extension registered the shared search tool and
// the three workflow tools; the fixture's test-only tools are absent.
assert.ok(state.toolsReported, "the provider saw the tool list");
for (const tool of ["zvec_grep_search", "workflow_read_assignment", "workflow_acknowledge_assignment", "workflow_report_progress"]) {
  assert.ok(state.toolsReported.includes(tool), `the provider wire exposes ${tool}`);
}
for (const forbidden of ["fixture_acknowledge_amendment", "fixture_report_progress", "agent_messages"]) {
  assert.ok(!state.toolsReported.includes(forbidden), `the fixture-only tool ${forbidden} is NOT on the production wire`);
}
const injectedEnvelope = state.envelopesSeen.find((eventId) => eventId === submitted.delivery.eventId);
assert.ok(injectedEnvelope, "the pushed amendment envelope reached the real model in the running turn");
pass("production wire: real extension tools only; the pushed envelope reached the model mid-turn");

// The runner's authoritative result reflects the post-update assignment.
const transport = JSON.parse(readFileSync(resultFile, "utf8"));
assert.equal(transport.runnerId, runnerId);
assert.match(transport.response, /updated assignment/, "the final answer reflects the updated assignment, not the stale one");
pass("runner result: the final answer incorporates the amended assignment");

// Return direction: the committed progress note is the only body of the push.
const published = await publishCommittedProgress({
  stateDir: changeStateDir,
  changeId: CHANGE_ID,
  jobId: JOB_ID,
  attemptId: ATTEMPT_ID,
  seq: progressEntries.at(-1).seq,
  relay: relayHandle,
  recipientAgent: `agents/${architectConsumerId}`,
});
assert.equal(published.ok, true);
assert.equal(published.push.status, "queued", "the return-direction push was accepted by the real relay");
let progressDelivery = null;
for (let waited = 0; waited < 20_000 && !progressDelivery; waited += 1000) {
  const result = await architectClient.next({
    consumer_type: "recipient",
    consumer_id: `agents/${architectConsumerId}`,
    generation: 0,
    endpoint_token: `agent-messages/${architectConsumerId}`,
    wait_ms: 1000,
  }).catch(() => null);
  if (result?.delivery) {
    // The delivery document nests the journal record with its envelope:
    // record.envelope.payload.message is the agent message.
    const delivery = result.delivery;
    const record = delivery.record ?? {};
    const message = record?.envelope?.payload?.message ?? {};
    const tasks = Array.isArray(message.tasks) ? message.tasks : [];
    if (tasks.includes(`progress:${progressEntries.at(-1).seq}`)) progressDelivery = { record, message };
    // Acknowledge with the full delivery guard so the obligation settles;
    // a non-matching delivery is acknowledged and the poll continues.
    await architectClient.acknowledge({
      obligation_id: delivery.obligation?.obligation_id,
      event_id: record.event_id,
      consumer_type: delivery.obligation?.consumer_type ?? "recipient",
      consumer_id: delivery.obligation?.consumer_id ?? `agents/${architectConsumerId}`,
      generation: delivery.obligation?.generation ?? 0,
      attempt_token: delivery.attempt_token,
      endpoint_token: delivery.endpoint_token,
      expected_high_water: delivery.guard?.expected_high_water,
      expected_gap_token: delivery.guard?.expected_gap_token,
    }).catch(() => {});
  }
}
assert.ok(progressDelivery, "the architect-side consumer received the pushed progress envelope");
assert.equal(progressDelivery.message.content, PROGRESS_NOTE, "the pushed body is the committed note verbatim - never a reconstruction");
assert.ok(progressDelivery.message.tasks?.includes(`change:${CHANGE_ID}`));
assert.ok(progressDelivery.message.tasks?.includes(`attempt:${ATTEMPT_ID}`));
pass("return direction: the committed progress note rides to the architect consumer with structured tasks");

console.log(`\nworker-communication-live: ${results.length} groups passed.`);
} catch (error) {
  console.error("COMMUNICATION LIVE FAILURE:", error?.message ?? error);
  console.error(error?.stack?.split("\n").slice(0, 12).join("\n") ?? "");
  process.exitCode = 1;
} finally {
  await cleanup("finally");
}

async function cleanup(cause) {
  for (const child of ownedChildren) {
    try { child.kill("SIGKILL"); } catch {}
  }
  try { await relayHandle?.release({ force: true }); } catch {}
  await new Promise((r) => setTimeout(r, 300));
  try { server.closeAllConnections?.(); } catch {}
  try { server.close(); } catch {}
  if (cause === "signal") process.exit(124);
}
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => { void cleanup("signal"); });
}
console.log(`worker-communication-live: TOTAL ${results.length}/${results.length} PASS (artifacts retained under ${root})`);
if (process.exitCode) process.exit(process.exitCode);
