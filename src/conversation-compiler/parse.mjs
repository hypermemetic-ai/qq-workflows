import { COMPILER_MARKER } from "./constants.mjs";
import { briefOf, hasSemanticSections, sectionItems, sectionOf, stripRecallNote } from "./summarize.mjs";

const HEADER_KEYS = Object.freeze({
  "Session Goal": "goals",
  "Files And Changes": "files",
  Commits: "commits",
  "Outstanding Context": "outstanding",
  "User Preferences": "preferences",
});

export const stripLeadingCompilerMarker = (text) => {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const first = lines.findIndex((line) => line !== "");
  if (first >= 0 && lines[first] === COMPILER_MARKER) lines.splice(first, 1);
  return lines.join("\n");
};

const isLegacyCompiledConversation = (text) => {
  if (typeof text !== "string") return false;
  const clean = stripLeadingCompilerMarker(text).trimStart();
  return /^## Session Goal[ \t]*(?:\r?\n|$)/.test(clean)
    && /^## Chronological Brief[ \t]*\r?$/m.test(clean);
};

const legacySections = (text) => {
  const parsed = { goals: [], files: [], commits: [], outstanding: [], preferences: [], brief: [] };
  const keyByHeading = new Map([...Object.entries(HEADER_KEYS), ["Chronological Brief", "brief"]]);
  let key = null;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const heading = line.match(/^## (.+)$/)?.[1];
    if (heading) { key = keyByHeading.get(heading) ?? null; continue; }
    if (!key || line.startsWith("> ") || line === "None recorded.") continue;
    if (line.startsWith("- ")) {
      const value = line.slice(2);
      if (value !== "None recorded.") parsed[key].push(value);
    }
    else if (/^\s+\S/.test(line) && parsed[key].length > 0) parsed[key][parsed[key].length - 1] += ` ${line.trim()}`;
  }
  return parsed;
};

export const parseCompiledConversation = (text) => {
  const empty = { goals: [], files: [], commits: [], outstanding: [], preferences: [], brief: [] };
  if (typeof text !== "string" || !text.trim()) return empty;
  if (isLegacyCompiledConversation(text)) return legacySections(text);
  const withoutMarker = stripLeadingCompilerMarker(text).trim();
  const clean = stripRecallNote(withoutMarker);
  const parsed = structuredClone(empty);
  for (const [header, key] of Object.entries(HEADER_KEYS)) parsed[key] = sectionItems(sectionOf(clean, header));
  const brief = hasSemanticSections(clean) ? briefOf(clean) : clean;
  parsed.brief = brief.split("\n").filter((line) => line.trim());
  return parsed;
};

const renderLegacyBrief = (items) => {
  const output = [];
  let role = null;
  for (const item of items) {
    const match = item.match(/^#(\d+)\s+(user|assistant):\s*([\s\S]*)$/);
    if (!match) { output.push(item); continue; }
    if (role !== match[2]) { if (output.length > 0) output.push(""); output.push(`[${match[2]}]`); role = match[2]; }
    output.push(`${match[3]} (#${match[1]})`);
  }
  return output.join("\n");
};

/** Convert checkpoints produced by the landed pre-audit formatter once. */
export const migrateLegacyCompiledConversation = (text) => {
  if (!isLegacyCompiledConversation(text)) return text;
  const parsed = legacySections(text);
  const sections = [];
  for (const [header, key] of Object.entries(HEADER_KEYS)) {
    if (parsed[key].length > 0) sections.push(`[${header}]\n${parsed[key].map((item) => `- ${item}`).join("\n")}`);
  }
  const brief = renderLegacyBrief(parsed.brief);
  return [sections.join("\n\n"), brief].filter(Boolean).join("\n\n---\n\n");
};
