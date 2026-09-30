#!/usr/bin/env node
// Optional offline check against the deployed SDK. No constructor, auth, model
// calls, real compaction, disk session, or installed-package mutations.
// PI_ARCHITECT_SDK_ROOT points to the coding-agent package directory.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// Baseline mode can load an extracted pre-fix extension without changing the
// worktree or installed release. Normal verification always uses this worktree.
const { createArchitectExtension } = await import(process.env.PI_ARCHITECT_BASELINE_EXTENSION && process.argv.includes('--baseline')
  ? pathToFileURL(process.env.PI_ARCHITECT_BASELINE_EXTENSION).href
  : '../pi-extension/qq-architect.mjs');
import { createWorkflow } from '../workflow/operations.mjs';
import { completedEventId, readNotification } from '../workflow/notify.mjs';
import { createJob, readJob, recordTerminal } from '../workflow/jobs.mjs';
import { callHandlers, fakePi, runnerSpawner, tempRepo, tickQueue, waitForJobTerminal } from './support/architect-fixtures.mjs';

if (!process.env.PI_ARCHITECT_SDK_ROOT) {
  console.log('SKIP architect compaction SDK check: set PI_ARCHITECT_SDK_ROOT');
  process.exit(0);
}
const sdk = process.env.PI_ARCHITECT_SDK_ROOT;
const { AgentSession } = await import(pathToFileURL(join(sdk, 'dist/core/agent-session.js')));
const { SessionManager } = await import(pathToFileURL(join(sdk, 'dist/core/session-manager.js')));
const { root, env } = await tempRepo();
let sequence = 0;
function fixture() {
  const key = `sdk-owner-${++sequence}`;
  const pi = fakePi();
  const tasks = tickQueue();
  const receipts = tickQueue();
  const manager = SessionManager.inMemory(root);
  const host = Object.create(AgentSession.prototype);
  const errors = [], queue = [], turns = [];
  Object.assign(host, {
    sessionManager: manager, _isAgentRunActive: false,
    _steeringMessages: [], _followUpMessages: [], _pendingCustomMessages: [],
    _pendingBashMessages: [], _pendingNextTurnMessages: [],
    _baseSystemPromptOptions: { selectedTools: [] },
    _modelRuntime: { hasConfiguredAuth: () => true },
    agent: {
      state: { model: { provider: 'offline', id: 'offline' }, messages: [] },
      steer: message => queue.push(message), followUp: message => queue.push(message),
      hasQueuedMessages: () => queue.length > 0,
      async prompt(messages) {
        turns.push(messages);
        for (const message of Array.isArray(messages) ? messages : [messages]) await retain(message);
      },
    },
    _extensionRunner: {
      hasHandlers: () => false,
      emitBeforeAgentStart: async (_text, _images, systemPromptOptions) => ({ systemPromptOptions, messages: [] }),
    },
    _recordSelection() {}, _preparePromptAndToolLoadout() {},
    getActiveToolNames: () => [], _handlePostAgentRun: async () => false,
    _runBeforeSettleBoundary: async () => false,
    _emitAgentSettled: async () => { host._isAgentRunActive = false; await callHandlers(pi, 'agent_settled', {}, ctx); },
  });
  const ctx = {
    sessionManager: manager, isIdle: () => host.isIdle,
    hasPendingMessages: () => host.pendingMessageCount > 0,
    getContextUsage: () => ({ tokens: 950, contextWindow: 1000 }),
    compact(options) { host._compactionAbortController = new AbortController(); ctx.compactOptions = options; },
  };
  async function retain(message) {
    await callHandlers(pi, 'message_start', { message }, ctx);
    await callHandlers(pi, 'message_end', { message }, ctx);
    if (message.role === 'custom') manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    else manager.appendMessage(message);
  }
  // Exactly the 0.99.1 bindCore catch-and-return-void semantics. Returning the
  // promise here would hide the production defect.
  pi.sendMessage = (message, options) => {
    pi.sent.push({ kind: 'message', message, options });
    host.sendCustomMessage(message, options).catch(error => errors.push(error));
  };
  pi.sendUserMessage = (text, options) => {
    pi.sent.push({ kind: 'user', content: text, options });
    host.sendUserMessage(text, options).catch(error => errors.push(error));
  };
  const makeExtension = () => createArchitectExtension(pi, {
    env: { ...env, PASEO_AGENT_ID: key, QQ_ARCHITECT_OWNER_AGENT_ID: key }, cwd: root,
    interactive: true, schedule: tasks.schedule, scheduleReceipt: receipts.schedule,
    compaction: { reserveTokens: 100, minIntervalMs: 0 },
    workflowFactory: config => createWorkflow({ ...config, spawnFn: runnerSpawner() }),
  });
  const extension = makeExtension();
  // SessionManager.inMemory has no session file; the readonly evidence contract
  // needs a stable handle, not an actual file.
  manager.getSessionFile = () => join(root, `${key}.jsonl`);
  return { key, pi, ctx, host, manager, extension, makeExtension, tasks, receipts, errors, turns, queue, retain };
}
async function microtasks() { for (let i = 0; i < 30; ++i) await Promise.resolve(); }

