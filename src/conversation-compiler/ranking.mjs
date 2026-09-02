import {
  MAX_BLOCKS,
  MAX_BUDGET_TOKENS,
  MIN_BUDGET_TOKENS,
  RECENT_BLOCKS,
  TOKENS_PER_BLOCK,
} from "./constants.mjs";
import { normalizedKey } from "./normalize.mjs";

export function compilerBudgetTokens(blockCount) {
  const estimated = Math.max(0, Number(blockCount) || 0) * TOKENS_PER_BLOCK;
  return Math.max(MIN_BUDGET_TOKENS, Math.min(MAX_BUDGET_TOKENS, Math.ceil(estimated)));
}

/** Reference corpus weights, before deterministic adjacency and recency tie-breakers. */
export function blockScore(block, index, total) {
  const text = String(block?.text ?? "").toLocaleLowerCase();
  let score = 0.5;
  if (/\b(?:fail(?:ed|ure)?|error|exception|nonzero|exit (?:code )?[1-9])\b/.test(text)) score += 6;
  if (/\b(?:commit(?:ted|ting)?|[0-9a-f]{7,40})\b/.test(text)) score += 5;
  if (/\b(?:modif(?:y|ied)|tests?|tested|edit(?:ed|ing)?|write|patch)\b/.test(text)) score += 4;
  if (/\b(?:workflow|implement(?:ation|ed|ing)?|research|review|plan(?:ned|ning)?)\b/.test(text)) score += 2;
  if (/\b(?:read|search|inspect|grep|rg|cat)\b/.test(text)) score += 1;
  score += total <= 1 ? 1 : index / (total - 1); // bounded recency bonus
  return score;
}

export function rankBlocks(blocks) {
  const source = Array.isArray(blocks) ? blocks : [];
  const scored = source.map((block, index) => ({ block, index, score: blockScore(block, index, source.length) }));
  for (let index = 0; index < scored.length; index += 1) {
    const neighbor = Math.max(scored[index - 1]?.score ?? 0, scored[index + 1]?.score ?? 0);
    if (neighbor >= 4.5) scored[index].score += 0.75;
  }
  return scored.sort((left, right) => right.score - left.score || right.index - left.index);
}

/** Keep a recent floor, then fill by score, and finally restore chronology. */
export function selectBlocks(blocks, charBudget = Infinity) {
  const source = Array.isArray(blocks) ? blocks : [];
  const selected = new Map();
  let used = 0;
  const add = (block, index) => {
    if (selected.size >= MAX_BLOCKS || selected.has(index)) return;
    const cost = String(block.text ?? "").length + 24;
    if (selected.size > 0 && used + cost > charBudget) return;
    selected.set(index, block);
    used += cost;
  };
  const recentStart = Math.max(0, source.length - RECENT_BLOCKS);
  for (let index = source.length - 1; index >= recentStart; index -= 1) add(source[index], index);
  for (const item of rankBlocks(source)) add(item.block, item.index);
  return [...selected.entries()].sort(([left], [right]) => left - right).map(([, block]) => block);
}

export function dedupeBrief(blocks) {
  const seen = new Set();
  const result = [];
  for (const block of blocks) {
    const key = `${block.role}:${normalizedKey(block.text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(block);
  }
  return result;
}
