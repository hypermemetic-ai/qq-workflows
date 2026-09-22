import { dirname as relayDirectory } from "node:path";
import { holdRelayForReceiver } from "./relay-process-holders.mjs";
// Production Pi receiver for workflow runner communication.
//
// This is the receiver the runner integration loads INSIDE the worker's Pi
// session (through the existing worker-tools extension seam). Its mechanics
// are the ORIGINAL receiver's tested injection/receipt/dedup logic, carried
// over from the maintained compatibility fixture
// (`tests/fixtures/pi-relay/agent-messages-relay-fixture.mjs`), which itself is
// the qq-monolith `extensions/agent-messages.ts` revision 2b4b989
// ("fix: prove agent receipts from durable entries") with declared adaptations
// A1–A5 (see docs/pi-relay-receiver-proof.md). Nothing here re-investigates or
// re-implements the relay protocol: the poll loop (`client.next` with
// `consumer_type:"recipient"`, generation 0, 30s long-poll), the receiveOne
// ordering (parse -> durable-receipt check -> dedup marker -> immediate
// claim/abort discipline -> injection options -> acknowledge only after the
// durable session entry is observable), `receiptEntryMatches`,
// `deliveryGuard`, `statusName`, and the injection option selection
// (`{triggerTurn:true}` idle, `{triggerTurn:true, deliverAs:"steer"}` busy)
// are the tested code paths.
//
// Declared production adaptations over the fixture (each is a difference from
// the fixture file, which stays untouched as historical provenance):
//
//   P1. Identity comes from the runtime-supplied communication binding
//       (`workflow/communication.mjs` `parseCommunicationBinding`), not from
//       QQ_AGENT_* environment aliases. The receiver's own address is the
//       session's BARE Pi UUID; production never accepts DSH session aliases
//       (the fixture's permissive DSH latitude is test-only).
//   P2. The historical `agent_messages` send tool is NOT registered: a worker
//       has no general-purpose send-to-arbitrary-recipient tool. The only
//       model-facing surface is the three coordinator-authored workflow tools
//       below, registered only when a valid binding is present.
//   P3. The fixture-only tools (`fixture_acknowledge_amendment`,
//       `fixture_report_progress`) are NOT carried over. Their production
//       replacements are `workflow_acknowledge_assignment` and
//       `workflow_report_progress`, with the same record-first discipline and
//       the same deterministic acknowledgement command IDs
//       (`ack-<amendmentId>-rev<revision>`), so a re-injected envelope after a
//       crash can produce duplicate INJECTION but never duplicate
//       INCORPORATION.
//   P4. The relay client is resolved from the binding's install root (falling
//       back to QQ_RELAY_INSTALL_ROOT and the installed default) and connects
//       to the binding's socket path — the parent-owned private relay, never a
//       machine-wide service.
//
// The change record stays the sole workflow authority: the tools append
// through the existing record writer/reducer, and delivery bookkeeping in the
// relay journal never advances worker acknowledgement.

import { createHash, randomUUID } from "node:crypto";

import {
  COMMUNICATION_TOOL_DESCRIPTIONS,
  PROGRESS_MESSAGE_MAX_CHARS,
  READ_ASSIGNMENT_LIMIT_DEFAULT,
  READ_ASSIGNMENT_LIMIT_MAX,
  READ_ASSIGNMENT_PENDING_REFS_MAX,
  RELAY_MESSAGE_SCHEMA,
  RELAY_PRODUCT,
  projectSlugForChange,
  sendAgentMessage,
  transportStatusOf,
} from "./communication.mjs";
import { JOB_ROLES, openChange, viewsFor } from "./change-record.mjs";

const CUSTOM_TYPE = "qq-agent-message";
const MESSAGE_KIND = "agent.message";
const RECEIVE_WAIT_MS = 30_000;
const RECONNECT_MS = 500;
const IMMEDIATE_IDLE_POLL_MS = 50;
const IMMEDIATE_IDLE_TIMEOUT_MS = 5_000;
const PI_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SIMPLE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DELIVERY = new Set(["default", "immediate"]);
const BOUNDED_TEXT_MAX = 4096;

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// P1: production validates the BARE Pi UUID only. The historical DSH alias
// latitude (`session-…`, with the source revision's version/variant anchors
// loosened) is fixture-only test vocabulary.
function validSessionId(value) {
  return PI_SESSION_ID.test(value ?? "");
}

