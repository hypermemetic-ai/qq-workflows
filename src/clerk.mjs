// Off-talking clerk. Fires after turn/end of an operator+architect pair.
// Never on send. Never after every tool. Host/land/relay injects that are
// not operator talk are skipped.

import { CLERK_SYSTEM, PACKET_SYSTEM, parseClerkOutput, runScribe } from "./scribe.mjs";

const USER_EXTRACT_CHARS = 240;
const TOOL_DUMP_CHARS = 80;

function messageText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function eventText(event) {
  if (event?.type === "user/message") return messageText(event.data);
  if (event?.type === "assistant/message") return messageText(event.data?.message);
  if (event?.type === "tool/result") return messageText(event.data?.message);
  return "";
}

function userSourceKind(event) {
  return event?.type === "user/message" ? event.data?.source?.kind : undefined;
}

function userSourcePlugin(event) {
  return event?.data?.source?.plugin;
}

function userSourceForm(event) {
  return event?.data?.source?.form;
}

/** True when this user/message is operator talk, not a host/land/relay inject. */
export function isOperatorUserMessage(event) {
  if (event?.type !== "user/message") return false;
  const source = event.data?.source;
  if (!source || source.kind === "user") return true;
  if (source.kind === "plugin") return false;
  return false;
}

/** True when the turn contains at least one operator user message. */
export function turnHasOperatorTalk(events) {
  return events.some(isOperatorUserMessage);
}

function eventTurn(event) {
  if (event.type === "turn/start" || event.type === "turn/end") return event.data?.turn;
  if (event.data && typeof event.data.turn === "number") return event.data.turn;
  return undefined;
}

/** Slice one turn, including user/message events that carry no turn field. */
function eventsForTurn(events, turn) {
  const slice = [];
  let current;
  for (const event of events) {
    if (event.type === "turn/start") current = event.data?.turn;
    const marked = eventTurn(event);
    if (marked === turn || current === turn) slice.push(event);
    if (event.type === "turn/end" && event.data?.turn === turn) break;
    if (event.type === "turn/end") current = undefined;
  }
  return slice;
}

/**
 * Model-free spine of one settled turn: seqs, speaker, tool names, sizes,
 * short extract of user text. Not the dump. Not reasoning.
 */
export function buildSpine(events, turn) {
  const slice = Number.isSafeInteger(turn) ? eventsForTurn(events, turn) : events;
  const start = slice[0];
  const end = slice.at(-1);
  const tools = [];
  let userExtract = "";
  let speaker = "none";
  for (const event of slice) {
    if (event.type === "user/message") {
      speaker = isOperatorUserMessage(event) ? "operator" : `plugin:${userSourcePlugin(event) ?? "unknown"}`;
      if (!userExtract) {
        const text = eventText(event).trim().replace(/\s+/g, " ");
        userExtract = text.slice(0, USER_EXTRACT_CHARS);
      }
    } else if (event.type === "assistant/message" && speaker === "none") {
      speaker = "architect";
    } else if (event.type === "tool/call") {
      tools.push({
        name: event.data?.name ?? "unknown",
        phase: "call",
        size: String(event.data?.arguments ?? "").length,
      });
    } else if (event.type === "tool/result") {
      const text = eventText(event);
      tools.push({
        name: event.data?.message?.name ?? event.data?.name ?? "result",
        phase: "result",
        size: text.length,
      });
    }
  }
  return {
    startSeq: start?.seq ?? 0,
    endSeq: end?.seq ?? start?.seq ?? 0,
    turn: turn ?? start?.data?.turn ?? null,
    speaker,
    tools,
    userExtract,
    empty: slice.length === 0 || (!userExtract && tools.length === 0),
  };
}

