// Bounded single-attempt SystemOne v1 provider seam for ADR Jev judgments.
//
// Attribution
// ----------
// Adapted (narrowly) from the historical binary-vs-ternary experiment artifact
//   /home/qqp/.local/state/qq-workflows/adr-jev-experiments/binary-vs-ternary-20260922T220341Z/lib/client.mjs
// (historical experiment evidence, not a production runtime dependency).
//
// Contract
// -------
// * ONE provider request = { model, state, questions } against the SystemOne v1
//   typed-questions endpoint. No chat channel is ever invented.
// * Model/API defaults match the verified experiment: jev-1.13.0 / SystemOne
//   v1. Worker/Architect model configuration is untouched: this seam is used
//   only for the narrow Jev judgment calls.
// * Credential safety is preserved from the experiment: the API key comes from
//   TYPESAFE_API_KEY or a 0600 key file (TYPESAFE_API_KEY_FILE). Authorization
//   values are never returned in results, never logged, never persisted.
// * Single attempt, bounded timeout, NO automatic retries. Every failure is an
//   explicit typed, retryable-flagged error result; callers decide whether to
//   retry (the judgment layer marks such work pending/deferred — it never
//   silently assigns 0 / unrelated).
// * The network seam is injectable (`fetchImpl`) so the test suite never makes
//   a live call.

import * as fs from "node:fs";

export const SYSTEMONE_API = Object.freeze({
  name: "systemone",
  version: "v1",
  defaultEndpoint: "https://api.typesafe.ai/v1/systemone",
});
export const DEFAULT_MODEL = "jev-1.13.0";
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Resolve the provider credential exactly as the verified experiment did:
 * env var first, otherwise a key file that MUST be 0600. The returned key must
 * only ever reach an Authorization header — never a result, log, cache or
 * artifact (callers must not serialize the credential or its source label).
 */
export function resolveCredential(env = process.env) {
  if (env.TYPESAFE_API_KEY && env.TYPESAFE_API_KEY.trim()) {
    return { key: env.TYPESAFE_API_KEY.trim(), source: "env:TYPESAFE_API_KEY" };
  }
  const keyFile = env.TYPESAFE_API_KEY_FILE ||
    `${env.HOME || "/home/qqp"}/.config/qq-workflows/typesafe-api-key`;
  if (!fs.existsSync(keyFile)) return { key: null, source: `missing (checked file ${keyFile})` };
  const st = fs.statSync(keyFile);
  if ((st.mode & 0o077) !== 0) throw new Error(`key file ${keyFile} must be 0600`);
  return { key: fs.readFileSync(keyFile, "utf8").trim(), source: `file:${keyFile}` };
}

function classifyRetryable(errorType, httpStatus = null) {
  if (errorType === "TIMEOUT" || errorType === "NETWORK_ERROR" || errorType === "BODY_READ_ERROR" || errorType === "MALFORMED_JSON") return true;
  if (errorType === "HTTP_ERROR") return httpStatus === 429 || httpStatus === 408 || (httpStatus >= 500 && httpStatus <= 599);
  return false;
}

/**
 * Single bounded request. Resolves (never throws on transport failure) with
 * either `{ ok: true, httpStatus, json, latencyMs }` or
 * `{ ok: false, httpStatus, errorType, errorMessage, retryable, latencyMs }`.
 * The request body is returned for caller-side inspection only and MUST NOT be
 * persisted alongside failures; it carries no credential either way.
 */
export async function systemoneRequest({
  endpoint = SYSTEMONE_API.defaultEndpoint,
  apiKey,
  model = DEFAULT_MODEL,
  state,
  questions,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new Error("systemoneRequest: apiKey is required (resolveCredential never leaks into artifacts)");
  const startedAt = Date.now();
  const body = { model, state, questions };
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const errorType = err?.name === "TimeoutError" || err?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR";
    return { ok: false, errorType, retryable: classifyRetryable(errorType), errorMessage: String(err?.message), latencyMs: Date.now() - startedAt, requestBody: body };
  }
  const latencyMs = Date.now() - startedAt;
  let text = "";
  try {
    text = await res.text();
  } catch (err) {
    return { ok: false, httpStatus: res.status, errorType: "BODY_READ_ERROR", retryable: true, errorMessage: String(err?.message), latencyMs, requestBody: body };
  }
  if (!res.ok) {
    return { ok: false, httpStatus: res.status, errorType: "HTTP_ERROR", retryable: classifyRetryable("HTTP_ERROR", res.status), errorMessage: `HTTP ${res.status}: ${text.slice(0, 800)}`, latencyMs, requestBody: body };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, httpStatus: res.status, errorType: "MALFORMED_JSON", retryable: true, errorMessage: String(err?.message), rawText: text.slice(0, 800), latencyMs, requestBody: body };
  }
  return { ok: true, httpStatus: res.status, json, latencyMs, requestBody: body };
}

/**
 * The injectable provider seam the judgment layer consumes:
 * `provider.request({ model, state, questions }) -> SystemOne-style result`.
 * The credential is resolved ONCE at creation and kept in closure scope only.
 */
export function createSystemOneProvider({
  endpoint = SYSTEMONE_API.defaultEndpoint,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  env = process.env,
  credential = undefined,
} = {}) {
  const cred = credential ?? resolveCredential(env);
  return {
    api: { name: SYSTEMONE_API.name, version: SYSTEMONE_API.version, endpoint },
    model,
    hasCredential: Boolean(cred.key),
    async request({ model: overrideModel, state, questions } = {}) {
      if (!cred.key) {
        return { ok: false, errorType: "NO_CREDENTIAL", retryable: false, errorMessage: "no provider credential available; no request was sent", latencyMs: 0 };
      }
      return systemoneRequest({
        endpoint,
        apiKey: cred.key,
        model: overrideModel ?? model,
        state,
        questions,
        timeoutMs,
        fetchImpl,
      });
    },
  };
}