function relayAgentId(sessionId) {
  if (!validSessionId(sessionId)) throw new Error("session_id must be a bare canonical Pi session UUID");
  return `${RELAY_PRODUCT}/${sessionId}`;
}

function bounded(value, label, maximum = BOUNDED_TEXT_MAX) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function normalizeTasks(value, label = "tasks") {
  if (value === undefined || value === null || value === "") return [];
  const values = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(values) || values.length > 32) throw new Error(`${label} must contain at most 32 entries`);
  const result = [];
  for (const entry of values) {
    if (typeof entry !== "string") throw new Error(`${label} entries must be strings`);
    const task = bounded(entry.trim(), `${label} entry`, 191);
    if (!result.includes(task)) result.push(task);
  }
  return result;
}

// Same payload gate as the historical receiver: a foreign or malformed
// envelope is blocked on the journal, never injected. Production additionally
// refuses DSH-shaped sender identities (P1).
function parseMessage(record) {
  const payload = record?.envelope?.payload;
  const message = payload?.message;
  if (payload?.schema !== RELAY_MESSAGE_SCHEMA || typeof message !== "object" || message === null) return undefined;
  if (!validSessionId(message.from) || !sessionIdFromRelayAgent(record.recipient_id)) return undefined;
  if (!SIMPLE.test(message.project ?? "") || !JOB_ROLES.includes(message.role)) return undefined;
  if (message.pane !== null && (typeof message.pane !== "string" || message.pane.length > 128 || message.pane.includes("\0"))) return undefined;
  if (typeof message.content !== "string" || message.content.length === 0 || message.content.length > 65_536) return undefined;
  if (!DELIVERY.has(message.delivery)) return undefined;
  let tasks;
  try { tasks = normalizeTasks(message.tasks); } catch { return undefined; }
  if (JSON.stringify(tasks) !== JSON.stringify(message.tasks)) return undefined;
  return { ...message, tasks, event_id: record.event_id, accepted_at: record.accepted_at, content_hash: sha256(message.content) };
}

function sessionIdFromRelayAgent(value) {
  const prefix = `${RELAY_PRODUCT}/`;
  if (typeof value !== "string" || !value.startsWith(prefix)) return undefined;
  const sessionId = value.slice(prefix.length);
  return validSessionId(sessionId) ? sessionId : undefined;
}

function receiptDetails(message) {
  return {
    schema: RELAY_MESSAGE_SCHEMA,
    event_id: message.event_id,
    content_hash: message.content_hash,
    from: message.from,
    delivery: message.delivery,
  };
}

function injectedMessageContent(message) {
  return `[message ${message.event_id} from ${message.from} — ${message.project} / ${message.role}${message.tasks.length ? ` — tasks: ${message.tasks.join(", ")}` : ""}]\n${message.content}`;
}

function receiptEntryMatches(entry, message) {
  if (entry?.type === "custom_message") {
    return entry.customType === CUSTOM_TYPE
      && entry.details?.event_id === message.event_id
      && entry.details?.content_hash === message.content_hash;
  }
  const blocks = entry?.message?.content;
  return entry?.type === "message"
    && entry.message?.role === "user"
    && Array.isArray(blocks)
    && blocks.length === 1
    && blocks[0]?.type === "text"
    && blocks[0]?.text === injectedMessageContent(message);
}

function deliveryGuard(delivery) {
  return {
    obligation_id: delivery.obligation.obligation_id,
    event_id: delivery.record.event_id,
    consumer_type: delivery.obligation.consumer_type,
    consumer_id: delivery.obligation.consumer_id,
    generation: delivery.obligation.generation,
    attempt_token: delivery.attempt_token,
    endpoint_token: delivery.endpoint_token,
    expected_high_water: delivery.guard.expected_high_water,
    expected_gap_token: delivery.guard.expected_gap_token,
  };
}

