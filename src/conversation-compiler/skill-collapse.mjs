const SKILL_OPEN_RE = /^\s*<skill(?:\s[^>]*)?>\s*$/i;
const SKILL_CLOSE_RE = /^\s*<\/skill>\s*$/i;

/** Collapse injected skill XML while leaving ordinary user-authored XML alone. */
export const collapseSkillLines = (lines) => {
  const out = [];
  let depth = 0;
  for (const line of lines ?? []) {
    if (SKILL_OPEN_RE.test(line)) { depth += 1; continue; }
    if (SKILL_CLOSE_RE.test(line)) { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) out.push(line);
  }
  return out;
};

export const collapseSkillText = (text) => collapseSkillLines(String(text ?? "").split("\n")).join("\n").trim();
