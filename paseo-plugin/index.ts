import type { PluginContext } from "@getpaseo/plugin";
import { registerClient } from "./architect.client";
import { handleStart, handleTicket, handleChildren } from "./architect.server";
import { startArchitectRpc, ticketSnapshotRpc, childrenRpc } from "./architect.shared";

export default function contribute(plugin: PluginContext) {
  plugin.handle(startArchitectRpc, handleStart);
  plugin.handle(ticketSnapshotRpc, handleTicket);
  plugin.handle(childrenRpc, handleChildren);

  registerClient(plugin);

  return () => {};
}
