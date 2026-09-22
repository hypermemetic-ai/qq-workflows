import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorkflow } from '../workflow/operations.mjs';
import { readJob, writeJob } from '../workflow/jobs.mjs';
import { tempRepo, fakeChild, agentTransport, waitForJobTerminal } from './support/architect-fixtures.mjs';

const { root, env } = await tempRepo();
let child;
const sent = agentTransport();
const owner = createWorkflow({ root, env, sessionKey: 'owner', notifierTransport: sent,
  spawnFn: () => (child = fakeChild()) });
const one = owner.dispatchRunner({ task: 'survive loss of callbacks' });
const record = readJob(owner.stateDir, one.jobId);
assert.ok(record.resultFile.startsWith(owner.stateDir));
child.stdout.write(JSON.stringify({step_update:{step_type:'tool',tool_name:'read',state:'ACTIVE'}})+'\n');
assert.equal(owner.checkRunner({jobId:one.jobId}).telemetry.state, 'active');
// Simulate loss of the original workflow instance, with a real result transport
// written after the coordinator disappears. No transcript is consulted.
writeFileSync(record.resultFile, JSON.stringify({ runnerId: one.jobId, response: 'durable findings', data_points: [] }));
const restarted = createWorkflow({root,env,sessionKey:'owner',notifierTransport:sent});
const recovered = restarted.checkRunner({jobId:one.jobId});
assert.equal(recovered.status,'completed');
assert.equal(recovered.telemetry.source,'durable');
assert.equal(restarted.readReport({reportId:recovered.reportId}).text,'durable findings');
await restarted.recoverDeliveries();
assert.equal(sent.delivered.length,1);
await restarted.recoverDeliveries();
assert.equal(sent.delivered.length,1,'receipt prevents duplicate notification');
assert.throws(()=>createWorkflow({root,env,sessionKey:'stranger'}).checkRunner({jobId:one.jobId}), /another workflow/);

const two = owner.dispatchRunner({task:'unexpected signal'});
child.emit('close',null,'SIGTERM');
assert.equal(readJob(owner.stateDir,two.jobId).status,'failed','external SIGTERM is not operator cancellation or running forever');
const three = owner.dispatchRunner({task:'cancel then late result'});
owner.cancelRunner({jobId:three.jobId});
writeFileSync(readJob(owner.stateDir,three.jobId).resultFile,JSON.stringify({runnerId:three.jobId,response:'late success'}));
assert.equal(restarted.checkRunner({jobId:three.jobId}).status,'cancelled');
const four = owner.dispatchRunner({task:'gone without result'});
assert.equal(restarted.checkRunner({jobId:four.jobId}).status,'interrupted');
assert.equal(restarted.checkRunner({jobId:four.jobId}).telemetry.source,'unavailable');
const five = owner.dispatchRunner({task:'forged result'});
writeFileSync(readJob(owner.stateDir,five.jobId).resultFile,JSON.stringify({runnerId:one.jobId,response:'forged success'}));
assert.equal(restarted.checkRunner({jobId:five.jobId}).status,'interrupted');
console.log('PASS runner recovery: report before notify, replay dedupe, ownership, external signal, cancellation, missing and forged results');
