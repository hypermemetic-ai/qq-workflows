import type { PluginHandlerContext } from "@getpaseo/plugin";
import { ensureHost, hostRequest } from "./host/host-client.mjs";
import { daemonConfigPatch } from "./host/config.mjs";
import { ticketRead } from "./host/workflow/ticket.mjs";

void ensureHost().catch(error => console.error("Architect host failed", error));
export async function handleStart(input: { cwd: string; title?: string }, { paseo }: PluginHandlerContext) {
  const current = await paseo.config.get();
  await paseo.config.patch(daemonConfigPatch(current.config));
  return hostRequest("/start", input);
}
export async function handleTicket(input: { cwd: string }) { return ticketRead(input.cwd); }
export async function handleChildren(input: { cwd: string; parentId?: string }) { return hostRequest("/jobs", input); }
