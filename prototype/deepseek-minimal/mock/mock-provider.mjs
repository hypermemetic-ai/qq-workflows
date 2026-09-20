/**
 * Deterministic local DeepSeek provider double for the prototype.
 *
 * It implements exactly the two endpoints the pinned harness touches on the
 * Messages protocol — `POST /v1/messages` (SSE) and the Files API under
 * `/v1/files` — plus a request journal that is the prototype's wire receipt.
 * No real credential is read, accepted, or recorded: the only key it ever sees
 * is the dummy the adapter injects, and receipts store a boolean, never a value.
 *
 * @module mock/mock-provider
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { decodePng } from "./png.mjs";

const DUMMY_KEY = "prototype-dummy-key";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Split a multipart/form-data body into its parts (fields and files). */
function parseMultipart(body, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/u.exec(contentType ?? "");
  if (boundaryMatch === null) return [];
  const boundary = Buffer.from(`--${boundaryMatch[1] ?? boundaryMatch[2]}`);
  const parts = [];
  let cursor = body.indexOf(boundary);
  while (cursor !== -1) {
    const headerStart = cursor + boundary.length;
    if (body.subarray(headerStart, headerStart + 2).toString() === "--") break;
    const headerEnd = body.indexOf("\r\n\r\n", headerStart);
    if (headerEnd === -1) break;
    const headers = body.subarray(headerStart + 2, headerEnd).toString("utf8");
    const next = body.indexOf(boundary, headerEnd);
    if (next === -1) break;
    const data = body.subarray(headerEnd + 4, next - 2); // strip trailing CRLF
    const name = /name="([^"]*)"/u.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/u.exec(headers)?.[1];
    const type = /content-type:\s*([^\r\n]+)/iu.exec(headers)?.[1];
    parts.push({ name, filename, contentType: type, data });
    cursor = next;
  }
  return parts;
}

