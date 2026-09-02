import { clipSentence, nonEmptyLines } from "./content.mjs";
import { extractGoals } from "./extract/goals.mjs";
import { extractFiles } from "./extract/files.mjs";
import { dedupPreferencesAgainstGoals, extractPreferences } from "./extract/preferences.mjs";
import { extractCommits, formatCommits } from "./extract/commits.mjs";
import { buildBriefSections, stringifyBrief } from "./brief.mjs";

const BLOCKER_RE = /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

export const extractOutstandingContext = (blocks) => {
  const items = [];
  const tail = (blocks ?? []).slice(-20);
  for (const block of tail) {
    if (block.kind !== "assistant" && block.kind !== "user") continue;
    for (const line of nonEmptyLines(block.text)) {
      if (!BLOCKER_RE.test(line) || line.length < 15) continue;
      if (/^\s*[-*+>]\s/.test(line) || /^\s*\(/.test(line)) continue;
      if (!/^\s*["'`*_]?[A-Z`]/.test(line)) continue;
      const clipped = block.kind === "user" ? `[user] ${clipSentence(line, 150)}` : clipSentence(line, 150);
      if (!items.includes(clipped)) items.push(clipped);
      break;
    }
  }
  return items.slice(0, 5);
};

export const formatFileActivity = (blocks, fileOps) => {
  const activity = extractFiles(blocks, fileOps);
  for (const path of activity.modified) activity.created.delete(path);
  const cap = (set, limit) => {
    const values = [...set];
    if (values.length <= limit) return values.join(", ");
    return `${values.slice(0, limit).join(", ")} (+${values.length - limit} more)`;
  };
  const lines = [];
  if (activity.modified.size > 0) lines.push(`Modified: ${cap(activity.modified, 10)}`);
  if (activity.created.size > 0) lines.push(`Created: ${cap(activity.created, 10)}`);
  if (activity.read.size > 0) lines.push(`Read: ${cap(activity.read, 10)}`);
  return lines;
};

export const buildSections = (input) => {
  const blocks = input?.blocks ?? [];
  const briefSections = buildBriefSections(input?.briefBlocks ?? blocks);
  const sessionGoal = extractGoals(blocks);
  return {
    sessionGoal,
    outstandingContext: extractOutstandingContext(blocks),
    filesAndChanges: formatFileActivity(blocks, input?.fileOps),
    commits: formatCommits(extractCommits(blocks)),
    userPreferences: dedupPreferencesAgainstGoals(extractPreferences(blocks), sessionGoal),
    briefTranscript: stringifyBrief(briefSections),
  };
};
