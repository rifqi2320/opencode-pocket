import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Platform, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { fetch as expoFetch } from 'expo/fetch';
import * as Notifications from 'expo-notifications';
import { usePocket as useCorePocket, type PushTarget } from './src/core';
import { authHeaders } from './src/core/client';
import { classifyRelationship, executionStatus, familyActivity, rollupFamilyRows, sessionFreshness } from './src/core/status';
import type { PendingForm, PendingPermission, ServerSnapshot, SessionMessage, SessionRecord, SessionSnapshot } from './src/core/types';
import { SessionsScreen } from './src/ui/SessionsScreen';
import { SessionDetailScreen } from './src/ui/SessionDetailScreen';
import { ServersScreen } from './src/ui/ServersScreen';
import { makeStyles, type as typeScale, usePalette } from './src/ui/theme';
import { AccessiblePressable, Icon, type IconName } from './src/ui/components';
import { actionableRequests } from './src/ui/behavior';
import type { Attention, PocketServer, PocketSession } from './src/ui/types';
import type { FormAnswers } from './src/ui/forms';
import { parseFormFields } from './src/ui/forms';
import { buildTurns } from './src/ui/turns';

type Route = { screen: 'sessions' | 'servers' } | { screen: 'detail'; key: string };
type AppSession = PocketSession & { serverId: string; remoteId: string };

/** The UI consumes a small view projection; the core remains the owner of live state and mutations. */
export function usePocket() {
  const state = useCorePocket();
  const servers: PocketServer[] = state.servers.map(snapshot => projectServer(snapshot));
  const sessions: AppSession[] = useMemo(() => projectSessions(state.servers, state.sessions), [state.servers, state.sessions]);
  // Search results come from the full server history, outside the recent-window inventory; project them the same way.
  const [searchRecords, setSearchRecords] = useState<Record<string, SessionRecord[]>>({});
  const searched: AppSession[] = useMemo(() => projectSessions(state.servers.map(snapshot => ({ ...snapshot, sessions: { data: searchRecords[snapshot.profile.id] ?? [], freshness: 'fresh' as const } })), state.sessions), [state.servers, state.sessions, searchRecords]);
  const findSession = (key: string) => sessions.find(session => session.id === key) ?? searched.find(session => session.id === key);
  return { ...state, servers, sessions, searched, setSearchRecords, findSession };
}

export default function App() {
  if (__DEV__ && Platform.OS === 'web' && typeof location !== 'undefined' && location.hash.startsWith('#preview')) {
    const { Preview } = require('./src/ui/Preview') as typeof import('./src/ui/Preview');
    return <SafeAreaProvider><Preview /></SafeAreaProvider>;
  }
  return <SafeAreaProvider><Shell /></SafeAreaProvider>;
}