/** Build one Anthropic-style Messages SSE frame sequence for a scripted turn. */
function turnEvents({ model, blocks, stopReason, requestIndex }) {
  const events = [{
    type: "message_start",
    message: {
      id: `msg_proto_${requestIndex}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      usage: { input_tokens: 32, output_tokens: 0 },
    },
  }];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
    } else if (block.type === "tool_use") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id ?? `toolu_proto_${requestIndex}_${index}`, name: block.name, input: {} },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
      });
    } else {
      throw new Error(`mock: unsupported scripted block ${JSON.stringify(block.type)}`);
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 64 } });
  events.push({ type: "message_stop" });
  return events;
}

function sseFrame(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function textOf(blocks) {
  return (blocks ?? [])
    .filter(block => block?.type === "text")
    .map(block => block.text)
    .join("");
}

/** Project every image block in the request body, decoding inline bytes for the receipt. */
function imageReceipts(body) {
  const images = [];
  const scan = (content) => {
    for (const block of content ?? []) {
      // Images ride inside tool results on the Messages wire, so walk nested content.
      if (block?.type === "tool_result" || block?.type === "tool-result") {
        scan(block.content);
        continue;
      }
      if (block?.type !== "image") continue;
      const source = block.source ?? {};
      if (source.type === "file") {
        images.push({ source: "file", fileId: source.file_id, mediaType: null, decodable: null });
      } else if (source.type === "base64") {
        const bytes = Buffer.from(String(source.data ?? ""), "base64");
        const png = decodePng(bytes);
        images.push({
          source: "base64",
          fileId: null,
          mediaType: source.media_type ?? null,
          dataBytes: bytes.length,
          dataSha256: sha256(bytes),
          decodable: png !== undefined,
          ...(png === undefined ? {} : { width: png.width, height: png.height }),
        });
      } else {
        images.push({ source: source.type ?? "unknown" });
      }
    }
  };
  for (const message of body.messages ?? []) scan(message.content);
  return images;
}

/**
 * Start the scripted provider.
 * @param options.scenario - scripted turns, files behavior, and optional request checker.
 * @param options.host - bind host (defaults to loopback).
 * @returns mock handle: url, journal, close(), receipt(), uploads.
 */
export async function startMockProvider(options = {}) {
  const scenario = options.scenario ?? {};
  const host = options.host ?? "127.0.0.1";
  const journal = [];
  const uploads = [];
  let messageTurns = 0;
  let fileCounter = 0;

  const record = (entry) => {
    journal.push(entry);
    return entry;
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      void handle(req, res, raw).catch((error) => {
        record({ kind: "mock-error", message: error.message });
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "api_error", message: error.message } }));
      });
    });
  });

  async function handle(req, res, raw) {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname === "/v1/files" && req.method === "POST") {
      const parts = parseMultipart(raw, req.headers["content-type"]);
      const file = parts.find(part => part.name === "file");
      if (scenario.filesMode === "error") {
        record({ kind: "files-upload", outcome: "error", bytes: file?.data.length ?? 0 });
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "api_error", message: "prototype Files API unavailable" } }));
        return;
      }
      if (file === undefined) {
        record({ kind: "files-upload", outcome: "malformed" });
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "missing file part" } }));
        return;
      }
      const png = decodePng(file.data);
      const id = `file_proto_${(fileCounter += 1)}`;
      const upload = {
        kind: "files-upload",
        outcome: "ok",
        fileId: id,
        filename: file.filename,
        mediaType: file.contentType,
        bytes: file.data.length,
        sha256: sha256(file.data),
        decodable: png !== undefined,
        ...(png === undefined ? {} : { width: png.width, height: png.height }),
        expiresAfterSeconds: parts.find(part => part.name === "expires_after[seconds]")?.data.toString(),
      };
      uploads.push({ id, bytes: file.data, mediaType: file.contentType, upload });
      record(upload);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id,
        type: "file",
        mime_type: file.contentType ?? "application/octet-stream",
        size_bytes: file.data.length,
        created_at: new Date(0).toISOString(),
        filename: file.filename ?? "upload.bin",
      }));
      return;
    }

    if (url.pathname === "/v1/files" && req.method === "GET") {
      record({ kind: "files-list" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [], has_more: false }));
      return;
    }

    if (url.pathname === "/v1/messages" && req.method === "POST") {
      const body = JSON.parse(raw.toString("utf8"));
      const toolList = body.tools ?? [];
      const tools = toolList.map(tool => tool.name).sort();
      // Descriptions are recorded so a test can prove the model receives the
      // gateway's official tool text (never authored prose) through the real
      // pinned bridge.
      const toolDescriptions = Object.fromEntries(
        toolList.map(tool => [tool.name, typeof tool.description === "string" ? tool.description : null]),
      );
      const isTitle = scenario.titleRequest?.(body) ?? (body.output_config === undefined
        && body.thinking?.type === "disabled"
        && (body.tools ?? []).length === 0);
      const images = imageReceipts(body);
      const toolResults = [];
      for (const message of body.messages ?? []) {
        for (const block of message.content ?? []) {
          if (block?.type === "tool_result") toolResults.push({ toolUseId: block.tool_use_id, text: textOf(block.content).slice(0, 600) });
        }
      }
      const entry = record({
        kind: isTitle ? "messages-title" : "messages",
        index: isTitle ? null : messageTurns,
        model: body.model,
        stream: body.stream,
        effort: body.output_config?.effort ?? null,
        thinking: body.thinking?.type ?? null,
        maxTokens: body.max_tokens,
        toolNames: tools,
        toolDescriptions,
        hasImage: images.length > 0,
        images,
        toolResults,
        apiKeyIsDummy: req.headers["x-api-key"] === DUMMY_KEY,
        apiVersion: req.headers["anthropic-version"] ?? null,
        systemPromptLength: String(body.system ?? "").length,
        systemPromptHead: String(body.system ?? "").slice(0, 120),
        systemPromptMentionsCompletionTool: /complete_task|mcp__/u.test(String(body.system ?? "")),
        systemPromptSha256: sha256(Buffer.from(String(body.system ?? ""))),
        bodySha256: sha256(raw),
        bodyBytes: raw.length,
      });

      const failure = scenario.check?.(entry, journal);
      if (failure) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "invalid_request_error", message: failure } }));
        return;
      }

      const turn = isTitle
        ? { blocks: [{ type: "text", text: "prototype session" }], stopReason: "end_turn" }
        : (scenario.turns ?? [])[messageTurns];
      if (turn === undefined) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "invalid_request_error", message: `mock: no scripted turn ${messageTurns}` } }));
        return;
      }
      if (!isTitle) messageTurns += 1;

      if (scenario.holdOpenMs !== undefined && !isTitle) await new Promise(resolve => setTimeout(resolve, scenario.holdOpenMs));
      if (turn.error !== undefined) {
        // Scripted provider failure: the harness must classify the turn as failed.
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(sseFrame({ type: "error", error: { type: "api_error", message: turn.error.message ?? "scripted provider failure" } }));
        res.end();
        return;
      }
      const events = turnEvents({
        model: body.model,
        blocks: turn.blocks,
        stopReason: turn.stopReason ?? (turn.blocks.some(block => block.type === "tool_use") ? "tool_use" : "end_turn"),
        requestIndex: messageTurns,
      });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const event of events) res.write(sseFrame(event));
      res.end();
      return;
    }

    record({ kind: "unexpected-request", method: req.method, path: url.pathname });
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "not_found_error", message: `mock: no route for ${req.method} ${url.pathname}` } }));
  }

  await new Promise((resolve) => server.listen(options.port ?? 0, host, resolve));
  const address = server.address();
  const url = `http://${host}:${address.port}`;
  return {
    url,
    port: address.port,
    journal,
    uploads,
    get messageRequests() {
      return journal.filter(entry => entry.kind === "messages");
    },
    get lastMessageRequest() {
      return this.messageRequests.at(-1);
    },
    async close() {
      await new Promise(resolve => server.close(resolve));
    },
    /** Secret-free receipt: journal plus upload digests and the mock's own identity. */
    receipt() {
      return {
        mockUrl: url,
        recordedAt: new Date().toISOString(),
        nonce: randomUUID(),
        requests: journal,
        uploads: uploads.map(upload => upload.upload),
      };
    },
  };
}

export const DUMMY_API_KEY = DUMMY_KEY;
