#!/usr/bin/env node
// Offline acceptance for runner communication (phase 2a of the communication
// integration).
//
// Everything here is hermetic except the explicitly-guarded relay runtime
// section: a fake `pi --mode rpc` binary, temporary change-record state, and
// direct module calls. No provider call, no operator config. What is proven:
//
//   * the communication binding is validated structurally before anything
//     enables (absent = disabled; malformed = `binding-invalid`, never a
//     partial enable; DSH session aliases and model-supplied routing are
//     refused);
//   * the receiver binding is recorded against the EXACT started attempt by
//     reusing `attempt.started.payload.identity`, is idempotent on retry, and
//     a different observed session is a loud mismatch, never a silent rebind;
//   * `attempt.admission_closed` is the smallest change-record addition that
//     makes a late accepted submission impossible: after closure a submission
//     is refused (race-order B), while acknowledgements and outcomes stay
//     recordable, and old-shape records still replay;
//   * the three model-facing tools behave exactly as documented: bounded read
//     with pagination that never silently truncates as complete, deterministic
//     acknowledgement command IDs with idempotent retries and
//     stale/wrong-target/unknown/inaccessible refusals, and progress that is
//     committed FIRST with the push status reported separately;
//   * the adapter enables communication only for a validated runner binding
//     (refusals before any process or provider traffic), records the observed
//     session binding, closes admission before the bounded drain window, and
//     postpones final-result selection until an idle-injected turn settles;
//   * worker isolation scrubs QQ_WORKFLOW_COMMUNICATION and the pi launch
//     re-adds it explicitly;
//   * the owned relay runtime is acquired/released with a private 0700 state
//     dir, bounded readiness, graceful-then-forced release, persistent
//     obligations across restart, stale-socket recovery, and a shared handle
//     that never kills a relay it does not own (SKIPPED when no relay is
//     installed - an honest skip is never a pass).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  COMMUNICATION_BINDING_ENV,
  COMMUNICATION_BINDING_SCHEMA,
  COMMUNICATION_ROLE_PARAGRAPH,
  COMMUNICATION_TOOL_NAMES,
  DEFAULT_DRAIN_MS,
  MAX_DRAIN_MS,
  PI_SESSION_ID_PATTERN,
  PROGRESS_MESSAGE_MAX_CHARS,
  READ_ASSIGNMENT_LIMIT_DEFAULT,
  READ_ASSIGNMENT_LIMIT_MAX,
  RELAY_MESSAGE_KIND,
  assertPiSessionId,
  acquireRelayRuntime,
  bindAttemptReceiver,
  buildProgressEnvelope,
  closeReceiverAdmission,
  inspectAmendment,
  parseCommunicationBinding,
  publishCommittedProgress,
  receiverBindingOf,
  relayRuntimeDir,
  relaySocketPath,
  resolveRelayInstall,
  submitAmendment,
  transportStatusOf,
  validateCommunicationBinding,
} from "../workflow/communication.mjs";
import {
  acknowledgeAssignment,
  readAssignment,
  reportProgress,
} from "../workflow/communication-receiver.mjs";
import { createChange, openChange } from "../workflow/change-record.mjs";
import { buildWorkerLaunch, WORKER_PI_ADAPTER } from "../workflow/worker-config.mjs";
import { ADAPTER_EXIT } from "../workflow/pi-worker/adapter.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const ADAPTER = WORKER_PI_ADAPTER;
const root = mkdtempSync(join(tmpdir(), "qq-worker-communication-"));
chmodSync(root, 0o700);
const stateDir = join(root, "change-state");
mkdirSync(stateDir, { recursive: true, mode: 0o700 });

// The pi binary override is a shim (chmod +x) that runs the shared fake runtime.
const fakePi = join(root, "fake-pi");
writeFileSync(fakePi, `#!/usr/bin/env node\nawait import(${JSON.stringify(join(here, "support", "fake-pi.mjs"))});\n`, "utf8");
spawnSync("chmod", ["+x", fakePi]);

const SESSION_A = "4b70f906-1111-4222-8333-444455556666";
const SESSION_B = "4b70f906-aaaa-4bbb-8ccc-ddddeeeeffff";
const CHANGE_ID = "comm-offline-1";
const JOB_ID = "job-1";
const JOB2_ID = "job-2";
const RUNTIME_ACTOR_ID = "comm-offline-runtime";
const runtimeActor = { kind: "runtime", id: RUNTIME_ACTOR_ID };

function bindingOf(overrides = {}) {
  return {
    schema: COMMUNICATION_BINDING_SCHEMA,
    stateDir,
    changeId: CHANGE_ID,
    jobId: JOB_ID,
    attemptId: "attempt-1",
    actorId: "worker-attempt-1",
    runtimeActorId: RUNTIME_ACTOR_ID,
    role: "runner",
    recipientAgent: `agents/${SESSION_A}`,
    socketPath: join(root, "relay", "qq-relay.sock"),
    ...overrides,
  };
}

function writeConfig(name, extra = {}) {
  const file = join(root, `worker-config-${name}.json`);
  writeFileSync(file, `${JSON.stringify({
    harness: "pi",
    provider: "meta",
    model: "muse-spark-1.3-contributor",
    env_key: "MODEL_API_KEY",
    context: { enabled: true, reserve_tokens: 16_384, keep_recent_tokens: 20_000 },
    ...extra,
  }, null, 2)}\n`, "utf8");
  return file;
}

function adapterEnv({ configFile, name, extra = {} }) {
  return {
    ...process.env,
    HOME: root,
    XDG_STATE_HOME: join(root, "state"),
    QQ_WORKER_CONFIG_FILE: configFile,
    QQ_WORKER_PI_BIN: fakePi,
    QQ_WORKER_PI_AGENT_DIR: join(root, `agent-${name}`),
    MODEL_API_KEY: "test-key-not-a-real-secret",
    [COMMUNICATION_BINDING_ENV]: undefined, // never inherited: explicit per run
    ...extra,
  };
}

function runAdapter({ args, env, timeout = 40_000 }) {
  return spawnSync(process.execPath, [ADAPTER, ...args], {
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
    timeout,
  });
}

