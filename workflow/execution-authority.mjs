// Managed-execution authority over the ONE append-only change record.
//
// A managed execution's authoritative lifecycle — parent execution identity,
// phase ticket/worktree, coordinating owner, immutable original constraints,
// child role/job/attempt identities and revisions, assignment amendments,
// cancellation intent, landing admission, validated outcomes and durable
// evidence links — lives in ONE change record (workflow/change-record.mjs),
// whose change id IS the public execution/job id (direct lookup convention,
// never a second authority). Existing job/EXECUTIONS/notification files stay
// rebuildable views; host requests/results stay subordinate transport
// artifacts. Cancellation and the landing-admission boundary are serialized in
// this record through its own writer lock: there is no second lock or state
// system.
//
// Invariants enforced here (and in the reducer beneath):
//   * launch metadata is recoverable from the record and a host request is
//     verified against it before any work starts (forged requests fail closed);
//   * authoritative cancellation intent is recorded BEFORE any process is
//     signalled; a later successful outcome can never follow it;
//   * landing admission is refused after an accepted cancellation, and a
//     cancellation is refused (truthfully) after landing admission — landing
//     evidence is preserved and rollback is never implied;
//   * a pending/unacknowledged assignment update newer than the validated
//     result blocks automatic landing and stays visible for explicit decision;
//   * late results after cancellation are recorded as durable EVIDENCE with
//     their report references and never relabel cancellation as success;
//   * disappearance is never a known failed outcome: an attempt without a
//     recorded outcome is reported as outcome-unknown.
//
// Update lifecycle vocabulary (kept distinct everywhere it is reported):
//   submitted            — the revision + delivery obligation are committed;
//   transport-received   — the attempt's receiver accepted the delivery
//                          (transport receipt, never incorporation);
//   worker-acknowledged  — the attempt recorded `worker.acknowledged` for the
//                          exact revision (incorporation evidence);
//   fulfilled            — the targeted attempt acknowledged the update and
//                          completed successfully at that revision or later.

