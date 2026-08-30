/** Trusted benchmark wrapper: unchanged qq-models plugin plus secret-free HTTP-attempt telemetry. */
import { appendFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const GROK_PROXY_URL = "https://cli-chat-proxy.grok.com/v1/responses";
const source = process.env.BENCH_QQ_MODELS_SOURCE;
const output = process.env.BENCH_OUTPUT_DIR;
if (!source || !output) throw new Error("qq-models benchmark wrapper requires trusted source/output paths");
const upstream = await import(pathToFileURL(resolve(source, "src", "plugin.mjs")));
const attemptLog = resolve(output, "qq-provider-attempts.jsonl");

function requestModel(body) {
  if (typeof body !== "string" && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) return null;
  try {
    const value = JSON.parse(Buffer.from(body).toString("utf8"));
    return typeof value?.model === "string" ? value.model : null;
  } catch {
    return null;
  }
}

function append(value) {
  appendFileSync(attemptLog, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(attemptLog, 0o600); } catch { /* already private */ }
}

async function instrumentedFetch(input, init = {}) {
  const url = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url ?? "");
  if (url !== GROK_PROXY_URL) return fetch(input, init);
  const started = Date.now();
  const model = requestModel(init.body);
  try {
    const response = await fetch(input, init);
    append({
      schema: "qq.grok-provider-attempt/v1",
      model,
      status: response.status,
      ok: response.ok,
      elapsed_ms: Date.now() - started,
    });
    return response;
  } catch (error) {
    append({
      schema: "qq.grok-provider-attempt/v1",
      model,
      status: null,
      ok: false,
      error_type: error?.name ?? "Error",
      elapsed_ms: Date.now() - started,
    });
    throw error;
  }
}

export const name = upstream.name;
export const inject = upstream.inject;
export const provide = upstream.provide;
export function apply(ctx, config = {}) {
  return upstream.apply(ctx, { ...config, fetch: instrumentedFetch });
}