function statusName(result) {
  const statuses = (result?.obligations ?? []).map((item) => item.status);
  if (statuses.includes("in_flight")) return "delivering";
  if (statuses.includes("pending")) return "queued";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.length && statuses.every((value) => value === "acknowledged")) return "delivered";
  if (statuses.includes("expired")) return "expired";
  if (statuses.some((value) => value === "disposed" || value === "abandoned")) return "failed";
  return result?.terminal_failure ? "failed" : "queued";
}

// P4: resolve the installed relay client (binding install root first, then the
// environment, then the installed default), validating the same export set the
// historical shim validated.
async function loadInstalledRelayClient({ installRoot, env }) {
  const configured = installRoot ?? env?.QQ_RELAY_INSTALL_ROOT;
  if (configured !== undefined && (typeof configured !== "string" || configured.length === 0 || !configured.startsWith("/"))) {
    throw new Error("QQ_RELAY_INSTALL_ROOT must be an absolute path");
  }
  const home = env?.HOME;
  if (typeof home !== "string" || home.length === 0 || !home.startsWith("/")) {
    throw new Error("HOME must be an absolute path when no install root is configured");
  }
  const root = configured || `${home}/.local/lib/qq/relay`;
  const client = await import(`${root}/client.mjs`);
  for (const name of ["QQ_RELAY_PROTOCOL", "RelayClient", "RelayError", "canonicalRelayJson"]) {
    if (!(name in client)) throw new Error(`qq-relay installed client does not export ${name}: ${root}/client.mjs`);
  }
  return client;
}

/**
 * Build the receiver controller for one worker session.
 *
 * `deps` (all injectable for tests): `client` (a stub transport),
 * `sendMessage` (the pi host call), `injectedMessages` (the dedup set),
 * `sleep`, `now`.
 */
