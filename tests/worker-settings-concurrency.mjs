// Concurrent production settings materialization, without model/provider calls.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ensurePiWorkerSettings} from '../workflow/worker-config.mjs';
const root=mkdtempSync(join(tmpdir(),'qq-settings-concurrency-')),source=join(root,'registry'),target=join(root,'workers');
mkdirSync(source);for(const name of ['models.json','models-store.json','auth.json'])writeFileSync(join(source,name),'{}');
const env={...process.env,PI_CODING_AGENT_DIR:source,QQ_WORKER_PI_AGENT_DIR:target};
const config={context:{enabled:true,reserveTokens:8192,keepRecentTokens:2000}};
ensurePiWorkerSettings(env,config);
const script=`import {ensurePiWorkerSettings} from ${JSON.stringify(new URL('../workflow/worker-config.mjs',import.meta.url).href)};for(let i=0;i<120;i++)ensurePiWorkerSettings(process.env,${JSON.stringify(config)});`;
const children=[],outcomes=[];let active=6,reads=0;
for(let i=0;i<6;i++) {
 const child=spawn(process.execPath,['--input-type=module','-e',script],{env,stdio:['ignore','ignore','pipe']});children.push(child);
 let stderr='';child.stderr.on('data',data=>stderr+=data);
 outcomes.push(new Promise(resolve=>child.on('exit',(code,signal)=>{active--;resolve({code,signal,stderr});})));
}
let readFailure=null;
try {
 while(active>0) {
  try {
   const settings=JSON.parse(readFileSync(join(target,'settings.json'),'utf8'));
   assert.equal(settings.compaction.reserveTokens,8192);
   for(const name of ['models.json','models-store.json','auth.json'])assert.deepEqual(JSON.parse(readFileSync(join(target,name),'utf8')),{});
   reads++;
  }catch(error){readFailure??=error;}
  await new Promise(resolve=>setImmediate(resolve));
 }
 for(const result of await Promise.all(outcomes))assert.equal(result.code,0,result.stderr);
 assert.equal(readFailure,null,readFailure?.message);assert.ok(reads>0);
 console.log('PASS concurrent worker settings and registry references: readers always see complete files; six real writer processes; no provider calls');
}finally{for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await Promise.all(outcomes);}
