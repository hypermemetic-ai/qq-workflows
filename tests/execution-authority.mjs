// Focused deterministic proof of the managed-execution authority: launch
// metadata verification (forged host requests fail closed), role/job/attempt
// identities and revisions in the ONE change record, truthful assignment
// updates bound to the intended active attempt (never a silent retarget),
// retry semantics (original constraints + acknowledged instructions kept,
// unresolved obligations never migrate), the distinct update lifecycle
// (submitted / transport-received / worker-acknowledged / fulfilled),
// authoritative cancellation before any signalling, the serialized
// landing-admission boundary, late evidence after cancellation without
// relabelling success, stale-cache reconstruction, outcome-unknown vs known
// failure, role report preservation and committed progress forwarding with
// replay protection. No external inference anywhere.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {randomUUID} from "node:crypto";

import {
  admitLanding,
  composeAssignment,
  forwardRoleProgress,
  managedExecutionView,
  pendingRoleProgress,
  readLaunchMetadata,
  recordAttemptEvidence,
  recordExecutionCancelIntent,
  recordExecutionOutcome,
  recordHostStarted,
  recordManagedExecution,
  recordRoleOutcome,
  reconcileManagedExecution,
  registerRoleAttempt,
  resolveActiveRoleAttempt,
  steerRoleAttempt,
  verifyHostLaunch,
  updateStatusOf,
} from "../workflow/execution-authority.mjs";
import { openChange, viewsFor } from "../workflow/change-record.mjs";
import { createJob, readJob, reconcileJob, recordCancellation, updateRunningJob, writeJob } from "../workflow/jobs.mjs";
import { bindAttemptReceiver, closeReceiverAdmission } from "../workflow/communication.mjs";
import { readReport, saveReport } from "../workflow/reports.mjs";
import { readNotification } from "../workflow/notify.mjs";
import {createWorkflow} from "../workflow/operations.mjs";

const root = mkdtempSync(join(tmpdir(), "qq-exec-authority-"));
const stateDir = join(root, "state");
const OWNER = "coordinator-1";
const PHASE = "bf1ec269-2cab-4a54-8e83-342b90c2f8d8";
const SESSION_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SESSION_B = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const pass = (message) => console.log(`PASS ${message}`);

{
  const pending={revision:3,targetedAttemptId:"old",acknowledged:null,acceptedAt:1};
  const job={attempts:{retry:{outcome:{status:"completed",revision:5}}}};
  assert.equal(updateStatusOf(pending,null,job),"transport-received","a higher retry revision cannot fulfill pending B");
  const acknowledged={...pending,acknowledged:{revision:3}};
  for(const status of ["failed","cancelled"])
    assert.equal(updateStatusOf(acknowledged,null,{attempts:{old:{outcome:{status,revision:3}}}}),"worker-acknowledged");
  assert.equal(updateStatusOf(acknowledged,null,job),"fulfilled","a successful retry can fulfill the acknowledged instructions it retains");
  pass("failed/cancelled outcomes and newer retries never invent fulfillment of pending updates");
}

{
  const owner=randomUUID();
  const wf=createWorkflow({root,sessionKey:owner,env:{QQ_WORKFLOW_STATE_DIR:stateDir},executionLauncher:async args=>{
    recordManagedExecution({stateDir,executionId:args.jobId,kind:"open",phaseId:PHASE,root,owner,constraints:"Keep unknown outcomes unknown.",launchId:randomUUID(),requestPath:join(stateDir,"fixture-request.json")});
    const job=readJob(stateDir,args.jobId);
    writeJob(stateDir,{...job,executionHost:{authority:true},process:{pid:999999999,fingerprint:null},createdAt:1});
    return {status:"interrupted"};
  }});
  const started=wf.dispatchExecution({kind:"open",phaseId:PHASE});
  await new Promise(done=>setImmediate(done));
  assert.equal(managedExecutionView({stateDir,executionId:started.jobId}).execution.outcome,null);
  assert.notEqual(wf.jobsView().find(job=>job.id===started.jobId).status,"completed");
  recordExecutionCancelIntent({stateDir,executionId:started.jobId});
  recordExecutionOutcome({stateDir,executionId:started.jobId,status:"cancelled"});
  for(const read of [()=>wf.jobsView(),()=>wf.reconcile().jobs]) {
    writeJob(stateDir,{...readJob(stateDir,started.jobId),status:"running",terminal:null,cancellation:null});
    assert.equal(read().find(job=>job.id===started.jobId).status,"cancelled");
  }
  pass("launcher interruption never invents completion; list and reconcile restore authoritative cancellation from stale caches");
}

