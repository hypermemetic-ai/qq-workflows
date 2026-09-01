// Architect chairs may interact with the host approval service for sanctioned
// one-shot escalation. Workflow children remain unattended execution contexts,
// so their independently resolved sandbox policy uses deterministic rejection.

export const INTERACTIVE_APPROVAL_POLICY = "ask";
export const NON_INTERACTIVE_APPROVAL_POLICY = "never";

export function effectiveApprovalPolicy(events = []) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "approval/policy") return event.data?.policy;
  }
  return undefined;
}

function pinApproval(agentOrSession, policy, data = {}) {
  const session = agentOrSession?.session ?? agentOrSession;
  if (!session || typeof session.append !== "function") {
    throw new Error("approval policy requires a writable session");
  }
  if (effectiveApprovalPolicy(session.events) === policy) return false;
  session.append("approval/policy", { policy, ...data });
  return true;
}

export function pinInteractiveApproval(agentOrSession) {
  return pinApproval(agentOrSession, INTERACTIVE_APPROVAL_POLICY);
}

export function pinNonInteractiveApproval(agentOrSession, { delegated = false } = {}) {
  return pinApproval(agentOrSession, NON_INTERACTIVE_APPROVAL_POLICY, {
    ...(delegated ? { source: "delegation" } : {}),
  });
}
