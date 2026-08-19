// Note + brief prompts and parse. The one-shot hop lives on qq.

export const CLERK_SYSTEM = [
  "You are the architect clerk. You receive the notebook and a spine of the latest operator+architect turn.",
  "Append one short note, or one withdraw line (\"X withdrawn / replaced by \u2026\"), or output NOTHING if the spine is empty or adds no durable fact.",
  "Do not dump the turn. Do not write reasoning. Do not rewrite the notebook.",
].join("\n");

export const PACKET_SYSTEM = [
  "You compile an invoke packet for a live child session.",
  "Read the notebook and the DSH log spine (text + tool names only). Write a short packet the child can start from.",
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

export function parseClerkOutput(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed || /^(nothing|none|\(none\)|n\/a)$/i.test(trimmed)) {
    return { action: "nothing" };
  }
  if (/\bwithdrawn\b/i.test(trimmed) || /^x withdrawn/i.test(trimmed)) {
    return { action: "withdraw", text: trimmed };
  }
  return { action: "note", text: trimmed };
}
