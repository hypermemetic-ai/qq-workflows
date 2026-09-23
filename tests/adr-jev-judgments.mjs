#!/usr/bin/env node
// Deterministic proof of the production binary Jev judgment pipeline over
// retained ADR evidence. Fake/replay provider seams and local temporary state
// dirs only — NO paid/provider inference, no live call, no worker, no
// notification, no indexing anywhere.
//
// Transparency note on fixture provenance (tests/fixtures/adr-jev/README.md):
// of the 12 frozen passage states only 6a8f2f and fc72cd are real excerpts
// ("real-excerpt"); the other 10 are constructed synthetic controls and the
// pass-2 candidate ADR fixture is entirely synthetic. The observed raw outputs
// in raw/ are real recorded jev-1.13.0 responses replayed here verbatim. No
// production recall calibration is claimed.
//
// Covers: (a) deterministic paragraph/heading segmentation with exact spans,
// attribution and neighboring context (mixed passages stay whole); (b) the
// 0.4 boundary, the .50 positive tie independent of argmax/confidence and
// below-threshold exclusion for BOTH passes; (c) malformed JSON / HTTP /
// network / timeout / response-score validation — errors stay pending, never a
// negative classification and never cached; (d) replay of the observed raw
// outputs (unchanged repeats are cache hits; wording/options/context/model/
// ADR version changes are cache misses; threshold-only reprojection calls
// nothing); (e) budget deferral vs unrelated + continuation; (f) missing/
// corrupt source/report/cache and unresolved-amendment honesty, no source
// deletion, no cache/source artifacts outside the subordinate state dir;
// (g) manifest/owner/phase confusion refusal; (h) end-to-end fake-provider
// manifest -> pass1 -> supplied ADRs -> pass2 -> result packet via the landed
// phase-1 APIs, with the pending obligation untouched.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  activateCurationObligation,
  adrSourcePath,
  listCurationObligations,
  readAdrSourceManifest,
  stageAdrSource,
} from "../workflow/adr-curation.mjs";
import {
  DEFAULT_ROUTING_POLICY,
  buildResultPacket,
  compareCandidates,
  judgeSelection,
  modelArgmaxOf,
  normalizeCandidate,
  prepareEvidenceUnits,
  reprojectJudgment,
  routeFromPositiveScore,
  segmentUnits,
  validateAnswer,
} from "../workflow/adr-jev-judgments.mjs";
import { createSystemOneProvider, systemoneRequest } from "../workflow/adr-jev-client.mjs";
import { canonicalJson, judgmentArtifactPath, judgmentIdentity, readJudgmentArtifact, readResultPacket, writeResultPacket } from "../workflow/adr-jev-cache.mjs";
import { selectQuestion, unitsState } from "../workflow/adr-jev-questions.mjs";
import { openChange } from "../workflow/change-record.mjs";
import { recordManagedExecution, recordRoleOutcome, registerRoleAttempt } from "../workflow/execution-authority.mjs";
import { saveReport } from "../workflow/reports.mjs";

const pass = (message) => console.log(`PASS ${message}`);
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "fixtures", "adr-jev");
const API = { name: "systemone", version: "v1", endpoint: "https://api.typesafe.ai/v1/systemone" };
const MODEL = "jev-1.13.0";
const RUNTIME = { kind: "runtime", id: "test-runtime" };
const WORKER = { kind: "worker", id: "test-worker" };
const OWNER = "coordinator-jev-1";
const PHASE = "phasejev0001-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const passages = JSON.parse(readFileSync(join(FIXTURES, "passages.json"), "utf8"));
const labelsEval = JSON.parse(readFileSync(join(FIXTURES, "labels-eval.json"), "utf8"));
const candidateAdrFixture = JSON.parse(readFileSync(join(FIXTURES, "candidate-adr.json"), "utf8"));

const hashText = (text) => createHash("sha256").update(text).digest("hex");

function fixtureUnits(passNo) {
  return passages.states
    .filter((entry) => entry.pass === passNo)
    .map((entry) => ({
      id: entry.id,
      sourceId: `fixture:${entry.id}`,
      ref: { kind: "fixture", pairRole: entry.pair_role, fixtureKind: entry.source.kind },
      heading: entry.heading,
      text: entry.text,
      span: { start: 0, end: entry.text.length },
      textSha256: hashText(entry.text),
      context: entry.context,
    }));
}

// A provider seam that replays the OBSERVED raw experiment outputs, matching
// the exact recorded request bodies (model/state/questions).
function replayProvider() {
  const calls = [];
  const entries = readdirSync(join(FIXTURES, "raw")).sort().map((callId) => ({
    callId,
    request: JSON.parse(readFileSync(join(FIXTURES, "raw", callId, "request.json"), "utf8")),
    response: JSON.parse(readFileSync(join(FIXTURES, "raw", callId, "response.json"), "utf8")),
  }));
  return {
    api: API,
    calls,
    async request({ model, state, questions }) {
      calls.push({ model, state, questions });
      const body = { model, state, questions };
      const hit = entries.find((entry) => canonicalJson(entry.request) === canonicalJson(body));
      if (!hit) return { ok: false, errorType: "REPLAY_MISS", retryable: false, errorMessage: "no recorded request matches this replay input" };
      return { ok: true, httpStatus: 200, json: hit.response };
    },
  };
}

// A deterministic fake provider seam (never a live call).
function fakeProvider(buildAnswer) {
  const calls = [];
  return {
    api: API,
    calls,
    async request({ model, state, questions }) {
      calls.push({ model, state, questions });
      const key = Object.keys(questions)[0];
      return buildAnswer({ key, state, questions, model, call: calls.length });
    },
  };
}

const choiceAnswer = (key, { positive, negative, choice, score, confidence = null }) => ({
  ok: true,
  httpStatus: 200,
  json: {
    model: MODEL,
    answers: {
      [key]: {
        type: "choice",
        choice,
        ...(confidence == null ? {} : { confidence }),
        probabilities: { [positive]: score, [negative]: 1 - score },
      },
    },
  },
});

function tmpStateDir() {
  return join(mkdtempSync(join(tmpdir(), "adr-jev-judgments-")), "state");
}

// ---------------------------------------------------------------------------
// (a) Deterministic segmentation: exact spans, attribution, context
// ---------------------------------------------------------------------------
{
  const text = "# Heading one\n\nFirst paragraph.\n\nSecond paragraph with\na second line.\n\n## Sub\n\n# Mixed heading\nBody of mixed block.\n\nTail paragraph.";
  const ref = { kind: "ticket", changeId: "chg-1" };
  const units = segmentUnits({ sourceId: "ticket:abc", ref, text });
  assert.equal(units.length, 4, "heading blocks are section context; paragraphs and the mixed block are units");
  for (const unit of units) {
    assert.equal(text.slice(unit.span.start, unit.span.end), unit.text, "unit text is the EXACT source span");
    assert.equal(unit.textSha256, hashText(unit.text));
    assert.deepEqual(unit.ref, ref, "attribution rides along on every unit");
    assert.equal(unit.sourceId, "ticket:abc");
  }
  assert.deepEqual(units.map((unit) => unit.heading), ["Heading one", "Heading one", "Mixed heading", "Mixed heading"]);
  assert.ok(units[2].text.startsWith("# Mixed heading\nBody of mixed block."), "the mixed heading+body passage stays WHOLE as one unit");
  assert.equal(units[2].text, "# Mixed heading\nBody of mixed block.");
  assert.equal(units[0].context.prev, "# Heading one", "supplied neighboring context (verbatim previous block)");
  assert.equal(units[0].context.next, "Second paragraph with\na second line.");
  assert.equal(units[3].text, "Tail paragraph.");
  assert.equal(units[3].context.next, null, "no fabricated neighbor at the boundary");
  assert.deepEqual(segmentUnits({ sourceId: "ticket:abc", ref, text }), units, "segmentation is deterministic");

  const lone = segmentUnits({ sourceId: "s", ref, text: "  \n\n  lone  \n" });
  assert.equal(lone.length, 1);
  assert.equal(lone[0].text, "lone");
  assert.equal(text.length >= 0 && lone[0].span.start >= 0, true);
  assert.equal("  \n\n  lone  \n".slice(lone[0].span.start, lone[0].span.end), "lone", "whitespace trimming keeps exact span offsets");
  assert.deepEqual(lone[0].context, { prev: null, next: null });
  pass("deterministic paragraph/heading segmentation keeps exact spans/IDs/hashes, attribution and neighboring context (mixed passages stay whole)");
}

