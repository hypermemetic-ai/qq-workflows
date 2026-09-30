#!/usr/bin/env node
// Real Pi 0.99.1 prompt/steer methods, offline collaborator boundary only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const sdk = path.join(homedir(), '.local/share/pi/releases/0.99.1/node_modules/@earendil-works/pi-coding-agent');
assert.equal(JSON.parse(await readFile(path.join(sdk, 'package.json'))).version, '0.99.1');
const { AgentSession } = await import(pathToFileURL(path.join(sdk, 'dist/core/agent-session.js')));
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }
function fixture() {
  const host = Object.create(AgentSession.prototype), model = deferred(), preflight = deferred(), acknowledgements = [], queued = [];
  Object.assign(host, {
    _isAgentRunActive: false, _isEmittingAgentSettled: false,
    _pendingNextTurnMessages: [], _baseSystemPromptOptions: { selectedTools: [] },
    _modelRuntime: { hasConfiguredAuth: () => true },
    _resourceLoader: { getPrompts: () => ({ prompts: [] }) },
    agent: { state: { model: { provider: 'offline', id: 'offline' } } },
    _extensionRunner: { emitBeforeAgentStart: async (_text, _images, systemPromptOptions) => ({ systemPromptOptions, messages: [] }) },
    async _runInputHandlers(text) { await preflight.promise; return { text }; },
    _flushPendingBashMessages() {}, _flushPendingCustomMessages() {}, _expandSkillCommand: text => text,
    _findLastAssistantMessage: () => undefined, getActiveToolNames: () => [],
    _normalizePromptImages: async () => ({ images: [], hints: [] }), _preparePromptAndToolLoadout() {},
    _runAgentPrompt: () => model.promise,
    _queueSteer: async text => queued.push(text), _queueFollowUp: async text => queued.push(text),
  });
  const options = { source: 'rpc', preflightResult: disposition => acknowledgements.push(disposition) };
  return { host, model, preflight, acknowledgements, queued, options };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const started = fixture(); let settled = false;
const work = started.host.prompt('non-slash input', started.options).then(() => settled = true);
await tick(); assert.deepEqual(started.acknowledgements, []);
started.preflight.resolve(); await tick();
assert.deepEqual(started.acknowledgements, ['started']); assert.equal(settled, false);
started.model.resolve(); await work;
const handled = fixture(); handled.host._runInputHandlers = async () => undefined;
await handled.host.prompt('handled non-slash input', handled.options);
assert.deepEqual(handled.acknowledgements, ['handled']);
const queued = fixture(); queued.host._isAgentRunActive = true; queued.preflight.resolve();
await queued.host.prompt('queue input', { ...queued.options, streamingBehavior: 'steer' });
assert.deepEqual(queued.acknowledgements, ['queued']); assert.deepEqual(queued.queued, ['queue input']);
const busy = fixture(); busy.host._isAgentRunActive = true; busy.preflight.resolve();
await assert.rejects(busy.host.prompt('busy input', busy.options), /already processing/);
assert.deepEqual(busy.acknowledgements, []);
const compact = fixture(); compact.host._compactionAbortController = new AbortController();
await assert.rejects(compact.host.prompt('compaction input', compact.options), /compaction is in progress/);
assert.deepEqual(compact.acknowledgements, []);
for (const disposition of ['queued', 'handled']) {
  const f = fixture(); f.preflight.resolve(); f.host._isAgentRunActive = true;
  if (disposition === 'handled') f.host._runInputHandlers = async () => undefined;
  assert.equal(await f.host.steer('steer input', undefined, { source: 'rpc' }), disposition);
}
// Bind the RPC layer's published conversion to the same contract. This is a
// source anchor, not execution of an RPC daemon or a claim of live verification.
const rpc = await readFile(path.join(sdk, 'dist/modes/rpc/rpc-mode.js'), 'utf8');
assert.match(rpc, /preflightResult: \(disposition\) => \{\s*preflightSucceeded = true;\s*output\(success\(id, "prompt", \{ disposition \}\)\)/);
assert.match(rpc, /if \(!preflightSucceeded\) \{\s*output\(error\(id, "prompt", e.message\)\)/);
console.log('PASS real Pi 0.99.1 offline: delayed preflight, started-before-model-settle, queued, non-slash handled, compaction/busy refusal, steer dispositions; RPC mapping source anchor');
