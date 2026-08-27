// One model-visible observation budget shared by architect, Mini, and reviewer.
// Count Unicode code points so astral characters are never split.

export const OBSERVATION_MAX_CHARS = 10_000;
export const OBSERVATION_HEAD_CHARS = 5_000;
export const OBSERVATION_TAIL_CHARS = 5_000;

const TRUNCATION_MARKER_PATTERN = /\n\[\.\.\. environment output truncated: \d+ chars omitted \.\.\.\]\n/;

export function codePointCount(value) {
  let count = 0;
  for (const _ of String(value ?? "")) count++;
  return count;
}

export function sliceCodePoints(value, start, end) {
  return Array.from(String(value ?? "")).slice(start, end).join("");
}

export function truncationMarker(omittedChars) {
  return `\n[... environment output truncated: ${omittedChars} chars omitted ...]\n`;
}

export function isTruncatedObservation(value) {
  const text = String(value ?? "");
  const match = TRUNCATION_MARKER_PATTERN.exec(text);
  if (!match) return false;
  return codePointCount(text.slice(0, match.index)) === OBSERVATION_HEAD_CHARS
    && codePointCount(text.slice(match.index + match[0].length)) === OBSERVATION_TAIL_CHARS;
}

export function truncateObservation(value) {
  const text = String(value ?? "");
  if (isTruncatedObservation(text)) return text;
  const chars = codePointCount(text);
  if (chars < OBSERVATION_MAX_CHARS) return text;
  return `${sliceCodePoints(text, 0, OBSERVATION_HEAD_CHARS)}${truncationMarker(chars - OBSERVATION_MAX_CHARS)}${sliceCodePoints(text, -OBSERVATION_TAIL_CHARS)}`;
}

/** Cap all text in one tool result as one independent observation. */
export function truncateObservationContent(content) {
  if (!Array.isArray(content)) return content;
  const textBlocks = content.filter((block) => block?.type === "text" && typeof block.text === "string");
  if (textBlocks.length === 0) return content;
  const text = textBlocks.map((block) => block.text).join("");
  const truncated = truncateObservation(text);
  if (truncated === text) return content;
  if (textBlocks.length === 1) {
    return content.map((block) => block === textBlocks[0] ? { ...block, text: truncated } : block);
  }

  const total = codePointCount(text);
  const tailStart = total - OBSERVATION_TAIL_CHARS;
  const marker = truncationMarker(total - OBSERVATION_MAX_CHARS);
  const capped = [];
  let offset = 0;
  let markerAdded = false;
  for (const block of content) {
    if (block?.type !== "text" || typeof block.text !== "string") {
      capped.push(block);
      continue;
    }
    const length = codePointCount(block.text);
    const end = offset + length;
    const headLength = Math.max(0, Math.min(length, OBSERVATION_HEAD_CHARS - offset));
    const tailOffset = Math.max(0, tailStart - offset);
    if (headLength > 0) capped.push({ ...block, text: sliceCodePoints(block.text, 0, headLength) });
    if (!markerAdded && end >= OBSERVATION_HEAD_CHARS) {
      capped.push({ type: "text", text: marker });
      markerAdded = true;
    }
    if (end > tailStart) capped.push({ ...block, text: sliceCodePoints(block.text, tailOffset) });
    offset = end;
  }
  if (!markerAdded) capped.push({ type: "text", text: marker });
  return capped;
}

const OBSERVATION_CAPPED_TOOL = Symbol.for("qq.workflows.observationCappedTool");

/** Cap a definition at both DSH output seams without changing its call contract. */
export function capObservationTool(definition) {
  if (!definition || definition[OBSERVATION_CAPPED_TOOL] === true) return definition;
  const output = definition.output && typeof definition.output.render === "function"
    ? {
        ...definition.output,
        render(args, value) {
          return truncateObservationContent(definition.output.render(args, value));
        },
      }
    : definition.output;
  return {
    ...definition,
    [OBSERVATION_CAPPED_TOOL]: true,
    ...(output ? { output } : {}),
    finalizeContent(exec, result) {
      const finalized = typeof definition.finalizeContent === "function"
        ? definition.finalizeContent(exec, result)
        : undefined;
      return truncateObservationContent(finalized === undefined ? result?.content : finalized);
    },
  };
}
