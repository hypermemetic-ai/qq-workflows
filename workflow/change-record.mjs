// Durable change records: one append-only event log per change, with a pure
// reducer, selective views, cross-process append serialization, and explicit
// recovery. This is the foundation for one durable history of amendments and
// acknowledgements; it is dormant until a later dispatch integrates the
// runtime, and it deliberately contains no transport, process launching, or
// Git behavior.
//
// Storage contract
// ----------------
// One record file per change: `<stateDir>/changes/<changeId>.jsonl`, mode
// 0600, inside a directory created with mode 0700. A change record contains
// ALL of its jobs and attempts. The change ID is caller-chosen and stable: it
// never derives from a model, session, process, or worktree, so the same
// change has one record across restarts and machines.
//
// Frame format
// ------------
// Each line is one committed event, framed as:
//
//     <jsonByteLength> <sha256(jsonBytes)> <json>\n
//
// The JSON is the versioned event envelope:
//
//     { schema, changeId, seq, eventId, command: { id, digest }, actor,
//       kind, jobId, attemptId, at, payload }
//
// - `schema` is the envelope schema version; unknown versions and unknown
//   kinds are rejected, never silently applied.
// - `seq` orders events. `at` is an informational timestamp and NEVER orders.
// - `command.digest` is sha256 over the canonical JSON of the caller's logical
//   input (kind, actor, job/attempt identity, payload — before sequence,
//   event ID, timestamp, or large-text splitting). It is what idempotent
//   retries are compared against, because those generated fields cannot be
//   reconstructed from the envelope alone.
// - The frame prefix is the integrity/framing information: a line whose byte
//   length or checksum does not match its declaration is corrupt.
//
// Reads, snapshots, and the committed boundary
// --------------------------------------------
// A reader never takes the writer lock. Its synchronization boundary is the
// last COMPLETE framed line: bytes after it (a final append still in
// progress, or a torn write) are not committed and are ignored by readers.
// The sequence watermark is the `seq` of the last complete frame. A complete,
// checksum-valid line is committed even if its writer crashed before
// acknowledging; idempotent retries make that visible to the caller.
//
// Append protocol
// ---------------
// Appends serialize across INDEPENDENT PROCESSES with an O_EXCL lock file
// (`<record>.lock`, mode 0600) holding an owner fingerprint. Node exposes no
// flock(2)/fcntl binding (verified on Node 26), so a runtime lock file is the
// coordination artifact; it is not a second state store. Platform honesty:
// this is correct on local POSIX filesystems (Linux/macOS local
// ext4/xfs/apfs/tmpfs). It is NOT correct on network filesystems (NFS/SMB)
// where O_EXCL semantics are unreliable, and PID liveness uses /proc on Linux
// (elsewhere the fingerprint is null and dead-owner recovery is disabled
// rather than guessed).
//
// Lock ownership rules:
// - Acquisition is bounded (`lockTimeoutMs`); a merely slow LIVE owner is
//   never stolen — contention past the deadline fails explicitly with the
//   owner's identity.
// - A stale lock is stolen only when its owner process is provably dead
//   (PID gone, or PID reused — recorded start ticks/cmdline hash no longer
//   match /proc). An unreadable or incomplete lock owner is never stolen.
// - An ownerless or unparseable lock (zero bytes, a torn owner write, no PID)
//   proves nothing about liveness, so it is never stolen automatically and
//   contention never decays into a steal. It fails explicitly, and the
//   operator recovers with `breakWriterLock` — an explicit entry point that
//   removes such a lock and refuses one whose owner parses and is a live,
//   matching process. Manually deleting the lock file remains possible but is
//   the operator's own unchecked action.
// - Steal is a verified rename to a tombstone (inode checked before and
//   after); the new owner re-verifies its token under the lock on every
//   append. The residual race (two processes stealing the same dead owner
//   simultaneously) is narrowed to a sub-millisecond window by the pre-write
//   token check and, if it were ever hit, produces a detectable duplicate
//   sequence — an interior validation error, never silent loss.
//
// Under the lock the writer: refreshes from the file (other processes' events
// are applied first), validates the caller's expected assignment revision /
// attempt phase and the proposed transition against the committed state via
// the reducer, then writes each event as one `writeSync` (looping over short
// writes) and `fsync`s the file before returning durable success. Creating
// the record file also fsyncs its directory.
//
// The proposed event group is applied to a scratch copy of the state exactly
// once, before any byte is written; the validated copy becomes the cached
// state only after the durable write. A rejected transition therefore writes
// nothing, and a successful return cannot diverge from durable state. The
// `inject` append option is a fault-injection seam for tests (`beforeWrite`,
// `beforeFrame`, `beforeSync`, `holdLockMs`); production callers pass none.
//
// Recovery semantics (exact)
// --------------------------
// Every frame buffer ends with its own newline and is written start-to-end in
// order, so a writer that dies mid-append can only leave a strict PREFIX of a
// frame at EOF — bytes after the last newline (frame JSON never contains a raw
// newline). Such a trailing segment is uncommitted BY CONSTRUCTION: no
// complete frame can be missing its newline while later bytes exist. It is
// discarded — under exclusive writer ownership, which every append holds and
// `recoverChange` takes explicitly — by truncating to the end of the last
// complete frame. A newline-terminated line, by contrast, always carries a
// whole frame: if its declared length, checksum, or envelope shape do not
// validate, the record is CORRUPT (bit rot or external damage, never a torn
// append): reads and appends fail hard and the file is never modified by this
// module in that case. No complete event is ever discarded. Interior
// corruption and complete malformed events can only be repaired by an operator
// who has established what happened; this module refuses to guess.
//
// A complete durable event may survive a crash that struck before its caller
// received acknowledgement (bytes written and complete, caller never told):
// replay treats it as committed and an idempotent retry returns it instead of
// duplicating it. The reverse never happens: acknowledgement implies fsync.
//
// Identity and idempotency
// ------------------------
// The trusted actor/job/attempt context is a SEPARATE API argument from the
// requested payload. Payload keys that would impersonate the envelope
// identity are rejected (identity-spoofing boundary for later tool
// authorization — this is application-layer validation, not OS sandboxing).
// Reusing a command ID with identical semantic input returns the original
// result without another event (completing any missing large-text
// continuation parts); the same ID with different input fails. Generated
// fields (sequence, event ID, timestamp) are excluded from the comparison.
// Creation is idempotent the same way: `createChange` may retry or race
// (concurrent creators meet O_EXCL EEXIST and fall through to the same
// idempotent `change.created` append), so exactly one creation event exists
// and every caller with the same command ID and actor observes one record.
//
// Large text
// ----------
// Registered text fields larger than TEXT_CHUNK_CHARS are split: the primary
// event carries the first chunk plus a `textContinuation` marker, and
// `text.continued` events carry the remaining chunks, all appended atomically
// under one lock acquisition and one fsync. Views reassemble the text and
// mark it `complete: false` with the missing parts listed when continuations
// are absent — a partial assignment/result is never presented as complete.
//
// Non-goals
// ---------
// Raw provider transcripts and large binary artifacts stay OUT of the record;
// a payload may carry a typed evidence reference (path/hash), which this
// module stores verbatim and never fetches. No remote transport, no process
// launching, no Git side effects, no caches of truth: the only mutable
// in-memory artifact is the rebuildable reduced state, and deleting it cannot
// change what the file says.

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";

import { isProcessAlive, processFingerprint } from "./jobs.mjs";

export const SCHEMA_VERSION = 1;

export const EVENT_KINDS = Object.freeze([
  "change.created",
  "assignment.revised",
  "job.registered",
  "attempt.launch_intent",
  "attempt.started",
  "attempt.activity",
  "worker.progress",
  "worker.blocker",
  "attempt.cancel_intent",
  // Receiver admission closure (runner communication runtime): after this
  // event the attempt's relay receiver no longer admits new amendment
  // deliveries. Serialization is the point: a submission appended after the
  // closure is refused, so a late accepted submission can never disappear as a
  // successful delivery. Records written before this kind existed replay
  // unchanged (the kind simply never appears in them).
  "attempt.admission_closed",
  // Landing admission (managed executions): the serialized irreversible
  // landing boundary. Once committed for an attempt, a cancellation intent for
  // that attempt is refused (truthful refusal — landing cannot be implied
  // rolled back) and no further pipeline stage is admitted before it. The
  // record serializes this boundary with cancellation and update state through
  // its own writer lock; there is no second authority.
  "attempt.landing_admitted",
  // Durable evidence link (reports, late results, role findings) for an
  // attempt at ANY phase — including after cancellation or a validated
  // outcome. Evidence never changes the outcome: a cancelled attempt stays
  // cancelled while its late report/landing evidence stays retrievable.
  "attempt.evidence",
  "attempt.outcome",
  "amendment.submitted",
  // Transport-push bookkeeping for one admitted amendment: the relay event id
  // and the observed transport status of a push attempt. This is delivery
  // CORRELATION durably in the authoritative record (so a parent restart can
  // inspect and retry a recorded-but-unsent update without re-recording
  // anything); it never advances acknowledgement — only worker.acknowledged
  // does. Records written before this kind existed replay unchanged.
  "amendment.pushed",
  "amendment.accepted",
  "worker.acknowledged",
  // ADR source evidence + curation obligation seam. Subordinate immutable
  // evidence blobs (the ADR source manifest) are referenced, never fetched;
  // these events are the workflow authority for the post-landing curation
  // obligation. `adr.source_manifest` stages retained source evidence before
  // the destructive ticket reset/worktree retirement, `adr.source_completion`
  // fills explicit pending/missing references idempotently after landing or
  // archival, and `adr.curation_obligation` records the post-landing
  // disposition (pending curation, explicit no-source-change, or validated
  // suppression). Records written before these kinds existed replay unchanged.
  "adr.source_manifest",
  "adr.source_completion",
  "adr.curation_obligation",
  "text.continued",
]);

export const ACTOR_KINDS = Object.freeze(["runtime", "worker", "operator"]);
export const JOB_ROLES = Object.freeze(["runner", "implementer", "reviewer", "execution"]);
export const OUTCOME_STATUSES = Object.freeze(["completed", "failed", "cancelled"]);

// Payload keys that would impersonate envelope identity are reserved.
const RESERVED_PAYLOAD_KEYS = Object.freeze([
  "schema", "changeId", "seq", "eventId", "command", "actor", "kind", "jobId",
  "attemptId", "at", "payload", "textContinuation",
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ACTOR_ID_PATTERN = /^[\w.@:/+-]{1,200}$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;
const FRAME_PREFIX_PATTERN = /^([0-9]{1,10}) ([0-9a-f]{64}) /;

// A single event line may not exceed this; registered text fields larger than
// TEXT_CHUNK_CHARS are split into continuation events instead.
export const FRAME_MAX_BYTES = 1_048_576;
export const TEXT_CHUNK_CHARS = 8_192;
export const MAX_TEXT_PARTS = 4_096;

// Which payload fields may be auto-split into continuations, per kind. Paths
// are dot-separated and rooted at the event payload.
export const LARGE_TEXT_FIELDS = Object.freeze({
  "change.created": ["title"],
  // A revision carries BOTH the full assignment text and (for an amendment
  // revision) the coordinator's raw instruction: both are splittable.
  "assignment.revised": ["assignment.instructions", "note"],
  "job.registered": ["note"],
  "attempt.launch_intent": ["note"],
  "attempt.started": ["note"],
  "attempt.activity": ["note"],
  "worker.progress": ["note"],
  "worker.blocker": ["note"],
  "attempt.cancel_intent": ["reason"],
  "attempt.landing_admitted": ["note"],
  "attempt.evidence": ["note"],
  "attempt.outcome": ["summary", "result"],
  "amendment.submitted": ["note"],
  "amendment.pushed": [],
  "amendment.accepted": ["note"],
  "worker.acknowledged": ["note"],
  "adr.source_manifest": ["note"],
  "adr.source_completion": ["note"],
  "adr.curation_obligation": ["note"],
});

// Which trusted identity fields each kind requires on the envelope.
const KIND_ID_REQUIREMENTS = Object.freeze({
  "change.created": {},
  "assignment.revised": {},
  "job.registered": { jobId: true },
  "attempt.launch_intent": { jobId: true, attemptId: true },
  "attempt.started": { jobId: true, attemptId: true },
  "attempt.activity": { jobId: true, attemptId: true },
  "worker.progress": { jobId: true, attemptId: true },
  "worker.blocker": { jobId: true, attemptId: true },
  "attempt.cancel_intent": { jobId: true, attemptId: true },
  "attempt.admission_closed": { jobId: true, attemptId: true },
  "attempt.landing_admitted": { jobId: true, attemptId: true },
  "attempt.evidence": { jobId: true, attemptId: true },
  "attempt.outcome": { jobId: true, attemptId: true },
  "amendment.submitted": { jobId: true, attemptId: true },
  "amendment.pushed": { jobId: true, attemptId: true },
  "amendment.accepted": { jobId: true, attemptId: true },
  "worker.acknowledged": { jobId: true, attemptId: true },
  "adr.source_manifest": { jobId: true, attemptId: true },
  "adr.source_completion": { jobId: true, attemptId: true },
  "adr.curation_obligation": { jobId: true, attemptId: true },
  "text.continued": {},
});

// Which actor kinds may author each kind. Worker findings are evidence, never
// authority: a worker cannot author assignments, registrations, validated
// outcomes, or amendment delivery.
const KIND_ACTORS = Object.freeze({
  "change.created": ["runtime", "operator"],
  "assignment.revised": ["runtime", "operator"],
  "job.registered": ["runtime", "operator"],
  "attempt.launch_intent": ["runtime", "operator"],
  "attempt.started": ["runtime"],
  "attempt.activity": ["runtime", "operator"],
  "worker.progress": ["worker"],
  "worker.blocker": ["worker"],
  "attempt.cancel_intent": ["runtime", "operator"],
  "attempt.admission_closed": ["runtime", "operator"],
  "attempt.landing_admitted": ["runtime", "operator"],
  "attempt.evidence": ["runtime", "operator"],
  "attempt.outcome": ["runtime", "operator"],
  "amendment.submitted": ["runtime", "operator"],
  "amendment.pushed": ["runtime", "operator"],
  "amendment.accepted": ["runtime", "operator"],
  "worker.acknowledged": ["worker"],
  // Curation evidence and obligations are runtime/operator authored only: a
  // worker can never stage its own source evidence or schedule its own
  // curation disposition.
  "adr.source_manifest": ["runtime", "operator"],
  "adr.source_completion": ["runtime", "operator"],
  "adr.curation_obligation": ["runtime", "operator"],
  "text.continued": ["runtime", "worker", "operator"],
});

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 20;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function assertIdentifier(value, name) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw fail("invalid-identifier", `${name} must match ${ID_PATTERN} (got ${JSON.stringify(value ?? null)})`);
  }
  return value;
}