import { randomUUID, createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";

import {
  assertActorId,
  assertIdentifier,
  createChange,
  changeRecordPath,
  changesDir,
  openChange,
  viewsFor,
} from "./change-record.mjs";
import { submitAmendment } from "./communication.mjs";
import {
  adrCurationProjection,
  createAdrCurationHook,
  recoverAdrCuration,
} from "./adr-curation.mjs";
import { createJob, readJob, writeJob, processFingerprint } from "./jobs.mjs";
import { readNotification, routeNotification, normalizeEvidence, acknowledgeDelivery } from "./notify.mjs";

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function normalizeNow(now) {
  if (typeof now === "function") return now;
  const value = Number(now);
  return () => value;
}

function clampText(value, max) {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} chars omitted]`;
}

export const ROLE_SEATS = Object.freeze(["test_owner", "implementer", "reviewer"]);
export const DEFAULT_RUNTIME_ACTOR = "qq-execution-authority";

// Bounded view caps (check_execution projections never grow without bound).
export const VIEW_ROLES_MAX = 8;
export const VIEW_ATTEMPTS_MAX = 8;
export const VIEW_UPDATES_MAX = 8;
export const VIEW_REPORTS_MAX = 16;
export const VIEW_EVIDENCE_MAX = 8;
export const VIEW_PROGRESS_MAX = 4;

// Exact coordinator-authored composition copy (kept byte-identical to the
// shared runner lifecycle's composition; consolidate with
// workflow/runner-lifecycle.mjs when phase2b lands).
export const ASSIGNMENT_UPDATES_HEADING = "## Assignment updates";
export const ASSIGNMENT_UPDATES_PRECEDENCE =
  "Apply these updates in revision order. A later update takes precedence where it conflicts with an earlier instruction.";

/**
 * Compose the FULL assignment view: the original task verbatim, then — when
 * amendments exist — the exact heading and precedence sentence followed by
 * every amendment's verbatim text in committed revision order. Instructions
 * are never summarized, paraphrased, or replaced by the latest message.
 */
export function composeAssignment({ task, amendments = [] } = {}) {
  if (typeof task !== "string" || task.trim() === "") {
    throw fail("invalid-arguments", "task (the original assignment text) is required");
  }
  let text = task;
  const ordered = (Array.isArray(amendments) ? amendments : [])
    .filter((entry) => entry && Number.isInteger(entry.revision) && typeof entry.text === "string" && entry.text.trim() !== "")
    .sort((a, b) => a.revision - b.revision);
  if (ordered.length > 0) {
    text += `\n\n${ASSIGNMENT_UPDATES_HEADING}\n${ASSIGNMENT_UPDATES_PRECEDENCE}\n`;
    text += ordered.map((entry) => `\n[revision ${entry.revision}]\n${entry.text}`).join("\n");
  }
  return text;
}

/** The deterministic progress/blocker notification wrapper (role-attributed). */
export function roleProgressNotificationText({ role, jobId, kind, seq, attemptId, message }) {
  return `Runner ${jobId} (${role}) reported ${kind} at sequence ${seq} (attempt ${attemptId}):\n${message}`;
}

/** Stable change/job/attempt/sequence notification identity. */
export function roleProgressEventId({ changeId, jobId, attemptId, seq }) {
  return `execution:${jobId}:progress:${changeId}:${attemptId}:${seq}`;
}

function runtimeActor(runtimeActorId) {
  const id = runtimeActorId ?? DEFAULT_RUNTIME_ACTOR;
  assertActorId(id);
  return { kind: "runtime", id };
}

function executionHandle(stateDir, executionId) {
  assertIdentifier(executionId, "executionId");
  return openChange({ stateDir, changeId: executionId });
}

// ---------------------------------------------------------------------------
// Record creation: parent execution identity + immutable constraints + launch
// ---------------------------------------------------------------------------

/**
 * Record a NEW managed execution in its authoritative change record BEFORE the
 * host is spawned: change created, immutable original constraints (revision 1,
 * verbatim), the execution job registered against that revision, and the
 * attempt's unresolved launch intent carrying the full launch metadata a host
 * request is later reconstructed and verified against.
 *
 * Idempotent per command id: a retry with the same launch id is a record
 * dedupe; a DIFFERENT launch for the same attempt is a loud command conflict.
 */
export function recordManagedExecution({
  stateDir,
  executionId,
  actor = null,
  kind,
  phaseId,
  baseRef = null,
  root,
  owner,
  constraints,
  targetPaths = null,
  launchId,
  requestPath,
  attemptId = null,
  now = Date.now(),
} = {}) {
  assertIdentifier(executionId, "executionId");
  if (!["bounded", "open"].includes(kind)) throw fail("invalid-arguments", "kind must be 'bounded' or 'open'");
  if (typeof root !== "string" || !isAbsolute(root)) throw fail("invalid-arguments", "root must be an absolute path");
  if (typeof owner !== "string" || !owner.trim()) throw fail("invalid-arguments", "owner (the coordinating workflow session key) is required");
  if (typeof constraints !== "string" || !constraints.trim()) throw fail("invalid-arguments", "constraints (the immutable original assignment) is required");
  assertIdentifier(launchId, "launchId");
  if (typeof requestPath !== "string" || !isAbsolute(requestPath)) throw fail("invalid-arguments", "requestPath must be an absolute path");
  const nowMs = normalizeNow(now)();
  const resolved = runtimeActor(actor?.id ?? null);
  const resolvedAttemptId = attemptId ?? launchId;
  assertIdentifier(resolvedAttemptId, "attemptId");
  const launch = Object.freeze({
    kind,
    phaseId: phaseId ?? null,
    baseRef: baseRef ?? null,
    root: resolvePath(root),
    owner,
    launchId,
    requestPath: resolvePath(requestPath),
  });
  try {
    createChange({ stateDir, changeId: executionId, actor: resolved, title: `managed execution ${executionId}`, commandId: `create-${executionId}`, now: nowMs });
    const handle = executionHandle(stateDir, executionId);
    handle.append(
      "assignment.revised",
      { revision: 1, predecessor: null, scope: { kind: "change" }, assignment: { instructions: constraints } },
      { context: { actor: resolved }, commandId: `exec-${executionId}-r1`, now: nowMs },
    );
    handle.append(
      "job.registered",
      { role: "execution", pinnedRevision: 1 },
      { context: { actor: resolved, jobId: executionId }, commandId: `register-${executionId}`, now: nowMs },
    );
    handle.append(
      "attempt.launch_intent",
      {
        note: `managed execution launched by ${resolved.id}`,
        cwd: launch.root,
        owner,
        targetPaths: Array.isArray(targetPaths) && targetPaths.length ? targetPaths.map(String) : null,
        launch,
      },
      { context: { actor: resolved, jobId: executionId, attemptId: resolvedAttemptId }, commandId: `launch-${executionId}-${resolvedAttemptId}`, now: nowMs },
    );
  } catch (error) {
    if (error?.code === "command-conflict" || error?.code === "invalid-transition") {
      // An existing record is verified by verifyHostLaunch; only identical
      // relaunches dedupe here, anything else fails closed.
      const existing = readLaunchMetadata({ stateDir, executionId });
      if (existing?.launch?.launchId === launchId) return { ok: true, changeId: executionId, attemptId: resolvedAttemptId, launch, dedupe: true };
    }
    throw error;
  }
  return { ok: true, changeId: executionId, attemptId: resolvedAttemptId, launch, dedupe: false };
}

/** The committed launch metadata of the execution's launch attempt. */
export function readLaunchMetadata({ stateDir, executionId }) {
  const handle = executionHandle(stateDir, executionId);
  const state = handle.state;
  const job = state.jobs[executionId];
  if(job?.role!=="execution")return null;
  const attemptId = job?.attemptOrder?.[0] ?? null;
  if (!attemptId) return null;
  const attempt = viewsFor(state).attempt(executionId, attemptId);
  return {
    attemptId,
    constraintsRevision: attempt.launchIntent.revision,
    cwd: attempt.launchIntent.cwd ?? null,
    owner: attempt.launchIntent.owner ?? null,
    targetPaths: attempt.launchIntent.targetPaths ?? null,
    launch: attempt.launchIntent.launch ?? null,
    observedIdentity: attempt.started?.identity ?? null,
  };
}

// Absence is legacy only when neither a record nor a new-runtime marker exists.
// Corruption or loss of a new record must never authorize legacy behaviour.
export function executionAuthorityMetadata({ stateDir, executionId, job = readJob(stateDir, executionId) }) {
  if (!existsSync(changeRecordPath(stateDir, executionId))) {
    if (job?.executionHost?.authority === true || job?.communication?.enabled === true) {
      throw fail("authority-unavailable", "managed execution change record is missing");
    }
    return null;
  }
  const metadata = readLaunchMetadata({ stateDir, executionId });
  if(!metadata && job?.role!=="execution" && !job?.executionHost?.authority && !job?.communication?.enabled)return null;
  if (!metadata?.attemptId || !metadata.launch?.owner || !isAbsolute(metadata.launch?.root??"")) throw fail("authority-unavailable", "managed execution launch is not committed");
  return metadata;
}

/**
 * Reconstruct and verify a host request against the AUTHORITATIVE launch
 * metadata (the compatibility job record is only crosschecked, never
 * authoritative). A forged or edited request — different kind, phase, base,
 * owner, root, launch id or path — is refused before any work can start.
 */
export function verifyHostLaunch({ stateDir, executionId, request, requestPath = null }) {
  let meta;
  try {
    meta = readLaunchMetadata({ stateDir, executionId });
  } catch (error) {
    return { ok: false, reason: `authoritative launch metadata unavailable: ${error.message}` };
  }
  if (!meta?.launch) return { ok: false, reason: "no authoritative launch metadata is recorded for this execution" };
  const expected = meta.launch;
  const path = requestPath ?? request?.requestPath ?? null;
  const checks = [
    ["kind", expected.kind, request?.kind],
    ["phaseId", expected.phaseId ?? null, request?.phaseId ?? null],
    ["baseRef", expected.baseRef ?? null, request?.baseRef ?? null],
    ["owner", expected.owner, request?.owner],
    ["root", expected.root, request?.root ? resolvePath(request.root) : null],
    ["launchId", expected.launchId, request?.launchId],
    ["requestPath", expected.requestPath, path ? resolvePath(path) : null],
    ["executionId", executionId, request?.jobId],
  ];
  for (const [field, want, got] of checks) {
    if (want !== got) return { ok: false, reason: `execution host request ${field} mismatch: recorded ${JSON.stringify(want)} vs requested ${JSON.stringify(got)}` };
  }
  return { ok: true, launch: expected, attemptId: meta.attemptId };
}

/** Record the observed host process identity (`attempt.started`). Idempotent. */
export function recordHostStarted({ stateDir, executionId, attemptId, identity, actor = null, now = Date.now() } = {}) {
  const nowMs = normalizeNow(now)();
  const resolved = runtimeActor(actor?.id ?? null);
  const handle = executionHandle(stateDir, executionId);
  const attempt = handle.state.jobs[executionId]?.attempts[attemptId];
  if (!attempt) throw fail("not-found", `execution attempt '${attemptId}' is not recorded`);
  if (attempt.started) return { ok: true, dedupe: true };
  try {
    handle.append(
      "attempt.started",
      { identity },
      { context: { actor: resolved, jobId: executionId, attemptId }, commandId: `started-${executionId}-${attemptId}`, now: nowMs },
    );
    return { ok: true, dedupe: false };
  } catch (error) {
    if (error?.code === "command-conflict") return { ok: true, dedupe: true };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Child role jobs and attempts (implementer / reviewer)
// ---------------------------------------------------------------------------

/**
 * Register one managed seat (implementer/reviewer) attempt in the SAME
 * authoritative record: the role's assignment revision (the exact prompt the
 * seat receives — original constraints verbatim), the child job registration
 * pinning that revision, and the child attempt's launch intent.
 *
 * A RETRY (`retryOfJobId`) is a NEW attempt on the same role job. It retains
 * the original constraints and the updates prior attempts acknowledged
 * (composed with the exact updates copy); an update that was never
 * acknowledged stays targeted at its old attempt — unresolved, never migrated
 * and never silently dropped.
 */
export function registerRoleAttempt({
  stateDir,
  executionId,
  role,
  jobId,
  attemptId,
  prompt,
  retryOfJobId = null,
  reuseRevision = null,
  targetPaths = null,
  cwd = null,
  owner = null,
  actor = null,
  now = Date.now(),
} = {}) {
  if (!ROLE_SEATS.includes(role)) throw fail("invalid-arguments", `role must be one of ${ROLE_SEATS.join(", ")}`);
  assertIdentifier(jobId, "jobId");
  assertIdentifier(attemptId, "attemptId");
  if (typeof prompt !== "string" || !prompt.trim()) throw fail("invalid-arguments", "prompt (the role's original constraints) is required");
  const nowMs = normalizeNow(now)();
  const resolved = runtimeActor(actor?.id ?? null);
  const handle = executionHandle(stateDir, executionId);
  const state = handle.state;
  if (state.jobs[executionId]?.role !== "execution") throw fail("not-found", `change '${executionId}' has no registered execution job`);

  const continuation = retryOfJobId && state.jobs[retryOfJobId] ? retryOfJobId : null;
  if (retryOfJobId && !continuation) throw fail("not-found", `retry target job '${retryOfJobId}' is not registered in change '${executionId}'`);
  const targetJobId = continuation ?? jobId;

  // Retries retain original constraints plus the updates prior attempts of the
  // job acknowledged (applicable acknowledged instructions), composed with the
  // exact updates copy. Unacknowledged updates are NOT migrated here.
  const launch = readLaunchMetadata({stateDir,executionId});
  const approvedView = viewsFor(state).assignment({revision:launch.constraintsRevision});
  const approvedText = typeof approvedView.assignment === "string" ? approvedView.assignment : approvedView.assignment.instructions;
  let instructions = `${prompt}\n\nOriginal approved phase assignment (immutable):\n${approvedText}`;
  if (continuation) {
    const views = viewsFor(state);
    const jobView = views.job(targetJobId);
    const acknowledgedRevisions = new Set();
    for (const attempt of Object.values(jobView.attempts)) {
      for (const ack of attempt.acknowledgements) acknowledgedRevisions.add(ack.revision);
    }
    const carried = jobView.amendments
      .filter((entry) => acknowledgedRevisions.has(entry.revision))
      .map((entry) => ({ revision: entry.revision, text: entry.note ?? "" }))
      .filter((entry) => entry.text.trim() !== "");
    const firstAttempt = jobView.attempts[jobView.attemptOrder[0]];
    const originalView = views.assignment({revision:firstAttempt.launchIntent.revision});
    const originalText = typeof originalView.assignment === "string" ? originalView.assignment : originalView.assignment.instructions;
    instructions = composeAssignment({ task: `${originalText}\n\nRetry instructions:\n${prompt}`, amendments: carried });
  }

  const existingJob = state.jobs[targetJobId];
  let revision;
  if (Number.isInteger(reuseRevision)) {
    // Two attempts on the SAME assignment revision (an honest relaunch of the
    // identical assignment): nothing is re-authored and nothing is re-pinned;
    // the new attempt launches against the existing revision verbatim.
    const entry = state.revisions[reuseRevision - 1];
    if (!entry) throw fail("invalid-arguments", `reuseRevision ${reuseRevision} does not exist in change '${executionId}'`);
    if (entry.scope.kind === "job" && entry.scope.jobId !== targetJobId) {
      throw fail("invalid-arguments", `reuseRevision ${reuseRevision} targets job '${entry.scope.jobId}', not '${targetJobId}'`);
    }
    revision = reuseRevision;
    if (!existingJob) {
      const pin = state.changeRevision > 0 ? state.changeRevision : 1;
      handle.append(
        "job.registered",
        { role, pinnedRevision: pin },
        { context: { actor: resolved, jobId: targetJobId }, commandId: `register-${targetJobId}`, now: nowMs },
      );
    }
  } else if (existingJob) {
    revision = state.currentRevision + 1;
    handle.append(
      "assignment.revised",
      { revision, predecessor: state.currentRevision, scope: { kind: "job", jobId: targetJobId }, assignment: { instructions }, note: prompt },
      { context: { actor: resolved, jobId: targetJobId }, commandId: `revise-${targetJobId}-r${revision}`, now: nowMs },
    );
  } else {
    // A NEW role job registers against the change's immutable constraints (its
    // pin), then its own role assignment revision — the exact prompt the seat
    // receives — becomes its effective revision.
    const pin = state.changeRevision > 0 ? state.changeRevision : 1;
    handle.append(
      "job.registered",
      { role, pinnedRevision: pin },
      { context: { actor: resolved, jobId: targetJobId }, commandId: `register-${targetJobId}`, now: nowMs },
    );
    revision = state.currentRevision + 1;
    handle.append(
      "assignment.revised",
      { revision, predecessor: state.currentRevision, scope: { kind: "job", jobId: targetJobId }, assignment: { instructions }, note: prompt },
      { context: { actor: resolved, jobId: targetJobId }, commandId: `revise-${targetJobId}-r${revision}`, now: nowMs },
    );
  }
  handle.append(
    "attempt.launch_intent",
    {
      note: `managed ${role} attempt dispatched by ${resolved.id}`,
      cwd: typeof cwd === "string" && cwd ? cwd : null,
      owner: typeof owner === "string" && owner ? owner : null,
      targetPaths: Array.isArray(targetPaths) && targetPaths.length ? targetPaths.map(String) : null,
      revision,
    },
    { context: { actor: resolved, jobId: targetJobId, attemptId }, commandId: `launch-${targetJobId}-${attemptId}`, now: nowMs },
  );
  const assignment = viewsFor(handle.state).assignment({revision}).assignment;
  return { ok: true, jobId: targetJobId, attemptId, role, revision, instructions:typeof assignment === "string" ? assignment : assignment.instructions, retry: Boolean(continuation), reusedRevision: Number.isInteger(reuseRevision) };
}

/**
 * Persist a role-bound, attempt-bound validated result plus its durable report
 * reference as the attempt's validated outcome. The outcome revision is the
 * ACTUAL acknowledged/pinned revision enforced by the reducer — never whatever
 * revision happens to exist at recovery time. A seat result claiming another
 * revision keeps its claim as evidence while the acknowledged/pinned revision
 * stays authoritative.
 */
export function recordRoleOutcome({
  stateDir,
  executionId,
  role,
  jobId,
  attemptId,
  status,
  summary = "",
  result = null,
  reportId = null,
  claimedRevision = null,
  identity = null,
  actor = null,
  now = Date.now(),
} = {}) {
  if (!["completed", "failed", "cancelled"].includes(status)) throw fail("invalid-arguments", `unknown outcome status '${status}'`);
  assertIdentifier(jobId, "jobId");
  assertIdentifier(attemptId, "attemptId");
  const nowMs = normalizeNow(now)();
  const resolved = runtimeActor(actor?.id ?? null);
  const handle = executionHandle(stateDir, executionId);
  const attempt = handle.state.jobs[jobId]?.attempts[attemptId];
  if (!attempt) throw fail("not-found", `attempt '${attemptId}' is not registered on job '${jobId}'`);
  if (attempt.outcome) {
    const existing = viewsFor(handle.state).attempt(jobId, attemptId).outcome;
    if (reportId && reportId !== existing.reportId) recordAttemptEvidence({stateDir,executionId,jobId,attemptId,label:"late-role-result",reportId,note:`late ${status} result; authoritative outcome stays ${existing.status}`,actor:resolved,now:nowMs});
    return { ok: true, dedupe: true, recorded: false, status: existing.status, revision: existing.revision };
  }
  // A validated result reaching a never-started attempt proves the attempt ran:
  // record the observed (result-binding) identity first, exactly once.
  if (!attempt.started) {
    if (status === "completed" && !identity) {
      return { ok: false, code: "invalid-transition", reason: "a completed outcome requires an observed start or a validated result identity" };
    }
    if (identity) {
      try {
        handle.append(
          "attempt.started",
          { identity },
          { context: { actor: resolved, jobId, attemptId }, commandId: `started-${jobId}-${attemptId}`, now: nowMs },
        );
      } catch (error) {
        if (error?.code !== "command-conflict") throw error;
      }
    }
  }
  const payload = { status };
  if (summary) payload.summary = clampText(summary, 4000);
  if (result != null) payload.result = typeof result === "string" ? result : JSON.stringify(result);
  if (reportId) payload.reportId = String(reportId);
  if (Number.isInteger(claimedRevision)) payload.revision = claimedRevision;
  try {
    const appended = handle.append(
      "attempt.outcome",
      payload,
      { context: { actor: resolved, jobId, attemptId }, commandId: `outcome-${jobId}-${attemptId}`, now: nowMs },
    );
    const outcome = viewsFor(handle.state).attempt(jobId, attemptId).outcome;
    return { ok: true, dedupe: appended.dedupe === true, recorded: true, status, revision: outcome?.revision ?? null };
  } catch (error) {
    if (error?.code === "command-conflict") {
      const existing = viewsFor(executionHandle(stateDir, executionId).state).attempt(jobId, attemptId).outcome;
      return { ok: true, dedupe: true, recorded: false, status: existing?.status ?? status, revision: existing?.revision ?? null };
    }
    if (error?.code === "invalid-transition" && Number.isInteger(claimedRevision) && /outcome claims revision/.test(error.message)) {
      // The claimed revision is not the acknowledged/pinned revision: the
      // record's revision stays authoritative and the claim is preserved as
      // evidence instead of being silently adopted.
      recordAttemptEvidence({stateDir,executionId,jobId,attemptId,label:"result-revision-mismatch",reportId,
        note:error.message,actor:resolved,now:nowMs});
      return {ok:false,code:"result-revision-mismatch",reason:error.message};
    }
    return { ok: false, code: error.code ?? "refused", reason: error.message };
  }
}

/**
 * Durably link evidence (a report reference and/or bounded note) to an
 * attempt at ANY phase — including after cancellation or a validated outcome.
 * Evidence NEVER changes the outcome: a cancelled execution stays cancelled
 * while its late report/landing evidence stays retrievable through the normal
 * report path. Idempotent for the same evidence; distinct late artifacts stay
 * linked even when they use the same descriptive label.
 */
export function recordAttemptEvidence({
  stateDir,
  executionId,
  jobId,
  attemptId,
  label,
  reportId = null,
  note = null,
  actor = null,
  now = Date.now(),
} = {}) {
  assertIdentifier(jobId, "jobId");
  assertIdentifier(attemptId, "attemptId");
  assertIdentifier(label, "label");
  const nowMs = normalizeNow(now)();
  const resolved = runtimeActor(actor?.id ?? null);
  const handle = executionHandle(stateDir, executionId);
  const attempt = handle.state.jobs[jobId]?.attempts[attemptId];
  if (!attempt) throw fail("not-found", `attempt '${attemptId}' is not registered on job '${jobId}'`);
  const payload={label,reportId:reportId??null,note:note==null?null:clampText(note,8000)};
  const commandId=`evidence-${createHash('sha256').update(JSON.stringify({executionId,jobId,attemptId,payload})).digest('hex').slice(0,32)}`;
  try {
    const appended = handle.append(
      "attempt.evidence",
      payload,
      { context: { actor: resolved, jobId, attemptId }, commandId, now: nowMs },
    );
    return { ok: true, dedupe: appended.dedupe === true, seq: appended.seq };
  } catch (error) {
    return { ok: false, code: error.code ?? "refused", reason: error.message };
  }
}

// ---------------------------------------------------------------------------
// The currently intended active role attempt + assignment updates
// ---------------------------------------------------------------------------

/**
 * The exact currently intended active role attempt: the newest registered
 * seat attempt that has not settled. Older unsettled attempts keep their own
 * unresolved obligations — they are never silently retargeted.
 */
export function resolveActiveRoleAttempt({ stateDir, executionId }) {
  const handle = executionHandle(stateDir, executionId);
  const state = handle.state;
  let best = null;
  for (const job of viewsFor(state).jobs()) {
    if (job.role === "execution") continue;
    const jobState = state.jobs[job.id];
    for (const attemptId of jobState.attemptOrder) {
      const attempt = jobState.attempts[attemptId];
      if (attempt.outcome || attempt.phase === "terminal") continue;
      const candidate = { jobId: job.id, attemptId, role: job.role, startedSeq: attempt.launchIntent.seq };
      if (!best || candidate.startedSeq > best.startedSeq) best = candidate;
    }
  }
  return best;
}

/** Update lifecycle status: submitted → transport-received →
 *  worker-acknowledged → fulfilled (each strictly later fact). */
export function updateStatusOf(amendmentView, attemptView, jobView) {
  const fulfilled = amendmentView.acknowledged && jobView.attempts
    && Object.values(jobView.attempts).some(
      // A later retry retains only acknowledged updates. Its higher revision
      // cannot erase an unacknowledged obligation on the previous attempt.
      (attempt) => attempt.outcome?.status === "completed" && attempt.outcome.revision >= amendmentView.revision,
    );
  if (fulfilled) return "fulfilled";
  if (amendmentView.acknowledged) return "worker-acknowledged";
  if (amendmentView.acceptedAt) return "transport-received";
  return "submitted";
}

function roleCommunicationOf(attempt) {
  const note=attempt.evidence?.findLast(entry=>entry.label==="communication-capability")?.note;
  let capability=null;
  if(note)try{capability=JSON.parse(note);}catch{}
  return {...(capability??{supported:null,harness:null}),bindingRecorded:Boolean(attempt.started?.identity?.piSession)};
}

function updateEntriesForAttempt(state, jobId, attemptId) {
  const views = viewsFor(state);
  const jobView = views.job(jobId);
  const attempt = jobView.attempts[attemptId];
  const launchRevision = attempt.launchIntent.revision;
  const entries = [];
  for (const revisionEntry of state.revisions) {
    if (revisionEntry.scope?.kind !== "job" || revisionEntry.scope.jobId !== jobId) continue;
    if (revisionEntry.revision <= launchRevision) continue;
    entries.push({ revision: revisionEntry.revision, text: null });
  }
  const amendmentByRevision = new Map(jobView.amendments.map((entry) => [entry.revision, entry]));
  return entries
    .map((entry) => {
      const amendment = amendmentByRevision.get(entry.revision) ?? null;
      const revisionView = views.assignment({ revision: entry.revision });
      const text = amendment?.note ?? revisionView?.note ?? null;
      return {
        revision: entry.revision,
        text: typeof text === "string" ? text : "",
        amendmentId: amendment?.amendmentId ?? null,
        targetedAttemptId: amendment?.targetedAttemptId ?? null,
      };
    })
    .sort((a, b) => a.revision - b.revision);
}

/**
 * Submit ONE assignment update to the EXACT currently intended active attempt.
 *
 * The target is BOUND before submission (and re-verified under the record's
 * writer lock via `expect.attemptActive`): a phase/attempt change racing the
 * submission is a truthful refusal, never a silent retarget. The composed
 * instructions are the full assignment view (original constraints verbatim,
 * then the ordered updates already targeted at this attempt, then the new
 * instruction) — never a replacement of the task with the latest message.
 *
 * Outcomes (never conflated):
 *   ok:true                    — recorded (+ delivery status as its own fact);
 *   ok:false code:'target-changed' — the bound attempt stopped being the
 *                                intended active attempt; nothing was recorded;
 *   ok:false code:'refused'    — the record refused admission (closed/terminal/
 *                                cancelled). `revisionRecorded` names a
 *                                revision that stays in the record as an
 *                                UNRESOLVED update when one was already
 *                                authored.
 */
export async function steerRoleAttempt({
  stateDir,
  executionId,
  message,
  expectAttemptId = null,
  expectJobId = null,
  relay = null,
  actor = null,
  amendmentId = null,
  now = Date.now(),
} = {}) {
  if (typeof message !== "string" || !message.trim()) throw fail("invalid-arguments", "message (the additional instruction) is required");
  const nowMs = normalizeNow(now)();
  const resolved = runtimeActor(actor?.id ?? null);
  const bound = resolveActiveRoleAttempt({ stateDir, executionId });
  if (!bound) {
    return { ok: false, code: "no-active-attempt", status: "refused", reason: "no unsettled role attempt is currently intended; nothing is retargeted automatically" };
  }
  if (expectAttemptId && expectAttemptId !== bound.attemptId) {
    return {
      ok: false,
      code: "target-changed",
      status: "refused",
      reason: `the intended active attempt changed (bound '${expectAttemptId ?? "unspecified"}' vs current '${bound.attemptId}'); resubmit explicitly`,
      bound,
    };
  }
  if (expectJobId && expectJobId !== bound.jobId) {
    return {
      ok: false,
      code: "target-changed",
      status: "refused",
      reason: `the intended active job changed (bound '${expectJobId}' vs current '${bound.jobId}'); resubmit explicitly`,
      bound,
    };
  }
  const handle = executionHandle(stateDir, executionId);
  const state = handle.state;
  const views = viewsFor(state);
  const attempt = views.attempt(bound.jobId, bound.attemptId);
  const communication=roleCommunicationOf(attempt);
  if(communication.supported===false)return {ok:false,code:"unsupported",status:"refused",bound,
    reason:communication.reason??`assignment communication is unsupported for harness '${communication.harness}'`,communication};
  if (attempt.phase === "terminal" || attempt.cancelIntent || attempt.admissionClosed) {
    const reason = attempt.cancelIntent
      ? "cancellation was intented for this attempt; updates are no longer admitted"
      : attempt.phase === "terminal"
        ? `the attempt is ${attempt.phase}; updates are no longer admitted`
        : "the receiver admission is closed; updates are no longer admitted";
    return { ok: false, code: "refused", status: "unresolved", reason, bound };
  }
  // The full composed instructions carry EVERY update already targeted at the
  // bound attempt (in committed revision order) plus the new one, built on the
  // attempt's own launch revision (its original constraints verbatim). The
  // composition re-reads the record inside every race attempt so a lost
  // revision race never bakes in stale updates or a stale revision label.
  const composeInstructions = (revision) => {
    const fresh = executionHandle(stateDir, executionId);
    const freshState = fresh.state;
    const freshViews = viewsFor(freshState);
    const freshAttempt = freshViews.attempt(bound.jobId, bound.attemptId);
    const baseView = freshViews.assignment({ revision: freshAttempt.launchIntent.revision });
    const baseText = typeof baseView?.assignment === "string" ? baseView.assignment : baseView?.assignment?.instructions;
    if (typeof baseText !== "string" || !baseText.trim()) {
      throw fail("not-found", "the original assignment text for the bound attempt is unavailable");
    }
    const prior = updateEntriesForAttempt(freshState, bound.jobId, bound.attemptId)
      .filter((entry) => entry.targetedAttemptId === bound.attemptId && entry.revision < revision && entry.text.trim() !== "");
    return composeAssignment({ task: baseText, amendments: [...prior, { revision, text: message }] });
  };
  try {
    const result = await submitAmendment({
      stateDir,
      changeId: executionId,
      jobId: bound.jobId,
      attemptId: bound.attemptId,
      composeInstructions,
      note: message,
      amendmentId,
      actor: resolved,
      relay,
      now: nowMs,
      // Bind the target before submission: the submission must still be for
      // the attempt that was the intended active attempt when we bound it.
      expect: { attemptActive: true },
    });
    if (result.ok) {
      return { ...result, bound, status: "submitted", acknowledged: false };
    }
    return {
      ...result,
      bound,
      status: result.revision ? "unresolved" : "refused",
    };
  } catch (error) {
    if (error?.code === "expectation-failed") {
      return {
        ok: false,
        code: "target-changed",
        status: "refused",
        reason: `the attempt changed while the update was being submitted; nothing was retargeted: ${error.message}`,
        bound,
      };
    }
    if (error?.code === "not-bound") {
      // Nothing was recorded; the caller may retry once the binding is
      // observed. Never a silent stdin write pretending delivery.
      return { ok: false, code: "not-bound", status: "refused", reason: error.message, bound };
    }
    if (error?.code === "invalid-transition") return {ok:false,code:"refused",status:"refused",reason:error.message,bound};
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Cancellation and landing admission (serialized in the authoritative record)
// ---------------------------------------------------------------------------

/**
 * Record the AUTHORITATIVE cancellation intent before any owned process is
 * signalled. Idempotent. Refused truthfully (with landing evidence preserved)
 * when landing has already been irreversibly admitted — rollback is never
 * implied. Applies to the execution attempt and every unsettled role attempt;
 * attempts with an already-validated outcome are left untouched.
 */
export function recordExecutionCancelIntent({ stateDir, executionId, reason = "cancelled by architect", actor = null, now = Date.now() } = {}) {
  const nowMs = normalizeNow(now)();
  const resolved = runtimeActor(actor?.id ?? null);
  const handle = executionHandle(stateDir, executionId);
  const state = handle.state;
  // Landing admission is checked for EVERY unsettled attempt before ANY intent
  // is recorded: after an irreversible landing the refusal is total and
  // truthful, never half-accepted.
  for (const landingJob of viewsFor(state).jobs()) {
    const landingJobState = state.jobs[landingJob.id];
    for (const landingAttemptId of landingJobState.attemptOrder) {
      const landingAttempt = landingJobState.attempts[landingAttemptId];
      if (landingAttempt.outcome || landingAttempt.cancelIntent) continue;
      if (landingAttempt.landingAdmitted) {
        return {
          ok: false,
          code: "landing-begun",
          reason: `landing for attempt '${landingAttemptId}' was already admitted at seq ${landingAttempt.landingAdmitted.seq}; cancellation cannot undo it`,
          landingEvidence: { at: landingAttempt.landingAdmitted.at, seq: landingAttempt.landingAdmitted.seq, note: landingAttempt.landingAdmitted.note ?? null },
          recorded: [],
        };
      }
    }
  }
  const views = viewsFor(state);
  const results = [];
  for (const job of views.jobs()) {
    const jobState = state.jobs[job.id];
    for (const attemptId of jobState.attemptOrder) {
      const attempt = jobState.attempts[attemptId];
      if (attempt.outcome || attempt.cancelIntent) continue;
      try {
        const appended = handle.append(
          "attempt.cancel_intent",
          { reason: clampText(reason, 2000) },
          { context: { actor: resolved, jobId: job.id, attemptId }, commandId: `cancel-${job.id}-${attemptId}`, now: nowMs },
        );
        results.push({ jobId: job.id, attemptId, recorded: true, dedupe: appended.dedupe === true });
      } catch (error) {
        if(error?.code==="invalid-transition") {
          const fresh=viewsFor(executionHandle(stateDir,executionId).state).attempt(job.id,attemptId);
          if(fresh.outcome||fresh.cancelIntent) {
            results.push({jobId:job.id,attemptId,recorded:false,dedupe:true,settled:Boolean(fresh.outcome)});
            continue;
          }
        }
        if (error?.code === "invalid-transition" && /landing .* already admitted/.test(error.message)) {
          const landing = viewsFor(handle.state).attempt(job.id, attemptId).landingAdmitted;
          return {
            ok: false,
            code: "landing-begun",
            reason: error.message,
            landingEvidence: landing ? { at: landing.at, seq: landing.seq, note: landing.note ?? null } : null,
            recorded: results,
          };
        }
        if (error?.code === "command-conflict") {
          results.push({ jobId: job.id, attemptId, recorded: false, dedupe: true });
          continue;
        }
        return { ok: false, code: error.code ?? "refused", reason: error.message, recorded: results };
      }
    }
  }
  return { ok: true, dedupe: results.length === 0, recorded: results };
}

/**
 * The landing-admission boundary, serialized with cancellation and update
 * state through the record's writer lock. Refuses after an accepted
 * cancellation and while a pending/unacknowledged update newer than the
 * validated result exists (update B pending with a result for A blocks
 * automatic landing and stays visible for explicit decision).
 */
export function admitLanding({ stateDir, executionId, resultRevision = null, note = null, actor = null, now = Date.now() } = {}) {
  const nowMs = normalizeNow(now)();
  const resolved = runtimeActor(actor?.id ?? null);
  const handle = executionHandle(stateDir, executionId);
  const state = handle.state;
  const views = viewsFor(state);
  const jobState = state.jobs[executionId];
  const attemptId = jobState?.attemptOrder?.[0] ?? null;
  if (!attemptId) return { ok: false, code: "not-found", reason: "the execution attempt is not recorded" };
  const attempt = views.attempt(executionId, attemptId);
  if (attempt.landingAdmitted) {
    return { ok: true, dedupe: true, seq: attempt.landingAdmitted.seq, at: attempt.landingAdmitted.at };
  }
  if (attempt.cancelIntent) {
    return { ok: false, code: "cancelled", reason: "cancellation was intented for this execution; landing is not admitted after an accepted cancellation" };
  }
  // Update B pending when the result covers A: block automatic landing, keep
  // the pending obligation visible for an explicit decision.
  const pendingNewer = [];
  for (const job of views.jobs()) {
    if (job.role === "execution") continue;
    for (const update of views.job(job.id).amendments) {
      if (update.acknowledged) continue;
      pendingNewer.push({ jobId: job.id, amendmentId: update.amendmentId, revision: update.revision, targetedAttemptId: update.targetedAttemptId });
    }
  }
  if (pendingNewer.length) {
    return {
      ok: false,
      code: "pending-update",
      reason: `unacknowledged assignment update(s) ${pendingNewer.map((entry) => `revision ${entry.revision}`).join(", ")} are pending while the result covers revision ${resultRevision ?? "unknown"}; automatic landing is blocked and the obligation remains visible`,
      pending: pendingNewer.slice(0, VIEW_UPDATES_MAX),
    };
  }
  try {
    const appended = handle.append(
      "attempt.landing_admitted",
      { note: note == null ? null : clampText(note, 2000) },
      { context: { actor: resolved, jobId: executionId, attemptId }, commandId: `landing-${executionId}-${attemptId}`, now: nowMs },
    );
    return { ok: true, dedupe: appended.dedupe === true, seq: appended.seq };
  } catch (error) {
    return { ok: false, code: error.code ?? "refused", reason: error.message };
  }
}

/**
 * Record the execution's validated outcome plus its durable report and role
 * report references BEFORE any completion notification. A cancellation intent
 * forbids a completed outcome (the reducer enforces it); late results after a
 * cancelled outcome are recorded as EVIDENCE only — the cancelled outcome
 * never changes.
 */
export function recordExecutionOutcome({
  stateDir,
  executionId,
  status,
  summary = "",
  result = null,
  reportId = null,
  childReports = [],
  identity = null,
  actor = null,
  now = Date.now(),
} = {}) {
  if (!["completed", "failed", "cancelled"].includes(status)) throw fail("invalid-arguments", `unknown outcome status '${status}'`);
  const nowMs = normalizeNow(now)();
  const resolved = runtimeActor(actor?.id ?? null);
  const handle = executionHandle(stateDir, executionId);
  const jobState = handle.state.jobs[executionId];
  const attemptId = jobState?.attemptOrder?.[0] ?? null;
  if (!attemptId) throw fail("not-found", "the execution attempt is not recorded");
  const attempt = handle.state.jobs[executionId].attempts[attemptId];

  // Durable evidence first: the pipeline report and every role report stay
  // linked and retrievable whatever the outcome ends up being.
  const evidence = [];
  if (reportId) {
    evidence.push(recordAttemptEvidence({ stateDir, executionId, jobId: executionId, attemptId, label: "pipeline-report", reportId, note: summary ? clampText(summary, 2000) : null, actor: resolved, now: nowMs }));
  }
  for (const child of Array.isArray(childReports) ? childReports : []) {
    if (!child?.reportId) continue;
    const label = `role-report-${String(child.role ?? "role")}-${String(child.jobId ?? child.attemptId ?? "attempt")}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
    evidence.push(recordAttemptEvidence({ stateDir, executionId, jobId: executionId, attemptId, label, reportId: String(child.reportId), note: clampText(`${child.role ?? "role"} ${child.status ?? ""} ${child.summary ?? ""}`.trim(), 2000), actor: resolved, now: nowMs }));
  }
  const refusedEvidence=evidence.find(entry=>!entry.ok);
  if(refusedEvidence)return {...refusedEvidence,evidence};

  if (attempt.outcome) {
    // Already settled (e.g. cancelled): evidence is linked, the outcome stands.
    const existing = viewsFor(handle.state).attempt(executionId, attemptId).outcome;
    return { ok: true, dedupe: true, recorded: false, status: existing.status, revision: existing.revision, evidence, late: true };
  }
  const payload = { status };
  if (summary) payload.summary = clampText(summary, 4000);
  if (result != null) payload.result = typeof result === "string" ? result : JSON.stringify(result);
  if (reportId) payload.reportId = String(reportId);
  try {
    if (!attempt.started && identity) {
      handle.append("attempt.started", { identity }, { context: { actor: resolved, jobId: executionId, attemptId }, commandId: `started-${executionId}-${attemptId}`, now: nowMs });
    }
    const appended = handle.append(
      "attempt.outcome",
      payload,
      { context: { actor: resolved, jobId: executionId, attemptId }, commandId: `outcome-${executionId}-${attemptId}`, now: nowMs },
    );
    const outcome = viewsFor(handle.state).attempt(executionId, attemptId).outcome;
    return { ok: true, dedupe: appended.dedupe === true, recorded: true, status, revision: outcome?.revision ?? null, evidence };
  } catch (error) {
    if (error?.code === "command-conflict") {
      const existing = viewsFor(executionHandle(stateDir, executionId).state).attempt(executionId, attemptId).outcome;
      return { ok: true, dedupe: true, recorded: false, status: existing?.status ?? status, revision: existing?.revision ?? null, evidence };
    }
    if (error?.code === "invalid-transition" && /cancellation intent/.test(error.message)) {
      // A cancellation was accepted while the result raced in: the result is
      // preserved as evidence without relabelling cancellation as success.
      evidence.push(recordAttemptEvidence({ stateDir, executionId, jobId: executionId, attemptId, label: "late-result", reportId: reportId ?? null, note: clampText(typeof result === "string" ? result : JSON.stringify(result ?? {}), 8000), actor: resolved, now: nowMs }));
      return { ok: true, recorded: false, status: "cancelled", evidence, late: true, refused: error.message };
    }
    return { ok: false, code: error.code ?? "refused", reason: error.message, evidence };
  }
}

