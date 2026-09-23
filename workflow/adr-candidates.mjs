// Shared curation candidate policy: selected verbatim phase-2 evidence +
// pinned corpus -> exact canonical ADR candidate tuples for `compareCandidates`
// (workflow/adr-jev-judgments.mjs), with a candidate identity/version
// snapshot, retrieval config/receipt and honest coverage.
//
// Policy (versioned + hashed; explicit TUNING PARAMETERS, not measured
// calibrated recall — see DEFAULT_RETRIEVAL_POLICY):
//   * eligible ADRs = EVERY ADR document in the pinned corpus (historical/
//     superseded decisions are never excluded by status),
//   * `exhaustiveThreshold` (default 50 eligible ADRs) is a CONFIGURABLE
//     strategy switch, never a hard candidate ceiling:
//       - <= threshold: EXHAUSTIVE pair candidates (all eligible ADRs) plus
//         SHADOW retrieval over the evidence for recall measurement ONLY —
//         shadow results NEVER exclude anything, and a shadow failure never
//         blocks the valid exhaustive comparison (it stays visible),
//       - > threshold: permissive corpus-scaled retrieval over the evidence
//         (one retrieval operation through the existing zvec-grep stack; no
//         score cutoff, Jev's 0.4 applies only to Jev positive-class scores),
//         unioned with EVERY explicit canonical ADR reference from the
//         evidence (explicit references bypass similarity ranking; unknown/
//         ambiguous references are explicit warnings), chunk hits lifted to
//         whole ADR identities, deduped with stable ordering before Jev.
//   * breadth = explicit configurable corpus-scaled tuning parameters
//     (`breadth.fraction/min/absoluteMax` of the eligible corpus) requested
//     through the supported direct interface (caller-selected per-group
//     limit; no 50 cap). No silent first-50, no automated query-facet /
//     context-expansion machinery.
//
// Honesty: search failure above the threshold is an INCOMPLETE RETRYABLE
// result — never a fake successful empty candidate set. A true empty corpus
// is valid. Requested/returned counts, saturation, query-budget deferrals and
// the backend's per-route recall bound (2000) are surfaced; above-threshold
// retrieval is intentionally selective and an unretrieved ADR is NEVER
// claimed unrelated or excluded by judgment. The exact returned candidates
// are snapshotted content-addressed for replay; new/changed corpus/ADR
// content, query/evidence or policy/config invalidates the cache by identity.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adrHeading, corpusSummary, extractAdrReferences, readAdrCorpus, resolveAdrReference } from "./adr-corpus.mjs";
import {
  ZVEC_RECALL_DEPTH_PER_ROUTE,
  ZVEC_RECALL_ROUTES,
  ZVEC_SCORE_KIND,
  adrIndexStatus,
  indexConfigHash,
  defaultBackendFactory,
  updateAdrIndex,
} from "./adr-index.mjs";
import { canonicalJson, sha256Hex } from "./adr-jev-cache.mjs";
import { DEFAULT_SEARCH_LIMIT } from "./adr-retrieval.mjs";

export const ADR_CANDIDATE_SNAPSHOT_SCHEMA = "adr-candidate-snapshot";
export const ADR_CANDIDATE_SNAPSHOT_SCHEMA_VERSION = 1;

export const DEFAULT_RETRIEVAL_POLICY = Object.freeze({
  schema: "adr-retrieval-policy",
  version: 1,
  // Configurable strategy switch (default 50 eligible ADRs): <= it, candidate
  // comparison is exhaustive; > it, retrieval is intentionally selective.
  exhaustiveThreshold: 50,
  // Query derivation from the selected evidence is bounded and deterministic —
  // never an automated query-facet/context-expansion loop.
  queryGroups: { max: 8, perGroupChars: 4000 },
  // Corpus-scaled retrieval breadth (tuning parameters, NOT calibrated
  // recall): per-group limit = clamp(ceil(n * fraction), min, absoluteMax),
  // capped at the eligible corpus size.
  breadth: { mode: "corpus-fraction", fraction: 0.5, min: 10, absoluteMax: 500 },
  note:
    "explicit tuning parameters for a bounded retrieval request, not measured calibrated recall; "
    + "scores are RRF rank fusion and are never thresholded here (Jev 0.4 applies only to Jev positive-class scores); "
    + "reranking never recovers unretrieved ADRs",
});