// ---------------------------------------------------------------------------
// (b) Routing: exactly 0.4 boundary, .50 tie independent of argmax/confidence,
//     below threshold — for BOTH passes
// ---------------------------------------------------------------------------
{
  assert.equal(routeFromPositiveScore(0.4), "forward", "score exactly 0.4 routes forward");
  assert.equal(routeFromPositiveScore(0.399999), "excluded");
  assert.equal(modelArgmaxOf({ include: 0.5, low_priority: 0.5 }), "tie");
  assert.deepEqual(validateAnswer({ type: "choice", choice: "include", probabilities: { include: 0.4, low_priority: 0.6 } }, { positive: "include", negative: "low_priority" }), { valid: true });

  const unit = fixtureUnits(1)[0];
  const atBoundary = fakeProvider(({ key }) => choiceAnswer(key, { positive: "include", negative: "low_priority", choice: "low_priority", score: 0.4, confidence: 0.99 }));
  const boundaryRun = await judgeSelection({ stateDir: tmpStateDir(), provider: atBoundary, units: [unit] });
  assert.equal(boundaryRun.forwardEntries.length, 1, "exactly 0.4 forwards even though the model's argmax choice is low_priority with 0.99 confidence");
  const judgment = boundaryRun.forwardEntries[0].judgment;
  assert.equal(judgment.positiveScore, 0.4);
  assert.equal(judgment.answer.choice, "low_priority");
  assert.equal(judgment.modelArgmax, "low_priority");
  assert.equal(judgment.route, "forward", "the actual route is preserved separately from the raw response");

  const justBelow = fakeProvider(({ key }) => choiceAnswer(key, { positive: "include", negative: "low_priority", choice: "include", score: 0.399999, confidence: 0 }));
  const belowRun = await judgeSelection({ stateDir: tmpStateDir(), provider: justBelow, units: [unit] });
  assert.equal(belowRun.excludedEntries.length, 1, "below-threshold is a REAL exclusion (distinct from deferral/error)");
  assert.equal(belowRun.excludedEntries[0].judgment.positiveScore, 0.399999);

  // The observed .50 tie shape: positive score 0.5 forwards independently of
  // argmax ('tie') and of the model's own low_priority choice/confidence 0.
  const tie = fakeProvider(({ key }) => ({ ok: true, httpStatus: 200, json: { model: MODEL, answers: { [key]: { type: "choice", choice: "low_priority", confidence: 0, probabilities: { low_priority: 0.5, include: 0.5 } } } } }));
  const tieRun = await judgeSelection({ stateDir: tmpStateDir(), provider: tie, units: [unit] });
  const tieJudgment = tieRun.forwardEntries[0].judgment;
  assert.equal(tieJudgment.positiveScore, 0.5);
  assert.equal(tieJudgment.modelArgmax, "tie");
  assert.equal(tieJudgment.route, "forward", "a .50 positive tie forwards regardless of argmax/confidence");

  const p2unit = fixtureUnits(2)[0];
  const cand = normalizeCandidate({ adrId: "adr-x", path: "/adr/x.md", version: "v1", content: candidateAdrFixture.candidate_adr.text, heading: candidateAdrFixture.candidate_adr.heading });
  const p2Boundary = fakeProvider(({ key }) => choiceAnswer(key, { positive: "consider_together", negative: "unrelated", choice: "unrelated", score: 0.4, confidence: 1 }));
  const p2Run = await compareCandidates({ stateDir: tmpStateDir(), provider: p2Boundary, units: [p2unit], candidates: [cand] });
  assert.equal(p2Run.consideredTogether.length, 1, "pass 2 forwards at exactly 0.4 too");
  const p2Below = fakeProvider(({ key }) => choiceAnswer(key, { positive: "consider_together", negative: "unrelated", choice: "consider_together", score: 0.3999, confidence: 0 }));
  const p2BelowRun = await compareCandidates({ stateDir: tmpStateDir(), provider: p2Below, units: [p2unit], candidates: [cand] });
  assert.equal(p2BelowRun.unrelated.length, 1, "pass 2 excludes below threshold");
  pass("exactly 0.4 boundary forwards and .50 positive ties forward independent of argmax/confidence for BOTH passes; below-threshold excludes");
}

