// Explicit launch of the existing managed pipeline in its own owned host.
// No restart policy: a disappeared host becomes interrupted (outcome unknown),
// never relaunched. The authoritative launch metadata — parent execution
// identity, phase ticket/worktree, coordinating owner, immutable original
// constraints, launch id and request path — is committed to the ONE change
// record BEFORE the host is spawned (durable spawn intent); the host
// reconstructs and verifies its request against that metadata and a forged or
// edited request fails closed before any work can start.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJob, writeJob, processFingerprint, reconcileJob, recordCancellation } from "./jobs.mjs";
import {spawnExecutionHostProcess} from "./execution-host-launcher.mjs";
import { recordManagedExecution, recordExecutionCancelIntent, executionAuthorityMetadata, reconcileManagedExecution } from "./execution-authority.mjs";
import {resolveTicketSource} from "./ticket.mjs";

export async function launchExecutionHost({
  stateDir,
  jobId,
  root,
  owner,
  kind,
  phaseId,
  baseRef,
  constraints = null,
  env = process.env,
  onPhase,
  spawnFn = spawn,
}) {
  const job = readJob(stateDir, jobId);
  if (!job || job.role !== "execution" || job.workflow?.sessionKey !== owner || job.terminal) {
    throw new Error("cannot launch execution host without an owned active job");
  }
  const dir = join(stateDir, "execution-hosts", jobId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const requestPath = join(dir, "request.json");
  const launchId = randomUUID();
  const originalConstraints = constraints ?? readFileSync(await resolveTicketSource(root, phaseId ?? owner), "utf8");
  // Durable spawn intent BEFORE any process exists.
  recordManagedExecution({
    stateDir,
    executionId: jobId,
    kind,
    phaseId: phaseId ?? null,
    baseRef: baseRef ?? null,
    root,
    owner,
    constraints: originalConstraints,
    launchId,
    requestPath,
  });
  writeFileSync(requestPath, JSON.stringify({ schema: 1, stateDir, jobId, root, owner, kind, phaseId, baseRef, launchId }), { flag: "wx", mode: 0o600 });
  writeJob(stateDir, { ...job, executionHost: { launchId, requestPath, authority: true }, updatedAt: Date.now() });
  const log = openSync(join(dir, "host.log"), "a", 0o600);
  let child;
  try {
    const hostEnv = { ...env, QQ_WORKFLOW_STATE_DIR: stateDir };
    child = spawnFn === spawn
      ? await spawnExecutionHostProcess({requestPath, root, env: hostEnv, log})
      : spawnFn(process.execPath, [fileURLToPath(new URL("./execution-host.mjs", import.meta.url)), requestPath], {
        cwd: root, env: hostEnv, detached: true, stdio: ["ignore", "ignore", log],
      });
  } finally {
    closeSync(log);
  }
  const current = readJob(stateDir, jobId);
  if (!current.terminal) writeJob(stateDir, { ...current, process: { pid: child.pid, spawnedAt: Date.now(), fingerprint: processFingerprint({ pid: child.pid }) }, updatedAt: Date.now() });
  child.unref?.();
  return new Promise((done, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      let current = reconcileJob(stateDir, jobId);
      // The host owns phase publication; a second parent writer could revive
      // stale running state after terminal publication.
      if (current?.terminal || current?.status !== "running") {
        settled = true;
        clearInterval(timer);
        done({ ok: current?.status === "completed", status: current?.status ?? "interrupted", phase: current?.phase, reportId: current?.terminal?.reportId, error: current?.terminal?.error });
      }
    };
    const timer = setInterval(finish, 500);
    timer.unref?.();
    child.on?.("error", (error) => { if (!settled) { settled = true; clearInterval(timer); reject(error); } });
    child.on?.("close", () => { reconcileJob(stateDir, jobId); finish(); });
    finish();
  });
}

/**
 * Cancel one managed execution safely:
 *   1. the AUTHORITATIVE cancellation intent is recorded before any signal
 *      (refused truthfully — with landing evidence preserved — when landing
 *      has already irreversibly begun);
 *   2. the compatibility tombstone mirrors the accepted intent;
 *   3. only a fingerprint-matched OWNED process is signalled. A repeated
 *      cancellation is idempotent, never signals an unrelated PID, and never
 *      restarts any worker.
 */
