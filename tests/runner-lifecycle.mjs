#!/usr/bin/env node
// Shared runner lifecycle (phase 2b) acceptance: the ONE lifecycle used by
// both entry points, exercised against the authoritative change record and the
// notification journal — offline (no relay installation, no external network).
//
// Covered here (the record/transport seams that need no live relay):
//   L1. Exact model-facing copy: the four runner tool descriptions verbatim on
//       BOTH surfaces, the assignment-updates heading/precedence sentence, the
//       progress push wrapper, and composition that keeps the original task and
//       target constraints verbatim (never summarized).
//   L2. Amendment composition under concurrency: two concurrent submissions
//       retain the original assignment and BOTH instructions exactly once with
//       deterministic revision ordering and latest-instruction precedence.
//   L3. Recorded-but-unsent updates: persisted before delivery, honestly
//       reported, and recovered through the explicit retry path with stable
//       transport request identities (lost send reply / acknowledgement loss).
//   L4. Honest layers: recording vs transport receipt vs acknowledgement are
//       never conflated; delivered/steered true is never returned without the
//       actual fact; the outcome pins to the acknowledged revision and an
//       unresolved update stays visible as pending.
//   L5. Identity gaps: two jobs and two attempts acknowledging the SAME initial
//       revision produce distinct, non-colliding incorporation command IDs.
//   L6. Forgery: wrong session/sequence/text/project/source cannot satisfy or
//       push another job's committed progress; verified envelopes route the
//       COMMITTED note and ack only after the notification journal accepted.
//   L7. Cancellation intent before outcome: a cancelled attempt can never
//       complete, even from late output; honest terminal semantics for a
//       launched-but-unbound setup failure (never success, never stuck).
//   L8. Workflow consumer address: stable per owner across restarts, isolated
//       across owners, UUID-form, and never presented as an observed session.
//   L9. Source of truth: stale compatibility caches cannot override the change
//       record; bounded pending/unresolved views; refcounted consumer release
//       never destroys another holder's transport.
//   L10. Per-message attribution: a shared consumer routes every notification
//       by the verified job id (never the first dispatch's closure).
//   L11. MCP read_report: reports.mjs-backed bounded pagination with terminal
//       reportId through the actual tool dispatcher, including cold-process
//       recovery.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createChange, openChange } from "../workflow/change-record.mjs";
import {
  COMMUNICATION_BINDING_SCHEMA,
  projectSlugForChange,
  relaySocketPath,
} from "../workflow/communication.mjs";
import { acknowledgeAssignment, readAssignment } from "../workflow/communication-receiver.mjs";
import {
  ASSIGNMENT_UPDATES_HEADING,
  ASSIGNMENT_UPDATES_PRECEDENCE,
  PENDING_UPDATE_VIEW_MAX,
  UNRESOLVED_REVISION_VIEW_MAX,
  composeAssignmentText,
  prepareRunnerCommunication,
  progressNotificationEventId,
  progressNotificationText,
  recordRunnerCancelIntent,
  recordRunnerOutcome,
  reconcileRunnerJob,
  releaseRunnerConsumer,
  retryPendingRunnerAmendments,
  runnerCommunicationView,
  steerRunnerLifecycle,
  verifyCommittedProgress,
  createParentProgressConsumer,
  workflowConsumerAddress,
} from "../workflow/runner-lifecycle.mjs";
import { readNotification } from "../workflow/notify.mjs";
import { WORKFLOW_TOOLS } from "../workflow/operations.mjs";
import { TOOLS as MCP_TOOLS } from "../bin/mcp-server.mjs";

const results = [];
const pass = (name) => { results.push(name); console.log(`PASS  ${name}`); };
const root = "/tmp/qq-runner-lifecycle-fixture-root";
const RUNTIME = { kind: "runtime", id: "lifecycle-runtime" };
const worker = (id) => ({ kind: "worker", id });
const sessionId = (n) => `aaaaaaaa-bbbb-4ccc-8ddd-00000000000${n}`;

function stateDirFor() {
  const dir = mkdtempSync(join(tmpdir(), "qq-runner-lifecycle-"));
  mkdirSync(join(dir, "changes"), { recursive: true, mode: 0o700 });
  return dir;
}

