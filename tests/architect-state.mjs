#!/usr/bin/env node
// Durable workflow state: job records, cancellation tombstones, report store,
// completion delivery, and restart reconciliation.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPLETE_TASK_RESPONSE_MAX } from "../workflow/results.mjs";
import {
  createJob,
  deliveryPending,
  isProcessAlive,
  jobArtifacts,
  jobSummary,
  listJobs,
  processFingerprint,
  readJob,
  reconcileAll,
  reconcileJob,
  recordCancellation,
  recordTerminal,
  markDelivery,
} from "../workflow/jobs.mjs";
import {
  REPORT_CHUNK_MAX,
  REPORT_TRANSPORT_CAP,
  boundedReportText,
  listReports,
  readReport,
  saveReport,
} from "../workflow/reports.mjs";
import {
  acknowledgeDelivery,
  completedEventId,
  completionTextForms,
  defaultCompletionText,
  deliverCompletion,
  isDuplicate,
  listJobsWithPendingDelivery,
  listNotifications,
  matchLegacyEvidence,
  normalizeEvidence,
  notificationPath,
  readNotification,
  preserveCorruptNotification,
  readNotificationState,
  recoverPendingDeliveries,
  repairNotificationFromJob,
  routeNotification,
} from "../workflow/notify.mjs";
import { acceptRunnerResult, renderRunnerFindings, validateRunnerResultPayload } from "../workflow/results.mjs";
import {
  ensureAssociation,
  listAssociations,
  resolveAssociation,
  resolveSessionKey,
  sessionIdFor,
  stateDirFor,
} from "../workflow/session.mjs";
import { agentTransport, tempDir } from "./support/architect-fixtures.mjs";

const root = tempDir("qq-state-repo-");
const stateDir = stateDirFor(root, {});
assert.equal(stateDir, join(root, ".architect", "state"), "state directory is repository-scoped");

// ---------------------------------------------------------------------------
// S1. Workflow identity is explicit, stable, and never inferred from recency.
// ---------------------------------------------------------------------------
assert.equal(resolveSessionKey({ explicit: "agent-x", env: {} }), "agent-x");
assert.equal(resolveSessionKey({ env: { QQ_WORKFLOW_SESSION_ID: "agent-env" } }), "agent-env");
assert.equal(resolveSessionKey({ env: { PASEO_AGENT_ID: "paseo-1" } }), "paseo-1", "Paseo agent ID is the workflow key");
assert.equal(resolveSessionKey({ env: {} }), null);

const uuidSession = sessionIdFor("11111111-2222-3333-4444-555555555555");
assert.equal(uuidSession, "11111111-2222-3333-4444-555555555555", "a UUID session key is used verbatim");
assert.equal(sessionIdFor("agent-A"), sessionIdFor("agent-A"), "non-UUID keys map deterministically");
assert.match(sessionIdFor("agent-A"), /^[0-9a-f-]{36}$/);

const first = ensureAssociation({ stateDir, key: "agent-A", root, ownerAgentId: "agent-A", now: 1_000 });
assert.equal(first.sessionId, sessionIdFor("agent-A"));
assert.equal(first.ticketPath, join(".architect", "tickets", `${first.sessionId}.md`));
const second = ensureAssociation({ stateDir, key: "agent-A", root, ownerAgentId: "agent-A", now: 2_000 });
assert.equal(second.createdAt, first.createdAt, "reopen keeps the original association");
assert.equal(second.sessionId, first.sessionId, "reopen preserves ticket identity");
assert.equal(listAssociations(stateDir).length, 1);

// A different session key is a different ticket even in the same repository.
const other = ensureAssociation({ stateDir, key: "agent-B", root, now: 1_000 });
assert.notEqual(other.sessionId, first.sessionId);

// No recency guessing: an unknown key has no session, even when a ticket exists.
assert.throws(
  () => resolveAssociation({ stateDir, key: "agent-unknown" }),
  /no durable association/,
  "an unknown session key must not resolve to whatever ticket exists",
);
ensureAssociation({ stateDir, key: "agent-C", root, now: 1_000 });
assert.equal(listAssociations(stateDir).length, 3);
assert.throws(
  () => ensureAssociation({ stateDir, key: "agent-A", root: "/somewhere-else", now: 3_000 }),
  /refusing to re-point/,
  "an established session is never re-pointed at another repository",
);

// ---------------------------------------------------------------------------
// S2. Job records persist identity, ownership, phase, and cancellation.
// ---------------------------------------------------------------------------
const workflow = { sessionKey: "agent-A", sessionId: first.sessionId, ownerAgentId: "agent-A", root };
const running = createJob({
  stateDir,
  id: "job-running",
  role: "runner",
  workflow,
  cwd: root,
  task: "inspect",
  process: { pid: process.pid, fingerprint: { pid: process.pid, startTicks: "1", cmdlineHash: "abc" } },
  now: 5_000,
});
assert.equal(running.status, "running");
assert.equal(running.workflow.sessionKey, "agent-A");
assert.deepEqual(listJobs(stateDir, { sessionKey: "agent-B" }), [], "job listing is scoped by workflow session");
assert.equal(listJobs(stateDir, { sessionKey: "agent-A" }).length, 1);

assert.throws(() => recordTerminal(stateDir, "job-running", { status: "weird" }), /invalid terminal status/);

const cancelled = recordCancellation(stateDir, "job-running", { by: "agent-A", reason: "operator stopped it", now: 6_000 });
assert.equal(cancelled.status, "cancelled");
assert.equal(cancelled.terminal.status, "cancelled", "cancellation is a terminal outcome");
assert.equal(cancelled.cancellation.reason, "operator stopped it");
assert.equal(deliveryPending(stateDir, "job-running"), false, "a cancellation needs no completion delivery");

// ---------------------------------------------------------------------------
// S3. Reconciliation is truthful and never kills, adopts, or restarts.
// ---------------------------------------------------------------------------
const alive = { status: "running", process: { pid: 9001, fingerprint: { pid: 9001, startTicks: "10", cmdlineHash: "aaa" } } };
const jobAlive = createJob({ stateDir, id: "job-alive", role: "runner", workflow, cwd: root, ...alive });
const verdictAlive = reconcileJob(stateDir, "job-alive", {
  alive: () => true,
  fingerprint: () => ({ pid: 9001, startTicks: "10", cmdlineHash: "aaa" }),
});
assert.equal(verdictAlive.status, "running");
assert.equal(verdictAlive.recovery.verdict, "running");

