// Note + brief prompts and parse. The one-shot hop lives on qq.

export const NOTE_MAX_CHARS = 280;

export const CLERK_SYSTEM = [
  "You are the architect clerk. The notebook is the standing board, not a diary.",
  "You receive the live board and a spine of the latest operator+architect turn.",
  "Update the board with at most one short line:",
  "FACT <settled standing fact>",
  "LEFTOVER <still open under this concern>",
  "X withdrawn / replaced by <what is done>",
  "NOTHING if the spine adds no durable fact.",
  "Do not recap the turn. Do not paste the board. Do not write User: or operator. Do not list tools.",
  `Max ${NOTE_MAX_CHARS} characters. A dump is NOTHING.`,
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

/** True when clerk output is a notebook paste, turn recap, or overlong dump. */
export function isClerkDump(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return false;
  if (trimmed.length > NOTE_MAX_CHARS) return true;
  if (/^card\s+\S+\s+\((open|closed)\)/i.test(trimmed)) return true;
  if (/Dropped conversation seq\s+\d+/i.test(trimmed)) return true;
  if (/^(-\s*)?User\b/i.test(trimmed)) return true;
  if (trimmed.includes("\n") && trimmed.split(/\n/).length > 4) return true;
  return false;
}

export function parseClerkOutput(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed || /^(nothing|none|\(none\)|n\/a)$/i.test(trimmed)) {
    return { action: "nothing" };
  }
  if (isClerkDump(trimmed)) {
    return { action: "nothing" };
  }
  if (/\bwithdrawn\b/i.test(trimmed) || /^x withdrawn/i.test(trimmed)) {
    return { action: "withdraw", text: trimmed };
  }
  return { action: "note", text: trimmed };
}
