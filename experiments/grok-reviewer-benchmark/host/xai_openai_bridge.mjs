#!/usr/bin/env node
/**
 * Loopback-only OpenAI chat-completions facade over qq-models' xai-auth adapter.
 *
 * The bridge owns access to the host OAuth store. External callers receive only
 * distinct run-scoped synthetic keys. A separate synthetic admin key authorizes
 * auth readiness. OAuth values are never written to logs or responses.
 */
import { createServer } from "node:http";
import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const MODEL = "grok-4.6";
const CONNECTOR = "grok";
const MAX_BODY = 8 * 1024 * 1024;
const LOCK_TIMEOUT = /qq-models: timed out locking /;

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
    if (role === "system" || role === "developer") instructions.push(text);
    else if (role === "user" || role === "assistant") messages.push({ role, content: [{ type: "text", text }] });
    else throw fail(`messages[${index}].role is unsupported`);
  }
  if (messages.length === 0 || messages.at(-1).role !== "user") throw fail("messages must end with a user message");
  if (body.reasoning != null && (
    typeof body.reasoning !== "object" || Array.isArray(body.reasoning)
    || Object.keys(body.reasoning).some((name) => name !== "effort")
  )) throw fail("unsupported reasoning object");
  const effort = body.reasoning_effort ?? body.reasoning?.effort ?? "high";
  if (effort !== "high") throw fail("reasoning effort must be high for this benchmark");
  return {
    provider: "xai-auth", model: MODEL, messages,
    system: instructions.length ? instructions.join("\n\n") : undefined,
    reasoningEffort: "high", sessionId,
  };
}

function finiteNonnegative(value) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

export function openAiUsage(usage = {}) {
  const input = finiteNonnegative(usage.inputTokens);
  const output = finiteNonnegative(usage.outputTokens);
  const cacheRead = finiteNonnegative(usage.cacheReadTokens);
  const cacheWrite = finiteNonnegative(usage.cacheWriteTokens);
  const reasoning = finiteNonnegative(usage.reasoningTokens);
  return {
    prompt_tokens: input + cacheRead + cacheWrite,
    completion_tokens: output,
    total_tokens: input + cacheRead + cacheWrite + output,
    prompt_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: cacheWrite },
    completion_tokens_details: { reasoning_tokens: reasoning },
  };
}

function responseChunk(id, created, delta = {}, finishReason = null, usage) {
  return {
    id, object: "chat.completion.chunk", created, model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage }),
  };
}

function sameAuth(left, right) {
  return Boolean(left && right)
    && left.access === right.access
    && left.refresh === right.refresh
    && left.expires === right.expires;
}

/**
 * Process-local refresh coordination around qq-models' host store.
 *
 * Every adapter receives a request-scoped facade that remembers the generation
 * it handed to that request. A 401 rotates only if that generation is still
 * current. Simultaneous expiry/401 refreshes share one promise. A file-lock
 * timeout caused by an external native qq process is recovered only when the
 * store proves that process installed a newer generation.
 */