// ---------------------------------------------------------------------------
// Bounded status projection (check_execution) + reload reconstruction
// ---------------------------------------------------------------------------

/** Bounded role/job/attempt/revision/update/report state, rebuilt from the
 *  authoritative record on every read (a stale cache cannot override it). */
export function managedExecutionView({ stateDir, executionId, limit = {} }) {
  const handle = executionHandle(stateDir, executionId);
  const state = handle.state;
  const views = viewsFor(state);
  const executionJob = state.jobs[executionId];
  const execAttemptId = executionJob?.attemptOrder?.[0] ?? null;
  const execAttempt = execAttemptId ? views.attempt(executionId, execAttemptId) : null;
  const meta = execAttempt ? readLaunchMetadata({ stateDir, executionId }) : null;
  let landingOutcome = null;
  try {
    const recorded = JSON.parse(execAttempt?.outcome?.result ?? "null");
    if (recorded?.landingOutcome && typeof recorded.landingOutcome === "object") landingOutcome = recorded.landingOutcome;
  } catch { /* old outcomes may contain non-JSON result strings */ }

  const roles = [];
  const reports = [];
  const updates = [];
  for (const job of views.jobs().slice(0, limit.roles ?? VIEW_ROLES_MAX)) {
    const jobView = views.job(job.id);
    const attempts = jobView.attemptOrder
      .slice(-1 * (limit.attempts ?? VIEW_ATTEMPTS_MAX))
      .map((attemptId) => {
        const attempt = jobView.attempts[attemptId];
        for (const entry of attempt.evidence.slice(-1 * (limit.evidence ?? VIEW_EVIDENCE_MAX))) {
          if (entry.reportId) {
            reports.push({ jobId: job.id, attemptId, role: job.role, label: entry.label, reportId: entry.reportId });
          }
        }
        if (attempt.outcome?.reportId) {
          reports.push({ jobId: job.id, attemptId, role: job.role, label: "outcome-report", reportId: String(attempt.outcome.reportId) });
        }
        return {
          attemptId,
          phase: attempt.phase,
          launchRevision: attempt.launchIntent.revision,
          receiverBindingRecorded: Boolean(attempt.started?.identity?.piSession),
          communication: roleCommunicationOf(attempt),
          acknowledgedRevisions: attempt.acknowledgements.map((ack) => ack.revision),
          lastAcknowledgedRevision: attempt.acknowledgements.at(-1)?.revision ?? null,
          cancelIntent: attempt.cancelIntent ? { at: attempt.cancelIntent.at, reason: attempt.cancelIntent.reason } : null,
          admissionClosed: Boolean(attempt.admissionClosed),
          landingAdmitted: Boolean(attempt.landingAdmitted),
          outcome: attempt.outcome
            ? { status: attempt.outcome.status, revision: attempt.outcome.revision, reportId: attempt.outcome.reportId ?? null, summary: attempt.outcome.summary ?? null }
            : null,
          outcomeKnown: Boolean(attempt.outcome),
          progress: attempt.progress.slice(-1 * (limit.progress ?? VIEW_PROGRESS_MAX)).map((entry) => ({ seq: entry.seq, at: entry.at, note: entry.note })),
          blockers: attempt.blockers.slice(-1 * (limit.progress ?? VIEW_PROGRESS_MAX)).map((entry) => ({ seq: entry.seq, at: entry.at, note: entry.note, fatal: entry.fatal })),
          evidence: attempt.evidence.slice(-1 * (limit.evidence ?? VIEW_EVIDENCE_MAX)).map((entry) => ({ seq: entry.seq, label: entry.label, reportId: entry.reportId })),
        };
      });
    for (const update of jobView.amendments.slice(-1 * (limit.updates ?? VIEW_UPDATES_MAX))) {
      updates.push({
        jobId: job.id,
        role: job.role,
        amendmentId: update.amendmentId,
        revision: update.revision,
        targetedAttemptId: update.targetedAttemptId,
        submittedAt: update.submittedAt,
        status: updateStatusOf(update, jobView.attempts[update.targetedAttemptId], jobView),
        acknowledgedAt: update.acknowledged?.at ?? null,
      });
    }
    roles.push({
      jobId: job.id,
      role: job.role,
      pinnedRevision: jobView.pinnedRevision,
      effectiveRevision: jobView.effectiveRevision,
      attempts,
    });
  }

  // Unresolved revisions: job-targeted revisions no admitted amendment covers.
  const amendmentRevisions = new Set();
  for (const job of views.jobs()) {
    for (const update of views.job(job.id).amendments) amendmentRevisions.add(update.revision);
  }
  const unresolvedRevisions = state.revisions
    .filter((entry) => entry.scope?.kind === "job" && !amendmentRevisions.has(entry.revision)
      && !Object.values(state.jobs[entry.scope.jobId]?.attempts ?? {}).some(attempt => attempt.launchIntent.revision === entry.revision))
    .map((entry) => ({ jobId: entry.scope.jobId, revision: entry.revision }));

  return {
    changeId: executionId,
    execution: execAttempt
      ? {
        jobId: executionId,
        attemptId: execAttemptId,
        kind: meta?.launch?.kind ?? null,
        phaseId: meta?.launch?.phaseId ?? null,
        baseRef: meta?.launch?.baseRef ?? null,
        worktreeSelection: (() => {
          const note=execAttempt.evidence.findLast(entry=>entry.label==="worktree-base")?.note;
          if(!note)return null;
          try{return JSON.parse(note);}catch{return null;}
        })(),
        root: meta?.launch?.root ?? meta?.cwd ?? null,
        owner: meta?.launch?.owner ?? meta?.owner ?? null,
        launchId: meta?.launch?.launchId ?? null,
        requestPath: meta?.launch?.requestPath ?? null,
        constraintsRevision: meta?.constraintsRevision ?? null,
        phase: execAttempt.phase,
        cancelIntent: execAttempt.cancelIntent ? { at: execAttempt.cancelIntent.at, reason: execAttempt.cancelIntent.reason } : null,
        landingAdmitted: execAttempt.landingAdmitted
          ? { at: execAttempt.landingAdmitted.at, seq: execAttempt.landingAdmitted.seq }
          : null,
        outcome: execAttempt.outcome
          ? { status: execAttempt.outcome.status, revision: execAttempt.outcome.revision, reportId: execAttempt.outcome.reportId ?? null, at: execAttempt.outcome.at }
          : null,
        outcomeKnown: Boolean(execAttempt.outcome),
        evidence: execAttempt.evidence.slice(-1 * (limit.evidence ?? VIEW_EVIDENCE_MAX)).map((entry) => ({ seq: entry.seq, label: entry.label, reportId: entry.reportId })),
      }
      : null,
    landingOutcome,
    activeRoleAttempt: resolveActiveRoleAttempt({ stateDir, executionId }),
    roles,
    updates,
    updateCount: updates.length,
    unresolvedRevisions: unresolvedRevisions.slice(0, limit.updates ?? VIEW_UPDATES_MAX),
    unresolvedRevisionCount: unresolvedRevisions.length,
    reconciliations: views.reconciliations().slice(0, limit.updates ?? VIEW_UPDATES_MAX),
    // The ADR source-evidence / curation-obligation projection, rebuilt from
    // the authoritative record on every read (a stale cache cannot override
    // it). Bounded; the job cache is never consulted.
    curation: adrCurationProjection(state, { stateDir }),
    reports: reports.slice(-1 * (limit.reports ?? VIEW_REPORTS_MAX)),
    reportCount: reports.length,
  };
}

