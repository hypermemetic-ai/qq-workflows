import {
  Icon,
  type PluginClientContext,
  type PluginComposerPillProps,
  type PluginTheme,
  type PluginSurfaceProps,
  type PluginWorkspacePanelProps,
  useRpc,
  useWorkspace,
} from "@getpaseo/plugin";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { childrenRpc, startArchitectRpc, ticketSnapshotRpc, type TicketTokens } from "./architect.shared";
import { attachTicketAccess, getTicketOrigin, subscribeTicketOrigin } from "./ticket-access.mjs";
import { TicketPlan, ticketTitle } from "./ticket-plan";

function TicketPill({ theme }: PluginComposerPillProps) {
  return <><Icon name="FileText" size={14} color={theme.colors.foregroundMuted} /><Text style={{ color: theme.colors.foregroundMuted }}>Ticket</Text></>;
}
export function contributeTicketAccess(client: PluginClientContext) {
  return attachTicketAccess(client, TicketPill);
}

type ChildWork = { id: string; role: string; status: string; kind?: string | null; agentId?: string; error?: string; phase?: string; completion?: string; createdAt?: number };
const activeWork = (child: ChildWork) => ['running', 'awaiting_correction', 'uncertain'].includes(child.status);
function workStatus(child: ChildWork) {
  const statuses: Record<string, string> = { succeeded: 'Completed', failed: 'Failed', cancelled: 'Cancelled', uncertain: 'Needs inspection', findings: 'Needs a decision', awaiting_correction: 'Correction in progress' };
  const phases: Record<string, string> = { preparing: 'Preparing checkout', spawning: 'Starting', working: 'Working', reviewing: 'In review', reviewed: 'Review complete', committing: 'Saving changes', committed: 'Changes saved', landing: 'Merging', landed: 'Merged', completion_received: 'Finishing', settling: 'Finishing' };
  return statuses[child.status] ?? (child.status === 'running' ? phases[child.phase ?? ''] ?? 'In progress' : 'Status unavailable');
}

const roleDisplayName = (child: ChildWork) => {
  if (child.role === 'implementer') return 'Implementer';
  if (child.role === 'reviewer') return 'Reviewer';
  if (child.role === 'teacher') return 'Teacher';
  if (child.role === 'researcher') return 'Researcher';
  return child.role.charAt(0).toUpperCase() + child.role.slice(1);
};
const needsAttention = (child: ChildWork) => ['uncertain', 'findings'].includes(child.status);
const isRunning = (child: ChildWork) => ['running', 'awaiting_correction'].includes(child.status);

