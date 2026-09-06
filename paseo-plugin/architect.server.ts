import type { PluginContext, PluginHandlerContext } from "@getpaseo/plugin";
import { ensureHost, hostRequest } from "./host/host-client.mjs";
import { applyDaemonPatch, architectProfile } from "./host/config.mjs";
import { ticketRead } from "./host/ticket.mjs";
import { childrenRpc, startArchitectRpc, ticketSnapshotRpc } from "./architect.shared";

export const startHost = ensureHost;
void ensureHost().catch(error => console.error("Architect host failed", error));
export async function handleStart(input: { cwd: string; title?: string }, { paseo }: PluginHandlerContext) {
  const current = await paseo.config.get();
  const config = current.config;
  const profiles = config.agentProfiles ?? [];
  const profile = architectProfile();
  await paseo.config.patch({
    providers: applyDaemonPatch({ agents: { providers: config.providers ?? {} } }).agents.providers,
    agentProfiles: [...profiles.filter(item => item.id !== profile.id), profile],
  });
  return hostRequest("/start", input);
}
export async function handleTicket(input: { cwd: string }) { return ticketRead(input.cwd); }
export async function handleChildren(input: { cwd: string; parentId?: string }) { return hostRequest("/jobs", input); }
export function registerArchitectHandlers(plugin: PluginContext) {
  plugin.handle(startArchitectRpc, handleStart);
  plugin.handle(ticketSnapshotRpc, handleTicket);
  plugin.handle(childrenRpc, handleChildren);
  // Jobs belong to the persistent host process; unloading the UI leaves them running.
  return { close: () => {} };
}
