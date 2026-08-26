// Talking architect tools: working-memory write and delegate.

import { randomUUID } from "node:crypto";
import { bodyOf, titleOf } from "./casefile.mjs";
import { buildLandTool } from "./land-tools.mjs";

function textBlock(text) {
  return { type: "text", text };
}

function refusal(reason) {
  return { status: "refused", reason };
}

function syncTask(cases, tasks, sessionId, text) {
  if (!tasks || typeof tasks.create !== "function" || typeof tasks.edit !== "function") {
    return cases.taskId?.(sessionId) ?? null;
  }
  const title = titleOf(text);
  const body = bodyOf(text);
  let id = cases.taskId?.(sessionId) ?? null;
  if (id) {
    try {
      tasks.edit(id, { title, body });
      return id;
    } catch {
      id = null;
    }
  }
  id = String(tasks.create({ title, body }));
  cases.bind(sessionId, id);
  return id;
}

function buildCaseWriteTool(cases, tasks) {
  return {
    name: "case_write",
    description: "Replace working memory for this session and end the turn. Send the whole small markdown document, not a patch.",
    parameters: {
      text: { type: "string", description: "Full markdown of working memory." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          status: { type: "string" },
          title: { type: "string" },
          id: { type: "string" },
          reason: { type: "string" },
        },
      },
      render: (_args, value) => {
        if (value.status === "refused") return [textBlock(`Case write refused: ${value.reason}`)];
        return [textBlock(`working memory updated: ${value.title}${value.id ? ` (${value.id})` : ""}`)];
      },
    },
    async execute(args, exec) {
      try {
        const sessionId = exec?.agent?.session?.id;
        if (!sessionId) return refusal("case_write requires a live session");
        if (typeof args?.text !== "string") return refusal("case_write requires text");
        const written = cases.write(sessionId, args.text);
        const id = syncTask(cases, tasks, sessionId, written.text);
        try { exec?.concludeTurn?.(); } catch { /* write already committed */ }
        return { status: "ok", title: titleOf(written.text), ...(id ? { id } : {}) };
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function buildArchitectTools({ delegate, tasks, cases, land } = {}) {
  const tools = [{
    name: "delegate",
    description: "Start one live child from working memory. Results return through qq-relay default steer.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          status: { type: "string" },
          child: { type: "string" },
          alias: { type: "string" },
          reason: { type: "string" },
        },
      },
      render: (_args, value) => [textBlock(value.status === "refused" ? `Delegate refused: ${value.reason}` : `delegated ${value.alias || value.child}`)],
    },
    async execute(_args, exec) {
      try {
        if (!delegate) return refusal("delegate is unavailable");
        return await delegate({ agent: exec?.agent });
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
    },
  }];
  if (typeof land === "function") tools.push(buildLandTool({ invoke: land }));
  if (cases && typeof cases.write === "function") tools.push(buildCaseWriteTool(cases, tasks));
  return tools;
}

export function pluginUserMessage(text, form = "notice") {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "qq-workflows", form },
  };
}

export const CASE_WRITE_GATE_TEXT = "Call case_write to end the turn.";
export const CASE_WRITE_GATE_LIMIT = 8;

function reasonKind(reason) {
  return reason && typeof reason === "object" ? reason.kind : reason;
}

export function isExceptionalTurn(reason) {
  const kind = reasonKind(reason);
  return kind === "aborted" || kind === "interrupted";
}

function sliceTurn(events, turn) {
  const list = Array.isArray(events) ? events : [];
  let start = -1;
  let end = list.length;
  for (let i = 0; i < list.length; i += 1) {
    const event = list[i];
    const eventTurn = event?.data?.turn;
    if (event?.type === "turn/start" && (turn === undefined || eventTurn === turn)) start = i;
    if (event?.type === "turn/end" && (turn === undefined || eventTurn === turn) && start >= 0) {
      end = i + 1;
      if (turn !== undefined) break;
    }
  }
  if (start >= 0) return list.slice(start, end);
  if (Number.isSafeInteger(turn)) return list.filter((event) => event?.data?.turn === turn);
  return list;
}

export function decideCaseWriteGate(events, { turn, reason } = {}) {
  if (isExceptionalTurn(reason)) return { action: "pass", reason: "aborted" };
  const slice = sliceTurn(events, turn);
  const wrote = slice.some((event) => event?.type === "tool/call" && event.data?.name === "case_write");
  if (wrote) return { action: "pass", reason: "wrote" };
  return { action: "hold", reason: "no-write" };
}

export const internals = Object.freeze({ textBlock, refusal, reasonKind, sliceTurn });
