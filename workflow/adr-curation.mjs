// ADR source-evidence retention and the recoverable post-landing curation
// obligation.
//
// Purpose
// -------
// ADR curation runs AFTER a successful source landing, nonblocking and
// retryable. Ticket archival, worktree retirement and final report assembly
// happen at distinct times and each is destructive or late, so this module is
// the evidence source/obligation seam: BEFORE the destructive ticket reset or
// worktree retirement it retains the exact ticket content and provenance as a
// versioned, immutable source manifest (subordinate evidence blob) plus typed
// references, and only a VERIFIED successful real source landing activates a
// pending curation obligation — recorded in the SAME authoritative managed
// change record (workflow/change-record.mjs). There is no independent
// curation scheduler or database, the jobs cache is never a second source of
// truth, and the source manifest is deliberately NOT searchable/indexed.
//
// Authority and content
// ---------------------
// The change record events (`adr.source_manifest`, `adr.source_completion`,
// `adr.curation_obligation`) are the workflow authority. The manifest blob
// under `<stateDir>/adr-sources/<manifestId>.json` (mode 0600) is subordinate
// immutable content referenced by path+sha256, never fetched by the record
// and never authoritative for status. A manifest retains, verbatim:
//   * the exact ticket content and its provenance (path, digest, project,
//     coordinating owner, phase identity, worktree/branch, launch metadata);
//   * the immutable original phase/task constraints (exact revision/seq);
//   * every ordered committed update with its target job/attempt/revision and
//     its ACKNOWLEDGEMENT and OUTCOME references taken ONLY from the
//     authoritative record events — never inferred from textual claims;
//     rejected/unresolved material stays attributed source (resolution
//     'unresolved'), never accepted policy;
//   * full durable role-report REFERENCES (report IDs retrievable from the
//     shared report store — never truncated summaries), each with an explicit
//     retained / record-only / pending / missing state;
//   * intended landing evidence at capture and the OBSERVED merge/ff receipt
//     as available, plus the exact record snapshot/version/sequence boundary.
// Raw provider transcripts, private reasoning and transcript mining are out of
// scope by construction: only ticket text, record events and report
// references are read. Recovery treats captured content strictly as inert
// JSON data — it never executes code or credentials from it.
//
// Failure and recovery semantics (exact)
// --------------------------------------
// Capture/obligation failure NEVER rolls back or fails a completed source
// landing: the landing result stays truthful and carries a bounded warning
// and a pending/incomplete curation state. When capture (or the receipt
// handoff) fails, the SOLE unretained required evidence is left intact for
// recovery — the caller must not clean it up (landWorktree preserves the
// ticket and worktree in that case). The landing receipt handoff is written
// (idempotently) BEFORE the obligation event, and manifest blobs are written
// before their events, so `recoverAdrCuration` can reconstruct a staged
// manifest or a pending obligation after an interrupted capture/archive/
// receipt handoff — but ONLY from verified retained evidence. A failed or
// unknown landing stays uncurated: no receipt, no obligation, no false
// success. Nothing here schedules work, launches a worker, sends a
// notification, or claims exactly-once delivery; source landing notifications
// remain the current mechanism and no curation wake-up exists until a
// consumer does.
//
// Suppression (future ADR-only publication, recursive-curation guard)
// ------------------------------------------------------------------
// Capture is ON by default for ordinary managed source changes. Suppression
// is decided ONLY from the verified changed-path set confined to defined ADR
// roots, or a trusted INTERNAL opt-out (publisher-only, explicit reason and
// provenance) — never from model/textual claims. The actual ADR storage root
// is not established yet, so `ADR_ROOTS` is empty and only the trusted
// publisher opt-out is active until roots are configured. A suppressed
// landing records an explicit 'suppressed' disposition (never a pending
// obligation), which is what prevents an ADR publication from curating
// itself.
//
// Processing status (reusable by the next phase, read/claim surface kept
// minimal): 'none' | 'prepared' | 'pending' | 'incomplete' | 'no-change' |
// 'suppressed'. Jev extraction, curation workers, ADR authoring/publication,
// user-facing tools and indexing are deliberately NOT implemented here.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ADR_REQUIRED_REFS,
  SCHEMA_VERSION as RECORD_SCHEMA_VERSION,
  openChange,
  viewsFor,
} from "./change-record.mjs";
import { changedPaths, currentBranch, defaultBaseRef, defaultLocalBranch, git, operationalPath } from "./git.mjs";
import { readReportMeta } from "./reports.mjs";
import { resolveTicketSource } from "./ticket.mjs";

export const ADR_SOURCE_MANIFEST_SCHEMA = 1;
export const PROCESSING_STATUSES = Object.freeze(["none", "prepared", "pending", "incomplete", "no-change", "suppressed"]);
export const VIEW_MANIFESTS_MAX = 8;
export const VIEW_OBLIGATIONS_MAX = 8;

// The ADR storage root is not yet established. While this list is empty only
// the trusted internal publisher opt-out can suppress capture; ordinary
// managed source changes are captured by default. No path scheme migration is
// performed here.
export const ADR_ROOTS = Object.freeze([]);

