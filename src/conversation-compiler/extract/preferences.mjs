import { clip, nonEmptyLines } from "../content.mjs";

const PREF_PATTERNS = [
  /\bprefer(?:s|red|ring)?\s+\w/i,
  /\bdon'?t want\b/i,
  /\balways (?:use|do|run|prefer|keep|make|format|write|add|set|put|prefix|start|include|append)\b/i,
  /\bnever (?:use|do|run|push|commit|write|ignore|add|set|put|remove|delete|include|deploy)\b/i,
  /\bplease (?:use|avoid|keep|make|don'?t|do not|format|write)\b/i,
  /\b(?:style|format|language|naming)\s*[:=]\s*\S/i,
];

export const extractPreferences = (blocks) => {
  const preferences = [];
  const seen = new Set();
  for (const block of blocks ?? []) {
    if (block.kind !== "user") continue;
    let perBlock = 0;
    for (const line of nonEmptyLines(block.text)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 5 || trimmed.length > 200) continue;
      if (trimmed.endsWith("?") || trimmed.includes("?...")) continue;
      if (!PREF_PATTERNS.some((pattern) => pattern.test(trimmed))) continue;
      const clipped = clip(trimmed, 200);
      const key = clipped.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      preferences.push(clipped);
      if (++perBlock >= 1) break;
    }
  }
  return preferences.slice(0, 10);
};

export const dedupPreferencesAgainstGoals = (preferences, goals) => {
  const normalize = (value) => value.trim().toLowerCase();
  const goalSet = new Set((goals ?? []).map(normalize));
  return (preferences ?? []).filter((preference) => !goalSet.has(normalize(preference)));
};
