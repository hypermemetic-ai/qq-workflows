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
  const valid = (Array.isArray(pairs) ? pairs : []).filter(pair => pair && typeof pair === "object");
  let operators = 0;
  for (let i = valid.length - 1; i >= 0; i--) {
    if (!isWakePair(valid[i]) && ++operators === count) return valid.slice(i);
  }
  return valid;
}

export function isWakePair(pair) {
  return pair?.source === "wake" || String(pair?.messageId ?? "").startsWith("wake:");
}

export function contextWindow(pairs, messageId) {
  const first = pairs[0];
  return {
    userMessageIds: [...pairs.filter(pair => !isWakePair(pair)).map(pair => pair.messageId), messageId].filter(id => id && !id.startsWith("wake:")),
    ...(first?.trimmed && first.messageId ? { firstExchange: {
      messageId: first.messageId, operator: first.operator, architect: first.architect,
    } } : {}),
  };
}

export function requestPairs(pairs, operatorText, source = "operator") {
  return retain(pairs, source === "wake" ? 2 : 1);
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
  source = "operator",
} = {}) {
  const previous = requestPairs(pairs, operatorText, source);
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

export function rememberPair(pairs, operatorText, architectText, messageId, items, source = "operator") {
  return keptPairs([
    ...(Array.isArray(pairs) ? pairs : []),
    { source, operator: String(operatorText ?? ""), architect: String(architectText ?? ""), ...(messageId ? { messageId } : {}), ...(items ? { items } : {}) },
  ]);
}
