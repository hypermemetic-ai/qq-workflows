// Probe: idle analogue of R4 — crash after pi persisted the wake as a user
// message entry, before the receipt write. Does recovery avoid a blind duplicate?
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createArchitectExtension } from "../pi-extension/qq-architect.mjs";
import { readJob, writeJob } from "../workflow/jobs.mjs";
import { completedEventId, readNotification, notificationPath } from "../workflow/notify.mjs";
import { createWorkflow } from "../workflow/operations.mjs";
import { callHandlers, piRuntimeDouble, runnerSpawner, tempRepo, tickQueue, waitForJobTerminal } from "../tests/support/architect-fixtures.mjs";

const { root, env } = await tempRepo({});
const stateDir = join(root, ".architect", "state");
const sessionEnv = (k) => ({ ...env, PASEO_AGENT_ID: k, QQ_ARCHITECT_OWNER_AGENT_ID: k });

for (const legacy of [false, true]) {
  const key = `idle-r4-${legacy}`;
  const build = (pi, response) => {
    const ticks = tickQueue();
    const extension = createArchitectExtension(pi, {
      env: sessionEnv(key), cwd: root, interactive: true,
      schedule: ticks.schedule, scheduleReceipt: ticks.schedule,
      workflowFactory: (config) => createWorkflow({ ...config, spawnFn: runnerSpawner({ response }) }),
    });
    extension.registerTools(extension.tools.map((t) => t.parameters));
    return { extension, ticks };
  };
  const beforePi = piRuntimeDouble({ idle: true, sessionFile: join(root, `${key}.jsonl`) });
  const before = build(beforePi, 'IDLE-R4-FINDINGS');
  await callHandlers(beforePi, 'session_start', { reason: 'startup' }, beforePi.ctx);
  const wf = before.extension.ensureWorkflow();
  const dispatched = wf.dispatchRunner({ task: 'idle r4 probe' });
  await waitForJobTerminal(stateDir, dispatched.jobId, { requireDelivery: true });
  const job = readJob(stateDir, dispatched.jobId), eventId = completedEventId(job);
  const wakeText = beforePi.sent.find(e => e.kind === 'user').content;
  // pi retains the wake as a regular user message entry (the receipt source)...
  await beforePi.wakeUser(wakeText);
  // ...and the process dies BEFORE the deferred receipt check wrote the ack.
  if (legacy) {
    // Old-release shape: the record claims delivered with a confirmed:false turn-started receipt.
    const receipt = { kind: 'turn-started', eventId, confirmed: false, at: Date.now() };
    writeJob(stateDir, { ...job, delivery: { ...job.delivery, state: 'delivered', receipt } });
    const path = notificationPath(stateDir, eventId);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...raw, state: 'delivered', receipt }));
  }
  console.log(`\n=== legacy=${legacy} pre-recovery job.delivery.state=${readJob(stateDir, job.id).delivery.state} notification.state=${readNotification(stateDir, eventId).state}`);

  // Reopened session whose persisted entries already contain the wake text.
  const afterPi = piRuntimeDouble({ idle: true, sessionFile: join(root, `${key}.jsonl`) });
  await afterPi.wakeUser(wakeText); // entry pi persisted before the crash
  afterPi.sent.length = 0;
  const after = build(afterPi);
  await callHandlers(afterPi, 'session_start', { reason: 'startup' }, afterPi.ctx);
  const recovered = await after.ticks.flush().then(() => after.extension.whenReady());
  const replayed = recovered.delivery.replayed.filter(e => e.jobId === dispatched.jobId).length;
  const reconciled = recovered.delivery.reconciled.filter(e => e.jobId === dispatched.jobId).length;
  const wakes = afterPi.sent.filter(e => e.kind === 'user').length;
  console.log(`replayed=${replayed} reconciled=${reconciled} duplicate-wakes-sent=${wakes}`);
  assert.equal(replayed, 0, "retained idle wake is reconciled instead of replayed");
  assert.equal(reconciled, 1);
  assert.equal(wakes, 0, "crash after persisted idle wake must not duplicate it");
  assert.equal(readJob(stateDir, job.id).delivery.state, "delivered");
  assert.equal(readNotification(stateDir, eventId).receipt.kind, "session-user-message");

  // Progress uses the same production transport but its own event journal.
  // Even if its caller replays after a receipt-write crash, the exact retained
  // message is observed before any new insertion.
  const progressText = `runner ${job.id} progress 4: retained milestone`;
  await afterPi.wakeUser(progressText);
  afterPi.sent.length = 0;
  const progress = await after.extension.transport.deliver({
    eventId: `${job.id}:progress:4`, jobId: job.id, role: "runner", text: progressText,
  });
  assert.equal(progress.state, "delivered");
  assert.equal(progress.receipt.kind, "session-user-message");
  assert.equal(afterPi.sent.length, 0, "retained progress wake is not duplicated");
  if (legacy) {
    const current = readJob(stateDir, job.id);
    const oldReceipt = { kind: "turn-started", eventId, confirmed: false, at: Date.now() };
    writeJob(stateDir, { ...current, delivery: { ...current.delivery, state: "delivered", receipt: oldReceipt } });
    const path = notificationPath(stateDir, eventId);
    const journal = JSON.parse(readFileSync(path, "utf8"));
    // Independently confirmed external delivery with no structured Pi receipt.
    writeFileSync(path, JSON.stringify({ ...journal, state: "delivered", receipt: null }));
    const mixed = await wf.recoverDeliveries({ evidence: { entries: [], pendingMessages: false },
      transport: { name: "no-replay", deliver: async () => { throw Error("unexpected replay"); } } });
    assert.equal(mixed.delivery.replayed.length, 0);
    assert.equal(mixed.delivery.reconciled.length, 1);
    const projected = readJob(stateDir, job.id).delivery;
    assert.equal(projected.state, "delivered");
    assert.equal(projected.receipt, null, "confirmed journal cannot inherit an unconfirmed receipt");
    assert.equal(projected.legacyUnconfirmedReceipt.confirmed, false, "old evidence remains explicitly historical");
  }
  console.log(`PASS idle receipt-write crash recovery (legacy=${legacy}), progress replay and mixed journal evidence`);
}
