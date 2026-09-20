#!/usr/bin/env node
// Completion receipts: what turns a volatile `queued` notification into a
// durable `delivered` record, and how recovery resolves every state in between.
//
// The scenarios are the counterexamples the ticket asks a reviewer to evaluate,
// not the happy path:
//   R1  busy notification consumed → exact event/job identity acknowledged, both
//       durable records advance to delivered with truthful timestamps
//   R2  consumption before the send returns cannot be overwritten by a later
//       queued result; duplicate hooks and repeated recovery never resend or
//       regress
//   R3  crash before the queue drained → restart replays it to the exact owner
//   R4  crash after pi's session insertion but before the receipt update →
//       reconciliation from persisted session evidence, no blind duplicate
//   R5  unprovable outcomes (no identity, no evidence, still queued here) are
//       retained as outcome-unknown/deferred; an identity-less record is never
//       auto-replayed, and only explicit recovery retries the unprovable set
//   R6  idle wakeup and its receipt, retryable transport failures, report
//       retention and exact-session ownership stay intact
//   R7  concurrent attempts coalesce; a receipt is never downgraded
//   R8  a busy completion still in pi's agent queue (which
//       `hasPendingMessages()` does not report) is deferred, never re-steered
//   R9  `/reload` rebuilds the extension around the same live agent: the
//       in-flight claim survives the reload and the tick does not duplicate
//   R10 the in-flight claim is bounded to the run that accepted it, so an
//       abandoned queue is reconcilable instead of blocking forever
//   R11 upgrade from a release that steered completions without the identity
//       metadata: identity-less session entries (raw pi shape or the reader's
//       normalized shape) are preserved as evidence, an exact unique content
//       correspondence acknowledges the event, and identical, partial, or
//       ambiguous candidates are never replayed
//   R12 journal integrity: a missing record is rebuilt from the owner-bound
//       projection, a corrupt record is preserved before it is replaced (and the
//       replay refused when the bytes cannot be preserved), and a record that
//       cannot be written or read is an error — never a reported success, never
//       a resend, and always converged once a safe write is possible
//   R13 deferred receipt checks after a session replacement: no uncaught
//       exception, no acknowledgement from the replaced session's entries, and
//       no failure read as proof of absence
//
// pi runtime shapes/ordering follow the installed 0.84.1 source
// (`dist/core/agent-session.js`, `dist/core/extensions/loader.js`,
// `pi-agent-core/dist/agent-loop.js`); see tests/support/architect-fixtures.mjs.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createArchitectExtension } from "../pi-extension/qq-architect.mjs";
import { ARCHITECT_COMPLETION_CUSTOM_TYPE } from "../workflow/architect-profile.mjs";
import { deliveryPending, jobPath, readJob, writeJob } from "../workflow/jobs.mjs";
import {
  acknowledgeDelivery,
  completedEventId,
  defaultCompletionText,
  isDuplicate,
  listNotifications,
  notificationPath,
  notificationsDir,
  readNotification,
  preserveCorruptNotification,
  readNotificationState,
  recoverPendingDeliveries,
  routeNotification,
} from "../workflow/notify.mjs";
import { createWorkflow } from "../workflow/operations.mjs";
import { listReports, readReport } from "../workflow/reports.mjs";
import {
  callHandlers,
  piRuntimeDouble,
  runnerSpawner,
  tempDir,
  tempRepo,
  tickQueue,
} from "./support/architect-fixtures.mjs";

const { root, env } = await tempRepo({ agents: "Repository rule: keep changes in the worktree.\n" });
const stateDir = join(root, ".architect", "state");

function sessionEnv(key) {
  return { ...env, PASEO_AGENT_ID: key, QQ_ARCHITECT_OWNER_AGENT_ID: key };
}

// The Architect extension on the pi 0.84.1 runtime double: same construction as
// production (interactive declares the session already open, as the existing
// suite does) with the receipt check driven by the test's tick queue.
function buildExtension({ sessionKey: key, pi, response = "receipt findings", interactive = true, workflowFactory = null }) {
  const ticks = tickQueue();
  const extension = createArchitectExtension(pi, {
    env: sessionEnv(key),
    cwd: root,
    interactive,
    schedule: ticks.schedule,
    scheduleReceipt: ticks.schedule,
    workflowFactory:
      workflowFactory ??
      ((config) => createWorkflow({ ...config, spawnFn: runnerSpawner({ response }) })),
  });
  extension.registerTools(extension.tools.map((tool) => tool.parameters));
  return { extension, ticks };
}

// ---------------------------------------------------------------------------
// R1. Busy completion consumed: the exact event is acknowledged from the session
//     entry pi persisted, and both durable records advance to delivered.
// ---------------------------------------------------------------------------
const busyKey = "agent-receipts-busy";
const busyPi = piRuntimeDouble({ idle: false, sessionFile: join(root, "pi-busy.jsonl") });
const busy = buildExtension({ sessionKey: busyKey, pi: busyPi, response: "BUSY-RECEIPT-FINDINGS" });
await callHandlers(busyPi, "session_start", { reason: "startup" }, busyPi.ctx);
assert.equal(busyPi.ctx.isIdle(), false, "the operator's turn is active");
const busyWorkflow = busy.extension.ensureWorkflow();
const busyDispatch = busyWorkflow.dispatchRunner({ task: "busy receipt roundtrip" });
const busySettled = await busyWorkflow.awaitRunner({ jobId: busyDispatch.jobId });
assert.equal(busySettled.status, "completed");
const busyJob = readJob(stateDir, busyDispatch.jobId);
const busyEventId = completedEventId(busyJob);
assert.equal(busyEventId, `${busyJob.role}:${busyJob.id}:terminal`);
assert.equal(busySettled.delivery.state, "queued", "a busy session queues; acceptance is not delivery");
assert.equal(busyJob.delivery.state, "queued");
assert.equal(deliveryPending(stateDir, busyDispatch.jobId), true, "a queued notification is not a receipt and stays recoverable");

const steer = busyPi.sent.filter((entry) => entry.kind === "message").at(-1);
assert.ok(steer, "the busy completion is steered into the live session");
assert.equal(steer.options.deliverAs, "steer");
assert.equal(steer.message.customType, busy.extension.completionCustomType);
assert.deepEqual(steer.message.details, {
  eventId: busyEventId,
  jobId: busyDispatch.jobId,
  role: busyJob.role,
  kind: `${busyJob.role}.terminal`,
  reportId: busyJob.terminal.reportId,
}, "the custom message carries the stable event/job identity pi persists");
assert.equal(busyPi.queue.length, 1, "the message sits in pi's queue until the loop drains it");

// pi drains the queue: message_start, message_end, then the session entry.
await busyPi.drain();
const persisted = busyPi.entries.at(-1);
assert.equal(persisted.type, "custom_message");
assert.equal(persisted.details.eventId, busyEventId, "pi persists the event identity verbatim");
assert.equal(persisted.details.jobId, busyDispatch.jobId);
assert.equal(readJob(stateDir, busyDispatch.jobId).delivery.state, "queued", "the in-handler observation claims nothing: pi had not written the entry yet");

await busy.ticks.flush();
const busyDelivered = readJob(stateDir, busyDispatch.jobId);
assert.equal(busyDelivered.delivery.state, "delivered");
assert.equal(busyDelivered.delivery.receipt.kind, "pi-session-entry", "delivery is acknowledged against the persisted entry, not the transport call");
assert.equal(busyDelivered.delivery.receipt.entryId, persisted.id);
assert.equal(busyDelivered.delivery.receipt.sessionFile, busyPi.ctx.sessionManager.getSessionFile());
assert.ok(busyDelivered.delivery.deliveredAt >= busyDelivered.delivery.queuedAt, "delivery is not backdated to the queue acceptance");
assert.ok(busyDelivered.delivery.stateAt >= busyDelivered.delivery.queuedAt, "the receipt is the most recent state this record holds");
assert.equal(busyDelivered.delivery.attempts, 2, "one transport attempt and one receipt are both recorded");
const busyRecord = readNotification(stateDir, busyEventId);
assert.equal(busyRecord.state, "delivered");
assert.equal(busyRecord.receipt.kind, "pi-session-entry");
assert.ok(busyRecord.acknowledgedAt >= busyRecord.deliveryAt, "the accepted-at time and the acknowledged-at time are both truthful");
assert.equal(busyRecord.seq, 2, "the queue acceptance and the receipt are both recorded");
assert.equal(busyPi.sent.filter((entry) => entry.kind === "message").length, 1, "consumption never causes a resend");
assert.equal(busyRecord.resultAvailable, true, "result availability comes from the persisted report, not the ack");
assert.ok(readReport(stateDir, busyJob.terminal.reportId).text.includes("BUSY-RECEIPT-FINDINGS"));

// The receipt is idempotent: a duplicate hook pair and a repeated recovery pass
// change nothing and never resend.
await callHandlers(busyPi, "message_start", { message: persisted }, busyPi.ctx);
await callHandlers(busyPi, "message_end", { message: persisted }, busyPi.ctx);
await busy.ticks.flush();
const replayedAfterAck = await busyWorkflow.recoverDeliveries({
  transport: busy.extension.transport,
  evidence: busy.extension.sessionEvidence(busyPi.ctx),
});
assert.deepEqual(replayedAfterAck.delivery.replayed, [], "a receipt-bearing completion is never replayed");
assert.deepEqual(replayedAfterAck.delivery.reconciled, [], "an already delivered event needs no second reconciliation");
assert.equal(busyPi.sent.filter((entry) => entry.kind === "message").length, 1, "duplicate hooks do not resend");
assert.equal(readJob(stateDir, busyDispatch.jobId).delivery.attempts, 2, "a duplicate hook is not a new delivery attempt");
assert.equal(readNotification(stateDir, busyEventId).seq, 2, "the duplicate hook writes nothing new");
assert.equal(readJob(stateDir, busyDispatch.jobId).delivery.deliveredAt, busyDelivered.delivery.deliveredAt, "a repeated observation does not move the delivery time");

// ---------------------------------------------------------------------------
// R2. Queue/drain race: consumption observed before the send call returns is not
//     overwritten by the queued result the router writes afterwards.
// ---------------------------------------------------------------------------
const raceKey = "agent-receipts-race";
const racePi = piRuntimeDouble({ idle: false, consume: "sync", sessionFile: join(root, "pi-race.jsonl") });
const race = buildExtension({ sessionKey: raceKey, pi: racePi, response: "RACE-FINDINGS" });
await callHandlers(racePi, "session_start", { reason: "startup" }, racePi.ctx);
const raceWorkflow = race.extension.ensureWorkflow();
const raceDispatch = raceWorkflow.dispatchRunner({ task: "race roundtrip" });
const raceSettled = await raceWorkflow.awaitRunner({ jobId: raceDispatch.jobId });
const raceJob = readJob(stateDir, raceDispatch.jobId);
const raceEventId = completedEventId(raceJob);
assert.equal(raceSettled.delivery.state, "queued", "the transport returns the volatile queue result");
assert.equal(racePi.entries.at(-1).details.eventId, raceEventId, "the message was consumed and persisted inside the send call");
assert.equal(racePi.queue.length, 0, "the queue drained synchronously");

await race.ticks.flush();
assert.equal(readJob(stateDir, raceDispatch.jobId).delivery.state, "delivered", "the deferred receipt wins over the queued result written after it");
assert.equal(readNotification(stateDir, raceEventId).state, "delivered");
assert.equal(racePi.sent.filter((entry) => entry.kind === "message").length, 1);

// A later attempt of an event already observed consumed reports the receipt, not
// a volatile queue result: an early consumption can never be overwritten.
busyPi.ctx.idle = false;
const replayedAttempt = await busy.extension.transport.deliver({ eventId: busyEventId, jobId: busyDispatch.jobId, role: busyJob.role, text: "reoffer" });
assert.equal(replayedAttempt.state, "delivered");
assert.equal(replayedAttempt.receipt.kind, "pi-session-entry");
assert.equal(replayedAttempt.receipt.entryId, persisted.id);