export function cancelExecutionHost({ stateDir, jobId, by = null, reason = "cancelled by architect", now = Date.now() } = {}) {
  let job = readJob(stateDir, jobId);
  // A job with an authoritative record records the intent there FIRST. A
  // legacy job without a record keeps the exact prior cancellation behavior.
  let hasAuthority = false;
  let authoritativeProcess=null;
  let intent = null;
  try {
    const metadata = executionAuthorityMetadata({ stateDir, executionId: jobId, job });
    hasAuthority = Boolean(metadata);
    if (metadata) {
      authoritativeProcess=metadata.observedIdentity?.host?metadata.observedIdentity:null;
      const reconstructed = reconcileManagedExecution({stateDir, executionId:jobId, expectedOwner:by, now});
      if (!reconstructed.ok) return {...reconstructed, code:reconstructed.code??"authority-unavailable", signalled:false};
      job=reconstructed.projection;
      const outcome = reconstructed.view.execution?.outcome;
      if (outcome) return {ok:true, status:outcome.status, alreadyTerminal:true, signalled:false, dedupe:true};
    }
  } catch (error) {
    return {ok:false, code:"authority-unavailable", reason:error.message, signalled:false};
  }
  if (!job || job.role !== "execution") return { ok: false, code: "not-found", reason: `no managed execution '${jobId}'` };
  if (by && job.workflow?.sessionKey !== by) return {ok:false, code:"owner-mismatch", signalled:false, reason:"execution belongs to another coordinating session"};
  if (hasAuthority) {
    intent = recordExecutionCancelIntent({ stateDir, executionId: jobId, reason, now });
    if (!intent.ok) return { ...intent, signalled: false };
    const reconstructed = reconcileManagedExecution({stateDir, executionId:jobId, now});
    if (!reconstructed.ok) return {...reconstructed, code:"authority-unavailable", signalled:false};
    const outcome=reconstructed.view.execution?.outcome;
    if(outcome)return {ok:true,status:outcome.status,alreadyTerminal:true,signalled:false,dedupe:true};
    if(!reconstructed.view.execution?.cancelIntent)return {ok:false,code:"cancellation-not-admitted",signalled:false,reason:"the execution has no committed cancellation intent"};
    if (job.cancellation) {
      return { ok: true, status: "cancelled", alreadyTerminal: true, signalled: false, dedupe: true, intent, note: "cancellation already recorded; nothing was signalled again" };
    }
  } else if (job.terminal || job.cancellation) {
    return { ok: true, status: job.status, alreadyTerminal: true, signalled: false, dedupe: true, note: "cancellation already recorded; nothing was signalled again" };
  }
  const cancelled = recordCancellation(stateDir, jobId, { by, reason, now });
  const recordedFingerprint = hasAuthority?authoritativeProcess?.fingerprint??null:cancelled.process?.fingerprint??null;
  const pid = hasAuthority?authoritativeProcess?.pid??null:cancelled.process?.pid??null;
  const livePrint = pid ? processFingerprint({ pid }) : null;
  const owned =
    Boolean(livePrint && recordedFingerprint) &&
    livePrint.startTicks === recordedFingerprint.startTicks &&
    livePrint.cmdlineHash === recordedFingerprint.cmdlineHash;
  let signalled = false;
  if (pid && owned) {
    try {
      process.kill(pid, "SIGTERM");
      signalled = true;
    } catch {}
  }
  return {
    ok: true,
    status: "cancelled",
    signalled,
    tombstoned: true,
    intent,
    note: signalled
      ? `${hasAuthority ? "authoritative cancellation intent recorded" : "cancellation recorded (no authoritative record for this legacy job)"} and the fingerprint-matched owned host was signalled`
      : `${hasAuthority ? "authoritative cancellation intent recorded" : "cancellation recorded (no authoritative record for this legacy job)"}; no owned live process was signalled (pid mismatch, already gone, or no process identity)`,
  };
}
