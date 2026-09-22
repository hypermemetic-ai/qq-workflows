// Offline supplements for the relay receiver compatibility proof.
//
// The real-Pi + real-journal proof lives in tests/pi-relay-receiver.mjs; this
// file adds the deterministic unit-level coverage that dispatch requires to
// SUPPLEMENT (never replace) it:
//   * the receiver's decision boundaries against a stub transport and a stub
//     Pi host, ported from the historical qq-monolith live test harness
//     (tests/test-agent-messages-live.mjs @2b4b989) onto the adapted fixture
//     receiver (tests/fixtures/pi-relay/agent-messages-relay-fixture.mjs);
//   * the change-record acknowledgement layering the proof depends on:
//     wrong-attempt, stale, and absent acknowledgements cannot fulfill a
//     pending amendment, amendment acceptance is scoped to the targeted
//     attempt, acknowledgement is idempotent by command ID, and a duplicate
//     acknowledgement never changes the amendment view.
// Everything here is offline and hermetic: no pi runtime, no relay service, no
// provider traffic.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createChange, openChange, viewsFor } from "../workflow/change-record.mjs";
import register, { parseMessage, statusName } from "./fixtures/pi-relay/agent-messages-relay-fixture.mjs";

const results = [];
const pass = (name) => { results.push(name); console.log(`PASS  ${name}`); };

const SENDER = "019ff7b9-2fcd-78cd-bc16-c770a9ccff11";
const WORKER = "session-4b70f906-ce0a-4135-bc9e-b231db9b98b1";

function envelopeRecord({ eventId, content, delivery = "default", tasks = ["job:job-1", "attempt:a1"] }) {
  return {
    event_id: eventId,
    accepted_at: 1,
    recipient_id: `agents/${WORKER}`,
    envelope: {
      payload: {
        schema: "qq.agent-message/v2",
        message: { from: SENDER, project: "relay-proof", role: "runner", tasks, pane: null, content, delivery },
      },
    },
  };
}

function stubClient() {
  const queue = [];
  const waiters = [];
  const ops = [];
  const client = {
    // Test-side controls.
    push(record) {
      const delivery = {
        record,
        obligation: { obligation_id: `obl_${record.event_id}`, consumer_type: "recipient", consumer_id: `agents/${WORKER}`, generation: 0 },
        attempt_token: `try_${record.event_id}`,
        endpoint_token: "ep",
        guard: { expected_high_water: null, expected_gap_token: "g", gaps: [] },
      };
      const waiter = waiters.shift();
      if (waiter) waiter({ delivery });
      else queue.push(delivery);
      return delivery;
    },
    // Receiver-side transport surface.
    async next(body) {
      if (queue.length) return { delivery: queue.shift() };
      const resolved = await new Promise((resolve) => {
        waiters.push(resolve);
        const timer = setTimeout(resolve, body.wait_ms ?? 100);
        if (typeof timer.unref === "function") timer.unref();
      });
      if (resolved?.delivery) return resolved;
      return queue.length ? { delivery: queue.shift() } : {};
    },
    async acknowledge(request) { ops.push({ op: "acknowledge", request }); return { acknowledged: true }; },
    async retry(request) { ops.push({ op: "retry", request }); return { retried: true }; },
    async block(request) { ops.push({ op: "block", request }); return { blocked: true }; },
    async publish(request) { ops.push({ op: "publish", request }); return { id: "evt_claim", idempotent: false }; },
    async status(request) { ops.push({ op: "status", request }); return { obligations: [{ status: "pending" }] }; },
    async send(request) { ops.push({ op: "send", request }); return { record: { event_id: "evt_sent" } }; },
  };
  client.ops = ops;
  client.queue = queue;
  return client;
}

function stubPiHost({ idle = false, durableEntries = [] } = {}) {
  const handlers = new Map();
  const received = [];
  const sequence = [];
  let aborted = 0;
  let isIdle = idle;
  const toolHandlers = new Map();
  const pi = {
    registerTool(tool) { toolHandlers.set(tool.name, tool); },
    registerCommand() {},
    on(name, handler) { handlers.set(name, handler); },
    events: { on() {} },
    sendMessage: async (message, options) => {
      sequence.push({ operation: "sendMessage", idle: isIdle });
      received.push({ message, options });
    },
  };
  const ctx = {
    cwd: "/fixture",
    isIdle: () => isIdle,
    abort: () => { sequence.push({ operation: "abort" }); aborted += 1; },
    sessionManager: {
      getSessionId: () => WORKER,
      getEntries: () => durableEntries,
      getSessionFile() { throw new Error("agent-message receipts must not read session files"); },
    },
  };
  const host = {
    pi, ctx, handlers, toolHandlers, received, sequence, durableEntries,
    setIdle(value) { isIdle = value; },
    get aborted() { return aborted; },
  };
  return host;
}