// A late/straggler queued result for the same event can no longer regress it.
// Process-scoped dedupe forces the write path (the default durable mode refuses
// the send outright, which is asserted right after).
const stragglerCalls = [];
const straggler = await routeNotification({
  stateDir,
  eventId: raceEventId,
  jobId: raceDispatch.jobId,
  role: raceJob.role,
  text: "race re-drain",
  transport: {
    name: "straggler",
    deliver: async () => {
      stragglerCalls.push(1);
      return { state: "queued", reason: "session-busy" };
    },
  },
  dedupe: "process",
  persistJob: true,
});
assert.equal(stragglerCalls.length, 1, "the straggler result was actually produced");
assert.equal(straggler.state, "delivered", "the router reports the receipt state it holds");
const stragglerRecord = readNotification(stateDir, raceEventId);
assert.equal(stragglerRecord.state, "delivered");
assert.equal(stragglerRecord.receipt.kind, "pi-session-entry");
assert.equal(stragglerRecord.lastResult.applied, false, "the suppressed result is still recorded as history");
const stragglerJob = readJob(stateDir, raceDispatch.jobId);
assert.equal(stragglerJob.delivery.state, "delivered");
assert.equal(stragglerJob.delivery.lastResult.state, "queued");
assert.equal(stragglerJob.delivery.lastResult.applied, false);
assert.equal(stragglerJob.delivery.receipt.kind, "pi-session-entry", "the receipt survives the late result");
// Under the default durable dedupe the straggler never even reaches the transport.
const suppressed = await routeNotification({
  stateDir,
  eventId: raceEventId,
  text: "race re-drain again",
  transport: { name: "never", deliver: async () => { throw new Error("a receipt-bearing event must not be sent again"); } },
});
assert.equal(suppressed.duplicate, true);

// ---------------------------------------------------------------------------
// R3. Crash before the drain: the durable records stay queued, the report stays,
//     and the restart replays the completion to its exact owner only.
// ---------------------------------------------------------------------------
const crashKey = "agent-receipts-crash-before-drain";
const crashState = { name: "offline", deliver: async () => ({ state: "queued", reason: "session-busy" }) };
const crashWorkflow = createWorkflow({
  root,
  sessionKey: crashKey,
  env: sessionEnv(crashKey),
  notifierTransport: crashState,
  spawnFn: runnerSpawner({ response: "CRASH-BEFORE-DRAIN-FINDINGS" }),
});
const crashDispatch = crashWorkflow.dispatchRunner({ task: "queued, then the process dies" });
const crashSettled = await crashWorkflow.awaitRunner({ jobId: crashDispatch.jobId });
const crashJob = readJob(stateDir, crashDispatch.jobId);
const crashEventId = completedEventId(crashJob);
assert.equal(crashJob.delivery.state, "queued");
assert.equal(crashSettled.terminal.reportId, crashJob.terminal.reportId, "the report is durable before anything is notified");

const crashPi = piRuntimeDouble({ idle: true, sessionFile: join(root, "pi-crash.jsonl") });
const crash = buildExtension({ sessionKey: crashKey, pi: crashPi, response: "never used" });
await callHandlers(crashPi, "session_start", { reason: "startup" }, crashPi.ctx);
const crashRecovery = await crash.ticks.flush().then(() => crash.extension.whenReady());
assert.deepEqual(crashRecovery.delivery.replayed.map((entry) => entry.jobId), [crashDispatch.jobId], "a queued event the session never held is replayed");
assert.equal(crashRecovery.delivery.replayed[0].reason, "receipt-absent");
assert.equal(crashRecovery.delivery.replayed[0].previousState, "queued");
assert.equal(crashRecovery.delivery.uncertain.length, 0);
assert.equal(crashRecovery.delivery.deferred.length, 0);
assert.equal(readJob(stateDir, crashDispatch.jobId).delivery.state, "delivered", "the idle replay starts a turn");
assert.equal(readNotification(stateDir, crashEventId).state, "delivered");
assert.equal(crashPi.sent.filter((entry) => entry.kind === "user").length, 1, "the reopened session is woken once");
assert.ok(crashPi.sent.find((entry) => entry.kind === "user").content.includes("CRASH-BEFORE-DRAIN-FINDINGS"));
assert.ok(readReport(stateDir, crashJob.terminal.reportId).text.includes("CRASH-BEFORE-DRAIN-FINDINGS"), "the report survives the crash");
assert.equal(listReports(stateDir).filter((entry) => entry.reportId === crashJob.terminal.reportId).length, 1, "replay never duplicates the report");
const crashAgain = await crashWorkflow.recoverDeliveries({ transport: crash.extension.transport, evidence: crash.extension.sessionEvidence(crashPi.ctx) });
assert.deepEqual(crashAgain.delivery.replayed, [], "a completed replay is not repeated");
assert.equal(crashPi.sent.filter((entry) => entry.kind === "user").length, 1);

// ---------------------------------------------------------------------------
// R4. Crash after pi retained the event but before the receipt update: recovery
//     reconciles the receipt from persisted session evidence instead of sending.
// ---------------------------------------------------------------------------
const reconcileKey = "agent-receipts-crash-after-insert";
const evidencePi = piRuntimeDouble({ idle: false, sessionFile: join(root, "pi-reconcile.jsonl") });
const reconcileState = { name: "offline", deliver: async () => ({ state: "queued", reason: "session-busy" }) };
const reconcileWorkflow = createWorkflow({
  root,
  sessionKey: reconcileKey,
  env: sessionEnv(reconcileKey),
  notifierTransport: reconcileState,
  spawnFn: runnerSpawner({ response: "CRASH-AFTER-INSERT-FINDINGS" }),
});
const reconcileDispatch = reconcileWorkflow.dispatchRunner({ task: "queued and consumed, then the process dies" });
await reconcileWorkflow.awaitRunner({ jobId: reconcileDispatch.jobId });
const reconcileJob = readJob(stateDir, reconcileDispatch.jobId);
const reconcileEventId = completedEventId(reconcileJob);
assert.equal(reconcileJob.delivery.state, "queued", "the receipt was never written");
// pi had already persisted the session entry before the crash: same custom type,
// same details, no extension attached after the restart.
evidencePi.sendMessage(
  { customType: "qq-workflow-completion", content: "completion text", display: true, details: { eventId: reconcileEventId, jobId: reconcileDispatch.jobId, role: reconcileJob.role } },
  { deliverAs: "steer" },
);
await evidencePi.drain();

const reconcile = buildExtension({ sessionKey: reconcileKey, pi: evidencePi, response: "never used" });
await callHandlers(evidencePi, "session_start", { reason: "startup" }, evidencePi.ctx);
const reconciled = await reconcile.ticks.flush().then(() => reconcile.extension.whenReady());
assert.deepEqual(reconciled.delivery.replayed, [], "a retained event is never re-sent");
assert.equal(reconciled.delivery.reconciled.length, 1, "recovery acknowledges the receipt it can prove");
assert.equal(reconciled.delivery.reconciled[0].jobId, reconcileDispatch.jobId);
assert.equal(reconciled.delivery.reconciled[0].entryId, evidencePi.entries.at(-1).id);
assert.equal(readJob(stateDir, reconcileDispatch.jobId).delivery.state, "delivered");
const reconciledRecord = readNotification(stateDir, reconcileEventId);
assert.equal(reconciledRecord.state, "delivered");
assert.equal(reconciledRecord.receipt.kind, "pi-session-entry");
assert.equal(reconciledRecord.receipt.entryId, evidencePi.entries.at(-1).id);
assert.equal(evidencePi.sent.filter((entry) => entry.kind === "user").length, 0, "nothing is woken twice after the crash");
assert.equal(evidencePi.sent.filter((entry) => entry.kind === "message").length, 1, "the only message is the entry that was already persisted");

// A projection that lags the journal is caught up by recovery as well: the
// journal's receipt is the source of truth, and nothing is sent again.
const driftKey = "agent-receipts-drift";
const driftWorkflow = createWorkflow({
  root,
  sessionKey: driftKey,
  env: sessionEnv(driftKey),
  notifierTransport: { name: "offline", deliver: async () => ({ state: "queued", reason: "session-busy" }) },
  spawnFn: runnerSpawner({ response: "DRIFT-FINDINGS" }),
});
const driftDispatch = driftWorkflow.dispatchRunner({ task: "journal ahead of the projection" });
await driftWorkflow.awaitRunner({ jobId: driftDispatch.jobId });
const driftJob = readJob(stateDir, driftDispatch.jobId);
const driftEventId = completedEventId(driftJob);
await acknowledgeDelivery({ stateDir, eventId: driftEventId, jobId: driftDispatch.jobId, receipt: { kind: "pi-session-entry", eventId: driftEventId, entryId: "entry-drift", sessionFile: "drift.jsonl" } });
// Simulate the crash window between the two writes: the journal holds the
// receipt while the projection never received it (the state is rewritten here,
// because a normal write could not regress a receipt).
const deliveredProjection = readJob(stateDir, driftDispatch.jobId);
writeJob(stateDir, {
  ...deliveredProjection,
  delivery: { ...deliveredProjection.delivery, state: "queued", stateAt: deliveredProjection.delivery.queuedAt, deliveredAt: null, receipt: null },
});
assert.equal(readNotification(stateDir, driftEventId).state, "delivered");
assert.equal(readJob(stateDir, driftDispatch.jobId).delivery.state, "queued");
const driftTransport = { name: "idle", delivered: [], async deliver(notification) { this.delivered.push(notification); return { state: "delivered" }; } };
const driftRecovery = await recoverPendingDeliveries({ stateDir, sessionKey: driftKey, transport: driftTransport, evidence: { entries: [], sessionFile: "drift.jsonl", pendingMessages: false } });
assert.equal(driftRecovery.reconciled.length, 1, "recovery converges the projection on the journal");
assert.equal(driftRecovery.reconciled[0].evidence, "journal-receipt");
assert.deepEqual(driftRecovery.replayed, [], "a receipt-bearing journal record is never replayed");
assert.equal(driftTransport.delivered.length, 0, "nothing is sent to catch up a projection");
const driftProjection = readJob(stateDir, driftDispatch.jobId).delivery;
assert.equal(driftProjection.state, "delivered");
assert.equal(driftProjection.receipt.entryId, "entry-drift");

// ---------------------------------------------------------------------------
// R5. Unprovable outcomes are retained, never blindly duplicated; only explicit
//     recovery retries them.
// ---------------------------------------------------------------------------
const legacyKey = "agent-receipts-unprovable";
const legacyWorkflow = createWorkflow({
  root,
  sessionKey: legacyKey,
  env: sessionEnv(legacyKey),
  notifierTransport: { name: "offline", deliver: async () => ({ state: "failed", reason: "session closed" }) },
  spawnFn: runnerSpawner({ response: "LEGACY-FINDINGS" }),
});
const legacyDispatch = legacyWorkflow.dispatchRunner({ task: "queued by an older release" });
await legacyWorkflow.awaitRunner({ jobId: legacyDispatch.jobId });
const legacyJob = readJob(stateDir, legacyDispatch.jobId);
// An older release recorded the queue acceptance without the event identity.
writeJob(stateDir, {
  ...legacyJob,
  delivery: { eventId: null, state: "queued", transport: "pi", attempts: 1, at: 1, queuedAt: 1, acceptedAt: 1, messageId: "legacy-message", reason: "session-busy" },
});
const legacyBefore = readJob(stateDir, legacyDispatch.jobId).delivery;
const idleTransport = { name: "idle", delivered: [], async deliver(notification) { this.delivered.push(notification); return { state: "delivered", messageId: "m-1" }; } };

