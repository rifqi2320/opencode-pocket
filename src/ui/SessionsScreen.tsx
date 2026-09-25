import React, { useState } from 'react';
import { ActivityIndicator, Platform, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { AccessiblePressable as Pressable, Button, Card, EmptyState, Group, Header, Icon, IconButton, Notice, SectionTitle, Segmented, StatusDot, TextField, type Tone } from './components';
import { actionableRequests, groupSessionsByProject, groupSessionSections, hasFailure, type ProjectGroup, type SessionFilter } from './behavior';
import { makeStyles, radius, space, type, usePalette } from './theme';
import type { PocketServer, PocketSession } from './types';

const problemStates: PocketServer['state'][] = ['offline', 'auth-error', 'incompatible', 'stale', 'error'];
export type SessionView = 'status' | 'project';
/** Opens the new-session form; `directory` pre-fills the folder when started from a project group. */
type NewSessionDraft = { serverId?: string; directory?: string };

const problemLabel: Partial<Record<PocketServer['state'], string>> = { offline: 'unreachable', 'auth-error': 'rejected the password', incompatible: 'is not a compatible OpenCode v2 server', stale: 'may be out of date', error: 'returned an error' };

export function SessionsScreen({ sessions, servers, onOpen, onServers, refreshing, onRefresh, query = '', onQuery, results, searching, view = 'status', onViewChange, onCreateSession, knownDirectories }: {
  sessions: PocketSession[]; servers: PocketServer[]; onOpen: (id: string) => void; onServers: () => void; refreshing?: boolean; onRefresh: () => void;
  /** Search spans all history on the server; the default list only covers the recent window. */
  query?: string; onQuery?: (query: string) => void; results?: PocketSession[]; searching?: boolean;
  /** `status` groups by what needs you; `project` groups per server + folder. */
  view?: SessionView; onViewChange?: (view: SessionView) => void;
  /** Creates a session and navigates to it. Rejects with a user-facing message (e.g. the folder does not exist). */
  onCreateSession?: (serverId: string, folder: string, title?: string) => Promise<void>;
  /** Folders the server already has sessions in, offered as quick picks. */
  knownDirectories?: (serverId: string) => string[];
}) {
  const c = usePalette(); const s = useStyles();
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [draft, setDraft] = useState<NewSessionDraft>();
  const multiServer = new Set(sessions.map(item => item.serverId ?? item.server)).size > 1 || servers.length > 1;
  const newSession = (next: NewSessionDraft = {}) => setDraft({ serverId: next.serverId ?? servers.find(server => server.state === 'connected')?.id ?? servers[0]?.id, ...(next.directory ? { directory: next.directory } : {}) });
  const projectGroups = view === 'project' ? groupSessionsByProject(sessions, filter) : [];
  const roots = sessions.filter(item => !item.isWorker);
  const all = groupSessionSections(sessions, 'all');
  const { needs, failures, working, unknown, recent } = groupSessionSections(sessions, filter);
  const problems = servers.filter(server => problemStates.includes(server.state));
  const connecting = servers.some(server => server.state === 'connecting');
  const nextRequest = needs.flatMap(session => actionableRequests(session).map(request => request.ownerSessionKey ?? session.id))[0];
  const sections: Array<[string, PocketSession[], React.ReactNode?]> = [
    ['Needs you', needs, nextRequest && needs.length > 1 ? <Pressable testID="next_request" accessibilityRole="button" accessibilityLabel="Open next request" onPress={() => onOpen(nextRequest)} hitSlop={8}><Text style={s.link}>Open next</Text></Pressable> : undefined],
    ['Failed', failures], ['Working', working], ['Status unknown', unknown], ['Recent', recent],
  ];

  return <ScrollView contentContainerStyle={s.page} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={c.muted} />}>
    <Header title="Sessions" right={servers.length ? <View style={s.headerActions}>
      {onCreateSession ? <IconButton testID="new_session" icon="plus" label="New session" onPress={() => newSession()} disabled={!!draft} /> : null}
      {refreshing ? <View style={s.spinner}><ActivityIndicator size="small" color={c.muted} /></View> : <IconButton icon="refresh" label="Refresh sessions" onPress={onRefresh} />}
    </View> : undefined} />
    {servers.length ? <Pressable accessibilityRole="button" accessibilityLabel="Manage servers" onPress={onServers} style={s.serverLine} hitSlop={6}>
      <StatusDot tone={problems.length ? 'danger' : connecting ? 'warning' : 'success'} size={6} />
      <Text style={s.serverLineText}>{servers.length} server{servers.length === 1 ? '' : 's'}{problems.length ? ` · ${problems.length} need${problems.length === 1 ? 's' : ''} attention` : connecting ? ' · connecting' : ''}</Text>
    </Pressable> : null}

    {problems.length ? <View style={s.notices}>{problems.map(server => <Notice key={server.id} tone={server.state === 'stale' ? 'warning' : 'danger'} title={`${server.name} ${problemLabel[server.state] ?? 'needs attention'}`}
      action={<Button size="sm" variant="secondary" label="Review" onPress={onServers} />}>{server.error}</Notice>)}</View> : null}

    {draft && onCreateSession ? <NewSessionForm key={`${draft.serverId}\u0000${draft.directory ?? ''}`} draft={draft} servers={servers} knownDirectories={knownDirectories} onCancel={() => setDraft(undefined)}
      onCreate={async (serverId, folder, title) => { await onCreateSession(serverId, folder, title); setDraft(undefined); }} /> : null}

    {onQuery && servers.length ? <View style={s.search}>
      <Icon name="search" size={16} color={c.faint} />
      <TextInput testID="session_search" accessibilityLabel="Search all sessions" value={query} onChangeText={onQuery} placeholder="Search all sessions" placeholderTextColor={c.faint} autoCapitalize="none" autoCorrect={false} returnKeyType="search" clearButtonMode="while-editing" style={s.searchInput} />
      {searching ? <ActivityIndicator size="small" color={c.faint} /> : query ? <IconButton icon="x" label="Clear search" onPress={() => onQuery('')} /> : null}
    </View> : null}

    {query.trim() ? <View testID="search_results">
      <SectionTitle title="Results" trailing={searching && !results ? 'Searching…' : String(results?.filter(item => !item.isWorker).length ?? 0)} />
      {results?.filter(item => !item.isWorker).length ? <Group>{results.filter(item => !item.isWorker).map(item => <SessionRow key={item.id} session={item} onOpen={onOpen} />)}</Group>
        : !searching ? <Text style={s.filterEmpty}>No sessions match “{query.trim()}”.</Text> : null}
    </View> : roots.length ? <>
      <View style={s.controls}>
        <View style={{ flex: 1 }}><Segmented testIDPrefix="filter" value={filter} onChange={setFilter} options={[['all', 'All'], ['needs', 'Needs you', all.needs.length], ['working', 'Working', all.working.length]]} /></View>
        {onViewChange ? <Pressable testID="view_toggle" accessibilityRole="button" accessibilityLabel={view === 'project' ? 'Group by status' : 'Group by project'} accessibilityHint="Switches how sessions are grouped"
          onPress={() => onViewChange(view === 'project' ? 'status' : 'project')} style={({ pressed }) => [s.viewToggle, pressed && { opacity: 0.7 }]}>
          <Icon name={view === 'project' ? 'list' : 'folder'} size={16} color={c.text} />
        </Pressable> : null}
      </View>
      <View testID="sessions_list" accessibilityLabel="Sessions list">
        {view === 'project' ? projectGroups.map(group => <ProjectSection key={group.key} group={group} showServer={multiServer} onOpen={onOpen}
          {...(onCreateSession && group.serverId ? { onNew: () => newSession({ serverId: group.serverId, ...(group.directory ? { directory: group.directory } : {}) }) } : {})} />)
          : sections.map(([title, items, trailing]) => items.length ? <View key={title}>
            <SectionTitle title={title} trailing={trailing ?? String(items.length)} />
            <Group>{items.map(item => <SessionRow key={item.id} session={item} onOpen={onOpen} />)}</Group>
          </View> : null)}
        {(view === 'project' ? !projectGroups.length : !needs.length && !failures.length && !working.length && !unknown.length && !recent.length) ? <Text style={s.filterEmpty}>{filter === 'needs' ? 'Nothing needs you right now.' : 'No sessions are working right now.'}</Text> : null}
        <Text style={s.windowNote}>Showing sessions updated in the last 7 days. Search to find older ones.</Text>
      </View>
    </> : servers.length === 0
      ? <EmptyState icon="server" title="No servers yet" body="Connect to an OpenCode server you already run. Your sessions stay on that server." action={<Button label="Add server" icon="plus" onPress={onServers} />} />
      : connecting ? <EmptyState icon="refresh" title="Connecting…" body="Loading sessions from your servers." />
        : problems.length ? <EmptyState icon="alert" title="Can't load sessions" body="None of your servers could be reached. Check the connection in Servers." action={<Button label="Open servers" variant="secondary" onPress={onServers} />} />
          : <EmptyState icon="inbox" title="No recent sessions" body="Nothing was updated in the last 7 days. Search to find older sessions, or start a new one."
            {...(onCreateSession ? { action: <Button label="New session" icon="plus" onPress={() => newSession()} /> } : {})} />}
  </ScrollView>;
}

