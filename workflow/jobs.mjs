// Durable job records for runner and execution work.
//
// Jobs survive process restarts because each record is a single JSON file under
// the workflow state directory. Records persist identity, ownership, phase,
// cancellation tombstones, launch-plan provenance, terminal results and the
// delivery state of their notification. Reconciliation only ever reports what
// the kernel and repository say; it never kills, adopts, or restarts work.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { acceptRunnerResult, renderRunnerFindings } from "./results.mjs";
import { saveReport } from "./reports.mjs";
import { dirname, join } from "node:path";

export const JOB_SCHEMA = 1;
export const RUNNING = "running";
export const TERMINAL_STATUSES = ["completed", "failed", "cancelled", "interrupted", "reconciliation-required"];

export function jobsDir(stateDir) {
  return join(stateDir, "jobs");
}

export function jobPath(stateDir, jobId) {
  const safe = String(jobId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return join(jobsDir(stateDir), `${safe}.json`);
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function clampText(value, max = 2000) {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} chars omitted]`;
}

// Ownership fingerprint: PID reuse is real, so a live PID is only trustworthy
// when its start time and command line still match what we recorded at spawn.
export function processFingerprint({ pid, env = process.env, readFile = readFileSync } = {}) {
  if (!pid) return null;
  try {
    const stat = readFile(join("/proc", String(pid), "stat"), "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    const startTicks = fields[19];
    const cmdline = readFile(join("/proc", String(pid), "cmdline"), "utf8").split("\0").filter(Boolean).join(" ");
    return {
      pid,
      startTicks,
      cmdlineHash: createHash("sha256").update(cmdline).digest("hex").slice(0, 16),
      cmdlineTail: clampText(cmdline, 200),
    };
  } catch {
    return null;
  }
}

export function isProcessAlive(pid, { kill = process.kill } = {}) {
  if (!pid) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

export function createJob({
  stateDir,
  id,
  role,
  kind = null,
  workflow,
  cwd,
  task = null,
  launchPlan = null,
  process: processInfo = null,
  now = Date.now(),
} = {}) {
  if (!stateDir) throw new Error("stateDir is required");
  if (!id) throw new Error("job id is required");
  if (!role) throw new Error("job role is required");
  if (!workflow?.sessionKey) throw new Error("workflow session key is required");
  const record = {
    schema: JOB_SCHEMA,
    id,
    role,
    kind,
    workflow: {
      sessionKey: workflow.sessionKey,
      sessionId: workflow.sessionId ?? null,
      ownerAgentId: workflow.ownerAgentId ?? null,
      root: workflow.root ?? null,
    },
    cwd: cwd ?? workflow.root ?? null,
    task: clampText(task, 4000),
    status: RUNNING,
    phase: role === "execution" ? "prepare" : null,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    process: processInfo
      ? { ...processInfo, fingerprint: processInfo.fingerprint ?? processFingerprint({ pid: processInfo.pid }) }
      : null,
    launchPlan: launchPlan ?? null,
    cancellation: null,
    terminal: null,
    delivery: null,
    recovery: null,
    events: [],
  };
  writeJob(stateDir, record);
  return record;
}

export function writeJob(stateDir, record) {
  const next = { ...record, updatedAt: record.updatedAt ?? Date.now() };
  writeJsonAtomic(jobPath(stateDir, next.id), next);
  return next;
}

export function readJob(stateDir, jobId) {
  try {
    const parsed = JSON.parse(readFileSync(jobPath(stateDir, jobId), "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function listJobs(stateDir, { sessionKey = null, role = null } = {}) {
  let names;
  try {
    names = readdirSync(jobsDir(stateDir));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const record = readJob(stateDir, name.slice(0, -5));
    if (!record) continue;
    if (sessionKey && record.workflow?.sessionKey !== sessionKey) continue;
    if (role && record.role !== role) continue;
    out.push(record);
  }
  return out.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

export function updateJob(stateDir, jobId, patch, { now = Date.now() } = {}) {
  const current = readJob(stateDir, jobId);
  if (!current) throw new Error(`unknown job '${jobId}'`);
  const next = { ...current, ...patch, updatedAt: now };
  writeJob(stateDir, next);
  return next;
}

export function appendJobEvent(stateDir, jobId, event, { now = Date.now(), limit = 40 } = {}) {
  const current = readJob(stateDir, jobId);
  if (!current) throw new Error(`unknown job '${jobId}'`);
  const events = [...(Array.isArray(current.events) ? current.events : []), { at: now, ...event }].slice(-limit);
  return writeJob(stateDir, { ...current, events, updatedAt: now });
}

export function recordCancellation(
  stateDir,
  jobId,
  { by = null, reason = "cancelled by architect", now = Date.now() } = {},
) {
  const current = readJob(stateDir, jobId);
  if (!current) throw new Error(`unknown job '${jobId}'`);
  if (current.status !== RUNNING) return current;
  // A cancellation is a terminal outcome: persist the tombstone AND a terminal
  // record so recovery can never mistake it for work that still needs delivery.
  return writeJob(stateDir, {
    ...current,
    status: "cancelled",
    finishedAt: now,
    updatedAt: now,
    cancellation: { at: now, by, reason },
    terminal: {
      status: "cancelled",
      at: now,
      ok: false,
      summary: `cancelled by ${by ?? "architect"}: ${reason}`,
      reportId: null,
      reportChars: 0,
      resultAvailable: false,
      error: null,
    },
    events: [...(current.events ?? []), { at: now, action: "cancelled" }].slice(-40),
  });
}

export function isCancellationTombstoned(stateDir, jobId) {
  const record = readJob(stateDir, jobId);
  return Boolean(record?.cancellation);
}

// Persist the terminal outcome BEFORE any notification is attempted. `reportId`
// points at the full durable report; `summary` is the bounded text that may be
// delivered through a capped transport.
export function recordTerminal(
  stateDir,
  jobId,
  { status, summary = "", reportId = null, reportChars = 0, error = null, phase = null, now = Date.now() },
) {
  if (!TERMINAL_STATUSES.includes(status)) throw new Error(`invalid terminal status '${status}'`);
  const current = readJob(stateDir, jobId);
  if (!current) throw new Error(`unknown job '${jobId}'`);
  if (current.terminal) return current;
  const events = [...(current.events ?? []), { at: now, action: "terminal", status }].slice(-40);
  return writeJob(stateDir, {
    ...current,
    status,
    phase: phase ?? current.phase ?? null,
    finishedAt: now,
    updatedAt: now,
    events,
    terminal: {
      status,
      at: now,
      ok: status === "completed",
      summary: clampText(summary, 4000),
      reportId,
      reportChars,
      resultAvailable: Boolean(reportId),
      error: error ? { message: clampText(error.message ?? String(error), 800), phase: error.phase ?? phase ?? null } : null,
    },
  });
}

// ---------------------------------------------------------------------------
// Delivery bookkeeping. One notification per (job, event) — the event ID is the
// dedupe key, so a repeated callback after a restart cannot double-deliver.
//
// A delivery state is a fact about the notification, never about the work:
//   accepted/queued — the transport took the message but no receipt proves the
//                     session retained it (volatile: a crash before the drain
//                     loses it, so it stays reconcilable)
//   delivered       — a receipt for this exact event exists (a pi session entry
//                     or a started turn), recorded with its evidence
//   failed          — the transport refused the message; nothing was accepted
//   unknown         — the outcome cannot be proven (identity or receipt
//                     evidence is missing); never replayed automatically and
//                     never reported as delivered. A record with no event ID
//                     keeps that absence, so no later pass can mistake it for an
//                     event whose absence was proven
// ---------------------------------------------------------------------------

export const DELIVERY_STATES = ["accepted", "queued", "delivered", "failed", "unknown"];

// States without a receipt: the message may or may not have reached the
// operator. They are eligible for reconciliation (evidence first, resend only
// when the absence is proven) and never suppress a later attempt by themselves.
export const UNVERIFIED_DELIVERY_STATES = ["accepted", "queued", "unknown"];

// Monotonic in the direction that matters: a later, weaker result can never
// overwrite a receipt-bearing `delivered`, and a failed attempt never erases an
// earlier acceptance or an already-unknown outcome. The acceptance timestamps
// an earlier attempt recorded are preserved either way.
export function nextDeliveryState(previous, incoming) {
  if (!incoming) return previous ?? null;
  if (!previous) return incoming;
  if (previous === "delivered" || incoming === "delivered") return "delivered";
  if (incoming === "failed") return previous;
  if (previous === "failed") return incoming;
  return incoming;
}

export function markDelivery(
  stateDir,
  jobId,
  { eventId, state, observed = null, reason = null, messageId = null, transport = null, receipt = null, now = Date.now() },
) {
  const current = readJob(stateDir, jobId);
  if (!current) throw new Error(`unknown job '${jobId}'`);
  if (!DELIVERY_STATES.includes(state)) throw new Error(`invalid delivery state '${state}'`);
  if (observed && !DELIVERY_STATES.includes(observed)) throw new Error(`invalid delivery state '${observed}'`);
  // Attempts are counted per recorded result; identity is matched per event so a
  // record from a different event never inherits this job's history. `observed`
  // is the result this write is based on when it differs from the state the
  // projection ends up holding (a straggler result suppressed by a receipt).
  //
  // A pre-metadata record has no identity, and that absence IS its identity:
  // `null`/`undefined` match each other, so marking such a record (e.g. as
  // `unknown`) neither invents an event ID nor resets the acceptance evidence
  // the record already carries.
  const previous = current.delivery && (current.delivery.eventId ?? null) === (eventId ?? null) ? deliveryEvidence(current.delivery) : null;
  const previousState = previous?.state ?? null;
  const next = nextDeliveryState(previousState, state);
  const observedState = observed ?? state;
  // A result the record could not take (weaker than the state it holds) is still
  // history: the transport result happened, it just did not become the state.
  const suppressed = nextDeliveryState(next, observedState) !== observedState;
  // State timestamps move only when the state actually changes: a repeated
  // receipt, a duplicate hook, or a straggler result must not rewrite when the
  // delivery happened.
  const transitioned = previousState !== next;
  const delivery = {
    eventId: eventId ?? null,
    state: next,
    transport: transport ?? previous?.transport ?? null,
    attempts: (previous?.attempts ?? 0) + 1,
    at: now,
    stateAt: transitioned ? now : previous?.stateAt ?? previous?.at ?? null,
    acceptedAt: transitioned && next === "accepted" ? now : previous?.acceptedAt ?? null,
    queuedAt: transitioned && next === "queued" ? now : previous?.queuedAt ?? null,
    deliveredAt: transitioned && next === "delivered" ? now : previous?.deliveredAt ?? null,
    // An independently confirmed journal delivery must not inherit an old
    // explicitly unconfirmed receipt and normalize back to queued forever.
    receipt: receipt ?? (next === "delivered" && previous?.receipt?.confirmed === false ? null : previous?.receipt ?? null),
    ...(previous?.legacyUnconfirmedReceipt ? {
      legacyUnconfirmedReceipt: previous.legacyUnconfirmedReceipt,
      legacyReportedState: previous.legacyReportedState,
    } : {}),
    reason: suppressed ? previous?.reason ?? null : reason ?? null,
    messageId: messageId ?? previous?.messageId ?? null,
    lastResult: suppressed ? { state: observedState, at: now, reason: reason ?? null, applied: false } : previous?.lastResult ?? null,
  };
  return writeJob(stateDir, { ...current, delivery, updatedAt: now });
}

// The job projection tracks only its terminal notification. Progress/blocker
// receipts live in their own journal entries and cannot satisfy completion.
// Identity-less historical projections retain their uncertainty semantics.
export function deliveryEvidence(delivery) {
  if (delivery?.state === "delivered" && delivery.receipt?.confirmed === false) {
    return { ...delivery, state: "queued", legacyReportedState: "delivered",
      legacyUnconfirmedReceipt: delivery.legacyUnconfirmedReceipt ?? delivery.receipt };
  }
  return delivery;
}

export function terminalDelivery(record) {
  const delivery = deliveryEvidence(record?.delivery ?? null);
  if (delivery?.eventId && delivery.eventId !== `${record.role}:${record.id}:terminal`) return null;
  return delivery;
}

// A pending completion is a terminal result whose notification is not confirmed
// delivered: never attempted, refused, only accepted by a transport, or of
// unprovable outcome. Cancellations are architect-initiated and need no wakeup.
export function deliveryPending(stateDir, jobId) {
  const record = readJob(stateDir, jobId);
  if (!record?.terminal) return false;
  const state = terminalDelivery(record)?.state;
  if (state === "delivered") return false;
  if (state) return true;
  return record.terminal.status !== "cancelled";
}

// ---------------------------------------------------------------------------
// Reconciliation. Called on reload/restart for every non-terminal record.
// Verdicts are truthful: a record never claims completion, and an unrelated
// process is never adopted or killed.
// ---------------------------------------------------------------------------

export function reconcileJob(
  stateDir,
  jobId,
  { now = Date.now(), alive = isProcessAlive, fingerprint = (pid) => processFingerprint({ pid }) } = {},
) {
  const record = readJob(stateDir, jobId);
  if (!record) return null;
  if (record.terminal || record.status !== RUNNING) return record;

  if (record.cancellation) {
    return writeJob(stateDir, {
      ...record,
      status: "cancelled",
      finishedAt: record.finishedAt ?? record.cancellation.at ?? now,
      updatedAt: now,
      recovery: { reconciledAt: now, verdict: "cancelled", detail: "cancellation tombstone; recovery never restarts this job" },
    });
  }

  // Recover explicit, job-bound completion before interpreting disappearance.
  // A model transcript/final stdout is never accepted as a completion result.
  if (record.role === "runner" && !record.communication) {
    const runner = { id: record.id, resultFile: record.resultFile ?? join(tmpdir(), `qq-runner-result-${record.id}.json`) };
    let bound = false;
    try { bound = JSON.parse(readFileSync(runner.resultFile, "utf8")).runnerId === record.id; } catch {}
    if (bound) {
      const accepted = acceptRunnerResult(runner, { stateDir, saveReport, now });
      if (accepted.ok) {
        const text = renderRunnerFindings(accepted.result);
        const report = accepted.report ?? saveReport(stateDir, { jobId: record.id, role: record.role, text, now });
        return recordTerminal(stateDir, record.id, { status: "completed", summary: text,
          reportId: report.reportId, reportChars: report.chars, now });
      }
    }
  }
  const pid = record.process?.pid ?? null;
  const recorded = record.process?.fingerprint ?? null;
  if (!pid) {
    return writeJob(stateDir, {
      ...record,
      status: "reconciliation-required",
      updatedAt: now,
      recovery: {
        reconciledAt: now,
        verdict: "no-process-identity",
        detail: "job record has no process identity; reattachment is unsafe, inspect artifacts before continuing",
      },
    });
  }
  if (!alive(pid)) {
    return writeJob(stateDir, {
      ...record,
      status: "interrupted",
      finishedAt: now,
      updatedAt: now,
      terminal: record.terminal ?? {
        status: "interrupted",
        at: now,
        ok: false,
        summary: "process is gone; outcome unknown after restart",
        reportId: null,
        reportChars: 0,
        resultAvailable: false,
        error: { message: "worker process not found during reconciliation", phase: record.phase ?? null },
      },
      recovery: {
        reconciledAt: now,
        verdict: "interrupted",
        detail: "recorded process is gone; no automatic restart, no assumed completion",
      },
    });
  }
  const live = fingerprint(pid) ?? processFingerprint({ pid });
  if (!live) {
    return writeJob(stateDir, {
      ...record,
      status: "reconciliation-required",
      updatedAt: now,
      recovery: {
        reconciledAt: now,
        verdict: "process-unreadable",
        detail: "recorded pid is alive but its identity could not be read; not adopted",
      },
    });
  }
  if (recorded && (recorded.startTicks !== live.startTicks || recorded.cmdlineHash !== live.cmdlineHash)) {
    return writeJob(stateDir, {
      ...record,
      status: "reconciliation-required",
      updatedAt: now,
      recovery: {
        reconciledAt: now,
        verdict: "pid-reused",
        detail: "recorded pid now belongs to a different process (fingerprint mismatch); not adopted and not signalled",
        observed: { startTicks: live.startTicks, cmdlineTail: live.cmdlineTail },
      },
    });
  }
  // Liveness is an observation, not a state mutation. A concurrent host may
  // have published its terminal result during the process check.
  const latest = readJob(stateDir, jobId) ?? record;
  if (latest.terminal) return latest;
  return { ...latest, recovery: { reconciledAt: now, verdict: "running", detail: "recorded process matches its fingerprint" } };
}

export function reconcileAll(stateDir, options = {}) {
  const results = [];
  for (const record of listJobs(stateDir)) {
    const reconciled = reconcileJob(stateDir, record.id, options);
    if (reconciled) results.push(reconciled);
  }
  return results;
}

export function jobSummary(record) {
  if (!record) return null;
  return {
    id: record.id,
    role: record.role,
    kind: record.kind,
    status: record.status,
    phase: record.phase,
    sessionKey: record.workflow?.sessionKey ?? null,
    sessionId: record.workflow?.sessionId ?? null,
    ownerAgentId: record.workflow?.ownerAgentId ?? null,
    cwd: record.cwd,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    pid: record.process?.pid ?? null,
    launchPlan: record.launchPlan ?? null,
    cancelled: Boolean(record.cancellation),
    terminal: record.terminal
      ? {
          status: record.terminal.status,
          ok: record.terminal.ok,
          at: record.terminal.at,
          summary: record.terminal.summary ?? null,
          reportId: record.terminal.reportId,
          reportChars: record.terminal.reportChars ?? 0,
          resultAvailable: record.terminal.resultAvailable,
          error: record.terminal.error,
        }
      : null,
    delivery: terminalDelivery(record),
    recovery: record.recovery,
    reportId: record.terminal?.reportId ?? null,
  };
}

// Filesystem artifacts for a record, for callers that know the state directory.
export function jobArtifacts(stateDir, record) {
  if (!record) return null;
  return {
    record: jobPath(stateDir, record.id),
    report: record.terminal?.reportId ? join(stateDir, "reports", `${record.terminal.reportId}.txt`) : null,
  };
}
