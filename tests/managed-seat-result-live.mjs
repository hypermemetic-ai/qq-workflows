import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {localPiProvider} from './support/local-pi-provider.mjs';
import {createWorkflow} from '../workflow/operations.mjs';
import {readSeatResult,parseSeatResultBinding} from '../workflow/results.mjs';
const fixture=await localPiProvider({respond:async({call})=>({text:call===1?'Implementation fixture finished.':'Verdict: PASS\nReview fixture finished.'})});
if(!fixture){console.log('SKIP managed seat result live: installed Pi unavailable');process.exit(0);}
const output=join(fixture.root,'results.json');
const driver=join(fixture.root,'driver.mjs');
writeFileSync(driver,`import {runChildSubagent} from ${JSON.stringify(new URL('../bin/mcp-server.mjs',import.meta.url).href)};import {writeFileSync} from 'node:fs';
const execution={id:'fixture-execution',sessionId:'fixture',root:${JSON.stringify(fixture.root)},status:'running',trajectory:[]};const results=[];for(const role of ['implementer','reviewer'])results.push(await runChildSubagent(execution,{role,cwd:${JSON.stringify(fixture.root)},prompt:'This is a bounded fixture; report your final answer.'}));writeFileSync(${JSON.stringify(output)},JSON.stringify({results,attempts:execution.childAttempts}));`);
const child=spawn(process.execPath,[driver],{env:fixture.env,stdio:['ignore','pipe','pipe']});
let diagnostics='';child.stderr.on('data',c=>diagnostics+=c);child.stdout.resume();
const timer=setTimeout(()=>child.kill('SIGTERM'),60000);
try {
 const code=await new Promise(done=>child.once('exit',done));assert.equal(code,0,diagnostics);
 const {results,attempts}=JSON.parse(readFileSync(output,'utf8'));
 assert.equal(results.length,2);assert.equal(fixture.calls,2);
 const reader=createWorkflow({root:fixture.root,sessionKey:'fixture',env:fixture.env});
 for(let i=0;i<2;i++){
  assert.equal(results[i].ok,true,JSON.stringify(results[i]));assert.ok(results[i].reportId);
  const expected=attempts[i];assert.equal(expected.status,'completed');
  const binding={path:expected.resultFile,jobId:expected.jobId,attemptId:expected.attemptId,role:expected.role};
  assert.equal(readSeatResult(binding).ok,true);
  assert.equal(readSeatResult({...binding,attemptId:'wrong'}).ok,false);
  assert.equal(readSeatResult({...binding,role:i===0?'reviewer':'implementer'}).ok,false);
  assert.match(reader.readReport({reportId:results[i].reportId}).text,/fixture finished/);
 }
 assert.notEqual(attempts[0].jobId,attempts[1].jobId);
 assert.throws(()=>parseSeatResultBinding({QQ_WORKER_RESULT_BINDING:JSON.stringify({schema:1,path:'/tmp/result',jobId:'j',attemptId:'a',role:'reviewer'})},'implementer'),/binding/);
 console.log('PASS installed Pi managed implementer/reviewer: distinct attempt-bound result transports, full durable reports, forged role/attempt rejected (communication wiring follows separately)');
}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await fixture.stop();}