export function createCommunicationReceiver(pi, { binding, env = process.env, client = null, sendMessage = null, injectedMessages = null, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  let releaseTransportHold = null;
  let active = false;
  let epoch = 0;
  let current;
  let currentContext;
  let clientInstance = client;
  const dedup = injectedMessages ?? new Set();

  async function getClient() {
    if (clientInstance) return clientInstance;
    const module = await loadInstalledRelayClient({ installRoot: binding.installRoot, env });
    clientInstance = new module.RelayClient(binding.socketPath);
    return clientInstance;
  }

  function receiptExists(message) {
    let entries;
    try { entries = currentContext?.sessionManager?.getEntries?.(); } catch { return false; }
    return Array.isArray(entries) && entries.some((entry) => receiptEntryMatches(entry, message));
  }

  async function claimImmediate(message) {
    const clientHandle = await getClient();
    const result = await clientHandle.publish({
      producer_id: relayAgentId(message.from),
      request_id: `immediate_${message.event_id}`,
      origin_id: relayAgentId(message.from),
      product_id: RELAY_PRODUCT,
      kind: "agent.immediate-claim",
      schema_version: 1,
      correlation_id: message.event_id,
      payload: { schema: RELAY_MESSAGE_SCHEMA, event_id: message.event_id, content_hash: message.content_hash },
    });
    return result.idempotent !== true;
  }

  async function waitUntilIdle(context) {
    for (let waited = 0; waited < IMMEDIATE_IDLE_TIMEOUT_MS; waited += IMMEDIATE_IDLE_POLL_MS) {
      if (context.isIdle?.() !== false) return true;
      await sleep(IMMEDIATE_IDLE_POLL_MS);
    }
    return context.isIdle?.() !== false;
  }

  // The historical receiveOne ordering, unchanged (see the module header).
  async function receiveOne(delivery, localEpoch) {
    const message = parseMessage(delivery.record);
    if (!message) {
      const clientHandle = await getClient();
      await clientHandle.block({ ...deliveryGuard(delivery), reason: "unsupported agent message payload" });
      return;
    }
    const injectionKey = `${message.event_id}:${message.content_hash}`;
    if (receiptExists(message)) {
      const clientHandle = await getClient();
      await clientHandle.acknowledge(deliveryGuard(delivery));
      dedup.delete(injectionKey);
      return;
    }
    if (dedup.has(injectionKey)) {
      const clientHandle = await getClient();
      await clientHandle.retry({ ...deliveryGuard(delivery), reason: "durable session entry not yet observable" });
      return;
    }
    if (!active || localEpoch !== epoch || !currentContext) return;
    const context = currentContext;
    dedup.add(injectionKey);
    let waitedForImmediateIdle = false;
    if (message.delivery === "immediate" && context.isIdle?.() === false) {
      const claimed = await claimImmediate(message);
      if (claimed) {
        try { context.abort?.(); } catch {}
      }
      waitedForImmediateIdle = await waitUntilIdle(context);
      if (!waitedForImmediateIdle) {
        dedup.delete(injectionKey);
        const clientHandle = await getClient();
        await clientHandle.retry({ ...deliveryGuard(delivery), reason: "Pi did not become idle after immediate abort" });
        return;
      }
    }
    const options = waitedForImmediateIdle || context.isIdle?.() !== false
      ? { triggerTurn: true }
      : { triggerTurn: true, deliverAs: "steer" };
    const send = sendMessage ?? pi.sendMessage.bind(pi);
    try {
      await send({
        customType: CUSTOM_TYPE,
        content: injectedMessageContent(message),
        display: true,
        details: receiptDetails(message),
      }, options);
    } catch (error) {
      dedup.delete(injectionKey);
      throw error;
    }
    if (receiptExists(message)) {
      const clientHandle = await getClient();
      await clientHandle.acknowledge(deliveryGuard(delivery));
      dedup.delete(injectionKey);
    } else {
      const clientHandle = await getClient();
      await clientHandle.retry({ ...deliveryGuard(delivery), reason: "durable session entry not yet observable" });
    }
  }

  async function receiver(localEpoch) {
    const endpoint = `agent-messages/${randomUUID()}`;
    while (active && localEpoch === epoch && current) {
      try {
        const clientHandle = await getClient();
        const result = await clientHandle.next({ consumer_type: "recipient", consumer_id: relayAgentId(current.session_id), generation: 0, endpoint_token: endpoint, wait_ms: RECEIVE_WAIT_MS });
        if (result?.delivery) await receiveOne(result.delivery, localEpoch);
      } catch {
        if (active && localEpoch === epoch) await sleep(RECONNECT_MS);
      }
    }
  }

  async function start(_event, ctx) {
    const localEpoch = ++epoch;
    active = false;
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (typeof sessionId !== "string" || sessionId === "") return;
    if (!validSessionId(sessionId)) throw new Error("host supplied a non-canonical session ID");
    if (!client && !releaseTransportHold) {
      const release = await holdRelayForReceiver(relayDirectory(binding.socketPath));
      // A shutdown/new session while acquiring the hold cannot resurrect an
      // old receiver or leak its newly acquired transport reference.
      if (localEpoch !== epoch) { await release(); return; }
      releaseTransportHold = release;
    }
    if (localEpoch !== epoch) return;
    currentContext = ctx;
    current = { session_id: sessionId, project: projectSlugForChange(binding.changeId), role: binding.role, pane: null };
    active = true;
    void receiver(localEpoch);
  }

  async function stop() {
    active = false;
    epoch += 1;
    dedup.clear();
    current = undefined;
    currentContext = undefined;
    if (releaseTransportHold) { const release = releaseTransportHold; releaseTransportHold = null; await release(); }
  }

  return {
    binding,
    start,
    stop,
    // Test/diagnostic surface: the receiver's own transport address.
    get address() {
      return current ? relayAgentId(current.session_id) : null;
    },
    // Surfaces the tools need: the lazy transport client and the live sender
    // identity (null until session_start registered the session).
    getClient,
    get currentRef() {
      return current;
    },
  };
}

export { normalizeTasks, parseMessage, statusName };

// ---------------------------------------------------------------------------
// Model-facing production tools (coordinator-authored copy; registered only on
// a bound runner). Identity, routing and scope come from the trusted binding,
// never from tool arguments.
// ---------------------------------------------------------------------------

function refusal(reason) {
  return { content: [{ type: "text", text: `Workflow communication refused: ${reason}` }], details: { status: "refused", reason }, isError: true };
}

function assignmentTextOf(assignment) {
  if (typeof assignment === "string") return assignment;
  if (assignment && typeof assignment.instructions === "string") return assignment.instructions;
  return JSON.stringify(assignment ?? null);
}

/**
 * The `workflow_read_assignment` implementation. `handleFor` opens the change
 * record fresh per call (cross-process truth, never a cached copy).
 */
export function readAssignment({ stateDir, changeId, jobId, attemptId }, params = {}) {
  const revision = params.revision;
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) {
    return refusal("revision must be a positive integer when given");
  }
  const offset = params.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) return refusal("offset must be a non-negative integer");
  const limit = params.limit ?? READ_ASSIGNMENT_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > READ_ASSIGNMENT_LIMIT_MAX) {
    return refusal(`limit must be an integer in [1, ${READ_ASSIGNMENT_LIMIT_MAX}]`);
  }
  let handle;
  try {
    handle = openChange({ stateDir, changeId });
  } catch (error) {
    return refusal(`the change record is unavailable: ${error.message}`);
  }
  const views = viewsFor(handle.state);
  let job;
  try {
    job = views.job(jobId);
  } catch (error) {
    return refusal(error.message);
  }
  const target = revision ?? job.effectiveRevision;
  let entry;
  try {
    // Scope: the attempt may read only revisions that exist and apply to its
    // own job (a change-scoped revision applies to every job).
    const view = views.assignment({ revision: target });
    if (!view) return refusal(`assignment revision ${target} does not exist`);
    if (view.scope.kind === "job" && view.scope.jobId !== jobId) {
      return refusal(`assignment revision ${target} targets job '${view.scope.jobId}', not this job`);
    }
    entry = view;
  } catch (error) {
    return refusal(error.message);
  }
  const text = assignmentTextOf(entry.assignment);
  const end = Math.min(text.length, offset + limit);
  const bounded = text.slice(offset, end);
  const nextOffset = end < text.length ? end : null;
  // Never silently truncate as complete: missing continuation parts are
  // reported even when the page boundary happens to align.
  const complete = nextOffset === null && entry.complete;
  const pendingRefs = job.pendingAmendments
    .filter((amendment) => amendment.targetedAttemptId === attemptId)
    .slice(0, READ_ASSIGNMENT_PENDING_REFS_MAX)
    .map((amendment) => ({ amendmentId: amendment.amendmentId, revision: amendment.revision }));
  const lines = [
    `[assignment revision ${entry.revision} — job ${jobId} — offset ${offset} limit ${limit}]`,
    bounded,
    `[nextOffset: ${nextOffset === null ? "null" : nextOffset}] [complete: ${complete}]`,
  ];
  if (pendingRefs.length > 0) {
    lines.push(`[pending updates: ${pendingRefs.map((ref) => `amendment ${ref.amendmentId} revision ${ref.revision}`).join("; ")}]`);
  } else if (offset === 0) {
    lines.push("[pending updates: none]");
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      status: "ok",
      revision: entry.revision,
      effectiveRevision: job.effectiveRevision,
      offset,
      nextOffset,
      complete,
      incompleteTexts: entry.incompleteTexts,
      pendingUpdates: pendingRefs,
    },
  };
}

