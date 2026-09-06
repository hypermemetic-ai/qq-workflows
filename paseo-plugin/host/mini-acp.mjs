#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { startJsonRpcStdio } from './jsonrpc-stdio.mjs';
import { PLUGIN_ROOT } from './config.mjs';
import { callHost } from './runtime.mjs';
import { loadGrokToken } from './secrets.mjs';
import { ZVEC_GREP_AGENT_GUIDANCE } from './zg-guidance.mjs';

const sessions = new Map();
startJsonRpcStdio({ async handler({ method, params }, { write }) {
  if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: {} }, agentInfo: { name: 'mini-v2', version: '2.4.6' } };
  if (method === 'session/new') {
    const sessionId = randomUUID();
    sessions.set(sessionId, { cwd: params.cwd, running: null });
    return { sessionId, models: { currentModelId: 'grok-4.6', availableModels: [{ modelId: 'grok-4.6', name: 'Grok 4.6' }] } };
  }
  const session = sessions.get(params?.sessionId);
  if (method === 'session/cancel') { if (session) session.cancelled = true; session?.running?.kill('SIGTERM'); return; }
  if (method === 'shutdown' || method === 'exit') { for (const item of sessions.values()) item.running?.kill('SIGTERM'); return {}; }
  if (method === 'session/set_config_option') return { configOptions: [] };
  if (method !== 'session/prompt' || !session) throw new Error(`unsupported method or session: ${method}`);
  if (session.running) throw new Error('Mini already running');
  const pythonRoot = join(PLUGIN_ROOT, '..', 'mini-researcher');
  const token = process.env.XAI_API_KEY || await loadGrokToken();
  const child = spawn(join(pythonRoot, '.venv', 'bin', 'python'), ['-m', 'mini_researcher.implementer'], {
    cwd: session.cwd,
    env: { ...process.env, PYTHONPATH: join(pythonRoot, 'src'), XAI_API_KEY: token },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  session.running = child;
  session.cancelled = false;
  const update = update => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update } });
  let failure, accepted = false;
  let processing = Promise.resolve();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { processing = processing.then(async () => {
    const event = JSON.parse(line);
    if (event.kind === 'text') update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.text } });
    if (event.kind === 'tool') update({ sessionUpdate: event.status === 'pending' ? 'tool_call' : 'tool_call_update', toolCallId: event.id, title: event.name, status: event.status, rawInput: event.arguments, content: event.output ? [{ type: 'content', content: { type: 'text', text: event.output } }] : [] });
    if (event.kind === 'done') {
      const { result } = await callHost('/tool', { name: 'done', arguments: event.arguments, context: { jobId: process.env.ARCHITECT_JOB_ID, role: 'implementer', cwd: session.cwd } });
      accepted = result.accepted;
      child.stdin.end(JSON.stringify(result) + '\n');
    }
    if (event.kind === 'failure') failure = event.error;
  }).catch(error => { failure = { message: error.message, failureClass: error.failureClass }; child.kill('SIGTERM'); }); });
  child.stderr.on('data', data => process.stderr.write(data));
  const task = (params.prompt ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
  child.stdin.write(JSON.stringify({ cwd: session.cwd, task, zgGuidance: ZVEC_GREP_AGENT_GUIDANCE }) + '\n');
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    await processing;
    if (!accepted) {
      failure ??= { message: session.cancelled ? 'Mini cancelled' : `Mini stopped without completion (exit ${code})`, failureClass: session.cancelled ? 'cancelled' : 'process' };
      await callHost('/runner', { jobId: process.env.ARCHITECT_JOB_ID, event: 'stopped', value: failure });
      throw new Error(failure.message);
    }
    return { stopReason: 'end_turn' };
  } finally { session.running = null; }
} });
