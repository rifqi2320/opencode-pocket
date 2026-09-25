import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { SessionsScreen } from './SessionsScreen';
import { SessionDetailScreen } from './SessionDetailScreen';
import { ServersScreen } from './ServersScreen';
import type { PocketServer, PocketServerNotifications, PocketSession } from './types';
import { buildTurns } from './turns';

/** Dev-only fixture gallery for web UI review: open `#preview/sessions`, `#preview/detail`, `#preview/chat` (conversation only), `#preview/servers`, `#preview/empty`. */
const servers: PocketServer[] = [
  { id: 'ws', name: 'Workstation', url: 'https://ws.tailnet.ts.net', state: 'connected', version: 'OpenCode 2.0.5', transport: 'Live event stream', lastSync: '4:12 PM', coverage: '12 sessions · 2 blockers' },
  { id: 'lab', name: 'Lab box', url: 'https://lab.example.com', state: 'offline', error: 'Could not reach server' },
];
const notificationFixture: { platform: string; servers: Record<string, PocketServerNotifications> } = { platform: 'android', servers: {
  ws: { enabled: true, busy: false, status: { kind: 'on', label: 'On', tone: 'success', canToggle: true }, preferences: { needsPermission: true, needsAnswer: true, sessionFailed: true, sessionFinished: false, sessionInterrupted: false, includeSubagents: false, hideDetails: false } },
  lab: { enabled: false, busy: false, status: { kind: 'plugin-missing', label: 'Plugin not installed · see plugin/README.md', tone: 'neutral', canToggle: false }, preferences: { needsPermission: true, needsAnswer: true, sessionFailed: true, sessionFinished: false, sessionInterrupted: false, includeSubagents: false, hideDetails: false } },
} };
/**
 * Sanitized fixture in the real OpenCode v2 wire shape (GET /api/session/:id/message): one
 * `assistant` message per model step with `content` parts (reasoning | text | tool), `idle`
 * markers closing each prompt, tool `state` carrying input/content/metadata/error.
 */
