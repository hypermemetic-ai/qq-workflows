import type { PluginContext } from "@getpaseo/plugin";
import { ArchitectSurface, TicketPanel } from "./architect.client";
import { handleStart, handleTicket, handleChildren } from "./architect.server";
import { startArchitectRpc, ticketSnapshotRpc, childrenRpc } from "./architect.shared";

export default function contribute(plugin: PluginContext) {
  plugin.handle(startArchitectRpc, handleStart);
  plugin.handle(ticketSnapshotRpc, handleTicket);
  plugin.handle(childrenRpc, handleChildren);

  plugin.addSurface("architect", ArchitectSurface);
  plugin.addSidebarItem({
    id: "architect",
    title: "Architect",
    icon: "Compass",
    surface: "architect",
  });
  plugin.addWorkspacePanel({
    id: "ticket",
    title: "Ticket",
    icon: "FileText",
    context: "workspace",
    Component: TicketPanel,
  });
  plugin.addCommandCenterItem({
    id: "start-architect",
    title: "Start architect",
    icon: "Compass",
    keywords: ["ticket", "delegate", "teacher"],
    context: "workspace",
    async onSelect({ paseo, rpc, workspace, openPanel }) {
      await rpc(startArchitectRpc, { cwd: workspace.directory, title: "Architect" });
      openPanel("ticket");
    },
  });

  return () => {};
}