// Exported for the communication runtime's binding validation: the same actor
// identity contract applies to trusted contexts supplied through environment
// bindings, not only to append-time contexts.
export function assertActorId(value) {
  if (typeof value !== "string" || !ACTOR_ID_PATTERN.test(value)) {
    throw fail("invalid-identifier", `actor id must match ${ACTOR_ID_PATTERN}`);
  }
  return value;
}

// Payloads must survive a JSON round trip unchanged, otherwise idempotency
// digests and checksums would not be reproducible.
function assertJsonSafe(value, path, depth = 0) {
  if (depth > 32) throw fail("invalid-payload", `payload at '${path}' is nested too deeply`);
  if (value === null || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw fail("invalid-payload", `payload at '${path}' is not a finite number`);
    return;
  }
  if (typeof value === "boolean") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSafe(item, `${path}[${index}]`, depth + 1));
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw fail("invalid-payload", `payload at '${path}' must be a plain JSON value`);
  }
  for (const key of Object.keys(value)) assertJsonSafe(value[key], `${path}.${key}`, depth + 1);
}

// Canonical JSON: sorted object keys, so an identical logical input always
// produces an identical digest regardless of key order.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeFull(fd, buffer, position) {
  let written = 0;
  while (written < buffer.length) {
    const n = writeSync(fd, buffer, written, buffer.length - written, position + written);
    if (n <= 0) throw fail("io-error", `short write at offset ${position + written}`);
    written += n;
  }
}

function fsyncDirBestEffort(dir) {
  let fd = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is best-effort across platforms; the record file fsync
    // is the durability boundary for event bytes.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function normalizeTimestamp(now) {
  const at = now === undefined ? Date.now() : now;
  if (!Number.isInteger(at) || at < 0) throw fail("invalid-timestamp", `timestamp must be a non-negative integer`);
  return at;
}

// ---------------------------------------------------------------------------
// Paths and containment
// ---------------------------------------------------------------------------

export function changesDir(stateDir) {
  return join(stateDir, "changes");
}

export function changeRecordPath(stateDir, changeId) {
  assertIdentifier(changeId, "changeId");
  const path = join(changesDir(stateDir), `${changeId}.jsonl`);
  // Containment: the ID charset already forbids separators, so assert it.
  const root = resolve(stateDir);
  const resolved = resolve(path);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw fail("invalid-identifier", `record path escapes the state directory`);
  }
  return path;
}

