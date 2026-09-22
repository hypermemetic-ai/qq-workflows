// Shared runner communication runtime.
//
// One API for the workflow runner's amendment/progress communication, usable by
// BOTH eventual caller entry points (`workflow/operations.mjs` and
// `bin/mcp-server.mjs`, wired in phase 2b) and by the worker-side adapter
// (`workflow/pi-worker/adapter.mjs`, integrated in this phase). It deliberately
// contains no workflow tool wiring, no runner dispatch, and no second truth:
//
//   * The change record (`workflow/change-record.mjs`) is the SOLE workflow
//     authority. Every binding, admission, submission, and acknowledgement
//     transition goes through its writer/reducer. The qq-relay journal is
//     subordinate durable TRANSPORT bookkeeping; the native Pi session remains
//     diagnostic and receiver-receipt evidence.
//   * The relay runtime is a CHILD PROCESS owned by the caller (the parent
//     runtime), serving a PRIVATE state/socket directory. It is never a
//     machine-wide service: acquire never attaches to a relay it did not spawn
//     on this private directory (a live foreign relay is used as shared
//     transport and never killed; a listener that is not qq-relay is refused;
//     a dead socket inside our own private directory is replaced), and release
//     never deletes pending durable obligations.
//
// Status language used throughout (each name is a distinct fact; none implies
// another):
//
//   recorded     — the change record durably committed the event (the only
//                  workflow truth).
//   queued       — the relay journal ACCEPTED the envelope for the recorded
//                  recipient. Transport acceptance only: not delivery, not
//                  receipt, not incorporation.
//   delivered    — the relay obligation was acknowledged by the receiver. Per
//                  the tested receiver discipline that acknowledgement happens
//                  only after the durable Pi session entry (the receiver
//                  receipt) was observable, so `delivered` is the evidence that
//                  a Pi session receipt exists. It is still NOT incorporation.
//   acknowledged — `worker.acknowledged` is committed in the change record for
//                  the exact revision by the targeted attempt: the worker
//                  incorporated the update. Incorporation never proves the
//                  requested outcome succeeded.
//   unavailable / unknown / refused — evidence that is absent, unobservable, or
//                  that the record refused; reported honestly, never as success.
//
// Nothing here claims exactly-once message injection (a crash before a durable
// receipt may reinject; see docs/pi-relay-receiver-proof.md F1). Exactly-once
// INCORPORATION is enforced by the change record's deterministic command IDs.
// Existing runner entry points remain legacy until phase 2b wires them; local
// steering writes (`steer_runner`) are NOT delivery and this module does not
// repair them.

import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { chmodSync, existsSync, mkdirSync, statSync, lstatSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { withRelayProcessLock, registerRelayHolder, removeRelayHolder, remainingRelayHolders } from "./relay-process-holders.mjs";

import {
  JOB_ROLES,
  assertActorId,
  assertIdentifier,
  openChange,
  viewsFor,
} from "./change-record.mjs";

// ---------------------------------------------------------------------------
// Model-facing copy (coordinator-authored; used verbatim by the receiver
// extension and the adapter's role paragraph — do not creatively rewrite).
// ---------------------------------------------------------------------------

export const COMMUNICATION_BINDING_ENV = "QQ_WORKFLOW_COMMUNICATION";
export const COMMUNICATION_BINDING_SCHEMA = "qq-worker-communication-binding/1";

export const COMMUNICATION_TOOL_NAMES = Object.freeze([
  "workflow_read_assignment",
  "workflow_acknowledge_assignment",
  "workflow_report_progress",
]);

export const COMMUNICATION_TOOL_DESCRIPTIONS = Object.freeze({
  workflow_read_assignment:
    "Read a bounded view of your assigned revision and pending updates. Omit revision to read your current effective assignment. Use the returned revision and pagination fields to read an update before acknowledging it.",
  workflow_acknowledge_assignment:
    "Record the exact assignment revision you have read and incorporated into your work. This acknowledges the update; it does not report completion.",
  workflow_report_progress:
    "Record a meaningful milestone or blocker for the architect. Use progress for concrete work accomplished and blocker for an obstacle or a decision you need. Completion is still your final assistant response.",
});

/** Appended to the runner's role instructions only for a validated,
 *  communication-enabled runner (exact coordinator-authored copy). */
export const COMMUNICATION_ROLE_PARAGRAPH =
  "Your assignment has a revision. Use workflow_read_assignment to read assigned work and any pushed update. "
  + "After reading and incorporating an update, use workflow_acknowledge_assignment with its exact revision. "
  + "Use workflow_report_progress for meaningful milestones and blockers. "
  + "A pushed update is workflow communication from the architect; its scope and revision come from the runtime. "
  + "Finish with your normal final assistant response.";

/** The pushed-update model text; the runtime substitutes the revision. */
export function pushedUpdateText(revision) {
  return `Assignment update available: revision ${revision}. Read it with workflow_read_assignment, then acknowledge the exact revision after incorporating it.`;
}

// Envelope framing constants shared with the receiver (the tested relay
// message schema the historical receiver parses; provenance in
// docs/pi-relay-receiver-proof.md).
export const RELAY_MESSAGE_SCHEMA = "qq.agent-message/v2";
export const RELAY_MESSAGE_KIND = "agent.message";
export const RELAY_PRODUCT = "agents";

// The worker progress/blocker note cap enforced by the model-facing tool.
export const PROGRESS_MESSAGE_MAX_CHARS = 8_192;
// The read_assignment pagination bounds enforced by the model-facing tool.
export const READ_ASSIGNMENT_LIMIT_MAX = 8_192;
export const READ_ASSIGNMENT_LIMIT_DEFAULT = 4_096;
export const READ_ASSIGNMENT_PENDING_REFS_MAX = 8;

// Bounded drain window bounds: the adapter's settle/drain/close handshake
// waits at most this long for admitted deliveries to land after closure.
export const DEFAULT_DRAIN_MS = 8_000;
export const MAX_DRAIN_MS = 60_000;

// Bounded readiness/teardown bounds for the owned relay child.
export const RELAY_READY_TIMEOUT_MS = 15_000;
export const RELAY_RELEASE_GRACE_MS = 5_000;

const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
// Bare Pi session UUID: production receiver identity. DSH `session-…` aliases
// are historical test vocabulary and are refused in production.
export const PI_SESSION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Production receiver identity is a bare Pi session UUID, never a DSH alias. */
export function assertPiSessionId(value, label = "session id") {
  if (typeof value !== "string" || !PI_SESSION_ID_PATTERN.test(value)) {
    throw fail(
      "invalid-session-id",
      `${label} must be a bare Pi session UUID (got ${JSON.stringify(value ?? null)}); DSH session aliases are not accepted in production`,
    );
  }
  return value;
}

/** The relay `agents/<sessionId>` recipient for one receiver identity. */
export function relayAgentId(sessionId) {
  assertPiSessionId(sessionId, "session id");
  return `${RELAY_PRODUCT}/${sessionId}`;
}

/** Parse an `agents/<sessionId>` recipient reference. */
export function parseRelayAgentId(value, label = "recipient") {
  if (typeof value !== "string" || !value.startsWith(`${RELAY_PRODUCT}/`)) {
    throw fail("invalid-recipient", `${label} must be '${RELAY_PRODUCT}/<bare Pi session UUID>' (got ${JSON.stringify(value ?? null)})`);
  }
  return assertPiSessionId(value.slice(RELAY_PRODUCT.length + 1), label);
}

/** The wire `project` slug for a change id (wire metadata only; the record
 *  keeps the exact id). */
export function projectSlugForChange(changeId) {
  const slug = String(changeId).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  if (!PROJECT_SLUG.test(slug)) throw fail("invalid-identifier", `change id ${JSON.stringify(changeId)} cannot form a relay project slug`);
  return slug;
}

// ---------------------------------------------------------------------------
// Binding: the trusted runner communication context (never model-supplied)
// ---------------------------------------------------------------------------

/**
 * Parse the runner communication binding from the environment. Absent or blank
 * means communication is DISABLED (the exact prior behavior). A present but
 * malformed binding throws (`binding-invalid`): the adapter refuses before any
 * inference, and communication is never partially enabled.
 *
 * The binding is the runtime-supplied trusted context: change/job/attempt
 * identity, the worker and runtime actor ids, the job role, the return-direction
 * recipient, the owned relay socket, and the drain window bound. Nothing in it
 * is ever taken from a model or from a filename.
 */
export function parseCommunicationBinding(env = process.env) {
  const raw = env?.[COMMUNICATION_BINDING_ENV];
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) return { enabled: false };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw fail("binding-invalid", `${COMMUNICATION_BINDING_ENV} is not valid JSON: ${error?.message ?? error}`);
  }
  return { enabled: true, binding: validateCommunicationBinding(parsed) };
}

