// Private handshake between Land and child-facing tool bridges. The capability
// never enters tool output JSON; it only arms disposal after the exact durable
// tool result has committed and the agent has returned idle.

export const CHILD_SETTLEMENT = Symbol.for("@hypermemetic-ai/qq-workflows/child-settlement");

export function withChildSettlement(value, settlement) {
  if (!value || typeof value !== "object" || !settlement) return value;
  Object.defineProperty(value, CHILD_SETTLEMENT, {
    value: settlement,
    configurable: true,
  });
  return value;
}

export function armChildSettlement(value, exec, hooks = {}) {
  const settlement = value?.[CHILD_SETTLEMENT];
  if (!settlement || typeof settlement.arm !== "function") return false;
  settlement.arm({
    callId: exec?.callId,
    onFailure: hooks.onFailure,
  });
  return true;
}

export function childSettlementOf(value) {
  return value?.[CHILD_SETTLEMENT] ?? null;
}