export function formatNotebookForScribe(notebook) {
  const cards = notebook?.cards ?? [];
  if (cards.length === 0) return "(empty notebook)";
  return cards.map((card) => {
    const flag = card.open ? "open" : "closed";
    const notes = card.notes.length === 0
      ? "  (no notes)"
      : card.notes.map((note) => `  - ${note.text} [${note.startSeq}-${note.endSeq}]`).join("\n");
    const stubs = (card.stubs ?? []).length === 0
      ? ""
      : `\n  stubs:\n${card.stubs.map((stub) => `  - [${stub.startSeq}-${stub.endSeq}] ${stub.text}`).join("\n")}`;
    return `card ${card.name} (${flag})\n${notes}${stubs}`;
  }).join("\n\n");
}

export function formatSpine(spine) {
  const tools = spine.tools.length === 0
    ? "none"
    : spine.tools.map((tool) => `${tool.name}:${tool.phase}:${tool.size}`).join(", ");
  return [
    `seq ${spine.startSeq}-${spine.endSeq} turn ${spine.turn ?? "-"} speaker ${spine.speaker}`,
    `tools ${tools}`,
    `user ${spine.userExtract || "(none)"}`,
  ].join("\n");
}

/**
 * Log spine for invoke packets: text + tool names; no reasoning, no dumps.
 * Stops at foldPoint when provided (inclusive).
 */
export function buildLogSpine(events, { foldPoint } = {}) {
  const limited = Number.isSafeInteger(foldPoint)
    ? events.filter((event) => event.seq <= foldPoint)
    : events;
  const lines = [];
  for (const event of limited) {
    if (event.type === "user/message" || event.type === "assistant/message") {
      const speaker = event.type === "user/message"
        ? (isOperatorUserMessage(event) ? "operator" : `plugin:${userSourcePlugin(event) ?? "unknown"}`)
        : "architect";
      const text = eventText(event).trim().replace(/\s+/g, " ").slice(0, USER_EXTRACT_CHARS);
      if (text) lines.push(`${event.seq} ${speaker}: ${text}`);
    } else if (event.type === "tool/call") {
      lines.push(`${event.seq} tool ${event.data?.name ?? "unknown"}`);
    } else if (event.type === "tool/result") {
      const size = eventText(event).length;
      const name = event.data?.message?.name ?? "result";
      const extract = eventText(event).trim().replace(/\s+/g, " ").slice(0, TOOL_DUMP_CHARS);
      lines.push(`${event.seq} result ${name} size=${size}${extract ? ` ${extract}` : ""}`);
    }
  }
  return lines.join("\n");
}

export function createClerk({ store, llm, binding, run = runScribe } = {}) {
  async function fire({ sessionId, events, turn }) {
    const slice = Number.isSafeInteger(turn) ? eventsForTurn(events, turn) : events;
    if (!turnHasOperatorTalk(slice)) return { action: "skip", reason: "not-operator" };
    const spine = buildSpine(events, turn);
    if (spine.empty) return { action: "nothing", reason: "empty-spine" };
    const notebook = store.load(sessionId);
    const user = [
      "Notebook:",
      formatNotebookForScribe(notebook),
      "",
      "Turn spine:",
      formatSpine(spine),
    ].join("\n");
    const raw = await run(llm, binding, { system: CLERK_SYSTEM, user });
    const parsed = parseClerkOutput(raw);
    if (parsed.action === "nothing") return parsed;
    const citation = { startSeq: spine.startSeq, endSeq: spine.endSeq };
    if (parsed.action === "withdraw") {
      store.appendWithdraw(sessionId, { text: parsed.text, ...citation });
    } else {
      store.appendNote(sessionId, { text: parsed.text, ...citation });
    }
    return { ...parsed, ...citation };
  }

  async function compilePacket({ sessionId, events, foldPoint }) {
    const notebook = store.load(sessionId);
    const user = [
      "Notebook:",
      formatNotebookForScribe(notebook),
      "",
      "DSH log (text + tool names; no reasoning, no dumps):",
      buildLogSpine(events, { foldPoint }) || "(empty)",
    ].join("\n");
    const packet = await run(llm, binding, { system: PACKET_SYSTEM, user });
    return packet;
  }

  return Object.freeze({ fire, compilePacket });
}

export const internals = Object.freeze({
  USER_EXTRACT_CHARS,
  eventsForTurn,
  eventText,
  messageText,
  userSourceKind,
  userSourceForm,
});
