#!/usr/bin/env node
// Durable delivery-ATTEMPT INTENT: the crash window between an external
// transport accepting a completion and its callback reaching the journal.
//
// The gap this regression holds closed (PR123 baseline): routeNotificationOnce
// saved the report, called the external transport, and only THEN wrote the
// notification journal. A coordinator that died in between left no attempt
// behind, so recovery blindly sent the completion again. The same window bites
// the internal execution-host handoff: a role host writes notification state
// `queued` with transport `execution-host-handoff` (no external delivery) and
// the owning coordinator sends it later — a crash during that external send
// must not leave a journal that still looks like a never-sent internal handoff.
//
// TRANSPORT SIMULATION versus ACTUAL PI — every transport in this file is a
// SIMULATED external queue in a real subprocess or in-process double: it
// records its acceptance and then hangs, waits, or refuses. Nothing here talks
// to Pi. The ACTUAL Pi transport and native Pi session evidence (pi session
// entries, user-message wakes, live agent queues) are covered against the pi
// runtime double / installed Pi by tests/architect-notify-receipts.mjs and
// tests/idle-wakeup-recovery.mjs; the evidence handed to recovery below is
// SIMULATED owning-session evidence in the exact normalized shape the real
// reader (pi-extension/qq-architect.mjs `sessionEvidence`) produces.
//
// Scenarios (each in its own workflow session so the passes stay independent):
//   J1  SIGKILL after the external acceptance, before the callback → the lost
//       callback is outcome-unknown: recovery without evidence preserves the
//       uncertainty and never duplicates; a blind resend is refused; the report
//       saved before the send stays durable and single.
//   J2  the same crash, resolved by RETAINED session evidence → acknowledged
//       without sending, and never sent afterwards.
//   J3  the same crash, first unresolved, then resolved by PROVED-ABSENT
//       evidence → retried as exactly the same event (same event ID, one send,
//       same report), and not duplicated by a later evidence-less pass.
//   J4  internal handoff + SIGKILL during the coordinator's external send → the
//       journal records the external attempt (not a never-sent handoff), keeps
//       the handoff's queued/accepted history verbatim, and refuses a blind
//       resend until evidence resolves the outcome.
//   J5  explicit transport REFUSAL (the callback proved it) → the attempt is
//       settled and stays retryable without evidence — the counterexample to
//       J1's lost callback.
//   J6  concurrent same-process calls coalesce onto one send, and a receipt
//       that lands while the callback is in flight is never overwritten by the
//       weak queued result.
//   J7  cross-process: the receipt lands from another process while the
//       sender's callback is provably still in flight; the later weak result
//       cannot erase the receipt.
//   J8  an intent that cannot be made durable refuses the send outright: no
//       external invocation without a durable attempt record.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJob, deliveryPending, readJob, recordTerminal, writeJob } from "../workflow/jobs.mjs";
import {
  acknowledgeDelivery,
  completedEventId,
  deliverCompletion,
  notificationPath,
  readNotification,
  recoverPendingDeliveries,
  routeNotification,
} from "../workflow/notify.mjs";
import { listReports, readReport, saveReport } from "../workflow/reports.mjs";

