// Pure deterministic child conversation compiler. No clock, filesystem, search,
// model, process state, or telemetry dependency is permitted in this directory.
export * from "./constants.mjs";
export * from "./normalize.mjs";
export * from "./extract.mjs";
export * from "./ranking.mjs";
export * from "./format.mjs";

import { extractSections, normalizedBlocks } from "./extract.mjs";
import { mergeCompiledState, parseCompiledConversation } from "./format.mjs";
import { compilerBudgetTokens, dedupeBrief, selectBlocks } from "./ranking.mjs";

export function compileConversation(records, { previousSummary = "", tokenCalibration } = {}) {
  const source = Array.isArray(records) ? records : [];
  const blocks = normalizedBlocks(source);
  const budgetTokens = compilerBudgetTokens(blocks.length);
  const charsPerToken = Number.isFinite(tokenCalibration?.charsPerToken) && tokenCalibration.charsPerToken > 0
    ? tokenCalibration.charsPerToken
    : 4;
  // Structural sections and framing are priced before ranked brief selection.
  // A conservative reserve keeps the final convergence loop exceptional.
  const briefBudget = Math.max(512, Math.floor(budgetTokens * charsPerToken) - 1_600);
  const selected = dedupeBrief(selectBlocks(blocks, briefBudget));
  const fresh = extractSections(source);
  const previous = parseCompiledConversation(previousSummary);
  return mergeCompiledState(fresh, previous, selected, previous.brief, blocks.length, charsPerToken);
}
