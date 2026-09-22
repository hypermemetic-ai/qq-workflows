// Shared runner lifecycle for the communication-enabled runner (phase 2b).
//
// ONE integration layer used by BOTH runner entry points — the native workflow
// operations (`workflow/operations.mjs`) and the MCP compatibility server
// (`bin/mcp-server.mjs`) — so that record creation, launch/attempt transitions,
// binding preparation, amendment composition/submission, status projection,
// cancellation intent, result outcomes and progress recovery are never
// independently implemented per caller. Caller-specific concerns remain
// adapters: argument names, live process handles, public ids, and the
// notification transport.
//
// Source-of-truth contract (documented; enforced by construction):
//
//   * The change record (`workflow/change-record.mjs`) is the SOLE workflow
//     authority for a dispatched runner job: assignment revisions, amendment
//     submissions and their raw instructions, transport-push correlation,
//     worker acknowledgements, cancellation intent, receiver admission and
//     validated outcomes. For a newly dispatched Pi runner job the record's
//     change id IS the public runner/job id and the dispatch opens exactly one
//     attempt (a fresh UUID) — a direct lookup convention, not a second
//     authority. Every shared API here keeps the shared record shape: multiple
//     jobs and attempts per record remain fully expressible.
//   * The relay journal is subordinate durable TRANSPORT bookkeeping: it can
//     prove an envelope was accepted, delivered, and receipted — never that a
//     worker incorporated anything.
//   * jobs.json records, MCP RUNNERS trackers and notification journals keep
//     live handles or rebuildable compatibility projections (identity, live
//     process handles, push event-id correlation). They never decide a job's
//     status, cancellation, effective revision or terminal outcome: the
//     check_runner projection here is rebuilt from the authoritative record on
//     every read, so a stale compatibility cache cannot override it.
//   * The parent-side relay recipient is a WORKFLOW CONSUMER address: a
//     deterministic UUID-form transport address derived from the repository
//     root and the coordinator's actual owner routing (the workflow session
//     key / session id). It is NOT an observed Pi session and is never
//     presented as one — MCP coordinators are Codex sessions, and a native
//     coordinator's session identity is not a Pi session either. A restarted
//     parent for the same owner derives the same address; unrelated owners
//     derive different addresses, so they never consume one another's
//     obligations.
//   * Progress bridging is receipt-honest in both directions: an incoming
//     relay delivery is verified against the authoritative record (source
//     job/attempt/binding, committed sequence, committed note verbatim) and
//     the outgoing notification is rebuilt from the committed note — the
//     transport text is never authority. The relay obligation is acknowledged
//     only AFTER the existing durable notification system accepted
//     responsibility (its journal record was written); a relay/journal
//     acknowledgement does not mean the Architect acted on it.
//
// Legacy (non-Pi or otherwise non-communication) runner dispatch keeps its
// exact prior behavior; steering such a runner is explicitly refused — it is
// never a silent stdin write pretending delivery.

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  assertActorId,
  assertIdentifier,
  createChange,
  openChange,
  viewsFor,
} from "./change-record.mjs";
import {
  COMMUNICATION_BINDING_ENV,
  COMMUNICATION_BINDING_SCHEMA,
  DEFAULT_DRAIN_MS,
  PI_SESSION_ID_PATTERN,
  acquireRelayRuntime,
  projectSlugForChange,
  pushedUpdateText,
  relaySocketPath,
  resolveRelayInstall,
  sendAgentMessage,
  submitAmendment,
  transportStatusOf,
  validateCommunicationBinding,
} from "./communication.mjs";
import { deliveryGuard, parseMessage } from "./communication-receiver.mjs";
import { readJob, reconcileJob, recordTerminal, writeJob } from "./jobs.mjs";
import { readNotification, routeNotification } from "./notify.mjs";
import { acceptRunnerResult, renderRunnerFindings } from "./results.mjs";
import { saveReport } from "./reports.mjs";

// Shared transport entry points re-exported for the callers, so native
// operations and MCP reach the ONE relay runtime implementation through this
// module (never a private copy).
export { acquireRelayRuntime };

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** `now` may be supplied as a numeric instant or a clock function. */
function normalizeNow(now) {
  if (typeof now === "function") return now;
  const value = Number(now);
  return () => value;
}

const sleep = (ms) => new Promise((done) => {
  const timer = setTimeout(done, ms);
  if (typeof timer.unref === "function") timer.unref();
});

