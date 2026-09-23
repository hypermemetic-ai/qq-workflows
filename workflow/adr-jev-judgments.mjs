// Production binary Jev judgments over retained ADR evidence.
//
// Purpose
// -------
// Reusable selection/comparison behavior over the phase-1 retained evidence
// (workflow/adr-curation.mjs): exact retained evidence -> binary Jev
// include/low_priority; exact retained evidence paired with caller-supplied
// versioned ADR candidates -> binary consider_together/unrelated. The output is
// coherent, attributable curation INPUT for a strong Architect. Nothing here
// authors, approves or supersedes ADR text or decisions, writes summaries,
// publishes/indexes anything, schedules work, launches a worker, or claims a
// curation obligation is complete.
//
// Evidence consumed (never transcripts, never private reasoning, never
// truncated summary mining)
// ---------------------------------------------------------------------------------
// `prepareEvidenceUnits` reads the VERIFIED retained source manifest through
// the landed phase-1 reader (`readAdrSourceManifest`, cross-checked against
// `adrCurationView`'s blob integrity) and the FULL durable report contents
// through the existing report API (`readReport`, chunk-assembled to complete).
// Every unit preserves exact source spans/IDs/hashes and attribution (phase,
// change, role, attempt, revision, seq/eventId, ack/outcome as available).
// Segmentation is deterministic (paragraph/heading; a mixed passage stays
// whole) with the supplied neighboring blocks as context. Jev never rewrites
// or invents text. Operational/draft/rejected text may be supplied as
// attributed evidence — selection is not accepted/current policy (unresolved
// updates keep `acceptedPolicy: false`). Missing/corrupt source or report
// yields an EXPLICIT incomplete/retryable result — never a negative
// classification — and curation can never be marked finished from missing
// evidence.
//
// Judgments (exactly two binary templates; see workflow/adr-jev-questions.mjs)
// ---------------------------------------------------------------------------------
// Pass 1 options: include / low_priority. Pass 2 options: consider_together /
// unrelated. The positive class score >= `positiveScoreMin` (0.4) routes
// FORWARD for BOTH passes — NOT the model argmax and NOT the model confidence.
// The exact response scores and the actual route are preserved separately, and
// a threshold-only routing-policy change reprojects routes from preserved raw
// scores without any provider call (`reprojectJudgment`). Ambiguous
// potentially useful material goes forward by the question wording itself.
// Malformed/missing scores/classes, API errors and invalid ranges stay errors /
// pending/deferred — never silently 0 / unrelated.
//
// Bounded, cached, idempotent
// --------------------------
// Successful raw judgments are cached content-addressed by the exact request
// identity (see workflow/adr-jev-cache.mjs); repeated and concurrent identical
// processing is idempotent. Resource budgets are explicit
// (`budget.maxUnits` / `budget.maxProviderRequests`); deferred work is
// explicit and never a negative judgment, and the caller continues with the
// returned continuation. Candidate ADRs are exact { adrId, path, content,
// version } tuples supplied by the caller (path recorded as provenance only —
// candidate content is MODEL DATA, never instructions for filesystem/worker
// actions, and is never opened from disk here). Zero candidates is valid;
// incomplete candidate coverage is carried forward honestly. Candidate
// enumeration/filtering belongs to the later retrieval-integration phase —
// there is no reranker here.

import { readReport } from "./reports.mjs";
import {
  adrCurationView,
  readAdrSourceManifest,
} from "./adr-curation.mjs";
import {
  QUESTION_TYPE,
  passClasses,
  questionKey,
  questionsIdentity,
  selectQuestion,
  unitsState,
} from "./adr-jev-questions.mjs";
import { DEFAULT_MODEL, SYSTEMONE_API } from "./adr-jev-client.mjs";
import {
  canonicalJson,
  judgmentIdentity,
  readJudgmentArtifact,
  resultPacketId,
  sha256Hex,
  writeJudgmentArtifact,
} from "./adr-jev-cache.mjs";

// The result-packet artifact schema constants live with the artifact store
// (workflow/adr-jev-cache.mjs: ADR_JEV_ARTIFACT_SCHEMA_VERSION /
// RESULT_PACKET_SCHEMA).

// ---------------------------------------------------------------------------
// Routing policy (versioned + hashed, stored SEPARATELY from raw judgments)
// ---------------------------------------------------------------------------

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export const DEFAULT_ROUTING_POLICY = Object.freeze({
  schema: "adr-jev-routing-policy",
  version: 1,
  positiveScoreMin: 0.4,
  rule: "positive-class score >= positiveScoreMin routes forward (never model argmax, never model confidence)",
});

export function routingPolicyHash(policy = DEFAULT_ROUTING_POLICY) {
  return sha256Hex(Buffer.from(canonicalJson(policy), "utf8"));
}

export function policySummary(policy = DEFAULT_ROUTING_POLICY) {
  return { schema: policy.schema, version: policy.version, positiveScoreMin: policy.positiveScoreMin, sha256: routingPolicyHash(policy) };
}

function assertPolicy(policy) {
  const min = policy?.positiveScoreMin;
  if (typeof min !== "number" || !Number.isFinite(min) || min < 0 || min > 1) {
    throw fail("invalid-arguments", "routing policy requires positiveScoreMin in [0,1]");
  }
  return policy;
}

