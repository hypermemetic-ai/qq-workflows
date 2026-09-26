// Bound Pi completion in a clean temporary repository: no remote or real operations.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {writeFileSync,mkdirSync,existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {localPiProvider} from './support/local-pi-provider.mjs';
import {readReport} from '../workflow/reports.mjs';
import {buildExecutionTerminalMessage} from '../bin/mcp-server.mjs';
import {WORKFLOW_TOOLS} from '../workflow/operations.mjs';
const phase='940d4149-ac31-4608-84cb-67ba4ac4e7cd';
const fixture=await localPiProvider({respond:async({body,call})=>{
  if(call===1)return {toolCalls:[{name:'workflow_read_assignment'}]};
  if(call===2){const revision=Number(JSON.stringify(body.messages).match(/assignment revision (\d+)/)?.[1] || 1);return {toolCalls:[{name:'workflow_acknowledge_assignment',arguments:{revision}}]};}
  return {text:'Completed the approved read-only inventory. Checked the baseline file and confirmed the requested fixture state; no source change was required. Evidence: baseline.txt and this durable role report.\n<!-- qq-final-disposition: completed -->'};
}});
if(!fixture){console.log('SKIP no-source Pi execution: installed Pi unavailable');process.exit(0);}
const git=args=>execFileSync('git',args,{cwd:fixture.root,encoding:'utf8'}).trim();
const driver=join(fixture.root,'driver.mjs');
try {
 git(['init','-b','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);
 writeFileSync(join(fixture.root,'baseline.txt'),'approved fixture baseline\n');git(['add','baseline.txt']);git(['commit','-m','fixture base']);
 const base=git(['rev-parse','HEAD']);
 mkdirSync(join(fixture.root,'.architect','tickets'),{recursive:true});
 writeFileSync(join(fixture.root,'.architect','tickets',`${phase}.md`),'# Verify the fixture baseline without modifying source\n\n## Kind\nbounded\n');
 writeFileSync(driver,`import {startMcpServer} from ${JSON.stringify(new URL('../bin/mcp-server.mjs',import.meta.url).href)};startMcpServer();`);
 const child=spawn(process.execPath,[driver],{cwd:fixture.root,env:{...fixture.env,QQ_WORKFLOW_SESSION_ID:phase,PASEO_AGENT_ID:phase,QQ_CODEX_BIN:'/usr/bin/false'},stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',data=>stderr+=data);
 const pending=new Map();let serial=0;
 createInterface({input:child.stdout}).on('line',line=>{let result;try{result=JSON.parse(line);}catch{return;}const waiter=pending.get(result.id);if(waiter){pending.delete(result.id);waiter(result);}});
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(Error(`MCP timeout ${method}: ${stderr.slice(-500)}`));},15000);pending.set(id,result=>{clearTimeout(timer);resolve(result.result)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 const tool=async(name,args={})=>{const response=await rpc('tools/call',{name,arguments:args});assert.notEqual(response.isError,true,JSON.stringify(response));return JSON.parse(response.content[0].text);};
 let view;
 try {
  await rpc('initialize');
  const started=await tool('dispatch_execution',{kind:'bounded',phaseId:phase,baseRef:base});assert.equal(started.ok,true);
  for(let i=0;i<600;i++){view=await tool('check_execution',{id:started.id});if(view.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(view.status,'completed',JSON.stringify(view));
 }finally{child.kill('SIGTERM');}
 const terminalReport=readReport(fixture.env.QQ_WORKFLOW_STATE_DIR,view.reportId);
 assert.ok(terminalReport.ok);const result=JSON.parse(terminalReport.text).result;
 assert.ok(result,terminalReport.text);
 assert.equal(result.landingOutcome.method,'none');assert.equal(result.landingOutcome.pr,null);
 assert.equal(result.landingOutcome.mergeSha,null);assert.equal(git(['rev-parse','main']),base);
 const message=buildExecutionTerminalMessage({id:view.id,kind:'bounded',status:'completed',result});
 assert.match(message,/outcome completed; no Git delivery/);assert.doesNotMatch(message,/verified and landed/);
 assert.match(JSON.stringify(result),/no source changes or Git delivery/);
 assert.match(result.verifiedStory,/Implementer reported completion \(report:/);
 const attempt=result.childAttempts.find(entry=>entry.role==='implementer');
 assert.ok(attempt.reportId);assert.match(readReport(fixture.env.QQ_WORKFLOW_STATE_DIR,attempt.reportId).text,/Checked the baseline file/);
 assert.deepEqual(view.authority.curation.pendingCuration,[]);
 assert.equal(view.authority.landingOutcome.method,'none');
 assert.equal(view.outcomeKnown,true);
 assert.equal(view.outcomeSource,'change-record');
 assert.equal(view.authority.curation.processingStatus,'no-change');
 assert.equal(view.authority.curation.manifests[0].refs.roleReports.status,'retained');
 assert.ok(result.landingOutcome.ticketArchived || existsSync(join(fixture.root,'.architect','tickets',`${phase}.md`)));
 // Legacy prose plus exit-0, even with a positive assertion, cannot use the
 // new unchanged-source path. This double never supplies a bound seat result.
 const legacy='11111111-2222-4333-8444-555555555555';
 writeFileSync(join(fixture.root,'.architect','tickets',`${legacy}.md`),'# Legacy no-source fixture\n');
 const negative=join(fixture.root,'negative.mjs'),negativeOutput=join(fixture.root,'negative.json');
 writeFileSync(negative,`import {dispatchExecution,checkExecution} from ${JSON.stringify(new URL('../bin/mcp-server.mjs',import.meta.url).href)};import {writeFileSync} from 'node:fs';globalThis.__QQ_TEST_SUBAGENT_HANDLER=async()=>({ok:true,output:'Completed and checked the fixture baseline.'});const started=await dispatchExecution({kind:'bounded',sessionId:${JSON.stringify(legacy)},cwd:${JSON.stringify(fixture.root)},baseRef:${JSON.stringify(base)}});let view;for(let i=0;i<300;i++){view=await checkExecution({id:started.id});if(view.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,50));}writeFileSync(${JSON.stringify(negativeOutput)},JSON.stringify(view));`);
 const negativeChild=spawn(process.execPath,[negative],{cwd:fixture.root,env:fixture.env,stdio:['ignore','pipe','pipe']});let diagnostics='';negativeChild.stderr.on('data',data=>diagnostics+=data);negativeChild.stdout.resume();
 const timeout=setTimeout(()=>negativeChild.kill('SIGTERM'),20000);
 try{assert.equal(await new Promise(done=>negativeChild.once('exit',done)),0,diagnostics);}finally{clearTimeout(timeout);}
 const rejected=JSON.parse(readFileSync(negativeOutput,'utf8'));
 assert.equal(rejected.status,'failed');assert.equal(rejected.error?.noChange,true);assert.ok(existsSync(join(fixture.root,'.architect','tickets',`${legacy}.md`)));
 const prompt=readFileSync(new URL('../agents/implementer/agent.md',import.meta.url),'utf8');
 assert.match(prompt,/description: Approved-ticket implementer working in a supplied directory\./);
 assert.match(prompt,/Inspect the relevant code or system, fulfill the ticket's outcome, and carry out its acceptance and testing plan\. Source changes are required only when the outcome calls for them\./);
 assert.match(prompt,/If no source changes were needed, explain how the outcome was fulfilled and identify the supporting evidence\./);
 const description='Delegate the approved ticket to managed execution. Open work includes independent review; source changes use Git delivery. Only call this after the operator approves the ticket.';
 assert.equal(WORKFLOW_TOOLS.find(tool=>tool.name==='dispatch_execution').description,description);
 assert.match(readFileSync(new URL('../bin/mcp-server.mjs',import.meta.url),'utf8'),/description: "Delegate the approved ticket to managed execution\. Open work includes independent review; source changes use Git delivery\. Only call this after the operator approves the ticket\."/);
 console.log('PASS typed bounded no-source completion: durable report, method:none, no commit/PR/pending curation, truthful terminal and approved prompt surfaces');
}finally{await fixture.stop();}
