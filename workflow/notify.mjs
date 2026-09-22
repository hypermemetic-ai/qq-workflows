// Transport-independent completion delivery.
//
// The router owns the difference between these distinct facts:
//   accepted  — the transport took the message (e.g. a queue command exited 0)
//   queued    — the message is queued behind the operator's active turn
//   delivered — a RECEIPT proves the owning session retained this exact event
//               (a pi session entry, a turn pi started, or — for a completion an
//               older release steered without the identity metadata — an exact
//               content correspondence):
//               never merely transport acceptance, never model turn success
//   unknown   — the outcome cannot be proven: the event has no stable identity
//               or there is no evidence to reconcile it against, so it is
//               neither replayed automatically nor reported as delivered
//   available — the complete result is durably retrievable (never implied by delivery)
// Every notification carries a stable event ID. A repeat AFTER a receipt is a
// duplicate and is never re-delivered, so a reconnect or a duplicated callback
// cannot create a second workflow side effect. An event whose release predates
// that metadata (the completion text was steered, the record stayed `queued`) is
// resolved from its persisted session entry by exact content correspondence: the
// text has to be the delivered text of exactly one pending event, and anything
// merely similar is reported as unprovable instead of being replayed.
//
// The journal record is a durable fact too, and it can be lost or corrupted
// independently of the projection. Recovery therefore repairs a missing record
// from the owner-bound job projection, preserves (quarantines) a corrupt one
// before replacing it, refuses to write over one that cannot even be read, and
// reports any write it could not perform as `errors` instead of a
// reconciliation: no caller may read a successful recovery out of a failed
// write.
//
// An accepted/queued event is NOT a receipt. A crash before the queue drains
// would lose the wakeup forever (and the durable record would keep claiming it
// was handled), so those states stay reconcilable: recovery resolves them from
// the owning session's persisted evidence first, defers an event the live
// session still holds in its message queue, and only resends when it can prove
// the event never reached the session. An event with no stable identity is never
// auto-replayed: without identity its outcome is unprovable by construction, so
// it is either acknowledged from an exact content correspondence (which proves
// retention, never absence) or retained as `unknown` for an explicit decision.
// Nothing claims exactly-once across transactions the runtime does not offer: the
// receipt boundary is documented in the README.
//
// Every DELIVERY ATTEMPT is journaled as durable intent BEFORE the transport is
// invoked, and settled with the transport's result afterwards. This closes the
// crash window between an external transport accepting the message and its
// callback reaching the journal: without the intent, a crash there leaves
// nothing (or — for a completion an internal execution-host handoff queued for
// this session to send — a bare `queued` record that looks like a never-sent
// internal handoff), and the next pass would blindly send the event again. With
// it, the journal proves an attempt was in flight, and an attempt whose callback
// never settled is outcome-UNKNOWN: nothing is sent behind a lost callback until
// the owning session's evidence resolves it (retention acknowledges it, proven
// absence replays the same event), while an explicit refusal the callback DID
// prove settles the attempt and stays retryable. This is deliberately NOT an
// exactly-once claim for an external queue without receipts: an accepted message
// may still be in the queue when the session evidence is read, so the receipt
// boundary stays exactly where the README documents it.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ARCHITECT_COMPLETION_CUSTOM_TYPE } from "./architect-profile.mjs";
import {
  DELIVERY_STATES,
  UNVERIFIED_DELIVERY_STATES,
  deliveryPending,
  deliveryEvidence,
  terminalDelivery,
  markDelivery,
  nextDeliveryState,
  readJob,
  recordTerminal,
} from "./jobs.mjs";
import { REPORT_TRANSPORT_CAP, boundedReportText, saveReport } from "./reports.mjs";

export { DELIVERY_STATES };
export const NOTIFICATION_STATES = ["pending", "accepted", "queued", "delivered", "failed", "unknown", "orphaned", "duplicate"];
// What a receipt can be based on. `pi-session-entry` is a durable pi session
// entry carrying the event identity (the strongest evidence available);
// `session-user-message` is the exact delivered text observed as a session user
// message; `turn-started` is retained for historical records; confirmed:false is not a receipt.
// `session-entry-content-correspondence` is the conservative fallback for a
// completion a previous release steered WITHOUT the identity metadata: the exact
// delivered text is the only link back to the event, so it is only ever used
// when that text maps to exactly one pending event (see the recovery section).
export const RECEIPT_KINDS = [
  "pi-session-entry",
  "session-user-message",
  "turn-started",
  "session-entry-content-correspondence",
  "unspecified",
];

// How many settled/superseded attempts a record keeps beside the current one.
// Bounded like every other history in the journal.
const ATTEMPT_HISTORY_LIMIT = 12;

export function notificationsDir(stateDir) {
  return join(stateDir, "notifications");
}