export function retrievalPolicyHash(policy = DEFAULT_RETRIEVAL_POLICY) {
  return sha256Hex(Buffer.from(canonicalJson(policy), "utf8"));
}

export function policySummary(policy = DEFAULT_RETRIEVAL_POLICY) {
  return {
    schema: policy.schema,
    version: policy.version,
    exhaustiveThreshold: policy.exhaustiveThreshold,
    queryGroups: policy.queryGroups,
    breadth: policy.breadth,
    sha256: retrievalPolicyHash(policy),
    note: policy.note,
  };
}

function assertPolicy(policy) {
  const threshold = policy?.exhaustiveThreshold;
  if (!Number.isSafeInteger(threshold) || threshold < 0) {
    throw Object.assign(new Error("retrieval policy requires a non-negative integer exhaustiveThreshold"), { code: "invalid-arguments" });
  }
  const breadth = policy?.breadth;
  if (!breadth || breadth.mode !== "corpus-fraction" || !(breadth.fraction > 0 && breadth.fraction <= 1) || !Number.isSafeInteger(breadth.min) || breadth.min < 1 || !Number.isSafeInteger(breadth.absoluteMax) || breadth.absoluteMax < breadth.min || breadth.absoluteMax > ZVEC_RECALL_DEPTH_PER_ROUTE) {
    throw Object.assign(new Error("retrieval policy requires breadth { mode: 'corpus-fraction', fraction in (0,1], min >= 1, absoluteMax >= min }"), { code: "invalid-arguments" });
  }
  const groups = policy?.queryGroups;
  if (!groups || !Number.isSafeInteger(groups.max) || groups.max < 1 || groups.max > 32 || !Number.isSafeInteger(groups.perGroupChars) || groups.perGroupChars < 1 || groups.perGroupChars > 4000) {
    throw Object.assign(new Error("retrieval policy requires queryGroups { max >= 1, perGroupChars >= 1 }"), { code: "invalid-arguments" });
  }
  return policy;
}

