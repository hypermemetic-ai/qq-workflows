// Hide DSH harness extras this chair does not use. Relay is the mailbox.
// Delegate and go start children. Do not sermon the model: the tools are gone.
// AGENTS.md is not a standing channel. Wiki index, working memory, and role
// prompts remain.

export const ARCHITECT_INHERITED_TOOLS = Object.freeze([
  "read",
  "grep",
  "glob",
  "bash",
  "relay_list",
  "relay_send",
  "relay_status",
]);

export const ARCHITECT_PLUGIN_TOOLS = Object.freeze([
  "case_write",
  "delegate",
  "research",
  "workflow_status",
  "workflow_send",
  "land",
]);

export const ARCHITECT_VISIBLE_TOOLS = Object.freeze([
  ...ARCHITECT_INHERITED_TOOLS,
  ...ARCHITECT_PLUGIN_TOOLS,
]);

export const HIDDEN_HARNESS_TOOLS = Object.freeze([
  "subagent",
  "subagent_fork",
  "send_message",
  "list_agents",
  "interrupt_agent",
  "create_goal",
  "get_goal",
  "update_goal",
  "ralph",
  "workflow",
]);

const ARCHITECT_VISIBLE = new Set(ARCHITECT_VISIBLE_TOOLS);
const HIDDEN = new Set(HIDDEN_HARNESS_TOOLS);
const HIDDEN_REASON = "this chair does not use that harness tool";
const UNLISTED_REASON = "this chair does not use that tool";

export function isHiddenHarnessTool(name) {
  return HIDDEN.has(name);
}

export function toolsOf(holder) {
  return holder?.tools
    ?? holder?.get?.("tools", false)
    ?? holder?.ctx?.tools
    ?? holder?.ctx?.get?.("tools", false)
    ?? null;
}

export function hideHarnessToolsOn(holder) {
  return hideHarnessTools(toolsOf(holder));
}

export function stripHiddenHarnessTools(tools) {
  if (!Array.isArray(tools)) return tools;
  const next = tools.filter((tool) => !HIDDEN.has(tool?.name));
  return next.length === tools.length ? tools : next;
}

export function stripUnlistedArchitectTools(tools) {
  if (!Array.isArray(tools)) return tools;
  const next = tools.filter((tool) => ARCHITECT_VISIBLE.has(tool?.name));
  return next.length === tools.length ? tools : next;
}

export function isAgentInstructionsMessage(message) {
  const source = message?.source;
  if (!source || typeof source !== "object") return false;
  if (source.kind === "agent-instructions") return true;
  return source.kind === "plugin" && source.plugin === "agent-instructions";
}

export function stripAgentInstructionMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  const next = messages.filter((message) => !isAgentInstructionsMessage(message));
  return next.length === messages.length ? messages : next;
}

/** Strip the instructions dump injected by inner pre-step middleware. */
export async function stripAgentInstructionsPreStep(_event, next) {
  const decision = await next();
  if (!decision || decision.kind === "reject") return decision;
  const messages = stripAgentInstructionMessages(decision.messages);
  if (messages === decision.messages) return decision;
  return { ...decision, messages };
}

/** Restrict architect inheritance to the decided tools and fence execution. */
export function restrictArchitectTools(tools) {
  if (!tools) return null;
  const lifts = [];
  if (typeof tools.restrict === "function") {
    try {
      const lift = tools.restrict({ allow: [...ARCHITECT_INHERITED_TOOLS] });
      if (typeof lift === "function") lifts.push(lift);
    } catch {
      // Visibility hide is best-effort; guard and assemble-time stripping remain.
    }
  }
  if (typeof tools.guard === "function") {
    try {
      const lift = tools.guard((execution) => {
        if (!ARCHITECT_VISIBLE.has(execution?.name)) return UNLISTED_REASON;
        return undefined;
      });
      if (typeof lift === "function") lifts.push(lift);
    } catch {
      // Assemble-time stripping and restrict still close the visible set.
    }
  }
  if (lifts.length === 0) return null;
  return () => {
    for (const lift of lifts) {
      try { lift(); } catch { /* lift is best-effort */ }
    }
  };
}

/** Deny child harness extras. Returns a lift, or null when tools cannot hide. */
export function hideHarnessTools(tools) {
  if (!tools) return null;
  const lifts = [];
  if (typeof tools.restrict === "function") {
    try {
      const lift = tools.restrict({ deny: [...HIDDEN_HARNESS_TOOLS] });
      if (typeof lift === "function") lifts.push(lift);
    } catch {
      // Visibility hide is best-effort; guard is the fence.
    }
  }
  if (typeof tools.guard === "function") {
    try {
      const lift = tools.guard((execution) => {
        if (HIDDEN.has(execution?.name)) return HIDDEN_REASON;
        return undefined;
      });
      if (typeof lift === "function") lifts.push(lift);
    } catch {
      // A missing guard API must not block attach or child create.
    }
  }
  if (lifts.length === 0) return null;
  return () => {
    for (const lift of lifts) {
      try { lift(); } catch { /* lift is best-effort */ }
    }
  };
}

export const internals = Object.freeze({
  ARCHITECT_VISIBLE,
  HIDDEN,
  HIDDEN_REASON,
  UNLISTED_REASON,
});
