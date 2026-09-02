import { normalize } from "./normalize.mjs";
import { filterNoise } from "./filter-noise.mjs";
import { buildSections } from "./build-sections.mjs";
import { BRIEF_MAX_LINES, RECALL_NOTE, capBrief, formatSummary, wrapLongLines } from "./format.mjs";
import { selectRankedBriefBlocks } from "./rank.mjs";

const HEADER_NAMES = Object.freeze(["Session Goal", "Files And Changes", "Commits", "Outstanding Context", "User Preferences"]);
const HEADER_TOKENS = new Set(HEADER_NAMES.map((name) => `[${name}]`));
const SEPARATOR = "\n\n---\n\n";
// This marker is merge-local framing, not emitted checkpoint content. Putting it
// at position zero makes the following separator compiler-owned even when the
// brief itself contains indistinguishable markdown horizontal rules.
const DSH_BRIEF_FRAME = "<!-- child-conversation-compiler:brief -->";

const firstContentLine = (lines) => lines.findIndex((line) => line !== "");
const isStructuralSeparator = (lines, index) => lines[index] === "---"
  && index > 0 && lines[index - 1] === ""
  && index + 1 < lines.length && lines[index + 1] === "";

/** Parse only compiler structure; bracketed text and markdown inside the brief stay opaque. */
const summaryLayout = (text) => {
  const source = String(text ?? "").replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  const first = firstContentLine(lines);
  const empty = { lines, headings: [], boundary: -1, hasSemanticSections: false, framedBrief: false };
  if (first < 0) return empty;

  // dshFraming always places this at the known outer boundary of a brief-only
  // checkpoint. Only the frame at that leading structural position is owned.
  if (lines[first] === DSH_BRIEF_FRAME && isStructuralSeparator(lines, first + 2)) {
    return { ...empty, boundary: first + 2, framedBrief: true };
  }

  // Compiler semantic sections, when present, are a preamble. A token in a
  // sentence or later transcript line can therefore never create a section.
  if (!HEADER_TOKENS.has(lines[first])) return empty;

  let boundary = -1;
  for (let index = first + 1; index < lines.length; index += 1) {
    if (isStructuralSeparator(lines, index)) { boundary = index; break; }
  }
  const semanticEnd = boundary < 0 ? lines.length : boundary;
  const headings = [];
  for (let index = first; index < semanticEnd; index += 1) {
    if (HEADER_TOKENS.has(lines[index])) headings.push({ index, token: lines[index] });
  }
  return { lines, headings, boundary, hasSemanticSections: true, framedBrief: false };
};

export const hasSemanticSections = (text) => summaryLayout(text).hasSemanticSections;

export const sectionOf = (text, header) => {
  const layout = summaryLayout(text);
  if (!layout.hasSemanticSections) return "";
  const tag = `[${header}]`;
  const headingOffset = layout.headings.findIndex(({ token }) => token === tag);
  if (headingOffset < 0) return "";
  const start = layout.headings[headingOffset].index;
  const end = layout.headings[headingOffset + 1]?.index
    ?? (layout.boundary < 0 ? layout.lines.length : layout.boundary);
  return layout.lines.slice(start, end).join("\n").trim();
};

export const briefOf = (text) => {
  const layout = summaryLayout(text);
  if (layout.boundary < 0) return "";
  return layout.lines.slice(layout.boundary + 1).join("\n").trim();
};

