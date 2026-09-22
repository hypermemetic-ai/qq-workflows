// Production MCP stdio/RPC + installed Pi + real relay + localhost provider.
// The external Codex notification sink is captured; it proves queue submission,
// not Architect consumption. The actual Architect test covers consumption.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {once} from 'node:events';
import {localPiProvider} from './support/local-pi-provider.mjs';

for (const reopen of [false,true]) {
  const counts=new Map(),gates=new Map(),release=[];
  for(const label of ['Mcp-alpha','Mcp-beta'])gates.set(label,new Promise(resolve=>release.push(resolve)));
  const fixture=await localPiProvider({respond:async({body})=>{
    const label=JSON.stringify(body.messages).includes('Mcp-beta')?'Mcp-beta':'Mcp-alpha';
    const count=(counts.get(label)??0)+1;counts.set(label,count);
    if(count===1)return {toolCalls:[{name:'workflow_read_assignment',arguments:{revision:1}}]};
    if(count===2)return {toolCalls:[{name:'workflow_acknowledge_assignment',arguments:{revision:1}}]};
    if(count===3)return {toolCalls:[{name:'workflow_report_progress',arguments:{kind:'progress',message:`${label} inspected the original assignment.`}}]};
    if(count===4){await gates.get(label);return {toolCalls:[{name:'workflow_read_assignment',arguments:{revision:2}}]};}
    if(count===5)return {toolCalls:[{name:'workflow_acknowledge_assignment',arguments:{revision:2}}]};
    assert.equal(count,6,'one managed worker turn sequence, no relaunch');
    return {text:`${label} durable findings cover acknowledged revision 2.\n${"Detailed retained observation. ".repeat(100)}`};
  }});
  if(!fixture){console.log('SKIP MCP communication live: installed Pi unavailable');break;}
  const owner='7f2dfe6d-43d3-4a71-a7bd-cf44cb948167';
  const notesPath=join(fixture.root,'notifications.jsonl'),driver=join(fixture.root,'mcp.mjs');
  writeFileSync(driver,`import {startMcpServer} from ${JSON.stringify(new URL('../bin/mcp-server.mjs',import.meta.url).href)};import {appendFileSync,readdirSync} from 'node:fs';globalThis.__QQ_TEST_NOTIFY_HANDLER=note=>{let reports=[];try{reports=readdirSync(${JSON.stringify(join(fixture.env.QQ_WORKFLOW_STATE_DIR,'reports'))})}catch{}appendFileSync(${JSON.stringify(notesPath)},JSON.stringify({...note,reportRegistered:reports.some(name=>name.startsWith('runner-'+note.trackerId+'-'))})+'\\n')};globalThis.__QQ_TEST_WATCHDOG={sweepMs:200};startMcpServer();`);
  const clients=[];let jobs=[];
  const notes=()=>existsSync(notesPath)?readFileSync(notesPath,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  const launch=()=>{
    const child=spawn(process.execPath,[driver],{cwd:fixture.root,env:{...fixture.env,PASEO_AGENT_ID:owner,QQ_WORKFLOW_SESSION_ID:owner,QQ_CODEX_BIN:'/usr/bin/false'},stdio:['pipe','pipe','pipe']});
    const pending=new Map();let seq=0,stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}const waiter=pending.get(m.id);if(!waiter)return;pending.delete(m.id);clearTimeout(waiter.timer);m.error?waiter.reject(Error(m.error.message)):waiter.resolve(m.result)});
    child.on('exit',()=>{for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(Error('MCP process exited: '+stderr.slice(-500)))}pending.clear();lines.close()});
    const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error('MCP request timeout: '+method+' '+stderr.slice(-500)))},30000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')});
    const tool=async(name,args={})=>{const result=await rpc('tools/call',{name,arguments:args});assert.notEqual(result.isError,true,JSON.stringify(result));return JSON.parse(result.content[0].text)};
    const client={child,rpc,tool};clients.push(client);return client;
  };
  const wait=async(predicate)=>{const end=Date.now()+60000;while(Date.now()<end){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,100))}throw Error('MCP live timeout: '+JSON.stringify({reopen,counts:[...counts],notes:notes().map(n=>({kind:n.kind,trackerId:n.trackerId}))}))};
  try {
    let client=launch();await client.rpc('initialize');
    const available=(await client.rpc('tools/list')).tools.map(t=>t.name);
    for(const name of ['dispatch_runner','check_runner','steer_runner','cancel_runner','read_report'])assert.ok(available.includes(name),`MCP exposes ${name}`);
    jobs=await Promise.all(['Mcp-alpha','Mcp-beta'].map(label=>client.tool('dispatch_runner',{task:`${label}: read and acknowledge original assignment, report progress, then incorporate the amendment.`,cwd:fixture.root,sessionId:owner})));
    assert.ok(jobs.every(job=>job.ok));assert.notEqual(jobs[0].runnerId,jobs[1].runnerId);
    await wait(()=>[...counts.values()].filter(n=>n>=4).length===2);
    await wait(()=>notes().filter(n=>n.kind==='runner.progress').length>=2);
    for(let i=0;i<jobs.length;i++){
      const label=i?'Mcp-beta':'Mcp-alpha';const note=notes().find(n=>n.kind==='runner.progress'&&n.message.includes(label));
      assert.equal(note.trackerId,jobs[i].runnerId,'shared consumer cannot capture another worker identity');
    }
    const updates=await Promise.all(jobs.map(job=>client.tool('steer_runner',{runnerId:job.runnerId,instruction:'Incorporate this additional requirement as revision 2.'})));
    for(const update of updates){assert.equal(update.recorded,true);assert.equal(update.acknowledged,false,'submission is not incorporation');assert.equal(update.revision,2)}
    if(reopen){const exited=once(client.child,'exit');client.child.kill('SIGKILL');await exited;client=launch();await client.rpc('initialize')}
    for(const resolve of release)resolve();
    // Do not call check_runner to drive recovery: completion must be pushed by
    // ordinary callbacks or the replacement server's own recovery lifecycle.
    await wait(()=>new Set(notes().filter(n=>n.kind==='runner.terminal').map(n=>n.trackerId)).size===2);
    for(const note of notes().filter(n=>n.kind==='runner.terminal'))assert.equal(note.reportRegistered,true,'durable report registration precedes terminal notification');
    for(let i=0;i<jobs.length;i++){
      const view=await client.tool('check_runner',{runnerId:jobs[i].runnerId});
      assert.equal(view.status,'completed');assert.equal(view.communication.outcome.revision,2);assert.equal(view.communication.pendingUpdateCount,0);assert.ok(view.reportId);
      let text='',offset=0;
      do {const page=await client.tool('read_report',{reportId:view.reportId,offset,limit:256});assert.equal(page.ok,true);text+=page.text;offset=page.complete?null:page.nextOffset;}while(offset!=null);
      assert.ok(text.length>256,"report retrieval spans multiple pages");
      assert.match(text,new RegExp(`${i?'Mcp-beta':'Mcp-alpha'} durable findings cover acknowledged revision 2`));
    }
    // The normal callback and the restart/backstop recovery share one delivery
    // obligation. Let the configured test sweep run again after completion.
    await new Promise(resolve=>setTimeout(resolve,500));
    for(const job of jobs)assert.equal(notes().filter(note=>note.kind==='runner.terminal'&&note.trackerId===job.runnerId).length,1,'callback and recovery do not submit duplicate completions');
    assert.equal(fixture.calls,12,'two workers, no retry/relaunch model traffic');
    console.log(`PASS production MCP stdio ${reopen?'reopened':'ordinary'}: concurrent jobs, correctly attributed pushed progress, amendments, acknowledgement, automatic completion and paged durable reports`);
  } finally {
    for(const resolve of release)resolve();
    const latest=clients.at(-1);
    if(latest?.child.exitCode===null&&latest.child.signalCode===null){
      for(const job of jobs)try{await latest.tool('cancel_runner',{runnerId:job.runnerId})}catch{}
    }
    for(const client of clients){if(client.child.exitCode===null&&client.child.signalCode===null){const exited=once(client.child,'exit');client.child.kill('SIGTERM');await exited}}
    await fixture.stop();
  }
}
