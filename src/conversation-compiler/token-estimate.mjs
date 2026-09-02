import {
  DEFAULT_CHARS_PER_TOKEN,
  IMAGE_CONTENT_CHARS,
  MAX_CHARS_PER_TOKEN,
  MIN_CHARS_PER_TOKEN,
} from "./constants.mjs";

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export const calibrateCharsPerToken = (sourceChars, sourceTokens) => {
  if (!sourceTokens || sourceTokens <= 0 || sourceChars <= 0) return { mode: "heuristic", charsPerToken: DEFAULT_CHARS_PER_TOKEN };
  const rawCharsPerToken = sourceChars / sourceTokens;
  if (!Number.isFinite(rawCharsPerToken) || rawCharsPerToken <= 0) return { mode: "heuristic", charsPerToken: DEFAULT_CHARS_PER_TOKEN };
  return {
    mode: "calibrated",
    charsPerToken: clamp(rawCharsPerToken, MIN_CHARS_PER_TOKEN, MAX_CHARS_PER_TOKEN),
    sourceChars,
    sourceTokens,
    rawCharsPerToken,
  };
};

export const estimateTokensFromChars = (chars, charsPerToken = DEFAULT_CHARS_PER_TOKEN) => Math.ceil(chars / charsPerToken);
const safeJsonStringify = (value) => {
  try { return JSON.stringify(value ?? "") ?? ""; } catch { return ""; }
};

export const estimateMessageContentChars = (content) => {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, part) => {
    if (!part || typeof part !== "object") return sum;
    switch (part.type) {
      case "text": return sum + (typeof part.text === "string" ? part.text.length : 0);
      case "thinking": return sum + (typeof part.thinking === "string" ? part.thinking.length : 0);
      case "reasoning": return sum + (typeof part.text === "string" ? part.text.length : 0);
      case "toolCall":
      case "tool-call": {
        const args = part.arguments ?? part.input;
        const argumentLength = typeof args === "string" ? args.length : safeJsonStringify(args).length;
        return sum + (part.name?.length ?? 0) + argumentLength;
      }
      case "toolResult":
      case "tool-result": {
        const value = part.content;
        return sum + (typeof value === "string" ? value.length : safeJsonStringify(value).length);
      }
      case "image": return sum + IMAGE_CONTENT_CHARS;
      default: return sum + (typeof part.text === "string" ? part.text.length : 0);
    }
  }, 0);
};

export const estimateMessageContentTokens = (content, charsPerToken = DEFAULT_CHARS_PER_TOKEN) =>
  estimateTokensFromChars(estimateMessageContentChars(content), charsPerToken);

export { DEFAULT_CHARS_PER_TOKEN, IMAGE_CONTENT_CHARS, MAX_CHARS_PER_TOKEN, MIN_CHARS_PER_TOKEN };
