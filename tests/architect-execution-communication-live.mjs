// Final integrated acceptance: actual Architect Pi + managed host + actual Pi
// implementer/reviewer + real relay + isolated local Git landing. Only the
// inference provider is deterministic localhost; no notification seam.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {localPiProvider} from './support/local-pi-provider.mjs';
import {PiRpcClient} from '../workflow/pi-worker/rpc.mjs';
import {loadPaseoRpcClient} from './support/paseo-rpc.mjs';
const paseoReload=process.env.QQ_TEST_PASEO_RELOAD==='1';
const RpcClient=paseoReload?await loadPaseoRpcClient():PiRpcClient;
if(!RpcClient){console.log('SKIP Architect execution Paseo reload: installed Paseo unavailable');process.exit(0);}
import {listJobs,processFingerprint} from '../workflow/jobs.mjs';
import {openChange,viewsFor} from '../workflow/change-record.mjs';
import {readReport} from '../workflow/reports.mjs';

const owner='064b8aaa-347b-4df9-a0aa-8aa5f13abceb';
const phase='d4f117e8-fb15-462d-8b3b-4f7d91b81514';
for (const reload of (paseoReload?[true]:[false,true])) {
 let fixture,base,pendingAction=null,readSeen=false;
 const counts={implementer:0,reviewer:0},updates={},returned={};
 const gates={},release={};
 for(const key of ['implementer-start','implementer-update','reviewer-start','reviewer-update'])gates[key]=new Promise(resolve=>release[key]=resolve);
 const execution=()=>listJobs(fixture.env.QQ_WORKFLOW_STATE_DIR,{sessionKey:owner}).find(job=>job.role==='execution');
 const roleState=role=>{
  const record=openChange({stateDir:fixture.env.QQ_WORKFLOW_STATE_DIR,changeId:execution().id}).state;
  const view=viewsFor(record),job=view.jobs().filter(job=>job.role===role).at(-1);
  assert.ok(job,`${role} registered before provider invocation`);
  const details=view.job(job.id),attempt=details.attempts[details.attemptOrder.at(-1)];
  return {job:details,attempt};
 };
 fixture=await localPiProvider({respond:async({body})=>{
  const names=(body.tools??[]).map(tool=>tool.function?.name);
  const text=JSON.stringify(body.messages);
  if(!names.includes('dispatch_execution')) {
   assert.ok(names.includes('workflow_read_assignment'),'managed role exposes real communication tools');
   const prompt=body.messages.filter(message=>message.role==='user').map(message=>typeof message.content==='string'?message.content:JSON.stringify(message.content)).join('\n');
   const match=prompt.match(/(Implement|Follow) '([^']+)\/\.architect\/ticket\.md'/);
   assert.ok(match,'canonical role prompt identifies the preserved phase worktree');
   const role=match[1]==='Implement'?'implementer':'reviewer',call=++counts[role];
   if(call===1){await gates[`${role}-start`];return {toolCalls:[{name:'workflow_read_assignment'}]};}
   if(call===2)return {toolCalls:[{name:'workflow_acknowledge_assignment',arguments:{revision:roleState(role).attempt.launchIntent.revision}}]};
   if(call===3)return {toolCalls:[{name:'workflow_report_progress',arguments:{kind:'progress',message:`${role} inspected the original phase constraints and is ready for its amendment.`}}]};
   if(call===4){await gates[`${role}-update`];return {toolCalls:[{name:'workflow_read_assignment'}]};}
   if(call===5){assert.match(text,new RegExp(`${role} marker`));return {toolCalls:[{name:'workflow_acknowledge_assignment',arguments:{revision:updates[role]}}]};}
   if(call===6)return role==='implementer'
    ? {toolCalls:[{name:'write',arguments:{path:join(match[2],'proof.txt'),content:'finished with implementer marker\n'}}]}
    : {toolCalls:[{name:'bash',arguments:{command:`test "$(cat '${join(match[2],'proof.txt')}')" = 'finished with implementer marker'`}}]};
   assert.equal(call,7,'no automatic worker retry or relaunch');
   return {text:role==='implementer'?'Implemented proof.txt with implementer marker.':'Verdict: PASS\nVerified proof.txt and incorporated reviewer marker.'};
  }
  assert.ok(names.includes('steer_execution'),'Architect exposes scoped execution amendments');
  if(pendingAction?.kind==='update') {
   const role=pendingAction.role;
   const {job}=roleState(role);
   updates[role]=job.effectiveRevision;
   assert.match(text,/recorded/,'submission reports durable recording');
   returned[role]=true;pendingAction=null;
   return {text:`The ${role} amendment is submitted; acknowledgement remains a separate fact.`};
  }
  if(pendingAction?.kind==='report') {
   assert.match(text,/reportId/);
   const next=pendingAction.remaining.shift();
   if(next)return {toolCalls:[{name:'read_report',arguments:{reportId:next}}]};
   readSeen=true;pendingAction=null;
   return {text:'Read the durable execution and both role reports after amended work completed.'};
  }
  if(pendingAction?.kind==='check') {
   const reports=['implementer','reviewer'].map(role=>roleState(role).attempt.outcome.reportId);
   for(const reportId of reports){assert.ok(reportId);assert.ok(text.includes(reportId),'normal check_execution exposes each role report reference');}
   pendingAction={kind:'report',remaining:reports};
   return {toolCalls:[{name:'read_report',arguments:{reportId:execution().terminal.reportId}}]};
  }
  const current=execution();
  if(!current)return {toolCalls:[{name:'dispatch_execution',arguments:{kind:'open',phaseId:phase,baseRef:base}}]};
  if(current.terminal){
   assert.equal(current.status,'completed',JSON.stringify(current.terminal));
   assert.ok(readReport(fixture.env.QQ_WORKFLOW_STATE_DIR,current.terminal.reportId).ok,'report registered before idle completion wake');
   pendingAction={kind:'check'};return {toolCalls:[{name:'check_execution',arguments:{jobId:current.id}}]};
  }
  for(const role of ['implementer','reviewer']){
   if(counts[role]<3||returned[role])continue;
   assert.match(text,new RegExp(`${role} inspected the original phase constraints`),'actual committed progress woke Architect');
   const {job,attempt}=roleState(role);
   pendingAction={kind:'update',role};
   return {toolCalls:[{name:'steer_execution',arguments:{jobId:current.id,expectJobId:job.id,expectAttemptId:attempt.id??job.attemptOrder.at(-1),message:`Include ${role} marker in your final report; preserve the approved phase constraints.`}}]};
  }
  return {text:'Waiting for pushed role progress and execution completion.'};
 }});
 if(!fixture){console.log('SKIP Architect execution communication: installed Pi unavailable');break;}
 const git=args=>execFileSync('git',args,{cwd:fixture.root,encoding:'utf8'}).trim();
 git(['init','-b','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);
 writeFileSync(join(fixture.root,'base.txt'),'base');git(['add','base.txt']);git(['commit','-m','fixture base']);base=git(['rev-parse','HEAD']);
 mkdirSync(join(fixture.root,'.architect','tickets'),{recursive:true});
 writeFileSync(join(fixture.root,'.architect','tickets',`${phase}.md`),'# Isolated communication acceptance\n\n## Solution\nCreate proof.txt containing finished with implementer marker. Preserve all original constraints across amendments.\n\n## Testing plan\nVerify the exact proof.txt content.\n');
 writeFileSync(join(fixture.env.PI_CODING_AGENT_DIR,'settings.json'),JSON.stringify({compaction:{enabled:false,reserveTokens:16384,keepRecentTokens:20000}}));
 const sessionFile=join(fixture.root,'architect.jsonl'),clients=[];
 const launch=()=>{const client=new RpcClient({bin:fixture.pi,cwd:fixture.root,env:{...fixture.env,QQ_WORKFLOW_SESSION_ID:owner,PASEO_AGENT_ID:owner},args:['--mode','rpc','--provider',fixture.provider,'--model',fixture.model,'--session',sessionFile,'--no-extensions','--extension',fileURLToPath(new URL('../pi-extension/qq-architect.mjs',import.meta.url)),'--no-approve']});clients.push(client);client.start();return client;};
 const wait=async(predicate,ms=90000)=>{const until=Date.now()+ms;while(Date.now()<until){if(await predicate())return;const job=execution();if(job?.status==='failed'||job?.status==='reconciliation-required'){const report=job.terminal?.reportId?readReport(fixture.env.QQ_WORKFLOW_STATE_DIR,job.terminal.reportId):null;throw Error(`execution failed before acceptance: ${report?.text??JSON.stringify(job.recovery??job.terminal)}`);}await new Promise(resolve=>setTimeout(resolve,100));}throw Error(`execution communication timeout ${JSON.stringify({reload,counts,returned,status:execution()?.status,phase:execution()?.phase})}: ${clients.at(-1)?.stderrTail}`)};
 try {
  let client=launch();await client.request({type:'get_state'});
  await client.request({type:'prompt',message:'Dispatch the approved isolated execution. Wait for pushed implementer and reviewer progress, submit one scoped amendment to each, and read the completion report.'});
  await wait(async()=>execution()&&(await client.request({type:'get_state'})).isStreaming===false);release['implementer-start']();
  await wait(async()=>returned.implementer&&(await client.request({type:'get_state'})).isStreaming===false);
  if(reload){if(paseoReload)await client.close();else process.kill(client.pid,'SIGKILL');await client.waitForExit();client=launch();await client.request({type:'get_state'});}
  release['implementer-update']();
  await wait(async()=>counts.reviewer>=1&&(await client.request({type:'get_state'})).isStreaming===false);release['reviewer-start']();
  await wait(async()=>returned.reviewer&&(await client.request({type:'get_state'})).isStreaming===false);release['reviewer-update']();
  await wait(()=>readSeen);await wait(()=>execution()?.delivery?.state==='delivered');
  for(const role of ['implementer','reviewer']){
   const {job,attempt}=roleState(role);
   assert.equal(attempt.outcome.status,'completed');assert.equal(attempt.outcome.revision,updates[role]);assert.equal(job.pendingAmendments.length,0);
   const report=readReport(fixture.env.QQ_WORKFLOW_STATE_DIR,attempt.outcome.reportId);
   assert.equal(report.ok,true);assert.match(report.text,new RegExp(`${role} marker`));assert.equal(counts[role],7);
  }
  assert.equal(git(['show','main:proof.txt']),'finished with implementer marker');
  const entries=readFileSync(sessionFile,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  for(const [name,count] of [['dispatch_execution',1],['steer_execution',2],['check_execution',1],['read_report',3]]){
   const found=entries.filter(entry=>entry.message?.role==='toolResult'&&entry.message?.toolName===name);assert.equal(found.length,count,name);assert.ok(found.every(entry=>!entry.message.isError),name);
  }
  console.log(`PASS actual Architect ${paseoReload?'Paseo close/reopen':reload?'reopened':'idle'}: scoped implementer/reviewer progress, amendments, acknowledgements, revision-bound reports, automatic execution completion and isolated landing`);
 } finally {
  Object.values(release).forEach(resolve=>resolve());
  for(const client of clients)try{process.kill(client.pid,'SIGTERM');}catch{}
  await Promise.all(clients.map(client=>client.waitForExit()));
  for(const job of listJobs(fixture.env.QQ_WORKFLOW_STATE_DIR,{sessionKey:owner})){
   const expected=job.process?.fingerprint,observed=processFingerprint({pid:job.process?.pid});
   if(expected&&observed&&expected.startTicks===observed.startTicks&&expected.cmdlineHash===observed.cmdlineHash)try{process.kill(observed.pid,'SIGTERM');}catch{}
  }
  await fixture.stop();
 }
}