function ensureRecordDir(stateDir) {
  const dir = changesDir(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // umask-proof
  return dir;
}

// ---------------------------------------------------------------------------
// Frame encoding, scanning, and structural envelope validation
// ---------------------------------------------------------------------------

function encodeFrame(env) {
  const jsonBytes = Buffer.from(JSON.stringify(env), "utf8");
  if (jsonBytes.length > FRAME_MAX_BYTES) {
    throw fail(
      "frame-too-large",
      `event serializes to ${jsonBytes.length} bytes (limit ${FRAME_MAX_BYTES}); use a registered large-text field so it is split into continuations`,
    );
  }
  const digest = sha256Hex(jsonBytes);
  return Buffer.concat([Buffer.from(`${jsonBytes.length} ${digest} `, "utf8"), jsonBytes, Buffer.from("\n", "utf8")]);
}

// Scans a whole record buffer into frames. Returns the committed frames, the
// byte offset where a torn final segment begins (if any), and the first hard
// error (complete-but-malformed or checksum-invalid line, or framing
// corruption), which stops the scan.
function scanFrames(buffer) {
  const frames = [];
  let pos = 0;
  while (pos < buffer.length) {
    const newline = buffer.indexOf(0x0a, pos);
    if (newline === -1) return { frames, tornStart: pos, error: null };
    const line = buffer.subarray(pos, newline);
    const parsed = parseFrameLine(line);
    if (parsed.error) return { frames, tornStart: null, error: parsed.error };
    frames.push({ env: parsed.env, start: pos, end: newline + 1 });
    pos = newline + 1;
  }
  return { frames, tornStart: null, error: null };
}

function parseFrameLine(line) {
  const head = line.toString("latin1", 0, Math.min(line.length, 96));
  const match = FRAME_PREFIX_PATTERN.exec(head);
  if (!match) {
    return { error: fail("frame-corrupt", "complete line without a valid '<length> <sha256> ' frame prefix") };
  }
  const declared = Number(match[1]);
  const prefixLen = match[0].length;
  const jsonBytes = line.subarray(prefixLen);
  if (jsonBytes.length !== declared) {
    return {
      error: fail(
        "frame-corrupt",
        `frame declares ${declared} payload bytes but the complete line carries ${jsonBytes.length}`,
      ),
    };
  }
  if (sha256Hex(jsonBytes) !== match[2]) {
    return { error: fail("frame-corrupt", "complete line failed its sha256 integrity check") };
  }
  let env;
  try {
    env = JSON.parse(jsonBytes.toString("utf8"));
  } catch (err) {
    return { error: fail("invalid-event", `complete line is not valid JSON: ${err.message}`) };
  }
  const problem = validateEnvelopeShape(env);
  if (problem) return { error: problem };
  return { env };
}

function validateEnvelopeShape(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) return fail("invalid-event", "envelope is not an object");
  if (env.schema !== SCHEMA_VERSION) {
    return fail("unknown-schema", `envelope schema ${JSON.stringify(env.schema)} is unknown; supported schema is ${SCHEMA_VERSION}`);
  }
  if (typeof env.changeId !== "string" || !ID_PATTERN.test(env.changeId)) return fail("invalid-event", "envelope changeId is invalid");
  if (!Number.isInteger(env.seq) || env.seq < 1) return fail("invalid-event", "envelope seq must be a positive integer");
  if (typeof env.eventId !== "string" || !ID_PATTERN.test(env.eventId)) return fail("invalid-event", "envelope eventId is invalid");
  if (!env.command || typeof env.command !== "object") return fail("invalid-event", "envelope command is missing");
  if (typeof env.command.id !== "string" || !ID_PATTERN.test(env.command.id)) return fail("invalid-event", "envelope command id is invalid");
  if (typeof env.command.digest !== "string" || !SHA_PATTERN.test(env.command.digest)) return fail("invalid-event", "envelope command digest is invalid");
  if (!env.actor || typeof env.actor !== "object") return fail("invalid-event", "envelope actor is missing");
  if (!ACTOR_KINDS.includes(env.actor.kind)) return fail("invalid-event", `envelope actor kind ${JSON.stringify(env.actor.kind)} is unknown`);
  if (typeof env.actor.id !== "string" || !ACTOR_ID_PATTERN.test(env.actor.id)) return fail("invalid-event", "envelope actor id is invalid");
  if (!EVENT_KINDS.includes(env.kind)) return fail("unknown-kind", `event kind ${JSON.stringify(env.kind)} is unknown; it is not applied`);
  if (!Number.isInteger(env.at) || env.at < 0) return fail("invalid-event", "envelope at must be a non-negative integer");
  if (env.jobId !== null && env.jobId !== undefined && (typeof env.jobId !== "string" || !ID_PATTERN.test(env.jobId))) {
    return fail("invalid-event", "envelope jobId is invalid");
  }
  if (env.attemptId !== null && env.attemptId !== undefined && (typeof env.attemptId !== "string" || !ID_PATTERN.test(env.attemptId))) {
    return fail("invalid-event", "envelope attemptId is invalid");
  }
  if (!env.payload || typeof env.payload !== "object" || Array.isArray(env.payload)) {
    return fail("invalid-event", "envelope payload must be an object");
  }
  if (env.payload.textContinuation !== undefined) {
    if (!Array.isArray(env.payload.textContinuation) || env.payload.textContinuation.length === 0) {
      return fail("invalid-event", "textContinuation must be a non-empty array");
    }
    for (const marker of env.payload.textContinuation) {
      if (!marker || typeof marker !== "object") return fail("invalid-event", "textContinuation marker must be an object");
      if (typeof marker.textId !== "string" || !ID_PATTERN.test(marker.textId)) return fail("invalid-event", "textContinuation textId is invalid");
      if (typeof marker.field !== "string" || !marker.field) return fail("invalid-event", "textContinuation field is invalid");
      if (!Number.isInteger(marker.parts) || marker.parts < 2 || marker.parts > MAX_TEXT_PARTS) {
        return fail("invalid-event", `textContinuation parts must be an integer in [2, ${MAX_TEXT_PARTS}]`);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dotted-path helpers for large-text splitting
// ---------------------------------------------------------------------------

function getAtPath(obj, path) {
  let node = obj;
  for (const key of path.split(".")) {
    if (node === null || typeof node !== "object" || !(key in node)) return undefined;
    node = node[key];
  }
  return node;
}

function setAtPath(obj, path, value) {
  const keys = path.split(".");
  let node = obj;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    if (node[key] === null || typeof node[key] !== "object") node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

function splitTextIntoChunks(text) {
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += TEXT_CHUNK_CHARS) {
    chunks.push(text.slice(offset, offset + TEXT_CHUNK_CHARS));
  }
  return chunks;
}

// Splits every registered large-text field that exceeds the chunk cap. Returns
// the transport payload (chunk 0 inline plus markers) and the per-marker
// chunks needed to build continuation events. The caller's payload object is
// never mutated: an idempotent retry must be able to re-derive the identical
// digest and chunks from the same object it originally passed.
function splitLargeTextFields(kind, payload) {
  const eligible = LARGE_TEXT_FIELDS[kind];
  if (!eligible) return { payload, splits: null, chunkSets: null };
  let transport = null;
  const splits = [];
  const chunkSets = [];
  for (const field of eligible) {
    const value = getAtPath(payload, field);
    if (typeof value !== "string" || value.length <= TEXT_CHUNK_CHARS) continue;
    const chunks = splitTextIntoChunks(value);
    if (chunks.length > MAX_TEXT_PARTS) {
      // Checked here, at build time: an envelope that only the replay scan
      // would reject would create a record that can never be reopened.
      throw fail(
        "text-too-large",
        `text field '${field}' splits into ${chunks.length} parts (limit ${MAX_TEXT_PARTS}); shorten it or store it outside the record as an evidence reference`,
      );
    }
    if (!transport) transport = structuredClone(payload);
    const textId = randomUUID();
    setAtPath(transport, field, chunks[0]);
    splits.push({ textId, field, parts: chunks.length });
    chunkSets.push(chunks);
  }
  if (!splits.length) return { payload, splits: null, chunkSets: null };
  transport.textContinuation = splits;
  return { payload: transport, splits, chunkSets };
}

function continuationCommandId(commandId, markerIndex, part) {
  return `${commandId}-c${markerIndex}-p${part}`;
}

// ---------------------------------------------------------------------------
// Pure reducer
// ---------------------------------------------------------------------------

export function emptyState(changeId) {
  return {
    changeId,
    createdAt: null,
    lastSeq: 0,
    currentRevision: 0,
    changeRevision: 0,
    revisions: [], // index revision-1: { revision, scope, at, seq, payload, splits }
    jobs: {}, // jobId -> job
    jobOrder: [],
    texts: {}, // textId -> { textId, kind, field, parts, commandId, chunks }
    eventIds: {}, // eventId -> seq
    commandIndex: {}, // commandId -> { seq, eventId, digest, splits }
    // ADR source evidence + curation obligation seam (subordinate blobs are
    // referenced from `evidence`, never fetched by this module).
    adr: {
      manifests: {}, // manifestId -> staged manifest entry
      manifestOrder: [],
      obligations: {}, // operationId -> curation obligation entry
      obligationOrder: [],
    },
  };
}

// ADR source/curation vocabulary (validated exactly; unknown values are
// rejected, never silently applied).
export const ADR_REF_STATUSES = Object.freeze(["retained", "pending", "missing"]);
export const ADR_OBLIGATION_STATUSES = Object.freeze(["pending", "no-change", "suppressed"]);
export const ADR_LANDING_METHODS = Object.freeze(["pr", "ff", "none"]);
export const ADR_SUPPRESSION_BASES = Object.freeze(["adr-roots", "trusted-opt-out"]);
// A manifest explicitly tracks these references; an absent required reference
// is an explicit pending/missing entry, so complete evidence is never declared
// while one of them is not retained.
export const ADR_REQUIRED_REFS = Object.freeze([
  "ticket", "provenance", "constraints", "amendments", "roleReports", "landingReceipt",
]);

function assertAdrRefEntry(name, entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw fail("invalid-event", `ADR ref '${name}' must be an object with an explicit status`);
  }
  if (!ADR_REF_STATUSES.includes(entry.status)) {
    throw fail("invalid-event", `ADR ref '${name}' status ${JSON.stringify(entry.status)} is unknown (allowed: ${ADR_REF_STATUSES.join(", ")})`);
  }
  for (const field of ["reportId", "path", "sha256", "reason"]) {
    if (entry[field] !== undefined && entry[field] !== null && typeof entry[field] !== "string") {
      throw fail("invalid-event", `ADR ref '${name}'.${field} must be a string or null`);
    }
  }
  if (entry.bytes !== undefined && entry.bytes !== null && (!Number.isInteger(entry.bytes) || entry.bytes < 0)) {
    throw fail("invalid-event", `ADR ref '${name}'.bytes must be a non-negative integer or null`);
  }
  if (entry.seq !== undefined && entry.seq !== null && (!Number.isInteger(entry.seq) || entry.seq < 1)) {
    throw fail("invalid-event", `ADR ref '${name}'.seq must be a positive integer or null`);
  }
  if (entry.count !== undefined && entry.count !== null && (!Number.isInteger(entry.count) || entry.count < 0)) {
    throw fail("invalid-event", `ADR ref '${name}'.count must be a non-negative integer or null`);
  }
  if (entry.landing !== undefined && entry.landing !== null) assertAdrLanding(entry.landing, `ADR ref '${name}'`);
  return entry;
}

function assertAdrRefs(refs, kind, { requireAll = false } = {}) {
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) {
    throw fail("invalid-event", `${kind} requires a payload.refs object of named evidence references`);
  }
  for (const [name, entry] of Object.entries(refs)) assertAdrRefEntry(name, entry);
  if (requireAll) {
    for (const name of ADR_REQUIRED_REFS) {
      if (!refs[name]) {
        throw fail("invalid-event", `${kind} requires an explicit payload.refs.${name} entry (retained, pending, or missing — never silently absent)`);
      }
    }
  }
  return refs;
}

function assertAdrLanding(landing, what) {
  if (!landing || typeof landing !== "object" || Array.isArray(landing)) {
    throw fail("invalid-event", `${what} requires a landing receipt object`);
  }
  if (!ADR_LANDING_METHODS.includes(landing.method)) {
    throw fail("invalid-event", `${what} landing method ${JSON.stringify(landing.method)} is unknown (allowed: ${ADR_LANDING_METHODS.join(", ")})`);
  }
  for (const field of ["receipt", "headSha", "pr"]) {
    if (landing[field] !== undefined && landing[field] !== null && typeof landing[field] !== "string") {
      throw fail("invalid-event", `${what} landing.${field} must be a string or null`);
    }
  }
  if (landing.method === "pr" || landing.method === "ff") {
    if (typeof landing.receipt !== "string" || !/^[0-9a-f]{7,64}$/.test(landing.receipt)) {
      throw fail("invalid-event", `${what}: a '${landing.method}' landing requires its verified merge/ff receipt (the actual landed revision)`);
    }
    if (landing.method === "pr" && (typeof landing.pr !== "string" || !landing.pr.trim())) {
      throw fail("invalid-event", `${what}: a 'pr' landing requires its merged PR reference`);
    }
  }
  if (landing.method === "none" && landing.receipt != null) {
    throw fail("invalid-event", `${what}: a no-source-change (method 'none') landing never carries a commit receipt`);
  }
  if (landing.changedPaths !== undefined && landing.changedPaths !== null) {
    const paths = landing.changedPaths;
    if (typeof paths !== "object" || Array.isArray(paths)) {
      throw fail("invalid-event", `${what} landing.changedPaths must be an object or null`);
    }
    if (paths.verified !== undefined && typeof paths.verified !== "boolean") {
      throw fail("invalid-event", `${what} landing.changedPaths.verified must be a boolean`);
    }
    if (paths.allWithinAdrRoots !== undefined && typeof paths.allWithinAdrRoots !== "boolean") {
      throw fail("invalid-event", `${what} landing.changedPaths.allWithinAdrRoots must be a boolean`);
    }
    if (paths.count !== undefined && paths.count !== null && (!Number.isInteger(paths.count) || paths.count < 0)) {
      throw fail("invalid-event", `${what} landing.changedPaths.count must be a non-negative integer`);
    }
  }
  return landing;
}

function assertAdrSuppression(suppression, what) {
  if (!suppression || typeof suppression !== "object" || Array.isArray(suppression)) {
    throw fail("invalid-event", `${what} suppression must be an object`);
  }
  if (!ADR_SUPPRESSION_BASES.includes(suppression.basis)) {
    throw fail("invalid-event", `${what} suppression basis ${JSON.stringify(suppression.basis)} is unknown (allowed: ${ADR_SUPPRESSION_BASES.join(", ")})`);
  }
  if (typeof suppression.reason !== "string" || !suppression.reason.trim()) {
    throw fail("invalid-event", `${what} suppression requires an explicit non-empty reason`);
  }
  if (typeof suppression.provenance !== "string" || !suppression.provenance.trim()) {
    throw fail("invalid-event", `${what} suppression requires explicit provenance`);
  }
  if (suppression.basis === "trusted-opt-out" && suppression.publisher !== true) {
    throw fail("invalid-event", `${what}: the trusted suppression opt-out is available to the ADR publisher only`);
  }
  return suppression;
}

function requirePayloadString(payload, field, kind) {
  const value = payload[field];
  if (typeof value !== "string") throw fail("invalid-event", `${kind} requires payload.${field} to be a string`);
  return value;
}

function revisionEntry(state, revision) {
  return state.revisions[revision - 1] ?? null;
}

function assertRevisionApplicableToJob(state, revision, jobId, what) {
  const entry = revisionEntry(state, revision);
  if (!entry) throw fail("invalid-transition", `${what} references assignment revision ${revision}, which does not exist`);
  const scope = entry.scope;
  if (scope.kind === "job" && scope.jobId !== jobId) {
    throw fail("invalid-transition", `${what} references assignment revision ${revision}, which never applied to job '${jobId}' (it targets job '${scope.jobId}')`);
  }
  return entry;
}

// The revision a job is working against: a job-targeted assignment revision
// supersedes the pin; otherwise the pin (the change default at registration)
// holds. Later change-default revisions never silently re-pin an existing job.
function effectiveRevisionOf(state, jobId) {
  const job = state.jobs[jobId];
  if (!job) throw fail("not-found", `unknown job '${jobId}'`);
  return job.jobRevision > 0 ? job.jobRevision : job.pinnedRevision;
}

function textEntryFromPayload(env) {
  return { seq: env.seq, at: env.at, payload: env.payload, splits: env.payload.textContinuation ?? null };
}

// Applies one structurally valid envelope to the state. Throws on every
// invalid authoritative transition; both the append path (dry run) and replay
// use this exact function, so a record can only ever contain transitions the
// reducer accepts.
function applyEvent(state, env) {
  if (env.seq !== state.lastSeq + 1) {
    throw fail("invalid-transition", `event seq ${env.seq} does not follow committed seq ${state.lastSeq}`);
  }
  if (env.changeId !== state.changeId) {
    throw fail("invalid-event", `envelope changeId '${env.changeId}' does not match record '${state.changeId}'`);
  }
  if (state.eventIds[env.eventId] !== undefined) {
    throw fail("invalid-transition", `duplicate event id '${env.eventId}'`);
  }
  if (state.commandIndex[env.command.id]) {
    throw fail("invalid-transition", `duplicate command id '${env.command.id}'`);
  }
  // Direct callers (candidate validation) bypass the framing scan, so the
  // payload guard lives here too: a malformed envelope is rejected as an
  // invalid event, never as a raw TypeError.
  if (!env.payload || typeof env.payload !== "object" || Array.isArray(env.payload)) {
    throw fail("invalid-event", "envelope payload must be an object");
  }
  const requirements = KIND_ID_REQUIREMENTS[env.kind];
  if (requirements.jobId && !env.jobId) throw fail("invalid-event", `${env.kind} requires a jobId`);
  if (requirements.attemptId && !env.attemptId) throw fail("invalid-event", `${env.kind} requires an attemptId`);
  if (!KIND_ACTORS[env.kind].includes(env.actor.kind)) {
    throw fail(
      "invalid-transition",
      `kind '${env.kind}' cannot be authored by actor kind '${env.actor.kind}' (allowed: ${KIND_ACTORS[env.kind].join(", ")})`,
    );
  }

  const payload = env.payload;

  switch (env.kind) {
    case "change.created": {
      if (state.lastSeq !== 0) throw fail("invalid-transition", "change.created must be the first event of a record");
      if (payload.title !== undefined && payload.title !== null && typeof payload.title !== "string") {
        throw fail("invalid-event", "change.created payload.title must be a string or null");
      }
      state.createdAt = env.at;
      break;
    }

    case "assignment.revised": {
      const { revision, predecessor, scope } = payload;
      if (!Number.isInteger(revision)) throw fail("invalid-event", "assignment.revised requires an integer payload.revision");
      if (revision !== state.currentRevision + 1) {
        throw fail(
          "invalid-transition",
          `assignment revision ${revision} does not follow current revision ${state.currentRevision}`,
        );
      }
      const expectedPredecessor = state.currentRevision === 0 ? null : state.currentRevision;
      if (predecessor !== expectedPredecessor) {
        throw fail(
          "invalid-transition",
          `assignment revision ${revision} records predecessor ${JSON.stringify(predecessor)} but expected ${JSON.stringify(expectedPredecessor)}`,
        );
      }
      if (!scope || typeof scope !== "object" || !["change", "job"].includes(scope.kind)) {
        throw fail("invalid-event", "assignment.revised requires payload.scope { kind: 'change' } or { kind: 'job', jobId }");
      }
      if (scope.kind === "job") {
        assertIdentifier(scope.jobId, "scope.jobId");
        if (!state.jobs[scope.jobId]) {
          throw fail("invalid-transition", `assignment revision targets unknown job '${scope.jobId}'`);
        }
        // Serialize a role update against the execution's irreversible landing
        // boundary under this same append lock, including direct callers.
        if (state.jobs[scope.jobId].role !== "execution") {
          for (const execution of Object.values(state.jobs).filter(job => job.role === "execution")) {
            if (Object.values(execution.attempts).some(attempt => attempt.landingAdmitted || attempt.cancelIntent || attempt.outcome)) {
              throw fail("invalid-transition", "execution is closed to assignment updates after landing admission, cancellation, or outcome");
            }
          }
        }
      }
      if (!payload.assignment || typeof payload.assignment !== "object" || Array.isArray(payload.assignment)) {
        throw fail("invalid-event", "assignment.revised requires a payload.assignment object");
      }
      // Optional raw coordinator instruction retained verbatim alongside the
      // composed full assignment (records written before this field existed
      // replay unchanged; it is simply absent).
      if (payload.note !== undefined && payload.note !== null && typeof payload.note !== "string") {
        throw fail("invalid-event", "assignment.revised payload.note must be a string or null");
      }
      // A revision is always the FULL assignment content, never a delta.
      state.revisions.push({
        revision,
        scope: { kind: scope.kind, jobId: scope.jobId ?? null },
        at: env.at,
        seq: env.seq,
        payload,
        splits: payload.textContinuation ?? null,
      });
      state.currentRevision = revision;
      if (scope.kind === "change") state.changeRevision = revision;
      else state.jobs[scope.jobId].jobRevision = revision;
      break;
    }

    case "job.registered": {
      const { role, pinnedRevision } = payload;
      if (!JOB_ROLES.includes(role)) {
        throw fail("invalid-event", `job.registered role ${JSON.stringify(role)} is unknown (allowed: ${JOB_ROLES.join(", ")})`);
      }
      if (!Number.isInteger(pinnedRevision)) throw fail("invalid-event", "job.registered requires an integer payload.pinnedRevision");
      if (!revisionEntry(state, pinnedRevision)) {
        throw fail("invalid-transition", `job pins assignment revision ${pinnedRevision}, which does not exist`);
      }
      if (state.jobs[env.jobId]) throw fail("invalid-transition", `job '${env.jobId}' is already registered in this change`);
      state.jobs[env.jobId] = {
        id: env.jobId,
        role,
        pinnedRevision,
        registeredAt: env.at,
        registeredSeq: env.seq,
        jobRevision: 0,
        attempts: {},
        attemptOrder: [],
        amendments: {},
        amendmentOrder: [],
      };
      state.jobOrder.push(env.jobId);
      break;
    }

    case "attempt.launch_intent": {
      const job = state.jobs[env.jobId];
      if (!job) throw fail("invalid-transition", `launch intent for unknown job '${env.jobId}'`);
      if (job.attempts[env.attemptId]) {
        throw fail("invalid-transition", `attempt '${env.attemptId}' already exists on job '${env.jobId}'`);
      }
      let revision = effectiveRevisionOf(state, env.jobId);
      if (payload.revision !== undefined) {
        if (!Number.isInteger(payload.revision)) throw fail("invalid-event", "attempt.launch_intent payload.revision must be an integer");
        assertRevisionApplicableToJob(state, payload.revision, env.jobId, "launch intent");
        revision = payload.revision;
      }
      // Launch context retention (optional, additive): the original working
      // directory, owner/session routing and target paths the launch was
      // intended for, plus the managed-execution launch metadata (kind, phase,
      // base, root/owner identity, launch id, request path) a host request is
      // later reconstructed and verified against. Records written before these
      // fields existed replay unchanged (they are simply absent).
      for (const field of ["cwd", "owner"]) {
        if (payload[field] !== undefined && payload[field] !== null && typeof payload[field] !== "string") {
          throw fail("invalid-event", `attempt.launch_intent payload.${field} must be a string or null`);
        }
      }
      if (payload.targetPaths !== undefined && payload.targetPaths !== null
        && (!Array.isArray(payload.targetPaths) || payload.targetPaths.some((entry) => typeof entry !== "string"))) {
        throw fail("invalid-event", "attempt.launch_intent payload.targetPaths must be an array of strings or null");
      }
      if (payload.launch !== undefined && payload.launch !== null
        && (typeof payload.launch !== "object" || Array.isArray(payload.launch))) {
        throw fail("invalid-event", "attempt.launch_intent payload.launch must be a plain object or null");
      }
      // Launch intent is explicitly UNRESOLVED until an observed start. The
      // reducer never repeats or assumes any external effect.
      job.attempts[env.attemptId] = {
        id: env.attemptId,
        jobId: env.jobId,
        phase: "launched",
        launchIntent: {
          at: env.at,
          seq: env.seq,
          revision,
          cwd: payload.cwd ?? null,
          owner: payload.owner ?? null,
          targetPaths: payload.targetPaths ?? null,
          launch: payload.launch ?? null,
        },
        started: null,
        activity: [],
        progress: [],
        blockers: [],
        cancelIntent: null,
        admissionClosed: null,
        landingAdmitted: null,
        evidence: [],
        outcome: null,
        acknowledgements: [],
      };
      job.attemptOrder.push(env.attemptId);
      break;
    }

    case "attempt.started": {
      const attempt = requireAttempt(state, env.jobId, env.attemptId, env.kind);
      if (attempt.phase !== "launched") {
        throw fail("invalid-transition", `attempt '${env.attemptId}' is '${attempt.phase}'; only an unresolved launch intent can be started`);
      }
      if (payload.identity === undefined || payload.identity === null) {
        throw fail("invalid-event", "attempt.started requires a trusted payload.identity");
      }
      if (typeof payload.identity !== "string" && (typeof payload.identity !== "object" || Array.isArray(payload.identity))) {
        throw fail("invalid-event", "attempt.started payload.identity must be a string or object");
      }
      attempt.started = { at: env.at, seq: env.seq, identity: payload.identity };
      attempt.phase = "started";
      break;
    }

    case "attempt.activity":
    case "worker.progress":
    case "worker.blocker": {
      const attempt = requireAttempt(state, env.jobId, env.attemptId, env.kind);
      if (attempt.phase !== "started") {
        throw fail("invalid-transition", `${env.kind} requires a started attempt ('${env.attemptId}' is '${attempt.phase}')`);
      }
      requirePayloadString(payload, "note", env.kind);
      const entry = textEntryFromPayload(env);
      if (env.kind === "attempt.activity") attempt.activity.push(entry);
      else if (env.kind === "worker.progress") attempt.progress.push(entry);
      else attempt.blockers.push(entry);
      break;
    }

    case "attempt.cancel_intent": {
      const attempt = requireAttempt(state, env.jobId, env.attemptId, env.kind);
      if (attempt.phase === "terminal") {
        throw fail("invalid-transition", `attempt '${env.attemptId}' is terminal; cancellation cannot follow a validated outcome`);
      }
      if (attempt.cancelIntent) {
        throw fail("invalid-transition", `attempt '${env.attemptId}' already carries a cancellation intent`);
      }
      // Landing has already been admitted (irreversible): a cancellation can
      // never be recorded as accepted here, because accepting it would imply a
      // rollback the world cannot perform. The caller reports the truthful
      // refusal and the landing evidence stays preserved.
      if (attempt.landingAdmitted) {
        throw fail(
          "invalid-transition",
          `landing for attempt '${env.attemptId}' was already admitted at seq ${attempt.landingAdmitted.seq}; cancellation cannot undo it`,
        );
      }
      const reason = requirePayloadString(payload, "reason", env.kind);
      attempt.cancelIntent = { at: env.at, seq: env.seq, reason };
      break;
    }

    case "attempt.landing_admitted": {
      const attempt = requireAttempt(state, env.jobId, env.attemptId, env.kind);
      if (attempt.phase !== "started") {
        throw fail("invalid-transition", `landing admission requires a started attempt ('${env.attemptId}' is '${attempt.phase}')`);
      }
      if (attempt.cancelIntent) {
        throw fail(
          "invalid-transition",
          `cancellation was intented for attempt '${env.attemptId}'; landing is not admitted after an accepted cancellation`,
        );
      }
      if (attempt.landingAdmitted) {
        throw fail("invalid-transition", `landing for attempt '${env.attemptId}' is already admitted at seq ${attempt.landingAdmitted.seq}`);
      }
      if (attempt.outcome) {
        throw fail("invalid-transition", `attempt '${env.attemptId}' already carries a validated outcome; landing admission precedes it`);
      }
      // This check belongs inside the reducer: an outside preflight can race
      // an amendment committed by another process before we take the lock.
      for (const roleJob of Object.values(state.jobs).filter(job => job.role !== "execution")) {
        for (const amendment of Object.values(roleJob.amendments)) {
          if (!amendmentAcknowledgedBy(state, roleJob.id, amendment)) {
            throw fail("pending-update", `unacknowledged assignment update for job '${roleJob.id}' prevents landing`);
          }
        }
        for (const revision of state.revisions.filter(entry => entry.scope.kind === "job" && entry.scope.jobId === roleJob.id)) {
          const launched = Object.values(roleJob.attempts).some(entry => entry.launchIntent.revision === revision.revision);
          const submitted = Object.values(roleJob.amendments).some(entry => entry.revision === revision.revision);
          if (!launched && !submitted) throw fail("pending-update", `unresolved assignment revision ${revision.revision} prevents landing`);
        }
      }
      if (payload.note !== undefined && payload.note !== null && typeof payload.note !== "string") {
        throw fail("invalid-event", "attempt.landing_admitted payload.note must be a string or null");
      }
      attempt.landingAdmitted = { at: env.at, seq: env.seq, note: payload.note ?? null };
      break;
    }

    case "attempt.evidence": {
      const attempt = requireAttempt(state, env.jobId, env.attemptId, env.kind);
      // Evidence is recordable at ANY attempt phase — including after a
      // cancellation or a validated outcome. It never alters the phase, the
      // cancellation, or the outcome; it only keeps the referenced artifact
      // durably linked and retrievable.
      if (typeof payload.label !== "string" || payload.label.trim() === "") {
        throw fail("invalid-event", "attempt.evidence requires a non-empty payload.label");
      }
      if (payload.reportId !== undefined && payload.reportId !== null && typeof payload.reportId !== "string") {
        throw fail("invalid-event", "attempt.evidence payload.reportId must be a string or null");
      }
      if (payload.note !== undefined && payload.note !== null && typeof payload.note !== "string") {
        throw fail("invalid-event", "attempt.evidence payload.note must be a string or null");
      }
      attempt.evidence.push({
        at: env.at,
        seq: env.seq,
        label: payload.label,
        reportId: payload.reportId ?? null,
        payload,
        splits: payload.textContinuation ?? null,
      });
      break;
    }

    case "attempt.admission_closed": {
      const attempt = requireAttempt(state, env.jobId, env.attemptId, env.kind);
      if (attempt.admissionClosed) {
        throw fail("invalid-transition", `receiver admission on attempt '${env.attemptId}' is already closed`);
      }
      // A closure is a lifecycle fact of the attempt's relay receiver, not a
      // validated outcome: worker acknowledgements remain recordable after it
      // (drain-delivered amendments may still be incorporated), and an outcome
      // may still be recorded for the work the attempt finished.
      attempt.admissionClosed = { at: env.at, seq: env.seq };
      break;
    }

    case "attempt.outcome": {
      const attempt = requireAttempt(state, env.jobId, env.attemptId, env.kind);
      if (attempt.phase === "terminal") {
        throw fail("invalid-transition", `attempt '${env.attemptId}' already carries a validated outcome`);
      }
      const { status } = payload;
      if (!OUTCOME_STATUSES.includes(status)) {
        throw fail("invalid-event", `attempt.outcome status ${JSON.stringify(status)} is unknown (allowed: ${OUTCOME_STATUSES.join(", ")})`);
      }
      // A COMPLETED outcome requires an observed start. A failure or
      // cancellation is recordable for a never-started attempt too: a launch
      // or communication setup that failed before the receiver binding was
      // observed must still reach a truthful terminal state (an honest
      // terminal failure, never a success and never an eternal 'launched').
      if (attempt.phase !== "started" && status === "completed") {
        throw fail(
          "invalid-transition",
          `attempt '${env.attemptId}' is '${attempt.phase}'; a completed outcome requires an observed start`,
        );
      }
      if (attempt.cancelIntent && status === "completed") {
        throw fail("invalid-transition", `cancellation intent on attempt '${env.attemptId}' forbids a completed outcome`);
      }
      if (status === "completed" && state.jobs[env.jobId].role !== "execution") {
        for (const execution of Object.values(state.jobs).filter(job => job.role === "execution")) {
          if (Object.values(execution.attempts).some(entry => entry.cancelIntent)) {
            throw fail("invalid-transition", "parent execution cancellation intent forbids a later completed role outcome");
          }
        }
      }
      if (payload.revision !== undefined && !Number.isInteger(payload.revision)) {
        throw fail("invalid-event", "attempt.outcome payload.revision must be an integer");
      }
      // The result is pinned to the revision this attempt actually worked
      // against: the last acknowledged revision, else the revision its launch
      // intent pinned (for single-attempt jobs that is the job's pinned
      // revision — identical behavior), never whatever revision happens to be
      // latest. A result against an old revision retains that revision; it can
      // never silently satisfy a newer targeted amendment.
      const derivedRevision = attempt.acknowledgements.at(-1)?.revision ?? attempt.launchIntent.revision ?? state.jobs[env.jobId].pinnedRevision;
      if (payload.revision !== undefined && payload.revision !== derivedRevision) {
        throw fail(
          "invalid-transition",
          `outcome claims revision ${payload.revision} but attempt '${env.attemptId}' worked against revision ${derivedRevision}`,
        );
      }
      attempt.outcome = {
        seq: env.seq,
        at: env.at,
        status,
        revision: derivedRevision,
        payload,
        splits: payload.textContinuation ?? null,
      };
      attempt.phase = "terminal";
      break;
    }

    case "amendment.submitted": {
      const job = requireJob(state, env.jobId);
      const attempt = requireAttempt(state, env.jobId, env.attemptId, env.kind);
      if (job.role !== "execution") {
        for (const execution of Object.values(state.jobs).filter(entry => entry.role === "execution")) {
          if (Object.values(execution.attempts).some(entry => entry.landingAdmitted || entry.cancelIntent || entry.outcome)) {
            throw fail("invalid-transition", "execution is closed to assignment updates after landing admission, cancellation, or outcome");
          }
        }
      }
      const { amendmentId, revision } = payload;
      // Delivery admission is serialized with receiver closure in THIS record:
      // once admission is closed the submission is refused, so a late accepted
      // submission cannot disappear as a successful delivery. The revision, if
      // one was already recorded for it, remains in the record and the caller
      // reports the refusal honestly.
      if (attempt.admissionClosed) {
        throw fail(
          "invalid-transition",
          `receiver admission on attempt '${env.attemptId}' is closed; amendment '${amendmentId}' cannot be admitted for delivery there`,
        );
      }
      assertIdentifier(amendmentId, "payload.amendmentId");
      if (!Number.isInteger(revision)) throw fail("invalid-event", "amendment.submitted requires an integer payload.revision");
      if (job.amendments[amendmentId]) {
        throw fail("invalid-transition", `amendment '${amendmentId}' is already submitted`);
      }
      const entry = revisionEntry(state, revision);
      if (!entry) throw fail("invalid-transition", `amendment references assignment revision ${revision}, which does not exist`);
      if (entry.scope.kind !== "job" || entry.scope.jobId !== env.jobId) {
        throw fail(
          "invalid-transition",
          `amendment references assignment revision ${revision}, which is not targeted at job '${env.jobId}'`,
        );
      }
      if (payload.transport !== undefined && (typeof payload.transport !== "object" || payload.transport === null || Array.isArray(payload.transport))) {
        throw fail("invalid-event", "amendment.submitted payload.transport must be an object");
      }
      // Delivery bookkeeping only. Submission never advances worker
      // acknowledgement; only worker.acknowledged can do that. The submitted
      // payload is retained (with its split markers) so the coordinator's raw
      // instruction stays recoverable for assignment composition and
      // post-restart inspection.
      if (payload.note !== undefined && payload.note !== null && typeof payload.note !== "string") {
        throw fail("invalid-event", "amendment.submitted payload.note must be a string or null");
      }
      job.amendments[amendmentId] = {
        amendmentId,
        revision,
        targetedAttemptId: env.attemptId,
        submitted: { at: env.at, seq: env.seq, transport: payload.transport ?? null, note: payload.note ?? null, splits: payload.textContinuation ?? null, payload },
        pushes: [],
        accepted: null,
      };
      job.amendmentOrder.push(amendmentId);
      break;
    }

    case "amendment.pushed": {
      const job = requireJob(state, env.jobId);
      requireAttempt(state, env.jobId, env.attemptId, env.kind);
      const { amendmentId } = payload;
      assertIdentifier(amendmentId, "payload.amendmentId");
      const amendment = job.amendments[amendmentId];
      if (!amendment) {
        throw fail("invalid-transition", `amendment '${amendmentId}' was never submitted on job '${env.jobId}'`);
      }
      // Payload key `pushEventId` (never `eventId`: that name is reserved for
      // trusted envelope identity and the spoofing guard rejects it).
      if (payload.pushEventId !== undefined && payload.pushEventId !== null && typeof payload.pushEventId !== "string") {
        throw fail("invalid-event", "amendment.pushed payload.pushEventId must be a string or null");
      }
      if (payload.status !== undefined && payload.status !== null && typeof payload.status !== "string") {
        throw fail("invalid-event", "amendment.pushed payload.status must be a string or null");
      }
      // One entry per push attempt, in order. The LAST entry is the correlation
      // the retry path checks against the relay journal; a push whose transport
      // result was lost (crash before the append) simply has no entry here, and
      // the next retry re-pushes (safe: incorporation is a deterministic record
      // dedupe, never a duplicate incorporation).
      amendment.pushes.push({ eventId: payload.pushEventId ?? null, status: payload.status ?? null, at: env.at, seq: env.seq });
      break;
    }

    case "amendment.accepted": {
      const job = requireJob(state, env.jobId);
      requireAttempt(state, env.jobId, env.attemptId, env.kind);
      const { amendmentId } = payload;
      assertIdentifier(amendmentId, "payload.amendmentId");
      const amendment = job.amendments[amendmentId];
      if (!amendment) throw fail("invalid-transition", `amendment '${amendmentId}' was never submitted on job '${env.jobId}'`);
      // Acceptance is scoped to the delivery: the accepting attempt must be
      // the one the amendment was submitted for.
      if (amendment.targetedAttemptId !== env.attemptId) {
        throw fail(
          "invalid-transition",
          `amendment '${amendmentId}' was submitted for attempt '${amendment.targetedAttemptId}'; it cannot be accepted by attempt '${env.attemptId}'`,
        );
      }
      if (amendment.accepted) throw fail("invalid-transition", `amendment '${amendmentId}' is already accepted`);
      amendment.accepted = { at: env.at, seq: env.seq };
      break;
    }

    case "worker.acknowledged": {
      const attempt = requireAttempt(state, env.jobId, env.attemptId, env.kind);
      // An acknowledgement is evidence about which assignment revision the
      // worker received, not an attempt-lifecycle transition: it stays
      // recordable after a validated outcome, because the steering flow — a
      // result for the old revision, then acknowledgement of a targeted
      // amendment — must be expressible. What it requires is an OBSERVED
      // start, never a mere launch intent.
      if (!attempt.started) {
        throw fail("invalid-transition", `acknowledgement requires an observed start ('${env.attemptId}' was never started)`);
      }
      const { revision } = payload;
      if (!Number.isInteger(revision)) throw fail("invalid-event", "worker.acknowledged requires an integer payload.revision");
      assertRevisionApplicableToJob(state, revision, env.jobId, "acknowledgement");
      attempt.acknowledgements.push({ revision, at: env.at, seq: env.seq });
      break;
    }

    case "adr.source_manifest": {
      // A staged ADR source manifest binds to the MANAGED EXECUTION attempt of
      // this change (its project, coordinating owner and phase identity live
      // in the retained blob and the obligation event; this module stores the
      // typed evidence reference verbatim and never fetches it).
      if (state.jobs[env.jobId].role !== "execution") {
        throw fail("invalid-transition", "an ADR source manifest binds to a managed execution attempt");
      }
      requireAttempt(state, env.jobId, env.attemptId, env.kind);
      assertIdentifier(payload.manifestId, "payload.manifestId");
      if (!Number.isInteger(payload.schemaVersion) || payload.schemaVersion < 1) {
        throw fail("invalid-event", "adr.source_manifest requires a positive integer payload.schemaVersion");
      }
      const evidence = payload.evidence;
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
        throw fail("invalid-event", "adr.source_manifest requires a payload.evidence reference object");
      }
      if (typeof evidence.path !== "string" || !evidence.path.trim()) {
        throw fail("invalid-event", "payload.evidence.path must name the retained manifest artifact");
      }
      if (typeof evidence.sha256 !== "string" || !SHA_PATTERN.test(evidence.sha256)) {
        throw fail("invalid-event", "payload.evidence.sha256 must be the artifact's sha256");
      }
      if (!Number.isInteger(evidence.bytes) || evidence.bytes < 0) {
        throw fail("invalid-event", "payload.evidence.bytes must be a non-negative integer");
      }
      const refs = assertAdrRefs(payload.refs, env.kind, { requireAll: true });
      if (state.adr.manifests[payload.manifestId]) {
        throw fail("invalid-transition", `ADR source manifest '${payload.manifestId}' is already staged`);
      }
      state.adr.manifests[payload.manifestId] = {
        manifestId: payload.manifestId,
        schemaVersion: payload.schemaVersion,
        seq: env.seq,
        at: env.at,
        evidence: { path: evidence.path, sha256: evidence.sha256, bytes: evidence.bytes },
        refs: Object.fromEntries(Object.entries(refs).map(([name, entry]) => [name, { ...entry }])),
        landing: null,
        disposition: null,
        suppression: null,
      };
      state.adr.manifestOrder.push(payload.manifestId);
      break;
    }

    case "adr.source_completion": {
      if (state.jobs[env.jobId].role !== "execution") {
        throw fail("invalid-transition", "an ADR source completion binds to a managed execution attempt");
      }
      requireAttempt(state, env.jobId, env.attemptId, env.kind);
      assertIdentifier(payload.manifestId, "payload.manifestId");
      const manifest = state.adr.manifests[payload.manifestId];
      if (!manifest) {
        throw fail("invalid-transition", `completion references unknown ADR source manifest '${payload.manifestId}'`);
      }
      const completionRefs = assertAdrRefs(payload.refs ?? {}, env.kind, { requireAll: false });
      for (const [name, entry] of Object.entries(completionRefs)) {
        const existing = manifest.refs[name];
        if (!existing) {
          manifest.refs[name] = { ...entry };
          continue;
        }
        if (existing.status === "retained") {
          // Retained stays retained; a late completion is idempotent, and a
          // conflicting identity for the same named reference is refused.
          if (entry.status === "retained"
            && ((existing.reportId ?? null) !== (entry.reportId ?? null)
              || (existing.path ?? null) !== (entry.path ?? null)
              || (existing.sha256 ?? null) !== (entry.sha256 ?? null))) {
            throw fail("invalid-transition", `conflicting retained ref '${name}' on ADR source manifest '${payload.manifestId}'`);
          }
          continue;
        }
        if (entry.status === "retained") manifest.refs[name] = { ...entry };
        else if (existing.status === "pending" && entry.status === "missing") manifest.refs[name] = { ...entry };
      }
      if (payload.landing !== undefined && payload.landing !== null) {
        assertAdrLanding(payload.landing, env.kind);
        if (manifest.landing && canonicalJson(manifest.landing) !== canonicalJson(payload.landing)) {
          throw fail("invalid-transition", `conflicting observed landing evidence on ADR source manifest '${payload.manifestId}'`);
        }
        manifest.landing = { ...payload.landing };
      }
      if (payload.disposition !== undefined && payload.disposition !== null) {
        if (!ADR_OBLIGATION_STATUSES.includes(payload.disposition)) {
          throw fail("invalid-event", `payload.disposition ${JSON.stringify(payload.disposition)} is unknown (allowed: ${ADR_OBLIGATION_STATUSES.join(", ")})`);
        }
        if (manifest.disposition && manifest.disposition !== payload.disposition) {
          throw fail("invalid-transition", `conflicting curation disposition on ADR source manifest '${payload.manifestId}'`);
        }
        manifest.disposition = payload.disposition;
      }
      if (payload.suppression !== undefined && payload.suppression !== null) {
        assertAdrSuppression(payload.suppression, env.kind);
        if (manifest.suppression && canonicalJson(manifest.suppression) !== canonicalJson(payload.suppression)) {
          throw fail("invalid-transition", `conflicting suppression on ADR source manifest '${payload.manifestId}'`);
        }
        manifest.suppression = { ...payload.suppression };
      }
      break;
    }

    case "adr.curation_obligation": {
      if (state.jobs[env.jobId].role !== "execution") {
        throw fail("invalid-transition", "a curation obligation binds to a managed execution attempt");
      }
      requireAttempt(state, env.jobId, env.attemptId, env.kind);
      assertIdentifier(payload.operationId, "payload.operationId");
      if (state.adr.obligations[payload.operationId]) {
        throw fail("invalid-transition", `curation obligation '${payload.operationId}' is already recorded`);
      }
      if (!ADR_OBLIGATION_STATUSES.includes(payload.status)) {
        throw fail("invalid-event", `payload.status ${JSON.stringify(payload.status)} is unknown (allowed: ${ADR_OBLIGATION_STATUSES.join(", ")})`);
      }
      assertAdrLanding(payload.landing, env.kind);
      for (const field of ["project", "owner"]) {
        if (typeof payload[field] !== "string" || !payload[field].trim()) {
          throw fail("invalid-event", `adr.curation_obligation requires payload.${field} (the binding identity)`);
        }
      }
      if (payload.phaseId !== undefined && payload.phaseId !== null && typeof payload.phaseId !== "string") {
        throw fail("invalid-event", "adr.curation_obligation payload.phaseId must be a string or null");
      }
      if (payload.manifestId !== undefined && payload.manifestId !== null) {
        assertIdentifier(payload.manifestId, "payload.manifestId");
        if (!state.adr.manifests[payload.manifestId]) {
          throw fail("invalid-transition", `curation obligation references unknown ADR source manifest '${payload.manifestId}'`);
        }
      }
      if (payload.suppression !== undefined && payload.suppression !== null) {
        assertAdrSuppression(payload.suppression, env.kind);
      }
      if (payload.status === "pending") {
        // Only a verified successful REAL source landing activates a pending
        // curation obligation, and only over retained source evidence.
        if (!payload.manifestId) {
          throw fail("invalid-transition", "a pending curation obligation requires the retained ADR source manifest");
        }
        if (payload.landing.method !== "pr" && payload.landing.method !== "ff") {
          throw fail("invalid-transition", "a pending curation obligation requires a verified real source landing (method 'pr' or 'ff')");
        }
        if (payload.suppression) {
          throw fail("invalid-transition", "a suppressed landing never schedules architectural curation");
        }
      }
      if (payload.status === "no-change" && payload.landing.method !== "none") {
        throw fail("invalid-transition", "a no-source-change disposition describes a method 'none' landing");
      }
      if (payload.status === "suppressed" && !payload.suppression) {
        throw fail("invalid-transition", "a suppressed disposition requires its validated suppression basis");
      }
      state.adr.obligations[payload.operationId] = {
        operationId: payload.operationId,
        manifestId: payload.manifestId ?? null,
        status: payload.status,
        landing: { ...payload.landing },
        suppression: payload.suppression ? { ...payload.suppression } : null,
        project: payload.project,
        owner: payload.owner,
        phaseId: payload.phaseId ?? null,
        seq: env.seq,
        at: env.at,
      };
      state.adr.obligationOrder.push(payload.operationId);
      break;
    }

    case "text.continued": {
      const { textId, part } = payload;
      assertIdentifier(textId, "payload.textId");
      const text = state.texts[textId];
      if (!text) throw fail("invalid-transition", `continuation references unknown text '${textId}'`);
      if (!Number.isInteger(part) || part < 1 || part >= text.parts) {
        throw fail("invalid-transition", `continuation part ${JSON.stringify(part)} is outside [1, ${text.parts - 1}] for text '${textId}'`);
      }
      const chunk = requirePayloadString(payload, "text", env.kind);
      if (text.chunks[part] !== undefined && text.chunks[part] !== chunk) {
        throw fail("invalid-transition", `conflicting content for text '${textId}' part ${part}`);
      }
      text.chunks[part] = chunk;
      break;
    }

    default:
      throw fail("unknown-kind", `event kind ${JSON.stringify(env.kind)} is unknown; it is not applied`);
  }

  // Large-text registration happens after the kind-specific transition so a
  // rejected transition never leaves a phantom text behind.
  if (payload.textContinuation) {
    for (const marker of payload.textContinuation) {
      const chunk0 = getAtPath(payload, marker.field);
      if (typeof chunk0 !== "string") {
        throw fail("invalid-event", `textContinuation field '${marker.field}' does not carry a string chunk`);
      }
      if (state.texts[marker.textId]) {
        throw fail("invalid-transition", `text '${marker.textId}' is already registered`);
      }
      state.texts[marker.textId] = {
        textId: marker.textId,
        kind: env.kind,
        field: marker.field,
        parts: marker.parts,
        commandId: env.command.id,
        chunks: { 0: chunk0 },
      };
    }
  }

  state.lastSeq = env.seq;
  state.eventIds[env.eventId] = env.seq;
  state.commandIndex[env.command.id] = {
    seq: env.seq,
    eventId: env.eventId,
    digest: env.command.digest,
    splits: payload.textContinuation ?? null,
  };
  return state;
}

function requireJob(state, jobId) {
  const job = state.jobs[jobId];
  if (!job) throw fail("invalid-transition", `unknown job '${jobId}'`);
  return job;
}

function requireAttempt(state, jobId, attemptId, kind) {
  const job = requireJob(state, jobId);
  const attempt = job.attempts[attemptId];
  if (!attempt) throw fail("invalid-transition", `${kind} references unknown attempt '${attemptId}' on job '${jobId}'`);
  return attempt;
}

// Pure replay: apply already-framed envelopes to an empty state. This is the
// exact function the file replay uses, so full replay and incremental appends
// share one set of transition rules.
export function reduceEvents(events, { changeId } = {}) {
  if (!changeId) throw fail("invalid-identifier", "reduceEvents requires the record's changeId");
  const state = emptyState(changeId);
  for (const env of events) applyEvent(state, env);
  return state;
}

// ---------------------------------------------------------------------------
// Views: pure selective projections over reduced state
// ---------------------------------------------------------------------------

function resolveSplits(state, payload, splits) {
  if (!splits || !splits.length) return { value: payload, incomplete: [] };
  const value = structuredClone(payload);
  const incomplete = [];
  for (const marker of splits) {
    const text = state.texts[marker.textId];
    const missing = [];
    if (!text) {
      for (let part = 0; part < marker.parts; part += 1) missing.push(part);
    } else {
      for (let part = 0; part < text.parts; part += 1) {
        if (text.chunks[part] === undefined) missing.push(part);
      }
    }
    if (missing.length) {
      // A partial text is never presented as complete: the field reads null
      // and the view reports exactly what is missing.
      setAtPath(value, marker.field, null);
      incomplete.push({ field: marker.field, textId: marker.textId, missing });
    } else {
      let full = "";
      for (let part = 0; part < text.parts; part += 1) full += text.chunks[part];
      setAtPath(value, marker.field, full);
    }
  }
  return { value, incomplete };
}

function textEntryView(state, entry, textField) {
  const { value, incomplete } = resolveSplits(state, entry.payload, entry.splits);
  return {
    seq: entry.seq,
    at: entry.at,
    [textField]: value[textField] ?? null,
    complete: incomplete.length === 0,
    incompleteTexts: incomplete,
  };
}

function outcomeView(state, outcome) {
  const { value, incomplete } = resolveSplits(state, outcome.payload, outcome.splits);
  return {
    seq: outcome.seq,
    at: outcome.at,
    status: outcome.status,
    ok: outcome.status === "completed",
    revision: outcome.revision,
    summary: value.summary ?? null,
    result: value.result ?? null,
    // The durable report reference recorded with the validated outcome (if
    // any): readers reconstruct the terminal report pointer from the
    // AUTHORITY, never from a compatibility cache.
    reportId: value.reportId ?? null,
    complete: incomplete.length === 0,
    incompleteTexts: incomplete,
  };
}

function amendmentAcknowledgedBy(state, jobId, amendment) {
  const job = state.jobs[jobId];
  const attempt = job?.attempts[amendment.targetedAttemptId];
  if (!attempt) return null;
  const ack = attempt.acknowledgements.find((entry) => entry.revision === amendment.revision);
  return ack ? { at: ack.at, seq: ack.seq } : null;
}

function amendmentView(state, jobId, amendment) {
  const acknowledged = amendmentAcknowledgedBy(state, jobId, amendment);
  const submitted = amendment.submitted ?? {};
  const note = resolveSplits(state, submitted.payload ?? { note: submitted.note ?? null }, submitted.splits ?? null);
  return {
    jobId,
    amendmentId: amendment.amendmentId,
    revision: amendment.revision,
    targetedAttemptId: amendment.targetedAttemptId,
    submittedAt: submitted.at ?? null,
    acceptedAt: amendment.accepted?.at ?? null,
    status: amendment.accepted ? "accepted" : "submitted",
    acknowledged,
    // The coordinator's raw instruction for this amendment, verbatim (resolved
    // from any large-text continuation parts; null when incomplete).
    note: note.value.note ?? null,
    noteComplete: note.incomplete.length === 0,
    // Transport-push attempts, in order (delivery correlation only — never
    // incorporation). The last entry is what the retry path checks against the
    // relay journal.
    pushes: (amendment.pushes ?? []).map((push) => ({ eventId: push.eventId ?? null, status: push.status ?? null, at: push.at, seq: push.seq })),
  };
}

function attemptView(state, job, attempt) {
  const progress = attempt.progress.map((entry) => textEntryView(state, entry, "note"));
  return {
    id: attempt.id,
    jobId: attempt.jobId,
    phase: attempt.phase,
    launchIntent: {
      at: attempt.launchIntent.at,
      seq: attempt.launchIntent.seq,
      revision: attempt.launchIntent.revision,
      cwd: attempt.launchIntent.cwd ?? null,
      owner: attempt.launchIntent.owner ?? null,
      targetPaths: attempt.launchIntent.targetPaths ?? null,
      launch: attempt.launchIntent.launch ?? null,
    },
    started: attempt.started ? { at: attempt.started.at, seq: attempt.started.seq, identity: attempt.started.identity } : null,
    landingAdmitted: attempt.landingAdmitted
      ? { at: attempt.landingAdmitted.at, seq: attempt.landingAdmitted.seq, note: attempt.landingAdmitted.note ?? null }
      : null,
    evidence: attempt.evidence.map((entry) => ({
      seq: entry.seq,
      at: entry.at,
      label: entry.label,
      reportId: entry.reportId,
      note: resolveSplits(state, entry.payload, entry.splits).value.note ?? null,
    })),
    activity: attempt.activity.map((entry) => textEntryView(state, entry, "note")),
    progress,
    latestProgress: progress.length ? progress[progress.length - 1] : null,
    blockers: attempt.blockers.map((entry) => ({
      ...textEntryView(state, entry, "note"),
      fatal: entry.payload.fatal === true,
    })),
    cancelIntent: attempt.cancelIntent ? { at: attempt.cancelIntent.at, seq: attempt.cancelIntent.seq, reason: attempt.cancelIntent.reason } : null,
    admissionClosed: attempt.admissionClosed ? { at: attempt.admissionClosed.at, seq: attempt.admissionClosed.seq } : null,
    outcome: attempt.outcome ? outcomeView(state, attempt.outcome) : null,
    acknowledgements: attempt.acknowledgements.map((ack) => ({ revision: ack.revision, at: ack.at, seq: ack.seq })),
  };
}

// Selective views over reduced state. Every accessor is a pure function of the
// state; views never read the file.
export function viewsFor(state) {
  return {
    assignment({ revision = null, scope = null } = {}) {
      let entry = null;
      if (revision !== null && revision !== undefined) {
        entry = revisionEntry(state, revision);
        if (!entry) throw fail("not-found", `assignment revision ${revision} does not exist`);
      } else if (scope === "change" || (scope && scope.kind === "change")) {
        entry = state.changeRevision ? revisionEntry(state, state.changeRevision) : null;
      } else if (scope && (scope.kind === "job" || typeof scope === "string")) {
        const jobId = scope.kind === "job" ? scope.jobId : scope;
        entry = revisionEntry(state, effectiveRevisionOf(state, jobId));
      } else {
        entry = state.changeRevision ? revisionEntry(state, state.changeRevision) : null;
      }
      if (!entry) return null;
      const { value, incomplete } = resolveSplits(state, entry.payload, entry.splits);
      return {
        revision: entry.revision,
        scope: entry.scope,
        at: entry.at,
        seq: entry.seq,
        assignment: value.assignment,
        // The raw coordinator instruction recorded for an amendment revision
        // (null for the initial revision). Resolved from continuation parts;
        // `noteComplete: false` reports missing parts instead of truncating.
        note: value.note ?? null,
        noteComplete: incomplete.length === 0,
        complete: incomplete.length === 0,
        incompleteTexts: incomplete,
      };
    },

    job(jobId) {
      const job = state.jobs[jobId];
      if (!job) throw fail("not-found", `unknown job '${jobId}'`);
      const amendments = job.amendmentOrder.map((id) => amendmentView(state, jobId, job.amendments[id]));
      return {
        id: job.id,
        role: job.role,
        pinnedRevision: job.pinnedRevision,
        effectiveRevision: effectiveRevisionOf(state, jobId),
        registeredAt: job.registeredAt,
        attempts: Object.fromEntries(job.attemptOrder.map((id) => [id, attemptView(state, job, job.attempts[id])])),
        attemptOrder: [...job.attemptOrder],
        amendments,
        pendingAmendments: amendments.filter((entry) => entry.acknowledged === null),
      };
    },

    jobs() {
      return state.jobOrder.map((jobId) => {
        const job = state.jobs[jobId];
        const latestId = job.attemptOrder[job.attemptOrder.length - 1] ?? null;
        const latest = latestId ? job.attempts[latestId] : null;
        const pending = job.amendmentOrder
          .map((id) => amendmentView(state, jobId, job.amendments[id]))
          .filter((entry) => entry.acknowledged === null);
        return {
          id: job.id,
          role: job.role,
          pinnedRevision: job.pinnedRevision,
          effectiveRevision: effectiveRevisionOf(state, jobId),
          registeredAt: job.registeredAt,
          attemptCount: job.attemptOrder.length,
          phase: latest ? latest.phase : null,
          outcomeStatus: latest?.outcome?.status ?? null,
          pendingAmendmentCount: pending.length,
        };
      });
    },

    attempt(jobId, attemptId) {
      const job = state.jobs[jobId];
      if (!job) throw fail("not-found", `unknown job '${jobId}'`);
      const attempt = job.attempts[attemptId];
      if (!attempt) throw fail("not-found", `unknown attempt '${attemptId}' on job '${jobId}'`);
      return attemptView(state, job, attempt);
    },

    // ADR source evidence + curation obligation projection. Pure copy of the
    // authoritative entries; subordinate blobs are read (and hash-verified)
    // only by the adr-curation helper, never by this module.
    adr() {
      const manifests = state.adr.manifestOrder.map((manifestId) => {
        const entry = state.adr.manifests[manifestId];
        return {
          manifestId: entry.manifestId,
          schemaVersion: entry.schemaVersion,
          seq: entry.seq,
          at: entry.at,
          evidence: { ...entry.evidence },
          refs: Object.fromEntries(Object.entries(entry.refs).map(([name, ref]) => [name, { ...ref }])),
          landing: entry.landing ? { ...entry.landing } : null,
          disposition: entry.disposition,
          suppression: entry.suppression ? { ...entry.suppression } : null,
        };
      });
      const obligations = state.adr.obligationOrder.map((operationId) => ({ ...state.adr.obligations[operationId] }));
      return { manifests, obligations };
    },

    pendingAmendments(jobId = null) {
      const ids = jobId === null ? state.jobOrder : [jobId];
      const out = [];
      for (const id of ids) {
        const job = state.jobs[id];
        if (!job) throw fail("not-found", `unknown job '${id}'`);
        for (const amendmentId of job.amendmentOrder) {
          const view = amendmentView(state, id, job.amendments[amendmentId]);
          if (view.acknowledged === null) out.push(view);
        }
      }
      return out;
    },

    // Results produced against an older revision while a newer amendment for
    // the same job is unresolved. This is the distinct reconciliation surface:
    // a fulfilled-looking result never hides an outstanding amendment.
    reconciliations() {
      const out = [];
      for (const jobId of state.jobOrder) {
        const job = state.jobs[jobId];
        const effective = effectiveRevisionOf(state, jobId);
        for (const attemptId of job.attemptOrder) {
          const attempt = job.attempts[attemptId];
          if (!attempt.outcome) continue;
          if (attempt.outcome.revision >= effective) continue;
          const pendingRevisions = job.amendmentOrder
            .map((id) => amendmentView(state, jobId, job.amendments[id]))
            .filter((entry) => entry.acknowledged === null && entry.revision > attempt.outcome.revision)
            .map((entry) => entry.revision);
          const uniquePending = [...new Set(pendingRevisions)].sort((a, b) => a - b);
          const detail = uniquePending.length
            ? `result for job '${jobId}' was validated against revision ${attempt.outcome.revision}, but unacknowledged amendment(s) target revision(s) ${uniquePending.join(", ")}`
            : `result for job '${jobId}' was validated against revision ${attempt.outcome.revision}, but revision ${effective} is in force and no result against it has been recorded`;
          out.push({
            jobId,
            attemptId,
            outcomeRevision: attempt.outcome.revision,
            effectiveRevision: effective,
            pendingRevisions: uniquePending,
            detail,
          });
        }
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Cross-process writer lock (runtime coordination artifact, not a state store)
// ---------------------------------------------------------------------------

function lockPathFor(recordPath) {
  return `${recordPath}.lock`;
}

function readLockOwner(lockPath) {
  let raw;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
  try {
    const owner = JSON.parse(raw);
    if (!owner || typeof owner !== "object" || typeof owner.token !== "string") return null;
    return owner;
  } catch {
    return null;
  }
}

// A lock is stealable ONLY when its owner process is provably dead. A live
// owner — even one that looks slow — is never stolen; an owner whose identity
// cannot be verified is never stolen either.
function ownerIsStealable(owner, { alive = isProcessAlive } = {}) {
  if (!owner || typeof owner.pid !== "number") return false;
  if (!alive(owner.pid)) return true;
  if (owner.startTicks == null || owner.cmdlineHash == null) return false;
  const live = processFingerprint({ pid: owner.pid });
  if (!live) return false;
  return live.startTicks !== owner.startTicks || live.cmdlineHash !== owner.cmdlineHash;
}

function stealStaleLock(lockPath, { alive = isProcessAlive } = {}) {
  let fd = null;
  let st;
  let owner;
  try {
    fd = openSync(lockPath, "r");
    st = fstatSync(fd);
    owner = readLockOwner(lockPath);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
  if (!ownerIsStealable(owner, { alive })) return null;
  const tombstone = `${lockPath}.steal-${randomUUID()}`;
  try {
    renameSync(lockPath, tombstone);
  } catch {
    return null;
  }
  // Verify the inode we examined is the one moved out of the way; if another
  // process replaced the lock in between, restore nothing and simply retry.
  let moved = null;
  try {
    moved = fstatSync(openSync(tombstone, "r"));
  } catch {
    return null;
  }
  if (moved.ino !== st.ino || moved.dev !== st.dev) {
    try {
      unlinkSync(tombstone);
    } catch {}
    return null;
  }
  return tombstone;
}

function selfFingerprint() {
  return processFingerprint({ pid: process.pid });
}

function acquireWriterLock(lockPath, { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS, pollMs = LOCK_POLL_MS, clock = Date.now } = {}) {
  const deadline = clock() + timeoutMs;
  let lastOwner = null;
  for (;;) {
    const token = randomUUID();
    let fd = null;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      lastOwner = readLockOwner(lockPath);
      let tombstone = null;
      if (ownerIsStealable(lastOwner)) tombstone = stealStaleLock(lockPath);
      if (tombstone) {
        // The dead owner's lock is out of the way; try to take it now. Either
        // outcome retires the tombstone.
        let acquired = false;
        try {
          fd = openSync(lockPath, "wx", 0o600);
          acquired = true;
        } catch (createErr) {
          if (createErr?.code !== "EEXIST") throw createErr;
        }
        try {
          unlinkSync(tombstone);
        } catch {}
        if (acquired) {
          writeLockOwner(fd, token);
          return { path: lockPath, token };
        }
        continue;
      }
      if (clock() >= deadline) {
        const alive = lastOwner ? isProcessAlive(lastOwner.pid) : false;
        throw fail(
          "lock-contention",
          `change-record writer lock is held by ${lastOwner ? `pid ${lastOwner.pid} (${alive ? "alive" : "unresponsive"})` : "an unreadable or ownerless lock"}; ` +
            `gave up after ${timeoutMs}ms without stealing a possibly-live owner — resolve the owner or, if no writer process is alive, recover explicitly with breakWriterLock`,
        );
      }
      sleepSync(pollMs);
      continue;
    }
    writeLockOwner(fd, token);
    return { path: lockPath, token };
  }
}

function writeLockOwner(fd, token) {
  const fingerprint = selfFingerprint();
  const owner = {
    token,
    pid: process.pid,
    startTicks: fingerprint?.startTicks ?? null,
    cmdlineHash: fingerprint?.cmdlineHash ?? null,
    acquiredAt: Date.now(),
  };
  try {
    fchmodSync(fd, 0o600);
    writeFull(fd, Buffer.from(`${JSON.stringify(owner)}\n`, "utf8"), 0);
    fsyncSync(fd);
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

function verifyLockOwnership(lockPath, token) {
  const owner = readLockOwner(lockPath);
  if (!owner || owner.token !== token) {
    throw fail("lock-lost", "writer lock ownership could not be verified; refusing to append");
  }
}

function releaseWriterLock(lock) {
  try {
    const owner = readLockOwner(lock.path);
    if (owner && owner.token === lock.token) unlinkSync(lock.path);
  } catch {
    // Best-effort release; a leftover lock is recovered by the steal path.
  }
}

// Explicit operator recovery for a lock whose owner cannot be verified —
// typically a zero-byte or unparseable lock file left by a crash between
// O_EXCL creation and the owner write. It is never called automatically: such
// a lock proves nothing about liveness, so only an operator who has
// established that no writer process is running (host restart, direct process
// check) may clear it. The entry point stays safe by refusing a lock whose
// owner parses and is a live, matching process; removing that one manually
// remains possible but is the operator's own unchecked action.
export function breakWriterLock({ stateDir, changeId } = {}) {
  if (!stateDir) throw fail("invalid-arguments", "stateDir is required");
  const lockPath = lockPathFor(changeRecordPath(stateDir, changeId));
  const owner = readLockOwner(lockPath);
  if (owner && typeof owner.pid === "number" && !ownerIsStealable(owner)) {
    throw fail(
      "lock-contention",
      `writer lock is held by live process pid ${owner.pid}; breakWriterLock refuses to remove a possibly-live owner — terminate that process or remove the lock file manually after establishing it is gone`,
    );
  }
  try {
    unlinkSync(lockPath);
    return { removed: true, owner: owner ?? null };
  } catch (err) {
    if (err?.code === "ENOENT") return { removed: false, owner: null };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Record IO
// ---------------------------------------------------------------------------

function readRecordBuffer(path) {
  return readFileSync(path);
}

function truncateTo(path, length) {
  const fd = openSync(path, "r+");
  try {
    ftruncateSync(fd, length);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeEventFrames(path, position, buffers, inject = null) {
  if (inject?.beforeWrite) inject.beforeWrite({ bytes: buffers.reduce((sum, buffer) => sum + buffer.length, 0) });
  const fd = openSync(path, "r+");
  try {
    const stat = fstatSync(fd);
    if (stat.size !== position) {
      throw fail("io-error", `record size ${stat.size} does not match the committed offset ${position} while the writer lock is held`);
    }
    // Privacy is part of the storage contract: tighten a record back to 0600
    // if anything ever loosened it.
    if ((stat.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
    let written = position;
    for (let index = 0; index < buffers.length; index += 1) {
      if (inject?.beforeFrame) inject.beforeFrame({ index, total: buffers.length });
      writeFull(fd, buffers[index], written);
      written += buffers[index].length;
    }
    if (inject?.beforeSync) inject.beforeSync({ bytes: written - position });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// The only path from validated envelopes to durable bytes. `candidate` is the
// post-event state produced by the single validated application of
// `envelopes`; it replaces the cached state only AFTER the bytes are on disk.
// A rejected transition therefore writes nothing, and a successful return is
// consistent with durable state by construction — no transition is ever
// applied twice, and no bytes are written before the whole group validates.
function commitValidatedAppend(handle, envelopes, buffers, candidate, inject = null) {
  const position = handle.byteOffset;
  writeEventFrames(handle.path, position, buffers, inject);
  handle.state = candidate;
  handle.byteOffset = position + buffers.reduce((sum, buffer) => sum + buffer.length, 0);
  handle.pendingRecovery = null;
}

// ---------------------------------------------------------------------------
// Handle: create / open / append / bounded read / recover
// ---------------------------------------------------------------------------

function normalizeContext(context) {
  if (!context || typeof context !== "object") throw fail("invalid-context", "a trusted context is required (the actor is never taken from the payload)");
  const actor = context.actor;
  if (!actor || typeof actor !== "object" || !ACTOR_KINDS.includes(actor.kind)) {
    throw fail("invalid-context", `trusted actor kind must be one of ${ACTOR_KINDS.join(", ")}`);
  }
  const actorId = assertActorId(actor.id);
  const jobId = context.jobId === undefined || context.jobId === null ? null : assertIdentifier(context.jobId, "context jobId");
  const attemptId =
    context.attemptId === undefined || context.attemptId === null ? null : assertIdentifier(context.attemptId, "context attemptId");
  return { actor: { kind: actor.kind, id: actorId }, jobId, attemptId };
}

function assertPlainPayload(kind, payload) {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw fail("invalid-payload", `${kind} payload must be an object`);
  }
  const proto = Object.getPrototypeOf(payload);
  if (proto !== Object.prototype && proto !== null) {
    throw fail("invalid-payload", `${kind} payload must be a plain object`);
  }
  for (const key of Object.keys(payload)) {
    if (RESERVED_PAYLOAD_KEYS.includes(key)) {
      throw fail(
        "spoofed-identity",
        `payload key '${key}' is reserved for trusted envelope identity; pass it via the context argument instead`,
      );
    }
  }
  assertJsonSafe(payload, "payload");
  return payload;
}

function commandDigest({ kind, actor, jobId, attemptId, payload }) {
  return sha256Hex(
    Buffer.from(
      canonicalJson({ actor, attemptId, jobId, kind, payload }),
      "utf8",
    ),
  );
}

function buildEnvelope({ changeId, seq, eventId, commandId, digest, actor, kind, jobId, attemptId, at, payload }) {
  return {
    schema: SCHEMA_VERSION,
    changeId,
    seq,
    eventId,
    command: { id: commandId, digest },
    actor: { kind: actor.kind, id: actor.id },
    kind,
    jobId: jobId ?? null,
    attemptId: attemptId ?? null,
    at,
    payload,
  };
}

function buildContinuationEnvelopes({ changeId, baseSeq, actor, jobId, attemptId, at, commandId, markers, chunkSets }) {
  const envelopes = [];
  markers.forEach((marker, markerIndex) => {
    const chunks = chunkSets[markerIndex];
    for (let part = 1; part < marker.parts; part += 1) {
      const payload = { textId: marker.textId, part, text: chunks[part] };
      const continuationCommand = continuationCommandId(commandId, markerIndex, part);
      // Derived command IDs must satisfy the same identifier contract as
      // caller-chosen ones, otherwise the event would only fail on replay and
      // the record would be unreadable forever after.
      assertIdentifier(continuationCommand, "continuation commandId");
      envelopes.push(
        buildEnvelope({
          changeId,
          seq: baseSeq + envelopes.length + 1,
          eventId: randomUUID(),
          commandId: continuationCommand,
          digest: commandDigest({ kind: "text.continued", actor, jobId, attemptId, payload }),
          actor,
          kind: "text.continued",
          jobId,
          attemptId,
          at,
          payload,
        }),
      );
    }
  });
  return envelopes;
}

function missingContinuationParts(state, commandIndexEntry) {
  const missing = [];
  const splits = commandIndexEntry.splits ?? [];
  splits.forEach((marker, markerIndex) => {
    const text = state.texts[marker.textId];
    for (let part = 1; part < marker.parts; part += 1) {
      if (!text || text.chunks[part] === undefined) missing.push({ markerIndex, marker, part });
    }
  });
  return missing;
}

function createHandle({ stateDir, changeId, path, lockTimeoutMs }) {
  assertIdentifier(changeId, "changeId");
  const lockPath = lockPathFor(path);

  const handle = {
    changeId,
    path,
    lockPath,
    stateDir,
    lockTimeoutMs,
    state: null,
    byteOffset: 0,
    pendingRecovery: null, // { tornBytes, byteOffset } while a torn tail exists

    watermark() {
      return { lastSeq: this.state.lastSeq, byteOffset: this.byteOffset, pendingRecovery: this.pendingRecovery };
    },

    snapshot() {
      return {
        state: structuredClone(this.state),
        watermark: { lastSeq: this.state.lastSeq, byteOffset: this.byteOffset },
      };
    },

    get views() {
      return viewsFor(this.state);
    },

    append(kind, payload, options = {}) {
      return appendToHandle(handle, kind, payload, options);
    },

    readEvents({ afterSeq = 0, limit = 100 } = {}) {
      return readEventsFromPath(path, { afterSeq, limit });
    },

    // Explicit recovery: discard a torn final segment under exclusive writer
    // ownership. Complete malformed or checksum-invalid events are corruption
    // and are never touched.
    recover() {
      return recoverHandle(handle);
    },
  };

  return handle;
}

// Rebuild a handle entirely from a buffer of committed bytes (full replay).
// A module helper: object literals cannot carry private methods, and every
// caller already has the handle reference.
function resetHandleFromBuffer(handle, buffer, committedEnd) {
  const scan = scanFrames(buffer);
  if (scan.error) throw scan.error;
  handle.state = reduceEvents(scan.frames.map((frame) => frame.env), { changeId: handle.changeId });
  handle.byteOffset = committedEnd;
  handle.pendingRecovery = null;
}

// Explicit recovery: discard a torn final segment under exclusive writer
// ownership. Complete malformed or checksum-invalid events are corruption and
// are never touched.
function recoverHandle(handle) {
  const lock = acquireWriterLock(handle.lockPath, { timeoutMs: handle.lockTimeoutMs });
  try {
    verifyLockOwnership(handle.lockPath, lock.token);
    const buffer = readRecordBuffer(handle.path);
    const scan = scanFrames(buffer);
    if (scan.error) throw scan.error;
    const committedEnd = scan.tornStart ?? buffer.length;
    let truncatedBytes = 0;
    if (committedEnd < buffer.length) {
      truncatedBytes = buffer.length - committedEnd;
      truncateTo(handle.path, committedEnd);
      fsyncDirBestEffort(changesDir(handle.stateDir));
    }
    resetHandleFromBuffer(handle, buffer.subarray(0, committedEnd), committedEnd);
    return { truncatedBytes };
  } finally {
    releaseWriterLock(lock);
  }
}

// Refresh the handle's reduced state from the file. Called under the writer
// lock: applies other processes' committed events, and discards a torn final
// segment (exact recovery behavior documented in the header).
function refreshHandle(handle) {
  const buffer = readRecordBuffer(handle.path);
  const scan = scanFrames(buffer);
  if (scan.error) throw scan.error;
  const committedEnd = scan.tornStart ?? buffer.length;
  if (handle.byteOffset > committedEnd) {
    // The file shrank below this handle's committed offset: bytes this handle
    // already applied as committed events are gone. That is external damage,
    // never a torn append (recovery only ever cuts uncommitted tail bytes), so
    // fail hard instead of silently rebuilding a state that forgets events.
    throw fail(
      "state-divergence",
      `record file shrank below the handle's committed offset (${handle.byteOffset} > ${committedEnd} bytes); committed events disappeared and will not be silently discarded`,
    );
  }
  if (committedEnd < buffer.length) {
    // Torn final append: recover under the exclusive ownership we hold.
    truncateTo(handle.path, committedEnd);
    fsyncDirBestEffort(changesDir(handle.stateDir));
  }
  if (committedEnd === handle.byteOffset) {
    handle.pendingRecovery = null;
    return;
  }
  const newFrames = scan.frames.filter((frame) => frame.start >= handle.byteOffset);
  const candidate = structuredClone(handle.state);
  for (const frame of newFrames) applyEvent(candidate, frame.env);
  handle.state = candidate;
  handle.byteOffset = committedEnd;
  handle.pendingRecovery = null;
}

function appendToHandle(handle, kind, payloadRequested, options) {
  if (!EVENT_KINDS.includes(kind)) throw fail("unknown-kind", `event kind ${JSON.stringify(kind)} is unknown; it is not applied`);
  const payload = assertPlainPayload(kind, payloadRequested);
  const ctx = normalizeContext(options?.context);
  const requirements = KIND_ID_REQUIREMENTS[kind];
  if (requirements.jobId && !ctx.jobId) throw fail("invalid-context", `${kind} requires context.jobId`);
  if (requirements.attemptId && !ctx.attemptId) throw fail("invalid-context", `${kind} requires context.attemptId`);
  const commandId = options?.commandId === undefined ? `cmd-${randomUUID()}` : assertIdentifier(options.commandId, "commandId");
  const at = normalizeTimestamp(options?.now);
  const digest = commandDigest({ kind, actor: ctx.actor, jobId: ctx.jobId, attemptId: ctx.attemptId, payload });
  const inject = options?.inject ?? null;

  const lock = acquireWriterLock(handle.lockPath, { timeoutMs: options?.lockTimeoutMs });
  try {
    verifyLockOwnership(handle.lockPath, lock.token);
    if (inject?.holdLockMs) sleepSync(inject.holdLockMs);
    refreshHandle(handle);

    // Idempotency first: a retry's expectations describe the world before its
    // first commit, so they are not re-checked against the post-event state.
    const prior = handle.state.commandIndex[commandId];
    if (prior) {
      if (prior.digest !== digest) {
        throw fail(
          "command-conflict",
          `command '${commandId}' is already committed with different input; a command ID is never reused for new semantics`,
        );
      }
      const retry = reconstructionForRetry(handle, kind, payload, prior, commandId, ctx, at);
      if (retry.envelopes.length) {
        // Complete the interrupted continuation group: exact chunks
        // reconstructed from the identical retry payload, consecutive
        // sequences, the whole completion validated before a single byte is
        // written.
        const candidate = structuredClone(handle.state);
        for (const env of retry.envelopes) applyEvent(candidate, env);
        const buffers = retry.envelopes.map((env) => encodeFrame(env));
        commitValidatedAppend(handle, retry.envelopes, buffers, candidate, inject);
      }
      return {
        committed: false,
        dedupe: true,
        seq: prior.seq,
        eventId: prior.eventId,
        commandId,
        completedMissingParts: retry.missingCount,
      };
    }

    checkExpectations(handle.state, ctx, options?.expect);

    // Build the event group (primary + large-text continuations) and validate
    // the whole proposed transition against the committed state via the pure
    // reducer before a single byte is written. This is the ONLY application of
    // the transition: the validated candidate becomes the cached state after
    // the durable write, so caller success and durable state always agree.
    const split = splitLargeTextFields(kind, payload);
    const primary = buildEnvelope({
      changeId: handle.changeId,
      seq: handle.state.lastSeq + 1,
      eventId: randomUUID(),
      commandId,
      digest,
      actor: ctx.actor,
      kind,
      jobId: ctx.jobId,
      attemptId: ctx.attemptId,
      at,
      payload: split.payload,
    });
    const envelopes = [primary];
    if (split.splits) {
      envelopes.push(
        ...buildContinuationEnvelopes({
          changeId: handle.changeId,
          baseSeq: primary.seq,
          actor: ctx.actor,
          jobId: ctx.jobId,
          attemptId: ctx.attemptId,
          at,
          commandId,
          markers: split.splits,
          chunkSets: split.chunkSets,
        }),
      );
    }

    const candidate = structuredClone(handle.state);
    for (const env of envelopes) applyEvent(candidate, env);

    // Durable success: complete bytes + fsync before acknowledging.
    const buffers = envelopes.map((env) => encodeFrame(env));
    commitValidatedAppend(handle, envelopes, buffers, candidate, inject);
    return { committed: true, seq: primary.seq, eventId: primary.eventId, commandId };
  } finally {
    releaseWriterLock(lock);
  }
}

// Rebuild the exact continuation events an idempotent retry must complete.
// The retry's semantic input is byte-identical (its command digest matched),
// so re-splitting the retry payload reproduces the original chunks exactly;
// the committed markers (text IDs, field paths, part counts) stay
// authoritative. Missing parts get consecutive sequences in a deterministic
// order, and nothing is written unless every chunk reconstructs — a retry
// never stores a placeholder for text it cannot recover.
function reconstructionForRetry(handle, kind, payload, prior, commandId, ctx, at) {
  const missing = missingContinuationParts(handle.state, prior);
  if (!missing.length) return { envelopes: [], missingCount: 0 };
  const retrySplit = splitLargeTextFields(kind, payload);
  if (!retrySplit.splits || retrySplit.splits.length !== prior.splits.length) {
    throw fail("command-conflict", `retry of command '${commandId}' does not carry the large text its first attempt committed`);
  }
  const chunkSets = prior.splits.map((marker) => {
    const index = retrySplit.splits.findIndex((candidate) => candidate.field === marker.field && candidate.parts === marker.parts);
    if (index === -1) {
      throw fail(
        "command-conflict",
        `retry of command '${commandId}' no longer carries large text field '${marker.field}' (${marker.parts} parts) as first committed`,
      );
    }
    return retrySplit.chunkSets[index];
  });
  let nextSeq = handle.state.lastSeq;
  const envelopes = [];
  for (const { markerIndex, marker, part } of missing) {
    const chunk = chunkSets[markerIndex][part];
    if (typeof chunk !== "string") {
      throw fail(
        "command-conflict",
        `retry of command '${commandId}' cannot reconstruct part ${part} of text '${marker.textId}'; refusing to write a placeholder`,
      );
    }
    nextSeq += 1;
    const payloadPart = { textId: marker.textId, part, text: chunk };
    const continuationCommand = continuationCommandId(commandId, markerIndex, part);
    assertIdentifier(continuationCommand, "continuation commandId");
    envelopes.push(
      buildEnvelope({
        changeId: handle.changeId,
        seq: nextSeq,
        eventId: randomUUID(),
        commandId: continuationCommand,
        digest: commandDigest({ kind: "text.continued", actor: ctx.actor, jobId: ctx.jobId, attemptId: ctx.attemptId, payload: payloadPart }),
        actor: ctx.actor,
        kind: "text.continued",
        jobId: ctx.jobId,
        attemptId: ctx.attemptId,
        at,
        payload: payloadPart,
      }),
    );
  }
  return { envelopes, missingCount: missing.length };
}

function checkExpectations(state, ctx, expect) {
  if (!expect) return;
  if (expect.assignmentRevision !== undefined) {
    const current = ctx.jobId ? effectiveRevisionOf(state, ctx.jobId) : state.changeRevision;
    if (current !== expect.assignmentRevision) {
      throw fail(
        "expectation-failed",
        `expected assignment revision ${expect.assignmentRevision} but committed state has ${current}`,
      );
    }
  }
  if (expect.attemptPhase !== undefined) {
    if (!ctx.attemptId) throw fail("invalid-context", "expect.attemptPhase requires context.attemptId");
    const attempt = state.jobs[ctx.jobId]?.attempts[ctx.attemptId];
    if (!attempt) throw fail("expectation-failed", `expected attempt '${ctx.attemptId}' does not exist`);
    if (attempt.phase !== expect.attemptPhase) {
      throw fail("expectation-failed", `expected attempt '${ctx.attemptId}' phase '${expect.attemptPhase}' but it is '${attempt.phase}'`);
    }
  }
  // The "still the intended active attempt" expectation used by execution
  // updates: the attempt must still be the job's newest attempt and must not
  // have settled. A phase/attempt change racing an update is then a truthful
  // refusal under the writer lock — never a silent retarget.
  if (expect.attemptActive !== undefined) {
    if (!ctx.attemptId) throw fail("invalid-context", "expect.attemptActive requires context.attemptId");
    const job = state.jobs[ctx.jobId];
    const attempt = job?.attempts[ctx.attemptId];
    if (!attempt) throw fail("expectation-failed", `expected attempt '${ctx.attemptId}' does not exist`);
    const latest = job.attemptOrder[job.attemptOrder.length - 1] ?? null;
    const active = latest === ctx.attemptId && !attempt.outcome && attempt.phase !== "terminal";
    if (expect.attemptActive !== active) {
      throw fail(
        "expectation-failed",
        `attempt '${ctx.attemptId}' is ${active ? "" : "no longer "}the intended active attempt of job '${ctx.jobId}'`,
      );
    }
  }
}

function readEventsFromPath(path, { afterSeq = 0, limit = 100 }) {
  if (!Number.isInteger(afterSeq) || afterSeq < 0) throw fail("invalid-read", "afterSeq must be a non-negative integer");
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw fail("invalid-read", "limit must be an integer in [1, 10000]");
  const buffer = readRecordBuffer(path);
  const scan = scanFrames(buffer);
  if (scan.error) throw scan.error;
  const events = [];
  let lastReturned = afterSeq;
  let hasMore = false;
  for (const frame of scan.frames) {
    if (frame.env.seq <= afterSeq) continue;
    if (events.length >= limit) {
      hasMore = true;
      break;
    }
    events.push(frame.env);
    lastReturned = frame.env.seq;
  }
  const lastFrame = scan.frames[scan.frames.length - 1] ?? null;
  return {
    events,
    nextAfterSeq: events.length ? lastReturned : afterSeq,
    hasMore,
    watermark: {
      lastSeq: lastFrame ? lastFrame.env.seq : 0,
      byteOffset: lastFrame ? lastFrame.end : 0,
      tornTailBytes: scan.tornStart !== null ? buffer.length - (lastFrame?.end ?? 0) : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export function createChange({ stateDir, changeId, actor, title = null, commandId, now } = {}) {
  if (!stateDir) throw fail("invalid-arguments", "stateDir is required");
  assertIdentifier(changeId, "changeId");
  // Validate the trusted context before touching the filesystem so a bad
  // caller cannot litter an empty record file.
  normalizeContext({ actor });
  const dir = ensureRecordDir(stateDir);
  const path = changeRecordPath(stateDir, changeId);
  let created = false;
  try {
    const fd = openSync(path, "wx", 0o600);
    created = true;
    try {
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    // A concurrent creator or a retry after acknowledgement loss: fall through
    // to the idempotent change.created append, which either deduplicates
    // against the committed command or fails loudly on a real conflict.
  }
  if (created) {
    fsyncDirBestEffort(dir);
  } else {
    const stat = statSync(path);
    if (!stat.isFile()) {
      throw fail("invalid-state", `change record path for '${changeId}' exists and is not a regular file`);
    }
    // An existing record must satisfy the privacy contract: tighten the mode,
    // never loosen it, and leave content and ownership alone.
    if ((stat.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
  }
  const handle = openChange({ stateDir, changeId });
  handle.append("change.created", { title: title ?? null }, { context: { actor }, commandId, now });
  return handle;
}

export function openChange({ stateDir, changeId, recover = false, lockTimeoutMs } = {}) {
  if (!stateDir) throw fail("invalid-arguments", "stateDir is required");
  const path = changeRecordPath(stateDir, changeId);
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    throw fail("not-found", `no change record for '${changeId}' under ${changesDir(stateDir)}`);
  }
  const handle = createHandle({ stateDir, changeId, path, lockTimeoutMs });
  const buffer = readRecordBuffer(path);
  const scan = scanFrames(buffer);
  if (scan.error) throw scan.error;
  const committedEnd = scan.tornStart ?? buffer.length;
  handle.state = reduceEvents(scan.frames.map((frame) => frame.env), { changeId });
  handle.byteOffset = committedEnd;
  if (committedEnd < size) {
    handle.pendingRecovery = { tornBytes: size - committedEnd, byteOffset: committedEnd };
    if (recover) handle.recover();
  }
  return handle;
}

export function recoverChange({ stateDir, changeId, lockTimeoutMs } = {}) {
  const handle = openChange({ stateDir, changeId, lockTimeoutMs });
  return handle.recover();
}