const root = mkdtempSync(join(tmpdir(), "qq-attempt-journal-"));
const stateDir = join(root, "state");
const childScript = fileURLToPath(new URL("./fixtures/notification-attempt-child.mjs", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function spawnChild(request) {
  const requestPath = join(root, `request-${request.jobId}.json`);
  writeFileSync(requestPath, `${JSON.stringify(request)}\n`, "utf8");
  return spawn(process.execPath, [childScript, requestPath], { stdio: ["ignore", "ignore", "pipe"] });
}

function exited(child) {
  return new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
}

async function waitForFile(path, { timeoutMs = 8_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const content = readFileSync(path, "utf8");
      if (content.trim()) return content;
    } catch {
      // not written yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await sleep(20);
  }
}

function acceptances(path) {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// SIMULATED external queue: records every send it is asked to make and answers
// with the volatile `queued` result an external queue without receipts honestly
// reports. NOT actual Pi.
function recordingTransport() {
  const sends = [];
  return {
    name: "simulated-external-queue",
    sends,
    async deliver(notification) {
      sends.push(notification);
      return { state: "queued", reason: "simulated busy queue" };
    },
  };
}

// Run the production path in a real child process and SIGKILL it in the exact
// crash window: the external transport already recorded its acceptance, the
// callback never returned.
async function crashDuringCallback(request) {
  const child = spawnChild(request);
  const closed = exited(child);
  await waitForFile(request.acceptFile);
  child.kill("SIGKILL");
  const { signal } = await closed;
  assert.equal(signal, "SIGKILL", "the sender dies a real SIGKILL while its callback is in flight");
  assert.equal(existsSync(request.doneFile), false, "the transport callback never returned to the router");
  assert.equal(acceptances(request.acceptFile).length, 1, "the external transport accepted exactly one message");
}

// ---------------------------------------------------------------------------
// J1. SIGKILL after acceptance, before the callback: outcome-unknown.
//     Recovery without evidence preserves the uncertainty and never duplicates.
// ---------------------------------------------------------------------------
const lostSession = "attempt-journal-lost";
const lost = {
  stateDir,
  jobId: "job-lost-callback",
  role: "runner",
  sessionKey: lostSession,
  setup: "fresh",
  mode: "accept-hang",
  text: "ATTEMPT-JOURNAL-LOST-CALLBACK-FINDINGS",
  acceptFile: join(root, "accept-lost.jsonl"),
  doneFile: join(root, "done-lost.json"),
};
await crashDuringCallback(lost);
const lostJob = readJob(stateDir, lost.jobId);
const lostEventId = completedEventId(lostJob);
const lostRecord = readNotification(stateDir, lostEventId);
assert.equal(lostRecord.attempt.settled, false, "the lost callback is an unsettled attempt, never a result");
assert.equal(lostRecord.attempt.transport, "simulated-external-queue");
assert.equal(lostRecord.attempt.count, 1);
assert.equal(lostRecord.state, "pending", "an intent-only record claims no transport result");
// Report-before-notify: the report the intent points at was saved before the
// external send and survives the crash verbatim, as the only copy.
assert.equal(lostRecord.reportId, lostJob.terminal.reportId);
const lostReport = readReport(stateDir, lostJob.terminal.reportId);
assert.equal(lostReport.ok, true);
assert.ok(lostReport.text.includes("ATTEMPT-JOURNAL-LOST-CALLBACK-FINDINGS"));
assert.equal(listReports(stateDir).filter((entry) => entry.reportId === lostJob.terminal.reportId).length, 1);

const lostTransport = recordingTransport();
for (const pass of [1, 2]) {
  const summary = await recoverPendingDeliveries({ stateDir, sessionKey: lostSession, transport: lostTransport });
  assert.deepEqual(summary.replayed, [], `evidence-less pass ${pass} must not duplicate a lost callback`);
  assert.deepEqual(summary.duplicates, []);
  assert.equal(summary.uncertain.length, 1);
  assert.equal(summary.uncertain[0].reason, "no-session-evidence");
  assert.equal(lostTransport.sends.length, 0, `evidence-less pass ${pass} never reaches the transport`);
}
assert.equal(readNotification(stateDir, lostEventId).state, "unknown", "the uncertainty is recorded, not guessed away");
assert.equal(deliveryPending(stateDir, lost.jobId), true, "an outcome-unknown event stays pending for its owning session's evidence");
// A blind coordinator resend is refused: a lost callback is never read as proof
// of absence.
const blind = await deliverCompletion({ stateDir, job: readJob(stateDir, lost.jobId), transport: lostTransport });
assert.equal(blind.state, "unknown");
assert.equal(blind.reason, "delivery-attempt-outcome-unknown");
assert.equal(lostTransport.sends.length, 0, "no send behind a lost callback");
assert.equal(listReports(stateDir).filter((entry) => entry.reportId === lostJob.terminal.reportId).length, 1, "the original report is never duplicated or replaced");

// ---------------------------------------------------------------------------
// J2. The same crash, resolved by RETAINED owning-session evidence:
//     acknowledge without sending.
// ---------------------------------------------------------------------------
const retainedSession = "attempt-journal-retained";
const retained = {
  stateDir,
  jobId: "job-retained-callback",
  role: "runner",
  sessionKey: retainedSession,
  setup: "fresh",
  mode: "accept-hang",
  text: "ATTEMPT-JOURNAL-RETAINED-FINDINGS",
  acceptFile: join(root, "accept-retained.jsonl"),
  doneFile: join(root, "done-retained.json"),
};
await crashDuringCallback(retained);
const retainedEventId = completedEventId(readJob(stateDir, retained.jobId));
const retainedTransport = recordingTransport();
// SIMULATED owning-session evidence (NOT actual Pi): the retained event
// identity, in the exact normalized shape the real reader produces.
const retainedSummary = await recoverPendingDeliveries({
  stateDir,
  sessionKey: retainedSession,
  transport: retainedTransport,
  evidence: { entries: [{ eventId: retainedEventId, entryId: "entry-retained", at: Date.now() }], sessionFile: "simulated-session.jsonl", pendingMessages: false },
});
assert.deepEqual(retainedSummary.replayed, [], "a retained event is never re-sent");
assert.equal(retainedSummary.reconciled.length, 1, "the retained event is acknowledged from its receipt evidence");
assert.equal(retainedSummary.reconciled[0].entryId, "entry-retained");
assert.equal(retainedTransport.sends.length, 0, "acknowledged without sending");
const retainedRecord = readNotification(stateDir, retainedEventId);
assert.equal(retainedRecord.state, "delivered");
assert.equal(retainedRecord.receipt.kind, "pi-session-entry");
assert.equal(retainedRecord.attempt.settledBy, "receipt", "the receipt resolves the lost callback");
assert.equal(readJob(stateDir, retained.jobId).delivery.state, "delivered");
const retainedSettled = await recoverPendingDeliveries({ stateDir, sessionKey: retainedSession, transport: retainedTransport });
assert.deepEqual(retainedSettled.replayed, []);
assert.deepEqual(retainedSettled.reconciled, [], "an acknowledged event is not reconciled twice");
assert.equal(retainedTransport.sends.length, 0);

// ---------------------------------------------------------------------------
// J3. The same crash, resolved by PROVED-ABSENT owning-session evidence
//     (the session was inspected and does not hold the event): retry exactly
//     the same event.
// ---------------------------------------------------------------------------
const retrySession = "attempt-journal-retry";
const retry = {
  stateDir,
  jobId: "job-retry-callback",
  role: "runner",
  sessionKey: retrySession,
  setup: "fresh",
  mode: "accept-hang",
  text: "ATTEMPT-JOURNAL-RETRY-FINDINGS",
  acceptFile: join(root, "accept-retry.jsonl"),
  doneFile: join(root, "done-retry.json"),
};
await crashDuringCallback(retry);
const retryJob = readJob(stateDir, retry.jobId);
const retryEventId = completedEventId(retryJob);
const retryTransport = recordingTransport();
const retryUncertain = await recoverPendingDeliveries({ stateDir, sessionKey: retrySession, transport: retryTransport });
assert.equal(retryUncertain.uncertain.length, 1, "without evidence the uncertainty is preserved first");
assert.equal(retryTransport.sends.length, 0);
// SIMULATED owning-session evidence (NOT actual Pi): the session was read and
// the event is provably absent from it.
const absent = await recoverPendingDeliveries({
  stateDir,
  sessionKey: retrySession,
  transport: retryTransport,
  evidence: { entries: [], sessionFile: "simulated-session.jsonl", pendingMessages: false },
});
assert.equal(absent.replayed.length, 1, "proved absence resolves the lost callback toward a retry");
assert.equal(absent.replayed[0].eventId, retryEventId, "the retry is exactly the same event");
assert.equal(absent.replayed[0].reason, "receipt-absent");
assert.equal(retryTransport.sends.length, 1);
assert.equal(retryTransport.sends[0].eventId, retryEventId, "and it is sent under exactly the same event ID");
const retryRecord = readNotification(stateDir, retryEventId);
assert.equal(retryRecord.attempt.count, 2, "the crashed attempt and the retry are both recorded");
assert.equal(retryRecord.attemptHistory.length, 1, "the crashed attempt is preserved as history");
assert.equal(retryRecord.attemptHistory[0].settled, false, "the lost callback stays visible as history");
assert.equal(listReports(stateDir).filter((entry) => entry.reportId === retryJob.terminal.reportId).length, 1, "the retry reuses the original report");
const afterRetry = await recoverPendingDeliveries({ stateDir, sessionKey: retrySession, transport: retryTransport });
assert.deepEqual(afterRetry.replayed, []);
assert.equal(retryTransport.sends.length, 1, "an evidence-less pass after the retry does not duplicate the volatile send");

// ---------------------------------------------------------------------------
// J4. Internal execution-host handoff + SIGKILL during the coordinator's
//     external send: the journal must not look like a never-sent handoff.
// ---------------------------------------------------------------------------
const handoffSession = "attempt-journal-handoff";
const handoffJobId = "job-handoff";
createJob({ stateDir, id: handoffJobId, role: "execution", workflow: { sessionKey: handoffSession, root }, cwd: root });
const handoffReport = saveReport(stateDir, { jobId: handoffJobId, role: "execution", text: "ATTEMPT-JOURNAL-HANDOFF-FINDINGS" });
recordTerminal(stateDir, handoffJobId, {
  status: "completed",
  summary: "handoff findings",
  reportId: handoffReport.reportId,
  reportChars: handoffReport.chars,
});
const handoffEventId = completedEventId(readJob(stateDir, handoffJobId));
// The role host's INTERNAL handoff (SIMULATED transport): notification state
// queued behind the owning coordinator, no external delivery.
const handedOff = await routeNotification({
  stateDir,
  eventId: handoffEventId,
  jobId: handoffJobId,
  role: "execution",
  workflow: { sessionKey: handoffSession, root },
  text: "execution job-handoff completed: handoff findings",
  transport: { name: "execution-host-handoff", deliver: async () => ({ state: "queued", reason: "held for the owning coordinator" }) },
  persistJob: true,
});
assert.equal(handedOff.state, "queued");
assert.equal(readNotification(stateDir, handoffEventId).transport, "execution-host-handoff");
// The owning coordinator now sends it externally — and dies mid-callback.
await crashDuringCallback({
  stateDir,
  jobId: handoffJobId,
  role: "execution",
  sessionKey: handoffSession,
  setup: "existing",
  mode: "accept-hang",
  text: "ATTEMPT-JOURNAL-HANDOFF-FINDINGS",
  acceptFile: join(root, "accept-handoff.jsonl"),
  doneFile: join(root, "done-handoff.json"),
});
const handoffRecord = readNotification(stateDir, handoffEventId);
assert.equal(handoffRecord.attempt.settled, false, "the external send's callback was lost");
assert.equal(handoffRecord.attempt.transport, "simulated-external-queue", "the journal records the EXTERNAL attempt, not only the handoff");
assert.equal(handoffRecord.attempt.count, 2);
assert.equal(handoffRecord.state, "queued", "the new intent never erases the queued state");
assert.equal(handoffRecord.transport, "execution-host-handoff", "the new intent never erases the accepted history");
assert.equal(handoffRecord.attemptHistory.at(-1).transport, "execution-host-handoff", "the handoff attempt is preserved as history");
assert.equal(handoffRecord.attemptHistory.at(-1).result, "queued");
assert.equal(handoffRecord.attemptHistory.at(-1).settled, true);
// The coordinator's blind resend must NOT treat this as a never-sent handoff.
const handoffTransport = recordingTransport();
const resend = await deliverCompletion({ stateDir, job: readJob(stateDir, handoffJobId), transport: handoffTransport });
assert.equal(resend.state, "unknown");
assert.equal(resend.reason, "delivery-attempt-outcome-unknown");
assert.equal(handoffTransport.sends.length, 0, "a crashed external send is never silently repeated");
const handoffSummary = await recoverPendingDeliveries({ stateDir, sessionKey: handoffSession, transport: handoffTransport });
assert.deepEqual(handoffSummary.replayed, []);
assert.equal(handoffSummary.uncertain.length, 1);
assert.equal(handoffSummary.uncertain[0].reason, "no-session-evidence");
assert.equal(handoffTransport.sends.length, 0);

// ---------------------------------------------------------------------------
// J5. An explicit transport REFUSAL proves the outcome: the attempt settles and
//     the event stays retryable without evidence — the counterexample to J1.
// ---------------------------------------------------------------------------
const refusalSession = "attempt-journal-refusal";
const refused = {
  stateDir,
  jobId: "job-refused-callback",
  role: "runner",
  sessionKey: refusalSession,
  setup: "fresh",
  mode: "refuse",
  text: "ATTEMPT-JOURNAL-REFUSAL-FINDINGS",
  acceptFile: join(root, "accept-refused.jsonl"),
  doneFile: join(root, "done-refused.json"),
};
const refusedChild = spawnChild(refused);
const refusedExit = await exited(refusedChild);
assert.equal(refusedExit.code, 0);
assert.equal(JSON.parse(readFileSync(refused.doneFile, "utf8")).state, "failed");
const refusedEventId = completedEventId(readJob(stateDir, refused.jobId));
const refusedRecord = readNotification(stateDir, refusedEventId);
assert.equal(refusedRecord.state, "failed");
assert.equal(refusedRecord.attempt.settled, true, "an explicit refusal settles the attempt: the outcome is known");
assert.equal(refusedRecord.attempt.result, "failed");
const refusedTransport = recordingTransport();
const refusalRetry = await recoverPendingDeliveries({ stateDir, sessionKey: refusalSession, transport: refusedTransport });
assert.equal(refusalRetry.uncertain.length, 0, "a proved refusal is not uncertainty");
assert.equal(refusalRetry.replayed.length, 1, "a proved refusal stays retryable without evidence");
assert.equal(refusalRetry.replayed[0].reason, "undelivered");
assert.equal(refusalRetry.replayed[0].eventId, refusedEventId);
assert.equal(refusedTransport.sends.length, 1);
assert.equal(refusedTransport.sends[0].eventId, refusedEventId);

// ---------------------------------------------------------------------------
// J6. Concurrent same-process calls coalesce onto one send; a receipt that
//     lands while the callback is in flight is never overwritten by the weak
//     queued result the callback returns.
// ---------------------------------------------------------------------------
const lateSession = "attempt-journal-late-receipt";
const lateJobId = "job-late-receipt";
createJob({ stateDir, id: lateJobId, role: "runner", workflow: { sessionKey: lateSession, root }, cwd: root });
recordTerminal(stateDir, lateJobId, { status: "completed", summary: "late receipt findings" });
const lateEventId = completedEventId(readJob(stateDir, lateJobId));
const lateSends = [];
let releaseGate;
const gate = new Promise((done) => {
  releaseGate = done;
});
const gatedTransport = {
  name: "simulated-external-queue",
  async deliver(notification) {
    lateSends.push(notification);
    await gate;
    return { state: "queued", reason: "simulated busy queue" };
  },
};
const routeOptions = {
  stateDir,
  eventId: lateEventId,
  jobId: lateJobId,
  role: "runner",
  workflow: { sessionKey: lateSession, root },
  text: "late receipt findings",
  transport: gatedTransport,
  persistJob: true,
};
const first = routeNotification(routeOptions);
const second = routeNotification(routeOptions);
assert.equal(lateSends.length, 1, "concurrent same-process calls coalesce onto one send");
// The receipt lands while the sender's callback is still in flight — the same
// race as "consumption observed before the send returns", one write earlier.
const lateAck = acknowledgeDelivery({
  stateDir,
  eventId: lateEventId,
  jobId: lateJobId,
  receipt: { kind: "pi-session-entry", eventId: lateEventId, entryId: "entry-late", sessionFile: "simulated-session.jsonl" },
});
assert.equal(lateAck.ok, true, "a receipt can settle the intent record before the callback returns");
assert.equal(readNotification(stateDir, lateEventId).state, "delivered");
releaseGate();
const [firstResult, secondResult] = await Promise.all([first, second]);
assert.equal(secondResult.coalesced, true, "the coalesced caller reports the in-flight outcome");
assert.equal(firstResult.state, "delivered", "the weak queued callback cannot overwrite the receipt");
const lateRecord = readNotification(stateDir, lateEventId);
assert.equal(lateRecord.state, "delivered");
assert.equal(lateRecord.receipt.entryId, "entry-late", "the receipt survives the late weak result");
assert.equal(lateRecord.lastResult.applied, false, "the weak result is retained as history, not as state");
assert.equal(lateRecord.lastResult.state, "queued");
assert.equal(lateRecord.attempt.settledBy, "receipt", "the receipt resolved the attempt first");
assert.equal(lateSends.length, 1, "still exactly one send");
const durableRepeat = await routeNotification({
  stateDir,
  eventId: lateEventId,
  text: "late receipt findings",
  transport: { name: "never", deliver: async () => { throw new Error("a receipt-bearing event must not reach the transport"); } },
});
assert.equal(durableRepeat.duplicate, true);
assert.equal(lateSends.length, 1);

// ---------------------------------------------------------------------------
// J7. Cross-process: the receipt lands from ANOTHER process while the sender's
//     callback is provably in flight; the sender's later weak result cannot
//     erase the strong evidence.
// ---------------------------------------------------------------------------
const crossSession = "attempt-journal-cross";
const cross = {
  stateDir,
  jobId: "job-cross-process",
  role: "runner",
  sessionKey: crossSession,
  setup: "fresh",
  mode: "accept-wait-release",
  text: "ATTEMPT-JOURNAL-CROSS-PROCESS-FINDINGS",
  acceptFile: join(root, "accept-cross.jsonl"),
  doneFile: join(root, "done-cross.json"),
  releaseFile: join(root, "release-cross"),
};
const crossChild = spawnChild(cross);
const crossClosed = exited(crossChild);
await waitForFile(cross.acceptFile);
const crossEventId = completedEventId(readJob(stateDir, cross.jobId));
assert.equal(readNotification(stateDir, crossEventId).attempt.settled, false);
const crossAck = acknowledgeDelivery({
  stateDir,
  eventId: crossEventId,
  jobId: cross.jobId,
  receipt: { kind: "pi-session-entry", eventId: crossEventId, entryId: "entry-cross", sessionFile: "simulated-session.jsonl" },
});
assert.equal(crossAck.ok, true);
assert.equal(readNotification(stateDir, crossEventId).state, "delivered");
// Let the sender's callback return its weak result now.
writeFileSync(cross.releaseFile, "release\n", "utf8");
const crossExit = await crossClosed;
assert.equal(crossExit.code, 0);
const crossResult = JSON.parse(readFileSync(cross.doneFile, "utf8"));
assert.equal(crossResult.state, "delivered", "the sender reports the receipt it could not regress");
const crossRecord = readNotification(stateDir, crossEventId);
assert.equal(crossRecord.state, "delivered", "a later weak cross-process result cannot erase the receipt");
assert.equal(crossRecord.receipt.entryId, "entry-cross");
assert.equal(crossRecord.attempt.settled, true, "the attempt is closed — resolved by the receipt, never left open");
assert.equal(crossRecord.attempt.settledBy, "receipt", "the strong evidence that resolved it is what the attempt records");
assert.equal(crossRecord.lastResult.state, "queued", "the weak callback that returned later is kept as history");
assert.equal(crossRecord.lastResult.applied, false);
assert.equal(readJob(stateDir, cross.jobId).delivery.state, "delivered", "the projection keeps the receipt too");

// ---------------------------------------------------------------------------
// J8. An attempt intent that cannot be made durable refuses the send: no
//     external invocation happens without a durable attempt record.
// ---------------------------------------------------------------------------
const blockedSession = "attempt-journal-intent-write";
const blockedJobId = "job-intent-write";
createJob({ stateDir, id: blockedJobId, role: "runner", workflow: { sessionKey: blockedSession, root }, cwd: root });
const blockedReport = saveReport(stateDir, { jobId: blockedJobId, role: "runner", text: "ATTEMPT-JOURNAL-INTENT-WRITE-FINDINGS" });
recordTerminal(stateDir, blockedJobId, { status: "completed", summary: "intent write findings", reportId: blockedReport.reportId, reportChars: blockedReport.chars });
const blockedEventId = completedEventId(readJob(stateDir, blockedJobId));
// Occupy the atomic write's scratch path: the intent cannot become durable.
mkdirSync(`${notificationPath(stateDir, blockedEventId)}.tmp-${process.pid}`, { recursive: true });
const blockedSends = [];
const blockedTransport = {
  name: "simulated-external-queue",
  async deliver(notification) {
    blockedSends.push(notification);
    return { state: "queued", reason: "simulated busy queue" };
  },
};
const blocked = await deliverCompletion({ stateDir, job: readJob(stateDir, blockedJobId), transport: blockedTransport });
assert.equal(blocked.ok, false);
assert.equal(blocked.reason, "delivery-intent-write-failed");
assert.equal(blockedSends.length, 0, "no external send starts without a durable attempt intent");
rmSync(`${notificationPath(stateDir, blockedEventId)}.tmp-${process.pid}`, { recursive: true, force: true });
const unblocked = await deliverCompletion({ stateDir, job: readJob(stateDir, blockedJobId), transport: blockedTransport });
assert.equal(unblocked.state, "queued");
assert.equal(blockedSends.length, 1, "the same call sends exactly once once the intent is durable");
assert.equal(readNotification(stateDir, blockedEventId).attempt.settled, true);


// J9. Simulate interruption after the queued callback was journaled but before
// its compatibility job projection was written. The durable journal must still
// prevent an evidence-less resend.
const projectionSession="queued-journal-projection-gap",projectionId="queued-journal-projection-gap";
createJob({stateDir,id:projectionId,role:"runner",workflow:{sessionKey:projectionSession,root:stateDir},cwd:stateDir});
recordTerminal(stateDir,projectionId,{status:"completed",summary:"Projection write gap findings"});
const projectionTransport=recordingTransport();
await deliverCompletion({stateDir,job:readJob(stateDir,projectionId),transport:projectionTransport});
const projectionJob=readJob(stateDir,projectionId),projectionEvent=completedEventId(projectionJob);
writeJob(stateDir,{...projectionJob,delivery:null});
assert.equal(readNotification(stateDir,projectionEvent).attempt.settled,true);
const projectionRecovery=await recoverPendingDeliveries({stateDir,sessionKey:projectionSession,transport:projectionTransport});
assert.equal(projectionTransport.sends.length,1,"a queued journal survives the missing job projection without duplicate send");
assert.equal(projectionRecovery.uncertain.length,1);
await recoverPendingDeliveries({stateDir,sessionKey:projectionSession,transport:projectionTransport,evidence:{entries:[],pendingMessages:false,inFlight:[]}});
assert.equal(projectionTransport.sends.length,2,"proved absence permits the same event to retry");
assert.equal(projectionTransport.sends[1].eventId,projectionEvent);

console.log(
  "PASS notification attempt journal (transport simulation in subprocesses/in-process doubles; actual Pi transport and native Pi session evidence remain covered by architect-notify-receipts.mjs and idle-wakeup-recovery.mjs): lost callbacks stay outcome-unknown and un-duplicated, retained evidence acknowledges without sending, proved absence retries exactly the same event, the internal handoff crash is no longer a never-sent handoff, proved refusals stay retryable, concurrent calls coalesce, late cross-process receipts are never erased, and no send starts without a durable intent",
);
