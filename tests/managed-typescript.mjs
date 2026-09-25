import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchExecution, checkExecution } from '../bin/mcp-server.mjs';
import { commitIfDirty, createWorktree } from '../workflow/git.mjs';
import { initManagedTesting, activateTestingSeat, selectManagedTests, runManagedTests, runManagedCheckpoint, recordManagedReview, managedLandingReady, managedTestingView } from '../workflow/managed-testing.mjs';

const legacy = {schema:1,command:'node',args:[],directory:'tests',extension:'.mjs'};
// A project-owned fixed TypeScript profile: no caller-controlled executable,
// flags or argv. This fixture describes the intended wire contract for tests.
const typescript = {schema:2,profile:'node-tsx-test',directory:'tests',extension:'.test.ts'};
const configPath = repo => join(repo,'.architect','test-runner.json');
const git = (repo,...args) => execFileSync('git',args,{cwd:repo,encoding:'utf8'});
function fixture(profile = typescript) {
  const repo = mkdtempSync(join(tmpdir(),'managed-ts-'));
  git(repo,'init','-b','main'); git(repo,'config','user.name','Testing'); git(repo,'config','user.email','testing@example.com');
  mkdirSync(join(repo,'.architect')); mkdirSync(join(repo,'tests'));
  writeFileSync(configPath(repo),JSON.stringify(profile));
  writeFileSync(join(repo,'tests','value.ts'),'export const value: number = 42;\n');
  writeFileSync(join(repo,'tests','one.test.ts'),"import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './value';\ntest('selected TypeScript file with extensionless TS import', () => { const result: number = value; assert.equal(result,42); assert.ok(process.env.NODE_TEST_CONTEXT, 'must run under node --test'); });\n");
  writeFileSync(join(repo,'tests','two.test.ts'),"import {test} from 'node:test'; test('second selected file',()=>{});\n");
  writeFileSync(join(repo,'tests','run.test.ts'),"import {test} from 'node:test'; test('broad entrypoint',()=>{});\n");
  writeFileSync(join(repo,'tests','run.mjs'),'process.exitCode=0;\n');
  git(repo,'add','.'); git(repo,'commit','-m','approved runner');
  return repo;
}
const binding = (stateDir,id,role) => JSON.parse(activateTestingSeat({stateDir,id,role,jobId:randomUUID(),attemptId:randomUUID()}));
const plan = '## Testing plan\nBroad regression: none\n';
const broadPlan = '## Testing plan\nBroad regression: required\nCommand: node tests/run.mjs\n';