export function createSingleFlightAuthCoordinator(store) {
  const flights = new Map();

  async function rotate(connectorId, refresher, observed) {
    const active = flights.get(connectorId);
    if (active) return active;
    const operation = (async () => {
      const current = store.read(connectorId);
      if (observed && current && !sameAuth(observed, current)) return current;
      try {
        return await store.rotate(connectorId, refresher);
      } catch (error) {
        const after = store.read(connectorId);
        if (LOCK_TIMEOUT.test(String(error?.message ?? error)) && observed && after && !sameAuth(observed, after)) {
          return after;
        }
        throw error;
      }
    })();
    flights.set(connectorId, operation);
    try {
      return await operation;
    } finally {
      if (flights.get(connectorId) === operation) flights.delete(connectorId);
    }
  }

  function requestStore() {
    const observed = new Map();
    return Object.freeze({
      pathFor: (...args) => store.pathFor(...args),
      read: (...args) => store.read(...args),
      present: (...args) => store.present(...args),
      write: (...args) => store.write(...args),
      remove: (...args) => store.remove(...args),
      needsRefresh: (...args) => store.needsRefresh(...args),
      async accessToken(connectorId, refresher) {
        let token = store.read(connectorId);
        if (!token) token = await store.accessToken(connectorId);
        if (store.needsRefresh(token) && typeof refresher === "function") {
          token = await rotate(connectorId, refresher, token);
        }
        observed.set(connectorId, token);
        return token;
      },
      async rotate(connectorId, refresher) {
        const token = await rotate(connectorId, refresher, observed.get(connectorId) ?? store.read(connectorId));
        observed.set(connectorId, token);
        return token;
      },
    });
  }

  async function ready(connectorId, refresher) {
    const before = store.read(connectorId) ?? await store.accessToken(connectorId);
    const token = await rotate(connectorId, refresher, before);
    // Readiness exists to keep the native qq process and this bridge from both
    // entering qq-models' two-minute refresh window after the wave barrier is
    // released. A refresh response can be structurally valid yet already fall
    // inside that window (for example, an unexpectedly short expires_in).
    // Failing closed here prevents an immediate cross-process lock race.
    if (!token || store.needsRefresh(token)) {
      throw fail("forced auth refresh did not produce a token outside the refresh window", 503, "authentication_error");
    }
    return { forced: true, refreshed: !sameAuth(before, token), fresh: true };
  }

  return Object.freeze({ requestStore, ready });
}

async function loadRuntime(args) {
  if (args.adapterModule) {
    const fixture = await import(pathToFileURL(resolve(args.adapterModule)));
    if (typeof fixture.createAdapter !== "function") throw fail("test adapter module must export createAdapter", 500);
    return {
      createAdapter: () => fixture.createAdapter(),
      authReady: typeof fixture.authReady === "function"
        ? fixture.authReady
        : async () => ({ forced: true, refreshed: false, fresh: true }),
    };
  }
  const root = resolve(args.modelsSource);
  const [{ createGrokAdapter }, { createAuthStore }, { refreshGrokToken }] = await Promise.all([
    import(pathToFileURL(`${root}/src/grok.mjs`)),
    import(pathToFileURL(`${root}/src/store.mjs`)),
    import(pathToFileURL(`${root}/src/oauth.mjs`)),
  ]);
  const store = createAuthStore({ env: process.env });
  if (!store.present(CONNECTOR)) throw fail("host xai-auth login is unavailable", 503, "authentication_error");
  const coordinator = createSingleFlightAuthCoordinator(store);
  return {
    createAdapter: () => createGrokAdapter({ store: coordinator.requestStore() }),
    authReady: () => coordinator.ready(CONNECTOR, (current) => refreshGrokToken(current)),
  };
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

function parseSyntheticKeys() {
  let clients;
  try { clients = JSON.parse(process.env.GROK_BENCH_BRIDGE_KEYS_JSON ?? ""); }
  catch { throw fail("GROK_BENCH_BRIDGE_KEYS_JSON must be a synthetic-key object", 500); }
  if (!clients || typeof clients !== "object" || Array.isArray(clients) || Object.keys(clients).length === 0) {
    throw fail("GROK_BENCH_BRIDGE_KEYS_JSON must be a synthetic-key object", 500);
  }
  for (const [name, key] of Object.entries(clients)) {
    if (!name || typeof key !== "string" || key.length < 32) throw fail("bridge client keys must be run-scoped synthetic keys", 500);
  }
  const admin = process.env.GROK_BENCH_BRIDGE_ADMIN_KEY;
  if (typeof admin !== "string" || admin.length < 32 || Object.values(clients).includes(admin)) {
    throw fail("GROK_BENCH_BRIDGE_ADMIN_KEY must be a distinct run-scoped synthetic key", 500);
  }
  if (new Set(Object.values(clients)).size !== Object.keys(clients).length) throw fail("bridge client keys must be distinct", 500);
  return { clients, admin };
}

function bearer(request) {
  const value = request.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : null;
}

function clientIdentity(request, clients) {
  const key = bearer(request);
  return Object.entries(clients).find(([, value]) => value === key)?.[0] ?? null;
}

function sendJson(response, status, value) {
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, { "content-type": "application/json", "content-length": encoded.length });
  response.end(encoded);
}

