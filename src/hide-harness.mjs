// Hide DSH harness extras this chair does not use. Relay is the mailbox.
// invoke/go are the children. Do not sermon the model: the tools are gone.

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

const HIDDEN = new Set(HIDDEN_HARNESS_TOOLS);
const HIDDEN_REASON = "this chair does not use that harness tool";

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

/** Restrict + guard. Returns a lift, or null when tools cannot hide. */
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
  HIDDEN,
  HIDDEN_REASON,
});