/** Structural validation of one communication binding object. */
export function validateCommunicationBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("binding-invalid", `${COMMUNICATION_BINDING_ENV} must be a JSON object`);
  }
  const allowed = new Set([
    "schema", "stateDir", "changeId", "jobId", "attemptId", "actorId", "runtimeActorId",
    "role", "recipientAgent", "socketPath", "installRoot", "drainMs",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw fail("binding-invalid", `${COMMUNICATION_BINDING_ENV} field '${key}' is not part of the binding schema`);
  }
  if (value.schema !== COMMUNICATION_BINDING_SCHEMA) {
    throw fail("binding-invalid", `${COMMUNICATION_BINDING_ENV} schema ${JSON.stringify(value.schema ?? null)} is unknown; expected '${COMMUNICATION_BINDING_SCHEMA}'`);
  }
  for (const field of ["stateDir", "socketPath"]) {
    if (typeof value[field] !== "string" || !isAbsolute(value[field])) {
      throw fail("binding-invalid", `${COMMUNICATION_BINDING_ENV} field '${field}' must be an absolute path`);
    }
  }
  for (const field of ["changeId", "jobId", "attemptId"]) {
    try {
      assertIdentifier(value[field], field);
    } catch (error) {
      throw fail("binding-invalid", `${COMMUNICATION_BINDING_ENV} field '${field}': ${error.message}`);
    }
  }
  for (const field of ["actorId", "runtimeActorId"]) {
    try {
      assertActorId(value[field]);
    } catch (error) {
      throw fail("binding-invalid", `${COMMUNICATION_BINDING_ENV} field '${field}': ${error.message}`);
    }
  }
  if (!JOB_ROLES.includes(value.role)) {
    throw fail("binding-invalid", `${COMMUNICATION_BINDING_ENV} field 'role' ${JSON.stringify(value.role ?? null)} is not a change-record job role`);
  }
  try {
    parseRelayAgentId(value.recipientAgent, "binding recipientAgent");
  } catch (error) {
    throw fail("binding-invalid", `${COMMUNICATION_BINDING_ENV} field 'recipientAgent': ${error.message}`);
  }
  if (value.installRoot !== undefined && (typeof value.installRoot !== "string" || !isAbsolute(value.installRoot))) {
    throw fail("binding-invalid", `${COMMUNICATION_BINDING_ENV} field 'installRoot' must be an absolute path when present`);
  }
  let drainMs = DEFAULT_DRAIN_MS;
  if (value.drainMs !== undefined) {
    if (!Number.isSafeInteger(value.drainMs) || value.drainMs < 0 || value.drainMs > MAX_DRAIN_MS) {
      throw fail("binding-invalid", `${COMMUNICATION_BINDING_ENV} field 'drainMs' must be an integer in [0, ${MAX_DRAIN_MS}]`);
    }
    drainMs = value.drainMs;
  }
  return Object.freeze({
    schema: value.schema,
    stateDir: value.stateDir,
    changeId: value.changeId,
    jobId: value.jobId,
    attemptId: value.attemptId,
    actorId: value.actorId,
    runtimeActorId: value.runtimeActorId,
    role: value.role,
    recipientAgent: value.recipientAgent,
    socketPath: value.socketPath,
    installRoot: value.installRoot ?? null,
    drainMs,
  });
}

/**
 * The record-side view of one attempt's receiver binding. The binding is
 * RECORDED AUTHORITY: `attempt.started` payload.identity carries
 * `{ seat, piSession, recipient }`, reusing the existing trusted identity
 * field (no new event kind for binding). `null` means the attempt has no
 * recorded receiver binding (delivery admission is not possible there).
 */