function startReceiver({ env, client, host, injectedMessages, durableEntries }) {
  register(host.pi, {
    env: { ...env, QQ_AGENT_PROJECT: "relay-proof", QQ_AGENT_ROLE: "runner", HOME: env.HOME },
    client,
    injectedMessages,
    sendMessage: host.pi.sendMessage,
  });
  return host.handlers.get("session_start")({ reason: "startup" }, host.ctx);
}

async function waitFor(label, predicate, deadlineMs = 2000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const AMENDMENT_ENVELOPE = "Workflow amendment available. Read the referenced assignment revision before acknowledging it. Delivery of this message does not acknowledge the amendment.";

try {
  // ---------------------------------------------------------------- U1: parse gate
  assert.equal(parseMessage({ envelope: { payload: { schema: "other" } } }), undefined, "foreign schema refused");
  assert.equal(
    parseMessage(envelopeRecord({ eventId: "evt_1", content: "x", tasks: ["job:job-1", "job:job-1"] })),
    undefined,
    "duplicate task entries refused by the historical normalizeTasks contract",
  );
  const parsed = parseMessage(envelopeRecord({ eventId: "evt_1", content: AMENDMENT_ENVELOPE }));
  assert.equal(parsed.event_id, "evt_1");
  assert.equal(parsed.content_hash.length, 64, "content hash is the stable duplicate key half");
  assert.equal(statusName({ obligations: [{ status: "pending" }] }), "queued");
  assert.equal(statusName({ obligations: [{ status: "acknowledged" }] }), "delivered");
  pass("U1 parse/status gates: foreign payloads refused, stable event_id+content_hash identity, transport status naming");

  // ---------------------------------------------------------------- U2: busy steering + delayed durable receipt
  {
    const client = stubClient();
    const host = stubPiHost({ idle: false });
    const durableEntries = host.durableEntries;
    const injectedMessages = new Set();
    await startReceiver({ env: process.env, client, host, injectedMessages, durableEntries });
    client.push(envelopeRecord({ eventId: "evt_busy", content: AMENDMENT_ENVELOPE }));
    await waitFor("busy injection", () => host.received.length === 1);
    assert.deepEqual(host.received[0].options, { triggerTurn: true, deliverAs: "steer" }, "busy delivery steers, never aborts");
    assert.equal(host.aborted, 0, "ordinary steering does not abort the run");
    await waitFor("first retry while the entry is not yet observable", () =>
      client.ops.some((op) => op.op === "retry" && op.request.reason === "durable session entry not yet observable"));
    assert.equal(client.ops.filter((op) => op.op === "acknowledge").length, 0, "nothing is acknowledged before the durable entry exists");
    // The steer lands and the session persists the receipt.
    durableEntries.push({
      type: "custom_message",
      customType: host.received[0].message.customType,
      content: host.received[0].message.content,
      display: true,
      details: { ...host.received[0].message.details },
    });
    client.push(envelopeRecord({ eventId: "evt_busy", content: AMENDMENT_ENVELOPE }));
    await waitFor("acknowledge after the durable receipt", () => client.ops.some((op) => op.op === "acknowledge"));
    assert.equal(host.received.length, 1, "redelivery must not inject the same event twice in one process");
    assert.equal(injectedMessages.size, 0, "the dedup marker is released once the durable receipt is acknowledged");
    pass("U2 busy receiver: steer options, retry 'durable session entry not yet observable' before receipt, exactly one acknowledge after it, no double injection");
    await host.handlers.get("session_shutdown")({ reason: "done" }, host.ctx);
  }

  // ---------------------------------------------------------------- U3: immediate delivery discipline
  {
    const client = stubClient();
    const host = stubPiHost({ idle: false });
    const injectedMessages = new Set();
    await startReceiver({ env: process.env, client, host, injectedMessages, durableEntries: host.durableEntries });
    client.push(envelopeRecord({ eventId: "evt_now", content: AMENDMENT_ENVELOPE, delivery: "immediate" }));
    await waitFor("immediate claim", () => client.ops.some((op) => op.op === "publish"));
    await waitFor("abort", () => host.aborted === 1);
    host.setIdle(true); // the runtime becomes idle because the aborted run ended
    await waitFor("idle injection", () => host.received.length === 1);
    const startIndex = host.sequence.findIndex((entry) => entry.operation === "abort");
    assert.deepEqual(host.sequence.slice(startIndex), [{ operation: "abort" }, { operation: "sendMessage", idle: true }], "historical sequence: abort first, then inject into the idle runtime");
    assert.deepEqual(host.received[0].options, { triggerTurn: true }, "post-abort injection triggers a fresh turn");
    pass("U3 immediate receiver: claim -> abort -> waitUntilIdle -> triggerTurn injection (historical discipline preserved)");
    await host.handlers.get("session_shutdown")({ reason: "done" }, host.ctx);
  }
  {
    const client = stubClient();
    const host = stubPiHost({ idle: false, neverIdle: true });
    // Keep the runtime busy forever: the waitUntilIdle cap must convert the
    // delivery into a retry, never a false acknowledgement.
    host.setIdle(false);
    const injectedMessages = new Set();
    await startReceiver({ env: process.env, client, host, injectedMessages, durableEntries: host.durableEntries });
    const originalIsIdle = host.ctx.isIdle;
    host.ctx.isIdle = () => false; // never becomes idle
    client.push(envelopeRecord({ eventId: "evt_stuck", content: AMENDMENT_ENVELOPE, delivery: "immediate" }));
    await waitFor("immediate-abort failure retry", () =>
      client.ops.some((op) => op.op === "retry" && op.request.reason === "Pi did not become idle after immediate abort"),
      (5_000 + 2_000));
    assert.equal(host.received.length, 0, "an idle that never arrives must not inject");
    assert.equal(injectedMessages.size, 0, "the dedup marker is released on the immediate-abort failure path");
    host.ctx.isIdle = originalIsIdle;
    pass("U3b immediate receiver failure path: 'Pi did not become idle after immediate abort' retry, no injection, no acknowledgement");
    await host.handlers.get("session_shutdown")({ reason: "done" }, host.ctx);
  }

  // ---------------------------------------------------------------- U4: durable evidence across a receiver restart
  {
    const durableEntries = [{
      type: "custom_message",
      customType: "qq-agent-message",
      content: `[message evt_old from ${SENDER} — relay-proof / runner — tasks: job:job-1, attempt:a1]\n${AMENDMENT_ENVELOPE}`,
      display: true,
      details: {
        schema: "qq.agent-message/v2",
        event_id: "evt_old",
        content_hash: parseMessage(envelopeRecord({ eventId: "evt_old", content: AMENDMENT_ENVELOPE })).content_hash,
        from: SENDER,
        delivery: "default",
      },
    }];
    const client = stubClient();
    const host = stubPiHost({ idle: true, durableEntries });
    const injectedMessages = new Set(); // a fresh receiver inherits nothing
    assert.equal(injectedMessages.size, 0, "a fresh receiver must not inherit process-local dedup state");
    await startReceiver({ env: process.env, client, host, injectedMessages, durableEntries });
    client.push(envelopeRecord({ eventId: "evt_old", content: AMENDMENT_ENVELOPE }));
    await waitFor("durable-evidence acknowledgement", () => client.ops.some((op) => op.op === "acknowledge"));
    assert.equal(host.received.length, 0, "durable session evidence avoids reinjection");
    assert.equal(client.ops.filter((op) => op.op === "acknowledge").length, 1, "exactly one acknowledgement for the durable receipt");
    pass("U4 restart: durable receipt acknowledged exactly once, no reinjection, no inherited in-memory dedup");
    await host.handlers.get("session_shutdown")({ reason: "done" }, host.ctx);
  }

  // ---------------------------------------------------------------- U5: change-record acknowledgement layering
  {
    const stateDir = mkdtempSync(join(tmpdir(), "qq-relay-units-cr-"));
    try {
      const ctx = (extra = {}) => ({ actor: { kind: "runtime", id: "fixture-runtime" }, ...extra });
      const workerCtx = (extra = {}) => ({ actor: { kind: "worker", id: "worker-session" }, ...extra });
      const handle = createChange({ stateDir, changeId: "layering", actor: { kind: "runtime", id: "fixture-runtime" }, title: "ack layering" });
      handle.append("assignment.revised", { revision: 1, predecessor: null, scope: { kind: "change" }, assignment: { instructions: "rev1" } }, { context: ctx() });
      handle.append("job.registered", { role: "runner", pinnedRevision: 1 }, { context: ctx({ jobId: "job-b" }) });
      handle.append("assignment.revised", { revision: 2, predecessor: 1, scope: { kind: "job", jobId: "job-b" }, assignment: { instructions: "rev2" } }, { context: ctx() });
      handle.append("attempt.launch_intent", {}, { context: ctx({ jobId: "job-b", attemptId: "a1" }) });
      handle.append("attempt.started", { identity: "pi-session-a1" }, { context: ctx({ jobId: "job-b", attemptId: "a1" }) });
      handle.append("attempt.launch_intent", {}, { context: ctx({ jobId: "job-b", attemptId: "a2" }) });
      handle.append("attempt.started", { identity: "pi-session-a2" }, { context: ctx({ jobId: "job-b", attemptId: "a2" }) });
      handle.append("amendment.submitted", { amendmentId: "am1", revision: 2, transport: { relay: { kind: "agent.message", recipient: "agents/pi-session-a1" } } }, { context: ctx({ jobId: "job-b", attemptId: "a1" }) });

      const views = () => viewsFor(openChange({ stateDir, changeId: "layering" }).state);
      const amendment = () => views().job("job-b").amendments.find((entry) => entry.amendmentId === "am1");
      assert.equal(amendment().acknowledged, null, "an absent acknowledgement leaves the amendment pending");
      assert.equal(views().pendingAmendments("job-b").length, 1);

      // Stale acknowledgement: the worker confirms the OLD revision.
      handle.append("worker.acknowledged", { revision: 1, note: "stale" }, { context: workerCtx({ jobId: "job-b", attemptId: "a1" }) });
      assert.equal(amendment().acknowledged, null, "a stale revision acknowledgement cannot fulfill a new amendment");

      // Wrong-attempt acknowledgement: another attempt confirms the right revision.
      handle.append("worker.acknowledged", { revision: 2, note: "wrong attempt" }, { context: workerCtx({ jobId: "job-b", attemptId: "a2" }) });
      assert.equal(amendment().acknowledged, null, "an acknowledgement by a non-targeted attempt cannot fulfill the amendment");

      // Acceptance is scoped to the delivery: the wrong attempt cannot accept.
      assert.throws(
        () => handle.append("amendment.accepted", { amendmentId: "am1" }, { context: ctx({ jobId: "job-b", attemptId: "a2" }) }),
        /cannot be accepted by attempt/,
        "amendment acceptance is scoped to the targeted attempt",
      );

      // The targeted attempt acknowledges the exact revision: fulfilled.
      const ack = handle.append(
        "worker.acknowledged",
        { revision: 2, note: "targeted ack" },
        { context: workerCtx({ jobId: "job-b", attemptId: "a1" }), commandId: "ack-am1-rev2" },
      );
      assert.equal(ack.committed, true);
      assert.ok(amendment().acknowledged, "the targeted attempt's exact-revision acknowledgement fulfills the amendment");
      assert.equal(views().pendingAmendments("job-b").length, 0);

      // Idempotent application: the same command ID is a dedupe, not a new event.
      const retry = handle.append(
        "worker.acknowledged",
        { revision: 2, note: "targeted ack" },
        { context: workerCtx({ jobId: "job-b", attemptId: "a1" }), commandId: "ack-am1-rev2" },
      );
      assert.equal(retry.committed, false);
      assert.equal(retry.dedupe, true, "a retried acknowledgement command is a dedupe");
      const seqAfterRetry = openChange({ stateDir, changeId: "layering" }).state.lastSeq;
      const withDuplicate = handle.append(
        "worker.acknowledged",
        { revision: 2, note: "duplicate ack, different command" },
        { context: workerCtx({ jobId: "job-b", attemptId: "a1" }), commandId: "ack-am1-rev2-dup" },
      );
      assert.equal(withDuplicate.committed, true, "a distinct duplicate acknowledgement is recordable evidence");
      const amendmentAfterDuplicate = views().job("job-b").amendments.find((entry) => entry.amendmentId === "am1");
      assert.equal(amendmentAfterDuplicate.acknowledged.seq, amendment().acknowledged.seq, "the amendment view stays pinned to the first fulfilment");
      assert.ok(seqAfterRetry >= ack.seq, "the dedupe wrote no new event");

      // A cancelled attempt can never be promoted to a completed outcome.
      handle.append("attempt.cancel_intent", { reason: "operator cancelled" }, { context: ctx({ jobId: "job-b", attemptId: "a2" }) });
      assert.throws(
        () => handle.append("attempt.outcome", { status: "completed" }, { context: ctx({ jobId: "job-b", attemptId: "a2" }) }),
        /cancellation intent on attempt/,
        "later output cannot promote cancelled work to success",
      );
      pass("U5 change-record layering: absent/stale/wrong-attempt acks never fulfill; acceptance scoping; command-ID idempotency; view stability; cancelled attempts cannot be promoted");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }

  console.log(`TOTAL ${results.length}/${results.length} PASS`);
} catch (error) {
  console.error("UNIT FAILURE:", error?.message ?? error);
  console.error(error?.stack ?? "");
  process.exitCode = 1;
}
