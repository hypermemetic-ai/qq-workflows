// Integration proof for the managed-execution lifecycle surfaces (native
// dispatch/check/steer/cancel) over the REAL detached host and the ONE
// authoritative change record, with a deterministic fake pipeline (NOT real
// managed-role proof — that lives in managed-execution-reload-live.mjs).
//
// Proves: two concurrent executions survive coordinator SIGKILL; committed
// settlement reaches the authoritative record and the durable report store
// BEFORE any notification (asserted inside the transport); notification
// replay is deduped with no relaunch; check_execution exposes bounded
// role/job/attempt/revision/update/report state from the record; steering
// reports truthful refusal instead of a silent retarget; cancellation records
// authoritative intent before fingerprint-matched signalling, stays idempotent,
// and a late pipeline result is preserved as durable evidence with full report
// retrieval WITHOUT relabelling the cancelled outcome as success.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createWorkflow } from "../workflow/operations.mjs";
import { readJob, processFingerprint } from "../workflow/jobs.mjs";
import { managedExecutionView, reconcileManagedExecution } from "../workflow/execution-authority.mjs";

const root = mkdtempSync(join(tmpdir(), "qq-exec-lifecycle-"));
const stateDir = join(root, "state");
mkdirSync(stateDir, { recursive: true });
const OWNER = "3f5d2a88-0ce8-4dce-86a8-f2802c079777";
const PHASE_A = "aaaaaaaa-1111-4222-8333-444444444444";
const PHASE_B = "bbbbbbbb-1111-4222-8333-444444444444";
const hostUrl = new URL("../workflow/execution-host.mjs", import.meta.url).href;
const supervisorUrl = new URL("../workflow/execution-supervisor.mjs", import.meta.url).href;
const operationsUrl = new URL("../workflow/operations.mjs", import.meta.url).href;

// The deterministic fake pipeline: it settles only when its phase marker file
// exists, and publishes a role report through the durable report store first.
const fakePipeline = join(root, "fake-pipeline.mjs");
writeFileSync(fakePipeline, `
import {existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {saveReport} from ${JSON.stringify(new URL("../workflow/reports.mjs", import.meta.url).href)};
let started=null;let phase=null;let settled=null;
export async function dispatchExecution(args={}) {
  started=Date.now();phase=args.phaseId;
  writeFileSync(join(${JSON.stringify(root)},'started-'+phase),'started');
  const stateDir=process.env.QQ_WORKFLOW_STATE_DIR;
  const roleReport=saveReport(stateDir,{jobId:'fake-role-job',role:'implementer',text:'fake role findings (durable)'});
  settled={ok:true,status:'completed',phase:'landed',result:{evidence:'pipeline survived the coordinator',landingOutcome:'landed-fake'},childAttempts:[{role:'implementer',jobId:'fake-role-job',attemptId:'fake-attempt-1',status:'completed',revision:1,reportId:roleReport.reportId,reportChars:roleReport.chars}]};
  return {id:'inner-'+phase};
}
export async function checkExecution() {
  const done=existsSync(join(${JSON.stringify(root)},'settle-'+phase));
  return done ? {...settled,pipelineSettled:true} : {status:'running',phase:'implementing',activeTool:null,trajectory:[]};
}
`);

