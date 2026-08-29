// Workflow chairs and custom children are unattended execution contexts. Keep
// their independently resolved sandbox policy intact, but make approval asks
// deterministic so routine work never stalls on an interactive prompt.

export const NON_INTERACTIVE_APPROVAL_POLICY = "never";

export function effectiveApprovalPolicy(events = []) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "approval/policy") return event.data?.policy;
  }
  return undefined;
}

export function pinNonInteractiveApproval(agentOrSession, { delegated = false } = {}) {
  const session = agentOrSession?.session ?? agentOrSession;
  if (!session || typeof session.append !== "function") {
    throw new Error("non-interactive approval requires a writable session");
  }
  if (effectiveApprovalPolicy(session.events) === NON_INTERACTIVE_APPROVAL_POLICY) return false;
  session.append("approval/policy", {
    policy: NON_INTERACTIVE_APPROVAL_POLICY,
    ...(delegated ? { source: "delegation" } : {}),
  });
  return true;
}