if (process.argv.includes('--baseline')) {
  const f = fixture();
  await callHandlers(f.pi, 'session_start', { reason: 'startup' }, f.ctx);
  await f.extension.maybeCompact(f.ctx);
  assert.equal(f.host.isIdle, false, 'real 0.99.1 excludes compaction from idle');
  // SDK refusal is swallowed by the binding, not thrown to the extension.
  assert.equal(f.pi.sendUserMessage('refused', { deliverAs: 'steer' }), undefined);
  await microtasks();
  assert.match(f.errors[0].message, /compaction is in progress/);
  const result = await f.extension.transport.deliver({ eventId: 'baseline:terminal', text: 'completed' });
  await microtasks();
  assert.equal(result.state, 'queued');
  assert.equal(f.manager.getEntries().filter(e => e.type === 'custom_message').length, 1);
  assert.equal(f.turns.length, 0, 'BUG: retained completion did not wake the owner');
  console.log('REPRODUCED 0.99.1: swallowed async prompt refusal; completion retained, zero turn starts');
  process.exit(0);
}

for (const outcome of ['completed', 'failed', 'cancelled']) {
  const f = fixture();
  await callHandlers(f.pi, 'session_start', { reason: 'startup' }, f.ctx);
  const wf = f.extension.ensureWorkflow();
  const running = wf.dispatchRunner({ task: 'completion during profile compaction' });
  await f.extension.maybeCompact(f.ctx);
  const job = await waitForJobTerminal(wf.stateDir, running.jobId, { requireDelivery: true });
  const eventId = completedEventId(readJob(wf.stateDir, running.jobId));
  assert.equal(job.delivery.state, 'failed');
  assert.equal(readNotification(wf.stateDir, eventId).attempt.settled, true);
  assert.equal(f.pi.sent.length, 0);
  assert.deepEqual(f.extension.sessionEvidence(f.ctx).inFlight, []);
  assert.equal(f.extension.state.receipts.size, 0);
  if (outcome === 'completed') {
    await callHandlers(f.pi, 'session_compact', {}, f.ctx);
    await f.tasks.flush(); // event is before controller clear: no premature send
    assert.equal(f.pi.sent.length, 0);
  }
  f.host._compactionAbortController = undefined;
  if (outcome === 'completed') f.ctx.compactOptions.onComplete({});
  else {
    await callHandlers(f.pi, 'session_compact_failed', { aborted: outcome === 'cancelled' }, f.ctx);
    f.ctx.compactOptions.onError(new Error(outcome));
  }
  await f.tasks.flush();
  await microtasks();
  await f.receipts.flush();
  assert.equal(f.turns.length, 1, 'automatic post-controller recovery starts a real SDK turn');
  assert.equal(readNotification(wf.stateDir, eventId).state, 'delivered');
  assert.equal(readJob(wf.stateDir, running.jobId).status, 'completed');
  assert.equal(readJob(wf.stateDir, running.jobId).terminal.reportId, job.terminal.reportId);
  assert.equal(f.extension.ensureWorkflow().session().sessionKey, f.key);
  assert.equal(f.manager.getSessionId(), f.ctx.sessionManager.getSessionId());
  await callHandlers(f.pi, 'session_shutdown', {}, f.ctx);
}

// Native/manual compaction, including failed/cancelled paths. No profile callback.
for (const event of ['session_compact', 'session_compact_failed']) {
 for (const prolongedDispatch of [false, true]) {
  const f = fixture();
  await callHandlers(f.pi, 'session_start', { reason: 'startup' }, f.ctx);
  f.host._compactionAbortController = new AbortController();
  await callHandlers(f.pi, 'session_before_compact', {}, f.ctx);
  const wf = f.extension.ensureWorkflow();
  const run = wf.dispatchRunner({ task: 'native compaction completion' });
  await waitForJobTerminal(wf.stateDir, run.jobId, { requireDelivery: true });
  assert.equal(f.pi.sent.length, 0);
  await callHandlers(f.pi, event, {}, f.ctx);
  if (prolongedDispatch) {
    await f.tasks.flush();
    assert.equal(f.pi.sent.length, 0);
  }
  f.host._compactionAbortController = undefined;
  if (prolongedDispatch) {
    // Drive the existing supervisor tick, not the operator recovery command.
    await f.extension.runReadyTick('supervision');
  } else await f.tasks.flush();
  await microtasks(); await f.receipts.flush();
  assert.equal(f.turns.length, 1);
  await callHandlers(f.pi, 'session_shutdown', {}, f.ctx);
 }
}

