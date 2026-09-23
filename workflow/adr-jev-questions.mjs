// The ONE discoverable versioned source of Jev judgment questions/options.
//
// Purpose
// -------
// Exactly two binary templates exist for ADR curation judgments:
//   pass 1: include / low_priority         (evidence selection)
//   pass 2: consider_together / unrelated  (candidate-ADR pairing)
// This module is the single tunable home of that wording. The initial wording
// BYTE-MATCHES the frozen binary-vs-ternary experiment
// (20260922T220341Z lib/questions.mjs) via the same unit_id substitution; a
// test suite byte-compares generated questions against the frozen artifact
// `tests/fixtures/adr-jev/questions-frozen.json`. Any future tuning happens
// HERE ONLY (no generic prompt framework, no third lane, no relationship
// vocabulary expansion).
//
// Attribution
// ----------
// `unitsState`, `selectQuestion` and the frozen instruction/criteria text are
// reused (adapted to ES module exports only) from the historical experiment
// artifact
//   /home/qqp/.local/state/qq-workflows/adr-jev-experiments/binary-vs-ternary-20260922T220341Z/lib/questions.mjs
// which is historical experiment evidence, not a production runtime
// dependency. Wording changes require a deliberate revision here (the
// content-addressed judgment identity hashes the exact question object, so a
// wording change invalidates cached judgments even without a version bump).
//
// Contract notes carried by the frozen wording
// --------------------------------------------
// * Every question names its target unit_id in the INSTRUCTIONS, not only in
//   the question key (`route__<unit_id>` is never model input semantics).
// * Question map keys are NOT model input; one self-contained typed Choice
//   question per provider request; paired states never co-occur.
// * "low_priority"/"unrelated" mean EXCLUDED FROM THE CURATION VIEW ONLY —
//   source is never deleted. Selection is not approval and not a claim of
//   current validity. Operational/draft/rejected text may be supplied as
//   attributed evidence.
// * Ambiguous potentially useful material routes FORWARD by question wording
//   ("when in doubt, include / consider_together"). For pass 2 "potentially
//   useful" means the snippet bears on the candidate ADR's choice, rationale,
//   conflict, replacement, dependency or exception (decision / constraint /
//   rationale / alternative / consequence in the frozen wording); mere shared
//   vocabulary is NOT enough and is "unrelated".
// * The provider request uses `state` + `questions` only (SystemOne v1 typed
//   questions). No chat channel is ever invented.

import { createHash } from "node:crypto";

export const QUESTIONS_SCHEMA = "adr-jev-questions";
export const QUESTIONS_VERSION = "adr-jev-questions-1/frozen-20260922T220341Z";

export const PASS1_POSITIVE = "include";
export const PASS1_NEGATIVE = "low_priority";
export const PASS2_POSITIVE = "consider_together";
export const PASS2_NEGATIVE = "unrelated";
export const QUESTION_TYPE = "choice";
export const QUESTION_KEY_PREFIX = "route__";

export function questionKey(unitId) {
  return `${QUESTION_KEY_PREFIX}${unitId}`;
}

/**
 * Model-facing state: opaque unit_id + verbatim heading/text + bounded
 * neighboring source context ONLY. NO source/provenance, NO label, NO
 * generated semantic status field. Pass 2 adds the candidate ADR
 * (`candidate_adr`) supplied by the caller as an exact content/version tuple.
 */
export function unitsState(units, pass, candidateAdr) {
  const u = {};
  for (const unit of units) {
    u[unit.id] = { unit_id: unit.id, heading: unit.heading, text: unit.text, context: unit.context };
  }
  if (pass === 2) return { candidate_adr: candidateAdr, units: u };
  return { units: u };
}

const INSTR_P1 = (id) =>
  `Task: choose how to route ONE passage for the Architect's ADR (Architecture Decision Record) curation view, selected from archived evidence. ` +
  `All original source documents remain available; this selection only assembles a curated view. ` +
  `"low_priority" means EXCLUDED FROM THIS VIEW ONLY - it never deletes any source. ` +
  `The passage is the entry in the state whose unit_id is "${id}" (fields: heading, text, context). Judge THIS passage on its own supplied text, heading and context. ` +
  `Source context is supplied up front where available; the Architect can request more later if needed. ` +
  `Routing options: ` +
  `include = forward the passage to the Architect's curation view. Include decision evidence - a chosen/proposed/rejected approach, a constraint or trade-off, a stated reason (rationale), or a decision-relevant consequence - AND ambiguous material that might hold such evidence: when in doubt, include; possibly useful material is forwarded, not silently discarded. ` +
  `low_priority = EXCLUDED FROM THIS VIEW ONLY (never deletion): clearly irrelevant operational chatter or routine logistics/event details (e.g. one-off status, job/branch coordinate bookkeeping, a single test/smoke result) with no decision, constraint, rationale, alternative or consequence information. ` +
  `A proposal or provisional status is NOT a reason to exclude - proposals and rejected options are still evidence. ` +
  `Selecting a passage does not imply approval and is not a claim of current validity. Do not fill gaps from general knowledge. Consider only unit "${id}".`;

