# ADR Jev judgments — production contracts (phase cd16c90a)

Binary Jev judgments over the retained ADR evidence landed in PR130
(`workflow/adr-curation.mjs`). This document is the concrete contract for the
next integration phases (ZG/Qwen/Jina candidate discovery, Architect UI/tools,
deterministic publication/indexing). **Not deployed here:** no pipeline
wake-up, no candidate discovery, no publication/indexing, no Architect UI.

Modules (narrow by design — not a prompt framework, not a scheduler):

| Module | Responsibility |
| --- | --- |
| `workflow/adr-jev-questions.mjs` | THE one versioned source of the two binary question templates + model-facing state builder |
| `workflow/adr-jev-client.mjs` | bounded single-attempt SystemOne v1 provider seam (injectable network, credential safety) |
| `workflow/adr-jev-cache.mjs` | content-addressed successful raw judgment cache + result-packet artifact store (subordinate, 0600/0700) |
| `workflow/adr-jev-judgments.mjs` | deterministic segmentation, evidence preparation over phase-1 readers, pass-1 selection, pass-2 candidate pairing, routing policy, result packets |

## Exactly two binary templates

| Pass | Question | Options (positive first) | Positive class |
| --- | --- | --- | --- |
| 1 — selection | route ONE retained passage | `include` / `low_priority` | `include` |
| 2 — candidate pairing | route ONE retained snippet vs ONE candidate ADR | `consider_together` / `unrelated` | `consider_together` |

The initial wording BYTE-MATCHES the frozen experiment
(`tests/fixtures/adr-jev/questions-frozen.json`; provenance README in that
directory) via the same `unit_id` substitution; `tests/adr-jev-questions.mjs`
proves the byte match and the byte-exact reproduction of the observed request
bodies. Every question names its target unit id in the instructions. There is
no third lane, no relationship vocabulary, no context-expansion loop.

## Routing policy (versioned + hashed, stored separately from judgments)

```js
DEFAULT_ROUTING_POLICY = {
  schema: "adr-jev-routing-policy",
  version: 1,
  positiveScoreMin: 0.4,
  rule: "positive-class score >= positiveScoreMin routes forward (never model argmax, never model confidence)",
}
```

* `route = "forward"` iff the exact positive-class probability `>= 0.4`
  (exactly 0.4 forwards) — for BOTH passes. The model's `choice`, `confidence`
  and `argmax` are preserved for transparency and NEVER drive routing.
* The exact response scores (`judgment.answer`) and the actual route
  (`judgment.route`) are stored separately.
* `reprojectJudgment(judgment, policy)` recomputes routes from preserved raw
  scores with ZERO provider calls — a threshold-only policy change never
  re-requests. Routing policy hash lives in `judgment.policy.sha256` and
  `packet.identity.routingPolicy.sha256`, never inside the judgment identity.
* Errors, malformed/missing scores or classes, invalid ranges and budget
  deferrals stay `error` / `invalid-response` / `deferred` (pending/retryable)
  — never a silent `0` / `unrelated` / `low_priority`.

## Public API

### Preparation (integrated with the landed phase-1 readers)

```js
prepareEvidenceUnits({ stateDir, changeId, manifestId, expected = { owner, phaseId, root } })
// -> { ok, status: "prepared"|"incomplete", complete, retryable, changeId,
//      manifestId, owner, phaseId,
//      units: [Unit], sources: [...], missing: [...], recordOnly: [...] }
```

* Reads the retained manifest via `readAdrSourceManifest`, cross-checks blob
  integrity and record presence via `adrCurationView`, and reads FULL durable
  report contents via `readReport` (chunk-assembled; nothing truncated).
* Sources segmented (deterministic order): exact ticket text, immutable
  constraints, ordered update instructions (with authoritative ack/outcome
  attribution), role-report texts.
* Missing/corrupt manifest, record, report or incomplete text yields the
  explicit `incomplete` result with `missing[]` entries (`retryable` flags) —
  never a negative classification. Curation can never be marked finished from
  missing evidence (`coverage.evidenceComplete` stays false).
* Unresolved/rejected updates are segmented with
  `ref.acceptedPolicy === false` (attributed source, not accepted policy).
  Selection is never acceptance.
* `expected.owner/phaseId/root` and the manifest's change binding are enforced
  (`owner-mismatch` / `phase-mismatch` / `root-mismatch` / `change-mismatch`
  throw — foreign context is refused). Candidate `path` values and retained
  `ticket.path` are provenance labels only and are never opened.

### Segmentation

```js
segmentUnits({ sourceId, ref, text }) // -> [Unit]
Unit = {
  id,                 // deterministic 12-hex id: sha256(sourceId, spanStart, text)
  sourceId, ref,      // full attribution (phase/change/role/attempt/revision/seq/eventId/ack/outcome)
  heading,            // section heading (heading blocks are context; mixed heading+body stays whole)
  text,               // VERBATIM exact span (never rewritten)
  span: { start, end },
  textSha256,
  context: { prev, next }, // verbatim neighboring blocks (null at boundaries)
}
```

### Selection (pass 1) and candidate pairing (pass 2)