const t0 = Date.parse('2026-09-25T09:12:00Z');
const at = (s: number) => t0 + s * 1000;
const tool = (id: string, name: string, s: number, dur: number, state: Record<string, unknown>) => ({ type: 'tool', id, name, executed: false, time: { created: at(s), ran: at(s) + 40, ...(state.status === 'running' ? {} : { completed: at(s) + 40 + dur }) }, state });
const shell = (id: string, s: number, dur: number, command: string, output: string, exit = 0) => tool(id, 'shell', s, dur, { status: 'completed', input: { command, workdir: '/home/dev/api' }, content: [{ type: 'text', text: output }, { type: 'text', text: `Command exited with code ${exit}.` }], metadata: { status: 'completed', truncated: false, exit } });
const step = (id: string, s: number, content: unknown[], finish = 'tool-calls') => ({ id, type: 'assistant', agent: 'build', model: { id: 'claude-sonnet-5', providerID: 'anthropic' }, time: { created: at(s), streamed: at(s + 1), completed: at(s + 3) }, finish, content });
const think = (text: string, s: number) => ({ type: 'reasoning', text, time: { created: at(s), completed: at(s + 2) }, state: {} });
const longLog = Array.from({ length: 160 }, (_, i) => `  ✓ handlers/order.test.ts > serializes ${i + 1} line items (${(i % 7) + 2}ms)`).join('\n');
const detailMessages: unknown[] = [
  { id: 'msg_01', type: 'user', text: 'Refactor the v1 handlers into a compat layer, but do not change the public interface. Run the tests when done.', files: [], agents: [], time: { created: at(0) } },
  step('msg_02', 1, [think('**Scanning handler exports**\n\nI need every exported handler before moving anything, so the compat layer can re-export the same names.', 1), { type: 'text', text: 'I will map the exported handlers first, then move them behind a compat layer.' },
    shell('call_1', 3, 180, 'rg -n "export function" src/handlers', 'src/handlers/user.ts:12:export function getUser(\nsrc/handlers/order.ts:40:export function createOrder(\nsrc/handlers/order.ts:88:export function listOrders(')]),
  step('msg_03', 6, [think('**Reading order handler**', 6), tool('call_2', 'read', 7, 12, { status: 'completed', input: { path: '/home/dev/api/src/handlers/order.ts', limit: 120 }, content: [{ type: 'text', text: 'Read file src/handlers/order.ts, lines 1-120\n 40  export function createOrder(input: OrderInput) {\n 41    const createdAt = new Date().toString();' }], metadata: { truncated: true } }),
    tool('call_3', 'grep', 8, 30, { status: 'completed', input: { pattern: 'toString\\(\\)', path: '/home/dev/api/src', include: '*.ts' }, content: [{ type: 'text', text: 'src/handlers/order.ts:41\nsrc/handlers/user.ts:19' }], metadata: {} })]),
  step('msg_04', 12, [think('**Creating compat layer**', 12), tool('call_4', 'patch', 13, 22, { status: 'completed', input: { patchText: '*** Begin Patch\n*** Add File: /home/dev/api/src/compat/v1.ts\n+export { getUser } from "../handlers/user";\n+export { createOrder, listOrders } from "../handlers/order";\n*** Update File: /home/dev/api/src/index.ts\n@@\n-export * from "./handlers";\n+export * from "./compat/v1";\n*** End Patch' }, content: [{ type: 'text', text: 'Success. Updated the following files:\nA src/compat/v1.ts\nM src/index.ts' }], metadata: { files: [{ file: '/home/dev/api/src/compat/v1.ts' }, { file: '/home/dev/api/src/index.ts' }], truncated: false } })]),
  step('msg_05', 16, [shell('call_5', 16, 5400, 'npm test -- --reporter=dot', 'FAIL handlers/order.test.ts\n  ✗ createOrder serializes createdAt as ISO-8601\n    Expected: "2026-09-25T09:12:00.000Z"\n    Received: "Fri Sep 25 2026 09:12:00 GMT+0000"\n\n2 failing, 41 passing', 1),
    tool('call_6', 'read', 23, 8, { status: 'error', input: { path: '/home/dev/api/src/handlers/legacy/date.ts' }, error: { type: 'tool.execution', message: 'File not found: /home/dev/api/src/handlers/legacy/date.ts' } })]),
  step('msg_06', 25, [think('**Fixing date serialisation**', 25), { type: 'text', text: 'Two tests fail because `createdAt` uses `toString()`. Switching to `toISOString()`.' },
    tool('call_7', 'patch', 27, 18, { status: 'completed', input: { patchText: '*** Begin Patch\n*** Update File: /home/dev/api/src/handlers/order.ts\n@@\n-    const createdAt = new Date().toString();\n+    const createdAt = new Date().toISOString();\n*** End Patch' }, content: [{ type: 'text', text: 'Success. Updated the following files:\nM src/handlers/order.ts' }], metadata: { files: [{ file: '/home/dev/api/src/handlers/order.ts' }], truncated: false } }),
    shell('call_8', 29, 4800, 'npm test -- --reporter=verbose', `${longLog}\n\n43 passing`)]),
  step('msg_07', 36, [think('**Summarizing changes**', 36), { type: 'text', text: [
    '## Done — handlers now live behind `src/compat/v1.ts`',
    '',
    'The public interface is **unchanged**: every previously exported name is re-exported from the compat layer.',
    '',
    '### What changed',
    '1. Added `src/compat/v1.ts` re-exporting `getUser`, `createOrder`, `listOrders`.',
    '2. `src/index.ts` now exports from the compat layer.',
    '3. Fixed `createdAt` serialisation in the order handler:',
    '   - was `toString()`, now `toISOString()`',
    '   - matches the documented *ISO-8601* contract',
    '',
    '```ts',
    'export { createOrder, listOrders } from "../handlers/order";',
    '```',
    '',
    '| Suite | Before | After |',
    '|---|:-:|:-:|',
    '| handlers | 2 failing | 43 passing |',
    '| compat | — | new |',
    '',
    '> `user.ts:19` also calls `toString()` but only for logging, so I left it.',
    '',
    'See the [migration notes](https://example.com/docs/migration) for the v2 plan.',
  ].join('\n') }], 'stop'),
  { id: 'msg_08', type: 'idle', outcome: 'succeeded', time: { created: at(40) } },
  { id: 'msg_09', type: 'user', text: 'Great. Now add a changelog entry.', files: [], agents: [], time: { created: at(60) } },
  step('msg_10', 61, [think('**Locating changelog**', 61), tool('call_9', 'grep', 62, 25, { status: 'completed', input: { pattern: '## Unreleased', path: '/home/dev/api' }, content: [{ type: 'text', text: 'CHANGELOG.md:3' }], metadata: {} })]),
  { id: 'msg_11', type: 'assistant', agent: 'build', model: { id: 'claude-sonnet-5', providerID: 'anthropic' }, time: { created: at(64) }, content: [tool('call_10', 'patch', 64, 0, { status: 'running', input: { patchText: '*** Begin Patch\n*** Update File: /home/dev/api/CHANGELOG.md\n@@ ## Unreleased\n+- Moved v1 handlers behind a compat layer (no API change).\n*** End Patch' }, metadata: {} })] },
];
const base = { server: 'Workstation', familyCoverage: 'complete' as const, freshness: 'live' as const, forms: [], workers: [], messages: [], attention: [], lastSeen: '2s ago' };
const sessions: PocketSession[] = [
  { ...base, serverId: 'ws', id: 'a', project: 'api', directory: '/home/dev/api', title: 'API compatibility cleanup', status: 'running', familyStatus: 'working', activeWorkerCount: 1, summary: 'Session is active', agent: 'build', model: 'claude-sonnet-5',
    attention: [{ id: 'p1', kind: 'permission', label: 'Permission · bash · npm test -- --watch=false', ownerSessionKey: 'a' }],
    workers: [{ id: 'w1', title: 'Review worker', status: 'working', relation: 'subagent', depth: 1, needsYou: true, sessionKey: 'w1' }, { id: 'w2', title: 'Test runner', status: 'inactive', relation: 'subagent', depth: 1, sessionKey: 'w2' }],
    forms: [{ id: 'f1', sessionID: 'a', title: 'Which database should the migration target?', fields: [{ key: 'db', type: 'string', title: 'Target', required: true, options: [{ value: 'pg', label: 'Postgres' }, { value: 'my', label: 'MySQL' }] }, { key: 'dry', type: 'boolean', title: 'Dry run first' }] }],
    messages: buildTurns(detailMessages) },
  { ...base, serverId: 'ws', id: 'b', project: 'web', directory: '/home/dev/web', title: 'Dashboard UI polish', status: 'running', familyStatus: 'working', summary: 'Session is active' },
  { ...base, serverId: 'ws', id: 'c', project: 'infra', directory: '/home/dev/infra', title: 'Terraform drift check', status: 'inactive', familyStatus: 'inactive', summary: 'No active execution observed', failure: 'Failure reported in session activity', lastSeen: '3m ago' },
  { ...base, serverId: 'ws', id: 'a2', project: 'api', directory: '/home/dev/api', title: 'Rate limiter review', status: 'inactive', familyStatus: 'inactive', summary: 'No active execution observed', lastSeen: '20m ago' },
  { ...base, serverId: 'ws', id: 'd', project: 'docs', directory: '/home/dev/docs', title: 'Write release notes for 0.4', status: 'inactive', familyStatus: 'inactive', summary: 'No active execution observed', lastSeen: '12m ago' },
  { ...base, id: 'e', server: 'Lab box', serverId: 'lab', project: 'ml', directory: '/srv/ml', title: 'Tokenizer benchmark', status: 'unknown', familyStatus: 'unknown', familyCoverage: 'unknown', freshness: 'offline', summary: 'Execution status not confirmed', lastSeen: 'not observed' },
];

