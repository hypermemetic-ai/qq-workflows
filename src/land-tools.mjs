// Land-path tools. `done` sits on the implementer child. `qa_verdict` sits on
// the isolated QA child. The architect/base chair may call `land` to land an
// existing worktree; merge never registers as a user-facing workflow.

import { createQaVerdict, validateQaVerdictInput } from "../../bin/lib/qa-verdict.mjs";

function textBlock(text) {
  return { type: "text", text };
}

function refusal(reason) {
  return { status: "refused", reason };
}

export const DONE_TOOL_NAME = "done";
export const LAND_TOOL_NAME = "land";
export const QA_VERDICT_TOOL_NAME = "qa_verdict";
export const QA_TOOL_ALLOWLIST = Object.freeze([
  "read",
  "bash",
  "edit",
  "write",
  QA_VERDICT_TOOL_NAME,
]);

export function buildDoneTool({ submit } = {}) {
  return {
    name: DONE_TOOL_NAME,
    description: "Submit this worktree for land or review. The brief is already the work order. Packet is brief plus file counts and diff pointers. Do not merge.",
    parameters: {
      ref: {
        type: "string",
        description: "Commit to submit. Defaults to HEAD.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          status: { type: "string" },
          mark: { type: "string" },
          outcome: { type: "string" },
          reason: { type: "string" },
        },
      },
      render: (_args, value) => {
        if (value.status === "refused") return [textBlock(`Done refused: ${value.reason}`)];
        if (value.outcome) return [textBlock(value.outcome)];
        return [textBlock(`stamped ${value.mark || "review"}`)];
      },
    },
    async execute(args, exec) {
      try {
        if (typeof submit !== "function") return refusal("done is unavailable");
        return await submit({ agent: exec?.agent, ref: args?.ref || "HEAD" });
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function buildLandTool({ invoke } = {}) {
  return {
    name: LAND_TOOL_NAME,
    description: "Land a git worktree onto the base branch. Implementer done already does this; call this from the architect or base chair to land an existing worktree.",
    parameters: {
      worktree: {
        type: "string",
        description: "Worktree path. Defaults to this session cwd if it is a linked worktree.",
      },
      ref: {
        type: "string",
        description: "Commit to land. Defaults to HEAD.",
      },
      brief: {
        type: "string",
        description: "Work order if this worktree is not already adopted.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          status: { type: "string" },
          mark: { type: "string" },
          outcome: { type: "string" },
          reason: { type: "string" },
        },
      },
      render: (_args, value) => {
        if (value.status === "refused") return [textBlock(`Land refused: ${value.reason}`)];
        if (value.outcome) return [textBlock(value.outcome)];
        return [textBlock(`stamped ${value.mark || "review"}`)];
      },
    },
    async execute(args, exec) {
      try {
        if (typeof invoke !== "function") return refusal("land is unavailable");
        return await invoke({
          agent: exec?.agent,
          worktree: args?.worktree,
          ref: args?.ref || "HEAD",
          brief: args?.brief,
        });
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function buildQaVerdictTool({ submit } = {}) {
  return {
    name: QA_VERDICT_TOOL_NAME,
    description: "Submit the structured QA verdict for this look. Call exactly once. Pass requires a clean worktree; any test-only changes must already be committed. Never edit or commit production code.",
    parameters: {
      verdict: {
        type: "string",
        required: true,
        description: "pass or fail",
      },
      summary: {
        type: "string",
        required: true,
        description: "Short verdict summary, at most 240 characters.",
      },
      feedback: {
        type: "string",
        required: true,
        description: "What passed or what to fix. Empty string when there is nothing extra.",
      },
      tests_modified: {
        type: "boolean",
        required: true,
        description: "True when this look committed test-only changes.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          status: { type: "string" },
          verdict: { type: "string" },
          outcome: { type: "string" },
          reason: { type: "string" },
        },
      },
      render: (_args, value) => {
        if (value.status === "refused") return [textBlock(`QA verdict refused: ${value.reason}`)];
        if (value.outcome) return [textBlock(value.outcome)];
        return [textBlock(`qa ${value.verdict}`)];
      },
    },
    async execute(args, exec) {
      try {
        if (typeof submit !== "function") return refusal("qa_verdict is unavailable");
        const input = {
          verdict: args?.verdict,
          summary: args?.summary,
          feedback: args?.feedback ?? "",
          tests_modified: args?.tests_modified,
        };
        validateQaVerdictInput(input);
        const record = createQaVerdict(input);
        return await submit({ agent: exec?.agent, verdict: record });
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
