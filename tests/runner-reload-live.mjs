import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {localPiProvider} from './support/local-pi-provider.mjs';
import {createWorkflow} from '../workflow/operations.mjs';
import {readJob,processFingerprint} from '../workflow/jobs.mjs';
let releaseAnswer;let observedRequest=false;
const answer=new Promise(done=>{releaseAnswer=done;});
const fixture=await localPiProvider({respond:async()=>{observedRequest=true;await answer;return {text:'Durable findings after coordinator process disappearance.'};}});
if(!fixture){console.log('SKIP runner reload live: installed Pi unavailable');process.exit(0);}
const moduleUrl=new URL('../workflow/operations.mjs',import.meta.url).href;
const dispatchFile=join(fixture.root,'dispatch.json');
const parentFile=join(fixture.root,'parent.mjs');
writeFileSync(parentFile,`import {createWorkflow} from ${JSON.stringify(moduleUrl)};import {writeFileSync} from 'node:fs';const wf=createWorkflow({root:${JSON.stringify(fixture.root)},sessionKey:'reload-owner'});const job=await wf.dispatchRunner({task:'Return a brief finding.'});writeFileSync(${JSON.stringify(dispatchFile)},JSON.stringify(job));setInterval(()=>{},1000);`);
const parent=spawn(process.execPath,[parentFile],{env:fixture.env,stdio:['ignore','ignore','pipe']});
let stderr='';parent.stderr.on('data',c=>stderr+=c);
let jobId;
const wait=async(predicate,ms=90000)=>{const until=Date.now()+ms;while(Date.now()<until){if(await predicate())return;await new Promise(done=>setTimeout(done,100));}throw new Error('timeout: '+stderr.slice(-500));};
try {
 await wait(()=>existsSync(dispatchFile)&&observedRequest);
 const launched=JSON.parse(readFileSync(dispatchFile,'utf8'));assert.equal(launched.ok,true);jobId=launched.jobId;
 const exited=new Promise(done=>parent.once('exit',done));parent.kill('SIGKILL');await exited;
 // Replacement owns the same workflow but never inherits the original live Map
 // or child callbacks. Notify is the only fake boundary in this live Pi proof.
 const notifications=[];
 const restarted=createWorkflow({root:fixture.root,sessionKey:'reload-owner',env:fixture.env,notifierTransport:{name:'fixture',deliver:async notification=>{
  const job=readJob(restarted.stateDir,jobId);
  assert.equal(job.status,'completed');assert.ok(job.terminal.reportId);
  assert.match(restarted.readReport({reportId:job.terminal.reportId}).text,/after coordinator/);
  notifications.push(notification);return {state:'delivered',receipt:{kind:'fixture-receipt',confirmed:true}};
 }}});
 releaseAnswer();
 await wait(async()=>{await restarted.recoverDeliveries();return readJob(restarted.stateDir,jobId)?.terminal;});
 const job=readJob(restarted.stateDir,jobId);assert.equal(job.status,'completed');
 assert.equal(notifications.length,1);
 await restarted.recoverDeliveries();assert.equal(notifications.length,1);
 assert.equal(fixture.calls,1,'no worker relaunch or duplicate model request');
 console.log('PASS installed Pi + native dispatch: kill coordinator during provider turn, explicit result recovered by new owner instance, durable report before notify, replay dedupe, no relaunch');
}finally{
 releaseAnswer();if(parent.exitCode===null&&parent.signalCode===null)parent.kill('SIGTERM');
 if(jobId){const job=readJob(join(fixture.root,'state'),jobId);const expected=job?.process?.fingerprint;const current=processFingerprint({pid:job?.process?.pid});if(expected&&current&&expected.startTicks===current.startTicks&&expected.cmdlineHash===current.cmdlineHash)try{process.kill(current.pid,'SIGTERM');}catch{}}
 await fixture.stop();
}