const blindAutomatic = await recoverPendingDeliveries({ stateDir, sessionKey: legacyKey, transport: idleTransport, evidence: { entries: [], sessionFile: "legacy.jsonl", pendingMessages: false } });
assert.deepEqual(blindAutomatic.replayed, [], "an event without a provable identity is never replayed automatically");
assert.equal(blindAutomatic.uncertain.length, 1);
assert.equal(blindAutomatic.uncertain[0].reason, "missing-event-identity");
assert.equal(blindAutomatic.uncertain[0].previousState, "queued");
assert.equal(idleTransport.delivered.length, 0, "the transport is never even asked");
const uncertainDelivery = readJob(stateDir, legacyDispatch.jobId).delivery;
assert.equal(uncertainDelivery.state, "unknown", "uncertainty is recorded, not guessed away");
assert.equal(uncertainDelivery.eventId, null, "no identity is invented by the unknown marking");
assert.equal(uncertainDelivery.transport, legacyBefore.transport, "acceptance evidence is preserved: transport");
assert.equal(uncertainDelivery.queuedAt, legacyBefore.queuedAt, "acceptance evidence is preserved: queue time");
assert.equal(uncertainDelivery.acceptedAt, legacyBefore.acceptedAt, "acceptance evidence is preserved: acceptance time");
assert.equal(uncertainDelivery.messageId, legacyBefore.messageId, "acceptance evidence is preserved: message id");
assert.equal(uncertainDelivery.attempts, legacyBefore.attempts + 1, "marking the outcome records the attempt without resetting the count");
assert.equal(uncertainDelivery.receipt, null, "an unknown outcome carries no receipt");
assert.equal(deliveryPending(stateDir, legacyDispatch.jobId), true, "an unprovable outcome stays pending for an explicit decision");
assert.ok(readReport(stateDir, legacyJob.terminal.reportId).ok, "the report is retained while the outcome is unknown");

// No evidence source at all: the identity is still missing, so the automatic
// pass still refuses to guess (absence is not proven either).
const noEvidence = await recoverPendingDeliveries({ stateDir, sessionKey: legacyKey, transport: idleTransport });
assert.deepEqual(noEvidence.replayed, []);
assert.equal(noEvidence.uncertain.length, 1);
assert.equal(noEvidence.uncertain[0].reason, "missing-event-identity");
assert.equal(readJob(stateDir, legacyDispatch.jobId).delivery.eventId, null, "identity absence survives a pass with no evidence");

// A LATER automatic pass with readable session evidence and no queued messages
// must not replay it either: the identity is what makes the outcome unprovable,
// and that absence is preserved across passes.
const secondReadable = await recoverPendingDeliveries({ stateDir, sessionKey: legacyKey, transport: idleTransport, evidence: { entries: [], sessionFile: "legacy.jsonl", pendingMessages: false } });
assert.deepEqual(secondReadable.replayed, [], "no later automatic pass can auto-replay an identity-less record");
assert.equal(secondReadable.uncertain.length, 1);
assert.equal(secondReadable.uncertain[0].reason, "missing-event-identity");
assert.equal(idleTransport.delivered.length, 0);
assert.equal(readJob(stateDir, legacyDispatch.jobId).delivery.eventId, null, "no automatic pass invents an identity");
assert.equal(readJob(stateDir, legacyDispatch.jobId).delivery.state, "unknown");
assert.equal(deliveryPending(stateDir, legacyDispatch.jobId), true);

// The live session still holds queued messages: retain, never resend. For an
// identity-less record the identity question is the deeper truth, so it is
// reported as uncertain either way.
const held = await recoverPendingDeliveries({
  stateDir,
  sessionKey: legacyKey,
  transport: idleTransport,
  evidence: { entries: [], sessionFile: "live.jsonl", pendingMessages: true },
});
assert.deepEqual(held.replayed, []);
assert.equal(held.uncertain.length, 1);
assert.equal(held.uncertain[0].reason, "missing-event-identity");
assert.equal(held.deferred.length, 0);
assert.equal(readJob(stateDir, legacyDispatch.jobId).delivery.state, "unknown", "a retained event keeps its uncertain state");

// The explicit operator path retries it (and then records the delivery).
const explicit = await recoverPendingDeliveries({
  stateDir,
  sessionKey: legacyKey,
  transport: idleTransport,
  evidence: { entries: [], sessionFile: "live.jsonl", pendingMessages: true },
  allowUnverified: true,
});
assert.equal(explicit.replayed.length, 1, "explicit recovery is allowed to retry an unprovable event");
assert.equal(explicit.replayed[0].reason, "receipt-absent");
assert.equal(idleTransport.delivered.length, 1);
assert.equal(readJob(stateDir, legacyDispatch.jobId).delivery.state, "delivered");

// Identity-bearing volatile records use the queue signals instead: unrelated
// queued messages defer an automatic pass (explicit recovery may still retry,
// because those messages may be unrelated to this event), while the per-event
// in-flight signal defers even explicit recovery.
const queuedKey = "agent-receipts-queued-signals";
const queuedWorkflow = createWorkflow({
  root,
  sessionKey: queuedKey,
  env: sessionEnv(queuedKey),
  notifierTransport: { name: "offline", deliver: async () => ({ state: "queued", reason: "session-busy" }) },
  spawnFn: runnerSpawner({ response: "QUEUED-SIGNALS-FINDINGS" }),
});
const queuedDispatch = queuedWorkflow.dispatchRunner({ task: "queued behind the operator" });
await queuedWorkflow.awaitRunner({ jobId: queuedDispatch.jobId });
const queuedEventId = completedEventId(readJob(stateDir, queuedDispatch.jobId));
const queuedTransport = { name: "idle", delivered: [], async deliver(notification) { this.delivered.push(notification); return { state: "delivered" }; } };
const queuedEvidence = { entries: [], sessionFile: "queued.jsonl", pendingMessages: true };

const queuedDeferred = await recoverPendingDeliveries({ stateDir, sessionKey: queuedKey, transport: queuedTransport, evidence: queuedEvidence });
assert.deepEqual(queuedDeferred.replayed, [], "queued session messages defer the automatic pass");
assert.equal(queuedDeferred.deferred.length, 1);
assert.equal(queuedDeferred.deferred[0].reason, "pending-in-session");
assert.equal(queuedTransport.delivered.length, 0);
assert.equal(readJob(stateDir, queuedDispatch.jobId).delivery.state, "queued");
assert.equal(readNotification(stateDir, queuedEventId).state, "queued", "the journal stays volatile while deferred");

// Explicit recovery may still decide that those unrelated messages are not this
// event (the /qq_recover contract).
const queuedExplicit = await recoverPendingDeliveries({ stateDir, sessionKey: queuedKey, transport: queuedTransport, evidence: queuedEvidence, allowUnverified: true });
assert.equal(queuedExplicit.replayed.length, 1);
assert.equal(queuedTransport.delivered.length, 1, "the explicit retry is the one delivery for that event");
assert.equal(readJob(stateDir, queuedDispatch.jobId).delivery.state, "delivered");

// The per-event in-flight signal is positive knowledge and defers even explicit
// recovery: this exact completion is still in the live session's queue.
const exactKey = "agent-receipts-exact-inflight";
const exactWorkflow = createWorkflow({
  root,
  sessionKey: exactKey,
  env: sessionEnv(exactKey),
  notifierTransport: { name: "offline", deliver: async () => ({ state: "queued", reason: "session-busy" }) },
  spawnFn: runnerSpawner({ response: "EXACT-INFLIGHT-FINDINGS" }),
});
const exactDispatch = exactWorkflow.dispatchRunner({ task: "exactly in flight" });
await exactWorkflow.awaitRunner({ jobId: exactDispatch.jobId });
const exactEventId = completedEventId(readJob(stateDir, exactDispatch.jobId));
const exactTransport = { name: "idle", delivered: [], async deliver(notification) { this.delivered.push(notification); return { state: "delivered" }; } };
const exactEvidence = { entries: [], sessionFile: "exact.jsonl", pendingMessages: false, inFlight: [exactEventId] };
for (const allowUnverified of [false, true]) {
  const exactPass = await recoverPendingDeliveries({ stateDir, sessionKey: exactKey, transport: exactTransport, evidence: exactEvidence, allowUnverified });
  assert.deepEqual(exactPass.replayed, [], `an in-flight event is never re-sent (allowUnverified=${allowUnverified})`);
  assert.equal(exactPass.deferred.length, 1);
  assert.equal(exactPass.deferred[0].reason, "pending-in-session");
}
assert.equal(exactTransport.delivered.length, 0, "the transport is never asked for an in-flight event");
assert.equal(readJob(stateDir, exactDispatch.jobId).delivery.state, "queued", "an in-flight event keeps its volatile acceptance");
assert.equal(deliveryPending(stateDir, exactDispatch.jobId), true);

// Once the queue claim is gone (the message drained or the run settled), the
// same evidence replays it.
const exactAfter = await recoverPendingDeliveries({ stateDir, sessionKey: exactKey, transport: exactTransport, evidence: { entries: [], sessionFile: "exact.jsonl", pendingMessages: false } });
assert.equal(exactAfter.replayed.length, 1, "without the in-flight claim the event is reconcilable again");
assert.equal(exactAfter.replayed[0].reason, "receipt-absent");
assert.equal(exactTransport.delivered.length, 1, "the deferred event is delivered once the claim is gone");

// Ownership is still checked before anything is sent: an unverified completion
// belonging to another session is reported, never re-routed.
const foreignKey = "agent-receipts-foreign";
const foreignWorkflow = createWorkflow({
  root,
  sessionKey: foreignKey,
  env: sessionEnv(foreignKey),
  notifierTransport: { name: "offline", deliver: async () => ({ state: "queued", reason: "session-busy" }) },
  spawnFn: runnerSpawner({ response: "FOREIGN-FINDINGS" }),
});
const foreignDispatch = foreignWorkflow.dispatchRunner({ task: "another session's work" });
await foreignWorkflow.awaitRunner({ jobId: foreignDispatch.jobId });
const foreignTransport = { name: "idle", delivered: [], async deliver(notification) { this.delivered.push(notification); return { state: "delivered" }; } };
const asOther = await recoverPendingDeliveries({ stateDir, sessionKey: legacyKey, transport: foreignTransport, allowUnverified: true });
assert.ok(asOther.orphaned.some((entry) => entry.jobId === foreignDispatch.jobId && entry.owner === foreignKey));
assert.equal(foreignTransport.delivered.some((notification) => notification.jobId === foreignDispatch.jobId), false, "another session's completion never lands here");
assert.equal(readJob(stateDir, foreignDispatch.jobId).delivery.state, "queued", "a foreign record is not mutated either");

// ---------------------------------------------------------------------------
// R6. The idle branch is unchanged: a turn is started, the record says delivered
//     with the turn-start receipt, and the exact session entry confirms it.
// ---------------------------------------------------------------------------
const idleKey = "agent-receipts-idle";
const idlePi = piRuntimeDouble({ idle: true, sessionFile: join(root, "pi-idle.jsonl") });
const idle = buildExtension({ sessionKey: idleKey, pi: idlePi, response: "IDLE-RECEIPT-FINDINGS" });
await callHandlers(idlePi, "session_start", { reason: "startup" }, idlePi.ctx);
assert.equal(idlePi.ctx.isIdle(), true, "an idle session is woken with a turn");
const idleWorkflow = idle.extension.ensureWorkflow();
const idleDispatch = idleWorkflow.dispatchRunner({ task: "idle wakeup" });
const idleSettled = await idleWorkflow.awaitRunner({ jobId: idleDispatch.jobId });
const idleJob = readJob(stateDir, idleDispatch.jobId);
const idleEventId = completedEventId(idleJob);
assert.equal(idleSettled.delivery.state, "delivered", "an idle session starts a turn");
const idleRecord = readNotification(stateDir, idleEventId);
assert.equal(idleRecord.state, "delivered");
assert.equal(idleRecord.receipt.kind, "turn-started", "the idle receipt names its basis instead of implying consumption");
const wakeText = idlePi.sent.find((entry) => entry.kind === "user").content;
assert.ok(wakeText.includes("IDLE-RECEIPT-FINDINGS"));

// pi appends the wakeup as a regular user message; the receipt is confirmed.
await idlePi.wakeUser(wakeText);
await idle.ticks.flush();
const confirmed = readNotification(stateDir, idleEventId);
assert.equal(confirmed.state, "delivered", "confirmation never changes a delivered state");
assert.equal(confirmed.receipt.kind, "session-user-message");
assert.equal(confirmed.receipt.entryId, idlePi.entries.at(-1).id);
assert.equal(confirmed.acknowledgedAt >= confirmed.deliveryAt, true);
assert.equal(idlePi.sent.filter((entry) => entry.kind === "user").length, 1, "the confirmation never re-wakes the session");
assert.equal(readJob(stateDir, idleDispatch.jobId).delivery.state, "delivered");

