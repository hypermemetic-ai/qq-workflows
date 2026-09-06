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
    const size = conversationTokens(pair.operator) + conversationTokens(pair.architect);
    if (list.length - start > minimum && tokens + size > CONVERSATION_TOKEN_FLOOR) {
      const budget = CONVERSATION_TOKEN_FLOOR - tokens;
      const architect = tokenSuffix(pair.architect, budget);
      const operator = conversationTokens(pair.architect) < budget
        ? tokenSuffix(pair.operator, budget - conversationTokens(architect)) : "";
      return [{ ...pair, operator, architect, trimmed: true }, ...list.slice(start + 1)];
    }
    tokens += size;
  }
  return list.slice(start);
}

// Keep a text suffix within the budget without cutting through a UTF-8 character.
export function tokenSuffix(value, budget) {
  const text = String(value ?? "");
  if (budget <= 0) return "";
  const encoded = tokenizer.encode(text, [], []);
  if (encoded.length <= budget) return text;
  for (let start = encoded.length - budget; start < encoded.length; start++) {
    const suffix = tokenizer.decode(encoded.slice(start));
    if (text.endsWith(suffix) && conversationTokens(suffix) <= budget) return suffix;
  }
  return "";
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
    if (pair.operator) input.push({ role: "user", content: String(pair.operator) });
    if (pair.architect) input.push({ role: "assistant", content: String(pair.architect) });
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
