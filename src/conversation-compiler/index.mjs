// Pure deterministic child conversation compiler. No clock, filesystem, search,
// model, process state, or telemetry dependency is permitted in this directory.
export * from "./constants.mjs";
export * from "./content.mjs";
export * from "./sanitize.mjs";
export * from "./normalize.mjs";
export * from "./filter-noise.mjs";
export * from "./heredoc.mjs";
export * from "./brief.mjs";
export * from "./tool-args.mjs";
export * from "./build-sections.mjs";
export * from "./extract.mjs";
export * from "./rank.mjs";
export * from "./ranking.mjs";
export * from "./format.mjs";
export * from "./summarize.mjs";
export * from "./token-estimate.mjs";
export * from "./parse.mjs";

import {
  COMPILER_MARKER,
  DEFAULT_CHARS_PER_TOKEN,
  MAX_CHARS_PER_TOKEN,
  MIN_CHARS_PER_TOKEN,
  RANKED_BRIEF_BUDGET_TOKENS,
  RANKED_BRIEF_CEILING_TOKENS,
  RANKED_BRIEF_TOKENS_PER_BLOCK,
} from "./constants.mjs";
import { isCompilerNoise } from "./extract.mjs";
import { migrateLegacyCompiledConversation, stripLeadingCompilerMarker } from "./parse.mjs";
import { compileRanked } from "./summarize.mjs";
import { calibrateCharsPerToken } from "./token-estimate.mjs";

const calibratedRatio = (calibration) => {
  if (Number.isFinite(calibration?.charsPerToken) && calibration.charsPerToken > 0) {
    return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, calibration.charsPerToken));
  }
  return calibrateCharsPerToken(calibration?.sourceChars, calibration?.sourceTokens).charsPerToken;
};

/**
 * DSH adapter around the source-faithful ranked compiler. `seq` becomes the
 * durable brief reference and the existing checkpoint marker is framing only.
 */
export const compileConversation = (records, { previousSummary = "", tokenCalibration, fileOps } = {}) => {
  const messages = (Array.isArray(records) ? records : []).filter((record) =>
    Number.isSafeInteger(record?.seq) && record.seq >= 0 && !isCompilerNoise(record));
  const charsPerToken = calibratedRatio(tokenCalibration) || DEFAULT_CHARS_PER_TOKEN;
  const body = compileRanked({
    messages,
    previousSummary: stripLeadingCompilerMarker(migrateLegacyCompiledConversation(previousSummary)).trim(),
    fileOps,
    dshFraming: true,
    ranking: {
      maxBriefChars: Math.round(RANKED_BRIEF_BUDGET_TOKENS * charsPerToken),
      maxBriefCharsCeiling: Math.round(RANKED_BRIEF_CEILING_TOKENS * charsPerToken),
      briefCharsPerBlock: Math.round(RANKED_BRIEF_TOKENS_PER_BLOCK * charsPerToken),
      fileOps,
    },
  });
  if (!body) return "";
  return `${COMPILER_MARKER}\n\n${body}`;
};