export function receiverBindingOf(attemptView) {
  const identity = attemptView?.started?.identity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return null;
  if (typeof identity.piSession !== "string" || typeof identity.recipient !== "string") return null;
  return { piSession: identity.piSession, recipient: identity.recipient, seat: identity.seat ?? null };
}

/**
 * Record (or verify) the actual receiver binding for one attempt, against the
 * EXACT started attempt, before any delivery admission.
 *
 * The session id is the one the runtime itself observed from the running Pi
 * (`get_state`) — never guessed from a filename and never accepted from a
 * model. When the attempt is still `launched`, this appends `attempt.started`
 * with the receiver identity (runtime-authored; the adapter is runtime code).
 * When the attempt is already `started`, the recorded identity must MATCH the
 * observed session exactly, otherwise the mismatch refuses.
 *
 * Idempotent: a retry with the same observed session is a record dedupe (the
 * deterministic command id); a DIFFERENT session for the same attempt is a
 * loud command conflict, never a silent rebind.
 */
export function bindAttemptReceiver({
  stateDir,
  changeId,
  jobId,
  attemptId,
  sessionId,
  seat = "runner",
  runtimeActorId,
  // Job-qualified: attempt ids are unique per job, and command ids are unique
  // per record - two jobs may legitimately reuse an attempt id.
  commandId = `started-${jobId}-${attemptId}`,
  now,
} = {}) {
  assertIdentifier(changeId, "changeId");
  assertIdentifier(jobId, "jobId");
  assertIdentifier(attemptId, "attemptId");
  assertActorId(runtimeActorId);
  assertPiSessionId(sessionId, "observed Pi session id");
  const handle = openChange({ stateDir, changeId });
  const attempt = handle.state.jobs[jobId]?.attempts[attemptId];
  if (!attempt) {
    throw fail("not-found", `attempt '${attemptId}' does not exist on job '${jobId}' in change '${changeId}'`);
  }
  const identity = { seat, piSession: sessionId, recipient: relayAgentId(sessionId) };
  if (attempt.phase === "launched") {
    const result = handle.append(
      "attempt.started",
      { identity },
      { context: { actor: { kind: "runtime", id: runtimeActorId }, jobId, attemptId }, commandId, now },
    );
    return { recorded: result.committed !== false, dedupe: result.dedupe === true, seq: result.seq, identity };
  }
  if (attempt.phase === "started") {
    const recorded = receiverBindingOf(viewsFor(handle.state).attempt(jobId, attemptId));
    if (!recorded || recorded.piSession !== sessionId || recorded.recipient !== identity.recipient) {
      throw fail(
        "binding-mismatch",
        `attempt '${attemptId}' is already bound to ${JSON.stringify(recorded?.piSession ?? null)}; the observed session ${JSON.stringify(sessionId)} does not match, and communication is never partially enabled`,
      );
    }
    return { recorded: false, dedupe: true, seq: attempt.started.seq, identity };
  }
  throw fail("invalid-transition", `attempt '${attemptId}' is '${attempt.phase}'; a receiver binding requires an unresolved launch intent or a matching started attempt`);
}

/**
 * Close the attempt's receiver admission: after this durable event the record
 * refuses further amendment submissions for the attempt, so a late accepted
 * submission cannot disappear as a successful delivery. Serialized with
 * submissions by the record's own writer lock (both are ordinary record
 * events; their order is total).
 *
 * Idempotent via the deterministic command id. Acknowledgements and outcomes
 * remain recordable after closure (drain-delivered work may still be
 * incorporated; the attempt's finished work may still be reported).
 */
