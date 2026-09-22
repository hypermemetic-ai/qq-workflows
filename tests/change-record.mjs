#!/usr/bin/env node
// Durable change records: one append-only event log per change with a pure
// reducer, selective views, cross-process append serialization, idempotency,
// and explicit recovery. Offline only — this phase is a dormant foundation
// with no transport, process launching, or Git behavior. Every section here
// demonstrates an invariant (replay/view equivalence, no lost acknowledged
// events, authority gates, the A→B steering regression) rather than
// re-stating implementation logic.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  breakWriterLock,
  createChange,
  FRAME_MAX_BYTES,
  openChange,
  recoverChange,
  reduceEvents,
  TEXT_CHUNK_CHARS,
  viewsFor,
} from "../workflow/change-record.mjs";
import { processFingerprint } from "../workflow/jobs.mjs";
import { tempDir } from "./support/architect-fixtures.mjs";

const MODULE_PATH = fileURLToPath(new URL("../workflow/change-record.mjs", import.meta.url));
const RUNTIME = { kind: "runtime", id: "test-runtime" };
const WORKER = { kind: "worker", id: "test-worker" };
const ctx = (extra = {}) => ({ actor: RUNTIME, ...extra });
const workerCtx = (extra = {}) => ({ actor: WORKER, ...extra });

function assertCode(fn, code, message) {
  assert.throws(fn, (err) => err?.code === code, `${message ?? "call"} must fail with ${code}`);
}

function frameLine(env, { digest = null, lengthDelta = 0 } = {}) {
  const json = JSON.stringify(env);
  const checksum = digest ?? createHash("sha256").update(json).digest("hex");
  return `${Buffer.byteLength(json) + lengthDelta} ${checksum} ${json}\n`;
}

// Raw file surgery helpers: they simulate what crashes and corruption leave
// on disk, from OUTSIDE the module, so recovery behavior is tested against
// reality rather than against the module's own idea of it.
function committedLines(path) {
  const text = readFileSync(path, "utf8");
  assert.ok(text.endsWith("\n"), "surgery helper expects a frame-aligned record");
  return text.slice(0, -1).split("\n");
}

function envelopeOf(line) {
  const prefix = /^([0-9]{1,10}) ([0-9a-f]{64}) /.exec(line);
  assert.ok(prefix, "surgery helper expects framed lines");
  return JSON.parse(line.slice(prefix[0].length));
}

function writeLines(path, lines) {
  writeFileSync(path, lines.map((line) => `${line}\n`).join(""));
}

// The default state of a usable change: one change-scoped assignment, one job
// pinned to it, one attempt launched and observed started.
function seedReady(handle, { jobId = "job-1", attemptId = "att-1", revision = 1, assignment = { goal: "g" } } = {}) {
  handle.append(
    "assignment.revised",
    { revision, predecessor: revision === 1 ? null : revision - 1, scope: { kind: "change" }, assignment },
    { context: ctx() },
  );
  handle.append("job.registered", { role: "implementer", pinnedRevision: revision }, { context: ctx({ jobId }) });
  handle.append("attempt.launch_intent", {}, { context: ctx({ jobId, attemptId }) });
  handle.append("attempt.started", { identity: "pi-session-x" }, { context: ctx({ jobId, attemptId }) });
}

const root = tempDir("qq-change-record-");

// Concurrent-child harness. Race tests use concurrently STARTED processes (a
// pool of live children contending for the writer lock), never sequential
// spawnSync calls, which would serialize by construction and prove nothing.
const childScript = join(root, "change-record-child.mjs");
writeFileSync(
  childScript,
  `import { createChange, openChange } from ${JSON.stringify(MODULE_PATH)};
const [, , mode, ...args] = process.argv;
const say = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
try {
  if (mode === "activity") {
    const [stateDir, changeId, jobId, attemptId, prefix, count] = args;
    const handle = openChange({ stateDir, changeId });
    const events = [];
    for (let i = 1; i <= Number(count); i += 1) {
      const result = handle.append("attempt.activity", { note: prefix + "-" + i }, {
        context: { actor: { kind: "runtime", id: "child-" + prefix }, jobId, attemptId },
        commandId: prefix + "-c" + i,
      });
      events.push({ seq: result.seq, eventId: result.eventId, commandId: result.commandId, committed: result.committed });
    }
    say({ ok: true, events });
  } else if (mode === "dup") {
    const [stateDir, changeId, jobId, attemptId, commandId] = args;
    const handle = openChange({ stateDir, changeId });
    const result = handle.append("attempt.activity", { note: "same-input" }, {
      context: { actor: { kind: "runtime", id: "child" }, jobId, attemptId },
      commandId,
    });
    say({ ok: true, seq: result.seq, eventId: result.eventId, committed: result.committed, dedupe: result.dedupe === true });
  } else if (mode === "conflict") {
    const [stateDir, changeId, jobId, attemptId, commandId, note] = args;
    const handle = openChange({ stateDir, changeId });
    const result = handle.append("attempt.activity", { note }, {
      context: { actor: { kind: "runtime", id: "child" }, jobId, attemptId },
      commandId,
    });
    say({ ok: true, seq: result.seq, note, committed: result.committed });
  } else if (mode === "create") {
    const [stateDir, changeId, commandId] = args;
    const handle = createChange({ stateDir, changeId, actor: { kind: "runtime", id: "creator" }, title: "raced", commandId });
    say({ ok: true, seq: handle.state.commandIndex[commandId]?.seq ?? null });
  } else if (mode === "hold") {
    const [stateDir, changeId, jobId, attemptId, holdMs] = args;
    const handle = openChange({ stateDir, changeId });
    const result = handle.append("attempt.activity", { note: "held" }, {
      context: { actor: { kind: "runtime", id: "holder" }, jobId, attemptId },
      commandId: "hold-" + process.pid,
      inject: { holdLockMs: Number(holdMs) },
    });
    say({ ok: true, seq: result.seq });
  } else {
    throw new Error("unknown child mode " + mode);
  }
} catch (err) {
  process.stderr.write(JSON.stringify({ code: err?.code ?? null, message: String(err?.message ?? err) }) + "\\n");
  process.exit(1);
}
`,
);

