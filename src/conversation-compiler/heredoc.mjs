import { BASH_CAP } from "./constants.mjs";
export const HEREDOC_OPEN_RE = /(?<![\w)])<<-?\s*["']?([A-Za-z_]\w*)["']?/;
const FILEWRITER_HEREDOC_RE = /^\s*(?:cat|tee|dd)\b/i;
const BODY_NOISE_RE = /^(?:#|\/\/|--|\/\*|\*|\*\/)/;
const HEREDOC_BODY_CAP = 80;

/** Return a real downstream terminator, or fail safe without swallowing lines. */
export const heredocCloseIndex = (lines, index) => {
  const heredoc = lines[index]?.match(HEREDOC_OPEN_RE);
  if (!heredoc) return -1;
  const terminator = heredoc[1];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (lines[cursor].trim() === terminator) return cursor;
  }
  return -1;
};

export const heredocBodyPreview = (lines, index, closeIndex) => {
  if (FILEWRITER_HEREDOC_RE.test(lines[index] ?? "")) return "";
  for (let cursor = index + 1; cursor < closeIndex; cursor += 1) {
    const text = lines[cursor].trim();
    if (!text || BODY_NOISE_RE.test(text)) continue;
    return text.length > HEREDOC_BODY_CAP ? `${text.slice(0, HEREDOC_BODY_CAP - 1)}…` : text;
  }
  return "";
};

export const isFileWriterHeredoc = (line) => FILEWRITER_HEREDOC_RE.test(String(line ?? ""));