function launch(overrides = {}) {
  const executionId = overrides.executionId;
  createJob({ stateDir, id: executionId, role: "execution", kind: overrides.kind ?? "open", workflow: { sessionKey: OWNER, root }, cwd: root, now: 1 });
  const requestPath = join(stateDir, "execution-hosts", executionId, "request.json");
  const request = {
    stateDir,
    jobId: executionId,
    owner: OWNER,
    root,
    kind: overrides.kind ?? "open",
    phaseId: PHASE,
    baseRef: overrides.baseRef ?? "main",
    launchId: overrides.launchId ?? `${executionId}-launch`,
  };
  recordManagedExecution({
    stateDir,
    executionId,
    kind: request.kind,
    phaseId: request.phaseId,
    baseRef: request.baseRef,
    root,
    owner: OWNER,
    constraints: overrides.constraints ?? "Create proof.txt containing finished. Never touch config/.",
    launchId: request.launchId,
    requestPath,
  });
  return { request, requestPath };
}

{
  const executionId=randomUUID();
  launch({executionId});
  const attemptId=readLaunchMetadata({stateDir,executionId}).attemptId;
  const reports=[1,2].map(n=>saveReport(stateDir,{jobId:executionId,role:"execution",text:`Late original findings ${n}`}));
  const args={stateDir,executionId,jobId:executionId,attemptId,label:`role-report-implementer-${randomUUID()}`};
  for(const report of reports)assert.equal(recordAttemptEvidence({...args,reportId:report.reportId}).ok,true);
  assert.equal(recordAttemptEvidence({...args,reportId:reports[0].reportId}).dedupe,true);
  const provenance={worktree:"/tmp/preserved-phase",branch:"architect/open/fixture",baseSelection:{ref:"origin/main",sha:"abc123",source:"remote-default"}};
  assert.equal(recordAttemptEvidence({...args,label:"worktree-base",note:JSON.stringify(provenance)}).ok,true);
  const view=managedExecutionView({stateDir,executionId});
  assert.equal(view.execution.evidence.filter(entry=>entry.label===args.label).length,2);
  assert.deepEqual(view.execution.worktreeSelection,provenance);
  const outcome=recordExecutionOutcome({stateDir,executionId,status:"completed",identity:{host:true,pid:process.pid},reportId:reports[0].reportId,
    childReports:[{jobId:randomUUID(),role:"implementer",reportId:reports[1].reportId}]});
  assert.equal(outcome.ok,true,JSON.stringify(outcome));
  assert.ok(outcome.evidence.every(entry=>entry.ok));
  pass("real UUID evidence IDs fit the record; distinct same-label reports and actual worktree provenance remain retrievable");
}

{
  launch({executionId:"exec-forged-revision"});
  registerRoleAttempt({stateDir,executionId:"exec-forged-revision",role:"implementer",jobId:"forged-role",attemptId:"forged-attempt",prompt:"Implement the approved task.",cwd:root});
  bindAttemptReceiver({stateDir,changeId:"exec-forged-revision",jobId:"forged-role",attemptId:"forged-attempt",sessionId:SESSION_A,seat:"implementer",runtimeActorId:"qq-execution-authority"});
  const report=saveReport(stateDir,{jobId:"forged-role",role:"implementer",text:"Retain the rejected result for inspection."});
  const rejected=recordRoleOutcome({stateDir,executionId:"exec-forged-revision",jobId:"forged-role",attemptId:"forged-attempt",status:"completed",claimedRevision:999,reportId:report.reportId});
  assert.equal(rejected.ok,false,"a forged revision cannot be silently relabelled to the acknowledged revision");
  const attempt=viewsFor(openChange({stateDir,changeId:"exec-forged-revision"}).state).attempt("forged-role","forged-attempt");
  assert.equal(attempt.outcome,null);
  assert.ok(attempt.evidence.some(entry=>entry.reportId===report.reportId));
  assert.ok(readReport(stateDir,report.reportId).ok);
  pass("forged result revision is refused; original findings remain durable evidence without invented success");
}