/**
 * Reload reconstruction (gap: stale cross-process cache writes reviving
 * running/success). The compatibility job record is CORRECTED from the one
 * append-only record: a recorded outcome or cancellation intent can never be
 * undone by a stale jobs.json write, and a job whose process disappeared
 * without a recorded outcome stays outcome-UNKNOWN (interrupted), never a
 * known failed outcome. Reports already linked as evidence stay retrievable.
 * Never restarts anything.
 */
export function reconcileManagedExecution({ stateDir, executionId, expectedOwner=null, expectedRoot=null, now = Date.now() } = {}) {
  const nowMs = normalizeNow(now)();
  let view,metadata;
  try {
    metadata=executionAuthorityMetadata({stateDir,executionId});
    if (!metadata) return {ok:true,legacy:true,view:null,projection:readJob(stateDir,executionId),corrected:false};
    if(expectedOwner&&metadata.launch?.owner!==expectedOwner)return {ok:false,code:"owner-mismatch",reason:"execution belongs to another coordinating session"};
    if(expectedRoot&&metadata.launch?.root!==expectedRoot)return {ok:false,code:"root-mismatch",reason:"execution belongs to another repository"};
    view = managedExecutionView({ stateDir, executionId });
  } catch (error) {
    const job = readJob(stateDir,executionId);
    const reason = `authoritative record unavailable: ${error.message}`;
    const projection = job ? writeJob(stateDir,{...job,status:"reconciliation-required",terminal:null,
      recovery:{...job.recovery,verdict:"authority-unavailable",detail:reason,reconciledAt:nowMs,
        priorTerminal:job.terminal??job.recovery?.priorTerminal??null}}) : null;
    return { ok: false, reason, projection };
  }
  const authoritative = view.execution?.outcome ?? null;
  const cancelIntent = view.execution?.cancelIntent ?? null;
  const attempt=viewsFor(executionHandle(stateDir,executionId).state).attempt(executionId,metadata.attemptId);
  const cached=readJob(stateDir,executionId);
  const job=cached??createJob({stateDir,id:executionId,role:"execution",kind:metadata.launch.kind,
    workflow:{sessionKey:metadata.launch.owner,sessionId:metadata.launch.owner,ownerAgentId:metadata.launch.owner,root:metadata.launch.root},
    cwd:metadata.launch.root,task:`managed execution (${metadata.launch.kind})`,now:attempt.launchIntent.at});
  const identity=attempt.started?.identity;
  const observed=identity?.fingerprint?processFingerprint({pid:identity.pid}):null;
  const sameProcess=Boolean(observed&&observed.startTicks===identity.fingerprint.startTicks&&observed.cmdlineHash===identity.fingerprint.cmdlineHash);
  const canonical={role:"execution",kind:metadata.launch.kind,cwd:metadata.launch.root,
    phaseId:metadata.launch.phaseId,baseRef:metadata.launch.baseRef,
    ...(!cached?{phase:authoritative?.status??(cancelIntent?"cancelled":view.execution.landingAdmitted?"landing":view.activeRoleAttempt?.role==="reviewer"?"reviewing":view.activeRoleAttempt?"implementing":"prepare")}:{}),
    workflow:{sessionKey:metadata.launch.owner,sessionId:metadata.launch.owner,ownerAgentId:metadata.launch.owner,root:metadata.launch.root},
    executionHost:{launchId:metadata.launch.launchId,requestPath:metadata.launch.requestPath,authority:true},
    ...(identity?.host&&identity.fingerprint?{process:{pid:identity.pid,fingerprint:identity.fingerprint,spawnedAt:attempt.started.at}}:{})};
  let corrected = !cached || Object.entries(canonical).some(([key,value])=>JSON.stringify(job[key])!==JSON.stringify(value));
  Object.assign(job,canonical);
  let next = job;
  if (authoritative) {
    const status = authoritative.status === "completed" ? "completed" : authoritative.status === "cancelled" ? "cancelled" : "failed";
    if (job.status !== status || job.terminal?.status !== status || job.terminal?.reportId !== (authoritative.reportId ?? null)) {
      corrected = true;
      next = {
        ...job,
        status,
        finishedAt: job.finishedAt ?? authoritative.at ?? nowMs,
        updatedAt: nowMs,
        terminal: {
          status,
          at: authoritative.at ?? nowMs,
          ok: status === "completed",
          summary: attempt.outcome?.summary ?? `reconstructed from the authoritative change record (outcome ${status} at revision ${authoritative.revision})`,
          reportId: authoritative.reportId ?? null,
          reportChars: 0,
          resultAvailable: Boolean(authoritative.reportId),
          error: status === "completed" ? null : { message: `authoritative outcome ${status}`, phase: job.phase ?? null },
        },
        recovery: { reconciledAt: nowMs, verdict: "reconstructed-from-record", detail: `authoritative outcome ${status} restored; a stale cache write cannot revive running state` },
      };
    }
  } else if (cancelIntent && (!job.cancellation || job.status !== "cancelled" || (job.terminal && job.terminal.status !== "cancelled"))) {
    // Accepted cancellation with no recorded outcome yet: the projection may
    // never show success or running after it. The outcome itself stays UNKNOWN
    // until evidence settles (never a known failed outcome).
    corrected = true;
    next = {
      ...job,
      cancellation: job.cancellation ?? { at: cancelIntent.at ?? nowMs, by: null, reason: cancelIntent.reason ?? "authoritative cancellation intent" },
      status: "cancelled",
      terminal: job.terminal?.status === "cancelled" ? job.terminal : null,
      updatedAt: nowMs,
      recovery: { reconciledAt: nowMs, verdict: "cancellation-intent-authoritative", detail: "authoritative cancellation intent restored; outcome stays unknown until evidence settles" },
    };
  } else if (!cancelIntent && (job.cancellation || ["completed","failed","cancelled"].includes(job.status)
    || (job.terminal && job.terminal.status!=="interrupted"))) {
    corrected=true;
    next={...job,status:"running",terminal:null,cancellation:null,finishedAt:null,
      recovery:{...job.recovery,verdict:"unproven-cache-outcome",reconciledAt:nowMs,priorTerminal:job.terminal??job.recovery?.priorTerminal??null}};
  } else if (!cancelIntent && job.status==="interrupted" && sameProcess) {
    corrected=true;
    next={...job,status:"running",terminal:null,finishedAt:null,recovery:{...job.recovery,verdict:"observed-host-still-live",reconciledAt:nowMs}};
  } else if (!cancelIntent && job.recovery?.verdict === "authority-unavailable") {
    corrected = true;
    next = {...job,status:"running",terminal:null,recovery:{...job.recovery,verdict:"authority-restored",reconciledAt:nowMs}};
  }
  if (corrected) writeJob(stateDir, next);
  // Recovery of an interrupted ADR capture/archive/receipt handoff reuses this
  // recovery hook: it reconstructs pending obligation/evidence only from
  // verified retained material and NEVER blocks or rewrites the reconciliation
  // above (bounded truthful state, no periodic scheduler, no relaunch).
  let curationRecovery = null;
  try {
    curationRecovery = recoverAdrCuration({ stateDir, changeId: executionId, repair: true, now: nowMs });
  } catch (error) {
    curationRecovery = { ok: false, reason: String(error?.message ?? error) };
  }
  return { ok: true, view, projection: next, corrected, curationRecovery };
}

