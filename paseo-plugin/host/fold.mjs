import { ARCHITECT_SYSTEM_PROMPT } from "./workflow/prompts.mjs";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

export const CONVERSATION_TOKEN_FLOOR = 2048;
const tokenizer = new Tiktoken(o200kBase);

// Count conversation text only, using the same proxy as the retention measurement.
export function conversationTokens(text) {
  return tokenizer.encode(String(text ?? ""), [], []).length;
}

function retain(pairs, minimum, tokens = 0) {
  const list = Array.isArray(pairs) ? pairs.filter((pair) => pair && typeof pair === "object") : [];
  let start = list.length;
  while (start > 0 && (list.length - start < minimum || tokens < CONVERSATION_TOKEN_FLOOR)) {
    const pair = list[--start];
    tokens += conversationTokens(pair.operator) + conversationTokens(pair.architect);
  }
  return list.slice(start);
}

export function requestPairs(pairs, operatorText) {
  return retain(pairs, 1, conversationTokens(operatorText));
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
    input.push({ role: "user", content: String(pair.operator ?? "") });
    input.push({ role: "assistant", content: String(pair.architect ?? "") });
  }
  if (operatorText != null) input.push({ role: "user", content: String(operatorText) });
  return {
    instructions: systemPrompt,
    input,
  };
}

export function rememberPair(pairs, operatorText, architectText, messageId) {
  return keptPairs([
    ...(Array.isArray(pairs) ? pairs : []),
    { operator: String(operatorText ?? ""), architect: String(architectText ?? ""), ...(messageId ? { messageId } : {}) },
  ]);
}
