import { DEFAULT_MAX_BLOCKS, DEFAULT_RECENT_BLOCKS } from "./constants.mjs";
import { extractPath } from "./tool-args.mjs";
import { compileBrief, heredocCloseIndex } from "./brief.mjs";

const EDIT_TOOL_RE = /^(edit|write|multiedit|quick_edit|target_edit|apply_patch)$/i;
const READ_TOOL_RE = /^(read|glob|grep|ls|find|semantic_query|semantic_grep|semantic_show)$/i;
const TEST_COMMAND_RE = /\b(?:bun|npm|pnpm|yarn|node|pytest|cargo|go|mvn|gradle)\b[^\n]*(?:test|spec|check|lint|build|tsc)/i;
const GH_PR_POLL_RE = /(?:^|\s)gh\s+pr\s+(?:view|checks)\s+(\d+)\b/i;
const WORKFLOW_COMMAND_RE = /(?:^|\s)(?:gh\s+(?:pr|issue)\s+[a-z-]+|git\s+(?:commit|push|merge|rebase|revert|cherry-pick|tag|reset|checkout|branch)\b)/i;
const MIN_SEGMENT_CLOSING_ASSISTANT_CHARS = 120;
const TRIVIAL_BASH_LINE_RE = /^(?:set\s+[-+]|cd(?:\s+\S+)?$|export\s+\w+=|(?:source|\.)\s+\S+|pwd$|true$|:$|#|ls(?:\s|$)|echo\b|clear$|sleep\b)/;
const TRIVIAL_BASH_PENALTY = 16;
const GH_PR_POLL_PENALTY = 10;

const isTrivialOnlyBash = (raw) => {
  const lines = String(raw ?? "").split("\n");
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    kept.push(lines[index]);
    const close = heredocCloseIndex(lines, index);
    if (close !== -1) index = close;
  }
  const meaningful = kept.map((line) => line.trim()).filter(Boolean).filter((line) => !TRIVIAL_BASH_LINE_RE.test(line));
  return meaningful.length === 0;
};
const asPathSet = (paths) => new Set((paths ?? []).filter(Boolean));
const bashCommandFromBlock = (block) => {
  if (block.kind === "bash") return block.command;
  if (block.kind === "tool_call" && /^bash$/i.test(block.name) && typeof block.args.command === "string") return block.args.command;
  return undefined;
};
const pathFromBlock = (block) => {
  if (block.kind === "tool_call") return extractPath(block.args) ?? undefined;
  if (block.kind === "bash") return block.command.match(/(?:^|\s)([\w./-]+\.[\w-]+)(?:\s|$)/)?.[1];
  return undefined;
};
const add = (ranked, points, reason) => {
  ranked.score += points;
  ranked.reasons.push(reason);
};

const scoreBlock = (block, index, total, modifiedFiles, readFiles) => {
  const ranked = { block, index, score: 0, reasons: [] };
  add(ranked, total <= 1 ? 0 : Math.round((index / (total - 1)) * 12), "recency");
  if (block.kind === "user") add(ranked, 18, "user-turn");
  if (block.kind === "assistant") add(ranked, 10, "assistant-context");
  if (block.kind === "tool_result") add(ranked, 1, "tool-result-low-value");

  if (block.kind === "tool_call") {
    const command = bashCommandFromBlock(block);
    if (EDIT_TOOL_RE.test(block.name)) add(ranked, 34, "edit-tool");
    else if (command && TEST_COMMAND_RE.test(command)) add(ranked, 26, "test-command");
    else if (READ_TOOL_RE.test(block.name)) add(ranked, 6, "read-tool");
    else add(ranked, 12, "tool-call");
    if (command && WORKFLOW_COMMAND_RE.test(command)) add(ranked, 14, "workflow-command");
    if (command && GH_PR_POLL_RE.test(command)) add(ranked, -GH_PR_POLL_PENALTY, "gh-pr-poll");
    if (command && isTrivialOnlyBash(command)) add(ranked, -TRIVIAL_BASH_PENALTY, "trivial-bash");
  }

  if (block.kind === "bash") {
    add(ranked, 8, "bash");
    if (block.exitCode != null && block.exitCode !== 0) add(ranked, 24, "nonzero-exit");
    if (TEST_COMMAND_RE.test(block.command)) add(ranked, 22, "test-command");
    if (WORKFLOW_COMMAND_RE.test(block.command)) add(ranked, 14, "workflow-command");
    if (GH_PR_POLL_RE.test(block.command)) add(ranked, -GH_PR_POLL_PENALTY, "gh-pr-poll");
    if (isTrivialOnlyBash(block.command) && !(block.exitCode != null && block.exitCode !== 0)) {
      add(ranked, -TRIVIAL_BASH_PENALTY, "trivial-bash");
    }
  }

  const path = pathFromBlock(block);
  if (path) {
    if (modifiedFiles.has(path)) add(ranked, 18, "hook-modified-file");
    if (readFiles.has(path)) add(ranked, 6, "hook-read-file");
  }
  if (block.kind === "tool_result" && block.text.length > 1000) add(ranked, -8, "long-tool-result");
  return ranked;
};