// A rejected transport stays retryable and never fakes a receipt.
const failingWorkflow = createWorkflow({
  root,
  sessionKey: idleKey,
  env: sessionEnv(idleKey),
  notifierTransport: { name: "refusing", deliver: async () => ({ state: "failed", reason: "session gone" }) },
  spawnFn: runnerSpawner({ response: "FAILED-TRANSPORT-FINDINGS" }),
});
const failingDispatch = failingWorkflow.dispatchRunner({ task: "transport refuses" });
await failingWorkflow.awaitRunner({ jobId: failingDispatch.jobId });
const failingJob = readJob(stateDir, failingDispatch.jobId);
assert.equal(failingJob.delivery.state, "failed");
assert.equal(failingJob.delivery.receipt, null, "a refusal is never dressed up as a receipt");
assert.equal(deliveryPending(stateDir, failingDispatch.jobId), true);
const retry = await recoverPendingDeliveries({ stateDir, sessionKey: idleKey, transport: idleTransport, evidence: { entries: [], sessionFile: "idle.jsonl", pendingMessages: false } });
assert.equal(retry.replayed.some((entry) => entry.jobId === failingDispatch.jobId), true, "a refused completion is retried");
assert.equal(retry.replayed.find((entry) => entry.jobId === failingDispatch.jobId).reason, "undelivered");
assert.equal(readJob(stateDir, failingDispatch.jobId).delivery.state, "delivered");

// ---------------------------------------------------------------------------
// R7. Concurrent attempts coalesce, and a receipt is never downgraded.
// ---------------------------------------------------------------------------
const raceDir = join(tempDir("qq-receipt-race-"), "state");
const calls = [];
let release;
const gate = new Promise((resolve) => {
  release = resolve;
});
const gatedTransport = {
  name: "gated",
  async deliver() {
    calls.push(1);
    await gate;
    return { state: "queued", reason: "session-busy" };
  },
};
const first = routeNotification({ stateDir: raceDir, eventId: "runner:race:terminal", jobId: "runner-race", role: "runner", text: "race", transport: gatedTransport, persistJob: false });
const second = routeNotification({ stateDir: raceDir, eventId: "runner:race:terminal", jobId: "runner-race", role: "runner", text: "race", transport: gatedTransport, persistJob: false });
assert.equal(calls.length, 1, "a concurrent attempt for the same event coalesces onto one send");
release();
const [attemptA, attemptB] = await Promise.all([first, second]);
assert.equal(attemptA.state, "queued");
assert.equal(attemptB.state, "queued");
assert.equal(attemptB.coalesced, true, "the coalesced caller reports the in-flight outcome");
assert.equal(calls.length, 1);

const receipt = { kind: "pi-session-entry", eventId: "runner:race:terminal", entryId: "entry-9", sessionFile: "s.jsonl", at: 1_000 };
const ack = acknowledgeDelivery({ stateDir: raceDir, eventId: "runner:race:terminal", jobId: "runner-race", receipt, now: 2_000 });
assert.equal(ack.state, "delivered");
assert.equal(ack.acknowledged, true);
assert.equal(ack.delivery.receipt.entryId, "entry-9");
assert.equal(isDuplicate(raceDir, "runner:race:terminal"), true, "only a receipt-bearing delivery is a duplicate");
// Process-scoped dedupe forces the write path: the transport result is produced
// and then suppressed by the receipt (durable dedupe would refuse the send, as
// asserted below).
const lateCalls = [];
const lateTransport = { name: "late", deliver: async (notification) => { lateCalls.push(notification.eventId); return { state: "queued", reason: "straggler" }; } };
const lateQueued = await routeNotification({ stateDir: raceDir, eventId: "runner:race:terminal", text: "race", transport: lateTransport, dedupe: "process" });
assert.equal(lateCalls.length, 1, "the straggler result reached the router");
assert.equal(lateQueued.state, "delivered", "a later queued result cannot overwrite the receipt");
// A failure arriving after a receipt is equally unable to erase it.
const lateFailedEvent = "runner:race-2:terminal";
await routeNotification({ stateDir: raceDir, eventId: lateFailedEvent, text: "race-2", transport: { name: "queued", deliver: async () => ({ state: "queued", reason: "session-busy" }) } });
acknowledgeDelivery({ stateDir: raceDir, eventId: lateFailedEvent, receipt: { kind: "pi-session-entry", eventId: lateFailedEvent, entryId: "entry-10" } });
const lateFailed = await routeNotification({
  stateDir: raceDir,
  eventId: lateFailedEvent,
  text: "race-2",
  transport: { name: "late", deliver: async () => ({ state: "failed", reason: "gone" }) },
  dedupe: "process",
});
assert.equal(lateFailed.state, "delivered", "a later failure cannot erase a receipt either");
assert.equal(readNotification(raceDir, lateFailedEvent).lastResult.applied, false);
const raceRecord = readNotification(raceDir, "runner:race:terminal");
assert.equal(raceRecord.state, "delivered");
assert.equal(raceRecord.receipt.entryId, "entry-9");
assert.equal(raceRecord.lastResult.applied, false);
const duplicateAttempt = await routeNotification({ stateDir: raceDir, eventId: "runner:race:terminal", text: "race", transport: { name: "never", deliver: async () => { throw new Error("a duplicate must not reach the transport"); } } });
assert.equal(duplicateAttempt.duplicate, true);
assert.equal(listNotifications(raceDir).length, 2, "one journal record per event, none invented by a duplicate");

// ---------------------------------------------------------------------------
// R8. In-flight deferral on the real pi shape. A busy completion is steered
//     into the agent's queue, which `hasPendingMessages()` does NOT report (it
//     counts only queued user prompts). The extension supplies the per-event
//     in-flight fact, so recovery defers the queued copy instead of steering a
//     duplicate — on automatic and on explicit recovery alike.
// ---------------------------------------------------------------------------
const inflightKey = "agent-receipts-inflight";
const inflightPi = piRuntimeDouble({ idle: false, sessionFile: join(root, "pi-inflight.jsonl") });
const inflight = buildExtension({ sessionKey: inflightKey, pi: inflightPi, response: "INFLIGHT-FINDINGS" });
await callHandlers(inflightPi, "session_start", { reason: "startup" }, inflightPi.ctx);
const inflightWorkflow = inflight.extension.ensureWorkflow();
const inflightDispatch = inflightWorkflow.dispatchRunner({ task: "still in the queue" });
await inflightWorkflow.awaitRunner({ jobId: inflightDispatch.jobId });
const inflightJob = readJob(stateDir, inflightDispatch.jobId);
const inflightEventId = completedEventId(inflightJob);
assert.equal(inflightJob.delivery.state, "queued");
assert.equal(inflightPi.queue.length, 1, "the custom steer sits in the live agent queue");
assert.equal(inflightPi.ctx.pendingUserMessages, 0, "no user prompt is queued in this scenario");
assert.equal(inflightPi.ctx.hasPendingMessages(), false, "pi's own signal does not report a queued custom steer");

const inflightEvidence = inflight.extension.sessionEvidence(inflightPi.ctx);
assert.equal(inflightEvidence.pendingMessages, false, "the generic flag stays faithful to pi");
assert.deepEqual(inflightEvidence.inFlight, [inflightEventId], "the owning extension supplies the exact in-flight event");
const inflightRecovery = await inflightWorkflow.recoverDeliveries({ transport: inflight.extension.transport, evidence: inflightEvidence });
assert.deepEqual(inflightRecovery.delivery.replayed, [], "a queued completion is not re-steered");
assert.equal(inflightRecovery.delivery.deferred.length, 1);
assert.equal(inflightRecovery.delivery.deferred[0].reason, "pending-in-session");
assert.equal(inflightPi.sent.filter((entry) => entry.kind === "message").length, 1, "still exactly one steer");

// The explicit operator path does not duplicate a positively in-flight event
// either: the queued copy is already on its way.
const inflightExplicit = await inflightWorkflow.recoverDeliveries({ transport: inflight.extension.transport, evidence: inflightEvidence, allowUnverified: true });
assert.deepEqual(inflightExplicit.delivery.replayed, []);
assert.equal(inflightExplicit.delivery.deferred.length, 1);
assert.equal(inflightPi.sent.filter((entry) => entry.kind === "message").length, 1);

// pi drains the queue: the claim is released and the receipt is written.
await inflightPi.drain();
await inflight.ticks.flush();
assert.equal(readJob(stateDir, inflightDispatch.jobId).delivery.state, "delivered");
assert.equal(readJob(stateDir, inflightDispatch.jobId).delivery.receipt.kind, "pi-session-entry");
assert.equal(inflight.extension.sessionEvidence(inflightPi.ctx).inFlight.length, 0, "the drain releases the in-flight claim");
const inflightAfter = await inflightWorkflow.recoverDeliveries({ transport: inflight.extension.transport, evidence: inflight.extension.sessionEvidence(inflightPi.ctx) });
assert.deepEqual(inflightAfter.delivery.replayed, []);
assert.deepEqual(inflightAfter.delivery.deferred, []);

// ---------------------------------------------------------------------------
// R9. `/reload` rebuilds the extension around the SAME live agent and queue, so
//     the in-flight claim has to survive the module re-evaluation: the reload's
//     automatic recovery tick defers the queued copy instead of re-steering it.
// ---------------------------------------------------------------------------
const reloadKey = "agent-receipts-reload";
const reloadPi = piRuntimeDouble({ idle: false, sessionFile: join(root, "pi-reload.jsonl") });
const reloadFirst = buildExtension({ sessionKey: reloadKey, pi: reloadPi, response: "RELOAD-FINDINGS" });
await callHandlers(reloadPi, "session_start", { reason: "startup" }, reloadPi.ctx);
const reloadWorkflow = reloadFirst.extension.ensureWorkflow();
const reloadDispatch = reloadWorkflow.dispatchRunner({ task: "queued across a reload" });
await reloadWorkflow.awaitRunner({ jobId: reloadDispatch.jobId });
const reloadEventId = completedEventId(readJob(stateDir, reloadDispatch.jobId));
assert.equal(reloadPi.queue.length, 1);

// pi invalidates the old extension runner and re-evaluates the module; the pi
// surface (and the agent queue behind it) is the same object.
reloadPi.handlers.clear();
const reloadSecond = buildExtension({ sessionKey: reloadKey, pi: reloadPi, response: "unused" });
await callHandlers(reloadPi, "session_start", { reason: "reload" }, reloadPi.ctx);
const reloadRecovery = await reloadSecond.extension.whenReady();
assert.deepEqual(reloadRecovery.delivery.replayed, [], "the reload tick does not duplicate the queued steer");
assert.equal(reloadRecovery.delivery.deferred.length, 1);
assert.equal(reloadRecovery.delivery.deferred[0].reason, "pending-in-session");
assert.equal(reloadPi.sent.filter((entry) => entry.kind === "message").length, 1, "still exactly one steer after the reload");
await reloadPi.drain();
await reloadSecond.ticks.flush();
assert.equal(readJob(stateDir, reloadDispatch.jobId).delivery.state, "delivered", "the reloaded extension writes the receipt");
assert.equal(readNotification(stateDir, reloadEventId).receipt.entryId, reloadPi.entries.at(-1).id);

// ---------------------------------------------------------------------------
// R10. The in-flight claim is bounded to the run that accepted it. When the run
//      settles without a drain (the operator aborted and pi discarded the
//      queue), the claim expires and recovery reconciles the record again — an
//      abandoned queue can never block the wakeup forever.
// ---------------------------------------------------------------------------
const staleKey = "agent-receipts-stale-inflight";
const stalePi = piRuntimeDouble({ idle: false, sessionFile: join(root, "pi-stale.jsonl") });
const stale = buildExtension({ sessionKey: staleKey, pi: stalePi, response: "STALE-FINDINGS" });
await callHandlers(stalePi, "session_start", { reason: "startup" }, stalePi.ctx);
const staleWorkflow = stale.extension.ensureWorkflow();
const staleDispatch = staleWorkflow.dispatchRunner({ task: "the queue is discarded" });
await staleWorkflow.awaitRunner({ jobId: staleDispatch.jobId });
assert.equal(stalePi.queue.length, 1);
assert.equal(stale.extension.sessionEvidence(stalePi.ctx).inFlight.length, 1);