function errorJson(error) {
  return { error: { message: error?.message ?? "bridge request failed", type: error?.type ?? "api_error", code: null } };
}

function logWriter(path) {
  let tail = Promise.resolve();
  return (value) => {
    tail = tail.then(() => appendFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 }));
    return tail;
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const keys = parseSyntheticKeys();
  const runtime = await loadRuntime(args);
  await mkdir(dirname(resolve(args.readyFile)), { recursive: true, mode: 0o700 });
  await mkdir(dirname(resolve(args.log)), { recursive: true, mode: 0o700 });
  await writeFile(resolve(args.log), "", { mode: 0o600 });
  const appendLog = logWriter(resolve(args.log));

  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    const started = Date.now();
    let controls = null;
    let clientId = null;
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/_qq/auth/ready" && !url.search && !url.hash) {
        if (bearer(request) !== keys.admin) throw fail("invalid bridge credential", 401, "authentication_error");
        const readiness = await runtime.authReady();
        sendJson(response, 200, {
          schema: "qq.grok-xai-auth-readiness/v1", status: "ready", model: MODEL,
          forced: readiness?.forced === true, refreshed: readiness?.refreshed === true,
          fresh: readiness?.fresh === true,
        });
        await appendLog({
          request_id: requestId, event: "auth-readiness", model: MODEL, status: 200,
          forced: readiness?.forced === true, refreshed: readiness?.refreshed === true,
          fresh: readiness?.fresh === true, elapsed_ms: Date.now() - started,
        });
        return;
      }
      clientId = clientIdentity(request, keys.clients);
      if (!clientId) throw fail("invalid bridge credential", 401, "authentication_error");
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions" || url.search || url.hash) {
        throw fail("route not found", 404);
      }
      if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        throw fail("content-type must be application/json", 415);
      }
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
      const adapter = runtime.createAdapter();
      for await (const chunk of adapter.stream(options)) {
        if (chunk?.type === "text-delta") {
          const delta = String(chunk.text ?? "");
          text += delta;
          if (stream) response.write(`data: ${JSON.stringify(responseChunk(id, created, { content: delta }))}\n\n`);
        } else if (chunk?.type === "usage") usage = openAiUsage(chunk.usage);
        else if (chunk?.type === "finish") {
          finishSeen = true;
          const kind = chunk.reason?.kind;
          if (kind === "max-tokens") finishReason = "length";
          else if (kind === "error" || kind === "aborted" || kind === "interrupted" || kind === "blocked") {
            throw fail(chunk.reason?.failure?.message ?? `provider request ended with ${String(kind)}`, 502, "provider_error");
          } else if (kind === "tool-calls") throw fail("provider unexpectedly returned tool calls", 502, "provider_error");
          else if (kind !== "stop") throw fail(`provider returned unsupported finish reason ${String(kind)}`, 502, "provider_error");
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
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finishReason }], usage,
        });
      }
      await appendLog({
        request_id: requestId, client_id: clientId, model: MODEL, status: 200, controls, usage,
        elapsed_ms: Date.now() - started,
      });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (!response.headersSent) sendJson(response, status, errorJson(error));
      else response.end();
      await appendLog({
        request_id: requestId, ...(clientId ? { client_id: clientId } : {}), model: MODEL, status, controls,
        error_type: error?.type ?? "api_error", elapsed_ms: Date.now() - started,
      }).catch(() => {});
    }
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(args.port, args.host, accept);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : args.port;
  const ready = {
    schema: "qq.grok-xai-bridge-ready/v1", base_url: `http://127.0.0.1:${port}/v1`,
    auth_ready_url: `http://127.0.0.1:${port}/_qq/auth/ready`, pid: process.pid, model: MODEL,
    concurrent_requests: true,
  };
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
