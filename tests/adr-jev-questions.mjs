#!/usr/bin/env node
// Deterministic proof that the ONE production question source byte-matches the
// frozen binary experiment artifacts and reproduces the frozen initial
// question/state (request) artifacts exactly. Pure local fixture work: no
// provider, no network, no worker anywhere.
//
// Covers: (a) byte-identical pass-1/pass-2 question wording via the same
// unit_id substitution for every frozen call; (b) byte-identical model-facing
// state + full request bodies (model/state/questions) reconstructed from the
// frozen passages/candidate fixtures; (c) exactly two binary templates and the
// frozen option sets; (d) question identity (version + content hash) is stable
// and content-sensitive.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PASS1_NEGATIVE,
  PASS1_POSITIVE,
  PASS2_NEGATIVE,
  PASS2_POSITIVE,
  passClasses,
  questionKey,
  questionsIdentity,
  selectQuestion,
  unitsState,
} from "../workflow/adr-jev-questions.mjs";

const pass = (message) => console.log(`PASS ${message}`);
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "fixtures", "adr-jev");
const frozen = JSON.parse(readFileSync(join(FIXTURES, "questions-frozen.json"), "utf8"));
const passages = JSON.parse(readFileSync(join(FIXTURES, "passages.json"), "utf8"));
const candidate = JSON.parse(readFileSync(join(FIXTURES, "candidate-adr.json"), "utf8"));

// ---------------------------------------------------------------------------
// (a) Frozen question wording byte-match (same unit_id substitution)
// ---------------------------------------------------------------------------
{
  const callIds = Object.keys(frozen.calls);
  assert.equal(callIds.length, 12, "the frozen artifact covers 12 binary calls");
  for (const callId of callIds) {
    const call = frozen.calls[callId];
    const generated = selectQuestion({ id: call.unit_id }, call.pass);
    assert.equal(
      JSON.stringify(generated, null, 2),
      JSON.stringify(call.question, null, 2),
      `${callId}: generated question must byte-match the frozen artifact`,
    );
    // The target unit id is named in the INSTRUCTIONS, not only the key.
    const entry = generated[questionKey(call.unit_id)];
    assert.ok(entry.instructions.includes(`unit_id is "${call.unit_id}"`), `${callId}: instructions name the target unit_id`);
    assert.ok(entry.instructions.includes(`Consider only unit "${call.unit_id}"`) || entry.instructions.includes(`only unit "${call.unit_id}"`));
  }
  pass(`pass-1/pass-2 question wording byte-matches the frozen artifact for all ${callIds.length} calls`);
}

// ---------------------------------------------------------------------------
// (b) Frozen initial state + full request artifacts reproduced byte-exactly
//     (attribution/provenance is STRIPPED from model input by unitsState)
// ---------------------------------------------------------------------------
{
  const model = "jev-1.13.0";
  for (const callId of Object.keys(frozen.calls)) {
    const call = frozen.calls[callId];
    const state = passages.states.find((entry) => entry.id === call.unit_id);
    assert.ok(state, `${callId}: fixture state exists`);
    assert.equal(state.pass, call.pass);
    // Provenance never reaches the model request.
    assert.ok(state.source, `${callId}: fixture carries attribution provenance`);
    const unitLike = { id: state.id, heading: state.heading, text: state.text, context: state.context };
    const request = {
      model,
      state: unitsState([unitLike], call.pass, call.pass === 2 ? candidate.candidate_adr : undefined),
      questions: selectQuestion(unitLike, call.pass),
    };
    const rawRequest = readFileSync(join(FIXTURES, "raw", callId, "request.json"), "utf8");
    assert.equal(JSON.stringify(request, null, 2), rawRequest, `${callId}: reconstructed request body must byte-match the observed raw request`);
    assert.ok(!rawRequest.includes('"source"'), `${callId}: no provenance/source field in the model request`);
  }
  pass("frozen initial state/question request artifacts reproduced byte-exactly from the production builders");
}

// ---------------------------------------------------------------------------
// (c) Exactly two binary templates with the frozen option sets
// ---------------------------------------------------------------------------
{
  assert.equal(PASS1_POSITIVE, "include");
  assert.equal(PASS1_NEGATIVE, "low_priority");
  assert.equal(PASS2_POSITIVE, "consider_together");
  assert.equal(PASS2_NEGATIVE, "unrelated");
  assert.deepEqual(passClasses(1), { positive: "include", negative: "low_priority" });
  assert.deepEqual(passClasses(2), { positive: "consider_together", negative: "unrelated" });
  for (const passNo of [1, 2]) {
    const entry = selectQuestion({ id: "u1" }, passNo)[questionKey("u1")];
    assert.equal(entry.type, "choice");
    assert.deepEqual(Object.keys(entry.criteria).sort(), passNo === 1 ? ["include", "low_priority"] : ["consider_together", "unrelated"]);
  }
  assert.throws(() => selectQuestion({ id: "u1" }, 3), /unknown pass/);
  assert.throws(() => passClasses(3), /unknown pass/);
  pass("exactly two binary templates (include/low_priority, consider_together/unrelated) — no third lane");
}

// ---------------------------------------------------------------------------
// (d) Question identity: stable, and content-sensitive (forgotten bump still
//     changes the identity hash)
// ---------------------------------------------------------------------------
{
  const identity = questionsIdentity();
  assert.equal(identity.schema, "adr-jev-questions");
  assert.equal(identity.version, "adr-jev-questions-1/frozen-20260922T220341Z");
  assert.match(identity.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(questionsIdentity(), identity, "identity is deterministic");
  // Content sensitivity is proven at the judgment-identity level in
  // tests/adr-jev-cache.mjs (wording/options changes there change cache keys
  // without any version bump).
  pass("question identity is deterministic, versioned and content-hashed");
}
