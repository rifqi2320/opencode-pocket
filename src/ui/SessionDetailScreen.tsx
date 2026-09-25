import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { AccessiblePressable, Badge, Button, Card, EmptyState, Group, Header, Icon, SectionTitle, Status, StatusDot, type IconName, type Tone } from './components';
import { makeStyles, radius, space, type, usePalette } from './theme';
import { FormReplyCard } from './FormReplyCard';
import { Timeline } from './Timeline';
import type { FormAnswers } from './forms';
import type { PocketSession, Worker } from './types';

type FormResolution = 'answered' | 'cancelled' | 'pending' | 'unknown';
type Props = {
  session?: PocketSession | undefined; onBack: () => void;
  onSend: (text: string, delivery: 'steer' | 'queue') => Promise<{ state: string } | void>;
  onInterrupt: () => Promise<unknown>;
  onReply: (id: string, answer: 'allow' | 'reject') => Promise<void>;
  onReplyForm: (id: string, answers: FormAnswers) => Promise<FormResolution>;
  onOpenWorker: (key: string) => void;
  /** Fetches the previous page of messages when the server reports more. */
  onLoadEarlier?: () => Promise<void>;
};
type Feedback = { tone: 'success' | 'muted' | 'danger'; text: string; receipt?: boolean };

const live = { accessibilityLiveRegion: 'polite', role: 'status', 'aria-live': 'polite' } as Record<string, unknown>;
const UNCONFIRMED = 'Response unconfirmed. Refresh before retrying.';

export function SessionDetailScreen(props: Props) {
  const s = useStyles();
  if (!props.session) return <View style={[s.page, s.content]}>
    <Header onBack={props.onBack} title="Session unavailable" />
    <EmptyState icon="alert" title="Not in current snapshot" body="This session is no longer reported by the server. Refresh before taking action." />
  </View>;
  // Keyed by destination so drafts, receipts and expansion state never carry over to another session.
  return <SessionDetail key={`${props.session.server}\u0000${props.session.id}`} {...props} session={props.session} />;
}