// The cache index is rebuildable too: enumerate the authoritative records,
// only restore this owner/repository, and never launch a replacement worker.
export function reconstructOwnedExecutions({stateDir,owner,root,now=Date.now()}) {
  const restored=[],errors=[];
  let names;
  try{names=readdirSync(changesDir(stateDir));}catch(error){if(error.code==="ENOENT")return {restored,errors};throw error;}
  for(const name of names.filter(name=>name.endsWith(".jsonl")).sort()) {
    const executionId=name.slice(0,-6);
    try {
      const meta=readLaunchMetadata({stateDir,executionId});
      if(!meta?.launch||meta.launch.owner!==owner||meta.launch.root!==root)continue;
      const result=reconcileManagedExecution({stateDir,executionId,expectedOwner:owner,expectedRoot:root,now});
      if(!result.ok)errors.push({jobId:executionId,reason:result.reason});
      else if(result.corrected)restored.push(executionId);
    }catch(error){errors.push({jobId:executionId,reason:String(error?.message??error)});}
  }
  return {restored,errors};
}

// ---------------------------------------------------------------------------
// The pipeline hook surface (consumed by bin/mcp-server.mjs's managed pipeline)
// ---------------------------------------------------------------------------

/**
 * The authority hooks the managed pipeline drives inside the host. They carry
 * NO second authority: every hook either appends to the one change record or
 * reads it. `assertRoleSpawnAllowed` re-checks the parent cancellation intent
 * before EACH role spawn; `admitLanding` is the serialized landing-admission
 * boundary (see admitLanding above).
 */
