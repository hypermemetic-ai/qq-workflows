#!/usr/bin/env node
// Offline integration with the actual published modules; no Pi/model process is spawned.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, rename, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const manifest = JSON.parse(await readFile(new URL('../patches/paseo/0.10.2/manifest.json', import.meta.url)));
const official = path.join(homedir(), '.local/share/paseo/releases/0.10.2');
const candidate = process.argv[2] ?? path.join(homedir(), `.local/share/paseo/releases/0.10.2-qq-pi-admission.${manifest.patchSha256.slice(0, 16)}`);
const moduleRoot = root => path.join(root, 'lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server');
const load = (root, file) => import(pathToFileURL(path.join(moduleRoot(root), file)));
const logger = Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error'].map(key => [key, () => {}]));
logger.child = () => logger;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let n = 0; n < 500; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.fail('condition did not become true');
}
const agentId = '11111111-1111-4111-8111-111111111111';
const state = { sessionId: 'offline-pi', thinkingLevel: 'high', isStreaming: false, model: { provider: 'offline', id: 'fake', name: 'Fake', input: ['text'], contextWindow: 10000 } };
class FakeChild extends EventEmitter {
  constructor() {
    super(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.requests = []; this.pid = undefined;
    this.stdin = new Writable({ write: (chunk, _encoding, done) => {
      const request = JSON.parse(chunk.toString()); this.requests.push(request);
      if (!['prompt', 'steer'].includes(request.type)) {
        const data = request.type === 'get_state' ? state : request.type === 'get_commands' ? { commands: [] } : request.type === 'get_messages' ? { messages: [] } : {};
        this.reply(request, { success: true, data });
      }
      done();
    } });
  }
  kill(signal) { this.signalCode = signal; this.emit('exit', null, signal); return true; }
  frame(frame) { this.stdout.write(JSON.stringify(frame) + '\n'); }
  reply(request, extra) { this.frame({ type: 'response', id: request.id, command: request.type, ...extra }); }
  last(type = 'prompt') { return this.requests.filter(request => request.type === type).at(-1); }
  terminal(error) {
    this.frame({ type: 'agent_end', willRetry: false, messages: error ? [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: error }] : [] });
    this.frame({ type: 'agent_settled' });
  }
}
const allHarnesses = [];
async function harness(root = candidate, timeout = 1000) {
  const { PiCliRuntime } = await load(root, 'agent/providers/pi/cli-runtime.js');
  const { PiRpcAgentSession } = await load(root, 'agent/providers/pi/agent.js');
  const { AgentManager } = await load(root, 'agent/agent-manager.js');
  const { MessageReceipts } = await load(root, 'message-receipts/index.js');
  const { Session } = await load(root, 'session.js');
  const child = new FakeChild();
  const runtimeSession = await new PiCliRuntime({ logger, runtimeSettings: {}, requestTimeoutMs: timeout, spawnProcess: () => child }).startSession({ cwd: tmpdir() });
  const session = new PiRpcAgentSession({ logger, runtimeSession, config: { cwd: tmpdir() }, initialState: { ...state }, capabilities: { supportsStreaming: true, supportsSessionPersistence: true }, usagePollScheduler: { schedulePoll: () => () => {} } });
  const manager = new AgentManager({ logger, paseoToolsEnabled: false, agentStreamCoalesceWindowMs: 0 });
  await manager.registerSession(session, { provider: 'pi', cwd: tmpdir() }, agentId, { historyPrimed: true });
  const events = []; manager.subscribe(event => { if (event.type === 'agent_stream') events.push(event.event); });
  const directory = await mkdtemp(path.join(tmpdir(), 'paseo-admission-'));
  const storage = { get: async () => ({ title: 'Offline', lastUserMessageAt: 'already' }) };
  const responses = [];
  const context = {
    agentManager: manager, agentStorage: storage, messageReceipts: new MessageReceipts(directory),
    sessionLogger: logger, delivery: { requestSignal: new AbortController().signal },
    resolveAgentIdentifier: async () => ({ ok: true, agentId }),
    prepareAgentMessage: Session.prototype.prepareAgentMessage,
    handleAgentRunError: (_id, error) => { if (process.env.DEBUG_ADMISSION) console.error(error); }, emit: response => responses.push(response),
  };
  const send = (messageId = 'key', text = 'hello', activeTurnBehavior = 'interrupt') => Session.prototype.handleSendAgentMessageRequest.call(context, { agentId, requestId: 'request-' + responses.length, messageId, text, activeTurnBehavior });
  const receipts = async () => Promise.all((await readdir(directory)).filter(file => file.endsWith('.json')).map(async file => JSON.parse(await readFile(path.join(directory, file)))));
  const h = { child, runtimeSession, session, manager, events, directory, context, responses, send, receipts };
  allHarnesses.push(h); return h;
}
let passed = 0;
async function test(name, run) { const start = performance.now(); await run(); passed++; console.log(`ok ${passed} - ${name} (${((performance.now() - start) / 1000).toFixed(3)}s)`); }
try {
  await test('official false acceptance reproduced before delayed native refusal', async () => {
    const h = await harness(official); const pending = h.send();
    await until(() => h.child.last());
    await pending;
    assert.equal(h.responses[0].payload.accepted, true);
    assert.equal((await h.receipts())[0].state, 'completed');
    h.child.reply(h.child.last(), { success: false, error: 'Cannot prompt during manual compaction' });
    await tick();
  });
  for (const disposition of ['started', 'queued', 'handled']) {
    await test(`${disposition}: server and receipt wait for correlated native admission only`, async () => {
      const h = await harness(); let settled = false; const pending = h.send().then(() => settled = true);
      await until(() => h.child.last()); await tick();
      assert.equal(settled, false); assert.equal(h.responses.length, 0);
      assert.equal((await h.receipts())[0].state, 'pending');
      assert.equal(h.events.some(event => event.type === 'turn_started'), false);
      // Wrong request ID cannot admit this send.
      h.child.reply({ ...h.child.last(), id: 'wrong-id' }, { success: true, data: { disposition } }); await tick();
      assert.equal(settled, false);
      if (disposition === 'handled') h.child.frame({ type: 'command_output', text: 'handled output' });
      h.child.reply(h.child.last(), { success: true, data: { disposition } }); await pending;
      assert.equal(h.responses[0].payload.accepted, true);
      assert.equal((await h.receipts())[0].state, 'completed');
      if (disposition === 'handled') {
        await until(() => h.session.activeTurnId === null);
        await h.manager.drainSessionEvents(agentId);
        assert.equal(h.events.filter(event => event.type === 'turn_completed').length, 1);
        const promptIndex = h.events.findIndex(event => event.type === 'timeline' && event.item.type === 'user_message');
        const outputIndex = h.events.findIndex(event => event.type === 'timeline' && event.item.type === 'assistant_message');
        assert(promptIndex >= 0 && outputIndex > promptIndex);
        assert.equal(h.events.filter(event => event.type === 'timeline' && event.item.type === 'user_message').length, 1);
      } else {
        assert.notEqual(h.session.activeTurnId, null); // model still active
        h.child.terminal(); await tick();
      }
      const rpcCount = h.child.requests.length;
      await h.send(); assert.equal(h.child.requests.length, rpcCount);
    });
  }
  await test('configured extends:pi wrapper forwards native-admission marker and exact startTurn', async () => {
    const h = await harness();
    const { buildProviderRegistry } = await load(candidate, 'agent/provider-registry.js');
    const { PiRpcAgentClient } = await load(candidate, 'agent/providers/pi/agent.js');
    const original = PiRpcAgentClient.prototype.createSession;
    // Public createSession collaborator mocked offline; deployed code is never mutated.
    PiRpcAgentClient.prototype.createSession = async () => h.session;
    try {
      const registry = buildProviderRegistry(logger, { providerOverrides: { 'qq-offline': { extends: 'pi', label: 'Offline' } } });
      const wrapped = await registry['qq-offline'].createClient(logger).createSession({ cwd: tmpdir() }, {});
      assert.equal(wrapped.provider, 'qq-offline'); assert.equal(wrapped.requiresNativePromptAdmission, true);
      let accepted = false; const pending = wrapped.startTurn('wrapper input').then(() => accepted = true);
      await until(() => h.child.last()); assert.equal(accepted, false);
      h.child.reply(h.child.last(), { success: true, data: { disposition: 'started' } }); await pending;
      assert.equal(accepted, true); h.child.terminal();
    } finally { PiRpcAgentClient.prototype.createSession = original; }
  });
  await test('non-Pi providers retain detached admission/start waiting behavior', async () => {
    const { startAgentRun } = await load(candidate, 'agent/agent-prompt.js');
    let release; const held = new Promise(resolve => release = resolve);
    const iterator = (async function* () { await held; yield { type: 'turn_started' }; })();
    const manager = { getAgent: () => ({ provider: 'other' }), tryRunOutOfBand: () => false, streamAgent: () => iterator, requiresNativePromptAdmission: () => false };
    const result = await startAgentRun(manager, agentId, 'hello', logger);
    assert.equal(result.disposition, 'turn_started'); assert.equal(result.nativeAdmission, false);
    release(); await tick();
  });
  await test('fast stream + terminal before continuation: start -> canonical prompt -> stream, one terminal', async () => {
    const h = await harness(); const pending = h.send(); await until(() => h.child.last());
    h.child.frame({ type: 'agent_start' }); h.child.frame({ type: 'turn_start' });
    h.child.frame({ type: 'message_update', message: { role: 'assistant', responseId: 'fast' }, assistantMessageEvent: { type: 'text_delta', delta: 'fast output' } });
    h.child.terminal(); h.child.terminal();
    h.child.reply(h.child.last(), { success: true, data: { disposition: 'started' } });
    await pending; await tick(); await h.manager.drainSessionEvents(agentId);
    assert.equal(h.responses[0].payload.accepted, true);
    const start = h.events.findIndex(event => event.type === 'turn_started');
    const prompt = h.events.findIndex(event => event.type === 'timeline' && event.item.type === 'user_message');
    const stream = h.events.findIndex(event => event.type === 'timeline' && event.item.type === 'assistant_message');
    assert(start >= 0 && prompt > start && stream > prompt);
    assert.equal(h.events.filter(event => event.type === 'turn_started').length, 1);
    assert.equal(h.events.filter(event => event.type === 'turn_completed').length, 1);
    assert.equal(h.session.activePromptRequestId, null);
    assert.equal(h.manager.hasInFlightRun(agentId), false);
  });
  for (const error of ['Cannot prompt during manual compaction', 'Agent is busy']) {
    await test(`definite refusal: ${error}; cleanup, replay refusal, new-key retry, conflict`, async () => {
      const h = await harness(); const pending = h.send(); await until(() => h.child.last());
      h.child.reply(h.child.last(), { success: false, error }); await pending;
      assert.equal(h.responses[0].payload.accepted, false); assert.match(h.responses[0].payload.error, new RegExp(error));
      const receipt = (await h.receipts())[0]; assert.equal(receipt.state, 'pending'); assert.equal(receipt.nativeRefusal.message, error);
      assert.equal(h.session.activeTurnId, null); assert.equal(h.session.activeClientMessageId, null);
      assert.equal(h.session.pendingNoTurnOutputs.length, 0); assert.equal(h.session.activePromptRequestId, null);
      assert.equal(h.events.filter(event => event.type === 'turn_failed').length, 1);
      assert.equal(h.events.filter(event => event.type === 'turn_started').length, 0);
      const count = h.child.requests.length; await h.send(); assert.equal(h.child.requests.length, count);
      assert.equal(h.responses.at(-1).payload.accepted, false); assert.match(h.responses.at(-1).payload.error, new RegExp(error));
      await h.send('key', 'different'); assert.match(h.responses.at(-1).payload.error, /agent_request_key_conflict/);
      assert.equal(h.child.requests.length, count);
      const retry = h.send('intentional-retry'); await until(() => h.child.requests.filter(req => req.type === 'prompt').length === 2);
      h.child.reply(h.child.last(), { success: true, data: { disposition: 'started' } }); await retry;
      assert.equal(h.responses.at(-1).payload.accepted, true); h.child.terminal();
      // Untouched official parser can read candidate-era metadata, failing safe unknown.
      const { MessageReceipts } = await load(official, 'message-receipts/index.js');
      let dispatched = false;
      await assert.rejects(new MessageReceipts(h.directory).send({ agentId, messageId: 'key', request: { prompt: 'hello', activeTurnBehavior: 'interrupt' }, send: () => { dispatched = true; } }), /agent_request_outcome_unknown/);
      assert.equal(dispatched, false); assert.equal((await h.receipts()).find(r => r.nativeRefusal).nativeRefusal.message, error);
    });
  }
  await test('native acceptance then exit before await continuation remains accepted with one terminal failure', async () => {
    const h = await harness(); const pending = h.send(); await until(() => h.child.last());
    h.child.reply(h.child.last(), { success: true, data: { disposition: 'started' } });
    h.child.emit('exit', 1, null);
    await pending; await tick(); await h.manager.drainSessionEvents(agentId);
    assert.equal(h.responses[0].payload.accepted, true);
    assert.equal((await h.receipts())[0].state, 'completed');
    assert.equal(h.session.activeTurnId, null);
    assert.equal(h.events.filter(event => event.type === 'turn_failed').length, 1);
    assert.equal(h.manager.hasInFlightRun(agentId), false);
  });
  await test('accepted then model failure remains deduplicated as completed', async () => {
    const h = await harness(); const pending = h.send(); await until(() => h.child.last());
    h.child.reply(h.child.last(), { success: true, data: { disposition: 'started' } }); await pending;
    h.child.terminal('model failure'); await tick(); await h.manager.drainSessionEvents(agentId);
    const count = h.child.requests.length; await h.send(); assert.equal(h.child.requests.length, count);
    assert.equal(h.responses.at(-1).payload.accepted, true); assert.equal((await h.receipts())[0].state, 'completed');
    assert.equal(h.events.filter(event => event.type === 'turn_failed').length, 1);
  });
  for (const fault of ['timeout', 'exit', 'pipe', 'missing-id', 'wrong-command', 'malformed-success', 'missing-disposition', 'legacy-ack']) {
    await test(`${fault}: unknown, provisional cleanup, no redispatch`, async () => {
      const h = await harness(candidate, 25); const pending = h.send(); await until(() => h.child.last()); const req = h.child.last();
      if (fault === 'exit') h.child.emit('exit', 1, null);
      if (fault === 'pipe') h.child.stdin.emit('error', new Error('EPIPE'));
      if (fault === 'missing-id') h.child.reply({ ...req, id: undefined }, { success: true, data: { disposition: 'started' } });
      if (fault === 'wrong-command') h.child.reply(req, { command: 'steer', success: false, error: 'Not correlated' });
      if (fault === 'malformed-success') h.child.reply(req, { success: 0, error: 'Not a boolean' });
      if (fault === 'missing-disposition') h.child.reply(req, { success: true, data: {} });
      if (fault === 'legacy-ack') h.child.reply(req, { success: true, data: { agentInvoked: false } });
      await pending;
      assert.equal(h.responses[0].payload.accepted, false); assert.match(h.responses[0].payload.error, /agent_request_outcome_unknown/);
      const receipt = (await h.receipts())[0]; assert.equal(receipt.state, 'pending'); assert.equal(receipt.nativeRefusal, undefined);
      assert.equal(h.session.activeTurnId, null); assert.equal(h.events.filter(event => event.type === 'turn_failed').length, 1);
      const count = h.child.requests.length; await h.send(); assert.equal(h.child.requests.length, count);
      assert.match(h.responses.at(-1).payload.error, /agent_request_outcome_unknown/);
    });
  }
  await test('accepted receipt commit loss remains unknown with no automatic or same-key replay', async () => {
    const h = await harness(); const pending = h.send(); await until(() => h.child.last());
    const file = (await readdir(h.directory)).find(file => file.endsWith('.json'));
    // Preserve the pending receipt while making rename-to-receipt fail with EISDIR.
    await rename(path.join(h.directory, file), path.join(h.directory, 'saved-pending'));
    await mkdir(path.join(h.directory, file));
    h.child.reply(h.child.last(), { success: true, data: { disposition: 'started' } }); await pending;
    assert.equal(h.responses[0].payload.accepted, false); assert.match(h.responses[0].payload.error, /agent_request_outcome_unknown/);
    await rm(path.join(h.directory, file), { recursive: true }); await rename(path.join(h.directory, 'saved-pending'), path.join(h.directory, file));
    const count = h.child.requests.length; await h.send(); assert.equal(h.child.requests.length, count);
    assert.equal((await h.receipts())[0].state, 'pending'); h.child.terminal();
  });
  await test('refusal receipt commit loss is unknown, not a claimed durable rejection', async () => {
    const h = await harness(); const pending = h.send(); await until(() => h.child.last());
    const file = (await readdir(h.directory)).find(file => file.endsWith('.json'));
    await rename(path.join(h.directory, file), path.join(h.directory, 'saved-pending'));
    await mkdir(path.join(h.directory, file));
    h.child.reply(h.child.last(), { success: false, error: 'Compaction refusal' }); await pending;
    assert.match(h.responses[0].payload.error, /agent_request_outcome_unknown/);
    await rm(path.join(h.directory, file), { recursive: true }); await rename(path.join(h.directory, 'saved-pending'), path.join(h.directory, file));
    const count = h.child.requests.length; await h.send(); assert.equal(h.child.requests.length, count);
    assert.equal((await h.receipts())[0].nativeRefusal, undefined);
  });
  await test('unkeyed transport loss also surfaces unknown without replay', async () => {
    const h = await harness(candidate, 25);
    const unkeyed = h.send(null, 'unkeyed'); await unkeyed;
    assert.match(h.responses.at(-1).payload.error, /agent_request_outcome_unknown/);
    assert.equal(h.child.requests.filter(req => req.type === 'prompt').length, 1);
    assert.equal((await h.receipts()).length, 0);
  });
  for (const disposition of ['queued', 'handled']) {
    await test(`active steering ${disposition}, including terminal before ack: no interrupt/resend`, async () => {
      const h = await harness(); const start = h.send('start'); await until(() => h.child.last()); h.child.reply(h.child.last(), { success: true, data: { disposition: 'started' } }); await start;
      const pending = h.send('steer', 'steering input', 'steer'); await until(() => h.child.last('steer'));
      h.child.terminal(); h.child.reply(h.child.last('steer'), { success: true, data: { disposition } }); await pending;
      assert.equal(h.responses.at(-1).payload.accepted, true);
      assert.equal(h.child.requests.filter(req => req.type === 'prompt').length, 1);
      assert.equal(h.child.requests.filter(req => req.type === 'abort').length, 0);
      assert.equal(h.session.pendingSteerSubmissions.length, 0);
    });
  }
  await test('interrupt intentionally cancels once then admits replacement once', async () => {
    const h = await harness(); const start = h.send('start'); await until(() => h.child.last()); h.child.reply(h.child.last(), { success: true, data: { disposition: 'started' } }); await start;
    const replacement = h.send('replace', 'new input', 'interrupt'); await until(() => h.child.requests.filter(req => req.type === 'prompt').length === 2);
    h.child.reply(h.child.last(), { success: true, data: { disposition: 'started' } }); await replacement;
    assert.equal(h.responses.at(-1).payload.accepted, true);
    assert.equal(h.child.requests.filter(req => req.type === 'abort').length, 1); h.child.terminal();
  });
  console.log(`passed ${passed} offline integration checks`);
} finally {
  for (const h of allHarnesses) {
    h.runtimeSession.process.failAll(new Error('offline cleanup'));
    await h.session.close();
    await rm(h.directory, { recursive: true, force: true });
  }
}
