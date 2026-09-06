import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../../paseo-plugin/host/store.mjs';
import { createRuntime } from '../../paseo-plugin/host/runtime.mjs';
import { createResponsesAccumulator, completeArchitect } from '../../paseo-plugin/host/model.mjs';
import { runArchitectTurn } from '../../paseo-plugin/host/loop.mjs';
import { extractResearcherAnswer, execFileWithInput } from '../../paseo-plugin/host/researcher.mjs';
const dir = await mkdtemp(join(tmpdir(), 'architect-durability-'));
try {
  const path = join(dir, 'state.sqlite');
  let store = createStore(path);
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const runtime = createRuntime({ store, settleWork: () => gate });
  const job = { id: 'child', role: 'implementer', kind: 'bounded', status: 'running', cwd: dir, parent: 'architect' };
  runtime.jobs.set(job.id, job);
  const receipt = await runtime.handleTool('done', { answer: 'complete' }, { jobId: job.id });
  assert.equal(receipt.accepted, true);
  assert.deepEqual(await runtime.handleTool('done', {}, { jobId: job.id }), receipt);
  assert.equal(store.get('completion', job.id).answer, 'complete');
  finish(); await runtime.flush();
  const wake = runtime.queueWake('architect', 'answer and sources');
  assert.deepEqual(runtime.takeWakes('architect'), [{ id: wake, text: 'answer and sources' }]);
  assert.equal(runtime.takeWakes('architect').length, 1);
  const active = store.begin('execution', { command: 'touch marker' });
  assert.throws(() => store.begin('execution'), /UNIQUE/);
  store.finish(active, { returncode: 0 });
  assert.throws(() => store.finish(active, {}), /stale/);
  store.close(); store = createStore(path);
  assert.deepEqual(store.get('receipt', job.id), receipt);
  assert.equal(store.wakes('architect')[0].id, wake);
  store.ack('architect', [wake]); assert.deepEqual(store.wakes('architect'), []);
  store.close();

  for (const end of [null, { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]) {
    const acc = createResponsesAccumulator();
    await acc.push({ type: 'response.output_item.done', item: { type: 'function_call', name: 'ticket_write', arguments: '{"text":"bad"}', call_id: 'c' } });
    if (end) await acc.push(end);
    assert.throws(() => acc.result(), /incomplete|exhaustion/);
  }
  const controller = new AbortController();
  const cancelled = completeArchitect({ auth: { accessToken: 'test' }, signal: controller.signal, fetchFn: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))) });
  controller.abort(new Error('cancelled'));
  await assert.rejects(cancelled, /cancelled/);
  await assert.rejects(runtime.handleTool('delegate', {}, { role: 'teacher', cwd: dir }), /cannot execute/);
  await assert.rejects(runtime.handleTool('zvec_grep_index_drop', {}, { role: 'teacher', cwd: dir }), /cannot execute/);
  const echo = await execFileWithInput('python3', ['-c', 'import sys; sys.stdout.write(sys.stdin.read())'], { input: 'actual Python stdin', encoding: 'utf8' });
  assert.equal(echo.stdout, 'actual Python stdin');
  const answer = 'The answer.\nhttps://example.com/source';
  assert.equal(extractResearcherAnswer(JSON.stringify({ version: 1, kind: 'research_completion', ok: true, answer })), answer);
  assert.throws(() => extractResearcherAnswer('Final answer: guessed'), /not JSON/);
  assert.throws(() => extractResearcherAnswer(JSON.stringify({ version: 1, kind: 'research_completion', ok: false, error: { message: 'HTTP 400: oversized context', failureClass: 'permanent', attempts: ['HTTP 400'] } })), error => error.failureClass === 'permanent' && error.attempts.length === 1);
} finally { await rm(dir, { recursive: true, force: true }); }
console.log('durability, role execution, cancellation, envelopes and Python transport passed');

// A restarted host resumes a received completion, but never replays an ambiguous landing.
const restartDir = await mkdtemp(join(tmpdir(), 'architect-restart-'));
try {
  const database = join(restartDir, 'state.sqlite');
  let journal = createStore(database);
  journal.receive({ id: 'received', role: 'teacher', status: 'running', cwd: restartDir, parent: 'parent', parked_question: 'choice?' }, { answer: 'Chosen option. source.md' });
  journal.put('job', 'publication', { id: 'publication', role: 'implementer', status: 'running', phase: 'landing', cwd: restartDir, parent: 'parent', kind: 'bounded' });
  journal.close(); journal = createStore(database);
  let landed = 0;
  const host = createRuntime({ store: journal, settleWork: async () => { landed++; } });
  await host.reconcile(); await host.flush();
  assert.equal(landed, 0);
  assert.equal(host.jobs.get('received').status, 'succeeded');
  assert.equal(host.jobs.get('publication').status, 'uncertain');
  const wakes = host.peekWakes('parent');
  assert.equal(wakes.length, 2);
  assert.match(wakes.find(wake => wake.id === 'received:completion').text, /Chosen option/);
  journal.close();
  journal = createStore(database);
  assert.deepEqual(journal.wakes('parent'), wakes, 'disconnect/reload preserves wake IDs and payloads');
  journal.close();
} finally { await rm(restartDir, { recursive: true, force: true }); }