// ---------------------------------------------------------------------------
// L1. Exact copy on both surfaces + composition keeps the original verbatim.
// ---------------------------------------------------------------------------
{
  const DISPATCH = "Delegate research, inspection, reproduction, or diagnostics to a runner. Returns a job ID for tracking. Communication-enabled runners can receive assignment updates and push progress; completion arrives through the existing notification path.";
  const CHECK = "Read a runner's current status, assignment revision, pending updates, and report reference. Transport receipt and worker acknowledgement are separate; neither proves the requested outcome succeeded. This tool does not return the full findings.";
  const STEER = "Submit an additional instruction to a runner as an assignment update. The result distinguishes recording, transport receipt, and worker acknowledgement. Pending or refused delivery does not mean the worker incorporated the update.";
  const CANCEL = "Record cancellation intent and stop the owned runner process. Cancellation prevents later output from becoming a successful outcome and does not automatically restart the runner.";
  for (const [surface, tools] of [["native", WORKFLOW_TOOLS], ["mcp", MCP_TOOLS]]) {
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.description ?? tool.description]));
    assert.equal(byName.dispatch_runner, DISPATCH, `${surface} dispatch_runner copy is verbatim`);
    assert.equal(byName.check_runner, CHECK, `${surface} check_runner copy is verbatim`);
    assert.equal(byName.steer_runner, STEER, `${surface} steer_runner copy is verbatim`);
    assert.equal(byName.cancel_runner, CANCEL, `${surface} cancel_runner copy is verbatim`);
    assert.ok(!/gemini/i.test(JSON.stringify(tools.filter((t) => t.name.endsWith("_runner")))), `${surface} runner copy carries no stale Gemini model name`);
  }
  assert.equal(ASSIGNMENT_UPDATES_HEADING, "## Assignment updates");
  assert.equal(
    ASSIGNMENT_UPDATES_PRECEDENCE,
    "Apply these updates in revision order. A later update takes precedence where it conflicts with an earlier instruction.",
  );
  const composed = composeAssignmentText({
    task: "Original task text.\nSecond line verbatim.",
    targetPaths: ["workflow/operations.mjs", "bin/mcp-server.mjs"],
    amendments: [
      { revision: 3, text: "Update B text." },
      { revision: 2, text: "Update A text." },
    ],
  });
  assert.ok(composed.startsWith("Original task text.\nSecond line verbatim."), "the original task is kept verbatim at the head");
  assert.ok(composed.includes("Target paths to inspect:\nworkflow/operations.mjs\nbin/mcp-server.mjs"), "target constraints are kept verbatim");
  assert.ok(composed.includes(`${ASSIGNMENT_UPDATES_HEADING}\n${ASSIGNMENT_UPDATES_PRECEDENCE}`), "the exact heading and precedence sentence ride once");
  assert.ok(composed.indexOf("[revision 2]\nUpdate A text.") < composed.indexOf("[revision 3]\nUpdate B text."), "updates are labeled and ordered by revision");
  assert.equal((composed.match(/Update A text\./g) ?? []).length, 1, "each instruction appears exactly once");
  assert.equal((composed.match(/Update B text\./g) ?? []).length, 1, "each instruction appears exactly once");
  const wrapper = progressNotificationText({ jobId: "job-1", kind: "progress", seq: 4, attemptId: "attempt-1", message: "Did the thing." });
  assert.equal(wrapper, "Runner job-1 reported progress at sequence 4 (attempt attempt-1):\nDid the thing.");
  assert.equal(
    progressNotificationEventId({ changeId: "job-1", jobId: "job-1", attemptId: "attempt-1", seq: 4 }),
    "runner:job-1:progress:job-1:attempt-1:4",
    "notification ids carry change/job/attempt/sequence deterministically",
  );
  pass("L1 exact copy on both surfaces; composition and wrapper verbatim");
}

// A minimal bound attempt in a change record, ready for steering.
function seedAttempt(stateDir, changeId, jobId, attemptId, piSession) {
  const handle = openChange({ stateDir, changeId });
  handle.append("attempt.started", {
    identity: { seat: "runner", piSession, recipient: `agents/${piSession}` },
  }, { context: { actor: RUNTIME, jobId, attemptId }, commandId: `started-${jobId}-${attemptId}` });
  return handle;
}

function seedJob(stateDir, changeId, jobId, attemptId, piSession, task) {
  createChange({ stateDir, changeId, actor: RUNTIME, title: `fixture ${changeId}`, commandId: `create-${changeId}` });
  const handle = openChange({ stateDir, changeId });
  handle.append("assignment.revised", {
    revision: 1, predecessor: null, scope: { kind: "change" },
    assignment: { instructions: task ?? "Original assignment." },
  }, { context: { actor: RUNTIME }, commandId: `revise-${jobId}-r1` });
  handle.append("job.registered", { role: "runner", pinnedRevision: 1 }, { context: { actor: RUNTIME, jobId }, commandId: `register-${jobId}` });
  handle.append("attempt.launch_intent", { note: "test" }, { context: { actor: RUNTIME, jobId, attemptId }, commandId: `launch-${jobId}-${attemptId}` });
  seedAttempt(stateDir, changeId, jobId, attemptId, piSession);
}

// A stub relay transport recording every send and answering status queries.
function stubRelay({ status = "pending" } = {}) {
  const sent = [];
  const client = {
    async send(payload) {
      sent.push(payload);
      return { record: { event_id: `evt_stub_${sent.length}` } };
    },
    async status() {
      return { obligations: [{ status }] };
    },
    acked: [],
    blocked: [],
    retried: [],
    async acknowledge(guard) { client.acked.push(guard); return {}; },
    async block(guard) { client.blocked.push(guard); return {}; },
    async retry(guard) { client.retried.push(guard); return {}; },
  };
  return { sent, client, relay: { client: async () => client, socketPath: "/tmp/none.sock" } };
}

