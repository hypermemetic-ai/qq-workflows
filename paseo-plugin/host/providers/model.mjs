import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTextGuard } from './text-loop.mjs';

export const ARCHITECT_MODEL = "gpt-6-astra";
export const ARCHITECT_REASONING = "high";

export async function loadCodexAuth({ readFileFn = readFile, home = homedir() } = {}) {
  const path = join(home, ".codex", "auth.json");
  const raw = JSON.parse(await readFileFn(path, "utf8"));
  const tokens = raw?.tokens ?? {};
  return {
    accessToken: tokens.access_token ?? null,
    accountId: tokens.account_id ?? null,
    authMode: raw?.auth_mode ?? null,
  };
}

export function responsesHeaders(auth) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (process.env.OPENAI_API_KEY) {
    headers.Authorization = `Bearer ${process.env.OPENAI_API_KEY}`;
    return { headers, url: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1/responses" };
  }
  if (!auth?.accessToken) throw new Error("no Codex or OPENAI_API_KEY credentials");
  headers.Authorization = `Bearer ${auth.accessToken}`;
  if (auth.accountId) headers["ChatGPT-Account-ID"] = auth.accountId;
  headers["OpenAI-Beta"] = "responses=experimental";
  headers.originator = "codex_cli_rs";
  return {
    headers,
    url: process.env.CODEX_RESPONSES_URL || "https://chatgpt.com/backend-api/codex/responses",
  };
}

export function toResponsesTools(tools) {
  return (tools ?? []).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? tool.inputSchema ?? { type: "object", properties: {} },
    strict: false,
  }));
}

export async function completeArchitect({
  instructions,
  input,
  tools = [],
  model = ARCHITECT_MODEL,
  reasoning = ARCHITECT_REASONING,
  fetchFn = fetch,
  auth = null,
  onDelta,
  signal,
  checkpoint,
} = {}) {
  const resolvedAuth = auth ?? (process.env.OPENAI_API_KEY ? null : await loadCodexAuth());
  const { headers, url } = responsesHeaders(resolvedAuth);
  const body = {
    model,
    instructions,
    input,
    tools: toResponsesTools(tools),
    store: false,
    stream: true,
    reasoning: { effort: reasoning },
  };
  signal?.throwIfAborted();
  await checkpoint?.("request", body);
  signal?.throwIfAborted();
  const response = await fetchFn(url, {
    signal,
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw Object.assign(new Error(`architect model HTTP ${response.status}: ${text}`), { status: response.status, retryAfter: response.headers?.get?.("retry-after") });
  }
  const acc = createResponsesAccumulator({ onDelta });
  await readSseEvents(response, (event) => acc.push(event));
  signal?.throwIfAborted();
  const result = acc.result();
  await checkpoint?.("response", result);
  return result;
}

export function parseSseJsonEvents(text) {
  const events = [];
  for (const block of String(text ?? "").split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      /* Codex status events can exceed a single SSE buffer; skip truncated JSON. */
    }
  }
  return events;
}

export function createResponsesAccumulator({ onDelta } = {}) {
  const textGuard = createTextGuard();
  const items = [];
  const textParts = [];
  const calls = new Map();
  let completed = null;
  let failed = null;

  function keyFor(event, item) {
    if (event?.output_index != null) return `i:${event.output_index}`;
    if (item?.id) return `id:${item.id}`;
    if (event?.item_id) return `id:${event.item_id}`;
    return `n:${calls.size}`;
  }

  return {
    async push(event) {
      const type = event?.type;
      if (type === "response.output_text.delta" && event.delta) {
        textGuard.push(event.delta);
        textParts.push(event.delta);
        await onDelta?.(event.delta);
        return;
      }
      if (type === "response.output_item.added" && event.item?.type === "function_call") {
        calls.set(keyFor(event, event.item), { ...event.item, arguments: event.item.arguments ?? "" });
        return;
      }
      if (type === "response.function_call_arguments.delta") {
        const call = calls.get(keyFor(event, event.item));
        if (call) call.arguments = `${call.arguments ?? ""}${event.delta ?? ""}`;
        return;
      }
      if (type === "response.function_call_arguments.done") {
        const call = calls.get(keyFor(event, event.item));
        if (call && event.arguments != null) call.arguments = event.arguments;
        return;
      }
      if (type === "response.output_item.done" && event.item) {
        items.push(event.item);
        return;
      }
      if (type === "response.failed") {
        failed = event.response?.error?.message ?? "architect model failed";
        return;
      }
      if (type === "error") {
        failed = event.message ?? JSON.stringify(event);
        return;
      }
      if (type === "response.incomplete") { failed = `Context exhaustion or incomplete response: ${JSON.stringify(event.response?.incomplete_details)}`; return; }
      if (type === "response.completed" || type === "response.done") {
        completed = event.response ?? null;
      }
    },
    result() {
      if (failed) throw new Error(failed);
      if (!completed || (completed.status && completed.status !== "completed")) throw new Error("incomplete model response: completion event missing");
      if (Array.isArray(completed?.output) && completed.output.length) {
        return parseResponsesBody(completed);
      }
      return parseResponsesBody({ ...completed, output: items });
    },
  };
}

async function readSseEvents(response, onEvent) {
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = await flushSseBuffer(buffer, onEvent);
    }
    buffer += decoder.decode();
    await flushSseBuffer(`${buffer}\n\n`, onEvent);
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return;
  }
  const text = await response.text();
  for (const event of parseSseJsonEvents(text)) await onEvent(event);
}

async function flushSseBuffer(buffer, onEvent) {
  let rest = buffer;
  let separator = /\r?\n\r?\n/.exec(rest);
  while (separator) {
    const block = rest.slice(0, separator.index);
    rest = rest.slice(separator.index + separator[0].length);
    for (const event of parseSseJsonEvents(block)) await onEvent(event);
    separator = /\r?\n\r?\n/.exec(rest);
  }
  return rest;
}

export function parseResponsesBody(payload) {
  if (payload?.status && payload.status !== "completed") throw new Error("incomplete model response");
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const textParts = [];
  const toolCalls = [];
  for (const item of output) {
    if (item?.type === "message") {
      for (const part of item.content ?? []) {
        if (typeof part?.text === "string") textParts.push(part.text);
      }
    } else if (item?.type === "function_call" || item?.type === "tool_call") {
      toolCalls.push({
        id: item.call_id ?? item.id ?? `call_${toolCalls.length + 1}`,
        name: item.name,
        arguments: parseArgs(item.arguments),
      });
    }
  }
  if (textParts.length === 0 && typeof payload?.output_text === "string") {
    textParts.push(payload.output_text);
  }
  return {
    text: textParts.join(""),
    toolCalls,
    functionCalls: output.filter((item) => item?.type === "function_call" || item?.type === "tool_call"),
    raw: payload,
  };
}

function parseArgs(value) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid tool arguments");
  return parsed;
}
