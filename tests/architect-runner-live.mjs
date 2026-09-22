// Actual Architect extension + native runner + installed Pi + localhost model.
// No fake notifier: idle wake and report retrieval occur in the Pi session.
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {localPiProvider} from './support/local-pi-provider.mjs';
import {PiRpcClient} from '../workflow/pi-worker/rpc.mjs';
import {listJobs,processFingerprint} from '../workflow/jobs.mjs';
const owner='8363815a-d0b2-4fd9-ab52-6e82258871a1';
for(const reload of [false,true]) {
 let architectCalls=0,workerCalls=0,workerEntered=false,readSeen=false;
 let release;const gate=new Promise(done=>release=done);
 let fixture;
 fixture=await localPiProvider({respond:async({body})=>{
  const names=(body.tools??[]).map(t=>t.function?.name);
  if(!names.includes('dispatch_runner')) {workerCalls++;workerEntered=true;await gate;return {text:'Live Architect recovery proof: durable findings.'};}
  architectCalls++;
  if(architectCalls===1)return {toolCalls:[{name:'dispatch_runner',arguments:{task:'Return the brief durable finding requested by this isolated fixture.'}}]};
  if(architectCalls===2)return {text:'Runner dispatched; waiting for its pushed completion.'};
  if(architectCalls===3){
   const job=listJobs(fixture.env.QQ_WORKFLOW_STATE_DIR,{sessionKey:owner}).at(-1);
   assert.equal(job.status,'completed');assert.ok(job.terminal.reportId,'report exists before idle wake');
   assert.match(JSON.stringify(body.messages),/durable findings/,'notification reached model without operator prompt');
   return {toolCalls:[{name:'read_report',arguments:{reportId:job.terminal.reportId}}]};
  }
  assert.match(JSON.stringify(body.messages),/Live Architect recovery proof/);readSeen=true;
  return {text:'Retrieved the durable runner report automatically.'};
 }});
 if(!fixture){console.log('SKIP Architect runner live: installed Pi unavailable');break;}
 writeFileSync(join(fixture.env.PI_CODING_AGENT_DIR,'settings.json'),JSON.stringify({compaction:{enabled:false,reserveTokens:16384,keepRecentTokens:20000}}));
 const sessionFile=join(fixture.root,'architect.jsonl');const clients=[];
 const launch=()=>{
  const client=new PiRpcClient({bin:fixture.pi,cwd:fixture.root,env:{...fixture.env,QQ_WORKFLOW_SESSION_ID:owner,PASEO_AGENT_ID:owner},args:['--mode','rpc','--provider',fixture.provider,'--model',fixture.model,'--session',sessionFile,'--no-extensions','--extension',fileURLToPath(new URL('../pi-extension/qq-architect.mjs',import.meta.url)),'--no-approve']});
  clients.push(client);client.start();return client;
 };
 const wait=async(predicate,ms=90000)=>{const until=Date.now()+ms;while(Date.now()<until){if(await predicate())return;await new Promise(done=>setTimeout(done,100));}throw new Error(`Architect live timeout (reload=${reload}, architect=${architectCalls}, worker=${workerCalls}): ${clients.at(-1)?.stderrTail}`);};
 try {
  let client=launch();await client.request({type:'get_state'});
  await client.request({type:'prompt',message:'Dispatch the isolated proof runner, then wait for its completion.'});
  await wait(async()=>workerEntered&&architectCalls===2&&(await client.request({type:'get_state'})).isStreaming===false);
  if(reload){process.kill(client.pid,'SIGKILL');await client.waitForExit();client=launch();await client.request({type:'get_state'});}
  release();
  // No prompt, check_runner, recover_deliveries or polling tool is sent to Pi.
  // Inspection here only observes the test's durable files and provider seam.
  await wait(()=>readSeen);
  await wait(()=>listJobs(fixture.env.QQ_WORKFLOW_STATE_DIR,{sessionKey:owner})[0]?.delivery?.state==='delivered');
  assert.equal(workerCalls,1,'worker never relaunched');assert.equal(architectCalls,4,'one automatic completion wake');
  const entries=readFileSync(sessionFile,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const reports=entries.filter(e=>e.message?.role==='toolResult'&&e.message?.toolName==='read_report');
  assert.equal(reports.length,1);assert.equal(reports[0].message.isError,false);
  console.log(`PASS actual Architect Pi ${reload?'process replacement':'idle'}: native dispatch, automatic completion wake, durable read_report, observed delivery receipt, no worker relaunch`);
 }finally{
  release();
  for(const client of clients)try{process.kill(client.pid,'SIGTERM');}catch{}
  await Promise.all(clients.map(client=>client.waitForExit()));
  for(const job of listJobs(fixture.env.QQ_WORKFLOW_STATE_DIR,{sessionKey:owner})){
   const expected=job.process?.fingerprint;const current=processFingerprint({pid:job.process?.pid});
   if(expected&&current&&expected.startTicks===current.startTicks&&expected.cmdlineHash===current.cmdlineHash)try{process.kill(current.pid,'SIGTERM');}catch{}
  }
  await fixture.stop();
 }
}