// ---------------------------------------------------------------------------
// (c) Failure and validation paths: errors stay pending, never negative
// ---------------------------------------------------------------------------
{
  const unit = fixtureUnits(1)[0];
  const runWith = async (buildAnswer) => judgeSelection({ stateDir: tmpStateDir(), provider: fakeProvider(buildAnswer), units: [unit] });

  const http503 = await runWith(() => ({ ok: false, httpStatus: 503, errorType: "HTTP_ERROR", retryable: true, errorMessage: "HTTP 503: busy" }));
  assert.equal(http503.judgments[0].judgment.status, "error");
  assert.equal(http503.judgments[0].judgment.retryable, true);
  assert.equal(http503.excludedEntries.length, 0, "an API error is never a negative classification");
  assert.equal(http503.judgments[0].judgment.route, undefined);
  assert.equal(http503.counts.errors, 1);

  const http400 = await runWith(() => ({ ok: false, httpStatus: 400, errorType: "HTTP_ERROR", retryable: false, errorMessage: "HTTP 400: bad" }));
  assert.equal(http400.judgments[0].judgment.retryable, false, "explicit retryable=false for permanent client errors");

  const network = await runWith(() => ({ ok: false, errorType: "NETWORK_ERROR", retryable: true, errorMessage: "ECONNREFUSED" }));
  assert.equal(network.judgments[0].judgment.status, "error");
  const timeout = await runWith(() => ({ ok: false, errorType: "TIMEOUT", retryable: true, errorMessage: "TimeoutError" }));
  assert.equal(timeout.judgments[0].judgment.errorType, "TIMEOUT");

  const missingKey = await runWith(() => ({ ok: true, httpStatus: 200, json: { model: MODEL, answers: {} } }));
  assert.equal(missingKey.judgments[0].judgment.status, "invalid-response");
  assert.equal(missingKey.judgments[0].judgment.retryable, true);
  const missingClass = await runWith(({ key }) => ({ ok: true, httpStatus: 200, json: { model: MODEL, answers: { [key]: { type: "choice", choice: "include", probabilities: { include: 0.7 } } } } }));
  assert.equal(missingClass.judgments[0].judgment.status, "invalid-response", "a missing probability class is invalid, never filled with 0");
  assert.deepEqual(missingClass.excludedEntries, [], "no fabricated negative classification");
  const outOfRange = await runWith(({ key }) => ({ ok: true, httpStatus: 200, json: { model: MODEL, answers: { [key]: { type: "choice", choice: "include", probabilities: { include: 1.5, low_priority: -0.5 } } } } }));
  assert.equal(outOfRange.judgments[0].judgment.status, "invalid-response", "invalid ranges stay errors");
  const badType = await runWith(({ key }) => ({ ok: true, httpStatus: 200, json: { model: MODEL, answers: { [key]: { type: "scale", choice: "include", probabilities: { include: 1, low_priority: 0 } } } } }));
  assert.equal(badType.judgments[0].judgment.status, "invalid-response");
  const badChoice = await runWith(({ key }) => ({ ok: true, httpStatus: 200, json: { model: MODEL, answers: { [key]: { type: "choice", choice: "maybe", probabilities: { include: 1, low_priority: 0 } } } } }));
  assert.equal(badChoice.judgments[0].judgment.status, "invalid-response");
  const badConfidence = await runWith(({ key }) => ({ ok: true, httpStatus: 200, json: { model: MODEL, answers: { [key]: { type: "choice", choice: "include", confidence: 5, probabilities: { include: 1, low_priority: 0 } } } } }));
  assert.equal(badConfidence.judgments[0].judgment.status, "invalid-response");
  const malformedJson = await runWith(() => ({ ok: false, httpStatus: 200, errorType: "MALFORMED_JSON", retryable: true, errorMessage: "Unexpected token" }));
  assert.equal(malformedJson.judgments[0].judgment.status, "error");
  assert.equal(malformedJson.counts.errors, 1);

  // Errors and invalid responses are NEVER cached as successful judgments.
  const stateDir = tmpStateDir();
  await judgeSelection({ stateDir, provider: fakeProvider(() => ({ ok: false, httpStatus: 500, errorType: "HTTP_ERROR", retryable: true, errorMessage: "boom" })), units: [unit] });
  const identity = judgmentIdentity({ api: API, model: MODEL, state: unitsState([{ id: unit.id, heading: unit.heading, text: unit.text, context: unit.context }], 1), questions: selectQuestion({ id: unit.id }, 1) });
  assert.equal(existsSync(judgmentArtifactPath(stateDir, identity.judgmentId)), false, "a failed request never masquerades as a reusable successful judgment");
  assert.equal(readJudgmentArtifact(stateDir, identity.judgmentId).ok, false);
  pass("malformed/missing scores, classes, HTTP/network/timeout/malformed-JSON failures stay errors/pending — never negative, never cached");

  // The client seam: failure classification with bounded timeout and NO
  // automatic retries (exactly one attempt per request).
  const bodyOf = { model: MODEL, state: { units: {} }, questions: { q: { type: "choice", instructions: "i", criteria: {} } } };
  const fetchCases = [
    [async () => { throw Object.assign(new TypeError("fetch failed"), { name: "TypeError" }); }, "NETWORK_ERROR", true],
    [async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }, "TIMEOUT", true],
    [async () => ({ ok: true, status: 200, text: async () => "{not json" }), "MALFORMED_JSON", true],
    [async () => ({ ok: false, status: 500, text: async () => "server error" }), "HTTP_ERROR", true],
    [async () => ({ ok: false, status: 429, text: async () => "slow down" }), "HTTP_ERROR", true],
    [async () => ({ ok: false, status: 404, text: async () => "nope" }), "HTTP_ERROR", false],
  ];
  for (const [fetchImpl, errorType, retryable] of fetchCases) {
    const result = await systemoneRequest({ apiKey: "SECRET-KEY", model: MODEL, state: bodyOf.state, questions: bodyOf.questions, timeoutMs: 50, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.errorType, errorType);
    assert.equal(result.retryable, retryable, `${errorType} retryable=${retryable}`);
    assert.ok(!JSON.stringify(result).includes("SECRET-KEY"), "the credential never leaks into a result");
  }
  let attempts = 0;
  const okOnce = async () => {
    attempts += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: MODEL, answers: {} }) };
  };
  await systemoneRequest({ apiKey: "SECRET-KEY", model: MODEL, state: bodyOf.state, questions: bodyOf.questions, fetchImpl: okOnce });
  assert.equal(attempts, 1, "exactly one attempt per request: no automatic retries");
  const credentialed = createSystemOneProvider({ fetchImpl: okOnce, credential: { key: "SECRET-KEY", source: "test" } });
  const noCred = createSystemOneProvider({ fetchImpl: okOnce, credential: { key: null, source: "missing" } });
  assert.equal((await credentialed.request({ model: MODEL, state: bodyOf.state, questions: bodyOf.questions })).ok, true);
  assert.equal((await noCred.request({ model: MODEL, state: bodyOf.state, questions: bodyOf.questions })).errorType, "NO_CREDENTIAL");
  pass("provider seam: single bounded attempt, explicit retryable failure classes, credential never serialized");
}