// A busy sample that becomes idle at actual custom admission must start a run.
const race = fixture();
await callHandlers(race.pi, 'session_start', { reason: 'startup' }, race.ctx);
race.ctx.getContextUsage = () => null;
race.ctx.isIdle = () => false;
const raced = await race.extension.transport.deliver({ eventId: 'race:terminal', text: 'failure report remains failure' });
await microtasks(); await race.receipts.flush();
assert.equal(raced.state, 'queued');
assert.equal(race.turns.length, 1);
assert.equal(race.manager.getEntries().filter(e => e.type === 'custom_message').length, 1);
const replay = await race.extension.transport.deliver({ eventId: 'race:terminal', text: 'failure report remains failure' });
assert.equal(replay.state, 'delivered');
assert.equal(race.turns.length, 1);

// Ordinary asynchronous refusal before custom run admission: not in-flight.
// The real SDK method rejects its promise; the binding catches and returns void.
const refused = fixture();
await callHandlers(refused.pi, 'session_start', { reason: 'startup' }, refused.ctx);
refused.host._recordSelection = () => { throw new Error('offline admission refusal'); };
const refusal = await refused.extension.transport.deliver({ eventId: 'refused:terminal', text: 'available report' });
await microtasks();
assert.equal(refusal.state, 'unknown');
assert.equal(refused.errors.length, 1);
assert.equal(refused.turns.length, 0);
assert.deepEqual(refused.extension.sessionEvidence(refused.ctx).inFlight, []);
refused.host._recordSelection = () => {};
refused.ctx.getContextUsage = () => null;
await refused.extension.transport.deliver({ eventId: 'refused:terminal', text: 'available report' });
await microtasks();
assert.equal(refused.turns.length, 1);

// Genuine busy admission is on the real SDK's agent steering queue. A module
// reload must preserve that exact claim while keeping another job untouched.
const busy = fixture();
await callHandlers(busy.pi, 'session_start', { reason: 'startup' }, busy.ctx);
busy.ctx.getContextUsage = () => null;
const busyWf = busy.extension.ensureWorkflow();
const failedJob = createJob({ stateDir: busyWf.stateDir, id: 'sdk-failed-job', role: 'runner', workflow: busyWf.session() });
recordTerminal(busyWf.stateDir, failedJob.id, { status: 'failed', summary: 'Authoritative failure, not a success' });
const liveJob = createJob({ stateDir: busyWf.stateDir, id: 'sdk-still-running', role: 'runner', workflow: busyWf.session(), process: { pid: process.pid } });
const nativeId = busy.manager.getSessionId();
busy.host._isAgentRunActive = true;
await busy.extension.runReadyTick('supervision');
assert.equal(busy.queue.length, 1);
assert.equal(busy.turns.length, 0, 'busy steering never starts or interrupts a run');
const failedEvent = completedEventId(readJob(busyWf.stateDir, failedJob.id));
const attemptId = readNotification(busyWf.stateDir, failedEvent).attempt.id;
assert.deepEqual(busy.extension.sessionEvidence(busy.ctx).inFlight, [failedEvent]);
await callHandlers(busy.pi, 'session_shutdown', {}, busy.ctx);
busy.pi.handlers.clear();
const reloaded = busy.makeExtension();
await callHandlers(busy.pi, 'session_start', { reason: 'reload' }, busy.ctx);
for (let i = 0; i < 3; ++i) await reloaded.runReadyTick('supervision');
assert.equal(busy.queue.length, 1);
assert.equal(busy.pi.sent.length, 1);
assert.equal(readJob(busyWf.stateDir, liveJob.id).status, 'running');
assert.equal(readJob(busyWf.stateDir, failedJob.id).status, 'failed');
await busy.retain(busy.queue.shift());
await busy.receipts.flush();
const acknowledged = readNotification(busyWf.stateDir, failedEvent);
assert.equal(acknowledged.state, 'delivered');
assert.equal(acknowledged.attempt.id, attemptId);
assert.equal(busy.manager.getEntries().filter(entry => entry.type === 'custom_message').length, 1);
assert.equal(acknowledged.receipt.eventId, failedEvent);
assert.equal(readJob(busyWf.stateDir, failedJob.id).status, 'failed');
assert.equal(busy.manager.getSessionId(), nativeId);
assert.equal(reloaded.ensureWorkflow().session().sessionKey, busy.key);
await reloaded.runReadyTick('supervision');
assert.equal(busy.pi.sent.length, 1);

// Before compaction: idle custom admission marks the run active in the same
// task. The profile cannot begin compaction in the old user-preflight gap.
const before = fixture();
await callHandlers(before.pi, 'session_start', { reason: 'startup' }, before.ctx);
await before.extension.transport.deliver({ eventId: 'before:terminal', text: 'before compaction' });
assert.equal(before.host.isStreaming, true);
assert.equal((await before.extension.maybeCompact(before.ctx)).reason, 'streaming');
await microtasks(); await before.receipts.flush();
assert.equal(before.turns.length, 1);
assert.equal(before.errors.length, 0);

console.log('PASS real Pi SDK offline: compaction success/failure/cancel barriers and autonomous wake; before/during/after admission; busy→idle wake; queued reload dedup/identity/failure preservation; async refusal accounting');
