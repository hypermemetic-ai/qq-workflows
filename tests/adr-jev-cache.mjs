#!/usr/bin/env node
// Deterministic proof of the content-addressed raw judgment cache and the
// result-packet artifact store. Local temporary state dirs only: no provider,
// no network, no worker, no ADR index anywhere.
//
// Covers: (a) judgment identity keys on the EXACT model/state/questions/options
// + API version/parameters — any meaningful wording/options/state/context/
// model/ADR-content change invalidates reuse even without a version bump;
// (b) permission + hash integrity (0700 dirs, 0600 files) and artifacts
// outside any ADR index; (c) only successful validated responses are ever
// cached (errors never masquerade as reusable judgments); (d) immutable
// historical results: identical writes dedupe, divergent writes preserve the
// first judgment and are reported; (e) corrupt cache reported cleanly and
// recovered without fabricated scores; (f) concurrent identical writes are
// idempotent; (g) result packets are content-addressed, rebuild-idempotent and
// integrity-checked.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  adrJevDir,
  judgmentArtifactPath,
  judgmentIdentity,
  readJudgmentArtifact,
  readResultPacket,
  resultPacketId,
  writeJudgmentArtifact,
  writeResultPacket,
} from "../workflow/adr-jev-cache.mjs";
import { questionKey, selectQuestion, unitsState } from "../workflow/adr-jev-questions.mjs";

const pass = (message) => console.log(`PASS ${message}`);
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "fixtures", "adr-jev");

const API = { name: "systemone", version: "v1", endpoint: "https://api.typesafe.ai/v1/systemone" };
const MODEL = "jev-1.13.0";

function fixtureRequest(unitId, passNo, { mutate = null } = {}) {
  const passages = JSON.parse(readFileSync(join(FIXTURES, "passages.json"), "utf8"));
  const candidate = JSON.parse(readFileSync(join(FIXTURES, "candidate-adr.json"), "utf8"));
  const state = passages.states.find((entry) => entry.id === unitId);
  const unitLike = { id: state.id, heading: state.heading, text: state.text, context: state.context };
  const request = {
    model: MODEL,
    state: unitsState([unitLike], passNo, passNo === 2 ? candidate.candidate_adr : undefined),
    questions: selectQuestion(unitLike, passNo),
  };
  return mutate ? mutate(request) : request;
}

function tmpState() {
  return mkdtempSync(join(tmpdir(), "adr-jev-cache-state-"));
}

function okResult(score = 0.9) {
  return { answers: { q: { type: "choice", choice: "include", confidence: score, probabilities: { include: score, low_priority: 1 - score } } }, model: MODEL, usage: { input_tokens: 1, output_tokens: 1 } };
}

// ---------------------------------------------------------------------------
// (a) Judgment identity is exact-content-addressed
// ---------------------------------------------------------------------------
const baseRequest = fixtureRequest("de7113", 1);
const baseIdentity = judgmentIdentity({ api: API, model: baseRequest.model, state: baseRequest.state, questions: baseRequest.questions });
{
  assert.deepEqual(judgmentIdentity({ api: API, model: baseRequest.model, state: baseRequest.state, questions: baseRequest.questions }), baseIdentity, "identical requests share one identity");
  assert.match(baseIdentity.judgmentId, /^jevj-[0-9a-f]{32}$/);
  assert.match(baseIdentity.requestSha256, /^[0-9a-f]{64}$/);
  assert.match(baseIdentity.identitySha256, /^[0-9a-f]{64}$/);
  assert.equal(baseIdentity.scope, null);

  const vary = (label, mutate) => {
    const request = fixtureRequest("de7113", 1, { mutate });
    const identity = judgmentIdentity({ api: API, model: request.model, state: request.state, questions: request.questions });
    assert.notEqual(identity.judgmentId, baseIdentity.judgmentId, `${label} must change the judgment identity`);
  };
  vary("question wording change", (request) => {
    const key = questionKey("de7113");
    request.questions[key].instructions = `${request.questions[key].instructions} (tweaked)`;
    return request;
  });
  vary("question OPTIONS change", (request) => {
    request.questions[questionKey("de7113")].criteria.include = "rewritten criteria";
    return request;
  });
  vary("unit context change", (request) => {
    request.state.units.de7113.context = { prev: "different neighbor", next: null };
    return request;
  });
  vary("unit text change", (request) => {
    request.state.units.de7113.text = "Different text entirely.";
    return request;
  });
  vary("model change", (request) => {
    request.model = "jev-1.14.0";
    return request;
  });
  const apiVary = judgmentIdentity({ api: { ...API, version: "v2" }, model: baseRequest.model, state: baseRequest.state, questions: baseRequest.questions });
  assert.notEqual(apiVary.judgmentId, baseIdentity.judgmentId, "API version change must change the judgment identity");
  const endpointVary = judgmentIdentity({ api: { ...API, endpoint: "https://other.example/v1/systemone" }, model: baseRequest.model, state: baseRequest.state, questions: baseRequest.questions });
  assert.notEqual(endpointVary.judgmentId, baseIdentity.judgmentId, "endpoint change must change the judgment identity");
  const scopeVary = judgmentIdentity({ api: API, model: baseRequest.model, state: baseRequest.state, questions: baseRequest.questions, scope: { candidate: { version: "v2", contentSha256: "a".repeat(64) } } });
  assert.notEqual(scopeVary.judgmentId, baseIdentity.judgmentId, "a candidate ADR content-version change must change the judgment identity");
  // Version-blind by construction: the vary() cases above changed wording/
  // content while questionsIdentity().version stayed untouched — identity is
  // content-addressed, so a "forgotten version bump" still invalidates reuse.
  // Pass-2 ADR candidate content is part of the request state: an ADR content
  // change (even with an unchanged declared version string) is a cache miss.
  const p2base = fixtureRequest("4a52e4", 2);
  const p2id = judgmentIdentity({ api: API, model: p2base.model, state: p2base.state, questions: p2base.questions });
  const p2changed = fixtureRequest("4a52e4", 2, { mutate: (request) => {
    request.state.candidate_adr.text = "Rewritten ADR content, same declared version.";
    return request;
  } });
  const p2changedId = judgmentIdentity({ api: API, model: p2changed.model, state: p2changed.state, questions: p2changed.questions });
  assert.notEqual(p2changedId.judgmentId, p2id.judgmentId, "ADR content change must change the judgment identity");
  pass("judgment identity covers exact model/state/questions/options/api — wording, options, context, model and ADR content changes all invalidate reuse");
}

