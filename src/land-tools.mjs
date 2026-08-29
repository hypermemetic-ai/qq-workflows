// Land-path tools. `done` sits on the implementation child. The architect/base
// chair may call `land` to land an existing worktree; GitHub PR landing
// never registers as a user-facing workflow.

import { armChildSettlement, childToolOutput } from "./child-settlement.mjs";

function textBlock(text) {
  return { type: "text", text };
}

function refusal(reason) {
  return { status: "refused", reason };
}

export const DONE_TOOL_NAME = "done";
export const LAND_TOOL_NAME = "land";

export function buildDoneTool({ submit } = {}) {
  return {
    name: DONE_TOOL_NAME,
    description: "Submit this worktree for land or review. The exact task is in the Git-private task artifact. The packet is a bounded changed-file summary plus diff pointers. Do not merge.",
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
        const result = await submit({ agent: exec?.agent, ref: args?.ref || "HEAD" });
        if (result?.status !== "refused") {
          armChildSettlement(result, exec);
          const output = childToolOutput(result);
          try { exec?.concludeTurn?.(); } catch { /* accepted result remains armed */ }
          return output;
        }
        return result;
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function buildLandTool({ invoke } = {}) {
  return {
    name: LAND_TOOL_NAME,
    description: "Publish a git worktree through a merge-commit PR to origin/main, then fast-forward local main. Implementer done already does this; call from the architect or base chair for an existing worktree.",
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
