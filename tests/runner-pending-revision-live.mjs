import assert from 'node:assert/strict';
import {localPiProvider} from './support/local-pi-provider.mjs';
let turn=0,allowFinal;const finalGate=new Promise(resolve=>allowFinal=resolve);
const fixture=await localPiProvider({respond:async()=>{
 ++turn;
 if(turn===1)return {toolCalls:[{name:'workflow_read_assignment',arguments:{revision:1}}]};
 if(turn===2)return {toolCalls:[{name:'workflow_acknowledge_assignment',arguments:{revision:1}}]};
 if(turn===3)return {toolCalls:[{name:'workflow_report_progress',arguments:{kind:'progress',message:'Finished the original revision; waiting before publishing its findings.'}}]};
 await finalGate;return {text:'Durable findings for original revision 1 only; later update has not been incorporated.'};
}});
if (!fixture) { console.log('SKIP native pending revision live: installed Pi unavailable'); process.exit(0); }
Object.assign(process.env,fixture.env);
const {createWorkflow}=await import('../workflow/operations.mjs');
const wf=createWorkflow({root:fixture.root,env:fixture.env,sessionKey:'018da257-a649-4414-8e31-c3f8ee27375e',notifierTransport:{name:'test-boundary',deliver:async()=>({state:'delivered'})}});
const wait=async predicate=>{const end=Date.now()+60000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,100))}throw Error('timed out at provider turn '+turn)};
let job;
try{
 job=await wf.callTool('dispatch_runner',{task:'Inspect original assignment. Keep findings bound to acknowledged revision.'});
 await wait(()=>turn>=4);
 const update=await wf.steerRunner({jobId:job.jobId,message:'Additional requirement B must remain pending until explicitly incorporated.'});
 assert.equal(update.recorded,true); assert.equal(update.acknowledged,false); allowFinal();
 await wait(()=>['completed','failed','cancelled','interrupted'].includes(wf.checkRunner({jobId:job.jobId}).status));
 const view=wf.checkRunner({jobId:job.jobId});
 assert.equal(view.status,'completed');
 assert.ok(view.reportId);
 assert.match(wf.readReport({reportId:view.reportId}).text,/original revision 1 only/);
 assert.equal(view.communication.outcome.revision,1,'completion stays tied to acknowledged A');
 assert.ok(view.communication.pendingUpdates?.some?.(u=>u.revision===2) || view.communication.pendingAmendments?.some?.(u=>u.revision===2),'unacknowledged B remains visibly pending');
 console.log('PASS native installed Pi: completed A retains pending B');
}finally{allowFinal();if(job)try{await wf.cancelRunner({jobId:job.jobId})}catch{}await wf.releaseCommunication();await fixture.stop()}
