#!/usr/bin/env node
import assert from 'node:assert/strict';
import { runArchitectTurn } from '../paseo-plugin/host/loop.mjs';
import { supervisedArchitect } from '../paseo-plugin/host/providers/architect-provider.mjs';
import { createStore } from '../paseo-plugin/host/store.mjs';
import { createRuntime } from '../paseo-plugin/host/runtime.mjs';
import { ARCHITECT_SYSTEM_PROMPT } from '../paseo-plugin/host/workflow/prompts.mjs';
import { architectTools } from '../paseo-plugin/host/workflow/tools.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
if (!process.env.LIVE_ARCHITECT) { console.log('live architect: skipped (set LIVE_ARCHITECT=1)'); process.exit(0); }
const dir = mkdtempSync(join(tmpdir(), 'architect-live-'));
const store = createStore(join(dir, 'state.sqlite'));
const runtime = createRuntime({ store });
try {
  const requests = [];
  const result = await runArchitectTurn({
    cwd: dir,
    operatorText: 'Call ticket_write and set the entire ticket text to LIVE_OK. This is a transport verification: then reply briefly and stop without delegating.',
    pairs: [{ operator: 'Discard this older exchange OLD_CONTEXT', architect: 'Old.' }, { operator: 'SUBSTANTIAL_CONTEXT', architect: Array.from({ length: 240 }, (_, i) => `Background entry ${i}: retain this exchange across short replies.`).join('\n') }, { operator: 'Keep this previous exchange PREVIOUS_CONTEXT', architect: 'Previous.' }],
    complete: request => supervisedArchitect(request, { store, turnKey: 'acceptance' }),
    checkpoint: (kind, value) => { if (kind === 'request') requests.push(value); },
    executeTool: (name, args) => runtime.handleTool(name, args, { cwd: dir, agentId: 'live-architect' }),
  });
  assert.equal(result.ticket, 'LIVE_OK'); assert.ok(result.pairs.length >= 2);
  assert.ok(requests.length);
  for (const request of requests) {
    assert.equal(request.instructions, ARCHITECT_SYSTEM_PROMPT);
    assert.equal(request.model, 'gpt-6-astra'); assert.equal(request.reasoning.effort, 'high');
    assert.deepEqual(request.tools.map(tool => tool.name), architectTools().map(tool => tool.name));
    assert.ok(JSON.stringify(request.input).includes('PREVIOUS_CONTEXT'));
    assert.ok(!JSON.stringify(request.input).includes('OLD_CONTEXT'));
    assert.ok(JSON.stringify(request.input).includes('SUBSTANTIAL_CONTEXT'));
  }
  console.log(`Live Architect: ${requests.length} actual Astra high requests; exact prompt, tool whitelist, ticket mutation and retained context verified`);
} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