const jobReused = createJob({
  stateDir,
  id: "job-reused",
  role: "runner",
  workflow,
  cwd: root,
  process: { pid: 9002, fingerprint: { pid: 9002, startTicks: "20", cmdlineHash: "bbb" } },
});
const verdictReused = reconcileJob(stateDir, "job-reused", {
  alive: () => true,
  fingerprint: () => ({ pid: 9002, startTicks: "99", cmdlineHash: "zzz" }),
});
assert.equal(verdictReused.status, "reconciliation-required");
assert.equal(verdictReused.recovery.verdict, "pid-reused");
assert.notEqual(verdictReused.terminal?.ok, true, "a reused pid never becomes a completion");

const jobGone = createJob({
  stateDir,
  id: "job-gone",
  role: "runner",
  workflow,
  cwd: root,
  process: { pid: 9003, fingerprint: { pid: 9003, startTicks: "30", cmdlineHash: "ccc" } },
});
const verdictGone = reconcileJob(stateDir, "job-gone", { alive: () => false });
assert.equal(verdictGone.status, "interrupted");
assert.equal(verdictGone.terminal.ok, false);
assert.match(verdictGone.terminal.summary, /outcome unknown/);

const jobNoIdentity = createJob({ stateDir, id: "job-no-identity", role: "runner", workflow, cwd: root });
assert.equal(reconcileJob(stateDir, "job-no-identity").status, "reconciliation-required");

const jobTerminal = createJob({
  stateDir,
  id: "job-terminal",
  role: "runner",
  workflow,
  cwd: root,
  process: { pid: 9004, fingerprint: { pid: 9004, startTicks: "40", cmdlineHash: "ddd" } },
});
recordTerminal(stateDir, "job-terminal", { status: "completed", summary: "done", reportId: "report-1", reportChars: 120 });
const recheck = reconcileJob(stateDir, "job-terminal", { alive: () => false });
assert.equal(recheck.status, "completed", "a terminal record is never overwritten by reconciliation");
assert.equal(recheck.terminal.reportId, "report-1");

const reconciled = reconcileAll(stateDir, { alive: () => false });
assert.ok(reconciled.length >= 5);
assert.equal(reconciled.some((record) => record.id === "job-terminal" && record.status !== "completed"), false);

// A cancelled job stays cancelled through reconciliation.
const jobCancelled = createJob({
  stateDir,
  id: "job-cancelled",
  role: "runner",
  workflow,
  cwd: root,
  process: { pid: 9005, fingerprint: { pid: 9005, startTicks: "50", cmdlineHash: "eee" } },
});
recordCancellation(stateDir, "job-cancelled", { by: "agent-A", reason: "duplicate work" });
const afterReconcile = reconcileJob(stateDir, "job-cancelled", { alive: () => true });
assert.equal(afterReconcile.status, "cancelled");
assert.ok(afterReconcile.cancellation, "the tombstone survives reconciliation");
assert.equal(afterReconcile.recovery ?? null, null, "cancelled records need no recovery verdict");

// Live process facts used by ownership checks.
assert.equal(isProcessAlive(process.pid), true);
assert.equal(isProcessAlive(999_999_999), false);
assert.equal(processFingerprint({ pid: process.pid }).pid, process.pid);
assert.equal(processFingerprint({ pid: 999_999_999 }), null);

const artifacts = jobArtifacts(stateDir, readJob(stateDir, "job-terminal"));
assert.ok(artifacts.record.endsWith("job-terminal.json"));
assert.ok(artifacts.report.endsWith("report-1.txt"));

// ---------------------------------------------------------------------------
// S4. Report store: full recovery, bounded transport text, over-cap spill.
// ---------------------------------------------------------------------------
const longReport = `${"A".repeat(30_000)}\nFINAL-LINE-OF-REPORT`;
const saved = saveReport(stateDir, { jobId: "job-terminal", role: "runner", text: longReport, now: 7_000 });
assert.equal(saved.chars, longReport.length);
assert.equal(saved.sha256.length, 64);
assert.ok(listReports(stateDir).some((entry) => entry.reportId === saved.reportId));
assert.equal(saveReport(stateDir, { jobId: "job-terminal", role: "runner", text: longReport }).reportId, saved.reportId, "saving the same report is idempotent");

let recovered = "";
let offset = 0;
let chunks = 0;
for (;;) {
  const chunk = readReport(stateDir, saved.reportId, { offset });
  assert.ok(chunk.ok);
  assert.ok(chunk.text.length <= REPORT_CHUNK_MAX);
  recovered += chunk.text;
  offset = chunk.nextOffset;
  chunks += 1;
  if (chunk.complete) break;
  assert.ok(chunks < 20, "chunked retrieval terminates");
}
assert.equal(recovered, longReport, "the full report is recoverable verbatim in bounded chunks");
assert.ok(chunks > 1);
assert.equal(readReport(stateDir, saved.reportId, { offset: 1_000_000 }).complete, true);
assert.equal(readReport(stateDir, "nope").ok, false);

const bounded = boundedReportText(longReport, { reportId: saved.reportId });
assert.ok(bounded.text.length <= REPORT_TRANSPORT_CAP, "the delivered summary respects the observed transport cap");
assert.equal(bounded.truncated, true);
assert.ok(bounded.text.includes("FINAL-LINE-OF-REPORT"), "the tail of a long report stays visible");
assert.ok(bounded.text.includes(saved.reportId), "the bounded text references the durable report");
assert.ok(bounded.omittedChars > 0);
const untouched = boundedReportText("short findings");
assert.equal(untouched.truncated, false);