function Shell() {
  const pocket = usePocket();
  const c = usePalette(); const s = useStyles();
  const [route, setRoute] = useState<Route>({ screen: 'sessions' });
  const [busyId, setBusyId] = useState<string>();
  const formReplyLocks = useRef(new Set<string>());
  const selected = route.screen === 'detail' ? pocket.findSession(route.key) : undefined;
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchedFor, setSearchedFor] = useState('');
  useEffect(() => {
    const text = query.trim();
    if (!text) { setSearching(false); setSearchedFor(''); return; }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      void pocket.searchSessions(text).then(records => { if (!cancelled) { pocket.setSearchRecords(records); setSearchedFor(text); } }).catch(() => undefined).finally(() => { if (!cancelled) setSearching(false); });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const title = route.screen === 'detail' ? selected?.title || 'Session' : route.screen === 'servers' ? 'Servers' : 'Sessions';
    document.title = `Pocket Control — ${title}`;
    const frame = requestAnimationFrame(() => document.getElementById('page-title')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [route.screen, route.screen === 'detail' ? route.key : '', selected?.title]);
  const openSession = (key: string) => {
    const target = pocket.findSession(key);
    if (!target) return;
    setRoute({ screen: 'detail', key });
    void pocket.selectSession(target.serverId, target.remoteId).catch(() => undefined);
  };
  // Foreground banners are suppressed only for the session that is on screen.
  const viewingKey = route.screen === 'detail' ? route.key : undefined;
  useEffect(() => { pocket.setViewingSession(viewingKey); }, [viewingKey]);
  // Notification taps (warm and cold start): refresh first, then open the exact session even if it is not listed yet.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const handled = new Set<string>();
    const open = (target: PushTarget) => {
      void pocket.refresh(target.serverId).catch(() => undefined);
      if (!target.sessionId || !target.sessionKey) { setRoute({ screen: target.kind === 'test' ? 'servers' : 'sessions' }); return; }
      setRoute({ screen: 'detail', key: target.sessionKey });
      void pocket.selectSession(target.serverId, target.sessionId).catch(() => undefined);
    };
    const handle = (response: Notifications.NotificationResponse | null) => {
      if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      const id = response.notification.request.identifier;
      if (handled.has(id)) return; handled.add(id);
      void pocket.resolveNotificationTap(response.notification.request).then(target => { if (target) open(target); }).catch(() => undefined);
      void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
    };
    const subscription = Notifications.addNotificationResponseReceivedListener(handle);
    void Notifications.getLastNotificationResponseAsync().then(handle).catch(() => undefined);
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (route.screen === 'sessions') return false;
      setRoute({ screen: 'sessions' }); return true;
    });
    return () => subscription.remove();
  }, [route.screen]);
  const saveServer = async (name: string, url: string, password: string) => {
    await pocket.testConnection({ name, url }, password);
    await pocket.saveServer({ name, url }, password);
  };
  const testServer = async (server: PocketServer) => {
    setBusyId(server.id);
    try {
      const profile = pocket.profiles.find(value => value.id === server.id);
      if (!profile) throw new Error('Server profile no longer exists');
      const password = await pocket.core.getPassword(server.id);
      await pocket.testConnection(profile, password);
      await pocket.refresh(server.id);
    } catch (error) {
      // Preserve cached state but refresh its freshness/error evidence for the diagnostics UI.
      await pocket.refresh(server.id).catch(() => undefined);
      throw error;
    } finally { setBusyId(undefined); }
  };
  const updateServer = async (id: string, name: string, url: string, password?: string) => {
    const secret = password ?? await pocket.core.getPassword(id).catch(() => '');
    await pocket.testConnection({ name, url }, secret);
    await pocket.updateServer(id, { name, url }, password);
  };
  const replyToForm = async (formId: string, answers: FormAnswers): Promise<'answered' | 'cancelled' | 'pending' | 'unknown'> => {
    if (!selected) throw new Error('Session unavailable. No answer was sent.');
    const destination = { serverId: selected.serverId, sessionId: selected.remoteId, formId };
    const request = selected.forms.find(form => form.id === formId);
    if (!request || request.sessionID !== destination.sessionId) throw new Error('This form no longer belongs to the selected session. Refresh before replying.');
    const lockKey = `${destination.serverId}\u0000${destination.sessionId}\u0000${destination.formId}`;
    if (formReplyLocks.current.has(lockKey)) throw new Error('A reply for this exact form is already in progress.');
    formReplyLocks.current.add(lockKey);
    try {
      const before = await readFormDetail(pocket, destination.serverId, destination.sessionId, destination.formId);
      if (before.state.status !== 'pending') {
        await reconcileSelectedForm(pocket, destination.serverId, destination.sessionId);
        return before.state.status;
      }
      await pocket.replyForm(destination.serverId, destination.sessionId, destination.formId, answers);
      // 204 acknowledges a reply request, not resolution; refresh server and the same selected
      // session only if the user has not navigated to a different destination while awaiting it.
      await pocket.refresh(destination.serverId).catch(() => undefined);
      if (pocket.selectedKey === `${destination.serverId}\u0000${destination.sessionId}`) await pocket.selectSession(destination.serverId, destination.sessionId).catch(() => undefined);
      try { return (await readFormDetail(pocket, destination.serverId, destination.sessionId, destination.formId)).state.status; }
      catch { return 'unknown'; }
    } finally { formReplyLocks.current.delete(lockKey); }
  };

  const needsCount = pocket.sessions.filter(session => !session.isWorker && actionableRequests(session).length > 0).length;
  const tabs: Array<{ key: 'sessions' | 'servers'; label: string; icon: IconName; badge?: number }> = [{ key: 'sessions', label: 'Sessions', icon: 'inbox', badge: needsCount }, { key: 'servers', label: 'Servers', icon: 'server' }];
  return <SafeAreaView style={s.safe} edges={route.screen === 'detail' ? ['top', 'bottom', 'left', 'right'] : ['top', 'left', 'right']}>
    <StatusBar style={c.scheme === 'dark' ? 'light' : 'dark'} />
    <View style={s.fill}>
      {route.screen === 'sessions' ? <SessionsScreen sessions={pocket.sessions} servers={pocket.servers} onOpen={openSession} onServers={() => setRoute({ screen: 'servers' })} onRefresh={() => void pocket.refresh().catch(() => undefined)} refreshing={pocket.servers.some(server => server.state === 'connecting')}
        query={query} onQuery={setQuery} searching={searching} {...(searchedFor ? { results: pocket.searched } : {})} /> : null}
      {route.screen === 'servers' ? <ServersScreen servers={pocket.servers} onSave={saveServer} onUpdate={updateServer} onTest={testServer} busyId={busyId} onRemove={id => pocket.removeServer(id)}
        notifications={pocket.notifications}
        onNotificationsToggle={(id, on) => on ? pocket.enableNotifications(id) : pocket.disableNotifications(id)}
        onNotificationPreference={(id, key, value) => pocket.setNotificationPreferences(id, { [key]: value })}
        onNotificationTest={id => pocket.sendTestNotification(id)} /> : null}
      {route.screen === 'detail' ? <SessionDetailScreen session={selected} onBack={() => setRoute({ screen: 'sessions' })}
        onSend={async (text, delivery) => { if (!selected) throw new Error('Session unavailable'); return pocket.sendPrompt(selected.serverId, selected.remoteId, text, delivery); }}
        onInterrupt={async () => { if (!selected) throw new Error('Session unavailable'); return pocket.interrupt(selected.serverId, selected.remoteId); }}
        onOpenWorker={openSession}
        onLoadEarlier={async () => { if (!selected) return; await pocket.loadMoreMessages(selected.serverId, selected.remoteId); }}
        onReplyForm={replyToForm}
        onReply={async (attentionId, answer) => { if (!selected) throw new Error('Session unavailable'); await pocket.replyPermission(selected.serverId, selected.remoteId, attentionId, answer === 'allow' ? 'once' : 'reject'); }} /> : null}
    </View>
    {route.screen !== 'detail' ? <SafeAreaView edges={['bottom']} style={s.nav} accessibilityRole="tablist">
      {tabs.map(item => {
        const active = route.screen === item.key;
        return <AccessiblePressable key={item.key} testID={`nav_${item.key}`} accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={`${item.label}${item.badge ? `, ${item.badge} need you` : ''}`} onPress={() => setRoute({ screen: item.key })} style={s.navButton}>
          <View><Icon name={item.icon} size={22} color={active ? c.text : c.faint} strokeWidth={active ? 2 : 1.7} />{item.badge ? <View style={s.navBadge}><Text style={s.navBadgeText}>{item.badge > 9 ? '9+' : item.badge}</Text></View> : null}</View>
          <Text style={[s.navLabel, active && { color: c.text }]}>{item.label}</Text>
        </AccessiblePressable>;
      })}
    </SafeAreaView> : null}
  </SafeAreaView>;
}