// ---------------------------------------------------------------------------
// (d) Replay of the OBSERVED raw outputs + cache hit/miss + threshold-only
//     reprojection (transparency over synthetic vs real fixtures)
// ---------------------------------------------------------------------------
{
  const stateDir = tmpStateDir();
  const provider = replayProvider();
  const p1units = fixtureUnits(1);
  const run1 = await judgeSelection({ stateDir, provider, units: p1units });
  assert.equal(provider.calls.length, 6, "one isolated request per unit (paired states never co-occur)");
  assert.deepEqual(run1.judgments.map((entry) => entry.judgment.status), Array(6).fill("ok"));

  const P1_ROUTES = { de7113: "forward", "881b59": "forward", "8c7d41": "forward", "89d611": "forward", "6a8f2f": "forward", fc72cd: "excluded" };
  for (const entry of run1.judgments) {
    const label = labelsEval.labels[entry.unit.id];
    console.log(`  replay p1 ${entry.unit.id} [${label.kind}] provisional-label=${label.expected_label} positiveScore=${entry.judgment.positiveScore} argmax=${entry.judgment.modelArgmax} route=${entry.judgment.route}`);
    assert.equal(entry.judgment.route, P1_ROUTES[entry.unit.id], `${entry.unit.id} routes by the 0.4 policy over the observed score`);
    assert.equal(entry.judgment.positiveScore, entry.judgment.answer.probabilities.include, "exact response score preserved");
    assert.equal(entry.judgment.cached, false);
  }
  // The documented divergence: 89d611's provisional label is low_priority but
  // the observed tie (0.5/0.5) forwards BY POLICY — transparently, not hidden.
  const tie = run1.judgments.find((entry) => entry.unit.id === "89d611").judgment;
  assert.equal(tie.modelArgmax, "tie");
  assert.equal(tie.answer.choice, "low_priority");
  assert.equal(tie.route, "forward");
  assert.equal(labelsEval.labels["89d611"].expected_label, "low_priority");
  pass("observed raw pass-1 outputs replay to the exact policy routes (provisional labels reported but never followed)");

  // Unchanged repeats are pure cache hits (no second provider call).
  const provider2 = replayProvider();
  const run2 = await judgeSelection({ stateDir, provider: provider2, units: p1units });
  assert.equal(provider2.calls.length, 0, "identical requests replay from cache — no provider call");
  assert.ok(run2.judgments.every((entry) => entry.judgment.cached === true));
  for (const entry of run2.judgments) {
    const before = run1.judgments.find((other) => other.unit.id === entry.unit.id).judgment;
    assert.equal(entry.judgment.positiveScore, before.positiveScore);
    assert.equal(entry.judgment.route, before.route);
  }
  pass("unchanged repeats are cache hits with byte-identical raw scores");

  // Threshold-only reprojection: routes recomputed from preserved raw scores
  // without ANY provider call; the policy hash lives separately.
  const strict = { ...DEFAULT_ROUTING_POLICY, version: 2, positiveScoreMin: 0.99 };
  const reprojected = reprojectJudgment(tie, strict);
  assert.equal(reprojected.route, "excluded", "the 0.5 tie excludes under the strict policy");
  assert.equal(reprojected.positiveScore, 0.5, "the exact raw score is preserved");
  assert.notEqual(reprojected.policy.sha256, tie.policy.sha256, "routing policy version/hash is stored separately from the judgment");
  const clear = run1.judgments.find((entry) => entry.unit.id === "6a8f2f").judgment;
  assert.equal(reprojectJudgment(clear, strict).route, "forward", "0.99 clears even the strict policy");
  const errored = reprojectJudgment({ status: "error", errorType: "TIMEOUT", retryable: true }, strict);
  assert.equal(errored.status, "error");
  assert.equal(errored.route, undefined, "errors never gain a route");
  assert.equal(provider2.calls.length, 0, "reprojection called nothing");
  pass("threshold-only routing-policy change reprojects routes from preserved raw scores with zero provider calls");

  // Pass-2 replay with the synthetic candidate ADR fixture.
  const p2 = replayProvider();
  const p2units = fixtureUnits(2);
  const cand = normalizeCandidate({
    adrId: "adr-fixture",
    path: "/synthetic/candidate-adr.md",
    version: "frozen-20260922T220341Z",
    content: candidateAdrFixture.candidate_adr.text,
    heading: candidateAdrFixture.candidate_adr.heading,
  });
  const p2run = await compareCandidates({ stateDir: tmpStateDir(), provider: p2, units: p2units, candidates: [cand] });
  assert.equal(p2.calls.length, 6);
  const P2_ROUTES = { "4a52e4": "forward", f8d067: "forward", a8ed0f: "forward", ce3746: "excluded", "2dfc90": "forward", "265ff0": "excluded" };
  for (const entry of p2run.pairs) {
    const label = labelsEval.labels[entry.unit.id];
    console.log(`  replay p2 ${entry.unit.id} [${label.kind}] provisional-label=${label.expected_label} positiveScore=${entry.judgment.positiveScore} route=${entry.judgment.route}`);
    assert.equal(entry.judgment.route, P2_ROUTES[entry.unit.id]);
    assert.equal(entry.judgment.classes.positive, "consider_together");
    assert.deepEqual(entry.candidate, { adrId: "adr-fixture", path: "/synthetic/candidate-adr.md", version: "frozen-20260922T220341Z", contentSha256: cand.contentSha256 }, "candidate provenance preserved on every pair");
  }
  assert.equal(p2run.coverage.exhaustiveCandidateComparison, false);
  assert.match(p2run.coverage.note, /only the caller-supplied candidate ADRs/);
  pass("observed raw pass-2 outputs replay to the exact policy routes with candidate provenance preserved");
}

// ---------------------------------------------------------------------------
// (e) Context / model / ADR version changes are cache misses (and identical
//     pair requests dedupe)
// ---------------------------------------------------------------------------
{
  const stateDir = tmpStateDir();
  const unit = fixtureUnits(1)[0];
  const build = (score) => fakeProvider(({ key }) => choiceAnswer(key, { positive: "include", negative: "low_priority", choice: "include", score, confidence: null }));
  const first = build(0.9);
  await judgeSelection({ stateDir, provider: first, units: [unit] });
  assert.equal(first.calls.length, 1);

  const contextChanged = { ...unit, context: { prev: "A different neighboring block.", next: null } };
  const second = build(0.9);
  await judgeSelection({ stateDir, provider: second, units: [contextChanged] });
  assert.equal(second.calls.length, 1, "a context change is a cache miss (new judgment identity)");

  const modelChanged = build(0.9);
  await judgeSelection({ stateDir, provider: modelChanged, units: [unit], model: "jev-1.99.0" });
  assert.equal(modelChanged.calls.length, 1, "a model change is a cache miss");

  const optionsChanged = build(0.9);
  await judgeSelection({ stateDir, provider: optionsChanged, units: [unit], api: { ...API, version: "v2" } });
  assert.equal(optionsChanged.calls.length, 1, "an API/options change is a cache miss");

  const repeat = build(0.9);
  await judgeSelection({ stateDir, provider: repeat, units: [unit] });
  assert.equal(repeat.calls.length, 0, "and the original request still replays from cache");

  // Pass 2: identical pair/input requests dedupe; an ADR content or version
  // change (even with no declared bump) is a cache miss.
  const p2unit = fixtureUnits(2)[0];
  const candA = normalizeCandidate({ adrId: "adr-a", path: "/a.md", version: "v1", content: "ADR A content." });
  const p2provider = fakeProvider(({ key, state }) => choiceAnswer(key, { positive: "consider_together", negative: "unrelated", choice: "consider_together", score: state.candidate_adr.text === "ADR A content." ? 0.9 : 0.9, confidence: null }));
  const dupRun = await compareCandidates({ stateDir, provider: p2provider, units: [p2unit], candidates: [candA, { adrId: "adr-a", path: "/a.md", version: "v1", content: "ADR A content." }, { adrId: "adr-a", path: "/a.md", version: "v1", content: "ADR A content." }] });
  assert.equal(dupRun.duplicatesRemoved, 2, "identical pair/input requests dedupe");
  assert.equal(dupRun.counts.pairs, 1);
  assert.equal(p2provider.calls.length, 1);

  const candAVersion2 = normalizeCandidate({ adrId: "adr-a", path: "/a.md", version: "v2", content: "ADR A content." });
  await compareCandidates({ stateDir, provider: p2provider, units: [p2unit], candidates: [candAVersion2] });
  assert.equal(p2provider.calls.length, 2, "an ADR version change is a cache miss");
  const candARewritten = normalizeCandidate({ adrId: "adr-a", path: "/a.md", version: "v1", content: "ADR A rewritten content (same declared version)." });
  await compareCandidates({ stateDir, provider: p2provider, units: [p2unit], candidates: [candARewritten] });
  assert.equal(p2provider.calls.length, 3, "an ADR content change is a cache miss even with a forgotten version bump");
  await compareCandidates({ stateDir, provider: p2provider, units: [p2unit], candidates: [candAVersion2] });
  assert.equal(p2provider.calls.length, 3, "and unchanged pairs replay from cache");

  // Two ADRs with identical content+content-version but distinct provenance
  // stay distinct pairs (deterministic order) sharing ONE cached judgment.
  const twin = normalizeCandidate({ adrId: "adr-twin", path: "/twin.md", version: "v1", content: "ADR A content." });
  const twinRun = await compareCandidates({ stateDir, provider: p2provider, units: [p2unit], candidates: [candA, twin] });
  assert.equal(twinRun.counts.pairs, 2);
  assert.deepEqual(twinRun.pairs.map((entry) => entry.candidate.adrId), ["adr-a", "adr-twin"], "deterministic pair ordering with candidate provenance");
  assert.equal(p2provider.calls.length, 3, "shared content reuses the one cached judgment");
  pass("context/model/API/ADR-version/ADR-content changes are cache misses; identical pair requests dedupe; provenance stays distinct");
}

