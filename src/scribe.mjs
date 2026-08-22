// Note + brief prompts and parse. The one-shot hop lives on qq.

export const NOTE_MAX_CHARS = 280;

export const CLERK_SYSTEM = [
  "You are the architect clerk. The notebook is the standing board, not a diary.",
  "You receive the live board and a spine of the latest operator+architect turn.",
  "Rewrite the standing board to what still matters. Output the full standing set:",
  "FACT <settled standing fact> [startSeq-endSeq]",
  "LEFTOVER <still open under this concern> [startSeq-endSeq]",
  "Keep untouched standing lines. Drop what this turn settled. Cite the original seqs;",
  "new lines use this turn's seqs from the spine.",
  "LOOK startSeq-endSeq if you must read a cited span to settle doubt. Then wait.",
  "NOTHING if the spine does not change the board.",
  "Do not recap the turn. Do not paste the board. Do not append a diary line.",
  "A recap dump or unprefixed diary line is refused: rewrite as FACT or LEFTOVER lines. Do not stop.",
  `Each line max ${NOTE_MAX_CHARS} characters.`,
].join("\n");

export const PACKET_SYSTEM = [
  "You compile an invoke packet for a live child session.",
  "Read the live board and the DSH log spine (text + tool names only). Write a short packet the child can start from.",
  "If a return address is given, include it so the child knows the parent session. Do not invent a mailbox.",
  "No reasoning. No tool dumps. No essay.",
].join("\n");

/** Resolve the note/brief binding from explicit config or architect settings. */
export function resolveScribeBinding(config = {}, _env = process.env) {
  if (config.scribe && typeof config.scribe.provider === "string" && typeof config.scribe.model === "string") {
    return {
      provider: config.scribe.provider,
      model: config.scribe.model,
      effort: config.scribe.effort,
    };
  }
  if (config.settings && typeof config.settings.get === "function") {
    return config.settings.get("scribe");
  }
  return null;
}

const BOARD_KIND = /^(fact|leftover)\b\s*:?\s*(\S.*)$/i;
const CITED_LINE = /^(.*)\s+\[(\d+)\s*-\s*(\d+)\]\s*$/;

/** FACT (still true) or LEFTOVER (still open). Recap dumps have no kind. */
export function boardKind(text) {
  const match = BOARD_KIND.exec(String(text ?? "").trim());
  return match ? match[1].toLowerCase() : null;
}

function boardLine(text) {
  return Boolean(boardKind(text))
    || /^look\b/i.test(String(text ?? "").trim())
    || /\bwithdrawn\b/i.test(String(text ?? "").trim());
}

/** True when clerk output is a notebook paste, fold stub, or overlong dump. */
export function isClerkDump(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return false;
  const lines = trimmed.split(/\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 0 && lines.every(boardLine)) {
    return lines.some((line) => line.length > NOTE_MAX_CHARS);
  }
  if (trimmed.length > NOTE_MAX_CHARS) return true;
  if (/^card\s+\S+\s+\((open|closed)\)/i.test(trimmed)) return true;
  if (/Dropped conversation seq\s+\d+/i.test(trimmed)) return true;
  if (lines.length > 4) return true;
  return false;
}

export function parseCitedLine(text) {
  const trimmed = String(text ?? "").trim();
  const cited = CITED_LINE.exec(trimmed);
  if (!cited) return { text: trimmed };
  return {
    text: cited[1].trim(),
    startSeq: Number(cited[2]),
    endSeq: Number(cited[3]),
  };
}

export function parseLookRanges(text) {
  const ranges = [];
  const source = String(text ?? "");
  const re = /(\d+)\s*-\s*(\d+)/g;
  let match = re.exec(source);
  while (match) {
    const startSeq = Number(match[1]);
    const endSeq = Number(match[2]);
    if (Number.isSafeInteger(startSeq) && Number.isSafeInteger(endSeq)) {
      ranges.push({ startSeq, endSeq });
    }
    match = re.exec(source);
  }
  return ranges;
}

export function parseClerkOutput(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed || /^(nothing|none|\(none\)|n\/a)$/i.test(trimmed)) {
    return { action: "nothing" };
  }
  if (isClerkDump(trimmed)) {
    return {
      action: "error",
      reason: `refused: recap dump or overlong. Write FACT or LEFTOVER lines (max ${NOTE_MAX_CHARS}).`,
    };
  }
  const lines = trimmed.split(/\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return { action: "nothing" };
  if (lines.every((line) => /^look\b/i.test(line))) {
    const ranges = parseLookRanges(trimmed);
    if (ranges.length === 0) {
      return { action: "error", reason: "refused: LOOK needs startSeq-endSeq." };
    }
    return { action: "look", ranges };
  }
  if (lines.length === 1 && (/\bwithdrawn\b/i.test(lines[0]) || /^x withdrawn/i.test(lines[0]))) {
    return { action: "withdraw", text: lines[0] };
  }
  const notes = [];
  for (const line of lines) {
    if (/^look\b/i.test(line)) {
      return { action: "look", ranges: parseLookRanges(trimmed) };
    }
    if (/\bwithdrawn\b/i.test(line)) continue;
    if (!boardKind(line)) {
      return { action: "error", reason: "refused: need FACT or LEFTOVER lines." };
    }
    notes.push(parseCitedLine(line));
  }
  if (notes.length === 0) return { action: "nothing" };
  if (notes.length === 1) return { action: "note", text: notes[0].text, notes };
  return { action: "board", notes };
}