function ProjectSection({ group, showServer, onOpen, onNew }: { group: ProjectGroup; showServer: boolean; onOpen: (id: string) => void; onNew?: () => void }) {
  const c = usePalette(); const s = useStyles();
  const waiting = group.sessions.filter(item => actionableRequests(item).length > 0).length;
  return <View testID={`project_${group.project.replace(/[^a-zA-Z0-9_-]/g, '_')}`}>
    <View style={s.projectHeader}>
      <View style={s.projectTitleBox}>
        <View style={s.projectTitleRow}>
          <Icon name="folder" size={14} color={c.muted} />
          <Text accessibilityRole="header" {...({ 'aria-level': 2 } as Record<string, unknown>)} numberOfLines={1} style={s.projectTitle}>{group.project}</Text>
          <Text style={s.projectCount}>{group.sessions.length}{waiting ? ` · ${waiting} need${waiting === 1 ? 's' : ''} you` : ''}</Text>
        </View>
        {group.directory || showServer ? <Text numberOfLines={1} style={s.projectPath}>{[showServer ? group.server : undefined, group.directory].filter(Boolean).join(' · ')}</Text> : null}
      </View>
      {onNew ? <IconButton testID={`new_session_in_${group.project.replace(/[^a-zA-Z0-9_-]/g, '_')}`} icon="plus" label={`New session in ${group.project}`} onPress={onNew} /> : null}
    </View>
    <Group>{group.sessions.map(item => <SessionRow key={item.id} session={item} onOpen={onOpen} hideProject />)}</Group>
  </View>;
}

