// Real production role launcher with deterministic process doubles, not model
// inference: legacy communication refusal and result-before-adapter-failure.
import assert from 'node:assert/strict';
import {writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {localPiProvider} from './support/local-pi-provider.mjs';
import {runChildSubagent} from '../bin/mcp-server.mjs';
import {recordManagedExecution,managedExecutionPipelineHooks,managedExecutionView,steerRoleAttempt} from '../workflow/execution-authority.mjs';
import {readReport} from '../workflow/reports.mjs';
const fixture=await localPiProvider({respond:()=>{throw Error('this test must never request inference');}});
if(!fixture){console.log('SKIP role process boundaries: fixture Pi installation unavailable');process.exit(0);}
const keys=['QQ_WORKER_CONFIG_FILE','QQ_WORKER_CODEX_HOME','DEEPSEEK_API_KEY','QQ_WORKFLOW_STATE_DIR','QQ_SUBAGENT_BIN','QQ_WORKER_PI_BIN','QQ_WORKER_PI_AGENT_DIR','PI_CODING_AGENT_DIR'];
const old=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
const executions=[];
try {
  for(const key of keys)if(fixture.env[key]!==undefined)process.env[key]=fixture.env[key];
  process.env.QQ_WORKER_CODEX_HOME=join(fixture.root,'codex-home');process.env.DEEPSEEK_API_KEY='fixture-dummy';
  for(const mode of ['legacy','published-then-failed']) {
    const id=randomUUID(),owner=randomUUID(),stateDir=fixture.env.QQ_WORKFLOW_STATE_DIR;
    const marker=join(fixture.root,`${mode}.ready`),gate=join(fixture.root,`${mode}.continue`),binary=join(fixture.root,`${mode}.mjs`);
    writeFileSync(binary,`#!/usr/bin/env node\nimport {writeFileSync,existsSync} from 'node:fs';import {writeSeatResult} from ${JSON.stringify(new URL('../workflow/results.mjs',import.meta.url).href)};writeFileSync(${JSON.stringify(marker)},'ready');while(!existsSync(${JSON.stringify(gate)}))await new Promise(done=>setTimeout(done,20));${mode==='legacy'?"console.log('Legacy role findings retained.');":"writeSeatResult(JSON.parse(process.env.QQ_WORKER_RESULT_BINDING),{response:'Full model findings persisted before adapter failure.'});process.exitCode=9;"}\n`,{mode:0o700});
    process.env.QQ_SUBAGENT_BIN=binary;
    if(mode==='legacy') {
      const config=join(fixture.root,'legacy-config.json');writeFileSync(config,JSON.stringify({harness:'codex',provider:'deepseek',model:'deepseek-flash',base_url:'http://127.0.0.1:9',wire_api:'responses',env_key:'DEEPSEEK_API_KEY'}));process.env.QQ_WORKER_CONFIG_FILE=config;
    } else process.env.QQ_WORKER_CONFIG_FILE=fixture.env.QQ_WORKER_CONFIG_FILE;
    recordManagedExecution({stateDir,executionId:id,kind:'bounded',phaseId:randomUUID(),root:fixture.root,owner,constraints:'Keep reports and truthful communication state.',launchId:randomUUID(),requestPath:join(fixture.root,`${id}.request`)});
    const execution={id,root:fixture.root,sessionId:owner,status:'running',trajectory:[],authority:managedExecutionPipelineHooks({stateDir,executionId:id,owner})};
    executions.push(execution);
    const completion=runChildSubagent(execution,{role:'implementer',cwd:fixture.root,prompt:'Perform the bounded fixture.'});
    const deadline=Date.now()+15000;
    while(!existsSync(marker)&&Date.now()<deadline)await new Promise(done=>setTimeout(done,20));
    assert.ok(existsSync(marker),'real child reached the gate');
    const before=managedExecutionView({stateDir,executionId:id});
    const active=before.roles.find(role=>role.role==='implementer').attempts[0];
    assert.equal(active.communication.supported,mode!=='legacy');
    if(mode==='legacy') {
      const update=await steerRoleAttempt({stateDir,executionId:id,message:'This cannot be delivered to the legacy harness.'});
      assert.equal(update.ok,false);assert.equal(update.code,'unsupported');
      assert.equal(managedExecutionView({stateDir,executionId:id}).updateCount,0);
    }
    writeFileSync(gate,'continue');
    const result=await completion,attempt=execution.childAttempts[0];
    const view=managedExecutionView({stateDir,executionId:id}).roles.find(role=>role.role==='implementer').attempts[0];
    assert.equal(result.ok,mode==='legacy');assert.equal(view.outcome.status,mode==='legacy'?'completed':'failed');
    assert.ok(attempt.reportId);assert.equal(view.outcome.reportId,attempt.reportId);
    assert.match(readReport(stateDir,attempt.reportId).text,mode==='legacy'?/Legacy role findings/:/Full model findings persisted before adapter failure/);
    if(mode!=='legacy')assert.equal(result.error.exitCode,9);
  }
  assert.equal(fixture.calls,0);
  console.log('PASS managed role process doubles: legacy steering explicitly unsupported with durable outcome/report; validated output survives adapter failure without success');
} finally {
  for(const execution of executions)if(execution.activeChild)try{execution.activeChild.kill('SIGTERM');}catch{}
  for(const key of keys)if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];
  await fixture.stop();
}