/** The actual route: forward iff the exact positive-class score >= threshold. */
export function routeFromPositiveScore(positiveScore, policy = DEFAULT_ROUTING_POLICY) {
  assertPolicy(policy);
  if (typeof positiveScore !== "number" || !Number.isFinite(positiveScore) || positiveScore < 0 || positiveScore > 1) {
    throw fail("invalid-arguments", "routing requires the exact positive-class score in [0,1]");
  }
  return positiveScore >= policy.positiveScoreMin ? "forward" : "excluded";
}

/** Reported for transparency only — routing NEVER uses it. Exact ties read 'tie'. */
export function modelArgmaxOf(probabilities) {
  let best = null;
  let tie = false;
  for (const [cls, score] of Object.entries(probabilities)) {
    if (best === null || score > probabilities[best]) {
      best = cls;
      tie = false;
    } else if (score === probabilities[best]) {
      tie = true;
    }
  }
  return tie ? "tie" : best;
}

/**
 * Threshold-only reprojection: recompute the route of a preserved raw judgment
 * from its exact positive-class score. No provider call, no cache write, no
 * mutation of the preserved scores. Errors/deferred entries never gain a route.
 */
export function reprojectJudgment(judgment, policy = DEFAULT_ROUTING_POLICY) {
  assertPolicy(policy);
  if (!judgment || typeof judgment !== "object") throw fail("invalid-arguments", "reprojectJudgment requires a preserved judgment");
  if (judgment.status !== "ok") return { ...judgment, policy: policySummary(policy) };
  return {
    ...judgment,
    route: routeFromPositiveScore(judgment.positiveScore, policy),
    policy: policySummary(policy),
  };
}

// ---------------------------------------------------------------------------
// Response validation (malformed/missing stays an error — never 0/unrelated)
// ---------------------------------------------------------------------------

/**
 * Validate ONE typed Choice answer against its binary template. Anything
 * malformed (wrong/missing type, choice or class, non-finite or out-of-range
 * score) is invalid — the caller keeps it pending/retryable and NEVER turns it
 * into a negative classification.
 */
export function validateAnswer(answer, { positive, negative }) {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    return { valid: false, reason: "answer is not an object" };
  }
  if (answer.type !== QUESTION_TYPE) {
    return { valid: false, reason: `answer type ${JSON.stringify(answer.type)} is not '${QUESTION_TYPE}'` };
  }
  if (answer.choice !== positive && answer.choice !== negative) {
    return { valid: false, reason: `answer choice ${JSON.stringify(answer.choice)} is not one of ${positive}/${negative}` };
  }
  const probabilities = answer.probabilities;
  if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)) {
    return { valid: false, reason: "answer probabilities are missing" };
  }
  const keys = Object.keys(probabilities).sort();
  const expected = [negative, positive].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return { valid: false, reason: `answer probability classes ${JSON.stringify(keys)} are not exactly ${JSON.stringify(expected)}` };
  }
  for (const key of keys) {
    const value = probabilities[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      return { valid: false, reason: `answer probability ${key}=${JSON.stringify(value)} is outside [0,1]` };
    }
  }
  if (answer.confidence !== undefined && answer.confidence !== null) {
    const confidence = answer.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return { valid: false, reason: `answer confidence ${JSON.stringify(confidence)} is outside [0,1]` };
    }
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Deterministic evidence segmentation (paragraph/heading; mixed stays whole)
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})[ \t]+(\S.*)$/;
const BLOCK_SEP_RE = /\r?\n[ \t]*\r?\n+/g;

function trimSpan(text, start, end) {
  let a = start;
  let b = end;
  while (a < b && /\s/.test(text[a])) a += 1;
  while (b > a && /\s/.test(text[b - 1])) b -= 1;
  return { start: a, end: b, text: text.slice(a, b) };
}

function splitBlocks(text) {
  const blocks = [];
  let start = 0;
  let match;
  BLOCK_SEP_RE.lastIndex = 0;
  while ((match = BLOCK_SEP_RE.exec(text)) !== null) {
    const block = trimSpan(text, start, match.index);
    if (block.text.length) blocks.push(block);
    start = match.index + match[0].length;
  }
  const last = trimSpan(text, start, text.length);
  if (last.text.length) blocks.push(last);
  return blocks;
}

function unitIdFor(sourceId, start, text) {
  return sha256Hex(Buffer.from(`${sourceId}\n${start}\n${text}`, "utf8")).slice(0, 12);
}

/**
 * Deterministic paragraph/heading segmentation of ONE retained source text.
 * Blocks are maximal runs of nonblank lines; a heading line opens a new
 * section context; a block that mixes a heading line with content stays whole
 * as one unit. Each unit keeps its EXACT source span (char offsets + sha256)
 * and the verbatim neighboring blocks as `context`. Never rewrites text.
 */