// The operator aborts: pi discards the queued copy without a drain, and the run
// settles. The claim is bounded to that run, so it expires here.
stalePi.queue.length = 0;
await callHandlers(stalePi, "agent_settled", {}, stalePi.ctx);
assert.equal(stale.extension.sessionEvidence(stalePi.ctx).inFlight.length, 0, "a settled run can no longer hold the event in flight");
const staleRecovery = await staleWorkflow.recoverDeliveries({ transport: stale.extension.transport, evidence: stale.extension.sessionEvidence(stalePi.ctx) });
assert.deepEqual(staleRecovery.delivery.replayed.map((entry) => entry.jobId), [staleDispatch.jobId], "the abandoned queue is reconcilable again");
assert.equal(staleRecovery.delivery.replayed[0].reason, "receipt-absent");
assert.equal(readJob(stateDir, staleDispatch.jobId).delivery.state, "queued", "the replacement steer is honestly volatile");
assert.equal(stalePi.sent.filter((entry) => entry.kind === "message").length, 2, "exactly one replacement copy");
assert.equal(stalePi.queue.length, 1);

// An explicit retry while the replacement looks in flight still changes nothing.
const staleExplicit = await staleWorkflow.recoverDeliveries({ transport: stale.extension.transport, evidence: stale.extension.sessionEvidence(stalePi.ctx), allowUnverified: true });
assert.deepEqual(staleExplicit.delivery.replayed, []);
assert.equal(stalePi.sent.filter((entry) => entry.kind === "message").length, 2);

// ---------------------------------------------------------------------------
// R11. Upgrade from a release that steered completions WITHOUT the identity
//      metadata (the live PR109 shape). The session entry carries the exact
//      completion text and no `details`, while the durable records stayed
//      `queued`. An upgrade must not read "no identified entry" as "never
//      received": the entry is preserved as evidence, an exact unique content
//      correspondence acknowledges it, and anything ambiguous or partial is
//      retained as unknown instead of being replayed.
// ---------------------------------------------------------------------------
const upgradeKey = "agent-receipts-legacy-upgrade";
const upgradeEnv = sessionEnv(upgradeKey);
const legacyTransport = { name: "pi-legacy", deliver: async () => ({ state: "queued", reason: "session-busy" }) };

// job A: the completion was consumed and the records stayed queued.
const upgradeWorkflow = createWorkflow({
  root,
  sessionKey: upgradeKey,
  env: upgradeEnv,
  notifierTransport: legacyTransport,
  spawnFn: runnerSpawner({ response: "LEGACY-CONSUMED-FINDINGS" }),
});
const upgradeDispatch = upgradeWorkflow.dispatchRunner({ task: "consumed by the release that predates the identity metadata" });
await upgradeWorkflow.awaitRunner({ jobId: upgradeDispatch.jobId });
const upgradeJob = readJob(stateDir, upgradeDispatch.jobId);
const upgradeEventId = completedEventId(upgradeJob);
const consumedText = defaultCompletionText(upgradeJob);
assert.equal(upgradeJob.delivery.state, "queued", "the old release left the projection queued");
assert.equal(readNotification(stateDir, upgradeEventId).state, "queued", "and the journal queued");

// same session, restarted with the fixed extension; the session file already
// holds the consumed custom message, exactly as the old release wrote it
// (`customType`, `content`, `display`, and no `details`).
const upgradePi = piRuntimeDouble({ idle: true, sessionFile: join(root, "pi-legacy-upgrade.jsonl") });
upgradePi.entries.push({
  id: "legacy-entry-1",
  parentId: null,
  timestamp: new Date().toISOString(),
  type: "custom_message",
  customType: ARCHITECT_COMPLETION_CUSTOM_TYPE,
  content: consumedText,
  display: true,
});
const upgrade = buildExtension({ sessionKey: upgradeKey, pi: upgradePi });
await callHandlers(upgradePi, "session_start", { reason: "startup" }, upgradePi.ctx);
const upgradeEvidence = upgrade.extension.sessionEvidence(upgradePi.ctx);
assert.equal(upgradeEvidence.unidentified.length, 1, "the identity-less completion is preserved as evidence instead of being discarded");
assert.equal(upgradeEvidence.unidentified[0].entryId, "legacy-entry-1");
assert.equal(upgradeEvidence.unidentified[0].text, consumedText);
assert.equal(upgradeEvidence.unidentified[0].customType, ARCHITECT_COMPLETION_CUSTOM_TYPE);
assert.deepEqual(upgradeEvidence.entries, [], "an entry without identity is never read as an identity-bound receipt");

const upgradeRecovery = await upgrade.ticks.flush().then(() => upgrade.extension.whenReady());
assert.deepEqual(upgradeRecovery.delivery.replayed, [], "a completion the session retained is never replayed after an upgrade");
assert.equal(upgradeRecovery.delivery.uncertain.length, 0);
const upgradeReconcile = upgradeRecovery.delivery.reconciled[0];
assert.equal(upgradeReconcile.jobId, upgradeDispatch.jobId);
assert.equal(upgradeReconcile.evidence, "legacy-content-correspondence");
assert.equal(upgradeReconcile.entryId, "legacy-entry-1");
assert.equal(upgradePi.sent.length, 0, "the operator is not woken again for a completion they already saw");
const upgradeDelivery = readJob(stateDir, upgradeDispatch.jobId).delivery;
assert.equal(upgradeDelivery.state, "delivered");
assert.equal(upgradeDelivery.receipt.kind, "session-entry-content-correspondence");
assert.equal(upgradeDelivery.receipt.entryId, "legacy-entry-1");
assert.equal(upgradeDelivery.receipt.copies, 1, "the correspondence records that exactly one copy matched");
assert.equal(upgradeDelivery.receipt.textChars, consumedText.length);
assert.equal(upgradeDelivery.queuedAt, upgradeJob.delivery.queuedAt, "the queue acceptance the old release recorded is preserved through the receipt");
assert.equal(upgradeDelivery.deliveredAt >= upgradeDelivery.queuedAt, true, "the acknowledgement is not backdated to the acceptance");
const upgradeRecord = readNotification(stateDir, upgradeEventId);
assert.equal(upgradeRecord.state, "delivered");
assert.equal(upgradeRecord.receipt.entryId, "legacy-entry-1");
assert.equal(upgradeRecord.seq, 2, "the acceptance and the receipt are both recorded");
// The acknowledgement is idempotent and never re-sent.
const upgradeAgain = await upgradeWorkflow.recoverDeliveries({ transport: upgrade.extension.transport, evidence: upgradeEvidence });
assert.deepEqual(upgradeAgain.delivery.replayed, []);
assert.deepEqual(upgradeAgain.delivery.reconciled, []);
assert.equal(upgradePi.sent.length, 0);

// The same evidence reaches the reader in the raw session-entry shape when a
// caller hands over the session's entries directly: it is read the same way, so
// no caller can turn a retained completion back into "provably never received".
const rawShapeWorkflow = createWorkflow({
  root,
  sessionKey: upgradeKey,
  env: upgradeEnv,
  notifierTransport: legacyTransport,
  spawnFn: runnerSpawner({ response: "LEGACY-RAW-SHAPE-FINDINGS" }),
});
const rawShapeDispatch = rawShapeWorkflow.dispatchRunner({ task: "consumed, reported in the raw entry shape" });
await rawShapeWorkflow.awaitRunner({ jobId: rawShapeDispatch.jobId });
const rawShapeJob = readJob(stateDir, rawShapeDispatch.jobId);
const rawShapeText = defaultCompletionText(rawShapeJob);
const rawShapeTransport = { name: "idle", delivered: [], async deliver(notification) { this.delivered.push(notification.eventId); return { state: "delivered" }; } };
const rawShapeRecovery = await rawShapeWorkflow.recoverDeliveries({
  transport: rawShapeTransport,
  evidence: {
    entries: [{
      id: "raw-legacy-entry",
      type: "custom_message",
      customType: ARCHITECT_COMPLETION_CUSTOM_TYPE,
      content: rawShapeText,
      display: true,
      timestamp: new Date().toISOString(),
    }, {
      id: "raw-user-entry",
      type: "message",
      message: { role: "user", content: [{ type: "text", text: rawShapeText }] },
      timestamp: new Date().toISOString(),
    }],
    sessionFile: "pi-legacy-upgrade.jsonl",
    pendingMessages: false,
  },
});
assert.deepEqual(rawShapeRecovery.delivery.replayed, [], "a raw completion entry is retention, not absence");
assert.equal(rawShapeRecovery.delivery.reconciled.length, 1);
assert.equal(rawShapeRecovery.delivery.reconciled[0].evidence, "legacy-content-correspondence");
assert.equal(readJob(stateDir, rawShapeDispatch.jobId).delivery.state, "delivered");
assert.equal(readNotification(stateDir, completedEventId(rawShapeJob)).receipt.copies, 1, "a user message is not completion evidence");
assert.equal(rawShapeTransport.delivered.length, 0);

// job B: the same completion was retained twice (the old release replayed its own
// copy). Identical copies of one text are copies of ONE event, not two identities.
const copiesWorkflow = createWorkflow({
  root,
  sessionKey: upgradeKey,
  env: upgradeEnv,
  notifierTransport: legacyTransport,
  spawnFn: runnerSpawner({ response: "LEGACY-DUPLICATE-FINDINGS" }),
});
const copiesDispatch = copiesWorkflow.dispatchRunner({ task: "retained twice by the old release" });
await copiesWorkflow.awaitRunner({ jobId: copiesDispatch.jobId });
const copiesJob = readJob(stateDir, copiesDispatch.jobId);
const copiesEventId = completedEventId(copiesJob);
const copiesText = defaultCompletionText(copiesJob);
const copiesEvidence = {
  entries: [],
  unidentified: [
    { entryId: "legacy-copy-1", at: 1, text: copiesText, customType: ARCHITECT_COMPLETION_CUSTOM_TYPE },
    { entryId: "legacy-copy-2", at: 2, text: copiesText, customType: ARCHITECT_COMPLETION_CUSTOM_TYPE },
  ],
  sessionFile: "pi-legacy-upgrade.jsonl",
  pendingMessages: false,
};
const copiesTransport = { name: "idle", delivered: [], async deliver(notification) { this.delivered.push(notification.eventId); return { state: "delivered" }; } };
const copiesRecovery = await copiesWorkflow.recoverDeliveries({ transport: copiesTransport, evidence: copiesEvidence });
assert.deepEqual(copiesRecovery.delivery.replayed, [], "identical copies never cause a replay");
assert.equal(copiesRecovery.delivery.reconciled.length, 1);
assert.equal(readJob(stateDir, copiesDispatch.jobId).delivery.receipt.copies, 2, "the copies are recorded as evidence");
assert.equal(copiesTransport.delivered.length, 0, "the transport is never asked");