function projectServer(snapshot: ServerSnapshot): PocketServer {
  const transport = snapshot.transport;
  const infoError = snapshot.info.error;
  const serverState: PocketServer['state'] = infoError?.kind === 'auth' || transport === 'auth-error' ? 'auth-error'
    : infoError?.kind === 'incompatible' ? 'incompatible'
      : infoError ? (snapshot.info.data ? 'stale' : infoError.kind === 'network' ? 'offline' : 'error')
        : transport === 'offline' ? 'offline'
          : transport === 'reconnecting' && snapshot.info.data ? 'stale'
            : snapshot.info.data ? 'connected' : transport === 'connecting' || transport === 'reconnecting' ? 'connecting' : 'unverified';
  const info = snapshot.info.data;
  return { id: snapshot.profile.id, name: snapshot.profile.name, url: snapshot.profile.url, state: serverState,
    ...(info?.version ? { version: `OpenCode ${String(info.version)}` } : {}), transport: transport === 'live' ? 'Live event stream' : transport === 'polling' ? 'Polling' : `Transport ${transport}`,
    ...(snapshot.lastSyncAt ? { lastSync: new Date(snapshot.lastSyncAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) } : {}),
    coverage: `${snapshot.coverage.sessions} sessions · ${snapshot.coverage.blockers} blockers`, ...(snapshot.info.error ? { error: snapshot.info.error.message } : {}) };
}

