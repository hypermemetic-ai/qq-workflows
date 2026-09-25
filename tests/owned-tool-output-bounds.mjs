#!/usr/bin/env node
// Owned model-facing boundaries: measure the whole serialized result, including
// Pi details, not just its first text block. No provider or live runtime needed.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createWorkflow } from '../workflow/operations.mjs';
import { createJob, readJob, writeJob } from '../workflow/jobs.mjs';
import { saveReport } from '../workflow/reports.mjs';
import { createArchitectExtension } from '../pi-extension/qq-architect.mjs';
import { createWorkerToolsExtension } from '../pi-extension/worker-tools.mjs';
import { handleRpc } from '../bin/mcp-server.mjs';
import { agentTransport, fakePi, tempRepo } from './support/architect-fixtures.mjs';

const MAX = 16_384;
function within(result, label) {
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX, `${label}: entire serialized model-visible result must fit ${MAX} UTF-8 bytes`);
  return result;
}
const { root, env } = await tempRepo();
// Exercise MCP's explicit context without relying on an inherited live owner.
// tests/run.mjs also strips these identities; keep focused runs isolated too.
const identityKeys = ['QQ_WORKFLOW_SESSION_ID', 'PASEO_AGENT_ID', 'CODEX_THREAD_ID'];
const previousIdentity = Object.fromEntries(identityKeys.map(key => [key, process.env[key]]));
for (const key of identityKeys) delete process.env[key];
try {
  const owner = 'bounded-recovery-owner';
  const delivery = agentTransport();
  const wf = createWorkflow({ root, sessionKey: owner, env: { ...env, QQ_WORKFLOW_SESSION_ID: owner },
    notifierTransport: delivery });
  const identity = wf.session();
  const oldIds = [];
  for (let i = 0; i < 123; i++) {
    const id = `old-history-${String(i).padStart(3, '0')}`;
    oldIds.push(id);
    const record = createJob({ stateDir: wf.stateDir, id, role: 'runner', workflow: { ...identity, root }, cwd: root, task: 'historical evidence '.repeat(100), now: i + 1 });
    writeJob(wf.stateDir, { ...record, status: i % 3 === 0 ? 'failed' : i % 3 === 1 ? 'cancelled' : 'completed',
      terminal: { status: i % 3 === 0 ? 'failed' : i % 3 === 1 ? 'cancelled' : 'completed', reportId: null },
      delivery: { state: 'delivered' }, finishedAt: i + 2 });
  }
  // One current actionable exception; historical outcomes remain independently inspectable.
  const id = 'current-orphan';
  createJob({ stateDir: wf.stateDir, id, role: 'runner', workflow: { ...identity, root }, cwd: root,
    process: { pid: 987654321, spawnedAt: 1, fingerprint: { pid: 987654321, startTicks: '1', cmdlineHash: 'gone' } }, now: 124 });
  const pi = fakePi();
  const extension = createArchitectExtension(pi, {
    cwd: root, env: { ...env, QQ_WORKFLOW_SESSION_ID: owner }, interactive: true,
    workflowFactory: () => wf,
  });
  extension.registerTools(extension.tools.map(tool => tool.parameters));
  const recovery = within(await pi.registered.find(tool => tool.name === 'recover_deliveries').execute('call', {}), 'native recovery (123 historical jobs)');
  const visible = JSON.stringify(recovery);
  assert.ok(oldIds.every(oldId => !visible.includes(oldId)), 'recovery must not enumerate historical jobs or references to old jobs');
  assert.match(visible, /current-orphan/, 'current actionable exception remains visible or explicitly retrievable');
  assert.match(visible, /operations\.mjs/, 'loaded operations module identity remains inspectable');
  assert.match(visible, /qq-architect\.mjs/, 'loaded extension module identity remains inspectable');
  assert.equal(readJob(wf.stateDir, oldIds[0]).status, 'failed');
  assert.equal(readJob(wf.stateDir, oldIds[1]).status, 'cancelled');
  assert.equal(readJob(wf.stateDir, oldIds[2]).status, 'completed');
  assert.equal(wf.checkRunner({ jobId: oldIds[0] }).status, 'failed', 'historical detail remains available on demand');
  assert.equal(readJob(wf.stateDir, id).status, 'interrupted', 'recovery still reconciles interrupted jobs');
  assert.equal(delivery.delivered.filter(entry => entry.jobId === id).length, 1, 'current interruption delivered exactly once');

  // A large set of *current* uncertain receipts is unlike historical jobs:
  // omitting them inline must not be reported as an all-clear. No evidence is
  // supplied, so recovery must not mistake transport queueing for a receipt.
  for (let i = 0; i < 220; i++) {
    const pendingId = `current-uncertain-${String(i).padStart(3, '0')}`;
    const record = createJob({ stateDir: wf.stateDir, id: pendingId, role: 'runner', workflow: { ...identity, root }, cwd: root, now: 200 + i });
    writeJob(wf.stateDir, { ...record, status: 'failed', terminal: { status: 'failed', ok: false },
      delivery: { eventId: `runner:${pendingId}:terminal`, state: 'queued' }, finishedAt: 200 + i });
  }
  const crowded = within(await pi.registered.find(tool => tool.name === 'recover_deliveries').execute('call', {}), 'native large actionable set');
  const crowdedBody = crowded.details ?? JSON.parse(crowded.content[0].text);
  assert.match(JSON.stringify(crowdedBody), /220/, 'current unknown receipts must have a truthful count even when not all fit inline');
  assert.match(JSON.stringify(crowdedBody), /read_report|check_runner|check_execution/, 'omitted actionable exceptions need explicit detail access');
  assert.equal(wf.checkRunner({ jobId: 'current-uncertain-219' }).status, 'failed', 'omitted current details remain inspectable by job ID');

  const exact = ('🌍\\"\n'.repeat(6000)) + 'END';
  const saved = saveReport(wf.stateDir, { jobId: 'large-report', role: 'runner', text: exact });
  let offset = 0;
  let assembled = '';
  for (let pageNo = 0; pageNo < 100; pageNo++) {
    const pageResult = within(await pi.registered.find(tool => tool.name === 'read_report').execute('call', { reportId: saved.reportId, offset, limit: 1_000_000 }), 'native maximum requested report page');
    const page = pageResult.details ?? JSON.parse(pageResult.content[0].text);
    assert.equal(page.ok, true);
    assert.equal(page.offset, offset);
    assembled += page.text;
    if (page.complete) break;
    assert.ok(page.nextOffset > offset, 'page advances without losing content');
    offset = page.nextOffset;
  }
  assert.equal(assembled, exact, 'all exact report content retrievable without replaying an action');
  // MCP resolves reports through an owned Git repository and session even when
  // no live identity is inherited. Scope the state override to these reads.
  execFileSync('git', ['init', '-q', root]);
  const previousStateDir = process.env.QQ_WORKFLOW_STATE_DIR;
  let mcpPage;
  let astralPageStalled = false;
  let recovered = '';
  try {
    process.env.QQ_WORKFLOW_STATE_DIR = wf.stateDir;
    mcpPage = within(await handleRpc('tools/call', { name: 'read_report', arguments: {
      cwd: root, sessionId: owner, reportId: saved.reportId, limit: 1_000_000,
    } }), 'MCP maximum requested report page');
    assert.equal(JSON.parse(mcpPage.content[0].text).ok, true, 'initial MCP report page succeeds without inherited live identity');
    const astral = '🌍A🌍';
    const tiny = saveReport(wf.stateDir, { jobId: 'astral-page', text: astral });
    let cursor = 0;
    for (let pageNo = 0; pageNo < 10; pageNo++) {
      const frame = within(await handleRpc('tools/call', { name: 'read_report', arguments: {
        cwd: root, sessionId: owner, reportId: tiny.reportId, offset: cursor, limit: 1,
      } }), 'MCP astral one-unit page');
      const page = JSON.parse(frame.content[0].text);
      assert.equal(page.ok, true);
      assert.equal(page.offset, cursor);
      recovered += page.text;
      if (page.complete) break;
      if (page.nextOffset <= cursor) {
        astralPageStalled = true;
        break;
      }
      cursor = page.nextOffset;
    }
  } finally {
    if (previousStateDir === undefined) delete process.env.QQ_WORKFLOW_STATE_DIR;
    else process.env.QQ_WORKFLOW_STATE_DIR = previousStateDir;
  }
  const mcpBody = JSON.parse(mcpPage.content[0].text);
  assert.equal(mcpBody.ok, true);
  assert.equal(mcpBody.complete, false, 'MCP page states when more exact content remains');
  assert.ok(mcpBody.nextOffset > 0 && mcpBody.nextOffset < exact.length, 'MCP provides a usable continuation');

  // MCP oversized references must be saved in the same repository state that
  // read_report uses, even when the tool cwd is a nested directory. Avoid the
  // fixture state override here: it would mask a mismatch between those paths.
  const nested = join(root, 'nested');
  mkdirSync(nested);
  const headings = Array.from({ length: 25 }, (_, i) => `section-${i}-` + '🌍\\"'.repeat(300));
  writeFileSync(join(root, '.architect', 'tickets', `${owner}.md`), headings.map(h => `## ${h}\n`).join(''));
  const priorState = process.env.QQ_WORKFLOW_STATE_DIR;
  try {
    delete process.env.QQ_WORKFLOW_STATE_DIR;
    const result = within(await handleRpc('tools/call', { name: 'read_ticket', arguments: {
      cwd: nested, sessionId: owner, sectionsOnly: true,
    } }), 'MCP oversized result from nested cwd');
    const ref = JSON.parse(result.content[0].text);
    assert.equal(ref.detailComplete, true, 'an advertised exact result must be durable');
    assert.ok(ref.reportId, 'oversized result supplies a report reference');
    let cursor = 0;
    let content = '';
    for (let pageNo = 0; pageNo < 100; pageNo++) {
      const frame = within(await handleRpc('tools/call', { name: 'read_report', arguments: {
        cwd: nested, sessionId: owner, reportId: ref.reportId, offset: cursor, limit: 1_000_000,
      } }), 'MCP nested-cwd exact-result report page');
      const page = JSON.parse(frame.content[0].text);
      assert.equal(page.ok, true, 'advertised report is readable through MCP read_report');
      content += page.text;
      if (page.complete) break;
      assert.ok(page.nextOffset > cursor, 'nested-cwd report page advances');
      cursor = page.nextOffset;
    }
    const original = JSON.parse(content);
    assert.equal(original.ok, true);
    assert.equal(original.sessionId, owner);
    assert.equal(original.path, join(root, '.architect', 'tickets', `${owner}.md`));
    assert.deepEqual(original.sections, headings, 'the entire oversized result is retrievable without calling read_ticket again');
  } finally {
    if (priorState === undefined) delete process.env.QQ_WORKFLOW_STATE_DIR;
    else process.env.QQ_WORKFLOW_STATE_DIR = priorState;
  }

  assert.equal(astralPageStalled, false, 'a one-unit limit must advance across an astral character');
  assert.equal(recovered, '🌍A🌍', 'tiny MCP pages reconstruct exact Unicode without stalling or splitting a surrogate pair');

  // A completed execution may have a large reconstructed authority view. Its
  // ordinary bounded check must still expose the three *current* role report
  // references, not only a pointer to an oversized generic tool-output report.
  const roleReportIds = ['test_owner', 'implementer', 'reviewer'].map(role =>
    saveReport(wf.stateDir, { jobId: `current-${role}`, role, text: `current ${role} result` }).reportId);
  const largeCompletion = { ok: true, jobId: 'completed-execution', status: 'completed',
    reportId: 'execution-current-report', outcomeKnown: true,
    authority: {
      roles: ['test_owner', 'implementer', 'reviewer'].map((role, index) => ({
        role, jobId: `current-${role}`, attempts: [{ outcome: { status: 'completed', reportId: roleReportIds[index] },
          progress: [{ note: '🌍\\"'.repeat(3_000) }] }],
      })),
      reports: ['test_owner', 'implementer', 'reviewer'].map((role, index) => ({
        role, jobId: `current-${role}`, label: 'outcome-report', reportId: roleReportIds[index],
      })),
    } };
  let checks = 0;
  const completionPi = fakePi();
  const completionExtension = createArchitectExtension(completionPi, {
    cwd: root, env: { ...env, QQ_WORKFLOW_SESSION_ID: owner }, interactive: true,
    workflowFactory: () => ({ stateDir: wf.stateDir, callTool: async (name, args) => {
      if (name === 'read_report') return wf.callTool(name, args);
      assert.equal(name, 'check_execution');
      assert.equal(args.jobId, largeCompletion.jobId);
      checks++;
      return largeCompletion;
    } }),
  });
  completionExtension.registerTools(completionExtension.tools.map(tool => tool.parameters));
  const completed = within(await completionPi.registered.find(tool => tool.name === 'check_execution')
    .execute('call', { jobId: largeCompletion.jobId }), 'native completed execution with large authority view');
  assert.equal(completed.isError, false, 'completed execution remains a known success');
  const completedVisible = JSON.stringify(completed);
  for (const [index, reportId] of roleReportIds.entries()) {
    assert.ok(completedVisible.includes(reportId), `current ${reportId} must be inspectable in check_execution`);
    assert.equal(wf.readReport({ reportId }).text, `current ${['test_owner', 'implementer', 'reviewer'][index]} result`);
  }
  const completedBody = completed.details ?? JSON.parse(completed.content[0].text);
  assert.equal(completedBody.detailComplete, true, 'advertised larger result must be complete');
  assert.match(completedBody.retrieval, /read_report.*reportId/, 'larger result has an explicit retrieval path');
  assert.ok(completedBody.reportId, 'the advertised exact-result report reference is present');
  let resultOffset = 0;
  let originalResult = '';
  for (let pageNo = 0; pageNo < 100; pageNo++) {
    const frame = within(await completionPi.registered.find(tool => tool.name === 'read_report')
      .execute('call', { reportId: completedBody.reportId, offset: resultOffset, limit: 1_000_000 }), 'oversized execution original-result page');
    const page = frame.details ?? JSON.parse(frame.content[0].text);
    assert.equal(page.ok, true, 'the advertised report is readable');
    originalResult += page.text;
    if (page.complete) break;
    assert.ok(page.nextOffset > resultOffset, 'original-result page advances');
    resultOffset = page.nextOffset;
    assert.ok(pageNo < 99, 'original-result paging terminates');
  }
  assert.deepEqual(JSON.parse(originalResult), largeCompletion, 'advertised report contains the exact original execution result, not a different outcome report');
  assert.equal(checks, 1, 'reading an oversized completed execution must not replay the check');

  // MCP refusal and success frames are model-visible too; escaping a long
  // caller-controlled name must not bypass the output ceiling.
  within(await handleRpc('tools/call', { name: 'unknown-' + '🌍\\"'.repeat(10_000), arguments: { cwd: root } }), 'MCP oversized refusal');
  within(await handleRpc('tools/call', { name: 'read_report', arguments: { cwd: root, sessionId: owner, reportId: 'nonexistent' } }), 'MCP normal report result');

  const workerTools = [];
  const worker = createWorkerToolsExtension({ registerTool(tool) { workerTools.push(tool); } }, {
    cwd: root, env: { QQ_ZVEC_GREP_SEAT: 'runner', QQ_ZVEC_GREP_ROOT: root },
    gateway: { search: async () => ({ content: [{ type: 'text', text: '🌍\\"'.repeat(12_000) }],
      details: { nested: '🌍'.repeat(12_000) } }) },
  });
  await worker.register();
  within(await workerTools.find(tool => tool.name === 'zvec_grep_search').execute('call', { query: 'example' }), 'worker oversized Unicode/escaped search');
  await worker.close();
  const failingTools = [];
  const failingWorker = createWorkerToolsExtension({ registerTool(tool) { failingTools.push(tool); } }, {
    cwd: root, env: { QQ_ZVEC_GREP_SEAT: 'runner', QQ_ZVEC_GREP_ROOT: root },
    gateway: { search: async () => { throw new Error('🌍\\"\\n'.repeat(12_000)); } },
  });
  await failingWorker.register();
  const failure = within(await failingTools.find(tool => tool.name === 'zvec_grep_search').execute('call', { query: 'example' }), 'worker oversized thrown error');
  assert.equal(failure.isError, true, 'thrown gateway errors remain errors, not successful results');
  await failingWorker.close();
  console.log('PASS owned serialized tool outputs bounded, recovery relevant, exact report retrievable');
} finally {
  for (const key of identityKeys) {
    if (previousIdentity[key] === undefined) delete process.env[key];
    else process.env[key] = previousIdentity[key];
  }
  rmSync(root, { recursive: true, force: true });
}
