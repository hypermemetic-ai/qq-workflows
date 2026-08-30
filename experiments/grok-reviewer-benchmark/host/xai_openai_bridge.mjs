#!/usr/bin/env node
/**
 * Loopback-only OpenAI chat-completions facade over qq-models' xai-auth adapter.
 *
 * The bridge owns access to the host OAuth store. Callers receive only a random,
 * run-scoped synthetic key. Authorization headers and OAuth values are never
 * written to logs or responses.
 */
import { createServer } from "node:http";
import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const MODEL = "grok-4.6";
const MAX_BODY = 8 * 1024 * 1024;

function fail(message, status = 400, type = "invalid_request_error") {
  const error = new Error(message);
  error.status = status;
  error.type = type;
  return error;
}

function parseArgs(argv) {
  const args = { host: "127.0.0.1", port: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--models-source") args.modelsSource = argv[++index];
    else if (name === "--adapter-module") args.adapterModule = argv[++index];
    else if (name === "--ready-file") args.readyFile = argv[++index];
    else if (name === "--log") args.log = argv[++index];
    else if (name === "--host") args.host = argv[++index];
    else if (name === "--port") args.port = Number(argv[++index]);
    else throw fail(`unknown argument: ${name}`);
  }
  if (args.host !== "127.0.0.1") throw fail("bridge must bind exactly 127.0.0.1");
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw fail("invalid bridge port");
  if (!args.readyFile || !args.log) throw fail("--ready-file and --log are required");
  if (!args.adapterModule && !args.modelsSource) throw fail("--models-source is required");
  return args;
}

function textContent(content, label) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw fail(`${label}.content must be text`);
  return content.map((part, index) => {
    if (part?.type !== "text" || typeof part.text !== "string") {
      throw fail(`${label}.content[${index}] is not a text part`);
    }
    return part.text;
  }).join("");
}

export function openAiToDsh(body, sessionId = randomUUID()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail("request body must be an object");
  if (body.model !== MODEL) throw fail(`model must be exactly ${MODEL}`);
  const allowed = new Set([
    "model", "messages", "stream", "stream_options", "reasoning_effort", "reasoning",
    "temperature", "max_tokens", "max_completion_tokens", "response_format", "n", "tools", "tool_choice",
  ]);
  const unknown = Object.keys(body).filter((name) => !allowed.has(name));
  if (unknown.length) throw fail(`unsupported request fields: ${unknown.sort().join(", ")}`);
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw fail("messages must be a nonempty array");
  if (body.tools != null && (!Array.isArray(body.tools) || body.tools.length > 0)) {
    throw fail("tools are disabled for the external stock-reviewer bridge");
  }
  if (body.tool_choice != null && body.tool_choice !== "none") throw fail("tool_choice must be none when supplied");
  if (body.n != null && body.n !== 1) throw fail("n must be 1 when supplied");
  if (body.stream != null && typeof body.stream !== "boolean") throw fail("stream must be boolean when supplied");
  if (body.response_format != null) throw fail("response_format is unsupported; configure the stock reviewer with structured output off");
  if (body.temperature != null && (typeof body.temperature !== "number" || !Number.isFinite(body.temperature))) {
    throw fail("temperature must be a finite number when supplied");
  }
  if (body.stream_options != null && (
    typeof body.stream_options !== "object" || Array.isArray(body.stream_options)
    || Object.keys(body.stream_options).some((name) => name !== "include_usage")
    || body.stream_options.include_usage != null && typeof body.stream_options.include_usage !== "boolean"
  )) throw fail("unsupported stream_options");

  const instructions = [];
  const messages = [];
  for (const [index, message] of body.messages.entries()) {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw fail(`messages[${index}] must be an object`);
    const role = message.role;
    const text = textContent(message.content, `messages[${index}]`);
    if (role === "system" || role === "developer") {
      instructions.push(text);
    } else if (role === "user" || role === "assistant") {
      messages.push({ role, content: [{ type: "text", text }] });
    } else {
      throw fail(`messages[${index}].role is unsupported`);
    }
  }
  if (messages.length === 0 || messages.at(-1).role !== "user") {
    throw fail("messages must end with a user message");
  }
  if (body.reasoning != null && (
    typeof body.reasoning !== "object" || Array.isArray(body.reasoning)
    || Object.keys(body.reasoning).some((name) => name !== "effort")
  )) throw fail("unsupported reasoning object");
  const effort = body.reasoning_effort ?? body.reasoning?.effort ?? "high";
  if (!new Set(["low", "medium", "high", "xhigh"]).has(effort)) throw fail("unsupported reasoning effort");
  for (const name of ["max_tokens", "max_completion_tokens"]) {
    if (body[name] != null && (!Number.isInteger(body[name]) || body[name] <= 0)) throw fail(`${name} must be a positive integer`);
  }
  return {
    provider: "xai-auth",
    model: MODEL,
    messages,
    ...(instructions.length ? { system: instructions.join("\n\n") } : {}),
    tools: [],
    reasoningEffort: effort,
    sessionId,
  };
}

