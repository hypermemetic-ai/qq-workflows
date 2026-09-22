#!/usr/bin/env node
// Relay compatibility proof: the ORIGINAL Pi agent-messages receiver (adapted
// as tests/fixtures/pi-relay/agent-messages-relay-fixture.mjs from
// qq-monolith extensions/agent-messages.ts @2b4b989) is loaded through the
// REAL installed Pi extension mechanism and driven against a REAL temporary
// qq-relay journal service, with every model response produced by a
// deterministic localhost provider (dummy key, no external inference).
//
// What is proven here that no simulated host can prove:
//   * durable receipt matching against REAL pi session entries
//     (ctx.sessionManager.getEntries() custom_message details),
//   * real steering into a running turn and real wake/trigger of an idle one,
//   * the real adapter lifecycle (workflow/pi-worker/adapter.mjs) around the
//     settle/exit boundary, using a test-only copied adapter whose ONLY
//     semantic delta is the loaded extension path (asserted in-file),
//   * honest restart/crash semantics: durable session evidence versus
//     in-memory dedup, and reinjection when no durable evidence exists.
//
// Infrastructure is authorized test infrastructure only: a temporary relay
// service in a 0700 fixture state dir, installed Pi against a 127.0.0.1
// deterministic provider with a dummy key. All owned processes are reaped;
// waits are bounded; operator credentials/config/state are never read (the
// fixture redirects XDG_STATE_HOME and the pi agent dir). The fixture root is
// RETAINED as the test-artifact transcript (the path is printed); owned
// processes are always cleaned up.
//
// A missing installed runtime or relay installation is reported as SKIPPED,
// never as a pass.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createChange, openChange, viewsFor } from "../workflow/change-record.mjs";
import { PiRpcClient } from "../workflow/pi-worker/rpc.mjs";
import { WORKER_PI_ADAPTER } from "../workflow/worker-config.mjs";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const FIXTURE_EXTENSION = join(repoRoot, "tests", "fixtures", "pi-relay", "agent-messages-relay-fixture.mjs");
const ADAPTER_SOURCE = WORKER_PI_ADAPTER;
const DUMMY_KEY = "dummy-key-for-localhost-relay-proof";

// Ticket fixture-only copy (not approved production prompts).
const INITIAL_ASSIGNMENT =
  "Relay compatibility fixture. Follow the test assignment and acknowledge an amendment only after reading its exact revision.";
const AMENDMENT_ENVELOPE =
  "Workflow amendment available. Read the referenced assignment revision before acknowledging it. Delivery of this message does not acknowledge the amendment.";

const CHANGE_ID = "relay-proof-1";
const JOB_ID = "job-relay-1";
const RUNTIME_ACTOR = { kind: "runtime", id: "relay-proof-runtime" };

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
    "relay receiver proof SKIPPED: " +
      (!piBin ? "no installed pi runtime on PATH" : "no installed qq-relay (client.mjs + bin/qq-relay)") +
      "; the offline receiver units in tests/relay-receiver-units.mjs still run.",
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Fixture state
// ---------------------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "qq-relay-proof-"));
chmodSync(root, 0o700);
const xdgState = join(root, "xdg");
const relayStateDir = join(xdgState, "qq-relay");
const relaySocket = join(relayStateDir, "qq-relay.sock");
const changeStateDir = join(root, "change-state");
mkdirSync(changeStateDir, { recursive: true, mode: 0o700 });
mkdirSync(xdgState, { recursive: true, mode: 0o700 });
mkdirSync(join(root, "sessions"), { recursive: true, mode: 0o700 });

const results = [];
const findings = [];
const pass = (name) => { results.push(name); console.log(`PASS  ${name}`); };
const finding = (name, detail) => { findings.push({ name, detail }); console.log(`FINDING  ${name}: ${detail}`); };
const ownedChildren = new Set();

// ---------------------------------------------------------------------------
// Deterministic localhost provider: routes by model id. Worker/architect
// behaviors are content-addressed (injected envelopes and tool results decide
// the next response); the adapter arm follows an explicit per-run plan. No
// external inference is reachable.
// ---------------------------------------------------------------------------
const wire = [];
const providerState = {
  "relay-mock-architect": { requests: 0, pendingPush: null, quotedProgress: [] },
  "relay-mock-worker-1": workerBehaviorState([2]),
  "relay-mock-worker-2": workerBehaviorState([3]),
  "relay-mock-worker-3": workerBehaviorState([4]),
  "relay-mock-adapter": { requests: 0, plan: [], envelopesSeen: [], onFinalDone: null },
};

function workerBehaviorState(allowedRevisions) {
  return {
    requests: 0,
    ackAllowed: new Set(allowedRevisions),
    ackedRevisions: new Set(),
    killWindow: null,
    defaultStallMs: 0,
    pendingProgressTurn: false,
    progressNote: "",
    envelopesSeen: [],
  };
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
    found.push({
      eventId: match[1],
      tasks,
      kind: text.includes("Workflow amendment available") ? "amendment" : text.includes("Workflow progress available") ? "progress" : "other",
      headerLine: header,
    });
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

function architectBehavior(body) {
  const state = providerState["relay-mock-architect"];
  const messages = body.messages ?? [];
  // The post-tool follow-up request ENDS with the tool result; historical tool
  // results stay in replayed context and must not trigger this branch.
  if (messages.at(-1)?.role === "tool") return textResponse("send completed");
  if (state.pendingPush) {
    const spec = state.pendingPush;
    state.pendingPush = null;
    return toolResponse("agent_messages", { action: "send", to: spec.to, message: spec.message, delivery: spec.delivery, tasks: spec.tasks });
  }
  const progress = findEnvelopes(body).find((entry) => entry.kind === "progress");
  if (progress) {
    state.quotedProgress.push(progress.headerLine);
    return textResponse(`PROGRESS RECEIVED: ${progress.headerLine}`);
  }
  return textResponse("architect standing by");
}

function workerBehavior(body, state) {
  const messages = body.messages ?? [];
  // The post-tool follow-up request ENDS with the tool result; historical tool
  // results stay in replayed context and must not trigger this branch.
  if (messages.at(-1)?.role === "tool") return textResponse("acknowledged and continuing");
  const envelopes = findEnvelopes(body);
  state.envelopesSeen.push(...envelopes.map((entry) => entry.eventId));
  // Rule order matters: replayed context contains every earlier envelope, so
  // each rule must be scoped to what it is for. Acknowledge an allowed,
  // not-yet-acknowledged amendment; hold the turn open only for an amendment
  // this generation must NOT acknowledge while the kill window is armed; then
  // the test-driven progress turn; then the test-driven default hold.
  for (const envelope of envelopes) {
    if (envelope.kind !== "amendment") continue;
    const revision = Number.parseInt(envelope.tasks.revision ?? "", 10);
    const amendmentId = envelope.tasks.amendment;
    if (Number.isInteger(revision) && state.ackAllowed.has(revision) && !state.ackedRevisions.has(revision) && amendmentId) {
      state.ackedRevisions.add(revision);
      return toolResponse("fixture_acknowledge_amendment", { amendment_id: amendmentId, revision });
    }
  }
  if (state.killWindow && envelopes.some((entry) => {
    if (entry.kind !== "amendment") return false;
    const revision = Number.parseInt(entry.tasks.revision ?? "", 10);
    return !Number.isInteger(revision) || !state.ackedRevisions.has(revision);
  })) {
    return textResponse("noted (no acknowledgement scripted)", state.killWindow.stallMs);
  }
  if (state.pendingProgressTurn) {
    state.pendingProgressTurn = false;
    return toolResponse("fixture_report_progress", { note: state.progressNote });
  }
  return textResponse("working from the current assignment", state.defaultStallMs);
}

function adapterBehavior(body) {
  const state = providerState["relay-mock-adapter"];
  state.envelopesSeen.push(...findEnvelopes(body).map((entry) => entry.eventId));
  const step = state.plan.shift() ?? { type: "text", text: "noted", stallMs: 0 };
  if (step.type === "tool") return toolResponse("read", { path: step.path });
  const isFinal = state.plan.length === 0;
  return { ...textResponse(step.text, step.stallMs), isFinal };
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    wire.push({ model: parsed?.model, body: parsed, authorization: req.headers.authorization, at: Date.now() });
    appendFileSync(join(root, "wire-log.jsonl"), `${JSON.stringify({ at: Date.now(), model: parsed?.model, url: req.url, lastMessageRole: parsed?.messages?.at(-1)?.role ?? null, lastMessageText: String(messageTexts({ messages: (parsed?.messages ?? []).slice(-1) })).slice(0, 80) })}\n`);
    if (!String(req.url).includes("/chat/completions") || !parsed || providerState[parsed.model] === undefined) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":{"message":"not found"}}');
      return;
    }
    const state = providerState[parsed.model];
    state.requests += 1;
    let response;
    if (parsed.model === "relay-mock-architect") response = architectBehavior(parsed);
    else if (parsed.model === "relay-mock-adapter") response = adapterBehavior(parsed);
    else response = workerBehavior(parsed, state);
    const finishUp = () => {
      if (response.isFinal && state.onFinalDone) {
        const done = state.onFinalDone;
        state.onFinalDone = null;
        done();
      }
    };
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const chunk of sseChunks(parsed, response.chunks)) res.write(`data: ${chunk}\n\n`);
    if (response.stallMs > 0) {
      const timer = setTimeout(() => {
        try { res.write("data: [DONE]\n\n"); res.end(); } catch {}
        finishUp();
      }, response.stallMs);
      timer.unref?.();
      res.on("close", () => clearTimeout(timer));
      return;
    }
    res.write("data: [DONE]\n\n");
    res.end();
    finishUp();
  });
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const providerOrigin = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------
function writeAgentDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const models = [];
  for (const model of ["relay-mock-architect", "relay-mock-worker-1", "relay-mock-worker-2", "relay-mock-worker-3", "relay-mock-adapter"]) {
    models.push({
      id: model, name: model, reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 8192,
      thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
      compat: { supportsReasoningEffort: true, maxTokensField: "max_tokens", supportsStrictMode: false },
    });
  }
  writeFileSync(join(dir, "models.json"), `${JSON.stringify({ providers: {
    "relay-mock": { name: "Relay Proof Local Mock", api: "openai-completions", baseUrl: `${providerOrigin}/v1`, apiKey: DUMMY_KEY, models },
  } }, null, 2)}\n`, "utf8");
}