function NewSessionForm({ draft, servers, knownDirectories, onCreate, onCancel }: { draft: NewSessionDraft; servers: PocketServer[]; knownDirectories?: (serverId: string) => string[]; onCreate: (serverId: string, folder: string, title?: string) => Promise<void>; onCancel: () => void }) {
  const c = usePalette(); const s = useStyles();
  const [serverId, setServerId] = useState(draft.serverId ?? servers[0]?.id ?? '');
  const [folder, setFolder] = useState(draft.directory ?? '');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const suggestions = (knownDirectories?.(serverId) ?? []).slice(0, 8);
  const submit = async () => {
    if (!serverId) { setError('Add a server first.'); return; }
    if (!folder.trim()) { setError('Enter a folder name or an absolute path.'); return; }
    setBusy(true); setError(undefined);
    try { await onCreate(serverId, folder, title); }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : 'Could not create the session.'); }
    finally { setBusy(false); }
  };
  return <Card testID="new_session_form" style={s.form}>
    <Text accessibilityRole="header" {...({ 'aria-level': 2 } as Record<string, unknown>)} style={s.formTitle}>New session</Text>
    {servers.length > 1 ? <Segmented testIDPrefix="new_session_server" value={serverId} onChange={value => { setServerId(value); setError(undefined); }} options={servers.map(server => [server.id, server.name] as const)} /> : null}
    <TextField testID="new_session_folder" label="Folder" value={folder} onChangeText={value => { setFolder(value); setError(undefined); }} placeholder="my-project or /home/me/code/my-project"
      autoCapitalize="none" autoCorrect={false} autoFocus={!draft.directory} returnKeyType="next" error={error} errorId="new_session_error"
      hint="A folder name this server already has sessions in, or an absolute path on the server." />
    {suggestions.length && !draft.directory ? <View style={s.chips}>
      {suggestions.map(directory => <Pressable key={directory} accessibilityRole="button" accessibilityLabel={`Use ${directory}`} onPress={() => { setFolder(directory); setError(undefined); }}
        style={({ pressed }) => [s.chip, folder === directory && { borderColor: c.borderStrong }, pressed && { opacity: 0.7 }]}>
        <Text numberOfLines={1} style={s.chipText}>{directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory}</Text>
      </Pressable>)}
    </View> : null}
    <TextField testID="new_session_title" label="Title" optional value={title} onChangeText={setTitle} placeholder="OpenCode names it after the first prompt" returnKeyType="go" onSubmitEditing={() => void submit()} />
    <View style={s.formActions}>
      <Button label="Cancel" variant="ghost" onPress={onCancel} disabled={busy} />
      <Button testID="new_session_create" label="Create" icon="plus" onPress={() => void submit()} loading={busy} />
    </View>
  </Card>;
}

