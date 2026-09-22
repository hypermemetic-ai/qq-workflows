// Full production managed pipeline: real installed Pi implementer + reviewer,
// localhost provider, isolated Git landing, detached host, coordinator death.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {localPiProvider} from './support/local-pi-provider.mjs';
import {createWorkflow} from '../workflow/operations.mjs';
import {readJob,processFingerprint} from '../workflow/jobs.mjs';
import {loadPaseoTreeTerminator} from './support/paseo-rpc.mjs';
const treeStop=process.env.QQ_TEST_PASEO_TREE==='1'?await loadPaseoTreeTerminator():null;
if(process.env.QQ_TEST_PASEO_TREE==='1'&&!treeStop){console.log('SKIP managed execution tree teardown: installed Paseo unavailable');process.exit(0);}
const owner='3f5d2a88-0ce8-4dce-86a8-f2802c079777';
const phase='bf1ec269-2cab-4a54-8e83-342b90c2f8d8';
let entered=false;let release;const gate=new Promise(done=>release=done);
const fixture=await localPiProvider({respond:async({body,call})=>{
 const message=body.messages.filter(m=>m.role==='user').map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
 const match=message.match(/(?:Follow|Implement) '([^']+)\/\.architect\/ticket\.md'/);
 if(call===1){entered=true;await gate;assert.ok(match,message);return {toolCalls:[{name:'write',arguments:{path:join(match[1],'proof.txt'),content:'finished\n'}}]};}
 if(call===2)return {text:'Implemented proof.txt as requested.'};
 if(call===3){assert.ok(match,message);return {toolCalls:[{name:'bash',arguments:{command:`test -s '${join(match[1],'proof.txt')}'`}}]};}
 return {text:'Verdict: PASS\nVerified the requested proof.txt exists and the verification command passed.'};
}});
if(!fixture){console.log('SKIP managed execution reload live: installed Pi unavailable');process.exit(0);}
const git=args=>execFileSync('git',args,{cwd:fixture.root,encoding:'utf8'}).trim();
git(['init','-b','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);
writeFileSync(join(fixture.root,'base.txt'),'base');git(['add','base.txt']);git(['commit','-m','fixture base']);
const base=git(['rev-parse','HEAD']);
mkdirSync(join(fixture.root,'.architect','tickets'),{recursive:true});
writeFileSync(join(fixture.root,'.architect','tickets',`${phase}.md`),'# Isolated fixture\n\n## Solution\nCreate proof.txt containing finished.\n\n## Testing plan\nVerify proof.txt exists.\n');
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
 const report=JSON.parse(wf.readReport({reportId:job.terminal.reportId}).text);
 assert.equal(report.result.childAttempts.length,2);
 for(const attempt of report.result.childAttempts){assert.equal(attempt.status,'completed');assert.ok(wf.readReport({reportId:attempt.reportId}).ok);}
 assert.equal(notifications.length,1);await wf.recoverDeliveries();assert.equal(notifications.length,1);
 assert.equal(fixture.calls,4,'no relaunch or repeated implementation/review');
 console.log(`PASS actual managed pipeline + installed Pi: coordinator ${treeStop?'Paseo recursive teardown':'PID death'} mid-implementation, host completes implementer/reviewer/local Git landing, role reports and terminal report retrieved, notification replay deduped`);
}finally{
 release();if(parent.exitCode===null&&parent.signalCode===null)parent.kill('SIGTERM');
 if(jobId){const job=readJob(fixture.env.QQ_WORKFLOW_STATE_DIR,jobId);const known=job?.process?.fingerprint;const current=processFingerprint({pid:job?.process?.pid});if(known&&current&&known.startTicks===current.startTicks&&known.cmdlineHash===current.cmdlineHash)try{process.kill(current.pid,'SIGTERM');}catch{}}
 await fixture.stop();
}
