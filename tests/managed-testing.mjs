import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dispatchExecution, checkExecution } from '../bin/mcp-server.mjs';
import { initManagedTesting, activateTestingSeat, selectManagedTests, runManagedTests, runManagedCheckpoint, recordManagedReview, advanceManagedRound, managedLandingReady, managedTestingView, workingState } from '../workflow/managed-testing.mjs';
import { MANAGED_OPEN_ROLES, PI_COMPLETION_SECTION, loadPiSeatInstructions } from '../workflow/pi-worker/instructions.mjs';
import { COMMUNICATION_ROLE_PARAGRAPH } from '../workflow/communication.mjs';
import { WORKER_PI_TOOLS } from '../workflow/worker-config.mjs';
import { createWorkerToolsExtension } from '../pi-extension/worker-tools.mjs';

const root = mkdtempSync(join(tmpdir(),'managed-tests-'));
try {
  const wt = join(root,'worktree'), stateDir = join(wt,'.architect','state');
  mkdirSync(join(wt,'tests'),{recursive:true}); mkdirSync(join(wt,'.architect'),{recursive:true});
  writeFileSync(join(wt,'.architect','test-runner.json'),JSON.stringify({schema:1,command:'node',args:[],directory:'tests',extension:'.mjs'}));
  const test = join(wt,'tests','focused.mjs');
  writeFileSync(test,'process.exitCode = 1;');
  const second = join(wt,'tests','other.mjs'); writeFileSync(second,'process.exitCode = 0;');
  writeFileSync(join(wt,'tests','run.mjs'),'process.exitCode = 0;');
  // Admission reads the committed execution authority, not a test-owner-created config.
  const git = (...args) => execFileSync('git',args,{cwd:wt,encoding:'utf8'});
  git('init','-b','main'); git('config','user.name','Testing'); git('config','user.email','testing@example.com');
  git('add','.architect/test-runner.json'); git('commit','-m','approved runner');
  const id = randomUUID();
  initManagedTesting({stateDir,id,root,worktree:wt,ticket:'## Testing plan\nBroad regression: required\nCommand: node tests/run.mjs\n\n## End'});
  const bind = role => JSON.parse(activateTestingSeat({stateDir,id,role,jobId:randomUUID(),attemptId:randomUUID()}));
  let owner = bind('test_owner');
  const expose = async (role, identity) => {
    const tools = [];
    const extension = createWorkerToolsExtension({registerTool:tool => tools.push(tool)}, {
      env:{ QQ_ZVEC_GREP_SEAT:role, QQ_ZVEC_GREP_ROOT:wt, QQ_MANAGED_TEST_BINDING:JSON.stringify(identity) },
      communication:{enabled:false}, gateway:{search:async () => ({content:[]})}, webSearch:{search:async () => ({})}, cwd:wt });
    await extension.register(); return tools.map(t => t.name);
  };
  assert.deepEqual((await expose('test_owner',owner)).slice(-2),['select_tests','run_selected_tests']);
  assert.equal((await expose('implementer',{...owner,role:'implementer'})).includes('submit_review'),false);
  assert.deepEqual((await expose('reviewer',{...owner,role:'reviewer'})).slice(-4),['select_tests','run_selected_tests','run_regression_checkpoint','submit_review']);
  assert.equal((await runManagedTests(owner)).status,'no-tests');
  assert.throws(() => selectManagedTests(owner,{targets:['run.mjs'],rationale:'broad'}),/invalid focused target/);
  assert.throws(() => selectManagedTests(owner,{targets:['../run.mjs'],rationale:'escape'}),/invalid focused target/);
  selectManagedTests(owner,{targets:['focused.mjs'],rationale:'change-related check'});
  assert.equal((await runManagedTests(owner)).status,'fail','an unexplained failure is not expected-red');
  assert.equal((await runManagedTests(owner,{expectedRed:'product behavior is not yet implemented'})).status,'expected-red');
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await runManagedTests(owner,{signal:aborted.signal})).status,'incomplete');
  let implementer = bind('implementer');
  assert.throws(() => selectManagedTests(implementer,{targets:['other.mjs'],rationale:'not allowed'}),/role not admitted/);
  writeFileSync(test,'process.exitCode = 0;');
  assert.equal((await runManagedTests(implementer)).status,'pass');
  let reviewer = bind('reviewer');
  assert.throws(() => selectManagedTests(reviewer,{targets:['other.mjs'],rationale:'shrink'}),/only widen/);
  selectManagedTests(reviewer,{targets:['focused.mjs','other.mjs'],rationale:'cover related existing check'});
  const focused = await runManagedTests(reviewer);
  assert.equal(focused.status,'pass');
  assert.equal(focused.hash,workingState(managedTestingView(stateDir,id)), 'writing the run into default worktree state cannot stale the tested hash');
  await assert.rejects(runManagedCheckpoint(reviewer),/no-repair assessment/);
  recordManagedReview(reviewer,{verdict:'READY'});
  const checkpoint = await runManagedCheckpoint(reviewer);
  assert.equal(checkpoint.status,'pass');
  assert.equal(checkpoint.hash,workingState(managedTestingView(stateDir,id)), 'checkpoint records must not stale the tested hash');
  await assert.rejects(runManagedCheckpoint(reviewer),/already attempted/);
  assert.equal(recordManagedReview(reviewer,{verdict:'PASS',suggestions:['Optional naming cleanup']}).verdict,'PASS');
  assert.equal(managedLandingReady(stateDir,id),true);
  writeFileSync(join(wt,'.architect','intent.md'),'changed acceptance');
  assert.equal(managedLandingReady(stateDir,id),false, 'non-state .architect changes still invalidate evidence');
  rmSync(join(wt,'.architect','intent.md'));
  assert.equal(managedLandingReady(stateDir,id),true);
  assert.deepEqual(managedTestingView(stateDir,id).totals.focusedTargets,['focused.mjs','other.mjs']);
  assert.equal(managedTestingView(stateDir,id).totals.checkpointLaunches,1);
  assert.ok(managedTestingView(stateDir,id).totals.focusedLaunches >= 3);
  writeFileSync(test,'process.exitCode = 1;');
  assert.equal(managedLandingReady(stateDir,id),false);
  assert.throws(() => recordManagedReview(reviewer,{verdict:'PASS'}),/PASS refused/);
  assert.equal((await runManagedTests(reviewer)).status,'fail');
  assert.equal(recordManagedReview(reviewer,{verdict:'FAIL',implementation:['broken behavior']}).verdict,'FAIL');
  advanceManagedRound(stateDir,id);
  assert.throws(() => advanceManagedRound(stateDir,id),/no shared repair/);
  assert.equal(managedTestingView(stateDir,id).round,1);
  assert.equal((await runManagedTests(reviewer).catch(e => e.message)).includes('no longer active'),true);
  owner = bind('test_owner');
  assert.equal((await runManagedTests(owner)).status,'fail','repair failures are not pre-implementation expected reds');
  await assert.rejects(runManagedTests(owner,{expectedRed:'not allowed after first round'}),/initial test owner/);
  // Optional checkpoint: a current focused and reviewer PASS suffice.
  const optional = randomUUID();
  initManagedTesting({stateDir,id:optional,root,worktree:wt,ticket:'## Testing plan\nBroad regression: none\n'});
  writeFileSync(test,'process.exitCode = 0;');
  const bound = role => JSON.parse(activateTestingSeat({stateDir,id:optional,role,jobId:randomUUID(),attemptId:randomUUID()}));
  const initial = bound('test_owner'); selectManagedTests(initial,{targets:['focused.mjs'],rationale:'focused'});
  await runManagedTests(initial);
  const review = bound('reviewer'); await runManagedTests(review);
  recordManagedReview(review,{verdict:'PASS'});
  assert.equal(managedLandingReady(stateDir,optional),true);
  assert.equal((await runManagedCheckpoint(review)).status,'not-required');
  assert.throws(() => recordManagedReview(review,{verdict:'FAIL',suggestions:['nice to have']}),/FAIL needs material repair/);
  assert.throws(() => recordManagedReview(review,{verdict:'PASS',implementation:['broken']}),/material repair findings require FAIL/);
  assert.throws(() => recordManagedReview(review,{verdict:'DECISION_NEEDED',decision:{question:'',recommendation:'choose A'}}),/decision-needed requires/);
  assert.equal(recordManagedReview(review,{verdict:'DECISION_NEEDED',decision:{question:'Which approved behavior applies?',recommendation:'Choose A'}}).verdict,'DECISION_NEEDED');
  assert.equal(managedLandingReady(stateDir,optional),false);
  assert.equal(recordManagedReview(review,{verdict:'INCOMPLETE',incomplete:['test environment unavailable']}).verdict,'INCOMPLETE');
  assert.equal(managedLandingReady(stateDir,optional),false);
  // Only the final review at role completion is authoritative: intermediate
  // FAIL then PASS in the same live role is not a committed-outcome rewrite.
  assert.equal(recordManagedReview(review,{verdict:'FAIL',implementation:['material defect under review']}).verdict,'FAIL');
  assert.equal(recordManagedReview(review,{verdict:'PASS',suggestions:['nonblocking']}).verdict,'PASS');
  assert.equal(managedLandingReady(stateDir,optional),true);
  bound('implementer');
  assert.throws(() => recordManagedReview(review,{verdict:'FAIL',implementation:['late rewrite']}),/no longer active/);
  assert.equal(managedLandingReady(stateDir,optional),true);
  const requiredFailure = randomUUID();
  writeFileSync(join(wt,'tests','run.mjs'),'process.exitCode = 1;');
  initManagedTesting({stateDir,id:requiredFailure,root,worktree:wt,ticket:'## Testing plan\nBroad regression: required\nCommand: node tests/run.mjs\n'});
  const fbind = role => JSON.parse(activateTestingSeat({stateDir,id:requiredFailure,role,jobId:randomUUID(),attemptId:randomUUID()}));
  const preparation = fbind('test_owner'); selectManagedTests(preparation,{targets:['focused.mjs'],rationale:'focused'});
  const failureReviewer = fbind('reviewer'); await runManagedTests(failureReviewer);
  recordManagedReview(failureReviewer,{verdict:'READY'});
  assert.equal((await runManagedCheckpoint(failureReviewer)).status,'fail');
  assert.throws(() => recordManagedReview(failureReviewer,{verdict:'PASS'}),/PASS refused/);
  await assert.rejects(runManagedCheckpoint(failureReviewer),/already attempted/);
  // Compare with the phase ticket when it is present; after landing the
  // ticket may be archived/cleared and this test must remain runnable.
  const approvedPath = join(import.meta.dirname,'..','.architect','ticket.md');
  const approved = existsSync(approvedPath) ? readFileSync(approvedPath,'utf8') : '';
  if (approved.includes('TEST OWNER — ROLE BODY')) {
    for (const [seat,heading] of [['test_owner','TEST OWNER — ROLE BODY'],['implementer','IMPLEMENTER — OPEN ROLE BODY'],['reviewer','REVIEWER — OPEN ROLE BODY']]) {
      const expected = approved.split(`${heading}\n\`\`\`text\n`)[1]?.split('\n\`\`\`')[0];
      assert.equal(MANAGED_OPEN_ROLES[seat],expected,`${seat} approved role body must be exact`);
    }
  }
  assert.match(MANAGED_OPEN_ROLES.implementer,/Do not modify retained tests/);
  assert.match(MANAGED_OPEN_ROLES.reviewer,/Request an architectural decision only when a consequential ambiguity or conflict/);
  assert.match(readFileSync(join(import.meta.dirname,'..','agents','reviewer','agent.md'),'utf8'),/Treat improvements beyond acceptance as nonblocking suggestions/);
  assert.match(readFileSync(join(import.meta.dirname,'..','agents','architect','agent.md'),'utf8'),/Treat worker findings as evidence, not new requirements/);
  for (const [seat,managedTools] of [['test_owner',['select_tests','run_selected_tests']],['implementer',['run_selected_tests']],['reviewer',['select_tests','run_selected_tests','run_regression_checkpoint','submit_review']]]) {
    const prompt = loadPiSeatInstructions(seat,{managed:true,tools:[...WORKER_PI_TOOLS[seat],...managedTools]});
    assert.equal(prompt.body,`${MANAGED_OPEN_ROLES[seat]}\n\n${PI_COMPLETION_SECTION}`);
    assert.deepEqual(prompt.namedTools, managedTools.filter(name => prompt.body.includes(`\`${name}\``)).sort());
    assert.doesNotMatch(prompt.body,/run the full suite|execute the full suite/i);
  }
  assert.match(COMMUNICATION_ROLE_PARAGRAPH,/Read and acknowledge assignment revisions using the communication tools/);
  console.log('managed testing: focused selection, role gates, evidence, checkpoint and repair checks passed');
} finally { rmSync(root,{recursive:true,force:true}); }

