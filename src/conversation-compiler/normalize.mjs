import { WRAP_COLUMNS } from "./constants.mjs";

/** Normalize newlines and horizontal whitespace without destroying paragraph boundaries. */
export function normalizeText(value) {
  return String(value ?? "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.replaceAll(/[\t ]+/g, " ").trim())
    .join("\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
}

/** Reference-style significant words: punctuation around a token is not counted. */
export function significantWords(value) {
  return String(value ?? "").match(/[\p{L}\p{N}_./:@%+="'-]+/gu) ?? [];
}

export function truncateWords(value, head, tail = 0) {
  const text = normalizeText(value).replaceAll(/\s+/g, " ");
  const matches = [...text.matchAll(/[\p{L}\p{N}_./:@%+="'-]+/gu)];
  if (matches.length <= head + tail) return text;
  const headMatch = matches[Math.max(0, head - 1)];
  const headEnd = headMatch.index + headMatch[0].length;
  if (tail <= 0) return `${text.slice(0, headEnd).trimEnd()} …`;
  const tailStart = matches[matches.length - tail].index;
  return `${text.slice(0, headEnd).trimEnd()} … ${text.slice(tailStart).trimStart()}`;
}

/** Replace heredoc payloads, retaining the command, delimiter, and following commands. */
export function compressHeredoc(value) {
  const lines = String(value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (!match) {
      output.push(line);
      continue;
    }
    const delimiter = match[2];
    let end = index + 1;
    while (end < lines.length && lines[end].trim() !== delimiter) end += 1;
    if (end >= lines.length) {
      output.push(line);
      continue;
    }
    output.push(line, `… ${Math.max(0, end - index - 1)} lines omitted …`, lines[end]);
    index = end;
  }
  return output.join("\n");
}

export function oneLine(value) {
  return normalizeText(value).replaceAll(/\s+/g, " ");
}

/** Deterministic hard wrapping; long unbroken identifiers are split rather than exceeding the contract. */
export function wrapLine(value, width = WRAP_COLUMNS, continuation = "  ") {
  const text = String(value ?? "");
  if (text.length <= width) return text;
  const lines = [];
  let remaining = text;
  let prefix = "";
  while (remaining.length + prefix.length > width) {
    const room = Math.max(1, width - prefix.length);
    let cut = remaining.lastIndexOf(" ", room);
    if (cut < Math.floor(room / 2)) cut = room;
    lines.push(prefix + remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
    prefix = continuation;
  }
  lines.push(prefix + remaining);
  return lines.join("\n");
}

export function wrapParagraphs(value, width = WRAP_COLUMNS) {
  return String(value ?? "").split("\n").map((line) => wrapLine(line, width)).join("\n");
}

export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export function normalizedKey(value) {
  return oneLine(value).toLocaleLowerCase();
}

export function unique(values, key = normalizedKey) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const identity = key(value);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    result.push(value);
  }
  return result;
}