export function managedExecutionPipelineHooks({ stateDir, executionId, owner = null, actor = null, now = Date.now() } = {}) {
  assertIdentifier(executionId, "executionId");
  return {
    stateDir,
    executionId,
    owner,
    assertRoleSpawnAllowed({ role = null } = {}) {
      const view = managedExecutionView({ stateDir, executionId });
      if (view.execution?.cancelIntent) {
        throw fail("cancelled", "the parent's authoritative cancellation intent is recorded; no further role may be spawned");
      }
      if (view.execution?.outcome) {
        throw fail("settled", "the execution already carries a validated outcome; no further role may be spawned");
      }
      return { ok: true, role };
    },
    registerRoleAttempt: (args) => registerRoleAttempt({ stateDir, executionId, owner, actor, now, ...args }),
    recordRoleOutcome: (args) => recordRoleOutcome({ stateDir, executionId, actor, now, ...args }),
    recordEvidence: (args) => recordAttemptEvidence({ stateDir, executionId, actor, now, ...args }),
    admitLanding: (args) => admitLanding({ stateDir, executionId, actor, now, ...args }),
    recordCancelIntent: (args) => recordExecutionCancelIntent({ stateDir, executionId, actor, now, ...args }),
    // The ADR source-evidence/curation-obligation seam the landing pipeline
    // threads through landWorktree: capture before destructive cleanup,
    // activation only on a verified real landing receipt, idempotent late
    // completion. Carries no second authority — every step appends to or reads
    // the ONE change record.
    adrCuration: createAdrCurationHook({ stateDir, executionId, owner, actor, now }),
    steer: async (args) => (await import('./execution-communication.mjs')).steerManagedRoleCommunication({ stateDir, executionId, actor, now, ...args }),
    view: (options = {}) => managedExecutionView({ stateDir, executionId, ...options }),
    reconcile: () => reconcileManagedExecution({ stateDir, executionId, now }),
  };
}

