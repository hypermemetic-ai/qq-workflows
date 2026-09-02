import {
  ASSISTANT_HEAD_WORDS,
  ASSISTANT_TAIL_WORDS,
  BASH_CAP,
  SEGMENT_CLOSING_ASSISTANT_HEAD_WORDS,
  SEGMENT_CLOSING_ASSISTANT_TAIL_WORDS,
  TOOL_CALLS_PER_TURN,
  TRUNCATE_USER,
} from "./constants.mjs";
import { clip } from "./content.mjs";
import { extractPath } from "./tool-args.mjs";
import { collapseSkillText } from "./skill-collapse.mjs";
import { HEREDOC_OPEN_RE, heredocBodyPreview, heredocCloseIndex } from "./heredoc.mjs";

export { HEREDOC_OPEN_RE, heredocCloseIndex } from "./heredoc.mjs";

const SELF_TALK_PREFIX_RE = /^\s*(?:hmm|wait|actually|oh|okay|ok|well|so)[,.!\s-]+/i;
const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const isWord = (segment) => segment.isWordLike || /[\p{L}\p{N}]/u.test(segment.segment);
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "between", "under", "over",
  "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
  "neither", "each", "every", "all", "any", "few", "more", "most",
  "other", "some", "such", "no",
  "that", "this", "these", "those", "it", "its",
  "i", "me", "my", "we", "our", "you", "your", "he", "him", "his",
  "she", "her", "they", "them", "their", "who", "which", "what",
  "if", "then", "than", "when", "where", "how", "just", "also",
]);

const normalizeForTokenBudget = (text) => String(text ?? "")
  .replace(/\r\n?/g, "\n")
  .replace(/[^\S\n]+/g, " ")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

export const truncateTokens = (text, limit) => {
  const flat = normalizeForTokenBudget(text);
  let count = 0;
  let lastEnd = 0;
  for (const segment of segmenter.segment(flat)) {
    if (isWord(segment) && !STOP_WORDS.has(segment.segment.toLowerCase())) {
      count += 1;
      if (count > limit) return `${flat.slice(0, lastEnd).trimEnd()}...(truncated)`;
    }
    lastEnd = segment.index + segment.segment.length;
  }
  return flat;
};

const significantWordSpans = (flat) => {
  const words = [];
  for (const segment of segmenter.segment(flat)) {
    if (!isWord(segment) || STOP_WORDS.has(segment.segment.toLowerCase())) continue;
    words.push({ start: segment.index, end: segment.index + segment.segment.length });
  }
  return words;
};

export const truncateTokensHeadTail = (text, headLimit, tailLimit) => {
  const flat = normalizeForTokenBudget(text);
  if (headLimit <= 0 || tailLimit <= 0) return flat;
  const words = significantWordSpans(flat);
  if (words.length <= headLimit + tailLimit) return flat;
  const head = flat.slice(0, words[headLimit - 1].end).trimEnd();
  const tail = flat.slice(words[words.length - tailLimit].start).trimStart();
  return `${head}\n...(middle truncated)...\n${tail}`;
};

const nextRenderableBlock = (blocks, index) => {
  for (let cursor = index + 1; cursor < blocks.length; cursor += 1) {
    if (blocks[cursor].kind !== "tool_result") return blocks[cursor];
  }
  return undefined;
};

const isSegmentClosingAssistant = (blocks, index) =>
  blocks[index]?.kind === "assistant" && (!nextRenderableBlock(blocks, index) || nextRenderableBlock(blocks, index).kind === "user");

const PIPE_TAIL_RE = /\s*\|\s*(?:head|tail|sort|wc|column|tr|cut|awk|uniq|python3|node|bun)(?:\s[^|]*)?$/;
const TRIVIAL_LINE_RE = /^(?:set\s+[-+]|cd\s+\S+$|export\s+\w+=|(?:source|\.)\s+\S+|pwd$|true$|:$|#)/;
const stripCdPrefix = (line) => line.replace(/^cd\s+\S+\s*&&\s*/, "").trim();
const stripPipeTail = (line) => {
  let command = line;
  for (let index = 0; index < 3; index += 1) {
    const stripped = command.replace(PIPE_TAIL_RE, "");
    if (stripped === command) break;
    command = stripped;
  }
  return command.trim();
};

export const compressBash = (raw) => {
  const rawLines = String(raw ?? "").split("\n");
  const withoutHeredocBodies = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index];
    withoutHeredocBodies.push(line);
    const close = heredocCloseIndex(rawLines, index);
    if (close === -1) continue;
    const preview = heredocBodyPreview(rawLines, index, close);
    if (preview) withoutHeredocBodies[withoutHeredocBodies.length - 1] = `${line.trim()} ${preview}`;
    index = close;
  }
  const lines = withoutHeredocBodies.map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return String(raw ?? "").trim();
  const meaningful = lines
    .filter((line) => !TRIVIAL_LINE_RE.test(line))
    .map((line) => stripPipeTail(stripCdPrefix(line)))
    .filter(Boolean);
  const chosen = meaningful.length ? meaningful : [stripPipeTail(stripCdPrefix(lines[0]))].filter(Boolean);
  const command = chosen.join("; ");
  return command.length > BASH_CAP ? `${command.slice(0, BASH_CAP - 3)}...` : command;
};

// Compatibility alias. The audited behavior is semantic rendering, not an
// omission-count replacement.
export const compressHeredoc = compressBash;