export function segmentUnits({ sourceId, ref, text }) {
  if (typeof sourceId !== "string" || !sourceId) throw fail("invalid-arguments", "segmentUnits requires a sourceId");
  if (typeof text !== "string") throw fail("invalid-arguments", "segmentUnits requires the verbatim source text");
  const blocks = splitBlocks(text);
  const units = [];
  let currentHeading = null;
  const blockMeta = blocks.map((block) => {
    const firstLine = block.text.split(/\r?\n/, 1)[0];
    const headingMatch = HEADING_RE.exec(firstLine);
    if (!headingMatch) return { ...block, kind: "paragraph", headingTitle: null };
    const title = headingMatch[2].trim();
    const rest = block.text.slice(firstLine.length).trim();
    return rest.length
      ? { ...block, kind: "mixed", headingTitle: title }
      : { ...block, kind: "heading", headingTitle: title };
  });
  blockMeta.forEach((block, index) => {
    if (block.kind === "heading") {
      currentHeading = block.headingTitle;
      return;
    }
    // A mixed heading+body block stays whole AND updates the section heading
    // (its heading line still heads the following content).
    const heading = block.kind === "mixed" ? block.headingTitle : currentHeading;
    if (block.kind === "mixed") currentHeading = block.headingTitle;
    units.push({
      id: unitIdFor(sourceId, block.start, block.text),
      sourceId,
      ref,
      heading,
      text: block.text,
      span: { start: block.start, end: block.end },
      textSha256: sha256Hex(Buffer.from(block.text, "utf8")),
      context: {
        prev: index > 0 ? blockMeta[index - 1].text : null,
        next: index < blockMeta.length - 1 ? blockMeta[index + 1].text : null,
      },
    });
  });
  return units;
}

/** Reference-only unit summary (no prose) used in results and packets. */
export function unitSummary(unit) {
  return { id: unit.id, sourceId: unit.sourceId, ref: unit.ref, heading: unit.heading, span: unit.span, textSha256: unit.textSha256 };
}

function assertVerbatimUnits(units) {
  if (!Array.isArray(units)) throw fail("invalid-arguments", "judgments require verbatim retained evidence units");
  for (const unit of units) {
    if (!unit || typeof unit !== "object" || typeof unit.id !== "string" || typeof unit.text !== "string") {
      throw fail("invalid-arguments", "each evidence unit requires id and verbatim text");
    }
    const digest = sha256Hex(Buffer.from(unit.text, "utf8"));
    if (unit.textSha256 !== digest) {
      throw fail("not-verbatim", `evidence unit '${unit.id}' text does not match its retained span sha256; only verbatim retained evidence can be judged`);
    }
  }
  return units;
}

// ---------------------------------------------------------------------------
// Preparation (phase-1 manifest readers + full report API)
// ---------------------------------------------------------------------------

function readFullReportText(stateDir, reportId) {
  let text = "";
  for (;;) {
    const page = readReport(stateDir, reportId, { offset: text.length });
    if (!page.ok) return { ok: false, reason: page.error ?? `report '${reportId}' could not be read` };
    text += page.text;
    if (page.complete) return { ok: true, text };
  }
}

function assertBinding(manifest, { changeId, expected }) {
  if (manifest.changeId !== changeId) {
    throw fail("change-mismatch", `retained source manifest '${manifest.manifestId}' belongs to change '${manifest.changeId}', not '${changeId}'; manifest confusion is refused`);
  }
  if (expected?.owner && (manifest.owner ?? null) !== expected.owner) {
    throw fail("owner-mismatch", `the retained source owner '${manifest.owner ?? null}' does not match '${expected.owner}'; this judgment operation is refused against a foreign context`);
  }
  if (expected?.phaseId !== undefined && (manifest.phaseId ?? null) !== (expected.phaseId ?? null)) {
    throw fail("phase-mismatch", `the retained source phase identity '${manifest.phaseId ?? null}' does not match '${expected.phaseId ?? null}'; this judgment operation is refused`);
  }
  if (expected?.root && (manifest.project ?? null) !== expected.root) {
    throw fail("root-mismatch", `the retained source project root '${manifest.project ?? null}' does not match '${expected.root}'; this judgment operation is refused`);
  }
}

/**
 * Bounded preparation over VERIFIED retained evidence: exact retained manifest
 * + full durable report contents -> deterministic evidence units with exact
 * spans/IDs/hashes and full attribution. Missing or corrupt source/report is
 * an explicit incomplete/retryable result (never a negative classification).
 */
