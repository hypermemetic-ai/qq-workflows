import assert from 'node:assert/strict';
import { localPiProvider } from './support/local-pi-provider.mjs';
import { createWorkflow } from '../workflow/operations.mjs';
import { readJob, processFingerprint } from '../workflow/jobs.mjs';
import { openChange, viewsFor } from '../workflow/change-record.mjs';
let release, requested = false;
const answer = new Promise(resolve => release = resolve);
const fixture = await localPiProvider({ respond: async () => {
  requested = true; await answer; return { text: 'late output must not become success' };
} });
if (!fixture) { console.log('SKIP: installed Pi unavailable'); process.exit(0); }
const owner = 'independent-cancel-owner';
const wf = createWorkflow({ root: fixture.root, sessionKey: owner, env: fixture.env });
let pid;
const wait = async fn => { const end = Date.now() + 45000;
  while (Date.now() < end) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error('timeout waiting for fake worker');
};
try {
  const dispatched = await wf.dispatchRunner({ task: 'Wait for an explicit cancellation.' });
  assert.equal(dispatched.ok, true);
  await wait(() => requested);
  const jobId = dispatched.jobId, record = readJob(wf.stateDir, jobId);
  pid = record.process.pid;
  assert.ok(record.independentRunner);
  const cancelled = wf.cancelRunner({ jobId });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.signalled, true);
  release();
  await wait(() => !processFingerprint({ pid }) || readJob(wf.stateDir, jobId)?.terminal?.status === 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(wf.checkRunner({ jobId }).status, 'cancelled');
  const state = openChange({ stateDir: wf.stateDir, changeId: jobId }).state;
  const job = viewsFor(state).job(jobId);
  assert.equal(viewsFor(state).attempt(jobId, job.attemptOrder.at(-1)).outcome.status, 'cancelled');
  assert.equal(fixture.calls, 1);
  console.log('PASS explicit cancellation signals detached supervisor, delayed output cannot become success');
} finally {
  release(); if (pid && processFingerprint({ pid })) try { process.kill(pid, 'SIGTERM'); } catch {}
  await wf.releaseCommunication?.(); await fixture.stop();
}