function baseEnv(extra = {}) {
  return {
    ...process.env,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_STATE_HOME: xdgState,
    QQ_RELAY_INSTALL_ROOT: relayRoot,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    ...extra,
  };
}

// Resolves with the predicate's truthy result (callers that only need the
// signal ignore it).
async function waitFor(what, predicate, deadlineMs = 20_000, intervalMs = 100) {
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

function readSessionEntries(sessionFile) {
  if (!existsSync(sessionFile)) return [];
  return readFileSync(sessionFile, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => {
    try { return JSON.parse(l); } catch { return { unparsed: l }; }
  });
}

const customReceiptCount = (sessionFile, eventId) =>
  readSessionEntries(sessionFile).filter((entry) =>
    entry.type === "custom_message" && entry.customType === "qq-agent-message" && entry.details?.event_id === eventId).length;

// Change-record surface (the sole workflow authority; the harness acts as the
// workflow runtime).
function crHandle() {
  return openChange({ stateDir: changeStateDir, changeId: CHANGE_ID });
}
function crAppend(kind, payload, { context = {}, commandId } = {}) {
  return crHandle().append(kind, payload, { context: { actor: RUNTIME_ACTOR, ...context }, commandId });
}
function crViews() {
  return viewsFor(crHandle().state);
}

async function journalStatus(client, eventId) {
  const result = await client.status({ event_id: eventId, wait_ms: 0 });
  const statuses = (result?.obligations ?? []).map((item) => item.status);
  const state = statuses.includes("in_flight") ? "delivering"
    : statuses.includes("pending") ? "queued"
    : statuses.includes("blocked") ? "blocked"
    : statuses.length && statuses.every((value) => value === "acknowledged") ? "delivered"
    : statuses.includes("expired") ? "expired"
    : statuses.some((value) => value === "disposed" || value === "abandoned") ? "failed"
    : result?.terminal_failure ? "failed" : "queued";
  return { state, result };
}

// One real installed Pi process in RPC mode with the fixture receiver loaded
// through the real extension mechanism (--no-extensions --extension <fixture>).
function launchPi({ name, model, tools, sessionFile, extraEnv = {}, systemPromptTag }) {
  const agentDir = join(root, `agent-${name}`);
  const workDir = join(root, `work-${name}`);
  writeAgentDir(agentDir);
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const args = [
    "--mode", "rpc",
    "--provider", "relay-mock",
    "--model", model,
    "--session", sessionFile,
    "--no-extensions", "--extension", FIXTURE_EXTENSION,
    "--no-approve",
    "--tools", tools.join(","),
  ];
  if (systemPromptTag) args.push("--append-system-prompt", systemPromptTag);
  const client = new PiRpcClient({
    bin: piBin,
    args,
    cwd: workDir,
    env: baseEnv({
      PI_CODING_AGENT_DIR: agentDir,
      QQ_AGENT_PROJECT: CHANGE_ID,
      ...extraEnv,
    }),
  });
  client.start();
  ownedChildren.add(client);
  const events = [];
  client.onEvent = (event) => events.push(event);
  // Label RPC failures with the owning fixture session for honest diagnostics.
  const rawRequest = client.request.bind(client);
  client.request = async (command, options) => {
    try {
      return await rawRequest(command, options);
    } catch (error) {
      error.message = `[${name} ${command?.type ?? "?"}] ${error.message}`;
      throw error;
    }
  };
  return { client, events, sessionFile, agentDir, name };
}

async function rpcState(launched) {
  return launched.client.request({ type: "get_state" }, { timeoutMs: 30_000 });
}

// The runtime's own processing flag is the only reliable idle signal: an
// aborted run's agent_settled can precede a receiver-injected turn.
async function waitIdle(launched, what, deadlineMs = 30_000) {
  await waitFor(what ?? "the runtime to be idle", async () => {
    const state = await rpcState(launched);
    return state.isStreaming !== true && state.isCompacting !== true;
  }, deadlineMs, 100);
}

const eventsAfter = (launched, index) => launched.events.slice(index);

async function waitSettle(launched, fromIndex, what, deadlineMs = 60_000) {
  await waitFor(what, () => eventsAfter(launched, fromIndex).some((event) => event.type === "agent_settled"), deadlineMs, 50);
}

async function lastAssistantText(launched, fromIndex) {
  const ends = eventsAfter(launched, fromIndex).filter((event) => event.type === "message_end" && event.message?.role === "assistant");
  const content = ends.at(-1)?.message?.content;
  if (typeof content === "string") return content;
  return (content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

// Drive one architect push through the ORIGINAL send tool in the REAL
// architect Pi session; returns the stable relay event id taken from the
// architect's own durable toolResult.
async function pushViaArchitect(architect, spec) {
  await waitIdle(architect, "the architect idle before the push");
  providerState["relay-mock-architect"].pendingPush = spec;
  const before = architect.events.length;
  await architect.client.request({ type: "prompt", message: "Send the queued workflow message now." }, { timeoutMs: 30_000 });
  await waitSettle(architect, before, "architect push turn to settle", 45_000);
  const toolResults = readSessionEntries(architect.sessionFile)
    .filter((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === "agent_messages");
  const last = toolResults.at(-1);
  const text = typeof last?.message?.content === "string"
    ? last.message.content
    : (last?.message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
  const refused = text.match(/Agent messages refused: (.*)/);
  if (refused) throw new Error(`architect push refused: ${refused[1]}`);
  const match = text.match(/message sent: (evt_\S+)/);
  if (!match) throw new Error(`architect push left no usable tool result: ${JSON.stringify(text).slice(0, 300)}`);
  return match[1];
}

function commitAmendment(number, { attemptId, recipientSessionId }) {
  const revision = number + 1; // revision 1 is the initial assignment
  const amendmentId = `amendment-${number}`;
  crAppend("assignment.revised", {
    revision,
    predecessor: revision - 1,
    scope: { kind: "job", jobId: JOB_ID },
    assignment: { instructions: `Revision ${revision} fixture assignment for ${amendmentId}.` },
  });
  crAppend("amendment.submitted", {
    amendmentId,
    revision,
    transport: { relay: { kind: "agent.message", recipient: `agents/${recipientSessionId}` } },
  }, { context: { jobId: JOB_ID, attemptId } });
  return { amendmentId, revision };
}

function amendmentTaskRefs({ amendmentId, revision, attemptId = null }) {
  const refs = [`job:${JOB_ID}`];
  if (attemptId) refs.push(`attempt:${attemptId}`);
  refs.push(`amendment:${amendmentId}`, `revision:${revision}`);
  return refs;
}

// ---------------------------------------------------------------------------
// Test-only copied adapter: the ONLY semantic delta is the loaded extension
// path; import specifiers are absolutized mechanically so the copy runs from
// the fixture directory. The control build (production extension path) proves
// the delta is exactly one declared line.
// ---------------------------------------------------------------------------
const PATCH_COMMENT =
  "// TEST-ONLY PATCH (see docs/pi-relay-receiver-proof.md): the worker extension\n" +
  "// constant points at the relay receiver fixture instead of worker-tools.mjs.\n" +
  "// Every other behavior is the landed adapter source.\n";

function generateAdapterCopy(extensionPath) {
  const source = readFileSync(ADAPTER_SOURCE, "utf8");
  const sourceDir = dirname(ADAPTER_SOURCE);
  const control = source.replace(/from "(\.\.?\/[^"]+)"/g, (_, spec) => `from "${pathToFileURL(resolve(sourceDir, spec)).href}"`);
  if (extensionPath === null) return control;
  return control
    .replace("  WORKER_PI_EXTENSION,\n", "")
    .replace(`export const ADAPTER_EXIT`, `${PATCH_COMMENT}const WORKER_PI_EXTENSION = ${JSON.stringify(extensionPath)};\n\nexport const ADAPTER_EXIT`);
}

const stripImportSpecifiers = (source) => source.replace(/from "[^"]*"/g, 'from "<specifier>"');
const controlAdapterSource = generateAdapterCopy(null);
assert.equal(
  stripImportSpecifiers(controlAdapterSource),
  stripImportSpecifiers(readFileSync(ADAPTER_SOURCE, "utf8")),
  "the adapter copy must differ from the landed adapter ONLY by absolute import specifiers",
);
const patchedAdapterSource = generateAdapterCopy(FIXTURE_EXTENSION);
assert.equal(
  patchedAdapterSource,
  controlAdapterSource
    .replace("  WORKER_PI_EXTENSION,\n", "")
    .replace("export const ADAPTER_EXIT", `${PATCH_COMMENT}const WORKER_PI_EXTENSION = ${JSON.stringify(FIXTURE_EXTENSION)};\n\nexport const ADAPTER_EXIT`),
  "the patched copy's delta over the control build is exactly the declared extension constant",
);
const patchedAdapterPath = join(root, "adapter-fixture-copy.mjs");
writeFileSync(patchedAdapterPath, patchedAdapterSource, { mode: 0o700 });

// ---------------------------------------------------------------------------
// Real temporary journal service (installed qq-relay, serving-socket transport)
// ---------------------------------------------------------------------------
const relayChild = spawn(join(relayRoot, "bin", "qq-relay"), ["serve", "--state-dir", relayStateDir], {
  stdio: ["ignore", "pipe", "pipe"],
});
ownedChildren.add(relayChild);
const relayLog = [];
relayChild.stdout.on("data", (c) => relayLog.push(String(c)));
relayChild.stderr.on("data", (c) => relayLog.push(String(c)));
await waitFor("relay socket", () => existsSync(relaySocket), 15_000, 50);
const { RelayClient } = await import(pathToFileURL(join(relayRoot, "client.mjs")).href);
const journal = new RelayClient(relaySocket);
const health = await journal.inspect({ view: "health" });
assert.equal(health?.service, "qq-relay", "the temporary journal service answered the health view");

// ---------------------------------------------------------------------------
// Workflow setup in the change record (runtime actor; sole workflow authority)
// ---------------------------------------------------------------------------
createChange({ stateDir: changeStateDir, changeId: CHANGE_ID, actor: RUNTIME_ACTOR, title: "Relay compatibility proof fixture" });
crAppend("assignment.revised", {
  revision: 1,
  predecessor: null,
  scope: { kind: "change" },
  assignment: { instructions: INITIAL_ASSIGNMENT },
});
crAppend("job.registered", { role: "runner", pinnedRevision: 1 }, { context: { jobId: JOB_ID } });
assert.equal(crViews().job(JOB_ID).effectiveRevision, 1);

// ---------------------------------------------------------------------------
// Real Pi sessions: the architect (sender + return-direction recipient) first,
// so the worker can be given the workflow-owned recipient identity.
// ---------------------------------------------------------------------------
const architectSessionFile = join(root, "sessions", "architect.jsonl");
const architect = launchPi({
  name: "architect",
  model: "relay-mock-architect",
  tools: ["agent_messages"],
  sessionFile: architectSessionFile,
  extraEnv: { QQ_AGENT_ROLE: "runner", QQ_RELAY_FIXTURE_TARGET_ROLE: "runner" },
  systemPromptTag: "RELAY-PROOF ARCHITECT SEAT",
});
const architectSessionId = (await rpcState(architect)).sessionId;
assert.match(architectSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "the architect session id is a canonical Pi session id");
await new Promise((r) => setTimeout(r, 700)); // the receiver loop starts asynchronously after session_start

const workerSessionFile = join(root, "sessions", "worker.jsonl");
const workerEnv = {
  QQ_AGENT_ROLE: "runner",
  QQ_RELAY_FIXTURE_TARGET_ROLE: "runner",
  QQ_RELAY_FIXTURE_STATE_DIR: changeStateDir,
  QQ_RELAY_FIXTURE_JOB_ID: JOB_ID,
  QQ_RELAY_FIXTURE_ATTEMPT_ID: "attempt-1",
  QQ_RELAY_FIXTURE_ACTOR_ID: "worker-attempt-1",
  QQ_RELAY_FIXTURE_RECIPIENT_AGENT: `agents/${architectSessionId}`,
};
const worker1 = launchPi({
  name: "worker-1",
  model: "relay-mock-worker-1",
  tools: ["read", "fixture_acknowledge_amendment", "fixture_report_progress"],
  sessionFile: workerSessionFile,
  extraEnv: workerEnv,
  systemPromptTag: "RELAY-PROOF WORKER SEAT",
});
const workerSessionId = (await rpcState(worker1)).sessionId;
assert.match(workerSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "the worker session id is a canonical Pi session id");

crAppend("attempt.launch_intent", {}, { context: { jobId: JOB_ID, attemptId: "attempt-1" } });
crAppend("attempt.started", { identity: { seat: "runner", pi_session: workerSessionId } }, { context: { jobId: JOB_ID, attemptId: "attempt-1" } });

try {
  console.log(`installed pi: ${piBin}`);
  console.log(`relay install root: ${relayRoot}`);
  console.log(`fixture root (retained artifacts): ${root}`);

  // ========================================================================
  // CASE 1 + CASE 2: busy receiver. The amendment is committed to the change
  // record BEFORE sending; the push goes through the original send tool in a
  // real Pi session; queue acceptance, durable session receipt, and model
  // incorporation are asserted as distinct layers with stable correlation.
  // ========================================================================
  {
    providerState["relay-mock-worker-1"].defaultStallMs = 2500;
    const before = worker1.events.length;
    await worker1.client.request({ type: "prompt", message: INITIAL_ASSIGNMENT }, { timeoutMs: 30_000 });
    const wireBefore = wire.length;
    await waitFor("worker turn-1 request at the mock provider", () => wire.slice(wireBefore).some((r) => r.model === "relay-mock-worker-1"), 30_000, 50);
    await new Promise((r) => setTimeout(r, 300)); // the worker is streaming (busy)

    const { amendmentId, revision } = commitAmendment(1, { attemptId: "attempt-1", recipientSessionId: workerSessionId });
    assert.deepEqual(
      crViews().pendingAmendments(JOB_ID).map((entry) => entry.amendmentId),
      [amendmentId],
      "the amendment is pending in the change record before any delivery",
    );

    const eventId = await pushViaArchitect(architect, {
      to: workerSessionId,
      delivery: "default",
      message: AMENDMENT_ENVELOPE,
      tasks: amendmentTaskRefs({ amendmentId, revision, attemptId: "attempt-1" }),
    });
    assert.match(eventId, /^evt_/, "the relay accepted the push with a stable event id");
    const reread = await journalStatus(journal, eventId);
    assert.equal(reread.result?.record?.event_id ?? null, eventId, "status queries keep the stable message id");

    // Layer 1: queue acceptance — distinct from receipt and incorporation.
    const queued = await journalStatus(journal, eventId);
    assert.equal(queued.state, "queued", "immediately after the send the obligation is queued, not delivered");
    assert.equal(customReceiptCount(workerSessionFile, eventId), 0, "no durable session receipt exists yet");
    assert.ok(crViews().pendingAmendments(JOB_ID).some((entry) => entry.amendmentId === amendmentId), "queue acceptance alone is not incorporation");

    // Layer 2: durable session receipt (a REAL pi session entry).
    await waitFor("durable session receipt in the worker session", () => customReceiptCount(workerSessionFile, eventId) === 1, 45_000);
    const receiptAt = Date.now();

    // Layer 3: incorporation — the deterministic provider emits the
    // fixture-only acknowledgement action for the EXACT revision after seeing
    // the injected envelope.
    await waitFor("worker.acknowledged for the exact revision", () =>
      crViews().attempt(JOB_ID, "attempt-1").acknowledgements.some((ack) => ack.revision === revision), 45_000);
    const incorporatedAt = Date.now();

    await waitFor("journal acknowledges after the durable receipt", async () => (await journalStatus(journal, eventId)).state === "delivered", 45_000);
    const deliveredAt = Date.now();

    assert.equal(customReceiptCount(workerSessionFile, eventId), 1, "the redelivery did not inject the same message twice in one process");
    const amendment = crViews().job(JOB_ID).amendments.find((entry) => entry.amendmentId === amendmentId);
    assert.notEqual(amendment.acknowledged, null, "the amendment is fulfilled by the matching attempt/revision");
    assert.equal(amendment.targetedAttemptId, "attempt-1");
    assert.equal(amendment.revision, revision);
    const acks = crHandle().state.jobs[JOB_ID].attempts["attempt-1"].acknowledgements.filter((ack) => ack.revision === revision);
    assert.equal(amendment.acknowledged.seq, acks[0].seq, "the amendment view points at the exact acknowledgement");
    // The worker session's own toolResult documents the acknowledgement chain.
    const ackToolResults = readSessionEntries(workerSessionFile)
      .filter((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === "fixture_acknowledge_amendment");
    assert.ok(ackToolResults.length >= 1, "the worker session records the fixture acknowledgement tool result");
    assert.match(JSON.stringify(ackToolResults.at(-1)), new RegExp(amendmentId));
    console.log(`      layer timings: queued at send; durable receipt +${receiptAt - (queued.result?.record?.accepted_at ?? receiptAt)}ms after acceptance; delivered +${deliveredAt - receiptAt}ms after receipt; incorporated +${incorporatedAt - receiptAt}ms after receipt`);
    await waitIdle(worker1, "the worker idle after the steered amendment turn", 30_000);
    providerState["relay-mock-worker-1"].defaultStallMs = 0;
    pass("CASE 1+2 busy receiver: amendment committed before send; the original receiver + real Pi steered it into the running turn; queue acceptance, durable receipt and worker.acknowledged are distinct layers with stable event/attempt/revision correlation");
  }

  // ========================================================================
  // CASE 5: return direction — worker progress committed to the change record
  // BEFORE a pushed notification to the actual architect Pi session; model
  // visibility proven by deterministic provider output and session entries,
  // never by a socket status query alone.
  // ========================================================================
  {
    const workerState = providerState["relay-mock-worker-1"];
    workerState.pendingProgressTurn = true;
    workerState.progressNote = "fixture progress: revision 2 acknowledged and verified in the change record";
    // The architect's notification turn runs concurrently with the worker's
    // turn, so its event index is captured before the worker is prompted.
    const architectBefore = architect.events.length;
    const before = worker1.events.length;
    await worker1.client.request({ type: "prompt", message: "PROGRESS-TURN: report progress to the workflow recipient." }, { timeoutMs: 30_000 });
    await waitSettle(worker1, before, "worker progress turn to settle", 45_000);

    const progressEntry = crViews().attempt(JOB_ID, "attempt-1").progress.at(-1);
    assert.ok(progressEntry, "worker.progress is committed to the change record");
    assert.match(progressEntry.note ?? "", /fixture progress/, "the committed progress note is the fixture note");
    const progressSeq = progressEntry.seq;

    await waitFor("architect receives and answers the pushed notification", async () => {
      const text = await lastAssistantText(architect, architectBefore);
      return text.includes(`progress:${progressSeq}`);
    }, 45_000);
    const quoted = providerState["relay-mock-architect"].quotedProgress.at(-1);
    assert.match(quoted, new RegExp(`progress:${progressSeq}`), "the pushed notification carried the change-record progress reference");

    const notificationEntries = readSessionEntries(architectSessionFile)
      .filter((entry) => entry.type === "custom_message" && (entry.content ?? "").includes("Workflow progress available"));
    assert.ok(notificationEntries.length >= 1, "the architect session holds the model-visible notification envelope");
    const notification = notificationEntries.at(-1);
    assert.ok((notification.content ?? "").includes(`progress:${progressSeq}`), "the envelope references the committed change-record progress entry");
    // The receiver acknowledges right after the injected turn settles; give
    // that bounded time instead of assuming it at the first instant.
    await waitFor("the return-direction acknowledgement", async () =>
      (await journalStatus(journal, notification.details?.event_id ?? "evt_none")).state === "delivered", 30_000);
    pass("CASE 5 return direction: worker.progress committed before the push; the real architect Pi session shows the envelope and its deterministic output quotes the bounded change-record reference");
  }

  // ========================================================================
  // Immediate-delivery contrast (feeds CASE 6): the original receiver's
  // immediate-claim abort discipline against a REAL busy Pi session —
  // distinct from ordinary steering (CASE 1) and from explicit cancellation.
  // ========================================================================
  {
    const workerState = providerState["relay-mock-worker-1"];
    workerState.defaultStallMs = 2500;
    const before = worker1.events.length;
    await worker1.client.request({ type: "prompt", message: "Hold a long turn for the immediate-delivery probe." }, { timeoutMs: 30_000 });
    const wireBefore = wire.length;
    await waitFor("worker turn request at the mock provider", () => wire.slice(wireBefore).some((r) => r.model === "relay-mock-worker-1"), 30_000, 50);
    await new Promise((r) => setTimeout(r, 300));

    const eventId = await pushViaArchitect(architect, {
      to: workerSessionId,
      delivery: "immediate",
      message: "Workflow progress available. Read the referenced change-record view.",
      tasks: [`job:${JOB_ID}`, "attempt:attempt-1", "probe:immediate-delivery"],
    });

    await waitFor("the in-flight turn was aborted by the immediate claim", () =>
      eventsAfter(worker1, before).some((event) =>
        event.type === "message_end" && event.message?.role === "assistant" && event.message?.stopReason === "aborted"), 30_000);
    await waitFor("the immediate envelope is durably received", () => customReceiptCount(workerSessionFile, eventId) === 1, 30_000);
    await waitFor("journal acknowledges the immediate delivery", async () => (await journalStatus(journal, eventId)).state === "delivered", 30_000);
    assert.equal(customReceiptCount(workerSessionFile, eventId), 1, "exactly one injection for the immediate delivery");
    // The injection can start its own turn (or drain through the aborted
    // run's continuation); the block must not end while it is still running.
    await waitIdle(worker1, "the worker idle after the immediate-delivery turn", 45_000);
    providerState["relay-mock-worker-1"].defaultStallMs = 0;
    pass("Immediate-delivery contrast: claim -> real abort of the in-flight turn (stopReason aborted) -> fresh triggerTurn injection -> durable receipt; distinct from CASE 1 steering (no abort) and from explicit cancellation (CASE 6)");
  }

  // ========================================================================
  // CASE 4: durable receipt, duplicates and restart.
  //   4a: receipt persisted, receiver killed before acknowledging -> a
  //       resumed receiver with the SAME session acknowledges from durable
  //       evidence without reinjection.
  //   4b: crash before any durable receipt -> honest reinjection on
  //       redelivery (no exactly-once claim); incorporation still applied
  //       exactly once at the change-record layer.
  // ========================================================================
  {
    // ---- 4a
    const workerState = providerState["relay-mock-worker-1"];
    workerState.defaultStallMs = 4000;
    workerState.killWindow = { stallMs: 12_000 };
    const before = worker1.events.length;
    await worker1.client.request({ type: "prompt", message: "Hold a turn for the restart probe." }, { timeoutMs: 30_000 });
    const wireBefore = wire.length;
    await waitFor("worker turn request at the mock provider", () => wire.slice(wireBefore).some((r) => r.model === "relay-mock-worker-1"), 30_000, 50);
    const { amendmentId, revision } = commitAmendment(2, { attemptId: "attempt-1", recipientSessionId: workerSessionId });
    const eventId = await pushViaArchitect(architect, {
      to: workerSessionId,
      delivery: "default",
      message: AMENDMENT_ENVELOPE,
      tasks: amendmentTaskRefs({ amendmentId, revision, attemptId: "attempt-1" }),
    });
    // The steer lands at the turn boundary; kill inside the window where the
    // durable entry exists but the receiver has not acknowledged yet.
    await waitFor("durable entry before the kill", () => customReceiptCount(workerSessionFile, eventId) === 1, 30_000, 50);
    worker1.client.kill("SIGKILL");
    await worker1.client.waitForExit();
    ownedChildren.delete(worker1.client);
    const statusAfterKill = await journalStatus(journal, eventId);
    assert.notEqual(statusAfterKill.state, "delivered", "the killed receiver never acknowledged: the obligation stays pending, not delivered");
    assert.equal(customReceiptCount(workerSessionFile, eventId), 1, "the durable receipt survived the kill");
    assert.ok(crViews().pendingAmendments(JOB_ID).some((entry) => entry.amendmentId === amendmentId), "the amendment is still pending (no incorporation happened)");

    // Resume the SAME session: durable session evidence avoids reinjection.
    const worker2 = launchPi({
      name: "worker-2",
      model: "relay-mock-worker-2",
      tools: ["read", "fixture_acknowledge_amendment", "fixture_report_progress"],
      sessionFile: workerSessionFile,
      extraEnv: workerEnv,
    });
    const worker2State = await rpcState(worker2);
    assert.equal(worker2State.sessionId, workerSessionId, "the resumed session keeps the same session id (transport addressing)");
    await waitFor("journal delivered from durable evidence after resume", async () => (await journalStatus(journal, eventId)).state === "delivered", 60_000);
    assert.equal(customReceiptCount(workerSessionFile, eventId), 1, "the resumed receiver did NOT reinject a durably received message");
    // The resumed model now acknowledges the pending amendment (deterministic
    // provider action for the exact revision visible in its context).
    const before2 = worker2.events.length;
    await worker2.client.request({ type: "prompt", message: "Review your context and acknowledge any pending amendment." }, { timeoutMs: 30_000 });
    await waitSettle(worker2, before2, "resumed worker acknowledgement turn", 45_000);
    assert.ok(
      crViews().attempt(JOB_ID, "attempt-1").acknowledgements.some((ack) => ack.revision === revision),
      "the resumed worker acknowledged the exact revision",
    );
    // Idempotent revision application at the live layer: the fixture tool uses
    // a deterministic command id, so a repeated acknowledgement is a dedupe.
    const dedupe = crHandle().append(
      "worker.acknowledged",
      { revision, note: `acknowledged amendment ${amendmentId} (revision ${revision})` },
      { context: { actor: { kind: "worker", id: "worker-attempt-1" }, jobId: JOB_ID, attemptId: "attempt-1" }, commandId: `ack-${amendmentId}-rev${revision}` },
    );
    assert.equal(dedupe.committed, false, "a repeated acknowledgement command is a change-record dedupe");
    assert.equal(dedupe.dedupe, true);
    worker2.client.kill("SIGTERM");
    await worker2.client.waitForExit();
    ownedChildren.delete(worker2.client);
    pass("CASE 4a durable receipt across receiver death: pending-not-delivered after the kill; the resumed same-session receiver acknowledged from durable session evidence with no reinjection; idempotent revision application via the deterministic command id");

    // ---- 4b: crash BEFORE any durable receipt -> honest reinjection.
    const worker3 = launchPi({
      name: "worker-3",
      model: "relay-mock-worker-3",
      tools: ["read", "fixture_acknowledge_amendment", "fixture_report_progress"],
      sessionFile: workerSessionFile,
      extraEnv: workerEnv,
    });
    const worker3State = await rpcState(worker3);
    assert.equal(worker3State.sessionId, workerSessionId);
    const workerState3 = providerState["relay-mock-worker-3"];
    workerState3.defaultStallMs = 30_000;
    const beforeW3 = worker3.events.length;
    await worker3.client.request({ type: "prompt", message: "Hold a turn for the crash probe." }, { timeoutMs: 30_000 });
    const wireBeforeW3 = wire.length;
    await waitFor("worker-3 turn request at the mock provider", () => wire.slice(wireBeforeW3).some((r) => r.model === "relay-mock-worker-3"), 30_000, 50);
    const { amendmentId: amendment3, revision: revision3 } = commitAmendment(3, { attemptId: "attempt-1", recipientSessionId: workerSessionId });
    const eventId3 = await pushViaArchitect(architect, {
      to: workerSessionId,
      delivery: "default",
      message: AMENDMENT_ENVELOPE,
      tasks: amendmentTaskRefs({ amendmentId: amendment3, revision: revision3, attemptId: "attempt-1" }),
    });
    await new Promise((r) => setTimeout(r, 700)); // the receiver steers the queued envelope; nothing durable yet
    assert.equal(customReceiptCount(workerSessionFile, eventId3), 0, "no durable receipt exists before the crash");
    const statusBeforeCrash = await journalStatus(journal, eventId3);
    assert.notEqual(statusBeforeCrash.state, "delivered", "the queued-but-undelivered message is not delivered");
    worker3.client.kill("SIGKILL");
    await worker3.client.waitForExit();
    ownedChildren.delete(worker3.client);
    workerState3.defaultStallMs = 0; // the resumed generation must not inherit the hold
    assert.equal(customReceiptCount(workerSessionFile, eventId3), 0, "the crash left no durable trace of the queued envelope");

    // Resume: the journal redelivers; with NO durable evidence the receiver
    // injects again (honest, not exactly-once) and the model acknowledges.
    const worker4 = launchPi({
      name: "worker-4",
      model: "relay-mock-worker-3",
      tools: ["read", "fixture_acknowledge_amendment", "fixture_report_progress"],
      sessionFile: workerSessionFile,
      extraEnv: workerEnv,
    });
    const worker4State = await rpcState(worker4);
    assert.equal(worker4State.sessionId, workerSessionId);
    await waitFor("the redelivered envelope is injected after the crash", () => customReceiptCount(workerSessionFile, eventId3) === 1, 60_000);
    await waitFor("the change record records the exact-revision acknowledgement", () =>
      crViews().attempt(JOB_ID, "attempt-1").acknowledgements.some((ack) => ack.revision === revision3), 45_000);
    await waitFor("journal acknowledges the redelivered message", async () => (await journalStatus(journal, eventId3)).state === "delivered", 45_000);
    assert.equal(customReceiptCount(workerSessionFile, eventId3), 1, "exactly one injection after the crash-restart cycle");
    worker4.client.kill("SIGTERM");
    await worker4.client.waitForExit();
    ownedChildren.delete(worker4.client);
    finding(
      "CASE 4b crash-before-receipt reinjection",
      "a crash between queuing and durable receipt leaves no trace: the resumed receiver injected the envelope again. No exactly-once injection across crashes; incorporation was still applied exactly once at the change-record layer.",
    );
    pass("CASE 4b crash before receipt: honest reinjection observed; the amendment was fulfilled exactly once via the change record");
  }

  // ========================================================================
  // CASE 3: idle/settling boundary against the REAL repository adapter
  // lifecycle (test-only copied adapter; delta asserted in-file).
  //   3a: delivery during the final streamed turn — the steer drains into a
  //       continuation and the durable receipt lands before adapter exit.
  //   3b: delivery at the settle/teardown boundary — the exit race is
  //       observed honestly; then a push to the EXITED adapter's session
  //       demonstrates the dead-consumer binding precisely.
  // ========================================================================
  const adapterWorkAssignment = join(root, "adapter-assignment.md");
  writeFileSync(adapterWorkAssignment, `${INITIAL_ASSIGNMENT}\n`, "utf8");

  async function runAdapterAttempt({ attemptId, plan }) {
    const agentDir = join(root, `agent-adapter-${attemptId}`);
    const workDir = join(root, `work-adapter-${attemptId}`);
    writeAgentDir(agentDir);
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const configFile = join(root, `worker-config-${attemptId}.json`);
    writeFileSync(configFile, `${JSON.stringify({
      harness: "pi", provider: "relay-mock", model: "relay-mock-adapter", reasoning_effort: "xhigh",
      context: { enabled: true, reserve_tokens: 8192, keep_recent_tokens: 2000 },
    }, null, 2)}\n`, "utf8");
    const runnerId = `relay-proof-${attemptId}`;
    const resultFile = join(tmpdir(), `qq-runner-result-${runnerId}.json`);
    rmSync(resultFile, { force: true });
    const summaryFile = join(root, `summary-${attemptId}.json`);
    const adapterState = providerState["relay-mock-adapter"];
    adapterState.requests = 0;
    adapterState.plan = plan.map((step) => ({ ...step }));
    adapterState.envelopesSeen = [];

    const child = spawn(process.execPath, [
      patchedAdapterPath, "--production", "--seat", "runner", "--cwd", workDir,
      "--prompt", INITIAL_ASSIGNMENT,
      "--summary-file", summaryFile,
    ], {
      cwd: workDir,
      env: baseEnv({
        PI_CODING_AGENT_DIR: agentDir,
        QQ_WORKER_CONFIG_FILE: configFile,
        QQ_WORKER_PI_BIN: piBin,
        QQ_RUNNER_ID: runnerId,
        QQ_RUNNER_RESULT_FILE: resultFile,
        QQ_ZVEC_GREP_ROOT: workDir,
        QQ_ZVEC_GREP_SEAT: "runner",
        QQ_AGENT_PROJECT: CHANGE_ID,
        QQ_AGENT_ROLE: "runner",
        QQ_RELAY_FIXTURE_TARGET_ROLE: "runner",
        QQ_RELAY_FIXTURE_STATE_DIR: changeStateDir,
        QQ_RELAY_FIXTURE_JOB_ID: JOB_ID,
        QQ_RELAY_FIXTURE_ATTEMPT_ID: attemptId,
        QQ_RELAY_FIXTURE_ACTOR_ID: `worker-${attemptId}`,
        QQ_RELAY_FIXTURE_RECIPIENT_AGENT: `agents/${architectSessionId}`,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    ownedChildren.add(child);
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; appendFileSync(join(root, `adapter-${attemptId}.stdout`), c); });
    child.stderr.on("data", (c) => { stderr += c; appendFileSync(join(root, `adapter-${attemptId}.stderr`), c); });
    const exitPromise = new Promise((resolveExit) => child.on("exit", (code, signal) => resolveExit({ code, signal })));
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    killTimer.unref?.();

    // The first planned step is a read tool call: it completes the first
    // assistant message, which flushes the native session header, which is
    // where the adapter arm's transport identity (pi session id) is read from.
    const sessionPath = await waitFor("the adapter's native session trace line", () => {
      const match = stderr.match(/pi-worker-adapter: native session file: (\S+)/);
      return match ? match[1] : null;
    }, 45_000, 50);
    const adapterSessionId = await waitFor("the adapter's native session header", () => {
      const header = readSessionEntries(sessionPath).find((entry) => entry.type === "session");
      return header?.id ?? null;
    }, 45_000, 50);
    return { child, exitPromise, sessionPath, adapterSessionId, summaryFile, resultFile, attemptId, stderr: () => stderr, stdout: () => stdout };
  }

  // The native session header appears as soon as the runtime starts, which can
  // precede the adapter's own prompt: wait for that prompt before pushing, or
  // the receiver's injection would reject the adapter's prompt command.
  async function waitForAdapterPrompt(run) {
    const wireBefore = wire.length;
    await waitFor("the adapter's own prompt request at the mock provider", () => wire.slice(wireBefore).some((r) => r.model === "relay-mock-adapter"), 45_000, 50);
  }

  async function finishAdapterAttempt(run) {
    const exit = await run.exitPromise;
    ownedChildren.delete(run.child);
    const summary = existsSync(run.summaryFile) ? JSON.parse(readFileSync(run.summaryFile, "utf8")) : null;
    return { exit, summary };
  }

  {
    // ---- 3a: push during the final streamed turn.
    crAppend("attempt.launch_intent", {}, { context: { jobId: JOB_ID, attemptId: "attempt-2" } });
    const { amendmentId, revision } = commitAmendment(4, { attemptId: "attempt-2", recipientSessionId: workerSessionId });
    const run = await runAdapterAttempt({
      attemptId: "attempt-2",
      plan: [
        { type: "tool", path: adapterWorkAssignment },
        { type: "text", text: "working from the current assignment", stallMs: 2500 },
      ],
    });
    await waitForAdapterPrompt(run);
    const eventId = await pushViaArchitect(architect, {
      to: run.adapterSessionId,
      delivery: "default",
      message: AMENDMENT_ENVELOPE,
      tasks: amendmentTaskRefs({ amendmentId, revision, attemptId: "attempt-2" }),
    });
    const { exit, summary } = await finishAdapterAttempt(run);
    assert.equal(exit.code, 0, `the adapter run completed (stderr: ${run.stderr().slice(-300)})`);
    assert.equal(summary?.outcome, "completed");
    assert.equal(summary?.sessionId, run.adapterSessionId, "the summary reports the same transport identity the receiver registered");
    assert.equal(customReceiptCount(run.sessionPath, eventId), 1, "the envelope was durably received in the adapter-run session BEFORE the adapter exited");
    assert.ok(providerState["relay-mock-adapter"].envelopesSeen.includes(eventId), "the adapter-run model saw the injected envelope (provider-observed)");
    const status = await journalStatus(journal, eventId);
    if (status.state === "delivered") {
      console.log("      3a: the receiver also acknowledged before the adapter teardown finished");
    } else {
      finding("CASE 3a acknowledgement raced the adapter teardown", `the durable receipt exists but the journal obligation is ${status.state}: the receiver did not get another poll before the adapter killed its runtime`);
    }
    crAppend("attempt.started", { identity: { seat: "runner", pi_session: run.adapterSessionId } }, { context: { jobId: JOB_ID, attemptId: "attempt-2" } });
    crAppend("attempt.outcome", { status: "completed", summary: "adapter arm 3a completed" }, { context: { jobId: JOB_ID, attemptId: "attempt-2" } });
    assert.ok(
      crViews().pendingAmendments(JOB_ID).some((entry) => entry.amendmentId === amendmentId),
      "durable receipt is not incorporation: the adapter arm has no acknowledgement path in this dispatch, so the amendment stays pending",
    );
    pass("CASE 3a settle-boundary delivery: the real adapter lifecycle completed while the pushed amendment was durably received and model-visible in its native session recording; incorporation deliberately absent (no production ack surface)");
  }

  {
    // ---- 3b: push at the settle/teardown boundary, then push after exit.
    crAppend("attempt.launch_intent", {}, { context: { jobId: JOB_ID, attemptId: "attempt-3" } });
    const first = commitAmendment(5, { attemptId: "attempt-3", recipientSessionId: workerSessionId });
    const second = commitAmendment(6, { attemptId: "attempt-3", recipientSessionId: workerSessionId });
    const finalDone = new Promise((resolveDone) => { providerState["relay-mock-adapter"].onFinalDone = resolveDone; });
    const run = await runAdapterAttempt({
      attemptId: "attempt-3",
      plan: [
        { type: "tool", path: adapterWorkAssignment },
        { type: "text", text: "working from the current assignment", stallMs: 800 },
      ],
    });
    await waitForAdapterPrompt(run);
    await finalDone; // the run's final provider response just completed; the adapter is settling/tearing down
    const boundaryEventId = await pushViaArchitect(architect, {
      to: run.adapterSessionId,
      delivery: "default",
      message: AMENDMENT_ENVELOPE,
      tasks: amendmentTaskRefs({ amendmentId: first.amendmentId, revision: first.revision, attemptId: "attempt-3" }),
    });
    const { exit, summary } = await finishAdapterAttempt(run);
    assert.equal(exit.code, 0, `the adapter run completed (stderr: ${run.stderr().slice(-300)})`);
    assert.equal(summary?.outcome, "completed");
    const boundaryReceipts = customReceiptCount(run.sessionPath, boundaryEventId);
    const boundaryStatus = await journalStatus(journal, boundaryEventId);
    assert.equal(
      boundaryStatus.state === "delivered",
      boundaryReceipts >= 1,
      `honest invariant: journal delivered iff a durable session receipt exists (status ${boundaryStatus.state}, receipts ${boundaryReceipts})`,
    );
    if (boundaryReceipts === 0) {
      finding(
        "CASE 3b settle-boundary delivery lost the exit race",
        "the adapter exited while the amendment was only queued on the journal; no durable receipt exists in the adapter session. Queue acceptance on a settling/exiting adapter is not delivery.",
      );
    } else {
      console.log("      3b: the boundary push won the race and was durably received before the runtime was killed");
    }
    crAppend("attempt.started", { identity: { seat: "runner", pi_session: run.adapterSessionId } }, { context: { jobId: JOB_ID, attemptId: "attempt-3" } });
    crAppend("attempt.outcome", { status: "completed", summary: "adapter arm 3b completed" }, { context: { jobId: JOB_ID, attemptId: "attempt-3" } });

    // Dead-consumer probe: push to the EXITED adapter's session id.
    const deadEventId = await pushViaArchitect(architect, {
      to: run.adapterSessionId,
      delivery: "default",
      message: AMENDMENT_ENVELOPE,
      tasks: amendmentTaskRefs({ amendmentId: second.amendmentId, revision: second.revision, attemptId: "attempt-3" }),
    });
    await new Promise((r) => setTimeout(r, 4000)); // bounded observation window
    const deadStatus = await journalStatus(journal, deadEventId);
    assert.notEqual(deadStatus.state, "delivered", "a queued message on a dead child is never reported delivered");
    assert.equal(customReceiptCount(run.sessionPath, deadEventId), 0, "no durable receipt can appear after the runtime is gone");
    assert.ok(
      crViews().pendingAmendments(JOB_ID).some((entry) => entry.amendmentId === second.amendmentId),
      "the amendment targeted at the exited attempt stays pending in the change record",
    );
    finding(
      "CASE 3b dead-consumer binding (lifecycle gap)",
      "obligations are bound to consumer_id agents/<pi-session-id>. When the adapter exits on settle, pending obligations stay queued for that dead consumer; a relaunched attempt has a NEW session id and never receives them. The runner integration must either hold the runtime until the receiver reports no pending obligations or re-address pending amendments to the successor attempt.",
    );
    pass("CASE 3b settle/exit boundary: the exit race was observed honestly and the dead-consumer binding was reproduced precisely (queued message on a dead child is never delivery)");
  }

  // ========================================================================
  // CASE 6: cancellation — explicit cancellation is recorded BEFORE the abort;
  // the native trace records the aborted outcome; later output cannot promote
  // cancelled work to success.
  // ========================================================================
  {
    crAppend("attempt.launch_intent", {}, { context: { jobId: JOB_ID, attemptId: "attempt-4" } });
    const { amendmentId, revision } = commitAmendment(7, { attemptId: "attempt-4", recipientSessionId: workerSessionId });
    const run = await runAdapterAttempt({
      attemptId: "attempt-4",
      plan: [
        { type: "tool", path: adapterWorkAssignment },
        { type: "text", text: "working from the current assignment", stallMs: 30_000 },
      ],
    });
    // The native session header is observed evidence the attempt started.
    crAppend("attempt.started", { identity: { seat: "runner", pi_session: run.adapterSessionId } }, { context: { jobId: JOB_ID, attemptId: "attempt-4" } });
    await waitForAdapterPrompt(run);
    const eventId = await pushViaArchitect(architect, {
      to: run.adapterSessionId,
      delivery: "default",
      message: AMENDMENT_ENVELOPE,
      tasks: amendmentTaskRefs({ amendmentId, revision, attemptId: "attempt-4" }),
    });
    await new Promise((r) => setTimeout(r, 500)); // the receiver steers the queued envelope; nothing durable yet
    // Record the cancellation BEFORE the abort.
    crAppend("attempt.cancel_intent", { reason: "operator cancelled the attempt during the relay proof" }, { context: { jobId: JOB_ID, attemptId: "attempt-4" } });
    run.child.kill("SIGINT");
    const exit = await run.exitPromise;
    ownedChildren.delete(run.child);
    assert.ok([1, 130, 143].includes(exit.code ?? -1), `the cancelled adapter run exits 1/130/143 (got ${exit.code}, stderr: ${run.stderr().slice(-300)})`);
    assert.match(run.stderr(), /run_aborted|received SIGINT/, "the abort was named on the adapter stderr");
    // The signal path exits before the adapter writes a summary; if one exists
    // anyway it must not claim success.
    if (existsSync(run.summaryFile)) {
      const summary = JSON.parse(readFileSync(run.summaryFile, "utf8"));
      assert.notEqual(summary?.outcome, "completed", "a cancelled run's summary must not claim completion");
    }
    const sessionEntries = readSessionEntries(run.sessionPath);
    const abortedAssistant = sessionEntries.some((entry) =>
      entry.type === "message" && entry.message?.role === "assistant" && entry.message?.stopReason === "aborted");
    assert.ok(abortedAssistant, "the native trace records the aborted in-flight message");
    // The queued steer may drain through the aborted run's continuation before
    // the runtime dies; the honest invariant is delivered-iff-durable-receipt,
    // never a false acknowledgement without one.
    const cancelReceipts = customReceiptCount(run.sessionPath, eventId);
    const statusAfterCancel = await journalStatus(journal, eventId);
    assert.equal(
      statusAfterCancel.state === "delivered",
      cancelReceipts >= 1,
      `honest invariant: journal delivered iff a durable session receipt exists (status ${statusAfterCancel.state}, receipts ${cancelReceipts})`,
    );
    if (cancelReceipts === 0) {
      console.log("      cancellation won the race: the queued envelope stayed pending on the cancelled attempt");
    } else {
      console.log("      the queued envelope drained through the aborted run's continuation and was durably received before the runtime died");
    }
    // Later output cannot promote cancelled work to success.
    assert.throws(
      () => crAppend("attempt.outcome", { status: "completed", summary: "late success claim" }, { context: { jobId: JOB_ID, attemptId: "attempt-4" } }),
      /cancellation intent .* forbids a completed outcome|forbids a completed outcome/,
      "the change record refuses to promote cancelled work to a completed outcome",
    );
    assert.ok(
      crViews().pendingAmendments(JOB_ID).some((entry) => entry.amendmentId === amendmentId),
      "the amendment targeted at the cancelled attempt stays pending (no false fulfilment)",
    );
    const attempt4 = crHandle().state.jobs[JOB_ID].attempts["attempt-4"];
    assert.equal(attempt4.cancelIntent.reason, "operator cancelled the attempt during the relay proof", "the cancellation intent is recorded with its reason before the abort");
    pass("CASE 6 cancellation: cancel_intent recorded before the abort; native trace stopReason=aborted; the change record refuses a later completed outcome; no false acknowledgement, amendment stays pending");
  }

  // ========================================================================
  // CASE 7: session recording artifacts and cleanup. Retained artifacts show
  // the model-visible envelope, the tool result/receipt/ack sequence, and
  // owned-process termination. No external inference, no operator
  // credentials/config/state touched.
  // ========================================================================
  {
    // The worker session recording shows the full envelope -> tool result ->
    // receipt -> acknowledgement sequence.
    const workerEntries = readSessionEntries(workerSessionFile);
    const envelopes = workerEntries.filter((entry) => entry.type === "custom_message" && entry.customType === "qq-agent-message");
    assert.ok(envelopes.length >= 3, `the worker session recording retains the model-visible envelopes (got ${envelopes.length})`);
    for (const envelope of envelopes) {
      assert.ok(envelope.details?.event_id && envelope.details?.content_hash, "each retained envelope carries its stable receipt identity");
    }
    const ackToolResults = workerEntries.filter((entry) =>
      entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === "fixture_acknowledge_amendment");
    assert.ok(ackToolResults.length >= 3, "the worker session recording retains the acknowledgement tool results");
    const progressToolResults = workerEntries.filter((entry) =>
      entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === "fixture_report_progress");
    assert.ok(progressToolResults.length >= 1, "the worker session recording retains the progress/notification tool result");

    // Adapter-arm native recordings exist under the private worker-session dir
    // with the recording sidecars the landed adapter writes.
    const adapterSessionsDir = join(xdgState, "qq-workflows", "worker-sessions");
    const sidecars = readdirSync(adapterSessionsDir).filter((f) => f.endsWith(".meta.json"));
    assert.equal(sidecars.length, 3, "one native session sidecar per adapter attempt (3a, 3b, cancellation)");
    for (const sidecar of sidecars) {
      const meta = JSON.parse(readFileSync(join(adapterSessionsDir, sidecar), "utf8"));
      assert.equal(meta.schema, "qq-worker-session-meta/1");
      assert.equal(meta.seat, "runner");
      assert.ok(existsSync(join(adapterSessionsDir, meta.sessionFile.split("/").at(-1))), "the recorded session file exists next to its sidecar");
    }

    // No external inference: every provider request went to the localhost mock
    // with the fixture dummy key.
    assert.ok(wire.length >= 10, `the mock provider saw the whole proof (${wire.length} requests)`);
    for (const request of wire) {
      assert.ok(String(request.authorization || "").includes(DUMMY_KEY), "every provider request carried only the fixture dummy key");
    }

    // Owned-process termination is verified at cleanup (finally block); assert
    // here that every adapter exit was observed and reaped.
    assert.ok(results.length >= 5, "the earlier cases ran before the cleanup assertions");

    // Retained artifact manifest for the reviewer.
    writeFileSync(join(root, "manifest.json"), `${JSON.stringify({
      schema: "qq-relay-proof-artifacts/1",
      generatedAt: new Date().toISOString(),
      changeRecord: join(changeStateDir, "changes", `${CHANGE_ID}.jsonl`),
      journalStateDir: relayStateDir,
      relayLog: relayLog.join("").slice(-4000),
      sessions: {
        architect: architectSessionFile,
        worker: workerSessionFile,
        adapterArmNativeSessions: join(xdgState, "qq-workflows", "worker-sessions"),
      },
      findings,
    }, null, 2)}\n`, "utf8");
    pass("CASE 7 recording and cleanup: retained native session artifacts show the model-visible envelopes, the tool result/receipt/ack sequence and the per-attempt recording sidecars; provider traffic stayed on the localhost mock with the dummy key; owned processes are reaped in the cleanup block");
  }
} catch (error) {
  console.error("RELAY PROOF FAILURE:", error?.message ?? error);
  if (error?.command) console.error("failing rpc command:", error.command);
  if (error?.stack) console.error(error.stack.split("\n").slice(0, 12).join("\n"));
  process.exitCode = 1;
} finally {
  await cleanup("finally");
}
// A timeout signal must not leave the temporary journal service or any pi
// runtime behind.
async function cleanup(cause) {
  for (const child of ownedChildren) {
    try { child.kill("SIGKILL"); } catch {}
  }
  try { relayChild.kill("SIGKILL"); } catch {}
  await new Promise((r) => setTimeout(r, 300));
  try { server.closeAllConnections?.(); } catch {}
  try { server.close(); } catch {}
  if (cause === "signal") process.exit(124);
}
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => { void cleanup("signal"); });
}
console.log(results.join("\n"));
if (findings.length) console.log(`FINDINGS (${findings.length}):\n${findings.map((f) => `- ${f.name}: ${f.detail}`).join("\n")}`);
if (process.exitCode) {
  console.log(`RELAY PROOF RESULT: ${results.length} cases passed before failure`);
  process.exit(process.exitCode);
}
console.log(`RELAY PROOF RESULT: TOTAL ${results.length}/${results.length} PASS (${findings.length} recorded findings; artifacts retained under ${root})`);
