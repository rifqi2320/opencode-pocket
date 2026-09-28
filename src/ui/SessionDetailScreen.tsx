import React, { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AccessiblePressable, Badge, Button, Card, EmptyState, Group, Header, Icon, IconButton, SectionTitle, Status, StatusDot, Toggle, type IconName, type Tone } from './components';
import { controlsForSession, DEFAULT_SESSION_CONTROLS, normalizeSessionControlsStore, SESSION_CONTROLS_KEY, sessionControlsId, type PromptDeliveryPreference, type SessionControls, type SessionControlsStore, updateSessionControls } from '../core/sessionControls';
import { makeStyles, radius, space, type, usePalette } from './theme';
import { FormReplyCard } from './FormReplyCard';
import { Timeline } from './Timeline';
import type { FormAnswers } from './forms';
import type { PocketSession, Worker } from './types';
import type { SessionModel, SessionModelRef } from '../core/types';

type FormResolution = 'answered' | 'cancelled' | 'pending' | 'unknown';
type Props = {
  session?: PocketSession | undefined; onBack: () => void;
  onSend: (text: string, delivery: 'steer' | 'queue') => Promise<{ state: string } | void>;
  onInterrupt: () => Promise<unknown>;
  onReply: (id: string, answer: 'allow' | 'reject') => Promise<void>;
  onReplyForm: (id: string, answers: FormAnswers) => Promise<FormResolution>;
  onOpenWorker: (key: string) => void;
  /** Refreshes this session without leaving its conversation. */
  onRefresh: () => Promise<void>;
  /** Lists models and variants available at this session's server location. */
  onListModels: () => Promise<SessionModel[]>;
  /** Changes the model used by subsequent provider turns. */
  onSwitchModel: (model: SessionModelRef) => Promise<void>;
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

function SessionDetail({ session, onBack, onSend, onInterrupt, onReply, onReplyForm, onOpenWorker, onRefresh, onListModels, onSwitchModel, onLoadEarlier }: Props & { session: PocketSession }) {
  const c = usePalette(); const s = useStyles();
  const scrollRef = useRef<ScrollView>(null);
  const lastScrollY = useRef(0);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [acting, setActing] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [workersOpen, setWorkersOpen] = useState(() => session.workers.some(worker => worker.needsYou));
  const [controlsOpen, setControlsOpen] = useState(false);
  const [showScrollLatest, setShowScrollLatest] = useState(false);
  const [showCompactHeader, setShowCompactHeader] = useState(false);
  const [composerHeight, setComposerHeight] = useState(96);
  const controlsId = sessionControlsId(session.serverId ?? session.server, session.remoteId ?? session.id);
  const controlsStore = useRef<SessionControlsStore>({ sessions: {} });
  const controlsRevision = useRef(0);
  const [controls, setControls] = useState<SessionControls>(DEFAULT_SESSION_CONTROLS);
  useEffect(() => {
    let active = true;
    const revision = controlsRevision.current;
    setControls(DEFAULT_SESSION_CONTROLS);
    void AsyncStorage.getItem(SESSION_CONTROLS_KEY).then(value => {
      const store = normalizeSessionControlsStore(value ? JSON.parse(value) : undefined);
      if (!active || revision !== controlsRevision.current) return;
      controlsStore.current = store;
      setControls(controlsForSession(store, controlsId));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [controlsId]);
  const updateControls = (patch: Partial<SessionControls>) => {
    controlsRevision.current++;
    controlsStore.current = updateSessionControls(controlsStore.current, controlsId, patch);
    setControls(controlsForSession(controlsStore.current, controlsId));
    void AsyncStorage.setItem(SESSION_CONTROLS_KEY, JSON.stringify(controlsStore.current)).catch(() => undefined);
  };

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
      const delivery = controls.delivery === 'automatic' ? (running ? 'steer' : 'queue') : controls.delivery;
      const outcome = await onSend(text, delivery);
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
  const scrollToLatest = () => { scrollRef.current?.scrollToEnd({ animated: true }); setShowScrollLatest(false); };
  const onScroll = (event: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const y = Math.max(0, contentOffset.y);
    const nearLatest = y + layoutMeasurement.height >= contentSize.height - 96;
    setShowScrollLatest(current => current === !nearLatest ? current : !nearLatest);
    if (y < 32) setShowCompactHeader(false);
    else if (y < lastScrollY.current - 8) setShowCompactHeader(true);
    else if (y > lastScrollY.current + 8) setShowCompactHeader(false);
    lastScrollY.current = y;
  };
  const headerActions = <View style={s.headerActions}>{session.freshness !== 'live' ? <Status tone={session.freshness === 'offline' ? 'danger' : 'warning'} label={session.freshness === 'offline' ? 'Offline' : 'Stale'} /> : null}<IconButton testID="session_controls" icon="more" label="Session controls" onPress={() => setControlsOpen(true)} /></View>;

  // Some Android IMEs report an inset that ends above their accessory strip. Keep the entire
  // composer, including its send button, clear of that strip rather than letting it be clipped.
  return <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined} keyboardVerticalOffset={Platform.OS === 'android' ? 80 : 0}>
    {showCompactHeader ? <View style={s.floatingHeader}><View style={[s.content, s.compactHeader]}><IconButton icon="back" label="Back" onPress={onBack} /><Text numberOfLines={1} style={s.floatingTitle}>{session.title}</Text><View style={s.spacer} /><IconButton icon="more" label="Session controls" onPress={() => setControlsOpen(true)} /></View></View> : null}
    <ScrollView ref={scrollRef} style={s.flex} contentContainerStyle={s.page} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} scrollEventThrottle={16} onScroll={onScroll}>
      <View style={s.content}>
        <Header onBack={onBack} eyebrow={`${session.server} / ${session.project}`} title={session.title}
          right={headerActions} />

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
        <Timeline key={`${session.id}:${controls.showThinking}:${controls.expandToolDetails}`} turns={session.messages} sessionRunning={running} showThinking={controls.showThinking} expandToolDetails={controls.expandToolDetails} {...(session.hasEarlier ? { hasEarlier: true } : {})} {...(onLoadEarlier ? { onLoadEarlier } : {})} />
      </View>
    </ScrollView>

    {showScrollLatest ? <View style={[s.scrollLatest, { bottom: composerHeight + space.md }]}><Button label="Latest" icon="down" variant="secondary" size="sm" onPress={scrollToLatest} /></View> : null}
    <View style={s.composerBar} onLayout={event => { const height = Math.ceil(event.nativeEvent.layout.height); setComposerHeight(current => current === height ? current : height); }}>
      <View style={[s.content, s.composer]}>
        {feedback ? <Text testID={feedback.receipt ? 'message_receipt' : undefined} {...(feedback.tone === 'danger' ? { accessibilityRole: 'alert' as const } : live)} numberOfLines={2}
          style={[s.feedback, { color: feedback.tone === 'success' ? c.success : feedback.tone === 'danger' ? c.danger : c.muted }]}>{feedback.text}</Text> : null}
        <Text numberOfLines={1} style={s.faint}>To {session.title} · {deliveryLabel(controls.delivery, running)}</Text>
        <View style={s.composerRow}>
          <TextInput testID="message_input" accessibilityLabel={`Message ${session.title}`} value={draft} onChangeText={setDraft} multiline
            placeholder={running ? 'Guide the running turn…' : 'Message'} placeholderTextColor={c.faint} style={s.input} />
          <RoundButton testID="message_send" icon="send" label={running ? `Guide ${session.title}` : `Send to ${session.title}`} tone="accent" disabled={!draft.trim() || sending} busy={sending} onPress={() => void send()} />
        </View>
      </View>
    </View>
    <SessionControlsSheet visible={controlsOpen} session={session} controls={controls} running={running} acting={acting} onClose={() => setControlsOpen(false)} onUpdate={updateControls}
      onRefresh={() => runAction(async () => { await onRefresh(); setFeedback({ tone: 'muted', text: 'Session refreshed.' }); })}
      onListModels={onListModels} onSwitchModel={async model => { setActing(true); setFeedback(null); try { await onSwitchModel(model); setFeedback({ tone: 'success', text: `Model switched to ${modelLabel(model)}.` }); } finally { setActing(false); } }}
      onInterrupt={() => { setControlsOpen(false); interrupt(); }} />
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

type ControlsPage = 'home' | 'delivery' | 'model' | 'variant' | 'details' | 'confirm-stop';

function SessionControlsSheet({ visible, session, controls, running, acting, onClose, onUpdate, onRefresh, onListModels, onSwitchModel, onInterrupt }: {
  visible: boolean; session: PocketSession; controls: SessionControls; running: boolean; acting: boolean; onClose: () => void; onUpdate: (patch: Partial<SessionControls>) => void;
  onRefresh: () => Promise<void>; onListModels: () => Promise<SessionModel[]>; onSwitchModel: (model: SessionModelRef) => Promise<void>; onInterrupt: () => void;
}) {
  const c = usePalette(); const s = useStyles();
  const [page, setPage] = useState<ControlsPage>('home');
  const [models, setModels] = useState<SessionModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string>();
  const [switchingModel, setSwitchingModel] = useState(false);
  const [selectedModel, setSelectedModel] = useState<SessionModel>();
  const listModelsRef = useRef(onListModels);
  useEffect(() => { listModelsRef.current = onListModels; }, [onListModels]);
  useEffect(() => { if (visible) setPage('home'); }, [visible]);
  useEffect(() => {
    if (!visible || page !== 'model') return;
    let active = true; setModelsLoading(true); setModelsError(undefined);
    void listModelsRef.current().then(value => { if (active) setModels(value); }).catch(() => { if (active) setModelsError('Could not load models from this server.'); }).finally(() => { if (active) setModelsLoading(false); });
    return () => { active = false; };
  }, [visible, page]);
  const back = () => page === 'home' ? onClose() : setPage('home');
  const title = page === 'home' ? 'Session controls' : page === 'delivery' ? 'Prompt delivery' : page === 'model' ? 'Switch model' : page === 'variant' ? 'Choose variant' : page === 'details' ? 'Session details' : 'Stop session';
  const chooseModel = async (model: SessionModel, variant?: string) => {
    setSwitchingModel(true); setModelsError(undefined);
    try { await onSwitchModel({ providerID: model.providerID, id: model.id, ...(variant ? { variant } : {}) }); setPage('home'); }
    catch { setModelsError('Could not switch the model. Refresh the session and try again.'); }
    finally { setSwitchingModel(false); }
  };
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={back}>
    <View style={s.modalOverlay}>
      <View accessibilityViewIsModal style={s.sheet}>
        <View style={s.sheetHeader}>
          {page === 'home' ? <View style={s.sheetHeaderButton} /> : <IconButton icon="back" label="Back to session controls" onPress={back} />}
          <Text accessibilityRole="header" style={s.sheetTitle}>{title}</Text>
          <IconButton icon="x" label="Close session controls" onPress={onClose} />
        </View>
        <ScrollView contentContainerStyle={s.sheetContent} keyboardShouldPersistTaps="handled">
          {page === 'home' ? <>
            <View style={s.sheetIntro}><Text numberOfLines={1} style={s.body}>{session.title}</Text><Text numberOfLines={1} style={s.faint}>{session.server} · {session.project}</Text></View>
            <SheetSection title="Execution">
              <ControlRow label="Agent" value={session.agent ?? 'Default'} />
              <ControlRow label="Model" value={session.model ?? 'Default'} onPress={() => setPage('model')} />
              <ControlRow label="Prompt delivery" value={deliveryLabel(controls.delivery, running)} onPress={() => setPage('delivery')} />
            </SheetSection>
            <SheetSection title="Display">
              <ToggleRow label="Show thinking" value={controls.showThinking} onChange={showThinking => onUpdate({ showThinking })} />
              <ToggleRow label="Expand tool details" value={controls.expandToolDetails} onChange={expandToolDetails => onUpdate({ expandToolDetails })} />
            </SheetSection>
            <SheetSection title="Session">
              <ControlRow label="Refresh session" value={acting ? 'Refreshing…' : undefined} onPress={() => void onRefresh()} disabled={acting} />
              <ControlRow label="Session details" onPress={() => setPage('details')} />
            </SheetSection>
            {running ? <SheetSection title="Actions"><ControlRow label="Stop session" danger onPress={() => setPage('confirm-stop')} disabled={acting} /></SheetSection> : null}
            <Text style={s.sheetNote}>These controls apply only to this Pocket session. Agent is shown for reference; model changes apply to subsequent provider turns.</Text>
          </> : null}
          {page === 'delivery' ? <>
            <Text style={s.sheetDescription}>Choose how messages from Pocket are delivered to this session.</Text>
            <ChoiceRow label="Automatic" detail="Steer while running; queue when idle." selected={controls.delivery === 'automatic'} onPress={() => { onUpdate({ delivery: 'automatic' }); setPage('home'); }} />
            <ChoiceRow label="Always steer" detail="Send guidance into the active turn." selected={controls.delivery === 'steer'} onPress={() => { onUpdate({ delivery: 'steer' }); setPage('home'); }} />
            <ChoiceRow label="Always queue" detail="Send after the current work is ready." selected={controls.delivery === 'queue'} onPress={() => { onUpdate({ delivery: 'queue' }); setPage('home'); }} />
          </> : null}
          {page === 'model' ? <>
            <Text style={s.sheetDescription}>The selected model is used for subsequent provider turns; existing work is not replayed.</Text>
            {modelsLoading ? <Text style={s.sheetDescription}>Loading available models…</Text> : null}
            {modelsError ? <Text accessibilityRole="alert" style={s.danger}>{modelsError}</Text> : null}
            {!modelsLoading && !modelsError && !models.length ? <Text style={s.sheetDescription}>This server did not report an available model.</Text> : null}
            {models.map(model => <ChoiceRow key={`${model.providerID}\u0000${model.id}`} label={model.name} detail={`${model.providerID} · ${model.id}${model.variants.length ? ` · ${model.variants.length} variant${model.variants.length === 1 ? '' : 's'}` : ''}`} selected={session.modelRef?.providerID === model.providerID && session.modelRef.id === model.id}
              disabled={switchingModel} onPress={() => { if (model.variants.length) { setSelectedModel(model); setPage('variant'); } else void chooseModel(model); }} />)}
          </> : null}
          {page === 'variant' && selectedModel ? <>
            <Text style={s.sheetDescription}>Choose a variant for {selectedModel.name}.</Text>
            {modelsError ? <Text accessibilityRole="alert" style={s.danger}>{modelsError}</Text> : null}
            <ChoiceRow label="Default" detail="Use this model without a variant." selected={session.modelRef?.providerID === selectedModel.providerID && session.modelRef.id === selectedModel.id && !session.modelRef.variant} disabled={switchingModel} onPress={() => void chooseModel(selectedModel)} />
            {selectedModel.variants.map(variant => <ChoiceRow key={variant.id} label={variant.id} detail={`${selectedModel.providerID} · ${selectedModel.id}`} selected={session.modelRef?.providerID === selectedModel.providerID && session.modelRef.id === selectedModel.id && session.modelRef.variant === variant.id} disabled={switchingModel} onPress={() => void chooseModel(selectedModel, variant.id)} />)}
          </> : null}
          {page === 'details' ? <SheetSection title="Session"><DetailRow label="Server" value={session.server} /><DetailRow label="Directory" value={session.directory ?? 'Not reported'} /><DetailRow label="Session ID" value={session.remoteId ?? session.id} selectable /><DetailRow label="State" value={`${running ? 'Running' : session.status === 'unknown' ? 'Unknown' : 'Idle'} · ${session.freshness}`} /><DetailRow label="Workers" value={session.activeWorkerCount ? `${session.activeWorkerCount} active` : String(session.workers.length)} /></SheetSection> : null}
          {page === 'confirm-stop' ? <><Text style={s.sheetDescription}>Interrupt this session? Workers may continue and completed changes are not reverted.</Text><View style={s.sheetActions}><Button label="Cancel" variant="secondary" onPress={() => setPage('home')} /><Button label="Stop session" variant="danger" icon="stop" onPress={onInterrupt} /></View></> : null}
        </ScrollView>
      </View>
    </View>
  </Modal>;
}

function SheetSection({ title, children }: { title: string; children: React.ReactNode }) { const s = useStyles(); return <View><SectionTitle title={title} /><Group>{children}</Group></View>; }
function ControlRow({ label, value, onPress, disabled, danger = false }: { label: string; value?: string; onPress?: () => void; disabled?: boolean; danger?: boolean }) {
  const c = usePalette(); const s = useStyles(); const body = <><Text style={[s.rowTitle, danger && { color: c.danger }]}>{label}</Text><View style={s.spacer} />{value ? <Text numberOfLines={1} style={s.rowValue}>{value}</Text> : null}{onPress ? <Icon name="chevron" size={16} color={c.faint} /> : null}</>;
  return onPress ? <AccessiblePressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [s.row, disabled && s.disabled, pressed && s.pressed]}>{body}</AccessiblePressable> : <View style={s.row}>{body}</View>;
}
function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) { const s = useStyles(); return <View style={s.row}><Text style={s.rowTitle}>{label}</Text><View style={s.spacer} /><Toggle label={label} value={value} onValueChange={onChange} /></View>; }
function ChoiceRow({ label, detail, selected, onPress, disabled = false }: { label: string; detail: string; selected: boolean; onPress: () => void; disabled?: boolean }) { const c = usePalette(); const s = useStyles(); return <AccessiblePressable accessibilityRole="radio" accessibilityState={{ selected, disabled }} accessibilityLabel={`${label}. ${detail}`} disabled={disabled} onPress={onPress} style={({ pressed }) => [s.choice, disabled && s.disabled, pressed && s.pressed]}><View style={s.flex}><Text style={s.rowTitle}>{label}</Text><Text style={s.faint}>{detail}</Text></View>{selected ? <Icon name="check" size={18} color={c.success} /> : null}</AccessiblePressable>; }
function DetailRow({ label, value, selectable = false }: { label: string; value: string; selectable?: boolean }) { const s = useStyles(); return <View style={s.detailRow}><Text style={s.detailLabel}>{label}</Text><Text selectable={selectable} style={s.detailValue}>{value}</Text></View>; }

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
function deliveryLabel(delivery: PromptDeliveryPreference, running: boolean) { return delivery === 'automatic' ? `Automatic · ${running ? 'steer' : 'queue'}` : delivery === 'steer' ? 'Always steer' : 'Always queue'; }
function modelLabel(model: SessionModelRef) { return `${model.providerID}/${model.id}${model.variant ? ` (${model.variant})` : ''}`; }
function formResolutionText(status: FormResolution) {
  if (status === 'answered') return 'Form answered';
  if (status === 'cancelled') return 'Form was cancelled elsewhere · not replayed';
  if (status === 'pending') return 'Form still pending · not resubmitted';
  return 'Form state unconfirmed · not resubmitted';
}

const useStyles = makeStyles(c => ({
  flex: { flex: 1 },
  spacer: { flex: 1 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
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
  composerBar: { flexShrink: 0, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.bg, paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.sm },
  composer: { gap: space.xs },
  feedback: { ...type.caption, marginBottom: 2 },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  input: { flex: 1, minHeight: 44, maxHeight: 140, backgroundColor: c.surfaceAlt, borderRadius: 20, paddingHorizontal: space.lg, paddingTop: 12, paddingBottom: 12, color: c.text, fontSize: Platform.OS === 'web' ? 16 : 15, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } as object : {}) },
  round: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  scrollLatest: { position: 'absolute', right: space.lg, zIndex: 5 },
  floatingHeader: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, paddingHorizontal: space.lg, backgroundColor: c.bg, borderBottomWidth: 1, borderBottomColor: c.border },
  compactHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 56 },
  floatingTitle: { ...type.small, fontWeight: '600', color: c.text, flexShrink: 1, maxWidth: '68%' },
  rowValue: { ...type.small, color: c.faint, maxWidth: '52%', textAlign: 'right' },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { maxHeight: '92%', minHeight: '55%', backgroundColor: c.bg, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, borderWidth: 1, borderBottomWidth: 0, borderColor: c.border, overflow: 'hidden' },
  sheetHeader: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.sm, borderBottomWidth: 1, borderBottomColor: c.border },
  sheetHeaderButton: { width: 40, height: 40 },
  sheetTitle: { ...type.heading, color: c.text },
  sheetContent: { padding: space.lg, paddingBottom: space.xxl, gap: space.md },
  sheetIntro: { gap: 2, marginBottom: space.xs },
  sheetNote: { ...type.caption, color: c.faint, textAlign: 'center', marginTop: space.md },
  sheetDescription: { ...type.small, color: c.muted, marginBottom: space.sm },
  sheetActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm, marginTop: space.md },
  choice: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 68, paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: c.surface, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, marginBottom: space.sm },
  detailRow: { gap: 3, paddingHorizontal: space.lg, paddingVertical: space.md },
  detailLabel: { ...type.caption, color: c.faint },
  detailValue: { ...type.small, color: c.text },
}));
