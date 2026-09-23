// The curation comparison helper contract: manifest -> selection -> candidate
// policy -> comparison -> packet, composing the landed phase-1/phase-2 APIs
// with the shared ADR retrieval candidate policy.
//
// Deliberately thin: every step is the landed API (`prepareEvidenceUnits` /
// `judgeSelection` / `compareCandidates` / `buildResultPacket` from
// workflow/adr-jev-judgments.mjs) plus `prepareCandidateSet` from
// workflow/adr-candidates.mjs. Nothing here authors ADR text, decides
// no-change/publication, completes the curation obligation, schedules work,
// or alters frozen Jev wording / 0.4 routing. A retrieval or source failure is
// an explicit incomplete retryable result — never a negative classification
// and never a fake empty candidate set.

import {
  buildResultPacket,
  compareCandidates,
  judgeSelection,
  prepareEvidenceUnits,
} from "./adr-jev-judgments.mjs";
import { DEFAULT_RETRIEVAL_POLICY, prepareCandidateSet } from "./adr-candidates.mjs";
import { DEFAULT_MODEL } from "./adr-jev-client.mjs";

/**
 * Run ONE curation comparison over the retained evidence of a change:
 *   1. `prepareEvidenceUnits` — verified retained manifest -> verbatim units,
 *   2. `judgeSelection` — pass 1 (include / low_priority),
 *   3. `prepareCandidateSet` — the shared candidate policy over the SELECTED
 *      verbatim units and the pinned corpus (exhaustive <= threshold + shadow,
 *      selective retrieval + always-unioned explicit references > threshold),
 *   4. `compareCandidates` — pass 2 (consider_together / unrelated) with the
 *      policy's exact candidate tuples and coverage propagation,
 *   5. `buildResultPacket` — the attributable packet with honest
 *      exhaustive/filtered/deferred candidate coverage.
 *
 * Budget deferrals at any step stay explicit and are carried into the packet;
 * the pending curation obligation is untouched.
 */
export async function runAdrCurationComparison({
  stateDir,
  changeId,
  manifestId,
  projectRoot,
  revision = "HEAD",
  corpusDir,
  provider,
  expected = {},
  model = DEFAULT_MODEL,
  api = null,
  budget = {},
  routingPolicy,
  retrievalPolicy = DEFAULT_RETRIEVAL_POLICY,
  backendFactory,
  operationId = null,
  provenance = {},
  now = () => Date.now(),
} = {}) {
  const prepared = prepareEvidenceUnits({ stateDir, changeId, manifestId, expected });
  const base = { changeId, manifestId, prepared, stage: "prepare" };
  if (!prepared.ok) {
    return { ok: false, status: "incomplete", retryable: prepared.retryable !== false, ...base, reason: "retained evidence is incomplete; comparison is explicitly pending/retryable (never a negative classification)" };
  }

  const selection = await judgeSelection({
    stateDir,
    provider,
    units: prepared.units,
    model,
    api,
    budget,
    ...(routingPolicy ? { routingPolicy } : {}),
    provenance: { ...provenance, changeId, manifestId },
  });

  const unitById = new Map(prepared.units.map((unit) => [unit.id, unit]));
  const selectedUnits = selection.forwardEntries
    .map((entry) => unitById.get(entry.unit.id))
    .filter(Boolean);

  const candidateSet = await prepareCandidateSet({
    stateDir,
    projectRoot,
    evidence: selectedUnits,
    revision,
    ...(corpusDir ? { corpusDir } : {}),
    policy: retrievalPolicy,
    ...(backendFactory ? { backendFactory } : {}),
    now,
  });
  const withCandidates = { ...base, stage: "candidates", selection, candidateSet };
  if (!candidateSet.ok) {
    // Incomplete retryable curation: never a successful empty candidate set.
    return { ok: false, status: "incomplete", retryable: candidateSet.retryable !== false, ...withCandidates, reason: candidateSet.reason };
  }

  const comparison = await compareCandidates({
    stateDir,
    provider,
    units: selectedUnits,
    candidates: candidateSet.candidates,
    model,
    api,
    budget,
    ...(routingPolicy ? { routingPolicy } : {}),
    provenance: { ...provenance, changeId, manifestId, candidateSnapshotId: candidateSet.snapshotId },
    candidateCoverage: candidateSet.coverage,
  });

  const packet = buildResultPacket({
    changeId,
    manifestId,
    operationId,
    prepared,
    selection,
    comparison,
    candidateCoverage: candidateSet.coverage,
    model,
    api,
    ...(routingPolicy ? { routingPolicy } : {}),
    now: now(),
  });

  return {
    ok: comparison.ok && selection.ok,
    status: comparison.ok && selection.ok ? "complete" : "incomplete",
    retryable: !comparison.ok || !selection.ok,
    changeId,
    manifestId,
    stage: "packet",
    prepared,
    selection,
    candidateSet,
    comparison,
    packet,
    note: "processing success is curation INPUT only: the pending curation obligation stays pending and no ADR authoring/no-change/publication decision is inferred here",
  };
}