function projectSessions(serverSnapshots: ServerSnapshot[], sessionSnapshots: SessionSnapshot[]): AppSession[] {
  const result: AppSession[] = [];
  for (const server of serverSnapshots) {
    const records = server.sessions.data ?? [];
    const sessions = sessionSnapshots.filter(item => item.serverId === server.profile.id);
    const snapshotById = new Map(sessions.map(item => [item.sessionId, item]));
    const activeFresh = server.activeSessionIds.freshness === 'fresh' && server.activeSessionIds.data !== undefined;
    const activeIds = activeFresh ? server.activeSessionIds.data : undefined;
    const permissions = uniqueBySessionId<PendingPermission>([
      ...(server.permissions.data ?? []),
      ...sessions.flatMap(item => (item.permissions.data ?? []).map(row => ({ ...row, sessionID: row.sessionID || item.sessionId }))),
    ]);
    const forms = uniqueBySessionId<PendingForm>([
      ...(server.forms.data ?? []),
      ...sessions.flatMap(item => (item.forms.data ?? []).map(row => ({ ...row, sessionID: row.sessionID || item.sessionId }))),
    ]);
    for (const record of records) {
      // Subagent sessions never become home cards: they render beneath their root (the core fetches parents
      // outside the recent window). Forks and unclassified relationships remain independent.
      const parentKnown = records.some(parent => parent.id === record.parentID);
      const parentFailed = !parentKnown && !!record.parentID && !!snapshotById.get(record.parentID)?.metadata.error;
      // If the parent cannot be loaded, keep the worker visible on its own so its requests are never hidden.
      const isWorker = classifyRelationship(record) === 'subagent' && !parentFailed;
      const detail = snapshotById.get(record.id);
      const permissionRows: PendingPermission[] = [...permissions.filter(item => item.sessionID === record.id), ...(detail?.permissions.data ?? []).map(item => ({ ...item, sessionID: item.sessionID || record.id }))];
      const formRows: PendingForm[] = [...forms.filter(item => item.sessionID === record.id), ...(detail?.forms.data ?? []).map(item => ({ ...item, sessionID: item.sessionID || record.id }))];
      const attention: Attention[] = [
        ...uniqueById(permissionRows).map(item => ({ id: item.id, ownerSessionKey: `${server.profile.id}\u0000${record.id}`, kind: 'permission' as const, label: permissionLabel(item) })),
        ...uniqueById(formRows).map(item => {
          const supported = parseFormFields(item.fields).supported;
          return { id: item.id, ownerSessionKey: `${server.profile.id}\u0000${record.id}`, kind: supported ? 'form' as const : 'unsupported' as const, label: formLabel(item, !supported) };
        }),
      ];
      const formRequests = uniqueById(formRows).map(item => ({ id: item.id, sessionID: item.sessionID, title: typeof item.title === 'string' ? item.title : 'Question', fields: Array.isArray(item.fields) ? item.fields : [] }));
      const active = activeIds === undefined ? undefined : activeIds.includes(record.id);
      const status = executionStatus({ active, observedAt: server.activeSessionIds.observedAt, freshness: server.activeSessionIds.freshness }).value;
      const family = familyActivity({ records, parentId: record.id, serverId: server.profile.id, activeSessionIds: activeIds, activeFreshness: server.activeSessionIds.freshness, sessionsCoverage: server.coverage.sessions });
      const workerRows = family.descendants.map(({ session: child, depth }) => ({
        id: child.id,
        title: sessionTitle(child),
        status: activeIds === undefined ? 'activity unknown' : activeIds.includes(child.id) ? 'working' : 'inactive',
        relation: 'subagent',
        depth,
        needsYou: [...permissions, ...forms].some(item => item.sessionID === child.id),
        sessionKey: `${server.profile.id}\u0000${child.id}`,
      }));
       const myMessages = detail?.messages.data ?? [];
       const failure = sessionFailure(record, myMessages) ? 'Failure reported in session activity' : undefined;
      const freshness = sessionFreshness({ transport: server.transport, hasInventory: server.sessions.data !== undefined, inventoryFreshness: server.sessions.freshness, activeFreshness: server.activeSessionIds.freshness, infoFailed: !!server.info.error, messagesLoaded: detail?.messages.data !== undefined, messagesFreshness: detail?.messages.freshness });
      const messages = buildTurns(myMessages);
      const id = `${server.profile.id}\u0000${record.id}`;
      const rolledUpAttention = [...attention];
      const familyPermissionRows = rollupFamilyRows({ records, parentId: record.id, serverId: server.profile.id, rows: permissions }).filter(item => item.ownerSessionId !== record.id);
      const familyFormRows = rollupFamilyRows({ records, parentId: record.id, serverId: server.profile.id, rows: forms }).filter(item => item.ownerSessionId !== record.id);
      for (const { row, ownerSessionId } of familyPermissionRows) {
        const child = records.find(candidate => candidate.id === ownerSessionId);
        rolledUpAttention.push({ id: row.id, ownerSessionKey: `${server.profile.id}\u0000${ownerSessionId}`, kind: 'permission', label: `${child ? sessionTitle(child) : 'Worker'} · ${permissionLabel(row)}` });
      }
      for (const { row, ownerSessionId } of familyFormRows) {
        const child = records.find(candidate => candidate.id === ownerSessionId);
        rolledUpAttention.push({ id: row.id, ownerSessionKey: `${server.profile.id}\u0000${ownerSessionId}`, kind: 'form', label: `${child ? sessionTitle(child) : 'Worker'} · ${formLabel(row)}` });
      }
      const familyCoverage = server.coverage.sessions === 'complete' && server.coverage.blockers === 'complete' && activeFresh ? 'complete' : server.coverage.sessions === 'unknown' || !server.activeSessionIds.data ? 'unknown' : 'partial';
       result.push({ id, serverId: server.profile.id, remoteId: record.id, server: server.profile.name, project: directoryName(record.directory), title: sessionTitle(record), status, isWorker, ...(failure ? { failure } : {}),
        familyStatus: family.status, activeWorkerCount: family.activeWorkerCount, familyCoverage,
        summary: status === 'running' ? 'Session is active' : status === 'inactive' ? 'No active execution observed' : 'Execution status not confirmed',
        lastSeen: server.activeSessionIds.observedAt ? relative(server.activeSessionIds.observedAt) : 'not observed', freshness, attention, forms: formRequests, rolledUpAttention, workers: workerRows, messages, ...(detail?.messageCursor ? { hasEarlier: true } : {}),
        ...(typeof record.agent === 'string' ? { agent: record.agent } : {}), ...(typeof record.model === 'string' ? { model: record.model } : {}),
        ...(detail?.inbox.data ? { pending: detail.inbox.data.length, pendingItems: detail.inbox.data.map((item, index) => ({ id: typeof item.id === 'string' ? item.id : `pending-${index}`, text: pendingText(item) })) } : {}), coverage: familyCoverage === 'complete' ? 'complete' : 'partial' });
    }
  }
  return result.sort((a, b) => Number((b.rolledUpAttention ?? b.attention).length > 0) - Number((a.rolledUpAttention ?? a.attention).length > 0) || Number(b.status === 'running' || b.familyStatus === 'working') - Number(a.status === 'running' || a.familyStatus === 'working'));
}