export function prepareEvidenceUnits({ stateDir, changeId, manifestId, expected = {} } = {}) {
  if (!stateDir) throw fail("invalid-arguments", "stateDir is required");
  if (typeof changeId !== "string" || !changeId) throw fail("invalid-arguments", "changeId is required");
  if (typeof manifestId !== "string" || !manifestId) throw fail("invalid-arguments", "manifestId is required");

  const missing = [];
  const recordOnly = [];
  const sources = [];
  const units = [];
  const incomplete = (kind, ref, reason, retryable) => missing.push({ kind, ref, reason, retryable });

  // 1. The retained manifest blob (phase-1 reader) + record cross-check.
  let manifest;
  try {
    manifest = readAdrSourceManifest(stateDir, manifestId);
  } catch (error) {
    return {
      ok: false,
      status: "incomplete",
      complete: false,
      retryable: true,
      changeId,
      manifestId,
      units: [],
      sources: [],
      missing: [{ kind: "manifest", ref: { manifestId }, reason: String(error?.message ?? error), retryable: true }],
      recordOnly: [],
    };
  }
  assertBinding(manifest, { changeId, expected });
  try {
    const view = adrCurationView({ stateDir, changeId, verifyBlobs: true });
    const entry = view.manifests.find((candidate) => candidate.manifestId === manifestId);
    if (!entry) {
      return {
        ok: false,
        status: "incomplete",
        complete: false,
        retryable: true,
        changeId,
        manifestId,
        units: [],
        sources: [],
        missing: [{ kind: "manifest", ref: { manifestId }, reason: "the retained source manifest is not yet recorded on the authoritative change record (interrupted capture; run recoverAdrCuration)", retryable: true }],
        recordOnly: [],
      };
    }
    if (entry.blob && (entry.blob.exists !== true || entry.blob.valid !== true)) {
      return {
        ok: false,
        status: "incomplete",
        complete: false,
        retryable: true,
        changeId,
        manifestId,
        units: [],
        sources: [],
        missing: [{ kind: "manifest", ref: { manifestId, evidence: entry.evidence }, reason: entry.blob.reason ?? "the retained source manifest failed its integrity check", retryable: true }],
        recordOnly: [],
      };
    }
  } catch (error) {
    return {
      ok: false,
      status: "incomplete",
      complete: false,
      retryable: true,
      changeId,
      manifestId,
      units: [],
      sources: [],
      missing: [{ kind: "record", ref: { changeId }, reason: `authoritative change record unavailable: ${error?.message ?? error}`, retryable: true }],
      recordOnly: [],
    };
  }

  const addSource = (sourceId, ref, text, status = "segmented") => {
    const sourceUnits = segmentUnits({ sourceId, ref, text });
    units.push(...sourceUnits);
    sources.push({ sourceId, kind: ref.kind, ref, unitCount: sourceUnits.length, textSha256: sha256Hex(Buffer.from(text, "utf8")), status });
  };

  // 2. Exact ticket content (retained verbatim in the manifest blob).
  if (manifest.ticket?.text != null && manifest.ticket?.sha256) {
    addSource(`ticket:${manifest.ticket.sha256.slice(0, 12)}`, {
      kind: "ticket",
      path: manifest.ticket.path ?? null,
      sessionId: manifest.ticket.sessionId ?? null,
      sha256: manifest.ticket.sha256,
      changeId,
    }, manifest.ticket.text);
  } else {
    incomplete("ticket", { kind: "ticket", path: manifest.ticket?.path ?? null }, manifest.ticket?.reason ?? "the exact ticket content is not retained", true);
  }

  // 3. Immutable original constraints (verbatim).
  if (manifest.constraints?.instructions != null) {
    addSource(`constraints:r${manifest.constraints.revision}`, {
      kind: "constraints",
      revision: manifest.constraints.revision,
      seq: manifest.constraints.seq ?? null,
      eventId: manifest.constraints.eventId ?? null,
      commandId: manifest.constraints.commandId ?? null,
      changeId,
    }, manifest.constraints.instructions);
  } else {
    incomplete("constraints", { kind: "constraints", revision: manifest.constraints?.revision ?? null }, manifest.refs?.constraints?.reason ?? "the immutable original constraints text is not retained", true);
  }

  // 4. Ordered updates: the verbatim coordinator instruction per revision with
  //    its authoritative ack/outcome attribution. Unresolved/rejected material
  //    is segmented as attributed evidence with acceptedPolicy: false.
  for (const update of manifest.updates ?? []) {
    const ref = {
      kind: "update",
      revision: update.revision,
      seq: update.seq ?? null,
      eventId: update.eventId ?? null,
      commandId: update.commandId ?? null,
      changeId,
      targetJobId: update.targetJobId ?? null,
      targetRole: update.targetRole ?? null,
      targetedAttemptId: update.targetedAttemptId ?? null,
      amendmentId: update.amendmentId ?? null,
      acknowledgement: update.acknowledgement ?? null,
      outcome: update.outcome ?? null,
      resolution: update.resolution ?? null,
      acceptedPolicy: update.acceptedPolicy === true,
    };
    const sourceId = `update:r${update.revision}`;
    if (update.instruction != null) {
      addSource(sourceId, ref, update.instruction);
    } else if (update.instructionComplete === false) {
      incomplete("update", ref, "the retained update instruction is incomplete (missing text parts are reported, never truncated)", true);
    } else {
      sources.push({ sourceId, kind: "update", ref, unitCount: 0, textSha256: null, status: "no-text" });
    }
  }

  // 5. Full durable role-report contents through the existing report API.
  for (const report of manifest.roleReports ?? []) {
    const ref = {
      kind: "roleReport",
      reportKind: report.kind,
      role: report.role,
      jobId: report.jobId,
      attemptId: report.attemptId,
      label: report.label,
      seq: report.seq ?? null,
      reportId: report.reportId ?? null,
      outcomeStatus: report.outcomeStatus ?? null,
    };
    const sourceId = report.reportId ? `report:${report.reportId}` : `record:${report.kind}:${report.seq ?? "na"}`;
    if (report.status === "record-only") {
      recordOnly.push(ref);
      sources.push({ sourceId, kind: "roleReport", ref, unitCount: 0, textSha256: null, status: "record-only" });
      continue;
    }
    if (report.status === "pending") {
      incomplete("roleReport", ref, report.reason ?? "the role report is not produced yet", true);
      continue;
    }
    if (report.status === "missing" || !report.reportId) {
      incomplete("roleReport", ref, report.reason ?? "the retained report reference has no persisted report artifact", true);
      continue;
    }
    const full = readFullReportText(stateDir, report.reportId);
    if (!full.ok) {
      incomplete("roleReport", ref, full.reason, true);
      continue;
    }
    addSource(sourceId, ref, full.text);
  }

  const complete = missing.length === 0;
  return {
    ok: complete,
    status: complete ? "prepared" : "incomplete",
    complete,
    retryable: missing.some((entry) => entry.retryable),
    changeId,
    manifestId,
    owner: manifest.owner ?? null,
    phaseId: manifest.phaseId ?? null,
    units,
    sources,
    missing,
    recordOnly,
  };
}

