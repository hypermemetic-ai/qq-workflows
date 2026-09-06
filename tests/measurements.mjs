import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../paseo-plugin/host/store.mjs';
import { architectMeasurements } from '../paseo-plugin/host/measurements.mjs';
import { conversationTokens } from '../paseo-plugin/host/fold.mjs';
const directory = mkdtempSync(join(tmpdir(), 'architect-metrics-'));
const path = join(directory, 'state.sqlite');
let store = createStore(path);
try {
  function record(id, { sessionId = 'session', status = 'completed', reasoning = 30, tools = false, source = 'operator' } = {}) {
    store.put('architect_turn', id, { version: 1, sessionId, cwd: '/project', source, status, startedAt: 1 });
    const operation = `${id}:model:request`;
    const request = { input: [{ role: 'user', content: 'huge pinned ticket' },
      { type: 'function_call_output', call_id: 'previous-turn-call', output: 'old huge tool output'.repeat(1000) },
      { role: 'user', content: 'question' }] };
    const response = { text: 'answer', toolCalls: tools ? [{ id: 'call', name: 'search', arguments: { query: 'x' } }] : [],
      raw: { id: `response-${id}`, output: tools ? [{ type: 'function_call', name: 'search', call_id: 'call', arguments: '{"query":"x"}' }] : [],
        usage: { input_tokens: 5000, output_tokens_details: reasoning == null ? {} : { reasoning_tokens: reasoning } } } };
    const failed = store.begin(operation, { request }); store.finish(failed, { message: 'transient failure' });
    const attempt = store.begin(operation, { request }); store.finish(attempt, response);
    // Repeated persisted response and output must not count twice.
    const repeat = store.begin(operation, { request }); store.finish(repeat, response);
    if (tools) store.put('turn', id, { input: [{ type: 'function_call_output', call_id: 'call', output: 'found' }], outputs: [{ type: 'function_call_output', call_id: 'call', output: 'found' }] });
  }
  record('a', { tools: true });
  record('aborted', { status: 'aborted', reasoning: null });
  record('b'); record('other', { sessionId: 'another' });
  record('unknown', { reasoning: null }); record('after-unknown');
  record('between', { source: 'wake' }); record('last');
  const ignored = store.begin('unlabelled:model:old', {}); store.finish(ignored, { text: 'legacy' });
  store.close(); store = null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const report = architectMeasurements(db);
    assert.deepEqual(report.statusCounts, { completed: 7, aborted: 1 });
    assert.equal(report.sessions, 2);
    assert.equal(report.twoTurnTokens.samples, 3, 'never bridge sessions or missing accounting');
    const first = report.turns[0];
    assert.equal(first.modelResponses, 1);
    assert.equal(first.providerAttempts, 3);
    assert.equal(first.unsuccessfulAttempts, 1);
    assert.equal(first.tokens.toolOutputs, conversationTokens('found'));
    assert.equal(first.reasoningTokens, 30);
    assert.equal(first.peakProviderInputTokens, 5000);
    assert.equal(first.estimatedFullTokens, Object.values(first.tokens).reduce((a, b) => a + b, 0) + 30);
    assert.equal(report.turns.find(turn => turn.id === 'unknown').estimatedFullTokens, null);
    assert.equal(JSON.stringify(report).includes('huge pinned ticket'), false);
    assert.equal(JSON.stringify(report).includes('old huge tool output'), false);
    assert.equal(architectMeasurements(db, { cwd: '/another-project' }).turns.length, 0);
    assert.equal(architectMeasurements(db, { source: 'wake' }).turns.length, 1);
    assert.equal(architectMeasurements(db, { source: 'operator' }).twoTurnTokens.samples, 1, 'filtering wakes must not manufacture adjacent operator pairs');
  } finally { db.close(); }
} finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
console.log('Durable Architect-only measurements, full accounting, retry deduplication, missing usage and session boundaries passed');