const MANIFEST_NOTE = "ADR source evidence retained for post-landing architectural curation";

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function clampText(value, max) {
  const text = typeof value === "string" ? value : value == null ? "" : String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} chars omitted]`;
}

function assertName(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw fail("invalid-arguments", `${name} must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ (got ${JSON.stringify(value ?? null)})`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Deterministic operation identity (duplicate callbacks/recovery never create
// duplicate obligations)
// ---------------------------------------------------------------------------

export function adrOperationIds({ changeId, attemptId }) {
  assertName(changeId, "changeId");
  assertName(attemptId, "attemptId");
  const short = sha256Hex(Buffer.from(`${changeId}:${attemptId}`, "utf8")).slice(0, 24);
  return {
    manifestId: `adr-src-${short}`,
    operationId: `adr-cur-${short}`,
    manifestCommandId: `adr-manifest-${short}`,
    obligationCommandId: `adr-obligation-${short}`,
  };
}

export function adrCompletionCommandId(manifestId, payload) {
  assertName(manifestId, "manifestId");
  return `adr-complete-${sha256Hex(Buffer.from(canonicalJson({ manifestId, payload }), "utf8")).slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// Suppression (narrowly validated; never from textual claims)
// ---------------------------------------------------------------------------

/**
 * Decide — and only ever decide — from the VERIFIED changed-path set confined
 * to defined ADR roots, or a trusted internal opt-out for the publisher with
 * explicit reason and provenance. Any other input shape fails loudly (an
 * arbitrary claim can never suppress capture); ordinary managed source
 * changes default ON.
 */
export function resolveAdrSuppression({ changedPaths = [], verified = false, adrRoots = ADR_ROOTS, trustedPublicationOptOut = null } = {}) {
  if (trustedPublicationOptOut != null) {
    const opt = trustedPublicationOptOut;
    if (typeof opt !== "object" || Array.isArray(opt)) {
      throw fail("invalid-suppression", "the trusted publication opt-out must be an object with an explicit reason and provenance");
    }
    if (typeof opt.reason !== "string" || !opt.reason.trim()) {
      throw fail("invalid-suppression", "the trusted publication opt-out requires an explicit non-empty reason");
    }
    if (typeof opt.provenance !== "string" || !opt.provenance.trim()) {
      throw fail("invalid-suppression", "the trusted publication opt-out requires explicit provenance");
    }
    if (opt.publisher !== true) {
      throw fail("invalid-suppression", "the trusted suppression opt-out is available to the ADR publisher only; ordinary managed source changes are captured by default");
    }
    return {
      suppressed: true,
      basis: "trusted-opt-out",
      reason: clampText(opt.reason.trim(), 2000),
      provenance: clampText(opt.provenance.trim(), 2000),
      publisher: true,
    };
  }
  const roots = (Array.isArray(adrRoots) ? adrRoots : [])
    .map((entry) => String(entry).replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  const paths = (Array.isArray(changedPaths) ? changedPaths : []).map(String).filter(Boolean);
  if (roots.length > 0 && verified && paths.length > 0
    && paths.every((path) => roots.some((root) => path === root || path.startsWith(`${root}/`)))) {
    return {
      suppressed: true,
      basis: "adr-roots",
      reason: `the verified changed-path set is confined to the ADR root(s) ${roots.join(", ")}`,
      provenance: "changed-path set derived from the repository's committed and working-tree state",
      changedPaths: { verified: true, count: paths.length, allWithinAdrRoots: true },
    };
  }
  return { suppressed: false, basis: null };
}

// The verified changed-path set: committed changes against the local default
// base plus the working tree, straight from git — never a textual claim.
async function defaultChangedPathsOf({ worktree, branch = null, mainRoot = null } = {}) {
  const cwd = worktree ?? mainRoot;
  if (!cwd) return { paths: [], verified: false, reason: "no working tree to derive the changed-path set from" };
  const paths = new Set();
  let verified = true;
  let base = null;
  try {
    base = await defaultLocalBranch(cwd);
  } catch {
    try {
      base = await defaultBaseRef(cwd);
    } catch {
      verified = false;
    }
  }
  try {
    const target = branch ?? (await currentBranch(cwd));
    if (base && target && target !== "HEAD" && target !== base) {
      const diff = await git(cwd, ["diff", "--name-only", `${base}...${target}`]);
      for (const line of diff.split("\n")) if (line.trim()) paths.add(line.trim());
    }
  } catch {
    verified = false;
  }
  try {
    // Include individual untracked files rather than collapsed directory
    // entries; parse both sides of renames literally, as managed staging does.
    for (const change of await changedPaths(cwd)) {
      for (const path of change.paths) paths.add(path);
    }
  } catch {
    verified = false;
  }
  const filtered = [...paths]
    .filter((path) => path && !operationalPath(path))
    .sort();
  return { paths: filtered, verified, ...(verified ? {} : { reason: "the changed-path set could not be fully derived from git" }) };
}

// ---------------------------------------------------------------------------
// Immutable subordinate evidence blob (never indexed, never a status source)
// ---------------------------------------------------------------------------

export function adrSourcesDir(stateDir) {
  return join(stateDir, "adr-sources");
}

export function adrSourcePath(stateDir, manifestId) {
  assertName(manifestId, "manifestId");
  return join(adrSourcesDir(stateDir), `${manifestId}.json`);
}

function manifestFingerprint(manifest) {
  return sha256Hex(Buffer.from(canonicalJson({ ...manifest, stagedAt: null }), "utf8"));
}

function validateManifestShape(manifest, { expectManifestId = null } = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw fail("corrupt-artifact", "ADR source manifest artifact is not an object");
  }
  if (manifest.schema !== "adr-source-manifest") {
    throw fail("corrupt-artifact", `ADR source manifest artifact schema ${JSON.stringify(manifest.schema)} is unknown`);
  }
  if (manifest.schemaVersion !== ADR_SOURCE_MANIFEST_SCHEMA) {
    // Unknown versions are rejected, never silently applied.
    throw fail("unknown-schema", `ADR source manifest schema version ${JSON.stringify(manifest.schemaVersion)} is unknown; supported version is ${ADR_SOURCE_MANIFEST_SCHEMA}`);
  }
  assertName(manifest.manifestId, "manifest.manifestId");
  if (expectManifestId && manifest.manifestId !== expectManifestId) {
    throw fail("corrupt-artifact", `ADR source manifest artifact '${expectManifestId}' carries manifestId '${manifest.manifestId}'`);
  }
  return manifest;
}

/**
 * Read the retained manifest blob. Fails honestly on a missing or corrupted
 * artifact (it is never guessed or reconstructed from anything else).
 */
export function readAdrSourceManifest(stateDir, manifestId) {
  const path = adrSourcePath(stateDir, manifestId);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw fail("missing-artifact", `retained ADR source manifest '${manifestId}' is missing at ${path}: ${error?.message ?? error}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw fail("corrupt-artifact", `retained ADR source manifest '${manifestId}' is corrupt: ${error?.message ?? error}`);
  }
  return validateManifestShape(manifest, { expectManifestId: manifestId });
}

/**
 * Write the manifest blob once (mode 0600, tmp + rename). An existing
 * artifact with the same content fingerprint (everything except the capture
 * timestamp) is reused idempotently — the returned sha256 always hashes the
 * EXACT file bytes, so an interrupted capture retried later derives the same
 * evidence reference. A conflicting rewrite of an immutable manifest fails.
 */
export function writeAdrSourceBlob(stateDir, manifest) {
  validateManifestShape(manifest);
  const path = adrSourcePath(stateDir, manifest.manifestId);
  if (existsSync(path)) {
    const existing = readAdrSourceManifest(stateDir, manifest.manifestId);
    if (manifestFingerprint(existing) !== manifestFingerprint(manifest)) {
      throw fail("immutable-conflict", `retained ADR source manifest '${manifest.manifestId}' already exists with different content; an immutable manifest is never rewritten`);
    }
    const bytes = readFileSync(path);
    return { path, sha256: sha256Hex(bytes), bytes: bytes.length, dedupe: true };
  }
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const buffer = Buffer.from(text, "utf8");
  mkdirSync(adrSourcesDir(stateDir), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, buffer, { mode: 0o600 });
  renameSync(tmp, path);
  return { path, sha256: sha256Hex(buffer), bytes: buffer.length, dedupe: false };
}

// ---------------------------------------------------------------------------
// Manifest construction (pure over the authoritative record state)
// ---------------------------------------------------------------------------

function readAllEvents(handle) {
  const events = [];
  let afterSeq = 0;
  for (;;) {
    const page = handle.readEvents({ afterSeq, limit: 10_000 });
    events.push(...page.events);
    if (!page.hasMore) return events;
    afterSeq = page.nextAfterSeq;
  }
}

/**
 * Build the versioned source manifest from the AUTHORITATIVE record state.
 * Acknowledgement and outcome references come only from `worker.acknowledged`
 * and `attempt.outcome` events — never from textual claims in any source.
 */
export function buildAdrSourceManifest({
  state,
  changeId,
  jobId,
  attemptId,
  events = [],
  ticket,
  provenance,
  intendedLanding = null,
  reportExists = () => true,
  now = Date.now(),
} = {}) {
  const views = viewsFor(state);
  const eventIndex = new Map(events.map((env) => [env.seq, env]));
  const refOf = (seq) => {
    const env = eventIndex.get(seq);
    return env
      ? { eventId: env.eventId, commandId: env.command.id, actor: { ...env.actor } }
      : { eventId: null, commandId: null, actor: null };
  };
  const jobState = state.jobs[jobId];
  const attempt = jobState?.attempts[attemptId];
  if (!attempt) throw fail("not-found", `attempt '${attemptId}' is not recorded on job '${jobId}'`);
  const launch = attempt.launchIntent.launch ?? {};

  // 1. Exact ticket content + provenance (captured before any destructive
  //    ticket reset/worktree retirement; see the stage entry point).
  const ticketRef = ticket?.path
    ? {
      path: ticket.path,
      sessionId: ticket.sessionId ?? null,
      sha256: ticket.sha256,
      bytes: ticket.bytes,
      text: ticket.text,
    }
    : { path: null, sessionId: ticket?.sessionId ?? null, reason: ticket?.reason ?? "the exact ticket content could not be captured" };

  // 2. The immutable original phase/task constraints (verbatim).
  const constraintsRevision = attempt.launchIntent.revision;
  const constraintsEntry = state.revisions[constraintsRevision - 1] ?? null;
  const constraintsView = constraintsRevision ? views.assignment({ revision: constraintsRevision }) : null;
  const constraintsAssignment = constraintsView?.assignment ?? null;
  const instructions = typeof constraintsAssignment === "string"
    ? constraintsAssignment
    : constraintsAssignment?.instructions ?? null;
  const constraints = {
    revision: constraintsRevision,
    seq: constraintsEntry?.seq ?? null,
    ...refOf(constraintsEntry?.seq),
    scope: constraintsEntry?.scope ?? null,
    instructions,
    complete: constraintsView?.complete ?? false,
    incompleteTexts: constraintsView?.incompleteTexts ?? [],
  };

  // 3. Every ordered committed update (job-scoped assignment revision) with
  //    its target job/attempt/revision and its ACK/outcome references. A
  //    source's approval is never inferred from text: only the record's
  //    acknowledgement and outcome events count, and rejected/unresolved
  //    material stays attributed source (never accepted policy).
  const updates = [];
  const outcomeSeqs = [];
  for (const entry of state.revisions.filter((revision) => revision.scope?.kind === "job")) {
    const targetJob = state.jobs[entry.scope.jobId] ?? null;
    const revisionView = views.assignment({ revision: entry.revision });
    const amendment = targetJob
      ? Object.values(targetJob.amendments).find((candidate) => candidate.revision === entry.revision) ?? null
      : null;
    let acknowledgement = null;
    let acknowledgedAttemptId = null;
    if (targetJob) {
      for (const aid of targetJob.attemptOrder) {
        const ack = targetJob.attempts[aid].acknowledgements.find((candidate) => candidate.revision === entry.revision);
        if (ack) {
          acknowledgement = { attemptId: aid, revision: entry.revision, at: ack.at, seq: ack.seq };
          acknowledgedAttemptId = aid;
          break;
        }
      }
    }
    const targetedAttemptId = amendment?.targetedAttemptId ?? acknowledgedAttemptId;
    const targetedAttempt = targetJob && targetedAttemptId ? targetJob.attempts[targetedAttemptId] ?? null : null;
    const outcome = targetedAttempt?.outcome
      ? {
        status: targetedAttempt.outcome.status,
        revision: targetedAttempt.outcome.revision,
        seq: targetedAttempt.outcome.seq,
        at: targetedAttempt.outcome.at,
        reportId: targetedAttempt.outcome.payload?.reportId ?? null,
      }
      : null;
    if (outcome) outcomeSeqs.push(outcome.seq);
    const isLaunchRevision = targetJob
      ? targetJob.attemptOrder.some((aid) => targetJob.attempts[aid].launchIntent.revision === entry.revision)
      : false;
    const resolution = acknowledgement ? "acknowledged" : isLaunchRevision ? "launch-revision" : "unresolved";
    updates.push({
      kind: amendment ? "amendment" : "assignment-revision",
      revision: entry.revision,
      seq: entry.seq,
      ...refOf(entry.seq),
      targetJobId: entry.scope.jobId,
      targetRole: targetJob?.role ?? null,
      targetedAttemptId: targetedAttemptId ?? null,
      amendmentId: amendment?.amendmentId ?? null,
      // The verbatim coordinator instruction (never a paraphrase or summary).
      instruction: revisionView?.note ?? null,
      instructionComplete: revisionView?.noteComplete ?? false,
      submittedAt: amendment?.submittedAt ?? null,
      acceptedAt: amendment?.acceptedAt ?? null,
      acknowledgement,
      outcome,
      resolution,
      // Unresolved/rejected material is retained as attributed source only.
      acceptedPolicy: resolution === "acknowledged",
    });
  }
  updates.sort((a, b) => a.revision - b.revision);

  // 4. Full durable role-report REFERENCES (never truncated summaries), each
  //    with an explicit retained / record-only / pending / missing state.
  const roleReports = [];
  for (const roleJobId of state.jobOrder) {
    const roleJob = state.jobs[roleJobId];
    if (roleJob.role === "execution") continue;
    for (const roleAttemptId of roleJob.attemptOrder) {
      const roleAttempt = roleJob.attempts[roleAttemptId];
      const push = (kind, label, seq, reportId, outcomeStatus = null) => {
        let status;
        let reason = null;
        if (reportId) {
          const exists = reportExists(reportId);
          status = exists ? "retained" : "missing";
          if (!exists) reason = `retained report reference '${reportId}' has no persisted report artifact`;
        } else {
          status = "record-only";
          reason = "the authoritative record event is the retained source for this entry (exact seq reference)";
        }
        roleReports.push({ role: roleJob.role, jobId: roleJobId, attemptId: roleAttemptId, kind, label, seq, reportId: reportId ?? null, outcomeStatus, status, reason });
      };
      if (roleAttempt.outcome) {
        if (roleAttempt.outcome.seq) outcomeSeqs.push(roleAttempt.outcome.seq);
        push("outcome", "role-outcome", roleAttempt.outcome.seq, roleAttempt.outcome.payload?.reportId ?? null, roleAttempt.outcome.status);
      }
      for (const evidence of roleAttempt.evidence) {
        if (evidence.reportId) push("evidence", evidence.label, evidence.seq, evidence.reportId);
      }
      if (!roleAttempt.outcome && roleAttempt.evidence.length === 0) {
        roleReports.push({
          role: roleJob.role,
          jobId: roleJobId,
          attemptId: roleAttemptId,
          kind: "attempt",
          label: "role-attempt",
          seq: roleAttempt.launchIntent.seq,
          reportId: null,
          outcomeStatus: null,
          status: "pending",
          reason: "the role attempt has no recorded outcome or durable report yet",
        });
      }
    }
  }

  // 5. The exact snapshot/version/sequence boundary of retained sources.
  const recordSnapshot = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    lastSeq: state.lastSeq,
    constraintsSeq: constraints.seq,
    updateSeqs: updates.map((entry) => entry.seq),
    outcomeSeqs: [...new Set(outcomeSeqs)].sort((a, b) => a - b),
    capturedAt: now,
  };

  // 6. Explicit required/optional references. Every required reference is
  //    present as retained/pending/missing — never silently absent.
  const missingReports = roleReports.filter((entry) => entry.status === "missing");
  const pendingReports = roleReports.filter((entry) => entry.status === "pending");
  const roleReportsStatus = missingReports.length ? "missing" : pendingReports.length ? "pending" : "retained";
  const refs = {
    ticket: ticketRef.path
      ? { status: "retained", path: ticketRef.path, sha256: ticketRef.sha256, bytes: ticketRef.bytes }
      : { status: "missing", reason: clampText(ticketRef.reason, 500) },
    provenance: { status: "retained" },
    constraints: instructions != null
      ? { status: "retained", seq: constraints.seq }
      : { status: "missing", reason: "the immutable original constraints text is unavailable in the record", seq: constraints.seq ?? null },
    amendments: { status: "retained", count: updates.length },
    roleReports: {
      status: roleReportsStatus,
      count: roleReports.length,
      reason: roleReportsStatus === "retained" ? null
        : clampText(`${missingReports.length} missing, ${pendingReports.length} pending role report reference(s)`, 500),
    },
    landingReceipt: { status: "pending", reason: "the verified landing receipt is retained post-landing" },
    archivePath: { status: "pending", reason: "the ticket archive path exists only after archival" },
    executionReport: { status: "pending", reason: "the execution's final durable report is published after landing returns" },
  };

  const ids = adrOperationIds({ changeId, attemptId });
  return {
    schema: "adr-source-manifest",
    schemaVersion: ADR_SOURCE_MANIFEST_SCHEMA,
    manifestId: ids.manifestId,
    operationId: ids.operationId,
    changeId,
    jobId,
    attemptId,
    project: provenance?.project ?? launch.root ?? null,
    owner: provenance?.owner ?? launch.owner ?? null,
    phaseId: provenance?.phaseId ?? launch.phaseId ?? null,
    stagedAt: now,
    ticket: ticketRef,
    provenance: {
      project: provenance?.project ?? launch.root ?? null,
      owner: provenance?.owner ?? launch.owner ?? null,
      phaseId: provenance?.phaseId ?? launch.phaseId ?? null,
      changeId,
      jobId,
      attemptId,
      worktree: provenance?.worktree ?? null,
      branch: provenance?.branch ?? null,
      sessionTag: ticket?.sessionId ?? null,
      baseSelection: provenance?.baseSelection ?? null,
      launch,
      constraintsRevision,
      capturedAt: now,
    },
    constraints,
    updates,
    roleReports,
    recordSnapshot,
    landing: { intended: intendedLanding ?? null, observed: null },
    refs,
    policy: {
      textualClaimsTreatedAsPolicy: false,
      note: "acknowledgement/outcome references derive only from authoritative record events; unresolved material is attributed source, not accepted policy",
    },
  };
}

// ---------------------------------------------------------------------------
// Record helpers (all idempotent; deterministic command identity)
// ---------------------------------------------------------------------------

function runtimeActor(actor) {
  const id = typeof actor?.id === "string" && actor.id.trim() ? actor.id.trim() : "qq-adr-curation";
  return { kind: "runtime", id };
}

function resolveExecutionAttempt(state, executionId, attemptId = null) {
  const jobState = state.jobs[executionId];
  if (!jobState || jobState.role !== "execution") {
    throw fail("not-found", `change '${executionId}' has no registered managed execution job`);
  }
  const resolvedAttemptId = attemptId ?? jobState.attemptOrder[0] ?? null;
  const attempt = resolvedAttemptId ? jobState.attempts[resolvedAttemptId] : null;
  if (!attempt) throw fail("not-found", `change '${executionId}' has no recorded execution attempt`);
  return { jobState, attempt, attemptId: resolvedAttemptId };
}

function assertBinding(attempt, expected = {}) {
  const launch = attempt.launchIntent.launch ?? {};
  if (expected.owner && (launch.owner ?? null) !== expected.owner) {
    throw fail("owner-mismatch", `the recorded coordinating owner '${launch.owner ?? null}' does not match '${expected.owner}'; this curation operation is refused against a foreign context`);
  }
  if (expected.phaseId !== undefined && (launch.phaseId ?? null) !== (expected.phaseId ?? null)) {
    throw fail("phase-mismatch", `the recorded phase identity '${launch.phaseId ?? null}' does not match '${expected.phaseId ?? null}'; this curation operation is refused`);
  }
  if (expected.root && (launch.root ?? null) !== expected.root) {
    throw fail("root-mismatch", `the recorded project root '${launch.root ?? null}' does not match '${expected.root}'; this curation operation is refused`);
  }
  return launch;
}

/**
 * Stage the ADR source manifest BEFORE the destructive ticket reset/worktree
 * retirement: the exact ticket content and provenance are retained as the
 * immutable blob first, then referenced from the authoritative record.
 * Idempotent: a duplicate capture (callback retry, recovery) returns the same
 * manifest identity and never stages twice.
 */
export async function stageAdrSource({
  stateDir,
  executionId,
  attemptId = null,
  ticketPath = null,
  sessionTag = null,
  worktree = null,
  branch = null,
  baseSelection = null,
  intendedLanding = null,
  expected = {},
  now = Date.now(),
  actor = null,
} = {}) {
  assertName(executionId, "executionId");
  if (!stateDir) throw fail("invalid-arguments", "stateDir is required");
  const handle = openChange({ stateDir, changeId: executionId });
  const state = handle.state;
  const resolved = resolveExecutionAttempt(state, executionId, attemptId);
  const launch = assertBinding(resolved.attempt, expected);
  const ids = adrOperationIds({ changeId: executionId, attemptId: resolved.attemptId });
  const existing = state.adr.manifests[ids.manifestId];
  if (existing) {
    return { ok: true, dedupe: true, manifestId: ids.manifestId, operationId: ids.operationId, refs: existing.refs };
  }

  // The exact ticket content, read before anything can reset or retire it. An
  // IO error here fails honestly (the caller preserves the sole source).
  let ticket;
  const project = launch.root ?? expected.root ?? null;
  const resolvedTicketPath = ticketPath
    ?? (sessionTag && project ? await resolveTicketSource(project, sessionTag).catch(() => null) : null);
  if (resolvedTicketPath) {
    const text = await readFile(resolvedTicketPath, "utf8");
    ticket = {
      path: resolvedTicketPath,
      sessionId: sessionTag ?? null,
      sha256: sha256Hex(Buffer.from(text, "utf8")),
      bytes: Buffer.byteLength(text, "utf8"),
      text,
    };
  } else {
    ticket = {
      path: null,
      sessionId: sessionTag ?? null,
      reason: "no session ticket resolved for this landing; the exact ticket content could not be captured",
    };
  }

  const manifest = buildAdrSourceManifest({
    state,
    changeId: executionId,
    jobId: executionId,
    attemptId: resolved.attemptId,
    events: readAllEvents(handle),
    ticket,
    provenance: { project, owner: launch.owner ?? expected.owner ?? null, phaseId: launch.phaseId ?? expected.phaseId ?? null, worktree, branch, baseSelection },
    intendedLanding,
    reportExists: (reportId) => readReportMeta(stateDir, reportId).exists,
    now,
  });
  const evidence = writeAdrSourceBlob(stateDir, manifest);
  const appended = handle.append(
    "adr.source_manifest",
    {
      manifestId: ids.manifestId,
      schemaVersion: ADR_SOURCE_MANIFEST_SCHEMA,
      evidence: { path: evidence.path, sha256: evidence.sha256, bytes: evidence.bytes },
      refs: manifest.refs,
      note: MANIFEST_NOTE,
    },
    {
      context: { actor: runtimeActor(actor), jobId: executionId, attemptId: resolved.attemptId },
      commandId: ids.manifestCommandId,
      now,
    },
  );
  return {
    ok: true,
    dedupe: appended.dedupe === true,
    seq: appended.seq,
    manifestId: ids.manifestId,
    operationId: ids.operationId,
    evidence,
    refs: manifest.refs,
  };
}

// The canonical landing-receipt shape. Every writer normalizes identically,
// so idempotent retries and recovery derive byte-identical payloads (and
// therefore the same deterministic command identity) from the same receipt.
export function normalizeAdrLanding(landing) {
  const normalized = {
    method: landing?.method ?? "none",
    receipt: landing?.receipt ?? null,
    headSha: landing?.headSha ?? null,
    pr: landing?.pr ?? null,
    changedPaths: landing?.changedPaths ?? null,
  };
  if (normalized.method === "none") {
    normalized.receipt = null;
    normalized.headSha = null;
    normalized.pr = null;
  }
  return normalized;
}

/**
 * Activate the post-landing curation disposition. ONLY a verified successful
 * real source landing (method 'pr'/'ff' with its actual merge/ff receipt)
 * activates a PENDING obligation; a `method: 'none'` no-op records an explicit
 * no-source-change disposition and a validated suppression records
 * 'suppressed'. A failed/unknown landing never reaches this call, so it stays
 * uncurated — no false success. Deterministic operation identity makes
 * duplicate callbacks and recovery idempotent.
 *
 * The receipt handoff is committed first (via `adr.source_completion`) and the
 * obligation event second, so recovery can always reconstruct the obligation
 * from retained receipt evidence and never from guesswork.
 */
export function activateCurationObligation({
  stateDir,
  executionId,
  attemptId = null,
  manifestId = null,
  landing,
  suppression = null,
  expected = {},
  now = Date.now(),
  actor = null,
} = {}) {
  assertName(executionId, "executionId");
  if (!stateDir) throw fail("invalid-arguments", "stateDir is required");
  const normalizedLanding = normalizeAdrLanding(landing);
  const status = suppression ? "suppressed" : normalizedLanding.method === "none" ? "no-change" : "pending";
  const handle = openChange({ stateDir, changeId: executionId });
  const state = handle.state;
  const resolved = resolveExecutionAttempt(state, executionId, attemptId);
  const launch = assertBinding(resolved.attempt, expected);
  const ids = adrOperationIds({ changeId: executionId, attemptId: resolved.attemptId });
  const targetManifestId = manifestId ?? ids.manifestId;

  // 1. Durable receipt handoff first (idempotent completion).
  if (targetManifestId && state.adr.manifests[targetManifestId]) {
    completeAdrSourceRefs({
      stateDir,
      executionId,
      attemptId: resolved.attemptId,
      manifestId: targetManifestId,
      refs: {
        landingReceipt: normalizedLanding.method === "none"
          ? { status: "missing", reason: "explicit no-source-change disposition: a method 'none' landing retains no commit receipt" }
          : { status: "retained" },
      },
      landing: normalizedLanding,
      disposition: status,
      suppression,
      now,
      actor,
    });
  }

  // 2. The obligation event itself.
  const appended = handle.append(
    "adr.curation_obligation",
    {
      operationId: ids.operationId,
      manifestId: targetManifestId && state.adr.manifests[targetManifestId] ? targetManifestId : null,
      status,
      landing: normalizedLanding,
      suppression,
      project: launch.root ?? expected.root ?? null,
      owner: launch.owner ?? expected.owner ?? null,
      phaseId: launch.phaseId ?? expected.phaseId ?? null,
      note: `curation obligation ${status} for change ${executionId}`,
    },
    {
      context: { actor: runtimeActor(actor), jobId: executionId, attemptId: resolved.attemptId },
      commandId: ids.obligationCommandId,
      now,
    },
  );
  return {
    ok: true,
    dedupe: appended.dedupe === true,
    seq: appended.seq,
    status,
    operationId: ids.operationId,
    manifestId: targetManifestId && state.adr.manifests[targetManifestId] ? targetManifestId : null,
  };
}

/**
 * Idempotent post-landing/late reference completion (archive path, execution
 * final report, observed receipt). Retained references are never demoted and
 * conflicting retained identities are refused by the reducer. With no staged
 * manifest (capture suppressed, failed, or unsupported) this is an explicit
 * no-op — nothing is ever declared complete from thin air.
 */
export function completeAdrSourceRefs({
  stateDir,
  executionId,
  attemptId = null,
  manifestId = null,
  refs = {},
  landing = null,
  disposition = null,
  suppression = null,
  now = Date.now(),
  actor = null,
} = {}) {
  assertName(executionId, "executionId");
  if (!stateDir) throw fail("invalid-arguments", "stateDir is required");
  const handle = openChange({ stateDir, changeId: executionId });
  const state = handle.state;
  const resolved = resolveExecutionAttempt(state, executionId, attemptId);
  const targetManifestId = manifestId ?? state.adr.manifestOrder[state.adr.manifestOrder.length - 1] ?? null;
  if (!targetManifestId || !state.adr.manifests[targetManifestId]) {
    return { ok: true, skipped: true, reason: "no staged ADR source manifest to complete (capture suppressed, failed, or unsupported)" };
  }
  const payload = {
    manifestId: targetManifestId,
    refs,
    ...(landing ? { landing: normalizeAdrLanding(landing) } : {}),
    ...(disposition ? { disposition } : {}),
    ...(suppression ? { suppression } : {}),
  };
  const appended = handle.append(
    "adr.source_completion",
    payload,
    {
      context: { actor: runtimeActor(actor), jobId: executionId, attemptId: resolved.attemptId },
      commandId: adrCompletionCommandId(targetManifestId, payload),
      now,
    },
  );
  return { ok: true, dedupe: appended.dedupe === true, seq: appended.seq, manifestId: targetManifestId };
}

// ---------------------------------------------------------------------------
// Bounded projection / minimal read surface for the next phase
// ---------------------------------------------------------------------------

function verifyAdrBlob(stateDir, entry) {
  let buffer;
  try {
    buffer = readFileSync(entry.evidence.path);
  } catch {
    return { exists: false, valid: false, reason: `retained manifest artifact is missing at ${entry.evidence.path}` };
  }
  const sha256 = sha256Hex(buffer);
  if (sha256 !== entry.evidence.sha256) {
    return { exists: true, valid: false, reason: "retained manifest artifact failed its sha256 integrity check" };
  }
  try {
    validateManifestShape(JSON.parse(buffer.toString("utf8")), { expectManifestId: entry.manifestId });
  } catch (error) {
    return { exists: true, valid: false, reason: `retained manifest artifact is corrupt: ${error?.message ?? error}` };
  }
  return { exists: true, valid: true, sha256 };
}

function requiredRefsFor(entry) {
  // A method 'none' landing retains no commit receipt BY DEFINITION; its
  // explicit no-source-change disposition is the honest state, so the receipt
  // is not a required reference for completeness there. Everywhere else a
  // missing required reference means evidence is never declared complete.
  return entry.disposition === "no-change"
    ? ADR_REQUIRED_REFS.filter((name) => name !== "landingReceipt")
    : [...ADR_REQUIRED_REFS];
}

/** Pure bounded projection over reduced record state (caches never override it). */
export function adrCurationProjection(state, { stateDir = null, verifyBlobs = true } = {}) {
  const { manifests, obligations } = viewsFor(state).adr();
  const manifestViews = manifests.slice(-VIEW_MANIFESTS_MAX).map((entry) => {
    const required = requiredRefsFor(entry);
    const missing = required.filter((name) => entry.refs[name]?.status === "missing");
    const pending = required.filter((name) => (entry.refs[name]?.status ?? "missing") === "pending" || !entry.refs[name]);
    const blob = verifyBlobs && stateDir ? verifyAdrBlob(stateDir, entry) : null;
    const evidenceComplete = (blob?.valid ?? true) !== false
      && (blob?.exists ?? true) !== false
      && missing.length === 0
      && pending.length === 0;
    return {
      manifestId: entry.manifestId,
      schemaVersion: entry.schemaVersion,
      seq: entry.seq,
      at: entry.at,
      evidence: entry.evidence,
      blob,
      refs: entry.refs,
      missingRefs: missing,
      pendingRefs: pending,
      evidenceComplete,
      landing: entry.landing,
      disposition: entry.disposition,
      suppression: entry.suppression,
    };
  });
  const byManifest = new Map(manifestViews.map((entry) => [entry.manifestId, entry]));
  const obligationViews = obligations.slice(-VIEW_OBLIGATIONS_MAX).map((entry) => ({
    operationId: entry.operationId,
    manifestId: entry.manifestId,
    status: entry.status,
    landing: entry.landing,
    suppression: entry.suppression,
    project: entry.project,
    owner: entry.owner,
    phaseId: entry.phaseId,
    seq: entry.seq,
    at: entry.at,
    evidenceComplete: entry.manifestId ? (byManifest.get(entry.manifestId)?.evidenceComplete ?? false) : entry.status !== "pending",
  }));

  let processingStatus;
  const pendingObligations = obligationViews.filter((entry) => entry.status === "pending");
  if (pendingObligations.length > 0) {
    processingStatus = pendingObligations.every((entry) => entry.evidenceComplete) ? "pending" : "incomplete";
  } else if (obligationViews.length > 0) {
    processingStatus = obligationViews[obligationViews.length - 1].status;
  } else if (manifestViews.length > 0) {
    processingStatus = "prepared";
  } else {
    processingStatus = "none";
  }

  return {
    changeId: state.changeId,
    processingStatus,
    manifests: manifestViews,
    manifestCount: manifests.length,
    obligations: obligationViews,
    obligationCount: obligations.length,
    pendingCuration: pendingObligations,
  };
}

/** Bounded projection rebuilt from the authoritative record on every read. */
export function adrCurationView({ stateDir, changeId, verifyBlobs = true } = {}) {
  const handle = openChange({ stateDir, changeId });
  return adrCurationProjection(handle.state, { stateDir, verifyBlobs });
}

/**
 * The minimal read surface the next phase claims from: pending curation
 * obligations with their exact retained source references. Read-only — no
 * Jev, no curation worker, no publication happens here.
 */
export function listCurationObligations({ stateDir, changeId, status = "pending" } = {}) {
  const view = adrCurationView({ stateDir, changeId });
  const entries = status ? view.obligations.filter((entry) => entry.status === status) : view.obligations;
  return {
    changeId,
    status,
    processingStatus: view.processingStatus,
    obligations: entries.slice(0, VIEW_OBLIGATIONS_MAX),
    total: entries.length,
  };
}

// ---------------------------------------------------------------------------
// Recovery (reuse of the existing recovery hooks; never a periodic scheduler)
// ---------------------------------------------------------------------------

/**
 * Reconstruct pending obligation/evidence state after an interrupted
 * capture/archive/receipt handoff, from VERIFIED retained evidence only:
 *   * an orphan manifest blob (written, its event lost) is re-staged
 *     idempotently — the deterministic payload/command identity makes a
 *     racing original append dedupe;
 *   * a retained landing receipt (committed completion) without its
 *     obligation event re-activates exactly one obligation;
 *   * a staged manifest whose landing receipt was never retained stays
 *     uncurated and pending — a failed/unknown landing is never upgraded to
 *     success;
 *   * optional observed references (e.g. an archive path) complete
 *     idempotently.
 * With `repair: false` this is a pure report. Captured ticket content is only
 * ever parsed as inert JSON data: recovery executes no code and no
 * credentials from it. It never launches or notifies anything.
 */
export function recoverAdrCuration({ stateDir, changeId, repair = false, observedRefs = null, now = Date.now(), actor = null } = {}) {
  const staged = [];
  const reconstructed = [];
  const pending = [];
  const errors = [];
  let handle;
  try {
    handle = openChange({ stateDir, changeId });
  } catch (error) {
    return { ok: false, reason: `authoritative change record unavailable: ${error?.message ?? error}`, staged, reconstructed, pending, errors };
  }

  // 1. Interrupted capture: retained blob without its record event.
  let names = [];
  try {
    names = readdirSync(adrSourcesDir(stateDir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    const manifestId = name.slice(0, -".json".length);
    let manifest;
    try {
      manifest = readAdrSourceManifest(stateDir, manifestId);
    } catch (error) {
      errors.push({ manifestId, stage: "capture", reason: String(error?.message ?? error) });
      continue;
    }
    if (manifest.changeId !== changeId) continue;
    const committed = handle.state.adr.manifests[manifestId];
    if (committed) {
      staged.push({ manifestId, state: "committed" });
      continue;
    }
    if (!repair) {
      pending.push({ manifestId, action: "restage-source-manifest" });
      continue;
    }
    try {
      const evidence = writeAdrSourceBlob(stateDir, manifest);
      handle.append(
        "adr.source_manifest",
        {
          manifestId,
          schemaVersion: ADR_SOURCE_MANIFEST_SCHEMA,
          evidence: { path: evidence.path, sha256: evidence.sha256, bytes: evidence.bytes },
          refs: manifest.refs,
          note: MANIFEST_NOTE,
        },
        {
          context: { actor: runtimeActor(actor), jobId: manifest.jobId, attemptId: manifest.attemptId },
          commandId: adrOperationIds({ changeId, attemptId: manifest.attemptId }).manifestCommandId,
          now,
        },
      );
      reconstructed.push({ manifestId, action: "staged-source-manifest" });
    } catch (error) {
      errors.push({ manifestId, stage: "restage", reason: String(error?.message ?? error) });
    }
  }

  // 2. Interrupted receipt/obligation handoff: retained landing evidence
  //    without its obligation event. No retained receipt -> uncurated.
  const views = viewsFor(handle.state);
  const adrView = views.adr();
  const boundObligations = new Set(adrView.obligations.map((entry) => entry.manifestId).filter(Boolean));
  for (const entry of adrView.manifests) {
    if (boundObligations.has(entry.manifestId)) continue;
    let manifestDetail = null;
    try {
      manifestDetail = readAdrSourceManifest(stateDir, entry.manifestId);
    } catch (error) {
      errors.push({ manifestId: entry.manifestId, stage: "manifest-read", reason: String(error?.message ?? error) });
      continue;
    }
    const landing = entry.landing;
    const disposition = entry.suppression ? "suppressed" : entry.disposition ?? (landing?.method === "none" ? "no-change" : null);
    if (!landing || !disposition) {
      pending.push({ manifestId: entry.manifestId, action: "activation-pending", reason: "no verified landing receipt is retained; the change stays uncurated" });
      continue;
    }
    const actionable = disposition === "pending" ? (landing.method === "pr" || landing.method === "ff") && Boolean(landing.receipt) : true;
    if (!actionable) {
      pending.push({ manifestId: entry.manifestId, action: "activation-missing-receipt", reason: "the retained landing evidence is not a verified real source landing; no obligation is invented" });
      continue;
    }
    if (!repair) {
      pending.push({ manifestId: entry.manifestId, action: "activate-obligation", landing });
      continue;
    }
    try {
      const activated = activateCurationObligation({
        stateDir,
        executionId: changeId,
        attemptId: manifestDetail.attemptId,
        manifestId: entry.manifestId,
        landing,
        suppression: entry.suppression,
        now,
        actor,
      });
      reconstructed.push({ manifestId: entry.manifestId, action: "activated-curation-obligation", operationId: activated.operationId, status: activated.status });
    } catch (error) {
      errors.push({ manifestId: entry.manifestId, stage: "activate", reason: String(error?.message ?? error) });
    }
  }

  // 3. Optional observed references supplied by the recovering caller.
  if (observedRefs && Object.keys(observedRefs).length && handle.state.adr.manifestOrder.length) {
    try {
      completeAdrSourceRefs({ stateDir, executionId: changeId, refs: observedRefs, now, actor });
    } catch (error) {
      errors.push({ stage: "observed-refs", reason: String(error?.message ?? error) });
    }
  }

  const projection = adrCurationProjection(openChange({ stateDir, changeId }).state, { stateDir });
  return {
    ok: errors.length === 0,
    ...(errors.length ? { reason: errors.map((entry) => `${entry.stage}/${entry.manifestId ?? "-"}: ${entry.reason}`).join("; ") } : {}),
    repair,
    staged,
    reconstructed,
    pending,
    errors,
    processingStatus: projection.processingStatus,
    projection,
  };
}

// ---------------------------------------------------------------------------
// The landing hook surface (consumed by workflow/git.mjs via the managed
// pipeline) — nonblocking by contract: the caller bounds every failure into a
// truthful warning and never rolls back a completed landing.
// ---------------------------------------------------------------------------

export function createAdrCurationHook({
  stateDir,
  executionId,
  owner = null,
  phaseId = undefined,
  root = null,
  actor = null,
  now = Date.now(),
  adrRoots = ADR_ROOTS,
  trustedPublicationOptOut = null,
  changedPathsOf = null,
} = {}) {
  assertName(executionId, "executionId");
  if (!stateDir) throw fail("invalid-arguments", "stateDir is required");
  const expected = {};
  if (owner) expected.owner = owner;
  if (phaseId !== undefined) expected.phaseId = phaseId;
  if (root) expected.root = root;
  const deriveChangedPaths = changedPathsOf ?? defaultChangedPathsOf;
  let lastCapture = null;
  return {
    stateDir,
    executionId,
    // 1. BEFORE the destructive ticket reset/worktree retirement: retain the
    //    exact ticket content and provenance (unless verified suppression).
    async capture({ mainRoot = null, worktree = null, branch = null, sessionTag = null, ticketPath = null, baseSelection = null } = {}) {
      const derived = await deriveChangedPaths({ worktree, branch, mainRoot });
      const suppression = resolveAdrSuppression({ changedPaths: derived.paths, verified: derived.verified, adrRoots, trustedPublicationOptOut });
      if (suppression.suppressed) {
        lastCapture = { suppressed: true, suppression, manifestId: null, changedPaths: derived };
        return { suppressed: true, suppression };
      }
      const staged = await stageAdrSource({
        stateDir,
        executionId,
        ticketPath,
        sessionTag,
        worktree,
        branch,
        baseSelection,
        intendedLanding: branch ? { branch, changedPaths: { verified: derived.verified, count: derived.paths.length } } : null,
        expected,
        now,
        actor,
      });
      lastCapture = { suppressed: false, suppression: null, manifestId: staged.manifestId, changedPaths: derived };
      return { suppressed: false, manifestId: staged.manifestId, operationId: staged.operationId, refs: staged.refs };
    },
    // 2. AFTER a verified real landing receipt (or an explicit no-change
    //    disposition) and before retirement: activate exactly one obligation.
    async activate({ landing, manifestId = null, suppression = undefined } = {}) {
      return activateCurationObligation({
        stateDir,
        executionId,
        manifestId: manifestId ?? lastCapture?.manifestId ?? null,
        landing,
        suppression: suppression !== undefined ? suppression : lastCapture?.suppression ?? null,
        expected,
        now,
        actor,
      });
    },
    // 3. Idempotent late reference completion (archive path, final reports).
    async complete({ manifestId = null, refs = {}, landing = null, disposition = null, suppression = null } = {}) {
      const targetManifestId = manifestId ?? lastCapture?.manifestId ?? null;
      if (!targetManifestId) {
        return { ok: true, skipped: true, reason: "no staged ADR source manifest from this capture (suppressed or failed); nothing is completed" };
      }
      return completeAdrSourceRefs({ stateDir, executionId, manifestId: targetManifestId, refs, landing, disposition, suppression, now, actor });
    },
    view: () => adrCurationView({ stateDir, changeId: executionId }),
  };
}
