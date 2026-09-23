// Content-addressed raw judgment cache + result-packet store for ADR Jev
// judgments (SUBORDINATE operational artifacts only).
//
// Purpose
// -------
// * A successful raw judgment is cached keyed by the EXACT request identity:
//   model, state, questions/options (verbatim), plus the model/API version and
//   request-affecting parameters (endpoint). Any meaningful wording, options,
//   state, context or candidate-ADR content change changes the content hash
//   and invalidates reuse — even when a human forgets to bump a version
//   string. Source/candidate content versions and provenance are recorded in
//   the artifact (the verbatim request content is covered by the identity
//   hash; the retained sources keep the prose, so no duplicate prose store).
// * ONLY successful validated responses are cached. Errors, timeouts,
//   malformed responses and out-of-range scores are NEVER persisted as
//   reusable successful judgments (callers keep them as explicit pending /
//   retryable results).
// * Immutable artifacts: the first successful judgment for a request identity
//   is preserved unchanged; a divergent concurrent response is reported and
//   discarded (never silently swapped). A corrupt artifact is reported
//   cleanly and can be replaced by a freshly obtained judgment (recovery
//   without fabricating scores).
// * Artifacts live OUTSIDE any ADR index under `<stateDir>/adr-jev/`
//   (directory 0700, files 0600, tmp + rename, sha256 integrity field) and
//   contain NO credentials. Nothing in this module schedules work, launches a
//   worker, notifies anyone, or becomes a second authoritative obligation
//   store: the managed change record remains the sole authority.
//
// Routing policy is deliberately NOT part of the judgment identity: the exact
// raw scores are preserved so a threshold-only policy change reprojects routes
// without any new provider call (see workflow/adr-jev-judgments.mjs).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ADR_JEV_ARTIFACT_SCHEMA_VERSION = 1;
export const JUDGMENT_SCHEMA = "adr-jev-judgment";
export const RESULT_PACKET_SCHEMA = "adr-jev-result";

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function adrJevDir(stateDir) {
  return join(stateDir, "adr-jev");
}

export function adrJevJudgmentsDir(stateDir) {
  return join(adrJevDir(stateDir), "judgments");
}

export function adrJevPacketsDir(stateDir) {
  return join(adrJevDir(stateDir), "packets");
}

// ---------------------------------------------------------------------------
// Judgment request identity (content-addressed; version-blind by construction)
// ---------------------------------------------------------------------------

/**
 * The judgment identity of ONE provider request: the exact actual model,
 * state/questions/options verbatim and every request-affecting parameter (the
 * API name/version/endpoint), plus an optional `scope` discriminator for
 * content versions that do not reach the model but must invalidate reuse
 * (e.g. the caller-supplied candidate ADR content version). It does NOT trust
 * any version string — the question wording and content hashes ARE the
 * identity — and deliberately excludes the routing policy (routes are
 * recomputable from raw scores).
 */
export function judgmentIdentity({ api, model, state, questions, scope = null }) {
  if (!model || typeof model !== "string") throw fail("invalid-arguments", "judgment identity requires the exact model id");
  if (!api || typeof api !== "object" || typeof api.name !== "string" || typeof api.version !== "string") {
    throw fail("invalid-arguments", "judgment identity requires api { name, version } (endpoint included when supplied)");
  }
  if (!state || typeof state !== "object" || !questions || typeof questions !== "object") {
    throw fail("invalid-arguments", "judgment identity requires the verbatim state and questions objects");
  }
  const apiMaterial = { name: api.name, version: api.version, endpoint: api.endpoint ?? null };
  const requestMaterial = { api: apiMaterial, model, state, questions };
  const requestSha256 = sha256Hex(Buffer.from(canonicalJson(requestMaterial), "utf8"));
  const identitySha256 = sha256Hex(Buffer.from(canonicalJson({ request: requestMaterial, scope }), "utf8"));
  return {
    judgmentId: `jevj-${identitySha256.slice(0, 32)}`,
    identitySha256,
    requestSha256,
    stateSha256: sha256Hex(Buffer.from(canonicalJson(state), "utf8")),
    questionsSha256: sha256Hex(Buffer.from(canonicalJson(questions), "utf8")),
    api: apiMaterial,
    model,
    scope,
  };
}

