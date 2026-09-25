import React, { useRef, useState } from 'react';
import { Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { AccessiblePressable, Button, Card, EmptyState, Group, Header, Icon, IconButton, Notice, StatusDot, TextField, Toggle, toneColor, type Tone } from './components';
import { canConfirmSavedServerRemoval } from './behavior';
import { makeStyles, radius, space, type, usePalette } from './theme';
import type { NotificationPrefKey, PocketServer, PocketServerNotifications } from './types';

type Props = {
  servers: PocketServer[];
  onBack?: () => void;
  onSave: (name: string, url: string, credential: string) => Promise<void>;
  onUpdate: (id: string, name: string, url: string, credential?: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onTest: (server: PocketServer) => Promise<void>;
  busyId?: string;
  /** Omit to hide the notifications block (e.g. previews). */
  notifications?: { platform: string; servers: Record<string, PocketServerNotifications | undefined> };
  onNotificationsToggle?: (id: string, on: boolean) => Promise<void>;
  onNotificationPreference?: (id: string, key: NotificationPrefKey, value: boolean) => Promise<void>;
  onNotificationTest?: (id: string) => Promise<{ ok: boolean; error?: string }>;
};
type FormMode = { kind: 'add' } | { kind: 'edit'; id: string };
type Feedback = { text: string; tone: 'neutral' | 'danger' };

const STATUS: Record<PocketServer['state'], [string, Tone]> = {
  connected: ['Connected', 'success'],
  connecting: ['Checking', 'warning'],
  stale: ['Stale', 'warning'],
  unverified: ['Not tested', 'warning'],
  incompatible: ['Incompatible', 'warning'],
  offline: ['Offline', 'danger'],
  'auth-error': ['Auth error', 'danger'],
  error: ['Error', 'danger'],
};

/** Strips any URL from an error message so endpoints are never echoed back into UI copy. */
const scrub = (cause: unknown, fallback: string) => cause instanceof Error && cause.message ? cause.message.replace(/https?:\/\/\S+/g, '[server URL]') : fallback;

function validateUrl(value: string): string | undefined {
  if (!value.trim()) return 'Enter an HTTPS URL.';
  try {
    const endpoint = new URL(value.trim());
    if (endpoint.protocol !== 'https:') return 'Use an HTTPS URL.';
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return 'Remove credentials, query and fragment from the URL.';
  } catch { return 'Enter a complete HTTPS URL.'; }
  return undefined;
}

const focusWeb = (id: string) => { if (Platform.OS === 'web') requestAnimationFrame(() => document.getElementById(id)?.focus()); };

export function ServersScreen({ servers, onBack, onSave, onUpdate, onRemove, onTest, busyId, notifications, onNotificationsToggle, onNotificationPreference, onNotificationTest }: Props) {
  const c = usePalette(); const s = useStyles();
  const [form, setForm] = useState<FormMode>();
  const [name, setName] = useState(''); const [url, setUrl] = useState(''); const [credential, setCredential] = useState(''); const [reveal, setReveal] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; url?: string }>({}); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string>(); const [pendingRemoveId, setPendingRemoveId] = useState<string>(); const [feedback, setFeedback] = useState<Record<string, Feedback | undefined>>({});
  const nameRef = useRef<TextInput>(null); const urlRef = useRef<TextInput>(null);

  const openForm = (mode: FormMode) => {
    const server = mode.kind === 'edit' ? servers.find(item => item.id === mode.id) : undefined;
    setForm(mode); setName(server?.name ?? ''); setUrl(server?.url ?? ''); setCredential(''); setReveal(false); setFieldErrors({}); setError('');
    requestAnimationFrame(() => nameRef.current?.focus());
  };
  const closeForm = () => { setForm(undefined); setName(''); setUrl(''); setCredential(''); setReveal(false); setFieldErrors({}); setError(''); };
  const setServerFeedback = (id: string, value?: Feedback) => setFeedback(current => ({ ...current, [id]: value }));

  const submit = async () => {
    if (!form) return;
    setError('');
    const next = { name: name.trim() ? undefined : 'Enter a name.', url: validateUrl(url) };
    setFieldErrors(next);
    if (next.name || next.url) { (next.name ? nameRef.current : urlRef.current)?.focus(); return; }
    const cleanUrl = url.trim().replace(/\/$/, '');
    setSaving(true);
    try {
      if (form.kind === 'edit') await onUpdate(form.id, name.trim(), cleanUrl, credential ? credential : undefined);
      else await onSave(name.trim(), cleanUrl, credential);
      closeForm();
    } catch (cause) { setError(scrub(cause, 'Unable to connect. Check the address, certificate and password.')); }
    finally { setSaving(false); }
  };

  const test = async (server: PocketServer) => {
    setServerFeedback(server.id);
    try { await onTest(server); setServerFeedback(server.id, { text: 'Connection verified.', tone: 'neutral' }); }
    catch (cause) { setServerFeedback(server.id, { text: scrub(cause, 'Could not verify this connection.'), tone: 'danger' }); }
  };
  const askRemove = (id?: string) => {
    const previous = pendingRemoveId;
    setPendingRemoveId(id);
    focusWeb(id ? `remove-confirm-${id}` : `remove-server-${previous}`);
  };
  const confirmRemove = async (id: string) => {
    if (!canConfirmSavedServerRemoval(pendingRemoveId, id)) return;
    setServerFeedback(id);
    try { await onRemove(id); setPendingRemoveId(undefined); if (expandedId === id) setExpandedId(undefined); if (form?.kind === 'edit' && form.id === id) closeForm(); }
    catch { setServerFeedback(id, { text: 'Could not remove. Nothing on the server was changed.', tone: 'danger' }); }
  };
  const toggle = (id: string) => { setExpandedId(current => current === id ? undefined : id); if (pendingRemoveId && pendingRemoveId !== id) setPendingRemoveId(undefined); };

  const editing = form?.kind === 'edit';
  const formCard = form ? <Card style={s.form}>
    <Text accessibilityRole="header" {...({ 'aria-level': 2 } as Record<string, unknown>)} style={s.formTitle}>{editing ? 'Edit server' : 'Add server'}</Text>
    <TextField ref={nameRef} nativeID="server-name" errorId="server-name-error" label="Name" placeholder="Workstation" value={name} error={fieldErrors.name} autoCapitalize="words" returnKeyType="next"
      onChangeText={text => { setName(text); setFieldErrors(current => ({ ...current, name: undefined })); }} onSubmitEditing={() => urlRef.current?.focus()} />
    <TextField ref={urlRef} nativeID="server-url" errorId="server-url-error" label="URL" placeholder="https://opencode.example.com" value={url} error={fieldErrors.url} style={s.mono}
      autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="next" onChangeText={text => { setUrl(text); setFieldErrors(current => ({ ...current, url: undefined })); }} />
    <View>
      <TextField label="Password" optional value={credential} onChangeText={setCredential} secureTextEntry={!reveal} autoCapitalize="none" autoCorrect={false} style={s.passwordInput}
        placeholder={editing ? 'Unchanged' : undefined} onSubmitEditing={() => void submit()}
        hint={Platform.OS === 'web' ? "Saved in this browser's local storage." : 'Saved in the device keychain.'} />
      <Button label={reveal ? 'Hide' : 'Show'} accessibilityHint={reveal ? 'Hides the password' : 'Shows the password'} variant="ghost" size="sm" onPress={() => setReveal(value => !value)} style={s.reveal} />
    </View>
    {error ? <Notice tone="danger">{error}</Notice> : null}
    <View style={s.actions}>
      <Button testID="add_server_connect" label={saving ? 'Connecting…' : 'Connect'} loading={saving} onPress={() => void submit()} />
      <Button label="Cancel" variant="ghost" disabled={saving} onPress={closeForm} />
    </View>
  </Card> : null;

  return <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
    <Header title="Servers" onBack={onBack} right={<IconButton icon="plus" label="Add server" onPress={() => openForm({ kind: 'add' })} disabled={form?.kind === 'add'} />} />
    {form?.kind === 'add' ? formCard : null}
    {!servers.length && !form ? <EmptyState icon="server" title="No servers yet" body="Connect to an OpenCode server you already run." action={<Button label="Add server" icon="plus" onPress={() => openForm({ kind: 'add' })} />} /> : null}
    {servers.length ? <Group testID="servers_list" style={s.list}>
      {servers.map(server => {
        const [label, tone] = STATUS[server.state];
        const open = expandedId === server.id; const confirming = pendingRemoveId === server.id; const note = feedback[server.id];
        return <View key={server.id} testID={`server_${server.id}`}>
          <AccessiblePressable accessibilityRole="button" accessibilityLabel={`${server.name}, ${label}`} accessibilityState={{ expanded: open }} onPress={() => toggle(server.id)} style={({ pressed }) => [s.row, pressed && s.pressed]}>
            <StatusDot tone={tone} />
            <View style={s.rowText}>
              <Text numberOfLines={1} style={s.name}>{server.name}</Text>
              <Text numberOfLines={1} style={s.url}>{server.url}</Text>
            </View>
            <Text style={[s.stateLabel, { color: tone === 'success' ? c.muted : c.faint }]}>{label}</Text>
            <Icon name={open ? 'down' : 'chevron'} size={16} color={c.faint} />
          </AccessiblePressable>
          {open ? <View style={s.detail}>
            {server.error ? <Notice tone="danger">{server.error}</Notice> : null}
            <View style={s.facts}>
              {([['Version', server.version], ['Transport', server.transport], ['Last sync', server.lastSync], ['Coverage', server.coverage]] as const).map(([key, value]) =>
                <View key={key} style={s.fact}><Text style={s.factKey}>{key}</Text><Text numberOfLines={1} style={s.factValue}>{value || '—'}</Text></View>)}
            </View>
            {notifications && notifications.platform !== 'web' ? <NotificationsBlock serverId={server.id} platform={notifications.platform} value={notifications.servers[server.id]}
              onToggle={onNotificationsToggle} onPreference={onNotificationPreference} onTest={onNotificationTest} /> : null}
            {editing && form.id === server.id ? formCard : confirming ? <View style={s.confirm}>
              <Text nativeID={`remove-confirm-${server.id}`} {...({ tabIndex: -1 } as Record<string, unknown>)} accessible style={s.confirmText}>Removes it from this device only. Work on the server is untouched.</Text>
              <View style={s.actions}>
                <Button testID="confirm_remove_server" label="Remove" variant="danger" size="sm" disabled={!!busyId} onPress={() => void confirmRemove(server.id)} />
                <Button label="Cancel" variant="ghost" size="sm" onPress={() => askRemove(undefined)} />
              </View>
            </View> : <View style={s.actions}>
              <Button label="Test connection" variant="secondary" size="sm" loading={busyId === server.id} disabled={!!busyId} onPress={() => void test(server)} />
              <Button label="Edit" variant="ghost" size="sm" onPress={() => { setPendingRemoveId(undefined); openForm({ kind: 'edit', id: server.id }); }} />
              <AccessiblePressable nativeID={`remove-server-${server.id}`} accessibilityRole="button" accessibilityLabel={`Remove ${server.name}`} accessibilityState={{ disabled: !!busyId }} disabled={!!busyId} onPress={() => askRemove(server.id)}
                style={({ pressed }) => [s.removeTrigger, !!busyId && s.disabled, pressed && s.pressedText]}><Text style={s.removeText}>Remove</Text></AccessiblePressable>
            </View>}
            {note?.text ? <Text {...({ role: note.tone === 'danger' ? 'alert' : 'status', 'aria-live': note.tone === 'danger' ? 'assertive' : 'polite' } as Record<string, unknown>)} accessibilityLiveRegion={note.tone === 'danger' ? 'assertive' : 'polite'} style={[s.feedback, note.tone === 'danger' && { color: c.danger }]}>{note.text}</Text> : null}
          </View> : null}
        </View>;
      })}
    </Group> : null}
  </ScrollView>;
}

const PREFS: ReadonlyArray<readonly [NotificationPrefKey, string]> = [['needsPermission', 'Permission requests'], ['needsAnswer', 'Questions'], ['sessionFailed', 'Failures'], ['sessionFinished', 'Finished sessions'], ['hideDetails', 'Hide details on lock screen']];

function NotificationsBlock({ serverId, platform, value, onToggle, onPreference, onTest }: { serverId: string; platform: string; value?: PocketServerNotifications; onToggle?: Props['onNotificationsToggle']; onPreference?: Props['onNotificationPreference']; onTest?: Props['onNotificationTest'] }) {
  const c = usePalette(); const s = useStyles();
  const [note, setNote] = useState<Feedback>(); const [testing, setTesting] = useState(false);
  const android = platform === 'android';
  const enabled = value?.enabled === true; const busy = value?.busy === true;
  const status = value?.status ?? { label: android ? 'Checking plugin…' : 'Android only for now', tone: 'neutral' as const, canToggle: false };
  const run = async (work: () => Promise<void>, fallback: string) => { setNote(undefined); try { await work(); } catch (cause) { setNote({ text: scrub(cause, fallback), tone: 'danger' }); } };
  const test = async () => {
    if (!onTest) return;
    setNote(undefined); setTesting(true);
    try { const result = await onTest(serverId); setNote(result.ok ? { text: 'Test sent. It should arrive in a few seconds.', tone: 'neutral' } : { text: result.error || 'Test failed.', tone: 'danger' }); }
    catch (cause) { setNote({ text: scrub(cause, 'Test failed.'), tone: 'danger' }); }
    finally { setTesting(false); }
  };
  return <View style={s.notify} testID={`notifications_${serverId}`}>
    <View style={s.notifyRow}>
      <View style={s.rowText}>
        <Text style={s.notifyTitle}>Notifications</Text>
        <Text style={[s.notifyCaption, status.tone !== 'neutral' && status.tone !== 'success' && { color: toneColor(c, status.tone) }]}>{status.label}</Text>
      </View>
      {android ? <Toggle testID={`notifications_toggle_${serverId}`} label="Notifications" value={enabled} disabled={busy || (!enabled && !status.canToggle) || !onToggle}
        onValueChange={next => void run(() => onToggle!(serverId, next), next ? 'Could not turn on notifications.' : 'Could not turn off notifications.')} /> : null}
    </View>
    {android && enabled ? <>
      <View style={s.prefs}>
        {PREFS.map(([key, label]) => <View key={key} style={s.prefRow}>
          <Text style={s.prefLabel}>{label}</Text>
          <Toggle label={label} value={value?.preferences[key] === true} disabled={busy || !onPreference} onValueChange={next => void run(() => onPreference!(serverId, key, next), 'Could not save this preference.')} />
        </View>)}
      </View>
      {onTest ? <View style={s.actions}><Button label="Send test" variant="secondary" size="sm" loading={testing} disabled={busy && !testing} onPress={() => void test()} /></View> : null}
    </> : null}
    {note ? <Text {...({ role: note.tone === 'danger' ? 'alert' : 'status' } as Record<string, unknown>)} accessibilityLiveRegion="polite" style={[s.feedback, note.tone === 'danger' && { color: c.danger }]}>{note.text}</Text> : null}
  </View>;
}

const useStyles = makeStyles(c => ({
  page: { width: '100%', maxWidth: 640, alignSelf: 'center', paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: 32, gap: space.lg, backgroundColor: c.bg, flexGrow: 1 },
  list: { marginTop: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 60, paddingHorizontal: space.lg, paddingVertical: space.md },
  pressed: { backgroundColor: c.surfaceAlt },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontSize: 15, lineHeight: 20, fontWeight: '500', color: c.text },
  url: { ...type.mono, fontSize: 12, color: c.faint },
  stateLabel: { ...type.caption, fontWeight: '500' },
  detail: { paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.md },
  facts: { backgroundColor: c.bg, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, paddingHorizontal: space.md, paddingVertical: space.sm, gap: 2 },
  fact: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md, paddingVertical: 3 },
  factKey: { ...type.caption, color: c.faint },
  factValue: { ...type.mono, fontSize: 12, lineHeight: 16, color: c.muted, flexShrink: 1, textAlign: 'right' },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm },
  removeTrigger: { marginLeft: 'auto', minHeight: 36, paddingHorizontal: space.md, borderRadius: radius.sm + 2, justifyContent: 'center' },
  removeText: { fontSize: 13, fontWeight: '600', color: c.danger },
  disabled: { opacity: 0.4 },
  pressedText: { opacity: 0.7 },
  passwordInput: { paddingRight: 72 },
  confirm: { gap: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: c.dangerSoft },
  confirmText: { ...type.small, color: c.text },
  feedback: { ...type.caption, color: c.muted },
  notify: { borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg, paddingHorizontal: space.md, paddingVertical: space.sm, gap: space.sm },
  notifyRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 36 },
  notifyTitle: { ...type.small, fontWeight: '500', color: c.text },
  notifyCaption: { ...type.caption, color: c.faint },
  prefs: { borderTopWidth: 1, borderTopColor: c.border, paddingTop: space.xs },
  prefRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, minHeight: 36 },
  prefLabel: { ...type.small, color: c.muted, flex: 1 },
  form: { gap: space.lg },
  formTitle: { ...type.heading, color: c.text },
  mono: { fontFamily: type.mono.fontFamily },
  reveal: { position: 'absolute', right: space.xs, top: 28, minHeight: 36 },
}));