// ---------------------------------------------------------------------------
// 1. Authoritative launch metadata: forged host requests fail closed (gap 3).
// ---------------------------------------------------------------------------
{
  const { request, requestPath } = launch({ executionId: "exec-launch" });
  const meta = readLaunchMetadata({ stateDir, executionId: "exec-launch" });
  assert.equal(meta.launch.kind, "open");
  assert.equal(meta.launch.phaseId, PHASE);
  assert.equal(meta.launch.baseRef, "main");
  assert.equal(meta.launch.owner, OWNER);
  assert.equal(meta.launch.requestPath, requestPath);
  assert.equal(meta.constraintsRevision, 1);
  const ok = verifyHostLaunch({ stateDir, executionId: "exec-launch", request, requestPath });
  assert.equal(ok.ok, true, ok.reason);
  for (const [field, value] of [["kind", "bounded"], ["phaseId", "11111111-2222-4333-8444-555555555555"], ["baseRef", "other"], ["owner", "intruder"], ["root", "/tmp"], ["launchId", "forged"], ["jobId", "other-job"]]) {
    const forged = verifyHostLaunch({ stateDir, executionId: "exec-launch", request: { ...request, [field]: value }, requestPath });
    assert.equal(forged.ok, false, `forged ${field} must fail closed`);
    assert.match(forged.reason, /mismatch/);
  }
  const forgedPath = verifyHostLaunch({ stateDir, executionId: "exec-launch", request, requestPath: "/tmp/elsewhere/request.json" });
  assert.equal(forgedPath.ok, false, "a forged request path fails closed");
  recordHostStarted({ stateDir, executionId: "exec-launch", attemptId: meta.attemptId, identity: { host: true, pid: 4242 } });
  const started = viewsFor(openChange({ stateDir, changeId: "exec-launch" }).state).attempt("exec-launch", meta.attemptId);
  assert.equal(started.phase, "started");
  pass("launch metadata is authoritative; every forged request field fails closed before any work can start");
}

