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

const roleName = (child: ChildWork) => child.completion === 'report' ? 'Investigation' : ({ researcher: 'Research', implementer: 'Implementation', teacher: 'Teaching', reviewer: 'Review' }[child.role] ?? child.role);
const needsAttention = (child: ChildWork) => ['uncertain', 'findings'].includes(child.status);
const isRunning = (child: ChildWork) => ['running', 'awaiting_correction'].includes(child.status);
function WorkRow({ child, theme, openAgent }: { child: ChildWork; theme: PluginTheme; openAgent?: (input: { agentId: string }) => void }) {
  const [expanded, setExpanded] = useState(false);
  const c = theme.colors;
  const statusColor = needsAttention(child) ? c.statusWarning : child.status === 'failed' ? c.statusDanger : c.foregroundMuted;
  const description = child.status === 'uncertain' ? 'An interrupted operation needs inspection.'
    : child.status === 'findings' ? 'Review findings need your decision.'
    : child.status === 'failed' ? 'Stopped before completion.'
    : child.role === 'researcher' ? child.status === 'succeeded' ? 'Findings returned to Architect.' : 'Findings will return to your conversation.'
    : child.completion === 'report' ? 'Investigation only; no changes to merge.'
    : child.kind === 'open' ? 'Review before merging.' : child.kind === 'bounded' ? 'Bounded implementation.' : 'A conversation with Architect’s specialist.';
  const icon = child.role === 'researcher' ? 'Search' : child.role === 'teacher' ? 'GraduationCap' : 'Code';
  return <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${roleName(child)}: ${workStatus(child)}. ${expanded ? 'Hide' : 'Show'} details`} accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)} style={{ paddingVertical: 17, flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
      <View style={{ paddingTop: 3 }}><Icon name={icon} size={17} color={c.foregroundMuted} /></View>
      <View style={{ flex: 1, gap: 5 }}>
        <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'space-between', alignItems: 'baseline' }}><Text style={{ color: c.foreground, fontSize: 16 }}>{roleName(child)}</Text><Text style={{ color: statusColor, fontSize: 12 }}>{workStatus(child)}</Text></View>
        <Text style={{ color: c.foregroundMuted, fontSize: 14, lineHeight: 21 }}>{description}</Text>
      </View>
      <View style={{ paddingTop: 3 }}><Icon name={expanded ? 'ChevronUp' : 'ChevronDown'} size={14} color={c.foregroundMuted} /></View>
    </Pressable>
    {expanded ? <View style={{ paddingLeft: 29, paddingBottom: 18, gap: 12 }}>
      {child.error ? <View style={{ backgroundColor: c.surface1, padding: 12, borderRadius: 8 }}><Text selectable style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 20 }}>{child.error}</Text></View> : null}
      {child.createdAt ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{new Date(child.createdAt).toLocaleString()}</Text> : null}
      {child.agentId && openAgent ? <Pressable accessibilityRole="button" accessibilityLabel={`Open ${child.role} conversation`} onPress={() => openAgent({ agentId: child.agentId! })} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 }}><Text style={{ color: c.foreground, fontSize: 14 }}>Open conversation</Text><Icon name="ArrowUpRight" size={15} color={c.foregroundMuted} /></Pressable> : null}
    </View> : null}
  </View>;
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
  const [showHistory, setShowHistory] = useState(false);
  const [section, setSection] = useState<'plan' | 'work'>('plan');
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
    project: { color: c.foregroundMuted, fontSize: 13, marginTop: 7, marginBottom: 21 },
    tabs: { flexDirection: 'row', gap: 26, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    tab: { minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 7, borderBottomWidth: 2 },
    tabText: { fontSize: 14, fontWeight: '500' },
    count: { minWidth: 20, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 5, backgroundColor: c.surface2, alignItems: 'center' },
    content: { paddingHorizontal: layout.compact ? 20 : 28, paddingTop: 14, paddingBottom: 36 },
    groupTitle: { color: c.foregroundMuted, fontSize: 12, fontWeight: '500', marginTop: 18, marginBottom: 1 },
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
      const [ticket, result] = await Promise.allSettled([loadTicket({ cwd: directory }), loadChildren({ cwd: directory })]);
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
  }, [directory, loadTicket, loadChildren]);

  useEffect(() => {
    setText(""); setTokens([]); setChildren([]); setShowHistory(false); setSection('plan'); setError(null);
    void reload();
    const timer = setInterval(() => { void reload({ quiet: true }); }, 5000);
    return () => { generation.current++; inFlight.current = null; clearInterval(timer); };
  }, [reload]);
  const ordered = [...children].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const running = ordered.filter(isRunning);
  const attention = ordered.filter(needsAttention);
  const history = ordered.filter(child => !isRunning(child) && !needsAttention(child));
  const rows = (items: ChildWork[]) => items.map(child => <WorkRow key={child.id} child={child} theme={theme} openAgent={navigation?.openAgent} />);

  return <View testID={`architect-ticket-${workspaceId}`} style={styles.screen}>
    <View style={[styles.width, styles.header]}>
      <View style={styles.top}>
        {origin && navigation?.openAgent ? <Pressable accessibilityRole="button" accessibilityLabel="Back to conversation" onPress={() => navigation.openAgent({ agentId: origin })} style={styles.action}><Icon name="ArrowLeft" size={16} color={c.foregroundMuted} /><Text style={styles.muted}>Conversation</Text></Pressable> : <Text style={styles.muted}>Ticket</Text>}
        <Pressable accessibilityRole="button" accessibilityLabel="Reload ticket" accessibilityState={{ busy: loading, disabled: !directory }} disabled={!directory} onPress={() => reload()} style={styles.iconButton}><Icon name="RefreshCw" size={16} color={c.foregroundMuted} /></Pressable>
      </View>
      <Text accessibilityRole="header" style={styles.title}>{ticketTitle(text)}</Text>
      <Text style={styles.project}>{project || directory?.split('/').pop() || 'Workspace'}{running.length ? `  ·  ${running.length} in progress` : ''}{attention.length ? `  ·  ${attention.length} needs attention` : ''}</Text>
      <View style={styles.tabs}>
        {(['plan', 'work'] as const).map(value => <Pressable key={value} accessibilityRole="tab" accessibilityLabel={value === 'plan' ? 'Show ticket plan' : 'Show delegated work'} accessibilityState={{ selected: section === value }} onPress={() => setSection(value)} style={[styles.tab, { borderBottomColor: section === value ? c.foreground : 'transparent' }]}><Text style={[styles.tabText, { color: section === value ? c.foreground : c.foregroundMuted }]}>{value === 'plan' ? 'Plan' : 'Work'}</Text>{value === 'work' && children.length ? <View style={styles.count}><Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{children.length}</Text></View> : null}</Pressable>)}
      </View>
    </View>
    <ScrollView key={section} style={{ flex: 1 }} contentContainerStyle={[styles.width, styles.content]}>
      {error ? <Pressable accessibilityRole="button" accessibilityLabel="Show connection details" onPress={() => setShowDetails(value => !value)} style={{ paddingVertical: 12 }}><Text style={styles.note}>Couldn’t refresh. Showing the last available information.</Text>{showDetails ? <Text selectable style={styles.muted}>{error}</Text> : null}</Pressable> : null}
      {section === 'plan' ? text ? <TicketPlan tokens={tokens} theme={theme} /> : <View style={styles.empty}><Text style={styles.emptyTitle}>{loading ? 'Loading your plan…' : 'A plan starts with a conversation'}</Text><Text style={styles.note}>Tell Architect what you want to change. The scope and decisions will appear here.</Text></View> : <View testID="architect-work-list">
        {running.length ? <><Text accessibilityRole="header" style={styles.groupTitle}>IN PROGRESS</Text>{rows(running)}</> : null}
        {attention.length ? <><Text accessibilityRole="header" style={styles.groupTitle}>NEEDS ATTENTION</Text>{rows(attention)}</> : null}
        {!running.length && !attention.length ? <View style={styles.empty}><Text style={styles.emptyTitle}>No work in progress</Text><Text style={styles.note}>New tasks will appear here as Architect delegates them.</Text></View> : null}
        {history.length ? <View style={{ marginTop: 18 }}><Pressable accessibilityRole="button" accessibilityLabel={showHistory ? 'Hide work history' : 'Show work history'} accessibilityState={{ expanded: showHistory }} onPress={() => setShowHistory(value => !value)} style={[styles.action, { justifyContent: 'space-between' }]}><Text style={styles.note}>Earlier work · {history.length}</Text><Icon name={showHistory ? 'ChevronUp' : 'ChevronDown'} size={15} color={c.foregroundMuted} /></Pressable>{showHistory ? rows(history) : null}</View> : null}
      </View>}
      <View style={{ marginTop: 28, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingTop: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Ticket details" accessibilityState={{ expanded: showDetails }} onPress={() => setShowDetails(value => !value)} style={[styles.action, { justifyContent: 'space-between' }]}><Text style={styles.muted}>Ticket details</Text><Icon name={showDetails ? 'ChevronUp' : 'ChevronDown'} size={14} color={c.foregroundMuted} /></Pressable>
        {showDetails ? <View style={{ gap: 8 }}><Text selectable style={styles.muted}>{directory}</Text><Text style={styles.muted}>Saved in .architect/ticket.md</Text><Pressable accessibilityRole="button" accessibilityLabel="Start architect" disabled={starting || !directory} style={styles.action} onPress={async () => {
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