// ---------------------------------------------------------------------------
// Immutable artifact IO (shared by judgments and result packets)
// ---------------------------------------------------------------------------

function integrityOf(entry) {
  const rest = { ...entry };
  delete rest.integrity;
  return { algorithm: "sha256", payloadSha256: sha256Hex(Buffer.from(canonicalJson(rest), "utf8")) };
}

function assertIdName(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw fail("invalid-arguments", `${name} must be a bounded identifier (got ${JSON.stringify(value ?? null)})`);
  }
  return value;
}

function readArtifactFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: `artifact is missing at ${path}` };
  }
  let entry;
  try {
    entry = JSON.parse(text);
  } catch (error) {
    return { ok: false, corrupt: true, reason: `artifact is corrupt (unparseable JSON): ${error?.message ?? error}` };
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: false, corrupt: true, reason: "artifact is corrupt (not an object)" };
  }
  const integrity = entry.integrity;
  if (!integrity || integrity.algorithm !== "sha256") {
    return { ok: false, corrupt: true, reason: "artifact is corrupt (missing integrity field)" };
  }
  const expected = integrityOf(entry).payloadSha256;
  if (expected !== integrity.payloadSha256) {
    return { ok: false, corrupt: true, reason: "artifact is corrupt (sha256 integrity check failed)" };
  }
  return { ok: true, entry };
}

function writeArtifactFile(dir, path, entry, { ignoreFields = [] } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const withIntegrity = { ...entry, integrity: integrityOf(entry) };
  const buffer = Buffer.from(`${JSON.stringify(withIntegrity, null, 2)}\n`, "utf8");
  const stripIgnored = (value) => {
    const copy = { ...value };
    delete copy.integrity;
    for (const field of ignoreFields) delete copy[field];
    return canonicalJson(copy);
  };
  let repairedCorrupt = false;
  if (existsSync(path)) {
    const existing = readArtifactFile(path);
    if (existing.ok) {
      const same = stripIgnored(existing.entry) === stripIgnored(withIntegrity);
      return { ok: true, path, sha256: sha256Hex(buffer), bytes: buffer.length, dedupe: same, divergent: !same, entry: existing.entry };
    }
    // Corrupt artifact: cleanly reported and replaced (recovery without ever
    // fabricating scores — the replacement content comes from a real response).
    repairedCorrupt = true;
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, buffer, { mode: 0o600 });
  renameSync(tmp, path);
  return {
    ok: true,
    path,
    sha256: sha256Hex(buffer),
    bytes: buffer.length,
    dedupe: false,
    divergent: false,
    ...(repairedCorrupt ? { repairedCorrupt: true } : {}),
    entry: withIntegrity,
  };
}

// ---------------------------------------------------------------------------
// Successful raw judgment artifacts
// ---------------------------------------------------------------------------

export function judgmentArtifactPath(stateDir, judgmentId) {
  assertIdName(judgmentId, "judgmentId");
  return join(adrJevJudgmentsDir(stateDir), `${judgmentId}.json`);
}

/**
 * Persist ONE successful validated raw judgment. Only call this with a real
 * validated provider response — errors never reach this function. Idempotent:
 * identical content rewrites nothing (`dedupe: true`); a divergent concurrent
 * response is reported (`divergent: true`) and the first successful judgment
 * is preserved unchanged.
 */
