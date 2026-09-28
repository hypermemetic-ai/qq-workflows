// Disposable installed-Pi/fake-provider proof through the real dispatch path.
// Reproduce a recursive PPID stop without invoking the user's Paseo daemon.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { localPiProvider } from './support/local-pi-provider.mjs';
import { createWorkflow } from '../workflow/operations.mjs';
import { readJob, processFingerprint, createJob, writeJob, reconcileJob } from '../workflow/jobs.mjs';

const parentDir = mkdtempSync(join(homedir(), '.qq-tree-runner-test-'));
let release, called = false;
const answer = new Promise(resolve => { release = resolve; });
const fixture = await localPiProvider({ fixtureParent: parentDir, respond: async () => {
  called = true; await answer; return { text: 'Survived the tree stop.' };
} });
if (!fixture) { rmSync(parentDir, { recursive: true, force: true }); console.log('SKIP: installed Pi unavailable'); process.exit(0); }
const owner = 'tree-stop-owner';
const info = join(fixture.root, 'dispatch.json');
const parentFile = join(fixture.root, 'parent.mjs');
writeFileSync(parentFile, `import {createWorkflow} from ${JSON.stringify(new URL('../workflow/operations.mjs', import.meta.url).href)};
import {writeFileSync} from 'node:fs';
const wf=createWorkflow({root:${JSON.stringify(fixture.root)},sessionKey:${JSON.stringify(owner)}});
const result=await wf.dispatchRunner({task:'Return one finding.'});
writeFileSync(${JSON.stringify(info)}, JSON.stringify(result));setInterval(()=>{},1000);`);
const parent = spawn(process.execPath, [parentFile], { env: fixture.env, stdio: ['ignore', 'ignore', 'pipe'] });
let errors = ''; parent.stderr.on('data', chunk => errors += chunk);
const wait = async (test, ms = 90000) => { const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(`timeout: ${errors.slice(-500)}`);
};
const children = pid => readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number).filter(candidate => {
  try { return Number(readFileSync(`/proc/${candidate}/stat`, 'utf8').split(') ')[1].split(' ')[1]) === pid; }
  catch { return false; }
});
const treeStop = pid => { for (const child of children(pid)) treeStop(child); try { process.kill(pid, 'SIGTERM'); } catch {} };
let jobId, runnerPid;
try {
  await wait(() => existsSync(info) && called);
  const launched = JSON.parse(readFileSync(info, 'utf8'));
  assert.equal(launched.ok, true); jobId = launched.jobId;
  const record = readJob(join(fixture.root, 'state'), jobId);
  runnerPid = record.process.pid;
  assert.ok(record.independentRunner);
  assert.notEqual(children(parent.pid).includes(runnerPid), true, 'bridge exited before accepted launch');
  assert.ok(children(runnerPid).length > 0, 'representative worker belongs to reparented supervisor');
  assert.ok(readFileSync(`/proc/${runnerPid}/stat`, 'utf8').split(') ')[1].split(' ')[1] !== String(parent.pid));
  const stopped = new Promise(resolve => parent.once('exit', resolve));
  treeStop(parent.pid); await stopped;
  assert.ok(processFingerprint({ pid: runnerPid }), 'supervisor survived installed-style PPID walk');
  assert.ok(children(runnerPid).length > 0, 'representative worker survived');
  const notices = [];
  const replacement = createWorkflow({ root: fixture.root, sessionKey: owner, env: fixture.env,
    notifierTransport: { name: 'fake', deliver: async notification => {
      notices.push(notification); return { state: 'delivered', receipt: { kind: 'fixture-receipt', confirmed: true } };
    } } });
  const running = replacement.checkRunner({ jobId });
  assert.equal(running.status, 'running');
  assert.ok(['durable', 'unavailable'].includes(running.telemetry.source));
  release();
  await wait(async () => { await replacement.recoverDeliveries(); return readJob(replacement.stateDir, jobId)?.status === 'completed'; });
  assert.match(replacement.readReport({ reportId: readJob(replacement.stateDir, jobId).terminal.reportId }).text, /Survived/);
  await replacement.recoverDeliveries();
  assert.equal(notices.length, 1, 'correct owner receives exactly one completion');
  assert.equal(fixture.calls, 1, 'no redispatch');
  const missing = createJob({ stateDir: replacement.stateDir, id: 'missing-result', role: 'runner',
    workflow: { sessionKey: owner, root: fixture.root }, now: Date.now() });
  const missingRequest = join(fixture.root, 'missing-request');
  writeFileSync(`${missingRequest}.exit`, JSON.stringify({ code: 0 }));
  writeJob(replacement.stateDir, { ...missing, independentRunner: { request: missingRequest },
    process: { pid: 987654, fingerprint: { startTicks: '1', cmdlineHash: 'fake' } } });
  assert.equal(reconcileJob(replacement.stateDir, missing.id, { alive: () => true }).status, 'interrupted',
    'an exited independent runner with no result has an unknown outcome, never fabricated success');
  console.log('PASS reparented supervisor + worker survive PPID tree stop, independent result reconciles and delivers once');
} finally {
  release(); if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGTERM');
  if (runnerPid && processFingerprint({ pid: runnerPid })) try { process.kill(runnerPid, 'SIGTERM'); } catch {}
  await fixture.stop(); rmSync(parentDir, { recursive: true, force: true });
}
