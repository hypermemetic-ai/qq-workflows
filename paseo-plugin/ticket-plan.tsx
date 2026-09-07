import type { PluginTheme } from '@getpaseo/plugin';
import { useMemo, type ReactNode } from 'react';
import { Linking, ScrollView, Text, View } from 'react-native';

import type { TicketTokens } from './architect.shared';
type Token = Omit<TicketTokens[number], 'children'> & { children?: TicketTokens[number]['children'] };
const attr = (token: Token, name: string) => token.attrs?.find(([key]) => key === name)?.[1];
type Node = { token: Token; children: Node[] };
function tree(tokens: Token[]) {
  const root: Node[] = [];
  const stack = [root];
  for (const token of tokens) {
    if (token.nesting === -1) { stack.pop(); continue; }
    const node = { token, children: [] as Node[] };
    stack[stack.length - 1].push(node);
    if (token.nesting === 1) stack.push(node.children);
  }
  return root;
}

export function ticketTitle(text: string) {
  const heading = text.match(/^#\s+(.+)$/m)?.[1].replace(/^Ticket\s*[:—-]?\s*/i, '').trim();
  return heading || 'Workspace ticket';
}

export function TicketPlan({ tokens, theme }: { tokens: TicketTokens; theme: PluginTheme }) {
  const nodes = useMemo(() => tree(tokens), [tokens]);
  const c = theme.colors;
  const body = { color: c.foreground, fontSize: 16, lineHeight: 25 };
  const code = { color: c.foreground, fontFamily: 'monospace', fontSize: 13, lineHeight: 21 };
  function inline(tokens: Token[]): ReactNode[] { return inlineNodes(tree(tokens)); }
  function inlineNodes(nodes: Node[]): ReactNode[] {
    return nodes.map(({ token: t, children }, index) => {
      const contents = children.length ? inlineNodes(children) : t.content;
      if (t.type === 'softbreak') return ' ';
      if (t.type === 'hardbreak') return '\n';
      if (t.type === 'code_inline') return <Text key={index} style={{ ...code, backgroundColor: c.surface2 }}>{t.content}</Text>;
      if (t.type === 'link_open') {
        const href = String(attr(t, 'href') ?? '');
        return <Text key={index} style={{ textDecorationLine: 'underline' }} onPress={/^https?:\/\//i.test(href) ? () => { void Linking.openURL(href).catch(() => undefined); } : undefined}>{contents}</Text>;
      }
      return <Text key={index} style={{ fontWeight: t.type === 'strong_open' ? '600' : undefined, fontStyle: t.type === 'em_open' ? 'italic' : undefined, textDecorationLine: t.type === 's_open' ? 'line-through' : undefined }}>{contents}</Text>;
    });
  }
  function blocks(nodes: Node[], inList = false): ReactNode[] {
    return nodes.map(({ token: t, children }, index) => {
      if (t.type === 'inline') return <Text key={index} selectable style={body}>{inline(t.children ?? [])}</Text>;
      if (t.type === 'heading_open') return <Text key={index} accessibilityRole="header" style={{ ...body, fontSize: t.tag === 'h2' ? 18 : 16, fontWeight: '500', marginTop: 22, marginBottom: 8 }}>{inline(children[0]?.token.children ?? [])}</Text>;
      if (t.type === 'paragraph_open') return <View key={index} style={{ marginBottom: inList ? 4 : 14 }}>{blocks(children, inList)}</View>;
      if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') {
        const start = Number(attr(t, 'start') ?? 1);
        return <View key={index} style={{ gap: 9, marginBottom: 14 }}>{children.map((item, i) => <View key={i} style={{ flexDirection: 'row', gap: 10 }}><Text style={{ ...body, color: c.foregroundMuted, minWidth: 20 }}>{t.type === 'ordered_list_open' ? `${start + i}.` : '•'}</Text><View style={{ flex: 1 }}>{blocks(item.children, true)}</View></View>)}</View>;
      }
      if (t.type === 'fence' || t.type === 'code_block') return <ScrollView horizontal key={index} style={{ backgroundColor: c.surface1, borderRadius: 8, marginVertical: 10 }} contentContainerStyle={{ padding: 12 }}><Text selectable style={code}>{t.content.trimEnd()}</Text></ScrollView>;
      if (t.type === 'hr') return <View key={index} style={{ height: 1, backgroundColor: c.border, marginVertical: 18 }} />;
      if (t.type === 'blockquote_open') return <View key={index} style={{ borderLeftWidth: 2, borderLeftColor: c.border, paddingLeft: 14, marginVertical: 8 }}>{blocks(children)}</View>;
      if (t.type === 'table_open') return <ScrollView horizontal key={index} style={{ marginVertical: 12 }}><View>{blocks(children)}</View></ScrollView>;
      if (t.type === 'tr_open') return <View key={index} style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: c.border }}>{blocks(children)}</View>;
      if (t.type === 'th_open' || t.type === 'td_open') return <View key={index} style={{ width: 190, padding: 10, backgroundColor: t.type === 'th_open' ? c.surface1 : undefined }}>{blocks(children)}</View>;
      return <View key={index}>{children.length ? blocks(children) : <Text style={body}>{t.content}</Text>}</View>;
    });
  }
  return <View testID="architect-ticket-plan">{blocks(nodes)}</View>;
}