export function closeReceiverAdmission({ stateDir, changeId, jobId, attemptId, runtimeActorId, commandId = `admission-closed-${jobId}-${attemptId}`, now } = {}) {
  assertIdentifier(changeId, "changeId");
  assertIdentifier(jobId, "jobId");
  assertIdentifier(attemptId, "attemptId");
  assertActorId(runtimeActorId);
  const handle = openChange({ stateDir, changeId });
  const result = handle.append(
    "attempt.admission_closed",
    {},
    { context: { actor: { kind: "runtime", id: runtimeActorId }, jobId, attemptId }, commandId, now },
  );
  const attempt = viewsFor(handle.state).attempt(jobId, attemptId);
  return {
    ok: true,
    committed: result.committed !== false,
    dedupe: result.dedupe === true,
    seq: attempt.admissionClosed?.seq ?? result.seq,
    at: attempt.admissionClosed?.at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Relay runtime: a privately-owned child process and its durable state dir
// ---------------------------------------------------------------------------

/** Resolve the installed qq-relay (client module + service binary). */
export function resolveRelayInstall(env = process.env, { exists = existsSync } = {}) {
  const configured = env?.QQ_RELAY_INSTALL_ROOT;
  if (configured !== undefined && (typeof configured !== "string" || configured.length === 0 || !configured.startsWith("/"))) {
    throw fail("relay-install-invalid", "QQ_RELAY_INSTALL_ROOT must be an absolute path");
  }
  const home = env?.HOME;
  if (typeof home !== "string" || home.length === 0 || !home.startsWith("/")) {
    throw fail("relay-install-invalid", "HOME must be an absolute path when QQ_RELAY_INSTALL_ROOT is unset");
  }
  const root = configured || join(home, ".local", "lib", "qq", "relay");
  const bin = join(root, "bin", "qq-relay");
  const clientModule = join(root, "client.mjs");
  if (!exists(bin) || !exists(clientModule)) {
    return { root: null, bin: null, clientModule: null };
  }
  return { root, bin, clientModule };
}

/** The private relay state/socket directory owned by the parent runtime. */
export function relayRuntimeDir(stateDir) {
  return join(stateDir, "relay");
}

export function relaySocketPath(stateDir) {
  return join(relayRuntimeDir(stateDir), "qq-relay.sock");
}

/** The relay's sticky-bit fence flag (stat.S_ISVTX). */
const STICKY_BIT = 0o1000;

/**
 * Mirror the relay's own placement fence over the WHOLE ancestor chain: a
 * group/other-writable ancestor is only acceptable with the sticky bit AND a
 * private (0777-masked) child owned by this account, and no ancestor may be
 * foreign-owned. Mirroring it here turns what would otherwise be a relay
 * child dying at startup into the explicit `refused` it is.
 */
function assertRelayParentChain(dir) {
  const euid = typeof process.getuid === "function" ? process.getuid() : null;
  let child = statSync(dir);
  let current = dirname(dir);
  for (;;) {
    const info = statSync(current);
    if (euid !== null && info.uid !== 0 && info.uid !== euid) {
      throw fail("refused", `relay state directory ancestor '${current}' is foreign-owned; the relay would refuse it`);
    }
    if ((info.mode & 0o022) !== 0) {
      if ((info.mode & STICKY_BIT) === 0) {
        throw fail("refused", `relay state directory ancestor '${current}' is group/other-writable without a sticky private-child fence`);
      }
      if (euid !== null && child.uid !== euid) {
        throw fail("refused", `relay state directory ancestor '${current}' is group/other-writable with a sticky bit, but its child is not owned by this account`);
      }
      if ((child.mode & 0o077) !== 0) {
        throw fail("refused", `relay state directory ancestor '${current}' is group/other-writable with a sticky bit, but its child is not private (0700)`);
      }
    }
    if (current === dirname(current)) break;
    child = info;
    current = dirname(current);
  }
}

async function loadRelayClientModule(clientModule) {
  const module = await import(pathToFileURL(clientModule).href);
  for (const name of ["QQ_RELAY_PROTOCOL", "RelayClient", "RelayError", "canonicalRelayJson"]) {
    if (!(name in module)) throw fail("relay-install-invalid", `qq-relay installed client does not export ${name}: ${clientModule}`);
  }
  return module;
}

async function probeRelayHealth(socketPath, clientModule) {
  try {
    const module = await loadRelayClientModule(clientModule);
    const client = new module.RelayClient(socketPath);
    const health = await client.inspect({ view: "health" });
    return health?.service === "qq-relay" ? health : null;
  } catch {
    return null;
  }
}

/**
 * Acquire the parent-owned relay runtime for one workflow state directory.
 *
 * Returns `{ ok: true, relay, shared }` or `{ ok: false, code, reason }` where
 * `code` is `unavailable` (no installed relay, or the child never became
 * ready) or `refused` (the private directory cannot be owned safely).
 *
 * `relay` is a handle with:
 *   socketPath / stateDir / pid / owned — identity and ownership facts;
 *   client()  — the lazily constructed installed RelayClient;
 *   inspect() — the relay health view;
 *   release({force}) — drops one hold; the LAST hold stops an OWNED child
 *     only when no other live or unknown process/receiver hold remains
 *     gracefully (SIGTERM, bounded, then SIGKILL) and never deletes the state
 *     directory: pending durable obligations survive a release and a restart.
 *     A `shared` handle (a live relay on our private directory that this
 *     process did not spawn) never kills the child, by construction.
 */
// Startup and shutdown share one queue per canonical directory. A ready-only
// cache does not protect the asynchronous socket readiness window: two calls
// can otherwise start competing singleton relays and fail an unrelated job.
const relayRuntimeQueues = new Map();
function serializeRelayRuntime(key, operation) {
  const previous = relayRuntimeQueues.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(() => {}, () => {});
  relayRuntimeQueues.set(key, settled);
  settled.then(() => {
    if (relayRuntimeQueues.get(key) === settled) relayRuntimeQueues.delete(key);
  });
  return result;
}

export async function acquireRelayRuntime(options = {}) {
  if (!options.stateDir || !isAbsolute(options.stateDir)) throw fail("invalid-arguments", "stateDir must be an absolute path");
  const stateDir = resolve(options.stateDir);
  return serializeRelayRuntime(stateDir, async () => {
    try {
      return await acquireRelayRuntimeUnlocked({ ...options, stateDir });
    } catch (error) {
      return { ok: false, code: "unavailable", reason: `relay runtime acquisition failed: ${error.message}` };
    }
  });
}

async function acquireRelayRuntimeUnlocked({
  stateDir,
  env = process.env,
  spawnImpl = nodeSpawn,
  readyTimeoutMs = RELAY_READY_TIMEOUT_MS,
  releaseGraceMs = RELAY_RELEASE_GRACE_MS,
} = {}) {
  if (!stateDir || !isAbsolute(stateDir)) throw fail("invalid-arguments", "stateDir must be an absolute path");
  const install = resolveRelayInstall(env);
  if (!install.root) {
    return { ok: false, code: "unavailable", reason: "no installed qq-relay (client.mjs + bin/qq-relay) at the resolved install root; communication transport is unavailable" };
  }
  const dir = relayRuntimeDir(stateDir);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { ok: false, code: "refused", reason: `relay state directory '${dir}' could not be initialized: ${error?.message ?? error}` };
  }
  const dirStat = lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || dirStat.uid !== process.getuid()) {
    return { ok: false, code: "refused", reason: `relay state directory '${dir}' is not an owned real directory` };
  }
  if ((dirStat.mode & 0o777) !== 0o700) {
    return { ok: false, code: "refused", reason: `relay state directory '${dir}' must be private (0700), got ${(dirStat.mode & 0o777).toString(8)}` };
  }
  // The relay itself refuses a state directory whose ancestor chain contains
  // a group/other-writable directory without the sticky private-child fence;
  // surface that as the explicit refusal it is instead of letting the child
  // die with an opaque stderr line.
  try {
    assertRelayParentChain(dir);
  } catch (error) {
    return { ok: false, code: "refused", reason: error.message };
  }

  return withRelayProcessLock(dir, async () => {
  const socketPath = relaySocketPath(stateDir);
  const cached = acquireRelayRuntime.cache?.get(stateDir);
  if (cached && cached.owned && !cached.isReleased && relayProcessAlive(cached)) {
    cached.refCount += 1;
    return { ok: true, relay: cached, shared: false };
  }

  if (existsSync(socketPath)) {
    const health = await probeRelayHealth(socketPath, install.clientModule);
    if (health) {
      // A live relay on our own private directory that this process did not
      // spawn (a sibling parent, or an orphan of a crashed one): use it as
      // shared transport and never kill it.
      const module = await loadRelayClientModule(install.clientModule);
      const shared = makeRelayHandle({
        cacheKey: stateDir, stateDir: dir, socketPath, pid: null, owned: false,
        clientFactory: () => new module.RelayClient(socketPath), releaseGraceMs,
      });
      return { ok: true, relay: shared, shared: true };
    }
    if (!(await socketProvenDead(socketPath))) {
      return { ok: false, code: "refused", reason: "relay socket has a live or unobservable listener which did not prove qq-relay health; refusing to replace it" };
    }
    // Dead socket inside our own private directory: replace it. The journal
    // state (sqlite) persists, so previously recorded obligations remain.
    try {
      unlinkSync(socketPath);
    } catch {
      /* a fresh spawn either rebinds or fails its readiness check below */
    }
  }

  // Relay lifetime is owned by the shared runtime's cross-process holders
  // (workflow/relay-process-holders.mjs): the child is detached and adopted as
  // SHARED transport by a later parent; owned shutdown goes through the
  // holder-checked release path only — never an unconditional exit hook.
  const child = spawnImpl(install.bin, ["serve", "--state-dir", dir], { stdio: ["ignore", "pipe", "pipe"], detached: true, env });
  const outputTail = [];
  child.stdout?.on("data", (chunk) => pushTail(outputTail, chunk));
  child.stderr?.on("data", (chunk) => pushTail(outputTail, chunk));
  const ready = await waitForRelayReady({ child, socketPath, install, deadline: Date.now() + readyTimeoutMs });
  if (!ready.ok) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    return { ok: false, code: "unavailable", reason: `${ready.reason}${outputTail.length ? ` (relay output: ${tailText(outputTail)})` : ""}` };
  }
  try {
  const module = await loadRelayClientModule(install.clientModule);
  const handle = makeRelayHandle({
    cacheKey: stateDir, stateDir: dir, socketPath, pid: child.pid ?? null, owned: true,
    clientFactory: () => new module.RelayClient(socketPath), releaseGraceMs, child,
  });
  acquireRelayRuntime.cache ??= new Map();
  acquireRelayRuntime.cache.set(stateDir, handle);
  return { ok: true, relay: handle, shared: false };
  } catch (error) {
    try { child.kill("SIGKILL"); } catch { /* only our just-spawned child */ }
    throw error;
  }
  });
}

