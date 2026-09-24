#!/usr/bin/env node
// An owned process hosting the EXISTING managed pipeline. The Architect's
// lifetime and stdout pipes are not the lifetime or result transport of a job.
// Requests/results are subordinate transport artifacts; workflow records and
// report references remain authoritative. A host is launched only by an
// explicit dispatch, never by recovery.
//
// The host reconstructs and verifies its request against the AUTHORITATIVE
// launch metadata in the one change record before any work starts (a forged or
// edited request fails closed), records its observed process identity, writes
// only guarded live telemetry (a stale write can never revive running/success
// or erase a cancellation), and settles through the authoritative record:
// validated outcome plus durable report/role-report references are persisted
// BEFORE the compatibility projection and any notification. Late results after
// a cancellation are linked as durable evidence without changing the cancelled
// outcome; an interrupted/disappeared pipeline stays outcome-unknown, never a
// known failed outcome.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readJob, writeJob, recordTerminal, updateRunningJob, processFingerprint } from "./jobs.mjs";
import { saveReport } from "./reports.mjs";
import {
  managedExecutionPipelineHooks,
  executionAuthorityMetadata,
  managedExecutionView,
  reconcileManagedExecution,
  recordAttemptEvidence,
  recordExecutionOutcome,
  recordHostStarted,
  verifyHostLaunch,
} from "./execution-authority.mjs";
import { completeAdrSourceRefs } from "./adr-curation.mjs";
import { localSyncWarning } from "./local-sync.mjs";

export function publishExecutionResult({ stateDir, jobId, result, now = Date.now() }) {
  const job = readJob(stateDir, jobId);
  if (!job || job.role !== "execution") throw new Error("execution identity unavailable");
  const report = saveReport(stateDir, {jobId, role:"execution", text:JSON.stringify(result,null,2), now});
  const meta = executionAuthorityMetadata({stateDir, executionId:jobId, job});
  const view = meta ? managedExecutionView({stateDir, executionId:jobId}) : null;
  let curationCompletion = null;
  let status = (meta ? view.execution.cancelIntent : job.cancellation) ? "cancelled"
    : result.ok === true && result.status === "completed" ? "completed"
    : result.status === "interrupted" ? "interrupted" : "failed";
  const warning = status === "completed" ? localSyncWarning(result.result?.landingOutcome) : null;
  const summary = result.error?.message ?? (warning ? `managed execution completed. ${warning}` : `managed execution ${status}`);
  if (meta) {
    if (status === "interrupted") {
      recordAttemptEvidence({stateDir,executionId:jobId,jobId,attemptId:meta.attemptId,label:"pipeline-report",reportId:report.reportId,note:`pipeline interrupted; outcome unknown: ${summary}`,now});
    } else {
      const outcome = recordExecutionOutcome({stateDir,executionId:jobId,status,summary,
        result:{ok:result.ok,status:result.status,phase:result.phase,childAttempts:result.childAttempts??[],
          ...(result.result?.landingOutcome ? { landingOutcome: { method:result.result.landingOutcome.method,
            pr:result.result.landingOutcome.pr,mergeSha:result.result.landingOutcome.mergeSha,
            ...(result.result.landingOutcome.localSync ? {localSync:result.result.landingOutcome.localSync} : {}) } } : {})},
        reportId:report.reportId,childReports:result.childAttempts??[],now});
      if (!outcome.ok) throw new Error(`managed result publication refused: ${outcome.reason}`);
      status = outcome.status;
      if (status === "cancelled" && result.status !== "cancelled") {
        recordAttemptEvidence({stateDir,executionId:jobId,jobId,attemptId:meta.attemptId,label:"late-result",reportId:report.reportId,note:`result ${result.status} arrived after accepted cancellation; outcome remains cancelled`,now});
      }
    }
    const recovered = reconcileManagedExecution({stateDir,executionId:jobId,now});
    if (!recovered.ok) throw new Error(recovered.reason);
    // Idempotent post-landing completion: the execution's final durable report
    // reference closes the landing-return -> report-finalization gap without
    // any circular dependency (landing never waits for it) and without ever
    // declaring complete evidence when the reference is absent. Failure is a
    // bounded warning only — publication and the settled result stand.
    try {
      curationCompletion = completeAdrSourceRefs({
        stateDir,
        executionId: jobId,
        refs: {
          executionReport: report
            ? { status: "retained", reportId: report.reportId }
            : { status: "missing", reason: "no durable execution report was persisted for this result" },
        },
        now,
      });
    } catch (error) {
      curationCompletion = { ok: false, reason: String(error?.message ?? error) };
    }
  }
  const settled = recordTerminal(stateDir,jobId,{status,summary,reportId:report.reportId,reportChars:report.chars,error:result.error??null,phase:result.phase,now});
  // Phase is telemetry; it cannot replace the authoritative outcome or report.
  if (result.phase && settled.phase !== result.phase) {
    settled.phase = result.phase;
    writeJob(stateDir,settled);
  }
  const settledResult = settled.terminal?.reportId === report.reportId ? settled : {...settled,
    lateEvidence:{reportId:report.reportId,reportChars:report.chars,at:now,resultStatus:result.status??null,outcomeUnchanged:settled.terminal?.status??null}};
  return curationCompletion ? { ...settledResult, curationCompletion } : settledResult;
}

