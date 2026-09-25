// Full production managed pipeline: real installed Pi implementer + reviewer,
// localhost provider, isolated Git landing, detached host, coordinator death.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {localPiProvider} from './support/local-pi-provider.mjs';
import {createWorkflow} from '../workflow/operations.mjs';
import {readJob,processFingerprint} from '../workflow/jobs.mjs';
import {reportPath} from '../workflow/reports.mjs';
import {loadPaseoTreeTerminator} from './support/paseo-rpc.mjs';
const treeStop=process.env.QQ_TEST_PASEO_TREE==='1'?await loadPaseoTreeTerminator():null;
if(process.env.QQ_TEST_PASEO_TREE==='1'&&!treeStop){console.log('SKIP managed execution tree teardown: installed Paseo unavailable');process.exit(0);}
const owner='3f5d2a88-0ce8-4dce-86a8-f2802c079777';
const phase='bf1ec269-2cab-4a54-8e83-342b90c2f8d8';
let entered=false;let release;const gate=new Promise(done=>release=done);
const counts={test_owner:0,implementer:0,reviewer:0};
const fixture=await localPiProvider({respond:async({body})=>{
 const message=body.messages.filter(m=>m.role==='user').map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
 const match=message.match(/(Prepare retained tests and the focused selection for|Implement|Review) '([^']+)\/\.architect\/ticket\.md'/);
 assert.ok(match,message);
 const role=match[1]==='Implement'?'implementer':match[1]==='Review'?'reviewer':'test_owner',call=++counts[role];
 if(role==='test_owner'){
  if(call===1)return {toolCalls:[{name:'select_tests',arguments:{targets:['proof.mjs'],rationale:'Check the agreed proof content'}}]};
  if(call===2)return {toolCalls:[{name:'run_selected_tests',arguments:{expectedRed:'proof not implemented'}}]};
  return {text:'Selected the retained proof test and recorded its expected red result.'};
 }
 if(role==='implementer'){
  if(call===1){entered=true;await gate;return {toolCalls:[{name:'write',arguments:{path:join(match[2],'proof.txt'),content:'finished\n'}}]};}
  if(call===2)return {toolCalls:[{name:'run_selected_tests'}]};
  return {text:'Implemented proof.txt and checked the selected test.\n<!-- qq-final-disposition: completed -->'};
 }
 if(call===1)return {toolCalls:[{name:'run_selected_tests'}]};
 if(call===2)return {toolCalls:[{name:'submit_review',arguments:{verdict:'PASS'}}]};
 return {text:'Verdict: PASS; verified the focused proof test.'};
}});
if(!fixture){console.log('SKIP managed execution reload live: installed Pi unavailable');process.exit(0);}
const git=args=>execFileSync('git',args,{cwd:fixture.root,encoding:'utf8'}).trim();
git(['init','-b','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);
writeFileSync(join(fixture.root,'base.txt'),'base');git(['add','base.txt']);git(['commit','-m','fixture base']);
mkdirSync(join(fixture.root,'.architect','tickets'),{recursive:true});
mkdirSync(join(fixture.root,'tests'),{recursive:true});
writeFileSync(join(fixture.root,'.architect','test-runner.json'),JSON.stringify({schema:1,command:'node',args:[],directory:'tests',extension:'.mjs'}));
writeFileSync(join(fixture.root,'tests','proof.mjs'),"import {readFileSync} from 'node:fs'; if(readFileSync('proof.txt','utf8') !== 'finished\\n') process.exitCode=1;\n");
git(['add','.architect/test-runner.json','tests/proof.mjs']);git(['commit','-m','fixture focused runner']);
const base=git(['rev-parse','HEAD']);
writeFileSync(join(fixture.root,'.architect','tickets',`${phase}.md`),'# Isolated fixture\n\n## Solution\nCreate proof.txt containing finished.\n\n## Testing plan\nBroad regression: none\nVerify proof.txt exists.\n');
const driver=join(fixture.root,'parent.mjs');const dispatchPath=join(fixture.root,'dispatch.json');
writeFileSync(driver,`import {createWorkflow} from ${JSON.stringify(new URL('../workflow/operations.mjs',import.meta.url).href)};import {loadManagedExecutionLauncher} from ${JSON.stringify(new URL('../pi-extension/managed-execution.mjs',import.meta.url).href)};import {writeFileSync} from 'node:fs';const wf=createWorkflow({root:${JSON.stringify(fixture.root)},sessionKey:${JSON.stringify(owner)},executionLauncher:loadManagedExecutionLauncher()});writeFileSync(${JSON.stringify(dispatchPath)},JSON.stringify(wf.dispatchExecution({kind:'open',phaseId:${JSON.stringify(phase)},baseRef:${JSON.stringify(base)}})));setInterval(()=>{},1000);`);
const parent=spawn(process.execPath,[driver],{env:fixture.env,stdio:['ignore','ignore','pipe']});let stderr='';parent.stderr.on('data',c=>stderr+=c);
let jobId;
const wait=async(predicate,ms=90000)=>{const deadline=Date.now()+ms;while(Date.now()<deadline){if(await predicate())return;await new Promise(done=>setTimeout(done,100));}throw new Error('managed reload timed out: '+stderr.slice(-1000));};
try {
 await wait(()=>existsSync(dispatchPath)&&entered);
 jobId=JSON.parse(readFileSync(dispatchPath,'utf8')).jobId;
 const before=readJob(fixture.env.QQ_WORKFLOW_STATE_DIR,jobId);assert.ok(before.process?.pid);assert.notEqual(before.process.pid,parent.pid);
 const exited=new Promise(done=>parent.once('exit',done));
 if(treeStop)await treeStop(parent,{gracefulTimeoutMs:2000,forceTimeoutMs:1000});else parent.kill('SIGKILL');
 await exited;
 await new Promise(done=>setTimeout(done,100));
 assert.equal(processFingerprint({pid:before.process.pid})?.startTicks,before.process.fingerprint.startTicks,'owned host survives coordinator teardown');
 release();
 await wait(()=>readJob(fixture.env.QQ_WORKFLOW_STATE_DIR,jobId)?.terminal);
 const notifications=[];
 const wf=createWorkflow({root:fixture.root,sessionKey:owner,env:fixture.env,notifierTransport:{name:'fixture',deliver:async note=>{assert.ok(wf.readReport({reportId:note.reportId}).ok);notifications.push(note);return {state:'delivered',receipt:{kind:'fixture',confirmed:true}};}}});
 await wf.recoverDeliveries();
 const job=readJob(wf.stateDir,jobId);assert.equal(job.status,'completed',JSON.stringify(job.terminal));
 assert.equal(readFileSync(join(fixture.root,'proof.txt'),'utf8'),'finished\n');
 assert.equal(wf.readReport({reportId:job.terminal.reportId}).ok,true);
 const report=JSON.parse(readFileSync(reportPath(wf.stateDir,job.terminal.reportId),'utf8'));
 assert.equal(report.result.childAttempts.length,3);
 for(const attempt of report.result.childAttempts){assert.equal(attempt.status,'completed');assert.ok(wf.readReport({reportId:attempt.reportId}).ok);}
 assert.equal(notifications.length,1);await wf.recoverDeliveries();assert.equal(notifications.length,1);
 assert.deepEqual(counts,{test_owner:3,implementer:3,reviewer:3},'no relaunch or repeated roles');
 console.log(`PASS actual managed pipeline + installed Pi: coordinator ${treeStop?'Paseo recursive teardown':'PID death'} mid-implementation, host completes test owner/implementer/reviewer/local Git landing, role reports and terminal report retrieved, notification replay deduped`);
}finally{
 release();if(parent.exitCode===null&&parent.signalCode===null)parent.kill('SIGTERM');
 if(jobId){const job=readJob(fixture.env.QQ_WORKFLOW_STATE_DIR,jobId);const known=job?.process?.fingerprint;const current=processFingerprint({pid:job?.process?.pid});if(known&&current&&known.startTicks===current.startTicks&&known.cmdlineHash===current.cmdlineHash)try{process.kill(current.pid,'SIGTERM');}catch{}}
 await fixture.stop();
}
