import { TEACHER_SYSTEM_PROMPT } from "./prompts.mjs";
import { teacherFirstUserMessage } from "./tools.mjs";
import { MINI_SWE_SYSTEM_PROMPT, renderMiniSweTask } from "./mini.mjs";
import { CHILD_MCP_ENTRY } from "./config.mjs";
import { ZG_STDIO_COMMAND } from "./zg-tools.mjs";
import { ZVEC_GREP_AGENT_GUIDANCE } from "./zg-guidance.mjs";

export const GROK_PROVIDER = "grok/grok-4.6";
export const GROK_THINKING = "high";

export function childProcessEnv(extra = {}, env = process.env) {
  return {
    ...(env.PATH ? { PATH: env.PATH } : {}),
    ...(env.PASEO_HOME ? { PASEO_HOME: env.PASEO_HOME } : {}),
    ...(env.PASEO_HOST ? { PASEO_HOST: env.PASEO_HOST } : {}),
    GROK_SUBAGENTS: "0",
    GROK_WORKFLOWS: "0",
    GROK_MEMORY: "0",
    GROK_REASONING_EFFORT: "high",
    ...extra,
  };
}

export function childMcpServers({ role, jobId, hostUrl, workspace }) {
  return {
    architect: {
      type: "stdio",
      command: process.execPath,
      args: [CHILD_MCP_ENTRY],
      env: {
        ARCHITECT_ROLE: role,
        ARCHITECT_JOB_ID: jobId,
        ARCHITECT_HOST: hostUrl,
        ARCHITECT_WORKSPACE: workspace,
      },
    },

  };
}

export function childToolPolicy(server = "architect") {
  const tools = {
    teacher: ["ticket_read", "ticket_write", "done"],
    implementer: ["done"],
  };
  const names = tools[server] ?? ["done"];
  return {
    preapproved: [
      ...names.map((tool) => ({ kind: "mcp", server: "architect", tool })),
      { kind: "mcp", server: "zvec_grep", tool: "zvec_grep_search" },
    ],
  };
}

export function teacherCreateOptions({ jobId, hostUrl, workspace, args, parent }) {
  return {
    config: {
      provider: "architect-teacher/grok-4.6",
      thinkingOptionId: GROK_THINKING,
      featureValues: { auto_accept: true },
      systemPrompt: TEACHER_SYSTEM_PROMPT,
      mcpServers: childMcpServers({ role: "teacher", jobId, hostUrl, workspace }),
    },
    cwd: workspace,
    parent,
    title: "teacher",
    prompt: teacherFirstUserMessage(args),
    labels: { role: "teacher", job: jobId },
    env: childProcessEnv({ ARCHITECT_JOB_ID: jobId, ARCHITECT_HOST: hostUrl, ARCHITECT_ROLE: "teacher" }),
  };
}

export function implementerCreateOptions({
  jobId,
  hostUrl,
  workspace,
  workspaceId,
  task,
  kind,
  parent,
  branch,
  findings,
}) {
  const packet = findings?.length
    ? `\n\nReviewer findings to fix:\n${findings.map((item) => `- ${item.path}:${item.line} ${item.body}`).join("\n")}`
    : "";
  return {
    config: {
      provider: "architect-mini/grok-4.6",
      thinkingOptionId: GROK_THINKING,
      featureValues: { auto_accept: true },
      systemPrompt: MINI_SWE_SYSTEM_PROMPT,
      mcpServers: childMcpServers({ role: "implementer", jobId, hostUrl, workspace }),
    },
    cwd: workspace,
    workspaceId: workspaceId ?? undefined,
    parent,
    title: `implementer (${kind})`,
    prompt: `${task}${packet}`,
    labels: { role: "implementer", kind, job: jobId },
    worktree: branch ? undefined : { mode: "branch-off", newBranch: `architect/${kind}/${jobId.slice(0, 8)}` },
    env: childProcessEnv({ ARCHITECT_JOB_ID: jobId, ARCHITECT_HOST: hostUrl, ARCHITECT_ROLE: "implementer" }),
  };
}