// ---------------------------------------------------------------------------
// (f) Explicit budgets: deferral is NOT a negative judgment; continuation
// ---------------------------------------------------------------------------
{
  const units = fixtureUnits(1);
  const provider = fakeProvider(({ key }) => choiceAnswer(key, { positive: "include", negative: "low_priority", choice: "include", score: 0.9, confidence: null }));
  const run = await judgeSelection({ stateDir: tmpStateDir(), provider, units, budget: { maxProviderRequests: 1 } });
  assert.equal(provider.calls.length, 1, "the provider-request budget is bounded");
  assert.equal(run.counts.ok, 1);
  assert.equal(run.counts.deferred, 5);
  assert.equal(run.counts.errors, 0);
  assert.equal(run.excludedEntries.length, 0, "deferred work is never an unrelated/low_priority judgment");
  for (const entry of run.deferredEntries) {
    assert.equal(entry.judgment.status, "deferred");
    assert.equal(entry.judgment.reason, "provider-request-budget-exhausted");
    assert.equal(entry.judgment.retryable, true);
  }
  assert.equal(run.continuation.remaining.length, 5, "the deferred remainder is carried forward explicitly");
  assert.match(run.continuation.reason, /never a negative judgment/);

  // Continuation: resume with the remaining units; identical work replays from
  // cache so no judgment is lost or duplicated.
  const resumeProvider = fakeProvider(({ key }) => choiceAnswer(key, { positive: "include", negative: "low_priority", choice: "include", score: 0.9, confidence: null }));
  const resume = await judgeSelection({ stateDir: tmpStateDir(), provider: resumeProvider, units: run.judgments.slice(1).map((entry) => units.find((unit) => unit.id === entry.unit.id)) });
  assert.equal(resume.counts.deferred, 0);
  assert.equal(resume.counts.ok, 5);

  const unitBudget = fakeProvider(({ key }) => choiceAnswer(key, { positive: "include", negative: "low_priority", choice: "include", score: 0.9, confidence: null }));
  const unitRun = await judgeSelection({ stateDir: tmpStateDir(), provider: unitBudget, units, budget: { maxUnits: 1 } });
  assert.equal(unitRun.counts.deferred, 5);
  assert.equal(unitRun.deferredEntries[0].judgment.reason, "unit-budget-exhausted");
  assert.equal(unitBudget.calls.length, 1);
  pass("explicit request/unit budgets defer work honestly (never negative) and continuations resume without loss");
}

// ---------------------------------------------------------------------------
// (g) Missing/corrupt source, report and cache honesty; no source deletion
// ---------------------------------------------------------------------------

function seedChange({ stateDir, root, executionId, phaseId = PHASE, owner = OWNER, pendingAttempt = false }) {
  mkdirSync(join(stateDir, "execution-hosts", executionId), { recursive: true });
  const requestPath = join(stateDir, "execution-hosts", executionId, "request.json");
  writeFileSync(requestPath, "{}", "utf8");
  recordManagedExecution({
    stateDir,
    executionId,
    kind: "open",
    phaseId,
    root,
    owner,
    constraints: "Immutable phase constraints: keep the module boundaries. Never touch config/.",
    launchId: `${executionId}-launch`,
    requestPath,
    now: 1,
  });
  const impl = registerRoleAttempt({ stateDir, executionId, role: "implementer", jobId: `${executionId}-impl`, attemptId: `${executionId}-impl-a1`, prompt: "Implement.", cwd: root, owner, now: 2 });
  const reviewer = registerRoleAttempt({ stateDir, executionId, role: "reviewer", jobId: `${executionId}-rev`, attemptId: `${executionId}-rev-a1`, prompt: "Review.", cwd: root, owner, now: 3 });
  const handle = openChange({ stateDir, changeId: executionId });
  handle.append("attempt.started", { identity: { seat: "implementer" } }, { context: { actor: RUNTIME, jobId: impl.jobId, attemptId: impl.attemptId }, commandId: `started-${impl.jobId}`, now: 4 });
  handle.append("attempt.started", { identity: { seat: "reviewer" } }, { context: { actor: RUNTIME, jobId: reviewer.jobId, attemptId: reviewer.attemptId }, commandId: `started-${reviewer.jobId}`, now: 5 });
  const implReport = saveReport(stateDir, {
    jobId: impl.jobId,
    role: "implementer",
    text: `# Decision\n\nWe route ADR curation after landing to avoid blocking source landing.\n\n## Trade-offs\n\nThe trade-off: architectural review lags the merge, but nothing destructive happens before evidence retention.\n\n${"x".repeat(24_000)}\n\nEND-OF-REPORT-MARKER-IMPL full text retained`,
  });
  const revReport = saveReport(stateDir, {
    jobId: reviewer.jobId,
    role: "reviewer",
    text: "# Review\n\nRoutine logistics note: the CI smoke job ran once at 12:00 and passed.\n\nVerdict: PASS with one suggestion about cache integrity.\n",
  });
  // r4: committed update NEVER acknowledged (unresolved attributed source).
  handle.append("assignment.revised",
    { revision: 4, predecessor: 3, scope: { kind: "job", jobId: impl.jobId }, assignment: { instructions: "Composed with update four." }, note: "Coordinator instruction four (unresolved): consider renaming the cache." },
    { context: { actor: RUNTIME, jobId: impl.jobId }, commandId: `revise-${impl.jobId}-r4`, now: 6 });
  handle.append("amendment.submitted",
    { amendmentId: `${executionId}-amd4`, revision: 4, note: "Coordinator instruction four (unresolved): consider renaming the cache." },
    { context: { actor: RUNTIME, jobId: impl.jobId, attemptId: impl.attemptId }, commandId: `submit-${executionId}-amd4`, now: 7 });
  // r5: committed update acknowledged by the worker.
  handle.append("assignment.revised",
    { revision: 5, predecessor: 4, scope: { kind: "job", jobId: impl.jobId }, assignment: { instructions: "Composed with update five." }, note: "Coordinator instruction five (acknowledged): keep the binary threshold at 0.4." },
    { context: { actor: RUNTIME, jobId: impl.jobId }, commandId: `revise-${impl.jobId}-r5`, now: 8 });
  handle.append("amendment.submitted",
    { amendmentId: `${executionId}-amd5`, revision: 5, note: "Coordinator instruction five (acknowledged): keep the binary threshold at 0.4." },
    { context: { actor: RUNTIME, jobId: impl.jobId, attemptId: impl.attemptId }, commandId: `submit-${executionId}-amd5`, now: 9 });
  handle.append("worker.acknowledged", { revision: 5 },
    { context: { actor: WORKER, jobId: impl.jobId, attemptId: impl.attemptId }, commandId: `ack-${impl.jobId}-r5`, now: 10 });
  recordRoleOutcome({ stateDir, executionId, role: "implementer", jobId: impl.jobId, attemptId: impl.attemptId, status: "completed", summary: "implemented", reportId: implReport.reportId, identity: { seat: "implementer" }, now: 11 });
  recordRoleOutcome({ stateDir, executionId, role: "reviewer", jobId: reviewer.jobId, attemptId: reviewer.attemptId, status: "completed", summary: "passed", reportId: revReport.reportId, identity: { seat: "reviewer" }, now: 12 });
  if (pendingAttempt) {
    // A role attempt with no outcome and no durable report (explicitly pending).
    const ops = registerRoleAttempt({ stateDir, executionId, role: "reviewer", jobId: `${executionId}-ops`, attemptId: `${executionId}-ops-a1`, prompt: "Second review seat.", cwd: root, owner, now: 13 });
    handle.append("attempt.started", { identity: { seat: "reviewer" } }, { context: { actor: RUNTIME, jobId: ops.jobId, attemptId: ops.attemptId }, commandId: `started-${ops.jobId}`, now: 14 });
  }
  return { impl, reviewer, implReport, revReport };
}