function SessionRow({ session, onOpen, hideProject }: { session: PocketSession; onOpen: (id: string) => void; hideProject?: boolean }) {
  const c = usePalette(); const s = useStyles();
  const requests = actionableRequests(session);
  const failed = hasFailure(session);
  const running = session.status === 'running' || session.familyStatus === 'working';
  const tone: Tone = requests.length ? 'warning' : failed ? 'danger' : running ? 'success' : 'neutral';
  const detail = requests.length ? `${requests[0]!.label}${requests.length > 1 ? `  +${requests.length - 1}` : ''}`
    : failed ? session.failure ?? 'Failure reported'
      : session.activeWorkerCount ? `${session.activeWorkerCount} worker${session.activeWorkerCount === 1 ? '' : 's'} running`
        : session.status === 'running' ? 'Working' : session.status === 'unknown' ? 'Status unknown' : undefined;
  const firstOwner = requests[0]?.ownerSessionKey;
  return <Pressable testID={`session_${session.server}_${session.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`} accessibilityRole="button" accessibilityLabel={`${session.title} on ${session.server}${detail ? `, ${detail}` : ''}`} accessibilityHint="Opens the session"
    onPress={() => onOpen(session.id)} style={({ pressed }) => [s.row, pressed && { backgroundColor: c.surfaceAlt }]}>
    <View style={s.dot}><StatusDot tone={tone} /></View>
    <View style={s.rowBody}>
      <View style={s.rowTop}>
        <Text numberOfLines={1} style={s.rowTitle}>{session.title}</Text>
        <Text style={s.rowTime}>{session.freshness === 'live' ? session.lastSeen : session.freshness}</Text>
      </View>
      {hideProject ? null : <Text numberOfLines={1} style={s.rowMeta}>{session.server} · {session.project}</Text>}
      {detail ? firstOwner && firstOwner !== session.id
        ? <Pressable accessibilityRole="button" accessibilityLabel={`Open request: ${requests[0]!.label}`} onPress={() => onOpen(firstOwner)} hitSlop={4}><Text numberOfLines={1} style={[s.rowDetail, { color: c.warning }]}>{detail}</Text></Pressable>
        : <Text numberOfLines={1} style={[s.rowDetail, tone !== 'neutral' && { color: tone === 'warning' ? c.warning : tone === 'danger' ? c.danger : c.success }]}>{detail}</Text> : null}
    </View>
    <Icon name="chevron" size={16} color={c.faint} />
  </Pressable>;
}

const useStyles = makeStyles(c => ({
  page: { width: '100%', maxWidth: 640, alignSelf: 'center', paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.xxl, backgroundColor: c.bg, flexGrow: 1 },
  spinner: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  controls: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.lg },
  viewToggle: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surfaceAlt },
  projectHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.xl, marginBottom: space.sm },
  projectTitleBox: { flex: 1, minWidth: 0, gap: 2 },
  projectTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  projectTitle: { ...type.body, fontWeight: '600', color: c.text, flexShrink: 1 },
  projectCount: { ...type.caption, color: c.faint },
  projectPath: { ...type.caption, color: c.faint },
  form: { gap: space.md, marginTop: space.lg },
  formTitle: { ...type.heading, color: c.text },
  formActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: { maxWidth: '100%', paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.sm + 2, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg },
  chipText: { ...type.small, color: c.text },
  serverLine: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 2 },
  serverLineText: { ...type.small, color: c.muted },
  notices: { gap: space.sm, marginTop: space.lg },
  link: { ...type.small, fontWeight: '600', color: c.text },
  search: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.lg, paddingLeft: space.md, paddingRight: 2, minHeight: 42, borderRadius: 10, backgroundColor: c.surfaceAlt },
  searchInput: { flex: 1, minHeight: 40, color: c.text, fontSize: Platform.OS === 'web' ? 16 : 15, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } as object : {}) },
  windowNote: { ...type.caption, color: c.faint, textAlign: 'center', marginTop: space.xl },
  filterEmpty: { ...type.small, color: c.faint, textAlign: 'center', marginTop: space.xxl },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, paddingHorizontal: space.lg, minHeight: 64 },
  dot: { alignSelf: 'flex-start', paddingTop: 7 },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  rowTitle: { ...type.body, fontWeight: '500', color: c.text, flex: 1 },
  rowTime: { ...type.caption, color: c.faint },
  rowMeta: { ...type.small, color: c.muted },
  rowDetail: { ...type.small, color: c.muted, marginTop: 2 },
}));