function runChildren(mode, argList) {
  return Promise.all(
    argList.map(
      (args) =>
        new Promise((resolveChild) => {
          const child = spawn(process.execPath, [childScript, mode, ...args], { stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          let err = "";
          child.stdout.on("data", (chunk) => (out += chunk));
          child.stderr.on("data", (chunk) => (err += chunk));
          child.on("close", (status) => resolveChild({ status, out, err, pid: child.pid }));
        }),
    ),
  );
}

function jsonOut(child) {
  assert.equal(child.status, 0, `child exited cleanly: ${child.err}`);
  return JSON.parse(child.out.trim());
}

// ---------------------------------------------------------------------------
// S1. Creation: privacy, containment, idempotent retries, bad-context hygiene.
// ---------------------------------------------------------------------------

{
  const dir = join(root, "s1-state");
  const handle = createChange({ stateDir: dir, changeId: "change-1", actor: RUNTIME, title: "First", commandId: "create-1" });
  assert.equal(handle.state.lastSeq, 1, "creation appends exactly one change.created event");
  assert.equal(statSync(handle.path).mode & 0o777, 0o600, "record files are private 0600");
  assert.equal(statSync(join(dir, "changes")).mode & 0o777, 0o700, "record directories are private 0700");
  assert.ok(resolve(handle.path).startsWith(resolve(dir) + sep), "record lives inside the state directory");

  // Acknowledgement-loss retry: the same command ID returns the original
  // result without a second event.
  const retried = createChange({ stateDir: dir, changeId: "change-1", actor: RUNTIME, title: "First", commandId: "create-1" });
  assert.equal(retried.state.lastSeq, 1, "create retry deduplicates instead of re-creating");
  // Same ID with different input fails.
  assertCode(
    () => createChange({ stateDir: dir, changeId: "change-1", actor: RUNTIME, title: "Different", commandId: "create-1" }),
    "command-conflict",
    "reusing a create command ID with different input fails",
  );
  // A different command ID on an already-created change is a new command and
  // cannot create the change twice.
  assertCode(
    () => createChange({ stateDir: dir, changeId: "change-1", actor: RUNTIME, title: "First", commandId: "create-2" }),
    "invalid-transition",
    "a second change.created command is rejected",
  );

  // Identifier containment: the ID charset forbids separators, path traversal,
  // and oversized values; nothing may escape the state directory.
  for (const bad of ["", "a/b", "..", "../escape", "x y", "a\tb", "-lead", "x".repeat(129)]) {
    assertCode(() => createChange({ stateDir: dir, changeId: bad, actor: RUNTIME, commandId: "c" }), "invalid-identifier", `changeId ${JSON.stringify(bad.slice(0, 8))} rejected`);
  }
  // A bad actor context must not litter an empty record file.
  assertCode(() => createChange({ stateDir: join(root, "s1-litter"), changeId: "litter", actor: { kind: "nope", id: "x" }, commandId: "c" }), "invalid-context");
  assert.ok(!statSync(join(root, "s1-litter", "changes"), { throwIfNoEntry: false }), "rejected creation leaves no changes directory behind");

  // An existing loose (0644) record file is tightened to the privacy contract,
  // never loosened; a non-regular file at the record path is refused.
  const looseDir = join(root, "s1-loose");
  mkdirSync(join(looseDir, "changes"), { recursive: true });
  const loosePath = join(looseDir, "changes", "loose.jsonl");
  writeFileSync(loosePath, "");
  chmodSync(loosePath, 0o644);
  createChange({ stateDir: looseDir, changeId: "loose", actor: RUNTIME, commandId: "create-loose" });
  assert.equal(statSync(loosePath).mode & 0o777, 0o600, "an existing 0644 record is tightened to 0600");
  mkdirSync(join(root, "s1-notfile", "changes"), { recursive: true });
  mkdirSync(join(root, "s1-notfile", "changes", "dir.jsonl"));
  assertCode(() => createChange({ stateDir: join(root, "s1-notfile"), changeId: "dir", actor: RUNTIME, commandId: "c" }), "invalid-state", "a directory at the record path is refused");
}

// ---------------------------------------------------------------------------
// S2. Framing: corruption is rejected, torn tails are recovered exactly, and
// unknown schema/kind are never silently applied.
// ---------------------------------------------------------------------------

{
  const dir = join(root, "s2-state");
  const handle = createChange({ stateDir: dir, changeId: "frame-1", actor: RUNTIME, commandId: "create-f1" });
  seedReady(handle, { jobId: "job-f", attemptId: "att-f" });
  const cleanSize = statSync(handle.path).size;
  const cleanBytes = readFileSync(handle.path);
  const baseEnvelope = () => ({
    schema: 1,
    changeId: "frame-1",
    seq: 6,
    eventId: "ev-x",
    command: { id: "cmd-x", digest: "0".repeat(64) },
    actor: { kind: "runtime", id: "test-runtime" },
    kind: "attempt.activity",
    jobId: "job-f",
    attemptId: "att-f",
    at: 1,
    payload: { note: "x" },
  });

  // A complete line that fails its own integrity check is corruption: reads
  // fail hard, recovery refuses, and the module never modifies the file.
  appendFileSync(handle.path, frameLine(baseEnvelope(), { digest: createHash("sha256").update("wrong").digest("hex") }));
  assertCode(() => openChange({ stateDir: dir, changeId: "frame-1" }), "frame-corrupt", "a checksum-invalid complete line is corruption");
  assertCode(() => recoverChange({ stateDir: dir, changeId: "frame-1" }), "frame-corrupt", "recovery refuses corruption instead of trimming it");
  assert.ok(readFileSync(handle.path).length > cleanSize, "the corrupt bytes are still there for the operator");

  // Complete-but-malformed: a declared-length mismatch on a newline-terminated
  // line is not a torn append (frames end with their own newline); it is
  // damage, and it fails hard.
  writeFileSync(handle.path, cleanBytes);
  appendFileSync(handle.path, frameLine(baseEnvelope(), { lengthDelta: 3 }));
  assertCode(() => openChange({ stateDir: dir, changeId: "frame-1" }), "frame-corrupt", "a complete line with a declared-length mismatch is corruption");

  // Unknown schema version and unknown kind in otherwise-valid frames are
  // rejected, never silently applied.
  for (const [mutate, code] of [
    [(env) => ({ ...env, schema: 2 }), "unknown-schema"],
    [(env) => ({ ...env, kind: "attempt.something_new" }), "unknown-kind"],
    [(env) => ({ ...env, payload: "not-an-object" }), "invalid-event"],
  ]) {
    writeFileSync(handle.path, cleanBytes);
    appendFileSync(handle.path, frameLine(mutate(baseEnvelope())));
    assertCode(() => openChange({ stateDir: dir, changeId: "frame-1" }), code, `mutated envelope rejected with ${code}`);
  }

  // Interior corruption: a damaged line between valid ones stops everything;
  // later valid lines never justify skipping it.
  writeFileSync(handle.path, cleanBytes);
  const good = committedLines(handle.path);
  const corrupt = frameLine(
    { ...baseEnvelope(), eventId: "ev-mid", command: { id: "cmd-mid", digest: "0".repeat(64) }, payload: { note: "mid" } },
    { digest: createHash("sha256").update("tampered").digest("hex") },
  ).trimEnd();
  writeLines(handle.path, [...good.slice(0, 2), corrupt, ...good.slice(2)]);
  assertCode(() => openChange({ stateDir: dir, changeId: "frame-1" }), "frame-corrupt", "interior corruption fails the whole read");
  assertCode(
    () => handle.append("attempt.activity", { note: "no" }, { context: ctx({ jobId: "job-f", attemptId: "att-f" }) }),
    "frame-corrupt",
    "append refuses a corrupt record",
  );
  writeFileSync(handle.path, cleanBytes);

  // A torn FINAL segment (bytes after the last newline: a partial frame
  // prefix) is uncommitted by construction. Readers ignore it and report it;
  // recovery truncates exactly those bytes, under exclusive ownership.
  const tail = Buffer.from(`41 ${"a".repeat(64)} {"sche`, "utf8");
  appendFileSync(handle.path, tail);
  const torn = openChange({ stateDir: dir, changeId: "frame-1" });
  assert.deepEqual(torn.pendingRecovery, { tornBytes: tail.length, byteOffset: cleanSize }, "a torn tail is surfaced, not hidden");
  assert.equal(torn.views.job("job-f").attempts["att-f"].phase, "started", "views read committed bytes only");
  assert.equal(torn.readEvents().watermark.tornTailBytes, tail.length, "the read watermark reports the torn tail");
  const recovered = recoverChange({ stateDir: dir, changeId: "frame-1" });
  assert.equal(recovered.truncatedBytes, tail.length, "recovery discards exactly the torn bytes");
  assert.equal(statSync(handle.path).size, cleanSize, "recovery never touches committed bytes");
  assert.deepEqual(openChange({ stateDir: dir, changeId: "frame-1" }).pendingRecovery, null, "recovery clears the pending flag");
  assert.equal(openChange({ stateDir: dir, changeId: "frame-1" }).state.lastSeq, 5, "committed events survive recovery");

  // Recovery of a clean record is a no-op.
  assert.deepEqual(recoverChange({ stateDir: dir, changeId: "frame-1" }), { truncatedBytes: 0 });
}

// ---------------------------------------------------------------------------
// S3. The reducer is the single transition authority: actor gates, attempt
// lifecycle, cancellation vs success, and worker findings vs completion.
// ---------------------------------------------------------------------------

{
  const dir = join(root, "s3-state");
  const handle = createChange({ stateDir: dir, changeId: "auth-1", actor: RUNTIME, commandId: "create-a1" });
  handle.append("assignment.revised", { revision: 1, predecessor: null, scope: { kind: "change" }, assignment: { goal: "g" } }, { context: ctx() });
  handle.append("job.registered", { role: "implementer", pinnedRevision: 1 }, { context: ctx({ jobId: "job-1" }) });

  // change.created must be the first event of a record.
  assertCode(() => handle.append("change.created", { title: "again" }, { context: ctx() }), "invalid-transition", "re-creating a change is rejected");

  // Worker findings are evidence, never authority.
  for (const [kind, payload, need] of [
    ["assignment.revised", { revision: 2, predecessor: 1, scope: { kind: "change" }, assignment: {} }, {}],
    ["job.registered", { role: "runner", pinnedRevision: 1 }, { jobId: "job-9" }],
    ["attempt.launch_intent", {}, { jobId: "job-9", attemptId: "att-w" }],
    ["attempt.cancel_intent", { reason: "r" }, { jobId: "job-1", attemptId: "att-1" }],
    ["attempt.outcome", { status: "completed" }, { jobId: "job-1", attemptId: "att-1" }],
    ["amendment.submitted", { amendmentId: "am-x", revision: 1 }, { jobId: "job-1", attemptId: "att-1" }],
    ["amendment.accepted", { amendmentId: "am-x" }, { jobId: "job-1", attemptId: "att-1" }],
  ]) {
    assertCode(() => handle.append(kind, payload, { context: workerCtx(need) }), "invalid-transition", `a worker cannot author ${kind}`);
  }
  // Conversely the runtime cannot fabricate worker evidence.
  assertCode(
    () => handle.append("worker.progress", { note: "fake" }, { context: ctx({ jobId: "job-1", attemptId: "att-1" }) }),
    "invalid-transition",
    "worker-authored kinds require a worker actor",
  );
  assertCode(
    () => handle.append("worker.acknowledged", { revision: 1 }, { context: ctx({ jobId: "job-1", attemptId: "att-1" }) }),
    "invalid-transition",
    "acknowledgements are worker evidence",
  );

  // Launch intent is explicitly unresolved; observed start carries trusted
  // identity; output requires the observed start.
  handle.append("attempt.launch_intent", {}, { context: ctx({ jobId: "job-1", attemptId: "att-1" }) });
  assert.equal(handle.views.attempt("job-1", "att-1").phase, "launched", "launch intent stays unresolved");
  assert.equal(handle.views.attempt("job-1", "att-1").started, null, "no start is invented");
  assertCode(
    () => handle.append("worker.progress", { note: "early" }, { context: workerCtx({ jobId: "job-1", attemptId: "att-1" }) }),
    "invalid-transition",
    "worker output before an observed start is rejected",
  );
  assertCode(
    () => handle.append("attempt.started", {}, { context: ctx({ jobId: "job-1", attemptId: "att-1" }) }),
    "invalid-event",
    "attempt.started requires a trusted identity",
  );
  handle.append("attempt.started", { identity: { session: "s-1", pid: 4242 } }, { context: ctx({ jobId: "job-1", attemptId: "att-1" }) });
  assert.equal(handle.views.attempt("job-1", "att-1").started.identity.session, "s-1", "observed identity is recorded");
  assertCode(
    () => handle.append("attempt.launch_intent", {}, { context: ctx({ jobId: "job-1", attemptId: "att-1" }) }),
    "invalid-transition",
    "an attempt ID is never reused",
  );

  // Cancellation prevents success; terminal states never regress.
  handle.append("attempt.cancel_intent", { reason: "operator stop" }, { context: ctx({ jobId: "job-1", attemptId: "att-1" }) });
  assertCode(
    () => handle.append("attempt.outcome", { status: "completed", summary: "done anyway" }, { context: ctx({ jobId: "job-1", attemptId: "att-1" }) }),
    "invalid-transition",
    "cancellation intent forbids a completed outcome",
  );
  handle.append("attempt.outcome", { status: "cancelled", summary: "stopped" }, { context: ctx({ jobId: "job-1", attemptId: "att-1" }) });
  assertCode(
    () => handle.append("attempt.outcome", { status: "failed", summary: "retry the verdict" }, { context: ctx({ jobId: "job-1", attemptId: "att-1" }) }),
    "invalid-transition",
    "a terminal outcome is never regression-edited",
  );
  assertCode(
    () => handle.append("worker.progress", { note: "late" }, { context: workerCtx({ jobId: "job-1", attemptId: "att-1" }) }),
    "invalid-transition",
    "no further attempt output after a validated outcome",
  );
  assertCode(
    () => handle.append("attempt.cancel_intent", { reason: "late" }, { context: ctx({ jobId: "job-1", attemptId: "att-1" }) }),
    "invalid-transition",
    "cancellation cannot follow a validated outcome",
  );
  assert.equal(handle.views.attempt("job-1", "att-1").outcome.status, "cancelled", "the first validated outcome stands");

  // Acknowledgement requires an observed start, never a mere launch intent.
  handle.append("attempt.launch_intent", {}, { context: ctx({ jobId: "job-1", attemptId: "att-2" }) });
  assertCode(
    () => handle.append("worker.acknowledged", { revision: 1 }, { context: workerCtx({ jobId: "job-1", attemptId: "att-2" }) }),
    "invalid-transition",
    "an unstarted attempt cannot acknowledge",
  );

  // Assignment revisions: enforced predecessors and valid scopes; outcome
  // revision claims must match what the attempt actually worked against.
  assertCode(
    () => handle.append("assignment.revised", { revision: 3, predecessor: 1, scope: { kind: "change" }, assignment: {} }, { context: ctx() }),
    "invalid-transition",
    "a revision must follow its true predecessor",
  );
  assertCode(
    () => handle.append("assignment.revised", { revision: 2, predecessor: 1, scope: { kind: "job", jobId: "ghost" }, assignment: {} }, { context: ctx() }),
    "invalid-transition",
    "a job-scoped revision must target a registered job",
  );
  assertCode(
    () => handle.append("job.registered", { role: "runner", pinnedRevision: 7 }, { context: ctx({ jobId: "job-2" }) }),
    "invalid-transition",
    "a job cannot pin a nonexistent revision",
  );
  assertCode(
    () => handle.append("job.registered", { role: "runner", pinnedRevision: 1 }, { context: ctx({ jobId: "job-1" }) }),
    "invalid-transition",
    "a job ID is registered once",
  );

  // Identity spoofing: the payload is never allowed to impersonate the
  // envelope; the trusted context is a separate argument.
  for (const key of ["actor", "kind", "seq", "jobId", "attemptId", "payload", "schema"]) {
    assertCode(
      () => handle.append("attempt.activity", { note: "x", [key]: "spoof" }, { context: ctx({ jobId: "job-1", attemptId: "att-2" }) }),
      "spoofed-identity",
      `payload key '${key}' is reserved`,
    );
  }
  assertCode(() => handle.append("attempt.not_a_kind", {}, { context: ctx() }), "unknown-kind", "unknown kinds are rejected at the API");

  // Expectations validate against the committed state under the lock — and a
  // passing expectation does not weaken the reducer's own gates.
  assertCode(
    () => handle.append("attempt.started", { identity: "s2" }, { context: ctx({ jobId: "job-1", attemptId: "att-2" }), expect: { attemptPhase: "started" } }),
    "expectation-failed",
    "a wrong expected phase fails explicitly",
  );
  handle.append("attempt.started", { identity: "s2" }, { context: ctx({ jobId: "job-1", attemptId: "att-2" }), expect: { attemptPhase: "launched" } });
  handle.append("attempt.activity", { note: "after start" }, { context: ctx({ jobId: "job-1", attemptId: "att-2" }), expect: { attemptPhase: "started" } });
  assertCode(
    () => handle.append("attempt.activity", { note: "x" }, { context: ctx({ jobId: "job-1", attemptId: "att-2" }), expect: { assignmentRevision: 99 } }),
    "expectation-failed",
    "a wrong expected assignment revision fails explicitly",
  );
}

// ---------------------------------------------------------------------------
// S4. Multiple jobs and attempts stay isolated; revision scope and pinning.
// ---------------------------------------------------------------------------

{
  const dir = join(root, "s4-state");
  const handle = createChange({ stateDir: dir, changeId: "iso-1", actor: RUNTIME, commandId: "create-i1" });
  handle.append("assignment.revised", { revision: 1, predecessor: null, scope: { kind: "change" }, assignment: { model: "deepseek", v: 1 } }, { context: ctx() });
  handle.append("job.registered", { role: "implementer", pinnedRevision: 1 }, { context: ctx({ jobId: "job-a" }) });
  handle.append("job.registered", { role: "reviewer", pinnedRevision: 1 }, { context: ctx({ jobId: "job-b" }) });
  handle.append("assignment.revised", { revision: 2, predecessor: 1, scope: { kind: "job", jobId: "job-b" }, assignment: { model: "glm", v: 2 } }, { context: ctx() });

  // A job-targeted revision supersedes the pin for that job only; the other
  // job keeps its pin.
  assert.equal(handle.views.job("job-a").effectiveRevision, 1, "job-a keeps its pin");
  assert.equal(handle.views.job("job-b").effectiveRevision, 2, "job-b follows its targeted revision");
  assert.equal(handle.views.assignment({ scope: { kind: "job", jobId: "job-a" } }).assignment.model, "deepseek");
  assert.equal(handle.views.assignment({ scope: { kind: "job", jobId: "job-b" } }).assignment.model, "glm");
  assert.equal(handle.views.assignment({ revision: 1 }).assignment.v, 1);
  assertCode(() => handle.views.assignment({ revision: 9 }), "not-found", "a nonexistent revision is not served");

  // A later change-default revision never silently re-pins an existing job.
  handle.append("assignment.revised", { revision: 3, predecessor: 2, scope: { kind: "change" }, assignment: { model: "deepseek", v: 3 } }, { context: ctx() });
  assert.equal(handle.views.job("job-a").effectiveRevision, 1, "change-default revisions do not re-pin");
  assert.equal(handle.views.job("job-b").effectiveRevision, 2, "job-targeted revisions survive later change defaults");
  assert.equal(handle.views.assignment().revision, 3, "the change default is the latest change-scoped revision");
  // A launch intent cannot pin a revision that never applied to the job.
  assertCode(
    () => handle.append("attempt.launch_intent", { revision: 2 }, { context: ctx({ jobId: "job-a", attemptId: "ax" }) }),
    "invalid-transition",
    "revision 2 never applied to job-a",
  );

  // Attempts are isolated: two attempts on one job, one on the other.
  for (const attemptId of ["a1", "a2"]) {
    handle.append("attempt.launch_intent", {}, { context: ctx({ jobId: "job-a", attemptId }) });
    handle.append("attempt.started", { identity: attemptId }, { context: ctx({ jobId: "job-a", attemptId }) });
  }
  handle.append("attempt.launch_intent", {}, { context: ctx({ jobId: "job-b", attemptId: "b1" }) });
  handle.append("attempt.started", { identity: "b1" }, { context: ctx({ jobId: "job-b", attemptId: "b1" }) });

  handle.append("worker.progress", { note: "from a1" }, { context: workerCtx({ jobId: "job-a", attemptId: "a1" }) });
  // Late output from the superseded attempt lands on ITS history only.
  handle.append("worker.progress", { note: "late from a1" }, { context: workerCtx({ jobId: "job-a", attemptId: "a1" }) });
  handle.append("attempt.activity", { note: "runtime saw a2" }, { context: ctx({ jobId: "job-a", attemptId: "a2" }) });
  handle.append("worker.blocker", { note: "blocked", fatal: true }, { context: workerCtx({ jobId: "job-b", attemptId: "b1" }) });

  const a1 = handle.views.attempt("job-a", "a1");
  const a2 = handle.views.attempt("job-a", "a2");
  const b1 = handle.views.attempt("job-b", "b1");
  assert.deepEqual(a1.progress.map((p) => p.note), ["from a1", "late from a1"], "attempt a1 keeps its own progress");
  assert.deepEqual(a2.progress, [], "old attempt output cannot update the new attempt");
  assert.deepEqual(a2.activity.map((p) => p.note), ["runtime saw a2"], "activity is separate from progress");
  assert.deepEqual(a1.activity, [], "activity and progress never cross-contaminate");
  assert.equal(a2.latestProgress, null, "latestProgress is per-attempt");
  assert.equal(b1.blockers[0].fatal, true, "blockers carry their own channel and fatality");
  assert.deepEqual(b1.progress, [], "jobs do not share attempt state");
  assert.equal(handle.views.job("job-a").attemptOrder.join(","), "a1,a2");
}

// ---------------------------------------------------------------------------
// S5. Large text: atomic multi-frame groups, exact reassembly, bounded reads.
// ---------------------------------------------------------------------------

{
  const dir = join(root, "s5-state");
  const handle = createChange({ stateDir: dir, changeId: "text-1", actor: RUNTIME, commandId: "create-t1" });
  const big = "abc123-".repeat(Math.ceil((TEXT_CHUNK_CHARS * 2 + 500) / 7)); // exactly 3 chunks
  assert.ok(big.length > TEXT_CHUNK_CHARS * 2, "fixture text spans three chunks");
  const bigPayload = { revision: 1, predecessor: null, scope: { kind: "change" }, assignment: { instructions: big } };
  handle.append("assignment.revised", bigPayload, { context: ctx(), commandId: "assign-big" });

  const view = handle.views.assignment();
  assert.equal(view.complete, true, "a fully committed split text reads as complete");
  assert.equal(view.assignment.instructions, big, "continuations reassemble byte-for-byte");
  assert.equal(bigPayload.assignment.instructions.length, big.length, "the caller's payload was not mutated by splitting");
  const page = handle.readEvents({ limit: 100 });
  assert.equal(page.events.filter((env) => env.kind === "text.continued").length, 2, "the group carried two continuation events");
  assert.equal(page.events[1].payload.textContinuation[0].parts, 3, "the primary event carries the marker");
  for (const line of committedLines(handle.path)) {
    assert.ok(Buffer.byteLength(line) <= FRAME_MAX_BYTES, "every frame respects the byte cap");
  }

  // Unregistered large fields are not silently split; they fail the frame cap
  // instead of writing a record that could never reopen.
  seedReady(handle, { jobId: "job-t", attemptId: "att-t", revision: 2, assignment: { goal: "g2" } });
  assertCode(
    () => handle.append("attempt.activity", { note: "small", extra: "x".repeat(FRAME_MAX_BYTES) }, { context: ctx({ jobId: "job-t", attemptId: "att-t" }) }),
    "frame-too-large",
    "an unregistered oversized field fails the frame cap",
  );

  // A result field larger than one chunk splits and reassembles too.
  const outcomePayload = { status: "completed", summary: "s", result: "r".repeat(TEXT_CHUNK_CHARS * 2 + 3) };
  const outcome = handle.append("attempt.outcome", outcomePayload, { context: ctx({ jobId: "job-t", attemptId: "att-t" }), commandId: "outcome-big" });
  assert.equal(outcome.committed, true);
  const outcomeView = handle.views.attempt("job-t", "att-t").outcome;
  assert.equal(outcomeView.complete, true, "a split result reassembles");
  assert.equal(outcomeView.result, "r".repeat(TEXT_CHUNK_CHARS * 2 + 3), "the result text is byte-exact");
  assert.equal(outcomePayload.result.length, TEXT_CHUNK_CHARS * 2 + 3, "the caller's payload object was not mutated by splitting");

  // Bounded reads with a stable watermark: pages concatenate to the full
  // history and the watermark is a stable snapshot boundary.
  const all = handle.readEvents({ limit: 10_000 });
  const paged = [];
  let cursor = 0;
  for (let guard = 0; guard < 100; guard += 1) {
    const pageRead = handle.readEvents({ afterSeq: cursor, limit: 3 });
    paged.push(...pageRead.events);
    cursor = pageRead.nextAfterSeq;
    if (!pageRead.hasMore) break;
  }
  assert.deepEqual(paged, all.events, "paged reads cover the history exactly once");
  assert.equal(all.hasMore, false, "the unbounded page reports completion");
  assert.deepEqual(handle.readEvents().watermark, { lastSeq: handle.state.lastSeq, byteOffset: statSync(handle.path).size, tornTailBytes: 0 }, "the watermark matches the committed boundary");
  assert.deepEqual(handle.snapshot().watermark, { lastSeq: handle.state.lastSeq, byteOffset: statSync(handle.path).size }, "snapshot watermark matches the committed boundary");
}

// ---------------------------------------------------------------------------
// S6. Steering regression: A (DeepSeek) → targeted amendment B (GLM).
// A result for A retains A; B stays unresolved until a worker acknowledges B
// by name and by the targeted attempt.
// ---------------------------------------------------------------------------

{
  const dir = join(root, "s6-state");
  const handle = createChange({ stateDir: dir, changeId: "steer-1", actor: RUNTIME, commandId: "create-s6" });
  handle.append("assignment.revised", { revision: 1, predecessor: null, scope: { kind: "change" }, assignment: { model: "deepseek" } }, { context: ctx(), commandId: "assign-a" });
  handle.append("job.registered", { role: "implementer", pinnedRevision: 1 }, { context: ctx({ jobId: "job-s" }) });
  handle.append("attempt.launch_intent", {}, { context: ctx({ jobId: "job-s", attemptId: "t1" }) });
  handle.append("attempt.started", { identity: "pi-1" }, { context: ctx({ jobId: "job-s", attemptId: "t1" }) });
  handle.append("worker.acknowledged", { revision: 1 }, { context: workerCtx({ jobId: "job-s", attemptId: "t1" }), commandId: "ack-a" });
  handle.append("worker.progress", { note: "working on A" }, { context: workerCtx({ jobId: "job-s", attemptId: "t1" }) });
  handle.append("attempt.outcome", { status: "completed", summary: "A done" }, { context: ctx({ jobId: "job-s", attemptId: "t1" }), commandId: "outcome-a" });

  // Targeted amendment B: new revision scoped to the job, delivery submitted
  // and accepted by the transport — but NO worker acknowledgement yet.
  handle.append("assignment.revised", { revision: 2, predecessor: 1, scope: { kind: "job", jobId: "job-s" }, assignment: { model: "glm" } }, { context: ctx(), commandId: "assign-b" });
  handle.append("amendment.submitted", { amendmentId: "amend-b", revision: 2 }, { context: ctx({ jobId: "job-s", attemptId: "t1" }), commandId: "submit-b" });

  // Acceptance is scoped to the delivery's targeted attempt.
  handle.append("attempt.launch_intent", {}, { context: ctx({ jobId: "job-s", attemptId: "t2" }) });
  handle.append("attempt.started", { identity: "pi-2" }, { context: ctx({ jobId: "job-s", attemptId: "t2" }) });
  assertCode(
    () => handle.append("amendment.accepted", { amendmentId: "amend-b" }, { context: ctx({ jobId: "job-s", attemptId: "t2" }) }),
    "invalid-transition",
    "the accepting attempt must match the targeted attempt",
  );
  handle.append("amendment.accepted", { amendmentId: "amend-b" }, { context: ctx({ jobId: "job-s", attemptId: "t1" }), commandId: "accept-b" });
  assertCode(
    () => handle.append("amendment.accepted", { amendmentId: "amend-b" }, { context: ctx({ jobId: "job-s", attemptId: "t1" }) }),
    "invalid-transition",
    "delivery acceptance is recorded once",
  );

  // The result for A retains A; B is exposed as unresolved, never fulfilled.
  const attempt1 = handle.views.attempt("job-s", "t1");
  assert.equal(attempt1.outcome.revision, 1, "the result for A retains revision A");
  assert.equal(attempt1.outcome.ok, true);
  assert.deepEqual(attempt1.acknowledgements.map((ack) => ack.revision), [1], "no acknowledgement of B exists");
  const job = handle.views.job("job-s");
  assert.deepEqual(job.pendingAmendments.map((a) => a.amendmentId), ["amend-b"], "B is exposed as unresolved");
  assert.equal(job.pendingAmendments[0].revision, 2);
  assert.ok(job.pendingAmendments[0].acceptedAt !== null, "the transport accepted the delivery");
  assert.equal(job.pendingAmendments[0].acknowledged, null, "the worker has not acknowledged it");
  assert.deepEqual(handle.views.pendingAmendments("job-s").map((a) => a.amendmentId), ["amend-b"]);
  assert.deepEqual(handle.views.pendingAmendments().map((a) => a.amendmentId), ["amend-b"]);
  assert.equal(handle.views.assignment({ scope: { kind: "job", jobId: "job-s" } }).assignment.model, "glm", "the targeted assignment is in force");
  const reconciliation = handle.views.reconciliations();
  assert.equal(reconciliation.length, 1, "the fulfilled-looking result is flagged for reconciliation");
  assert.deepEqual(reconciliation[0].pendingRevisions, [2], "the pending amendment is named");
  assert.equal(reconciliation[0].outcomeRevision, 1);

  // A worker can still acknowledge B after its validated outcome — that is the
  // steering flow — but an acknowledgement of a nonexistent revision is
  // rejected.
  assertCode(
    () => handle.append("worker.acknowledged", { revision: 9 }, { context: workerCtx({ jobId: "job-s", attemptId: "t1" }) }),
    "invalid-transition",
    "acknowledging a revision that does not exist is rejected",
  );
  // A non-targeted attempt's acknowledgement does not fulfil the delivery.
  handle.append("worker.acknowledged", { revision: 2 }, { context: workerCtx({ jobId: "job-s", attemptId: "t2" }), commandId: "ack-b-t2" });
  assert.deepEqual(handle.views.job("job-s").pendingAmendments.map((a) => a.amendmentId), ["amend-b"], "another attempt's ack does not resolve a delivery targeted elsewhere");
  // The targeted attempt's acknowledgement of B resolves it, naming B.
  handle.append("worker.acknowledged", { revision: 2 }, { context: workerCtx({ jobId: "job-s", attemptId: "t1" }), commandId: "ack-b" });
  assert.deepEqual(handle.views.job("job-s").pendingAmendments, [], "acknowledging B resolves it");
  assert.deepEqual(handle.views.reconciliations()[0].pendingRevisions, [], "no unacknowledged amendment remains");
  assert.equal(handle.views.reconciliations()[0].outcomeRevision, 1, "the old result still names A");
  const ackB = handle.views.attempt("job-s", "t1").acknowledgements.at(-1);
  assert.equal(ackB.revision, 2, "the acknowledgement names B");
  assert.equal(handle.views.attempt("job-s", "t1").id, "t1", "the acknowledgement record sits on the targeted attempt");
}

// ---------------------------------------------------------------------------
// S7. Idempotency and fault injection: short-circuit failures, acknowledgement
// loss, interrupted multi-frame groups, and lost continuation frames.
// ---------------------------------------------------------------------------

{
  const dir = join(root, "s7-state");
  const handle = createChange({ stateDir: dir, changeId: "fault-1", actor: RUNTIME, commandId: "create-f7" });
  seedReady(handle, { jobId: "job-1", attemptId: "att-1" });
  const workerOn = workerCtx({ jobId: "job-1", attemptId: "att-1" });

  // Failure BEFORE any byte is written: nothing persists, retry succeeds.
  const sizeBefore = statSync(handle.path).size;
  assert.throws(
    () => handle.append("worker.progress", { note: "lost" }, { context: workerOn, commandId: "fw-1", inject: { beforeWrite: () => { throw new Error("boom"); } } }),
    /boom/,
  );
  assert.equal(statSync(handle.path).size, sizeBefore, "a pre-write failure writes nothing");
  const fw = handle.append("worker.progress", { note: "lost" }, { context: workerOn, commandId: "fw-1" });
  assert.equal(fw.committed, true, "the retry commits normally");

  // Acknowledgement loss: bytes durable + complete, caller never told. A
  // fresh reader sees the event committed; the retry deduplicates.
  assert.throws(
    () => handle.append("worker.progress", { note: "acked?" }, { context: workerOn, commandId: "fw-2", inject: { beforeSync: () => { throw new Error("caller died"); } } }),
    /caller died/,
  );
  const fresh = openChange({ stateDir: dir, changeId: "fault-1" });
  assert.ok(fresh.state.commandIndex["fw-2"], "the durable event is visible despite the lost acknowledgement");
  assert.equal(fresh.state.lastSeq, handle.state.lastSeq + 1, "replay counts it exactly once");
  const retry = fresh.append("worker.progress", { note: "acked?" }, { context: workerOn, commandId: "fw-2" });
  assert.equal(retry.committed, false, "the retry is a dedupe, not a second event");
  assert.equal(retry.dedupe, true);
  assert.equal(retry.completedMissingParts, 0);
  assert.equal(retry.seq, fresh.state.lastSeq, "the dedupe returns the original result");
  // The stale in-memory handle heals itself from the file on its next append.
  const healed = handle.append("worker.progress", { note: "acked?" }, { context: workerOn, commandId: "fw-2" });
  assert.equal(healed.committed, false, "the stale handle converges on durable truth");

  // Interrupted multi-frame group: a crash after the primary frame leaves the
  // continuation parts missing; a partial text is never presented as complete.
  const big = "z".repeat(TEXT_CHUNK_CHARS * 2 + 7);
  assert.throws(
    () =>
      handle.append(
        "attempt.activity",
        { note: big },
        { context: ctx({ jobId: "job-1", attemptId: "att-1" }), commandId: "big-1", inject: { beforeFrame: ({ index }) => { if (index === 1) throw new Error("crash mid-group"); } } },
      ),
    /crash mid-group/,
  );
  const midGroup = openChange({ stateDir: dir, changeId: "fault-1" });
  const partial = midGroup.views.attempt("job-1", "att-1").activity.at(-1);
  assert.equal(partial.complete, false, "a partial text is never presented as complete");
  assert.equal(partial.note, null, "the partial field reads null, not a truncated assignment");
  assert.deepEqual(partial.incompleteTexts[0].missing, [1, 2], "the missing parts are named");
  assertCode(
    () => midGroup.append("attempt.activity", { note: "DIFFERENT" }, { context: ctx({ jobId: "job-1", attemptId: "att-1" }), commandId: "big-1" }),
    "command-conflict",
    "a retry with different input cannot complete someone else's group",
  );
  // The identical retry reconstructs the EXACT chunks and completes the group.
  const retryBig = midGroup.append("attempt.activity", { note: big }, { context: ctx({ jobId: "job-1", attemptId: "att-1" }), commandId: "big-1" });
  assert.equal(retryBig.dedupe, true);
  assert.equal(retryBig.completedMissingParts, 2, "both lost continuation frames were completed");
  const healedText = midGroup.views.attempt("job-1", "att-1").activity.at(-1);
  assert.equal(healedText.complete, true);
  assert.equal(healedText.note, big, "the reconstructed text is byte-identical, never a placeholder");
  const replayAfterRetry = reduceEvents(midGroup.readEvents({ limit: 10_000 }).events, { changeId: "fault-1" });
  assert.equal(
    JSON.stringify(viewsFor(replayAfterRetry).attempt("job-1", "att-1").activity.at(-1)),
    JSON.stringify(midGroup.views.attempt("job-1", "att-1").activity.at(-1)),
    "full replay after the retry equals the selective view",
  );

  // Frame-aligned loss of continuation frames (machine-crash shape: the
  // primary is durable, later frames are simply gone, no torn tail). Also
  // proves that external truncation of COMMITTED events is never silently
  // absorbed by a stale handle.
  const dir2 = join(root, "s7b-state");
  const handle2 = createChange({ stateDir: dir2, changeId: "fault-2", actor: RUNTIME, commandId: "create-f8" });
  handle2.append("assignment.revised", { revision: 1, predecessor: null, scope: { kind: "change" }, assignment: { goal: "g" } }, { context: ctx(), commandId: "assign-1" });
  const bigText = "w".repeat(TEXT_CHUNK_CHARS * 2 + 11);
  handle2.append("assignment.revised", { revision: 2, predecessor: 1, scope: { kind: "change" }, assignment: { instructions: bigText } }, { context: ctx(), commandId: "assign-2" });
  writeLines(handle2.path, committedLines(handle2.path).filter((line) => envelopeOf(line).kind !== "text.continued"));
  assertCode(
    () => handle2.append("attempt.activity", { note: "x" }, { context: ctx({ jobId: "nope", attemptId: "nope" }) }),
    "state-divergence",
    "a handle whose committed bytes vanished externally refuses to keep going",
  );
  const reopened = openChange({ stateDir: dir2, changeId: "fault-2" });
  const lostView = reopened.views.assignment({ revision: 2 });
  assert.equal(lostView.complete, false, "the lost continuation is visible as incompleteness");
  assert.equal(lostView.assignment.instructions, null, "a partial assignment is never presented as complete");
  assert.deepEqual(lostView.incompleteTexts[0].missing, [1, 2]);
  const retryLost = reopened.append(
    "assignment.revised",
    { revision: 2, predecessor: 1, scope: { kind: "change" }, assignment: { instructions: bigText } },
    { context: ctx(), commandId: "assign-2" },
  );
  assert.equal(retryLost.dedupe, true);
  assert.equal(retryLost.completedMissingParts, 2);
  assert.equal(reopened.views.assignment({ revision: 2 }).assignment.instructions, bigText, "the retry restores the exact text");
  assert.equal(reopened.views.assignment({ revision: 2 }).complete, true);
  const replayed = reduceEvents(reopened.readEvents({ limit: 10_000 }).events, { changeId: "fault-2" });
  assert.equal(replayed.lastSeq, reopened.state.lastSeq, "replay after retry reduces cleanly (no duplicate sequences)");
  assert.equal(viewsFor(replayed).assignment({ revision: 2 }).assignment.instructions, bigText);

  // A torn continuation frame (partial last line) is recovered under exclusive
  // ownership, then the identical retry completes the group.
  const dir3 = join(root, "s7c-state");
  const handle3 = createChange({ stateDir: dir3, changeId: "fault-3", actor: RUNTIME, commandId: "create-f9" });
  handle3.append("assignment.revised", { revision: 1, predecessor: null, scope: { kind: "change" }, assignment: { goal: "g" } }, { context: ctx(), commandId: "assign-1" });
  handle3.append("assignment.revised", { revision: 2, predecessor: 1, scope: { kind: "change" }, assignment: { instructions: bigText } }, { context: ctx(), commandId: "assign-2" });
  const keptLines = committedLines(handle3.path);
  const continuations = keptLines.filter((line) => envelopeOf(line).kind === "text.continued");
  writeLines(handle3.path, keptLines.filter((line) => envelopeOf(line).kind !== "text.continued"));
  appendFileSync(handle3.path, continuations[0].slice(0, 40)); // torn frame prefix, no newline
  const tornOpen = openChange({ stateDir: dir3, changeId: "fault-3" });
  assert.ok(tornOpen.pendingRecovery, "the torn continuation is surfaced");
  assert.equal(tornOpen.views.assignment({ revision: 2 }).complete, false);
  assert.equal(recoverChange({ stateDir: dir3, changeId: "fault-3" }).truncatedBytes, 40);
  tornOpen.append(
    "assignment.revised",
    { revision: 2, predecessor: 1, scope: { kind: "change" }, assignment: { instructions: bigText } },
    { context: ctx(), commandId: "assign-2" },
  );
  assert.equal(tornOpen.views.assignment({ revision: 2 }).assignment.instructions, bigText, "recovery then retry restores the text exactly");

  // A dedupe with nothing to complete writes nothing.
  const quietSize = statSync(handle3.path).size;
  const quiet = handle3.append(
    "assignment.revised",
    { revision: 2, predecessor: 1, scope: { kind: "change" }, assignment: { instructions: bigText } },
    { context: ctx(), commandId: "assign-2" },
  );
  assert.equal(quiet.dedupe, true);
  assert.equal(quiet.completedMissingParts, 0);
  assert.equal(statSync(handle3.path).size, quietSize, "a no-op dedupe writes no bytes");
}

// ---------------------------------------------------------------------------
// S8. Cross-process writer lock: bounded contention, live owners are never
// stolen, stale owners are, and ownerless locks need an explicit break.
// ---------------------------------------------------------------------------

{
  const dir = join(root, "s8-state");
  const handle = createChange({ stateDir: dir, changeId: "lock-1", actor: RUNTIME, commandId: "create-l1" });
  seedReady(handle, { jobId: "job-1", attemptId: "att-1" });
  const lockPath = `${handle.path}.lock`;
  const parentActivity = (note, extra = {}) => handle.append("attempt.activity", { note }, { context: ctx({ jobId: "job-1", attemptId: "att-1" }), ...extra });

  // A merely slow LIVE owner is never stolen: contention fails explicitly,
  // names the owner, and stays bounded.
  const holder = spawn(process.execPath, [childScript, "hold", dir, "lock-1", "job-1", "att-1", "1500"], { stdio: ["ignore", "pipe", "pipe"] });
  let holderOut = "";
  holder.stdout.on("data", (chunk) => (holderOut += chunk));
  const heldPromise = new Promise((resolveClose) => holder.on("close", (code) => resolveClose({ code, out: holderOut })));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if (JSON.parse(readFileSync(lockPath, "utf8")).pid === holder.pid) break;
    } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  const contendedAt = Date.now();
  let contendedError = null;
  try {
    parentActivity("contended", { lockTimeoutMs: 300 });
  } catch (err) {
    contendedError = err;
  }
  assert.equal(contendedError?.code, "lock-contention", "bounded contention fails explicitly");
  assert.ok(Date.now() - contendedAt < 4000, "contention failure is bounded");
  assert.match(contendedError.message, new RegExp(`pid ${holder.pid} \\(alive\\)`), "the error names the live owner");
  assert.doesNotMatch(contendedError.message, /unreadable or ownerless/, "a live owner is not confused with an unreadable one");
  const held = await Promise.race([
    heldPromise,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout({ code: "timeout", out: holderOut }), 8000)),
  ]);
  assert.equal(held.code, 0, `the holder child finished cleanly: ${holderOut}`);
  assert.equal(parentActivity("after release").committed, true, "the lock is usable once the owner releases");

  // A provably dead owner is stolen automatically.
  const gone = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  writeFileSync(lockPath, `${JSON.stringify({ token: "stale-token", pid: gone.pid, startTicks: "12345", cmdlineHash: "deadbeefdeadbeef", acquiredAt: 1 })}\n`);
  assert.equal(parentActivity("stolen").committed, true, "a dead owner's lock is recovered automatically");

  // An ownerless/unparseable lock is NEVER stolen and never times out into a
  // steal: contention fails explicitly and only breakWriterLock clears it.
  writeFileSync(lockPath, "not json at all");
  let unreadableError = null;
  try {
    parentActivity("x", { lockTimeoutMs: 250 });
  } catch (err) {
    unreadableError = err;
  }
  assert.equal(unreadableError?.code, "lock-contention", "an unreadable lock owner is never stolen");
  assert.match(unreadableError.message, /unreadable or ownerless/);
  assert.match(unreadableError.message, /breakWriterLock/, "the error names the explicit recovery path");

  const liveFingerprint = processFingerprint({ pid: process.pid });
  assert.ok(liveFingerprint, "this platform exposes /proc fingerprints (Linux)");
  writeFileSync(lockPath, `${JSON.stringify({ token: "live-token", pid: process.pid, startTicks: liveFingerprint.startTicks, cmdlineHash: liveFingerprint.cmdlineHash, acquiredAt: 1 })}\n`);
  assertCode(() => breakWriterLock({ stateDir: dir, changeId: "lock-1" }), "lock-contention", "breakWriterLock refuses a live, matching owner");
  writeFileSync(lockPath, `${JSON.stringify({ token: "ownerless" })}\n`); // no PID at all
  assert.deepEqual(breakWriterLock({ stateDir: dir, changeId: "lock-1" }), { removed: true, owner: { token: "ownerless" } }, "an ownerless lock is removed on explicit request");
  assert.deepEqual(breakWriterLock({ stateDir: dir, changeId: "lock-1" }), { removed: false, owner: null }, "breaking a missing lock is a no-op");
  assert.equal(parentActivity("after break").committed, true, "the record is writable again after the explicit break");

  // Reopen/recovery consistency: a fresh handle sees the same truth.
  const reopened = openChange({ stateDir: dir, changeId: "lock-1" });
  assert.deepEqual(reopened.snapshot().watermark, handle.snapshot().watermark, "reopen converges on the committed watermark");
  assert.equal(JSON.stringify(reopened.views.job("job-1")), JSON.stringify(handle.views.job("job-1")), "reopen equals the live handle's views");
}