/** Read formatter-wrapped bullets as logical section items. */
export const sectionItems = (section) => {
  const items = [];
  for (const line of String(section ?? "").split("\n").slice(1)) {
    if (line.startsWith("- ")) items.push(line.slice(2));
    else if (/^\s+\S/.test(line) && items.length > 0) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
};

export const mergeFileLines = (previous, fresh) => {
  const categories = ["Modified", "Created", "Read"];
  const merged = Object.fromEntries(categories.map((category) => [category, new Set()]));
  for (const text of [previous, fresh]) {
    for (const item of sectionItems(text)) {
      for (const category of categories) {
        const prefix = `${category}: `;
        if (!item.startsWith(prefix)) continue;
        const rest = item.slice(prefix.length).replace(/\s*\(\+\d+ more\)\s*$/, "");
        for (const path of rest.split(",")) if (path.trim()) merged[category].add(path.trim());
      }
    }
  }
  for (const path of merged.Modified) merged.Created.delete(path);
  const cap = (set, limit) => {
    const values = [...set];
    return values.length <= limit ? values.join(", ") : `${values.slice(0, limit).join(", ")} (+${values.length - limit} more)`;
  };
  const lines = [];
  if (merged.Modified.size > 0) lines.push(`- Modified: ${cap(merged.Modified, 10)}`);
  if (merged.Created.size > 0) lines.push(`- Created: ${cap(merged.Created, 10)}`);
  if (merged.Read.size > 0) lines.push(`- Read: ${cap(merged.Read, 10)}`);
  return lines.length > 0 ? `[Files And Changes]\n${lines.join("\n")}` : "";
};

export const mergeHeaderSection = (header, previous, fresh) => {
  if (header === "Outstanding Context") return fresh;
  if (!previous) return fresh;
  if (!fresh) return previous;
  if (header === "Files And Changes") return mergeFileLines(previous, fresh);
  const isClean = (item) => !item.includes("<skill") && !item.includes("</skill");
  const combined = [...new Set([...sectionItems(previous).filter(isClean), ...sectionItems(fresh).filter(isClean)])];
  const cap = header === "Session Goal" ? 8 : header === "Commits" ? 8 : 15;
  const capped = combined.length > cap ? combined.slice(-cap) : combined;
  return capped.length > 0 ? `[${header}]\n${capped.map((item) => `- ${item}`).join("\n")}` : "";
};

const briefLineCount = (text) => text ? text.split("\n").length : 0;
const capBriefToLineBudget = (text, maxLines) => {
  if (!text || maxLines <= 0) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(-maxLines);
  const firstHeader = kept.findIndex((line) => line === "[user]" || line === "[assistant]");
  const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
  const omitted = lines.length - clean.length;
  return `...(${omitted} earlier lines omitted)\n\n${clean.join("\n")}`;
};
const mergeBriefTranscriptWithFreshBudget = (previous, fresh) => {
  if (!previous) return fresh;
  if (!fresh) return capBrief(previous);
  const remainingPreviousLines = Math.max(0, BRIEF_MAX_LINES - briefLineCount(fresh));
  const previousTail = capBriefToLineBudget(previous, remainingPreviousLines);
  return previousTail ? `${previousTail}\n\n${fresh}` : fresh;
};

export const mergePrevious = (previous, fresh, options = {}) => {
  const headers = HEADER_NAMES.map((header) => mergeHeaderSection(header, sectionOf(previous, header), sectionOf(fresh, header))).filter(Boolean);
  const previousBrief = briefOf(previous);
  const freshBrief = briefOf(fresh);
  const mergedBrief = options.preserveFreshBrief
    ? mergeBriefTranscriptWithFreshBudget(previousBrief, freshBrief)
    : (!previousBrief ? freshBrief : !freshBrief ? previousBrief : `${previousBrief}\n\n${freshBrief}`);
  const parts = [];
  if (headers.length > 0) parts.push(headers.join("\n\n"));
  if (mergedBrief) parts.push(options.preserveFreshBrief ? mergedBrief : capBrief(mergedBrief));
  return parts.join(SEPARATOR);
};

export const stripRecallNote = (text) => {
  const original = String(text ?? "");
  const normalized = original.replace(/\r\n/g, "\n");
  const trimmed = normalized.trimEnd();
  const footer = SEPARATOR + RECALL_NOTE;
  if (!trimmed.endsWith(footer)) return original;
  return trimmed.slice(0, -footer.length).trimEnd();
};

const compileWithBriefBlocks = (input, options = {}) => {
  const blocks = filterNoise(normalize(input?.messages ?? []));
  const briefBlocks = options.briefBlocksFor?.(blocks);
  const data = buildSections({ blocks, briefBlocks, fileOps: input?.fileOps });
  const fresh = formatSummary(data, { capBriefTranscript: options.capFreshBrief ?? true });
  let previous = input?.previousSummary ? stripRecallNote(input.previousSummary) : undefined;
  let mergeableFresh = fresh;
  // DSH adaptation: a huge one-line task can legitimately produce a brief with
  // no semantic headers. Frame every such value at its known outer boundary;
  // separator-like user content must never influence ownership. The source-pure
  // formatter remains unchanged because this frame exists only during merging.
  if (input?.dshFraming) {
    const frameBriefOnly = (text) => {
      if (!text) return text;
      const layout = summaryLayout(text);
      if (layout.hasSemanticSections || layout.framedBrief) return text;
      return `${DSH_BRIEF_FRAME}${SEPARATOR}${text}`;
    };
    previous = frameBriefOnly(previous);
    mergeableFresh = frameBriefOnly(mergeableFresh);
  }
  const merged = previous ? mergePrevious(previous, mergeableFresh, { preserveFreshBrief: options.preserveFreshBriefOnMerge }) : fresh;
  if (!merged) return "";
  return wrapLongLines(merged + SEPARATOR + RECALL_NOTE);
};

export const compile = (input) => compileWithBriefBlocks(input);
export const compileRanked = (input) => compileWithBriefBlocks(input, {
  briefBlocksFor: (blocks) => selectRankedBriefBlocks(blocks, {
    ...input?.ranking,
    fileOps: input?.ranking?.fileOps ?? input?.fileOps,
  }),
  capFreshBrief: false,
  preserveFreshBriefOnMerge: true,
});
