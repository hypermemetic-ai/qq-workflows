import { textOf } from "./content.mjs";
import { normalize } from "./normalize.mjs";
import { filterNoise } from "./filter-noise.mjs";
import { buildSections } from "./build-sections.mjs";

export * from "./extract/goals.mjs";
export * from "./extract/preferences.mjs";
export * from "./extract/files.mjs";
export * from "./extract/commits.mjs";

/** DSH-only transport retry; it is not a user turn and has no semantic value. */
export const isCompilerNoise = (record) => {
  if (record?.role !== "user" || record?.source?.kind !== "plugin" || record.source.plugin !== "qq-workflows") return false;
  const text = textOf(record.content);
  return /^Tool call error:/i.test(text) && /<error>[\s\S]*Every response needs to (?:call|use)/i.test(text);
};

export const normalizedBlocks = (records) => filterNoise(normalize(
  (Array.isArray(records) ? records : []).filter((record) => !isCompilerNoise(record)),
));

export const extractSections = (recordsOrBlocks, fileOps) => {
  const source = Array.isArray(recordsOrBlocks) ? recordsOrBlocks : [];
  const blocks = source.length === 0 || source[0]?.kind ? source : normalizedBlocks(source);
  return buildSections({ blocks, fileOps });
};