// ---------------------------------------------------------------------------
// 2. Role attempts, truthful updates bound to the active attempt, retries.
// ---------------------------------------------------------------------------
{
  const { request } = launch({ executionId: "exec-steer" });
  const first = registerRoleAttempt({ stateDir, executionId: "exec-steer", role: "implementer", jobId: "impl-1", attemptId: "impl-a1", prompt: "Implement the ticket. Never touch config/.", cwd: root, owner: OWNER });
  assert.equal(first.ok, true);
  assert.equal(resolveActiveRoleAttempt({ stateDir, executionId: "exec-steer" }).attemptId, "impl-a1");
  bindAttemptReceiver({ stateDir, changeId: "exec-steer", jobId: "impl-1", attemptId: "impl-a1", sessionId: SESSION_A, seat: "implementer", runtimeActorId: "qq-execution-authority" });

  // Update B targets the exact currently intended active attempt.
  const steered = await steerRoleAttempt({ stateDir, executionId: "exec-steer", message: "Also add a proof test.", expectAttemptId: "impl-a1" });
  assert.equal(steered.ok, true, JSON.stringify(steered));
  assert.equal(steered.bound.attemptId, "impl-a1");
  assert.equal(steered.status, "submitted");
  assert.equal(steered.acknowledged, false, "submission is never acknowledgement");
  // Composed instructions: original constraints verbatim, then the exact
  // updates copy and the labelled update — never a replacement.
  const composed = viewsFor(openChange({ stateDir, changeId: "exec-steer" }).state).assignment({ revision: steered.revision });
  const text = typeof composed.assignment === "string" ? composed.assignment : composed.assignment.instructions;
  assert.match(text, /^Implement the ticket\. Never touch config\/\./, "the original constraints stay verbatim at the head");
  assert.match(text, /## Assignment updates\nApply these updates in revision order\. A later update takes precedence where it conflicts with an earlier instruction\./);
  assert.ok(text.includes(`[revision ${steered.revision}]\nAlso add a proof test.`));
  // A stale expected attempt races to a truthful refusal, never a retarget.
  const retarget = await steerRoleAttempt({ stateDir, executionId: "exec-steer", message: "x", expectAttemptId: "impl-a0" });
  assert.equal(retarget.ok, false);
  assert.equal(retarget.code, "target-changed");

  // Update lifecycle: submitted -> transport-received -> worker-acknowledged.
  let view = managedExecutionView({ stateDir, executionId: "exec-steer" });
  let update = view.updates.find((entry) => entry.revision === steered.revision);
  assert.equal(update.status, "submitted");
  openChange({ stateDir, changeId: "exec-steer" }).append(
    "amendment.accepted",
    { amendmentId: steered.amendmentId },
    { context: { actor: { kind: "runtime", id: "qq-execution-authority" }, jobId: "impl-1", attemptId: "impl-a1" }, commandId: `accept-${steered.amendmentId}`, now: 10 },
  );
  view = managedExecutionView({ stateDir, executionId: "exec-steer" });
  update = view.updates.find((entry) => entry.revision === steered.revision);
  assert.equal(update.status, "transport-received", "receiver acceptance is transport receipt, never incorporation");
  openChange({ stateDir, changeId: "exec-steer" }).append(
    "worker.acknowledged",
    { revision: steered.revision },
    { context: { actor: { kind: "worker", id: "worker-impl-a1" }, jobId: "impl-1", attemptId: "impl-a1" }, commandId: `ack-impl-a1-${steered.revision}`, now: 11 },
  );
  view = managedExecutionView({ stateDir, executionId: "exec-steer" });
  update = view.updates.find((entry) => entry.revision === steered.revision);
  assert.equal(update.status, "worker-acknowledged");

  // A second update stays UNACKNOWLEDGED: this is the pending obligation B
  // that must survive a retry un-migrated.
  const unacked = await steerRoleAttempt({ stateDir, executionId: "exec-steer", message: "Unresolved obligation on the old attempt." });
  assert.equal(unacked.ok, true);
  assert.equal(unacked.bound.attemptId, "impl-a1");

  // The validated result pins the ACTUAL acknowledged revision.
  const outcome = recordRoleOutcome({
    stateDir,
    executionId: "exec-steer",
    role: "implementer",
    jobId: "impl-1",
    attemptId: "impl-a1",
    status: "completed",
    summary: "implemented",
    reportId: saveReport(stateDir, { jobId: "impl-1", role: "implementer", text: "full implementer findings" }).reportId,
    claimedRevision: steered.revision,
    identity: { seat: "implementer", resultBinding: { jobId: "impl-1", attemptId: "impl-a1", role: "implementer" } },
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.revision, steered.revision, "the outcome revision is the acknowledged revision");
  view = managedExecutionView({ stateDir, executionId: "exec-steer" });
  update = view.updates.find((entry) => entry.revision === steered.revision);
  assert.equal(update.status, "fulfilled", "a result at that revision fulfils the update");
  const stillPending = view.updates.find((entry) => entry.revision === unacked.revision);
  assert.notEqual(stillPending.status, "fulfilled", "update B pending with a result for A is never claimed fulfilled");

  // Retry: original constraints + acknowledged instructions retained; the
  // unacknowledged obligation stays targeted at the old attempt (unresolved).
  const retry = registerRoleAttempt({
    stateDir,
    executionId: "exec-steer",
    role: "implementer",
    jobId: "impl-x",
    attemptId: "impl-a2",
    prompt: "Retry implementing the ticket after review.",
    retryOfJobId: "impl-1",
    cwd: root,
  });
  assert.equal(retry.jobId, "impl-1", "the retry is a new attempt on the SAME role job");
  assert.equal(retry.retry, true);
  const retryView = viewsFor(openChange({ stateDir, changeId: "exec-steer" }).state).assignment({ revision: retry.revision });
  const retryText = typeof retryView.assignment === "string" ? retryView.assignment : retryView.assignment.instructions;
  assert.match(retryText, /^Implement the ticket\. Never touch config\//, "the retry preserves the original role assignment");
  assert.ok(retryText.includes("Retry implementing the ticket after review."));
  assert.ok(retryText.includes("Create proof.txt containing finished. Never touch config/."), "the approved phase constraints remain verbatim");
  assert.ok(retryText.includes("Also add a proof test."), "acknowledged instructions are retained");
  assert.ok(!retryText.includes("Unresolved obligation"), "an unacknowledged obligation never migrates into a new attempt");
  view = managedExecutionView({ stateDir, executionId: "exec-steer" });
  const migrated = view.updates.find((entry) => entry.revision === unacked.revision);
  assert.equal(migrated.targetedAttemptId, "impl-a1", "the unresolved obligation stays targeted at its old attempt");
  assert.notEqual(migrated.status, "fulfilled");
  const retried=recordRoleOutcome({stateDir,executionId:"exec-steer",jobId:"impl-1",attemptId:"impl-a2",status:"completed",claimedRevision:retry.revision,
    identity:{seat:"implementer",resultBinding:{jobId:"impl-1",attemptId:"impl-a2",role:"implementer"}}});
  assert.equal(retried.ok,true);
  const afterRetry=managedExecutionView({stateDir,executionId:"exec-steer"}).updates.find(entry=>entry.revision===unacked.revision);
  assert.equal(afterRetry.status,"submitted","successful retry excludes B and cannot hide it as fulfilled");
  const blocked=admitLanding({stateDir,executionId:"exec-steer",resultRevision:retry.revision});
  assert.equal(blocked.ok,false);assert.equal(blocked.code,"pending-update");
  assert.ok(blocked.pending.some(entry=>entry.revision===unacked.revision));

  // Two attempts on the SAME revision (honest relaunch of identical work).
  const same = registerRoleAttempt({ stateDir, executionId: "exec-steer", role: "implementer", jobId: "impl-x", attemptId: "impl-a3", prompt: "ignored", retryOfJobId: "impl-1", reuseRevision: first.revision });
  assert.equal(same.revision, first.revision);
  assert.equal(same.reusedRevision, true);
  // A reviewer seat stays read-only: its role assignment says so verbatim and
  // an update can never change that.
  registerRoleAttempt({ stateDir, executionId: "exec-steer", role: "reviewer", jobId: "rev-1", attemptId: "rev-a1", prompt: "Review read-only; never modify the implementation.", cwd: root });
  const revJob = managedExecutionView({ stateDir, executionId: "exec-steer" }).roles.find((entry) => entry.role === "reviewer");
  assert.ok(revJob, "the reviewer role job is recorded with its own identity");
  pass("updates bind to the intended active attempt with truthful refusals; retries keep constraints and acknowledged updates without migration");

  // Steering a receiver whose admission closed is a refusal with the recorded
  // revision kept unresolved — never a silent drop and never a retarget.
  const bound2 = resolveActiveRoleAttempt({ stateDir, executionId: "exec-steer" });
  bindAttemptReceiver({ stateDir, changeId: "exec-steer", jobId: bound2.jobId, attemptId: bound2.attemptId, sessionId: SESSION_B, seat: "implementer", runtimeActorId: "qq-execution-authority" });
  closeReceiverAdmission({ stateDir, changeId: "exec-steer", jobId: bound2.jobId, attemptId: bound2.attemptId, runtimeActorId: "qq-execution-authority" });
  const closed = await steerRoleAttempt({ stateDir, executionId: "exec-steer", message: "too late" });
  assert.equal(closed.ok, false);
  assert.equal(closed.code, "refused");
  assert.match(closed.reason, /admission is closed/);
  pass("a closed receiver admission refuses updates with its obligation preserved");

  // A claimed result revision that is not the acknowledged/pinned revision is
  // never adopted silently.
  const claimed = recordRoleOutcome({
    stateDir,
    executionId: "exec-steer",
    role: "implementer",
    jobId: "impl-1",
    attemptId: "impl-a1",
    status: "failed",
    claimedRevision: 99,
    summary: "late claim",
  });
  assert.equal(claimed.ok, true, "an outcome for an already-settled attempt is a dedupe, never an overwrite");
  assert.equal(claimed.status, "completed", "the recorded outcome stands");
  void request;
}

// ---------------------------------------------------------------------------
// 3. Cancellation is authoritative before any signal; late evidence survives
//    without relabelling cancellation as success (gaps 1 and 4).
// ---------------------------------------------------------------------------
{
  launch({ executionId: "exec-cancel" });
  recordHostStarted({ stateDir, executionId: "exec-cancel", attemptId: readLaunchMetadata({ stateDir, executionId: "exec-cancel" }).attemptId, identity: { host: true, pid: 1 } });
  registerRoleAttempt({ stateDir, executionId: "exec-cancel", role: "implementer", jobId: "c-impl", attemptId: "c-impl-a1", prompt: "Implement.", cwd: root });
  const intent = recordExecutionCancelIntent({ stateDir, executionId: "exec-cancel", reason: "operator stopped the run", now: 20 });
  assert.equal(intent.ok, true);
  const repeat = recordExecutionCancelIntent({ stateDir, executionId: "exec-cancel", reason: "operator stopped the run", now: 21 });
  assert.equal(repeat.ok, true, "repeated cancellation is idempotent");
  assert.equal(repeat.dedupe, true, "no second intent event is invented");
  // Cancellation intent covers the execution AND every unsettled role attempt.
  const cancelledView = managedExecutionView({ stateDir, executionId: "exec-cancel" });
  assert.ok(cancelledView.execution.cancelIntent);
  assert.ok(cancelledView.roles[0].attempts[0].cancelIntent, "the role attempt carries the cancellation intent too");

  // A completed result racing the accepted cancellation becomes EVIDENCE.
  const late = recordExecutionOutcome({
    stateDir,
    executionId: "exec-cancel",
    status: "completed",
    summary: "landed anyway",
    result: { landingOutcome: "already landed" },
    reportId: saveReport(stateDir, { jobId: "exec-cancel", role: "execution", text: "late landing evidence" }).reportId,
    childReports: [{ role: "implementer", jobId: "c-impl", reportId: saveReport(stateDir, { jobId: "c-impl", role: "implementer", text: "late role findings" }).reportId, status: "completed" }],
  });
  assert.equal(late.recorded, false, "a successful outcome can never follow an accepted cancellation");
  assert.equal(late.status, "cancelled");
  assert.ok(late.evidence.length >= 1, "the late result is preserved as evidence");
  const evidenceView = managedExecutionView({ stateDir, executionId: "exec-cancel" });
  const lateEntry = evidenceView.execution.evidence.find((entry) => entry.label === "late-result");
  assert.ok(lateEntry?.reportId, "the late report stays linked");
  assert.ok(readReport(stateDir, lateEntry.reportId).ok, "the late report is retrievable through the normal report path");
  // The settle maps to the cancelled outcome — the outcome changes to the
  // truthful cancelled state once, and stays there.
  const settled = recordExecutionOutcome({ stateDir, executionId: "exec-cancel", status: "cancelled", summary: "cancelled", reportId: null });
  assert.equal(settled.status, "cancelled");
  const again = recordExecutionOutcome({ stateDir, executionId: "exec-cancel", status: "completed" });
  assert.equal(again.recorded, false, "a later completed claim never overwrites the cancelled outcome");
  assert.equal(again.status, "cancelled");
  const finalView = managedExecutionView({ stateDir, executionId: "exec-cancel" });
  assert.equal(finalView.execution.outcome.status, "cancelled");
  assert.equal(finalView.execution.outcomeKnown, true);
  pass("authoritative cancellation intent is idempotent; late results are durable evidence without relabelling cancellation as success");

  // Landing admission after an accepted cancellation is refused.
  const landing = admitLanding({ stateDir, executionId: "exec-cancel", resultRevision: null });
  assert.equal(landing.ok, false);
  assert.equal(landing.code, "cancelled");
  pass("landing is never admitted after an accepted cancellation");
}

// ---------------------------------------------------------------------------
// 4. Landing admission: refusal after landing began preserves evidence; a
//    pending update B with a result for A blocks automatic landing.
// ---------------------------------------------------------------------------
{
  launch({ executionId: "exec-land" });
  recordHostStarted({ stateDir, executionId: "exec-land", attemptId: readLaunchMetadata({ stateDir, executionId: "exec-land" }).attemptId, identity: { host: true, pid: 1 } });
  const role = registerRoleAttempt({ stateDir, executionId: "exec-land", role: "implementer", jobId: "l-impl", attemptId: "l-impl-a1", prompt: "Implement.", cwd: root });
  // Pending update B while the result covers revision A: blocked, visible.
  bindAttemptReceiver({ stateDir, changeId: "exec-land", jobId: "l-impl", attemptId: "l-impl-a1", sessionId: SESSION_A, seat: "implementer", runtimeActorId: "qq-execution-authority" });
  const updateB = await steerRoleAttempt({ stateDir, executionId: "exec-land", message: "Change the approach." });
  const blocked = admitLanding({ stateDir, executionId: "exec-land", resultRevision: role.revision });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "pending-update");
  assert.equal(blocked.pending.length, 1, "the pending obligation stays visible for an explicit decision");
  assert.equal(admitLanding({stateDir,executionId:"exec-land",resultRevision:999}).ok,false,"a newer result from another role cannot cover this role's pending update");
  assert.throws(() => openChange({stateDir,changeId:"exec-land"}).append(
    "attempt.landing_admitted", {note:"stale preflight"},
    {context:{actor:{kind:"runtime",id:"fixture"},jobId:"exec-land",attemptId:readLaunchMetadata({stateDir,executionId:"exec-land"}).attemptId},commandId:"raced-landing"}
  ), /unacknowledged assignment update/, "the atomic append itself checks pending updates, even when a caller preflight raced");
  // Acknowledge B and land against its revision: admitted.
  openChange({ stateDir, changeId: "exec-land" }).append(
    "worker.acknowledged",
    { revision: updateB.revision },
    { context: { actor: { kind: "worker", id: "worker-l-impl-a1" }, jobId: "l-impl", attemptId: "l-impl-a1" }, commandId: `ack-l-impl-a1-${updateB.revision}`, now: 30 },
  );
  const admitted = admitLanding({ stateDir, executionId: "exec-land", resultRevision: updateB.revision });
  assert.equal(admitted.ok, true, admitted.reason);
  const dedupe = admitLanding({ stateDir, executionId: "exec-land", resultRevision: updateB.revision });
  assert.equal(dedupe.dedupe, true, "landing admission is recorded exactly once");
  // After landing admission a cancellation refuses truthfully and keeps the
  // landing evidence — rollback is never implied.
  const refused = recordExecutionCancelIntent({ stateDir, executionId: "exec-land", reason: "too late" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "landing-begun");
  assert.match(refused.reason, /cancellation cannot undo it/);
  assert.ok(refused.landingEvidence?.seq, "the landing evidence is preserved with the refusal");
  const lateUpdate = await steerRoleAttempt({stateDir,executionId:"exec-land",message:"too late to amend"});
  assert.equal(lateUpdate.ok,false,"the landing boundary also rejects subsequent amendments");
  pass("landing admission is serialized with update state; a begun landing refuses cancellation truthfully with its evidence preserved");
}

// ---------------------------------------------------------------------------
// 5. Stale cross-process cache writes cannot revive running/success (gap 2);
//    disappearance stays outcome-unknown, distinct from a known failure (gap
//    4); role reports survive for failed/cancelled work.
// ---------------------------------------------------------------------------
{
  launch({ executionId: "exec-stale" });
  recordHostStarted({ stateDir, executionId: "exec-stale", attemptId: readLaunchMetadata({ stateDir, executionId: "exec-stale" }).attemptId, identity: { host: true, pid: 1 } });
  recordExecutionCancelIntent({ stateDir, executionId: "exec-stale", reason: "cancelled", now: 40 });
  recordCancellation(stateDir, "exec-stale", { by: OWNER, reason: "cancelled", now: 41 });
  // A stale guarded write is refused outright.
  const guarded = updateRunningJob(stateDir, "exec-stale", { status: "running", terminal: null, cancellation: null, phase: "implementing" });
  assert.equal(guarded.status, "cancelled", "a guarded stale write never revives running state");
  assert.ok(guarded.cancellation, "the cancellation tombstone survives");
  // Even a RAW stale write is corrected from the one append-only record.
  const stale = readJob(stateDir, "exec-stale");
  writeJob(stateDir, { ...stale, status: "running", terminal: null, cancellation: null, finishedAt: null });
  const reconstructed = reconcileManagedExecution({ stateDir, executionId: "exec-stale" });
  assert.equal(reconstructed.corrected, true);
  assert.equal(reconstructed.projection.status, "cancelled", "the record reconstructs the projection; stale success/running cannot revive");
  assert.equal(reconstructed.projection.recovery.verdict, "cancellation-intent-authoritative");

  // A known failed outcome vs a disappeared execution with NO outcome.
  const failed = recordExecutionOutcome({ stateDir, executionId: "exec-stale", status: "cancelled", summary: "settled cancelled" });
  assert.equal(failed.status, "cancelled");
  const knownView = managedExecutionView({ stateDir, executionId: "exec-stale" });
  assert.equal(knownView.execution.outcomeKnown, true, "a recorded outcome is a KNOWN outcome");
  launch({ executionId: "exec-gone" });
  createJob({ stateDir, id: "gone-probe", role: "runner", workflow: { sessionKey: OWNER, root }, cwd: root, process: { pid: 999999 }, now: 2 });
  const gone = reconcileJob(stateDir, "gone-probe");
  assert.equal(gone.status, "interrupted");
  assert.match(gone.terminal.summary, /outcome unknown/i, "disappearance is never a known failed outcome");
  const goneView = managedExecutionView({ stateDir, executionId: "exec-gone" });
  assert.equal(goneView.execution.outcomeKnown, false, "an execution without a recorded outcome stays outcome-UNKNOWN");

  // Role reports survive for failed/cancelled jobs (retrievable, attributed).
  const roleReport = saveReport(stateDir, { jobId: "l-impl", role: "implementer", text: "failure diagnostics for the cancelled run" });
  recordAttemptEvidence({ stateDir, executionId: "exec-stale", jobId: "exec-stale", attemptId: readLaunchMetadata({ stateDir, executionId: "exec-stale" }).attemptId, label: "role-report-implementer", reportId: roleReport.reportId, note: "failed/cancelled role findings" });
  const withReports = managedExecutionView({ stateDir, executionId: "exec-stale" });
  assert.ok(withReports.reports.some((entry) => entry.reportId === roleReport.reportId), "role reports stay linked for failed/cancelled work");
  assert.match(readReport(stateDir, roleReport.reportId).text, /failure diagnostics/);
  pass("stale cache writes cannot revive settled state; disappearance is outcome-unknown; role reports survive failures and cancellations");
}

// ---------------------------------------------------------------------------
// 6. Committed progress forwarding: role attribution, stable identity, replay
//    protection, honest states, owner isolation.
// ---------------------------------------------------------------------------
{
  launch({ executionId: "exec-progress" });
  registerRoleAttempt({ stateDir, executionId: "exec-progress", role: "reviewer", jobId: "p-rev", attemptId: "p-rev-a1", prompt: "Review.", cwd: root });
  bindAttemptReceiver({ stateDir, changeId: "exec-progress", jobId: "p-rev", attemptId: "p-rev-a1", sessionId: SESSION_B, seat: "reviewer", runtimeActorId: "qq-execution-authority" });
  const handle = openChange({ stateDir, changeId: "exec-progress" });
  const committed = handle.append(
    "worker.progress",
    { note: "Reviewed the parser; one finding recorded." },
    { context: { actor: { kind: "worker", id: "worker-p-rev-a1" }, jobId: "p-rev", attemptId: "p-rev-a1" }, commandId: "progress-p-rev-a1-1", now: 50 },
  );
  const delivered = [];
  const transport = { name: "fixture", deliver: async (notification) => { delivered.push(notification); return { state: "delivered", receipt: { kind: "fixture", confirmed: true } }; } };
  const forwarded = await forwardRoleProgress({ stateDir, executionId: "exec-progress", jobId: "p-rev", attemptId: "p-rev-a1", seq: committed.seq, transport, owner: OWNER });
  assert.equal(forwarded.ok, true);
  assert.match(delivered[0].text, /\(reviewer\) reported progress at sequence \d+ \(attempt p-rev-a1\)/, "the notification is role/attempt/sequence attributed");
  assert.ok(delivered[0].text.includes("Reviewed the parser; one finding recorded."), "the committed note is the body verbatim");
  assert.equal(forwarded.eventId, `execution:p-rev:progress:exec-progress:p-rev-a1:${committed.seq}`, "stable change/job/attempt/sequence identity");
  assert.ok(readNotification(stateDir, forwarded.eventId), "the durable notification journal records the route");
  const replay = await forwardRoleProgress({ stateDir, executionId: "exec-progress", jobId: "p-rev", attemptId: "p-rev-a1", seq: committed.seq, transport, owner: OWNER });
  assert.equal(replay.duplicate, true, "replay protection: a repeated forward never delivers twice");
  assert.equal(delivered.length, 1);
  const wrongOwner = await forwardRoleProgress({ stateDir, executionId: "exec-progress", jobId: "p-rev", attemptId: "p-rev-a1", seq: committed.seq, transport, owner: "someone-else" });
  assert.equal(wrongOwner.ok, false, "owner isolation across parent reloads");
  assert.equal(wrongOwner.code, "not-owned");
  const missing = await forwardRoleProgress({ stateDir, executionId: "exec-progress", jobId: "p-rev", attemptId: "p-rev-a1", seq: 999999, transport, owner: OWNER });
  assert.equal(missing.ok, false, "a forged/uncommitted sequence is never published as progress");
  assert.equal(missing.code, "unknown-source");
  // No transport: the committed entry stays retryable and is never claimed
  // delivered (queue acceptance is not receipt).
  const blockerHandle = openChange({ stateDir, changeId: "exec-progress" });
  const blocker = blockerHandle.append(
    "worker.blocker",
    { note: "Need a decision on the schema.", fatal: true },
    { context: { actor: { kind: "worker", id: "worker-p-rev-a1" }, jobId: "p-rev", attemptId: "p-rev-a1" }, commandId: "blocker-p-rev-a1-1", now: 51 },
  );
  const offline = await forwardRoleProgress({ stateDir, executionId: "exec-progress", jobId: "p-rev", attemptId: "p-rev-a1", seq: blocker.seq, transport: null, owner: OWNER });
  assert.equal(offline.state, "failed");
  assert.ok(offline.reason.includes("no architect notification transport"), "an unavailable transport is reported honestly");
  const pending = pendingRoleProgress({ stateDir, executionId: "exec-progress" });
  const pendingEntry = pending.find((entry) => entry.seq === blocker.seq && entry.kind === "blocker");
  assert.equal(pendingEntry.pending, true, "unforwarded committed progress stays pending across a parent reload");
  const recoveredEntry = pending.find((entry) => entry.seq === committed.seq);
  assert.equal(recoveredEntry.pending, false, "already-forwarded progress is not re-obligated");
  pass("committed progress/blocker forwarding: role-attributed, replay-protected, owner-isolated, honest about unavailable transports");
}

// ---------------------------------------------------------------------------
// 7. Composition helpers keep the exact updates copy.
// ---------------------------------------------------------------------------
{
  const composed = composeAssignment({ task: "Task.", amendments: [{ revision: 3, text: "later" }, { revision: 2, text: "earlier" }] });
  assert.ok(composed.indexOf("[revision 2]") < composed.indexOf("[revision 3]"), "updates compose in committed revision order");
  assert.match(composed, /## Assignment updates\nApply these updates in revision order\. A later update takes precedence where it conflicts with an earlier instruction\./);
  assert.ok(!composeAssignment({ task: "Task." }).includes("## Assignment updates"), "a bare assignment carries no updates heading");
}
pass("assignment composition preserves original constraints and ordered amendments verbatim");

console.log("execution-authority: all focused groups passed.");
