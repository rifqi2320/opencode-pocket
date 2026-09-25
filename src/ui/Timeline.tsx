import React, { useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { AccessiblePressable, Button, Icon, StatusDot, type Tone } from './components';
import { Markdown } from './Markdown';
import { makeStyles, radius, space, type, usePalette } from './theme';
import { formatDuration, summarizeSteps } from './turns';
import type { PocketStep, PocketToolStep, PocketTurn } from './types';

type AssistantTurn = Extract<PocketTurn, { kind: 'assistant' }>;
const STEP_WINDOW = 40;

/** Conversation view: user prompts as bubbles, assistant work collapsed above the Markdown answer. */
export function Timeline({ turns, sessionRunning, hasEarlier, onLoadEarlier }: { turns: PocketTurn[]; sessionRunning: boolean; hasEarlier?: boolean; onLoadEarlier?: () => Promise<void> }) {
  const s = useStyles();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const toggle = (id: string) => setOpen(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const lastAssistant = [...turns].reverse().find(turn => turn.kind === 'assistant');
  const loadEarlier = async () => { if (!onLoadEarlier || loading) return; setLoading(true); try { await onLoadEarlier(); } catch { /* freshness shows failures */ } finally { setLoading(false); } };

  return <View testID="messages_list" accessibilityLabel="Conversation" style={s.timeline}>
    {hasEarlier && onLoadEarlier ? <View style={s.earlier}><Button testID="messages_load_earlier" label="Load earlier messages" variant="ghost" size="sm" loading={loading} onPress={() => void loadEarlier()} /></View> : null}
    {turns.length ? turns.map(turn => turn.kind === 'user'
      ? <UserTurn key={turn.id} turn={turn} />
      : <AssistantTurnView key={turn.id} turn={turn} live={sessionRunning && turn === lastAssistant && !!turn.running} open={open} toggle={toggle} />)
      : <Text style={s.faint}>No messages loaded</Text>}
  </View>;
}

function UserTurn({ turn }: { turn: Extract<PocketTurn, { kind: 'user' }> }) {
  const s = useStyles();
  return <View style={s.userWrap}>
    <View style={s.bubble}><Text selectable style={s.body}>{turn.text || ' '}</Text></View>
    {turn.files?.length ? <View style={s.files}>{turn.files.map((file, index) => <View key={`${file}:${index}`} style={s.fileChip}><Text numberOfLines={1} style={s.fileText}>{file}</Text></View>)}</View> : null}
    {turn.time ? <Text style={s.meta}>{turn.time}</Text> : null}
  </View>;
}

function AssistantTurnView({ turn, live, open, toggle }: { turn: AssistantTurn; live: boolean; open: ReadonlySet<string>; toggle: (id: string) => void }) {
  const c = usePalette(); const s = useStyles();
  const [showAll, setShowAll] = useState(false);
  const summary = summarizeSteps(turn.steps);
  const expanded = open.has(turn.id);
  const duration = formatDuration(turn.durationMs);
  const current = live ? summary.running ?? [...turn.steps].reverse().find(step => step.kind === 'tool' || step.kind === 'reasoning') : undefined;
  const liveLabel = current ? current.kind === 'tool' ? `${current.name} · ${current.title}` : current.kind === 'reasoning' ? 'Thinking' : 'Working' : 'Working';
  const hidden = !showAll && turn.steps.length > STEP_WINDOW ? turn.steps.length - STEP_WINDOW : 0;
  const visible = hidden ? turn.steps.slice(-STEP_WINDOW) : turn.steps;
  const label = live ? liveLabel : [summary.label, duration].filter(Boolean).join(' · ');

  return <View style={s.assistant}>
    {turn.steps.length || live ? <View>
      <AccessiblePressable testID="turn_steps_toggle" accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={`${label}. ${expanded ? 'Hide' : 'Show'} steps`}
        disabled={!turn.steps.length} onPress={() => toggle(turn.id)} style={({ pressed }) => [s.summary, pressed && s.pressed]}>
        {live ? <ActivityIndicator size="small" color={c.muted} style={s.spinner} /> : <Icon name={expanded ? 'down' : 'chevron'} size={14} color={c.faint} />}
        <Text numberOfLines={1} style={[s.summaryText, live && { color: c.muted }]}>{label}</Text>
        {summary.failed && !live ? <StatusDot tone="danger" size={6} /> : null}
      </AccessiblePressable>
      {expanded ? <View style={s.steps}>
        {hidden ? <AccessiblePressable accessibilityRole="button" accessibilityLabel={`Show ${hidden} earlier steps`} onPress={() => setShowAll(true)} style={({ pressed }) => [s.stepRow, pressed && s.pressed]}>
          <Text style={s.more}>{`Show ${hidden} earlier step${hidden === 1 ? '' : 's'}`}</Text>
        </AccessiblePressable> : null}
        {visible.map(step => <StepView key={step.id} step={step} live={live} open={open.has(step.id)} onToggle={() => toggle(step.id)} />)}
      </View> : null}
    </View> : null}
    {turn.finalText ? <Markdown testID="assistant_answer" text={turn.finalText} /> : null}
    {turn.error ? <Text selectable style={s.error}>{turn.error}</Text> : null}
    {!live && turn.outcome ? <Text style={s.meta}>{turn.outcome === 'interrupted' ? 'Interrupted' : turn.outcome === 'failed' ? 'Failed' : turn.outcome}</Text> : null}
  </View>;
}

function StepView({ step, live, open, onToggle }: { step: PocketStep; live: boolean; open: boolean; onToggle: () => void }) {
  const c = usePalette(); const s = useStyles();
  if (step.kind === 'text') return <View style={s.narration}><Markdown text={step.text} tone="muted" /></View>;
  if (step.kind === 'tool') return <ToolStep step={step} live={live} open={open} onToggle={onToggle} />;
  const title = step.kind === 'reasoning' ? reasoningTitle(step.text) : step.label;
  const detail = step.kind === 'reasoning' ? (step.text.replace(/^\s*\*\*[^*\n]+\*\*\s*/, '').trim() || undefined) : step.text;
  const label = step.kind === 'reasoning' ? `Thinking${title ? ` · ${title}` : ''}` : title;
  const duration = step.kind === 'reasoning' ? formatDuration(step.durationMs) : undefined;
  const head = <>
    <View style={s.lead}><View style={step.kind === 'reasoning' ? s.ring : s.square} /></View>
    <Text numberOfLines={1} style={[s.stepTitle, s.italicFaint]}>{label}</Text>
    {duration ? <Text style={s.duration}>{duration}</Text> : null}
    <Chevron show={!!detail} open={open} />
  </>;
  if (!detail) return <View style={s.stepRow}>{head}</View>;
  return <View>
    <AccessiblePressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${label}. ${open ? 'Hide' : 'Show'} details`} onPress={onToggle} style={({ pressed }) => [s.stepRow, pressed && s.pressed]}>{head}</AccessiblePressable>
    {open ? <View style={s.detail}>{step.kind === 'reasoning' ? <Markdown text={detail} tone="muted" /> : <Text selectable style={s.monoBlock}>{detail}</Text>}</View> : null}
  </View>;
}

function ToolStep({ step, live, open, onToggle }: { step: PocketToolStep; live: boolean; open: boolean; onToggle: () => void }) {
  const c = usePalette(); const s = useStyles();
  const active = step.status === 'running' || step.status === 'pending';
  // A non-zero exit (e.g. failing tests) is a result, not a tool failure: warn rather than alarm.
  const tone: Tone = step.status === 'error' ? 'danger' : step.exitCode !== undefined ? 'warning' : step.status === 'completed' ? 'success' : 'neutral';
  const duration = formatDuration(step.durationMs);
  const hasDetail = !!(step.input || step.output || step.error);
  const statusText = step.status === 'error' ? 'failed' : active ? (live ? 'running' : 'did not finish') : step.exitCode !== undefined ? `exit ${step.exitCode}` : 'completed';
  const head = <>
    <View style={s.lead}>{active && live ? <ActivityIndicator size="small" color={c.muted} style={s.spinnerSm} /> : <StatusDot tone={tone} size={6} />}</View>
    <Text style={s.toolName}>{step.name}</Text>
    <Text numberOfLines={1} style={[s.stepTitle, tone === 'danger' && { color: c.danger }]}>{step.title === step.name ? '' : step.title}</Text>
    {duration ? <Text style={s.duration}>{duration}</Text> : null}
    <Chevron show={hasDetail} open={open} />
  </>;
  const a11y = `${step.name} ${step.title}, ${statusText}${duration ? `, ${duration}` : ''}`;
  if (!hasDetail) return <View accessible accessibilityLabel={a11y} style={s.stepRow}>{head}</View>;
  return <View>
    <AccessiblePressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${a11y}. ${open ? 'Hide' : 'Show'} input and output`} onPress={onToggle} style={({ pressed }) => [s.stepRow, pressed && s.pressed]}>{head}</AccessiblePressable>
    {open ? <View style={s.detail}>
      {step.input ? <IO label="Input" text={step.input} truncated={step.inputTruncated} /> : null}
      {step.error ? <IO label="Error" text={step.error} danger /> : null}
      {step.output ? <IO label={step.exitCode !== undefined ? `Output · exit ${step.exitCode}` : 'Output'} text={step.output} truncated={step.outputTruncated} /> : null}
    </View> : null}
  </View>;
}

function IO({ label, text, truncated, danger }: { label: string; text: string; truncated?: boolean | undefined; danger?: boolean }) {
  const c = usePalette(); const s = useStyles();
  return <View style={s.io}>
    <Text style={[s.ioLabel, danger && { color: c.danger }]}>{label}</Text>
    <View style={[s.monoWrap, danger && { backgroundColor: c.dangerSoft }]}><Text selectable style={[s.monoBlock, danger && { color: c.danger }]}>{text}</Text></View>
    {truncated ? <Text style={s.meta}>{label.startsWith('Input') ? 'Truncated · showing the first 4,000 characters' : 'Truncated · showing the start and end (4,000 characters)'}</Text> : null}
  </View>;
}

function Chevron({ show, open }: { show: boolean; open: boolean }) {
  const c = usePalette();
  // Always reserve the slot so durations line up whether or not a row is expandable.
  return <View style={{ width: 12 }}>{show ? <Icon name={open ? 'down' : 'chevron'} size={12} color={c.faint} /> : null}</View>;
}

function reasoningTitle(text: string) {
  const bold = text.match(/^\s*\*\*([^*\n]+)\*\*/);
  const line = (bold ? bold[1] : text.split('\n').find(value => value.trim())) ?? '';
  return line.replace(/[*_`#]/g, '').trim().slice(0, 100);
}

const useStyles = makeStyles(c => ({
  timeline: { gap: space.xl },
  earlier: { alignItems: 'center' },
  faint: { ...type.caption, color: c.faint },
  meta: { ...type.caption, color: c.faint },
  body: { ...type.body, color: c.text },
  pressed: { opacity: 0.6 },
  userWrap: { alignItems: 'flex-end', gap: 4, paddingLeft: space.xxl },
  bubble: { maxWidth: '100%', backgroundColor: c.surfaceAlt, borderRadius: 18, borderBottomRightRadius: 6, paddingHorizontal: 14, paddingVertical: 9 },
  files: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6 },
  fileChip: { borderWidth: 1, borderColor: c.border, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2, maxWidth: 220 },
  fileText: { ...type.caption, color: c.muted },
  assistant: { gap: space.md },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', maxWidth: '100%', minHeight: 28, paddingVertical: 2, paddingRight: space.sm },
  summaryText: { ...type.small, color: c.faint, flexShrink: 1 },
  spinner: { transform: [{ scale: 0.7 }], width: 14, height: 14 },
  spinnerSm: { transform: [{ scale: 0.55 }], width: 10, height: 10 },
  steps: { marginTop: space.xs, marginLeft: 6, paddingLeft: space.md, borderLeftWidth: 1, borderLeftColor: c.border, gap: 2 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 30 },
  lead: { width: 12, alignItems: 'center', justifyContent: 'center' },
  ring: { width: 7, height: 7, borderRadius: 4, borderWidth: 1.5, borderColor: c.faint },
  square: { width: 6, height: 6, borderRadius: 1.5, backgroundColor: c.borderStrong },
  toolName: { ...type.mono, fontSize: 12, color: c.muted },
  stepTitle: { ...type.small, color: c.text, flex: 1, minWidth: 0 },
  italicFaint: { color: c.muted, fontStyle: 'italic' },
  duration: { ...type.caption, color: c.faint, fontVariant: ['tabular-nums'] },
  more: { ...type.caption, color: c.muted, textDecorationLine: 'underline' },
  narration: { paddingVertical: 4, paddingLeft: 20 },
  detail: { paddingLeft: 20, paddingBottom: space.sm, gap: space.sm },
  io: { gap: 4 },
  ioLabel: { ...type.caption, fontSize: 11, fontWeight: '600', color: c.faint, textTransform: 'uppercase', letterSpacing: 0.4 },
  monoWrap: { backgroundColor: c.surfaceAlt, borderRadius: radius.sm + 2, paddingHorizontal: 10, paddingVertical: 8 },
  monoBlock: { ...type.mono, fontSize: 12, lineHeight: 17, color: c.text },
  error: { ...type.small, color: c.danger },
}));