// The DeepSeek worker's over-cap completion is spilled, not lost.
const transportFile = join(root, "over-cap-result.json");
const overCap = `${"W".repeat(40_000)}END-OF-WORKER-FINDINGS`;
writeFileSync(transportFile, JSON.stringify({ runnerId: "over-cap", response: overCap, data_points: ["d1"] }), "utf8");
const spilled = acceptRunnerResult(
  { id: "over-cap", resultFile: transportFile },
  { stateDir, saveReport: (dir, options) => saveReport(dir, options) },
);
assert.equal(spilled.ok, true, "an over-cap response still yields a usable result");
assert.equal(spilled.spilled, true);
assert.ok(spilled.report.chars > COMPLETE_TASK_RESPONSE_MAX, "the spilled report carries the whole over-cap response");
let spilledText = "";
let spilledOffset = 0;
for (;;) {
  const chunk = readReport(stateDir, spilled.report.reportId, { offset: spilledOffset });
  spilledText += chunk.text;
  spilledOffset = chunk.nextOffset;
  if (chunk.complete) break;
}
const expectedSpilled = renderRunnerFindings({ response: overCap, data_points: ["d1"] });
assert.equal(spilledText.length, expectedSpilled.length, "the worker's complete response stays recoverable verbatim");
assert.equal(spilledText, expectedSpilled);
assert.ok(spilled.result.response.length < overCap.length);
assert.equal(spilled.result.data_points[0], "d1");

// In-cap results pass through, and binding failures still fail.
writeFileSync(transportFile, JSON.stringify({ runnerId: "in-cap", response: "ok", data_points: [] }), "utf8");
const inCap = acceptRunnerResult({ id: "in-cap", resultFile: transportFile }, { stateDir, saveReport: (dir, o) => saveReport(dir, o) });
assert.equal(inCap.ok, true);
assert.equal(inCap.spilled, false);
assert.equal(inCap.result.response, "ok");
writeFileSync(transportFile, JSON.stringify({ runnerId: "someone-else", response: "x" }), "utf8");
const mismatched = acceptRunnerResult({ id: "in-cap", resultFile: transportFile }, { stateDir, saveReport: (dir, o) => saveReport(dir, o) });
assert.equal(mismatched.ok, false);
assert.match(mismatched.error, /ID mismatch/);
assert.match(validateRunnerResultPayload({ response: "x" }, { id: "in-cap" }).ok ? "ok" : "bad", /ok/);
assert.equal(renderRunnerFindings({ response: "body", data_points: ["p"] }), "body\n\ndata_points:\n- p");

// ---------------------------------------------------------------------------
// S5. Completion delivery: dedupe, bounded payload, ownership-scoped recovery.
// ---------------------------------------------------------------------------
const deliveryJob = createJob({ stateDir, id: "job-delivery", role: "runner", workflow, cwd: root, now: 8_000 });
recordTerminal(stateDir, "job-delivery", {
  status: "completed",
  summary: "bounded summary",
  reportId: saved.reportId,
  reportChars: saved.chars,
  now: 8_100,
});
const transport = agentTransport({ name: "agent-A-transport" });
const firstDelivery = await deliverCompletion({
  stateDir,
  job: readJob(stateDir, "job-delivery"),
  transport,
  text: longReport,
  reportText: longReport,
});
assert.equal(firstDelivery.eventId, completedEventId(readJob(stateDir, "job-delivery")));
assert.equal(firstDelivery.state, "delivered");
assert.equal(transport.delivered.length, 1);
assert.ok(transport.delivered[0].text.length <= REPORT_TRANSPORT_CAP);
assert.equal(firstDelivery.delivery.resultAvailable, true, "persistence, not delivery, decides result availability");
assert.equal(readJob(stateDir, "job-delivery").delivery.state, "delivered");

// A repeated callback with the same event ID is a duplicate with no side effect.
const repeat = await deliverCompletion({ stateDir, job: readJob(stateDir, "job-delivery"), transport, text: longReport, reportText: longReport });
assert.equal(repeat.duplicate, true);
assert.equal(transport.delivered.length, 1, "dedupe by stable event ID prevents a second delivery");
assert.equal(isDuplicate(stateDir, firstDelivery.eventId), true);
assert.equal(readNotification(stateDir, firstDelivery.eventId).seq, 1);

// A failed transport leaves the completion pending and retryable.
const failing = { name: "failing", deliver: async () => ({ state: "failed", reason: "session gone" }) };
const undeliveredJob = createJob({ stateDir, id: "job-undelivered", role: "execution", workflow, cwd: root, now: 9_000 });
recordTerminal(stateDir, "job-undelivered", { status: "failed", summary: "phase 'review' failed", reportChars: 0, now: 9_100 });
const failedDelivery = await deliverCompletion({ stateDir, job: readJob(stateDir, "job-undelivered"), transport: failing, text: "boom" });
assert.equal(failedDelivery.state, "failed");
assert.equal(deliveryPending(stateDir, "job-undelivered"), true, "an undelivered terminal result stays pending");
const pendingIds = listJobsWithPendingDelivery(stateDir).map((job) => job.id);
assert.ok(pendingIds.includes("job-undelivered"), "an undelivered terminal result is pending");
assert.ok(pendingIds.includes("job-terminal"), "a completed result that was never delivered is pending");
assert.equal(pendingIds.includes("job-cancelled"), false, "cancellations are never pending delivery");
assert.equal(pendingIds.includes("job-no-identity"), false, "records without a terminal result are not pending");

// Recovery replays only for the owning session.
const beforeForeign = transport.delivered.length;
const foreign = await recoverPendingDeliveries({ stateDir, sessionKey: "agent-B", transport });
assert.ok(foreign.orphaned.length >= 1);
assert.ok(foreign.orphaned.every((entry) => entry.owner === "agent-A" && entry.requested === "agent-B"));
assert.deepEqual(foreign.replayed, []);
assert.equal(transport.delivered.length, beforeForeign, "a foreign session never receives another session's result");
const owned = await recoverPendingDeliveries({ stateDir, sessionKey: "agent-A", transport });
assert.ok(owned.replayed.some((entry) => entry.jobId === "job-undelivered"));
assert.equal(transport.delivered.length, beforeForeign + owned.replayed.length);
assert.ok(transport.delivered.some((notification) => notification.jobId === "job-undelivered"));
assert.equal(deliveryPending(stateDir, "job-undelivered"), false);
const deliveredSoFar = transport.delivered.length;
const replayAgain = await recoverPendingDeliveries({ stateDir, sessionKey: "agent-A", transport });
assert.deepEqual(replayAgain.replayed, [], "replayed deliveries are not replayed again");
assert.deepEqual(replayAgain.skipped, [], "nothing is left pending after a successful replay");
assert.equal(transport.delivered.length, deliveredSoFar, "no duplicate delivery after reconnect");