async function stageAndActivate({ stateDir, root, executionId, ticketText, phaseId = PHASE, owner = OWNER, expected }) {
  mkdirSync(root, { recursive: true });
  const ticketPath = join(root, `${phaseId}.ticket.md`);
  writeFileSync(ticketPath, ticketText, "utf8");
  const binding = expected ?? { owner, phaseId, root };
  const staged = await stageAdrSource({ stateDir, executionId, ticketPath, expected: binding, now: 20, actor: RUNTIME });
  const activated = activateCurationObligation({
    stateDir,
    executionId,
    manifestId: staged.manifestId,
    landing: { method: "ff", receipt: "f".repeat(40), headSha: "f".repeat(40) },
    expected: binding,
    now: 21,
    actor: RUNTIME,
  });
  return { staged, activated, ticketPath };
}

{
  // Missing manifest: explicit incomplete/retryable, never a classification.
  const stateDir = tmpStateDir();
  const missingSource = prepareEvidenceUnits({ stateDir, changeId: "chg-none", manifestId: "adr-src-none" });
  assert.equal(missingSource.ok, false);
  assert.equal(missingSource.status, "incomplete");
  assert.equal(missingSource.retryable, true);
  assert.equal(missingSource.units.length, 0);
  assert.match(missingSource.missing[0].reason, /missing/);
  assert.equal(missingSource.complete, false, "curation can never be finished from missing evidence");

  // Full seed, then corrupt the retained manifest blob.
  const corruptState = tmpStateDir();
  const root1 = mkdtempSync(join(tmpdir(), "adr-jev-root-"));
  const seeded1 = seedChange({ stateDir: corruptState, root: root1, executionId: "exec-g1" });
  const staged1 = await stageAndActivate({ stateDir: corruptState, root: root1, executionId: "exec-g1", ticketText: "# Ticket\n\nTicket body for corrupt-blob honesty.\n" });
  writeFileSync(adrSourcePath(corruptState, staged1.staged.manifestId), "{corrupt", "utf8");
  const corruptSource = prepareEvidenceUnits({ stateDir: corruptState, changeId: "exec-g1", manifestId: staged1.staged.manifestId });
  assert.equal(corruptSource.ok, false);
  assert.equal(corruptSource.status, "incomplete");
  assert.equal(corruptSource.retryable, true);
  assert.match(corruptSource.missing[0].reason, /corrupt|integrity/);
  assert.throws(() => readAdrSourceManifest(corruptState, staged1.staged.manifestId), /corrupt/, "the corrupt blob is honestly unreadable as a manifest");

  // Missing report artifact + pending attempt: partial units + explicit
  // incomplete coverage, and unresolved updates stay attributed non-policy.
  const stateDir2 = tmpStateDir();
  const root2 = mkdtempSync(join(tmpdir(), "adr-jev-root-"));
  const seeded2 = seedChange({ stateDir: stateDir2, root: root2, executionId: "exec-g2", pendingAttempt: true });
  const staged2 = await stageAndActivate({ stateDir: stateDir2, root: root2, executionId: "exec-g2", ticketText: "# Ticket G2\n\nSecond ticket body.\n" });
  rmSync(join(stateDir2, "reports", `${seeded2.implReport.reportId}.txt`));
  const partial = prepareEvidenceUnits({ stateDir: stateDir2, changeId: "exec-g2", manifestId: staged2.staged.manifestId });
  assert.equal(partial.complete, false);
  assert.equal(partial.status, "incomplete");
  assert.ok(partial.units.length > 0, "available sources are still segmented");
  assert.ok(partial.units.some((unit) => unit.sourceId.startsWith("ticket:")));
  assert.ok(partial.units.some((unit) => unit.sourceId.startsWith("constraints:")));
  assert.ok(partial.units.some((unit) => unit.sourceId.startsWith("update:")));
  assert.ok(partial.units.some((unit) => unit.sourceId.startsWith("report:")), "the surviving reviewer report is segmented");
  assert.ok(!partial.units.some((unit) => unit.sourceId === `report:${seeded2.implReport.reportId}`), "the missing report is never fabricated");
  const missingReport = partial.missing.find((entry) => entry.kind === "roleReport" && entry.ref.reportId === seeded2.implReport.reportId);
  assert.ok(missingReport, "the missing report reference is carried forward honestly");
  assert.equal(missingReport.retryable, true);
  assert.ok(partial.missing.some((entry) => entry.ref.reportId == null && /no recorded outcome/i.test(entry.reason)), "the pending role attempt is explicit");

  // Unresolved amendments honesty (attributed evidence, not accepted policy).
  const unresolved = partial.units.find((unit) => unit.ref.kind === "update" && unit.ref.revision === 4);
  const acknowledged = partial.units.find((unit) => unit.ref.kind === "update" && unit.ref.revision === 5);
  assert.equal(unresolved.ref.resolution, "unresolved");
  assert.equal(unresolved.ref.acceptedPolicy, false, "unresolved material is attributed source, never accepted policy");
  assert.ok(unresolved.text.includes("Coordinator instruction four (unresolved)"), "the verbatim instruction text, no paraphrase");
  assert.equal(acknowledged.ref.resolution, "acknowledged");
  assert.equal(acknowledged.ref.acceptedPolicy, true);
  assert.equal(acknowledged.ref.acknowledgement.attemptId, seeded2.impl.attemptId);
  assert.equal(acknowledged.ref.outcome.status, "completed", "outcome attribution from the authoritative record");

  // Corrupt cache: reported cleanly and recovered from a real response.
  const p1 = partial.units.filter((unit) => unit.sourceId.startsWith("ticket:"));
  const providerA = fakeProvider(({ key }) => choiceAnswer(key, { positive: "include", negative: "low_priority", choice: "include", score: 0.7, confidence: null }));
  const runA = await judgeSelection({ stateDir: stateDir2, provider: providerA, units: p1, provenance: { changeId: "exec-g2", manifestId: staged2.staged.manifestId } });
  assert.equal(providerA.calls.length, p1.length);
  const artifactPath = judgmentArtifactPath(stateDir2, runA.judgments[0].judgment.judgmentId);
  writeFileSync(artifactPath, "not-json", "utf8");
  const providerB = fakeProvider(({ key }) => choiceAnswer(key, { positive: "include", negative: "low_priority", choice: "include", score: 0.7, confidence: null }));
  const runB = await judgeSelection({ stateDir: stateDir2, provider: providerB, units: p1, provenance: { changeId: "exec-g2", manifestId: staged2.staged.manifestId } });
  assert.equal(runB.cacheIssues.length, 1, "the corrupt cache artifact is reported");
  assert.match(runB.cacheIssues[0].reason, /corrupt/);
  assert.equal(providerB.calls.length, 1, "recovery re-requests exactly the corrupt entry");
  assert.equal(runB.judgments[0].judgment.positiveScore, 0.7, "the recovered score comes from the real response — never fabricated");
  assert.equal(readJudgmentArtifact(stateDir2, runB.judgments[0].judgment.judgmentId).ok, true);

  // No source deletion: retained source artifacts are byte-identical after
  // judgment processing.
  const blobBefore = readFileSync(adrSourcePath(stateDir2, staged2.staged.manifestId));
  const revReportBefore = readFileSync(join(stateDir2, "reports", `${seeded2.revReport.reportId}.txt`));
  await judgeSelection({ stateDir: stateDir2, provider: fakeProvider(({ key }) => choiceAnswer(key, { positive: "include", negative: "low_priority", choice: "low_priority", score: 0.1, confidence: null })), units: p1 });
  assert.deepEqual(readFileSync(adrSourcePath(stateDir2, staged2.staged.manifestId)), blobBefore, "retained source blobs are never touched");
  assert.deepEqual(readFileSync(join(stateDir2, "reports", `${seeded2.revReport.reportId}.txt`)), revReportBefore, "retained reports are never deleted or rewritten");
  pass("missing/corrupt source, report and cache are reported honestly; unresolved amendments stay attributed non-policy; no source is ever deleted");
}