// Exercise the real managed OPEN seat order, not just the testing record API.
// An initial implementation failure must reach the reviewer and the single
// coordinated repair; an unsuccessful repair must reach final review, not land.
for (const scenario of ['repair-passes', 'repair-fails', 'selection-drift', 'repair-selection-drift', 'config-drift', 'initial-blocked', 'repair-blocked']) {
  const repairPasses = scenario === 'repair-passes';
  const repo = mkdtempSync(join(tmpdir(),'managed-pipeline-'));
  const previous = Object.fromEntries(['QQ_WORKER_CONFIG_FILE','QQ_WORKFLOW_STATE_DIR'].map(key => [key,process.env[key]]));
  const id = randomUUID(), roles = [], outcomes = [];
  try {
    const git = (...args) => execFileSync('git',args,{cwd:repo,encoding:'utf8'});
    git('init','-b','main'); git('config','user.name','Testing'); git('config','user.email','testing@example.com');
    mkdirSync(join(repo,'.architect','tickets'),{recursive:true}); mkdirSync(join(repo,'tests'));
    writeFileSync(join(repo,'app.txt'),'v0');
    writeFileSync(join(repo,'tests','focused.mjs'),"import {readFileSync} from 'node:fs'; if (readFileSync('app.txt','utf8') !== 'v2') process.exitCode=1;\n");
    writeFileSync(join(repo,'tests','other.mjs'),'process.exitCode=0;\n');
    writeFileSync(join(repo,'.architect','test-runner.json'),JSON.stringify({schema:1,command:'node',args:[],directory:'tests',extension:'.mjs'}));
    git('add','app.txt','tests/focused.mjs','tests/other.mjs','.architect/test-runner.json'); git('commit','-m','fixture');
    writeFileSync(join(repo,'.architect','tickets',`${id}.md`),'# Fixture\n\n## Kind\nopen\n\n## Testing plan\nBroad regression: none\n');
    const configFile = join(repo,'worker-config.json');
    // Mock inference still exercises the shared central configuration path;
    // managed admission does not pin one provider/model identity in source.
    writeFileSync(configFile,JSON.stringify({harness:'pi',provider:'fixture-provider',model:'fixture-model',reasoning_effort:'low'}));
    process.env.QQ_WORKER_CONFIG_FILE=configFile;
    process.env.QQ_WORKFLOW_STATE_DIR=join(repo,'workflow-state');
    globalThis.__QQ_TEST_SUBAGENT_HANDLER = async ({role,cwd,execution}) => {
      roles.push(role);
      const binding = JSON.parse(activateTestingSeat({stateDir:execution.managedTesting.stateDir,id:execution.id,role,jobId:randomUUID(),attemptId:randomUUID()}));
      if (role === 'test_owner') {
        selectManagedTests(binding,{targets:['focused.mjs'],rationale:'approved app behavior'});
        const repair = roles.filter(r => r === 'test_owner').length > 1;
        outcomes.push((await runManagedTests(binding,repair ? {} : {expectedRed:'v2 not yet implemented'})).status);
        if (scenario === 'config-drift') {
          // A changed execution profile cannot be made authoritative by a worker
          // re-running tests after its own edit, even with current file hashes.
          mkdirSync(join(cwd,'alternate'));
          writeFileSync(join(cwd,'alternate','focused.mjs'),'process.exitCode=0;\n');
          writeFileSync(join(cwd,'.architect','test-runner.json'),JSON.stringify({schema:1,command:'node',args:[],directory:'alternate',extension:'.mjs'}));
          assert.throws(() => selectManagedTests(binding,{targets:['focused.mjs'],rationale:'adopt modified runner'}),/config|profile|authority|drift|committed/i);
          await assert.rejects(runManagedTests(binding),/config|profile|authority|drift|committed/i);
        }
        if (scenario === 'selection-drift' || (scenario === 'repair-selection-drift' && repair))
          selectManagedTests(binding,{targets:['focused.mjs','other.mjs'],rationale:'widened but not executed'});
      } else if (role === 'implementer') {
        if (scenario === 'initial-blocked' || (scenario === 'repair-blocked' && roles.filter(r => r === 'implementer').length === 2))
          return {ok:false,status:'blocked',output:'Blocked; work remains in the worktree.',error:{message:'terminal implementer blocker'}};
        writeFileSync(join(cwd,'app.txt'),roles.filter(r => r === 'implementer').length === 2 && repairPasses ? 'v2' : 'v1');
        outcomes.push((await runManagedTests(binding)).status);
      } else {
        const result = await runManagedTests(binding); outcomes.push(result.status);
        recordManagedReview(binding,result.status === 'pass' ? {verdict:'PASS'} : scenario === 'repair-selection-drift'
          ? {verdict:'FAIL',tests:['test coverage needs repair']} : {verdict:'FAIL',implementation:['app does not implement v2']});
      }
      return {ok:true,output:`${role} complete`};
    };
    const started = await dispatchExecution({kind:'open',sessionId:id,cwd:repo});
    let done;
    const deadline = Date.now()+30000;
    do {
      done = await checkExecution({id:started.id});
      if (done.pipelineSettled) break;
      await new Promise(resolve => setTimeout(resolve,25));
    } while (Date.now()<deadline);
    assert.equal(done.pipelineSettled,true,'managed fixture must settle');
    if (scenario === 'initial-blocked') {
      assert.deepEqual(roles,['test_owner','implementer'],'a terminal initial blocker stops before review');
      assert.equal(done.status,'failed');
      assert.match(done.error.message,/blocker/);
    } else if (scenario === 'repair-blocked') {
      assert.deepEqual(roles,['test_owner','implementer','reviewer','implementer'],'a terminal repair blocker stops before second review');
      assert.equal(done.status,'failed');
      assert.match(done.error.message,/blocker/);
    } else if (scenario === 'config-drift') {
      assert.deepEqual(roles,['test_owner'],'modified test authority must stop before implementation');
      assert.deepEqual(outcomes,['expected-red']);
      assert.equal(done.status,'failed');
    } else if (scenario === 'selection-drift') {
      assert.deepEqual(roles,['test_owner'],'an unexecuted final selection must stop before implementation');
      assert.deepEqual(outcomes,['expected-red']);
      assert.equal(done.status,'failed');
      assert.match(done.error.message,/execute the current selection/);
    } else if (scenario === 'repair-selection-drift') {
      assert.deepEqual(roles,['test_owner','implementer','reviewer','test_owner']);
      assert.deepEqual(outcomes,['expected-red','fail','fail','fail']);
      assert.equal(done.status,'failed');
      assert.match(done.error.message,/execution of the current selection/);
    } else {
      assert.deepEqual(roles,['test_owner','implementer','reviewer','implementer','reviewer']);
      assert.deepEqual(outcomes,repairPasses ? ['expected-red','fail','fail','pass','pass'] : ['expected-red','fail','fail','fail','fail']);
      if (repairPasses) assert.equal(done.status,'completed',JSON.stringify(done.error));
      else {
        assert.equal(done.status,'failed');
        assert.match(done.error.message,/unresolved second-round findings/);
      }
    }
  } finally {
    delete globalThis.__QQ_TEST_SUBAGENT_HANDLER;
    for (const [key,value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key]=value; }
    rmSync(repo,{recursive:true,force:true});
  }
}