// ---------------------------------------------------------------------------
// L2 + L4. Concurrent amendments retain the original task/targets and both
// instructions exactly once; layers stay distinct; the outcome pins to the
// acknowledged revision while the unresolved update stays pending.
// ---------------------------------------------------------------------------
{
  const stateDir = stateDirFor();
  const changeId = "job-concurrent";
  const jobId = changeId;
  const attemptId = "attempt-c1";
  seedJob(stateDir, changeId, jobId, attemptId, sessionId(1), "Original task.\n\nTarget paths to inspect:\nsrc/a.mjs");
  const { relay } = stubRelay({ status: "pending" });
  const [a, b] = await Promise.all([
    steerRunnerLifecycle({ stateDir, changeId, jobId, message: "Update A: also inspect src/b.mjs.", relay, amendmentId: "amend-a", actor: RUNTIME }),
    steerRunnerLifecycle({ stateDir, changeId, jobId, message: "Update B: report the failing case.", relay, amendmentId: "amend-b", actor: RUNTIME }),
  ]);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.notEqual(a.revision, b.revision, "each submission committed its own revision exactly once");
  const state = openChange({ stateDir, changeId }).state;
  const views = openChange({ stateDir, changeId }).views;
  const finalRevision = Math.max(a.revision, b.revision);
  const finalText = views.assignment({ revision: finalRevision }).assignment.instructions;
  assert.ok(finalText.startsWith("Original task."), "the original task is never replaced");
  assert.ok(finalText.includes("Target paths to inspect:\nsrc/a.mjs"), "target constraints survive composition");
  for (const [label, text] of [["A", "Update A: also inspect src/b.mjs."], ["B", "Update B: report the failing case."]]) {
    assert.equal((finalText.match(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 1,
      `update ${label} appears exactly once in the composed assignment`);
    assert.ok(finalText.includes(`[revision ${text === "Update A: also inspect src/b.mjs." ? a.revision : b.revision}]`),
      `update ${label} carries its committed revision label`);
  }
  assert.ok(finalText.includes(ASSIGNMENT_UPDATES_PRECEDENCE), "latest-instruction precedence is stated verbatim");
  assert.equal(views.job(jobId).amendments.length, 2, "both amendments are recorded exactly once");
  assert.equal(state.revisions.filter((entry) => entry.scope.kind === "job").length, 2, "no duplicate or lost revision from the race");
  // Recording and transport receipt are separate facts; nothing claims
  // acknowledgement or incorporation here.
  assert.equal(a.acknowledged, false);
  assert.equal(b.acknowledged, false);
  assert.ok(["queued", "delivering", "unknown"].includes(a.delivery.status), `transport receipt is its own fact (${a.delivery.status})`);

  // The worker acknowledges ONLY revision A (its committed work covers A).
  const acked = acknowledgeAssignment({ stateDir, changeId, jobId, attemptId, actorId: "worker-c1" }, { revision: a.revision });
  assert.equal(acked.details.status, "ok");
  // The outcome covers revision A; the unresolved update B stays visible and
  // is never silently re-pinned or labelled fulfilled.
  const outcome = recordRunnerOutcome({ stateDir, changeId, jobId, attemptId, status: "completed", summary: "done for A" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.revision, a.revision, "the result is pinned to the acknowledged revision, not the latest one");
  const view = runnerCommunicationView({ stateDir, communication: { enabled: true, changeId, jobId, attemptId, stateDir } });
  assert.equal(view.outcome.status, "completed");
  assert.equal(view.outcome.revision, a.revision);
  assert.equal(view.pendingUpdates.length, 1, "the unresolved update B stays visible after terminal completion");
  assert.equal(view.pendingUpdates[0].revision, b.revision);
  assert.equal(view.pendingUpdates[0].status, "submitted");
  assert.equal(view.lastAcknowledgedRevision, a.revision);
  assert.equal(view.effectiveRevision, b.revision, "B is in force but not fulfilled by the A result");
  pass("L2+L4 concurrent amendments compose exactly once; outcome pinned to the acknowledged revision");
}

// ---------------------------------------------------------------------------
// L3. Recorded-but-unsent: persisted before delivery; explicit safe retry with
// stable request identities; never re-recorded; acknowledged work untouched.
// ---------------------------------------------------------------------------
{
  const stateDir = stateDirFor();
  const changeId = "job-retry";
  const jobId = changeId;
  const attemptId = "attempt-r1";
  seedJob(stateDir, changeId, jobId, attemptId, sessionId(2));
  // Submission with NO transport: recorded first, delivery honestly unavailable.
  const recorded = await steerRunnerLifecycle({
    stateDir, changeId, jobId, message: "Please also cover the retry path.", relay: null, amendmentId: "amend-retry", actor: RUNTIME,
  });
  assert.equal(recorded.ok, true);
  assert.equal(recorded.delivery.status, "unavailable", "no transport never fakes a send");
  const view0 = runnerCommunicationView({ stateDir, communication: { enabled: true, changeId, jobId, attemptId, stateDir } });
  assert.equal(view0.pendingUpdates[0].lastPush.status, "unavailable", "recorded-but-unsent is visible without a live cache");
  assert.equal(view0.pendingUpdates[0].lastPush.eventId, null);
  // Recovery: the explicit retry path re-pushes (never re-records) and records
  // durable delivery correlation with a stable request identity.
  const { relay, sent } = stubRelay({ status: "pending" });
  const retry = await retryPendingRunnerAmendments({ stateDir, changeId, jobId, relay, actor: RUNTIME });
  assert.equal(retry.pushed.length, 1, "the recorded-but-unsent update is re-pushed");
  assert.equal(retry.pushed[0].amendmentId, "amend-retry");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].request_id, `push-req-${jobId}-${attemptId}-amend-retry-0`, "the transport request identity is stable across retries");
  const view1 = runnerCommunicationView({ stateDir, communication: { enabled: true, changeId, jobId, attemptId, stateDir } });
  assert.ok(view1.pendingUpdates[0].lastPush.eventId, "the push correlation is durable in the authoritative record");
  // A crash that loses the send REPLY re-pushes under the SAME request id and
  // does not create a second record: correlation is rebuilt, nothing duplicated.
  const again = await retryPendingRunnerAmendments({ stateDir, changeId, jobId, relay, actor: RUNTIME });
  assert.equal(again.pushed.length, 0, "a queued obligation is never duplicated");
  assert.equal(again.inFlight.length, 1);
  // Acknowledged updates are never touched again.
  acknowledgeAssignment({ stateDir, changeId, jobId, attemptId, actorId: "worker-r1" }, { revision: 2 });
  const afterAck = await retryPendingRunnerAmendments({ stateDir, changeId, jobId, relay, actor: RUNTIME });
  assert.equal(afterAck.pushed.length, 0);
  assert.equal(afterAck.delivered.length, 1, "an acknowledged update reports as incorporated, not re-pushed");
  pass("L3 recorded-but-unsent updates recover exactly once with stable transport identities");
}

// ---------------------------------------------------------------------------
// L5. Two jobs and two attempts acknowledging the SAME initial revision can
// never collide on incorporation command IDs.
// ---------------------------------------------------------------------------
{
  const stateDir = stateDirFor();
  const changeId = "job-shared-rev";
  createChange({ stateDir, changeId, actor: RUNTIME, title: "shared revisions", commandId: `create-${changeId}` });
  const handle = openChange({ stateDir, changeId });
  handle.append("assignment.revised", {
    revision: 1, predecessor: null, scope: { kind: "change" }, assignment: { instructions: "Shared initial assignment." },
  }, { context: { actor: RUNTIME }, commandId: "revise-shared-r1" });
  for (const jobId of ["job-x", "job-y"]) {
    handle.append("job.registered", { role: "runner", pinnedRevision: 1 }, { context: { actor: RUNTIME, jobId }, commandId: `register-${jobId}` });
  }
  handle.append("attempt.launch_intent", {}, { context: { actor: RUNTIME, jobId: "job-x", attemptId: "x-a1" }, commandId: "launch-x-a1" });
  handle.append("attempt.launch_intent", {}, { context: { actor: RUNTIME, jobId: "job-x", attemptId: "x-a2" }, commandId: "launch-x-a2" });
  handle.append("attempt.launch_intent", {}, { context: { actor: RUNTIME, jobId: "job-y", attemptId: "y-a1" }, commandId: "launch-y-a1" });
  for (const [jobId, attemptId] of [["job-x", "x-a1"], ["job-x", "x-a2"], ["job-y", "y-a1"]]) {
    seedAttempt(stateDir, changeId, jobId, attemptId, sessionId(3));
    const ack = acknowledgeAssignment({ stateDir, changeId, jobId, attemptId, actorId: `worker-${attemptId}` }, { revision: 1 });
    assert.equal(ack.details.status, "ok", `${jobId}/${attemptId} acknowledged the shared initial revision`);
  }
  const seen = new Set();
  for (const entry of openChange({ stateDir, changeId }).readEvents({ limit: 50 }).events.filter((env) => env.kind === "worker.acknowledged")) {
    assert.ok(!seen.has(entry.command.id), `command id ${entry.command.id} is unique across jobs and attempts`);
    seen.add(entry.command.id);
  }
  assert.equal(seen.size, 3, "three acknowledgements of the same initial revision committed distinctly");
  assert.ok([...seen].every((id) => id.startsWith("ack-job-")), "incorporation command IDs are scoped to job+attempt");
  pass("L5 shared pinned revisions cannot collide on acknowledgement command IDs");
}

// ---------------------------------------------------------------------------
// L6. Forgery and mis-routing: only the recorded receiver binding can push a
// committed note; verified envelopes route the COMMITTED note and settle the
// relay obligation only after the notification journal accepted.
// ---------------------------------------------------------------------------
{
  const stateDir = stateDirFor();
  const changeId = "job-forge";
  const jobId = changeId;
  const attemptId = "attempt-f1";
  seedJob(stateDir, changeId, jobId, attemptId, sessionId(4));
  const bound = sessionId(4);
  const handle = openChange({ stateDir, changeId });
  handle.append("worker.progress", { note: "Scoped the work." }, { context: { actor: worker("worker-f1"), jobId, attemptId }, commandId: "progress-f1-1" });
  const seq = handle.state.jobs[jobId].attempts[attemptId].progress.at(-1).seq;
  const okBase = { stateDir, changeId, jobId, attemptId, kind: "progress", seq, fromSessionId: bound, text: "Scoped the work.", project: projectSlugForChange(changeId) };
  assert.equal(verifyCommittedProgress(okBase).note, "Scoped the work.", "the exact committed note verifies");

  const forged = [
    ["wrong session", { ...okBase, fromSessionId: sessionId(9) }, /recorded receiver binding/],
    ["wrong text", { ...okBase, text: "Scoped something else entirely." }, /does not match/],
    ["uncommitted sequence", { ...okBase, seq: seq + 7 }, /no committed progress entry/],
    ["wrong project", { ...okBase, project: "another-change" }, /does not match/],
    ["unknown job", { ...okBase, jobId: "job-elsewhere" }, /not committed|unknown/],
    ["cross-attempt sequence", { ...okBase, attemptId: "attempt-other" }, /not committed|unknown/],
  ];
  for (const [label, args, pattern] of forged) {
    assert.throws(() => verifyCommittedProgress(args), pattern, `${label} is refused, never trusted`);
  }
  pass("L6a forged/uncommitted/foreign progress payloads are refused");

  // The parent consumer bridges VERIFIED envelopes through the caller's
  // transport and acks only after the durable notification journal accepted.
  const consumerId = workflowConsumerAddress({ root, ownerRouting: "owner-1" });
  const delivered = [];
  const { relay, client } = stubRelay();
  const consumer = createParentProgressConsumer({
    relay,
    consumerId,
    stateDir,
    transport: { name: "fake-sink", deliver: async (notification) => { delivered.push(notification); return { state: "delivered" }; } },
  });
  const message = {
    schema: "qq.agent-message/v2",
    message: {
      from: bound,
      project: projectSlugForChange(changeId),
      role: "runner",
      tasks: [`change:${changeId}`, `job:${jobId}`, `attempt:${attemptId}`, `progress:${seq}`],
      pane: null,
      content: "Scoped the work.",
      delivery: "default",
    },
  };
  const deliveryDoc = {
    obligation: { obligation_id: "ob-1", consumer_type: "recipient", consumer_id: `agents/${consumerId}`, generation: 0 },
    record: { event_id: "evt-progress-1", recipient_id: `agents/${consumerId}`, envelope: { payload: message } },
    attempt_token: "at-1",
    endpoint_token: "ep-1",
    guard: { expected_high_water: "hw", expected_gap_token: "gap" },
  };
  const handled = await consumer.handleRawDelivery(deliveryDoc);
  assert.equal(handled.handled, "acked");
  assert.equal(delivered.length, 1);
  assert.equal(
    delivered[0].text,
    `Runner ${jobId} reported progress at sequence ${seq} (attempt ${attemptId}):\nScoped the work.`,
    "the outgoing notification is rebuilt from the COMMITTED note with the exact wrapper",
  );
  assert.equal(client.acked.length, 1, "the relay obligation settles only after the notification journal accepted");
  assert.ok(readNotification(stateDir, `runner:${jobId}:progress:${changeId}:${attemptId}:${seq}`), "the notification journal holds the deterministic event id");

  // A forged envelope never routes and never settles: it is BLOCKED.
  const forgedDoc = {
    ...deliveryDoc,
    obligation: { ...deliveryDoc.obligation, obligation_id: "ob-2" },
    record: { event_id: "evt-forged-1", recipient_id: `agents/${consumerId}`, envelope: { payload: { ...message, message: { ...message.message, content: "Fabricated progress." } } } },
  };
  const forgedResult = await consumer.handleRawDelivery(forgedDoc);
  assert.equal(forgedResult.handled, "blocked", "a forged envelope is blocked on the journal");
  assert.equal(delivered.length, 1, "no phantom progress reaches the architect");
  assert.equal(client.acked.length, 1);
  assert.equal(client.blocked.length, 1);

  // Duplicate delivery of the same event: no duplicate receipted notification.
  const dupResult = await consumer.handleRawDelivery(deliveryDoc);
  assert.equal(dupResult.handled, "acked");
  assert.equal(dupResult.duplicate, true, "an already-receipted progress notification is never sent twice");
  assert.equal(delivered.length, 1);
  pass("L6b verified progress routes the committed note once; forged envelopes block; duplicates never re-notify");

  // A transport failure leaves RECOVERABLE pending work (retry, not delete).
  const failingSink = createParentProgressConsumer({
    relay: stubRelay().relay,
    consumerId,
    stateDir,
    transport: { name: "broken", deliver: async () => ({ state: "failed", reason: "transport down" }) },
  });
  const secondProgress = openChange({ stateDir, changeId });
  secondProgress.append("worker.progress", { note: "Second milestone." }, { context: { actor: worker("worker-f1"), jobId, attemptId }, commandId: "progress-f1-2" });
  const seq2 = secondProgress.state.jobs[jobId].attempts[attemptId].progress.at(-1).seq;
  const delivery2 = {
    ...deliveryDoc,
    obligation: { ...deliveryDoc.obligation, obligation_id: "ob-3" },
    record: {
      event_id: "evt-progress-2",
      recipient_id: `agents/${consumerId}`,
      envelope: { payload: { ...message, message: { ...message.message, tasks: [`change:${changeId}`, `job:${jobId}`, `attempt:${attemptId}`, `progress:${seq2}`], content: "Second milestone." } } },
    },
  };
  const failed = await failingSink.handleRawDelivery(delivery2);
  assert.equal(failed.handled, "retried", "a transport failure retries the obligation instead of deleting it");
  pass("L6c transport failure keeps the progress obligation recoverable");
}

// ---------------------------------------------------------------------------
// L7. Cancellation and launched-but-unbound semantics.
// ---------------------------------------------------------------------------
{
  const stateDir = stateDirFor();
  const changeId = "job-cancel";
  const jobId = changeId;
  const attemptId = "attempt-k1";
  seedJob(stateDir, changeId, jobId, attemptId, sessionId(5));
  const intent = recordRunnerCancelIntent({ stateDir, changeId, jobId, attemptId, reason: "operator changed direction" });
  assert.equal(intent.ok, true, "cancellation intent records first");
  const late = recordRunnerOutcome({ stateDir, changeId, jobId, attemptId, status: "completed", summary: "late success" });
  assert.equal(late.ok, false, "late output can never become a successful outcome");
  assert.equal(late.code, "cancelled");
  const cancelled = recordRunnerOutcome({ stateDir, changeId, jobId, attemptId, status: "cancelled", summary: "cancelled by architect" });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.status, "cancelled");
  const dedupe = recordRunnerOutcome({ stateDir, changeId, jobId, attemptId, status: "completed" });
  assert.equal(dedupe.ok, true);
  assert.equal(dedupe.matches, false, "a dedupe never launders a different status");
  assert.equal(dedupe.status, "cancelled", "the record's outcome is authoritative in both directions");

  // Launched-but-never-bound: honest terminal FAILURE is recordable (the record
  // is never stuck in 'launched' and never fakes success).
  const unbound = "job-unbound";
  createChange({ stateDir, changeId: unbound, actor: RUNTIME, title: "unbound", commandId: `create-${unbound}` });
  const unboundHandle = openChange({ stateDir, changeId: unbound });
  unboundHandle.append("assignment.revised", {
    revision: 1, predecessor: null, scope: { kind: "change" }, assignment: { instructions: "Unbound job." },
  }, { context: { actor: RUNTIME }, commandId: "revise-unbound-r1" });
  unboundHandle.append("job.registered", { role: "runner", pinnedRevision: 1 }, { context: { actor: RUNTIME, jobId: unbound }, commandId: "register-unbound" });
  unboundHandle.append("attempt.launch_intent", { note: "setup" }, { context: { actor: RUNTIME, jobId: unbound, attemptId: "u-a1" }, commandId: "launch-unbound" });
  const completedUnbound = recordRunnerOutcome({ stateDir, changeId: unbound, jobId: unbound, attemptId: "u-a1", status: "completed" });
  assert.equal(completedUnbound.ok, false, "a never-started attempt can never complete");
  const failedUnbound = recordRunnerOutcome({ stateDir, changeId: unbound, jobId: unbound, attemptId: "u-a1", status: "failed", summary: "relay unavailable" });
  assert.equal(failedUnbound.ok, true, "an honest terminal failure reaches the record for an unbound attempt");
  assert.equal(failedUnbound.status, "failed");
  pass("L7 cancellation forbids success; unbound attempts reach honest terminal failure");
}

