import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { architectMeasurements } from '../paseo-plugin/host/measurements.mjs';
const root = mkdtempSync(join(tmpdir(), 'architect-acp-metrics-'));
mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'repo'));
writeFileSync(join(root, 'bin', 'zg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
let requestCount = 0, held;
const waiting = new Promise(resolve => { held = resolve; });
const requests = [];
const server = createServer(async (req, res) => {
  if (req.url === '/wakes') return; // Real cancellation closes this long poll.
  let body = ''; for await (const part of req) body += part;
  const input = JSON.parse(body || '{}');
  if (req.url === '/tool') { res.end(JSON.stringify({ result: 'fixture tool result' })); return; }
  requests.push(input); requestCount++;
  if (input.input.at(-1)?.content === 'hold') { held(); return; }
  const output = [{ type: 'reasoning', id: `r${requestCount}`, encrypted_content: 'opaque', summary: [] }];
  if (requestCount === 1) output.push({ type: 'function_call', call_id: 'fixture-call', name: 'ticket_write', arguments: '{"text":"fixture"}' });
  else output.push({ type: 'message', id: `m${requestCount}`, role: 'assistant', content: [{ type: 'output_text', text: `answer ${requestCount}` }] });
  res.setHeader('Content-Type', 'text/event-stream');
  res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `response${requestCount}`, status: 'completed', output,
    usage: { input_tokens: 1500, output_tokens_details: { reasoning_tokens: 17 } } } })}\n\n`);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
let worker, pending = new Map(), notifications = [], nextId = 0, diagnostics = "";
function start() {
  worker = spawn(process.execPath, [resolve('paseo-plugin/host/acp.mjs')], { env: { ...process.env,
    PASEO_HOME: join(root, 'home'), ARCHITECT_HOST: url, OPENAI_API_KEY: 'fixture', OPENAI_BASE_URL: url + '/responses',
    PATH: join(root, 'bin') + ':' + process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
  worker.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-2000); });
  createInterface({ input: worker.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.id == null) { notifications.push(message); return; }
    const waiter = pending.get(message.id); pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
  });
}
function rpc(method, params = {}) {
  const id = ++nextId;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ACP timeout: ${method}; ${diagnostics}`)), 15000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  });
  worker.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return promise;
}
async function stop() {
  if (!worker || worker.exitCode != null || worker.signalCode != null) return;
  const exited = once(worker, 'exit');
  await rpc('shutdown'); worker.kill('SIGTERM'); await exited;
}
try {
  start(); await rpc('initialize');
  const { sessionId } = await rpc('session/new', { cwd: join(root, 'repo') });
  const prompt = (text, messageId) => rpc('session/prompt', { sessionId, messageId, prompt: text });
  await prompt('first question', 'u1');
  await prompt('second question', 'u2');
  assert.ok(requests[2].input.some(item => item.type === 'function_call_output'));
  assert.ok(requests[2].input.some(item => item.type === 'reasoning'));
  await stop(); start(); await rpc('initialize'); await rpc('session/load', { sessionId });
  await prompt('third question', 'u3');
  assert.ok(!JSON.stringify(requests[3].input).includes('first question'));
  assert.ok(JSON.stringify(requests[3].input).includes('second question'));
  const failed = assert.rejects(prompt('hold', 'u4'), /abort/i);
  await waiting; worker.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }) + '\n'); await failed;
  const windows = notifications.filter(item => item.method === '_paseo/context_window');
  assert.deepEqual(windows.at(-1).params.userMessageIds, ['u2', 'u3']);
  await stop();
  const db = new DatabaseSync(join(root, 'home', 'architect', 'state.sqlite'), { readOnly: true });
  try {
    const report = architectMeasurements(db);
    assert.deepEqual(report.statusCounts, { completed: 3, aborted: 1 });
    assert.equal(report.twoTurnTokens.samples, 2);
    assert.equal(report.turns[0].reasoningTokens, 34);
    assert.equal(report.turns[0].toolCalls, 1);
    assert.equal(report.turns[0].missingToolOutputs, 0);
    assert.equal(report.turns.at(-1).estimatedFullTokens, null);
  } finally { db.close(); }
  console.log('Actual ACP: full two-turn replay, restart, cancellation, shared cutoff and persisted usage labels passed');
} finally {
  if (worker && worker.exitCode == null && worker.signalCode == null) { const exited = once(worker, 'exit'); worker.kill('SIGTERM'); await exited; }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
