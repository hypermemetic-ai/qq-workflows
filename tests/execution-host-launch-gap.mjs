// Real launch bridge/host, deliberately omit the coordinator's PID binding.
// The host must exit without entering the pipeline after coordinator loss.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJob, readJob, writeJob, processFingerprint, reconcileJob } from '../workflow/jobs.mjs';
import { spawnExecutionHostProcess } from '../workflow/execution-host-launcher.mjs';

const root=mkdtempSync(join(tmpdir(),'qq-host-launch-gap-'));
const stateDir=join(root,'state'),jobId='unbound-host',owner='fixture-owner',phaseId='fixture-phase',launchId='fixture-launch';
createJob({stateDir,id:jobId,role:'execution',kind:'open',workflow:{sessionKey:owner,root},cwd:root});
const dir=join(stateDir,'execution-hosts',jobId);mkdirSync(dir,{recursive:true,mode:0o700});
const requestPath=join(dir,'request.json'),logPath=join(dir,'host.log');
writeJob(stateDir,{...readJob(stateDir,jobId),phaseId,executionHost:{launchId,requestPath}});
writeFileSync(requestPath,JSON.stringify({schema:1,stateDir,jobId,root,owner,kind:'open',phaseId,launchId}),{mode:0o600});
const log=openSync(logPath,'a',0o600);
let host;
try {
  host=await spawnExecutionHostProcess({requestPath,root,env:process.env,log});
} finally {closeSync(log);}
const expected=processFingerprint({pid:host.pid});
try {
  const until=Date.now()+10000;
  while(processFingerprint({pid:host.pid})&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(processFingerprint({pid:host.pid}),null,'unbound host exits without an automatic retry');
  assert.match(readFileSync(logPath,'utf8'),/process binding was not published/);
  assert.equal(readJob(stateDir,jobId).terminal,null,'no invented pipeline result');
  const recovered=reconcileJob(stateDir,jobId);
  assert.notEqual(recovered.status,'running','missing coordinator binding is surfaced for reconciliation');
  assert.equal(recovered.executionHost.launchId,launchId,'original launch obligation remains inspectable');
  console.log('PASS launch interruption before PID binding: no pipeline or relaunch; obligation retained and no stale running claim');
} finally {
  const current=processFingerprint({pid:host.pid});
  if(expected&&current&&current.startTicks===expected.startTicks&&current.cmdlineHash===expected.cmdlineHash)try{process.kill(host.pid,'SIGTERM');}catch{}
}
