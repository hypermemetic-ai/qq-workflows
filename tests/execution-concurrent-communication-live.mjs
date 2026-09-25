// Installed Pi roles in two production owned hosts share one real relay.
// Finish A while B waits, then amend B after A releases all runtime holds.
// Localhost inference and isolated Git; notification consumption is simulated.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {localPiProvider} from './support/local-pi-provider.mjs';
import {createWorkflow} from '../workflow/operations.mjs';
import {launchExecutionHost} from '../workflow/execution-supervisor.mjs';
import {readJob,processFingerprint} from '../workflow/jobs.mjs';
import {openChange,viewsFor} from '../workflow/change-record.mjs';

const owner='a9165a30-8930-4e25-9fd4-d332bf9e8b37';
const phases={A:'aaaaaaaa-a123-4123-8123-aaaaaaaaaaaa',B:'bbbbbbbb-b123-4123-8123-bbbbbbbbbbbb'};
const counts={A:0,B:0},ids={},revisions={},release={},gates={};
for(const label of ['A','B'])gates[label]=new Promise(done=>release[label]=done);
let fixture,wf;
const attemptFor=label=>{
  const views=viewsFor(openChange({stateDir:wf.stateDir,changeId:ids[label]}).state);
  const role=views.jobs().find(job=>job.role==='implementer');
  const job=views.job(role.id);return {job,attempt:job.attempts[job.attemptOrder.at(-1)]};
};
fixture=await localPiProvider({respond:async({body})=>{
  const prompt=body.messages.filter(m=>m.role==='user').map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
  const match=prompt.match(/Implement '([^']+)\/\.architect\/ticket\.md'/);assert.ok(match);
  const label=match[1].includes(phases.A.slice(0,8))?'A':'B',call=++counts[label];
  if(call===1)return {toolCalls:[{name:'workflow_read_assignment'}]};
  if(call===2)return {toolCalls:[{name:'workflow_acknowledge_assignment',arguments:{revision:attemptFor(label).attempt.launchIntent.revision}}]};
  if(call===3)return {toolCalls:[{name:'workflow_report_progress',arguments:{kind:'progress',message:`Worker ${label} is ready.`}}]};
  if(call===4){await gates[label];return {toolCalls:[{name:'workflow_read_assignment'}]};}
  if(call===5){assert.match(JSON.stringify(body.messages),new RegExp(`Amendment ${label}`));return {toolCalls:[{name:'workflow_acknowledge_assignment',arguments:{revision:revisions[label]}}]};}
  if(call===6)return {toolCalls:[{name:'write',arguments:{path:join(match[1],`${label}.txt`),content:`${label} done\n`}}]};
  assert.equal(call,7,'no retry/relaunch');return {text:`Implemented ${label}.txt and acknowledged Amendment ${label}.\n<!-- qq-final-disposition: completed -->`};
}});
if(!fixture){console.log('SKIP concurrent execution communication: installed Pi unavailable');process.exit(0);}
const git=args=>execFileSync('git',args,{cwd:fixture.root,encoding:'utf8'}).trim();
git(['init','-b','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);
writeFileSync(join(fixture.root,'base.txt'),'base');git(['add','base.txt']);git(['commit','-m','fixture base']);
const base=git(['rev-parse','HEAD']);
mkdirSync(join(fixture.root,'.architect','tickets'),{recursive:true});
for(const label of ['A','B'])writeFileSync(join(fixture.root,'.architect','tickets',`${phases[label]}.md`),`# Concurrent ${label}\nCreate ${label}.txt containing ${label} done. Preserve this original constraint.\n`);
const notes=[];
wf=createWorkflow({root:fixture.root,sessionKey:owner,env:fixture.env,
  executionLauncher:args=>launchExecutionHost({stateDir:args.stateDir,jobId:args.jobId,root:args.cwd,owner:args.workflow.sessionKey,kind:args.kind,phaseId:args.phaseId,baseRef:args.baseRef,env:fixture.env}),
  notifierTransport:{name:'fixture-consumer',deliver:async note=>{assert.ok(wf.readReport({reportId:note.reportId}).ok);notes.push(note);return {state:'delivered',receipt:{kind:'fixture',confirmed:true}};}}});
const wait=async predicate=>{const deadline=Date.now()+90000;while(Date.now()<deadline){await wf.recoverDeliveries();if(await predicate())return;for(const id of Object.values(ids)){const job=readJob(wf.stateDir,id);if(job?.status==='failed')throw Error(wf.readReport({reportId:job.terminal.reportId}).text);}await new Promise(done=>setTimeout(done,100));}throw Error(`concurrent role timeout ${JSON.stringify({counts,notes:notes.map(n=>n.kind)})}`);};
try {
  for(const label of ['A','B'])ids[label]=wf.dispatchExecution({kind:'bounded',phaseId:phases[label],baseRef:base}).jobId;
  await wait(()=>['A','B'].every(label=>notes.some(note=>note.eventId.includes(`:progress:${ids[label]}:`)&&note.kind==='execution.progress')));
  const bBefore=readJob(wf.stateDir,ids.B).process.fingerprint;
  for(const label of ['A','B']) {
    const {job,attempt}=attemptFor(label);
    const submitted=await wf.steerExecution({jobId:ids[label],expectJobId:job.id,expectAttemptId:attempt.id,message:`Amendment ${label}: retain the original required file and report this marker.`});
    assert.equal(submitted.ok,true,JSON.stringify(submitted));assert.equal(submitted.acknowledged,false);revisions[label]=submitted.revision;
    release[label]();
    // Both started from the same explicit base. A advances main, so bounded
    // fast-forward-only landing must truthfully refuse B's divergent branch.
    await wait(()=>readJob(wf.stateDir,ids[label]).status===(label==='A'?'completed':'failed'));
    if(label==='B')assert.match(wf.readReport({reportId:readJob(wf.stateDir,ids.B).terminal.reportId}).text,/cannot fast-forward/);
    assert.equal(attemptFor(label).attempt.outcome.revision,revisions[label]);
    assert.ok(wf.readReport({reportId:attemptFor(label).attempt.outcome.reportId}).ok);
    assert.ok(wf.checkExecution({jobId:ids[label]}).authority.execution.worktreeSelection.baseSelection.sha);
    if(label==='A') {
      await wait(()=>!processFingerprint({pid:readJob(wf.stateDir,ids.A).process.pid}));
      assert.equal(processFingerprint({pid:bBefore.pid})?.startTicks,bBefore.startTicks,'finishing A never kills B');
      assert.equal(readJob(wf.stateDir,ids.B).status,'running');
    }
  }
  await wf.recoverDeliveries();
  for(const label of ['A','B']) {
    assert.equal(notes.filter(note=>note.jobId===ids[label]&&note.kind==='execution.terminal').length,1);
    assert.equal(git(['show',`${label==='A'?'main':'architect/bounded/bbbbbbbb'}:${label}.txt`]),`${label} done`);assert.equal(counts[label],7);
  }
  console.log('PASS concurrent production managed Pi roles: isolated amendments/reports, A cleanup preserves B relay and host, A lands and B truthfully reports divergent-base landing failure');
} finally {
  Object.values(release).forEach(done=>done());
  for(const id of Object.values(ids)){const job=readJob(wf.stateDir,id),known=job?.process?.fingerprint,current=processFingerprint({pid:job?.process?.pid});if(known&&current&&known.startTicks===current.startTicks&&known.cmdlineHash===current.cmdlineHash)try{process.kill(current.pid,'SIGTERM');}catch{}}
  await fixture.stop();
}
