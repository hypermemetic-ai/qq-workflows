import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {localPiProvider} from './support/local-pi-provider.mjs';
import {createWorkflow} from '../workflow/operations.mjs';
import {readSeatResult,parseSeatResultBinding} from '../workflow/results.mjs';
const fixture=await localPiProvider({respond:async({call})=>({text:call===1?'Implementation fixture finished.\n<!-- qq-final-disposition: completed -->':call===2?'Verdict: PASS\nReview fixture finished.':'Blocked; no host maintenance performed.'})});
if(!fixture){console.log('SKIP managed seat result live: installed Pi unavailable');process.exit(0);}
const output=join(fixture.root,'results.json');
const driver=join(fixture.root,'driver.mjs');
writeFileSync(driver,`import {runChildSubagent} from ${JSON.stringify(new URL('../bin/mcp-server.mjs',import.meta.url).href)};import {writeFileSync} from 'node:fs';
const execution={id:'fixture-execution',sessionId:'fixture',root:${JSON.stringify(fixture.root)},status:'running',trajectory:[]};const results=[];for(const role of ['implementer','reviewer','implementer'])results.push(await runChildSubagent(execution,{role,cwd:${JSON.stringify(fixture.root)},prompt:'This is a bounded fixture; report your final answer.'}));writeFileSync(${JSON.stringify(output)},JSON.stringify({results,attempts:execution.childAttempts}));`);
const child=spawn(process.execPath,[driver],{env:fixture.env,stdio:['ignore','pipe','pipe']});
let diagnostics='';child.stderr.on('data',c=>diagnostics+=c);child.stdout.resume();
const timer=setTimeout(()=>child.kill('SIGTERM'),60000);
try {
 const code=await new Promise(done=>child.once('exit',done));assert.equal(code,0,diagnostics);
 const {results,attempts}=JSON.parse(readFileSync(output,'utf8'));
 assert.equal(results.length,3);assert.equal(fixture.calls,3);
 const reader=createWorkflow({root:fixture.root,sessionKey:'fixture',env:fixture.env});
 for(let i=0;i<2;i++){
  assert.equal(results[i].ok,true,JSON.stringify(results[i]));assert.ok(results[i].reportId);
  const expected=attempts[i];assert.equal(expected.status,'completed');
  const binding={path:expected.resultFile,jobId:expected.jobId,attemptId:expected.attemptId,role:expected.role};
  const published=readSeatResult(binding);
  assert.equal(published.ok,true);
  if(i===0)assert.equal(published.disposition,'completed','managed Pi producer publishes explicit final implementer disposition');
  assert.equal(readSeatResult({...binding,attemptId:'wrong'}).ok,false);
  assert.equal(readSeatResult({...binding,role:i===0?'reviewer':'implementer'}).ok,false);
  assert.match(reader.readReport({reportId:results[i].reportId}).text,/fixture finished/);
 }
 assert.notEqual(attempts[0].jobId,attempts[1].jobId);
 // No communication binding exists here, but the launcher still binds a
 // managed result. Terminal blocker prose without an explicit declaration must
 // never be upgraded into completed work by the adapter's standalone bridge.
 assert.equal(results[2].ok,false,'bound implementer without communication cannot implicitly complete');
 assert.notEqual(attempts[2].status,'completed');
 assert.ok(results[2].reportId,'failed attempt keeps durable diagnostics');
 assert.match(reader.readReport({reportId:results[2].reportId}).text,/Blocked; no host maintenance performed|final disposition/);
 assert.notEqual(readSeatResult({path:attempts[2].resultFile,jobId:attempts[2].jobId,attemptId:attempts[2].attemptId,role:'implementer'}).ok,true);
 assert.throws(()=>parseSeatResultBinding({QQ_WORKER_RESULT_BINDING:JSON.stringify({schema:1,path:'/tmp/result',jobId:'j',attemptId:'a',role:'reviewer'})},'implementer'),/binding/);
 console.log('PASS bound Pi roles: explicit disposition, unmarked blocker refused without communication, durable reports, forged identities rejected');
}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await fixture.stop();}
