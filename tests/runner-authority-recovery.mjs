// Retained incident/authority regressions. Real owned fixture processes, native
// workflow entrypoints, durable change records; no provider or fake outcome.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createChange,openChange,changeRecordPath,viewsFor} from '../workflow/change-record.mjs';
import {createJob,readJob,writeJob,processFingerprint,isProcessAlive,jobPath} from '../workflow/jobs.mjs';
import {createWorkflow} from '../workflow/operations.mjs';

const actor={kind:'runtime',id:'authority-fixture'};
const runCase=name=>!process.env.QQ_TEST_AUTHORITY_CASE||process.env.QQ_TEST_AUTHORITY_CASE===name;
async function fixture(outcome=null) {
 const stateDir=mkdtempSync(join(tmpdir(),'qq-runner-authority-')),id=randomUUID(),attemptId=randomUUID(),owner='fixture-owner';
 createChange({stateDir,changeId:id,actor,commandId:'create'});
 const handle=openChange({stateDir,changeId:id});
 handle.append('assignment.revised',{revision:1,predecessor:null,scope:{kind:'change'},assignment:{instructions:'Preserve the original constraints.'}},{context:{actor},commandId:'assignment'});
 handle.append('job.registered',{role:'runner',pinnedRevision:1},{context:{actor,jobId:id},commandId:'register'});
 handle.append('attempt.launch_intent',{owner,cwd:stateDir},{context:{actor,jobId:id,attemptId},commandId:'launch'});
 handle.append('attempt.started',{identity:{harness:'pi',piSession:randomUUID()}},{context:{actor,jobId:id,attemptId},commandId:'started'});
 if(outcome==='cancelled')handle.append('attempt.cancel_intent',{reason:'already accepted cancellation'},{context:{actor,jobId:id,attemptId},commandId:'cancel'});
 if(outcome)handle.append('attempt.outcome',{status:outcome},{context:{actor,jobId:id,attemptId},commandId:'outcome'});
 const child=spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{stdio:'ignore'});
 await once(child,'spawn');
 createJob({stateDir,id,role:'runner',workflow:{sessionKey:owner,root:stateDir},cwd:stateDir});
 writeJob(stateDir,{...readJob(stateDir,id),process:{pid:child.pid,fingerprint:processFingerprint({pid:child.pid})},communication:{enabled:true,changeId:id,jobId:id,attemptId,runtimeActorId:actor.id}});
 const wf=createWorkflow({root:stateDir,sessionKey:owner,env:{...process.env,QQ_WORKFLOW_STATE_DIR:stateDir}});
 const stop=async()=>{if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGKILL');await ended;}};
 return {stateDir,id,attemptId,owner,child,wf,stop};
}

if(runCase('cancelled_cache')) {
 const f=await fixture('cancelled');
 try {assert.equal(f.wf.checkRunner({jobId:f.id}).status,'cancelled','authoritative cancellation overrides stale running cache');}
 finally {await f.stop();}
}
if(runCase('completed_cancel')) {
 const f=await fixture('completed');
 try {
  const result=f.wf.cancelRunner({jobId:f.id});
  assert.equal(result.status,'completed');assert.notEqual(result.signalled,true);assert.ok(isProcessAlive(f.child.pid),'completed attempt cannot be cancelled through a stale cache');
 } finally {await f.stop();}
}
if(runCase('unknown_exit')) {
 const f=await fixture();
 try {
  await f.stop();
  const result=f.wf.checkRunner({jobId:f.id});
  assert.equal(result.status,'interrupted','unexpected process loss is surfaced');
  const attempt=viewsFor(openChange({stateDir:f.stateDir,changeId:f.id}).state).attempt(f.id,f.attemptId);
  assert.equal(attempt.outcome,null,'disappearance without a managed result is outcome-unknown, not a known failed outcome');
 } finally {await f.stop();}
}
if(runCase('corrupt_cancel')) {
 const f=await fixture();
 try {
  writeFileSync(changeRecordPath(f.stateDir,f.id),'fixture record corruption');
  let result;try{result=f.wf.cancelRunner({jobId:f.id});}catch(error){result={ok:false,error:error.message};}
  assert.equal(result.ok,false,'new authority failure cannot silently become legacy cancellation');
  assert.ok(isProcessAlive(f.child.pid),'no signal before accepted authoritative intent');
  const cached=JSON.parse(readFileSync(jobPath(f.stateDir,f.id),'utf8'));
  assert.notEqual(cached.status,'cancelled');assert.equal(cached.cancellation,null,'failed admission cannot publish a cancellation tombstone');
 } finally {await f.stop();}
}
if(runCase('owner')) {
 const f=await fixture();
 try {
  const other=createWorkflow({root:f.stateDir,sessionKey:'other-owner',env:{...process.env,QQ_WORKFLOW_STATE_DIR:f.stateDir}});
  assert.throws(()=>other.checkRunner({jobId:f.id}),/another workflow session/);
  assert.throws(()=>other.cancelRunner({jobId:f.id}),/another workflow session/);
  assert.ok(isProcessAlive(f.child.pid));
 } finally {await f.stop();}
}
console.log(`PASS runner authority case(s): ${process.env.QQ_TEST_AUTHORITY_CASE??'all five'}`);
