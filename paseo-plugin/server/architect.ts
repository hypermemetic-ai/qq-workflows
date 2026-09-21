// Architect profile binding for Paseo.
//
// These helpers keep the Architect choice scoped: only the Architect provider is
// touched, and only its environment and agent-configuration fields. An ordinary
// Codex, pi, or other provider agent passes through untouched.
//
// The constant names mirror workflow/architect-profile.mjs; the installer test
// asserts the two stay in sync so a rename cannot silently split them.

export const ARCHITECT_PROVIDER_ID = "qq-architect";
export const ARCHITECT_PROFILE_ENV = "QQ_ARCHITECT_PROFILE";
export const ARCHITECT_SESSION_ID_ENV = "QQ_WORKFLOW_SESSION_ID";
export const ARCHITECT_OWNER_ENV = "QQ_ARCHITECT_OWNER_AGENT_ID";
export const ARCHITECT_ROOT_ENV = "QQ_WORKFLOW_ROOT";

export interface AgentCreateRequest {
  config: {
    provider?: string;
    systemPrompt?: string;
    mcpServers?: Record<string, unknown>;
    [key: string]: unknown;
  };
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface SessionOpenRequest {
  agentId: string;
  provider: string;
  cwd: string;
  reason?: string;
  env?: Record<string, string>;
  [key: string]: unknown;
}

export function isArchitectProvider(provider: unknown): boolean {
  return provider === ARCHITECT_PROVIDER_ID;
}

// Creation: the Architect owns its prompt at runtime, so Paseo must not append a
// prompt layer, and no MCP server may become a prerequisite for the workflow
// tools. Model, mode, and thinking selections are preserved verbatim.
export function architectCreateRequest<T extends AgentCreateRequest>(request: T): T {
  if (!isArchitectProvider(request?.config?.provider)) return request;
  return {
    ...request,
    config: {
      ...request.config,
      systemPrompt: "",
      mcpServers: {},
    },
  } as T;
}

// Session open: bind the stable Paseo agent ID before the provider session and
// before the first turn. The agent ID is the workflow session key, so reopening
// or resuming keeps the same ticket.
export function architectSessionOpenRequest<T extends SessionOpenRequest>(request: T): T {
  if (!isArchitectProvider(request?.provider)) return request;
  const agentId = typeof request.agentId === "string" ? request.agentId.trim() : "";
  if (!agentId) {
    throw new Error(
      "qq-architect requires a Paseo agent ID: the workflow session identity must be stable across reopen/resume",
    );
  }
  const env: Record<string, string> = { ...(request.env ?? {}) };
  env[ARCHITECT_PROFILE_ENV] = "1";
  env[ARCHITECT_SESSION_ID_ENV] = agentId;
  env[ARCHITECT_OWNER_ENV] = agentId;
  if (typeof request.cwd === "string" && request.cwd.trim()) env[ARCHITECT_ROOT_ENV] = request.cwd.trim();
  return { ...request, env } as T;
}