export function openAiUsage(usage = {}) {
  const uncached = Number.isInteger(usage.inputTokens) ? usage.inputTokens : 0;
  const cacheRead = Number.isInteger(usage.cacheReadTokens) ? usage.cacheReadTokens : 0;
  const cacheWrite = Number.isInteger(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0;
  const output = Number.isInteger(usage.outputTokens) ? usage.outputTokens : 0;
  const reasoning = Number.isInteger(usage.reasoningTokens) ? usage.reasoningTokens : 0;
  const prompt = uncached + cacheRead + cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
    prompt_tokens_details: {
      cached_tokens: cacheRead,
      cache_creation_tokens: cacheWrite,
    },
    completion_tokens_details: { reasoning_tokens: reasoning },
  };
}

function responseChunk(id, created, delta = {}, finishReason = null, usage) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

async function loadAdapter(args) {
  if (args.adapterModule) {
    const fixture = await import(pathToFileURL(resolve(args.adapterModule)));
    if (typeof fixture.createAdapter !== "function") throw fail("test adapter module must export createAdapter", 500);
    return fixture.createAdapter();
  }
  const root = resolve(args.modelsSource);
  const [{ createGrokAdapter }, { createAuthStore }] = await Promise.all([
    import(pathToFileURL(`${root}/src/grok.mjs`)),
    import(pathToFileURL(`${root}/src/store.mjs`)),
  ]);
  const store = createAuthStore({ env: process.env });
  if (!store.present("grok")) throw fail("host xai-auth login is unavailable", 503, "authentication_error");
  return createGrokAdapter({ store });
}

async function bodyBytes(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw fail("request body is too large", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw fail("request body is not valid JSON"); }
}

function authorized(request, key) {
  const value = request.headers.authorization;
  return typeof value === "string" && value === `Bearer ${key}`;
}

function sendJson(response, status, value) {
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, { "content-type": "application/json", "content-length": encoded.length });
  response.end(encoded);
}

function errorJson(error) {
  return { error: { message: error?.message ?? "bridge request failed", type: error?.type ?? "api_error", code: null } };
}