```js
judgeSelection({ stateDir, provider, units, model = "jev-1.13.0", api, budget, routingPolicy, provenance })
compareCandidates({ stateDir, provider, units, candidates = [], model, api, budget, routingPolicy, provenance })
normalizeCandidate({ adrId, path, content, version, heading?, contentSha256? })
```

* `provider` is the injectable seam (`createSystemOneProvider(...)` or a test
  fake): `provider.request({ model, state, questions })`. Requests use
  SystemOne v1 `state`/`questions` — no chat channel. Defaults match the
  verified experiment: model `jev-1.13.0`, SystemOne v1. Single attempt,
  bounded timeout, no automatic retries.
* Candidates are exact `{ adrId, path, content, version }` tuples supplied by
  the caller. Zero candidates is valid. Only the supplied candidates are
  compared (`coverage.exhaustiveCandidateComparison === false`, with an honest
  note) — candidate enumeration/filtering belongs to the retrieval-integration
  phase; there is no reranker here.
* Pairs are `units × candidates` in deterministic order; identical pair/input
  requests dedupe (`duplicatesRemoved`); candidate provenance is preserved on
  every pair. Pass 2 "potentially useful" = bears on the candidate ADR's
  choice, rationale, conflict, replacement, dependency or exception (the
  frozen wording's decision/constraint/rationale/alternative/consequence);
  shared vocabulary alone is `unrelated`.
* Budgets: `budget.maxUnits` / `budget.maxProviderRequests`. Deferred work is
  explicit (`status: "deferred"` + `continuation.remaining`) and is never a
  negative judgment. Cache hits do not consume provider-request budget.

### Result packets

```js
buildResultPacket({ changeId, manifestId, operationId, prepared, selection, comparison, model, api, routingPolicy })
writeResultPacket(stateDir, packet)  // -> { path, sha256, dedupe }
readResultPacket(stateDir, packetId) // -> { ok, entry } | { ok:false, corrupt, reason }
```

Compact attributable packets: `evidence.selected` carries the SELECTED VERBATIM
evidence (exact spans/IDs/hashes/attribution) + judgments; `evidence.lowPriority`
and `candidatePairs.unrelated` are references + preserved scores only (no
duplicate prose store, no summaries). Counts, errors, coverage and
`coverage.curationObligation: "pending (untouched by this processing)"` are
explicit. Processing success is NOT Architect approval, NOT a published/indexed
ADR and NOT a completed curation obligation — the pending obligation from
`listCurationObligations` stays pending until a later Architect/publication
outcome.

## Cache identity (content-addressed, version-blind by construction)

```
judgmentId = jevj-<sha256(canonicalJson({ request: { api, model, state, questions }, scope }))32>
scope      = pass 2 ? { candidate: { version, contentSha256 } } : null
```

* `api = { name, version, endpoint }` — every request-affecting parameter.
* The EXACT model, verbatim `state` (unit text + context + candidate content)
  and verbatim `questions` (wording + options) are the identity. A forgotten
  version bump cannot cause stale reuse; wording/options/context/model/endpoint
  changes and candidate content or version changes are always cache misses.
* Routing policy is excluded on purpose (see above).
* Only VALIDATED SUCCESSFUL responses are cached. Errors never masquerade as
  reusable judgments. Artifacts are immutable: identical writes dedupe
  (`dedupe: true`), a divergent concurrent response is reported
  (`divergent: true`) and the first successful judgment is preserved.
* Corrupt artifacts are reported (`{ ok:false, corrupt:true, reason }`) and the
  next real response cleanly replaces them (`repairedCorrupt: true`) — scores
  are never fabricated.

## Tuning points (all central, no prompt framework)

* `workflow/adr-jev-questions.mjs` — wording, option sets, question type/key
  scheme (`QUESTIONS_VERSION`, `questionsIdentity()`).
* `DEFAULT_ROUTING_POLICY.positiveScoreMin` (0.4) and its version/hash
  (`routingPolicyHash`) in `workflow/adr-jev-judgments.mjs`.
* `DEFAULT_MODEL` (`jev-1.13.0`), `SYSTEMONE_API` endpoint/version,
  `DEFAULT_TIMEOUT_MS` in `workflow/adr-jev-client.mjs`.
* Budgets per call (`maxUnits`, `maxProviderRequests`) — caller-supplied.

## Subordinate operational artifacts (outside any ADR index)

```
<stateDir>/adr-jev/judgments/<judgmentId>.json   // 0600 raw judgments
<stateDir>/adr-jev/packets/<packetId>.json       // 0600 result packets
```

Dirs 0700, tmp + rename, sha256 `integrity` field, no credentials, never
indexed and never in a repository working tree. No second authoritative
obligation store and no extra state machine: the managed change record remains
the sole authority and this phase appends no events.

## Deliberately out of scope (next phases)

Shared ADR retrieval and Architect planning lookup are implemented in phase 52315bc8
(see [adr-retrieval.md](adr-retrieval.md)); this is ZG hybrid/RRF, **not** Jina
invocation. Candidate policy is exhaustive plus non-excluding shadow through 50
eligible ADRs by default, selective above that with no fixed 50 ceiling. Still
out of scope: deterministic Architect-authored publication, obligation disposition,
post-landing delivery/recovery and integrated runtime acceptance.
