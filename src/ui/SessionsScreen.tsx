import React, { useState } from 'react';
import { ActivityIndicator, Platform, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { AccessiblePressable as Pressable, Button, EmptyState, Group, Header, Icon, IconButton, Notice, SectionTitle, Segmented, StatusDot, type Tone } from './components';
import { actionableRequests, groupSessionSections, hasFailure, type SessionFilter } from './behavior';
import { makeStyles, space, type, usePalette } from './theme';
import type { PocketServer, PocketSession } from './types';

const problemStates: PocketServer['state'][] = ['offline', 'auth-error', 'incompatible', 'stale', 'error'];
const problemLabel: Partial<Record<PocketServer['state'], string>> = { offline: 'unreachable', 'auth-error': 'rejected the password', incompatible: 'is not a compatible OpenCode v2 server', stale: 'may be out of date', error: 'returned an error' };

export function SessionsScreen({ sessions, servers, onOpen, onServers, refreshing, onRefresh, query = '', onQuery, results, searching }: {
  sessions: PocketSession[]; servers: PocketServer[]; onOpen: (id: string) => void; onServers: () => void; refreshing?: boolean; onRefresh: () => void;
  /** Search spans all history on the server; the default list only covers the recent window. */
  query?: string; onQuery?: (query: string) => void; results?: PocketSession[]; searching?: boolean;
}) {
  const c = usePalette(); const s = useStyles();
  const [filter, setFilter] = useState<SessionFilter>('all');
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
    <Header title="Sessions" right={servers.length ? refreshing ? <View style={s.spinner}><ActivityIndicator size="small" color={c.muted} /></View> : <IconButton icon="refresh" label="Refresh sessions" onPress={onRefresh} /> : undefined} />
    {servers.length ? <Pressable accessibilityRole="button" accessibilityLabel="Manage servers" onPress={onServers} style={s.serverLine} hitSlop={6}>
      <StatusDot tone={problems.length ? 'danger' : connecting ? 'warning' : 'success'} size={6} />
      <Text style={s.serverLineText}>{servers.length} server{servers.length === 1 ? '' : 's'}{problems.length ? ` · ${problems.length} need${problems.length === 1 ? 's' : ''} attention` : connecting ? ' · connecting' : ''}</Text>
    </Pressable> : null}

    {problems.length ? <View style={s.notices}>{problems.map(server => <Notice key={server.id} tone={server.state === 'stale' ? 'warning' : 'danger'} title={`${server.name} ${problemLabel[server.state] ?? 'needs attention'}`}
      action={<Button size="sm" variant="secondary" label="Review" onPress={onServers} />}>{server.error}</Notice>)}</View> : null}

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
      <View style={{ marginTop: space.lg }}><Segmented testIDPrefix="filter" value={filter} onChange={setFilter} options={[['all', 'All'], ['needs', 'Needs you', all.needs.length], ['working', 'Working', all.working.length]]} /></View>
      <View testID="sessions_list" accessibilityLabel="Sessions list">
        {sections.map(([title, items, trailing]) => items.length ? <View key={title}>
          <SectionTitle title={title} trailing={trailing ?? String(items.length)} />
          <Group>{items.map(item => <SessionRow key={item.id} session={item} onOpen={onOpen} />)}</Group>
        </View> : null)}
        {!needs.length && !failures.length && !working.length && !unknown.length && !recent.length ? <Text style={s.filterEmpty}>{filter === 'needs' ? 'Nothing needs you right now.' : 'No sessions are working right now.'}</Text> : null}
        <Text style={s.windowNote}>Showing sessions updated in the last 7 days. Search to find older ones.</Text>
      </View>
    </> : servers.length === 0
      ? <EmptyState icon="server" title="No servers yet" body="Connect to an OpenCode server you already run. Your sessions stay on that server." action={<Button label="Add server" icon="plus" onPress={onServers} />} />
      : connecting ? <EmptyState icon="refresh" title="Connecting…" body="Loading sessions from your servers." />
        : problems.length ? <EmptyState icon="alert" title="Can't load sessions" body="None of your servers could be reached. Check the connection in Servers." action={<Button label="Open servers" variant="secondary" onPress={onServers} />} />
          : <EmptyState icon="inbox" title="No recent sessions" body="Nothing was updated in the last 7 days. Search to find older sessions." />}
  </ScrollView>;
}

function SessionRow({ session, onOpen }: { session: PocketSession; onOpen: (id: string) => void }) {
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
      <Text numberOfLines={1} style={s.rowMeta}>{session.server} · {session.project}</Text>
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
