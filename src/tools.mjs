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

function editCaseText(args, current) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("case_write requires a full rewrite or patch");
  }
  const hasText = Object.hasOwn(args, "text");
  const hasPatch = Object.hasOwn(args, "old_string")
    || Object.hasOwn(args, "new_string")
    || Object.hasOwn(args, "replace_all");
  if (hasText) {
    if (hasPatch) throw new Error("case_write accepts either text or a patch, not both");
    if (typeof args.text !== "string") throw new Error("case_write requires text to be a string");
    return args.text;
  }
  if (typeof args.old_string !== "string" || typeof args.new_string !== "string") {
    throw new Error("case_write patch requires old_string and new_string");
  }
  if (!args.old_string) throw new Error("case_write patch requires a non-empty old_string");
  if (args.replace_all !== undefined && typeof args.replace_all !== "boolean") {
    throw new Error("case_write replace_all must be a boolean");
  }
  const source = String(current ?? "");
  const first = source.indexOf(args.old_string);
  if (first < 0) throw new Error("case_write old_string was not found");
  if (args.replace_all === true) return source.split(args.old_string).join(args.new_string);
  if (source.indexOf(args.old_string, first + 1) >= 0) {
    throw new Error("case_write old_string is not unique; set replace_all to true to replace every match");
  }
  return source.slice(0, first) + args.new_string + source.slice(first + args.old_string.length);
}

function buildCaseWriteTool(cases, tasks) {
  return {
    name: "case_write",
    description: "Edit the plan document without ending the turn. Fully rewrite it with text, or patch a unique old_string to new_string (optionally replace_all).",
    parameters: {
      text: { type: "string", description: "Complete markdown plan for a full rewrite. Mutually exclusive with patch fields." },
      old_string: { type: "string", description: "Exact text to replace in the persisted plan." },
      new_string: { type: "string", description: "Replacement text for old_string." },
      replace_all: { type: "boolean", description: "Replace every match instead of requiring old_string to be unique." },
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
        const current = cases.load?.(sessionId)?.text ?? "";
        const written = cases.write(sessionId, editCaseText(args, current));
        const id = syncTask(cases, tasks, sessionId, written.text);
        return { status: "ok", title: titleOf(written.text), ...(id ? { id } : {}) };
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
    },
  };
}


const DELEGATION_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const WORKFLOW_ROLES = ["implementer", "qa-look-1", "fixer", "qa-look-2"];

function buildWorkflowStatusTool(workflowStatus) {
  return {
    name: "workflow_status",
    description: "Inspect one durable delegation by its full delegation UUID. Returns the Land run state and the exact current physical role session, epoch, ref, and worktree. Session aliases are display-only.",
    parameters: {
      delegationId: {
        type: "string",
        required: true,
        pattern: DELEGATION_PATTERN,
        description: "Full durable delegation UUID returned by delegate.",
      },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => {
        if (value.status === "refused") return [textBlock(`Workflow status refused: ${value.reason}`)];
        const current = value.sessionUuid
          ? `current session ${value.sessionUuid}${value.alias ? ` (alias ${value.alias}, ephemeral)` : ""}; role ${value.role}; epoch ${value.phaseEpoch}`
          : `no current session; epoch ${value.phaseEpoch}`;
        return [textBlock(
          `delegation ${value.delegationId}\nland run ${value.runId}; state ${value.runStatus}${value.transitioning ? "; transitioning" : ""}${value.terminal ? "; terminal" : ""}\n${current}\nref ${value.ref || "(none)"}\nworktree ${value.worktree || "(none)"}`,
        )];
      },
    },
    async execute(args, exec) {
      try {
        if (typeof workflowStatus !== "function") return refusal("workflow_status is unavailable");
        return workflowStatus({
          delegationId: args?.delegationId,
          parentSessionUuid: exec?.agent?.session?.id,
        });
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function buildWorkflowSendTool(workflowSend) {
  return {
    name: "workflow_send",
    description: "Send one default-steer message to the exact current owned live child behind a durable delegation UUID. Refuses terminal, missing, transitioning, stale-role, stale-epoch, or non-live runs. Resolution never uses session aliases or labels.",
    parameters: {
      delegationId: {
        type: "string",
        required: true,
        pattern: DELEGATION_PATTERN,
        description: "Full durable delegation UUID returned by delegate.",
      },
      message: { type: "string", required: true, description: "Message for the current workflow child." },
      expectedRole: {
        type: "string",
        enum: WORKFLOW_ROLES,
        description: "Optional stale-send guard: require this current workflow role.",
      },
      expectedEpoch: {
        type: "integer",
        minimum: 1,
        description: "Optional stale-send guard: require this current phase epoch.",
      },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => {
        if (value.status === "refused") return [textBlock(`Workflow send refused: ${value.reason}`)];
        return [textBlock(
          `delegation ${value.delegationId}\nmessage sent to current session ${value.sessionUuid}${value.alias ? ` (alias ${value.alias}, ephemeral)` : ""}; role ${value.role}; epoch ${value.phaseEpoch}: ${value.message_id}`,
        )];
      },
    },
    async execute(args, exec) {
      try {
        if (typeof workflowSend !== "function") return refusal("workflow_send is unavailable");
        return await workflowSend({
          delegationId: args?.delegationId,
          message: args?.message,
          expectedRole: args?.expectedRole,
          expectedEpoch: args?.expectedEpoch,
          parentSessionUuid: exec?.agent?.session?.id,
        });
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function buildArchitectTools({ delegate, workflowStatus, workflowSend, tasks, cases, land } = {}) {
  const tools = [{
    name: "delegate",
    description: "Start one workflow from working memory. The result renders the authoritative durable delegation UUID first, followed by the current immutable physical session UUID, role, epoch, and informational ephemeral alias. Workflow-owned results return automatically.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          status: { type: "string" },
          delegationId: { type: "string" },
          runId: { type: "string" },
          child: { type: "string" },
          alias: { type: "string" },
          role: { type: "string" },
          phaseEpoch: { type: "integer" },
          reason: { type: "string" },
        },
      },
      render: (_args, value) => [textBlock(value.status === "refused"
        ? `Delegate refused: ${value.reason}`
        : `delegation ${value.delegationId}\ncurrent session ${value.child}${value.alias ? ` (alias ${value.alias}, ephemeral)` : ""}; role ${value.role}; epoch ${value.phaseEpoch}${value.runId ? `; land run ${value.runId}` : ""}`)],
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
  tools.push(buildWorkflowStatusTool(workflowStatus), buildWorkflowSendTool(workflowSend));
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

export const internals = Object.freeze({ textBlock, refusal, editCaseText });