// ---------------------------------------------------------------------------
// S9. Independent writer processes: racing appends stay ordered and complete,
// duplicate command races yield one event, conflicting payloads are rejected.
// ---------------------------------------------------------------------------

{
  const dir = join(root, "s9-state");
  const setup = createChange({ stateDir: dir, changeId: "race-1", actor: RUNTIME, commandId: "create-r1" });
  seedReady(setup, { jobId: "job-r", attemptId: "att-r" });

  // Six concurrently started writers, four appends each: the record must hold
  // every acknowledged event, in one valid order, with no gaps.
  const racers = await runChildren("activity", Array.from({ length: 6 }, (_, i) => [dir, "race-1", "job-r", "att-r", `w${i}`, "4"]));
  const acknowledged = [];
  for (const child of racers) {
    const report = jsonOut(child);
    assert.ok(report.events.every((event) => event.committed), "each racer committed its own commands");
    acknowledged.push(...report.events);
  }
  assert.equal(acknowledged.length, 24, "every child acknowledged four events");
  const final = openChange({ stateDir: dir, changeId: "race-1" });
  const all = final.readEvents({ limit: 10_000 });
  const byCommand = new Map(all.events.map((env) => [env.command.id, env.seq]));
  const byEventId = new Map(all.events.map((env) => [env.eventId, env.seq]));
  for (const event of acknowledged) {
    assert.equal(byCommand.get(event.commandId), event.seq, `acknowledged event ${event.commandId} is durable at its acknowledged sequence`);
    assert.equal(byEventId.get(event.eventId), event.seq, "acknowledged event IDs match the durable record");
  }
  assert.equal(all.watermark.tornTailBytes, 0, "no torn tail survived the races");
  const seqs = all.events.map((env) => env.seq);
  assert.deepEqual(seqs, seqs.map((_, index) => index + 1), "sequences are dense and ordered");
  const replayed = reduceEvents(all.events, { changeId: "race-1" });
  assert.equal(replayed.lastSeq, 29, "replay reduces the full raced history");
  assert.equal(JSON.stringify(viewsFor(replayed).job("job-r")), JSON.stringify(final.views.job("job-r")), "full replay equals selective views after the race");

  // Duplicate command races: N processes, one command ID, identical input —
  // exactly one event, every caller succeeds, all see the same result.
  const dupRacers = await runChildren("dup", Array.from({ length: 5 }, () => [dir, "race-1", "job-r", "att-r", "race-dup"]));
  const dupReports = dupRacers.map(jsonOut);
  assert.equal(dupReports.filter((report) => report.committed).length, 1, "exactly one racer committed the command");
  assert.ok(dupReports.every((report) => report.seq === dupReports[0].seq), "every racer observed the same original result");
  const dupEvents = final.readEvents({ limit: 10_000 }).events.filter((env) => env.command.id === "race-dup");
  assert.equal(dupEvents.length, 1, "the record contains exactly one event for the duplicated command");

  // Conflicting duplicate payloads: at most one winner, the losers fail
  // loudly, and the record stays valid.
  const conflictRacers = await runChildren("conflict", [
    [dir, "race-1", "job-r", "att-r", "race-conflict", "note-A"],
    [dir, "race-1", "job-r", "att-r", "race-conflict", "note-B"],
  ]);
  const winners = conflictRacers.filter((child) => child.status === 0);
  const losers = conflictRacers.filter((child) => child.status !== 0);
  assert.equal(winners.length, 1, "exactly one conflicting racer committed");
  assert.equal(losers.length, 1);
  assert.match(losers[0].err, /command-conflict/, "the loser failed with a command conflict, not silent divergence");
  const winnerReport = jsonOut(winners[0]);
  const conflictEvents = final.readEvents({ limit: 10_000 }).events.filter((env) => env.command.id === "race-conflict");
  assert.equal(conflictEvents.length, 1, "exactly one event carries the contested command ID");
  assert.equal(conflictEvents[0].payload.note, winnerReport.note, "the surviving event is the winner's input");
  assert.equal(conflictEvents[0].seq, winnerReport.seq, "the winner's acknowledged sequence matches the record");

  // Concurrent creation: racing createChange with one command ID yields one
  // change.created event and four healthy handles.
  const dir2 = join(root, "s9b-state");
  const creators = await runChildren("create", Array.from({ length: 4 }, () => [dir2, "race-create", "create-race"]));
  for (const child of creators) jsonOut(child);
  const created = openChange({ stateDir: dir2, changeId: "race-create" });
  const createdEvents = created.readEvents({ limit: 10 }).events;
  assert.equal(createdEvents.length, 1, "exactly one creation event survived the race");
  assert.equal(createdEvents[0].kind, "change.created");
}

