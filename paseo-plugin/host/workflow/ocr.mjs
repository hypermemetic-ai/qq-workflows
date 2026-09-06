import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProviderProxy } from "../providers/provider-proxy.mjs";
import { loadGrokToken } from "../providers/secrets.mjs";

const exec = promisify(execFile);

export function mapOcrJson(payload) {
  const failed = payload?.manifest?.coverage?.failed ?? [];
  if ((payload?.status && !["success", "complete"].includes(payload.status)) || payload?.summary?.budget_exceeded || failed.length || ["partial", "failed", "cancelled"].includes(payload?.manifest?.terminal_state)) {
    throw Object.assign(new Error(`Review coverage incomplete: ${JSON.stringify({ status: payload.status, failed, message: payload.message })}`), {
      failureClass: "process", reviewEvidence: { status: payload.status, message: payload.message, manifest: payload.manifest },
    });
  }
  const list = findingsList(payload);
  if (!Array.isArray(list)) {
    throw new Error("ocr json must include a comments array");
  }
  return list.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`ocr finding ${index} must be an object`);
    }
    const rawPath = item.path ?? item.file_path ?? item.file;
    const rawBody = item.body ?? item.content ?? item.message;
    if (typeof rawPath !== "string" || typeof rawBody !== "string") throw new Error(`ocr finding ${index} requires string path and body`);
    const path = rawPath.trim();
    const body = rawBody.trim();
    const rawLine = item.line ?? item.start_line ?? item.startLine ?? item.end_line;
    const line = rawLine == null || rawLine === "" ? 1 : Number(rawLine);
    if (!path || !body || (!Number.isInteger(line) || line < 1)) {
      throw new Error(`ocr finding ${index} requires path, line, and body`);
    }
    return { path, line, body };
  });
}

export async function grokOcrEnv(env = process.env) {
  const token = env.OCR_LLM_TOKEN || env.XAI_API_KEY || (await loadGrokToken(env));
  return {
    ...env,
    OCR_LLM_URL: env.OCR_LLM_URL || "https://api.x.ai",
    OCR_LLM_MODEL: env.OCR_LLM_MODEL || "grok-4.6",
    ...(token ? { OCR_LLM_TOKEN: token } : {}),
  };
}

export async function runOcrReview(repo, {
  from,
  to = "HEAD",
  command = process.env.OCR_BIN ?? "ocr",
  execFileFn = exec,
  env = process.env,
  supervision,
} = {}) {
  if (!from) throw new Error("ocr review requires --from merge-base");
  if (!repo) throw new Error("ocr review requires --repo");
  const effectiveEnv = await grokOcrEnv(env);
  const proxy = supervision ? await createProviderProxy({ ...supervision, endpoint: effectiveEnv.OCR_LLM_URL, token: effectiveEnv.OCR_LLM_TOKEN, model: effectiveEnv.OCR_LLM_MODEL }) : null;
  let stdout;
  try {
  ({ stdout } = await execFileFn(command, [
    "review",
    "--audience", "agent",
    "--format", "json",
    "--effort", "high",
    "--from", from,
    "--to", to,
    "--repo", repo,
  ], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: { ...effectiveEnv, ...(proxy ? { OCR_LLM_URL: proxy.url } : {}) },
  }));
  } catch (error) {
    if (proxy?.failures.length) {
      const underlying = proxy.failures.at(-1);
      throw Object.assign(new Error(JSON.parse(underlying.text).error.message, { cause: error }), { failureClass: underlying.failureClass, attempts: underlying.attempts, exhausted: underlying.exhausted, supervised: true });
    }
    throw error;
  } finally { await proxy?.close(); }
  if (proxy?.failures.length) {
    const underlying = proxy.failures.at(-1);
    throw Object.assign(new Error(JSON.parse(underlying.text).error.message), { failureClass: underlying.failureClass, attempts: underlying.attempts, exhausted: underlying.exhausted, supervised: true });
  }
  const text = String(stdout ?? "").trim();
  if (!text) throw new Error("ocr produced no json");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("ocr output is not json");
  }
  return mapOcrJson(payload);
}

function findingsList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return null;
  if (Array.isArray(payload.comments)) return payload.comments;
  if (Array.isArray(payload.findings)) return payload.findings;
  if (Array.isArray(payload.results)) return payload.results;
  return null;
}