function socketProvenDead(socketPath) {
  return new Promise(resolve => {
    const socket = createConnection(socketPath);
    const finish = dead => { socket.destroy(); resolve(dead); };
    socket.once("connect", () => finish(false));
    socket.once("error", error => finish(error.code === "ECONNREFUSED" || error.code === "ENOENT"));
    socket.setTimeout(500, () => finish(false));
  });
}

function pushTail(list, chunk) {
  list.push(String(chunk));
  if (list.length > 20) list.shift();
}

function tailText(list) {
  return list.join("").trim().slice(-400).replace(/\s+/g, " ");
}

function relayProcessAlive(handle) {
  if (handle.exitCode !== null) return false;
  if (handle.pid === null || handle.pid === undefined) return false;
  try {
    process.kill(handle.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForRelayReady({ child, socketPath, install, deadline }) {
  let lastReason = "the relay socket did not appear in time";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return { ok: false, reason: `the relay child exited before it became ready (code ${child.exitCode ?? "none"}, signal ${child.signalCode ?? "none"})` };
    }
    if (existsSync(socketPath)) {
      const health = await probeRelayHealth(socketPath, install.clientModule);
      if (health) return { ok: true, health };
      lastReason = "the relay socket exists but does not answer the qq-relay health view";
    }
    await sleep(100);
  }
  return { ok: false, reason: lastReason };
}

function makeRelayHandle({ cacheKey, stateDir, socketPath, pid, owned, clientFactory, releaseGraceMs, child = null }) {
  let clientInstance = null;
  let refCount = 1;
  const holderPath = registerRelayHolder(stateDir);
  let released = false;
  const handle = {
    stateDir,
    socketPath,
    pid,
    owned,
    get refCount() {
      return refCount;
    },
    set refCount(value) {
      refCount = value;
    },
    exitCode: null,
    async client() {
      if (!clientInstance) clientInstance = clientFactory();
      return clientInstance;
    },
    async inspect() {
      const client = await handle.client();
      return client.inspect({ view: "health" });
    },
    release({ force = false } = {}) {
      return serializeRelayRuntime(cacheKey, () => withRelayProcessLock(stateDir, async () => {
        if (released) return { released: false, reason: "relay already released" };
        refCount -= 1;
        if (refCount > 0 && !force) return { released: false, reason: `shared by ${refCount} holder(s) in this process` };
        released = true;
        removeRelayHolder(holderPath);
        if (acquireRelayRuntime.cache?.get(cacheKey) === handle) acquireRelayRuntime.cache.delete(cacheKey);
        if (!owned) return { released: false, holdReleased: true, reason: "shared relay: this handle does not own the child and never kills it" };
        const remaining = remainingRelayHolders(stateDir);
        if (remaining.length) {
          // Other process incarnations (including bound Pi receivers) still
          // need this socket. Relinquish local ownership without terminating
          // the service or holding this coordinator's event loop open.
          child?.unref(); child?.stdout?.unref?.(); child?.stderr?.unref?.();
          return { released: false, holdReleased: true, reason: `retained for ${remaining.length} other process holder(s)` };
        }
        // Graceful shutdown first (the relay removes its own socket on a clean
        // exit), then bounded escalation — for OUR child only.
        try { child?.kill("SIGTERM"); } catch { /* already gone */ }
        const deadline = Date.now() + releaseGraceMs;
        while (child && Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
          await sleep(50);
        }
        if (child && child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          await sleep(50);
        }
        handle.exitCode = child?.exitCode ?? null;
        return { released: true, forced: child ? child.signalCode === "SIGKILL" : false };
      }));
    },
    get isReleased() {
      return released;
    },
  };
  if (child) {
    child.on("exit", (code) => {
      handle.exitCode = code;
      if (!released) void withRelayProcessLock(stateDir, () => removeRelayHolder(holderPath)).catch(() => {});
      if (acquireRelayRuntime.cache?.get(cacheKey) === handle) acquireRelayRuntime.cache.delete(cacheKey);
    });
  }
  return handle;
}

/** Map a relay status query onto the shared transport status vocabulary. */
export function transportStatusOf(statusResult) {
  const statuses = (statusResult?.obligations ?? []).map((item) => item.status);
  if (statuses.includes("in_flight")) return "delivering";
  if (statuses.includes("pending")) return "queued";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.length && statuses.every((value) => value === "acknowledged")) return "delivered";
  if (statuses.includes("expired")) return "expired";
  if (statuses.some((value) => value === "disposed" || value === "abandoned")) return "failed";
  return statusResult?.terminal_failure ? "failed" : "unknown";
}

