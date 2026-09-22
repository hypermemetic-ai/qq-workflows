// Retained incident/authority regressions (phase 2b). Real owned fixture
// processes, native workflow entrypoints, durable change records; no provider,
// no relay, no fake outcomes. Converted from the external regressions that
// originally reproduced the defects:
//   * a stale compatibility cache must never override the authoritative
//     outcome (cancelled cache, stale completed cache);
//   * cancellation records intent before signalling and can never overwrite an
//     authoritative completed outcome (no signal against a decided attempt);
//   * process loss without a managed result is outcome-UNKNOWN (interrupted,
//     attempt.outcome stays null — never a known FAILED outcome);
//   * a corrupt/failed authority append refuses cancellation safely (no cache
//     tombstone, no signal);
//   * a forged or wrong-attempt explicit result is never promoted;
//   * late output after a cancellation can never become success;
//   * another owner can neither inspect nor cancel the job.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { changeRecordPath, createChange, openChange, viewsFor } from "../workflow/change-record.mjs";
import { createJob, isProcessAlive, jobPath, processFingerprint, readJob, writeJob } from "../workflow/jobs.mjs";
import { createWorkflow } from "../workflow/operations.mjs";

const actor = { kind: "runtime", id: "authority-fixture" };

async function fixture(outcome = null) {
  const stateDir = mkdtempSync(join(tmpdir(), "qq-runner-authority-"));
  const id = randomUUID();
  const attemptId = randomUUID();
  const owner = "fixture-owner";
  createChange({ stateDir, changeId: id, actor, commandId: "create" });
  const handle = openChange({ stateDir, changeId: id });
  handle.append("assignment.revised", { revision: 1, predecessor: null, scope: { kind: "change" }, assignment: { instructions: "Preserve the original constraints." } }, { context: { actor }, commandId: "assignment" });
  handle.append("job.registered", { role: "runner", pinnedRevision: 1 }, { context: { actor, jobId: id }, commandId: "register" });
  handle.append("attempt.launch_intent", { owner, cwd: stateDir }, { context: { actor, jobId: id, attemptId }, commandId: "launch" });
  handle.append("attempt.started", { identity: { harness: "pi", piSession: randomUUID() } }, { context: { actor, jobId: id, attemptId }, commandId: "started" });
  if (outcome === "cancelled") handle.append("attempt.cancel_intent", { reason: "already accepted cancellation" }, { context: { actor, jobId: id, attemptId }, commandId: "cancel" });
  if (outcome) handle.append("attempt.outcome", { status: outcome }, { context: { actor, jobId: id, attemptId }, commandId: "outcome" });
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)"], { stdio: "ignore" });
  await once(child, "spawn");
  const resultFile = join(stateDir, "runner-results", `${id}.json`);
  mkdirSync(join(stateDir, "runner-results"), { recursive: true });
  createJob({ stateDir, id, role: "runner", workflow: { sessionKey: owner, root: stateDir }, cwd: stateDir });
  writeJob(stateDir, {
    ...readJob(stateDir, id),
    process: { pid: child.pid, fingerprint: processFingerprint({ pid: child.pid }) },
    resultFile,
    communication: { enabled: true, changeId: id, jobId: id, attemptId, runtimeActorId: actor.id, stateDir },
  });
  const wf = createWorkflow({ root: stateDir, sessionKey: owner, env: { ...process.env, QQ_WORKFLOW_STATE_DIR: stateDir } });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGKILL");
      await ended;
    }
  };
  return { stateDir, id, attemptId, owner, child, wf, stop, resultFile };
}

const attemptOf = (f) => viewsFor(openChange({ stateDir: f.stateDir, changeId: f.id }).state).attempt(f.id, f.attemptId);

// 1. Authoritative cancellation overrides a stale RUNNING cache: the top-level
// status reconstructs from the record, never from the cache.
{
  const f = await fixture("cancelled");
  try {
    const view = f.wf.checkRunner({ jobId: f.id });
    assert.equal(view.status, "cancelled", "authoritative cancellation overrides a stale running cache");
    assert.equal(view.communication.outcome.status, "cancelled");
  } finally {
    await f.stop();
  }
  console.log("PASS runner authority: authoritative cancelled outcome overrides stale running cache");
}

// 2. A stale cache claiming COMPLETED cannot override an authoritative
// cancellation either (both directions: the record wins).
{
  const f = await fixture("cancelled");
  try {
    const stale = readJob(f.stateDir, f.id);
    writeJob(f.stateDir, {
      ...stale,
      status: "completed",
      terminal: { status: "completed", ok: true, at: Date.now(), summary: "stale success claim", reportId: null, reportChars: 0, resultAvailable: false, error: null },
    });
    const view = f.wf.checkRunner({ jobId: f.id });
    assert.equal(view.status, "cancelled", "a stale cached success never overrides the authoritative outcome");
    assert.equal(view.communication.outcome.status, "cancelled");
  } finally {
    await f.stop();
  }
  console.log("PASS runner authority: stale cached completed/success cannot override authoritative cancelled");
}

