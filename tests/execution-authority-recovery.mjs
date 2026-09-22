// Corrupt or missing authority for a new managed execution must never be
// reclassified as a legacy job to authorize process signalling.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {recordManagedExecution} from '../workflow/execution-authority.mjs';
import {createJob,writeJob,readJob,processFingerprint,isProcessAlive} from '../workflow/jobs.mjs';
import {changeRecordPath} from '../workflow/change-record.mjs';
import {cancelExecutionHost} from '../workflow/execution-supervisor.mjs';

for (const fault of ['corrupt','missing']) {
 const stateDir=mkdtempSync(join(tmpdir(),'qq-execution-authority-'));
 const jobId=randomUUID(),launchId=randomUUID(),owner='fixture-owner',requestPath=join(stateDir,'request.json');
 recordManagedExecution({stateDir,executionId:jobId,kind:'open',phaseId:randomUUID(),root:stateDir,owner,constraints:'Keep the original task and cancellation obligations.',launchId,requestPath});
 const child=spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{stdio:'ignore'});
 await once(child,'spawn');
 try {
  const job=createJob({stateDir,id:jobId,role:'execution',workflow:{sessionKey:owner,root:stateDir},cwd:stateDir});
  writeJob(stateDir,{...job,process:{pid:child.pid,fingerprint:processFingerprint({pid:child.pid})},executionHost:{launchId,requestPath},communication:{enabled:true,changeId:jobId,jobId}});
  const record=changeRecordPath(stateDir,jobId);
  if(fault==='corrupt')writeFileSync(record,'fixture authority corruption\n');
  else unlinkSync(record);
  let result;
  try {result=await cancelExecutionHost({stateDir,jobId,by:owner});}
  catch(error){result={ok:false,error:error.message};}
  assert.equal(result.ok,false,`${fault} new authority cannot silently become legacy cancellation`);
  assert.ok(isProcessAlive(child.pid),'no owned-process signal before committed cancellation intent');
  assert.equal(readJob(stateDir,jobId).cancellation,null,'failed admission cannot publish a cancellation tombstone');
 } finally {
  if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill('SIGKILL');await stopped;}
 }
}
console.log('PASS execution authority unavailable: no legacy fallback, signal, or invented cancellation');