// ---------------------------------------------------------------------------
// Judgment pipeline (pass 1 selection / pass 2 candidate pairing)
// ---------------------------------------------------------------------------

function judgmentFromAnswers({ answers, key, pass, identity, cached, routingPolicy }) {
  const classes = passClasses(pass);
  const answer = answers?.[key];
  if (!answer) {
    return { judgmentId: identity.judgmentId, status: "invalid-response", pass, retryable: true, reason: `the response carries no answer for question '${key}'` };
  }
  const check = validateAnswer(answer, classes);
  if (!check.valid) {
    return { judgmentId: identity.judgmentId, status: "invalid-response", pass, retryable: true, reason: check.reason };
  }
  return {
    judgmentId: identity.judgmentId,
    status: "ok",
    cached: cached === true,
    pass,
    questionKey: key,
    classes: { positive: classes.positive, negative: classes.negative },
    // The EXACT response scores, preserved verbatim and separately from route.
    answer: { choice: answer.choice, confidence: answer.confidence ?? null, probabilities: { ...answer.probabilities } },
    positiveScore: answer.probabilities[classes.positive],
    modelArgmax: modelArgmaxOf(answer.probabilities),
    route: routeFromPositiveScore(answer.probabilities[classes.positive], routingPolicy),
    policy: policySummary(routingPolicy),
  };
}

function makeBudget(budget = {}) {
  const maxProviderRequests = budget.maxProviderRequests == null ? Infinity : Math.trunc(budget.maxProviderRequests);
  const maxUnits = budget.maxUnits == null ? Infinity : Math.trunc(budget.maxUnits);
  if (!(maxProviderRequests >= 0) || !(maxUnits >= 0)) {
    throw fail("invalid-arguments", "budget.maxProviderRequests and budget.maxUnits must be non-negative integers");
  }
  return {
    unitsUsed: 0,
    providerRequestsUsed: 0,
    takeUnit() {
      if (this.unitsUsed >= maxUnits) return false;
      this.unitsUsed += 1;
      return true;
    },
    takeProviderRequest() {
      if (this.providerRequestsUsed >= maxProviderRequests) return false;
      this.providerRequestsUsed += 1;
      return true;
    },
  };
}

async function judgeOne({ stateDir, provider, api, model, pass, unit, candidateState = null, candidateRef = null, provenance, budget, routingPolicy }) {
  const unitLike = { id: unit.id, heading: unit.heading, text: unit.text, context: unit.context };
  const key = questionKey(unit.id);
  const questions = selectQuestion(unitLike, pass);
  const state = unitsState([unitLike], pass, pass === 2 ? candidateState : undefined);
  // The judgment identity covers the exact request AND the candidate content
  // version (an ADR version change must invalidate reuse even though the
  // version string itself never reaches the model).
  const identity = judgmentIdentity({
    api,
    model,
    state,
    questions,
    scope: candidateRef ? { candidate: { version: candidateRef.version, contentSha256: candidateRef.contentSha256 } } : null,
  });
  const cacheProvenance = {
    ...(provenance ?? {}),
    pass,
    unit: { id: unit.id, sourceId: unit.sourceId, textSha256: unit.textSha256, span: unit.span },
    candidate: candidateRef,
  };
  const cacheIssues = [];

  if (!budget.takeUnit()) {
    return { judgment: { status: "deferred", pass, reason: "unit-budget-exhausted", retryable: true }, identity, cacheIssues };
  }

  const cached = readJudgmentArtifact(stateDir, identity.judgmentId);
  if (cached.ok) {
    if (cached.entry.identity?.identitySha256 !== identity.identitySha256) {
      cacheIssues.push({ judgmentId: identity.judgmentId, reason: "cached judgment identity does not match the request identity; treated as a cache miss" });
    } else {
      return { judgment: judgmentFromAnswers({ answers: cached.entry.result.answers, key, pass, identity, cached: true, routingPolicy }), identity, cacheIssues };
    }
  } else if (cached.corrupt) {
    cacheIssues.push({ judgmentId: identity.judgmentId, reason: cached.reason });
  }

  if (!budget.takeProviderRequest()) {
    return { judgment: { status: "deferred", pass, reason: "provider-request-budget-exhausted", retryable: true }, identity, cacheIssues };
  }

  const response = await provider.request({ model, state, questions });
  if (!response?.ok) {
    // API errors stay errors/pending. NEVER cached as successful judgments.
    return {
      judgment: {
        judgmentId: identity.judgmentId,
        status: "error",
        pass,
        errorType: response?.errorType ?? "UNKNOWN",
        retryable: response?.retryable ?? true,
        errorMessage: String(response?.errorMessage ?? "provider request failed").slice(0, 800),
        httpStatus: response?.httpStatus ?? null,
      },
      identity,
      cacheIssues,
    };
  }
  const judgment = judgmentFromAnswers({ answers: response.json?.answers, key, pass, identity, cached: false, routingPolicy });
  if (judgment.status !== "ok") {
    // Malformed/missing scores or classes stay pending/retryable and are never
    // cached as reusable successful judgments.
    return { judgment, identity, cacheIssues };
  }
  const written = writeJudgmentArtifact(stateDir, {
    identity,
    provenance: cacheProvenance,
    result: { answers: response.json.answers, model: response.json.model ?? null, usage: response.json.usage ?? null },
  });
  if (written.divergent) {
    cacheIssues.push({ judgmentId: identity.judgmentId, reason: "a divergent response for the identical request was discarded; the first successful judgment is preserved unchanged" });
  }
  return { judgment, identity, cacheIssues };
}

