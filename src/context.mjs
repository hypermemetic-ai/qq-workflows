// Declarative session contexts and leave reasons for the workflow registry.
//
// Omitted acceptedContexts defaults to project only. That is the documented
// legacy sibling default; new workflows opt into scratch explicitly.
// Reasons are a closed generic set. Never branch on a workflow name.

export const SESSION_CONTEXTS = Object.freeze(["project", "scratch"]);
export const LEAVE_REASONS = Object.freeze([
  "back",
  "home",
  "workflow-switch",
  "context-navigation",
  "session-close",
]);
export const DEFAULT_ACCEPTED_CONTEXTS = Object.freeze(["project"]);

const CONTEXT_SET = new Set(SESSION_CONTEXTS);
const REASON_SET = new Set(LEAVE_REASONS);

export function normalizeAcceptedContexts(raw) {
  if (raw === undefined) return DEFAULT_ACCEPTED_CONTEXTS;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("acceptedContexts must be a non-empty array of project and/or scratch");
  }
  const accepted = [];
  for (const context of raw) {
    if (!CONTEXT_SET.has(context)) {
      throw new Error(`invalid session context: ${String(context)}`);
    }
    if (!accepted.includes(context)) accepted.push(context);
  }
  if (accepted.length === 1 && accepted[0] === "project") return DEFAULT_ACCEPTED_CONTEXTS;
  return Object.freeze(accepted);
}

export function assertSessionContext(context) {
  if (!CONTEXT_SET.has(context)) {
    throw new Error(`invalid session context: ${String(context)}`);
  }
  return context;
}

export function assertLeaveReason(reason) {
  if (!REASON_SET.has(reason)) {
    throw new Error(`invalid leave reason: ${String(reason)}`);
  }
  return reason;
}

export function lifecycleRefused(result) {
  if (result === false) return true;
  if (!result || typeof result !== "object") return false;
  return result.status === "refused" || result.ok === false;
}

export function refusalMessage(result, fallback) {
  if (result && typeof result === "object") {
    const message = result.reason ?? result.message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return fallback;
}