const boostAdjacency = (ranked) => {
  const important = ranked
    .filter((item) => item.score >= 34 || item.reasons.includes("edit-tool") || item.reasons.includes("test-command") || item.reasons.includes("nonzero-exit"))
    .map((item) => item.index);
  for (const importantIndex of important) {
    for (let index = importantIndex - 1; index >= Math.max(0, importantIndex - 8); index -= 1) {
      if (ranked[index].block.kind === "user") { add(ranked[index], 10, "near-important-event"); break; }
    }
    for (let index = importantIndex - 1; index >= Math.max(0, importantIndex - 4); index -= 1) {
      if (ranked[index].block.kind === "assistant") { add(ranked[index], 7, "near-important-event"); break; }
    }
    for (let index = importantIndex + 1; index <= Math.min(ranked.length - 1, importantIndex + 4); index += 1) {
      if (ranked[index].block.kind === "assistant" || ranked[index].block.kind === "bash") {
        add(ranked[index], 5, "after-important-event");
        break;
      }
    }
  }
};

const nextNonToolResult = (ranked, index) => {
  for (let cursor = index + 1; cursor < ranked.length; cursor += 1) {
    if (ranked[cursor].block.kind !== "tool_result") return ranked[cursor].block;
  }
  return undefined;
};
const boostSegmentClosingAssistants = (ranked) => {
  for (let index = 0; index < ranked.length; index += 1) {
    const current = ranked[index];
    if (current.block.kind !== "assistant" || current.block.text.trim().length < MIN_SEGMENT_CLOSING_ASSISTANT_CHARS) continue;
    const next = nextNonToolResult(ranked, index);
    if (!next || next.kind === "user") add(current, 14, "segment-closing-assistant");
  }
};

const dedupKey = (block) => {
  const command = bashCommandFromBlock(block);
  const ghPrPoll = command?.match(GH_PR_POLL_RE);
  if (ghPrPoll) return `gh-pr-poll:${ghPrPoll[1]}`;
  if (command) {
    const normalized = command.replace(/\s+/g, " ").trim();
    return normalized ? `bash:${normalized}` : undefined;
  }
  if (block.kind === "tool_call") {
    const path = pathFromBlock(block);
    return path ? `tool:${block.name.toLowerCase()}:${path}` : undefined;
  }
  return undefined;
};

export const rankBriefBlocks = (blocks, options = {}) => {
  const modifiedFiles = asPathSet(options.fileOps?.modifiedFiles);
  const readFiles = asPathSet(options.fileOps?.readFiles);
  const ranked = (blocks ?? []).map((block, index) => scoreBlock(block, index, blocks.length, modifiedFiles, readFiles));
  boostAdjacency(ranked);
  boostSegmentClosingAssistants(ranked);
  return ranked;
};

export const selectRankedBriefBlocks = (blocks, options = {}) => {
  const source = blocks ?? [];
  const maxBlocks = options.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const maxBriefChars = options.maxBriefChars != null && options.maxBriefCharsCeiling != null && options.briefCharsPerBlock != null
    ? Math.round(Math.min(options.maxBriefCharsCeiling, Math.max(options.maxBriefChars, options.briefCharsPerBlock * source.length)))
    : options.maxBriefChars;
  if (source.length <= maxBlocks && maxBriefChars == null) return source;

  const preserveRecentBlocks = Math.min(options.preserveRecentBlocks ?? DEFAULT_RECENT_BLOCKS, maxBlocks);
  const ranked = rankBriefBlocks(source, options);
  const selected = new Set();
  const seenKeys = new Set();
  const costs = maxBriefChars == null ? null : source.map((block) => block.kind === "tool_result" ? 0 : compileBrief([block]).length + 1);
  let usedChars = 0;

  for (let index = source.length - 1; index >= Math.max(0, source.length - preserveRecentBlocks); index -= 1) {
    if (source[index].kind === "tool_result" || selected.has(index)) continue;
    if (costs && usedChars + costs[index] > maxBriefChars) continue;
    selected.add(index);
    if (costs) usedChars += costs[index];
    const key = dedupKey(source[index]);
    if (key) seenKeys.add(key);
  }

  const ordered = [...ranked].sort((left, right) => right.score - left.score || right.index - left.index);
  for (const item of ordered) {
    if (selected.size >= maxBlocks) break;
    if (selected.has(item.index) || item.block.kind === "tool_result") continue;
    const key = dedupKey(item.block);
    if (key && seenKeys.has(key)) continue;
    if (costs) {
      if (usedChars + costs[item.index] > maxBriefChars) continue;
      usedChars += costs[item.index];
    }
    selected.add(item.index);
    if (key) seenKeys.add(key);
  }
  return [...selected].sort((left, right) => left - right).map((index) => source[index]);
};