// ---------------------------------------------------------------------------
// Committed progress/blocker forwarding (native notifier/receipt path)
// ---------------------------------------------------------------------------

/**
 * Forward ONE committed, role-attributed progress/blocker entry through the
 * caller's existing durable notification system (the SAME native
 * notifier/receipt path the MCP transport adapter also routes through).
 *
 * The outgoing notification is rebuilt from the COMMITTED note with stable
 * change/job/attempt/sequence identity — the transport text is never authority.
 * Receipt-honest states are kept distinct and a journal record that already
 * exists suppresses a resend (replay protection across duplicate deliveries
 * and parent reloads). Queue acceptance is never reported as receipt.
 */
export async function forwardRoleProgress({
  stateDir,
  executionId,
  jobId,
  attemptId,
  seq,
  transport = null,
  journalDir = null,
  workflow = null,
  owner = null,
  cap = null,
  evidence = null,
  now = Date.now(),
} = {}) {
  assertIdentifier(jobId, "jobId");
  assertIdentifier(attemptId, "attemptId");
  if (!Number.isSafeInteger(seq) || seq < 1) throw fail("invalid-arguments", "seq must be a positive integer");
  const nowMs = normalizeNow(now)();
  const handle = executionHandle(stateDir, executionId);
  const state = handle.state;
  const views = viewsFor(state);
  // Owner isolation across parent reloads: a different coordinating owner
  // never consumes this execution's committed progress.
  if (owner) {
    const meta = readLaunchMetadata({ stateDir, executionId });
    if (meta?.owner && meta.owner !== owner) {
      return { ok: false, code: "not-owned", reason: `execution '${executionId}' is owned by '${meta.owner}', not '${owner}'` };
    }
  }
  let jobView;
  let attempt;
  try {
    jobView = views.job(jobId);
    attempt = views.attempt(jobId, attemptId);
  } catch (error) {
    return { ok: false, code: "unknown-source", reason: `the committed entry cannot be attributed: ${error.message}` };
  }
  const isProgress = attempt.progress.some((entry) => entry.seq === seq);
  const entry = (isProgress ? attempt.progress : attempt.blockers).find((item) => item.seq === seq);
  if (!entry) return { ok: false, code: "unknown-source", reason: `no committed progress/blocker entry at sequence ${seq} on attempt '${attemptId}'` };
  if (!entry.complete) return { ok: false, code: "incomplete-entry", reason: `the committed entry at sequence ${seq} has missing continuation parts` };
  const kind = isProgress ? "progress" : "blocker";
  const text = roleProgressNotificationText({ role: jobView.role, jobId, kind, seq, attemptId, message: entry.note });
  const eventId = roleProgressEventId({ changeId: executionId, jobId, attemptId, seq });
  const resolvedJournal = journalDir ?? stateDir;
  const existing = readNotification(resolvedJournal, eventId);
  if (existing?.state === "delivered") {
    return { ok: true, committed: { seq, kind }, eventId, state: existing.state, duplicate: true };
  }
  const localHandoff = existing?.state === "queued" && existing.transport === "execution-host-handoff"
    && existing.reason === "awaiting owning coordinator readiness" && existing.attempt?.settled !== false;
  let resolveUnknownOutcome = false;
  if (existing?.state && existing.state !== "failed" && !localHandoff) {
    const known = normalizeEvidence(evidence);
    const retained = known.byEventId.get(eventId) ?? known.userMessages.find(entry => entry.text === text);
    if (retained) {
      const receipt = {kind:retained.kind ?? "pi-session-entry",eventId,entryId:retained.entryId ?? null,
        sessionFile:retained.sessionFile ?? known.sessionFile,at:retained.at ?? null,observedAt:nowMs};
      return {...acknowledgeDelivery({stateDir:resolvedJournal,eventId,receipt,now:nowMs}),committed:{seq,kind}};
    }
    if (!known.known || known.inFlight.has(eventId) || known.pendingMessages !== false) {
      return {ok:true,committed:{seq,kind},eventId,state:existing.attempt?.settled === false ? "unknown" : existing.state,deferred:true};
    }
    resolveUnknownOutcome = true; // owning-session evidence proves absence
  }
  if (!transport || typeof transport.deliver !== "function") {
    return { ok: true, committed: { seq, kind }, eventId, state: "failed", reason: "no architect notification transport is configured; the committed entry stays retryable" };
  }
  try {
    const routed = await routeNotification({
      stateDir: resolvedJournal,
      eventId,
      jobId,
      role: "execution",
      workflow,
      text,
      reportText: entry.note,
      resolveUnknownOutcome,
      transport: {...transport, deliver: notification => transport.deliver({...notification, kind:"execution.progress"})},
      ...(cap ? { cap } : {}),
      now: nowMs,
    });
    return {
      ok: routed?.state !== "failed",
      committed: { seq, kind },
      eventId,
      state: routed?.state ?? "unknown",
      duplicate: routed?.duplicate === true,
      reason: routed?.delivery?.reason ?? routed?.transportResult?.reason ?? null,
    };
  } catch (error) {
    return { ok: true, committed: { seq, kind }, eventId, state: "failed", reason: clampText(error?.message ?? String(error), 200) };
  }
}

