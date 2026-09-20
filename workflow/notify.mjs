// Transport-independent completion delivery.
//
// The router owns the difference between four distinct facts:
//   accepted  — the transport took the message (e.g. a queue command exited 0)
//   queued    — the message is queued behind the operator's active turn
//   delivered — a turn was started in the live session, so the operator sees it
//   available — the complete result is durably retrievable (never implied by delivery)
// Every notification carries a stable event ID. Repeats with the same event ID
// are recorded as duplicates and never re-delivered, so a reconnect or a
// duplicated callback cannot create a second workflow side effect.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deliveryPending, markDelivery, readJob, recordTerminal } from "./jobs.mjs";
import { boundedReportText, saveReport } from "./reports.mjs";

export const DELIVERY_STATES = ["accepted", "queued", "delivered", "failed"];
export const NOTIFICATION_STATES = ["pending", "accepted", "queued", "delivered", "failed", "orphaned", "duplicate"];

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

export function readNotification(stateDir, eventId) {
  try {
    const parsed = JSON.parse(readFileSync(notificationPath(stateDir, eventId), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
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

// A notification whose transport call has already been accepted (or delivered)
// is complete: repeats are duplicates, not new deliveries. A failed delivery
// stays retryable.
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
  return record.state === "delivered" || record.state === "queued" || record.state === "accepted";
}

export function markProcessSeen(eventId) {
  processSeen.add(eventId);
}

export function completedEventId(job) {
  return `${job.role}:${job.id}:terminal`;
}

// Route one notification through a transport.
//
// Durable, bounded, and idempotent: the full report is saved first (when one is
// supplied), the delivered text is bounded to `cap`, the transport's acceptance
// is recorded verbatim, and the event ID decides duplicates. Returns the state
// the transport actually achieved — never a claim of delivery that did not
// happen.
export async function routeNotification({
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
  now = Date.now(),
} = {}) {
  if (!stateDir) throw new Error("stateDir is required");
  if (!eventId) throw new Error("eventId is required");
  if (!transport || typeof transport.deliver !== "function") {
    throw new Error("a transport with deliver() is required");
  }

  if (isDuplicate(stateDir, eventId, { dedupe })) {
    const existing = readNotification(stateDir, eventId);
    return { ok: true, eventId, state: "duplicate", duplicate: true, delivery: existing };
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
  const state = DELIVERY_STATES.includes(result?.state) ? result.state : "failed";
  const previous = readNotification(stateDir, eventId);
  const record = {
    schema: 1,
    eventId,
    jobId,
    role,
    workflow: workflow ?? null,
    state,
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
    seq: (previous?.seq ?? 0) + 1,
  };
  writeJsonAtomic(notificationPath(stateDir, eventId), record);
  markProcessSeen(eventId);
  if (persistJob && jobId) {
    markDelivery(stateDir, jobId, {
      eventId,
      state,
      reason: record.reason,
      messageId: record.messageId,
      transport: record.transport,
      now,
    });
  }
  return { ok: state !== "failed", eventId, state, delivery: record, report, transportResult: result };
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
export async function deliverCompletion({ stateDir, job, transport, text = null, reportText = null, role = null, now = Date.now(), cap } = {}) {
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
    now,
  });
}

// Recovery of completion delivery after a restart/reconnect. Ownership is
// checked before anything is sent: a pending notification is only replayed for
// the workflow session that owns it. Anything else is marked orphaned and
// reported, never re-routed.
export async function recoverPendingDeliveries({ stateDir, sessionKey, transport, now = Date.now(), cap } = {}) {
  if (!stateDir) throw new Error("stateDir is required");
  const summary = { replayed: [], duplicates: [], skipped: [], orphaned: [] };
  const jobs = listJobsWithPendingDelivery(stateDir);
  for (const job of jobs) {
    const owner = job.workflow?.sessionKey ?? null;
    if (owner !== sessionKey) {
      summary.orphaned.push({ jobId: job.id, owner, requested: sessionKey ?? null });
      continue;
    }
    if (!transport || typeof transport.deliver !== "function") {
      summary.skipped.push({ jobId: job.id, reason: "no-transport" });
      continue;
    }
    const result = await deliverCompletion({ stateDir, job, transport, now, cap });
    if (result.state === "duplicate") summary.duplicates.push({ jobId: job.id, eventId: result.eventId });
    else if (result.ok) summary.replayed.push({ jobId: job.id, eventId: result.eventId, state: result.state });
    else summary.skipped.push({ jobId: job.id, reason: result.delivery?.reason ?? "delivery-failed" });
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