// Notification records are inspectable and distinguish acceptance from delivery.
const records = listNotifications(stateDir);
assert.ok(records.length >= 3);
const accepted = await routeNotification({
  stateDir,
  eventId: "runner:queued:terminal",
  text: "queued result",
  transport: { name: "queue", deliver: async () => ({ state: "queued", reason: "agent busy" }) },
});
assert.equal(accepted.state, "queued");
assert.equal(readNotification(stateDir, "runner:queued:terminal").state, "queued");
const processDedupeFirst = await routeNotification({ stateDir, eventId: "runner:proc:terminal", text: "x", transport, dedupe: "process" });
const processDedupeSecond = await routeNotification({ stateDir, eventId: "runner:proc:terminal", text: "x", transport, dedupe: "process" });
assert.equal(processDedupeFirst.state, "delivered");
assert.equal(processDedupeSecond.state, "duplicate");

// Delivery bookkeeping is recorded on the record itself, and the state machine is
// monotonic: a later, weaker transport result can never overwrite a receipt.
markDelivery(stateDir, "job-delivery", { eventId: firstDelivery.eventId, state: "queued", reason: "resumed" });
const afterStaleWrite = readJob(stateDir, "job-delivery").delivery;
assert.equal(afterStaleWrite.attempts, 2);
assert.equal(afterStaleWrite.state, "delivered", "a queued result cannot regress a delivered record");
assert.equal(afterStaleWrite.lastResult.applied, false, "the suppressed result is recorded as history");
assert.equal(afterStaleWrite.lastResult.state, "queued");
assert.equal(afterStaleWrite.receipt, null, "no receipt existed for this fixture delivery");
markDelivery(stateDir, "job-delivery", { eventId: firstDelivery.eventId, state: "failed", reason: "later failure" });
assert.equal(readJob(stateDir, "job-delivery").delivery.state, "delivered", "a failure cannot erase a receipt either");
markDelivery(stateDir, "job-delivery", { eventId: firstDelivery.eventId, state: "unknown", reason: "unprovable" });
assert.equal(readJob(stateDir, "job-delivery").delivery.state, "delivered", "an unprovable outcome never downgrades a receipt");
assert.throws(() => markDelivery(stateDir, "job-delivery", { eventId: "e", state: "nonsense" }), /invalid delivery state/);
assert.equal(jobSummary(readJob(stateDir, "job-delivery")).terminal.reportId, saved.reportId);

// A pre-metadata record has no event identity, and that absence is itself the
// identity: marking it (e.g. as outcome-unknown) keeps it identity-less and
// preserves the acceptance evidence it already carries instead of resetting it.
createJob({ stateDir, id: "job-legacy-delivery", role: "runner", workflow, cwd: root, now: 9_050 });
recordTerminal(stateDir, "job-legacy-delivery", { status: "completed", summary: "legacy", now: 9_060 });
markDelivery(stateDir, "job-legacy-delivery", { eventId: null, state: "queued", transport: "pi-legacy", messageId: "m-legacy", now: 9_070 });
const legacyUnknown = markDelivery(stateDir, "job-legacy-delivery", {
  eventId: null,
  state: "unknown",
  reason: "missing-event-identity",
  now: 9_080,
}).delivery;
assert.equal(legacyUnknown.eventId, null, "the identity-less record stays identity-less");
assert.equal(legacyUnknown.state, "unknown");
assert.equal(legacyUnknown.transport, "pi-legacy", "the transport that accepted it is preserved");
assert.equal(legacyUnknown.messageId, "m-legacy", "the message id is preserved");
assert.equal(legacyUnknown.queuedAt, 9_070, "the queue time is preserved");
assert.equal(legacyUnknown.stateAt, 9_080, "the state time records when the outcome became unknown");
assert.equal(legacyUnknown.attempts, 2, "the record's attempt count continues instead of resetting");
assert.equal(deliveryPending(stateDir, "job-legacy-delivery"), true);

// A receipt upgrades a volatile record, and the ack is idempotent.
const ackEventId = "execution:job-ack:terminal";
const ackJob = createJob({ stateDir, id: "job-ack", role: "execution", workflow, cwd: root, now: 8_200 });
recordTerminal(stateDir, "job-ack", { status: "completed", summary: "acked", now: 8_300 });
const queuedRoute = await routeNotification({
  stateDir,
  eventId: ackEventId,
  jobId: ackJob.id,
  role: "execution",
  text: "acked result",
  transport: { name: "pi", deliver: async () => ({ state: "queued", reason: "session-busy" }) },
  persistJob: true,
  now: 8_400,
});
assert.equal(queuedRoute.state, "queued");
assert.equal(readJob(stateDir, ackJob.id).delivery.state, "queued");
assert.equal(deliveryPending(stateDir, ackJob.id), true, "a queued notification is owed a receipt");
assert.equal(isDuplicate(stateDir, ackEventId), false, "transport acceptance is not a duplicate");
const receipt = { kind: "pi-session-entry", eventId: ackEventId, entryId: "entry-42", sessionFile: "/tmp/session.jsonl", at: 8_450 };
const ack = acknowledgeDelivery({ stateDir, eventId: ackEventId, jobId: ackJob.id, receipt, now: 8_500 });
assert.equal(ack.state, "delivered");
assert.equal(ack.alreadyDelivered, false);
assert.equal(readNotification(stateDir, ackEventId).receipt.entryId, "entry-42");
assert.equal(readNotification(stateDir, ackEventId).acknowledgedAt, 8_500);
const ackRecord = readJob(stateDir, ackJob.id).delivery;
assert.equal(ackRecord.state, "delivered");
assert.equal(ackRecord.receipt.entryId, "entry-42");
assert.equal(ackRecord.deliveredAt, 8_500);
assert.equal(ackRecord.queuedAt, 8_400, "the acceptance time is preserved through the receipt");
assert.equal(ackRecord.queuedAt < ackRecord.deliveredAt, true, "acceptance and acknowledgement keep distinct timestamps");
assert.equal(ackRecord.receipt.at, 8_450, "the evidence carries its own observed time");
assert.equal(deliveryPending(stateDir, ackJob.id), false);
assert.equal(isDuplicate(stateDir, ackEventId), true, "a receipt is the dedupe boundary");
const repeatedAck = acknowledgeDelivery({ stateDir, eventId: ackEventId, jobId: ackJob.id, receipt, now: 8_600 });
assert.equal(repeatedAck.alreadyDelivered, true);
assert.equal(readJob(stateDir, ackJob.id).delivery.deliveredAt, 8_500, "a repeated receipt does not move the delivery time");
// A suppressed straggler result changes neither the delivery time nor the state.
const beforeStraggler = readNotification(stateDir, ackEventId);
const stragglerRecord = await routeNotification({
  stateDir,
  eventId: ackEventId,
  text: "acked result",
  transport: { name: "straggler", deliver: async () => ({ state: "queued", reason: "session-busy" }) },
  dedupe: "process",
  persistJob: true,
  now: 8_700,
});
assert.equal(stragglerRecord.state, "delivered");
const afterStraggler = readNotification(stateDir, ackEventId);
assert.equal(afterStraggler.stateAt, beforeStraggler.stateAt, "a suppressed result does not move the state time");
assert.equal(afterStraggler.acknowledgedAt, beforeStraggler.acknowledgedAt, "a suppressed result does not move the receipt");
assert.equal(afterStraggler.deliveryAt, beforeStraggler.deliveryAt, "a suppressed result does not become the delivery time");
assert.equal(afterStraggler.lastResult.at, 8_700, "the suppressed result keeps its own time in the history");
assert.equal(afterStraggler.seq, beforeStraggler.seq + 1, "the history entry is what advances");
assert.equal(readJob(stateDir, ackJob.id).delivery.deliveredAt, 8_500, "the job projection is not regressed either");

