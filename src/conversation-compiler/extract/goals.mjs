import { clip, nonEmptyLines } from "../content.mjs";
import { collapseSkillLines } from "../skill-collapse.mjs";

const SCOPE_CHANGE_RE = /\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do|stop .* and)\b/i;
const TASK_RE = /\b(fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|test|write|set up)\b/i;
const NOISE_SHORT_RE = /^(ok|yes|no|sure|yeah|yep|go|hi|hey|thx|thanks|ok\b.*|y|n|k)\s*[.!?]*$/i;
const NON_GOAL_RE = /^\s*[\[│├└─╭╰]|```|^\s*(=[A-Z]+\(|function |const |let |var |import |export |class )|^(https?:|file:|\/[A-Za-z])|\\n|^\s*For each\b|\bin full\b[^\n]*\b(comments|issue|issues|PRs?|linked)\b/;
const TEMPLATE_SIGNAL_RE = /^\s*(For each\b|Do NOT implement\b|Analyze and propose\b|If Task\/context\b|Output:\s*$)/i;
const MAX_GOAL_CHARS = 200;
const LEADING_CHARS = 200;

const truncateAtTemplate = (lines) => {
  const index = lines.findIndex((line) => TEMPLATE_SIGNAL_RE.test(line));
  return index >= 0 ? lines.slice(0, index) : lines;
};
const stripLeadingBullet = (line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();
const isSubstantiveGoal = (text) => {
  const value = text.trim();
  if (value.length <= 5 || value.length > MAX_GOAL_CHARS) return false;
  if (NOISE_SHORT_RE.test(value) || NON_GOAL_RE.test(value)) return false;
  return true;
};

export const extractGoals = (blocks) => {
  const goals = [];
  let latestScopeChange = null;
  for (const block of blocks ?? []) {
    if (block.kind !== "user") continue;
    const rawLines = nonEmptyLines(block.text);
    const truncated = truncateAtTemplate(rawLines);
    const lines = collapseSkillLines(truncated.filter(isSubstantiveGoal))
      .map(stripLeadingBullet)
      .filter((line) => line.length > 5);
    if (lines.length === 0) continue;
    if (goals.length === 0) {
      goals.push(...lines.slice(0, 6));
      continue;
    }
    const leading = block.text.slice(0, LEADING_CHARS);
    if (SCOPE_CHANGE_RE.test(leading)) {
      latestScopeChange = lines.slice(0, 3).map((line) => clip(line, MAX_GOAL_CHARS));
    } else if (TASK_RE.test(leading) && lines[0].length > 15) {
      latestScopeChange = lines.slice(0, 2).map((line) => clip(line, MAX_GOAL_CHARS));
    }
  }
  if (latestScopeChange?.length > 0) goals.push("[Scope change]", ...latestScopeChange);
  return goals.slice(0, 8);
};