export function writeJudgmentArtifact(stateDir, { identity, provenance = null, result }) {
  if (!stateDir) throw fail("invalid-arguments", "stateDir is required");
  if (!identity?.judgmentId || !identity?.requestSha256 || !identity?.identitySha256) throw fail("invalid-arguments", "writeJudgmentArtifact requires a full judgment identity");
  if (!result || typeof result !== "object" || !result.answers || typeof result.answers !== "object") {
    throw fail("invalid-arguments", "only a successful raw provider response (with answers) may be cached");
  }
  if (!/^[0-9a-f]{64}$/.test(String(identity.requestSha256))) throw fail("invalid-arguments", "judgment identity requestSha256 must be a sha256 hex digest");
  const entry = {
    schema: JUDGMENT_SCHEMA,
    schemaVersion: ADR_JEV_ARTIFACT_SCHEMA_VERSION,
    judgmentId: identity.judgmentId,
    identity: {
      api: identity.api,
      model: identity.model,
      requestSha256: identity.requestSha256,
      identitySha256: identity.identitySha256,
      stateSha256: identity.stateSha256,
      questionsSha256: identity.questionsSha256,
      scope: identity.scope ?? null,
    },
    provenance,
    result: { answers: result.answers, model: result.model ?? null, usage: result.usage ?? null },
    recordedAt: Date.now(),
  };
  return writeArtifactFile(adrJevJudgmentsDir(stateDir), judgmentArtifactPath(stateDir, identity.judgmentId), entry, { ignoreFields: ["recordedAt"] });
}

/**
 * Read a cached raw judgment. `corrupt: true` results are reported cleanly and
 * must be treated as a cache miss by the caller (who may re-request; scores
 * are never fabricated from a corrupt artifact).
 */
export function readJudgmentArtifact(stateDir, judgmentId) {
  const path = judgmentArtifactPath(stateDir, judgmentId);
  const result = readArtifactFile(path);
  if (!result.ok) return result;
  const entry = result.entry;
  if (entry.schema !== JUDGMENT_SCHEMA) {
    return { ok: false, corrupt: true, reason: `artifact schema ${JSON.stringify(entry.schema)} is unknown` };
  }
  if (entry.schemaVersion !== ADR_JEV_ARTIFACT_SCHEMA_VERSION) {
    return { ok: false, corrupt: true, reason: `artifact schema version ${JSON.stringify(entry.schemaVersion)} is unknown` };
  }
  if (entry.judgmentId !== judgmentId) {
    return { ok: false, corrupt: true, reason: `artifact '${judgmentId}' carries judgmentId '${entry.judgmentId}'` };
  }
  return { ok: true, entry };
}

// ---------------------------------------------------------------------------
// Compact attributable result packets
// ---------------------------------------------------------------------------

export function resultPacketPath(stateDir, packetId) {
  assertIdName(packetId, "packetId");
  return join(adrJevPacketsDir(stateDir), `${packetId}.json`);
}

/** Content-addressed packet identity (createdAt excluded: rebuild-idempotent). */
export function resultPacketId(packet) {
  const rest = { ...packet };
  delete rest.packetId;
  delete rest.createdAt;
  return `jevpkt-${sha256Hex(Buffer.from(canonicalJson(rest), "utf8")).slice(0, 32)}`;
}

export function writeResultPacket(stateDir, packet) {
  if (!stateDir) throw fail("invalid-arguments", "stateDir is required");
  const expectedId = resultPacketId(packet);
  if (packet.packetId !== expectedId) {
    throw fail("invalid-arguments", `result packet id '${packet.packetId}' does not match its content-addressed id '${expectedId}'`);
  }
  const entry = {
    schema: RESULT_PACKET_SCHEMA,
    schemaVersion: ADR_JEV_ARTIFACT_SCHEMA_VERSION,
    ...packet,
  };
  return writeArtifactFile(adrJevPacketsDir(stateDir), resultPacketPath(stateDir, packet.packetId), entry, { ignoreFields: ["createdAt"] });
}

export function readResultPacket(stateDir, packetId) {
  const result = readArtifactFile(resultPacketPath(stateDir, packetId));
  if (!result.ok) return result;
  const entry = result.entry;
  if (entry.schema !== RESULT_PACKET_SCHEMA) {
    return { ok: false, corrupt: true, reason: `artifact schema ${JSON.stringify(entry.schema)} is unknown` };
  }
  if (entry.schemaVersion !== ADR_JEV_ARTIFACT_SCHEMA_VERSION) {
    return { ok: false, corrupt: true, reason: `artifact schema version ${JSON.stringify(entry.schemaVersion)} is unknown` };
  }
  if (entry.packetId !== packetId) {
    return { ok: false, corrupt: true, reason: `artifact '${packetId}' carries packetId '${entry.packetId}'` };
  }
  return { ok: true, entry };
}