// ---------------------------------------------------------------------------
// Relay wire format (shared with the receiver extension)
// ---------------------------------------------------------------------------

/**
 * Send one agent.message envelope. `from` must be a bare Pi session UUID (the
 * sender's own identity), `recipientAgent` an `agents/<uuid>` reference.
 * `requestId` is the stable transport identity for retries of the SAME logical
 * push (a lost send reply, acknowledgement loss): the relay journal dedupes a
 * repeated request id instead of creating a second delivery obligation.
 * Returns `{ eventId, status }` where status is the immediate transport
 * observation (`queued` = journal acceptance, never delivery).
 */
export async function sendAgentMessage({ relayOrClient, from, recipientAgent, project, role, tasks, content, delivery = "default", requestId = null }) {
  assertPiSessionId(from, "sender session id");
  parseRelayAgentId(recipientAgent, "recipient");
  const client = "client" in relayOrClient && typeof relayOrClient.client === "function" ? await relayOrClient.client() : relayOrClient;
  const sent = await client.send({
    producer_id: relayAgentId(from),
    request_id: requestId ?? `msg_${randomUUID()}`,
    origin_id: relayAgentId(from),
    recipient_id: recipientAgent,
    product_id: RELAY_PRODUCT,
    kind: RELAY_MESSAGE_KIND,
    schema_version: 1,
    payload: {
      schema: RELAY_MESSAGE_SCHEMA,
      message: { from, project, role, tasks, pane: null, content, delivery },
    },
  });
  const eventId = sent?.record?.event_id ?? null;
  let status = "unknown";
  try {
    status = transportStatusOf(await client.status({ event_id: eventId, wait_ms: 0 }));
  } catch {
    status = "unknown";
  }
  return { eventId, status };
}

// ---------------------------------------------------------------------------
// Amendment submission: durable in the record BEFORE transport submission
// ---------------------------------------------------------------------------

/**
 * Submit one amendment for a bound runner attempt.
 *
 * Order of facts (each reported separately; none implies another):
 *   1. `assignment.revised` — the new assignment revision, job-scoped
 *      (durable; idempotent command id for the same record state).
 *   2. `amendment.submitted` — the delivery obligation, targeted at the exact
 *      attempt, durably committed BEFORE any push. If the attempt's receiver
 *      admission is closed the record REFUSES here and nothing is pushed.
 *   3. transport push — the envelope goes to the recipient recorded in the
 *      attempt's receiver binding (never a caller-supplied session id), with
 *      the coordinator-authored update text and the structured references
 *      (change/job/attempt/amendment/revision) as wire metadata.
 *
 * Idempotency: retries MUST pass the same `amendmentId` (and meet the same
 * record state) to dedupe; a generated id makes every call a new amendment.
 *
 * Returns `{ ok: true, amendmentId, revision, recorded, submission, delivery }`
 * where `delivery.status` is `queued` (journal acceptance), `unknown`, or
 * `unavailable` (no relay / relay failure — the amendment stays recorded and
 * pending for retry). Returns `{ ok: false, code: "refused", ... }` when the
 * record refused the submission (e.g. admission closed concurrently): the
 * recorded revision, if any, stays in the record and nothing was pushed.
 */