// ---------------------------------------------------------------------------
// (b)+(c)+(d)+(e)+(f) Artifact lifecycle
// ---------------------------------------------------------------------------
{
  const stateDir = tmpState();
  const result = okResult();
  const written = writeJudgmentArtifact(stateDir, { identity: baseIdentity, provenance: { changeId: "chg-1", pass: 1 }, result });
  assert.equal(written.dedupe, false);
  const path = judgmentArtifactPath(stateDir, baseIdentity.judgmentId);
  assert.ok(existsSync(path));
  assert.equal(statSync(path).mode & 0o777, 0o600, "judgment artifacts are 0600");
  assert.equal(statSync(adrJevDir(stateDir)).mode & 0o777, 0o700, "the adr-jev artifact root is 0700");
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);

  // (b) no artifact is ever outside stateDir/adr-jev (outside any ADR index).
  assert.ok(path.startsWith(join(stateDir, "adr-jev") + "/"));
  const serialized = readFileSync(path, "utf8");
  assert.ok(!/Bearer |api[_-]?key|authorization/i.test(serialized), "no credential material in cached artifacts");
  pass("judgment artifacts are permission/hash-integrity protected, credential-free and live under stateDir/adr-jev (outside any ADR index)");

  // Round trip + integrity verification.
  const readBack = readJudgmentArtifact(stateDir, baseIdentity.judgmentId);
  assert.equal(readBack.ok, true);
  assert.equal(readBack.entry.identity.requestSha256, baseIdentity.requestSha256);
  assert.deepEqual(readBack.entry.result.answers, result.answers, "the exact raw response scores are preserved");
  assert.deepEqual(readBack.entry.provenance, { changeId: "chg-1", pass: 1 });

  // (d) identical rewrite dedupes (idempotent), divergent response reports and
  // preserves the FIRST successful judgment (immutable historical results).
  const again = writeJudgmentArtifact(stateDir, { identity: baseIdentity, provenance: { changeId: "chg-1", pass: 1 }, result });
  assert.equal(again.dedupe, true);
  assert.equal(again.divergent, false);
  const divergent = writeJudgmentArtifact(stateDir, { identity: baseIdentity, provenance: { changeId: "chg-1", pass: 1 }, result: okResult(0.2) });
  assert.equal(divergent.divergent, true, "a divergent concurrent response is reported, never silently swapped");
  assert.deepEqual(readJudgmentArtifact(stateDir, baseIdentity.judgmentId).entry.result.answers, result.answers, "the first successful judgment is preserved unchanged");
  pass("identical writes dedupe; divergent writes keep the first judgment and report the divergence");

  // (f) concurrent identical writes are idempotent and never corrupt.
  const stateDir2 = tmpState();
  const identity2 = judgmentIdentity({ api: API, model: baseRequest.model, state: baseRequest.state, questions: baseRequest.questions });
  const writes = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve().then(() => writeJudgmentArtifact(stateDir2, { identity: identity2, provenance: { changeId: "chg-2" }, result }))));
  const read2 = readJudgmentArtifact(stateDir2, identity2.judgmentId);
  assert.equal(read2.ok, true, "concurrent identical writes leave one valid artifact");
  assert.ok(writes.every((entry) => entry.ok));
  assert.ok(writes.filter((entry) => entry.dedupe).length >= 1, "at least one writer observed the dedupe");
  assert.equal(readdirSync(dirname(judgmentArtifactPath(stateDir2, identity2.judgmentId))).length, 1, "exactly one artifact file");
  pass("concurrent identical cache writes are idempotent (one artifact, valid integrity)");

  // (c) errors never masquerade as reusable successful judgments.
  assert.throws(
    () => writeJudgmentArtifact(stateDir, { identity: baseIdentity, result: { errorType: "HTTP_ERROR" } }),
    /successful raw provider response/,
    "error results can never be cached",
  );
  assert.throws(
    () => writeJudgmentArtifact(stateDir, { identity: baseIdentity, result: { answers: null } }),
    /successful raw provider response/,
  );
  pass("only successful validated responses are cacheable; errors can never masquerade as reusable judgments");

  // (e) corrupt cache reported cleanly; recovery rewrites from a real response
  // without fabricating scores.
  writeFileSync(path, `${serialized.slice(0, 40)}CORRUPTED`, "utf8");
  const corrupt = readJudgmentArtifact(stateDir, baseIdentity.judgmentId);
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.corrupt, true);
  assert.match(corrupt.reason, /corrupt/);
  const repaired = writeJudgmentArtifact(stateDir, { identity: baseIdentity, provenance: { changeId: "chg-1", pass: 1 }, result });
  assert.equal(repaired.repairedCorrupt, true, "a corrupt artifact is cleanly replaced from a real response");
  assert.equal(readJudgmentArtifact(stateDir, baseIdentity.judgmentId).ok, true);
  // Missing artifact: honest miss, never a fabricated judgment.
  const missing = readJudgmentArtifact(stateDir, "jevj-ffffffffffffffffffffffffffffffff");
  assert.equal(missing.ok, false);
  assert.equal(missing.entry, undefined);
  pass("corrupt cache artifacts are reported and recoverable without fabricating scores");
}