function SessionDetail({ session, onBack, onSend, onInterrupt, onReply, onReplyForm, onOpenWorker, onLoadEarlier }: Props & { session: PocketSession }) {
  const c = usePalette(); const s = useStyles();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [acting, setActing] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [workersOpen, setWorkersOpen] = useState(() => session.workers.some(worker => worker.needsYou));

  const running = session.status === 'running';
  const permissions = session.attention.filter(item => item.kind === 'permission');

  const runAction = async (action: () => Promise<void>) => {
    setActing(true); setFeedback(null);
    try { await action(); } catch { setFeedback({ tone: 'danger', text: UNCONFIRMED }); } finally { setActing(false); }
  };
  const decide = (id: string, answer: 'allow' | 'reject') => runAction(async () => {
    await onReply(id, answer);
    setDecisions(current => ({ ...current, [id]: `${answer === 'allow' ? 'Allowed once' : 'Rejected'} · checking request state…` }));
  });
  const interrupt = () => runAction(async () => { const result = await onInterrupt(); setFeedback({ tone: 'muted', text: interruptLabel(result) }); });
  const send = async () => {
    const text = draft;
    if (!text.trim() || sending) return;
    setSending(true); setFeedback(null);
    try {
      const outcome = await onSend(text, running ? 'steer' : 'queue');
      setFeedback(outcome?.state === 'accepted' ? { tone: 'success', text: 'Accepted by server · not yet finished', receipt: true } : { tone: 'muted', text: 'Sent · verify session state', receipt: true });
      // Only clear the draft if the user has not edited it while the request was in flight.
      setDraft(current => current === text ? '' : current);
    } catch {
      setFeedback({ tone: 'danger', text: 'Delivery unknown. Check the session before resending; no automatic retry.' });
    } finally { setSending(false); }
  };

  const statusTone: Tone = running ? 'success' : session.status === 'unknown' ? 'warning' : 'neutral';
  const statusLabel = running ? 'Running' : session.status === 'unknown' ? 'Unknown' : 'Idle';
  const meta = [session.agent, session.model].filter(Boolean).join(' · ');
  const familyLine = session.familyStatus === 'working'
    ? session.activeWorkerCount ? `${session.activeWorkerCount} worker${session.activeWorkerCount === 1 ? '' : 's'} active` : 'Workers active'
    : undefined;

  return <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'web' ? undefined : 'padding'}>
    <ScrollView style={s.flex} contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <View style={s.content}>
        <Header onBack={onBack} eyebrow={`${session.server} / ${session.project}`} title={session.title}
          right={session.freshness !== 'live' ? <Status tone={session.freshness === 'offline' ? 'danger' : 'warning'} label={session.freshness === 'offline' ? 'Offline' : 'Stale'} /> : null} />

        <View style={s.now}>
          <View style={s.nowRow}><Status tone={statusTone} label={statusLabel} />{meta ? <Text numberOfLines={1} style={s.faint}>{meta}</Text> : null}<View style={s.spacer} />
            {running ? <Button testID="session_interrupt" label="Stop" icon="stop" variant="danger" size="sm" disabled={acting} accessibilityHint="Interrupts this session only. Workers may continue and completed changes are not reverted." onPress={() => void interrupt()} /> : null}</View>
          {session.status === 'unknown' ? <Text style={s.muted}>{session.summary}</Text> : null}
          {familyLine ? <Text style={s.muted}>{familyLine}</Text> : null}
          {session.failure ? <Text style={s.danger}>{session.failure}</Text> : null}
        </View>

        {permissions.length ? <View style={s.stack}>
          {permissions.map(request => <Card key={`${request.kind}:${request.id}`} style={s.request}>
            <View style={s.requestHead}><Icon name="shield" size={16} color={c.warning} /><Text style={s.requestTitle}>Permission request</Text></View>
            <Text selectable style={s.mono}>{request.label.replace(/^Permission · /, '')}</Text>
            <View style={s.buttons}>
              <Button testID="permission_deny" label="Reject" variant="secondary" size="sm" style={s.flex} disabled={acting} onPress={() => void decide(request.id, 'reject')} />
              <Button testID="permission_allow" label="Allow once" size="sm" style={s.flex} disabled={acting} accessibilityHint="One-time decision for this exact request. Always allow is not available." onPress={() => void decide(request.id, 'allow')} />
            </View>
            {decisions[request.id] ? <Text {...live} style={s.faint}>{decisions[request.id]}</Text> : null}
          </Card>)}
        </View> : null}

        {session.forms.length ? <View style={s.stack}>
          {session.forms.map(form => <FormReplyCard key={form.id} form={form} onSubmit={async (id, answers) => {
            const status = await onReplyForm(id, answers);
            // Surface the outcome outside the card too: the card unmounts once the form leaves the snapshot.
            setFeedback({ tone: status === 'answered' ? 'success' : 'muted', text: formResolutionText(status) });
            return status;
          }} />)}
        </View> : null}

        {session.workers.length ? <>
          <Group style={s.workers}>
            <AccessiblePressable testID="related_sessions_toggle" accessibilityRole="button" accessibilityLabel={`${session.workers.length} workers, ${workersOpen ? 'hide' : 'show'} list`} accessibilityState={{ expanded: workersOpen }} onPress={() => setWorkersOpen(open => !open)} style={({ pressed }) => [s.row, pressed && s.pressed]}>
              <Text style={s.rowTitle}>Workers<Text style={s.count}>{`  ${session.workers.length}`}</Text></Text>
              {session.workers.some(worker => worker.needsYou) ? <Badge text="Needs you" tone="warning" /> : null}
              <View style={s.spacer} />
              <Icon name={workersOpen ? 'down' : 'chevron'} size={16} color={c.faint} />
            </AccessiblePressable>
            {workersOpen ? session.workers.map(worker => <WorkerRow key={worker.id} worker={worker} server={session.server} onOpen={onOpenWorker} />) : null}
          </Group>
        </> : null}

        {session.pendingItems?.length ? <>
          <SectionTitle title="Queued" trailing={`${session.pendingItems.length} · server-managed`} />
          <Group>{session.pendingItems.map(item => <View key={item.id} style={s.row}><Text style={[s.body, s.flex]}>{item.text}</Text></View>)}</Group>
        </> : null}

        <SectionTitle title="Conversation" />
        <Timeline turns={session.messages} sessionRunning={running} {...(session.hasEarlier ? { hasEarlier: true } : {})} {...(onLoadEarlier ? { onLoadEarlier } : {})} />
      </View>
    </ScrollView>

    <View style={s.composerBar}>
      <View style={[s.content, s.composer]}>
        {feedback ? <Text testID={feedback.receipt ? 'message_receipt' : undefined} {...(feedback.tone === 'danger' ? { accessibilityRole: 'alert' as const } : live)} numberOfLines={2}
          style={[s.feedback, { color: feedback.tone === 'success' ? c.success : feedback.tone === 'danger' ? c.danger : c.muted }]}>{feedback.text}</Text> : null}
        <Text numberOfLines={1} style={s.faint}>To {session.title}</Text>
        <View style={s.composerRow}>
          <TextInput testID="message_input" accessibilityLabel={`Message ${session.title}`} value={draft} onChangeText={setDraft} multiline
            placeholder={running ? 'Guide the running turn…' : 'Message'} placeholderTextColor={c.faint} style={s.input} />
          <RoundButton testID="message_send" icon="send" label={running ? `Guide ${session.title}` : `Send to ${session.title}`} tone="accent" disabled={!draft.trim() || sending} busy={sending} onPress={() => void send()} />
        </View>
      </View>
    </View>
  </KeyboardAvoidingView>;
}