export async function submitAmendment({
  stateDir,
  changeId,
  jobId,
  attemptId,
  instructions = null,
  composeInstructions = null,
  note = null,
  amendmentId = null,
  actor = null,
  relay = null,
  now,
  expect = null,
} = {}) {
  assertIdentifier(changeId, "changeId");
  assertIdentifier(jobId, "jobId");
  assertIdentifier(attemptId, "attemptId");
  // The full assignment revision content: either supplied verbatim, or
  // composed per revision attempt (`composeInstructions(revision)`) so a
  // revision race never bakes in a stale committed revision label.
  const instructionsFor = (revision, currentState) => {
    const text = typeof composeInstructions === "function" ? composeInstructions(revision, currentState) : instructions;
    if (typeof text !== "string" || text.trim() === "") {
      throw fail("invalid-arguments", "instructions (the full assignment revision content) is required");
    }
    return text;
  };
  if (typeof composeInstructions !== "function" && (typeof instructions !== "string" || instructions.trim() === "")) {
    throw fail("invalid-arguments", "instructions (the full assignment revision content) is required");
  }
  if (note !== null && (typeof note !== "string" || note.trim() === "")) {
    throw fail("invalid-arguments", "note (the raw coordinator instruction) must be a nonempty string when given");
  }
  const resolvedActor = actor ?? { kind: "runtime", id: "qq-workflows-runtime" };
  const handle = openChange({ stateDir, changeId });
  const state = handle.state;
  const job = state.jobs[jobId];
  if (!job) throw fail("not-found", `unknown job '${jobId}' in change '${changeId}'`);
  const attempt = job.attempts[attemptId];
  if (!attempt) throw fail("not-found", `unknown attempt '${attemptId}' on job '${jobId}'`);
  const binding = receiverBindingOf(viewsFor(state).attempt(jobId, attemptId));
  if (!binding) {
    throw fail(
      "not-bound",
      `attempt '${attemptId}' has no recorded receiver binding; delivery admission requires the binding recorded against the exact started attempt first`,
    );
  }
  const resolvedAmendmentId = amendmentId ?? `amend-${randomUUID()}`;
  assertIdentifier(resolvedAmendmentId, "amendmentId");

  // Retry-dedupe: the same amendmentId meeting an already-recorded submission
  // is an idempotent return. No new revision is authored and nothing is
  // re-pushed: a second push would be a NEW relay event the receiver cannot
  // correlate with the first delivery.
  const priorSubmission = job.amendments[resolvedAmendmentId];
  if (priorSubmission) {
    return {
      ok: true,
      amendmentId: resolvedAmendmentId,
      revision: priorSubmission.revision,
      dedupe: true,
      recorded: { seq: null, eventId: null },
      submission: { seq: null, eventId: null },
      delivery: {
        status: "unknown",
        eventId: null,
        reason: "a submission with this amendmentId is already recorded; nothing was re-pushed - inspect the amendment for its delivery status",
      },
    };
  }

  // Concurrent coordinators race for the next revision number: a loser's
  // `revise-<jobId>-r<revision>` command id collides with the winner's
  // different content. Re-open the record and recompute (bounded) so a race is
  // a retry, never a corruption and never a lost amendment. Each attempt
  // re-checks admission closure against the freshly read state: a closure that
  // committed in between refuses the submission here, which is the
  // race-order-B guarantee.
  const RACE_ATTEMPTS = 4;
  let revised = null;
  let submission = null;
  let revision = null;
  let lastConflict = null;
  for (let race = 0; race < RACE_ATTEMPTS && !submission; race += 1) {
    const current = race === 0 ? handle : openChange({ stateDir, changeId });
    const currentState = current.state;
    const currentAttempt = currentState.jobs[jobId]?.attempts[attemptId];
    if (!currentAttempt) throw fail("not-found", `unknown attempt '${attemptId}' on job '${jobId}'`);
    const currentBinding = receiverBindingOf(viewsFor(currentState).attempt(jobId, attemptId));
    if (!currentBinding) {
      throw fail("not-bound", `attempt '${attemptId}' has no recorded receiver binding; delivery admission requires the binding recorded against the exact started attempt first`);
    }
    if (currentAttempt.admissionClosed) {
      return {
        ok: false,
        code: "refused",
        reason: `receiver admission on attempt '${attemptId}' is closed; the amendment was not admitted for delivery there`,
        revision: null,
        amendmentId: null,
      };
    }
    revision = currentState.currentRevision + 1;
    // The caller may need the COMMITTED revision number to author the full
    // assignment text (concurrent coordinators race for the next revision
    // number, so the precomputed text could carry a stale revision label).
    // `composeInstructions` is recomputed under the record's writer lock for
    // each race attempt, so the committed revision is always the one the text
    // names.
    const resolvedInstructions = instructionsFor(revision, currentState);
    if (typeof resolvedInstructions !== "string" || resolvedInstructions.trim() === "") {
      throw fail("invalid-arguments", "the composed assignment revision content is required");
    }
    let revisedAttempt;
    try {
      revisedAttempt = current.append(
        "assignment.revised",
        {
          revision,
          predecessor: currentState.currentRevision,
          scope: { kind: "job", jobId },
          assignment: { instructions: resolvedInstructions },
          ...(note ? { note } : {}),
        },
        { context: { actor: resolvedActor, jobId }, commandId: `revise-${jobId}-r${revision}`, now },
      );
    } catch (error) {
      if (error?.code === "command-conflict") {
        lastConflict = error;
        continue; // another coordinator committed this revision number: recompute
      }
      throw error;
    }
    try {
      submission = current.append(
        "amendment.submitted",
        {
          amendmentId: resolvedAmendmentId,
          revision,
          transport: { relay: { kind: RELAY_MESSAGE_KIND, recipient: currentBinding.recipient } },
          note: note ?? null,
        },
        // `expect` binds the submission to the exact attempt that was the
        // intended target when the caller bound it: a phase/attempt change
        // racing the submission refuses here (the recorded revision, if any,
        // stays in the record as an unresolved update) and is never silently
        // retargeted.
        { context: { actor: resolvedActor, jobId, attemptId }, commandId: `submit-${resolvedAmendmentId}`, now, ...(expect ? { expect } : {}) },
      );
      revised = revisedAttempt;
    } catch (error) {
      if (error?.code === "command-conflict") {
        // A concurrent submitter recorded this amendmentId between our snapshot
        // and this append. The record already holds the submission; report the
        // recorded facts and never re-push a duplicate delivery.
        const recorded = viewsFor(current.state).job(jobId).amendments.find((entry) => entry.amendmentId === resolvedAmendmentId);
        return {
          ok: true,
          amendmentId: resolvedAmendmentId,
          revision: recorded?.revision ?? revision,
          dedupe: true,
          recorded: { seq: null, eventId: null },
          submission: { seq: null, eventId: null },
          delivery: {
            status: "unknown",
            eventId: null,
            reason: "a concurrent submission with this amendmentId is already recorded; nothing was re-pushed - inspect the amendment for its delivery status",
          },
        };
      }
      // The record is the authority: a refused submission (e.g. an admission
      // closure that committed between the pre-check and this append) is
      // reported as refused, and the recorded revision stays in the record.
      return {
        ok: false,
        code: "refused",
        reason: `the record refused the amendment submission: ${error.message}`,
        revision,
        revisedSeq: revisedAttempt.seq,
        amendmentId: resolvedAmendmentId,
      };
    }
  }
  if (!submission || !revised) {
    throw fail("contention", `could not record the amendment after ${RACE_ATTEMPTS} revision races: ${lastConflict?.message ?? "unknown contention"}`);
  }

  let delivery = { status: "unavailable", reason: "no relay runtime was supplied; the amendment stays recorded and pending", eventId: null };
  if (relay) {
    try {
      const pushed = await sendAgentMessage({
        relayOrClient: relay,
        from: binding.piSession,
        recipientAgent: binding.recipient,
        project: projectSlugForChange(changeId),
        role: job.role,
        tasks: [`change:${changeId}`, `job:${jobId}`, `attempt:${attemptId}`, `amendment:${resolvedAmendmentId}`, `revision:${revision}`],
        content: pushedUpdateText(revision),
        // Stable transport identity: a retry after a lost send reply dedupes
        // at the relay journal instead of creating a second obligation.
        requestId: `push-req-${jobId}-${attemptId}-${resolvedAmendmentId}-0`,
      });
      delivery = { status: pushed.status, eventId: pushed.eventId };
    } catch (error) {
      delivery = { status: "unavailable", reason: String(error?.message ?? error).slice(0, 300), eventId: null };
    }
  }
  return {
    ok: true,
    amendmentId: resolvedAmendmentId,
    revision,
    recorded: { seq: revised.seq, eventId: revised.eventId },
    submission: { seq: submission.seq, eventId: submission.eventId },
    delivery,
  };
}