async function appendLog(path, value) {
  await appendFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const syntheticKey = process.env.GROK_BENCH_BRIDGE_KEY;
  if (typeof syntheticKey !== "string" || syntheticKey.length < 32) throw fail("GROK_BENCH_BRIDGE_KEY must be a run-scoped synthetic key", 500);
  const adapter = await loadAdapter(args);
  await mkdir(dirname(resolve(args.readyFile)), { recursive: true, mode: 0o700 });
  await mkdir(dirname(resolve(args.log)), { recursive: true, mode: 0o700 });
  await writeFile(resolve(args.log), "", { mode: 0o600 });

  let busy = false;
  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    const started = Date.now();
    let claimed = false;
    let controls = null;
    try {
      if (!authorized(request, syntheticKey)) throw fail("invalid bridge credential", 401, "authentication_error");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions" || url.search || url.hash) {
        throw fail("route not found", 404);
      }
      if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        throw fail("content-type must be application/json", 415);
      }
      if (busy) throw fail("bridge permits one provider request at a time", 429, "rate_limit_error");
      busy = true;
      claimed = true;
      const body = await bodyBytes(request);
      const options = openAiToDsh(body, requestId);
      const controller = new AbortController();
      options.signal = controller.signal;
      request.once("aborted", () => controller.abort());
      response.once("close", () => { if (!response.writableEnded) controller.abort(); });
      controls = {
        reasoning_effort_requested: body.reasoning_effort ?? body.reasoning?.effort ?? null,
        reasoning_effort_forwarded: options.reasoningEffort,
        temperature_requested: body.temperature ?? null,
        temperature_forwarded: false,
        token_cap_requested: body.max_completion_tokens ?? body.max_tokens ?? null,
        token_cap_forwarded: false,
        response_format_requested: body.response_format ?? null,
      };
      const stream = body.stream === true;
      const id = `chatcmpl-${requestId}`;
      const created = Math.floor(Date.now() / 1000);
      let text = "";
      let usage;
      let finishReason = "stop";
      let finishSeen = false;
      if (stream) {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
        response.write(`data: ${JSON.stringify(responseChunk(id, created, { role: "assistant", content: "" }))}\n\n`);
      }
      for await (const chunk of adapter.stream(options)) {
        if (chunk?.type === "text-delta") {
          const delta = String(chunk.text ?? "");
          text += delta;
          if (stream) response.write(`data: ${JSON.stringify(responseChunk(id, created, { content: delta }))}\n\n`);
        } else if (chunk?.type === "usage") {
          usage = openAiUsage(chunk.usage);
        } else if (chunk?.type === "finish") {
          finishSeen = true;
          const kind = chunk.reason?.kind;
          if (kind === "max-tokens") finishReason = "length";
          else if (kind === "error" || kind === "aborted" || kind === "interrupted" || kind === "blocked") {
            throw fail(chunk.reason?.failure?.message ?? `provider request ended with ${String(kind)}`, 502, "provider_error");
          } else if (kind === "tool-calls") {
            throw fail("provider unexpectedly returned tool calls", 502, "provider_error");
          } else if (kind !== "stop") {
            throw fail(`provider returned unsupported finish reason ${String(kind)}`, 502, "provider_error");
          }
        }
      }
      if (!finishSeen) throw fail("provider response omitted finish event", 502, "provider_error");
      if (!usage) throw fail("provider response omitted usage", 502, "provider_error");
      if (stream) {
        response.write(`data: ${JSON.stringify(responseChunk(id, created, {}, finishReason, usage))}\n\n`);
        response.end("data: [DONE]\n\n");
      } else {
        sendJson(response, 200, {
          id, object: "chat.completion", created, model: MODEL,
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finishReason }],
          usage,
        });
      }
      await appendLog(resolve(args.log), {
        request_id: requestId, model: MODEL, status: 200, controls, usage,
        elapsed_ms: Date.now() - started,
      });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (!response.headersSent) sendJson(response, status, errorJson(error));
      else response.end();
      await appendLog(resolve(args.log), {
        request_id: requestId, model: MODEL, status, controls,
        error_type: error?.type ?? "api_error", elapsed_ms: Date.now() - started,
      }).catch(() => {});
    } finally {
      if (claimed) busy = false;
    }
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(args.port, args.host, accept);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : args.port;
  const ready = { schema: "qq.grok-xai-bridge-ready/v1", base_url: `http://127.0.0.1:${port}/v1`, pid: process.pid, model: MODEL };
  await writeFile(resolve(args.readyFile), `${JSON.stringify(ready)}\n`, { mode: 0o600 });
  await chmod(resolve(args.readyFile), 0o600);
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  main().catch((error) => {
    console.error(`xai bridge: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