const TOOL_SUMMARY_FIELDS = {
  Read: "file_path", Edit: "file_path", Write: "file_path",
  read: "file_path", edit: "file_path", write: "file_path",
  Glob: "pattern", Grep: "pattern",
};

export const toolOneLiner = (name, args = {}) => {
  const field = TOOL_SUMMARY_FIELDS[name];
  if (field && typeof args[field] === "string") return `* ${name} "${args[field]}"`;
  const path = extractPath(args);
  if (path) return `* ${name} "${path}"`;
  if (name === "bash" || name === "Bash") {
    const raw = args.command ?? args.description ?? "";
    return `* ${name} "${compressBash(String(raw))}"`;
  }
  if (typeof args.query === "string") return `* ${name} "${clip(args.query, 60)}"`;
  return `* ${name}`;
};

export const buildBriefSections = (blocks) => {
  const sections = [];
  let lastHeader = "";
  const push = (header, line) => {
    if (header === lastHeader && sections.length > 0) {
      sections[sections.length - 1].lines.push(line);
      return;
    }
    sections.push({ header, lines: [line] });
    lastHeader = header;
  };
  const pushText = (header, text, reference = "") => {
    const lines = text.split("\n");
    if (reference && lines.length > 0) lines[lines.length - 1] = `${lines.at(-1)}${reference}`;
    for (const line of lines) push(header, line);
  };

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    switch (block.kind) {
      case "user": {
        if (!block.text.trim()) break;
        const text = truncateTokens(collapseSkillText(block.text), TRUNCATE_USER);
        if (text) pushText("[user]", text, block.sourceIndex != null ? ` (#${block.sourceIndex})` : "");
        lastHeader = "[user]";
        break;
      }
      case "bash": {
        const command = compressBash(block.command);
        if (command) push("[user]", `$ ${command}${block.sourceIndex != null ? ` (#${block.sourceIndex})` : ""}`);
        lastHeader = "[user]";
        break;
      }
      case "assistant": {
        let raw = block.text;
        for (let index = 0; index < 2; index += 1) {
          const stripped = raw.replace(SELF_TALK_PREFIX_RE, "");
          if (stripped === raw) break;
          raw = stripped;
        }
        const text = isSegmentClosingAssistant(blocks, blockIndex)
          ? truncateTokensHeadTail(raw, SEGMENT_CLOSING_ASSISTANT_HEAD_WORDS, SEGMENT_CLOSING_ASSISTANT_TAIL_WORDS)
          : truncateTokensHeadTail(raw, ASSISTANT_HEAD_WORDS, ASSISTANT_TAIL_WORDS);
        if (text) pushText("[assistant]", text, block.sourceIndex != null ? ` (#${block.sourceIndex})` : "");
        break;
      }
      case "tool_call": {
        if (!block.name || !block.name.trim()) break;
        push("[assistant]", `${toolOneLiner(block.name, block.args)}${block.sourceIndex != null ? ` (#${block.sourceIndex})` : ""}`);
        break;
      }
      case "tool_result":
        break;
      default:
        break;
    }
  }

  for (const section of sections) {
    if (section.header !== "[assistant]") continue;
    const output = [];
    for (const line of section.lines) {
      if (!line.startsWith("* ")) { output.push(line); continue; }
      const reference = line.match(/\(#(\d+)\)$/)?.[1] ?? "";
      const base = reference ? line.slice(0, -(reference.length + 3)).trimEnd() : line;
      const last = output.at(-1) ?? "";
      const repeated = last.match(/^(.*) \((#[\d, #]+)\) x(\d+)$/);
      if (repeated && repeated[1] === base) {
        output[output.length - 1] = `${base} (${repeated[2]}, #${reference}) x${Number.parseInt(repeated[3], 10) + 1}`;
      } else if (/\(#\d+\)$/.test(last) && last.replace(/\s*\(#\d+\)$/, "") === base) {
        const previousReference = last.match(/\(#(\d+)\)$/)?.[1];
        output[output.length - 1] = `${base} (#${previousReference}, #${reference}) x2`;
      } else output.push(line);
    }
    section.lines = output;
  }

  for (const section of sections) {
    if (section.header !== "[assistant]") continue;
    const toolIndexes = section.lines.map((line, index) => line.startsWith("* ") ? index : -1).filter((index) => index >= 0);
    if (toolIndexes.length <= TOOL_CALLS_PER_TURN) continue;
    const dropCount = toolIndexes.length - TOOL_CALLS_PER_TURN;
    const dropSet = new Set(toolIndexes.slice(0, dropCount));
    const firstKeptToolIndex = toolIndexes[dropCount];
    const next = [];
    let inserted = false;
    for (let index = 0; index < section.lines.length; index += 1) {
      if (dropSet.has(index)) continue;
      if (!inserted && index === firstKeptToolIndex) {
        next.push(`* (${dropCount} earlier tool-call entries omitted)`);
        inserted = true;
      }
      next.push(section.lines[index]);
    }
    section.lines = next;
  }
  return sections;
};

export const stringifyBrief = (sections) => {
  const output = [];
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    if (index > 0) {
      const previous = sections[index - 1];
      const previousTools = previous.header === "[assistant]" && previous.lines.every((line) => line.startsWith("* "));
      const currentTools = section.header === "[assistant]" && section.lines.every((line) => line.startsWith("* "));
      if (!(previousTools && currentTools)) output.push("");
    }
    output.push(section.header, ...section.lines);
  }
  return output.join("\n");
};

export const compileBrief = (blocks) => stringifyBrief(buildBriefSections(blocks));