const CRIT_P1 = {
  include: "Forward to the Architect's ADR curation view: decision / constraint / rationale / alternative / consequence evidence, or ambiguous material that might hold such evidence - when in doubt, include. Selection is not approval.",
  low_priority: "Excluded from this view only (never delete the source): clearly irrelevant operational chatter or routine logistics/event details with no such information.",
};

const INSTR_P2 = (id) =>
  `Task: decide whether ONE evidence snippet should be forwarded to be considered TOGETHER with the candidate ADR in the state field candidate_adr, for the Architect's ADR (Architecture Decision Record) work. ` +
  `The candidate ADR and all evidence remain archived; this only assembles a combined consideration view. ` +
  `"unrelated" means EXCLUDED FROM THIS VIEW ONLY - it never deletes any source. ` +
  `The evidence snippet is the entry in the state whose unit_id is "${id}" (fields: heading, text, context). Judge THIS snippet against the candidate ADR using its own supplied text, heading and context. ` +
  `Source context is supplied up front where available; the Architect can request more later if needed. ` +
  `Options: ` +
  `consider_together = forward the snippet to be considered alongside the candidate ADR: it bears on the ADR's decision, constraint, rationale, alternative or consequence - or it is ambiguous and might do so: when in doubt, consider_together; possibly useful material is forwarded, not silently discarded. ` +
  `unrelated = EXCLUDED FROM THIS VIEW ONLY (never deletion): clearly unrelated material - operational chatter, routine logistics, or a scope with no bearing on the candidate ADR. ` +
  `Forwarding is not approval and not a claim of current validity. Do not fill gaps from general knowledge. Consider only unit "${id}".`;

const CRIT_P2 = {
  consider_together: "Forward alongside the candidate ADR: material bearing on its decision / constraint / rationale / alternative / consequence, or ambiguous material that might do so - when in doubt, forward. Forwarding is not approval.",
  unrelated: "Excluded from this combined view only (never delete the source): clearly unrelated material - operational chatter, logistics, or scope with no bearing on the candidate ADR.",
};

/**
 * The single question factory. `state` is a model-facing unit entry (its `id`
 * names the target unit in the instructions). Exactly two binary templates:
 * pass 1 (include/low_priority) and pass 2 (consider_together/unrelated).
 */
export function selectQuestion(state, pass) {
  const id = state.id;
  const key = questionKey(id);
  if (pass === 1) return { [key]: { type: QUESTION_TYPE, instructions: INSTR_P1(id), criteria: CRIT_P1 } };
  if (pass === 2) return { [key]: { type: QUESTION_TYPE, instructions: INSTR_P2(id), criteria: CRIT_P2 } };
  throw new Error("unknown pass " + pass);
}

/** Positive/negative classes of each pass (the ONLY two options per template). */
export function passClasses(pass) {
  if (pass === 1) return { positive: PASS1_POSITIVE, negative: PASS1_NEGATIVE };
  if (pass === 2) return { positive: PASS2_POSITIVE, negative: PASS2_NEGATIVE };
  throw new Error("unknown pass " + pass);
}

// Content identity of this question source (used in judgment identity and
// result packets). The hash covers the exact rendered wording of BOTH passes
// plus the option sets and the unit_id substitution mechanism, so a meaningful
// wording/options change is visible even when QUESTIONS_VERSION is not bumped.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function questionsIdentity() {
  const rendered = {};
  for (const pass of [1, 2]) {
    // Render each template at two target ids so the unit_id substitution
    // mechanism itself is part of the content identity.
    rendered[pass] = ["target-unit", "\u0000other\u0000"].map((id) => ({
      question: selectQuestion({ id }, pass),
      classes: passClasses(pass),
    }));
  }
  const material = {
    schema: QUESTIONS_SCHEMA,
    version: QUESTIONS_VERSION,
    rendered: { type: QUESTION_TYPE, keyPrefix: QUESTION_KEY_PREFIX, passes: rendered },
  };
  const sha256 = createHash("sha256").update(canonicalJson(material)).digest("hex");
  return { schema: QUESTIONS_SCHEMA, version: QUESTIONS_VERSION, sha256 };
}