// ---------------------------------------------------------------------------
// S10. Full replay equals selective views at a common watermark, for the whole
// vocabulary at once.
// ---------------------------------------------------------------------------

{
  const dir = join(root, "s10-state");
  const handle = createChange({ stateDir: dir, changeId: "equiv-1", actor: RUNTIME, commandId: "create-e1" });
  handle.append("assignment.revised", { revision: 1, predecessor: null, scope: { kind: "change" }, assignment: { model: "deepseek" } }, { context: ctx() });
  handle.append("job.registered", { role: "implementer", pinnedRevision: 1 }, { context: ctx({ jobId: "job-1" }) });
  handle.append("job.registered", { role: "reviewer", pinnedRevision: 1 }, { context: ctx({ jobId: "job-2" }) });
  handle.append("assignment.revised", { revision: 2, predecessor: 1, scope: { kind: "job", jobId: "job-2" }, assignment: { model: "glm" } }, { context: ctx() });
  for (const [jobId, attemptId] of [["job-1", "e1"], ["job-2", "e2"]]) {
    handle.append("attempt.launch_intent", {}, { context: ctx({ jobId, attemptId }) });
    handle.append("attempt.started", { identity: attemptId }, { context: ctx({ jobId, attemptId }) });
    handle.append("worker.acknowledged", { revision: jobId === "job-2" ? 2 : 1 }, { context: workerCtx({ jobId, attemptId }) });
    handle.append("worker.progress", { note: `progress ${attemptId}` }, { context: workerCtx({ jobId, attemptId }) });
    handle.append("worker.blocker", { note: `blocked ${attemptId}` }, { context: workerCtx({ jobId, attemptId }) });
    handle.append("attempt.activity", { note: `activity ${attemptId}` }, { context: ctx({ jobId, attemptId }) });
  }
  handle.append("attempt.outcome", { status: "completed", summary: "one" }, { context: ctx({ jobId: "job-1", attemptId: "e1" }) });
  handle.append("amendment.submitted", { amendmentId: "am-e", revision: 2 }, { context: ctx({ jobId: "job-2", attemptId: "e2" }) });

  const all = handle.readEvents({ limit: 10_000 });
  const replayed = reduceEvents(all.events, { changeId: "equiv-1" });
  assert.equal(replayed.lastSeq, handle.state.lastSeq, "replay reaches the same watermark");
  const replayViews = viewsFor(replayed);
  assert.deepEqual(replayViews.job("job-1"), handle.views.job("job-1"), "job view: replay equals live handle");
  assert.deepEqual(replayViews.job("job-2"), handle.views.job("job-2"));
  assert.deepEqual(replayViews.jobs(), handle.views.jobs(), "job list: replay equals live handle");
  assert.deepEqual(replayViews.attempt("job-1", "e1"), handle.views.attempt("job-1", "e1"));
  assert.deepEqual(replayViews.attempt("job-2", "e2"), handle.views.attempt("job-2", "e2"));
  assert.deepEqual(replayViews.assignment(), handle.views.assignment());
  assert.deepEqual(replayViews.assignment({ scope: { kind: "job", jobId: "job-2" } }), handle.views.assignment({ scope: { kind: "job", jobId: "job-2" } }));
  assert.deepEqual(replayViews.pendingAmendments(), handle.views.pendingAmendments());
  assert.deepEqual(replayViews.reconciliations(), handle.views.reconciliations());

  // Every prefix of the history is independently valid: sequence — not
  // timestamp — orders events, and replay never depends on the tail.
  for (let cut = 1; cut <= all.events.length; cut += 1) {
    const prefix = reduceEvents(all.events.slice(0, cut), { changeId: "equiv-1" });
    assert.equal(prefix.lastSeq, cut, `prefix of ${cut} events replays cleanly`);
  }
  // Timestamps are informational only: out-of-order clocks do not reorder.
  const reordered = [...all.events.slice(0, -1), { ...all.events.at(-1), at: 1 }];
  assert.equal(reduceEvents(reordered, { changeId: "equiv-1" }).lastSeq, all.events.length, "a backdated timestamp does not change the order");
}

console.log("change-record tests passed");