/**
 * Recovery projection for a reloaded parent: committed progress/blocker
 * entries per role attempt with their forwarding state (owner/attempt
 * isolated), pending (unacknowledged) assignment updates, and terminal
 * notification obligations — all rebuilt from the authoritative record.
 */
export function pendingRoleProgress({ stateDir, executionId, journalDir = null, forwardedStateOf = null } = {}) {
  const handle = executionHandle(stateDir, executionId);
  const state = handle.state;
  const views = viewsFor(state);
  const resolvedJournal = journalDir ?? stateDir;
  const out = [];
  for (const job of views.jobs()) {
    if (job.role === "execution") continue;
    const jobView = views.job(job.id);
    for (const attemptId of jobView.attemptOrder) {
      const attempt = jobView.attempts[attemptId];
      for (const [kind, entries] of [["progress", attempt.progress], ["blocker", attempt.blockers]]) {
        for (const entry of entries) {
          const eventId = roleProgressEventId({ changeId: executionId, jobId: job.id, attemptId, seq: entry.seq });
          const notification = readNotification(resolvedJournal, eventId);
          const state2 = typeof forwardedStateOf === "function"
            ? forwardedStateOf({ eventId, jobId: job.id, attemptId, seq: entry.seq })
            : notification?.state ?? null;
          out.push({
            jobId: job.id,
            role: job.role,
            attemptId,
            kind,
            seq: entry.seq,
            eventId,
            forwarded: state2,
            pending: !state2 || state2 === "failed" || state2 === "pending",
          });
        }
      }
    }
  }
  return out;
}
