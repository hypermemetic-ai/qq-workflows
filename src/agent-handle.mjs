const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// DSH-owned handles survive plugin-fiber replacement on the live Agent.
export const AGENT_HANDLE = Symbol.for("@hypermemetic-ai/qq/agent-handle");

export function adoptAgentHandle(handle) {
  const owner = handle && typeof handle.dispose === "function" ? handle : undefined;
  const agent = owner?.agent ?? (handle?.session ? handle : undefined);
  if (!owner || !SESSION_ID.test(agent?.session?.id)) return handle;
  try {
    Object.defineProperty(agent, AGENT_HANDLE, {
      value: owner,
      configurable: true,
    });
  } catch {
    // Non-extensible Agents remain owned by the workflow's live handle map.
  }
  return handle;
}