const driver = join(root, "parent.mjs");
const dispatchA = join(root, "dispatch-a.json");
const dispatchB = join(root, "dispatch-b.json");
writeFileSync(driver, `
import {createWorkflow} from ${JSON.stringify(operationsUrl)};
import {launchExecutionHost} from ${JSON.stringify(supervisorUrl)};
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const wf=createWorkflow({root:${JSON.stringify(root)},sessionKey:${JSON.stringify(OWNER)},executionLauncher:(args)=>launchExecutionHost({
  stateDir:args.stateDir,jobId:args.jobId,root:args.cwd,owner:args.workflow.sessionKey,kind:args.kind,phaseId:args.phaseId,baseRef:args.baseRef,constraints:"Preserve both deterministic lifecycle obligations.",
  spawnFn:(bin,argv,options)=>spawn(bin,['--input-type=module','-e',\`import {runExecutionHost} from ${JSON.stringify(hostUrl)}; await runExecutionHost(\${JSON.stringify(argv[1])},{loadPipeline:()=>import(${JSON.stringify(pathToFileURL(fakePipeline).href)})});\`],options),
})});
writeFileSync(${JSON.stringify(dispatchA)},JSON.stringify(wf.dispatchExecution({kind:'open',phaseId:${JSON.stringify(PHASE_A)},baseRef:'main'})));
writeFileSync(${JSON.stringify(dispatchB)},JSON.stringify(wf.dispatchExecution({kind:'bounded',phaseId:${JSON.stringify(PHASE_B)},baseRef:'main'})));
setInterval(()=>{},1000);
`);