export async function runExecutionHost(requestPath, { loadPipeline = () => import("../bin/mcp-server.mjs") } = {}) {
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  const { stateDir, jobId, owner, root, kind, phaseId, baseRef, launchId } = request;
  const job = readJob(stateDir, jobId);
  if (!job || job.role !== "execution" || job.workflow?.sessionKey !== owner || job.workflow?.root !== root || job.executionHost?.launchId !== launchId || job.executionHost?.requestPath !== resolve(requestPath) || job.kind !== kind || job.phaseId !== phaseId || (job.baseRef ?? null) !== (baseRef ?? null)) throw new Error("execution host ownership mismatch");
  if (job.terminal || job.cancellation) return job;
  // Authoritative verification: reconstruct the committed launch metadata and
  // crosscheck every request field against it. A forged request whose cache
  // fields happen to line up still fails closed against the record.
  const meta = executionAuthorityMetadata({stateDir,executionId:jobId,job});
  const hooks = meta ? managedExecutionPipelineHooks({ stateDir, executionId: jobId, owner }) : null;
  if (meta) {
    const verified = verifyHostLaunch({ stateDir, executionId: jobId, request, requestPath });
    if (!verified.ok) throw new Error(`execution host ownership mismatch: ${verified.reason}`);
  }
  // Spawn intent is durable before fork; do not run the pipeline until the
  // parent has published this host's observed process identity.
  const deadline = Date.now() + 5000;
  for (;;) {
    const current = readJob(stateDir, jobId);
    if (current?.terminal || current?.cancellation) return current;
    if (current?.process?.pid === process.pid) break;
    if (Date.now() > deadline) throw new Error("execution host process binding was not published");
    await new Promise((done) => setTimeout(done, 20));
  }
  if (meta?.attemptId) {
    recordHostStarted({
        stateDir,
        executionId: jobId,
        attemptId: meta.attemptId,
        identity: { host: true, pid: process.pid, fingerprint: processFingerprint({ pid: process.pid }), launchId: meta.launch?.launchId ?? null },
    });
  }
  const pipeline = await loadPipeline();
  let pipelineId = null;
  let cancelling = false;
  const cancel = async (signal) => {
    if (cancelling) return;
    cancelling = true;
    // Only the host's exact active child is signalled by the existing pipeline.
    // An external signal is interruption, not an invented operator cancellation.
    await pipeline.cancelExecution?.({ id: pipelineId, reason: signal, interrupted: !readJob(stateDir, jobId)?.cancellation });
  };
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  try {
    const started = await pipeline.dispatchExecution({
      kind,
      cwd: root,
      sessionId: owner,
      phaseId,
      baseRef,
      notificationMode: "parent",
      ...(hooks ? { authority: hooks } : {}),
    });
    pipelineId = started.id;
    if (cancelling) await pipeline.cancelExecution?.({ id: pipelineId, reason: "host interrupted", interrupted: !readJob(stateDir, jobId)?.cancellation });
    for (;;) {
      const view = await pipeline.checkExecution({ id: pipelineId });
      const current = readJob(stateDir, jobId);
      if (!current) throw new Error("execution record disappeared");
      if (current.cancellation && !cancelling) await cancel("cancellation intent");
      // Guarded live telemetry only: a cancellation or terminal that commits
      // during this window wins and is never overwritten by this stale write.
      if (!current.terminal) {
        updateRunningJob(stateDir, jobId, (fresh) => ({
          ...fresh,
          phase: view.phase,
          executionHost: { ...fresh.executionHost, pipelineId },
          telemetry: { source: "execution-host", lastObservedAt: Date.now(), activeTool: view.activeTool ?? null, trajectory: (view.trajectory ?? []).slice(-8) },
        }));
      }
      if (view.status !== "running" && view.pipelineSettled !== false) {
        return publishExecutionResult({
          stateDir,
          jobId,
          result: { ok: view.status === "completed", status: view.status, phase: view.phase, result: view.result, error: view.error, childAttempts: view.childAttempts ?? [], pipelineId },
        });
      }
      await new Promise((done) => setTimeout(done, 500));
    }
  } catch (error) {
    return publishExecutionResult({ stateDir, jobId, result: { ok: false, status: "failed", error: { message: error.message }, pipelineId } });
  } finally {
    process.off("SIGTERM", cancel);
    process.off("SIGINT", cancel);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runExecutionHost(process.argv[2]).catch((error) => {
    process.stderr.write(`execution host: ${error.message}\n`);
    process.exitCode = 1;
  });
}