/** The corpus-scaled per-group retrieval breadth for n eligible ADRs. */
export function retrievalLimitFor(policy, eligibleCount) {
  assertPolicy(policy);
  const { fraction, min, absoluteMax } = policy.breadth;
  const scaled = Math.ceil(eligibleCount * fraction);
  return Math.min(eligibleCount, Math.max(min, Math.min(scaled, absoluteMax)));
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function assertVerbatimEvidence(evidence) {
  if (!Array.isArray(evidence)) throw fail("invalid-arguments", "evidence must be an array of verbatim phase-2 evidence units");
  for (const unit of evidence) {
    if (!unit || typeof unit !== "object" || typeof unit.id !== "string" || typeof unit.text !== "string") {
      throw fail("invalid-arguments", "each evidence unit requires id and verbatim text");
    }
    const digest = sha256Hex(Buffer.from(unit.text, "utf8"));
    if (unit.textSha256 !== digest) {
      throw fail("not-verbatim", `evidence unit '${unit.id}' text does not match its retained span sha256; only verbatim retained evidence can drive candidate retrieval`);
    }
  }
  return evidence;
}

// ---------------------------------------------------------------------------
// Candidate snapshots (subordinate, content-addressed, replayable)
// ---------------------------------------------------------------------------

export function adrCandidateSnapshotsDir(stateDir) {
  return join(stateDir, "adr-jev", "candidates");
}

export function candidateSnapshotPath(stateDir, snapshotId) {
  if (typeof snapshotId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(snapshotId)) {
    throw fail("invalid-arguments", "snapshotId must be a bounded identifier");
  }
  return join(adrCandidateSnapshotsDir(stateDir), `${snapshotId}.json`);
}

/**
 * The content-addressed candidate request identity: corpus bytes, the exact
 * selected evidence, the derived queries and the policy/config. Any
 * corpus/ADR content, query/evidence or policy change yields a NEW id (cache
 * invalidation by construction). The committed source revision is provenance
 * beside the identity, not part of it (non-ADR commits never invalidate).
 */
export function candidateRequestId({ corpusHash, evidence, queries, policy, indexConfigHashValue = indexConfigHash() }) {
  const material = {
    corpusHash,
    evidence: evidence.map((unit) => ({ id: unit.id, textSha256: unit.textSha256 })),
    queries: queries.map((query) => ({ id: query.id, text: query.text })),
    policy: retrievalPolicyHash(policy),
    indexConfigHash: indexConfigHashValue,
  };
  const identitySha256 = sha256Hex(Buffer.from(canonicalJson(material), "utf8"));
  return { snapshotId: `adrcand-${identitySha256.slice(0, 32)}`, identitySha256, material };
}

function integrityOf(entry) {
  const rest = { ...entry };
  delete rest.integrity;
  return { algorithm: "sha256", payloadSha256: sha256Hex(Buffer.from(canonicalJson(rest), "utf8")) };
}

export function writeCandidateSnapshot(stateDir, snapshot) {
  const dir = adrCandidateSnapshotsDir(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const entry = { ...snapshot, integrity: integrityOf(snapshot) };
  const path = candidateSnapshotPath(stateDir, snapshot.snapshotId);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return { ok: true, path, snapshotId: snapshot.snapshotId };
}

export function readCandidateSnapshot(stateDir, snapshotId) {
  const path = candidateSnapshotPath(stateDir, snapshotId);
  let entry;
  try {
    entry = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return existsSync(path)
      ? { ok: false, corrupt: true, reason: `candidate snapshot '${snapshotId}' is corrupt/unreadable: ${String(error?.message ?? error)}` }
      : { ok: false, missing: true, reason: `candidate snapshot '${snapshotId}' does not exist` };
  }
  if (!entry || typeof entry !== "object" || entry.schema !== ADR_CANDIDATE_SNAPSHOT_SCHEMA || entry.schemaVersion !== ADR_CANDIDATE_SNAPSHOT_SCHEMA_VERSION) {
    return { ok: false, corrupt: true, reason: `candidate snapshot '${snapshotId}' carries an unknown schema/version` };
  }
  if (entry.integrity?.payloadSha256 !== integrityOf(entry).payloadSha256) {
    return { ok: false, corrupt: true, reason: `candidate snapshot '${snapshotId}' failed its sha256 integrity check` };
  }
  if (entry.snapshotId !== snapshotId) {
    return { ok: false, corrupt: true, reason: `candidate snapshot '${snapshotId}' carries id '${entry.snapshotId}'` };
  }
  return { ok: true, snapshot: entry };
}

// ---------------------------------------------------------------------------
// Candidate preparation
// ---------------------------------------------------------------------------

function deriveQueries(evidence, policy) {
  const queries = [];
  const deferrals = [];
  evidence.forEach((unit, index) => {
    const text = unit.text.slice(0, policy.queryGroups.perGroupChars);
    const query = { id: `u${index}-${unit.id}`.slice(0, 80), role: "primary", unitId: unit.id, text: unit.heading ? `${unit.heading}\n${text}` : text };
    if (unit.text.length > policy.queryGroups.perGroupChars) deferrals.push({ unitId: unit.id, reason: `query-text-budget (policy.queryGroups.perGroupChars=${policy.queryGroups.perGroupChars}); remaining text deferred from similarity search (explicit ADR references still scanned across the full selected text)` });
    if (queries.length < policy.queryGroups.max) queries.push(query);
    else deferrals.push({ unitId: unit.id, reason: `query-group-budget (policy.queryGroups.max=${policy.queryGroups.max}); explicitly deferred, never silently dropped — the caller may increase/revise the bounded retrieval request` });
  });
  return { queries, deferrals };
}

function resolveExplicitReferences(evidence, entries) {
  const resolved = [];
  const unresolved = [];
  const seen = new Set();
  for (const unit of evidence) {
    for (const hit of extractAdrReferences(unit.text)) {
      const key = hit.reference;
      if (seen.has(key)) continue;
      seen.add(key);
      const outcome = resolveAdrReference(entries, key);
      if (outcome.ok) {
        resolved.push({ reference: key, adrId: outcome.entry.adrId, path: outcome.entry.path, resolvedBy: outcome.resolvedBy, firstUnitId: unit.id });
      } else {
        unresolved.push({ reference: key, code: outcome.code, reason: outcome.reason, firstUnitId: unit.id });
      }
    }
  }
  return { resolved, unresolved };
}

function tupleOf(entry) {
  return {
    adrId: entry.adrId,
    path: entry.path,
    content: entry.content,
    version: entry.version,
    contentSha256: entry.contentSha256,
    heading: adrHeading(entry.content),
  };
}

function coverageBase({ strategy, policy, corpus, included, retrieval, explicitReferences, deferrals, shadow }) {
  return {
    strategy,
    exhaustive: strategy === "exhaustive",
    eligibleAdrs: corpus.entries.length,
    includedCandidates: included,
    corpus: corpusSummary(corpus),
    retrievalPolicy: policySummary(policy),
    retrieval,
    explicitReferences,
    deferred: deferrals,
    shadow: shadow ?? null,
    note: strategy === "exhaustive"
      ? "candidate comparison is exhaustive over ALL eligible ADR documents in the pinned corpus (no status exclusion); shadow retrieval is recall measurement only and never excludes a candidate"
      : "candidate comparison is FILTERED by intentionally selective retrieval over the evidence plus ALL explicit canonical ADR references (which bypass similarity ranking); an unretrieved ADR is NOT claimed unrelated or excluded by judgment — reranking never recovers unretrieved ADRs",
  };
}

const backendBoundsNote = {
  recallDepthPerRoute: ZVEC_RECALL_DEPTH_PER_ROUTE,
  recallRoutes: [...ZVEC_RECALL_ROUTES],
  scoreKind: ZVEC_SCORE_KIND,
};

/**
 * Prepare the exact canonical ADR candidate tuples for one curation
 * comparison. Consumes SELECTED VERBATIM phase-2 evidence (span-hash checked)
 * and the pinned corpus only; never opens candidate content from a path the
 * caller supplied and never consults dirty worktree contents.
 */
export async function prepareCandidateSet({
  stateDir,
  projectRoot,
  evidence,
  revision = "HEAD",
  corpusDir,
  policy = DEFAULT_RETRIEVAL_POLICY,
  backendFactory = defaultBackendFactory,
  corpus = null,
  replay = true,
  now = () => Date.now(),
} = {}) {
  if (!stateDir) throw fail("invalid-arguments", "stateDir is required");
  assertPolicy(policy);
  assertVerbatimEvidence(evidence);

  let effectiveCorpus = corpus;
  if (!effectiveCorpus) {
    const loaded = await readAdrCorpus({ projectRoot, revision, ...(corpusDir ? { corpusDir } : {}) });
    if (!loaded.ok) {
      return {
        ok: false,
        status: "incomplete",
        retryable: loaded.code === "unresolved-revision" || loaded.code === "corpus-unreadable" || loaded.code === "not-a-git-repository",
        code: loaded.code,
        reason: loaded.reason,
        candidates: null,
        coverage: null,
      };
    }
    effectiveCorpus = loaded.corpus;
  }
  // The working corpus for the rest of this preparation (the `corpus`
  // parameter may have supplied it pre-loaded).
  corpus = effectiveCorpus;

  const { queries, deferrals } = deriveQueries(evidence, policy);
  const explicit = resolveExplicitReferences(evidence, corpus.entries);
  const request = candidateRequestId({ corpusHash: corpus.corpusHash, evidence, queries, policy });

  const cacheIssues = [];
  if (replay) {
    const cached = readCandidateSnapshot(stateDir, request.snapshotId);
    if (cached.ok && cached.snapshot.identity?.identitySha256 === request.identitySha256
      && cached.snapshot.candidates?.every((candidate) => {
        const entry = corpus.entries.find((item) => item.adrId === candidate.adrId);
        return entry?.path === candidate.path && entry?.version === candidate.version && entry?.content === candidate.content;
      })) {
      return {
        ok: true,
        status: "complete",
        replay: true,
        snapshotId: request.snapshotId,
        strategy: cached.snapshot.strategy,
        candidates: cached.snapshot.candidates,
        candidateRefs: cached.snapshot.candidateRefs,
        coverage: cached.snapshot.coverage,
        retrievalReceipt: cached.snapshot.retrievalReceipt,
        shadow: cached.snapshot.shadow,
        explicitReferences: cached.snapshot.explicitReferences,
        queryDeferrals: cached.snapshot.queryDeferrals,
        sourceRevision: cached.snapshot.sourceRevision,
        corpusHash: cached.snapshot.corpusHash,
        cacheIssues,
      };
    }
    if (cached.corrupt) cacheIssues.push({ snapshotId: request.snapshotId, reason: cached.reason, treated: "cache-miss" });
  }

  const strategy = corpus.entries.length <= policy.exhaustiveThreshold ? "exhaustive" : "retrieved";
  const perGroupLimit = retrievalLimitFor(policy, Math.max(corpus.entries.length, 1));
  const entryByPath = new Map(corpus.entries.map((entry) => [entry.path, entry]));
  const entryById = new Map(corpus.entries.map((entry) => [entry.adrId, entry]));

  const retrievalReceipt = {
    queries,
    queryDeferrals: deferrals,
    perGroupLimit,
    breadth: { ...policy.breadth, eligibleAdrs: corpus.entries.length, formula: "clamp(ceil(eligibleAdrs * fraction), min, absoluteMax), capped at eligibleAdrs" },
    backendBounds: backendBoundsNote,
    requestedPerGroup: perGroupLimit,
    returnedPerGroup: [],
    saturationKnown: true,
    scoresNote: "hit scores are RRF rank fusion values (NOT similarity probabilities); no score cutoff is applied and Jev's 0.4 never applies to them",
  };

  // The derived ADR-only index is the ONE retrieval surface for candidates too.
  // Refresh it when missing/stale (derived state only) and record that honestly;
  // an unavailable index is a retrieval failure — never a fake empty result.
  let indexState = corpus.entries.length > 0
    ? adrIndexStatus(stateDir, { corpus })
    : { state: "empty", fresh: false, reason: "no ADR documents to index" };
  if (corpus.entries.length > 0 && indexState.state !== "fresh") {
    const update = await updateAdrIndex({ stateDir, corpus, backendFactory, now });
    if (update.ok) {
      indexState = adrIndexStatus(stateDir, { corpus });
      retrievalReceipt.indexRefreshed = true;
    } else {
      indexState = { state: "unavailable", fresh: false, receipt: null, reason: update.reason };
    }
  }
  retrievalReceipt.index = { state: indexState.state, fresh: indexState.fresh, receiptId: indexState.receipt?.receiptId ?? null, sourceRevision: indexState.receipt?.corpus?.sourceRevision ?? null };
  const workspaceRoot = indexState.receipt?.materialization?.workspace ?? null;

  const runRetrieval = async () => {
    if (queries.length === 0) return { ok: true, groups: [], empty: true };
    if (!indexState.fresh) {
      return { ok: false, retryable: true, message: `the derived ADR index is unavailable for retrieval: ${indexState.reason ?? "unknown reason"}` };
    }
    const opened = await backendFactory({ workspaceRoot, purpose: "candidates" });
    if (!opened.ok) return { ok: false, retryable: true, message: opened.reason };
    try {
      return await opened.backend.search({ queries, limit: perGroupLimit });
    } finally {
      await opened.backend.close?.();
    }
  };

  let candidates = [];
  let shadow = null;
  let coverage;

  if (corpus.entries.length === 0) {
    // A true empty corpus is valid: zero candidates, complete (exhaustively so).
    coverage = coverageBase({ strategy: "exhaustive", policy, corpus, included: 0, retrieval: { ...retrievalReceipt, note: "no ADR documents exist in the pinned corpus; no retrieval was attempted" }, explicitReferences: explicit, deferrals, shadow: null });
  } else if (strategy === "exhaustive") {
    // Exhaustive pair candidates: EVERY eligible ADR, stable corpus order.
    candidates = corpus.entries.map(tupleOf);
    // Shadow retrieval: recall measurement ONLY — it never excludes anything.
    const shadowRun = await runRetrieval();
    if (shadowRun.ok) {
      const wouldRetrieve = [];
      for (const group of shadowRun.groups ?? []) {
        for (const item of group.items ?? []) {
          const entry = item.relativePath ? entryByPath.get(item.relativePath) : null;
          if (entry && !wouldRetrieve.includes(entry.adrId)) wouldRetrieve.push(entry.adrId);
        }
      }
      retrievalReceipt.returnedPerGroup = (shadowRun.groups ?? []).map((group) => ({ id: group.id, requested: perGroupLimit, returned: group.items.length, saturated: group.items.length >= perGroupLimit }));
      shadow = {
        ok: true,
        role: "recall-measurement-only",
        note: "shadow retrieval never excludes a candidate; the comparison is exhaustive regardless of what the shadow did or did not retrieve",
        retrievedAdrIds: wouldRetrieve,
        wouldRetrieveCount: wouldRetrieve.length,
        eligibleCount: corpus.entries.length,
      };
    } else {
      // Shadow failure is visible but must NOT block the valid exhaustive comparison.
      shadow = {
        ok: false,
        role: "recall-measurement-only",
        note: "shadow retrieval failed; the exhaustive comparison is unaffected and proceeds with ALL eligible ADRs",
        reason: shadowRun.message ?? "shadow retrieval failed",
      };
      cacheIssues.push({ snapshotId: request.snapshotId, reason: `shadow retrieval failed (${shadowRun.message ?? "unknown"}); exhaustive candidates unaffected` });
    }
    coverage = coverageBase({ strategy: "exhaustive", policy, corpus, included: candidates.length, retrieval: retrievalReceipt, explicitReferences: explicit, deferrals, shadow });
  } else {
    // Selective retrieval over the evidence + ALWAYS-unioned explicit references.
    const retrieval = await runRetrieval();
    if (!retrieval.ok) {
      // NEVER a fake successful empty candidate set: incomplete + retryable.
      return {
        ok: false,
        status: "incomplete",
        retryable: true,
        code: "retrieval-failed",
        reason: `candidate retrieval failed above the exhaustive threshold: ${retrieval.message ?? "search backend failed"}. The candidate set is INCOMPLETE and retryable — it is never a successful empty set; the caller may retry or revise the bounded retrieval request.`,
        candidates: null,
        candidateRefs: null,
        strategy,
        snapshotId: request.snapshotId,
        retrievalReceipt,
        explicitReferences: explicit,
        queryDeferrals: deferrals,
        coverage: null,
        cacheIssues,
      };
    }
    const order = [];
    const seenIds = new Set();
    // Explicit canonical references FIRST (first-appearance order) — they
    // bypass similarity ranking and are ALWAYS included.
    for (const ref of explicit.resolved) {
      if (seenIds.has(ref.adrId)) continue;
      seenIds.add(ref.adrId);
      order.push(ref.adrId);
    }
    let unmappedHits = 0;
    for (const group of retrieval.groups ?? []) {
      for (const item of group.items ?? []) {
        const entry = item.relativePath ? entryByPath.get(item.relativePath) : null;
        if (!entry) {
          unmappedHits += 1;
          continue;
        }
        if (seenIds.has(entry.adrId)) continue;
        seenIds.add(entry.adrId);
        order.push(entry.adrId);
      }
    }
    retrievalReceipt.returnedPerGroup = (retrieval.groups ?? []).map((group) => ({ id: group.id, requested: perGroupLimit, returned: group.items.length, saturated: group.items.length >= perGroupLimit }));
    retrievalReceipt.unmappedHits = unmappedHits;
    candidates = order.map((adrId) => tupleOf(entryById.get(adrId)));
    coverage = coverageBase({ strategy: "retrieved", policy, corpus, included: candidates.length, retrieval: retrievalReceipt, explicitReferences: explicit, deferrals, shadow: null });
  }

  const candidateRefs = candidates.map(({ adrId, path, version, contentSha256 }) => ({ adrId, path, version, contentSha256 }));
  const snapshot = {
    schema: ADR_CANDIDATE_SNAPSHOT_SCHEMA,
    schemaVersion: ADR_CANDIDATE_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: request.snapshotId,
    identity: { identitySha256: request.identitySha256, material: request.material },
    createdAt: now(),
    sourceRevision: corpus.sourceRevision,
    corpusHash: corpus.corpusHash,
    strategy,
    candidates,
    candidateRefs,
    coverage,
    retrievalReceipt,
    shadow,
    explicitReferences: explicit,
    queryDeferrals: deferrals,
  };
  writeCandidateSnapshot(stateDir, snapshot);

  return {
    ok: true,
    status: "complete",
    replay: false,
    snapshotId: request.snapshotId,
    strategy,
    candidates,
    candidateRefs,
    coverage,
    retrievalReceipt,
    shadow,
    explicitReferences: explicit,
    queryDeferrals: deferrals,
    sourceRevision: corpus.sourceRevision,
    corpusHash: corpus.corpusHash,
    cacheIssues,
  };
}