// job C: only a partial (truncated) copy of the completion text is in the
// session. The entry proves a completion was retained but not which one, so the
// event is retained as unknown: never acknowledged, never replayed.
const partialWorkflow = createWorkflow({
  root,
  sessionKey: upgradeKey,
  env: upgradeEnv,
  notifierTransport: legacyTransport,
  spawnFn: runnerSpawner({ response: "LEGACY-PARTIAL-FINDINGS" }),
});
const partialDispatch = partialWorkflow.dispatchRunner({ task: "partially retained by the old release" });
await partialWorkflow.awaitRunner({ jobId: partialDispatch.jobId });
const partialJob = readJob(stateDir, partialDispatch.jobId);
const partialEventId = completedEventId(partialJob);
const partialText = defaultCompletionText(partialJob);
const partialEvidence = {
  entries: [],
  unidentified: [{ entryId: "legacy-partial", at: 3, text: partialText.slice(0, 14), customType: ARCHITECT_COMPLETION_CUSTOM_TYPE }],
  sessionFile: "pi-legacy-upgrade.jsonl",
  pendingMessages: false,
};
const partialTransport = { name: "idle", delivered: [], async deliver(notification) { this.delivered.push(notification.eventId); return { state: "delivered" }; } };
const partialRecovery = await partialWorkflow.recoverDeliveries({ transport: partialTransport, evidence: partialEvidence });
assert.deepEqual(partialRecovery.delivery.replayed, [], "a partial copy is not proof of absence and must not be replayed");
assert.equal(partialRecovery.delivery.reconciled.length, 0, "and it is not proof of retention either");
assert.equal(partialRecovery.delivery.uncertain.length, 1);
assert.equal(partialRecovery.delivery.uncertain[0].reason, "legacy-completion-identity-unconfirmed");
assert.equal(partialTransport.delivered.length, 0);
assert.equal(readJob(stateDir, partialDispatch.jobId).delivery.state, "unknown", "the unprovable outcome is recorded, not guessed away");
assert.equal(deliveryPending(stateDir, partialDispatch.jobId), true);
assert.ok(readReport(stateDir, partialJob.terminal.reportId).text.includes("LEGACY-PARTIAL-FINDINGS"), "the report is retained while the identity is unprovable");
// A later automatic pass with the same partial evidence is just as conservative.
const partialAgain = await partialWorkflow.recoverDeliveries({ transport: partialTransport, evidence: partialEvidence });
assert.deepEqual(partialAgain.delivery.replayed, []);
assert.equal(partialTransport.delivered.length, 0, "no automatic pass can turn a partial copy into a resend");
// The explicit operator path is the one decision that may retry it.
const partialExplicit = await partialWorkflow.recoverDeliveries({ transport: partialTransport, evidence: partialEvidence, allowUnverified: true });
assert.equal(partialExplicit.delivery.replayed.length, 1, "explicit recovery retries an unprovable completion on the operator's decision");
assert.equal(partialTransport.delivered.length, 1);

// job D: an exact match that belongs to ANOTHER session is never acknowledged
// here, because ownership is decided before any evidence is read.
const foreignLegacyWorkflow = createWorkflow({
  root,
  sessionKey: "agent-receipts-legacy-foreign",
  env: sessionEnv("agent-receipts-legacy-foreign"),
  notifierTransport: legacyTransport,
  spawnFn: runnerSpawner({ response: "LEGACY-FOREIGN-FINDINGS" }),
});
const foreignLegacyDispatch = foreignLegacyWorkflow.dispatchRunner({ task: "another agent's retained completion" });
await foreignLegacyWorkflow.awaitRunner({ jobId: foreignLegacyDispatch.jobId });
const foreignLegacyJob = readJob(stateDir, foreignLegacyDispatch.jobId);
const foreignLegacyEventId = completedEventId(foreignLegacyJob);
const legacyForeignTransport = { name: "idle", delivered: [], async deliver(notification) { this.delivered.push(notification.eventId); return { state: "delivered" }; } };
const asUpgrade = await upgradeWorkflow.recoverDeliveries({
  transport: legacyForeignTransport,
  evidence: {
    entries: [],
    unidentified: [{ entryId: "foreign-copy", at: 4, text: defaultCompletionText(foreignLegacyJob), customType: ARCHITECT_COMPLETION_CUSTOM_TYPE }],
    sessionFile: "pi-legacy-upgrade.jsonl",
    pendingMessages: false,
  },
});
assert.ok(asUpgrade.delivery.orphaned.some((entry) => entry.jobId === foreignLegacyDispatch.jobId), "another session's retained completion is reported as orphaned");
assert.equal(asUpgrade.delivery.reconciled.length, 0, "an exact match in the wrong session acknowledges nothing");
assert.equal(readJob(stateDir, foreignLegacyDispatch.jobId).delivery.state, "queued");
assert.equal(readNotification(stateDir, foreignLegacyEventId).state, "queued");
assert.equal(legacyForeignTransport.delivered.length, 0);

// The evidence sample above is only a proof for the text it reproduces: an
// unrelated legacy completion leaves the event's absence standing, so a
// genuinely lost busy notification is still replayed after the upgrade.
const lostWorkflow = createWorkflow({
  root,
  sessionKey: upgradeKey,
  env: upgradeEnv,
  notifierTransport: legacyTransport,
  spawnFn: runnerSpawner({ response: "LEGACY-LOST-FINDINGS" }),
});
const lostDispatch = lostWorkflow.dispatchRunner({ task: "never reached the session" });
await lostWorkflow.awaitRunner({ jobId: lostDispatch.jobId });
const lostTransport = { name: "idle", delivered: [], async deliver(notification) { this.delivered.push(notification.eventId); return { state: "delivered" }; } };
const lostRecovery = await lostWorkflow.recoverDeliveries({
  transport: lostTransport,
  evidence: {
    entries: [],
    unidentified: [{ entryId: "legacy-other", at: 5, text: "runner some-other-job completed: unrelated result", customType: ARCHITECT_COMPLETION_CUSTOM_TYPE }],
    sessionFile: "pi-legacy-upgrade.jsonl",
    pendingMessages: false,
  },
});
assert.deepEqual(lostRecovery.delivery.replayed.map((entry) => entry.jobId), [lostDispatch.jobId], "an unrelated legacy completion is not mistaken for this event");
assert.deepEqual(lostRecovery.delivery.uncertain, []);
assert.equal(lostTransport.delivered.length, 1);

// ---------------------------------------------------------------------------
// R12. Journal integrity: a receipt is only ever reported as reconciled when
//      BOTH durable writes landed. A missing record is reconstructed from the
//      owner-bound projection, a corrupt record is preserved before it is
//      replaced, and a record that cannot be written (or read) is an error —
//      never a reported success and never a reason to send again.
// ---------------------------------------------------------------------------
const integrityKey = "agent-receipts-journal-integrity";
const integrityEnv = sessionEnv(integrityKey);

async function seedQueuedJob(id, response) {
  const wf = createWorkflow({
    root,
    sessionKey: integrityKey,
    env: integrityEnv,
    notifierTransport: legacyTransport,
    spawnFn: runnerSpawner({ response }),
  });
  const dispatch = wf.dispatchRunner({ task: `queued seed for ${id}` });
  await wf.awaitRunner({ jobId: dispatch.jobId });
  return { wf, dispatch, job: readJob(stateDir, dispatch.jobId) };
}

// (a) The journal record is gone, but the owning session retained the event: the
//     receipt is persisted by repairing the record from the projection, and the
//     projection converges in the same pass.
const repairSeed = await seedQueuedJob("repair", "JOURNAL-REPAIR-FINDINGS");
const repairEventId = completedEventId(repairSeed.job);
rmSync(notificationPath(stateDir, repairEventId), { force: true });
assert.equal(readNotificationState(stateDir, repairEventId).status, "missing");
const repairTransport = { name: "idle", delivered: [], async deliver(notification) { this.delivered.push(notification.eventId); return { state: "delivered" }; } };
const repairEvidence = { entries: [{ eventId: repairEventId, entryId: "entry-repair", at: 10 }], sessionFile: "pi-integrity.jsonl", pendingMessages: false };
const repairRecovery = await recoverPendingDeliveries({ stateDir, sessionKey: integrityKey, transport: repairTransport, now: 20_000, evidence: repairEvidence });
assert.deepEqual(repairRecovery.errors, []);
assert.equal(repairRecovery.reconciled.length, 1);
assert.equal(repairRecovery.reconciled[0].repaired, true, "the reconciliation reports that it had to rebuild the record");
assert.equal(repairRecovery.reconciled[0].entryId, "entry-repair");
assert.equal(repairTransport.delivered.length, 0, "a retained event is never re-sent to repair a record");
const repairedRecord = readNotification(stateDir, repairEventId);
assert.equal(repairedRecord.state, "delivered");
assert.equal(repairedRecord.receipt.entryId, "entry-repair");
assert.equal(repairedRecord.jobId, repairSeed.job.id, "the rebuilt record names the job the projection proves");
assert.equal(repairedRecord.reportId, repairSeed.job.terminal.reportId, "and the retained report");
assert.equal(readJob(stateDir, repairSeed.job.id).delivery.state, "delivered");
assert.equal(repairedRecord.repair.source, "job-projection");
// The repair closes the window for good: nothing is replayed or rewritten again.
const repairConverged = await recoverPendingDeliveries({ stateDir, sessionKey: integrityKey, transport: repairTransport, now: 20_010, evidence: repairEvidence });
assert.deepEqual(repairConverged.reconciled, []);
assert.deepEqual(repairConverged.replayed, []);
assert.deepEqual(repairConverged.errors, []);
assert.equal(readNotification(stateDir, repairEventId).seq, repairedRecord.seq, "a converged record is left untouched");
assert.equal(repairTransport.delivered.length, 0);

// (b) The record exists but cannot be parsed: the bytes are preserved (never
//     silently overwritten), the receipt is recorded in the rebuilt record, and
//     the preserved bytes stay available as evidence.
const corruptSeed = await seedQueuedJob("corrupt", "JOURNAL-CORRUPT-FINDINGS");
const corruptEventId = completedEventId(corruptSeed.job);
writeFileSync(notificationPath(stateDir, corruptEventId), '{"schema":1,"state":"queued","trunc', "utf8");
assert.equal(readNotificationState(stateDir, corruptEventId).status, "corrupt");
const corruptEvidence = { entries: [{ eventId: corruptEventId, entryId: "entry-corrupt-run", at: 11 }], sessionFile: "pi-integrity.jsonl", pendingMessages: false };
const corruptRecovery = await recoverPendingDeliveries({ stateDir, sessionKey: integrityKey, transport: repairTransport, now: 20_020, evidence: corruptEvidence });
assert.deepEqual(corruptRecovery.errors, []);
assert.equal(corruptRecovery.reconciled.length, 1);
assert.equal(corruptRecovery.reconciled[0].repaired, true);
assert.ok(corruptRecovery.reconciled[0].quarantined, "the unreadable record is named in the reconciliation");
assert.equal(readFileSync(join(stateDir, "notifications", corruptRecovery.reconciled[0].quarantined), "utf8"), '{"schema":1,"state":"queued","trunc', "the corrupt bytes are preserved verbatim");
assert.equal(readNotification(stateDir, corruptEventId).state, "delivered");
assert.equal(readNotification(stateDir, corruptEventId).repair.previous, "corrupt");
assert.equal(readJob(stateDir, corruptSeed.job.id).delivery.state, "delivered");
assert.equal(repairTransport.delivered.length, 0);

