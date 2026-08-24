// Durable clock at the end of agent/request. Not a transcript node:
// hook/result has no surfaceOp, so conversation stays identity.
//
// step/start → this mark = deriveMessages + claimed prompts + this waterfall.
// data.ms = waterfall wall (chop/fold/projection + later agent/request listeners).
// mark → first delta = prepareCall + provider TTFT.

export const ASSEMBLE_HOOK = "agent/request";
export const ASSEMBLE_PLUGIN = "qq-workflows";

export function isAssembleMark(event) {
  return event?.type === "hook/result"
    && event.data?.hook === ASSEMBLE_HOOK
    && event.data?.plugin === ASSEMBLE_PLUGIN;
}

export function markAssemble(session, record = {}) {
  if (!session || typeof session.append !== "function") return null;
  const ms = Number.isFinite(record.ms) ? Math.max(0, Math.round(record.ms)) : 0;
  const data = { hook: ASSEMBLE_HOOK, plugin: ASSEMBLE_PLUGIN, ms };
  if (Number.isSafeInteger(record.turn)) data.turn = record.turn;
  if (Number.isSafeInteger(record.step)) data.step = record.step;
  if (Number.isSafeInteger(record.talking)) data.talking = record.talking;
  if (Number.isSafeInteger(record.q)) data.q = record.q;
  try {
    return session.append("hook/result", data);
  } catch {
    return null;
  }
}
