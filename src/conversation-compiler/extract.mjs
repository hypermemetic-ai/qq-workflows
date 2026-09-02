import {
  ASSISTANT_HEAD_WORDS,
  ASSISTANT_TAIL_WORDS,
  BASH_WORD_BUDGET,
  CLOSING_ASSISTANT_HEAD_WORDS,
  CLOSING_ASSISTANT_TAIL_WORDS,
  FILE_CAP,
  MAX_TOOL_CALLS,
  PREFERENCE_CAP,
  USER_WORD_BUDGET,
} from "./constants.mjs";
import {
  compressHeredoc,
  normalizedKey,
  normalizeText,
  oneLine,
  stableJson,
  truncateWords,
  unique,
} from "./normalize.mjs";

const STRUCTURED_FILE_TOOLS = new Set([
  "write", "edit", "apply_patch", "str_replace_editor", "create_file", "delete_file", "move_file", "rename_file",
]);
const PATH_KEYS = ["path", "file_path", "filepath", "targetPath", "target_path"];

function textOfContent(content, { includeToolResults = false } = {}) {
  if (!Array.isArray(content)) return "";
  const text = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") text.push(block.text);
    else if (includeToolResults && block?.type === "tool-result" && Array.isArray(block.content)) {
      text.push(textOfContent(block.content, { includeToolResults: true }));
    }
  }
  return normalizeText(text.join("\n"));
}

function argsObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toolCalls(record) {
  return Array.isArray(record?.content)
    ? record.content.filter((block) => block?.type === "tool-call" && typeof block.name === "string")
    : [];
}

/** Drop only the Mini adapter's generated format retry; task/recovery notices remain semantic input. */
export function isCompilerNoise(record) {
  if (record?.role !== "user" || record?.source?.kind !== "plugin" || record.source.plugin !== "qq-workflows") return false;
  const text = textOfContent(record.content);
  return /^Tool call error:/i.test(text)
    && /<error>[\s\S]*Every response needs to (?:call|use)/i.test(text);
}

function renderToolCall(call) {
  const parsed = argsObject(call.arguments);
  if (call.name === "bash") {
    const raw = parsed?.command ?? (typeof call.arguments === "string" ? call.arguments : stableJson(call.arguments ?? {}));
    const command = truncateWords(compressHeredoc(raw), Math.ceil(BASH_WORD_BUDGET / 2), Math.floor(BASH_WORD_BUDGET / 2));
    return `bash(command=${JSON.stringify(oneLine(command))})`;
  }
  return `${call.name}(${stableJson(parsed ?? call.arguments ?? {})})`;
}

function isClosingAssistant(records, index) {
  if (records[index]?.role !== "assistant") return false;
  for (let cursor = index + 1; cursor < records.length; cursor += 1) {
    if (records[cursor]?.role === "tool-result") continue;
    return records[cursor]?.role === "user";
  }
  return true;
}

export function normalizedBlocks(records) {
  const prepared = [];
  const source = Array.isArray(records) ? records : [];
  for (let index = 0; index < source.length; index += 1) {
    const record = source[index];
    if (isCompilerNoise(record)) continue;
    if (!Number.isSafeInteger(record?.seq) || record.seq < 0) continue;
    if (record.role === "tool-result") continue; // Result bodies remain recoverable through session_history, never copied here.
    if (record.role !== "user" && record.role !== "assistant") continue;
    const rawText = textOfContent(record.content);
    let text = "";
    if (record.role === "user") text = truncateWords(rawText, USER_WORD_BUDGET);
    else {
      const closing = isClosingAssistant(source, index);
      text = truncateWords(
        rawText,
        closing ? CLOSING_ASSISTANT_HEAD_WORDS : ASSISTANT_HEAD_WORDS,
        closing ? CLOSING_ASSISTANT_TAIL_WORDS : ASSISTANT_TAIL_WORDS,
      );
    }
    const calls = toolCalls(record);
    const renderedCalls = calls.slice(0, MAX_TOOL_CALLS).map(renderToolCall);
    if (calls.length > MAX_TOOL_CALLS) renderedCalls.push(`… ${calls.length - MAX_TOOL_CALLS} additional tool calls omitted …`);
    const parts = [oneLine(text), ...renderedCalls].filter(Boolean);
    if (parts.length === 0) continue;
    prepared.push({
      seq: record.seq,
      role: record.role,
      text: parts.join(" | "),
      source: record,
    });
  }

  // Exact duplicate prose is noise. Retain the newest occurrence and its resolvable seq.
  const newest = new Map();
  for (let index = 0; index < prepared.length; index += 1) {
    newest.set(`${prepared[index].role}:${normalizedKey(prepared[index].text)}`, index);
  }
  return prepared.filter((block, index) => newest.get(`${block.role}:${normalizedKey(block.text)}`) === index);
}

