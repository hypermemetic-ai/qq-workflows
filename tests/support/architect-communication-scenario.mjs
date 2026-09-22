// Requires communication-enabled Pi. Imported by the integrated live test.
// Production Architect/worker extensions, real relay, localhost provider only.
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {localPiProvider} from './local-pi-provider.mjs';
import {PiRpcClient} from '../../workflow/pi-worker/rpc.mjs';
import {listJobs,processFingerprint} from '../../workflow/jobs.mjs';
import {openChange,viewsFor} from '../../workflow/change-record.mjs';
const owner='8363815a-d0b2-4fd9-ab52-6e82258871a1';
for(const reload of [false,true]) {
 let architectCalls=0,workerCalls=0,readSeen=false,updateReturned=false;
 let beginWorker,finishWorker;const workerGate=new Promise(done=>beginWorker=done),updateGate=new Promise(done=>finishWorker=done);
 let fixture;
 const job=()=>listJobs(fixture.env.QQ_WORKFLOW_STATE_DIR,{sessionKey:owner}).at(-1);
 fixture=await localPiProvider({respond:async({body})=>{
  const names=(body.tools??[]).map(t=>t.function?.name);
  if(!names.includes('dispatch_runner')) {
   workerCalls++;
   assert.ok(names.includes('workflow_read_assignment'),'actual worker communication tools exposed');
   if(workerCalls===1){await workerGate;return {toolCalls:[{name:'workflow_read_assignment'}]};}
   if(workerCalls===2)return {toolCalls:[{name:'workflow_acknowledge_assignment',arguments:{revision:1}}]};
   if(workerCalls===3)return {toolCalls:[{name:'workflow_report_progress',arguments:{kind:'progress',message:'Inspected the initial assignment; ready for the requested amendment.'}}]};
   if(workerCalls===4){await updateGate;return {toolCalls:[{name:'workflow_read_assignment'}]};}
   if(workerCalls===5){assert.match(JSON.stringify(body.messages),/Include revised marker/);return {toolCalls:[{name:'workflow_acknowledge_assignment',arguments:{revision:2}}]};}
   assert.equal(workerCalls,6);
   return {text:'Live communication proof: revised marker included after reading and acknowledging revision 2.'};
  }
  architectCalls++;
  if(architectCalls===1)return {toolCalls:[{name:'dispatch_runner',arguments:{task:'Read and acknowledge the assignment; inspect it and report useful progress. Incorporate the subsequent assignment amendment in the final findings.'}}]};
  if(architectCalls===2)return {text:'Dispatched; waiting for pushed progress.'};
  if(architectCalls===3){assert.match(JSON.stringify(body.messages),/Inspected the initial assignment/);return {toolCalls:[{name:'steer_runner',arguments:{jobId:job().id,message:'Include revised marker in the final report.'}}]};}
  if(architectCalls===4){assert.match(JSON.stringify(body.messages),/recorded/);updateReturned=true;return {text:'Update recorded; worker acknowledgement is a separate later fact.'};}
  if(architectCalls===5){
   const current=job();assert.equal(current.status,'completed');assert.ok(current.terminal.reportId);
   const state=openChange({stateDir:fixture.env.QQ_WORKFLOW_STATE_DIR,changeId:current.communication.changeId}).state;
   const view=viewsFor(state).job(current.id),attempt=view.attempts[current.communication.attemptId];
   assert.equal(attempt.outcome.revision,2);assert.equal(view.pendingAmendments.length,0);
   return {toolCalls:[{name:'read_report',arguments:{reportId:current.terminal.reportId}}]};
  }
  assert.equal(architectCalls,6);assert.match(JSON.stringify(body.messages),/revised marker included/);readSeen=true;
  return {text:'Retrieved the durable report covering acknowledged revision 2.'};
 }});
 if(!fixture){console.log('SKIP Architect communication live: installed Pi unavailable');break;}
 writeFileSync(join(fixture.env.PI_CODING_AGENT_DIR,'settings.json'),JSON.stringify({compaction:{enabled:false,reserveTokens:16384,keepRecentTokens:20000}}));
 const sessionFile=join(fixture.root,'architect.jsonl'),clients=[];
 const launch=()=>{const client=new PiRpcClient({bin:fixture.pi,cwd:fixture.root,env:{...fixture.env,QQ_WORKFLOW_SESSION_ID:owner,PASEO_AGENT_ID:owner},args:['--mode','rpc','--provider',fixture.provider,'--model',fixture.model,'--session',sessionFile,'--no-extensions','--extension',fileURLToPath(new URL('../../pi-extension/qq-architect.mjs',import.meta.url)),'--no-approve']});clients.push(client);client.start();return client;};
 const wait=async(predicate,ms=90000)=>{const until=Date.now()+ms;while(Date.now()<until){if(await predicate())return;await new Promise(done=>setTimeout(done,100));}throw new Error(`Architect communication timeout (reload=${reload}, architect=${architectCalls}, worker=${workerCalls}): ${clients.at(-1)?.stderrTail}`);};
 try {
  let client=launch();await client.request({type:'get_state'});
  await client.request({type:'prompt',message:'Dispatch the isolated proof runner and wait for pushed progress. Submit the requested amendment when it reports progress, then wait for completion and read the report.'});
  await wait(async()=>architectCalls===2&&(await client.request({type:'get_state'})).isStreaming===false);beginWorker();
  await wait(async()=>updateReturned&&(await client.request({type:'get_state'})).isStreaming===false);
  if(reload){process.kill(client.pid,'SIGKILL');await client.waitForExit();client=launch();await client.request({type:'get_state'});}
  finishWorker();await wait(()=>readSeen);
  await wait(()=>job()?.delivery?.state==='delivered');
  const entries=readFileSync(sessionFile,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  for(const name of ['dispatch_runner','steer_runner','read_report']){const found=entries.filter(e=>e.message?.role==='toolResult'&&e.message?.toolName===name);assert.equal(found.length,1,name);assert.equal(found[0].message.isError,false,name);}
  assert.equal(workerCalls,6);assert.equal(architectCalls,6);
  console.log(`PASS actual Architect Pi ${reload?'reopened after amendment':'idle'}: pushed committed progress wakes Architect, native update distinguishes submission from acknowledgement, worker reads/acks revision2, automatic completion and durable read_report`);
 }finally {
  beginWorker();finishWorker();for(const client of clients)try{process.kill(client.pid,'SIGTERM');}catch{}
  await Promise.all(clients.map(client=>client.waitForExit()));
  for(const current of listJobs(fixture.env.QQ_WORKFLOW_STATE_DIR,{sessionKey:owner})){const expected=current.process?.fingerprint,observed=processFingerprint({pid:current.process?.pid});if(expected&&observed&&expected.startTicks===observed.startTicks&&expected.cmdlineHash===observed.cmdlineHash)try{process.kill(observed.pid,'SIGTERM');}catch{}}
  await fixture.stop();
 }
}