// A reviewer decision or incomplete evidence stops before the shared repair;
// neither route can be transformed into a synthetic implementation FAIL.
for (const verdict of ['DECISION_NEEDED','INCOMPLETE']) {
  const repo = mkdtempSync(join(tmpdir(),'managed-routing-'));
  const previous = Object.fromEntries(['QQ_WORKER_CONFIG_FILE','QQ_WORKFLOW_STATE_DIR'].map(key => [key,process.env[key]]));
  const id = randomUUID(), roles = [];
  try {
    const git = (...args) => execFileSync('git',args,{cwd:repo,encoding:'utf8'});
    git('init','-b','main'); git('config','user.name','Testing'); git('config','user.email','testing@example.com');
    mkdirSync(join(repo,'.architect','tickets'),{recursive:true}); mkdirSync(join(repo,'tests'));
    writeFileSync(join(repo,'tests','focused.mjs'),'process.exitCode=0;\n');
    writeFileSync(join(repo,'.architect','test-runner.json'),JSON.stringify({schema:1,command:'node',args:[],directory:'tests',extension:'.mjs'}));
    git('add','.'); git('commit','-m','fixture');
    writeFileSync(join(repo,'.architect','tickets',`${id}.md`),'# Fixture\n\n## Kind\nopen\n\n## Testing plan\nBroad regression: none\n');
    const configFile = join(repo,'worker-config.json');
    writeFileSync(configFile,JSON.stringify({harness:'pi',provider:'openai-codex',model:'gpt-6-sol',reasoning_effort:'high'}));
    process.env.QQ_WORKER_CONFIG_FILE=configFile; process.env.QQ_WORKFLOW_STATE_DIR=join(repo,'workflow-state');
    globalThis.__QQ_TEST_SUBAGENT_HANDLER = async ({role,execution}) => {
      roles.push(role);
      const binding = JSON.parse(activateTestingSeat({stateDir:execution.managedTesting.stateDir,id:execution.id,role,jobId:randomUUID(),attemptId:randomUUID()}));
      if (role === 'test_owner') { selectManagedTests(binding,{targets:['focused.mjs'],rationale:'fixture behavior'}); await runManagedTests(binding); }
      if (role === 'reviewer') {
        await runManagedTests(binding);
        recordManagedReview(binding,verdict === 'DECISION_NEEDED'
          ? {verdict,decision:{question:'Which agreed outcome applies?',recommendation:'Prefer A'}}
          : {verdict,incomplete:['required verification unavailable']});
      }
      return {ok:true,output:`${role} completed`};
    };
    const started = await dispatchExecution({kind:'open',sessionId:id,cwd:repo});
    let done; const deadline = Date.now()+30000;
    do { done = await checkExecution({id:started.id}); if (done.pipelineSettled) break; await new Promise(resolve => setTimeout(resolve,25)); } while (Date.now()<deadline);
    assert.equal(done.pipelineSettled,true);
    assert.deepEqual(roles,['test_owner','implementer','reviewer']);
    assert.equal(done.status,'failed');
    assert.match(done.error.message, verdict === 'DECISION_NEEDED' ? /Architect decision needed: Which agreed outcome applies\? Recommended option: Prefer A/ : /verification incomplete/);
  } finally {
    delete globalThis.__QQ_TEST_SUBAGENT_HANDLER;
    for (const [key,value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key]=value; }
    rmSync(repo,{recursive:true,force:true});
  }
}