export function notificationPath(stateDir, eventId) {
  const safe = String(eventId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
  return join(notificationsDir(stateDir), `${safe}.json`);
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

// The journal, read with the distinctions recovery needs:
//   "missing"   — no record was ever written at this path;
//   "corrupt"   — a record exists but cannot be parsed: its bytes are evidence
//                 of an unreadable outcome and must be preserved before
//                 anything writes the path again;
//   "unreadable"— the path cannot be read at all (permissions, a filesystem
//                 object in the way): the same refusal applies, and nothing may
//                 be written over bytes that cannot even be preserved.
export function readNotificationState(stateDir, eventId) {
  const path = notificationPath(stateDir, eventId);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { status: "missing", record: null, raw: null };
    return { status: "unreadable", record: null, raw: null, error: err?.message || String(err) };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { status: "ok", record: deliveryEvidence(parsed), raw };
    return { status: "corrupt", record: null, raw };
  } catch {
    return { status: "corrupt", record: null, raw };
  }
}

export function readNotification(stateDir, eventId) {
  return readNotificationState(stateDir, eventId).record;
}

// Move an unreadable journal record aside before anything writes its path
// again. Uncertainty that cannot be preserved is never silently discarded: the
// caller refuses to overwrite the record when this fails.
export function preserveCorruptNotification(stateDir, eventId, { raw = null, now = Date.now() } = {}) {
  const safe = basename(notificationPath(stateDir, eventId)).replace(/\.json$/, "");
  const name = `${safe}.corrupt-${now}.bak`;
  const path = join(notificationsDir(stateDir), name);
  let alreadyPreserved = false;
  try {
    alreadyPreserved = statSync(path).isFile();
  } catch {
    alreadyPreserved = false;
  }
  try {
    mkdirSync(notificationsDir(stateDir), { recursive: true });
    // The same unreadable record can be refused more than once (each pass
    // reports it). The first preserved copy is the evidence, so an existing
    // quarantine file is kept instead of being rewritten — while a path that
    // exists but is not that file still fails the write rather than pretending
    // the bytes were preserved.
    if (!alreadyPreserved) writeFileSync(path, typeof raw === "string" ? raw : "", "utf8");
  } catch (err) {
    return { ok: false, quarantined: null, reason: "corrupt-evidence-preserve-failed", error: err?.message || String(err) };
  }
  return {
    ok: true,
    quarantined: name,
    preservedChars: alreadyPreserved ? 0 : typeof raw === "string" ? raw.length : 0,
    existing: alreadyPreserved,
  };
}

export function listNotifications(stateDir) {
  let names;
  try {
    names = readdirSync(notificationsDir(stateDir));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const record = readNotification(stateDir, name.slice(0, -5));
    if (record) out.push(record);
  }
  return out;
}

// A notification with a receipt is complete: repeats are duplicates, not new
// deliveries. Transport acceptance alone (accepted/queued), a failed attempt and
// an unprovable outcome stay retryable/reconcilable.
//
// Dedupe modes:
//   "durable" (default) — the delivered record in the state directory decides.
//     An event ID is delivered at most once for the life of the workflow, so a
//     reconnect, a duplicated callback, or a restart cannot duplicate a side
//     effect.
//   "process" — only repeats seen by this process are treated as duplicates.
//     The compatibility adapter for in-memory MCP trackers uses this: it keeps
//     the durable record for inspection and recovery without letting a record
//     from an earlier, unrelated process swallow a fresh delivery.
const processSeen = new Set();

export function isDuplicate(stateDir, eventId, { dedupe = "durable" } = {}) {
  if (dedupe !== "durable") return processSeen.has(eventId);
  const record = readNotification(stateDir, eventId);
  if (!record) return false;
  // Only a receipt-bearing delivery is a duplicate. `accepted`/`queued` mean the
  // transport moved the message, not that the session retained it, so they never
  // suppress an attempt by themselves; reconciliation decides them with
  // evidence. `unknown` must never be silently swallowed either.
  return record.state === "delivered";
}

// Record a process-scoped confirmation. A failed attempt is deliberately NOT
// recorded: it stays retryable, exactly like the durable mode where a `failed`
// record is not a duplicate. Without this, a transport failure would be
// swallowed as a duplicate by the next attempt in the same process.
export function markProcessSeen(eventId, state = null) {
  if (state === "failed") return;
  processSeen.add(eventId);
}

export function completedEventId(job) {
  return `${job.role}:${job.id}:terminal`;
}

// ---------------------------------------------------------------------------
// Durable acknowledgement.
// ---------------------------------------------------------------------------

// Durable delivery-attempt INTENT, written BEFORE the transport is invoked.
//
// The crash window this closes: the external transport accepted the message and
// the process died before its callback could be journaled. Without a durable
// intent that event looks exactly like one that was never sent — nothing
// recorded, or (for the internal execution-host handoff) a bare `queued` record
// the owning coordinator still owes an external send — and the next pass blindly
// sends it again. With it, the journal proves an attempt was in flight, and an
// attempt whose callback never settled is outcome-unknown until the owning
// session's evidence resolves it.
//
// The write is MERGED, never a replacement: it adds the attempt (moving the
// previous attempt into a bounded history) and preserves everything else the
// record holds — an earlier receipt, the queued/accepted history of an internal
// handoff, and the report reference (an earlier report pointer wins; an intent
// never re-points a record away from the report it already has). It deliberately
// does NOT advance `seq`: the sequence counts recorded results, and an intent is
// not a result — it has its own `count` and timestamps.
function writeAttemptIntent(stateDir, eventId, { transport = null, now = Date.now(), seed = null } = {}) {
  const previous = readNotification(stateDir, eventId);
  const priorAttempt = previous?.attempt ?? null;
  const attempt = {
    count: (priorAttempt?.count ?? 0) + 1,
    at: now,
    transport: transport ?? null,
    settled: false,
    settledAt: null,
    settledBy: null,
    result: null,
    reason: null,
  };
  const attemptHistory = [
    ...(previous?.attemptHistory ?? []),
    ...(priorAttempt ? [priorAttempt] : []),
  ].slice(-ATTEMPT_HISTORY_LIMIT);
  const record = previous
    ? {
        ...previous,
        reportId: previous.reportId ?? seed?.reportId ?? null,
        reportChars: previous.reportId ? previous.reportChars : seed?.reportChars ?? 0,
        resultAvailable: previous.resultAvailable || Boolean(seed?.reportId),
        truncated: previous.truncated || Boolean(seed?.truncated),
        attempt,
        attemptHistory,
      }
    : {
        schema: 1,
        eventId,
        jobId: seed?.jobId ?? null,
        role: seed?.role ?? null,
        workflow: seed?.workflow ?? null,
        // A record that holds only an intent claims no result yet.
        state: "pending",
        transport: null,
        reason: null,
        messageId: null,
        via: null,
        reportId: seed?.reportId ?? null,
        reportChars: seed?.reportChars ?? 0,
        resultAvailable: Boolean(seed?.reportId),
        truncated: Boolean(seed?.truncated),
        deliveredTextChars: 0,
        deliveryAt: null,
        stateAt: now,
        receipt: null,
        receiptAt: null,
        acknowledgedAt: null,
        seq: 0,
        attempt,
        attemptHistory,
      };
  writeJsonAtomic(notificationPath(stateDir, eventId), record);
  return { record, previous, fresh: !previous };
}

// Apply a notification-record update with the same monotonic rule the job
// projection uses: a later queued/failed result can never overwrite a receipt,
// and the acceptance facts an earlier attempt recorded stay in the record. The
// state is re-read here (not carried in from a caller's earlier read), so a
// later weak result from ANOTHER process cannot erase strong evidence a
// concurrent writer already persisted either.
//
// `patch.settleAttempt` closes the attempt the record carries: the callback
// landed (its result is `requested`, applied or suppressed) or a receipt
// resolved it. A suppressed late callback settles nothing new — the attempt it
// belongs to is already closed by whatever wrote first.
function applyNotificationState(stateDir, eventId, patch) {
  const previous = readNotification(stateDir, eventId);
  if (!previous) return null;
  const requested = patch.state ?? null;
  // A `pending` record holds an intent, not a result: it must never swallow the
  // result that settles it (an explicit refusal has to land as `failed`).
  const priorState = previous.state === "pending" ? null : previous.state ?? null;
  const next = requested ? nextDeliveryState(priorState, requested) : previous.state ?? null;
  const applied = requested ? next === requested : false;
  const transitioned = applied && (previous.state ?? null) !== next;
  const record = {
    ...previous,
    state: next,
    transport: patch.transport ?? previous.transport ?? null,
    reason: applied ? patch.reason ?? null : previous.reason ?? null,
    messageId: patch.messageId ?? previous.messageId ?? null,
    via: patch.via ?? previous.via ?? null,
    reportId: patch.reportId ?? previous.reportId ?? null,
    reportChars: patch.reportChars ?? previous.reportChars ?? 0,
    resultAvailable: patch.resultAvailable ?? previous.resultAvailable ?? false,
    truncated: patch.truncated ?? previous.truncated ?? false,
    deliveredTextChars: patch.deliveredTextChars ?? previous.deliveredTextChars ?? 0,
    receipt: patch.receipt ?? previous.receipt ?? null,
    receiptAt: patch.receiptAt ?? previous.receiptAt ?? null,
    acknowledgedAt: patch.acknowledgedAt ?? previous.acknowledgedAt ?? null,
    // `stateAt` is when the state this record holds began; `deliveryAt` is when
    // the transport/observation last produced it; `acknowledgedAt` is when a
    // receipt proved it. A suppressed straggler changes none of them (its time
    // lives in `lastResult`).
    stateAt: transitioned ? patch.now ?? Date.now() : previous.stateAt ?? previous.deliveryAt ?? null,
    deliveryAt: applied ? patch.deliveryAt ?? previous.deliveryAt ?? patch.now ?? Date.now() : previous.deliveryAt ?? null,
    // A suppressed result is still history: the transport/observation happened,
    // it just did not become the record's state.
    lastResult: applied ? previous.lastResult ?? null : { state: requested, at: patch.now ?? Date.now(), reason: patch.reason ?? null, applied: false },
    attempt:
      patch.settleAttempt && previous.attempt && previous.attempt.settled !== true
        ? {
            ...previous.attempt,
            settled: true,
            settledAt: patch.now ?? Date.now(),
            settledBy: patch.settleAttempt.by ?? "callback",
            result: patch.settleAttempt.result ?? null,
            reason: patch.settleAttempt.reason ?? null,
          }
        : previous.attempt ?? null,
    attemptHistory: previous.attemptHistory ?? [],
    seq: (previous.seq ?? 0) + 1,
  };
  writeJsonAtomic(notificationPath(stateDir, eventId), record);
  return { record, previous, applied };
}

// Rebuild a lost or unreadable journal record from the authoritative, owner-bound
// job projection.
//
// Recovery only calls this after checking that the job belongs to the session
// performing recovery (`job.workflow.sessionKey`) and that the event ID is the
// job's own event; the projection is where those facts are durable. A projection
// that records no identity only ever matches its own canonical event ID, so
// nothing can be repaired under an identity the event does not have.
//
// A record that exists but cannot be parsed is preserved (quarantined next to
// the journal) before anything writes its path: if the bytes cannot be
// preserved, nothing is written at all and the uncertainty is reported.
export function repairNotificationFromJob({ stateDir, job, eventId, now = Date.now() } = {}) {
  if (!stateDir) throw new Error("stateDir is required");
  if (!job?.id) return { ok: false, repaired: false, reason: "job-required" };
  if (!eventId) return { ok: false, repaired: false, reason: "eventId is required" };
  const identity = job.delivery?.eventId ?? null;
  if (identity ? identity !== eventId : eventId !== completedEventId(job)) {
    return { ok: false, repaired: false, reason: "event-not-owned-by-job" };
  }
  const current = readNotificationState(stateDir, eventId);
  if (current.status === "ok") return { ok: true, repaired: false, record: current.record, reason: null };
  if (current.status === "unreadable") {
    // Nothing may be written over a record whose bytes cannot even be read (and
    // therefore cannot be preserved): the uncertainty is reported instead.
    return { ok: false, repaired: false, reason: "notification-record-unreadable", error: current.error ?? null };
  }
  const delivery = deliveryEvidence(job.delivery ?? null);
  const at = delivery?.at ?? job.terminal?.at ?? now;
  const repair = { at: now, source: "job-projection", previous: current.status, quarantined: null, preservedChars: 0 };
  if (current.status === "corrupt") {
    const preserved = preserveCorruptNotification(stateDir, eventId, { raw: current.raw, now });
    if (!preserved.ok) return { ok: false, repaired: false, reason: preserved.reason, error: preserved.error };
    repair.quarantined = preserved.quarantined;
    repair.preservedChars = preserved.preservedChars;
  }
  const record = {
    schema: 1,
    eventId: identity,
    jobId: job.id,
    role: job.role,
    workflow: job.workflow ?? null,
    state: DELIVERY_STATES.includes(delivery?.state ?? "") ? delivery.state : "queued",
    transport: delivery?.transport ?? null,
    reason: delivery?.reason ?? null,
    messageId: delivery?.messageId ?? null,
    via: null,
    reportId: job.terminal?.reportId ?? null,
    reportChars: job.terminal?.reportChars ?? 0,
    resultAvailable: Boolean(job.terminal?.reportId),
    truncated: false,
    deliveredTextChars: null,
    deliveryAt: at,
    stateAt: delivery?.stateAt ?? at,
    receipt: delivery?.receipt ?? null,
    receiptAt: null,
    acknowledgedAt: null,
    seq: 1,
    repair,
  };
  try {
    writeJsonAtomic(notificationPath(stateDir, eventId), record);
  } catch (err) {
    return { ok: false, repaired: false, reason: "notification-write-failed", error: err?.message || String(err), quarantined: repair.quarantined };
  }
  return { ok: true, repaired: true, record, repair, quarantined: repair.quarantined };
}

// Acknowledge a completion with a receipt: the owning session retained this
// exact event. The receipt is the strongest fact the workflow can hold, so it
// upgrades an accepted/queued/unknown record to `delivered` and writes the job
// projection after the journal, so the record recovery reads first is never the
// stale one. Idempotent: a repeated receipt refreshes the evidence (entry id,
// session file, observation time) without creating a second delivery.
//
// Every write result is reported, never assumed: a receipt whose record could
// not be written, and a projection that could not be updated, are both returned
// as failures so a caller may not report a successful reconciliation for them.
// `projectionEventId` is the identity the projection's history is matched on; a
// pre-metadata record keeps its identity-less form (only its own receipt is
// recorded) instead of having an identity written into it.
export function acknowledgeDelivery({
  stateDir,
  eventId,
  jobId = null,
  receipt = null,
  now = Date.now(),
  reason = null,
  projectionEventId = undefined,
} = {}) {
  if (!stateDir) throw new Error("stateDir is required");
  if (!eventId) throw new Error("eventId is required");
  if (receipt?.confirmed === false) {
    return { ok: false, acknowledged: false, eventId, jobId, state: null, reason: "unconfirmed-receipt" };
  }
  const journal = readNotificationState(stateDir, eventId);
  if (journal.status !== "ok") {
    // Consumption can be observed before the send call returns and the router
    // writes the journal, and a record can also be lost or corrupted afterwards.
    // The caller keeps the in-memory receipt and re-applies it; nothing may
    // claim delivery before a readable record exists.
    return {
      ok: false,
      acknowledged: false,
      eventId,
      jobId,
      state: null,
      reason:
        journal.status === "corrupt"
          ? "notification-record-corrupt"
          : journal.status === "unreadable"
            ? "notification-record-unreadable"
            : "no-notification-record",
    };
  }
  const previous = journal.record;
  const confirmed = { ...(receipt ?? { kind: "unspecified", at: now }) };
  let applied;
  try {
    applied = applyNotificationState(stateDir, eventId, {
      state: "delivered",
      receipt: confirmed,
      receiptAt: confirmed.at ?? now,
      acknowledgedAt: now,
      reason,
      // A receipt RESOLVES an attempt whose callback never settled: the outcome
      // is no longer unknown — the session provably retained the event.
      settleAttempt: { result: "delivered", by: "receipt", reason },
      now,
    });
  } catch (err) {
    return { ok: false, acknowledged: false, eventId, jobId, state: null, reason: "notification-write-failed", error: err?.message || String(err) };
  }
  const record = applied.record;
  const targetJob = jobId ?? previous.jobId ?? null;
  let job = null;
  let jobError = null;
  // A progress receipt must never overwrite (or fabricate) terminal delivery
  // state. The notification journal above already retains its own receipt.
  const projectionJob = targetJob ? readJob(stateDir, targetJob) : null;
  if (targetJob && (!projectionJob || eventId === completedEventId(projectionJob))) {
    try {
      job = markDelivery(stateDir, targetJob, {
        eventId: projectionEventId === undefined ? eventId : projectionEventId,
        state: "delivered",
        transport: record.transport,
        messageId: record.messageId,
        receipt: record.receipt,
        now,
      });
    } catch (err) {
      // The journal is the durable receipt; a missing projection is reported,
      // never invented.
      jobError = err?.message || String(err);
    }
  }
  return {
    ok: true,
    acknowledged: true,
    alreadyDelivered: previous.state === "delivered",
    eventId,
    jobId: targetJob,
    state: "delivered",
    delivery: record,
    job,
    ...(jobError ? { jobError } : {}),
  };
}

// ---------------------------------------------------------------------------
// Routing.
// ---------------------------------------------------------------------------

// Concurrent attempts for the same (state, event) coalesce onto one send: a
// duplicate callback in flight reports the same outcome instead of racing a
// second delivery. Sequential retries are unaffected.
const inFlightRoutes = new Map();

export async function routeNotification(options = {}) {
  const { stateDir, eventId } = options;
  if (!stateDir) throw new Error("stateDir is required");
  if (!eventId) throw new Error("eventId is required");
  const key = `${stateDir}\u0000${eventId}`;
  const pending = inFlightRoutes.get(key);
  if (pending) {
    const settled = await pending;
    return { ...settled, coalesced: true };
  }
  const attempt = routeNotificationOnce(options);
  inFlightRoutes.set(key, attempt);
  try {
    return await attempt;
  } finally {
    if (inFlightRoutes.get(key) === attempt) inFlightRoutes.delete(key);
  }
}

// Route one notification through a transport.
//
// Durable, bounded, and idempotent: the full report is saved first (when one is
// supplied), the delivered text is bounded to `cap`, the transport's acceptance
// is recorded verbatim, and the event ID decides duplicates. Returns the state
// the transport actually achieved — never a claim of delivery that did not
// happen, and never a downgrade of a receipt that already exists.
async function routeNotificationOnce({
  stateDir,
  eventId,
  jobId = null,
  role = null,
  workflow = null,
  text,
  reportText = null,
  reportId = null,
  reportChars = 0,
  transport,
  terminal = null,
  cap,
  dedupe = "durable",
  persistJob = false,
  // The caller resolved an outcome-unknown attempt first: owning-session
  // evidence proved the event absent, or the operator explicitly decided a
  // retry. Without it, a lost callback is never silently resent.
  resolveUnknownOutcome = false,
  now = Date.now(),
} = {}) {
  if (!transport || typeof transport.deliver !== "function") {
    throw new Error("a transport with deliver() is required");
  }

  if (isDuplicate(stateDir, eventId, { dedupe })) {
    const existing = readNotification(stateDir, eventId);
    return { ok: true, eventId, state: "duplicate", duplicate: true, delivery: existing };
  }

  // Whatever writes here must never overwrite a record whose bytes are evidence
  // of an unreadable outcome. A corrupt record is preserved (quarantined) before
  // this attempt replaces it — the caller's attempt still happens, so a
  // completion whose absence was proven can still reach its owner — and an
  // attempt to write over a record that cannot even be read is refused, because
  // nothing about it can be preserved or verified.
  const journalState = readNotificationState(stateDir, eventId);
  if (journalState.status === "unreadable") {
    return { ok: false, eventId, state: "failed", reason: "notification-record-unreadable", delivery: null, report: null };
  }
  if (journalState.status === "corrupt") {
    const preserved = preserveCorruptNotification(stateDir, eventId, { raw: journalState.raw, now });
    if (!preserved.ok) {
      return { ok: false, eventId, state: "failed", reason: preserved.reason, delivery: null, report: null };
    }
  }

  // A previous attempt whose callback never settled is outcome-unknown: the
  // external transport may have accepted the message before the crash, so
  // sending again could duplicate it — and a journal that still shows only the
  // internal handoff's `queued` would make that look like a first send. Nothing
  // is sent behind a lost callback unless the caller resolved the uncertainty
  // first (the owning session's evidence proved the event absent, or the
  // operator explicitly decided a retry).
  const prior = journalState.status === "ok" ? journalState.record : null;
  if (prior?.attempt && prior.attempt.settled !== true && !resolveUnknownOutcome) {
    return { ok: false, eventId, state: "unknown", reason: "delivery-attempt-outcome-unknown", delivery: prior, attempt: prior.attempt, report: null };
  }

  let report = reportId ? { reportId, chars: reportChars } : null;
  const body = typeof reportText === "string" ? reportText : typeof text === "string" ? text : "";
  if (!report && body) {
    const saved = saveReport(stateDir, { jobId: jobId ?? eventId, role: role ?? "job", text: body, now });
    report = { reportId: saved.reportId, chars: saved.chars };
  }

  const bounded = boundedReportText(typeof text === "string" ? text : body, {
    cap: cap ?? undefined,
    reportId: report?.reportId ?? null,
    label: "record",
  });

  // The attempt is durable BEFORE the transport is invoked (report-before-notify
  // intact: the report above is already saved). An intent that cannot be written
  // means the attempt must not start: an external send whose intent was lost is
  // exactly the blind-duplicate window this closes.
  try {
    writeAttemptIntent(stateDir, eventId, {
      transport: transport.name ?? "unknown",
      now,
      seed: {
        jobId,
        role,
        workflow,
        reportId: report?.reportId ?? null,
        reportChars: report?.chars ?? 0,
        truncated: bounded.truncated,
      },
    });
  } catch (err) {
    return { ok: false, eventId, state: "failed", reason: "delivery-intent-write-failed", error: err?.message || String(err), delivery: null, report };
  }

  let result;
  try {
    result = await transport.deliver({
      eventId,
      jobId,
      role,
      kind: `${role ?? "job"}.terminal`,
      workflow,
      text: bounded.text,
      fullTextChars: body.length,
      reportId: report?.reportId ?? null,
      truncated: bounded.truncated,
      terminal,
    });
  } catch (err) {
    result = { state: "failed", reason: err?.message || String(err) };
  }
  const reported = result?.state === "delivered" && result?.receipt?.confirmed === false
    ? "queued" : DELIVERY_STATES.includes(result?.state) ? result.state : "failed";
  // A receipt observed while the transport call was in flight is stronger than
  // the transport result, and a receipt already on disk is never downgraded.
  const receipt = result?.receipt ?? null;
  const patch = {
    state: reported,
    transport: transport.name ?? "unknown",
    reason: result?.reason ?? null,
    messageId: result?.messageId ?? null,
    via: result?.via ?? null,
    reportId: report?.reportId ?? null,
    reportChars: report?.chars ?? 0,
    // Result availability is a property of persistence, not of delivery: the
    // bounded text may be truncated while the full report still exists.
    resultAvailable: Boolean(report?.reportId),
    truncated: bounded.truncated,
    deliveredTextChars: bounded.text.length,
    deliveryAt: now,
    receipt,
    receiptAt: receipt?.at ?? null,
    // The callback settled the attempt: its result is recorded on the attempt
    // itself (applied or not), so a lost callback stays distinguishable from a
    // refusal the callback explicitly proved.
    settleAttempt: { result: reported, reason: result?.reason ?? null },
    now,
  };
  let applied = applyNotificationState(stateDir, eventId, patch);
  if (!applied) {
    // The intent record was lost mid-attempt (a concurrent cleanup, a foreign
    // writer): rebuild it around the result that actually came back, so the
    // attempt is never recorded as one that never happened.
    writeAttemptIntent(stateDir, eventId, {
      transport: patch.transport,
      now,
      seed: { jobId, role, workflow, reportId: patch.reportId, reportChars: patch.reportChars, truncated: patch.truncated },
    });
    applied = applyNotificationState(stateDir, eventId, patch);
  }
  const record = applied.record;
  // The process-scoped confirmation exists for the process-dedupe adapter; a
  // durable-mode route is governed by the durable record alone.
  if (dedupe !== "durable") markProcessSeen(eventId, record.state);
  if (persistJob && jobId) {
    markDelivery(stateDir, jobId, {
      eventId,
      // The projection ends where the journal ends (they must agree), and the
      // result this attempt actually observed is recorded next to it.
      state: record.state,
      observed: reported,
      reason: record.reason,
      messageId: record.messageId,
      transport: record.transport,
      receipt: record.receipt ?? null,
      now,
    });
  }
  return { ok: record.state !== "failed", eventId, state: record.state, delivery: record, report, transportResult: result };
}

// Default delivery text: identity, role, truthful status, bounded body, and the
// durable report reference. A transport never has to invent a summary.
export function defaultCompletionText(job, { cap = 4000 } = {}) {
  if (!job) return "";
  const parts = [];
  if (job.terminal?.summary) parts.push(String(job.terminal.summary));
  if (job.terminal?.error?.message && !parts.some((part) => part.includes(job.terminal.error.message))) {
    parts.push(String(job.terminal.error.message));
  }
  const body = parts.join(" — ");
  const bounded = typeof body === "string" && body.length > cap ? `${body.slice(0, cap)}… [${body.length - cap} chars omitted]` : body;
  const report = job.terminal?.reportId ? `\nFull report: read_report reportId='${job.terminal.reportId}'.` : "";
  return `${job.role} ${job.id} ${job.terminal?.status ?? job.status}: ${bounded}${report}`;
}

// Terminal completion delivery for one durable job: ensures the job's terminal
// record points at the persisted report before routing the notification.
export async function deliverCompletion({ stateDir, job, transport, text = null, reportText = null, role = null, now = Date.now(), cap, resolveUnknownOutcome = false } = {}) {
  if (!stateDir) throw new Error("stateDir is required");
  if (!job?.id) throw new Error("job is required");
  const body = typeof reportText === "string" ? reportText : text ?? job.terminal?.summary ?? "";
  let report = job.terminal?.reportId ? { reportId: job.terminal.reportId, chars: job.terminal.reportChars } : null;
  if (!report && body) {
    const saved = saveReport(stateDir, { jobId: job.id, role: role ?? job.role, text: body, now });
    report = { reportId: saved.reportId, chars: saved.chars };
    if (job.terminal) {
      recordTerminal(stateDir, job.id, {
        status: job.terminal.status,
        summary: job.terminal.summary,
        reportId: saved.reportId,
        reportChars: saved.chars,
        error: job.terminal.error,
        now,
      });
    }
  }
  return routeNotification({
    stateDir,
    eventId: completedEventId(job),
    jobId: job.id,
    role: role ?? job.role,
    workflow: job.workflow ?? null,
    text: typeof text === "string" ? text : defaultCompletionText(job),
    reportText: body,
    reportId: report?.reportId ?? null,
    reportChars: report?.chars ?? 0,
    transport,
    terminal: job.terminal ?? null,
    cap,
    persistJob: true,
    resolveUnknownOutcome,
    now,
  });
}

// ---------------------------------------------------------------------------
// Recovery.
// ---------------------------------------------------------------------------

// The text a session entry carries: this release reports it as `text`, while a
// raw pi entry stores a plain string (custom messages) or content parts.
function evidenceText(entry) {
  if (typeof entry?.text === "string") return entry.text;
  const content = entry?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
  return null;
}

function evidenceAt(entry) {
  if (typeof entry?.at === "number") return entry.at;
  const parsed = typeof entry?.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

// Session evidence the recovery decision is made against. `known` means the
// owning session was actually inspected, so an absent event proves it is not in
// that session; `pendingMessages` means the live session still holds queued
// messages, so an unverified event may still be in flight; `inFlight` names the
// exact events the live session is still holding in its message queue (a pi
// custom steer is invisible to `hasPendingMessages()`, so the owning extension
// supplies them per event).
//
// `unidentified` is the one piece of evidence that is NOT identity-bound: the
// completions a previous release steered before the identity metadata existed.
// They are preserved rather than discarded, because dropping them would make an
// event the session demonstrably retained look like an event it never received
// — and that difference decides whether a wakeup is replayed (duplicated) or
// acknowledged. They are only ever read through `matchLegacyEvidence` below.
export function normalizeEvidence(evidence) {
  if (!evidence) {
    return { known: false, byEventId: new Map(), unidentified: [], userMessages: [], sessionFile: null, pendingMessages: null, inFlight: new Set(), at: null };
  }
  const byEventId = new Map();
  const unidentified = [];
  const userMessages = [];
  // Legacy completion evidence reaches the reader in one of two shapes: the
  // owning reader's normalized `{entryId, text}` form, or a raw pi session entry
  // for a completion of this profile (`custom_message` of the completion type,
  // text, no `details.eventId`). Both are accepted, because discarding either
  // would turn a retained completion into an event the session provably never
  // received — the exact defect this evidence exists to prevent.
  const collect = (entry, { requireCompletionType }) => {
    if (!entry || typeof entry !== "object") return;
    const text = evidenceText(entry);
    if (!text) return;
    // A raw entry is completion evidence only when it is labelled as such; the
    // normalized channel may omit the label (its caller scoped the list already),
    // but a foreign label is never completion evidence.
    const labelled = entry.customType;
    if (requireCompletionType ? labelled !== ARCHITECT_COMPLETION_CUSTOM_TYPE : labelled != null && labelled !== ARCHITECT_COMPLETION_CUSTOM_TYPE) return;
    unidentified.push({
      entryId: entry.entryId ?? entry.id ?? null,
      at: evidenceAt(entry),
      text,
      customType: entry.customType ?? ARCHITECT_COMPLETION_CUSTOM_TYPE,
      sessionFile: entry.sessionFile ?? evidence.sessionFile ?? null,
    });
  };
  for (const entry of evidence.entries ?? []) {
    const eventId = typeof entry === "string" ? entry : entry?.eventId;
    if (typeof eventId === "string" && eventId) {
      byEventId.set(eventId, typeof entry === "string" ? { eventId } : entry);
      continue;
    }
    collect(entry, { requireCompletionType: true });
  }
  for (const entry of evidence.unidentified ?? []) {
    collect(entry, { requireCompletionType: false });
  }
  // Idle wakes are ordinary Pi user messages, without custom event metadata.
  // Preserve their exact text for the same conservative correspondence used
  // by the live receipt checker. Dropping this evidence on reopen duplicates
  // a wake saved just before the workflow receipt was written.
  if (evidence.userMessages instanceof Map) {
    for (const [text, entries] of evidence.userMessages) {
      if (typeof text !== "string" || !Array.isArray(entries)) continue;
      for (const entry of entries) userMessages.push({ ...entry, text, source: "user-message" });
    }
  }
  for (const entry of evidence.entries ?? []) {
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const text = evidenceText(entry.message);
    if (text) userMessages.push({ entryId: entry.id ?? null, at: evidenceAt(entry), text, source: "user-message" });
  }
  const inFlight = new Set();
  if (evidence.inFlight && typeof evidence.inFlight !== "string" && typeof evidence.inFlight[Symbol.iterator] === "function") {
    for (const entry of evidence.inFlight) {
      const eventId = typeof entry === "string" ? entry : entry?.eventId;
      if (typeof eventId === "string" && eventId) inFlight.add(eventId);
    }
  }
  return {
    known: true,
    byEventId,
    unidentified,
    userMessages,
    sessionFile: evidence.sessionFile ?? null,
    pendingMessages: typeof evidence.pendingMessages === "boolean" ? evidence.pendingMessages : null,
    inFlight,
    at: evidence.at ?? null,
  };
}

function receiptFromEvidence(eventId, entry, evidence, now) {
  return {
    kind: entry.kind ?? "pi-session-entry",
    eventId,
    entryId: entry.entryId ?? null,
    sessionFile: entry.sessionFile ?? evidence.sessionFile ?? null,
    at: entry.at ?? null,
    observedAt: now,
  };
}

// The text this event's completion carries, exactly as it would have been
// delivered: the canonical completion text, and — when the transport cap bites —
// the bounded form the router actually sent. Both are computed from the durable
// job record, so the correspondence below compares against the real delivery,
// not against a paraphrase of it.
export function completionTextForms(job) {
  const full = defaultCompletionText(job);
  const bounded = boundedReportText(full, { cap: REPORT_TRANSPORT_CAP, reportId: job?.terminal?.reportId ?? null, label: "record" });
  return bounded.text === full ? [full] : [full, bounded.text];
}

function completionHeader(job) {
  return `${job?.role ?? "job"} ${job?.id ?? "unknown"} ${job?.terminal?.status ?? job?.status ?? "unknown"}: `;
}

// Read the identity-less completion entries as evidence for one pending event.
//
//   "exact"       — the entry text IS this event's delivered text, and exactly
//                   one pending event in this session can claim that text, so
//                   the session provably retained this event: acknowledge it.
//   "ambiguous"   — the text matches, but more than one pending event could have
//                   carried it: nothing is proven, nothing is replayed.
//   "unconfirmed" — an entry carries this event's canonical header without the
//                   exact text (a truncated or differently formatted copy from
//                   that release): the identity cannot be confirmed, so nothing
//                   is replayed and nothing is claimed.
//   "none"        — no entry relates to this event, so its absence stands.
//
// Anything that is not an exact unique match is deliberately NOT a receipt: a
// similar text is never treated as proof, and the event is retained as unknown
// for an explicit decision instead of being replayed on a guess.
export function matchLegacyEvidence({ job, evidence, claimants = new Map() } = {}) {
  const known = evidence?.byEventId ? evidence : normalizeEvidence(evidence);
  if (known.unidentified.length === 0 && !known.userMessages?.length) return { state: "none" };
  const forms = completionTextForms(job);
  // Prefer labelled completion evidence when present. Ordinary user text is
  // only the idle-wake fallback, not another copy of a labelled completion.
  const labelled = known.unidentified.filter((entry) => forms.includes(entry.text));
  const matches = labelled.length ? labelled : (known.userMessages ?? []).filter((entry) => forms.includes(entry.text));
  if (matches.length > 0) {
    const claimantsForText = new Set();
    for (const form of forms) for (const id of claimants.get(form) ?? []) claimantsForText.add(id);
    if (claimantsForText.size > 1) {
      return { state: "ambiguous", reason: "legacy-completion-identity-ambiguous", candidates: matches.length, claimants: [...claimantsForText].sort() };
    }
    return { state: "exact", entry: matches[0], copies: matches.length, text: matches[0].text };
  }
  const header = completionHeader(job);
  const plausible = known.unidentified.filter((entry) => entry.text.startsWith(header) || header.startsWith(entry.text));
  if (plausible.length > 0) {
    return { state: "unconfirmed", reason: "legacy-completion-identity-unconfirmed", candidates: plausible.length };
  }
  return { state: "none" };
}

// Outcome-unknown: no identity or no evidence can prove what happened. The
// records keep the acceptance facts they already have; the state says the
// outcome is unprovable, and recovery reports it instead of guessing.
//
// The projection's identity is carried through verbatim — a pre-metadata record
// with no event ID stays identity-less, because that absence is what makes its
// outcome unprovable on every later pass. Writing a derived ID back into the
// record would erase the only marker separating "cannot be proven" from "was
// proven absent", and the next pass would auto-replay it. `markDelivery` matches
// on that identity, so the acceptance evidence (transport, queue time, message
// id, attempt count) is preserved as well.
//
// `eventId` is the identity the projection's delivery slot is matched and
// written on (see `projectionIdentity` in the recovery pass). The identity-less
// form is reserved for a delivery record that EXISTS without an event ID; a
// projection that never held a delivery record is written under the event's own
// identity, because that identity is known — a `null` there would fabricate the
// pre-metadata shape and keep a merely uncertain event unprovable forever.
function markOutcomeUnknown(stateDir, job, { eventId, reason, now, detail = null }) {
  const identity = job.delivery?.eventId ?? null;
  const recordId = identity ?? eventId ?? completedEventId(job);
  let delivery = null;
  try {
    delivery = markDelivery(stateDir, job.id, { eventId: eventId ?? null, state: "unknown", reason, now });
  } catch {
    delivery = null;
  }
  const previous = readNotification(stateDir, recordId);
  if (previous) {
    applyNotificationState(stateDir, recordId, { state: "unknown", reason, now });
  }
  return {
    jobId: job.id,
    eventId: recordId,
    state: delivery?.delivery?.state ?? "unknown",
    previousState: job.delivery?.state ?? null,
    reason,
    ...(detail ? { detail } : {}),
  };
}

// Converge a proven retention with the durable records, and report what was
// actually written.
//
// Two writes are involved and either can fail: the journal (the receipt) and the
// job projection. A caller may only report a reconciliation when both effects
// landed, so every result is checked here — a receipt that could not be
// persisted is an error, never a success, and never a reason to send again.
function reconcileDelivery({ stateDir, job, eventId, projectionEventId, receipt, journalRecord, now }) {
  const repaired = repairNotificationFromJob({ stateDir, job, eventId, now });
  if (!repaired.ok) return { ok: false, reason: repaired.reason, error: repaired.error ?? null };
  if (receipt) {
    const ack = acknowledgeDelivery({ stateDir, eventId, jobId: job.id, receipt, now, projectionEventId });
    if (!ack.ok) return { ok: false, reason: ack.reason ?? "receipt-write-failed", error: ack.error ?? null, repaired: repaired.repaired };
    if (ack.jobError) return { ok: false, reason: "projection-write-failed", error: ack.jobError, repaired: repaired.repaired, delivery: ack.delivery };
    return { ok: true, delivery: ack.delivery, job: ack.job, repaired: repaired.repaired, quarantine: repaired.quarantined ?? null };
  }
  // Delivered without a stored receipt (a transport that confirmed the turn
  // itself): converge the projection on the journal's fact.
  try {
    const applied = applyNotificationState(stateDir, eventId, {
      state: "delivered",
      transport: journalRecord?.transport ?? null,
      messageId: journalRecord?.messageId ?? null,
      reason: journalRecord?.reason ?? null,
      now,
    });
    const projected = markDelivery(stateDir, job.id, {
      eventId: projectionEventId,
      state: "delivered",
      transport: journalRecord?.transport ?? null,
      messageId: journalRecord?.messageId ?? null,
      reason: journalRecord?.reason ?? null,
      now,
    });
    return { ok: true, delivery: applied?.record ?? null, job: projected, repaired: repaired.repaired, quarantine: repaired.quarantined ?? null };
  } catch (err) {
    return { ok: false, reason: "projection-write-failed", error: err?.message || String(err) };
  }
}

function reportReconciliation(summary, { job, eventId, state, converged, receipt, evidence: kind }) {
  if (!converged.ok) {
    summary.errors.push({
      jobId: job.id,
      eventId,
      previousState: state,
      reason: converged.reason,
      ...(converged.error ? { error: converged.error } : {}),
      ...(converged.quarantine ? { quarantined: converged.quarantine } : {}),
    });
    return;
  }
  summary.reconciled.push({
    jobId: job.id,
    eventId,
    state: "delivered",
    previousState: state,
    entryId: receipt?.entryId ?? null,
    evidence: kind,
    ...(converged.repaired ? { repaired: true } : {}),
    ...(converged.quarantine ? { quarantined: converged.quarantine } : {}),
  });
}

// Recovery of completion delivery after a restart/reconnect.
//
// Ownership is checked before anything is sent: a pending notification is only
// replayed for the workflow session that owns it. Anything else is orphaned and
// reported, never re-routed. Within the owning session:
//   * evidence that the session retained the exact event → acknowledge it as
//     delivered (the receipt path; nothing is resent). A journal record that the
//     receipt would have to be written into is repaired from the owner-bound job
//     projection first, and a record that cannot be repaired is an error — never
//     a reported success and never a resend;
//   * the same, for a completion a previous release steered without the identity
//     metadata: an exact, unique content correspondence is retention. Identical
//     or ambiguous candidates are retained as outcome-unknown, never replayed;
//   * the live session still holds this exact event in its message queue
//     (`evidence.inFlight`, because a pi custom steer is invisible to
//     `hasPendingMessages()`) → defer it; it is on its way and resending would
//     duplicate it;
//   * a volatile (accepted/queued) event absent from the session, with no queued
//     messages left → replay: the crash happened before the drain;
//   * an event with an UNSETTLED delivery attempt (the transport was invoked and
//     its callback never landed) is outcome-unknown like a volatile event: it is
//     resolved by the evidence above — retention acknowledges it, proven absence
//     replays the SAME event — and with no evidence it is retained as unknown
//     instead of being blindly duplicated behind a lost callback;
//   * a volatile event that cannot be resolved (no identity, or no evidence
//     source) → retained as outcome-unknown and reported, never blindly
//     duplicated;
//   * nothing recorded or a failed attempt → replay as before.
// `allowUnverified` is the explicit operator path (`/qq_recover`): it retries
// unprovable events on the operator's decision instead of retaining them. It
// does not override a positive in-flight fact — an event still queued in the
// live session is never re-sent behind the operator's back — and that fact is
// bounded: the owning extension releases it when the message drains, when its
// receipt is observed, and when the run it entered settles. A legacy
// correspondence that is merely ambiguous is retried by that path too: the
// operator's explicit decision is the only thing that may turn unproven
// evidence into a second delivery.
export async function recoverPendingDeliveries({
  stateDir,
  sessionKey,
  transport,
  now = Date.now(),
  cap,
  evidence = null,
  allowUnverified = false,
  ownsJob = null,
} = {}) {
  if (!stateDir) throw new Error("stateDir is required");
  const summary = {
    replayed: [],
    duplicates: [],
    skipped: [],
    orphaned: [],
    reconciled: [],
    deferred: [],
    uncertain: [],
    errors: [],
  };
  const known = normalizeEvidence(evidence);
  const jobs = listJobsWithPendingDelivery(stateDir);
  // Which pending event each canonical completion text belongs to, so a text two
  // records could claim is never read as proof for either of them.
  const claimants = new Map();
  for (const job of jobs) {
    if ((job.workflow?.sessionKey ?? null) !== sessionKey) continue;
    if(ownsJob&&!ownsJob(job))continue;
    for (const text of completionTextForms(job)) {
      const list = claimants.get(text) ?? [];
      if (!list.includes(job.id)) list.push(job.id);
      claimants.set(text, list);
    }
  }
  for (const persistedJob of jobs) {
    // Older receivers could project a progress receipt into this single slot.
    // Ignore that foreign event for completion recovery; preserve its journal.
    const job = { ...persistedJob, delivery: terminalDelivery(persistedJob) };
    const owner = job.workflow?.sessionKey ?? null;
    if (owner !== sessionKey || (ownsJob&&!ownsJob(job))) {
      summary.orphaned.push({ jobId: job.id, owner, requested: sessionKey ?? null });
      continue;
    }
    const state = job.delivery?.state ?? null;
    const identity = job.delivery?.eventId ?? null;
    const eventId = identity ?? completedEventId(job);
    const identityMissing = Boolean(job.delivery && !identity);
    // The identity the projection's delivery slot is matched and written on. A
    // pre-metadata projection (a delivery record that EXISTS without an event
    // ID) keeps that identity-less form verbatim; a projection that never held
    // a delivery record is written under this event's own identity, which is
    // known — fabricating identity-less-ness there would keep a merely
    // uncertain event unprovable on every later pass.
    const projectionIdentity = identity ?? (job.delivery ? null : eventId);
    // 1. The owning session already retained this exact event, or the journal
    //    (which is written before the projection) already holds its receipt:
    //    acknowledge it instead of sending anything again.
    const proven = known.byEventId.get(eventId);
    const journalState = readNotificationState(stateDir, eventId);
    const journal = journalState.status === "ok" ? journalState.record : null;
    const journalDelivered = journal?.state === "delivered";
    // An UNSETTLED delivery attempt is a lost callback: the transport was
    // invoked (its intent is durable) and no result ever came back, so the
    // outcome is unknown even when the projection still looks like a
    // never-sent internal handoff or recorded no delivery at all. It is decided
    // by the same evidence rules as a volatile state below — retention
    // acknowledges it, proven absence replays the same event, and no evidence
    // keeps the uncertainty instead of duplicating a possibly-accepted send.
    const unsettled = Boolean(journal?.attempt && journal.attempt.settled !== true);
    // The journal is written before the job projection. A crash between those
    // writes cannot turn a durably queued send into an apparently unsent one.
    const unverified = unsettled || UNVERIFIED_DELIVERY_STATES.includes(state ?? "")
      || UNVERIFIED_DELIVERY_STATES.includes(journal?.state ?? "");
    if (proven || journalDelivered) {
      const receipt = proven ? receiptFromEvidence(eventId, proven, known, now) : journal.receipt ?? null;
      const converged = reconcileDelivery({ stateDir, job, eventId, projectionEventId: projectionIdentity, receipt, journalRecord: journal, now });
      reportReconciliation(summary, {
        job,
        eventId,
        state,
        converged,
        receipt,
        evidence: proven ? "session-entry" : receipt ? "journal-receipt" : "journal-delivery",
      });
      continue;
    }
    // 1b. A completion from a release that persisted the text without the
    //     identity metadata. Only an exact, unique correspondence counts as
    //     retention; anything weaker is reported and deliberately not replayed,
    //     because the entry proves *a* completion was retained, not which one.
    const legacy = matchLegacyEvidence({ job, evidence: known, claimants });
    if (legacy.state === "exact") {
      const receipt = {
        kind: legacy.entry.source === "user-message" ? "session-user-message" : "session-entry-content-correspondence",
        eventId,
        entryId: legacy.entry.entryId,
        sessionFile: legacy.entry.sessionFile ?? known.sessionFile,
        at: legacy.entry.at ?? null,
        observedAt: now,
        copies: legacy.copies,
        textChars: legacy.text.length,
      };
      const converged = reconcileDelivery({ stateDir, job, eventId, projectionEventId: projectionIdentity, receipt, journalRecord: journal, now });
      reportReconciliation(summary, { job, eventId, state, converged, receipt, evidence: "legacy-content-correspondence" });
      continue;
    }
    if (legacy.state !== "none" && !allowUnverified) {
      summary.uncertain.push(
        markOutcomeUnknown(stateDir, job, {
          eventId: projectionIdentity,
          reason: legacy.reason,
          now,
          detail: { state: legacy.state, candidates: legacy.candidates ?? legacy.copies ?? null, claimants: legacy.claimants ?? null },
        }),
      );
      continue;
    }
    // 2. Positive in-flight knowledge: the live session still holds this exact
    //    event in its message queue. It is on its way, so resending it would
    //    duplicate the completion; this is known state, not uncertainty, so even
    //    explicit recovery defers it. The claim is bounded by the owning
    //    extension (drain, receipt, settled run), so a queue that was abandoned
    //    can never block reconciliation forever.
    if (unverified && known.inFlight.has(eventId)) {
      summary.deferred.push({ jobId: job.id, eventId, state, reason: "pending-in-session" });
      continue;
    }
    // 3. Unprovable on this pass: never replayed automatically. A pre-metadata
    //    record has no event identity at all, so no evidence can ever prove its
    //    outcome: it stays identity-less (and un-replayed) until an explicit
    //    retry — unless the legacy correspondence above proved it was retained,
    //    which is the one fact that resolves it without guessing. A record that
    //    merely lacked readable evidence is re-evaluated by the next pass that
    //    can read the session (retention acknowledges it, proven absence replays
    //    it); this pass refuses to guess either way.
    if (!allowUnverified && (identityMissing || (unverified && !known.known))) {
      summary.uncertain.push(
        markOutcomeUnknown(stateDir, job, {
          eventId: projectionIdentity,
          reason: identityMissing ? "missing-event-identity" : "no-session-evidence",
          now,
        }),
      );
      continue;
    }
    // 4. The live session still holds queued messages: an unverified event may
    //    still be in flight, so nothing is resent under it. An explicit operator
    //    retry may still decide the event is lost (that is the /qq_recover
    //    contract).
    if (!allowUnverified && unverified && known.pendingMessages === true) {
      summary.deferred.push({ jobId: job.id, eventId, state, reason: "pending-in-session" });
      continue;
    }
    if (!transport || typeof transport.deliver !== "function") {
      summary.skipped.push({ jobId: job.id, reason: "no-transport" });
      continue;
    }
    // 5. The event never reached the session (or nothing was accepted/failed):
    //    replay it to the owner. A journal record that cannot be parsed is moved
    //    aside first — the replay would otherwise overwrite the only evidence
    //    that the outcome was unreadable — and the replay is refused when even
    //    that is impossible. The same refusal applies to a record that cannot be
    //    read at all.
    if (journalState.status === "unreadable") {
      summary.errors.push({
        jobId: job.id,
        eventId,
        previousState: state,
        reason: "notification-record-unreadable",
        ...(journalState.error ? { error: journalState.error } : {}),
      });
      continue;
    }
    if (journalState.status === "corrupt") {
      const preserved = preserveCorruptNotification(stateDir, eventId, { raw: journalState.raw, now });
      if (!preserved.ok) {
        summary.errors.push({ jobId: job.id, eventId, previousState: state, reason: preserved.reason, error: preserved.error });
        continue;
      }
    }
    let result;
    try {
      // Reaching this point IS the resolution of the uncertainty: nothing was
      // recorded, the attempt settled with a refusal the callback proved, or the
      // evidence above proved the event absent (or the operator explicitly
      // decided a retry). The router is told so it may send behind a lost
      // callback — the exact same event ID, never a new one.
      result = await deliverCompletion({ stateDir, job, transport, now, cap, resolveUnknownOutcome: true });
    } catch (err) {
      // A replay that could not even be recorded (an unwritable journal) is
      // reported: recovery never loses the event, and never claims it was sent.
      summary.errors.push({ jobId: job.id, eventId, previousState: state, reason: "replay-failed", error: err?.message || String(err) });
      continue;
    }
    if (result.state === "duplicate") summary.duplicates.push({ jobId: job.id, eventId: result.eventId });
    else if (result.ok) summary.replayed.push({ jobId: job.id, eventId: result.eventId, state: result.state, previousState: state, reason: unverified ? "receipt-absent" : "undelivered" });
    else summary.skipped.push({ jobId: job.id, reason: result.delivery?.reason ?? result.reason ?? "delivery-failed" });
  }
  return summary;
}

export function listJobsWithPendingDelivery(stateDir) {
  const dir = join(stateDir, "jobs");
  if (!existsSync(dir)) return [];
  const ids = readdirSync(dir).filter((name) => name.endsWith(".json"));
  const out = [];
  for (const name of ids) {
    const id = name.slice(0, -5);
    if (!deliveryPending(stateDir, id)) continue;
    const job = readJob(stateDir, id);
    if (job) out.push(job);
  }
  return out;
}