function clampText(value, max) {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} chars omitted]`;
}

// Honest terminal semantics for a LAUNCHED-BUT-UNBOUND setup failure: the
// attempt never reached an observed start, so only a truthful failure (never a
// completion) can be recorded — and only when the record itself exists.
function recordSetupFailure({ stateDir, jobId, attemptId, actor, reason, nowMs }) {
  try {
    recordRunnerOutcome({
      stateDir,
      changeId: jobId,
      jobId,
      attemptId,
      status: "failed",
      summary: `runner communication setup failed: ${clampText(reason, 500)}`,
      actor,
      now: nowMs,
    });
  } catch {
    /* the record is unavailable: the caller already reports the failure */
  }
}

// A runtime actor id that satisfies the record's actor-id pattern for any
// owner routing (session keys are arbitrary caller strings).
export function runtimeActorIdFor(ownerRouting) {
  const safe = String(ownerRouting ?? "unowned").replace(/[^\w.@:/+-]/g, "_").slice(0, 120);
  return `runtime-${safe || "unowned"}`;
}

// ---------------------------------------------------------------------------
// Assignment composition (the model-facing assignment view)
// ---------------------------------------------------------------------------

/** The exact updates heading and precedence sentence appended when a runner
 *  assignment carries amendments (coordinator-authored copy; used verbatim). */
export const ASSIGNMENT_UPDATES_HEADING = "## Assignment updates";
export const ASSIGNMENT_UPDATES_PRECEDENCE =
  "Apply these updates in revision order. A later update takes precedence where it conflicts with an earlier instruction.";

/**
 * Compose the FULL assignment view: the original task (with target-path
 * constraints) verbatim, then — when amendments exist — the exact heading and
 * precedence sentence followed by every amendment's verbatim text in committed
 * revision order, each with its revision label. Instructions are never
 * summarized, paraphrased, or replaced by the latest message.
 */
export function composeAssignmentText({ task, targetPaths = [], amendments = [] } = {}) {
  if (typeof task !== "string" || task.trim() === "") {
    throw fail("invalid-arguments", "task (the original assignment text) is required");
  }
  let text = task;
  if (Array.isArray(targetPaths) && targetPaths.length > 0) {
    text += `\n\nTarget paths to inspect:\n${targetPaths.join("\n")}`;
  }
  const ordered = (Array.isArray(amendments) ? amendments : [])
    .filter((entry) => entry && Number.isInteger(entry.revision) && typeof entry.text === "string" && entry.text.trim() !== "")
    .sort((a, b) => a.revision - b.revision);
  if (ordered.length > 0) {
    text += `\n\n${ASSIGNMENT_UPDATES_HEADING}\n${ASSIGNMENT_UPDATES_PRECEDENCE}\n`;
    text += ordered.map((entry) => `\n[revision ${entry.revision}]\n${entry.text}`).join("\n");
  }
  return text;
}

/** The exact parent-facing progress notification wrapper. */
export function progressNotificationText({ jobId, kind, seq, attemptId, message }) {
  return `Runner ${jobId} reported ${kind} at sequence ${seq} (attempt ${attemptId}):\n${message}`;
}

/** Deterministic progress notification id: change/job/attempt/sequence. */
export function progressNotificationEventId({ changeId, jobId, attemptId, seq }) {
  return `runner:${jobId}:progress:${changeId}:${attemptId}:${seq}`;
}

// ---------------------------------------------------------------------------
// The workflow consumer address (parent-side relay recipient)
// ---------------------------------------------------------------------------

/**
 * The stable, UUID-form transport address of the parent's workflow consumer
 * for one repository + owner routing. Deterministic: a restarted parent for
 * the same owner recovers the same address without any identity database;
 * different owners (and different repositories) derive different addresses.
 * This is a workflow consumer address — never an observed Pi session id.
 */
export function workflowConsumerAddress({ root, ownerRouting } = {}) {
  if (!root) throw fail("invalid-arguments", "root (the repository root) is required");
  const routing = typeof ownerRouting === "string" && ownerRouting.trim() !== ""
    ? ownerRouting.trim()
    // No owner identity: each parent process is its own (unshared) consumer.
    // Recovery across a restart is impossible without an owner identity, and
    // unrelated parents must never consume one another's obligations.
    : `unowned-${process.pid}`;
  const digest = createHash("sha256")
    .update(`qq-workflow-consumer\u0000${root}\u0000${routing}`)
    .digest("hex");
  // UUID v4-shaped formatting of the digest (version and variant nibbles set),
  // matching the relay's `agents/<bare-uuid>` recipient form.
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    ((parseInt(digest[16], 16) & 0x3) | 0x8).toString(16) + digest.slice(17, 20),
    digest.slice(20, 32),
  ].join("-");
}

// ---------------------------------------------------------------------------
// Parent progress consumer: verify-against-record, bridge, acknowledge
// ---------------------------------------------------------------------------

// Bounded wait between relay polls while a consumer is active, and the bounded
// drain window observed on the last release before the transport stops.
export const CONSUMER_POLL_WAIT_MS = 2_000;
export const CONSUMER_DRAIN_MS = 3_000;
export const CONSUMER_RECONNECT_MS = 500;
// Bounded check_runner projection caps.
export const PENDING_UPDATE_VIEW_MAX = 8;
export const UNRESOLVED_REVISION_VIEW_MAX = 8;

/** Parse the structured tasks of a return-direction envelope. */
function parseProgressTasks(tasks) {
  let changeId = null;
  let jobId = null;
  let attemptId = null;
  let kind = null;
  let seq = null;
  let amendment = null;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (typeof task !== "string") continue;
    if (task.startsWith("change:")) changeId = task.slice("change:".length) || null;
    else if (task.startsWith("job:")) jobId = task.slice("job:".length) || null;
    else if (task.startsWith("attempt:")) attemptId = task.slice("attempt:".length) || null;
    else if (task.startsWith("progress:")) { kind = "progress"; seq = Number.parseInt(task.slice("progress:".length), 10); }
    else if (task.startsWith("blocker:")) { kind = "blocker"; seq = Number.parseInt(task.slice("blocker:".length), 10); }
    else if (task.startsWith("amendment:")) amendment = task.slice("amendment:".length) || null;
  }
  if (!changeId || !jobId || !attemptId || !kind || !Number.isSafeInteger(seq) || seq < 1) return null;
  // Amendment pushes are coordinator→worker direction; a parent consumer never
  // fulfils one.
  if (amendment) return null;
  return { changeId, jobId, attemptId, kind, seq };
}

/**
 * Verify an incoming progress/blocker envelope against the authoritative
 * change record. Everything the outgoing notification claims is rebuilt from
 * the committed entry; the transport text is only ever CORROBORATION (it must
 * match the committed note verbatim, or the envelope is refused).
 *
 * Verifies: the change/job/attempt exist in the record, the exact sequence is
 * committed as a complete progress/blocker entry, the committed note equals
 * the envelope body verbatim, the sending session is the attempt's RECORDED
 * receiver binding (a wrong session cannot push another job's work), and the
 * project slug matches the change. Never trusts transport text/tasks.
 */
export function verifyCommittedProgress({ stateDir, changeId, jobId, attemptId, kind, seq, fromSessionId, text, project = null }) {
  assertIdentifier(changeId, "changeId");
  assertIdentifier(jobId, "jobId");
  assertIdentifier(attemptId, "attemptId");
  if (kind !== "progress" && kind !== "blocker") throw fail("invalid-envelope", `unsupported progress kind '${kind}'`);
  if (!Number.isSafeInteger(seq) || seq < 1) throw fail("invalid-envelope", `invalid committed sequence ${seq}`);
  let handle;
  try {
    handle = openChange({ stateDir, changeId });
  } catch (error) {
    throw fail("unknown-source", `the change record for '${changeId}' is unavailable: ${error.message}`);
  }
  const state = handle.state;
  const views = viewsFor(state);
  if (project !== null && project !== projectSlugForChange(changeId)) {
    throw fail("unknown-source", `the envelope project '${project}' does not match change '${changeId}'`);
  }
  let attempt;
  try {
    attempt = views.attempt(jobId, attemptId);
  } catch {
    throw fail("unknown-source", `attempt '${attemptId}' on job '${jobId}' is not committed in change '${changeId}'`);
  }
  const entries = kind === "progress" ? attempt.progress : attempt.blockers;
  const entry = entries.find((item) => item.seq === seq);
  if (!entry) throw fail("unknown-source", `no committed ${kind} entry at sequence ${seq} on attempt '${attemptId}'`);
  if (!entry.complete) throw fail("incomplete-entry", `the committed ${kind} entry at sequence ${seq} has missing continuation parts`);
  if (typeof text !== "string" || text !== entry.note) {
    throw fail("uncommitted-content", `the envelope body does not match the committed ${kind} note at sequence ${seq}`);
  }
  const binding = attempt.started?.identity ?? null;
  if (!binding?.piSession) throw fail("unknown-source", `attempt '${attemptId}' has no recorded receiver binding`);
  if (fromSessionId !== binding.piSession) {
    throw fail("unknown-source", "the envelope sender is not the attempt's recorded receiver binding");
  }
  return { note: entry.note, at: entry.at, jobRole: views.job(jobId).role };
}

/**
 * Create the parent-side progress consumer for one workflow consumer address.
 *
 * The consumer polls the relay (the same long-poll discipline the worker
 * receiver uses), and for every delivery:
 *   1. parses the envelope with the production payload gate (a foreign or
 *      malformed envelope is BLOCKED on the journal, never delivered);
 *   2. verifies it against the authoritative change record
 *      (`verifyCommittedProgress`);
 *   3. rebuilds the outgoing notification from the COMMITTED note with the
 *      exact wrapper text, and routes it through the caller's Architect
 *      notification transport with a deterministic event id
 *      (`runner:<jobId>:progress:<changeId>:<attemptId>:<seq>`);
 *   4. acknowledges the relay obligation only after the existing durable
 *      notification system accepted responsibility (its journal record was
 *      written). A repeated delivery or a parent restart re-checks the
 *      journal first, so an already-accepted progress notification is never
 *      sent twice; a transport failure RETRIES the obligation, leaving
 *      recoverable pending work instead of deleting it.
 *
 * `transport` is the caller's existing notification transport ({ name,
 * deliver }) — the external delivery boundary tests replace with a fake sink.
 * With no transport configured, progress stays committed in the record and
 * the obligation is retried (reported as unavailable, never as delivered).
 *
 * `routes` is the shared per-job route registry (jobId -> { transport,
 * workflowRouting }) maintained by `acquireRunnerConsumer`: the transport and
 * session routing used for ONE message are selected per MESSAGE from the
 * verified notification's job id — never from whichever worker's dispatch
 * closure happened to create the shared consumer first.
 */
export function createParentProgressConsumer({
  relay,
  consumerId,
  stateDir,
  transport = null,
  journalDir = null,
  workflowRouting = null,
  cap = null,
  ownsChange = null,
  routes = null,
  pollWaitMs = CONSUMER_POLL_WAIT_MS,
  reconnectMs = CONSUMER_RECONNECT_MS,
  sleepImpl = sleep,
  now = Date.now,
} = {}) {
  if (!relay) throw fail("invalid-arguments", "a relay handle is required");
  if (!PI_SESSION_ID_PATTERN.test(consumerId ?? "")) {
    throw fail("invalid-arguments", "consumerId must be a UUID-form workflow consumer address");
  }
  if (!stateDir || !isAbsolute(stateDir)) throw fail("invalid-arguments", "stateDir must be an absolute path");
  const consumerAgentId = `agents/${consumerId}`;
  const resolvedJournalDir = journalDir ?? stateDir;
  let running = false;
  let stopRequested = false;
  let loopPromise = null;

  // Route one verified envelope through the caller's notification system.
  // Dedupe BEFORE sending: an already-accepted/queued/delivered journal record
  // means the durable notification system already holds responsibility for
  // this exact deterministic event id, so a repeated relay delivery (or a
  // redelivery after a crash between route and relay-ack) must not send it
  // again. A failed record stays retryable.
  async function routeOnce({ eventId, jobId, text }) {
    const existing = readNotification(resolvedJournalDir, eventId);
    if (existing && existing.state && existing.state !== "failed") {
      return { state: existing.state, duplicate: true, reason: null };
    }
    // Per-message attribution: the transport and session routing come from the
    // VERIFIED notification's job id (the shared registry), never from the
    // closure of whichever dispatch created the shared consumer first.
    const route = (routes && typeof routes.get === "function" ? routes.get(jobId) : null) ?? {};
    const activeTransport = route.transport ?? transport;
    const activeWorkflow = route.workflowRouting ?? workflowRouting;
    if (!activeTransport || typeof activeTransport.deliver !== "function") {
      return { state: "failed", duplicate: false, reason: "no architect notification transport is configured" };
    }
    const routed = await routeNotification({
      stateDir: resolvedJournalDir,
      eventId,
      jobId,
      role: "runner",
      workflow: activeWorkflow,
      text,
      reportText: text,
      transport: activeTransport,
      ...(cap ? { cap } : {}),
      now: now(),
    });
    return {
      state: routed?.state ?? "failed",
      duplicate: routed?.duplicate === true,
      reason: routed?.delivery?.reason ?? routed?.transportResult?.reason ?? null,
    };
  }

  async function handleDelivery(delivery) {
    const client = await relay.client();
    const guard = deliveryGuard(delivery);
    let message = null;
    try {
      message = parseMessage(delivery.record);
    } catch {
      message = null;
    }
    if (!message) {
      await client.block({ ...guard, reason: "unsupported agent message payload" });
      return { handled: "blocked" };
    }
    const refs = parseProgressTasks(message.tasks);
    if (!refs) {
      await client.block({ ...guard, reason: "the envelope does not reference a committed progress/blocker sequence" });
      return { handled: "blocked" };
    }
    let verification;
    try {
      verification = verifyCommittedProgress({
        stateDir,
        changeId: refs.changeId,
        jobId: refs.jobId,
        attemptId: refs.attemptId,
        kind: refs.kind,
        seq: refs.seq,
        fromSessionId: message.from,
        text: message.content,
        project: message.project,
      });
    } catch (error) {
      await client.block({ ...guard, reason: `unverified progress envelope: ${clampText(error.message, 200)}` });
      return { handled: "blocked", reason: error.code };
    }
    if (typeof ownsChange === "function" && !ownsChange({ changeId: refs.changeId, jobId: refs.jobId })) {
      await client.block({ ...guard, reason: "the referenced job is not owned by this workflow consumer" });
      return { handled: "blocked", reason: "not-owned" };
    }
    // The outgoing notification is rebuilt from the committed note, never from
    // the transport text.
    const text = progressNotificationText({
      jobId: refs.jobId,
      kind: refs.kind,
      seq: refs.seq,
      attemptId: refs.attemptId,
      message: verification.note,
    });
    const eventId = progressNotificationEventId({ changeId: refs.changeId, jobId: refs.jobId, attemptId: refs.attemptId, seq: refs.seq });
    let result;
    try {
      result = await routeOnce({ eventId, jobId: refs.jobId, text });
    } catch (error) {
      result = { state: "failed", duplicate: false, reason: clampText(error?.message ?? String(error), 200) };
    }
    if (result.state === "failed" || result.state === "unknown") {
      // Leave the obligation recoverable: it will be redelivered and retried.
      await client.retry({ ...guard, reason: `progress notification ${result.state}: ${clampText(result.reason ?? "transport unavailable", 160)}` });
      return { handled: "retried", state: result.state };
    }
    // The durable notification system accepted responsibility (its journal
    // record is written) — the relay obligation can settle. This ack is
    // transport bookkeeping only; it never means the Architect acted.
    await client.acknowledge(guard);
    return { handled: "acked", state: result.state, duplicate: result.duplicate === true };
  }

  async function pollOnce(waitMs) {
    const client = await relay.client();
    return client.next({
      consumer_type: "recipient",
      consumer_id: consumerAgentId,
      generation: 0,
      endpoint_token: `agent-messages/${randomUUID()}`,
      wait_ms: waitMs,
    });
  }

  async function loop() {
    while (!stopRequested) {
      try {
        const result = await pollOnce(pollWaitMs);
        if (result?.delivery) await handleDelivery(result.delivery);
      } catch {
        if (!stopRequested) await sleepImpl(reconnectMs);
      }
    }
  }

  return {
    consumerId,
    consumerAgentId,
    get running() {
      return running;
    },
    /** Establish the subscription BEFORE any worker is launched: journal
     *  obligations bind to a live consumer, so the first poll must happen
     *  before the first push can be routed. */
    async prime() {
      try {
        const result = await pollOnce(0);
        return { ok: true, delivery: result?.delivery ?? null };
      } catch (error) {
        return { ok: false, reason: clampText(error?.message ?? String(error), 200) };
      }
    },
    start() {
      if (running) return;
      running = true;
      stopRequested = false;
      loopPromise = loop();
    },
    /**
     * Stop the poll loop and drain what is already journal-accepted, bounded.
     * Pending obligations are never deleted: whatever is not delivered here
     * stays in the relay journal for the next consumer of this address.
     */
    async drainAndStop({ boundedMs = CONSUMER_DRAIN_MS } = {}) {
      if (!running) return { drained: 0 };
      stopRequested = true;
      if (loopPromise) {
        try { await loopPromise; } catch { /* the loop reports its own errors */ }
      }
      running = false;
      const deadline = Date.now() + boundedMs;
      let drained = 0;
      while (Date.now() < deadline) {
        try {
          const result = await pollOnce(0);
          if (!result?.delivery) break;
          await handleDelivery(result.delivery);
          drained += 1;
        } catch {
          break;
        }
      }
      return { drained };
    },
    /** Test/diagnostic surface: handle one raw delivery document directly. */
    async handleRawDelivery(delivery) {
      return handleDelivery(delivery);
    },
  };
}

// ---------------------------------------------------------------------------
// Refcounted consumer/relay runtime per (stateDir, owner)
// ---------------------------------------------------------------------------

const CONSUMERS = new Map();
// In-flight shared-consumer creation per key: two CONCURRENT acquisitions of
// the same (stateDir, owner) consumer coalesce onto ONE creation (one relay
// runtime, one consumer, one prime) instead of racing and leaking a poll loop.
const CONSUMER_STARTS = new Map();

/**
 * Acquire (or join) the shared progress consumer for one workflow state
 * directory and owner. One owned relay runtime and one consumer serve every
 * runner of the same parent/owner; reference counting keeps the transport
 * alive while any holder needs it, and releasing one worker never destroys
 * another worker's transport or pending messages.
 *
 * Each call may register a PER-JOB route (`jobId` + `transport` +
 * `workflowRouting`): the shared consumer attributes every outgoing
 * notification per MESSAGE from the verified job id, so a second runner's
 * progress is never delivered through the first dispatch's transport closure.
 *
 * The subscription is established BEFORE any worker is launched.
 */
export async function acquireRunnerConsumer({
  stateDir,
  root,
  ownerRouting,
  env = process.env,
  transport = null,
  journalDir = null,
  workflowRouting = null,
  cap = null,
  ownsChange = null,
  jobId = null,
  pollWaitMs = CONSUMER_POLL_WAIT_MS,
} = {}) {
  if (!stateDir || !isAbsolute(stateDir)) throw fail("invalid-arguments", "stateDir must be an absolute path");
  const consumerId = workflowConsumerAddress({ root, ownerRouting });
  const key = `${stateDir}\u0000${consumerId}`;
  let entry = CONSUMERS.get(key);
  if (!entry) {
    let start = CONSUMER_STARTS.get(key);
    if (!start) {
      start = (async () => {
        const acquired = await acquireRelayRuntime({ stateDir, env });
        if (!acquired.ok) return { ok: false, code: acquired.code, reason: acquired.reason };
        // The shared per-job route registry: every message selects its own
        // transport/session routing from the verified notification's job id.
        const routes = new Map();
        const consumer = createParentProgressConsumer({
          relay: acquired.relay,
          consumerId,
          stateDir,
          transport,
          journalDir,
          workflowRouting,
          cap,
          ownsChange,
          routes,
          pollWaitMs,
        });
        const primed = await consumer.prime();
        if (!primed.ok) {
          // Release only what was acquired; the journal-backed relay keeps any
          // pending obligations for the next consumer of this address.
          await acquired.relay.release();
          return { ok: false, code: "unavailable", reason: `the workflow consumer could not subscribe to the relay: ${primed.reason}` };
        }
        consumer.start();
        const created = { key, consumerId, relay: acquired.relay, consumer, routes, refs: 0 };
        CONSUMERS.set(key, created);
        return { ok: true, entry: created };
      })();
      CONSUMER_STARTS.set(key, start);
    }
    let result;
    try {
      result = await start;
    } finally {
      if (CONSUMER_STARTS.get(key) === start) CONSUMER_STARTS.delete(key);
    }
    if (!result.ok) return result;
    entry = result.entry;
  }
  // Per-job route registration (idempotent per job): the transport closure and
  // owner routing that belong to THIS job, used whenever its verified messages
  // arrive — regardless of which dispatch created the shared consumer.
  if (jobId) entry.routes.set(jobId, { transport, workflowRouting });
  entry.refs += 1;
  return {
    ok: true,
    consumerId,
    relay: entry.relay,
    consumer: entry.consumer,
    release: () => releaseRunnerConsumer(entry),
  };
}

/** Drop one hold on the shared consumer. The LAST hold drains bounded, stops
 *  the poll loop, and releases the relay reference (the last relay hold stops
 *  an OWNED relay child; pending obligations survive in the journal). */
export async function releaseRunnerConsumer(entry) {
  if (!entry || entry.refs <= 0) return { released: false, reason: "not held" };
  entry.refs -= 1;
  if (entry.refs > 0) return { released: false, reason: `shared by ${entry.refs} holder(s) in this process` };
  CONSUMERS.delete(entry.key);
  try {
    await entry.consumer.drainAndStop();
  } catch {
    /* a drain failure never deletes pending work */
  }
  try {
    await entry.relay.release();
  } catch {
    /* release is best-effort; the journal survives either way */
  }
  return { released: true };
}

/** Release every consumer hold this process still owns (test/shutdown seam). */
export async function releaseAllRunnerConsumers() {
  for (const entry of [...CONSUMERS.values()]) {
    entry.refs = 1;
    await releaseRunnerConsumer(entry);
  }
}

// ---------------------------------------------------------------------------
// Dispatch prelude: record → relay → consumer subscription → binding
// ---------------------------------------------------------------------------

/**
 * Prepare the full communication context for ONE newly dispatched Pi runner
 * job, in the dispatch order the integration requires:
 *
 *   1. record the original assignment (revision 1: the task and target-path
 *      constraints verbatim — the exact text the worker will be prompted
 *      with), register the job, and record the attempt's unresolved launch
 *      intent — all in the authoritative change record, whose change id is
 *      the public runner/job id and whose state directory is the caller's
 *      `stateDirFor(root, env)` (threaded unchanged through the binding, the
 *      relay and every reader);
 *   2. acquire the healthy PRIVATE relay runtime for that state directory;
 *   3. establish (or join) the owner's return-consumer subscription BEFORE
 *      any worker exists — journal obligations need a live consumer;
 *   4. prepare the explicit, structurally validated communication binding
 *      (the return-direction recipient is the workflow consumer address).
 *
 * Nothing is spawned here. On any failure the caller records an honest
 * terminal failure and this helper has already released exactly what it
 * acquired — a new Pi runner is NEVER silently downgraded to legacy steering.
 *
 * Returns `{ ok: true, jobId, changeId, attemptId, binding, bindingEnv,
 * consumerId, release }` or `{ ok: false, code, reason }`.
 */
export async function prepareRunnerCommunication({
  stateDir,
  root,
  env = process.env,
  jobId,
  task,
  targetPaths = [],
  cwd = null,
  ownerRouting,
  runtimeActorId = null,
  drainMs = DEFAULT_DRAIN_MS,
  transport = null,
  journalDir = null,
  workflowRouting = null,
  cap = null,
  ownsChange = null,
  now = Date.now(),
} = {}) {
  if (!stateDir || !isAbsolute(stateDir)) throw fail("invalid-arguments", "stateDir must be an absolute path");
  assertIdentifier(jobId, "jobId");
  const nowMs = normalizeNow(now)();
  const attemptId = randomUUID();
  const workerActorId = `worker-${attemptId}`;
  const resolvedRuntimeActorId = runtimeActorId ?? runtimeActorIdFor(ownerRouting);
  assertActorId(resolvedRuntimeActorId);
  const actor = { kind: "runtime", id: resolvedRuntimeActorId };

  // 1. The authoritative record. The initial assignment is the exact prompt
  //    the runner will receive (task + target-path constraints, verbatim).
  const initialAssignment = composeAssignmentText({ task, targetPaths });
  try {
    createChange({ stateDir, changeId: jobId, actor, title: `runner ${jobId}`, commandId: `create-${jobId}`, now: nowMs });
    const handle = openChange({ stateDir, changeId: jobId });
    handle.append(
      "assignment.revised",
      { revision: 1, predecessor: null, scope: { kind: "change" }, assignment: { instructions: initialAssignment } },
      { context: { actor, jobId }, commandId: `revise-${jobId}-r1`, now: nowMs },
    );
    handle.append(
      "job.registered",
      { role: "runner", pinnedRevision: 1 },
      { context: { actor, jobId }, commandId: `register-${jobId}`, now: nowMs },
    );
    // The launch intent preserves the ORIGINAL launch context in the
    // authoritative record: working directory, owner/session routing and
    // target paths (the full task text is revision 1 itself, verbatim).
    handle.append(
      "attempt.launch_intent",
      {
        note: `dispatched by ${resolvedRuntimeActorId}`,
        cwd: typeof cwd === "string" && cwd ? cwd : null,
        owner: typeof ownerRouting === "string" && ownerRouting ? ownerRouting : null,
        targetPaths: Array.isArray(targetPaths) && targetPaths.length ? targetPaths.map(String) : null,
      },
      { context: { actor, jobId, attemptId }, commandId: `launch-${jobId}-${attemptId}`, now: nowMs },
    );
  } catch (error) {
    return { ok: false, code: "record-unavailable", reason: `the runner change record could not be prepared: ${error.message}` };
  }

  // 2 + 3. The private relay runtime and the owner's consumer subscription.
  //
  // Any failure from here on records an honest terminal FAILURE in the change
  // record (allowed for a never-started attempt — never a success) and releases
  // exactly what was acquired, before the caller settles the compatibility
  // record.
  const consumer = await acquireRunnerConsumer({
    stateDir,
    root,
    ownerRouting,
    env,
    transport,
    journalDir,
    workflowRouting,
    cap,
    ownsChange,
    jobId,
  });
  if (!consumer.ok) {
    recordSetupFailure({ stateDir, jobId, attemptId, actor, reason: consumer.reason, nowMs });
    return { ok: false, code: consumer.code, reason: consumer.reason, outcomeRecorded: true };
  }

  // 4. The validated binding. Every field is runtime-supplied; the recipient
  //    is the WORKFLOW CONSUMER address, not any session's Pi UUID.
  let binding;
  try {
    const install = resolveRelayInstall(env);
    binding = validateCommunicationBinding({
      schema: COMMUNICATION_BINDING_SCHEMA,
      stateDir,
      changeId: jobId,
      jobId,
      attemptId,
      actorId: workerActorId,
      runtimeActorId: resolvedRuntimeActorId,
      role: "runner",
      recipientAgent: `agents/${consumer.consumerId}`,
      socketPath: relaySocketPath(stateDir),
      ...(install.root ? { installRoot: install.root } : {}),
      ...(drainMs !== DEFAULT_DRAIN_MS ? { drainMs } : {}),
    });
  } catch (error) {
    void Promise.resolve(consumer.release()).catch(() => {});
    recordSetupFailure({ stateDir, jobId, attemptId, actor, reason: error.message, nowMs });
    return { ok: false, code: "binding-invalid", reason: error.message, outcomeRecorded: true };
  }
  return {
    ok: true,
    jobId,
    changeId: jobId,
    attemptId,
    binding,
    bindingEnv: { [COMMUNICATION_BINDING_ENV]: JSON.stringify(binding) },
    consumerId: consumer.consumerId,
    relay: consumer.relay,
    consumer: consumer.consumer,
    release: consumer.release,
  };
}

// ---------------------------------------------------------------------------
// Amendments: composition, submission, delivery correlation, retry
// ---------------------------------------------------------------------------

/**
 * The ordered update entries a job's assignment view is composed from: every
 * job-targeted revision in committed order, with the coordinator's raw
 * instruction for it — from the amendment's recorded note when one was
 * admitted for delivery, else from the revision's own recorded note (a
 * revision the record authored but whose submission was refused is still an
 * instruction the coordinator gave, and it stays visible as unresolved).
 *
 * Records written before raw instruction notes existed (the first receiver
 * revision) replay unchanged but carry no recoverable instruction text; such
 * entries are excluded from a NEW composition (their text cannot be
 * reproduced verbatim) and stay visible as the unresolved revisions they are.
 */
function updateEntriesForJob(handle, jobId) {
  const state = handle.state;
  const views = viewsFor(state);
  const job = state.jobs[jobId];
  if (!job) throw fail("not-found", `unknown job '${jobId}'`);
  const jobView = views.job(jobId);
  const amendmentByRevision = new Map(jobView.amendments.map((entry) => [entry.revision, entry]));
  const entries = [];
  for (const revisionEntry of state.revisions) {
    if (revisionEntry.scope?.kind !== "job" || revisionEntry.scope.jobId !== jobId) continue;
    const revision = revisionEntry.revision;
    const amendment = amendmentByRevision.get(revision) ?? null;
    let text = amendment?.note ?? null;
    let complete = amendment ? amendment.noteComplete !== false : true;
    if (!amendment || text == null) {
      const view = views.assignment({ revision });
      text = view?.note ?? null;
      complete = view ? view.noteComplete !== false : false;
    }
    entries.push({ revision, text: typeof text === "string" ? text : "", complete, amendmentId: amendment?.amendmentId ?? null });
  }
  return entries.sort((a, b) => a.revision - b.revision);
}

/**
 * Submit ONE additional instruction for a communication-enabled runner as an
 * assignment update, through the shared lifecycle:
 *
 *   1. the full new assignment is COMPOSED from the record's original
 *      assignment (revision text verbatim) and the ordered committed
 *      amendments — never replacing the task with the latest message, never
 *      concatenating onto an obsolete revision — and states latest-instruction
 *      precedence with the exact coordinator-authored copy;
 *   2. `submitAmendment` records the revision and the delivery obligation
 *      BEFORE any push (its revision-race protocol is reused unchanged, so
 *      concurrent submissions preserve both instructions exactly once with
 *      deterministic ordering);
 *   3. the push correlation (relay event id + observed transport status) is
 *      recorded durably in the change record (`amendment.pushed`) so a parent
 *      restart can inspect and retry a recorded-but-unsent update.
 *
 * Honest outcomes, never conflated:
 *   - `ok: true`  → recorded (+ delivery status as its own fact; acknowledgement
 *     is a LATER, separate fact that check_runner reports);
 *   - `ok: false, code: "not-bound"` → the receiver binding has not been
 *     observed yet; NOTHING was recorded and the caller may retry;
 *   - `ok: false, code: "refused"` → admission closed / attempt terminal /
 *     cancellation intent: any recorded revision stays in the record as an
 *     unresolved update and is reported as such.
 */
export async function steerRunnerLifecycle({
  stateDir,
  changeId,
  jobId,
  message,
  relay = null,
  actor = null,
  amendmentId = null,
  now = Date.now(),
} = {}) {
  assertIdentifier(changeId, "changeId");
  assertIdentifier(jobId, "jobId");
  const nowMs = normalizeNow(now)();
  if (typeof message !== "string" || message.trim() === "") {
    throw fail("invalid-arguments", "message (the additional instruction) is required");
  }
  const handle = openChange({ stateDir, changeId });
  const state = handle.state;
  const job = state.jobs[jobId];
  if (!job) throw fail("not-found", `unknown job '${jobId}' in change '${changeId}'`);
  const attemptId = job.attemptOrder.at(-1) ?? null;
  if (!attemptId) throw fail("not-found", `job '${jobId}' has no recorded attempt`);
  const attemptView = viewsFor(state).attempt(jobId, attemptId);
  // Admission is closed, the attempt is terminal, or cancellation was intented:
  // refuse up front so nothing is recorded that could never be delivered. A
  // closure that commits concurrently with the submission is still caught by
  // the record reducer (race-order B) and surfaces below as a refusal with the
  // recorded revision preserved.
  if (attemptView.phase === "terminal" || attemptView.cancelIntent || attemptView.admissionClosed) {
    const reason = attemptView.cancelIntent
      ? "cancellation was intented for this runner; updates are no longer admitted"
      : attemptView.phase === "terminal"
        ? `the attempt is ${attemptView.phase}; updates are no longer admitted`
        : "the receiver admission is closed; updates are no longer admitted";
    return {
      ok: false,
      code: "refused",
      status: "unresolved",
      jobId,
      attemptId,
      amendmentId: null,
      revision: null,
      revisionRecorded: null,
      delivery: { status: "refused", reason, eventId: null },
      reason,
    };
  }
  const jobView = viewsFor(state).job(jobId);
  const pinnedRevision = jobView.pinnedRevision;
  // The composed text must carry the COMMITTED revision label and exactly the
  // updates committed at composition time, even when concurrent coordinators
  // race for the next revision number and force the record's writer-lock retry.
  // The composition therefore re-reads the authoritative record INSIDE every
  // race attempt (`composeInstructions` is invoked under the writer lock per
  // attempt) — prior updates captured before a lost race are never baked in.
  const composeInstructions = (revision) => {
    const fresh = openChange({ stateDir, changeId });
    const freshViews = viewsFor(fresh.state);
    const base = freshViews.assignment({ revision: pinnedRevision });
    const baseText = typeof base?.assignment === "string" ? base.assignment : base?.assignment?.instructions;
    if (typeof baseText !== "string" || baseText.trim() === "") {
      throw fail("not-found", "the original assignment text is unavailable");
    }
    const priorUpdates = updateEntriesForJob(fresh, jobId)
      .filter((entry) => entry.complete && entry.text.trim() !== "")
      .map((entry) => ({ revision: entry.revision, text: entry.text }));
    return composeAssignmentText({
      task: baseText,
      amendments: [...priorUpdates, { revision, text: message }],
    });
  };
  const result = await submitAmendment({
    stateDir,
    changeId,
    jobId,
    attemptId,
    composeInstructions,
    note: message,
    amendmentId,
    actor: actor ?? { kind: "runtime", id: "qq-workflows-runtime" },
    relay,
    now: nowMs,
  });

  if (result.ok) {
    // Delivery correlation is durably recorded so inspection and retry survive
    // a parent restart. This is transport bookkeeping in the authoritative
    // record — never incorporation.
    if (result.delivery?.eventId || result.delivery?.status) {
      try {
        const fresh = openChange({ stateDir, changeId });
        fresh.append(
          "amendment.pushed",
          { amendmentId: result.amendmentId, pushEventId: result.delivery.eventId ?? null, status: result.delivery.status ?? null },
          // Command IDs are scoped to job+attempt+amendment so two jobs or two
          // attempts in one record can never collide on push correlation.
          { context: { actor: actor ?? { kind: "runtime", id: "qq-workflows-runtime" }, jobId, attemptId }, commandId: `push-${jobId}-${attemptId}-${result.amendmentId}-0`, now: nowMs },
        );
      } catch {
        /* correlation recording is best-effort bookkeeping; the submission
           itself is already durable and the retry path still works */
      }
    }
    return {
      ok: true,
      jobId,
      attemptId,
      amendmentId: result.amendmentId,
      revision: result.revision,
      recorded: true,
      dedupe: result.dedupe === true,
      delivery: result.delivery,
      // Point-in-time facts only: acknowledgement is a later, separate record
      // event that check_runner reports.
      acknowledged: false,
    };
  }
  return {
    ok: false,
    code: result.code ?? "refused",
    status: "unresolved",
    jobId,
    attemptId,
    amendmentId: result.amendmentId ?? null,
    revision: result.revision ?? null,
    revisionRecorded: result.revision ?? null,
    delivery: { status: "refused", reason: result.reason ?? "the record refused the submission", eventId: null },
    reason: result.reason ?? "the record refused the submission",
  };
}

/**
 * Push one already-recorded amendment again — the explicit safe retry path for
 * recorded-but-unsent updates (acknowledgement loss, a lost send reply, a
 * parent restart). The record is the only source of what was requested; the
 * relay journal decides whether a push is still needed:
 *
 *   - an amendment the worker already acknowledged is never touched;
 *   - an attempt that is terminal, admission-closed, or unbound keeps the
 *     request recorded but UNRESOLVED (reported, never re-pushed and never
 *     silently dropped, never turned into a successor launch);
 *   - a push whose relay obligation is queued/in-flight/delivered is not
 *     duplicated (PR115's dedupe semantics preserved; the re-push here only
 *     covers evidence that the push never landed or expired);
 *   - a re-push re-records the correlation (`amendment.pushed`) so inspection
 *     stays possible after a parent restart.
 */
export async function retryPendingRunnerAmendments({
  stateDir,
  changeId,
  jobId,
  relay = null,
  actor = null,
  now = Date.now(),
} = {}) {
  assertIdentifier(changeId, "changeId");
  assertIdentifier(jobId, "jobId");
  const nowMs = normalizeNow(now)();
  const resolvedActor = actor ?? { kind: "runtime", id: "qq-workflows-runtime" };
  const handle = openChange({ stateDir, changeId });
  const state = handle.state;
  const job = state.jobs[jobId];
  if (!job) throw fail("not-found", `unknown job '${jobId}' in change '${changeId}'`);
  const views = viewsFor(state);
  const jobView = views.job(jobId);
  const out = { pushed: [], delivered: [], inFlight: [], unresolved: [], errors: [] };
  for (const amendment of jobView.amendments) {
    if (amendment.acknowledged) {
      out.delivered.push({ amendmentId: amendment.amendmentId, revision: amendment.revision, acknowledged: true });
      continue;
    }
    const attemptId = amendment.targetedAttemptId;
    let attempt = null;
    try {
      attempt = views.attempt(jobId, attemptId);
    } catch {
      out.errors.push({ amendmentId: amendment.amendmentId, reason: `attempt '${attemptId}' is not in the record` });
      continue;
    }
    if (attempt.phase === "terminal" || attempt.cancelIntent || attempt.admissionClosed) {
      out.unresolved.push({
        amendmentId: amendment.amendmentId,
        revision: amendment.revision,
        reason: attempt.cancelIntent
          ? "cancellation was intented"
          : attempt.phase === "terminal"
            ? `attempt is ${attempt.phase}`
            : "receiver admission is closed",
      });
      continue;
    }
    const binding = attempt.started?.identity ?? null;
    if (!binding?.recipient) {
      out.unresolved.push({ amendmentId: amendment.amendmentId, revision: amendment.revision, reason: "the receiver binding has not been observed yet" });
      continue;
    }
    // Transport truth first: a queued/in-flight/delivered obligation needs no
    // second push (a second push would be a NEW relay event the receiver
    // cannot correlate with the first delivery).
    const lastPush = [...amendment.pushes].reverse().find((push) => push.eventId) ?? null;
    if (relay && lastPush) {
      try {
        const client = await relay.client();
        const status = transportStatusOf(await client.status({ event_id: lastPush.eventId, wait_ms: 0 }));
        if (status === "delivered" || status === "delivering" || status === "queued") {
          out.inFlight.push({ amendmentId: amendment.amendmentId, revision: amendment.revision, status });
          continue;
        }
      } catch (error) {
        out.errors.push({ amendmentId: amendment.amendmentId, reason: `transport status unavailable: ${clampText(error?.message ?? String(error), 160)}` });
        continue;
      }
    } else if (lastPush) {
      out.inFlight.push({ amendmentId: amendment.amendmentId, revision: amendment.revision, status: lastPush.status ?? "unknown" });
      continue;
    }
    if (!relay) {
      out.errors.push({ amendmentId: amendment.amendmentId, reason: "no relay runtime was supplied; the recorded update stays pending" });
      continue;
    }
    try {
      // The transport identity indexes OBSERVED relay events, not local
      // attempts: a retry whose earlier send reply was lost reuses the same
      // request id (the relay journal dedupes it and the correlation is
      // recovered), while a deliberately new event after an expired one gets
      // the next index.
      const pushIndex = amendment.pushes.filter((push) => push.eventId).length;
      const pushed = await sendAgentMessage({
        relayOrClient: relay,
        from: binding.piSession,
        recipientAgent: binding.recipient,
        project: projectSlugForChange(changeId),
        role: job.role,
        tasks: [`change:${changeId}`, `job:${jobId}`, `attempt:${attemptId}`, `amendment:${amendment.amendmentId}`, `revision:${amendment.revision}`],
        content: pushedUpdateText(amendment.revision),
        // Stable transport identity: a retry of the SAME push attempt (a lost
        // send reply, acknowledgement loss) dedupes at the relay journal
        // instead of creating a second delivery obligation.
        requestId: `push-req-${jobId}-${attemptId}-${amendment.amendmentId}-${pushIndex}`,
      });
      const fresh = openChange({ stateDir, changeId });
      const pushes = viewsFor(fresh.state).job(jobId).amendments.find((entry) => entry.amendmentId === amendment.amendmentId)?.pushes ?? [];
      fresh.append(
        "amendment.pushed",
        { amendmentId: amendment.amendmentId, pushEventId: pushed.eventId, status: pushed.status },
        // Job+attempt scoped: two jobs or two attempts in one record can never
        // collide on push correlation command IDs.
        { context: { actor: resolvedActor, jobId, attemptId }, commandId: `push-${jobId}-${attemptId}-${amendment.amendmentId}-${pushes.length}`, now: nowMs },
      );
      out.pushed.push({ amendmentId: amendment.amendmentId, revision: amendment.revision, eventId: pushed.eventId, status: pushed.status });
    } catch (error) {
      out.errors.push({ amendmentId: amendment.amendmentId, reason: clampText(error?.message ?? String(error), 200) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cancellation intent and validated outcomes in the authoritative record
// ---------------------------------------------------------------------------

/**
 * Record the cancellation intent for the runner's attempt BEFORE any owned
 * process is signalled. Idempotent; a validated outcome can never follow a
 * completed outcome, and (per the reducer) a cancellation intent forbids any
 * later COMPLETED outcome, so later output can never become success.
 */
export function recordRunnerCancelIntent({ stateDir, changeId, jobId, attemptId, reason = "cancelled by architect", actor = null, now = Date.now() } = {}) {
  assertIdentifier(changeId, "changeId");
  assertIdentifier(jobId, "jobId");
  assertIdentifier(attemptId, "attemptId");
  const nowMs = normalizeNow(now)();
  const resolvedActor = actor ?? { kind: "runtime", id: "qq-workflows-runtime" };
  let handle;
  let attempt;
  try {
    handle = openChange({ stateDir, changeId });
    attempt = handle.state.jobs[jobId]?.attempts[attemptId];
  } catch (error) {
    // A record that cannot be read or replayed can never admit a cancellation:
    // refusing here is what keeps the caller from writing a cache tombstone or
    // signalling a process on failed authority.
    return { ok: false, code: "record-unavailable", reason: `the authoritative change record is unavailable: ${error.message}` };
  }
  if (!attempt) return { ok: false, code: "not-found", reason: `attempt '${attemptId}' is not in the record` };
  if (attempt.cancelIntent) return { ok: true, dedupe: true };
  if (attempt.phase === "terminal") {
    return { ok: false, code: "invalid-transition", reason: "the attempt already has a validated outcome" };
  }
  try {
    const result = handle.append(
      "attempt.cancel_intent",
      { reason: clampText(reason, 2000) },
      { context: { actor: resolvedActor, jobId, attemptId }, commandId: `cancel-${jobId}-${attemptId}`, now: nowMs },
    );
    return { ok: true, dedupe: result.dedupe === true, seq: result.seq };
  } catch (error) {
    return { ok: false, code: error.code ?? "refused", reason: error.message };
  }
}

/**
 * Record the validated outcome for the runner's attempt in the authoritative
 * record. The reducer pins the outcome to the revision the attempt actually
 * worked against (last acknowledged revision, else the job's pin), so a
 * completed outcome for revision A stays a result for A when a later update B
 * was never acknowledged — never silently re-pinned or labelled fulfilled.
 * Idempotent: an attempt has at most one validated outcome.
 */
export function recordRunnerOutcome({ stateDir, changeId, jobId, attemptId, status, summary = "", reportId = null, actor = null, now = Date.now() } = {}) {
  assertIdentifier(changeId, "changeId");
  assertIdentifier(jobId, "jobId");
  assertIdentifier(attemptId, "attemptId");
  const nowMs = normalizeNow(now)();
  const resolvedActor = actor ?? { kind: "runtime", id: "qq-workflows-runtime" };
  let handle;
  let attempt;
  try {
    handle = openChange({ stateDir, changeId });
    attempt = handle.state.jobs[jobId]?.attempts[attemptId];
  } catch (error) {
    return { ok: false, code: "record-unavailable", reason: `the authoritative change record is unavailable: ${error.message}` };
  }
  if (!attempt) return { ok: false, code: "not-found", reason: `attempt '${attemptId}' is not in the record` };
  if (attempt.outcome) {
    // The record already holds the validated outcome and it is AUTHORITATIVE:
    // a later call with a different status (e.g. a 'completed' after a
    // cancellation) never overwrites it and never reports itself accepted.
    const existing = viewsFor(handle.state).attempt(jobId, attemptId).outcome;
    return {
      ok: true,
      dedupe: true,
      recorded: false,
      status: existing.status,
      matches: existing.status === status,
      revision: existing.revision ?? null,
    };
  }
  // A completed outcome requires an observed start; an honest terminal
  // FAILURE (or cancellation) is recordable for a never-started attempt too,
  // so a launched-but-unbound setup failure reaches truthful terminal
  // semantics instead of staying unresolved forever.
  if (attempt.phase !== "started" && status === "completed") {
    return { ok: false, code: "invalid-transition", reason: `attempt '${attemptId}' is '${attempt.phase}'; a completed outcome requires an observed start` };
  }
  if (attempt.cancelIntent && status === "completed") {
    return { ok: false, code: "cancelled", reason: "cancellation was intented; a cancelled attempt can never complete" };
  }
  const payload = { status };
  if (summary) payload.summary = clampText(summary, 4000);
  if (reportId) payload.reportId = String(reportId);
  try {
    const result = handle.append(
      "attempt.outcome",
      payload,
      { context: { actor: resolvedActor, jobId, attemptId }, commandId: `outcome-${jobId}-${attemptId}`, now: nowMs },
    );
    return { ok: true, dedupe: result.dedupe === true, recorded: true, status, seq: result.seq, revision: viewsFor(handle.state).attempt(jobId, attemptId).outcome?.revision ?? null };
  } catch (error) {
    if (error?.code === "command-conflict") {
      // A previous append committed this outcome but its acknowledgement was
      // lost: the record's outcome is authoritative and identical in meaning.
      const existing = viewsFor(handle.state).attempt(jobId, attemptId).outcome;
      return { ok: true, dedupe: true, recorded: false, status: existing?.status ?? status, matches: existing?.status === status, revision: existing?.revision ?? null };
    }
    return { ok: false, code: error.code ?? "refused", reason: error.message };
  }
}

/**
 * The ONE reload-recovery step for a runner job, shared by every caller. The
 * change record is the SOLE authority; the ordering contract is:
 *   1. an existing AUTHORITATIVE outcome is read first, and the compatibility
 *      projection is RECONSTRUCTED from it — a stale (or corrupted) cache
 *      never overrides the record;
 *   2. an explicit, job-bound, VALIDATED result is ingested BEFORE any process
 *      loss is interpreted, and the completed outcome is admitted by the
 *      record BEFORE the compatibility terminal exists (a refusal is mirrored,
 *      never published as success);
 *   3. a cancellation tombstone converges to the authoritative cancelled
 *      intent/outcome (the cache never decides);
 *   4. only then are process verdicts reconciled. Discovered process loss is
 *      outcome-UNKNOWN: no known outcome is ever invented from disappearance,
 *      and obligations/pending updates stay inspectable.
 *
 * Returns the (possibly reconciled) compatibility record plus the authoritative
 * outcome projection.
 */
export function reconcileRunnerJob({ stateDir, jobId, now = Date.now() } = {}) {
  const nowMs = normalizeNow(now)();
  const before = readJob(stateDir, jobId);
  if (!before) return { record: null, outcome: null };
  const communication = before.communication;
  if (!communication?.enabled || !communication.changeId) {
    return { record: reconcileJob(stateDir, jobId, { now: nowMs }), outcome: null };
  }
  const commStateDir = communication.stateDir ?? stateDir;
  const actor = { kind: "runtime", id: communication.runtimeActorId ?? "qq-workflows-runtime" };
  const readAttempt = () => {
    try {
      return viewsFor(openChange({ stateDir: commStateDir, changeId: communication.changeId }).state)
        .attempt(jobId, communication.attemptId);
    } catch {
      return null;
    }
  };
  const outcomeProjection = (attempt) => ({
    status: attempt.outcome.status,
    revision: attempt.outcome.revision ?? null,
    reportId: attempt.outcome.reportId ?? null,
    source: "change-record",
  });
  let attempt = readAttempt();
  // (1) The authoritative outcome wins outright: the cache converges to it.
  if (attempt?.outcome) {
    const record = convergeCacheToOutcome({ stateDir, record: before, outcome: attempt.outcome, nowMs });
    return { record, outcome: outcomeProjection(attempt) };
  }
  // (2) Explicit, validated, job-bound result BEFORE interpreting any process
  //     loss. The payload must bind the runner identity — and, when it names an
  //     attempt/change, that exact attempt/change — so a forged or wrong-
  //     attempt payload is never promoted.
  if (!before.terminal && !before.cancellation) {
    const runner = { id: before.id, resultFile: before.resultFile ?? join(tmpdir(), `qq-runner-result-${before.id}.json`) };
    let parsed = null;
    try { parsed = JSON.parse(readFileSync(runner.resultFile, "utf8")); } catch { parsed = null; }
    const bound = Boolean(parsed)
      && parsed.runnerId === before.id
      && (parsed.attemptId === undefined || parsed.attemptId === communication.attemptId)
      && (parsed.changeId === undefined || parsed.changeId === communication.changeId);
    if (bound) {
      const accepted = acceptRunnerResult(runner, { stateDir: commStateDir, saveReport, now: nowMs });
      if (accepted.ok) {
        const text = renderRunnerFindings(accepted.result);
        const report = accepted.report ?? saveReport(stateDir, { jobId: before.id, role: before.role, text, now: nowMs });
        // The record admits the completed outcome BEFORE the compatibility
        // terminal exists.
        const outcome = recordRunnerOutcome({
          stateDir: commStateDir,
          changeId: communication.changeId,
          jobId: before.id,
          attemptId: communication.attemptId,
          status: "completed",
          summary: text,
          reportId: report.reportId,
          actor,
          now: nowMs,
        });
        const settled = outcome.ok ? (outcome.status ?? "completed") : null;
        if (settled === "completed") {
          const record = recordTerminal(stateDir, before.id, {
            status: "completed",
            summary: text,
            reportId: report.reportId,
            reportChars: report.chars,
            now: nowMs,
          });
          return { record, outcome: { status: "completed", revision: outcome.revision ?? null, reportId: report.reportId, source: "change-record" } };
        }
        // The record refused (cancel intent, unbound attempt, identity, or a
        // concurrent decision): mirror the authoritative state, never success.
        attempt = readAttempt();
        if (attempt?.outcome) {
          const record = convergeCacheToOutcome({ stateDir, record: readJob(stateDir, jobId) ?? before, outcome: attempt.outcome, nowMs });
          return { record, outcome: outcomeProjection(attempt) };
        }
        return {
          record: readJob(stateDir, jobId) ?? before,
          outcome: { status: null, refused: outcome.reason ?? outcome.code ?? "the record refused the outcome", source: "change-record" },
        };
      }
      // An invalid payload (forged context, over-cap without spill) falls
      // through UNPROMOTED to the process verdicts below.
    }
  }
  // (3) A cancellation tombstone converges to the authoritative cancelled
  //     intent/outcome (idempotent; only an accepted intent admits the
  //     cancelled outcome).
  if (before.cancellation) {
    recordRunnerCancelIntent({
      stateDir: commStateDir,
      changeId: communication.changeId,
      jobId,
      attemptId: communication.attemptId,
      reason: before.cancellation.reason ?? "cancelled by architect",
      actor,
      now: nowMs,
    });
    recordRunnerOutcome({
      stateDir: commStateDir,
      changeId: communication.changeId,
      jobId,
      attemptId: communication.attemptId,
      status: "cancelled",
      summary: before.cancellation.reason ?? "cancelled by architect",
      actor,
      now: nowMs,
    });
    attempt = readAttempt();
    if (attempt?.outcome) {
      const record = convergeCacheToOutcome({ stateDir, record: readJob(stateDir, jobId) ?? before, outcome: attempt.outcome, nowMs });
      return { record, outcome: outcomeProjection(attempt) };
    }
  }
  // (4) Process verdicts. Discovered process loss is outcome-UNKNOWN: no
  //     authoritative outcome is invented from disappearance.
  const record = reconcileJob(stateDir, jobId, { now: nowMs });
  return {
    record,
    outcome: attempt?.outcome ? outcomeProjection(attempt) : { status: null, unknown: true, source: "change-record" },
  };
}

// Rebuild the compatibility projection from the authoritative outcome: a stale
// running/terminal cache (including a corrupted one) is RECONSTRUCTED, never
// consulted. The superseded projection is kept as recovery evidence.
function convergeCacheToOutcome({ stateDir, record, outcome, nowMs }) {
  const status = outcome.status === "completed" ? "completed" : outcome.status === "cancelled" ? "cancelled" : "failed";
  const reportId = outcome.reportId ?? record.terminal?.reportId ?? null;
  if (record.status === status && record.terminal?.status === status && (record.terminal?.reportId ?? null) === reportId) return record;
  const superseded = record.terminal && record.terminal.status !== status ? record.terminal.status : null;
  const authoritySummary = `authoritative change-record outcome '${status}'${outcome.summary ? `: ${clampText(outcome.summary, 500)}` : ""}`;
  return writeJob(stateDir, {
    ...record,
    status,
    finishedAt: record.finishedAt ?? nowMs,
    updatedAt: nowMs,
    terminal: {
      status,
      at: record.terminal?.at ?? nowMs,
      ok: status === "completed",
      summary: superseded === null && record.terminal?.summary ? record.terminal.summary : authoritySummary,
      reportId,
      reportChars: record.terminal?.reportChars ?? 0,
      resultAvailable: Boolean(reportId),
      error: record.terminal?.error ?? null,
    },
    events: [...(Array.isArray(record.events) ? record.events : []), { at: nowMs, action: "reconstructed-from-authority", status, ...(superseded ? { superseded } : {}) }].slice(-40),
    recovery: {
      reconciledAt: nowMs,
      verdict: status,
      detail: "compatibility projection reconstructed from the authoritative change-record outcome",
    },
  });
}

// ---------------------------------------------------------------------------
// Bounded status projection for check_runner
// ---------------------------------------------------------------------------

/**
 * The bounded communication projection `check_runner` exposes, REBUILT from
 * the authoritative change record on every read (a stale compatibility cache
 * cannot override it). Pending amendment references and unresolved revisions
 * are bounded; assignment/finding text is never included here.
 */
export function runnerCommunicationView({ stateDir, communication } = {}) {
  if (!communication?.enabled || !communication.changeId) {
    return {
      enabled: false,
      supported: false,
      reason: communication?.disabledReason
        ?? "no communication binding was prepared for this runner; assignment updates are unsupported and progress is not pushed",
    };
  }
  const { changeId, jobId, attemptId } = communication;
  let handle;
  try {
    handle = openChange({ stateDir: communication.stateDir ?? stateDir, changeId });
  } catch (error) {
    return {
      enabled: true,
      supported: true,
      changeId,
      jobId,
      attemptId,
      recordUnavailable: clampText(error.message, 200),
    };
  }
  const state = handle.state;
  const views = viewsFor(state);
  let jobView;
  try {
    jobView = views.job(jobId);
  } catch (error) {
    return { enabled: true, supported: true, changeId, jobId, attemptId, recordUnavailable: clampText(error.message, 200) };
  }
  const attempt = jobView.attempts[attemptId] ?? null;
  // Unresolved revisions: job-targeted revisions that no admitted amendment
  // covers (a submission the record refused after authoring the revision).
  const amendmentRevisions = new Set(jobView.amendments.map((entry) => entry.revision));
  const unresolvedRevisions = state.revisions
    .filter((entry) => entry.scope?.kind === "job" && entry.scope.jobId === jobId && !amendmentRevisions.has(entry.revision))
    .map((entry) => entry.revision);
  const pending = jobView.pendingAmendments;
  const view = {
    enabled: true,
    supported: true,
    changeId,
    jobId,
    attemptId,
    role: jobView.role,
    pinnedRevision: jobView.pinnedRevision,
    effectiveRevision: jobView.effectiveRevision,
    attemptPhase: attempt?.phase ?? null,
    receiverBindingRecorded: Boolean(attempt?.started?.identity?.piSession),
    admissionClosed: Boolean(attempt?.admissionClosed),
    cancelIntent: Boolean(attempt?.cancelIntent),
    lastAcknowledgedRevision: attempt?.acknowledgements.at(-1)?.revision ?? null,
    outcome: attempt?.outcome
      ? { status: attempt.outcome.status, ok: attempt.outcome.ok, revision: attempt.outcome.revision, reportId: attempt.outcome.reportId ?? null }
      : null,
    pendingUpdates: pending.slice(0, PENDING_UPDATE_VIEW_MAX).map((entry) => ({
      amendmentId: entry.amendmentId,
      revision: entry.revision,
      status: entry.status,
      lastPush: entry.pushes.length ? { status: entry.pushes.at(-1).status ?? "unknown", eventId: entry.pushes.at(-1).eventId } : { status: "unpushed", eventId: null },
    })),
    pendingUpdateCount: pending.length,
    unresolvedRevisions: unresolvedRevisions.slice(0, UNRESOLVED_REVISION_VIEW_MAX),
    unresolvedRevisionCount: unresolvedRevisions.length,
  };
  if (communication.consumerId) view.consumerAddress = communication.consumerId;
  return view;
}