/**
 * The `workflow_acknowledge_assignment` implementation. Resolves the targeted
 * amendments for the exact revision against THIS attempt, refuses stale,
 * wrong-target, unknown, or inaccessible revisions, and appends
 * `worker.acknowledged` with the deterministic incorporation command ID
 * (`ack-<amendmentId>-rev<revision>`, or `ack-rev<revision>` when no amendment
 * ever targeted this revision for this attempt — the documented
 * launch-revision acknowledgement case the reducer already supports).
 * Retries with identical meaning are record dedupes.
 */
export function acknowledgeAssignment({ stateDir, changeId, jobId, attemptId, actorId }, params = {}) {
  const revision = params.revision;
  if (!Number.isInteger(revision) || revision < 1) return refusal("revision is required and must be a positive integer");
  let handle;
  try {
    handle = openChange({ stateDir, changeId });
  } catch (error) {
    return refusal(`the change record is unavailable: ${error.message}`);
  }
  const views = viewsFor(handle.state);
  let job;
  try {
    job = views.job(jobId);
  } catch (error) {
    return refusal(error.message);
  }
  const attempt = job.attempts[attemptId];
  if (!attempt) return refusal(`attempt '${attemptId}' is not recorded on job '${jobId}'`);
  if (!attempt.started) return refusal(`attempt '${attemptId}' has no observed start; acknowledgements require a started attempt`);
  // Existence and accessibility: the revision must exist and apply to this job.
  try {
    const view = views.assignment({ revision });
    if (!view) return refusal(`assignment revision ${revision} does not exist`);
    if (view.scope.kind === "job" && view.scope.jobId !== jobId) {
      return refusal(`assignment revision ${revision} targets job '${view.scope.jobId}', not this job`);
    }
  } catch (error) {
    return refusal(error.message);
  }
  // Deterministic targeting resolution: the FIRST amendment in submission
  // order for this revision targeted at THIS attempt (pending, accepted, or
  // already fulfilled — a retry must resolve the same command ID).
  const targeted = job.amendments.filter((amendment) => amendment.revision === revision && amendment.targetedAttemptId === attemptId);
  const alreadyAcknowledged = attempt.acknowledgements.some((ack) => ack.revision === revision);
  const effective = job.effectiveRevision;
  if (targeted.length === 0 && revision !== effective && !alreadyAcknowledged) {
    return refusal(
      `revision ${revision} is stale: it is not this job's effective revision (${effective}), no pending amendment targets it for this attempt, and it was not already acknowledged`,
    );
  }
  const commandId = targeted.length > 0 ? `ack-${targeted[0].amendmentId}-rev${revision}` : `ack-rev${revision}`;
  try {
    const result = handle.append(
      "worker.acknowledged",
      { revision, note: targeted.length > 0 ? `acknowledged revision ${revision} (${targeted[0].amendmentId})` : `acknowledged revision ${revision}` },
      { context: { actor: { kind: "worker", id: actorId }, jobId, attemptId }, commandId },
    );
    // handle.state is the post-append state (the writer validated and applied
    // the event before the durable write returned).
    const amendmentAfter = targeted.length > 0
      ? viewsFor(handle.state).job(jobId).amendments.find((entry) => entry.amendmentId === targeted[0].amendmentId) ?? null
      : null;
    const dedupe = result.dedupe === true;
    const text = targeted.length > 0
      ? `Revision ${revision} acknowledged${dedupe ? " (already recorded)" : ` at record seq ${result.seq}`}${amendmentAfter?.acknowledged ? `; amendment ${targeted[0].amendmentId} is fulfilled` : ""}.`
      : `Revision ${revision} acknowledged${dedupe ? " (already recorded)" : ` at record seq ${result.seq}`}; no pending amendment targeted this revision for this attempt (launch-revision acknowledgement).`;
    return {
      content: [{ type: "text", text }],
      details: {
        status: "ok",
        revision,
        seq: result.seq,
        committed: result.committed !== false,
        dedupe,
        commandId,
        amendment: amendmentAfter,
        launchRevisionAcknowledgement: targeted.length === 0,
      },
    };
  } catch (error) {
    return refusal(error.message);
  }
}