function summarizeOutcome(results, budget, counts, pass) {
  const judgments = results.map(({ unit, judgment }) => ({ unit: unitSummary(unit), judgment }));
  const okEntry = (entry) => entry.judgment.status === "ok";
  const selected = results.filter((entry) => okEntry(entry) && entry.judgment.route === "forward");
  const excluded = results.filter((entry) => okEntry(entry) && entry.judgment.route === "excluded");
  const deferred = results.filter((entry) => entry.judgment.status === "deferred");
  const errors = results.filter((entry) => entry.judgment.status === "error" || entry.judgment.status === "invalid-response");
  const remaining = deferred.map((entry) => unitSummary(entry.unit));
  return {
    pass,
    judgments,
    counts: {
      ...counts,
      ok: selected.length + excluded.length,
      forward: selected.length,
      excluded: excluded.length,
      deferred: deferred.length,
      errors: errors.length,
      providerRequests: budget.providerRequestsUsed,
    },
    forwardEntries: selected.map((entry) => ({ unit: unitSummary(entry.unit), judgment: entry.judgment })),
    excludedEntries: excluded.map((entry) => ({ unit: unitSummary(entry.unit), judgment: entry.judgment })),
    deferredEntries: deferred.map((entry) => ({ unit: unitSummary(entry.unit), judgment: entry.judgment })),
    errorEntries: errors.map((entry) => ({ unit: unitSummary(entry.unit), judgment: entry.judgment })),
    continuation: deferred.length
      ? {
        remaining,
        reason: "budget exhausted: the remaining work is explicitly deferred and is never a negative judgment; re-run with these units (identical work replays from cache)",
      }
      : null,
  };
}

/**
 * Pass 1 — binary selection over verbatim retained evidence units:
 * include / low_priority, positive class 'include', score >= 0.4 forwards.
 * `units` must come from `prepareEvidenceUnits` (or carry matching verbatim
 * span hashes). Budget-deferred work is explicit and never negative.
 */
export async function judgeSelection({
  stateDir,
  provider,
  units,
  model = DEFAULT_MODEL,
  api = null,
  budget = {},
  routingPolicy = DEFAULT_ROUTING_POLICY,
  provenance = {},
} = {}) {
  if (!stateDir) throw fail("invalid-arguments", "stateDir is required");
  if (!provider || typeof provider.request !== "function") throw fail("invalid-arguments", "judgeSelection requires an injectable provider seam (no live call is ever made implicitly)");
  assertPolicy(routingPolicy);
  assertVerbatimUnits(units);
  const effectiveApi = api ?? provider.api ?? { name: SYSTEMONE_API.name, version: SYSTEMONE_API.version, endpoint: SYSTEMONE_API.defaultEndpoint };
  const budgetState = makeBudget(budget);
  const results = [];
  const cacheIssues = [];
  for (const unit of units) {
    const outcome = await judgeOne({
      stateDir,
      provider,
      api: effectiveApi,
      model,
      pass: 1,
      unit,
      provenance,
      budget: budgetState,
      routingPolicy,
    });
    cacheIssues.push(...outcome.cacheIssues);
    results.push({ unit, judgment: outcome.judgment });
  }
  const summary = summarizeOutcome(results, budgetState, { units: units.length, cacheHits: results.filter((entry) => entry.judgment.cached).length }, 1);
  return {
    ok: summary.counts.errors === 0 && summary.counts.deferred === 0,
    ...summary,
    cacheIssues,
    routingPolicy: policySummary(routingPolicy),
    model,
    api: effectiveApi,
  };
}

/**
 * Normalize + validate ONE caller-supplied candidate ADR tuple. The `path` is
 * recorded as provenance ONLY — it is never opened; `content` is exact model
 * data (never instructions for filesystem/worker actions).
 */
