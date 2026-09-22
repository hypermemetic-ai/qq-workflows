// Production native recovery with durable records and a simulated transport
// crash after queue acceptance. No provider inference or relay is simulated as
// live proof here; installed Pi/relay acceptance is retained separately.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {notificationPath,readNotification} from '../workflow/notify.mjs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createWorkflow} from '../workflow/operations.mjs';
import {createMcpExecutionSurface} from '../workflow/mcp-executions.mjs';
import {createJob,readJob,writeJob,processFingerprint} from '../workflow/jobs.mjs';
import {createChange,openChange} from '../workflow/change-record.mjs';
import {bindAttemptReceiver} from '../workflow/communication.mjs';
import {recordManagedExecution,registerRoleAttempt} from '../workflow/execution-authority.mjs';

const root=mkdtempSync(join(tmpdir(),'qq-progress-recovery-')),stateDir=join(root,'state'),owner='owner',actor={kind:'runtime',id:'fixture'};
const env={...process.env,QQ_WORKFLOW_STATE_DIR:stateDir};
const jobId=randomUUID(),attemptId=randomUUID();
createChange({stateDir,changeId:jobId,actor,commandId:'create'});
const handle=openChange({stateDir,changeId:jobId});
handle.append('assignment.revised',{revision:1,predecessor:null,scope:{kind:'change'},assignment:{instructions:'Keep the original task.'}},{context:{actor},commandId:'assignment'});
handle.append('job.registered',{role:'runner',pinnedRevision:1},{context:{actor,jobId},commandId:'job'});
handle.append('attempt.launch_intent',{owner,cwd:root},{context:{actor,jobId,attemptId},commandId:'launch'});
bindAttemptReceiver({stateDir,changeId:jobId,jobId,attemptId,sessionId:randomUUID(),seat:'runner',runtimeActorId:actor.id});
handle.append('worker.progress',{note:'Runner progress accepted before coordinator loss.'},{context:{actor:{kind:'worker',id:'worker'},jobId,attemptId},commandId:'progress'});
createJob({stateDir,id:jobId,role:'runner',workflow:{sessionKey:owner,root},cwd:root});
writeJob(stateDir,{...readJob(stateDir,jobId),process:{pid:process.pid,fingerprint:processFingerprint({pid:process.pid})},communication:{enabled:true,changeId:jobId,jobId,attemptId}});

const executionId=randomUUID(),roleId=randomUUID(),roleAttempt=randomUUID();
recordManagedExecution({stateDir,executionId,kind:'open',phaseId:randomUUID(),root,owner,constraints:'Retain the role obligation.',launchId:randomUUID(),requestPath:join(root,'request.json')});
createJob({stateDir,id:executionId,role:'execution',workflow:{sessionKey:owner,root},cwd:root});
writeJob(stateDir,{...readJob(stateDir,executionId),process:{pid:process.pid,fingerprint:processFingerprint({pid:process.pid})}});
registerRoleAttempt({stateDir,executionId,role:'reviewer',jobId:roleId,attemptId:roleAttempt,prompt:'Review.',cwd:root,owner});
bindAttemptReceiver({stateDir,changeId:executionId,jobId:roleId,attemptId:roleAttempt,sessionId:randomUUID(),seat:'reviewer',runtimeActorId:'qq-execution-authority'});
openChange({stateDir,changeId:executionId}).append('worker.progress',{note:'Reviewer progress accepted before coordinator loss.'},{context:{actor:{kind:'worker',id:'reviewer'},jobId:roleId,attemptId:roleAttempt},commandId:'progress'});

const queued=[],delivered=[];
const first=createWorkflow({root,sessionKey:owner,env,notifierTransport:{deliver:async notification=>{queued.push(notification);return {state:'queued'};}}});
await first.recoverDeliveries();assert.equal(queued.length,2);
// Simulate the journal left by a lost external callback. The notification
// subprocess regression proves the actual SIGKILL boundary separately.
for(const [index,entry] of queued.entries()) {
 const path=notificationPath(stateDir,entry.eventId),journal=JSON.parse(readFileSync(path,'utf8'));
 journal.attempt={...journal.attempt,settled:false,settledAt:null};
 if(index===1){journal.transport='execution-host-handoff';journal.reason='awaiting owning coordinator readiness';}
 writeFileSync(path,JSON.stringify(journal));
}
const transport={deliver:async notification=>{delivered.push(notification);return {state:'delivered',receipt:{kind:'fixture',confirmed:true}};}};
await createWorkflow({root,sessionKey:'foreign-owner',env,notifierTransport:transport}).recoverDeliveries();
assert.equal(delivered.length,0,'foreign owners cannot recover these obligations');
const reopened=createWorkflow({root,sessionKey:owner,env,notifierTransport:transport});
await reopened.recoverDeliveries();assert.equal(delivered.length,0,'unknown receipt state is retained, not blindly resent');
await reopened.recoverDeliveries({evidence:{entries:[],pendingMessages:false,inFlight:queued.map(entry=>entry.eventId)}});
assert.equal(delivered.length,0,'live queued messages are never duplicated');
await reopened.recoverDeliveries({evidence:{entries:[],pendingMessages:false,inFlight:[]}});
assert.equal(delivered.length,2,'proved-absent progress survives coordinator replacement after relay responsibility transfer');
assert.deepEqual(delivered.map(entry=>entry.eventId).sort(),queued.map(entry=>entry.eventId).sort());
await reopened.recoverDeliveries({evidence:{entries:[],pendingMessages:false,inFlight:[]}});
assert.equal(delivered.length,2,'receipt-confirmed progress is not duplicated');
// A retained message resolves the same uncertainty without invoking transport.
for(const entry of queued) {
 const path=notificationPath(stateDir,entry.eventId),journal=JSON.parse(readFileSync(path,'utf8'));
 journal.state='pending';journal.receipt=null;journal.attempt={...journal.attempt,settled:false};
 writeFileSync(path,JSON.stringify(journal));
}
await reopened.recoverDeliveries({evidence:{entries:queued.map(entry=>({eventId:entry.eventId,entryId:'retained-'+entry.eventId})),pendingMessages:false,inFlight:[]}});
assert.equal(delivered.length,2,'retained progress is acknowledged without a transport invocation');
for(const entry of queued){const journal=readNotification(stateDir,entry.eventId);assert.equal(journal.state,'delivered');assert.equal(journal.attempt.settled,true);}
// The shared MCP recovery sweep also recovers runners; keep their message
// attribution instead of labelling every recovered obligation an execution.
handle.append('worker.progress',{note:'MCP runner recovery progress.'},{context:{actor:{kind:'worker',id:'worker'},jobId,attemptId},commandId:'progress-mcp'});
openChange({stateDir,changeId:executionId}).append('worker.progress',{note:'MCP reviewer recovery progress.'},{context:{actor:{kind:'worker',id:'reviewer'},jobId:roleId,attemptId:roleAttempt},commandId:'progress-mcp'});
const mcpNotes=[];
const mcp=createMcpExecutionSurface({env,resolveContext:async()=>({root,owner}),notify:async(_owner,text,meta)=>{mcpNotes.push({text,...meta});return {notified:true};}});
await mcp.recover();
assert.equal(mcpNotes.find(note=>note.text.includes('MCP runner recovery progress.')).kind,'runner.progress');
assert.equal(mcpNotes.find(note=>note.text.includes('MCP reviewer recovery progress.')).kind,'execution.progress');
console.log('PASS native runner and role progress: durable queue-loss recovery, owner isolation, in-flight deferral, stable identity, receipt dedupe (transport simulation)');