/**
 * The `workflow_report_progress` implementation. The record commit happens
 * BEFORE the push, always; the push status is reported separately and an
 * unavailable transport never erases the committed entry.
 */
export async function reportProgress({ binding, getClient, currentRef }, params = {}) {
  const kind = params.kind;
  if (kind !== "progress" && kind !== "blocker") return refusal("kind must be 'progress' or 'blocker'");
  const message = params.message;
  if (typeof message !== "string" || message.length === 0 || message.length > PROGRESS_MESSAGE_MAX_CHARS || message.includes("\0")) {
    return refusal(`message must be a nonempty string of at most ${PROGRESS_MESSAGE_MAX_CHARS} characters`);
  }
  let handle;
  try {
    handle = openChange({ stateDir: binding.stateDir, changeId: binding.changeId });
  } catch (error) {
    return refusal(`the change record is unavailable: ${error.message}`);
  }
  let committed;
  try {
    committed = handle.append(
      kind === "progress" ? "worker.progress" : "worker.blocker",
      { note: message },
      { context: { actor: { kind: "worker", id: binding.actorId }, jobId: binding.jobId, attemptId: binding.attemptId } },
    );
  } catch (error) {
    return refusal(error.message);
  }
  // The committed sequence is the routing truth; the push only references it.
  const sender = currentRef();
  if (!sender) {
    return {
      content: [{ type: "text", text: `${kind === "progress" ? "Progress" : "Blocker"} committed at record seq ${committed.seq}; push unavailable (this session is not registered for transport).` }],
      details: { status: "ok", committed: { seq: committed.seq, eventId: committed.eventId, kind }, push: { status: "unavailable", reason: "session not registered for transport" } },
    };
  }
  try {
    const client = await getClient();
    const { eventId, status } = await sendAgentMessage({
      relayOrClient: client,
      from: sender.session_id,
      recipientAgent: binding.recipientAgent,
      project: projectSlugForChange(binding.changeId),
      role: binding.role,
      tasks: [`change:${binding.changeId}`, `job:${binding.jobId}`, `attempt:${binding.attemptId}`, `${kind === "progress" ? "progress" : "blocker"}:${committed.seq}`],
      content: message,
    });
    return {
      content: [{ type: "text", text: `${kind === "progress" ? "Progress" : "Blocker"} committed at record seq ${committed.seq}; push ${status} (event ${eventId ?? "unknown"}).` }],
      details: { status: "ok", committed: { seq: committed.seq, eventId: committed.eventId, kind }, push: { status, eventId } },
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `${kind === "progress" ? "Progress" : "Blocker"} committed at record seq ${committed.seq}; push unavailable (${String(error?.message ?? error).slice(0, 200)}).` }],
      details: { status: "ok", committed: { seq: committed.seq, eventId: committed.eventId, kind }, push: { status: "unavailable", reason: String(error?.message ?? error).slice(0, 200) } },
    };
  }
}