// ---------------------------------------------------------------------------
// L8. Workflow consumer address: stable per owner, isolated across owners.
// ---------------------------------------------------------------------------
{
  const a1 = workflowConsumerAddress({ root, ownerRouting: "owner-A" });
  const a2 = workflowConsumerAddress({ root, ownerRouting: "owner-A" });
  const b = workflowConsumerAddress({ root, ownerRouting: "owner-B" });
  const otherRoot = workflowConsumerAddress({ root: "/tmp/other-root", ownerRouting: "owner-A" });
  assert.equal(a1, a2, "a restarted parent for the same owner recovers the same address");
  assert.notEqual(a1, b, "unrelated owners never consume one another's obligations");
  assert.notEqual(a1, otherRoot, "the address is scoped to the repository");
  assert.match(a1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "the address is UUID-form (relay agents/<uuid> shape)");
  pass("L8 workflow consumer address is deterministic per owner and never impersonates a session");
}

// ---------------------------------------------------------------------------
// L9. Source of truth, bounded views, and refcounted release.
// ---------------------------------------------------------------------------
{
  const stateDir = stateDirFor();
  const changeId = "job-truth";
  const jobId = changeId;
  const attemptId = "attempt-t1";
  seedJob(stateDir, changeId, jobId, attemptId, sessionId(6));
  // Bounded views: many pending updates and job revisions stay capped.
  for (let index = 0; index < PENDING_UPDATE_VIEW_MAX + 4; index += 1) {
    await steerRunnerLifecycle({
      stateDir, changeId, jobId, message: `Update ${index}.`, relay: null, amendmentId: `amend-t-${index}`, actor: RUNTIME,
    });
  }
  const view = runnerCommunicationView({ stateDir, communication: { enabled: true, changeId, jobId, attemptId, stateDir } });
  assert.equal(view.pendingUpdates.length, PENDING_UPDATE_VIEW_MAX, "pending update references are bounded");
  assert.ok(view.pendingUpdateCount > PENDING_UPDATE_VIEW_MAX, "the total is reported alongside the bounded page");
  assert.ok(view.unresolvedRevisions.length <= UNRESOLVED_REVISION_VIEW_MAX, "unresolved revisions are bounded");
  const text = JSON.stringify(view);
  assert.ok(!text.includes("Update 0."), "the projection never carries raw instruction text");

  // A stale compatibility cache cannot override the authoritative record: the
  // record holds no outcome while the cache claims completion.
  const cacheRecord = {
    id: jobId,
    role: "runner",
    status: "completed",
    terminal: { status: "completed", ok: true, at: Date.now(), summary: "fabricated", reportId: null, reportChars: 0, resultAvailable: false, error: null },
    communication: { enabled: true, changeId, jobId, attemptId, stateDir, runtimeActorId: "lifecycle-runtime" },
  };
  const recordView = runnerCommunicationView({ stateDir, communication: cacheRecord.communication });
  assert.equal(recordView.outcome, null, "the projection rebuilds from the record; a stale cache cannot invent an outcome");

  // Reconcile a job record that carries an explicit result: the shared recovery
  // ingests it and mirrors the settled outcome INTO the authoritative record.
  mkdirSync(join(stateDir, "jobs"), { recursive: true });
  const resultFile = join(stateDir, "runner-results", `${jobId}.json`);
  mkdirSync(join(stateDir, "runner-results"), { recursive: true });
  writeFileSync(resultFile, JSON.stringify({ runnerId: jobId, response: "durable findings", data_points: [] }), "utf8");
  const { writeJob } = await import("../workflow/jobs.mjs");
  writeJob(stateDir, {
    schema: 1,
    id: jobId,
    role: "runner",
    status: "running",
    workflow: { sessionKey: "owner-t", sessionId: null, ownerAgentId: null, root },
    cwd: root,
    task: "truth task",
    startedAt: Date.now(),
    resultFile,
    communication: cacheRecord.communication,
    process: null,
  });
  const recovered = reconcileRunnerJob({ stateDir, jobId });
  assert.equal(recovered.record.status, "completed", "the explicit result is ingested before a lost process is interpreted");
  assert.equal(recovered.outcome.status, "completed", "the settled outcome is mirrored into the authoritative change record");
  const mirrored = runnerCommunicationView({ stateDir, communication: cacheRecord.communication });
  assert.equal(mirrored.outcome.status, "completed", "the change record is the outcome authority after recovery");
  assert.equal(mirrored.outcome.revision, 1, "an outcome without acknowledgement stays pinned to revision 1 despite newer updates");

  // Refcounted consumer release: one holder releasing never destroys another
  // holder's transport; the LAST release drains and stops.
  let drained = 0;
  let released = 0;
  const entry = {
    key: "k",
    refs: 2,
    consumer: { drainAndStop: async () => { drained += 1; return { drained: 0 }; } },
    relay: { release: async () => { released += 1; return { released: true }; } },
  };
  const first = await releaseRunnerConsumer(entry);
  assert.equal(first.released, false, "a shared hold survives one worker's release");
  assert.equal(drained, 0);
  assert.equal(released, 0);
  const second = await releaseRunnerConsumer(entry);
  assert.equal(second.released, true, "the last hold drains bounded and releases the transport");
  assert.equal(drained, 1);
  assert.equal(released, 1);
  pass("L9 record authority over caches; bounded views; refcounted consumer release");
}

