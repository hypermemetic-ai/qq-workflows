import { TUI_SAFE_LINE_CHARS } from "./constants.mjs";
import { textOf } from "./content.mjs";
import { sanitize } from "./sanitize.mjs";
import { parseToolArgs } from "./tool-args.mjs";

const sourceIndexOf = (message, messageIndex) =>
  Number.isSafeInteger(message?.seq) && message.seq >= 0 ? message.seq : messageIndex;

const normalizeOne = (message, messageIndex) => {
  const sourceIndex = sourceIndexOf(message, messageIndex);
  if (message?.role === "user") {
    const blocks = [];
    const text = sanitize(textOf(message.content));
    if (text) blocks.push({ kind: "user", text, sourceIndex });
    if (message.content && typeof message.content !== "string") {
      for (const part of message.content) {
        if (part?.type === "image") {
          blocks.push({ kind: "user", text: `[image: ${part.mimeType}]`, sourceIndex });
        }
      }
    }
    return blocks.length > 0 ? blocks : [{ kind: "user", text: "", sourceIndex }];
  }

  if (message?.role === "bashExecution") {
    const command = message.command ?? "";
    const output = message.output ?? "";
    return [{ kind: "bash", command, output, exitCode: message.exitCode, sourceIndex }];
  }

  if (message?.role === "toolResult" || message?.role === "tool-result") {
    return [{
      kind: "tool_result",
      name: message.toolName ?? message.name ?? "",
      text: sanitize(textOf(message.content)),
      sourceIndex,
    }];
  }

  if (message?.role === "assistant") {
    if (!message.content) return [];
    if (typeof message.content === "string") {
      return [{ kind: "assistant", text: sanitize(message.content), sourceIndex }];
    }
    const blocks = [];
    for (const part of message.content) {
      if (part?.type === "text") {
        blocks.push({ kind: "assistant", text: sanitize(part.text), sourceIndex });
      } else if (part?.type === "toolCall" || part?.type === "tool-call") {
        blocks.push({
          kind: "tool_call",
          name: typeof part.name === "string" ? part.name : "",
          args: parseToolArgs(part.arguments ?? part.input),
          sourceIndex,
        });
      }
    }
    return blocks;
  }
  return [];
};

export const normalize = (messages) =>
  (Array.isArray(messages) ? messages : []).flatMap((message, index) => normalizeOne(message, index));

// Compatibility helpers retained for callers of the landed module surface.
export const normalizeText = (value) => sanitize(value)
  .split("\n")
  .map((line) => line.replace(/[\t ]+/g, " ").trim())
  .join("\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

export const significantWords = (value) => String(value ?? "").match(/[\p{L}\p{N}_./:@%+="'-]+/gu) ?? [];

export const oneLine = (value) => normalizeText(value).replace(/\s+/g, " ");
export const normalizedKey = (value) => oneLine(value).toLowerCase();

export const stableJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
};

export const unique = (values, key = normalizedKey) => {
  const result = [];
  const seen = new Set();
  for (const value of values ?? []) {
    const identity = key(value);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    result.push(value);
  }
  return result;
};

export const wrapLine = (value, width = TUI_SAFE_LINE_CHARS, continuation = "  ") => {
  const text = String(value ?? "");
  if (text.length <= width) return text;
  const lines = [];
  let remaining = text;
  let prefix = "";
  while (remaining && prefix.length + remaining.length > width) {
    const available = Math.max(20, width - prefix.length);
    let splitAt = remaining.lastIndexOf(" ", available);
    if (splitAt < Math.floor(available * 0.5)) splitAt = available;
    lines.push(prefix + remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
    prefix = continuation;
  }
  if (remaining) lines.push(prefix + remaining);
  return lines.join("\n");
};

export const wrapParagraphs = (value, width = TUI_SAFE_LINE_CHARS) =>
  String(value ?? "").split("\n").map((line) => wrapLine(line, width)).join("\n");