/**
 * Register the receiver and the three production tools on a worker pi host.
 * `binding` is a validated communication binding (the caller — the
 * worker-tools extension seam — parsed and validated it; an invalid binding
 * never reaches this function).
 */
export function registerCommunicationReceiver(pi, options = {}) {
  const receiver = createCommunicationReceiver(pi, options);
  const binding = options.binding;
  const toolContext = {
    stateDir: binding.stateDir,
    changeId: binding.changeId,
    jobId: binding.jobId,
    attemptId: binding.attemptId,
    actorId: binding.actorId,
  };
  const progressContext = { binding, getClient: () => receiver.getClient(), currentRef: () => receiver.currentRef };

  pi.registerTool({
    name: "workflow_read_assignment",
    label: "Read assignment",
    description: COMMUNICATION_TOOL_DESCRIPTIONS.workflow_read_assignment,
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        revision: { type: "integer", description: "Optional positive integer. Omit to read your current effective assignment." },
        offset: { type: "integer", description: "Optional nonnegative integer offset into the assignment text (default 0)." },
        limit: { type: "integer", description: `Optional integer in [1, ${READ_ASSIGNMENT_LIMIT_MAX}], default ${READ_ASSIGNMENT_LIMIT_DEFAULT}: maximum characters returned.` },
      },
    },
    execute: (_id, params) => readAssignment(toolContext, params ?? {}),
  });

  pi.registerTool({
    name: "workflow_acknowledge_assignment",
    label: "Acknowledge assignment",
    description: COMMUNICATION_TOOL_DESCRIPTIONS.workflow_acknowledge_assignment,
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        revision: { type: "integer", description: "Required positive integer: the exact assignment revision you read and incorporated." },
      },
      required: ["revision"],
    },
    execute: (_id, params) => acknowledgeAssignment(toolContext, params ?? {}),
  });

  pi.registerTool({
    name: "workflow_report_progress",
    label: "Report progress",
    description: COMMUNICATION_TOOL_DESCRIPTIONS.workflow_report_progress,
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["progress", "blocker"], description: "'progress' for concrete work accomplished, 'blocker' for an obstacle or a decision you need." },
        message: { type: "string", description: `Nonempty string, maximum ${PROGRESS_MESSAGE_MAX_CHARS} characters.` },
      },
      required: ["kind", "message"],
    },
    execute: (_id, params) => reportProgress(progressContext, params ?? {}),
  });

  pi.on("session_start", receiver.start);
  pi.on("session_shutdown", receiver.stop);

  return receiver;
}
