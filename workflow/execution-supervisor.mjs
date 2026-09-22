// Explicit launch of the existing managed pipeline in its own owned host.
// No restart policy: a disappeared host becomes interrupted, never relaunched.
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readJob,writeJob,processFingerprint,reconcileJob} from './jobs.mjs';
import {spawnExecutionHostProcess} from './execution-host-launcher.mjs';

export async function launchExecutionHost({stateDir,jobId,root,owner,kind,phaseId,baseRef,env=process.env,onPhase,spawnFn=spawn}) {
  const job=readJob(stateDir,jobId);
  if(!job || job.role!=='execution' || job.workflow?.sessionKey!==owner || job.terminal) throw new Error('cannot launch execution host without an owned active job');
  const dir=join(stateDir,'execution-hosts',jobId);
  mkdirSync(dir,{recursive:true,mode:0o700});
  const requestPath=join(dir,'request.json');
  const launchId=randomUUID();
  writeFileSync(requestPath,JSON.stringify({schema:1,stateDir,jobId,root,owner,kind,phaseId,baseRef,launchId}),{flag:'wx',mode:0o600});
  writeJob(stateDir,{...job,executionHost:{launchId,requestPath},updatedAt:Date.now()});
  const log=openSync(join(dir,'host.log'),'a',0o600);
  let child;
  try {
    const hostEnv={...env,QQ_WORKFLOW_STATE_DIR:stateDir};
    child=spawnFn===spawn
      ? await spawnExecutionHostProcess({requestPath,root,env:hostEnv,log})
      : spawnFn(process.execPath,[fileURLToPath(new URL('./execution-host.mjs',import.meta.url)),requestPath],{cwd:root,env:hostEnv,detached:true,stdio:['ignore','ignore',log]});
  } finally {closeSync(log);}
  const current=readJob(stateDir,jobId);
  if(!current.terminal)writeJob(stateDir,{...current,process:{pid:child.pid,spawnedAt:Date.now(),fingerprint:processFingerprint({pid:child.pid})},updatedAt:Date.now()});
  child.unref?.();
  return new Promise((done,reject)=>{
    let settled=false;
    const finish=()=>{
      if(settled)return;
      let current=reconcileJob(stateDir,jobId);
      // The host owns phase publication; a second parent writer could revive
      // stale running state after terminal publication.
      if(current?.terminal || current?.status!=='running') {
        settled=true;clearInterval(timer);
        done({ok:current?.status==='completed',status:current?.status ?? 'interrupted',phase:current?.phase,reportId:current?.terminal?.reportId,error:current?.terminal?.error});
      }
    };
    const timer=setInterval(finish,500);timer.unref?.();
    child.on?.('error',error=>{if(!settled){settled=true;clearInterval(timer);reject(error);}});
    child.on?.('close',()=>{reconcileJob(stateDir,jobId);finish();});
    finish();
  });
}