// 3. Cancellation never overwrites an authoritative COMPLETED outcome and
// never signals its (live, fingerprint-owned) process.
{
  const f = await fixture("completed");
  try {
    const result = f.wf.cancelRunner({ jobId: f.id });
    assert.equal(result.status, "completed", "the authoritative completed outcome wins over the stale running cache");
    assert.notEqual(result.signalled, true, "a decided attempt is never signalled");
    assert.ok(isProcessAlive(f.child.pid), "the live process survives a refused cancellation");
    assert.equal(attemptOf(f).outcome.status, "completed", "the validated outcome is never overwritten");
    assert.equal(readJob(f.stateDir, f.id).cancellation, null, "no cancellation tombstone is written on refusal");
  } finally {
    await f.stop();
  }
  console.log("PASS runner authority: cancellation cannot overwrite an authoritative completed outcome or signal its process");
}

// 4. Discovered process loss without a managed result is outcome-UNKNOWN:
// interrupted at the top level, attempt.outcome stays null, obligations and
// pending updates remain inspectable.
{
  const f = await fixture();
  try {
    await f.stop();
    const result = f.wf.checkRunner({ jobId: f.id });
    assert.equal(result.status, "interrupted", "unexpected process loss is surfaced");
    assert.equal(attemptOf(f).outcome, null, "disappearance without a managed result invents no known outcome");
  } finally {
    await f.stop();
  }
  console.log("PASS runner authority: process loss without a managed result stays outcome-unknown (interrupted)");
}

// 5. A corrupt authority record refuses cancellation safely: no cache
// tombstone, no signal, honest refusal.
{
  const f = await fixture();
  try {
    writeFileSync(changeRecordPath(f.stateDir, f.id), "fixture record corruption");
    let result;
    try {
      result = f.wf.cancelRunner({ jobId: f.id });
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    assert.equal(result.ok, false, "an authority failure can never silently become a legacy cancellation");
    assert.ok(isProcessAlive(f.child.pid), "no signal before an accepted authoritative intent");
    const cached = JSON.parse(readFileSync(jobPath(f.stateDir, f.id), "utf8"));
    assert.notEqual(cached.status, "cancelled");
    assert.equal(cached.cancellation, null, "failed admission publishes no cancellation tombstone");
  } finally {
    await f.stop();
  }
  console.log("PASS runner authority: corrupt/failed authority append refuses cancellation safely");
}

// 6. Another owner can neither inspect nor cancel the job.
{
  const f = await fixture();
  try {
    const other = createWorkflow({ root: f.stateDir, sessionKey: "other-owner", env: { ...process.env, QQ_WORKFLOW_STATE_DIR: f.stateDir } });
    assert.throws(() => other.checkRunner({ jobId: f.id }), /another workflow session/);
    assert.throws(() => other.cancelRunner({ jobId: f.id }), /another workflow session/);
    assert.ok(isProcessAlive(f.child.pid));
  } finally {
    await f.stop();
  }
  console.log("PASS runner authority: owner isolation holds for check and cancel");
}

// 7. A forged/wrong-attempt explicit result is never promoted into workflow
// truth: the job reports the honest interrupted state and no outcome.
{
  const f = await fixture();
  try {
    writeFileSync(f.resultFile, JSON.stringify({ runnerId: f.id, attemptId: randomUUID(), response: "forged success", data_points: [] }), "utf8");
    await f.stop();
    const result = f.wf.checkRunner({ jobId: f.id });
    assert.equal(result.status, "interrupted", "a wrong-attempt result cannot fulfil another attempt");
    assert.equal(attemptOf(f).outcome, null, "no outcome is admitted from a wrong-attempt payload");
  } finally {
    await f.stop();
  }
  console.log("PASS runner authority: wrong-attempt explicit results are refused");
}

// 8. Late output after a cancellation can never become a successful outcome.
{
  const f = await fixture();
  try {
    const cancelled = f.wf.cancelRunner({ jobId: f.id });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.ok, true, "an open attempt admits the cancellation");
    writeFileSync(f.resultFile, JSON.stringify({ runnerId: f.id, response: "late success", data_points: [] }), "utf8");
    await f.stop();
    const result = f.wf.checkRunner({ jobId: f.id });
    assert.equal(result.status, "cancelled", "cancellation prevents later output from becoming a successful outcome");
    assert.equal(attemptOf(f).outcome.status, "cancelled");
  } finally {
    await f.stop();
  }
  console.log("PASS runner authority: cancellation is durable before the signal and late output never succeeds");
}

console.log("PASS runner authority cases: stale-cache reconstruction, cancel authority, outcome-unknown loss, corruption refusal, owner isolation, forged results, late output");