function WorkerRow({ worker, server, onOpen }: { worker: Worker; server: string; onOpen: (key: string) => void }) {
  const c = usePalette(); const s = useStyles();
  const tone: Tone = worker.needsYou ? 'warning' : /running|busy|working|active/i.test(worker.status) ? 'success' : /error|fail/i.test(worker.status) ? 'danger' : 'neutral';
  const indent = { paddingLeft: space.lg + Math.max(0, Math.min((worker.depth ?? 1) - 1, 4)) * space.lg };
  const content = <>
    <StatusDot tone={tone} />
    <View style={s.flex}>
      <Text numberOfLines={1} style={s.body}>{worker.title}</Text>
      <Text numberOfLines={1} style={s.faint}>{worker.relation} · {worker.status}</Text>
    </View>
    {worker.needsYou ? <Badge text="Needs you" tone="warning" /> : null}
    {worker.sessionKey ? <Icon name="chevron" size={16} color={c.faint} /> : null}
  </>;
  if (!worker.sessionKey) return <View style={[s.row, indent]}>{content}</View>;
  const key = worker.sessionKey;
  return <AccessiblePressable accessibilityRole="button" accessibilityLabel={`Open worker ${worker.title} on ${server}`} onPress={() => onOpen(key)} style={({ pressed }) => [s.row, indent, pressed && s.pressed]}>{content}</AccessiblePressable>;
}

function RoundButton({ icon, label, hint, tone, disabled, busy, onPress, testID }: { icon: IconName; label: string; hint?: string; tone: 'accent' | 'danger'; disabled?: boolean; busy?: boolean; onPress: () => void; testID?: string }) {
  const c = usePalette(); const s = useStyles();
  return <AccessiblePressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint} accessibilityState={{ disabled: !!disabled, busy: !!busy }} disabled={disabled} onPress={onPress} hitSlop={4}
    style={({ pressed }) => [s.round, { backgroundColor: tone === 'danger' ? c.dangerSoft : c.accent }, disabled && s.disabled, pressed && s.pressed]}>
    <Icon name={icon} size={18} strokeWidth={2.2} color={tone === 'danger' ? c.danger : c.accentText} />
  </AccessiblePressable>;
}

function interruptLabel(result: unknown) {
  const flag = typeof result === 'boolean' ? result : typeof result === 'object' && result !== null && 'interrupted' in result ? (result as { interrupted?: unknown }).interrupted : undefined;
  if (flag === false) return 'Nothing was running · no-op';
  if (flag === true) return 'Interrupt acknowledged · workers may continue';
  return 'Interrupt requested · refreshed state is authoritative';
}
function formResolutionText(status: FormResolution) {
  if (status === 'answered') return 'Form answered';
  if (status === 'cancelled') return 'Form was cancelled elsewhere · not replayed';
  if (status === 'pending') return 'Form still pending · not resubmitted';
  return 'Form state unconfirmed · not resubmitted';
}

const useStyles = makeStyles(c => ({
  flex: { flex: 1 },
  spacer: { flex: 1 },
  page: { paddingHorizontal: space.lg, paddingBottom: space.xxl, backgroundColor: c.bg, flexGrow: 1 },
  content: { width: '100%', maxWidth: 640, alignSelf: 'center' },
  now: { gap: 6, paddingTop: space.md, paddingBottom: space.sm },
  nowRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  body: { ...type.body, color: c.text },
  muted: { ...type.small, color: c.muted },
  faint: { ...type.caption, color: c.faint, flexShrink: 1 },
  danger: { ...type.small, color: c.danger },
  mono: { ...type.mono, color: c.text },
  monoFaint: { ...type.mono, color: c.muted },
  stack: { gap: space.md, marginTop: space.lg },
  request: { gap: space.md, backgroundColor: c.warningSoft, borderColor: c.border, borderLeftWidth: 3, borderLeftColor: c.warning },
  requestHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  requestTitle: { ...type.small, fontWeight: '600', color: c.text },
  buttons: { flexDirection: 'row', gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 48, paddingHorizontal: space.lg, paddingVertical: space.sm },
  rowTitle: { ...type.body, fontWeight: '500', color: c.text },
  count: { color: c.faint, fontWeight: '400' },
  workers: { marginTop: space.xl },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
  composerBar: { borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.bg, paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.sm },
  composer: { gap: space.xs },
  feedback: { ...type.caption, marginBottom: 2 },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  input: { flex: 1, minHeight: 44, maxHeight: 140, backgroundColor: c.surfaceAlt, borderRadius: 20, paddingHorizontal: space.lg, paddingTop: 12, paddingBottom: 12, color: c.text, fontSize: Platform.OS === 'web' ? 16 : 15, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } as object : {}) },
  round: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
}));