// The journal and the job projection converge: a projection that lags a receipt
// is caught up by the next result, which is recorded as a suppressed straggler.
const driftEventId = "runner:job-drift:terminal";
createJob({ stateDir, id: "job-drift", role: "runner", workflow, cwd: root, now: 8_800 });
recordTerminal(stateDir, "job-drift", { status: "completed", summary: "drift", now: 8_810 });
markDelivery(stateDir, "job-drift", { eventId: driftEventId, state: "queued", now: 8_820 });
await routeNotification({
  stateDir,
  eventId: driftEventId,
  text: "drift",
  transport: { name: "pi", deliver: async () => ({ state: "queued", reason: "session-busy" }) },
  now: 8_825,
});
const driftAck = acknowledgeDelivery({ stateDir, eventId: driftEventId, receipt: { kind: "pi-session-entry", entryId: "entry-drift", at: 8_830 }, now: 8_835 });
assert.equal(driftAck.state, "delivered");
assert.equal(readNotification(stateDir, driftEventId).state, "delivered", "the journal holds the receipt");
assert.equal(readJob(stateDir, "job-drift").delivery.state, "queued", "the projection lags until its next write");
const catchUp = await routeNotification({
  stateDir,
  eventId: driftEventId,
  jobId: "job-drift",
  role: "runner",
  text: "drift",
  transport: { name: "straggler", deliver: async () => ({ state: "queued", reason: "session-busy" }) },
  dedupe: "process",
  persistJob: true,
  now: 8_840,
});
assert.equal(catchUp.state, "delivered");
const drift = readJob(stateDir, "job-drift").delivery;
assert.equal(drift.state, "delivered", "the projection converges on the journal's receipt");
assert.equal(drift.deliveredAt, 8_840, "the catch-up records when the projection learned the receipt");
assert.equal(drift.receipt.entryId, "entry-drift");
assert.equal(drift.lastResult.state, "queued");
assert.equal(drift.lastResult.applied, false);

// An event with no journal record cannot be acknowledged (nothing may claim a
// delivery the workflow never recorded).
assert.equal(acknowledgeDelivery({ stateDir, eventId: "runner:absent:terminal" }).reason, "no-notification-record");
// A receipt is refused for a record that was never attempted in this state dir.
assert.equal(readNotification(stateDir, "runner:absent:terminal"), null);
assert.ok(existsSync(jobArtifacts(stateDir, readJob(stateDir, "job-delivery")).record));
assert.ok(readFileSync(jobArtifacts(stateDir, readJob(stateDir, "job-delivery")).record, "utf8").includes("job-delivery"));

// ---------------------------------------------------------------------------
// S8. Journal integrity: a notification record that is missing or unreadable is
//     repaired only from owner-bound durable evidence, and never silently
//     overwritten. A repair that cannot be written is reported as a failure, so
//     no caller can mistake it for a successful reconciliation.
// ---------------------------------------------------------------------------
const integrityJob = createJob({ stateDir, id: "job-integrity", role: "runner", workflow, cwd: root, now: 9_100 });
recordTerminal(stateDir, "job-integrity", { status: "completed", summary: "integrity", reportId: saved.reportId, reportChars: saved.chars, now: 9_110 });
markDelivery(stateDir, "job-integrity", {
  eventId: "runner:job-integrity:terminal",
  state: "queued",
  transport: "pi",
  messageId: "m-integrity",
  now: 9_120,
});
assert.equal(readNotificationState(stateDir, "runner:job-integrity:terminal").status, "missing", "a journal record that was never written is missing, not corrupt");

// A receipt cannot be recorded into a journal record that does not exist: the
// caller keeps it and retries once a record can be written.
const noRecord = acknowledgeDelivery({ stateDir, eventId: "runner:job-integrity:terminal", jobId: integrityJob.id, receipt: { kind: "pi-session-entry", entryId: "entry-x" }, now: 9_130 });
assert.equal(noRecord.ok, false);
assert.equal(noRecord.reason, "no-notification-record");
assert.equal(readJob(stateDir, integrityJob.id).delivery.state, "queued", "a refused receipt never moves the projection");