// (c) The record is missing and cannot be written. The receipt is NOT reported as
//     reconciled, nothing is sent, the projection stays exactly where it was, and
//     the same pass succeeds once the journal can be written (convergence).
const blockedKey = "agent-receipts-journal-blocked";
const blockedEnv = sessionEnv(blockedKey);
const blockedWorkflow = createWorkflow({
  root,
  sessionKey: blockedKey,
  env: blockedEnv,
  notifierTransport: legacyTransport,
  spawnFn: runnerSpawner({ response: "JOURNAL-BLOCKED-FINDINGS" }),
});
const blockedDispatch = blockedWorkflow.dispatchRunner({ task: "queued while the journal cannot be written" });
await blockedWorkflow.awaitRunner({ jobId: blockedDispatch.jobId });
const blockedJob = readJob(stateDir, blockedDispatch.jobId);
const blockedEventId2 = completedEventId(blockedJob);
rmSync(notificationPath(stateDir, blockedEventId2), { force: true });
// A dangling directory entry: reads report "nothing written", writes fail.
const blockedPath = notificationsDir(stateDir);
const blockedDirContents = readdirSync(blockedPath).filter((name) => name.startsWith("runner_journal-blocked"));
for (const name of blockedDirContents) rmSync(join(blockedPath, name), { force: true });
rmSync(blockedPath, { recursive: true, force: true });
symlinkSync(join(stateDir, "notifications-nowhere"), blockedPath);
const blockedTransport = { name: "idle", delivered: [], async deliver(notification) { this.delivered.push(notification.eventId); return { state: "delivered" }; } };
const blockedEvidence = { entries: [{ eventId: blockedEventId2, entryId: "entry-blocked", at: 12 }], sessionFile: "pi-integrity.jsonl", pendingMessages: false };
const blockedRecovery = await recoverPendingDeliveries({ stateDir, sessionKey: blockedKey, transport: blockedTransport, now: 20_030, evidence: blockedEvidence });
assert.deepEqual(blockedRecovery.reconciled, [], "a receipt that could not be persisted is never reported as reconciled");
assert.equal(blockedRecovery.errors.length, 1);
assert.equal(blockedRecovery.errors[0].reason, "notification-write-failed");
assert.equal(blockedRecovery.errors[0].jobId, blockedDispatch.jobId);
assert.equal(blockedTransport.delivered.length, 0, "a persistence failure never turns into a resend");
assert.equal(readJob(stateDir, blockedDispatch.jobId).delivery.state, "queued", "the projection keeps the truth: the notification is still undelivered");
assert.equal(deliveryPending(stateDir, blockedDispatch.jobId), true);
// The obstruction is removed: the very same evidence now converges.
rmSync(blockedPath, { force: true });
mkdirSync(blockedPath, { recursive: true });
const convergedRecovery = await recoverPendingDeliveries({ stateDir, sessionKey: blockedKey, transport: blockedTransport, now: 20_040, evidence: blockedEvidence });
assert.deepEqual(convergedRecovery.errors, []);
assert.equal(convergedRecovery.reconciled.length, 1, "the reconciliation converges once the record can be written");
assert.equal(convergedRecovery.reconciled[0].repaired, true);
assert.equal(readNotification(stateDir, blockedEventId2).state, "delivered");
assert.equal(readJob(stateDir, blockedDispatch.jobId).delivery.state, "delivered");
assert.equal(blockedTransport.delivered.length, 0);

// (d) The record cannot even be read (a filesystem object is in the way). A
//     replay would overwrite bytes that cannot be preserved, so it is refused
//     and reported; the projection stays pending for a later pass.
const unreadableKey = "agent-receipts-journal-unreadable";
const unreadableEnv = sessionEnv(unreadableKey);
const unreadableWorkflow = createWorkflow({
  root,
  sessionKey: unreadableKey,
  env: unreadableEnv,
  notifierTransport: legacyTransport,
  spawnFn: runnerSpawner({ response: "JOURNAL-UNREADABLE-FINDINGS" }),
});
const unreadableDispatch = unreadableWorkflow.dispatchRunner({ task: "queued while the journal is unreadable" });
await unreadableWorkflow.awaitRunner({ jobId: unreadableDispatch.jobId });
const unreadableJob = readJob(stateDir, unreadableDispatch.jobId);
const unreadableEventId = completedEventId(unreadableJob);
rmSync(notificationPath(stateDir, unreadableEventId), { force: true });
mkdirSync(notificationPath(stateDir, unreadableEventId), { recursive: true });
assert.equal(readNotificationState(stateDir, unreadableEventId).status, "unreadable");
const unreadableTransport = { name: "idle", delivered: [], async deliver(notification) { this.delivered.push(notification.eventId); return { state: "delivered" }; } };
const unreadableRecovery = await recoverPendingDeliveries({
  stateDir,
  sessionKey: unreadableKey,
  transport: unreadableTransport,
  now: 20_050,
  evidence: { entries: [], sessionFile: "pi-integrity.jsonl", pendingMessages: false },
});
assert.deepEqual(unreadableRecovery.replayed, [], "an unreadable record is never overwritten by a replay");
assert.equal(unreadableRecovery.errors.length, 1);
assert.equal(unreadableRecovery.errors[0].reason, "notification-record-unreadable");
assert.equal(unreadableTransport.delivered.length, 0);
assert.equal(existsSync(notificationPath(stateDir, unreadableEventId)), true, "the unreadable record is left in place");
assert.equal(readJob(stateDir, unreadableDispatch.jobId).delivery.state, "queued", "nothing is claimed about an outcome whose record cannot be read");

// (g) A corrupt record whose bytes cannot be preserved is never overwritten by
//     the replay that would replace it: recovery refuses and reports the failure.
const preserveSeed = await seedQueuedJob("preserve-failure", "JOURNAL-PRESERVE-FINDINGS");
const preserveEventId = completedEventId(preserveSeed.job);
writeFileSync(notificationPath(stateDir, preserveEventId), '{"schema":1,"state":"que', "utf8");
// Learn the quarantine path from the preserve step itself, then occupy it.
const learnQuarantine = preserveCorruptNotification(stateDir, preserveEventId, { raw: '{"schema":1,"state":"que', now: 20_100 });
assert.equal(learnQuarantine.ok, true);
rmSync(join(stateDir, "notifications", learnQuarantine.quarantined), { force: true });
mkdirSync(join(stateDir, "notifications", learnQuarantine.quarantined), { recursive: true });
const preserveTransport = { name: "idle", delivered: [], async deliver(notification) { this.delivered.push(notification.eventId); return { state: "delivered" }; } };
const preserveRecovery = await recoverPendingDeliveries({
  stateDir,
  sessionKey: integrityKey,
  transport: preserveTransport,
  now: 20_100,
  evidence: { entries: [], sessionFile: "pi-integrity.jsonl", pendingMessages: false },
});
assert.deepEqual(preserveRecovery.replayed, [], "a replay is refused when the bytes it would overwrite cannot be preserved");
assert.equal(preserveRecovery.errors.length, 1);
assert.equal(preserveRecovery.errors[0].reason, "corrupt-evidence-preserve-failed");
assert.equal(preserveTransport.delivered.length, 0);
assert.equal(readFileSync(notificationPath(stateDir, preserveEventId), "utf8"), '{"schema":1,"state":"que', "the unreadable record is left exactly as it was");
assert.equal(readJob(stateDir, preserveSeed.job.id).delivery.state, "queued", "and the projection keeps the truth: still undelivered");
// Once the quarantine path is free again, the same pass preserves and replays.
rmSync(join(stateDir, "notifications", learnQuarantine.quarantined), { recursive: true, force: true });
const preserveRecovered = await recoverPendingDeliveries({
  stateDir,
  sessionKey: integrityKey,
  transport: preserveTransport,
  now: 20_100,
  evidence: { entries: [], sessionFile: "pi-integrity.jsonl", pendingMessages: false },
});
assert.deepEqual(preserveRecovered.errors, []);
assert.equal(preserveRecovered.replayed.length, 1, "the completion still reaches its owner once the evidence can be preserved");
assert.equal(preserveTransport.delivered.length, 1);
assert.equal(readFileSync(join(stateDir, "notifications", learnQuarantine.quarantined), "utf8"), '{"schema":1,"state":"que', "and the preserved bytes are the evidence");

// (e) The record exists and is readable, but the receipt cannot be written into
//     it (the atomic write's scratch path is occupied). Recovery must report the
//     failure instead of a reconciliation, send nothing, leave the projection
//     queued, and converge once the write can land.
const failingWriteSeed = await seedQueuedJob("failing-write", "JOURNAL-FAILING-WRITE-FINDINGS");
const failingWriteEventId = completedEventId(failingWriteSeed.job);
assert.equal(readNotification(stateDir, failingWriteEventId).state, "queued");
mkdirSync(`${notificationPath(stateDir, failingWriteEventId)}.tmp-${process.pid}`, { recursive: true });
const failingWriteTransport = { name: "idle", delivered: [], async deliver(notification) { this.delivered.push(notification.eventId); return { state: "delivered" }; } };
const failingWriteEvidence = { entries: [{ eventId: failingWriteEventId, entryId: "entry-failing", at: 13 }], sessionFile: "pi-integrity.jsonl", pendingMessages: false };
const failingWriteRecovery = await recoverPendingDeliveries({ stateDir, sessionKey: integrityKey, transport: failingWriteTransport, now: 20_060, evidence: failingWriteEvidence });
assert.deepEqual(failingWriteRecovery.reconciled, [], "a receipt that could not be persisted is never reported as reconciled");
assert.equal(failingWriteRecovery.errors.length, 1);
assert.equal(failingWriteRecovery.errors[0].reason, "notification-write-failed");
assert.equal(failingWriteRecovery.errors[0].jobId, failingWriteSeed.job.id);
assert.equal(failingWriteTransport.delivered.length, 0, "a write failure is never answered with a resend");
assert.equal(readNotification(stateDir, failingWriteEventId).state, "queued");
assert.equal(readJob(stateDir, failingWriteSeed.job.id).delivery.state, "queued");
rmSync(`${notificationPath(stateDir, failingWriteEventId)}.tmp-${process.pid}`, { recursive: true, force: true });
const failingWriteConverged = await recoverPendingDeliveries({ stateDir, sessionKey: integrityKey, transport: failingWriteTransport, now: 20_070, evidence: failingWriteEvidence });
assert.deepEqual(failingWriteConverged.errors, []);
assert.equal(failingWriteConverged.reconciled.length, 1, "the same evidence converges once the record can be written");
assert.equal(readNotification(stateDir, failingWriteEventId).state, "delivered");
assert.equal(readJob(stateDir, failingWriteSeed.job.id).delivery.state, "delivered");
assert.equal(failingWriteTransport.delivered.length, 0);

// (f) The receipt lands in the journal but the projection cannot be written. The
//     reconciliation is reported as an error (the two records do not agree), and
//     the next pass converges the projection from the journal receipt.
const projectionSeed = await seedQueuedJob("projection-write", "JOURNAL-PROJECTION-FINDINGS");
const projectionEventId = completedEventId(projectionSeed.job);
const projectionTransport = { name: "idle", delivered: [], async deliver(notification) { this.delivered.push(notification.eventId); return { state: "delivered" }; } };
const projectionEvidence = { entries: [{ eventId: projectionEventId, entryId: "entry-projection", at: 14 }], sessionFile: "pi-integrity.jsonl", pendingMessages: false };
mkdirSync(`${jobPath(stateDir, projectionSeed.job.id)}.tmp-${process.pid}`, { recursive: true });
const projectionRecovery = await recoverPendingDeliveries({ stateDir, sessionKey: integrityKey, transport: projectionTransport, now: 20_080, evidence: projectionEvidence });
assert.deepEqual(projectionRecovery.reconciled, [], "a reconciliation whose projection write failed is never reported as one");
assert.equal(projectionRecovery.errors.length, 1);
assert.equal(projectionRecovery.errors[0].reason, "projection-write-failed");
assert.equal(projectionRecovery.errors[0].jobId, projectionSeed.job.id);
assert.equal(readNotification(stateDir, projectionEventId).state, "delivered", "the journal receipt is durable");
assert.equal(readJob(stateDir, projectionSeed.job.id).delivery.state, "queued", "and the lagging projection is the reported failure");
assert.equal(projectionTransport.delivered.length, 0, "no record that disagrees is answered with a resend");
rmSync(`${jobPath(stateDir, projectionSeed.job.id)}.tmp-${process.pid}`, { recursive: true, force: true });
// No session evidence this time: the durable receipt in the journal is what
// converges the lagging projection.
const projectionConverged = await recoverPendingDeliveries({
  stateDir,
  sessionKey: integrityKey,
  transport: projectionTransport,
  now: 20_090,
  evidence: { entries: [], sessionFile: "pi-integrity.jsonl", pendingMessages: false },
});
assert.deepEqual(projectionConverged.errors, []);
assert.equal(projectionConverged.reconciled.length, 1, "the projection converges on the journal receipt");
assert.equal(projectionConverged.reconciled[0].evidence, "journal-receipt");
assert.equal(projectionConverged.reconciled[0].entryId, "entry-projection");
assert.equal(readJob(stateDir, projectionSeed.job.id).delivery.state, "delivered");
assert.equal(projectionTransport.delivered.length, 0);