// Real loader integration is conditional on an already installed consumer
// dependency. Never replace tsx with a mock and call that integration proof.
const installedTsx = '/home/qqp/projects/iso-notation/node_modules/tsx';
if (existsSync(installedTsx)) {
  const repo = fixture(), stateDir = join(repo,'.architect','state'), id = randomUUID();
  try {
    mkdirSync(join(repo,'node_modules'));
    symlinkSync(installedTsx,join(repo,'node_modules','tsx'),'dir');
    initManagedTesting({stateDir,id,root:repo,worktree:repo,ticket:broadPlan});
    const owner = binding(stateDir,id,'test_owner');
    selectManagedTests(owner,{targets:['one.test.ts'],rationale:'extensionless TS import'});
    symlinkSync(join(repo,'tests','one.test.ts'),join(repo,'tests','alias.test.ts'));
    writeFileSync(join(repo,'outside.test.ts'),'throw new Error("escaped test directory");\n');
    symlinkSync(join(repo,'outside.test.ts'),join(repo,'tests','escape.test.ts'));
    for (const target of ['../one.test.ts','/tmp/one.test.ts','run.test.ts','run.mjs','value.ts','escape.test.ts'])
      assert.throws(() => selectManagedTests(owner,{targets:[target],rationale:'bad focused target'}),/focused target|focused test|entrypoint/i,target);
    // Node's --test runner reexecutes a worker with its own execArgv. Capture
    // the original spawn's argv at the node executable boundary instead of
    // inspecting the worker's process.execArgv. The shim delegates to real
    // Node, so the selected test still uses the actual consumer tsx loader.
    const bin = mkdtempSync(join(tmpdir(),'managed-node-argv-'));
    const argvLog = join(bin,'argv');
    const originalPath = process.env.PATH;
    const originalLog = process.env.QQ_MANAGED_ARGV_RECORD;
    let result;
    try {
      const nodeShim = join(bin,'node');
      writeFileSync(nodeShim,`#!/bin/sh\nif [ ! -e "$QQ_MANAGED_ARGV_RECORD" ]; then printf '%s\\n' "$@" > "$QQ_MANAGED_ARGV_RECORD"; fi\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`);
      chmodSync(nodeShim,0o755);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      process.env.QQ_MANAGED_ARGV_RECORD = argvLog;
      result = await runManagedTests(owner);
      assert.deepEqual(readFileSync(argvLog,'utf8').trimEnd().split('\n'),
        ['--import','tsx','--test',join(repo,'tests','one.test.ts')], 'fixed runner launch argv');
    } finally {
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      if (originalLog === undefined) delete process.env.QQ_MANAGED_ARGV_RECORD; else process.env.QQ_MANAGED_ARGV_RECORD = originalLog;
      rmSync(bin,{recursive:true,force:true});
    }
    assert.equal(result.status,'pass',JSON.stringify(result.outcomes));
    assert.deepEqual(result.outcomes.map(o=>o.target),['one.test.ts']);
    assert.match(result.outcomes[0].output,/selected TypeScript file with extensionless TS import/);
    const reviewer = binding(stateDir,id,'reviewer');
    assert.throws(() => selectManagedTests(reviewer,{targets:['two.test.ts'],rationale:'shrink'}),/only widen/);
    selectManagedTests(reviewer,{targets:['one.test.ts','two.test.ts'],rationale:'cover second real test'});
    const reviewed = await runManagedTests(reviewer);
    assert.equal(reviewed.status,'pass',JSON.stringify(reviewed.outcomes));
    assert.deepEqual(reviewed.outcomes.map(o=>o.status),['pass','pass']);
    assert.throws(() => recordManagedReview(reviewer,{verdict:'PASS'}),/PASS refused/);
    recordManagedReview(reviewer,{verdict:'READY'});
    const checkpoint = await runManagedCheckpoint(reviewer);
    assert.equal(checkpoint.status,'pass','ticket-owned broad regression remains independent from focused TS evidence');
    assert.equal(checkpoint.command,'node tests/run.mjs');
    recordManagedReview(reviewer,{verdict:'PASS'});
    assert.equal(managedLandingReady(stateDir,id),true);
    const previous = managedTestingView(stateDir,id).runs.at(-1);
    // Worker changes cannot create new authority, even by obtaining a fresh
    // PASS with newly computed working-state hash.
    writeFileSync(configPath(repo),JSON.stringify({...typescript, directory:'alternate'}));
    mkdirSync(join(repo,'alternate')); writeFileSync(join(repo,'alternate','one.test.ts'),readFileSync(join(repo,'tests','one.test.ts')));
    assert.equal(managedLandingReady(stateDir,id),false);
    assert.throws(() => selectManagedTests(reviewer,{targets:['one.test.ts','two.test.ts'],rationale:'new directory'}),/config|profile|authority|drift|committed/i);
    await assert.rejects(runManagedTests(reviewer),/config|profile|authority|drift|committed/i);
    assert.throws(() => recordManagedReview(reviewer,{verdict:'PASS'}),/PASS refused|config|profile|authority|drift|committed/i);
    assert.equal(managedTestingView(stateDir,id).runs.at(-1).at,previous.at);
  } finally { rmSync(repo,{recursive:true,force:true}); }
} else console.log('real tsx integration not available; no real-loader proof claimed');

// A separately authorized onboarding commit, not OPEN admission, supplies
// authority. A fresh worktree admitted after that commit accepts the profile.
{
  const repo = fixture(legacy), first = randomUUID(), second = randomUUID();
  let wt;
  try {
    git(repo,'rm','.architect/test-runner.json'); git(repo,'commit','-m','remove old runner');
    mkdirSync(join(repo,'.architect'),{recursive:true});
    writeFileSync(configPath(repo),JSON.stringify(typescript));
    const original = git(repo,'rev-parse','HEAD').trim();
    assert.throws(() => initManagedTesting({stateDir:join(repo,'.state'),id:first,root:repo,worktree:repo,ticket:plan}),/committed|configuration|authority/i);
    assert.equal(git(repo,'rev-parse','HEAD').trim(),original,'failed OPEN admission cannot commit authority');
    const onboarded = await commitIfDirty(repo,'project-owned runner onboarding');
    assert.equal(onboarded.committed,true);
    assert.equal(git(repo,'show','HEAD:.architect/test-runner.json').trim(),JSON.stringify(typescript));
    mkdirSync(join(repo,'.architect','tickets'),{recursive:true});
    writeFileSync(join(repo,'.architect','tickets',`${second}.md`),`# Fresh OPEN ticket\n\n${plan}`);
    wt = (await createWorktree(repo,{kind:'open',sessionId:second})).cwd;
    initManagedTesting({stateDir:join(repo,'.state'),id:second,root:repo,worktree:wt,ticket:plan});
    const owner = binding(join(repo,'.state'),second,'test_owner');
    selectManagedTests(owner,{targets:['one.test.ts'],rationale:'fresh admission uses committed project profile'});
  } finally {
    if (wt) git(repo,'worktree','remove','--force',wt);
    rmSync(repo,{recursive:true,force:true});
  }
}