/**
 * Inspect one amendment's delivery and acknowledgement SEPARATELY.
 *
 * `transport.status` comes from the relay journal when the caller supplies the
 * pushed event id (`queued` = accepted, `delivered` = the receiver
 * acknowledged after a durable Pi session receipt existed — receipt evidence,
 * never incorporation); without an event id the transport status is `unknown`
 * (unobservable, honestly). `amendment.acknowledged` comes from the change
 * record (`worker.acknowledged` for the exact revision by the targeted
 * attempt — incorporation).
 */
export async function inspectAmendment({ stateDir, changeId, jobId, amendmentId, relay = null, eventId = null }) {
  assertIdentifier(changeId, "changeId");
  assertIdentifier(jobId, "jobId");
  const handle = openChange({ stateDir, changeId });
  const jobView = viewsFor(handle.state).job(jobId);
  const amendment = jobView.amendments.find((entry) => entry.amendmentId === amendmentId);
  if (!amendment) throw fail("not-found", `amendment '${amendmentId}' was never submitted on job '${jobId}'`);
  let transport = { status: "unknown", eventId, reason: eventId ? null : "no pushed relay event id was supplied" };
  if (relay && eventId) {
    try {
      const client = await relay.client();
      transport = { status: transportStatusOf(await client.status({ event_id: eventId, wait_ms: 0 })), eventId, reason: null };
    } catch (error) {
      transport = { status: "unknown", eventId, reason: String(error?.message ?? error).slice(0, 200) };
    }
  }
  return {
    amendment,
    transport,
    layers: {
      recorded: true,
      receiverReceiptObserved: transport.status === "delivered",
      workerAcknowledged: amendment.acknowledged !== null,
    },
  };
}

// ---------------------------------------------------------------------------
// Progress publication: the committed entry is the only body
// ---------------------------------------------------------------------------

/**
 * Build the return-direction progress envelope from an ALREADY COMMITTED
 * change-record entry. The body is the committed worker message verbatim; the
 * structured metadata (source role, change, job, attempt, sequence) rides in
 * the message tasks — never inside the text. A sequence that is not committed
 * cannot be published (no phantom progress), and an entry with missing
 * continuation parts is refused rather than published incomplete.
 */
export function buildProgressEnvelope({ stateDir, changeId, jobId, attemptId, seq }) {
  assertIdentifier(changeId, "changeId");
  assertIdentifier(jobId, "jobId");
  assertIdentifier(attemptId, "attemptId");
  const handle = openChange({ stateDir, changeId });
  const state = viewsFor(handle.state);
  const attempt = state.attempt(jobId, attemptId);
  const entry = [...attempt.progress, ...attempt.blockers].find((item) => item.seq === seq);
  if (!entry) {
    throw fail("not-found", `no committed progress/blocker entry at seq ${seq} on attempt '${attemptId}'`);
  }
  if (!entry.complete) {
    throw fail("incomplete-text", `committed entry at seq ${seq} has missing continuation parts; it cannot be published until the record is complete`);
  }
  const kind = attempt.progress.some((item) => item.seq === seq) ? "worker.progress" : "worker.blocker";
  return {
    kind,
    seq: entry.seq,
    at: entry.at,
    text: entry.note,
    jobRole: state.job(jobId).role,
    tasks: [`change:${changeId}`, `job:${jobId}`, `attempt:${attemptId}`, `progress:${entry.seq}`],
  };
}

/**
 * The default relay sink for `publishCommittedProgress`: push the committed
 * body to `recipientAgent` with the worker attempt's own recorded identity as
 * the producer (the progress originates from the worker; the parent only
 * transports it). Configuration is explicit — never derived from the pushed
 * text.
 */
export function relayProgressSink({ relay, fromSessionId, recipientAgent, changeId }) {
  assertPiSessionId(fromSessionId, "producer session id");
  parseRelayAgentId(recipientAgent, "recipientAgent");
  return async (delivery) => {
    const { eventId, status } = await sendAgentMessage({
      relayOrClient: relay,
      from: fromSessionId,
      recipientAgent,
      project: projectSlugForChange(changeId),
      role: delivery.meta.role,
      tasks: delivery.meta.tasks,
      content: delivery.text,
    });
    return { state: status, eventId };
  };
}

/**
 * Publish one already-committed progress/blocker entry.
 *
 * `sink` is injectable so the parent can reuse its existing Architect
 * notification transport in phase 2b; without one, `relay` +
 * `recipientAgent` build the default relay sink. A missing sink or a sink
 * failure is reported as `push: { status: "unavailable" }` while the committed
 * entry stays retrievable and retryable (no phantom progress, no second
 * authority). The sink receives
 * `{ eventId, kind, jobId, attemptId, seq, text, meta }` and returns
 * `{ state, eventId?, reason? }`.
 */
export async function publishCommittedProgress({
  stateDir,
  changeId,
  jobId,
  attemptId,
  seq,
  relay = null,
  recipientAgent = null,
  sink = null,
}) {
  const envelope = buildProgressEnvelope({ stateDir, changeId, jobId, attemptId, seq });
  const sinkFn = sink
    ?? (relay && recipientAgent
      ? relayProgressSink({
        relay,
        fromSessionId: receiverBindingOf(openChange({ stateDir, changeId }).views.attempt(jobId, attemptId))?.piSession,
        recipientAgent,
        changeId,
      })
      : null);
  const delivery = {
    eventId: `progress-${changeId}-${seq}`,
    kind: envelope.kind,
    jobId,
    attemptId,
    seq: envelope.seq,
    text: envelope.text,
    meta: { tasks: envelope.tasks, role: envelope.jobRole, changeId },
  };
  if (!sinkFn) {
    return { ok: true, committed: { seq: envelope.seq, kind: envelope.kind }, push: { status: "unavailable", reason: "no sink or relay recipient was supplied" } };
  }
  try {
    const result = await sinkFn(delivery);
    return { ok: true, committed: { seq: envelope.seq, kind: envelope.kind }, push: { status: result?.state ?? "unknown", eventId: result?.eventId ?? null, reason: result?.reason ?? null } };
  } catch (error) {
    return { ok: true, committed: { seq: envelope.seq, kind: envelope.kind }, push: { status: "unavailable", reason: String(error?.message ?? error).slice(0, 300) } };
  }
}
