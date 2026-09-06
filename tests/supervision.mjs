import assert from 'node:assert/strict';
import { createStore } from '../paseo-plugin/host/store.mjs';
import { createCircuit } from '../paseo-plugin/host/recovery.mjs';
import { createSupervisor } from '../paseo-plugin/host/supervisor.mjs';
import { createProviderProxy } from '../paseo-plugin/host/providers/provider-proxy.mjs';
import { reconcileWithSdk } from '../paseo-plugin/host/spawn-agent.mjs';
import { mapOcrJson } from '../paseo-plugin/host/workflow/ocr.mjs';

const store = createStore(':memory:');
const jobs = new Map([['job', { id: 'job', role: 'implementer', status: 'running', delegationId: 'delegation' }]]);
const circuit = createCircuit({ store });
let supervise = createSupervisor({ store, jobs, circuit, random: () => 0 });
for (let n = 1; n <= 3; n++) {
  const { attemptId } = await supervise({ jobId: 'job', event: 'begin', operation: 'model:1', value: { kind: 'model', scope: 'provider', request: { messages: ['observation'] } } });
  const reply = await supervise({ jobId: 'job', event: 'failure', operation: 'model:1', attemptId, value: { message: 'HTTP 503 actual provider message', failureClass: 'transient', retryAfter: '2' } });
  assert.equal(reply.retry, n < 3);
  if (reply.retry) assert.equal(reply.delayMs, 2000);
  else assert.equal(reply.attempts.length, 3);
  await assert.rejects(supervise({ jobId: 'job', event: 'success', operation: 'model:1', attemptId, value: {} }), /stale/);
}
assert.equal(store.get('ledger', 'delegation').recoveryActions, 2);
for (let n = 0; n < 5; n++) {
  assert.equal((await supervise({ jobId: 'job', event: 'loop_before', value: { name: 'bash', args: { command: 'cat a' } } })).action, 'allow');
  const decision = await supervise({ jobId: 'job', event: 'loop', value: { name: 'bash', args: { command: 'cat a' }, result: 'unchanged' } });
  if (n === 2) assert.equal(decision.action, 'warn');
}
supervise = createSupervisor({ store, jobs, circuit });
assert.equal((await supervise({ jobId: 'job', event: 'loop_before', value: { name: 'bash', args: { command: 'cat a' } } })).action, 'stop');
assert.equal((await supervise({ jobId: 'job', event: 'loop_before', value: { name: 'bash', args: { command: 'cat b' } } })).action, 'allow');
await supervise({ jobId: 'job', event: 'restart' });
await assert.rejects(supervise({ jobId: 'job', event: 'restart' }), /allowance exhausted/);
await supervise({ jobId: 'job', event: 'repair' });
await assert.rejects(supervise({ jobId: 'job', event: 'repair' }), /repair exhausted/);

let calls = 0;
const proxyStore = createStore(':memory:');
const proxy = await createProviderProxy({ endpoint: 'https://provider.invalid', token: 'test', model: 'grok-4.6', jobId: 'review', store: proxyStore, sleep: async () => {}, random: () => 0, fetchFn: async () => { calls++; return new Response('provider unavailable', { status: 503 }); } });
try {
  const request = () => fetch(proxy.url + '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: ['retained observations'] }) });
  const failed = await request();
  assert.equal(failed.status, 503); assert.equal(failed.headers.get('x-should-retry'), 'false');
  assert.equal(calls, 3);
  await request(); assert.equal(calls, 3, 'a lower-level retry must reuse the final outcome');
  assert.equal(proxy.failures[0].attempts.length, 3);
  assert.equal(proxyStore.get('ledger', 'review').recoveryActions, 2);
} finally { await proxy.close(); proxyStore.close(); }
const permanentStore = createStore(':memory:'); calls = 0;
const permanent = await createProviderProxy({ endpoint: 'https://provider.invalid', token: 'test', model: 'grok-4.6', jobId: 'review', store: permanentStore, fetchFn: async () => { calls++; return new Response('context too large', { status: 400 }); } });
try {
  const failed = await fetch(permanent.url + '/v1/chat/completions', { method: 'POST', body: '{}' });
  assert.equal(failed.status, 400); assert.equal(calls, 1); assert.equal(permanent.failures[0].failureClass, 'permanent');
} finally { await permanent.close(); permanentStore.close(); }
const schemaStore = createStore(':memory:');
let forwarded;
const schemaProxy = await createProviderProxy({ endpoint: 'https://provider.invalid', token: 'test', model: 'grok-4.6', jobId: 'schema-review', store: schemaStore,
  fetchFn: async (url, options) => { forwarded = JSON.parse(options.body); return new Response('{}'); } });
try {
  const payload = { messages: [{ role: 'user', content: 'Preserve input' }], tools: [
    { name: 'done', input_schema: { type: 'object', required: null } },
    { type: 'function', function: { name: 'done', parameters: { type: 'object', required: null } } },
    { name: 'read', input_schema: { type: 'object', required: ['path'] } },
  ] };
  const result = await fetch(schemaProxy.url + '/v1/messages', { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(result.status, 200);
  assert.deepEqual(forwarded.messages, payload.messages);
  assert.deepEqual(forwarded.tools[0].input_schema.required, []);
  assert.deepEqual(forwarded.tools[1].function.parameters.required, []);
  assert.deepEqual(forwarded.tools[2], payload.tools[2]);
} finally { await schemaProxy.close(); schemaStore.close(); }
const child = { id: 'existing', labels: { job: 'job' }, cwd: '/worktree', status: 'running' };
assert.equal((await reconcileWithSdk('job', { client: { agents: { list: async () => ({ entries: [{ agent: child }] }) } } })).id, 'existing');
await assert.rejects(reconcileWithSdk('job', { client: { agents: { list: async () => ({ entries: [{ agent: child }, { agent: child }] }) } } }), /Multiple children/);
for (const payload of [{ comments: [], status: 'partial' }, { comments: [], summary: { budget_exceeded: true } }, { comments: [], manifest: { coverage: { failed: ['a'] } } }, { comments: [{ path: 'a', body: 'issue', line: 'invalid' }] }]) assert.throws(() => mapOcrJson(payload));
store.close();
console.log('Host budgets, retry suppression, permanent errors, persisted repetition, stale results, spawn reconciliation and fail-closed reviews passed');
const { createTextGuard } = await import('../paseo-plugin/host/providers/text-loop.mjs');
const passage = 'A'.repeat(127) + 'B';
const textGuard = createTextGuard();
textGuard.push(passage); textGuard.push(passage);
assert.equal(textGuard.push(passage).action, 'warn');
textGuard.push(passage); textGuard.push(passage);
assert.throws(() => textGuard.push(passage), /degeneration/);
const healthy = createTextGuard();
for (let n = 0; n < 100; n++) healthy.push(`Distinct observation ${n} with continued useful reasoning. `);
