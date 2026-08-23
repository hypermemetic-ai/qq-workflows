// Talking architect tools: working-memory write, delegate, and optional rundown.

import { randomUUID } from "node:crypto";
import { bodyOf, titleOf } from "./casefile.mjs";

function textBlock(text) {
  return { type: "text", text };
}

function refusal(reason) {
  return { status: "refused", reason };
}

function buildRundownTool(tasks) {
  return {
    name: "rundown",
    description: "Report on the live documents. Cites spoken ids as an index to the originals.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          status: { type: "string" },
          report: { type: "string" },
          reason: { type: "string" },
        },
      },
      render: (_args, value) => [textBlock(value.status === "refused" ? `Rundown refused: ${value.reason}` : value.report || "(empty pile)")],
    },
    async execute() {
      try {
        if (typeof tasks?.rundown !== "function") return refusal("rundown requires qq-tasks");
        return { status: "ok", report: await tasks.rundown() };
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
    },
  };
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
    description: "Replace working memory for this session. Send the whole small markdown document, not a patch.",
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
        return { status: "ok", title: titleOf(written.text), ...(id ? { id } : {}) };
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function buildArchitectTools({ delegate, tasks, cases } = {}) {
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
  if (cases && typeof cases.write === "function") tools.push(buildCaseWriteTool(cases, tasks));
  if (typeof tasks?.rundown === "function") tools.push(buildRundownTool(tasks));
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

export const internals = Object.freeze({ textBlock, refusal });