function DelegateRow({ child, theme, openAgent }: { child: ChildWork; theme: PluginTheme; openAgent?: (input: { agentId: string }) => void }) {
  const c = theme.colors;
  const statusColor = needsAttention(child) ? c.statusWarning : child.status === 'failed' ? c.statusDanger : c.foregroundMuted;
  const icon = child.role === 'researcher' ? 'Search' : child.role === 'teacher' ? 'GraduationCap' : child.role === 'reviewer' ? 'CheckSquare' : 'Code';
  const role = roleDisplayName(child);
  const status = workStatus(child);
  const canOpen = Boolean(child.agentId && openAgent);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${role}: ${status}.${canOpen ? ' Open conversation.' : ''}`}
      disabled={!canOpen}
      onPress={() => {
        if (child.agentId && openAgent) {
          openAgent({ agentId: child.agentId });
        }
      }}
      style={{
        paddingVertical: 14,
        flexDirection: 'row',
        gap: 12,
        alignItems: 'center',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: c.border,
      }}
    >
      <View style={{ paddingTop: 1 }}>
        <Icon name={icon} size={18} color={c.foregroundMuted} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'space-between', alignItems: 'baseline' }}>
          <Text style={{ color: c.foreground, fontSize: 15, fontWeight: '500' }}>{role}</Text>
          <Text style={{ color: statusColor, fontSize: 12 }}>{status}</Text>
        </View>
        {child.error ? (
          <Text numberOfLines={2} style={{ color: c.statusDanger, fontSize: 12 }}>{child.error}</Text>
        ) : null}
      </View>
      <Icon name="ArrowUpRight" size={15} color={canOpen ? c.foregroundMuted : 'transparent'} />
    </Pressable>
  );
}

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
        Start Architect from the Command Center or your workspace’s Ticket panel.
        Describe the change you want and make decisions together in the conversation.
        Tap Ticket beside the composer to see the plan and delegated work.
      </Text>
    </View>
  );
}

export function TicketPanel({ theme, layout, workspaceId, navigation }: PluginWorkspacePanelProps) {
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const project = useWorkspace(workspaceId, (workspace) => workspace.projectDisplayName);
  const origin = useSyncExternalStore(subscribeTicketOrigin, useCallback(() => getTicketOrigin(workspaceId), [workspaceId]));
  const loadTicket = useRpc(ticketSnapshotRpc);
  const loadChildren = useRpc(childrenRpc);
  const start = useRpc(startArchitectRpc);
  const [text, setText] = useState("");
  const [tokens, setTokens] = useState<TicketTokens>([]);
  const [children, setChildren] = useState<ChildWork[]>([]);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const inFlight = useRef<{ cwd: string; id: number } | null>(null);
  const c = theme.colors;
  const styles = useMemo(() => StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.surface0 },
    width: { width: '100%', maxWidth: 760, alignSelf: 'center' },
    header: { paddingHorizontal: layout.compact ? 20 : 28, paddingTop: 8 },
    top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
    action: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 7 },
    iconButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    muted: { color: c.foregroundMuted, fontSize: 13, lineHeight: 20 },
    title: { color: c.foreground, fontSize: 22, lineHeight: 29, fontWeight: '500', marginTop: 13 },
    project: { color: c.foregroundMuted, fontSize: 13, marginTop: 7, marginBottom: 14 },
    content: { paddingHorizontal: layout.compact ? 20 : 28, paddingTop: 14, paddingBottom: 36 },
    groupTitle: { color: c.foregroundMuted, fontSize: 12, fontWeight: '500', marginTop: 18, marginBottom: 4 },
    empty: { paddingVertical: 24, gap: 8 },
    emptyTitle: { color: c.foreground, fontSize: 16 },
    note: { color: c.foregroundMuted, fontSize: 14, lineHeight: 22 },
  }), [c, layout.compact]);

  const reload = useCallback(async ({ quiet = false } = {}) => {
    if (!directory) return;
    if (inFlight.current?.cwd === directory) return;
    const request = ++generation.current;
    inFlight.current = { cwd: directory, id: request };
    if (!quiet) setLoading(true);
    try {
      const [ticket, result] = await Promise.allSettled([
        loadTicket({ cwd: directory, sessionId: origin ?? undefined }),
        loadChildren({ cwd: directory }),
      ]);
      if (request !== generation.current) return;
      if (ticket.status === 'fulfilled') { setText(ticket.value.text); setTokens(ticket.value.tokens); }
      if (result.status === 'fulfilled') setChildren(result.value.children);
      const failures = [ticket, result].filter(item => item.status === 'rejected').map(item => item.reason instanceof Error ? item.reason.message : String(item.reason));
      setError(failures.length ? failures.join('\n') : null);
    } catch (error) { if (request === generation.current) setError(error instanceof Error ? error.message : String(error)); }
    finally {
      if (inFlight.current?.id === request) inFlight.current = null;
      if (request === generation.current) setLoading(false);
    }
  }, [directory, origin, loadTicket, loadChildren]);

  useEffect(() => {
    setText(""); setTokens([]); setChildren([]); setError(null);
    void reload();
    const timer = setInterval(() => { void reload({ quiet: true }); }, 5000);
    return () => { generation.current++; inFlight.current = null; clearInterval(timer); };
  }, [reload]);
  const ordered = [...children].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const running = ordered.filter(isRunning);
  const attention = ordered.filter(needsAttention);

  return <View testID={`architect-ticket-${workspaceId}`} style={styles.screen}>
    <View style={[styles.width, styles.header]}>
      <View style={styles.top}>
        {origin && navigation?.openAgent ? <Pressable accessibilityRole="button" accessibilityLabel="Back to conversation" onPress={() => navigation.openAgent({ agentId: origin })} style={styles.action}><Icon name="ArrowLeft" size={16} color={c.foregroundMuted} /><Text style={styles.muted}>Conversation</Text></Pressable> : <Text style={styles.muted}>Ticket</Text>}
        <Pressable accessibilityRole="button" accessibilityLabel="Reload ticket" accessibilityState={{ busy: loading, disabled: !directory }} disabled={!directory} onPress={() => reload()} style={styles.iconButton}><Icon name="RefreshCw" size={16} color={c.foregroundMuted} /></Pressable>
      </View>
      <Text accessibilityRole="header" style={styles.title}>{ticketTitle(text)}</Text>
      <Text style={styles.project}>{project || directory?.split('/').pop() || 'Workspace'}{running.length ? `  ·  ${running.length} in progress` : ''}{attention.length ? `  ·  ${attention.length} needs attention` : ''}</Text>
    </View>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.width, styles.content]}>
      {error ? <Pressable accessibilityRole="button" accessibilityLabel="Show connection details" onPress={() => setShowDetails(value => !value)} style={{ paddingVertical: 12 }}><Text style={styles.note}>Couldn’t refresh. Showing the last available information.</Text>{showDetails ? <Text selectable style={styles.muted}>{error}</Text> : null}</Pressable> : null}
      {text ? <TicketPlan tokens={tokens} theme={theme} /> : <View style={styles.empty}><Text style={styles.emptyTitle}>{loading ? 'Loading your plan…' : 'A plan starts with a conversation'}</Text><Text style={styles.note}>Tell Architect what you want to change. The scope and decisions will appear here.</Text></View>}
      <View testID="architect-delegates" style={{ marginTop: 28 }}>
        <Text accessibilityRole="header" style={styles.groupTitle}>DELEGATES</Text>
        {ordered.length ? (
          ordered.map((child) => (
            <DelegateRow
              key={child.id}
              child={child}
              theme={theme}
              openAgent={navigation?.openAgent}
            />
          ))
        ) : (
          <View style={styles.empty}>
            <Text style={styles.note}>New tasks will appear here as Architect delegates them.</Text>
          </View>
        )}
      </View>
      <View style={{ marginTop: 28, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingTop: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Ticket details" accessibilityState={{ expanded: showDetails }} onPress={() => setShowDetails(value => !value)} style={[styles.action, { justifyContent: 'space-between' }]}><Text style={styles.muted}>Ticket details</Text><Icon name={showDetails ? 'ChevronUp' : 'ChevronDown'} size={14} color={c.foregroundMuted} /></Pressable>
        {showDetails ? <View style={{ gap: 8 }}><Text selectable style={styles.muted}>{directory}</Text><Text style={styles.muted}>Saved in {origin ? `.architect/tickets/${origin}.md` : '.architect/ticket.md'}</Text><Pressable accessibilityRole="button" accessibilityLabel="Start architect" disabled={starting || !directory} style={styles.action} onPress={async () => {
          if (!directory || starting) return;
          setStarting(true);
          try { const created = await start({ cwd: directory, title: 'Architect' }); navigation?.openAgent?.({ agentId: created.agentId }); }
          catch (error) { setError(error instanceof Error ? error.message : String(error)); }
          finally { setStarting(false); }
        }}><Text style={styles.note}>{starting ? 'Starting…' : 'Start another Architect conversation'}</Text><Icon name="ArrowUpRight" size={14} color={c.foregroundMuted} /></Pressable></View> : null}
      </View>
    </ScrollView>
  </View>;
}
