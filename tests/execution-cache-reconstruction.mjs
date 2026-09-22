// Compatibility files cannot authorize ownership or invent managed outcomes.
// Actual owned process + native operations; notification receipt is simulated.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createWorkflow} from '../workflow/operations.mjs';
import {recordManagedExecution,recordHostStarted,readLaunchMetadata,recordExecutionOutcome,managedExecutionView} from '../workflow/execution-authority.mjs';
import {createJob,writeJob,readJob,jobPath,processFingerprint,isProcessAlive} from '../workflow/jobs.mjs';
import {cancelExecutionHost} from '../workflow/execution-supervisor.mjs';
import {saveReport} from '../workflow/reports.mjs';

const root=mkdtempSync(join(tmpdir(),'qq-execution-cache-')),stateDir=join(root,'state');
const owner=randomUUID(),foreign=randomUUID(),id=randomUUID(),launchId=randomUUID();
recordManagedExecution({stateDir,executionId:id,kind:'open',phaseId:randomUUID(),root,owner,constraints:'Keep the committed owner and reports.',launchId,requestPath:join(root,'request.json')});
const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'});await once(child,'spawn');
const fingerprint=processFingerprint({pid:child.pid});
recordHostStarted({stateDir,executionId:id,attemptId:readLaunchMetadata({stateDir,executionId:id}).attemptId,identity:{host:true,pid:child.pid,fingerprint,launchId}});
const original=createJob({stateDir,id,role:'execution',workflow:{sessionKey:owner,root},cwd:root,process:{pid:child.pid,fingerprint}});
const calls=[];
const transport={name:'fixture',deliver:async note=>{calls.push(note);return {state:'delivered',receipt:{kind:'fixture',confirmed:true}};}};
const wf=createWorkflow({root,sessionKey:owner,env:{QQ_WORKFLOW_STATE_DIR:stateDir},notifierTransport:transport});
const intruder=createWorkflow({root,sessionKey:foreign,env:{QQ_WORKFLOW_STATE_DIR:stateDir},notifierTransport:transport});
try {
  const report=saveReport(stateDir,{jobId:id,role:'execution',text:'Useful original execution findings.'});
  writeJob(stateDir,{...original,workflow:{sessionKey:foreign,root},status:'completed',terminal:{status:'completed',reportId:report.reportId,summary:'unproven cache success'}});
  const refused=cancelExecutionHost({stateDir,jobId:id,by:foreign});
  assert.equal(refused.ok,false);assert.equal(refused.signalled,false);assert.ok(isProcessAlive(child.pid));
  assert.equal(managedExecutionView({stateDir,executionId:id}).execution.cancelIntent,null);
  assert.throws(()=>intruder.checkExecution({jobId:id}),/another coordinating session/);
  await assert.rejects(intruder.steerExecution({jobId:id,message:'forged owner update'}),/another coordinating session/);
  assert.deepEqual(intruder.jobsView(),[]);
  await intruder.recoverDeliveries();assert.equal(calls.length,0,'forged cache ownership never redirects notification');
  const repaired=wf.checkExecution({jobId:id});
  assert.equal(repaired.status,'running');assert.equal(repaired.outcomeKnown,false);
  const otherRoot=createWorkflow({root:mkdtempSync(join(tmpdir(),'qq-other-repository-')),sessionKey:owner,env:{QQ_WORKFLOW_STATE_DIR:stateDir},notifierTransport:transport});
  assert.throws(()=>otherRoot.checkExecution({jobId:id}),/repository/);
  await assert.rejects(otherRoot.recoverDeliveries(),/repository/);assert.equal(calls.length,0,'shared state does not cross the repository boundary');
  assert.equal(readJob(stateDir,id).workflow.sessionKey,owner);
  assert.equal(readJob(stateDir,id).terminal,null,'unproven compatibility success is not an outcome');
  unlinkSync(jobPath(stateDir,id));
  assert.equal(wf.checkExecution({jobId:id}).status,'running');
  assert.deepEqual(readJob(stateDir,id).process.fingerprint,fingerprint,'process ownership reconstructed from observed authoritative identity');
  assert.equal(recordExecutionOutcome({stateDir,executionId:id,status:'completed',reportId:report.reportId}).ok,true);
  unlinkSync(jobPath(stateDir,id));
  const recovered=await wf.recoverDeliveries();
  assert.ok(recovered.reconstruction.restored.includes(id));
  assert.equal(readJob(stateDir,id).status,'completed');assert.equal(calls.length,1);
  assert.equal(calls[0].reportId,report.reportId);assert.ok(wf.readReport({reportId:report.reportId}).ok);
  unlinkSync(jobPath(stateDir,id));
  await wf.recoverDeliveries();assert.equal(calls.length,1,'journal receipt survives complete compatibility-cache reconstruction');
  assert.equal(wf.jobsView()[0].status,'completed');
  console.log('PASS execution cache reconstruction: forged owner cannot signal/steer/notify, cache success refused, missing jobs rebuilt with original process/report/receipt and no relaunch');
} finally {
  if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');await stopped;}
}