// ---------------------------------------------------------------------------
// (g) Result packets: content-addressed, rebuild-idempotent, integrity-checked
// ---------------------------------------------------------------------------
{
  const stateDir = tmpState();
  const packet = {
    packetId: null,
    createdAt: 111,
    changeId: "chg-1",
    manifestId: "adr-src-1",
    evidence: { selected: [], lowPriority: [] },
    notes: ["note"],
  };
  packet.packetId = resultPacketId(packet);
  const rebuilt = { ...packet, createdAt: 999 };
  rebuilt.packetId = resultPacketId(rebuilt);
  assert.equal(rebuilt.packetId, packet.packetId, "packet identity excludes createdAt (rebuild-idempotent)");
  const other = { ...packet, evidence: { selected: [{ x: 1 }], lowPriority: [] } };
  assert.notEqual(resultPacketId(other), packet.packetId, "packet identity is content-addressed");

  const written = writeResultPacket(stateDir, packet);
  assert.equal(written.dedupe, false);
  const again = writeResultPacket(stateDir, { ...packet, createdAt: 999 });
  assert.equal(again.dedupe, true, "a rebuilt identical packet dedupes to one artifact");
  const readBack = readResultPacket(stateDir, packet.packetId);
  assert.equal(readBack.ok, true);
  assert.equal(readBack.entry.changeId, "chg-1");
  assert.equal(statSync(join(stateDir, "adr-jev", "packets", `${packet.packetId}.json`)).mode & 0o777, 0o600);
  assert.throws(() => writeResultPacket(stateDir, { ...packet, packetId: "jevpkt-wrong" }), /does not match its content-addressed id/);
  const missing = readResultPacket(stateDir, "jevpkt-ffffffffffffffffffffffffffffffff");
  assert.equal(missing.ok, false);
  // Tamper -> corrupt reported.
  const path = join(stateDir, "adr-jev", "packets", `${packet.packetId}.json`);
  writeFileSync(path, readFileSync(path, "utf8").replace("chg-1", "chg-2"), "utf8");
  const tampered = readResultPacket(stateDir, packet.packetId);
  assert.equal(tampered.ok, false);
  assert.equal(tampered.corrupt, true);
  pass("result packets are content-addressed, immutable, rebuild-idempotent and integrity-checked");
}

// A tiny artifact-root sanity: nothing ever lands in a repo-like location.
{
  const stateDir = tmpState();
  mkdirSync(join(stateDir, "adr-jev"), { recursive: true });
  assert.ok(adrJevDir(stateDir).includes("adr-jev"));
  assert.ok(!adrJevDir(stateDir).includes(".architect"));
  pass("artifact roots stay subordinate operational state (never repo/ADR-index locations)");
}
