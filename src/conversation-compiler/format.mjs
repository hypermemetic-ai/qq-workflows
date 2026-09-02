import {
  CHARS_PER_TOKEN,
  COMMIT_CAP,
  COMPILER_MARKER,
  FILE_CAP,
  GOAL_CAP,
  MAX_BLOCKS,
  PREFERENCE_CAP,
  RECALL_NOTE,
} from "./constants.mjs";
import { unique, wrapLine } from "./normalize.mjs";
import { compilerBudgetTokens } from "./ranking.mjs";

const HEADINGS = Object.freeze({
  goals: "Session Goal",
  files: "Files And Changes",
  commits: "Commits",
  outstanding: "Outstanding Context",
  preferences: "User Preferences",
  brief: "Chronological Brief",
});

function values(lines) {
  return unique(lines.filter((line) => line && line !== "None recorded."));
}

export function parseCompiledConversation(text) {
  const parsed = { goals: [], files: [], commits: [], outstanding: [], preferences: [], brief: [] };
  if (typeof text !== "string" || !text.includes(COMPILER_MARKER)) return parsed;
  const keyByHeading = new Map(Object.entries(HEADINGS).map(([key, heading]) => [heading, key]));
  let section = null;
  for (const raw of text.split("\n")) {
    const heading = raw.match(/^## (.+)$/)?.[1];
    if (heading) {
      section = keyByHeading.get(heading) ?? null;
      continue;
    }
    if (!section || raw.startsWith("> ")) continue;
    if (raw.startsWith("- ")) parsed[section].push(raw.slice(2));
    else if (/^  \S/.test(raw) && parsed[section].length > 0) parsed[section][parsed[section].length - 1] += ` ${raw.trim()}`;
  }
  for (const key of Object.keys(parsed)) parsed[key] = values(parsed[key]);
  return parsed;
}

function briefLine(block) {
  return `#${block.seq} ${block.role}: ${String(block.text ?? "")}`;
}

function section(title, items) {
  const body = items.length > 0 ? items : ["None recorded."];
  return [`## ${title}`, ...body.map((item) => wrapLine(`- ${item}`))].join("\n");
}

function render(state) {
  const sections = [
    section(HEADINGS.goals, state.goals),
    ...(state.files.length > 0 ? [section(HEADINGS.files, state.files)] : []),
    section(HEADINGS.commits, state.commits),
    section(HEADINGS.outstanding, state.outstanding),
    section(HEADINGS.preferences, state.preferences),
    section(HEADINGS.brief, state.brief),
  ];
  return [COMPILER_MARKER, ...sections, RECALL_NOTE].join("\n\n");
}

function shrinkEntry(value, maximum) {
  const text = String(value);
  if (text.length <= maximum) return text;
  const citation = text.match(/^#\d+\s+/)?.[0] ?? "";
  const available = Math.max(1, maximum - citation.length - 3);
  const head = Math.ceil(available * 0.45);
  const tail = Math.floor(available * 0.55);
  return `${citation}${text.slice(citation.length, citation.length + head).trimEnd()} … ${text.slice(-tail).trimStart()}`;
}

export function mergeCompiledState(fresh, previous, freshBrief, previousBrief, blockCount, charsPerToken = CHARS_PER_TOKEN) {
  const state = {
    goals: unique([...fresh.goals, ...previous.goals]).slice(0, GOAL_CAP),
    files: unique([...fresh.files, ...previous.files]).slice(0, FILE_CAP),
    commits: unique([...fresh.commits, ...previous.commits]).slice(0, COMMIT_CAP),
    outstanding: unique(fresh.outstanding), // stale obligations never survive merely because an older checkpoint named them
    preferences: unique([...fresh.preferences, ...previous.preferences]).slice(0, PREFERENCE_CAP),
    brief: unique([...freshBrief.map(briefLine), ...previousBrief]).slice(0, MAX_BLOCKS),
  };
  const ceiling = Math.floor(compilerBudgetTokens(blockCount) * charsPerToken);
  let output = render(state);
  // Previous history is at the tail by design. Repeated compaction sheds that
  // oldest material first while keeping the new overview and one recall note.
  while (output.length > ceiling && state.brief.length > Math.min(4, freshBrief.length)) {
    state.brief.pop();
    output = render(state);
  }
  for (const key of ["files", "preferences", "commits", "goals", "outstanding"]) {
    while (output.length > ceiling && state[key].length > 1) {
      state[key].pop();
      output = render(state);
    }
  }
  // An adversarial single "word" may be arbitrarily long and therefore evade
  // significant-word caps. Converge it with deterministic head/tail retention.
  const keys = ["brief", "goals", "files", "commits", "outstanding", "preferences"];
  while (output.length > ceiling) {
    let candidate = null;
    for (const key of keys) {
      for (let index = 0; index < state[key].length; index += 1) {
        const length = state[key][index].length;
        if (length > 80 && (!candidate || length > candidate.length)) candidate = { key, index, length };
      }
    }
    if (!candidate) throw new Error(`child conversation compiler could not satisfy ${ceiling}-character budget`);
    const reduction = Math.max(16, output.length - ceiling + 8);
    state[candidate.key][candidate.index] = shrinkEntry(
      state[candidate.key][candidate.index],
      Math.max(80, candidate.length - reduction),
    );
    output = render(state);
  }
  return output;
}