// ---------------------------------------------------------------------------
// L10. Shared-consumer per-message attribution: every outgoing notification
// selects its transport/session route from the VERIFIED notification's job id
// (the shared registry) — never the closure of whichever dispatch created the
// consumer first.
// ---------------------------------------------------------------------------
{
  const stateDir = stateDirFor();
  seedJob(stateDir, "job-route-a", "job-route-a", "attempt-ra", sessionId(7), "Task A.");
  seedJob(stateDir, "job-route-b", "job-route-b", "attempt-rb", sessionId(8), "Task B.");
  const addProgress = (changeId, jobId, attemptId, note, cmd) => {
    const handle = openChange({ stateDir, changeId });
    handle.append("worker.progress", { note }, { context: { actor: worker(`worker-${attemptId}`), jobId, attemptId }, commandId: cmd });
    return handle.state.jobs[jobId].attempts[attemptId].progress.at(-1).seq;
  };
  const seqA = addProgress("job-route-a", "job-route-a", "attempt-ra", "A milestone.", "progress-ra-1");
  const seqB = addProgress("job-route-b", "job-route-b", "attempt-rb", "B milestone.", "progress-rb-1");
  const sinkA = [];
  const sinkB = [];
  const consumerId = workflowConsumerAddress({ root, ownerRouting: "owner-routes" });
  const routes = new Map([
    ["job-route-a", { transport: { name: "sink-a", deliver: async (n) => { sinkA.push(n); return { state: "delivered" }; } }, workflowRouting: { sessionKey: "owner-routes", sessionId: sessionId(7) } }],
    ["job-route-b", { transport: { name: "sink-b", deliver: async (n) => { sinkB.push(n); return { state: "delivered" }; } }, workflowRouting: { sessionKey: "owner-routes", sessionId: sessionId(8) } }],
  ]);
  // The consumer was CREATED with job A's transport closure — the historical
  // defect: the first dispatch's closure handled every later job's messages.
  const { relay, client } = stubRelay();
  const consumer = createParentProgressConsumer({
    relay,
    consumerId,
    stateDir,
    transport: routes.get("job-route-a").transport,
    routes,
  });
  const envelope = (changeId, jobId, attemptId, seq, note, from) => ({
    obligation: { obligation_id: `ob-${jobId}`, consumer_type: "recipient", consumer_id: `agents/${consumerId}`, generation: 0 },
    record: {
      event_id: `evt-${jobId}`,
      recipient_id: `agents/${consumerId}`,
      envelope: {
        payload: {
          schema: "qq.agent-message/v2",
          message: { from, project: projectSlugForChange(changeId), role: "runner", tasks: [`change:${changeId}`, `job:${jobId}`, `attempt:${attemptId}`, `progress:${seq}`], pane: null, content: note, delivery: "default" },
        },
      },
    },
    attempt_token: "at-r",
    endpoint_token: "ep-r",
    guard: { expected_high_water: "hw-r", expected_gap_token: "gap-r" },
  });
  // Job B's message FIRST: it must reach B's route, never A's closure.
  const handledB = await consumer.handleRawDelivery(envelope("job-route-b", "job-route-b", "attempt-rb", seqB, "B milestone.", sessionId(8)));
  assert.equal(handledB.handled, "acked");
  assert.equal(sinkA.length, 0, "the first dispatch's closure never handles another job's message");
  assert.equal(sinkB.length, 1);
  assert.equal(sinkB[0].jobId, "job-route-b", "job attribution comes from the verified notification");
  assert.equal(sinkB[0].workflow.sessionId, sessionId(8), "session routing is the message's own route");
  const handledA = await consumer.handleRawDelivery(envelope("job-route-a", "job-route-a", "attempt-ra", seqA, "A milestone.", sessionId(7)));
  assert.equal(handledA.handled, "acked");
  assert.equal(sinkA.length, 1);
  assert.equal(sinkA[0].jobId, "job-route-a");
  assert.equal(client.acked.length, 2, "both obligations settle after their own journal acceptance");
  pass("L10 shared consumer attributes each message per verified job route, not the first dispatch closure");
}

