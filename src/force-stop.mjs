// Parent stop is an immediate control-plane operation. DSH AgentHandle.dispose()
// correctly waits for the turn to become idle, but a tool that ignores abort can
// keep that promise pending indefinitely. Cancel the runtime, detach its live
// registry entry immediately, and let owned teardown drain in the background.

const CORDIS_ORIGINAL = Symbol.for("cordis.original");

function sessionIdOf(agent) {
  return agent?.session?.id ?? agent?.id ?? "";
}

function concreteAgents(agents) {
  return agents?.[CORDIS_ORIGINAL] ?? agents ?? null;
}

function detachLiveAgent(agents, agent) {
  const id = sessionIdOf(agent);
  const registry = concreteAgents(agents);
  const entry = registry?.store?.get?.(id);
  if (!id || !entry || entry.agent !== agent) return false;
  if (typeof registry.detachEntered === "function") registry.detachEntered(entry);
  else if (typeof registry.store?.delete === "function") registry.store.delete(id);
  else return false;
  return registry.store?.get?.(id)?.agent !== agent;
}

function exactAgentIsLive(agents, agent) {
  const id = sessionIdOf(agent);
  if (!id || !agent) return false;
  const registry = concreteAgents(agents);
  if (registry?.store?.get?.(id)?.agent === agent) return true;
  try {
    if (agents?.get?.(id) === agent) return true;
  } catch { /* fall through to list */ }
  try {
    if (agents?.list?.().some?.((candidate) => candidate === agent)) return true;
  } catch { /* an unavailable projection cannot make an absent exact entry live */ }
  return false;
}

// Completed workflow children retire at the idle boundary: first let the owned
// handle drain, then detach the exact Agent from the live registry. AgentHandle
// disposal and registry detachment are distinct DSH lifecycle operations.
// Keeping this ordering means a failed handle disposal remains recoverable; the
// exact-object checks make retries and a same-session replacement safe.
export async function retireAgent({ agents, agent, handle } = {}) {
  if (!agent || typeof handle?.dispose !== "function") return false;
  await handle.dispose();
  detachLiveAgent(agents, agent);
  return !exactAgentIsLive(agents, agent);
}

export function forceStopAgent({ agents, agent, handle } = {}) {
  if (!agent) return Object.freeze({ cancelled: false, detached: false, disposal: Promise.resolve(false) });
  let cancelled = false;
  try {
    if (typeof agent.cancel === "function") {
      agent.cancel({ kind: "disposed" });
      cancelled = true;
    }
  } catch { /* registry detachment must still proceed */ }
  const disposal = typeof handle?.dispose === "function"
    ? Promise.resolve().then(async () => {
      await handle.dispose();
      return true;
    })
    : Promise.resolve(false);
  const detached = detachLiveAgent(agents, agent);
  return Object.freeze({ cancelled, detached, disposal });
}