export function normalizeCandidate(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw fail("invalid-candidate", "candidate ADRs must be exact { adrId, path, content, version } tuples");
  }
  const { adrId, path, content, version, heading = null } = candidate;
  if (typeof adrId !== "string" || !adrId.trim()) throw fail("invalid-candidate", "a candidate ADR requires a non-empty adrId");
  if (typeof path !== "string" || !path) throw fail("invalid-candidate", `candidate ADR '${adrId}' requires its exact path (recorded as provenance only)`);
  if (typeof content !== "string" || !content.length) throw fail("invalid-candidate", `candidate ADR '${adrId}' requires its exact content`);
  if (typeof version !== "string" || !version.trim()) throw fail("invalid-candidate", `candidate ADR '${adrId}' requires an explicit content version`);
  const contentSha256 = sha256Hex(Buffer.from(content, "utf8"));
  if (candidate.contentSha256 != null && candidate.contentSha256 !== contentSha256) {
    throw fail("candidate-version-mismatch", `candidate ADR '${adrId}' content does not match its declared contentSha256; the supplied version is refused`);
  }
  return { adrId, path, version, heading, content, contentSha256 };
}

/**
 * Pass 2 — binary candidate pairing: consider_together / unrelated, positive
 * class 'consider_together', score >= 0.4 forwards. Pairs are the caller's
 * evidence units x the caller's candidate tuples in deterministic order;
 * identical pair/input requests are deduplicated and candidate provenance is
 * preserved. Zero candidates is valid; ONLY the supplied candidates are ever
 * compared — coverage is never described as 'all existing ADRs'.
 */
export async function compareCandidates({
  stateDir,
  provider,
  units,
  candidates = [],
  model = DEFAULT_MODEL,
  api = null,
  budget = {},
  routingPolicy = DEFAULT_ROUTING_POLICY,
  provenance = {},
} = {}) {
  if (!stateDir) throw fail("invalid-arguments", "stateDir is required");
  if (!provider || typeof provider.request !== "function") throw fail("invalid-arguments", "compareCandidates requires an injectable provider seam (no live call is ever made implicitly)");
  assertPolicy(routingPolicy);
  assertVerbatimUnits(units);
  if (!Array.isArray(candidates)) throw fail("invalid-arguments", "candidates must be an array of exact { adrId, path, content, version } tuples");
  const normalized = candidates.map(normalizeCandidate);
  const candidateRefs = normalized.map(({ adrId, path, version, contentSha256 }) => ({ adrId, path, version, contentSha256 }));
  const effectiveApi = api ?? provider.api ?? { name: SYSTEMONE_API.name, version: SYSTEMONE_API.version, endpoint: SYSTEMONE_API.defaultEndpoint };
  const budgetState = makeBudget(budget);

  // Deterministic pair order (unit order x candidate order) with exact-tuple
  // dedupe. Distinct tuples that share content keep their own provenance and
  // share one content-addressed judgment (no duplicate provider request).
  const planned = [];
  const seen = new Set();
  let duplicatesRemoved = 0;
  for (const unit of units) {
    for (const candidate of normalized) {
      const pairKey = `${unit.id}\n${candidate.adrId}\n${candidate.path}\n${candidate.version}\n${candidate.contentSha256}`;
      if (seen.has(pairKey)) {
        duplicatesRemoved += 1;
        continue;
      }
      seen.add(pairKey);
      planned.push({ unit, candidate });
    }
  }

  const results = [];
  const cacheIssues = [];
  for (const { unit, candidate } of planned) {
    const outcome = await judgeOne({
      stateDir,
      provider,
      api: effectiveApi,
      model,
      pass: 2,
      unit,
      candidateState: { heading: candidate.heading ?? null, text: candidate.content },
      candidateRef: { adrId: candidate.adrId, version: candidate.version, contentSha256: candidate.contentSha256 },
      provenance,
      budget: budgetState,
      routingPolicy,
    });
    cacheIssues.push(...outcome.cacheIssues);
    results.push({
      unit,
      candidate: { adrId: candidate.adrId, path: candidate.path, version: candidate.version, contentSha256: candidate.contentSha256 },
      judgment: outcome.judgment,
    });
  }

  const pairs = results.map((entry) => ({ unit: unitSummary(entry.unit), candidate: entry.candidate, judgment: entry.judgment }));
  const okEntry = (entry) => entry.judgment.status === "ok";
  const together = results.filter((entry) => okEntry(entry) && entry.judgment.route === "forward");
  const unrelated = results.filter((entry) => okEntry(entry) && entry.judgment.route === "excluded");
  const deferred = results.filter((entry) => entry.judgment.status === "deferred");
  const errors = results.filter((entry) => entry.judgment.status === "error" || entry.judgment.status === "invalid-response");
  return {
    ok: errors.length === 0 && deferred.length === 0,
    pass: 2,
    pairs,
    consideredTogether: together.map((entry) => ({ unit: unitSummary(entry.unit), candidate: entry.candidate, judgment: entry.judgment })),
    unrelated: unrelated.map((entry) => ({ unit: unitSummary(entry.unit), candidate: entry.candidate, judgment: entry.judgment })),
    deferredEntries: deferred.map((entry) => ({ unit: unitSummary(entry.unit), candidate: entry.candidate, judgment: entry.judgment })),
    errorEntries: errors.map((entry) => ({ unit: unitSummary(entry.unit), candidate: entry.candidate, judgment: entry.judgment })),
    candidates: candidateRefs,
    duplicatesRemoved,
    counts: {
      units: units.length,
      candidates: normalized.length,
      pairs: planned.length,
      ok: together.length + unrelated.length,
      forward: together.length,
      excluded: unrelated.length,
      deferred: deferred.length,
      errors: errors.length,
      providerRequests: budgetState.providerRequestsUsed,
      cacheHits: results.filter((entry) => entry.judgment.cached).length,
    },
    continuation: deferred.length
      ? {
        remaining: deferred.map((entry) => ({ unit: unitSummary(entry.unit), candidate: entry.candidate })),
        reason: "budget exhausted: the remaining work is explicitly deferred and is never a negative judgment; re-run with the remaining pairs (identical work replays from cache)",
      }
      : null,
    cacheIssues,
    coverage: {
      candidatesSupplied: normalized.length,
      pairsPlanned: planned.length,
      pairsCompared: together.length + unrelated.length,
      exhaustiveCandidateComparison: false,
      note: "only the caller-supplied candidate ADRs were compared (exact ID/path/content/version tuples); candidate enumeration and filtering belong to the later retrieval-integration phase",
    },
    routingPolicy: policySummary(routingPolicy),
    model,
    api: effectiveApi,
  };
}