const parent = spawn(process.execPath, [driver], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, QQ_WORKFLOW_STATE_DIR: stateDir } });
let parentStderr = "";
parent.stderr.on("data", (chunk) => { parentStderr += chunk; });
const env = { ...process.env, QQ_WORKFLOW_STATE_DIR: stateDir };
let jobIdA = null;
let jobIdB = null;
const wait = async (predicate, ms = 30000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`execution lifecycle timed out: ${parentStderr.slice(-1200)}`);
};
try {
  await wait(() => existsSync(dispatchA) && existsSync(dispatchB));
  jobIdA = JSON.parse(readFileSync(dispatchA, "utf8")).jobId;
  jobIdB = JSON.parse(readFileSync(dispatchB, "utf8")).jobId;
  await wait(() => readJob(stateDir, jobIdA)?.process?.pid && readJob(stateDir, jobIdB)?.process?.pid);
  await wait(() => existsSync(join(root,`started-${PHASE_A}`)) && existsSync(join(root,`started-${PHASE_B}`)));
  const before = readJob(stateDir, jobIdB);
  assert.notEqual(before.process.pid, parent.pid, "the execution runs in its own owned host, not in the coordinator");

  // Coordinator dies mid-execution; both hosts keep working.
  const exited = new Promise((done) => parent.once("exit", done));
  parent.kill("SIGKILL");
  await exited;

  // A replacement coordinator recovers from the ONE record + durable store.
  const notifications = [];
  const wf2 = createWorkflow({
    root,
    sessionKey: OWNER,
    env,
    notifierTransport: {
      name: "fixture",
      deliver: async (notification) => {
        // Reports BEFORE notification: the referenced report must already be
        // fully retrievable at delivery time.
        assert.ok(notification.reportId, "the notification references its durable report");
        assert.equal(wf2.readReport({ reportId: notification.reportId }).ok, true);
        notifications.push(notification);
        return { state: "delivered", receipt: { kind: "fixture", confirmed: true } };
      },
    },
  });

  // Steering before any role attempt is registered is a truthful refusal,
  // never a silent retarget and never a stdin write pretending delivery.
  const steered = await wf2.steerExecution({ jobId: jobIdB, message: "change of plan" });
  assert.equal(steered.ok, false);
  assert.match(steered.reason, /no unsettled role attempt|settled or cancelled/);

  // check_execution exposes bounded record-derived execution state.
  const runningView = await wf2.checkExecution({ jobId: jobIdB });
  assert.equal(runningView.authority.enabled !== false, true);
  assert.equal(runningView.authority.execution.kind, "bounded");
  assert.equal(runningView.authority.execution.phaseId, PHASE_B);
  assert.equal(runningView.authority.execution.owner, OWNER);
  assert.equal(runningView.authority.execution.outcomeKnown, false);

  // Cancellation: authoritative intent before any signal, then settle.
  const cancelled = await wf2.cancelExecution({ jobId: jobIdB, reason: "operator stopped the run" });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.signalled, true, "the fingerprint-matched owned host is signalled after the intent is recorded");
  const afterCancel = readJob(stateDir, jobIdB);
  assert.ok(afterCancel.cancellation, "the cancellation tombstone is durable");
  assert.equal(managedExecutionView({ stateDir, executionId: jobIdB }).execution.cancelIntent.reason, "operator stopped the run");
  const lateSteer = await wf2.steerExecution({ jobId: jobIdB, message: "too late" });
  assert.equal(lateSteer.ok, false, "updates are no longer admitted after an accepted cancellation");

  // Settle A (normal completion) and B (late result after cancellation).
  writeFileSync(join(root, `settle-${PHASE_A}`), "settle");
  writeFileSync(join(root, `settle-${PHASE_B}`), "settle");
  await wait(() => readJob(stateDir, jobIdA)?.terminal);
  await wait(() => managedExecutionView({ stateDir, executionId: jobIdB }).execution.evidence.some((entry) => entry.label === "late-result"));

  // A: completed; report before notification; replay dedupe; no relaunch.
  const jobA = readJob(stateDir, jobIdA);
  assert.equal(jobA.status, "completed", JSON.stringify(jobA.terminal));
  const viewA = managedExecutionView({ stateDir, executionId: jobIdA });
  assert.equal(viewA.execution.outcome.status, "completed");
  assert.equal(viewA.execution.outcomeKnown, true, "a recorded outcome is a KNOWN outcome");
  assert.ok(viewA.reports.some((entry) => entry.label === "pipeline-report"), "the pipeline report is linked as durable evidence");
  assert.ok(viewA.reports.some((entry) => entry.label.includes("implementer")), "role reports are linked for full retrieval");
  await wf2.recoverDeliveries();
  assert.equal(notifications.length, 1, "exactly one completion notification for the completed execution");
  await wf2.recoverDeliveries();
  assert.equal(notifications.length, 1, "replay is deduped across recovery passes");

  // B: cancelled outcome preserved; late evidence retrievable; no relabelling.
  const jobB = readJob(stateDir, jobIdB);
  assert.equal(jobB.status, "cancelled", "a late successful pipeline result never revives or relabels cancellation");
  const viewB = managedExecutionView({ stateDir, executionId: jobIdB });
  assert.equal(viewB.execution.outcome.status, "cancelled");
  const lateEntry = viewB.execution.evidence.find((entry) => entry.label === "late-result");
  assert.ok(lateEntry?.reportId, "the late result is durably linked");
  const lateReport = wf2.readReport({ reportId: lateEntry.reportId });
  assert.equal(lateReport.ok, true, "normal report retrieval works for the late evidence");
  assert.match(lateReport.text, /pipeline survived the coordinator/);
  const roleEntry = viewB.reports.find((entry) => entry.label.includes("implementer"));
  assert.match(wf2.readReport({ reportId: roleEntry.reportId }).text, /fake role findings/, "role reports survive the cancelled job");

  // Repeated cancellation is idempotent and never signals an unrelated PID or
  // restarts anything.
  const again = await wf2.cancelExecution({ jobId: jobIdB, reason: "operator stopped the run" });
  assert.equal(again.ok, true);
  assert.equal(again.alreadyTerminal, true);
  assert.equal(again.signalled, false);
  const reconciliation = reconcileManagedExecution({ stateDir, executionId: jobIdB });
  assert.equal(reconciliation.corrected, false, "the projection already matches the authoritative record");
  assert.equal(reconciliation.view.execution.outcomeKnown, true);
  console.log("PASS concurrent detached executions survive coordinator SIGKILL: record-derived check/steer/cancel surfaces, intent-before-signal cancellation, late evidence preserved without relabelling success, reports before notification, replay dedupe, no relaunch");
} finally {
  if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGTERM");
  for (const jobId of [jobIdA, jobIdB]) {
    if (!jobId) continue;
    const job = readJob(stateDir, jobId);
    const known = job?.process?.fingerprint ?? null;
    const current = job?.process?.pid ? processFingerprint({ pid: job.process.pid }) : null;
    if (known && current && known.startTicks === current.startTicks && known.cmdlineHash === current.cmdlineHash) {
      try { process.kill(current.pid, "SIGTERM"); } catch {}
    }
  }
}
