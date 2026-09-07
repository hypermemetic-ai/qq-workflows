// One ticket belongs to a checkout, including recovery conversations in that checkout.
const origins = new Map();
const listeners = new Set();
export const subscribeTicketOrigin = listener => { listeners.add(listener); return () => listeners.delete(listener); };
export const getTicketOrigin = workspaceId => origins.get(workspaceId) ?? null;
function setOrigin(workspaceId, agentId) {
  origins.set(workspaceId, agentId);
  for (const listener of listeners) listener();
}
export function attachTicketAccess(client, Component) {
  const agents = new Map();
  const pills = new Map();
  const updated = new Set();
  let loading = true;
  let stopped = false;
  function remove(id) { pills.get(id)?.dispose(); pills.delete(id); }
  function register(agent) {
    // Bind callbacks in a function invocation, including when evaluated by Hermes.
    const workspaceId = agent.workspaceId;
    pills.set(agent.id, { workspaceId, dispose: client.addComposerPill({
      id: 'open-ticket', title: 'Open Architect ticket', workspaceId, agentId: agent.id, Component,
      onPress() { setOrigin(workspaceId, agent.id); client.openPanel('ticket', { workspaceId }); },
    }) });
  }
  function reconcile() {
    if (stopped) return;
    const checkouts = new Set([...agents.values()]
      .filter(agent => agent.provider === 'architect' || agent.labels?.role === 'architect')
      .map(agent => agent.cwd));
    for (const [id, pill] of pills) {
      const agent = agents.get(id);
      if (!agent || !checkouts.has(agent.cwd) || agent.workspaceId !== pill.workspaceId) remove(id);
    }
    for (const agent of agents.values()) {
      if (!agent.workspaceId || !checkouts.has(agent.cwd) || pills.has(agent.id)) continue;
      register(agent);
    }
  }
  const unsubscribe = client.paseo.agents.subscribe(update => {
    const id = update.kind === 'remove' ? update.agentId : update.agent.id;
    if (loading) updated.add(id);
    if (update.kind === 'remove') agents.delete(id);
    else agents.set(id, update.agent);
    reconcile();
  });
  void client.paseo.agents.list().then(({ entries }) => {
    if (stopped) return;
    for (const { agent } of entries) if (!updated.has(agent.id)) agents.set(agent.id, agent);
    reconcile();
  }).catch(() => undefined).finally(() => { loading = false; updated.clear(); });
  return () => {
    stopped = true;
    unsubscribe();
    for (const id of pills.keys()) remove(id);
    agents.clear();
    origins.clear();
    for (const listener of listeners) listener();
  };
}
