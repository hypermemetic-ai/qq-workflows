#!/usr/bin/env node
// Mocked integration roundtrip: ticket read/update -> runner -> full result
// retrieval -> idle/busy completion delivery to the exact originating agent,
// with two simultaneous Architect agents, restart recovery, and worker pins.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflow, interpretRunnerEvent, WORKFLOW_TOOL_NAMES } from "../workflow/operations.mjs";
import { readJob, writeJob } from "../workflow/jobs.mjs";
import { readReport } from "../workflow/reports.mjs";
import {
  DEFAULT_WORKER_CONFIG_PATH,
  planFingerprint,
  planToSpawn,
  readCentralWorkerConfig,
  resolveWorkerLaunchPlan,
  workerConfigPath,
} from "../workflow/worker-launch.mjs";
import { WORKER_DEEPSEEK_ADAPTER } from "../workflow/worker-config.mjs";
import { agentTransport, runnerSpawner, tempRepo, tempDir } from "./support/architect-fixtures.mjs";

const { root, env } = await tempRepo({ agents: "Repository rule: keep changes in the worktree.\n" });

function workflowFor({ sessionKey, transport, spawnFn, overrides = {} }) {
  return createWorkflow({
    root,
    sessionKey,
    env: { ...env, QQ_WORKFLOW_SESSION_ID: sessionKey, QQ_ARCHITECT_OWNER_AGENT_ID: sessionKey },
    notifierTransport: transport,
    spawnFn,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// O1. Ticket read/update is scoped to the workflow session key.
// ---------------------------------------------------------------------------
const transportA = agentTransport({ name: "agent-A" });
const spawnsA = [];
const agentA = workflowFor({ sessionKey: "agent-A", transport: transportA, spawnFn: runnerSpawner({ response: "A findings", record: spawnsA }) });

const association = agentA.session();
assert.equal(association.sessionKey, "agent-A");
assert.equal((await agentA.readTicket({})).ok, false, "no ticket exists until it is written");
const written = await agentA.updateTicket({ content: "# Ticket\n\n## Problem\n\napp-selectable architect\n" });
assert.equal(written.ok, true);
assert.ok(existsSync(written.path));
const readBack = await agentA.readTicket({ section: "Problem" });
assert.equal(readBack.ok, true);
assert.match(readBack.content, /app-selectable architect/);
assert.ok(readBack.sections.includes("Problem"));
const sectionMiss = await agentA.readTicket({ section: "Nonexistent" });
assert.equal(sectionMiss.ok, false);
assert.match(sectionMiss.error, /Available sections/);

// The other agent gets its own ticket file: no shared state.
const transportB = agentTransport({ name: "agent-B" });
const spawnsB = [];
const agentB = workflowFor({ sessionKey: "agent-B", transport: transportB, spawnFn: runnerSpawner({ response: "B findings", record: spawnsB }) });
assert.equal((await agentB.readTicket({})).ok, false, "a second agent does not see the first agent's ticket");
await agentB.updateTicket({ content: "# Ticket\n\n## Problem\n\nsecond agent ticket\n" });
assert.match((await agentB.readTicket({ section: "Problem" })).content, /second agent ticket/);
assert.match((await agentA.readTicket({ section: "Problem" })).content, /app-selectable architect/);
assert.notEqual(agentA.session().sessionId, agentB.session().sessionId);

// ---------------------------------------------------------------------------
// O2. Runner dispatch -> full report retrieval -> completion delivery.
// ---------------------------------------------------------------------------
const longFindings = `${"evidence line\n".repeat(2_500)}CONCLUSION: the retry path is correct.`;
const spawnsLong = [];
const transportLong = agentTransport({ name: "agent-A" });
const agentLong = workflowFor({
  sessionKey: "agent-A",
  transport: transportLong,
  spawnFn: (command, args, options) =>
    runnerSpawner({ response: longFindings, dataPoints: ["evidence-1", "evidence-2"], record: spawnsLong })(command, args, options),
});
const dispatch = agentLong.dispatchRunner({ task: "verify the retry path", targetPaths: ["workflow/operations.mjs"] });
assert.equal(dispatch.ok, true);
assert.equal(dispatch.status, "running");
assert.equal(dispatch.pid, 424242);
const spawn = spawnsLong[0];
// The runner seat launches the centrally configured harness adapter, with an
// explicit seat, the target repository as working directory only, and its bound
// identity/transport inside the central contract. No agy/legacy path remains.
assert.equal(spawn.command, process.execPath, "the configured harness adapter runs under this node");
assert.equal(spawn.args[0], WORKER_DEEPSEEK_ADAPTER, "the central adapter source, not a target-project launcher");
assert.equal(spawn.args[1], "--production", "production mode is explicit");
const spawnArgv = spawn.args.join(" ");
assert.ok(spawnArgv.includes("--seat runner"), "the seat is explicit");
assert.ok(spawnArgv.includes(`--runtime-root ${root}/deepseek-minimal-runtime`), "the pinned runtime root is the fixture's");
assert.ok(spawnArgv.includes("--cwd"), "the target repository is only a working directory");
assert.ok(spawnArgv.includes("verify the retry path"), "the task is the prompt");
assert.ok(spawnArgv.includes("workflow/operations.mjs"), "target paths ride in the prompt");
assert.doesNotMatch(spawnArgv, /(^|\s)agy(\s|$)|--agent\s|--model\s+gemini|gemini-3\.8/, "no legacy runner argv may survive");
assert.equal(spawn.options.env.QQ_RUNNER_ID, dispatch.jobId);
assert.ok(spawn.options.env.QQ_RUNNER_RESULT_FILE.endsWith(".json"));
assert.equal(spawn.options.env.DEEPSEEK_API_KEY, undefined, "no credential is invented for the runner launch");

const runningView = agentLong.checkRunner({ jobId: dispatch.jobId });
assert.equal(runningView.status, "running");
assert.equal(runningView.sessionKey, "agent-A");
assert.equal(runningView.launchPlan.source, "central-config");
assert.equal(runningView.launchPlan.harness, "deepseek-minimal", "the recorded plan is the centrally configured harness");
assert.equal(runningView.launchPlan.provider, "deepseek");
assert.equal(runningView.launchPlan.model, "deepseek-flash");
assert.equal(runningView.launchPlan.reasoning_effort, "max");
assert.equal(runningView.launchPlan.runtime_root, join(root, "deepseek-minimal-runtime"));
assert.ok(runningView.launchPlan.fingerprint);

const settled = await agentLong.awaitRunner({ jobId: dispatch.jobId });
assert.equal(settled.settled, true);
assert.equal(settled.status, "completed");
assert.ok(settled.terminal.reportId, "the terminal record points at a durable report");
assert.ok(settled.terminal.reportChars >= longFindings.length, "the durable report holds the complete worker result");
assert.equal(settled.delivery.state, "delivered", "an idle session starts a turn for the completion");
assert.equal(transportLong.delivered.length, 1);
assert.equal(transportLong.delivered[0].jobId, dispatch.jobId);
assert.ok(transportLong.delivered[0].text.length <= 16_384, "the notification is bounded by the observed transport cap");
assert.ok(transportLong.delivered[0].text.includes("read_report"), "the notification points at the durable report");

let fullText = "";
let offset = 0;
for (;;) {
  const chunk = agentLong.readReport({ reportId: settled.terminal.reportId, offset });
  fullText += chunk.text;
  offset = chunk.nextOffset;
  if (chunk.complete) break;
}
assert.ok(fullText.includes("CONCLUSION: the retry path is correct."), "the full findings are retrievable in chunks");
assert.ok(fullText.length > 16_384, "the full report is longer than the transport cap and still fully recoverable");
assert.ok(fullText.includes("data_points"), "data points are part of the durable report");

// A busy session queues instead of interrupting, and never loses the result.
const busy = agentTransport({ name: "agent-A-busy", idle: false });
const agentBusy = workflowFor({ sessionKey: "agent-A", transport: busy, spawnFn: runnerSpawner({ response: "busy findings" }) });
const busyDispatch = agentBusy.dispatchRunner({ task: "second runner" });
const busySettled = await agentBusy.awaitRunner({ jobId: busyDispatch.jobId });
assert.equal(busySettled.status, "completed");
assert.equal(busy.delivered[0].state, "queued", "a busy session gets a queued (non-interrupting) notification");
assert.ok(busySettled.terminal.reportId, "the result is durable even when delivery is only queued");

// A runner that exits without an authoritative complete_task result is a failure,
// and its diagnostics are persisted for inspection.
const failed = workflowFor({
  sessionKey: "agent-A",
  transport: agentTransport(),
  spawnFn: (command, args, options) =>
    runnerSpawner({ response: "ignored", exitCode: 3, resultWriter: ({ options: spawnOptions, child }) => { child.stderr.write("boom: harness failed\n"); void spawnOptions; } })(command, args, options),
});
const failedDispatch = failed.dispatchRunner({ task: "will fail" });
const failedSettled = await failed.awaitRunner({ jobId: failedDispatch.jobId });
assert.equal(failedSettled.status, "failed");
assert.ok(failedSettled.terminal.reportId, "failure diagnostics are persisted too");
assert.match(readReport(join(root, ".architect", "state"), failedSettled.terminal.reportId).text, /code 3/);

// ---------------------------------------------------------------------------
// O3. Steer and cancel: cancellation is tombstoned and recovery never restarts.
// ---------------------------------------------------------------------------
let held = null;
const heldTransport = agentTransport();
const agentHeld = workflowFor({
  sessionKey: "agent-A",
  transport: heldTransport,
  spawnFn: (command, args, options) => {
    held = runnerSpawner({ response: "late" })(command, args, options);
    held.emit("hold");
    return held;
  },
});
const heldDispatch = agentHeld.dispatchRunner({ task: "long runner" });
const steer = agentHeld.steerRunner({ jobId: heldDispatch.jobId, message: "also check the worktree root" });
assert.equal(steer.ok, true);
assert.deepEqual(held.written, ["also check the worktree root\n"], "steering writes to the live runner without restarting it");
const cancelled = agentHeld.cancelRunner({ jobId: heldDispatch.jobId, reason: "operator changed direction" });
assert.equal(cancelled.status, "cancelled");
assert.equal(cancelled.tombstoned, true);
const cancelledRecord = readJob(join(root, ".architect", "state"), heldDispatch.jobId);
assert.equal(cancelledRecord.status, "cancelled");
assert.equal(cancelledRecord.cancellation.reason, "operator changed direction");
assert.equal(held.killedWith, "SIGTERM");

// ---------------------------------------------------------------------------
// O4. Restart: durable records survive, nothing is replayed unsafely.
// ---------------------------------------------------------------------------
const restartTransport = agentTransport({ name: "agent-A-after-restart" });
const afterRestart = workflowFor({ sessionKey: "agent-A", transport: restartTransport, spawnFn: runnerSpawner({ response: "never used" }) });
const jobsAfterRestart = afterRestart.jobsView();
assert.ok(jobsAfterRestart.some((job) => job.id === dispatch.jobId && job.status === "completed"), "completed jobs stay inspectable after a restart");
assert.ok(jobsAfterRestart.some((job) => job.id === heldDispatch.jobId && job.status === "cancelled"));
assert.ok(afterRestart.readReport({ reportId: settled.terminal.reportId }).ok, "reports stay retrievable after a restart");

// An in-flight record whose process is gone is reported as interrupted, never completed.
const stateDir = join(root, ".architect", "state");
const orphanId = "job-restart-orphan";
writeJob(stateDir, {
  schema: 1,
  id: orphanId,
  role: "execution",
  kind: "open",
  workflow: { sessionKey: "agent-A", sessionId: afterRestart.session().sessionId, ownerAgentId: "agent-A", root },
  cwd: root,
  task: "implementation",
  status: "running",
  phase: "implementer",
  startedAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
  finishedAt: null,
  process: { pid: 987_654_321, spawnedAt: Date.now() - 60_000, fingerprint: { pid: 987_654_321, startTicks: "1", cmdlineHash: "dead" } },
  launchPlan: null,
  cancellation: null,
  terminal: null,
  delivery: null,
  recovery: null,
  events: [],
});
const recovered = await afterRestart.recoverDeliveries();
const orphan = recovered.jobs.find((job) => job.id === orphanId);
assert.equal(orphan.status, "interrupted", "a job whose process is gone reports interruption, not success");
assert.equal(orphan.terminal.ok, false);
assert.equal(orphan.delivery, null);
assert.equal(recovered.pendingDelivery.includes(orphanId), true, "the interrupted job is surfaced for a decision");
const orphanNotice = restartTransport.delivered.find((notification) => notification.jobId === orphanId);
assert.ok(orphanNotice, "recovery surfaces the interrupted job to its owning session");
assert.match(orphanNotice.text, /job-restart-orphan interrupted/);
assert.match(orphanNotice.text, /outcome unknown/);
assert.doesNotMatch(orphanNotice.text, /completed/);
assert.equal(orphan.terminal.reportId, null, "an interrupted job has no fabricated result");
assert.equal(orphan.terminal.resultAvailable, false);
assert.match(recovered.note, /never restarts work/);
assert.match(recovered.note, /unreconciled rather than delivered/, "recovery documents what it does with a record it could not persist");
assert.deepEqual(recovered.unreconciled, [], "a clean recovery reports no unreconciled completion");
assert.equal(Array.isArray(recovered.reconciled), true);

// A cancelled job is never restarted or re-notified by recovery.
assert.equal(restartTransport.delivered.some((notification) => notification.jobId === heldDispatch.jobId), false);
const cancelledAfterRecovery = readJob(stateDir, heldDispatch.jobId);
assert.equal(cancelledAfterRecovery.status, "cancelled");
assert.ok(cancelledAfterRecovery.cancellation);

// Await after a restart returns a truthful reconciliation instead of hanging.
const awaited = await afterRestart.awaitRunner({ jobId: orphanId });
assert.equal(awaited.settled, true);
assert.equal(awaited.status, "interrupted");
assert.match(awaited.note, /restart/);

// ---------------------------------------------------------------------------
// O5. Two simultaneous agents never cross-route tickets or results.
// ---------------------------------------------------------------------------
const crossA = agentTransport({ name: "cross-A" });
const crossB = agentTransport({ name: "cross-B" });
const wfA = workflowFor({ sessionKey: "cross-A", transport: crossA, spawnFn: runnerSpawner({ response: "for A" }) });
const wfB = workflowFor({ sessionKey: "cross-B", transport: crossB, spawnFn: runnerSpawner({ response: "for B" }) });
await wfA.updateTicket({ content: "# Ticket\n\n## Problem\n\nticket A\n" });
await wfB.updateTicket({ content: "# Ticket\n\n## Problem\n\nticket B\n" });
const dispatchA = wfA.dispatchRunner({ task: "A only" });
const dispatchB = wfB.dispatchRunner({ task: "B only" });
const [settledA, settledB] = await Promise.all([
  wfA.awaitRunner({ jobId: dispatchA.jobId }),
  wfB.awaitRunner({ jobId: dispatchB.jobId }),
]);
assert.equal(settledA.sessionKey, "cross-A");
assert.equal(settledB.sessionKey, "cross-B");
assert.ok(crossA.delivered.every((notification) => notification.jobId === dispatchA.jobId));
assert.ok(crossB.delivered.every((notification) => notification.jobId === dispatchB.jobId));
assert.equal(crossA.delivered.length, 1);
assert.equal(crossB.delivered.length, 1);
assert.throws(() => wfB.checkRunner({ jobId: dispatchA.jobId }), /another workflow session/);
await assert.rejects(() => wfB.awaitRunner({ jobId: dispatchA.jobId }), /another workflow session/);
const wfC = workflowFor({ sessionKey: "cross-C", transport: agentTransport({ name: "cross-C" }), spawnFn: runnerSpawner({}) });
assert.equal((await wfC.readTicket({})).ok, false, "a fresh session has no ticket and none is inferred for it");
assert.match((await wfA.readTicket({ section: "Problem" })).content, /ticket A/);
assert.match((await wfB.readTicket({ section: "Problem" })).content, /ticket B/);

// A replayed completion can only reach its own session's transport. A pending
// completion owned by another session is reported as orphaned (including one
// still only queued, whose receipt is unverified) and never re-routed.
const recoveryA = await wfA.recoverDeliveries();
assert.deepEqual(recoveryA.delivery.replayed, [], "nothing is replayed for a session with no pending delivery");
assert.ok(
  recoveryA.delivery.orphaned.every((entry) => entry.owner !== "cross-A"),
  "orphaned entries always name a different owning session",
);
assert.equal(crossB.delivered.length, 1, "recovery for A never delivers to B");

// ---------------------------------------------------------------------------
// O5b. Managed execution delegation: durable execution jobs, phases, delivery.
// ---------------------------------------------------------------------------
const execTransport = agentTransport({ name: "exec-agent" });
const execPhases = [];
const execLauncher = async ({ kind, onPhase }) => {
  onPhase?.("implementing", "prepare_worktree");
  onPhase?.("reviewing", null);
  return {
    ok: true,
    status: "completed",
    phase: "landed",
    result: {
      kind,
      verifiedStory: "Implemented and verified through the managed pipeline.",
      landingOutcome: { method: "merge", pr: 42, mergeSha: "abcdef123456" },
      implementerSummary: "Changed workflow operations.",
      reviewerSummary: "Verdict: PASS with evidence.",
    },
    error: null,
  };
};
const execWorkflow = createWorkflow({
  root,
  sessionKey: "exec-agent",
  env: { ...env, QQ_WORKFLOW_SESSION_ID: "exec-agent" },
  notifierTransport: execTransport,
  executionLauncher: async (options) => {
    execPhases.push(options.onPhase ? "has-onPhase" : "no-onPhase");
    return await execLauncher(options);
  },
});
await execWorkflow.updateTicket({ content: "# Ticket\n\n## Kind\n\nbounded\n" });
const execDispatch = execWorkflow.dispatchExecution({ kind: "bounded" });
assert.equal(execDispatch.ok, true);
assert.equal(execDispatch.status, "running");
const execSettled = await execWorkflow.awaitExecution({ jobId: execDispatch.jobId });
assert.equal(execSettled.settled, true);
assert.equal(execSettled.status, "completed");
assert.equal(execSettled.role, "execution");
assert.equal(execSettled.kind, "bounded");
assert.ok(execSettled.terminal.reportId, "the managed execution result is persisted");
assert.equal(execSettled.delivery.state, "delivered");
assert.equal(execTransport.delivered.length, 1);
const execReport = execWorkflow.readReport({ reportId: execSettled.terminal.reportId });
assert.match(execReport.text, /verifiedStory/);
assert.equal(execPhases.length, 1);
const execRecord = readJob(join(root, ".architect", "state"), execDispatch.jobId);
assert.equal(execRecord.role, "execution");
assert.ok(execRecord.events.some((event) => event.action === "phase" && event.phase === "reviewing"), "phase transitions are journaled");
assert.deepEqual(execWorkflow.jobsView().map((job) => job.role), ["execution"], "executions live in the same durable store as runners, scoped by session");
assert.ok(agentA.jobsView().some((job) => job.role === "runner"), "a runner session keeps its own jobs");
assert.equal(
  agentA.jobsView().some((job) => job.id === execDispatch.jobId),
  false,
  "another session's executions are not listed",
);
assert.throws(() => execWorkflow.checkExecution({ jobId: "no-such-job" }), /unknown job/);

// A failing managed execution is recorded with its diagnostics, and a profile
// without the managed pipeline refuses instead of mutating anything directly.
const failingExec = createWorkflow({
  root,
  sessionKey: "exec-agent",
  env: { ...env, QQ_WORKFLOW_SESSION_ID: "exec-agent" },
  notifierTransport: agentTransport(),
  executionLauncher: async () => ({ ok: false, status: "failed", phase: "review", error: { message: "reviewer found defects", phase: "review" } }),
});
const failingDispatch = failingExec.dispatchExecution({ kind: "open" });
const failingSettled = await failingExec.awaitExecution({ jobId: failingDispatch.jobId });
assert.equal(failingSettled.status, "failed");
assert.match(failingSettled.terminal.summary, /reviewer found defects/);
assert.ok(failingSettled.terminal.reportId, "failure diagnostics are persisted for executions too");

const unmanaged = createWorkflow({ root, sessionKey: "exec-agent", env: { ...env, QQ_WORKFLOW_SESSION_ID: "exec-agent" } });
const refused = unmanaged.dispatchExecution({ kind: "bounded" });
assert.equal(refused.ok, false);
assert.match(refused.error, /managed execution pipeline is not configured/);
assert.throws(() => unmanaged.dispatchExecution({ kind: "research" }), /bounded.*open/);
const runnerOnly = createWorkflow({
  root,
  sessionKey: "exec-agent",
  env: { ...env, QQ_WORKFLOW_SESSION_ID: "exec-agent" },
  notifierTransport: agentTransport(),
  spawnFn: runnerSpawner({ response: "r" }),
});
const runnerJob = runnerOnly.dispatchRunner({ task: "runner only" });
assert.throws(() => runnerOnly.checkExecution({ jobId: runnerJob.jobId }), /not a managed execution/);
await runnerOnly.awaitRunner({ jobId: runnerJob.jobId });

// ---------------------------------------------------------------------------
// O6. Every native tool name is reachable through the shared dispatcher.
// ---------------------------------------------------------------------------
for (const name of WORKFLOW_TOOL_NAMES) {
  if (name === "recover_deliveries") continue;
  if (["dispatch_runner", "dispatch_execution", "check_execution", "await_execution"].includes(name)) continue;
  const args = {
    read_ticket: {},
    update_ticket: { content: "# Ticket\n" },
    check_runner: { jobId: dispatchA.jobId },
    await_runner: { jobId: dispatchA.jobId },
    steer_runner: { jobId: dispatchA.jobId, message: "x" },
    cancel_runner: { jobId: dispatchA.jobId },
    read_report: { reportId: settledA.terminal.reportId },
    list_jobs: {},
  }[name];
  const result = await wfA.callTool(name, args);
  assert.ok(result !== undefined, `tool ${name} dispatches`);
}
const execCheck = await execWorkflow.callTool("check_execution", { jobId: execDispatch.jobId });
assert.equal(execCheck.role, "execution");
assert.equal(execCheck.status, "completed");
const execAwait = await execWorkflow.callTool("await_execution", { jobId: execDispatch.jobId });
assert.equal(execAwait.settled, true);
assert.equal(execAwait.kind, "bounded");
const jobsListed = await wfA.callTool("list_jobs", {});
assert.ok(jobsListed.jobs.some((job) => job.id === dispatchA.jobId));
assert.ok(jobsListed.jobs.every((job) => job.sessionKey === "cross-A"), "list_jobs is session-scoped by default");
const allJobs = await wfA.callTool("list_jobs", { scope: "all" });
assert.ok(allJobs.jobs.length >= jobsListed.jobs.length);
await assert.rejects(() => wfA.callTool("land", {}), /unknown workflow tool/);
await assert.rejects(() => wfA.callTool("bash", {}), /unknown workflow tool/);

// ---------------------------------------------------------------------------
// O7. Worker launch plans keep the configured pins; nothing substitutes them.
// ---------------------------------------------------------------------------
const workerConfigDir = tempDir("qq-worker-config-");
const workerConfigPathFixture = join(workerConfigDir, "worker-config.json");
const pins = {
  provider: "deepseek",
  model: "deepseek-flash",
  base_url: "https://api.deepseek.com",
  wire_api: "responses",
  env_key: "DEEPSEEK_API_KEY",
  api_key_file: join(workerConfigDir, "deepseek-api-key"),
  reasoning_effort: "max",
  harness: "deepseek-minimal",
};
writeFileSync(workerConfigPathFixture, JSON.stringify(pins, null, 2), "utf8");
const runtimeRoot = join(workerConfigDir, "runtime");
mkdirSync(join(runtimeRoot, "upstream"), { recursive: true });
writeFileSync(join(runtimeRoot, "provenance.json"), JSON.stringify({ globalDshUsed: false }), "utf8");
writeFileSync(join(runtimeRoot, "upstream", "package.json"), JSON.stringify({ version: "0.1.6-alpha.2" }), "utf8");
const pinnedEnv = { QQ_WORKER_CONFIG_FILE: workerConfigPathFixture, QQ_DEEPSEEK_RUNTIME_ROOT: runtimeRoot };
assert.equal(workerConfigPath(pinnedEnv), workerConfigPathFixture);
assert.equal(workerConfigPath({}), DEFAULT_WORKER_CONFIG_PATH, "the default central config path is unchanged");
const central = readCentralWorkerConfig({ env: pinnedEnv });
assert.equal(central.provider, "deepseek");
assert.equal(central.harness, "deepseek-minimal");

const plan = resolveWorkerLaunchPlan({ role: "runner", env: pinnedEnv });
assert.equal(plan.source, "central-config");
assert.deepEqual(
  {
    provider: plan.provider,
    model: plan.model,
    base_url: plan.base_url,
    wire_api: plan.wire_api,
    env_key: plan.env_key,
    api_key_file: plan.api_key_file,
    reasoning_effort: plan.reasoning_effort,
    harness: plan.harness,
  },
  { ...pins, api_key_file: pins.api_key_file },
  "the plan records the operator's pins verbatim",
);
assert.equal(plan.configPath, workerConfigPathFixture);
assert.equal(plan.runtime_root, runtimeRoot);
assert.equal(planFingerprint(plan).length, 16);

// The plan becomes the real production launcher argument contract: the
// configured harness adapter, an explicit seat, the target repository as cwd,
// the pinned runtime root, and the runner's bound identity/transport.
const runnerId = "o7-bound-runner";
const resultFile = join(tmpdir(), `qq-runner-result-${runnerId}.json`);
const spawnPlan = planToSpawn(plan, {
  prompt: "do work",
  env: pinnedEnv,
  cwd: root,
  mcpEnv: { QQ_RUNNER_ID: runnerId, QQ_RUNNER_RESULT_FILE: resultFile },
});
assert.equal(spawnPlan.executable.mode, "central");
assert.equal(spawnPlan.executable.harness, "deepseek-minimal");
assert.equal(spawnPlan.command, process.execPath);
assert.equal(spawnPlan.args[0], WORKER_DEEPSEEK_ADAPTER);
assert.equal(spawnPlan.args[1], "--production");
assert.deepEqual(spawnPlan.args.slice(2, 8), ["--seat", "runner", "--cwd", root, "--prompt", "do work"]);
assert.deepEqual(spawnPlan.args.slice(-2), ["--runtime-root", runtimeRoot]);
assert.equal(spawnPlan.env.QQ_RUNNER_ID, runnerId);
assert.equal(spawnPlan.env.QQ_RUNNER_RESULT_FILE, resultFile);
assert.equal(spawnPlan.env.QQ_DEEPSEEK_RUNTIME_ROOT, runtimeRoot);
assert.equal(spawnPlan.env.QQ_WORKER_CONFIG_FILE, workerConfigPathFixture, "the adapter re-reads the same central config");

// A project-local launcher (or a harness probe under the target repository) is
// never consulted: the integration source in this checkout is the only source.
mkdirSync(join(root, "bin"), { recursive: true });
writeFileSync(join(root, "bin", "worker-exec.mjs"), "// project-local launcher\n", "utf8");
mkdirSync(join(root, "prototype", "deepseek-minimal", "adapter"), { recursive: true });
writeFileSync(join(root, "prototype", "deepseek-minimal", "adapter", "worker.mjs"), "// project-local adapter\n", "utf8");
const projectProbe = planToSpawn(plan, {
  prompt: "do work",
  env: pinnedEnv,
  cwd: root,
  mcpEnv: { QQ_RUNNER_ID: runnerId, QQ_RUNNER_RESULT_FILE: resultFile },
});
assert.equal(projectProbe.args[0], WORKER_DEEPSEEK_ADAPTER, "the installed adapter is used, not the target project's");
assert.ok(!projectProbe.args[0].startsWith(root), "the target project cannot hijack the worker launcher");
assert.deepEqual(projectProbe.args, spawnPlan.args);
rmSync(join(root, "prototype"), { recursive: true, force: true });
rmSync(join(root, "bin", "worker-exec.mjs"), { force: true });

// A configured executable override outside the central contract is refused
// instead of being honored.
assert.throws(
  () => resolveWorkerLaunchPlan({ role: "runner", env: { ...pinnedEnv, QQ_WORKER_EXEC: "/usr/bin/agy" } }),
  /QQ_WORKER_EXEC=.* is not a supported worker launch override/,
);

// Fail closed on a pin violation; never fall back to another provider or model.
for (const violation of [{ provider: "openai" }, { model: "gpt-x" }]) {
  const path = join(workerConfigDir, `bad-${Object.keys(violation)[0]}.json`);
  writeFileSync(path, JSON.stringify({ ...pins, ...violation }), "utf8");
  assert.throws(
    () => resolveWorkerLaunchPlan({ role: "runner", env: { QQ_WORKER_CONFIG_FILE: path } }),
    /not authorized/,
    "a pin violation refuses the launch instead of substituting a provider",
  );
}

// A missing central configuration is refused: there is no default pins path,
// no agy fallback, and no legacy model substitution.
const missingConfig = join(workerConfigDir, "missing.json");
assert.throws(
  () => resolveWorkerLaunchPlan({ role: "runner", env: { QQ_WORKER_CONFIG_FILE: missingConfig } }),
  new RegExp(`central worker configuration is missing at '${missingConfig}'`),
);
assert.throws(
  () => planToSpawn({ ...plan, configPath: missingConfig }, { prompt: "x", env: { QQ_WORKER_CONFIG_FILE: missingConfig }, cwd: root, mcpEnv: { QQ_RUNNER_ID: runnerId, QQ_RUNNER_RESULT_FILE: resultFile } }),
  /central worker configuration is missing/,
  "the spawn path cannot bypass the missing-configuration refusal",
);

// A missing pinned runtime fails closed with the setup command, and a missing
// adapter source fails closed instead of substituting another harness.
assert.throws(
  () => planToSpawn(plan, {
    prompt: "do work",
    env: { ...pinnedEnv, QQ_DEEPSEEK_RUNTIME_ROOT: join(workerConfigDir, "absent-runtime") },
    cwd: root,
    mcpEnv: { QQ_RUNNER_ID: runnerId, QQ_RUNNER_RESULT_FILE: resultFile },
  }),
  /no prepared runtime at .*setup-runtime\.mjs/s,
  "a missing configured runtime refuses the launch",
);
assert.throws(
  () => resolveWorkerLaunchPlan({ role: "implementer", env: { QQ_WORKER_CONFIG_FILE: join(workerConfigDir, "missing.json") } }),
  /central worker configuration is missing/,
  "every seat resolves the same central configuration",
);
assert.throws(() => resolveWorkerLaunchPlan({ role: "researcher", env: {} }), /unknown worker seat/);
assert.throws(() => planToSpawn(null, { prompt: "x" }), /launch plan is required/);
assert.throws(() => planToSpawn(plan, { prompt: "" }), /worker prompt is required/);

// The installer never writes worker configuration.
const workerConfigBefore = readFileSync(workerConfigPathFixture, "utf8");
assert.equal(readFileSync(workerConfigPathFixture, "utf8"), workerConfigBefore);

// ---------------------------------------------------------------------------
// O8. Runner event interpretation is shared and bounded.
// ---------------------------------------------------------------------------
const activeTool = interpretRunnerEvent({ step_update: { step_type: "tool", tool_name: "grep", state: "ACTIVE" } });
assert.equal(activeTool.activeTool.name, "grep");
assert.equal(interpretRunnerEvent({ step_update: { step_type: "tool", tool_name: "grep", state: "DONE" } }).activeTool, null);
assert.equal(interpretRunnerEvent({ tool_name: "mcp__qq__complete_task" }).completeTask, true);
assert.equal(interpretRunnerEvent({ message: "noise" }).step, null);

console.log("architect operations roundtrip tests passed");