// ---------------------------------------------------------------------------
// (g2) Manifest/owner/phase confusion is refused
// ---------------------------------------------------------------------------
{
  const stateDir = tmpStateDir();
  const rootA = mkdtempSync(join(tmpdir(), "adr-jev-root-"));
  seedChange({ stateDir, root: rootA, executionId: "exec-h1" });
  const stagedA = await stageAndActivate({ stateDir, root: rootA, executionId: "exec-h1", ticketText: "# Ticket H1\n\nFirst.\n" });
  const rootB = mkdtempSync(join(tmpdir(), "adr-jev-root-"));
  seedChange({ stateDir, root: rootB, executionId: "exec-h2", phaseId: "phasejev0002-cccc-4ccc-8ccc-cccccccccccc", owner: "coordinator-jev-2" });
  const stagedB = await stageAndActivate({
    stateDir,
    root: rootB,
    executionId: "exec-h2",
    ticketText: "# Ticket H2\n\nSecond.\n",
    phaseId: "phasejev0002-cccc-4ccc-8ccc-cccccccccccc",
    owner: "coordinator-jev-2",
  });

  assert.throws(() => prepareEvidenceUnits({ stateDir, changeId: "exec-h2", manifestId: stagedA.staged.manifestId }), /belongs to change/, "manifest/change confusion is refused");
  assert.throws(
    () => prepareEvidenceUnits({ stateDir, changeId: "exec-h1", manifestId: stagedA.staged.manifestId, expected: { owner: "coordinator-jev-2" } }),
    /does not match/,
    "foreign owner is refused",
  );
  assert.throws(
    () => prepareEvidenceUnits({ stateDir, changeId: "exec-h2", manifestId: stagedB.staged.manifestId, expected: { owner: "coordinator-jev-2", phaseId: PHASE } }),
    /does not match/,
    "foreign phase identity is refused",
  );
  assert.throws(
    () => prepareEvidenceUnits({ stateDir, changeId: "exec-h1", manifestId: stagedA.staged.manifestId, expected: { owner: OWNER, phaseId: PHASE, root: rootB } }),
    /does not match/,
    "foreign project root is refused",
  );
  // Binding that matches exactly still prepares.
  const ok = prepareEvidenceUnits({ stateDir, changeId: "exec-h1", manifestId: stagedA.staged.manifestId, expected: { owner: OWNER, phaseId: PHASE, root: rootA } });
  assert.equal(ok.status, "prepared");
  // Untrusted candidate paths are never opened (provenance labels only) and
  // candidate content is model data with strict version validation.
  assert.throws(() => normalizeCandidate({ adrId: "adr-1", path: "/nope.md", content: "text" }), /explicit content version/);
  assert.throws(() => normalizeCandidate({ adrId: "adr-1", path: "/nope.md", version: "v1", content: "text", contentSha256: "0".repeat(64) }), /does not match its declared contentSha256/);
  const label = normalizeCandidate({ adrId: "adr-1", path: "/definitely/not/there.md", version: "v1", content: "exact content" });
  assert.equal(label.path, "/definitely/not/there.md");
  assert.equal(label.contentSha256, hashText("exact content"));
  pass("manifest/owner/phase/root confusion is refused; untrusted paths are provenance labels only; candidate versions are validated");
}

