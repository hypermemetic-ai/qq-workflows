/** Clip a string without allowing an adversarial unbroken value to escape a cap. */
export const clip = (text, max = 200) => {
  const value = String(text ?? "").trim();
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, Math.max(0, max));
  return `${value.slice(0, max - 3).trimEnd()}...`;
};

/** Prefer a sentence boundary, then a word boundary, before the hard clip. */
export const clipSentence = (text, max = 200) => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;
  const window = value.slice(0, Math.max(0, max - 3));
  const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (sentence >= Math.floor(max * 0.45)) return `${window.slice(0, sentence + 1).trimEnd()}...`;
  const space = window.lastIndexOf(" ");
  const end = space >= Math.floor(max * 0.45) ? space : window.length;
  return `${window.slice(0, end).trimEnd()}...`;
};

export const nonEmptyLines = (text) =>
  String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);

export const firstLine = (text, max = 200) => clip(nonEmptyLines(text)[0] ?? "", max);

export const textParts = (content) => {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const result = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") result.push(part.text);
    else if ((part?.type === "toolResult" || part?.type === "tool-result") && part.content != null) {
      result.push(...textParts(part.content));
    }
  }
  return result;
};

export const textOf = (content) => textParts(content).join("\n");

const CONTENT_KEYS = new Set([
  "content", "text", "newText", "oldText", "new_string", "old_string", "patch", "diff", "edits",
]);

export const isContentBearing = (args) => {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  return Object.keys(args).some((key) => CONTENT_KEYS.has(key));
};

const safeString = (value) => {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value ?? "") ?? ""; } catch { return ""; }
};

/** Bounded text used by the upstream recall index; retained as a pure helper. */
export const extractToolCallText = (args) => {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const parts = [];
  for (const [key, value] of Object.entries(args)) {
    if (!CONTENT_KEYS.has(key)) continue;
    const text = safeString(value).trim();
    if (text) parts.push(text);
  }
  return parts.join("\n");
};

export const extractToolCallArgsText = (args) => {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const parts = [];
  for (const value of Object.values(args)) {
    const text = safeString(value).trim();
    if (text) parts.push(text);
  }
  return parts.join("\n");
};

export const snippet = (text, term, radius = 60) => {
  const source = String(text ?? "");
  const needle = String(term ?? "").toLowerCase();
  if (!needle) return null;
  const index = source.toLowerCase().indexOf(needle);
  if (index < 0) return null;
  const start = Math.max(0, index - radius);
  const end = Math.min(source.length, index + needle.length + radius);
  return `${start > 0 ? "..." : ""}${source.slice(start, end).trim()}${end < source.length ? "..." : ""}`;
};
