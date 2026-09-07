import { TEACHER_SYSTEM_PROMPT, MINI_SWE_SYSTEM_PROMPT, RESEARCHER_SYSTEM_PROMPT } from "./prompts.mjs";
import { teacherFirstUserMessage } from "./tools.mjs";
import { CHILD_MCP_ENTRY } from "../config.mjs";

export const GROK_THINKING = "high";
export const AGY_PROVIDER_MODEL = "agy/Gemini 3.8 Flash";
export const AGY_THINKING = "High";

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

export function teacherCreateOptions({ jobId, hostUrl, workspace, args, parent }) {
  return {
    config: {
      provider: AGY_PROVIDER_MODEL,
      thinkingOptionId: AGY_THINKING,
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
  completion,
}) {
  const packet = findings?.length
    ? `\n\nReviewer findings to fix:\n${findings.map((item) => `- ${item.path}:${item.line} ${item.body}`).join("\n")}`
    : "";
  return {
    config: {
      provider: AGY_PROVIDER_MODEL,
      thinkingOptionId: AGY_THINKING,
      featureValues: { auto_accept: true },
      systemPrompt: MINI_SWE_SYSTEM_PROMPT,
      mcpServers: childMcpServers({ role: "implementer", jobId, hostUrl, workspace }),
    },
    cwd: workspace,
    workspaceId: workspaceId ?? undefined,
    parent,
    title: `implementer (${kind})`,
    prompt: `${task}${packet}${completion === "report" ? "\n\nThis is a report-only investigation. Do not modify project code. Call done with your findings in answer; the host will return them without committing, reviewing, or publishing." : ""}\n\nImplementation checkout: ${workspace}. Work in this checkout; paths in the ticket may refer to the source checkout.`,
    labels: { role: "implementer", kind, job: jobId },
    worktree: branch ? undefined : { mode: "branch-off", newBranch: `architect/${kind}/${jobId.slice(0, 8)}` },
    env: childProcessEnv({ ARCHITECT_JOB_ID: jobId, ARCHITECT_HOST: hostUrl, ARCHITECT_ROLE: "implementer" }),
  };
}

export function researcherCreateOptions({
  jobId,
  hostUrl,
  workspace,
  question,
  parent,
}) {
  return {
    config: {
      provider: AGY_PROVIDER_MODEL,
      thinkingOptionId: AGY_THINKING,
      featureValues: { auto_accept: true },
      systemPrompt: RESEARCHER_SYSTEM_PROMPT,
      mcpServers: childMcpServers({ role: "researcher", jobId, hostUrl, workspace }),
    },
    cwd: workspace,
    parent,
    title: "researcher",
    prompt: question,
    labels: { role: "researcher", job: jobId },
    env: childProcessEnv({ ARCHITECT_JOB_ID: jobId, ARCHITECT_HOST: hostUrl, ARCHITECT_ROLE: "researcher" }),
  };
}

export function reviewerCreateOptions({
  jobId,
  hostUrl,
  workspace,
  workspaceId,
  parent,
}) {
  return {
    config: {
      provider: AGY_PROVIDER_MODEL,
      thinkingOptionId: AGY_THINKING,
      featureValues: { auto_accept: true },
      mcpServers: childMcpServers({ role: "reviewer", jobId, hostUrl, workspace }),
    },
    cwd: workspace,
    workspaceId: workspaceId ?? undefined,
    parent,
    title: "reviewer",
    prompt: [
      "You are the reviewer. The ticket is `.architect/ticket.md`.",
      "Follow its testing plan. Do not change project code.",
      "Call done with findings. Empty findings means it passed.",
    ].join("\n"),
    labels: { role: "reviewer", job: jobId },
    env: childProcessEnv({ ARCHITECT_JOB_ID: jobId, ARCHITECT_HOST: hostUrl, ARCHITECT_ROLE: "reviewer" }),
  };
}
