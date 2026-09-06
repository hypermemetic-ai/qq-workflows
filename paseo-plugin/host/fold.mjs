import { ARCHITECT_SYSTEM_PROMPT } from "./prompts.mjs";

export const TICKET_BLOCK_HEADING = "Current ticket (`.architect/ticket.md`)";

export function ticketBlock(ticketText) {
  return `${TICKET_BLOCK_HEADING}:\n\n${String(ticketText ?? "")}`;
}

export function keptPairs(pairs) {
  const list = Array.isArray(pairs) ? pairs.filter((pair) => pair && typeof pair === "object") : [];
  return list.slice(-2);
}

export function assembleArchitectRequest({
  systemPrompt = ARCHITECT_SYSTEM_PROMPT,
  ticketText = "",
  pairs = [],
  operatorText,
} = {}) {
  const previous = keptPairs(pairs).slice(-1);
  const input = [
    { role: "user", content: ticketBlock(ticketText) },
  ];
  for (const pair of previous) {
    input.push({ role: "user", content: String(pair.operator ?? "") });
    input.push({ role: "assistant", content: String(pair.architect ?? "") });
  }
  if (operatorText != null) input.push({ role: "user", content: String(operatorText) });
  return {
    instructions: systemPrompt,
    input,
  };
}

export function rememberPair(pairs, operatorText, architectText) {
  return keptPairs([
    ...(Array.isArray(pairs) ? pairs : []),
    { operator: String(operatorText ?? ""), architect: String(architectText ?? "") },
  ]);
}