function sentences(value) {
  return oneLine(value).split(/(?<=[.!?])\s+|\s*[;]\s*/u).map((part) => part.trim()).filter(Boolean);
}

function cited(seq, text) {
  return `#${seq} ${oneLine(text)}`;
}

function userRecords(records) {
  return records.filter((record) => record?.role === "user" && record?.source?.kind !== "tool");
}

export function extractGoals(records) {
  const users = userRecords(records);
  const goals = [];
  for (let index = 0; index < users.length; index += 1) {
    const text = textOfContent(users[index].content);
    if (!text) continue;
    if (index === 0 || /\b(?:correction|instead|also|must|need|please|goal|task)\b/i.test(text)) {
      goals.push(cited(users[index].seq, truncateWords(text, 80, 40)));
    }
  }
  return unique(goals);
}

export function extractPreferences(records) {
  const preferences = [];
  for (const record of userRecords(records)) {
    for (const sentence of sentences(textOfContent(record.content))) {
      if (/\b(?:prefer|please (?:keep|avoid|use)|do not|don't|must|always|never|keep the|avoid)\b/i.test(sentence)) {
        preferences.push(cited(record.seq, truncateWords(sentence, 48, 24)));
      }
    }
  }
  return unique(preferences).slice(-PREFERENCE_CAP);
}

function pathFrom(args) {
  if (!args) return "";
  for (const key of PATH_KEYS) {
    if (typeof args[key] === "string" && args[key].trim()) return oneLine(args[key]);
  }
  return "";
}

export function extractFiles(records) {
  const files = [];
  for (const record of records) {
    if (!Number.isSafeInteger(record?.seq)) continue;
    for (const call of toolCalls(record)) {
      if (!STRUCTURED_FILE_TOOLS.has(call.name)) continue;
      const path = pathFrom(argsObject(call.arguments));
      if (!path) continue;
      files.push(cited(record.seq, `${call.name}: ${path}`));
    }
  }
  return unique(files).slice(-FILE_CAP);
}

export function extractCommits(records) {
  const commits = [];
  for (const record of records) {
    if (!Number.isSafeInteger(record?.seq)) continue;
    const text = textOfContent(record.content, { includeToolResults: true });
    if (!/\bcommit(?:ted|s|ting)?\b/i.test(text)) continue;
    const hashes = text.match(/\b[0-9a-f]{7,40}\b/gi) ?? [];
    for (const hash of hashes) commits.push(cited(record.seq, hash));
  }
  return unique(commits, (value) => value.match(/[0-9a-f]{7,40}/i)?.[0]?.toLowerCase() ?? normalizedKey(value));
}

export function extractOutstanding(records) {
  const outstanding = [];
  for (const record of records) {
    if (!Number.isSafeInteger(record?.seq) || record.role === "tool-result") continue;
    const text = textOfContent(record.content);
    if (/\b(?:no|nothing)\s+(?:outstanding|remaining)|\bno outstanding tasks remain\b|\bwork is complete\b/i.test(text)) {
      outstanding.length = 0;
      continue;
    }
    for (const sentence of sentences(text)) {
      if (/\b(?:outstanding|next|remain(?:s|ing)?|todo|to-do|follow[- ]?up|need(?:s|ed)? to|verify|failed|failure|nonzero)\b/i.test(sentence)) {
        outstanding.push(cited(record.seq, truncateWords(sentence, 64, 32)));
      }
    }
  }
  return unique(outstanding).slice(-12);
}

export function extractSections(records) {
  const input = Array.isArray(records) ? records.filter((record) => !isCompilerNoise(record)) : [];
  return {
    goals: extractGoals(input),
    files: extractFiles(input),
    commits: extractCommits(input),
    outstanding: extractOutstanding(input),
    preferences: extractPreferences(input),
  };
}
