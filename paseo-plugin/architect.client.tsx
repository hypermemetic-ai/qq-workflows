import {
  type PluginContext,
  type PluginSurfaceProps,
  type PluginWorkspacePanelProps,
  useRpc,
  useWorkspace,
} from "@getpaseo/plugin";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { childrenRpc, startArchitectRpc, ticketSnapshotRpc } from "./architect.shared";

export function ArchitectSurface({ theme, layout }: PluginSurfaceProps) {
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
        gap: 12,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24 },
      body: { color: theme.colors.foregroundMuted },
    }),
    [theme, layout.compact],
  );
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Architect</Text>
      <Text style={styles.body}>
        Start an architect session from the Command Center or a workspace. The ticket is
        `.architect/ticket.md`. Open child pills yourself.
      </Text>
    </View>
  );
}

export function TicketPanel({ theme, layout, workspaceId, navigation }: PluginWorkspacePanelProps) {
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const loadTicket = useRpc(ticketSnapshotRpc);
  const loadChildren = useRpc(childrenRpc);
  const start = useRpc(startArchitectRpc);
  const [text, setText] = useState("");
  const [children, setChildren] = useState<Array<{ id: string; role: string; status: string; kind?: string | null; agentId?: string; error?: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const inFlight = useRef<{ cwd: string; id: number } | null>(null);
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
        gap: 12,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 22 },
      body: { color: theme.colors.foreground, fontFamily: "monospace" },
      muted: { color: theme.colors.foregroundMuted },
      button: { padding: 12, borderRadius: 8, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.accentForeground, textAlign: "center" as const },
    }),
    [theme, layout.compact],
  );

  const reload = useCallback(async () => {
    if (!directory) return;
    if (inFlight.current?.cwd === directory) return;
    const request = ++generation.current;
    inFlight.current = { cwd: directory, id: request };
    setLoading(true);
    setError(null);
    try {
      const [ticket, result] = await Promise.all([loadTicket({ cwd: directory }), loadChildren({ cwd: directory })]);
      if (request !== generation.current) return;
      setText(ticket.text);
      setChildren(result.children);
    } catch (error) { if (request === generation.current) setError(String(error)); }
    finally {
      if (inFlight.current?.id === request) inFlight.current = null;
      if (request === generation.current) setLoading(false);
    }
  }, [directory, loadTicket, loadChildren]);

  useEffect(() => {
    setText(""); setChildren([]);
    void reload();
    const timer = setInterval(() => { void reload(); }, 5000);
    return () => { generation.current++; inFlight.current = null; clearInterval(timer); };
  }, [reload]);


  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ gap: 12 }}>
      <Text style={styles.title}>Ticket</Text>
      <Text style={styles.muted}>{directory ?? "No workspace directory"}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Start architect"
        style={styles.button}
        disabled={starting || !directory}
        onPress={async () => {
          if (!directory || starting) return;
          setStarting(true); setError(null);
          try { await start({ cwd: directory, title: "Architect" }); await reload(); }
          catch (error) { setError(String(error)); }
          finally { setStarting(false); }
        }}
      >
        <Text style={styles.buttonText}>{starting ? "Starting…" : "Start architect"}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Reload ticket"
        style={styles.button}
        onPress={() => reload()}
      >
        <Text style={styles.buttonText}>Reload ticket</Text>
      </Pressable>
      {loading ? <Text style={styles.muted}>Loading…</Text> : null}
      {error ? <Text accessibilityRole="alert" style={styles.body}>{error}</Text> : null}
      <Text style={styles.body}>
        {text || "Ticket lives at `.architect/ticket.md`. Architect fills it, then delegates."}
      </Text>
      {children.map((child) => (
        <Pressable key={child.id} accessibilityRole="button" disabled={!child.agentId} onPress={() => { if (child.agentId) navigation?.openAgent?.({ agentId: child.agentId }); }}>
        <Text style={styles.muted}>
          {child.role}{child.kind ? ` (${child.kind})` : ""} — {child.status}{child.error ? `: ${child.error}` : ""}
        </Text>
        </Pressable>
      ))}
      {navigation?.openAgent ? (
        <Text style={styles.muted}>Child sessions appear as pills. Open them from the workspace.</Text>
      ) : null}
    </ScrollView>
  );
}

export function registerClient(plugin: Pick<PluginContext, "addSurface" | "addSidebarItem" | "addWorkspacePanel" | "addCommandCenterItem">) {
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