function parseEvents(stdout) {
  return stdout.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

const results = [];
const pass = (name) => { results.push(name); console.log(`PASS  ${name}`); };
// Refusals carry a stable `code` property; assert the code, not prose.
const assertCode = (fn, code, message) => assert.throws(fn, (error) => error?.code === code, `${message} (expected code '${code}')`);
const assertRejectsCode = (fn, code, message) => assert.rejects(fn, (error) => error?.code === code, `${message} (expected code '${code}')`);

// A change record with one runner job whose revision 1 assignment is the given
// text, plus a launched attempt ready to be bound (and a second job for the
// wrong-target refusal cases).
function seedChange({ assignmentText = "Revision one assignment. ".repeat(4) } = {}) {
  createChange({ stateDir, changeId: CHANGE_ID, actor: runtimeActor, title: "communication offline fixture" });
  const handle = openChange({ stateDir, changeId: CHANGE_ID });
  handle.append("assignment.revised", {
    revision: 1,
    predecessor: null,
    scope: { kind: "change" },
    assignment: { instructions: assignmentText },
  }, { context: { actor: runtimeActor } });
  handle.append("job.registered", { role: "runner", pinnedRevision: 1 }, { context: { actor: runtimeActor, jobId: JOB_ID } });
  handle.append("job.registered", { role: "runner", pinnedRevision: 1 }, { context: { actor: runtimeActor, jobId: JOB2_ID } });
  for (const jobId of [JOB_ID, JOB2_ID]) {
    handle.append("attempt.launch_intent", { note: "offline fixture" }, { context: { actor: runtimeActor, jobId, attemptId: "attempt-1" } });
  }
  // A dedicated attempt for the record-integration tests, so attempt-1 stays
  // an unbound launch intent for the adapter tests.
  handle.append("attempt.launch_intent", { note: "record-integration fixture" }, { context: { actor: runtimeActor, jobId: JOB_ID, attemptId: "attempt-rec" } });
  return handle;
}

function crHandle() {
  return openChange({ stateDir, changeId: CHANGE_ID });
}

function crAppend(kind, payload, { context = {}, commandId, actor = runtimeActor } = {}) {
  return crHandle().append(kind, payload, { context: { actor, ...context }, commandId });
}
const workerActor = { kind: "worker", id: "worker-attempt-rec" };

// Availability checks for the relay-dependent section: an honest skip is never
// a pass.
function resolveRelayRoot() {
  const configured = process.env.QQ_RELAY_INSTALL_ROOT;
  if (configured && configured.startsWith("/")) {
    return existsSync(join(configured, "client.mjs")) && existsSync(join(configured, "bin", "qq-relay")) ? configured : null;
  }
  const home = process.env.HOME;
  if (!home) return null;
  const candidate = join(home, ".local", "lib", "qq", "relay");
  return existsSync(join(candidate, "client.mjs")) && existsSync(join(candidate, "bin", "qq-relay")) ? candidate : null;
}

const relayRoot = resolveRelayRoot();
const relayEnv = relayRoot ? { ...process.env, QQ_RELAY_INSTALL_ROOT: relayRoot } : null;

try {
  // ==========================================================================
  // PART 1: binding validation (the trusted runner communication context).
  // ==========================================================================
  assert.deepEqual(parseCommunicationBinding({}), { enabled: false }, "an absent binding is disabled, not an error");
  assert.deepEqual(parseCommunicationBinding({ [COMMUNICATION_BINDING_ENV]: "   " }), { enabled: false }, "a blank binding is disabled");
  assert.throws(() => parseCommunicationBinding({ [COMMUNICATION_BINDING_ENV]: "{not json" }), /is not valid JSON/, "malformed JSON refuses");
  assert.throws(() => validateCommunicationBinding([bindingOf()]), /must be a JSON object/, "a non-object binding refuses");
  assert.throws(() => validateCommunicationBinding({ ...bindingOf(), surprise: 1 }), /field 'surprise' is not part of the binding schema/, "unknown fields refuse");
  assert.throws(() => validateCommunicationBinding({ ...bindingOf(), schema: "other/9" }), /schema .* is unknown/, "an unknown schema refuses");
  assert.throws(() => validateCommunicationBinding({ ...bindingOf(), stateDir: "relative/state" }), /must be an absolute path/, "a relative stateDir refuses");
  assert.throws(() => validateCommunicationBinding({ ...bindingOf(), socketPath: "sock.sock" }), /must be an absolute path/, "a relative socketPath refuses");
  assert.throws(() => validateCommunicationBinding({ ...bindingOf(), changeId: "has space" }), /field 'changeId'/, "a malformed changeId refuses");
  assert.throws(() => validateCommunicationBinding({ ...bindingOf(), runtimeActorId: "" }), /field 'runtimeActorId'/, "a malformed runtimeActorId refuses");
  assert.throws(() => validateCommunicationBinding({ ...bindingOf(), role: "architect" }), /field 'role'/, "a non-job role refuses");
  // DSH session aliases are never acceptable routing: the recipient must name
  // a bare Pi session UUID.
  assert.throws(
    () => validateCommunicationBinding({ ...bindingOf(), recipientAgent: `agents/session-${SESSION_A}` }),
    /field 'recipientAgent'/,
    "a DSH-style session alias refuses",
  );
  assert.throws(() => validateCommunicationBinding({ ...bindingOf(), recipientAgent: "agents/not-a-uuid" }), /field 'recipientAgent'/, "a non-UUID recipient refuses");
  assert.throws(() => validateCommunicationBinding({ ...bindingOf(), recipientAgent: SESSION_A }), /field 'recipientAgent'/, "a recipient without the agents/ product refuses");
  assert.throws(() => validateCommunicationBinding({ ...bindingOf(), installRoot: "rel/relay" }), /'installRoot' must be an absolute path/, "a relative installRoot refuses");
  assert.throws(() => validateCommunicationBinding({ ...bindingOf(), drainMs: -1 }), /'drainMs' must be an integer/, "a negative drainMs refuses");
  assert.throws(() => validateCommunicationBinding({ ...bindingOf(), drainMs: MAX_DRAIN_MS + 1 }), /'drainMs' must be an integer/, "an over-bound drainMs refuses");
  assert.throws(() => validateCommunicationBinding({ ...bindingOf(), drainMs: 1.5 }), /'drainMs' must be an integer/, "a fractional drainMs refuses");

  const validated = validateCommunicationBinding(bindingOf());
  assert.equal(validated.drainMs, DEFAULT_DRAIN_MS, "an omitted drainMs defaults to the documented window");
  assert.equal(validated.installRoot, null, "an omitted installRoot resolves from the environment at use time");
  assert.equal(validateCommunicationBinding(bindingOf({ drainMs: 250, installRoot: "/opt/relay" })).drainMs, 250, "an explicit drainMs is honored");
  assert.ok(Object.isFrozen(validated), "the validated binding is frozen");

  // Session identity: bare Pi UUID only, never a DSH alias, never a guess.
  assert.match(SESSION_A, PI_SESSION_ID_PATTERN);
  assert.equal(assertPiSessionId(SESSION_A), SESSION_A, "a bare Pi session UUID is accepted");
  assert.throws(() => assertPiSessionId(`session-${SESSION_A}`), /bare Pi session UUID/, "a DSH-style session id refuses even though a UUID is embedded");
  assert.throws(() => assertPiSessionId("fake-session"), /bare Pi session UUID/, "a placeholder session id refuses");
  assert.throws(() => assertPiSessionId(null), /bare Pi session UUID/, "a missing session id refuses");
  pass("binding validation matrix (disabled default, refusals, defaults, session identity)");

  // ==========================================================================
  // PART 2: record integration - binding, admission closure, race-order B.
  // ==========================================================================
  seedChange();
  const bound = bindAttemptReceiver({
    stateDir, changeId: CHANGE_ID, jobId: JOB_ID, attemptId: "attempt-rec",
    sessionId: SESSION_A, runtimeActorId: RUNTIME_ACTOR_ID,
  });
  assert.equal(bound.recorded, true, "the first binding records attempt.started");
  assert.equal(bound.identity.piSession, SESSION_A);
  assert.equal(bound.identity.recipient, `agents/${SESSION_A}`, "the recipient is derived from the observed session, never supplied");
  assert.deepEqual(
    receiverBindingOf(crHandle().views.attempt(JOB_ID, "attempt-rec")),
    { piSession: SESSION_A, recipient: `agents/${SESSION_A}`, seat: "runner" },
    "the binding is the recorded attempt.started identity",
  );
  const rebound = bindAttemptReceiver({
    stateDir, changeId: CHANGE_ID, jobId: JOB_ID, attemptId: "attempt-rec",
    sessionId: SESSION_A, runtimeActorId: RUNTIME_ACTOR_ID,
  });
  assert.equal(rebound.dedupe, true, "a retry with the same observed session is a record dedupe");
  assert.throws(
    () => bindAttemptReceiver({
      stateDir, changeId: CHANGE_ID, jobId: JOB_ID, attemptId: "attempt-rec",
      sessionId: SESSION_B, runtimeActorId: RUNTIME_ACTOR_ID,
    }),
    (error) => error?.code === "binding-mismatch",
    "a different observed session for a started attempt is a loud mismatch, never a silent rebind",
  );
  assert.throws(
    () => bindAttemptReceiver({
      stateDir, changeId: CHANGE_ID, jobId: JOB_ID, attemptId: "attempt-rec",
      sessionId: `session-${SESSION_B}`, runtimeActorId: RUNTIME_ACTOR_ID,
    }),
    /bare Pi session UUID/,
    "a DSH alias is refused as an observed session",
  );
  assert.throws(
    () => bindAttemptReceiver({
      stateDir, changeId: CHANGE_ID, jobId: JOB_ID, attemptId: "nope",
      sessionId: SESSION_B, runtimeActorId: RUNTIME_ACTOR_ID,
    }),
    (error) => error?.code === "not-found",
    "binding names an attempt that does not exist refuses",
  );
  pass("receiver binding against the exact started attempt (idempotent, mismatch-refusing)");

  const closed = closeReceiverAdmission({
    stateDir, changeId: CHANGE_ID, jobId: JOB_ID, attemptId: "attempt-rec", runtimeActorId: RUNTIME_ACTOR_ID,
  });
  assert.equal(closed.committed, true, "admission closure commits");
  assert.equal(closed.dedupe, false, "the first closure is not a dedupe");
  const reclosed = closeReceiverAdmission({
    stateDir, changeId: CHANGE_ID, jobId: JOB_ID, attemptId: "attempt-rec", runtimeActorId: RUNTIME_ACTOR_ID,
  });
  assert.equal(reclosed.dedupe, true, "admission closure is idempotent");
  assert.equal(reclosed.seq, closed.seq, "the idempotent closure reports the original seq");
  assert.ok(crHandle().views.attempt(JOB_ID, "attempt-rec").admissionClosed, "the attempt view projects admissionClosed");

  // Race-order B: a submission that loses the race to the closure is REFUSED -
  // it can never disappear as a successful delivery. The revision content the
  // caller authored stays in the record (assignment.revised committed), but no
  // amendment was admitted for delivery on the closed attempt.
  const refused = await submitAmendment({
    stateDir, changeId: CHANGE_ID, jobId: JOB_ID, attemptId: "attempt-rec",
    instructions: "Too late for this attempt.", amendmentId: "amend-late-1",
    actor: runtimeActor,
  });
  assert.equal(refused.ok, false, "a submission after closure is refused");
  assert.equal(refused.code, "refused", "the refusal is the explicit refused code, not an exception");
  // The closure was already visible before any record append, so nothing was
  // authored: no revision, no amendment id. (The concurrent race window - a
  // closure committing between the pre-check and the submission append - is
  // exercised by the concurrent-actor race test below, where the record
  // refuses the submission append itself.)
  assert.equal(refused.revision, null, "a pre-checked closed admission authors nothing");
  assert.equal(refused.amendmentId, null, "a pre-checked closed admission authors nothing");
  assert.equal(crHandle().views.job(JOB_ID).pendingAmendments.length, 0, "no amendment is pending for the closed attempt");
  await assertRejectsCode(
    () => inspectAmendment({ stateDir, changeId: CHANGE_ID, jobId: JOB_ID, amendmentId: "amend-late-1" }),
    "not-found",
    "a refused submission left no inspectable amendment",
  );

  // Work the attempt already finished stays recordable after closure.
  crAppend("worker.acknowledged", { revision: 1, note: "acknowledged revision 1" }, { context: { jobId: JOB_ID, attemptId: "attempt-rec" }, commandId: "ack-rev1", actor: workerActor });
  crAppend("attempt.outcome", { summary: "done", result: { ok: true }, status: "completed" }, { context: { jobId: JOB_ID, attemptId: "attempt-rec" } });
  const afterOutcome = crHandle().views.attempt(JOB_ID, "attempt-rec");
  assert.equal(afterOutcome.phase, "terminal", "the outcome still records after closure");
  assert.equal(afterOutcome.acknowledgements.length, 1, "the acknowledgement still records after closure");
  pass("admission closure: idempotent, refuses late submissions, keeps acks/outcomes recordable (race-order B)");

  // ==========================================================================
  // PART 3: the three model-facing tools (offline; push failures are honest).
  // ==========================================================================
  // A fresh job with a LONG assignment for pagination and its own attempt.
  const longText = "L".repeat(READ_ASSIGNMENT_LIMIT_DEFAULT + 40);
  crAppend("assignment.revised", { revision: 2, predecessor: 1, scope: { kind: "job", jobId: JOB2_ID }, assignment: { instructions: longText } }, { context: { jobId: JOB2_ID } });
  crAppend("assignment.revised", { revision: 3, predecessor: 2, scope: { kind: "job", jobId: JOB_ID }, assignment: { instructions: "Job one scoped revision three." } }, { context: { jobId: JOB_ID } });
  const attempt2 = bindAttemptReceiver({
    stateDir, changeId: CHANGE_ID, jobId: JOB2_ID, attemptId: "attempt-1",
    sessionId: SESSION_B, runtimeActorId: RUNTIME_ACTOR_ID,
  });
  assert.equal(attempt2.recorded, true, "the second job's attempt binds independently");
  const toolsCtx = { stateDir, changeId: CHANGE_ID, jobId: JOB2_ID, attemptId: "attempt-1", actorId: "worker-job2-attempt-1" };

  // readAssignment: bounded view, pagination, honest completeness.
  const page0 = readAssignment(toolsCtx, {});
  assert.equal(page0.details.status, "ok");
  assert.equal(page0.details.revision, 2, "the effective revision is the job-scoped revision 2");
  assert.equal(page0.details.offset, 0);
  assert.equal(page0.details.nextOffset, READ_ASSIGNMENT_LIMIT_DEFAULT, "the default limit pages a long assignment");
  assert.equal(page0.details.complete, false, "a paginated read is never reported complete");
  const page1 = readAssignment(toolsCtx, { offset: page0.details.nextOffset });
  assert.equal(page1.details.nextOffset, null, "the second page ends the text");
  assert.equal(page1.details.complete, true, "the final page with a complete entry is complete");
  assert.ok(page0.content[0].text.includes(`[nextOffset: ${READ_ASSIGNMENT_LIMIT_DEFAULT}]`), "the text carries the pagination markers");
  assert.ok(page0.content[0].text.includes("[pending updates: none]"), "the first offset reports pending state explicitly");
  assert.match(readAssignment(toolsCtx, { limit: 0 }).content[0].text, /refused/, "limit 0 refuses");
  assert.match(readAssignment(toolsCtx, { limit: READ_ASSIGNMENT_LIMIT_MAX + 1 }).content[0].text, /refused/, "limit above the cap refuses");
  assert.match(readAssignment(toolsCtx, { limit: 1.5 }).content[0].text, /refused/, "a fractional limit refuses");
  assert.match(readAssignment(toolsCtx, { offset: -1 }).content[0].text, /refused/, "a negative offset refuses");
  assert.match(readAssignment(toolsCtx, { revision: 0 }).content[0].text, /refused/, "revision 0 refuses");
  assert.match(readAssignment(toolsCtx, { revision: 99 }).content[0].text, /refused/, "an unknown revision refuses");
  assert.match(
    readAssignment({ ...toolsCtx, jobId: JOB_ID, attemptId: "attempt-1" }, { revision: 2 }).content[0].text,
    /not this job/,
    "a revision scoped to another job is out of scope for this attempt",
  );
  pass("workflow_read_assignment: bounded view, pagination, honest completeness, scope and range refusals");

  // acknowledgeAssignment: deterministic command IDs, idempotent retries,
  // stale/unknown/inaccessible refusals.
  const noRevision = acknowledgeAssignment(toolsCtx, {});
  assert.match(noRevision.content[0].text, /refused/, "a missing revision refuses");
  const zeroRevision = acknowledgeAssignment(toolsCtx, { revision: 0 });
  assert.match(zeroRevision.content[0].text, /refused/, "revision 0 refuses");
  const launchAck = acknowledgeAssignment(toolsCtx, { revision: 2 });
  assert.equal(launchAck.details.status, "ok");
  assert.equal(launchAck.details.commandId, "ack-rev2", "the launch-revision acknowledgement uses the documented command ID");
  assert.equal(launchAck.details.launchRevisionAcknowledgement, true);
  assert.equal(launchAck.details.dedupe, false);
  const launchAckRetry = acknowledgeAssignment(toolsCtx, { revision: 2 });
  assert.equal(launchAckRetry.details.dedupe, true, "an identical acknowledgement retry is a record dedupe");
  assert.equal(launchAckRetry.details.commandId, "ack-rev2", "the retry resolves the same command ID");
  pass("workflow_acknowledge_assignment: launch-revision acknowledgement with idempotent retries");

  // Pending refs ride along, capped, only for THIS attempt.
  for (let index = 0; index < 9; index += 1) {
    const submitted = await submitAmendment({
      stateDir, changeId: CHANGE_ID, jobId: JOB2_ID, attemptId: "attempt-1",
      instructions: `Amendment ${index} for job 2.`, amendmentId: `amend-job2-${index}`,
      actor: runtimeActor,
    });
    assert.equal(submitted.ok, true, `amendment ${index} submitted (recorded; delivery unavailable offline)`);
    assert.equal(submitted.delivery.status, "unavailable", "no relay was supplied, so the push is honestly unavailable");
  }
  const withPending = readAssignment(toolsCtx, {});
  assert.equal(withPending.details.pendingUpdates.length, 8, "pending refs are capped at the documented maximum");
  assert.deepEqual(
    withPending.details.pendingUpdates[0],
    { amendmentId: "amend-job2-0", revision: 4 },
    "pending refs are in submission order with their revisions",
  );
  assert.ok(withPending.content[0].text.includes("amendment amend-job2-0 revision 4"), "the text names the pending updates");
  pass("workflow_read_assignment: pending update refs for this attempt, capped and ordered");

  const amendment = await submitAmendment({
    stateDir, changeId: CHANGE_ID, jobId: JOB2_ID, attemptId: "attempt-1",
    instructions: "Revision for the targeted acknowledgement.", amendmentId: "amend-targeted-1",
    actor: runtimeActor,
  });
  assert.equal(amendment.ok, true);
  const targetedRevision = amendment.revision;
  const preAck = readAssignment(toolsCtx, { revision: targetedRevision });
  assert.equal(preAck.details.status, "ok", "the worker can read the exact amended revision");
  const ack = acknowledgeAssignment(toolsCtx, { revision: targetedRevision });
  assert.equal(ack.details.status, "ok");
  assert.equal(ack.details.commandId, `ack-amend-targeted-1-rev${targetedRevision}`, "a targeted amendment acknowledgement uses the documented command ID");
  assert.equal(ack.details.launchRevisionAcknowledgement, false);
  assert.equal(ack.details.amendment.acknowledged !== null, true, "the amendment is fulfilled by the acknowledgement");
  const ackRetry = acknowledgeAssignment(toolsCtx, { revision: targetedRevision });
  assert.equal(ackRetry.details.dedupe, true, "the acknowledgement retry dedupes");
  assert.equal(ackRetry.details.commandId, ack.details.commandId, "the retry resolves the identical command ID");
  pass("workflow_acknowledge_assignment: targeted amendment acknowledgement fulfills the amendment, retry idempotent");

  // Refusals: stale, unknown, and an attempt without an observed start.
  assert.match(
    acknowledgeAssignment({ ...toolsCtx, attemptId: "attempt-1", jobId: JOB2_ID }, { revision: targetedRevision + 5 }).content[0].text,
    /refused/,
    "an unknown revision refuses",
  );
  // A stale revision for THIS attempt: stage a started attempt on job 2 with
  // no acknowledgements and no targeted amendments; revision 1 applies to it
  // but the job's effective revision is far ahead by now.
  crAppend("attempt.launch_intent", { note: "staleness fixture" }, { context: { jobId: JOB2_ID, attemptId: "attempt-stale" } });
  crAppend("attempt.started", { identity: { seat: "runner", piSession: SESSION_B, recipient: `agents/${SESSION_B}` } }, { context: { jobId: JOB2_ID, attemptId: "attempt-stale" } });
  const stale = acknowledgeAssignment(
    { stateDir, changeId: CHANGE_ID, jobId: JOB2_ID, attemptId: "attempt-stale", actorId: "worker-attempt-stale" },
    { revision: 1 },
  );
  assert.match(stale.content[0].text, /stale/, "a revision that is neither effective, targeted, nor acknowledged refuses as stale");
  assert.match(
    acknowledgeAssignment({ stateDir, changeId: CHANGE_ID, jobId: JOB2_ID, attemptId: "attempt-1", actorId: "worker-job2-attempt-1" }, { revision: 3 }).content[0].text,
    /not this job/,
    "an inaccessible (other-job) revision refuses",
  );
  crAppend("attempt.launch_intent", { note: "never started" }, { context: { jobId: JOB2_ID, attemptId: "attempt-2" } });
  assert.match(
    acknowledgeAssignment({ ...toolsCtx, attemptId: "attempt-2" }, { revision: 2 }).content[0].text,
    /refused/,
    "an acknowledgement requires a started attempt",
  );
  pass("workflow_acknowledge_assignment: stale, unknown, inaccessible, and unstarted refusals");

  // reportProgress: kind/message validation, commit FIRST, push separately.
  const progressBinding = bindingOf({ jobId: JOB2_ID, attemptId: "attempt-1", actorId: "worker-job2-attempt-1" });
  const progressCtx = { binding: progressBinding, getClient: async () => { throw new Error("no transport offline"); }, currentRef: () => null };
  assert.match((await reportProgress(progressCtx, { kind: "status", message: "x" })).content[0].text, /refused/, "an unknown kind refuses");
  assert.match((await reportProgress(progressCtx, { kind: "progress", message: "" })).content[0].text, /refused/, "an empty message refuses");
  assert.match((await reportProgress(progressCtx, { kind: "progress", message: "x".repeat(PROGRESS_MESSAGE_MAX_CHARS + 1) })).content[0].text, /refused/, "an over-length message refuses");
  assert.match((await reportProgress(progressCtx, { kind: "progress", message: "bad\0text" })).content[0].text, /refused/, "a NUL-bearing message refuses");
  const progress1 = await reportProgress(progressCtx, { kind: "progress", message: "Implemented the parser; tests pending." });
  assert.equal(progress1.details.status, "ok", "the progress report itself succeeds");
  assert.equal(typeof progress1.details.committed.seq, "number", "the committed sequence is returned");
  assert.equal(progress1.details.push.status, "unavailable", "an unusable transport is an unavailable push, never a fabricated delivery");
  assert.match(progress1.details.push.reason, /session not registered/, "the unregistered-session reason is explicit");
  const blocker1 = await reportProgress(progressCtx, { kind: "blocker", message: "Need a decision on the schema." });
  assert.equal(blocker1.details.committed.kind, "blocker");
  const progressEnvelope = buildProgressEnvelope({
    stateDir, changeId: CHANGE_ID, jobId: JOB2_ID, attemptId: "attempt-1", seq: progress1.details.committed.seq,
  });
  assert.equal(progressEnvelope.text, "Implemented the parser; tests pending.", "the envelope body is the committed message verbatim");
  assert.equal(progressEnvelope.kind, "worker.progress");
  assert.ok(progressEnvelope.tasks.includes(`progress:${progress1.details.committed.seq}`), "structured metadata rides in the tasks");
  assert.ok(progressEnvelope.tasks.includes(`job:${JOB2_ID}`));
  const blockerEnvelope = buildProgressEnvelope({
    stateDir, changeId: CHANGE_ID, jobId: JOB2_ID, attemptId: "attempt-1", seq: blocker1.details.committed.seq,
  });
  assert.equal(blockerEnvelope.kind, "worker.blocker");
  assert.equal(blockerEnvelope.text, "Need a decision on the schema.");
  assert.throws(
    () => buildProgressEnvelope({ stateDir, changeId: CHANGE_ID, jobId: JOB2_ID, attemptId: "attempt-1", seq: 999_999 }),
    (error) => error?.code === "not-found",
    "a sequence that was never committed cannot be published (no phantom progress)",
  );
  pass("workflow_report_progress: commit-first with an honest separate push status; envelope from committed truth only");

  // ==========================================================================
  // PART 4: the adapter - validated enable, refusals, and the drain handshake.
  // ==========================================================================
  const configFile = writeConfig("comm");
  const runnerEnvBase = adapterEnv({ configFile, name: "comm-runner" });
  const runnerId = "comm-offline-runner";
  const runnerArgs = ["--production", "--seat", "runner", "--cwd", root, "--prompt", "do the work"];

  // No binding: the exact prior behavior, unchanged.
  {
    const summaryFile = join(root, "summary-nobinding.json");
    const result = runAdapter({
      args: [...runnerArgs, "--summary-file", summaryFile],
      env: { ...runnerEnvBase, QQ_RUNNER_ID: runnerId, QQ_RUNNER_RESULT_FILE: join(tmpdir(), `comm-result-nobinding.json`) },
    });
    assert.equal(result.status, ADAPTER_EXIT.ok, result.stderr);
    const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
    assert.deepEqual(summary.communication, { enabled: false }, "an absent binding disables communication");
    assert.ok(!summary.allowedTools.some((tool) => tool.startsWith("workflow_")), "no communication tools are exposed without a binding");
    assert.ok(!summary.piArgs.some((arg) => typeof arg === "string" && arg.includes(COMMUNICATION_ROLE_PARAGRAPH.slice(0, 40))), "no communication paragraph without a binding");
  }
  pass("adapter: an absent binding preserves the exact prior behavior");

  // A valid binding for a launched attempt: bound, closed, drained, tools and
  // paragraph present.
  {
    const summaryFile = join(root, "summary-bound.json");
    const binding = bindingOf({ drainMs: 400 });
    const result = runAdapter({
      args: [...runnerArgs, "--summary-file", summaryFile],
      env: {
        ...runnerEnvBase,
        QQ_RUNNER_ID: runnerId,
        QQ_RUNNER_RESULT_FILE: join(tmpdir(), "comm-result-bound.json"),
        QQ_FAKE_PI_SESSION_ID: SESSION_A,
        [COMMUNICATION_BINDING_ENV]: JSON.stringify(binding),
      },
    });
    assert.equal(result.status, ADAPTER_EXIT.ok, result.stderr);
    const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
    assert.equal(summary.communication.enabled, true);
    assert.equal(summary.communication.changeId, CHANGE_ID);
    assert.equal(summary.communication.jobId, JOB_ID);
    assert.equal(summary.communication.attemptId, "attempt-1");
    assert.equal(summary.communication.recipientAgent, `agents/${SESSION_A}`);
    assert.equal(summary.communication.drainMs, 400);
    assert.equal(summary.communication.bound.recorded, true, "the observed session was bound against the exact attempt");
    assert.equal(summary.communication.bound.recipient, `agents/${SESSION_A}`);
    assert.equal(typeof summary.communication.admissionClosed.seq, "number", "admission was closed after the first settle");
    assert.ok(summary.communication.drain, "a drain report exists");
    assert.equal(summary.communication.drain.injectedTurns, 0, "no injection happened without a receiver delivery");
    for (const tool of COMMUNICATION_TOOL_NAMES) {
      assert.ok(summary.allowedTools.includes(tool), `the communication tool ${tool} is exposed on a bound runner`);
    }
    assert.equal(summary.instructions.communicationRoleParagraph, true, "the role paragraph flag is recorded");
    assert.ok(summary.piArgs.some((arg) => typeof arg === "string" && arg.includes(COMMUNICATION_ROLE_PARAGRAPH)), "the coordinator-authored paragraph reaches the runtime verbatim");
    const attemptView = crHandle().views.attempt(JOB_ID, "attempt-1");
    assert.equal(attemptView.started.identity.piSession, SESSION_A, "the record bound the fake runtime's observed session");
    assert.equal(attemptView.started.identity.recipient, `agents/${SESSION_A}`, "the recorded recipient is derived, never supplied");
    assert.equal(summary.communication.bound.dedupe, false, "the first binding of this attempt is a fresh record, not a dedupe");
  }
  pass("adapter: a validated binding enables tools + paragraph, binds the observed session, closes admission, drains");

  // A malformed binding refuses before any process traffic (exit 2, never a
  // partial enable).
  {
    const summaryFile = join(root, "summary-badbinding.json");
    const result = runAdapter({
      args: [...runnerArgs, "--summary-file", summaryFile],
      env: {
        ...runnerEnvBase,
        QQ_RUNNER_ID: runnerId,
        QQ_RUNNER_RESULT_FILE: join(tmpdir(), "comm-result-badbinding.json"),
        [COMMUNICATION_BINDING_ENV]: "{not json",
      },
    });
    assert.equal(result.status, ADAPTER_EXIT.refused, "a malformed binding refuses with exit 2");
    const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
    assert.equal(summary.code, "binding-invalid", "the refusal names the binding failure");
  }
  pass("adapter: a malformed binding is an exit-2 refusal, never a partial enable");


  // Seat refusal: a binding is only valid for the runner seat.
  {
    const summaryFile = join(root, "summary-seat.json");
    const result = runAdapter({
      args: ["--production", "--seat", "implementer", "--cwd", root, "--prompt", "x", "--summary-file", summaryFile],
      env: {
        ...runnerEnvBase,
        [COMMUNICATION_BINDING_ENV]: JSON.stringify(bindingOf()),
      },
    });
    assert.equal(result.status, ADAPTER_EXIT.refused, "a binding on a non-runner seat refuses with exit 2");
    const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
    assert.equal(summary.code, "binding_invalid_seat", "the refusal names the seat violation");
  }
  pass("adapter: a binding on a seat other than the runner refuses before any process is spawned");

  // Unknown attempt and non-launchable phase refusals (record-side preflight,
  // still before any provider traffic).
  {
    const summaryFile = join(root, "summary-ghost.json");
    const result = runAdapter({
      args: [...runnerArgs, "--summary-file", summaryFile],
      env: {
        ...runnerEnvBase,
        QQ_RUNNER_ID: runnerId,
        QQ_RUNNER_RESULT_FILE: join(tmpdir(), "comm-result-ghost.json"),
        [COMMUNICATION_BINDING_ENV]: JSON.stringify(bindingOf({ attemptId: "attempt-ghost" })),
      },
    });
    assert.equal(result.status, ADAPTER_EXIT.refused, "a binding naming an unknown attempt refuses with exit 2");
    const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
    assert.equal(summary.code, "binding_attempt_unknown");
  }
  {
    // A terminal attempt can no longer be started, so it cannot be bound.
    crAppend("attempt.launch_intent", { note: "terminal fixture" }, { context: { jobId: JOB_ID, attemptId: "attempt-term" } });
    crAppend("attempt.started", { identity: { seat: "runner", piSession: SESSION_B, recipient: `agents/${SESSION_B}` } }, { context: { jobId: JOB_ID, attemptId: "attempt-term" } });
    crAppend("attempt.outcome", { summary: "done", result: { ok: true }, status: "completed" }, { context: { jobId: JOB_ID, attemptId: "attempt-term" } });
    const summaryFile = join(root, "summary-terminal.json");
    const result = runAdapter({
      args: [...runnerArgs, "--summary-file", summaryFile],
      env: {
        ...runnerEnvBase,
        QQ_RUNNER_ID: runnerId,
        QQ_RUNNER_RESULT_FILE: join(tmpdir(), "comm-result-terminal.json"),
        [COMMUNICATION_BINDING_ENV]: JSON.stringify(bindingOf({ attemptId: "attempt-term" })),
      },
    });
    assert.equal(result.status, ADAPTER_EXIT.refused, "a binding naming a terminal attempt refuses with exit 2");
    const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
    assert.equal(summary.code, "binding_attempt_not_launchable");
  }
  {
    // A binding whose recorded session does not match the observed runtime
    // session refuses loudly (never a silent rebind, never partial enable).
    const summaryFile = join(root, "summary-mismatch.json");
    const result = runAdapter({
      args: [...runnerArgs, "--summary-file", summaryFile],
      env: {
        ...runnerEnvBase,
        QQ_RUNNER_ID: runnerId,
        QQ_RUNNER_RESULT_FILE: join(tmpdir(), "comm-result-mismatch.json"),
        // JOB2's attempt is recorded with SESSION_B; observing SESSION_A must
        // refuse, never silently rebind.
        QQ_FAKE_PI_SESSION_ID: SESSION_A,
        [COMMUNICATION_BINDING_ENV]: JSON.stringify(bindingOf({ jobId: JOB2_ID })),
      },
    });
    assert.equal(result.status, ADAPTER_EXIT.refused, "a binding/observed-session mismatch refuses with exit 2");
    const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
    assert.equal(summary.code, "binding-mismatch");
  }
  pass("adapter: unknown, terminal, and mismatched bindings all refuse before inference");

  // Idle injection during the drain: final-result selection is postponed until
  // the injected turn settles, so the post-update answer is the outcome.
  {
    const summaryFile = join(root, "summary-inject.json");
    const result = runAdapter({
      args: [...runnerArgs, "--summary-file", summaryFile],
      env: {
        ...runnerEnvBase,
        QQ_RUNNER_ID: runnerId,
        QQ_RUNNER_RESULT_FILE: join(tmpdir(), "comm-result-inject.json"),
        QQ_FAKE_PI_SESSION_ID: SESSION_A,
        QQ_FAKE_PI_ANSWER: "FIRST-ANSWER",
        QQ_FAKE_PI_SECOND_ANSWER: "UPDATED-ANSWER",
        QQ_FAKE_PI_INJECT_TURN_DELAY_MS: "150",
        [COMMUNICATION_BINDING_ENV]: JSON.stringify(bindingOf({ drainMs: 4000 })),
      },
    });
    assert.equal(result.status, ADAPTER_EXIT.ok, result.stderr);
    const events = parseEvents(result.stdout);
    const finals = events.filter((event) => event.type === "item.completed" && event.item?.type === "agent_message");
    assert.equal(finals.at(-1)?.item.text, "UPDATED-ANSWER", "the post-update answer, not the stale pre-injection text, is the outcome");
    const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
    assert.equal(summary.communication.drain.injectedTurns, 1, "the drain observed exactly one injected turn");
    assert.equal(summary.outcome, "completed");
  }
  pass("adapter: an idle injection postpones final-result selection until that turn settles");

  // A drain window that ends while an injected turn is in flight refuses
  // honestly instead of reporting the stale text as success.
  {
    const summaryFile = join(root, "summary-draincut.json");
    const result = runAdapter({
      args: [...runnerArgs, "--summary-file", summaryFile],
      env: {
        ...runnerEnvBase,
        QQ_RUNNER_ID: runnerId,
        QQ_RUNNER_RESULT_FILE: join(tmpdir(), "comm-result-draincut.json"),
        QQ_FAKE_PI_SESSION_ID: SESSION_A,
        QQ_FAKE_PI_ANSWER: "FIRST-ANSWER",
        QQ_FAKE_PI_INJECT_TURN_DELAY_MS: "120",
        QQ_FAKE_PI_INJECT_TURN_SETTLES: "false",
        [COMMUNICATION_BINDING_ENV]: JSON.stringify(bindingOf({ drainMs: 500 })),
      },
    });
    assert.equal(result.status, ADAPTER_EXIT.failed, "a cut-off injected turn is a failure, never a stale success");
    const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
    assert.equal(summary.outcome, "drain_turn_interrupted", "the outcome names the interrupted drain turn");
    assert.equal(summary.communication.drain.interruptedTurn, true, "the drain report is honest about the interruption");
  }
  pass("adapter: a drain window that ends mid-injected-turn fails honestly; the amendment stays pending");

  // ==========================================================================
  // PART 5: worker isolation scrubs the binding; the pi launch re-adds it.
  // ==========================================================================
  {
    const bindingJson = JSON.stringify(bindingOf());
    const envWithBinding = { ...process.env, [COMMUNICATION_BINDING_ENV]: bindingJson };
    // A codex-harness launch must never carry the binding.
    const codexConfig = writeConfig("codex", { harness: "codex" });
    const codexLaunch = buildWorkerLaunch({ seat: "implementer", cwd: root, prompt: "x", env: { ...envWithBinding, QQ_WORKER_CONFIG_FILE: codexConfig } });
    assert.equal(codexLaunch.env[COMMUNICATION_BINDING_ENV], undefined, "a non-pi launch never carries the binding");
    // A pi launch re-adds it explicitly for the runner.
    const piLaunch = buildWorkerLaunch({
      seat: "runner",
      cwd: root,
      prompt: "x",
      env: { ...envWithBinding, QQ_WORKER_CONFIG_FILE: configFile },
      mcpEnv: { QQ_RUNNER_ID: runnerId, QQ_RUNNER_RESULT_FILE: join(tmpdir(), "comm-result-launch.json") },
    });
    assert.equal(piLaunch.harness, "pi");
    assert.equal(piLaunch.env[COMMUNICATION_BINDING_ENV], bindingJson, "the pi runner launch re-adds the exact binding");
    // And a pi launch WITHOUT the env carries nothing (nothing is invented).
    const plainLaunch = buildWorkerLaunch({
      seat: "runner",
      cwd: root,
      prompt: "x",
      env: { ...process.env, QQ_WORKER_CONFIG_FILE: configFile },
      mcpEnv: { QQ_RUNNER_ID: runnerId, QQ_RUNNER_RESULT_FILE: join(tmpdir(), "comm-result-launch2.json") },
    });
    assert.equal(plainLaunch.env[COMMUNICATION_BINDING_ENV], undefined, "no binding env means no binding, also at the launch layer");
  }
  pass("worker isolation: QQ_WORKFLOW_COMMUNICATION is scrubbed and re-added explicitly by the pi launch");

  // ==========================================================================
  // PART 6+7: the owned relay runtime and the delivery pipeline, against the
  // REAL installed qq-relay when one is present. An honest skip is never a
  // pass.
  // ==========================================================================
  if (!relayRoot) {
    console.log("relay runtime tests SKIPPED: no installed qq-relay (client.mjs + bin/qq-relay); every offline section above still ran.");
  } else {
    assert.deepEqual(resolveRelayInstall(relayEnv).root, relayRoot, "the install root resolves");
    const { RelayClient } = await import(pathToFileURL(join(relayRoot, "client.mjs")).href);

    // Missing install = explicit unavailable, never a silent fallback.
    {
      const missing = await acquireRelayRuntime({ stateDir: join(root, "relay-missing"), env: { ...relayEnv, QQ_RELAY_INSTALL_ROOT: "/nonexistent-qq-relay-root" } });
      assert.equal(missing.ok, false);
      assert.equal(missing.code, "unavailable", "a missing install is the explicit unavailable code");
    }
    pass("relay runtime: a missing install is explicitly unavailable");

    // The sticky private-child fence: a group-writable parent refuses.
    {
      const sharedParent = join(root, "group-writable");
      mkdirSync(sharedParent, { recursive: true });
      chmodSync(sharedParent, 0o770); // chmod, not mkdir mode: umask-proof
      const refused = await acquireRelayRuntime({ stateDir: join(sharedParent, "state"), env: relayEnv });
      assert.equal(refused.ok, false);
      assert.equal(refused.code, "refused", "a group/other-writable parent is the explicit refused code");
      assert.match(refused.reason, /group\/other-writable/);
    }
    pass("relay runtime: a group-writable parent refuses before any child is spawned");

    // Owned lifecycle: acquire, health, refcount, graceful release.
    const ownedState = join(root, "relay-owned");
    mkdirSync(ownedState, { recursive: true, mode: 0o700 });
    const acquired = await acquireRelayRuntime({ stateDir: ownedState, env: relayEnv });
    assert.equal(acquired.ok, true, acquired.reason ?? "relay acquired");
    assert.equal(acquired.shared, false, "a fresh private dir spawns an owned relay");
    const handle = acquired.relay;
    assert.equal(handle.owned, true);
    assert.ok(existsSync(handle.socketPath), "the socket exists once ready");
    assert.equal((await handle.inspect())?.service, "qq-relay", "the relay answers the health view");
    const runtimeDirStat = statSync(relayRuntimeDir(ownedState));
    assert.equal(runtimeDirStat.mode & 0o777, 0o700, "the private runtime dir is 0700");

    const secondAcquire = await acquireRelayRuntime({ stateDir: ownedState, env: relayEnv });
    assert.equal(secondAcquire.shared, false, "the cached owned handle is reused");
    assert.equal(secondAcquire.relay, handle, "acquire is refcounted per state dir");
    assert.equal(handle.refCount, 2, "two holders share the owned handle");
    const sharedRelease = await handle.release();
    assert.equal(sharedRelease.released, false, "one holder does not release the relay");
    assert.equal(handle.refCount, 1);
    pass("relay runtime: acquire is refcounted per state dir");

    // Obligations persist across a full stop/start of the owned relay.
    const submitted = await submitAmendment({
      stateDir, changeId: CHANGE_ID, jobId: JOB2_ID, attemptId: "attempt-1",
      instructions: "Persisted across restart.", amendmentId: "amend-persist-1",
      actor: runtimeActor, relay: handle,
    });
    assert.equal(submitted.ok, true, "the amendment is recorded");
    assert.equal(submitted.delivery.status, "queued", "the relay accepted the pushed update");
    assert.match(submitted.delivery.eventId ?? "", /^evt_/, "the push has a stable relay event id");
    const firstInspection = await inspectAmendment({
      stateDir, changeId: CHANGE_ID, jobId: JOB2_ID, amendmentId: "amend-persist-1",
      relay: handle, eventId: submitted.delivery.eventId,
    });
    assert.deepEqual(
      firstInspection.layers,
      { recorded: true, receiverReceiptObserved: false, workerAcknowledged: false },
      "recorded, receipt, and acknowledgement are distinct facts (queued = recorded only)",
    );
    assert.equal(firstInspection.transport.status, "queued");

    const finalRelease = await handle.release();
    assert.equal(finalRelease.released, true, "the last holder releases the relay");
    assert.equal(finalRelease.forced, false, "a healthy relay exits on SIGTERM within the grace window");
    for (let waited = 0; waited < 5000 && existsSync(handle.socketPath); waited += 50) {
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(existsSync(handle.socketPath), false, "a graceful SIGTERM exit removes the socket");
    assert.throws(() => process.kill(handle.pid, 0), /ESRCH/, "the relay child is reaped");

    const reacquired = await acquireRelayRuntime({ stateDir: ownedState, env: relayEnv });
    assert.equal(reacquired.ok, true, "the relay respawns for the same state dir");
    const handle2 = reacquired.relay;
    assert.equal(handle2.owned, true);
    assert.notEqual(handle2.pid, handle.pid, "a new child process owns the restarted relay");
    const statusAfterRestart = transportStatusOf(
      await (await handle2.client()).status({ event_id: submitted.delivery.eventId, wait_ms: 0 }),
    );
    assert.equal(statusAfterRestart, "queued", "the obligation survives the restart: delivery is still pending");
    pass("relay runtime: graceful release reaps the child; obligations persist across restart");

    // Stale-socket recovery: a SIGKILLed relay leaves the socket behind; the
    // next acquire unlinks it and respawns, and the obligations STILL persist.
    process.kill(handle2.pid, "SIGKILL");
    for (let waited = 0; waited < 5000; waited += 50) {
      let alive = true;
      try { process.kill(handle2.pid, 0); } catch { alive = false; }
      if (!alive) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.ok(existsSync(handle2.socketPath), "SIGKILL leaves the stale socket file behind");
    const afterCrash = await acquireRelayRuntime({ stateDir: ownedState, env: relayEnv });
    assert.equal(afterCrash.ok, true, "a dead socket in our own private dir is unlinked and the relay respawns");
    assert.equal(afterCrash.shared, false);
    const statusAfterCrash = transportStatusOf(
      await (await afterCrash.relay.client()).status({ event_id: submitted.delivery.eventId, wait_ms: 0 }),
    );
    assert.equal(statusAfterCrash, "queued", "the obligation survives even a crash-restart cycle");
    await afterCrash.relay.release();
    pass("relay runtime: stale-socket recovery respawns without losing obligations");

    // A live relay this process did not spawn on our private dir is adopted as
    // a shared handle that NEVER kills it.
    const sharedDir = join(root, "relay-shared");
    const sharedRuntimeDir = join(sharedDir, "relay"); // the relay serves from the runtime dir
    mkdirSync(sharedRuntimeDir, { recursive: true, mode: 0o700 });
    const foreignSocket = relaySocketPath(sharedDir);
    const foreignChild = spawn(join(relayRoot, "bin", "qq-relay"), ["serve", "--state-dir", sharedRuntimeDir], { stdio: ["ignore", "ignore", "ignore"] });
    for (let waited = 0; waited < 10_000 && !existsSync(foreignSocket); waited += 50) {
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.ok(existsSync(foreignSocket), "the foreign relay came up");
    const sharedAcquire = await acquireRelayRuntime({ stateDir: sharedDir, env: relayEnv });
    assert.equal(sharedAcquire.ok, true, "the live foreign relay is adopted");
    assert.equal(sharedAcquire.shared, true, "adoption is explicit: shared, not owned");
    assert.equal(sharedAcquire.relay.owned, false);
    const foreignRelease = await sharedAcquire.relay.release();
    assert.equal(foreignRelease.released, false, "a shared handle never kills the relay it does not own");
    let foreignAlive = true;
    try { process.kill(foreignChild.pid, 0); } catch { foreignAlive = false; }
    assert.equal(foreignAlive, true, "the foreign relay survives the release attempt");
    assert.ok(existsSync(foreignSocket), "the foreign socket survives the release attempt");
    foreignChild.kill("SIGTERM");
    pass("relay runtime: a live foreign relay is a shared handle whose release never kills it");

    // The submission pipeline against the real relay: durable record first,
    // then the queued push; inspection layers stay distinct.
    crAppend("attempt.launch_intent", { note: "relay pipeline fixture" }, { context: { jobId: JOB_ID, attemptId: "attempt-relay" } });
    bindAttemptReceiver({
      stateDir, changeId: CHANGE_ID, jobId: JOB_ID, attemptId: "attempt-relay",
      sessionId: SESSION_A, runtimeActorId: RUNTIME_ACTOR_ID,
    });
    const pipelineState = join(root, "relay-pipeline");
    mkdirSync(pipelineState, { recursive: true, mode: 0o700 });
    const pipeline = await acquireRelayRuntime({ stateDir: pipelineState, env: relayEnv });
    assert.equal(pipeline.ok, true);
    const relayHandle = pipeline.relay;
    const pushed = await submitAmendment({
      stateDir, changeId: CHANGE_ID, jobId: JOB_ID, attemptId: "attempt-relay",
      instructions: "Relay-pushed revision content.", amendmentId: "amend-relay-1",
      actor: runtimeActor, relay: relayHandle,
    });
    assert.equal(pushed.ok, true, "the submission is recorded and pushed");
    assert.equal(pushed.delivery.status, "queued", "the relay accepted the pushed update envelope");
    const pipelineInspection = await inspectAmendment({
      stateDir, changeId: CHANGE_ID, jobId: JOB_ID, amendmentId: "amend-relay-1",
      relay: relayHandle, eventId: pushed.delivery.eventId,
    });
    assert.equal(pipelineInspection.amendment.revision, pushed.revision);
    assert.equal(pipelineInspection.layers.recorded, true);
    assert.equal(pipelineInspection.layers.receiverReceiptObserved, false, "queued is not a receiver receipt");
    assert.equal(pipelineInspection.layers.workerAcknowledged, false, "queued is not an acknowledgement");
    // The pushed record is in the relay journal with the agent.message kind
    // and the bound producer/recipient identity (envelope content itself is
    // proven at the receiver in the live proof).
    const journal = await (await relayHandle.client()).inspect({ view: "journal", limit: 20 });
    const pushedRecord = (journal?.records ?? []).find((entry) => entry.event_id === pushed.delivery.eventId);
    assert.ok(pushedRecord, "the pushed record is inspectable in the journal");
    assert.equal(pushedRecord.kind, RELAY_MESSAGE_KIND);
    assert.equal(pushedRecord.producer_id, `agents/${SESSION_A}`, "the producer is the bound receiver session");
    assert.equal(pushedRecord.recipient_id, `agents/${SESSION_A}`, "the recipient is the binding-derived one, never caller-supplied");
    await relayHandle.release();
    pass("relay pipeline: submitAmendment records durably, pushes with the authored text, and layers stay distinct");

    // Progress publication: a real relay sink pushes the committed entry.
    {
      const committed = crAppend("worker.progress", { note: "Relay-era progress note." }, { context: { jobId: JOB_ID, attemptId: "attempt-relay" }, actor: { kind: "worker", id: "worker-attempt-relay" } });
      const sinkRelay = await acquireRelayRuntime({ stateDir: pipelineState, env: relayEnv });
      assert.equal(sinkRelay.ok, true);
      const published = await publishCommittedProgress({
        stateDir, changeId: CHANGE_ID, jobId: JOB_ID, attemptId: "attempt-relay",
        seq: committed.seq, relay: sinkRelay.relay,
        recipientAgent: `agents/${SESSION_B}`,
      });
      assert.equal(published.ok, true, "publication succeeds");
      assert.equal(published.committed.seq, committed.seq);
      assert.equal(published.push.status, "queued", "the default relay sink pushed the committed entry");
      // A sink failure never erases the commit; a retry can then push it.
      const committed2 = crAppend("worker.progress", { note: "Second committed note." }, { context: { jobId: JOB_ID, attemptId: "attempt-relay" }, actor: { kind: "worker", id: "worker-attempt-relay" } });
      const failed = await publishCommittedProgress({
        stateDir, changeId: CHANGE_ID, jobId: JOB_ID, attemptId: "attempt-relay",
        seq: committed2.seq, sink: async () => { throw new Error("transport exploded"); },
      });
      assert.equal(failed.ok, true, "a sink failure is reported, not thrown away");
      assert.equal(failed.push.status, "unavailable", "the failed push is unavailable");
      assert.match(failed.push.reason, /transport exploded/);
      assert.equal(buildProgressEnvelope({ stateDir, changeId: CHANGE_ID, jobId: JOB_ID, attemptId: "attempt-relay", seq: committed2.seq }).text, "Second committed note.", "the committed entry stays retrievable after a failed push");
      const retried = await publishCommittedProgress({
        stateDir, changeId: CHANGE_ID, jobId: JOB_ID, attemptId: "attempt-relay",
        seq: committed2.seq, sink: async () => ({ state: "queued", eventId: "evt_sink_retry_ok" }),
      });
      assert.equal(retried.push.status, "queued", "the retry pushes the same committed entry");
    }
    pass("progress publication: committed-first with retryable pushes over the real relay and injectable sinks");
  }

  // Old-shape compatibility: an attempt.started without an identity payload
  // (pre-communication record) still replays; delivery admission there is
  // honestly not-bound.
  crAppend("attempt.launch_intent", { note: "pre-communication shape" }, { context: { jobId: JOB2_ID, attemptId: "attempt-noid" } });
  // The pre-communication shape: identity was a plain string, so the new
  // object-based receiver binding cannot exist there - replay stays valid and
  // the binding view is honestly null.
  crAppend("attempt.started", { identity: "legacy-worker-identity" }, { context: { jobId: JOB2_ID, attemptId: "attempt-noid" } });
  assert.equal(receiverBindingOf(crHandle().views.attempt(JOB2_ID, "attempt-noid")), null, "an old-shape started attempt has no receiver binding");
  await assertRejectsCode(
    () => submitAmendment({ stateDir, changeId: CHANGE_ID, jobId: JOB2_ID, attemptId: "attempt-noid", instructions: "x", actor: runtimeActor }),
    "not-bound",
    "delivery admission on an unbound attempt is refused with the explicit not-bound code",
  );
  pass("old-shape records replay unchanged; unbound attempts refuse admission explicitly");

  // Concurrent-actor race: submitters and closers hammering the same attempt
  // from SEPARATE PROCESSES. The record's writer lock serializes them, so the
  // invariant holds exactly: every ACCEPTED amendment.submitted commits before
  // the admission closure, and a submission that loses the race is refused by
  // the reducer itself (never silently delivered, never partially recorded).
  {
    crAppend("attempt.launch_intent", { note: "race fixture" }, { context: { jobId: JOB_ID, attemptId: "attempt-race" } });
    bindAttemptReceiver({
      stateDir, changeId: CHANGE_ID, jobId: JOB_ID, attemptId: "attempt-race",
      sessionId: SESSION_A, runtimeActorId: RUNTIME_ACTOR_ID,
    });
    const raceDir = join(root, "race-out");
    mkdirSync(raceDir, { recursive: true });
    const childSource = `
      const [, , stateDir, changeId, jobId, attemptId, role, amendmentId, outDir] = process.argv;
      const { submitAmendment, closeReceiverAdmission } = await import(${JSON.stringify(join(repoRoot, "workflow", "communication.mjs"))});
      const { writeFileSync } = await import("node:fs");
      const result = { role, amendmentId: amendmentId ?? null, ok: false };
      try {
        if (role === "submit") {
          const r = await submitAmendment({
            stateDir, changeId, jobId, attemptId,
            instructions: \`race amendment \${amendmentId}\`, amendmentId,
            actor: { kind: "runtime", id: "race-submitter" },
          });
          result.accepted = r.ok === true;
          result.code = r.code ?? null;
        } else {
          const r = closeReceiverAdmission({ stateDir, changeId, jobId, attemptId, runtimeActorId: "race-closer" });
          result.committed = r.committed !== false;
          result.dedupe = r.dedupe === true;
        }
        result.ok = true;
      } catch (error) {
        result.error = String(error?.message ?? error).slice(0, 200);
      }
      writeFileSync(\`\${outDir}/\${role}-\${amendmentId ?? "closer"}\${process.pid}.json\`, JSON.stringify(result));
    `;
    const childPath = join(root, "race-child.mjs");
    writeFileSync(childPath, childSource, "utf8");
    const jobs = [];
    for (let index = 0; index < 6; index += 1) {
      jobs.push({ role: "submit", amendmentId: `amend-race-${index}` });
    }
    jobs.push({ role: "close", amendmentId: null }, { role: "close", amendmentId: null });
    await Promise.all(jobs.map(({ role, amendmentId }) => new Promise((done) => {
      const child = spawn(process.execPath, [childPath, stateDir, CHANGE_ID, JOB_ID, "attempt-race", role, amendmentId ?? "x", raceDir], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("exit", (code) => {
        assert.equal(code, 0, `race child ${role}/${amendmentId} exited ${code}: ${stderr.slice(0, 300)}`);
        done();
      });
    })));
    const outcomes = readFileSync(childPath) && readdirSync(raceDir).map((name) => JSON.parse(readFileSync(join(raceDir, name), "utf8")));
    const closures = outcomes.filter((entry) => entry.role === "close");
    assert.equal(closures.length, 2, "both closers reported");
    assert.ok(closures.every((entry) => entry.ok && (entry.committed || entry.dedupe)), "closure succeeds or idempotently dedupes");
    assert.equal(closures.filter((entry) => entry.dedupe).length, 1, "exactly one closer committed; the other deduped");
    // The record is the authority: read the committed events.
    const events = [];
    for (let afterSeq = 0; ;) {
      const page = crHandle().readEvents({ afterSeq, limit: 100 });
      events.push(...page.events);
      if (!page.hasMore) break;
      afterSeq = page.nextAfterSeq;
    }
    const closureEvents = events.filter((entry) => entry.kind === "attempt.admission_closed" && entry.attemptId === "attempt-race");
    assert.equal(closureEvents.length, 1, "exactly one admission closure event is committed");
    const closureSeq = closureEvents[0].seq;
    const submittedEvents = events.filter((entry) => entry.kind === "amendment.submitted" && entry.attemptId === "attempt-race");
    assert.ok(
      submittedEvents.every((entry) => entry.seq < closureSeq),
      "every accepted amendment submission commits BEFORE the admission closure",
    );
    for (const outcome of outcomes.filter((entry) => entry.role === "submit")) {
      const hasEvent = submittedEvents.some((entry) => entry.payload?.amendmentId === outcome.amendmentId);
      assert.equal(hasEvent, outcome.accepted === true, `submitter ${outcome.amendmentId}: acceptance fact and record agree (${outcome.code ?? ""})`);
    }
    assert.ok(submittedEvents.length >= 1, "at least one submission won the race");
  }
  pass("concurrent-actor race: submissions serialize against closure; late ones are refused by the record itself");

  console.log(`\nworker-communication: ${results.length} groups passed.`);
} catch (error) {
  console.error("COMMUNICATION TEST FAILURE:", error?.message ?? error);
  console.error(error?.stack ?? "");
  process.exitCode = 1;
} finally {
  // Release every relay handle this test acquired and reap every child it
  // spawned; a test must never leave a relay service behind.
  try {
    for (const [, cached] of acquireRelayRuntime.cache ?? new Map()) {
      try { await cached.release({ force: true }); } catch { /* already gone */ }
    }
  } catch { /* nothing acquired */ }
}