// The extension path has to honour the same rule: a busy completion whose session
// entry exists while the journal record was lost is reconciled at startup, never
// replayed into the session.
const lostJournalKey = "agent-receipts-lost-journal";
const lostJournalEnv = sessionEnv(lostJournalKey);
const lostJournalWorkflow = createWorkflow({
  root,
  sessionKey: lostJournalKey,
  env: lostJournalEnv,
  notifierTransport: legacyTransport,
  spawnFn: runnerSpawner({ response: "LOST-JOURNAL-FINDINGS" }),
});
const lostJournalDispatch = lostJournalWorkflow.dispatchRunner({ task: "consumed, then the record was lost" });
await lostJournalWorkflow.awaitRunner({ jobId: lostJournalDispatch.jobId });
const lostJournalJob = readJob(stateDir, lostJournalDispatch.jobId);
const lostJournalEventId = completedEventId(lostJournalJob);
rmSync(notificationPath(stateDir, lostJournalEventId), { force: true });
const lostJournalPi = piRuntimeDouble({ idle: true, sessionFile: join(root, "pi-lost-journal.jsonl") });
lostJournalPi.entries.push({
  id: "lost-journal-entry",
  parentId: null,
  timestamp: new Date().toISOString(),
  type: "custom_message",
  customType: ARCHITECT_COMPLETION_CUSTOM_TYPE,
  content: "an unrelated completion",
  display: true,
});
lostJournalPi.entries.push({
  id: "lost-journal-entry-2",
  parentId: "lost-journal-entry",
  timestamp: new Date().toISOString(),
  type: "custom_message",
  customType: ARCHITECT_COMPLETION_CUSTOM_TYPE,
  content: defaultCompletionText(lostJournalJob),
  display: true,
});
const lostJournal = buildExtension({ sessionKey: lostJournalKey, pi: lostJournalPi });
await callHandlers(lostJournalPi, "session_start", { reason: "startup" }, lostJournalPi.ctx);
const lostJournalRecovery = await lostJournal.ticks.flush().then(() => lostJournal.extension.whenReady());
assert.deepEqual(lostJournalRecovery.delivery.replayed, [], "a retained completion is not replayed when its record was lost");
assert.deepEqual(lostJournalRecovery.delivery.errors, []);
assert.equal(lostJournalRecovery.delivery.reconciled.length, 1);
assert.equal(lostJournalRecovery.delivery.reconciled[0].repaired, true);
assert.equal(readNotification(stateDir, lostJournalEventId).state, "delivered");
assert.equal(readNotification(stateDir, lostJournalEventId).receipt.entryId, "lost-journal-entry-2");
assert.equal(readJob(stateDir, lostJournalDispatch.jobId).delivery.state, "delivered");
assert.equal(lostJournalPi.sent.length, 0, "the session that holds the completion is never woken for it again");

// ---------------------------------------------------------------------------
// R13. Deferred receipt checks against a replaced session. pi invalidates the
//      context on newSession/fork/switchSession/reload and every guarded getter
//      then throws; a check that fires afterwards must not kill the session, must
//      not read the replaced session's entries, and must not turn a failure into
//      proof of absence.
// ---------------------------------------------------------------------------
const staleTimerKey = "agent-receipts-stale-timer";
const staleTimerCapture = join(root, "stale-timer-capture.jsonl");
const staleTimerEnv = { ...sessionEnv(staleTimerKey), QQ_ARCHITECT_PROMPT_CAPTURE: staleTimerCapture };
const staleTimerPi = piRuntimeDouble({ idle: false, sessionFile: join(root, "pi-stale-timer.jsonl") });
const staleTimerChecks = [];
const staleTimerTicks = tickQueue();
let staleTimerOptions = null;
const staleTimer = createArchitectExtension(staleTimerPi, {
  env: staleTimerEnv,
  cwd: root,
  interactive: true,
  schedule: staleTimerTicks.schedule,
  // Capture the deferred check instead of scheduling it, so the test fires it at
  // the exact moment the runtime would.
  scheduleReceipt: (fn) => {
    staleTimerChecks.push(fn);
    return () => {};
  },
  workflowFactory: (config) => createWorkflow({ ...config, spawnFn: runnerSpawner({ response: "STALE-TIMER-FINDINGS" }) }),
});
staleTimer.registerTools(staleTimer.tools.map((tool) => tool.parameters));
await callHandlers(staleTimerPi, "session_start", { reason: "startup" }, staleTimerPi.ctx);
const staleTimerWorkflow = staleTimer.ensureWorkflow();
const staleTimerDispatch = staleTimerWorkflow.dispatchRunner({ task: "consumed while busy" });
await staleTimerWorkflow.awaitRunner({ jobId: staleTimerDispatch.jobId });
const staleTimerJob = readJob(stateDir, staleTimerDispatch.jobId);
const staleTimerEventId = completedEventId(staleTimerJob);
assert.equal(staleTimerJob.delivery.state, "queued");
assert.equal(staleTimer.state.receipts.has(staleTimerEventId), true, "the busy steer registered a receipt expectation");
await callHandlers(staleTimerPi, "agent_settled", {}, staleTimerPi.ctx);
assert.equal(staleTimerChecks.length >= 1, true, "the receipt check is deferred, never inline");

// pi marks the session replaced: the captured context now throws on every
// guarded read, exactly as the installed runtime's `assertActive()` does.
const staleError = new Error("This extension ctx is stale after session replacement or reload.");
Object.defineProperty(staleTimerPi.ctx, "sessionManager", { get() { throw staleError; } });
Object.defineProperty(staleTimerPi.ctx, "isIdle", { value: () => { throw staleError; } });
// The session that replaced it holds an entry carrying THIS event's identity —
// evidence a retargeted check would happily acknowledge.
const replacementEntries = [
  {
    id: "entry-replacement",
    parentId: null,
    timestamp: new Date().toISOString(),
    type: "custom_message",
    customType: ARCHITECT_COMPLETION_CUSTOM_TYPE,
    content: "completion text of the replaced session",
    display: true,
    details: { eventId: staleTimerEventId, jobId: staleTimerDispatch.jobId, role: staleTimerJob.role },
  },
];
const replacementCtx = {
  isIdle: () => true,
  hasPendingMessages: () => false,
  sessionManager: { getEntries: () => [...replacementEntries], getSessionFile: () => join(root, "pi-replacement.jsonl") },
};

// The delivery path is guarded the same way: a context that cannot be read is not
// written to, and nothing is claimed for the completion.
const staleDelivery = await staleTimer.transport.deliver({ eventId: staleTimerEventId, jobId: staleTimerDispatch.jobId, role: staleTimerJob.role, text: "late completion" });
assert.equal(staleDelivery.state, "failed");
assert.equal(staleDelivery.reason, "stale-session-context");
assert.equal(staleTimerPi.sent.filter((entry) => entry.kind === "user" || entry.kind === "message").length, 1);

// The replacement is installed before the deferred task runs; the old code read
// `state.lastCtx` at that moment.
staleTimer.state.lastCtx = replacementCtx;

const staleCheck = staleTimerChecks.shift();
let staleThrown = null;
let staleOutcome = null;
try {
  staleOutcome = staleCheck();
} catch (err) {
  staleThrown = err;
}
assert.equal(staleThrown, null, "a deferred check against a replaced session must never throw into pi");
assert.ok(staleOutcome, "the deferred check reports what it did");
assert.deepEqual(staleOutcome.acknowledged, [], "a replaced session's entries never acknowledge the old session's completion");
assert.equal(staleOutcome.reason, "no-session-evidence", "an unreadable context is not evidence — and never proof of absence");
assert.equal(readJob(stateDir, staleTimerDispatch.jobId).delivery.state, "queued", "the durable records are untouched by the failed check");
assert.equal(readNotification(stateDir, staleTimerEventId).state, "queued");
assert.equal(staleTimerPi.sent.filter((entry) => entry.kind === "user" || entry.kind === "message").length, 1, "nothing is sent into a session that cannot be read");

// A failed read is not proof of absence: recovery against the invalidated
// context refuses to guess, and never falls back to the session that replaced it.
const invalidatedEvidence = staleTimer.sessionEvidence(staleTimerPi.ctx);
assert.equal(invalidatedEvidence, null, "an invalidated context yields no evidence");
const invalidatedRecovery = await staleTimerWorkflow.recoverDeliveries({ transport: staleTimer.transport, evidence: invalidatedEvidence });
assert.deepEqual(invalidatedRecovery.delivery.replayed, [], "no evidence is not proven absence");
assert.equal(invalidatedRecovery.delivery.uncertain.length, 1);
assert.equal(invalidatedRecovery.delivery.uncertain[0].reason, "no-session-evidence");
assert.equal(readJob(stateDir, staleTimerDispatch.jobId).delivery.state, "unknown");
assert.equal(staleTimerPi.sent.filter((entry) => entry.kind === "user" || entry.kind === "message").length, 1);

// The real replacement arrives: the expectation of the session that is gone is
// dropped, never retargeted at the replacement's evidence.
await callHandlers(staleTimerPi, "session_start", { reason: "new" }, replacementCtx);
assert.equal(staleTimer.state.receipts.has(staleTimerEventId), false, "an expectation of the replaced session is dropped, not matched elsewhere");
const droppedReceiptChecks = readFileSync(staleTimerCapture, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.kind === "receipt-check");
assert.equal(droppedReceiptChecks.some((entry) => entry.outcome === "stale-session" && entry.dropped.includes(staleTimerEventId)), true, "the expectation is dropped by session generation, not matched against the replacement's evidence");
assert.equal(droppedReceiptChecks.some((entry) => entry.kind === "receipt" && entry.eventId === staleTimerEventId), false, "the deferred receipt path never acknowledged the event");
// The replacement's own recovery may reconcile the event from the replacement
// session's identified entry — that is the documented receipt contract — but it
// is never the deferred check of the session that is gone that does it, and it
// never sends anything.
assert.equal(readNotification(stateDir, staleTimerEventId).state, "delivered");
assert.equal(readNotification(stateDir, staleTimerEventId).receipt.kind, "pi-session-entry");
assert.equal(staleTimerPi.sent.filter((entry) => entry.kind === "user" || entry.kind === "message").length, 1, "acknowledging the entry never sends anything");

// The production timer path (the default `setTimeout` scheduler) has to survive
// the same window: a deferred check that fires after the context was invalidated
// must not raise an uncaught exception.
const defaultTimerKey = "agent-receipts-stale-default-timer";
const defaultTimerPi = piRuntimeDouble({ idle: false, sessionFile: join(root, "pi-stale-default.jsonl") });
const defaultTimerTicks = tickQueue();
const defaultTimer = createArchitectExtension(defaultTimerPi, {
  env: sessionEnv(defaultTimerKey),
  cwd: root,
  interactive: true,
  schedule: defaultTimerTicks.schedule,
  workflowFactory: (config) => createWorkflow({ ...config, spawnFn: runnerSpawner({ response: "DEFAULT-TIMER-FINDINGS" }) }),
});
defaultTimer.registerTools(defaultTimer.tools.map((tool) => tool.parameters));
await callHandlers(defaultTimerPi, "session_start", { reason: "startup" }, defaultTimerPi.ctx);
const defaultTimerWorkflow = defaultTimer.ensureWorkflow();
const defaultTimerDispatch = defaultTimerWorkflow.dispatchRunner({ task: "consumed while busy (production timer)" });
await defaultTimerWorkflow.awaitRunner({ jobId: defaultTimerDispatch.jobId });
const defaultTimerJob = readJob(stateDir, defaultTimerDispatch.jobId);
const defaultTimerEventId = completedEventId(defaultTimerJob);
assert.equal(defaultTimerJob.delivery.state, "queued");
await callHandlers(defaultTimerPi, "agent_settled", {}, defaultTimerPi.ctx);
const escaped = [];
const trap = (err) => escaped.push(err);
process.on("uncaughtException", trap);
Object.defineProperty(defaultTimerPi.ctx, "sessionManager", { get() { throw new Error("This extension ctx is stale after session replacement or reload."); } });
await new Promise((resolve) => setTimeout(resolve, 40));
process.removeListener("uncaughtException", trap);
assert.deepEqual(escaped.map((err) => err?.message), [], "the production receipt timer must not raise an uncaught exception");
assert.equal(readJob(stateDir, defaultTimerDispatch.jobId).delivery.state, "queued", "and must not acknowledge anything from a context it cannot read");
assert.equal(defaultTimerPi.sent.filter((entry) => entry.kind === "user" || entry.kind === "message").length, 1);

console.log("architect completion receipt + recovery tests passed");
