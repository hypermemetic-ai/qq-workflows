// Real installed Pi on both caller surfaces. Only the owned signal boundary is
// observed: cancellation intent must already be durable when SIGTERM is sent.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {localPiProvider} from './support/local-pi-provider.mjs';
import {createWorkflow} from '../workflow/operations.mjs';
import {openChange,viewsFor} from '../workflow/change-record.mjs';

for(const surface of ['native','mcp']) {
  let started=false,release;const answer=new Promise(resolve=>release=resolve);
  const fixture=await localPiProvider({respond:async()=>{started=true;await answer;return {text:'Late model output must not become a successful cancelled outcome.'}}});
  if(!fixture){console.log('SKIP runner cancellation live: installed Pi unavailable');break;}
  Object.assign(process.env,fixture.env);
  const owner='ddf550f2-4d96-48e5-993a-787d635f59dc';
  let signalProbe=()=>{};
  const wf=createWorkflow({root:fixture.root,sessionKey:owner,env:fixture.env,
    spawnFn:(...args)=>{const child=spawn(...args);const original=child.kill;child.kill=function(signal){if(signal==='SIGTERM')signalProbe();return original.call(child,signal)};return child},
    notifierTransport:{name:'captured',deliver:async()=>({state:'accepted'})}});
  globalThis.__QQ_TEST_NOTIFY_HANDLER=()=>{};
  const mcp=surface==='mcp'?await import('../bin/mcp-server.mjs'):{};
  const call=surface==='native'?(name,args)=>wf.callTool(name,args):async(name,args)=>{
    const result=await mcp.handleRpc('tools/call',{name,arguments:args});assert.notEqual(result.isError,true,JSON.stringify(result));return JSON.parse(result.content[0].text);
  };
  let id,observedSignals=0,restoreSignal=()=>{};
  const wait=async predicate=>{const end=Date.now()+30000;while(Date.now()<end){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,50))}throw Error('cancellation fixture timeout')};
  const authoritative=()=>{
    const state=openChange({stateDir:fixture.env.QQ_WORKFLOW_STATE_DIR,changeId:id}).state;
    const job=viewsFor(state).job(id);return job.attempts[job.attemptOrder.at(-1)];
  };
  try {
    const dispatch=await call('dispatch_runner',{task:'Wait for cancellation in the isolated fixture.',cwd:fixture.root,sessionId:owner});
    id=dispatch.jobId??dispatch.runnerId;assert.ok(id);await wait(()=>started);
    assert.equal(authoritative().phase,'started');
    const beforeSignal=()=>{assert.ok(authoritative().cancelIntent,'authoritative intent precedes the actual owned-process signal');observedSignals++};
    if(surface==='native'){
      signalProbe=beforeSignal;
      restoreSignal=()=>{signalProbe=()=>{}};
    }else{
      const child=mcp.RUNNERS.get(id).process;const original=child.kill;
      child.kill=function(signal){if(signal==='SIGTERM')beforeSignal();return original.call(child,signal)};
      restoreSignal=()=>{child.kill=original};
    }
    const cancelled=await call('cancel_runner',surface==='native'?{jobId:id}:{runnerId:id});
    assert.equal(cancelled.ok,true);assert.equal(observedSignals,1);
    release();await new Promise(resolve=>setTimeout(resolve,300));
    const checked=await call('check_runner',surface==='native'?{jobId:id}:{runnerId:id});
    assert.equal(checked.status,'cancelled');assert.equal(authoritative().outcome?.status,'cancelled');
    const repeated=await call('cancel_runner',surface==='native'?{jobId:id}:{runnerId:id});
    assert.equal(observedSignals,1,'idempotent cancellation must not signal twice');
    assert.notEqual(repeated.status,'completed');
    assert.equal(fixture.calls,1,'cancel never relaunches worker');
    console.log(`PASS ${surface} installed Pi: durable intent before actual owned SIGTERM, cancelled outcome, idempotent retry and no relaunch`);
  }finally{
    restoreSignal();release();
    if(id)try{await call('cancel_runner',surface==='native'?{jobId:id}:{runnerId:id})}catch{}
    await wf.releaseCommunication?.();await mcp.releaseRunnerCommunication?.();await fixture.stop();
  }
}