// The repair reconstructs the record from the owner-bound projection, keeping
// the facts the projection still holds and naming its source.
const repaired = repairNotificationFromJob({ stateDir, job: readJob(stateDir, integrityJob.id), eventId: "runner:job-integrity:terminal", now: 9_140 });
assert.equal(repaired.ok, true);
assert.equal(repaired.repaired, true);
assert.equal(repaired.record.jobId, integrityJob.id);
assert.equal(repaired.record.role, "runner");
assert.equal(repaired.record.state, "queued");
assert.equal(repaired.record.transport, "pi");
assert.equal(repaired.record.messageId, "m-integrity");
assert.equal(repaired.record.reportId, saved.reportId, "the retained report keeps pointing at the completion result");
assert.equal(repaired.record.resultAvailable, true);
assert.equal(repaired.record.repair.source, "job-projection");
assert.equal(repaired.record.repair.previous, "missing");
assert.equal(repaired.record.repair.at, 9_140);
assert.equal(readNotification(stateDir, "runner:job-integrity:terminal").seq, 1);
// An existing readable record is never rewritten by a repair.
const stableRepair = repairNotificationFromJob({ stateDir, job: readJob(stateDir, integrityJob.id), eventId: "runner:job-integrity:terminal", now: 9_150 });
assert.equal(stableRepair.repaired, false);
assert.equal(stableRepair.record.seq, 1);

// Ownership: a repair is refused for an event that is not the job's own, and an
// identity-less projection is only ever repaired under its canonical identity.
assert.equal(repairNotificationFromJob({ stateDir, job: readJob(stateDir, integrityJob.id), eventId: "runner:job-other:terminal" }).reason, "event-not-owned-by-job");
assert.equal(repairNotificationFromJob({ stateDir, job: readJob(stateDir, "job-legacy-delivery"), eventId: "runner:job-legacy-delivery:terminal" }).ok, true, "the canonical identity of an identity-less record is its own");
assert.equal(repairNotificationFromJob({ stateDir, job: readJob(stateDir, "job-legacy-delivery"), eventId: "runner:someone-else:terminal" }).reason, "event-not-owned-by-job");

// A record that exists but cannot be parsed is preserved before it is replaced,
// and the quarantine file is evidence, not a journal record.
const corruptEventId = "runner:job-corrupt:terminal";
createJob({ stateDir, id: "job-corrupt", role: "runner", workflow, cwd: root, now: 9_160 });
recordTerminal(stateDir, "job-corrupt", { status: "completed", summary: "corrupt", now: 9_170 });
markDelivery(stateDir, "job-corrupt", { eventId: corruptEventId, state: "accepted", transport: "pi", messageId: "m-corrupt", now: 9_180 });
writeFileSync(notificationPath(stateDir, corruptEventId), "{ this is not json", "utf8");
assert.equal(readNotificationState(stateDir, corruptEventId).status, "corrupt");
assert.equal(readNotification(stateDir, corruptEventId), null, "an unreadable record is not a record");
const corruptAck = acknowledgeDelivery({ stateDir, eventId: corruptEventId, jobId: "job-corrupt", receipt: { kind: "pi-session-entry", entryId: "entry-corrupt" }, now: 9_190 });
assert.equal(corruptAck.ok, false);
assert.equal(corruptAck.reason, "notification-record-corrupt", "an unreadable record is reported as such, never overwritten in place");
assert.equal(readFileSync(notificationPath(stateDir, corruptEventId), "utf8"), "{ this is not json", "the unreadable bytes are still there");
const corruptRepair = repairNotificationFromJob({ stateDir, job: readJob(stateDir, "job-corrupt"), eventId: corruptEventId, now: 9_200 });
assert.equal(corruptRepair.ok, true);
assert.equal(corruptRepair.repaired, true);
assert.equal(corruptRepair.record.repair.previous, "corrupt");
assert.equal(corruptRepair.record.state, "accepted");
assert.ok(corruptRepair.quarantined, "the unreadable record is preserved next to the journal");
assert.equal(readFileSync(join(stateDir, "notifications", corruptRepair.quarantined), "utf8"), "{ this is not json");
assert.equal(readNotification(stateDir, corruptEventId).jobId, "job-corrupt", "the reconstructed record is readable");
assert.equal(listNotifications(stateDir).some((record) => record.jobId === "job-corrupt" && record.seq === 1), true);
assert.equal(listNotifications(stateDir).length, listNotifications(stateDir).filter((record) => record.schema === 1).length, "a quarantine file is never read as a journal record");

// A record whose bytes cannot even be read cannot be preserved either, so nothing
// may be written over it: the uncertainty is reported instead of being silently
// discarded.
const blockedEventId = "runner:job-blocked:terminal";
createJob({ stateDir, id: "job-blocked", role: "runner", workflow, cwd: root, now: 9_210 });
recordTerminal(stateDir, "job-blocked", { status: "completed", summary: "blocked", now: 9_220 });
markDelivery(stateDir, "job-blocked", { eventId: blockedEventId, state: "queued", transport: "pi", now: 9_230 });
// A directory where the record belongs: reading it fails for a reason that is
// not "nothing was written".
mkdirSync(notificationPath(stateDir, blockedEventId), { recursive: true });
const blockedState = readNotificationState(stateDir, blockedEventId);
assert.equal(blockedState.status, "unreadable", "an unreadable record is not confused with a missing one");
assert.equal(blockedState.record, null);
const blockedRepair = repairNotificationFromJob({ stateDir, job: readJob(stateDir, "job-blocked"), eventId: blockedEventId, now: 9_240 });
assert.equal(blockedRepair.ok, false);
assert.equal(blockedRepair.reason, "notification-record-unreadable");
const blockedAck = acknowledgeDelivery({ stateDir, eventId: blockedEventId, jobId: "job-blocked", receipt: { kind: "pi-session-entry", entryId: "e" }, now: 9_245 });
assert.equal(blockedAck.ok, false);
assert.equal(blockedAck.reason, "notification-record-unreadable");
assert.equal(existsSync(notificationPath(stateDir, blockedEventId)), true, "the unreadable record is left in place");
assert.equal(readJob(stateDir, "job-blocked").delivery.state, "queued", "no durable success is claimed for an unreadable record");

// The quarantine step itself is reported when it cannot preserve the bytes.
const unwritablePreserveDir = join(tempDir("qq-state-preserve-"), "state");
mkdirSync(join(unwritablePreserveDir, "jobs"), { recursive: true });
writeFileSync(join(unwritablePreserveDir, "notifications"), "a file blocks the journal directory", "utf8");
const failedPreserve = preserveCorruptNotification(unwritablePreserveDir, "runner:blocked:terminal", { raw: "unreadable bytes", now: 9_246 });
assert.equal(failedPreserve.ok, false);
assert.equal(failedPreserve.reason, "corrupt-evidence-preserve-failed");
assert.equal(failedPreserve.quarantined, null);

