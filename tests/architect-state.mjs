#!/usr/bin/env node
// Durable workflow state: job records, cancellation tombstones, report store,
// completion delivery, and restart reconciliation.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  completedEventId,
  deliverCompletion,
  isDuplicate,
  listJobsWithPendingDelivery,
  listNotifications,
  readNotification,
  recoverPendingDeliveries,
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
assert.ok(spilled.report.chars > 32_768);
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

// Delivery bookkeeping is recorded on the record itself.
markDelivery(stateDir, "job-delivery", { eventId: firstDelivery.eventId, state: "queued", reason: "resumed" });
assert.equal(readJob(stateDir, "job-delivery").delivery.attempts, 2);
assert.equal(jobSummary(readJob(stateDir, "job-delivery")).terminal.reportId, saved.reportId);
assert.ok(existsSync(jobArtifacts(stateDir, readJob(stateDir, "job-delivery")).record));
assert.ok(readFileSync(jobArtifacts(stateDir, readJob(stateDir, "job-delivery")).record, "utf8").includes("job-delivery"));

console.log("architect durable state tests passed");