// Configuration is execution authority: an absent, uncommitted, modified or
// malformed file must fail admission before any managed worker can act.
for (const variant of ['missing','uncommitted','dirty','malformed','arbitrary-argv','unknown-profile']) {
  const repo = fixture(legacy), id = randomUUID(), roles = [];
  let dirtyWorktree;
  const previous = Object.fromEntries(['QQ_WORKER_CONFIG_FILE','QQ_WORKFLOW_STATE_DIR'].map(k=>[k,process.env[k]]));
  try {
    if (variant === 'missing') { git(repo,'rm','.architect/test-runner.json'); git(repo,'commit','-m','no runner'); }
    if (variant === 'uncommitted') { git(repo,'rm','.architect/test-runner.json'); git(repo,'commit','-m','no runner'); mkdirSync(join(repo,'.architect'),{recursive:true}); writeFileSync(configPath(repo),JSON.stringify(legacy)); }
    if (variant === 'malformed' || variant === 'arbitrary-argv' || variant === 'unknown-profile') {
      const bad = variant === 'malformed' ? {schema:2,profile:'node-tsx-test',directory:'../tests',extension:'.test.ts'}
        : variant === 'arbitrary-argv' ? {...typescript,args:['--eval','unsafe']} : {...typescript,profile:'shell'};
      writeFileSync(configPath(repo),JSON.stringify(bad)); git(repo,'add','.architect/test-runner.json'); git(repo,'commit','-m','bad runner');
    }
    mkdirSync(join(repo,'.architect','tickets'),{recursive:true});
    writeFileSync(join(repo,'.architect','tickets',`${id}.md`),`# Fixture\n\n## Kind\nopen\n\n${plan}`);
    if (variant === 'dirty') {
      // Dispatch provisions a separate worktree from HEAD. Dirty the actual
      // execution worktree; edits to the source checkout are not admission input.
      dirtyWorktree = (await createWorktree(repo,{kind:'open',sessionId:id})).cwd;
      writeFileSync(configPath(dirtyWorktree),JSON.stringify({...legacy,directory:'other'}));
    }
    const workerFile = join(repo,'worker-config.json');
    writeFileSync(workerFile,JSON.stringify({harness:'pi',provider:'fixture-provider',model:'fixture-model',reasoning_effort:'low'}));
    process.env.QQ_WORKER_CONFIG_FILE=workerFile; process.env.QQ_WORKFLOW_STATE_DIR=join(repo,'workflow-state');
    globalThis.__QQ_TEST_SUBAGENT_HANDLER = async ({role}) => { roles.push(role); return {ok:true,output:'unexpected worker'}; };
    const started = await dispatchExecution({kind:'open',sessionId:id,cwd:repo});
    let done; const deadline=Date.now()+30000;
    do { done=await checkExecution({id:started.id}); if(done.pipelineSettled) break; await new Promise(resolve=>setTimeout(resolve,25)); } while(Date.now()<deadline);
    assert.equal(done.pipelineSettled,true,`${variant}: admission did not settle`);
    assert.equal(done.status,'failed',variant);
    assert.deepEqual(roles,[],`${variant}: cannot issue worker authority`);
    assert.match(done.error.message,/runner|config|profile|committed|dirty|authority|missing|unsupported/i,variant);
  } finally {
    delete globalThis.__QQ_TEST_SUBAGENT_HANDLER;
    for (const [k,v] of Object.entries(previous)) { if(v===undefined) delete process.env[k]; else process.env[k]=v; }
    if (dirtyWorktree) git(repo,'worktree','remove','--force',dirtyWorktree);
    rmSync(repo,{recursive:true,force:true});
  }
}
console.log('TypeScript focused runner and admission checks passed');