// A record that exists and is readable, but whose write fails (the atomic
// write's scratch path is occupied, which is how a failing filesystem write
// presents itself to the journal): the receipt is refused, and neither record is
// claimed to have advanced.
const failingWriteEventId = "runner:job-failing-write:terminal";
createJob({ stateDir, id: "job-failing-write", role: "runner", workflow, cwd: root, now: 9_248 });
recordTerminal(stateDir, "job-failing-write", { status: "completed", summary: "failing write", now: 9_249 });
await routeNotification({
  stateDir,
  eventId: failingWriteEventId,
  jobId: "job-failing-write",
  role: "runner",
  text: "failing write result",
  transport: { name: "pi", deliver: async () => ({ state: "queued", reason: "session-busy" }) },
  persistJob: true,
  now: 9_251,
});
assert.equal(readNotification(stateDir, failingWriteEventId).state, "queued");
mkdirSync(`${notificationPath(stateDir, failingWriteEventId)}.tmp-${process.pid}`, { recursive: true });
const failingWriteAck = acknowledgeDelivery({
  stateDir,
  eventId: failingWriteEventId,
  jobId: "job-failing-write",
  receipt: { kind: "pi-session-entry", entryId: "entry-failing" },
  now: 9_252,
});
assert.equal(failingWriteAck.ok, false, "a receipt whose record could not be written is not acknowledged");
assert.equal(failingWriteAck.acknowledged, false);
assert.equal(failingWriteAck.reason, "notification-write-failed");
assert.ok(failingWriteAck.error, "the write failure is reported");
assert.equal(readNotification(stateDir, failingWriteEventId).state, "queued", "the record is unchanged");
assert.equal(readJob(stateDir, "job-failing-write").delivery.state, "queued", "and the projection is untouched");
rmSync(`${notificationPath(stateDir, failingWriteEventId)}.tmp-${process.pid}`, { recursive: true, force: true });
const recoveredWriteAck = acknowledgeDelivery({
  stateDir,
  eventId: failingWriteEventId,
  jobId: "job-failing-write",
  receipt: { kind: "pi-session-entry", entryId: "entry-failing" },
  now: 9_253,
});
assert.equal(recoveredWriteAck.ok, true, "the same receipt lands once the record can be written");
assert.equal(readJob(stateDir, "job-failing-write").delivery.state, "delivered");

// The router preserves an unreadable record before it writes that event's
// record again (the completion is still attempted — a proven-absent event must be
// able to reach its owner), reuses the first quarantine instead of piling up
// copies, and refuses outright when the bytes cannot even be read.
const routedCorruptEventId = "runner:job-routed-corrupt:terminal";
createJob({ stateDir, id: "job-routed-corrupt", role: "runner", workflow, cwd: root, now: 9_247 });
recordTerminal(stateDir, "job-routed-corrupt", { status: "completed", summary: "routed corrupt", now: 9_247 });
writeFileSync(notificationPath(stateDir, routedCorruptEventId), "{ partially written", "utf8");
const routedCorrupt = await routeNotification({
  stateDir,
  eventId: routedCorruptEventId,
  jobId: "job-routed-corrupt",
  role: "runner",
  text: "routed corrupt result",
  transport: { name: "pi", deliver: async () => ({ state: "queued", reason: "session-busy" }) },
  persistJob: true,
  now: 9_252,
});
assert.equal(routedCorrupt.state, "queued", "the attempt still reaches the transport");
assert.equal(routedCorrupt.delivery.repair, undefined, "the record is a fresh attempt, not a reconstruction");
const firstQuarantine = readdirSync(join(stateDir, "notifications")).filter((name) => name.startsWith("runner_job-routed-corrupt_terminal.corrupt-"));
assert.equal(firstQuarantine.length, 1, "the unreadable bytes are preserved");
assert.equal(readFileSync(join(stateDir, "notifications", firstQuarantine[0]), "utf8"), "{ partially written");
const preservedReuse = preserveCorruptNotification(stateDir, routedCorruptEventId, { raw: "{ partially written", now: 9_252 });
assert.equal(preservedReuse.ok, true);
assert.equal(preservedReuse.existing, true, "the first preserved copy is the evidence, so it is not rewritten");
assert.equal(readdirSync(join(stateDir, "notifications")).filter((name) => name.startsWith("runner_job-routed-corrupt_terminal.corrupt-")).length, 1);
const unreadableRoutedEventId = "runner:job-routed-unreadable:terminal";
createJob({ stateDir, id: "job-routed-unreadable", role: "runner", workflow, cwd: root, now: 9_247 });
recordTerminal(stateDir, "job-routed-unreadable", { status: "completed", summary: "routed unreadable", now: 9_247 });
mkdirSync(notificationPath(stateDir, unreadableRoutedEventId), { recursive: true });
let unreadableTransportCalls = 0;
const unreadableRouted = await routeNotification({
  stateDir,
  eventId: unreadableRoutedEventId,
  jobId: "job-routed-unreadable",
  role: "runner",
  text: "routed unreadable result",
  transport: { name: "pi", deliver: async () => { unreadableTransportCalls += 1; return { state: "queued" }; } },
  persistJob: true,
  now: 9_252,
});
assert.equal(unreadableRouted.ok, false, "a record that cannot be read is never written over");
assert.equal(unreadableRouted.reason, "notification-record-unreadable");
assert.equal(unreadableTransportCalls, 0, "and the event is not sent under an outcome that cannot be verified");
assert.equal(readJob(stateDir, "job-routed-unreadable").delivery, null, "a refused attempt records no delivery at all");
assert.equal(deliveryPending(stateDir, "job-routed-unreadable"), true, "the completion stays pending for the recovery that can read the record");