function sessionTitle(record: SessionRecord) { return typeof record.title === 'string' && record.title ? record.title : 'Untitled session'; }
function directoryName(value?: string) { if (!value) return 'Project not reported'; return value.split('/').filter(Boolean).at(-1) ?? value; }
function relative(timestamp: number) { const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000)); return seconds < 5 ? 'just now' : seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`; }
function uniqueById<T extends { id: string }>(rows: T[]) { return [...new Map(rows.map(row => [row.id, row])).values()]; }
function uniqueBySessionId<T extends { id: string; sessionID: string }>(rows: T[]) { return [...new Map(rows.map(row => [`${row.sessionID}\u0000${row.id}`, row])).values()]; }
function permissionLabel(item: Record<string, unknown>) {
  const permission = typeof item.permission === 'string' ? item.permission : 'action';
  const patterns = Array.isArray(item.patterns) ? item.patterns.filter((value): value is string => typeof value === 'string').slice(0, 3) : [];
  return `Permission · ${permission}${patterns.length ? ` · ${patterns.join(', ')}` : ''}`;
}
function formLabel(item: Record<string, unknown>, unsupported = false) { const title = typeof item.title === 'string' ? item.title : 'Question'; return unsupported ? `Answer in OpenCode · ${title}` : `Question · ${title}`; }
function sessionFailure(record: SessionRecord, messages: SessionMessage[]) {
  if (record.status === 'error' || record.state === 'error' || record.error) return true;
  return messages.some(message => message.role === 'error' || message.type === 'error' || message.state === 'error');
}
function pendingText(item: Record<string, unknown>) {
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  return 'Pending server input (content not exposed in this response).';
}
type FormStateStatus = 'pending' | 'answered' | 'cancelled';
async function readFormDetail(pocket: ReturnType<typeof usePocket>, serverId: string, sessionId: string, formId: string): Promise<{ state: { status: FormStateStatus } }> {
  const profile = pocket.profiles.find(candidate => candidate.id === serverId);
  if (!profile) throw new Error('The form’s server profile is unavailable. No answer was sent.');
  const password = await pocket.core.getPassword(serverId);
  const directory = pocket.core.getSession(serverId, sessionId)?.metadata.data?.directory;
  const query = new URLSearchParams(); if (directory) query.set('directory', directory);
  const path = `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}`;
  const response = await expoFetch(`${profile.url}${path}${query.size ? `?${query}` : ''}`, { method: 'GET', headers: { ...authHeaders(password), accept: 'application/json' }, redirect: 'error' } as RequestInit);
  if (!response.ok) throw new Error(`Could not verify this form’s current state (${response.status}); no answer was sent.`);
  const envelope: unknown = await response.json();
  const data = typeof envelope === 'object' && envelope !== null && 'data' in envelope ? (envelope as { data: unknown }).data : envelope;
  if (typeof data !== 'object' || data === null || !('state' in data) || typeof (data as { state: unknown }).state !== 'object' || (data as { state: object }).state === null || !('status' in (data as { state: object }).state)) throw new Error('The server did not return a verifiable form state. No answer was sent.');
  const status = (data as { state: { status?: unknown } }).state.status;
  if (status !== 'pending' && status !== 'answered' && status !== 'cancelled') throw new Error('The server returned an unsupported form state. No answer was sent.');
  return { state: { status } };
}
async function reconcileSelectedForm(pocket: ReturnType<typeof usePocket>, serverId: string, sessionId: string) {
  await pocket.refresh(serverId).catch(() => undefined);
  if (pocket.selectedKey === `${serverId}\u0000${sessionId}`) await pocket.selectSession(serverId, sessionId).catch(() => undefined);
}

const useStyles = makeStyles(c => ({
  safe: { flex: 1, backgroundColor: c.bg }, fill: { flex: 1 },
  nav: { flexDirection: 'row', backgroundColor: c.bg, borderTopWidth: 1, borderTopColor: c.border },
  navButton: { flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center', gap: 3, paddingTop: 6 },
  navLabel: { ...typeScale.caption, fontSize: 11, fontWeight: '500', color: c.faint },
  navBadge: { position: 'absolute', top: -4, right: -9, minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 4, backgroundColor: c.warning, alignItems: 'center', justifyContent: 'center' },
  navBadgeText: { fontSize: 10, fontWeight: '700', color: '#000' },
}));
