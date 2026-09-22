#!/usr/bin/env node
// An owned process hosting the EXISTING managed pipeline. The Architect's
// lifetime and stdout pipes are not the lifetime or result transport of a job.
// Requests/results are subordinate transport artifacts; workflow records and
// report references remain authoritative. A host is launched only by an
// explicit dispatch, never by recovery.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readJob,writeJob,recordTerminal,processFingerprint} from './jobs.mjs';
import {saveReport} from './reports.mjs';

export function publishExecutionResult({stateDir,jobId,result,now=Date.now()}) {
  const job=readJob(stateDir,jobId);
  if (!job || job.role !== 'execution') throw new Error('execution identity unavailable');
  const text=JSON.stringify(result,null,2);
  const report=saveReport(stateDir,{jobId,role:'execution',text,now});
  const status=job.cancellation ? 'cancelled' : result.status === 'completed' && result.ok === true ? 'completed' : result.status === 'interrupted' ? 'interrupted' : 'failed';
  return recordTerminal(stateDir,jobId,{status,summary:result.error?.message ?? `managed execution ${status}`,reportId:report.reportId,reportChars:report.chars,error:result.error ?? null,phase:result.phase,now});
}

export async function runExecutionHost(requestPath,{loadPipeline=()=>import('../bin/mcp-server.mjs')}={}) {
  const request=JSON.parse(readFileSync(requestPath,'utf8'));
  const {stateDir,jobId,owner,root,kind,phaseId,baseRef,launchId}=request;
  const job=readJob(stateDir,jobId);
  if (!job || job.role !== 'execution' || job.workflow?.sessionKey !== owner || job.workflow?.root !== root || job.executionHost?.launchId !== launchId || job.executionHost?.requestPath !== resolve(requestPath)) throw new Error('execution host ownership mismatch');
  if (job.terminal || job.cancellation) return job;
  // Spawn intent is durable before fork; do not run the pipeline until the
  // parent has published this host's observed process identity.
  const deadline=Date.now()+5000;
  for (;;) {
    const current=readJob(stateDir,jobId);
    if(current?.terminal || current?.cancellation) return current;
    if(current?.process?.pid===process.pid) break;
    if(Date.now()>deadline) throw new Error('execution host process binding was not published');
    await new Promise(done=>setTimeout(done,20));
  }
  const pipeline=await loadPipeline();
  let pipelineId=null;
  let cancelling=false;
  const cancel=async signal=>{
    if(cancelling)return;
    cancelling=true;
    // Only the host's exact active child is signalled by the existing pipeline.
    // An external signal is interruption, not an invented operator cancellation.
    await pipeline.cancelExecution?.({id:pipelineId,reason:signal,interrupted:!readJob(stateDir,jobId)?.cancellation});
  };
  process.on('SIGTERM',cancel);process.on('SIGINT',cancel);
  try {
    const started=await pipeline.dispatchExecution({kind,cwd:root,sessionId:owner,phaseId,baseRef,notificationMode:'parent'});
    pipelineId=started.id;
    if(cancelling) await pipeline.cancelExecution?.({id:pipelineId,reason:'host interrupted',interrupted:!readJob(stateDir,jobId)?.cancellation});
    for (;;) {
      const view=await pipeline.checkExecution({id:pipelineId});
      const current=readJob(stateDir,jobId);
      if (!current) throw new Error('execution record disappeared');
      if(current.cancellation && !cancelling) await cancel('cancellation intent');
      if(!current.terminal) writeJob(stateDir,{...current,phase:view.phase,updatedAt:Date.now(),executionHost:{...current.executionHost,pipelineId},telemetry:{source:'execution-host',lastObservedAt:Date.now(),activeTool:view.activeTool ?? null,trajectory:(view.trajectory ?? []).slice(-8)}});
      if(view.status !== 'running') return publishExecutionResult({stateDir,jobId,result:{ok:view.status==='completed',status:view.status,phase:view.phase,result:view.result,error:view.error,pipelineId}});
      await new Promise(done=>setTimeout(done,500));
    }
  } catch(error) {
    return publishExecutionResult({stateDir,jobId,result:{ok:false,status:'failed',error:{message:error.message},pipelineId}});
  } finally {process.off('SIGTERM',cancel);process.off('SIGINT',cancel);}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  runExecutionHost(process.argv[2]).catch(error=>{process.stderr.write(`execution host: ${error.message}\n`);process.exitCode=1;});
}
