import {
  RANKED_BRIEF_BUDGET_TOKENS,
  RANKED_BRIEF_CEILING_TOKENS,
  RANKED_BRIEF_TOKENS_PER_BLOCK,
} from "./constants.mjs";
import { rankBriefBlocks, selectRankedBriefBlocks } from "./rank.mjs";

export * from "./rank.mjs";

export const compilerBudgetTokens = (blockCount) => Math.round(Math.min(
  RANKED_BRIEF_CEILING_TOKENS,
  Math.max(RANKED_BRIEF_BUDGET_TOKENS, RANKED_BRIEF_TOKENS_PER_BLOCK * Math.max(0, Number(blockCount) || 0)),
));

// Compatibility aliases for the initially landed public surface.
export const rankBlocks = rankBriefBlocks;
export const selectBlocks = (blocks, charBudget) => selectRankedBriefBlocks(blocks, {
  ...(Number.isFinite(charBudget) ? { maxBriefChars: charBudget } : {}),
});
export const dedupeBrief = (blocks) => selectRankedBriefBlocks(blocks, { maxBlocks: blocks?.length ?? 0 });
export const blockScore = (block, index = 0, total = 1) => {
  const prefix = Array.from({ length: Math.max(0, index) }, () => ({ kind: "tool_result", name: "", text: "" }));
  const suffix = Array.from({ length: Math.max(0, total - index - 1) }, () => ({ kind: "tool_result", name: "", text: "" }));
  return rankBriefBlocks([...prefix, block, ...suffix])[index]?.score ?? 0;
};