// ---------------------------------------------------------------------------
// L11. The mandated MCP read_report surface: reports.mjs-backed, bounded
// pagination, terminal reportId, reachable through the ACTUAL tool dispatcher
// (tools/call) and from a cold process with no in-memory state.
// ---------------------------------------------------------------------------
{
  const { callTool, handleRpc: rpc } = await import("../bin/mcp-server.mjs");
  const { saveReport } = await import("../workflow/reports.mjs");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const stateDir = stateDirFor();
  mkdirSync(join(stateDir, "reports"), { recursive: true });
  const body = "0123456789".repeat(120); // 1200 chars
  const saved = saveReport(stateDir, { jobId: "job-report", role: "runner", text: body });
  const previous = process.env.QQ_WORKFLOW_STATE_DIR;
  const previousOwner = process.env.QQ_WORKFLOW_SESSION_ID;
  process.env.QQ_WORKFLOW_STATE_DIR = stateDir;
  process.env.QQ_WORKFLOW_SESSION_ID = sessionId(9);
  try {
    const first = await callTool("read_report", { reportId: saved.reportId, limit: 500 });
    assert.equal(first.ok, true);
    assert.equal(first.reportId, saved.reportId, "the terminal reportId is returned");
    assert.equal(first.text.length, 500, "chunks are bounded");
    assert.equal(first.complete, false);
    const second = await callTool("read_report", { reportId: saved.reportId, offset: first.nextOffset, limit: 500 });
    assert.equal(second.text.length, 500);
    const third = await callTool("read_report", { reportId: saved.reportId, offset: second.nextOffset });
    assert.equal(third.text.length, 200);
    assert.equal(third.complete, true);
    assert.equal(first.text + second.text + third.text, body, "paged retrieval reproduces the whole report");
    // Through the ACTUAL MCP dispatcher (JSON-RPC tools/call semantics).
    const rpcOut = await rpc("tools/call", { name: "read_report", arguments: { reportId: saved.reportId, limit: 100 } });
    assert.notEqual(rpcOut.isError, true, JSON.stringify(rpcOut));
    const parsed = JSON.parse(rpcOut.content[0].text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.text.length, 100);
    // A missing report is an honest refusal, never a crash or empty success.
    const missing = await callTool("read_report", { reportId: "runner-nope-0000" });
    assert.equal(missing.ok, false);
  } finally {
    if (previous === undefined) delete process.env.QQ_WORKFLOW_STATE_DIR;
    else process.env.QQ_WORKFLOW_STATE_DIR = previous;
    if (previousOwner === undefined) delete process.env.QQ_WORKFLOW_SESSION_ID;
    else process.env.QQ_WORKFLOW_SESSION_ID = previousOwner;
  }
  // Cold-process recovery: a fresh server process serves the same durable
  // report through the tool dispatcher with no in-memory state at all.
  const request = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_report", arguments: { reportId: saved.reportId, offset: 1100 } } })}\n`;
  const cold = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/mcp-server.mjs", import.meta.url))], {
    input: request,
    encoding: "utf8",
    env: { ...process.env, QQ_WORKFLOW_STATE_DIR: stateDir, QQ_WORKFLOW_SESSION_ID: sessionId(9) },
    timeout: 15_000,
  });
  assert.equal(cold.status, 0, `cold server failed: ${cold.stderr}`);
  const coldLine = JSON.parse(cold.stdout.split("\n").filter((line) => line.trim())[0]);
  const coldParsed = JSON.parse(coldLine.result.content[0].text);
  assert.equal(coldParsed.ok, true, "cold-process report retrieval works");
  assert.equal(coldParsed.text, body.slice(1100));
  assert.equal(coldParsed.complete, true);
  pass("L11 MCP read_report serves durable reports through the actual dispatcher with bounded pagination and cold-process recovery");
}

console.log(`\nrunner-lifecycle: ${results.length} groups passed.`);