// ---------------------------------------------------------------------------
// Compact attributable result packets
// ---------------------------------------------------------------------------

const PACKET_NOTES = Object.freeze([
  "Selection/forwarding is not Architect approval and not a claim of current validity; low_priority/unrelated only exclude from the curation view and never delete retained source.",
  "Processing success is NOT Architect approval, NOT a published/indexed ADR, and NOT a completed curation obligation; the pending curation obligation for this change stays pending until a later Architect/publication outcome.",
  "All evidence text is verbatim retained source (exact spans/IDs/hashes preserved); no model-authored ADR prose and no summary exists anywhere in this packet.",
  "Operational/draft/rejected text may appear as attributed evidence; selection is not accepted/current policy (see each unit's acceptedPolicy/resolution attribution).",
  "Candidate coverage is exactly the caller-supplied candidate set; no claim that all existing ADRs were compared is ever made here.",
]);

function attachVerbatim(unitById, entry) {
  const unit = unitById.get(entry.unit.id);
  return unit ? { ...entry, text: unit.text, context: unit.context } : entry;
}

/**
 * Build the compact attributable result packet: selected VERBATIM evidence
 * (with exact spans/attribution) + all unit judgments + candidate pairs
 * considered. Omitted low_priority source and rejected pairs remain inspectable
 * by reference (with their preserved scores). Counts, errors and coverage are
 * explicit. This is curation INPUT for the Architect — not approval, not
 * publication, not obligation completion.
 */
export function buildResultPacket({
  changeId,
  manifestId,
  operationId = null,
  prepared,
  selection,
  comparison = null,
  model = DEFAULT_MODEL,
  api = null,
  routingPolicy = DEFAULT_ROUTING_POLICY,
  now = Date.now(),
} = {}) {
  if (!prepared || !selection) throw fail("invalid-arguments", "buildResultPacket requires the prepared evidence and the pass-1 selection result");
  assertPolicy(routingPolicy);
  const unitById = new Map(prepared.units.map((unit) => [unit.id, unit]));
  const effectiveApi = api ?? selection.api ?? { name: SYSTEMONE_API.name, version: SYSTEMONE_API.version, endpoint: SYSTEMONE_API.defaultEndpoint };
  const packet = {
    packetId: null,
    createdAt: now,
    changeId,
    manifestId,
    operationId,
    owner: prepared.owner ?? null,
    phaseId: prepared.phaseId ?? null,
    identity: {
      questions: questionsIdentity(),
      routingPolicy: policySummary(routingPolicy),
      model: { model, api: effectiveApi },
    },
    sources: prepared.sources.map(({ sourceId, kind, ref, unitCount, textSha256, status }) => ({ sourceId, kind, ref, unitCount, textSha256, status })),
    evidence: {
      selected: selection.forwardEntries.map((entry) => attachVerbatim(unitById, entry)),
      lowPriority: selection.excludedEntries,
      deferred: selection.deferredEntries,
      errors: selection.errorEntries,
    },
    candidatePairs: comparison
      ? {
        consideredTogether: comparison.consideredTogether,
        unrelated: comparison.unrelated,
        deferred: comparison.deferredEntries,
        errors: comparison.errorEntries,
      }
      : null,
    candidates: comparison ? comparison.candidates : [],
    counts: {
      evidence: selection.counts,
      candidatePairs: comparison ? { ...comparison.counts, duplicatesRemoved: comparison.duplicatesRemoved } : null,
    },
    coverage: {
      evidenceComplete: prepared.complete === true,
      incompleteSources: prepared.missing,
      recordOnlySources: prepared.recordOnly,
      candidatesSupplied: comparison ? comparison.coverage.candidatesSupplied : 0,
      pairsCompared: comparison ? comparison.coverage.pairsCompared : 0,
      exhaustiveCandidateComparison: false,
      curationObligation: "pending (untouched by this processing)",
    },
    notes: [...PACKET_NOTES],
  };
  packet.packetId = resultPacketId(packet);
  return packet;
}