export function Preview() {
  const [screen, setScreen] = useState(() => location.hash.split('/')[1] ?? 'sessions');
  useEffect(() => { const update = () => setScreen(location.hash.split('/')[1] ?? 'sessions'); addEventListener('hashchange', update); return () => removeEventListener('hashchange', update); }, []);
  const wait = async () => { await new Promise(resolve => setTimeout(resolve, 600)); };
  return <View style={{ flex: 1 }}>
    {screen === 'sessions' || screen === 'projects' ? <SessionsScreen sessions={sessions} servers={servers} onOpen={() => { location.hash = 'preview/detail'; }} onServers={() => { location.hash = 'preview/servers'; }} onRefresh={() => undefined}
      view={screen === 'projects' ? 'project' : 'status'} onViewChange={view => { location.hash = view === 'project' ? 'preview/projects' : 'preview/sessions'; }}
      knownDirectories={() => ['/home/dev/api', '/home/dev/docs', '/home/dev/infra', '/home/dev/web']}
      onCreateSession={async (_serverId, folder) => { await wait(); if (!/^(\/home\/dev\/)?(api|docs|infra|web)$/.test(folder.trim())) throw new Error(`Folder “${folder.trim()}” does not exist on Workstation.`); location.hash = 'preview/chat'; }} /> : null}
    {screen === 'empty' ? <SessionsScreen sessions={[]} servers={[]} onOpen={() => undefined} onServers={() => { location.hash = 'preview/servers'; }} onRefresh={() => undefined} /> : null}
    {screen === 'detail' ? <SessionDetailScreen session={sessions[0]} onBack={() => { location.hash = 'preview/sessions'; }} onSend={async () => { await wait(); return { state: 'accepted' }; }} onInterrupt={async () => { await wait(); return true; }} onReply={wait} onReplyForm={async () => { await wait(); return 'answered'; }} onOpenWorker={() => undefined} /> : null}
    {screen === 'chat' ? <SessionDetailScreen session={{ ...sessions[0]!, attention: [], forms: [], workers: [], familyStatus: 'working', activeWorkerCount: 0, hasEarlier: true }} onBack={() => { location.hash = 'preview/sessions'; }} onSend={async () => { await wait(); return { state: 'accepted' }; }} onInterrupt={async () => { await wait(); return true; }} onReply={wait} onReplyForm={async () => { await wait(); return 'answered'; }} onOpenWorker={() => undefined} onLoadEarlier={wait} /> : null}
    {screen === 'servers' ? <ServersScreen servers={servers} onSave={wait} onUpdate={wait} onRemove={wait} onTest={wait} notifications={notificationFixture} onNotificationsToggle={wait} onNotificationPreference={wait} onNotificationTest={async () => { await wait(); return { ok: true }; }} /> : null}
  </View>;
}