// A notification directory that cannot be written reports a write failure
// rather than a repaired record (nothing may claim a durable write that did not
// happen), and the projection is left exactly where it was.
const unwritableDir = join(tempDir("qq-state-unwritable-"), "state");
mkdirSync(join(unwritableDir, "jobs"), { recursive: true });
symlinkSync(join(unwritableDir, "nowhere"), join(unwritableDir, "notifications"));
createJob({ stateDir: unwritableDir, id: "job-unwritable", role: "runner", workflow, cwd: root, now: 9_250 });
recordTerminal(unwritableDir, "job-unwritable", { status: "completed", summary: "unwritable", now: 9_260 });
markDelivery(unwritableDir, "job-unwritable", { eventId: "runner:job-unwritable:terminal", state: "queued", transport: "pi", now: 9_270 });
const unwritableRepair = repairNotificationFromJob({ stateDir: unwritableDir, job: readJob(unwritableDir, "job-unwritable"), eventId: "runner:job-unwritable:terminal", now: 9_280 });
assert.equal(unwritableRepair.ok, false);
assert.equal(unwritableRepair.reason, "notification-write-failed");
assert.ok(unwritableRepair.error, "the write failure is reported, not swallowed");
assert.equal(readJob(unwritableDir, "job-unwritable").delivery.state, "queued", "a failed repair leaves the projection exactly where it was");
const unwritableAck = acknowledgeDelivery({ stateDir: unwritableDir, eventId: "runner:job-unwritable:terminal", jobId: "job-unwritable", receipt: { kind: "pi-session-entry", entryId: "e" }, now: 9_290 });
assert.equal(unwritableAck.ok, false);
assert.equal(unwritableAck.reason, "no-notification-record", "a journal that cannot be written is reported as missing, never as delivered");
rmSync(join(unwritableDir, "notifications"), { force: true });
mkdirSync(join(unwritableDir, "notifications"), { recursive: true });
const recoveredRepair = repairNotificationFromJob({ stateDir: unwritableDir, job: readJob(unwritableDir, "job-unwritable"), eventId: "runner:job-unwritable:terminal", now: 9_295 });
assert.equal(recoveredRepair.ok, true, "the same repair converges once the journal can be written");
assert.equal(recoveredRepair.record.state, "queued");

// ---------------------------------------------------------------------------
// S9. Legacy completion evidence: entries a previous release persisted without
//     the identity metadata are preserved as evidence, and only exact content
//     correspondence may ever read them as retention.
// ---------------------------------------------------------------------------
const legacyEvidence = normalizeEvidence({
  entries: [{ eventId: "runner:known:terminal", entryId: "entry-known", at: 5 }],
  unidentified: [
    { entryId: "entry-legacy", at: 6, text: "runner job-1 completed: old text" },
    { entryId: "entry-other-type", at: 7, text: "not a completion", customType: "some-other-extension" },
    { entryId: "entry-empty", at: 8, text: "" },
    "not an object",
  ],
  sessionFile: "legacy.jsonl",
  pendingMessages: false,
});
assert.equal(legacyEvidence.known, true);
assert.equal(legacyEvidence.byEventId.get("runner:known:terminal").entryId, "entry-known");
assert.equal(legacyEvidence.unidentified.length, 1, "only this profile's identity-less completions are evidence");
assert.equal(legacyEvidence.unidentified[0].entryId, "entry-legacy");
assert.equal(legacyEvidence.unidentified[0].customType, "qq-workflow-completion");
assert.deepEqual(normalizeEvidence(null).unidentified, [], "no evidence source means no legacy evidence either");

// Raw session-entry shapes are read the same way (a completion custom message
// with text and no identity), while a user message is not completion evidence.
const rawEvidence = normalizeEvidence({
  entries: [
    { id: "raw-1", type: "custom_message", customType: "qq-workflow-completion", content: "runner job-1 completed: raw", timestamp: "2024-01-01T00:00:00.000Z" },
    { id: "raw-2", type: "message", message: { role: "user", content: [{ type: "text", text: "runner job-1 completed: raw" }] } },
    { id: "raw-3", type: "custom_message", customType: "some-other-extension", content: "runner job-1 completed: raw" },
  ],
  sessionFile: "raw.jsonl",
  pendingMessages: false,
});
assert.equal(rawEvidence.unidentified.length, 1, "only this profile's completion entries are legacy evidence");
assert.equal(rawEvidence.unidentified[0].entryId, "raw-1");
assert.equal(rawEvidence.unidentified[0].text, "runner job-1 completed: raw");
assert.equal(rawEvidence.unidentified[0].at, Date.parse("2024-01-01T00:00:00.000Z"), "the entry timestamp is kept as the observation time");

const legacyTextJob = readJob(stateDir, "job-legacy-delivery");
assert.deepEqual(completionTextForms(legacyTextJob), [defaultCompletionText(legacyTextJob)], "a short completion has exactly one delivered form");
const matched = matchLegacyEvidence({ job: legacyTextJob, evidence: normalizeEvidence({ unidentified: [{ entryId: "entry-match", text: defaultCompletionText(legacyTextJob), at: 9 }] }) });
assert.equal(matched.state, "exact");
assert.equal(matched.copies, 1);
const identicalCopies = matchLegacyEvidence({
  job: legacyTextJob,
  evidence: normalizeEvidence({ unidentified: [{ entryId: "entry-match", text: defaultCompletionText(legacyTextJob) }, { entryId: "entry-copy", text: defaultCompletionText(legacyTextJob) }] }),
});
assert.equal(identicalCopies.state, "exact", "identical copies of one text are copies of one event, not two identities");
assert.equal(identicalCopies.copies, 2, "the copies are recorded");
const twoClaimants = matchLegacyEvidence({
  job: legacyTextJob,
  evidence: normalizeEvidence({ unidentified: [{ entryId: "entry-match", text: defaultCompletionText(legacyTextJob) }] }),
  claimants: new Map([[defaultCompletionText(legacyTextJob), ["job-legacy-delivery", "runner-other"]]]),
});
assert.equal(twoClaimants.state, "ambiguous", "a text two pending events could claim is never read as proof for either");
assert.deepEqual(twoClaimants.claimants, ["job-legacy-delivery", "runner-other"]);
assert.equal(twoClaimants.entry, undefined);
const partial = matchLegacyEvidence({ job: legacyTextJob, evidence: normalizeEvidence({ unidentified: [{ entryId: "entry-short", text: defaultCompletionText(legacyTextJob).slice(0, 12) }] }) });
assert.equal(partial.state, "unconfirmed", "a partial copy of this event's header is not a receipt");
const unrelated = matchLegacyEvidence({ job: legacyTextJob, evidence: normalizeEvidence({ unidentified: [{ entryId: "entry-other", text: "execution job-9 completed: unrelated" }] }) });
assert.equal(unrelated.state, "none", "an unrelated completion leaves this event's absence standing");

console.log("architect durable state tests passed");
