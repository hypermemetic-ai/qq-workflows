// Production MCP stdio + owned managed host + installed Pi roles + real relay.
// Inference is localhost; the external coordinator queue is captured, proving
// submission rather than consumption. Actual Pi Architect tests cover receipt.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {localPiProvider} from './support/local-pi-provider.mjs';
import {readJob,processFingerprint} from '../workflow/jobs.mjs';
import {readReport} from '../workflow/reports.mjs';
import {openChange,viewsFor} from '../workflow/change-record.mjs';

for(const mode of ['ordinary','reopened','cancelled']) {
  const owner='6613a2b9-c4b8-437d-9511-537f18928693',phase='940d4149-ac31-4608-84cb-67ba4ac4e7cd';
  const counts={test_owner:0,implementer:0,reviewer:0},updates={},gates={},release={};
  for(const role of Object.keys(counts))gates[role]=new Promise(resolve=>release[role]=resolve);
  let fixture,id;
  const roleState=role=>{
    const views=viewsFor(openChange({stateDir:fixture.env.QQ_WORKFLOW_STATE_DIR,changeId:id}).state);
    const row=views.jobs().filter(job=>job.role===role).at(-1);assert.ok(row);
    const job=views.job(row.id);return {job,attempt:job.attempts[job.attemptOrder.at(-1)]};
  };
  fixture=await localPiProvider({respond:async({body})=>{
    const names=(body.tools??[]).map(tool=>tool.function?.name);assert.ok(names.includes('workflow_read_assignment'));
    const text=JSON.stringify(body.messages),prompt=body.messages.filter(message=>message.role==='user').map(message=>typeof message.content==='string'?message.content:JSON.stringify(message.content)).join('\n');
    const match=prompt.match(/(Prepare retained tests and the focused selection for|Implement|Review) '([^']+)\/\.architect\/ticket\.md'/);assert.ok(match);
    const role=match[1]==='Implement'?'implementer':match[1]==='Review'?'reviewer':'test_owner',call=++counts[role];
    if(call===1)return {toolCalls:[{name:'workflow_read_assignment'}]};
    if(call===2)return {toolCalls:[{name:'workflow_acknowledge_assignment',arguments:{revision:roleState(role).attempt.launchIntent.revision}}]};
    if(call===3)return {toolCalls:[{name:'workflow_report_progress',arguments:{kind:'progress',message:`${role} is ready for the MCP amendment.`}}]};
    if(call===4){await gates[role];return {toolCalls:[{name:'workflow_read_assignment'}]};}
    if(call===5){assert.match(text,new RegExp(`${role} marker`));return {toolCalls:[{name:'workflow_acknowledge_assignment',arguments:{revision:updates[role]}}]};}
    if(role==='test_owner'){
      if(call===6)return {toolCalls:[{name:'select_tests',arguments:{targets:['proof.mjs'],rationale:'Verify the approved proof content'}}]};
      if(call===7)return {toolCalls:[{name:'run_selected_tests',arguments:{expectedRed:'proof has not been implemented'}}]};
      assert.equal(call,8);return {text:'Selected proof test, checked expected red, and incorporated test_owner marker.'};
    }
    if(call===6)return role==='implementer'?{toolCalls:[{name:'write',arguments:{path:join(match[2],'proof.txt'),content:'implemented marker\n'}}]}:{toolCalls:[{name:'run_selected_tests'}]};
    if(call===7)return role==='implementer'?{toolCalls:[{name:'run_selected_tests'}]}:{toolCalls:[{name:'submit_review',arguments:{verdict:'PASS'}}]};
    assert.equal(call,8,'no role retry or automatic relaunch');
    return {text:role==='implementer'?'Implemented proof.txt with implementer marker.':'Verdict: PASS; verified proof.txt with reviewer marker.'};
  }});
  if(!fixture){console.log('SKIP MCP execution communication: installed Pi unavailable');break;}
  const git=args=>execFileSync('git',args,{cwd:fixture.root,encoding:'utf8'}).trim();
  git(['init','-b','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);
  writeFileSync(join(fixture.root,'base.txt'),'base');git(['add','base.txt']);git(['commit','-m','fixture base']);
  mkdirSync(join(fixture.root,'.architect','tickets'),{recursive:true});
  mkdirSync(join(fixture.root,'tests'),{recursive:true});
  writeFileSync(join(fixture.root,'.architect','test-runner.json'),JSON.stringify({schema:1,command:'node',args:[],directory:'tests',extension:'.mjs'}));
  writeFileSync(join(fixture.root,'tests','proof.mjs'),"import {readFileSync} from 'node:fs'; if(readFileSync('proof.txt','utf8') !== 'implemented marker\\n') process.exitCode=1;\n");
  git(['add','.architect/test-runner.json','tests/proof.mjs']);git(['commit','-m','fixture focused runner']);
  const base=git(['rev-parse','HEAD']);
  writeFileSync(join(fixture.root,'.architect','tickets',`${phase}.md`),'# MCP managed communication proof\nCreate proof.txt containing implemented marker. Preserve all original constraints across amendments.\n\n## Testing plan\nBroad regression: none\n');
  const notesPath=join(fixture.root,'notes.jsonl'),driver=join(fixture.root,'mcp.mjs');
  writeFileSync(driver,`import {startMcpServer} from ${JSON.stringify(new URL('../bin/mcp-server.mjs',import.meta.url).href)};import {appendFileSync} from 'node:fs';import {readJob} from ${JSON.stringify(new URL('../workflow/jobs.mjs',import.meta.url).href)};import {readReport} from ${JSON.stringify(new URL('../workflow/reports.mjs',import.meta.url).href)};globalThis.__QQ_TEST_NOTIFY_HANDLER=note=>{const job=readJob(process.env.QQ_WORKFLOW_STATE_DIR,note.trackerId);const registered=note.kind==='execution.terminal'?Boolean(job?.terminal?.reportId&&readReport(process.env.QQ_WORKFLOW_STATE_DIR,job.terminal.reportId).ok):null;appendFileSync(${JSON.stringify(notesPath)},JSON.stringify({...note,registered})+String.fromCharCode(10));};globalThis.__QQ_TEST_WATCHDOG={sweepMs:500};startMcpServer();`);
  const clients=[],notes=()=>existsSync(notesPath)?readFileSync(notesPath,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  const launch=()=>{
    const child=spawn(process.execPath,[driver],{cwd:fixture.root,env:{...fixture.env,QQ_WORKFLOW_SESSION_ID:owner,PASEO_AGENT_ID:owner,QQ_CODEX_BIN:'/usr/bin/false'},stdio:['pipe','pipe','pipe']});
    const pending=new Map();let serial=0,stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{let message;try{message=JSON.parse(line);}catch{return;}const wait=pending.get(message.id);if(!wait)return;pending.delete(message.id);clearTimeout(wait.timer);message.error?wait.reject(Error(message.error.message)):wait.resolve(message.result);});
    child.on('exit',()=>{for(const wait of pending.values()){clearTimeout(wait.timer);wait.reject(Error('MCP exited: '+stderr.slice(-500)));}pending.clear();lines.close();});
    const rpc=(method,params={})=>new Promise((resolve,reject)=>{const n=++serial,timer=setTimeout(()=>{pending.delete(n);reject(Error('MCP request timeout: '+method+' '+stderr.slice(-500)));},30000);pending.set(n,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n');});
    const tool=async(name,args={})=>{const result=await rpc('tools/call',{name,arguments:args});assert.notEqual(result.isError,true,JSON.stringify(result));return JSON.parse(result.content[0].text);};
    const client={child,rpc,tool};clients.push(client);return client;
  };
  const wait=async(predicate)=>{const deadline=Date.now()+90000;while(Date.now()<deadline){if(await predicate())return;const job=id?readJob(fixture.env.QQ_WORKFLOW_STATE_DIR,id):null;if(job?.status==='failed')throw Error(readReport(fixture.env.QQ_WORKFLOW_STATE_DIR,job.terminal.reportId).text);await new Promise(resolve=>setTimeout(resolve,100));}throw Error(`MCP execution timeout ${JSON.stringify({mode,counts,notes:notes().map(note=>note.kind)})}`);};
  try {
    let client=launch();await client.rpc('initialize');
    const tools=(await client.rpc('tools/list')).tools.map(tool=>tool.name);
    for(const name of ['dispatch_execution','check_execution','steer_execution','cancel_execution','read_report'])assert.ok(tools.includes(name));
    const started=await client.tool('dispatch_execution',{kind:'open',phaseId:phase,sessionId:owner,baseRef:base});id=started.id;assert.equal(started.ok,true);
    for(const role of Object.keys(counts)) {
      await wait(()=>notes().some(note=>note.kind==='execution.progress'&&note.message.includes(`(${role})`)));
      const bound=roleState(role);
      const forged=await client.tool('steer_execution',{id,message:'forged target',expectAttemptId:'not-the-active-attempt'});assert.equal(forged.ok,false);
      const update=await client.tool('steer_execution',{id,message:`Include ${role} marker.`,expectAttemptId:bound.attempt.id,expectJobId:bound.job.id});
      assert.equal(update.ok,true);assert.equal(update.acknowledged,false);updates[role]=update.revision;
      if(role==='implementer'&&mode==='cancelled') {
        const cancelled=await client.tool('cancel_execution',{id,reason:'bounded communication cancellation proof'});assert.equal(cancelled.status,'cancelled');
        const again=await client.tool('cancel_execution',{id});assert.equal(again.signalled,false);
        release.implementer();await wait(()=>!processFingerprint({pid:readJob(fixture.env.QQ_WORKFLOW_STATE_DIR,id).process.pid}));
        assert.equal(counts.reviewer,0);assert.equal(roleState(role).job.pendingAmendments.length,1,'unacknowledged amendment remains an obligation');
        break;
      }
      if(role==='implementer'&&mode==='reopened') {
        const host=readJob(fixture.env.QQ_WORKFLOW_STATE_DIR,id).process.fingerprint;
        const exited=once(client.child,'exit');client.child.kill('SIGKILL');await exited;
        client=launch();await client.rpc('initialize');
        assert.deepEqual(readJob(fixture.env.QQ_WORKFLOW_STATE_DIR,id).process.fingerprint,host,'same host, no relaunch');
      }
      release[role]();
    }
    if(mode!=='cancelled') {
      // No check_execution call drives completion/recovery.
      await wait(()=>notes().some(note=>note.kind==='execution.terminal'));
      const terminal=notes().filter(note=>note.kind==='execution.terminal');assert.equal(terminal.length,1);assert.equal(terminal[0].registered,true);
      const view=await client.tool('check_execution',{id});assert.equal(view.status,'completed');
      await assert.rejects(client.tool('check_execution',{id,sessionId:'foreign-owner'}),/another coordinating session/);
      const reportIds=[view.reportId,...Object.keys(counts).map(role=>roleState(role).attempt.outcome.reportId)];
      assert.ok(reportIds.every(Boolean));
      for(const reportId of reportIds){const report=await client.tool('read_report',{reportId});assert.equal(report.ok,true);assert.ok(report.text.length>0);}
      for(const role of Object.keys(counts)){assert.equal(counts[role],8);assert.equal(roleState(role).attempt.outcome.revision,updates[role]);}
      assert.equal(git(['show','main:proof.txt']),'implemented marker');
    }
    console.log(`PASS production MCP managed execution ${mode}: owned host, scoped role communication, truthful updates, durable reports and automatic notification (external queue captured)`);
  } finally {
    Object.values(release).forEach(resolve=>resolve());
    for(const client of clients)if(client.child.exitCode===null&&client.child.signalCode===null){const exited=once(client.child,'exit');client.child.kill('SIGTERM');await exited;}
    if(id){const job=readJob(fixture.env.QQ_WORKFLOW_STATE_DIR,id),observed=processFingerprint({pid:job.process?.pid});if(observed&&observed.startTicks===job.process.fingerprint?.startTicks&&observed.cmdlineHash===job.process.fingerprint?.cmdlineHash)try{process.kill(observed.pid,'SIGTERM');}catch{}}
    await fixture.stop();
  }
}
