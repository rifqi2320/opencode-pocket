import React, { useMemo } from 'react';
import { Linking, Platform, ScrollView, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { parseMarkdown, type Block, type Inline } from './markdownParser';
import { makeStyles, radius, space, type, usePalette } from './theme';

type Props = {
  text: string;
  /** Smaller, muted rendering for secondary content (narration, reasoning). */
  tone?: 'default' | 'muted';
  testID?: string;
};

/** Renders assistant Markdown with the app's type scale. Parsing is memoised per text. */
export function Markdown({ text, tone = 'default', testID }: Props) {
  const s = useStyles();
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const base: StyleProp<TextStyle> = tone === 'muted' ? s.mutedText : s.text;
  return <View testID={testID} style={tone === 'muted' ? s.stackTight : s.stack}>{blocks.map((block, index) => <BlockView key={index} block={block} base={base} tone={tone} />)}</View>;
}

function BlockView({ block, base, tone }: { block: Block; base: StyleProp<TextStyle>; tone: 'default' | 'muted' }) {
  const c = usePalette(); const s = useStyles();
  switch (block.type) {
    case 'paragraph': return <Text selectable style={base}><Inlines nodes={block.children} /></Text>;
    case 'heading': return <Text selectable accessibilityRole="header" {...({ 'aria-level': Math.min(6, block.level + 2) } as Record<string, unknown>)} style={[base, block.level === 1 ? s.h1 : block.level === 2 ? s.h2 : s.h3]}><Inlines nodes={block.children} /></Text>;
    case 'hr': return <View style={s.hr} />;
    case 'code': return <View style={s.codeBlock}>
      {block.lang ? <Text style={s.codeLang}>{block.lang}</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[s.codeScroll, !!block.lang && s.codeScrollLabelled]}>
        <Text selectable style={s.codeText}>{block.text}</Text>
      </ScrollView>
    </View>;
    case 'blockquote': return <View style={s.quote}>{block.children.map((child, index) => <BlockView key={index} block={child} base={[base, { color: c.muted }]} tone={tone} />)}</View>;
    case 'list': return <View style={s.list}>{block.items.map((item, index) => <View key={index} style={s.listItem}>
      <Text style={[base, s.marker, block.ordered && s.markerOrdered]}>{item.checked !== undefined ? (item.checked ? '☑' : '☐') : block.ordered ? `${block.start + index}.` : '•'}</Text>
      <View style={s.listBody}>{item.children.map((child, childIndex) => <BlockView key={childIndex} block={child} base={base} tone={tone} />)}</View>
    </View>)}</View>;
    case 'table': {
      const columns = block.header.length;
      const width = (col: number) => {
        const lengths = [block.header[col], ...block.rows.map(row => row[col])].map(cell => plain(cell ?? []).length);
        return Math.max(64, Math.min(260, Math.max(...lengths) * 7.5 + 24));
      };
      const widths = Array.from({ length: columns }, (_, col) => width(col));
      const cell = (nodes: Inline[], col: number, header: boolean, key: number) => <View key={key} style={[s.cell, { width: widths[col] }]}>
        <Text selectable style={[s.cellText, header && s.cellHeader, { textAlign: block.align[col] ?? 'left' }]}><Inlines nodes={nodes} /></Text>
      </View>;
      return <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={s.table}>
          <View style={[s.tr, s.thead]}>{block.header.map((nodes, col) => cell(nodes, col, true, col))}</View>
          {block.rows.map((row, rowIndex) => <View key={rowIndex} style={[s.tr, rowIndex > 0 && s.trBorder]}>{row.map((nodes, col) => cell(nodes, col, false, col))}</View>)}
        </View>
      </ScrollView>;
    }
  }
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  const s = useStyles();
  return <>{nodes.map((node, index) => {
    switch (node.type) {
      case 'text': return <React.Fragment key={index}>{node.text}</React.Fragment>;
      case 'br': return <React.Fragment key={index}>{'\n'}</React.Fragment>;
      case 'code': return <Text key={index} style={s.inlineCode}>{node.text}</Text>;
      case 'strong': return <Text key={index} style={s.strong}><Inlines nodes={node.children} /></Text>;
      case 'em': return <Text key={index} style={s.em}><Inlines nodes={node.children} /></Text>;
      case 'del': return <Text key={index} style={s.del}><Inlines nodes={node.children} /></Text>;
      case 'link': return <Text key={index} accessibilityRole="link" style={s.link} onPress={() => { void Linking.openURL(node.href).catch(() => undefined); }}
        {...(Platform.OS === 'web' ? { href: node.href, hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' } } as Record<string, unknown> : {})}><Inlines nodes={node.children} /></Text>;
    }
  })}</>;
}

function plain(nodes: Inline[]): string { return nodes.map(node => node.type === 'text' || node.type === 'code' ? node.text : node.type === 'br' ? ' ' : plain(node.children)).join(''); }

const useStyles = makeStyles(c => ({
  stack: { gap: 10 },
  stackTight: { gap: 6 },
  text: { ...type.body, color: c.text },
  mutedText: { ...type.small, color: c.muted },
  h1: { fontSize: 19, lineHeight: 25, fontWeight: '600', letterSpacing: -0.3, marginTop: 4 },
  h2: { fontSize: 16.5, lineHeight: 23, fontWeight: '600', letterSpacing: -0.2, marginTop: 2 },
  h3: { fontWeight: '600' },
  strong: { fontWeight: '600' },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through' },
  link: { color: c.text, textDecorationLine: 'underline', textDecorationColor: c.borderStrong } as TextStyle,
  inlineCode: { fontFamily: type.mono.fontFamily, fontSize: 13, backgroundColor: c.surfaceAlt, color: c.text, borderRadius: 4 },
  hr: { height: 1, backgroundColor: c.border, marginVertical: space.xs },
  codeBlock: { backgroundColor: c.surfaceAlt, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, overflow: 'hidden' },
  codeLang: { ...type.caption, fontSize: 11, color: c.faint, paddingHorizontal: space.md, paddingTop: space.sm },
  codeScroll: { paddingHorizontal: space.md, paddingVertical: space.sm + 2 },
  codeScrollLabelled: { paddingTop: 2 },
  codeText: { ...type.mono, color: c.text },
  quote: { borderLeftWidth: 3, borderLeftColor: c.borderStrong, paddingLeft: space.md, gap: 6 },
  list: { gap: 4 },
  listItem: { flexDirection: 'row', alignItems: 'flex-start' },
  marker: { width: 18, color: c.faint },
  markerOrdered: { width: 24, fontVariant: ['tabular-nums'] },
  listBody: { flex: 1, minWidth: 0, gap: 4 },
  table: { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, overflow: 'hidden' },
  tr: { flexDirection: 'row' },
  trBorder: { borderTopWidth: 1, borderTopColor: c.border },
  thead: { backgroundColor: c.surfaceAlt, borderBottomWidth: 1, borderBottomColor: c.border },
  cell: { paddingHorizontal: 10, paddingVertical: 6 },
  cellText: { ...type.small, color: c.text },
  cellHeader: { fontWeight: '600' },
}));