// ---------------------------------------------------------------------------
// (h) End-to-end: phase-1 manifest -> pass 1 -> supplied ADRs -> pass 2 ->
//     result packet, obligation untouched
// ---------------------------------------------------------------------------
{
  const parent = mkdtempSync(join(tmpdir(), "adr-jev-e2e-"));
  const stateDir = join(parent, "state");
  const root = join(parent, "repo-root");
  mkdirSync(root, { recursive: true });
  const ticketText = "# Phase ticket\n\nExact ticket for the e2e pipeline.\n\n## Constraint\n\nKeep judgments binary and attributable.\n";
  const seeded = seedChange({ stateDir, root, executionId: "exec-e2e", pendingAttempt: false });
  const staged = await stageAndActivate({ stateDir, root, executionId: "exec-e2e", ticketText });
  const rootFilesBefore = readdirSync(root);

  // The exact landed phase-1 read surface.
  const obligations = listCurationObligations({ stateDir, changeId: "exec-e2e" });
  assert.equal(obligations.processingStatus, "pending");
  const manifestId = obligations.obligations[0].manifestId;
  assert.equal(manifestId, staged.staged.manifestId);

  const prepared = prepareEvidenceUnits({ stateDir, changeId: "exec-e2e", manifestId, expected: { owner: OWNER, phaseId: PHASE, root } });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.complete, true, "all required references retained");
  assert.ok(prepared.units.some((unit) => unit.sourceId.startsWith("ticket:")));
  assert.ok(prepared.units.some((unit) => unit.sourceId.startsWith("constraints:")));
  assert.ok(prepared.units.some((unit) => unit.sourceId.startsWith(`report:${seeded.implReport.reportId}`)));
  // The 24k-char report is read to FULL length through the report API (chunk
  // assembly) — no silent truncation anywhere.
  const implUnits = prepared.units.filter((unit) => unit.sourceId === `report:${seeded.implReport.reportId}`);
  assert.ok(implUnits.some((unit) => unit.text.includes("END-OF-REPORT-MARKER-IMPL")), "the tail of the long report is retained");
  assert.ok(implUnits.some((unit) => unit.text === "We route ADR curation after landing to avoid blocking source landing."), "verbatim paragraph units");
  assert.ok(implUnits.every((unit) => unit.ref.role === "implementer" && unit.ref.reportId === seeded.implReport.reportId), "attribution reaches every unit");
  assert.ok(!JSON.stringify(prepared.sources).includes("auth"), "no credential material anywhere");

  // Pass 1: routine logistics goes low_priority, decision evidence forwards.
  const p1provider = fakeProvider(({ key, state }) => {
    const text = Object.values(state.units)[0].text;
    const routine = /Routine logistics note/.test(text);
    return choiceAnswer(key, { positive: "include", negative: "low_priority", choice: routine ? "low_priority" : "include", score: routine ? 0.1 : 0.9, confidence: null });
  });
  const selection = await judgeSelection({ stateDir, provider: p1provider, units: prepared.units, provenance: { changeId: "exec-e2e", manifestId, owner: OWNER, phaseId: PHASE } });
  assert.equal(selection.counts.errors, 0);
  assert.equal(selection.counts.deferred, 0);
  assert.equal(selection.counts.ok, prepared.units.length);
  assert.ok(selection.forwardEntries.length >= 5, "decision evidence and the unresolved proposal both forward");
  assert.ok(selection.forwardEntries.some((entry) => entry.unit.ref.kind === "update" && entry.unit.ref.acceptedPolicy === false), "proposals/unresolved material still forward (selection is not acceptance)");
  assert.equal(selection.excludedEntries.length, 1, "exactly the routine logistics paragraph is excluded from the view");
  assert.equal(selection.excludedEntries[0].unit.ref.role, "reviewer");

  // Pass 2 with TWO caller-supplied versioned candidate ADRs.
  const adrA = normalizeCandidate({ adrId: "adr-landing-order", path: "docs/adr-0001-landing-order.md", version: "sha-aaaa", content: "Decision: curate ADR evidence AFTER landing; landing must never block on curation.", heading: "ADR 0001: landing order" });
  const adrB = normalizeCandidate({ adrId: "adr-unrelated-vpn", path: "docs/adr-0009-vpn.md", version: "sha-bbbb", content: "Decision: route office traffic over the new VPN concentrator.", heading: "ADR 0009: VPN" });
  const p2provider = fakeProvider(({ key, state }) => {
    const related = state.candidate_adr.text.startsWith("Decision: curate ADR evidence AFTER landing");
    const onTopic = /curation|landing|threshold|cache/.test(Object.values(state.units)[0].text);
    const score = related && onTopic ? 0.85 : 0.15;
    return choiceAnswer(key, { positive: "consider_together", negative: "unrelated", choice: score >= 0.4 ? "consider_together" : "unrelated", score, confidence: null });
  });
  const comparison = await compareCandidates({
    stateDir,
    provider: p2provider,
    units: prepared.units.filter((unit) => selection.forwardEntries.some((entry) => entry.unit.id === unit.id)),
    candidates: [adrA, adrB],
    provenance: { changeId: "exec-e2e", manifestId, owner: OWNER, phaseId: PHASE },
  });
  assert.equal(comparison.counts.pairs, selection.forwardEntries.length * 2);
  assert.equal(comparison.counts.errors, 0);
  assert.equal(comparison.counts.deferred, 0);
  assert.ok(comparison.consideredTogether.every((entry) => entry.candidate.adrId === "adr-landing-order"), "shared vocabulary alone never pairs the VPN ADR");
  assert.ok(comparison.consideredTogether.length > 0);
  assert.ok(comparison.unrelated.length > 0);
  assert.equal(comparison.coverage.candidatesSupplied, 2);
  assert.equal(comparison.coverage.exhaustiveCandidateComparison, false, "incomplete candidate coverage is never described as all existing ADRs");

  // Zero candidates is valid and honest.
  const none = await compareCandidates({ stateDir, provider: fakeProvider(() => { throw new Error("must not be called"); }), units: prepared.units, candidates: [] });
  assert.equal(none.counts.pairs, 0);
  assert.equal(none.coverage.candidatesSupplied, 0);
  assert.equal(none.ok, true, "zero candidates is a valid input, not an error");

  // The compact attributable result packet.
  const packet = buildResultPacket({
    changeId: "exec-e2e",
    manifestId,
    operationId: obligations.obligations[0].operationId,
    prepared,
    selection,
    comparison,
  });
  assert.equal(packet.owner, OWNER);
  assert.equal(packet.phaseId, PHASE);
  assert.equal(packet.identity.questions.version, "adr-jev-questions-1/frozen-20260922T220341Z");
  assert.equal(packet.identity.routingPolicy.positiveScoreMin, 0.4);
  assert.equal(packet.identity.model.model, MODEL);
  // Selected evidence is VERBATIM with exact spans; excluded material is
  // referenceable but carries no duplicate prose store.
  for (const entry of packet.evidence.selected) {
    assert.equal(typeof entry.text, "string");
    assert.equal(hashText(entry.text), entry.unit.textSha256);
  }
  assert.ok(packet.evidence.selected.some((entry) => entry.text.includes("END-OF-REPORT-MARKER-IMPL")));
  assert.ok(packet.evidence.lowPriority.length === 1);
  assert.equal(packet.evidence.lowPriority[0].text, undefined, "low_priority source is inspectable by reference + scores, not duplicated prose");
  assert.equal(packet.evidence.lowPriority[0].judgment.positiveScore, 0.1);
  assert.ok(packet.candidatePairs.consideredTogether.every((entry) => entry.candidate.adrId === "adr-landing-order" && entry.candidate.version === "sha-aaaa"));
  assert.ok(packet.candidatePairs.unrelated.some((entry) => entry.candidate.contentSha256 === adrB.contentSha256 && entry.candidate.adrId === "adr-unrelated-vpn" && entry.candidate.version === "sha-bbbb"), "rejected pairs stay inspectable via candidate provenance + preserved scores");
  assert.equal(packet.coverage.evidenceComplete, true);
  assert.equal(packet.coverage.exhaustiveCandidateComparison, false);
  assert.equal(packet.coverage.curationObligation, "pending (untouched by this processing)");
  assert.equal(packet.counts.evidence.ok, prepared.units.length);
  assert.equal(packet.counts.candidatePairs.pairs, selection.forwardEntries.length * 2);
  const allJudgments = [...packet.evidence.selected.map((entry) => entry.judgment), ...packet.evidence.lowPriority.map((entry) => entry.judgment)];
  assert.ok(allJudgments.every((judgment) => typeof judgment.positiveScore === "number" && judgment.route), "exact scores + actual route preserved separately");
  assert.ok(packet.notes.some((note) => /NOT Architect approval/.test(note)));

  // Persist + read back the packet (idempotent, integrity-checked).
  const written = writeResultPacket(stateDir, packet);
  assert.equal(written.dedupe, false);
  const readBack = readResultPacket(stateDir, packet.packetId);
  assert.equal(readBack.ok, true);
  assert.deepEqual(readBack.entry.evidence.selected.map((entry) => entry.unit.id), packet.evidence.selected.map((entry) => entry.unit.id));
  const rewritten = writeResultPacket(stateDir, buildResultPacket({ changeId: "exec-e2e", manifestId, operationId: obligations.obligations[0].operationId, prepared, selection, comparison }));
  assert.equal(rewritten.dedupe, true, "repeated identical processing is idempotent");

  // The pending obligation stays pending: processing is not approval, not
  // publication, not obligation completion.
  const after = listCurationObligations({ stateDir, changeId: "exec-e2e" });
  assert.equal(after.obligations[0].status, "pending");
  assert.equal(after.processingStatus, "pending");

  // No source deletion + no cache/source artifacts outside the subordinate
  // state dir (nothing in the project root, nothing indexed).
  assert.doesNotThrow(() => readAdrSourceManifest(stateDir, manifestId), "the retained source manifest survives processing intact");
  assert.deepEqual(readdirSync(root), rootFilesBefore, "the project root gains no cache/source/index artifacts");
  const stray = readdirSync(parent).filter((name) => name !== "state" && name !== "repo-root");
  assert.deepEqual(stray, [], "every artifact lives under the state dir");
  assert.ok(!existsSync(join(root, "adr-jev")) && !existsSync(join(root, "adr-sources")), "no cache/source artifacts in any index-like location");
  assert.ok(readdirSync(join(stateDir, "adr-jev", "judgments")).length > 0);
  assert.ok(readdirSync(join(stateDir, "adr-jev", "packets")).length === 1);
  pass("end-to-end manifest -> pass1 -> supplied ADRs -> pass2 -> result packet via landed phase-1 APIs; obligation untouched, nothing indexed");

  // Concurrent identical end-to-end processing is idempotent.
  const [c1, c2] = await Promise.all([
    judgeSelection({ stateDir, provider: fakeProvider(({ key }) => choiceAnswer(key, { positive: "include", negative: "low_priority", choice: "include", score: 0.9, confidence: null })), units: prepared.units }),
    judgeSelection({ stateDir, provider: fakeProvider(({ key }) => choiceAnswer(key, { positive: "include", negative: "low_priority", choice: "include", score: 0.9, confidence: null })), units: prepared.units }),
  ]);
  assert.equal(c1.counts.ok, c2.counts.ok);
  assert.deepEqual(c1.judgments.map((entry) => entry.judgment.route), c2.judgments.map((entry) => entry.judgment.route));
  pass("concurrent identical processing replays idempotently to identical routes");
}
