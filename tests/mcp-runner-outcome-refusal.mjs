// A model result cannot become managed success when the record refuses it.
// Production MCP completion path, deterministic objects/files; no provider call.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createChange,openChange} from '../workflow/change-record.mjs';
import {createJob,readJob} from '../workflow/jobs.mjs';
import {readReport} from '../workflow/reports.mjs';
import {cleanupRunnerFiles,notifyTerminal} from '../bin/mcp-server.mjs';
const stateDir=mkdtempSync(join(tmpdir(),'qq-mcp-refused-outcome-'));
process.env.QQ_WORKFLOW_STATE_DIR=stateDir;
const id=randomUUID(),attemptId=randomUUID(),actor={kind:'runtime',id:'fixture'};
createChange({stateDir,changeId:id,actor,commandId:'create'});
const record=openChange({stateDir,changeId:id});
record.append('assignment.revised',{revision:1,predecessor:null,scope:{kind:'change'},assignment:{instructions:'Original task.'}},{context:{actor},commandId:'assignment'});
record.append('job.registered',{role:'runner',pinnedRevision:1},{context:{actor,jobId:id},commandId:'job'});
record.append('attempt.launch_intent',{owner:'owner',cwd:stateDir},{context:{actor,jobId:id,attemptId},commandId:'launch'});
// No observed start: accepting completion here would invent a managed success.
createJob({stateDir,id,role:'runner',workflow:{sessionKey:'owner',root:stateDir},cwd:stateDir});
const resultFile=join(stateDir,'raw-result.json');writeFileSync(resultFile,'retained transport evidence');
const tracker={id,runnerId:id,cwd:stateDir,sessionId:'owner',startedAt:Date.now(),status:'completed',trajectory:[],resultFile,
 result:{response:'Useful original model findings.',dataPoints:[],sources:[]},
 communication:{enabled:true,stateDir,changeId:id,jobId:id,attemptId,runtimeActorId:'fixture'}};
let sends=0;globalThis.__QQ_TEST_NOTIFY_HANDLER=()=>{sends++};
cleanupRunnerFiles(tracker);
assert.notEqual(tracker.status,'completed','refused outcome must not leave a successful compatibility tracker');
assert.equal(openChange({stateDir,changeId:id}).state.jobs[id].attempts[attemptId].outcome,null);
await notifyTerminal(tracker,'runner');assert.equal(sends,0,'a refused completion is never announced as success');
assert.equal(existsSync(resultFile),true,'unpublished transport evidence remains recoverable');
const job=readJob(stateDir,id);assert.equal(job.status,'interrupted');assert.ok(job.terminal.reportId);
assert.match(readReport(stateDir,job.terminal.reportId).text,/Useful original model findings/);
console.log('PASS MCP refused outcome: no invented success or completion send; findings report and raw transport retained');
