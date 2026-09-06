import { ARCHITECT_SYSTEM_PROMPT } from "./workflow/prompts.mjs";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

// No token floor until normal Architect usage provides a baseline.
export const CONVERSATION_TOKEN_FLOOR = 0;
const tokenizer = new Tiktoken(o200kBase);
export function conversationTokens(text) {
  return tokenizer.encode(String(text ?? ""), [], []).length;
}
function retain(pairs, count) {
  return (Array.isArray(pairs) ? pairs : []).filter(pair => pair && typeof pair === "object").slice(-count);
}

export function contextWindow(pairs, messageId) {
  const first = pairs[0];
  return {
    userMessageIds: [...pairs.map(pair => pair.messageId), messageId].filter(Boolean),
    ...(first?.trimmed && first.messageId ? { firstExchange: {
      messageId: first.messageId, operator: first.operator, architect: first.architect,
    } } : {}),
  };
}

export function requestPairs(pairs, operatorText) {
  return retain(pairs, 1);
}

export const TICKET_BLOCK_HEADING = "Current ticket (`.architect/ticket.md`)";

export function ticketBlock(ticketText) {
  return `${TICKET_BLOCK_HEADING}:\n\n${String(ticketText ?? "")}`;
}

export function keptPairs(pairs) {
  return retain(pairs, 2);
}

export function assembleArchitectRequest({
  systemPrompt = ARCHITECT_SYSTEM_PROMPT,
  ticketText = "",
  pairs = [],
  operatorText,
} = {}) {
  const previous = requestPairs(pairs, operatorText);
  const input = [
    { role: "user", content: ticketBlock(ticketText) },
  ];
  for (const pair of previous) {
    if (Array.isArray(pair.items)) { input.push(...pair.items); continue; }
    if (pair.operator) input.push({ role: "user", content: String(pair.operator) });
    if (pair.architect) input.push({ role: "assistant", content: String(pair.architect) });
  }
  if (operatorText != null) input.push({ role: "user", content: String(operatorText) });
  return {
    instructions: systemPrompt,
    input,
  };
}

export function rememberPair(pairs, operatorText, architectText, messageId, items) {
  return keptPairs([
    ...(Array.isArray(pairs) ? pairs : []),
    { operator: String(operatorText ?? ""), architect: String(architectText ?? ""), ...(messageId ? { messageId } : {}), ...(items ? { items } : {}) },
  ]);
}
