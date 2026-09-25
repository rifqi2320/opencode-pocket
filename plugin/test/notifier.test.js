import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryStorage, fakeSender } from './helpers.js'
import { buildMessage, createNotifier, CHANNEL_ATTENTION, CHANNEL_UPDATES, validateDevice } from '../src/notifier.js'

const prefs = (over = {}) => ({ needsPermission: true, needsAnswer: true, sessionFailed: true, sessionFinished: false, hideDetails: false, ...over })
const device = (id, over = {}) => ({ deviceId: id, fcmToken: `tok-${id}`, platform: 'android', pairingId: `pair-${id}`, preferences: prefs(over) })

function setup({ sender = fakeSender(), sessions = {}, config = {}, clock } = {}) {
  const storage = memoryStorage()
  let t = clock ?? 1_000_000
  const notifier = createNotifier({
    storage,
    sender,
    pluginVersion: '0.1.0',
    projectName: 'my-app',
    now: () => t,
    sleep: async () => {},
    config: { retryDelayMs: 0, ...config },
    lookupSession: async (id) => sessions[id],
  })
  return { storage, sender, notifier, advance: (ms) => { t += ms } }
}

const permissionAsked = (id, sessionID = 'ses_1', extra = {}) => ({ id: `evt_${id}`, type: 'permission.asked', data: { id, sessionID, action: 'bash', resources: ['git push', 'origin'], ...extra } })
const formCreated = (id, sessionID = 'ses_1') => ({ id: `evt_${id}`, type: 'form.created', data: { form: { id, sessionID, title: 'Which database should I use?', fields: [] } } })

test('info reports protocol and configuration', () => {
  assert.deepEqual(setup().notifier.info(), { protocolVersion: 1, pluginVersion: '0.1.0', notificationsConfigured: true, events: ['permission', 'question', 'failed', 'finished', 'interrupted'], subagents: true, transports: [] })
  assert.deepEqual(setup({ config: { events: ['permission'], allowSubagents: false } }).notifier.info().events, ['permission'])
  const unconfigured = createNotifier({ storage: memoryStorage(), sender: null, pluginVersion: '0.1.0', projectName: 'x' })
  assert.equal(unconfigured.info().notificationsConfigured, false)
})

test('upsertDevice validates and stores, removeDevice deletes', async () => {
  const { notifier, storage } = setup()
  assert.deepEqual(await notifier.upsertDevice(device('a')), { ok: true })
  assert.equal((await notifier.listDevices()).length, 1)
  assert.equal(storage.map.get('device/a').pairingId, 'pair-a')
  await assert.rejects(notifier.upsertDevice({ ...device('b'), platform: 'web' }), /platform/)
  await assert.rejects(notifier.upsertDevice({ ...device('b'), preferences: { needsPermission: true } }), /preferences/)
  assert.deepEqual(await notifier.removeDevice({ deviceId: 'a' }), { ok: true })
  assert.equal((await notifier.listDevices()).length, 0)
  assert.equal(validateDevice(device('z')), undefined)
})

test('permission request sends attention push with details and data payload', async () => {
  const { notifier, sender } = setup({ sessions: { ses_1: { title: 'API cleanup' } } })
  await notifier.upsertDevice(device('a'))
  notifier.onEvent(permissionAsked('per_1'))
  await notifier.idle()
  assert.equal(sender.sent.length, 1)
  const m = sender.sent[0]
  assert.equal(m.token, 'tok-a')
  assert.deepEqual(m.notification, { title: 'my-app: permission needed', body: 'API cleanup · bash git push origin' })
  assert.deepEqual(m.data, { pocket: '1', pairingId: 'pair-a', kind: 'permission', eventId: 'per_1', sessionId: 'ses_1' })
  assert.equal(m.android.priority, 'HIGH')
  assert.equal(m.android.notification.channel_id, CHANNEL_ATTENTION)
  assert.equal(m.android.notification.tag, 'permission-ses_1')
  for (const v of Object.values(m.data)) assert.equal(typeof v, 'string')
})

test('question uses form title; failed/finished use updates channel', async () => {
  const { notifier, sender } = setup({ sessions: { ses_1: { title: 'Build' } } })
  await notifier.upsertDevice(device('a', { sessionFinished: true }))
  notifier.onEvent(formCreated('frm_1'))
  notifier.onEvent({ id: 'evt_s', type: 'session.execution.started', data: { sessionID: 'ses_1' } })
  notifier.onEvent({ id: 'evt_f', type: 'session.execution.failed', data: { sessionID: 'ses_1', error: { type: 'x', message: 'Rate limited' } } })
  notifier.onEvent({ id: 'evt_s2', type: 'session.execution.started', data: { sessionID: 'ses_1' } })
  notifier.onEvent({ id: 'evt_ok', type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } })
  await notifier.idle()
  assert.deepEqual(sender.sent.map((m) => m.data.kind), ['question', 'failed', 'finished'])
  assert.deepEqual(sender.sent[0].notification, { title: 'my-app: question', body: 'Which database should I use?' })
  assert.equal(sender.sent[1].android.notification.channel_id, CHANNEL_UPDATES)
  assert.equal(sender.sent[1].notification.body, 'Build · Rate limited')
  assert.deepEqual(sender.sent[2].notification, { title: 'my-app: session finished', body: 'Build' })
})

test('preferences gate each kind; sessionFinished default off', async () => {
  const { notifier, sender } = setup({ sessions: { ses_1: { title: 'T' } } })
  await notifier.upsertDevice(device('a', { needsPermission: false }))
  notifier.onEvent(permissionAsked('per_1'))
  notifier.onEvent({ id: 'e1', type: 'session.execution.started', data: { sessionID: 'ses_1' } })
  notifier.onEvent({ id: 'e2', type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } })
  notifier.onEvent(formCreated('frm_1'))
  await notifier.idle()
  assert.deepEqual(sender.sent.map((m) => m.data.kind), ['question'])
})

test('finished only for root sessions with an observed running boundary', async () => {
  const { notifier, sender } = setup({ sessions: { root: { title: 'Root' }, child: { title: 'Child', parentID: 'root' } } })
  await notifier.upsertDevice(device('a', { sessionFinished: true }))
  notifier.onEvent({ id: 'e0', type: 'session.idle', data: { sessionID: 'root' } }) // no prior running -> ignored
  notifier.onEvent({ id: 'e1', type: 'session.status', data: { sessionID: 'child', status: { type: 'busy' } } })
  notifier.onEvent({ id: 'e2', type: 'session.status', data: { sessionID: 'child', status: { type: 'idle' } } })
  notifier.onEvent({ id: 'e3', type: 'session.status', data: { sessionID: 'root', status: { type: 'busy' } } })
  notifier.onEvent({ id: 'e4', type: 'session.status', data: { sessionID: 'root', status: { type: 'idle' } } })
  notifier.onEvent({ id: 'e5', type: 'session.idle', data: { sessionID: 'root' } }) // same boundary, already consumed
  await notifier.idle()
  assert.deepEqual(sender.sent.map((m) => [m.data.kind, m.data.sessionId]), [['finished', 'root']])
})

test('interrupted sessions do not produce finished pushes; unknown session suppresses finished', async () => {
  const { notifier, sender } = setup({ sessions: {} })
  await notifier.upsertDevice(device('a', { sessionFinished: true }))
  notifier.onEvent({ id: 'e1', type: 'session.execution.started', data: { sessionID: 's' } })
  notifier.onEvent({ id: 'e2', type: 'session.execution.interrupted', data: { sessionID: 's', reason: 'user' } })
  notifier.onEvent({ id: 'e3', type: 'session.execution.succeeded', data: { sessionID: 's' } })
  notifier.onEvent({ id: 'e4', type: 'session.execution.started', data: { sessionID: 'unknown' } })
  notifier.onEvent({ id: 'e5', type: 'session.execution.succeeded', data: { sessionID: 'unknown' } })
  await notifier.idle()
  assert.equal(sender.sent.length, 0)
})

test('subagent failures are skipped, root failures notify', async () => {
  const { notifier, sender } = setup({ sessions: { child: { parentID: 'root' }, root: { title: 'R' } } })
  await notifier.upsertDevice(device('a'))
  notifier.onEvent({ id: 'f1', type: 'session.execution.failed', data: { sessionID: 'child', error: { message: 'x' } } })
  notifier.onEvent({ id: 'f2', type: 'session.execution.failed', data: { sessionID: 'root', error: { message: 'boom' } } })
  await notifier.idle()
  assert.deepEqual(sender.sent.map((m) => m.data.sessionId), ['root'])
})

test('dedupe by request id survives restarts via storage', async () => {
  const { notifier, sender, storage } = setup({ sessions: { ses_1: { title: 'T' } } })
  await notifier.upsertDevice(device('a'))
  notifier.onEvent(permissionAsked('per_1'))
  notifier.onEvent(permissionAsked('per_1'))
  await notifier.idle()
  assert.equal(sender.sent.length, 1)
  assert.ok(storage.map.has('sent/permission%2Fper_1'))
  // New notifier instance (plugin reload) sharing storage.
  const sender2 = fakeSender()
  const again = createNotifier({ storage, sender: sender2, pluginVersion: '0', projectName: 'p', config: { throttleMs: 0 }, lookupSession: async () => ({ title: 'T' }) })
  again.onEvent(permissionAsked('per_1'))
  await again.idle()
  assert.equal(sender2.sent.length, 0)
})

test('resolved requests before worker runs are not pushed', async () => {
  const { notifier, sender } = setup({ sessions: { ses_1: { title: 'T' } } })
  await notifier.upsertDevice(device('a'))
  notifier.onEvent(permissionAsked('per_1'))
  notifier.onEvent({ id: 'r', type: 'permission.replied', data: { sessionID: 'ses_1', requestID: 'per_1', reply: 'once' } })
  await notifier.idle()
  assert.equal(sender.sent.length, 0)
})

test('throttle per device+session+kind', async () => {
  const { notifier, sender, advance } = setup({ sessions: { ses_1: { title: 'T' }, ses_2: { title: 'U' } }, config: { throttleMs: 10_000 } })
  await notifier.upsertDevice(device('a'))
  notifier.onEvent(permissionAsked('per_1'))
  notifier.onEvent(permissionAsked('per_2'))
  notifier.onEvent(permissionAsked('per_3', 'ses_2'))
  await notifier.idle()
  assert.deepEqual(sender.sent.map((m) => m.data.eventId), ['per_1', 'per_3'])
  advance(10_001)
  notifier.onEvent(permissionAsked('per_4'))
  await notifier.idle()
  assert.deepEqual(sender.sent.map((m) => m.data.eventId), ['per_1', 'per_3', 'per_4'])
})

test('hideDetails produces generic text but keeps routing data', async () => {
  const { notifier, sender } = setup({ sessions: { ses_1: { title: 'Secret project work' } } })
  await notifier.upsertDevice(device('a', { hideDetails: true, sessionFinished: true }))
  notifier.onEvent(permissionAsked('per_1'))
  notifier.onEvent({ id: 'e1', type: 'session.execution.started', data: { sessionID: 'ses_1' } })
  notifier.onEvent({ id: 'e2', type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } })
  await notifier.idle()
  const [perm, done] = sender.sent
  assert.equal(perm.notification.title, 'OpenCode needs you')
  assert.equal(done.notification.title, 'Session update')
  for (const m of sender.sent) {
    const text = JSON.stringify(m.notification)
    assert.ok(!/my-app|git push|bash|Secret/.test(text), text)
  }
  assert.equal(perm.data.sessionId, 'ses_1')
  assert.equal(perm.data.pairingId, 'pair-a')
})

test('invalid token responses prune the device; transient errors retry once', async () => {
  const sender = fakeSender((m) => (m.token === 'tok-bad'
    ? { ok: false, code: 'UNREGISTERED', error: 'UNREGISTERED: gone', invalidToken: true, retryable: false }
    : { ok: true }))
  const { notifier, storage } = setup({ sender, sessions: { ses_1: { title: 'T' } } })
  await notifier.upsertDevice({ ...device('bad'), fcmToken: 'tok-bad' })
  await notifier.upsertDevice(device('good'))
  notifier.onEvent(permissionAsked('per_1'))
  await notifier.idle()
  assert.equal(storage.map.has('device/bad'), false)
  assert.equal(storage.map.has('device/good'), true)

  let calls = 0
  const flaky = fakeSender(() => (++calls === 1 ? { ok: false, code: 'UNAVAILABLE', error: 'x', invalidToken: false, retryable: true } : { ok: true }))
  const s2 = setup({ sender: flaky, sessions: { ses_1: { title: 'T' } } })
  await s2.notifier.upsertDevice(device('a'))
  s2.notifier.onEvent(permissionAsked('per_9'))
  await s2.notifier.idle()
  assert.equal(flaky.sent.length, 2)
  assert.equal(s2.storage.map.has('device/a'), true)
})

test('prune does not delete a device that re-registered with a new token', async () => {
  let notifierRef
  const sender = fakeSender(async (m) => {
    await notifierRef.upsertDevice({ ...device('a'), fcmToken: 'tok-new' }) // token refresh races the failing send
    return { ok: false, code: 'UNREGISTERED', error: 'x', invalidToken: true, retryable: false }
  })
  const { notifier, storage } = setup({ sender, sessions: { ses_1: { title: 'T' } } })
  notifierRef = notifier
  await notifier.upsertDevice(device('a'))
  notifier.onEvent(permissionAsked('per_1'))
  await notifier.idle()
  assert.equal(storage.map.get('device/a').fcmToken, 'tok-new')
})

test('testNotification: success, unknown device, invalid token pruned, unconfigured', async () => {
  const sender = fakeSender((m) => (m.token === 'tok-bad'
    ? { ok: false, code: 'INVALID_ARGUMENT', error: 'INVALID_ARGUMENT: The registration token is not a valid FCM registration token', invalidToken: true, retryable: false }
    : { ok: true }))
  const { notifier, storage } = setup({ sender })
  await notifier.upsertDevice(device('a'))
  await notifier.upsertDevice({ ...device('bad'), fcmToken: 'tok-bad' })
  assert.deepEqual(await notifier.testNotification({ deviceId: 'a' }), { ok: true })
  assert.equal(sender.sent[0].data.kind, 'test')
  assert.equal(sender.sent[0].android.notification.channel_id, CHANNEL_UPDATES)
  assert.equal(sender.sent[0].data.sessionId, undefined)
  assert.deepEqual(await notifier.testNotification({ deviceId: 'nope' }), { ok: false, error: 'Device is not registered' })
  const bad = await notifier.testNotification({ deviceId: 'bad' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /INVALID_ARGUMENT.*removed/)
  assert.equal(storage.map.has('device/bad'), false)
  const none = createNotifier({ storage: memoryStorage(), sender: null, pluginVersion: '0', projectName: 'p' })
  assert.equal((await none.testNotification({ deviceId: 'a' })).ok, false)
})

test('expired device registrations are dropped', async () => {
  const { notifier, advance } = setup()
  await notifier.upsertDevice(device('a'))
  advance(91 * 86_400_000)
  assert.equal((await notifier.listDevices()).length, 0)
})

test('dedupe records are bounded and expire', async () => {
  const { notifier, storage, advance } = setup({ config: { maxSent: 3, sentTtlMs: 1000 } })
  for (let i = 0; i < 6; i++) { await storage.set(`sent/k${i}`, 1_000_000 + i) }
  await notifier.compact()
  assert.deepEqual([...storage.map.keys()].filter((k) => k.startsWith('sent/')).sort(), ['sent/k3', 'sent/k4', 'sent/k5'])
  advance(5000)
  await notifier.compact()
  assert.equal([...storage.map.keys()].filter((k) => k.startsWith('sent/')).length, 0)
})

test('no devices / no sender / malformed events never throw', async () => {
  const { notifier, sender } = setup()
  notifier.onEvent(null)
  notifier.onEvent({ type: 'permission.asked' })
  notifier.onEvent({ type: 'form.created', data: {} })
  notifier.onEvent(permissionAsked('per_1'))
  await notifier.idle()
  assert.equal(sender.sent.length, 0)
  const throwing = setup({ sender: { async send() { throw new Error('kaboom') } }, sessions: { ses_1: {} } })
  await throwing.notifier.upsertDevice(device('a'))
  throwing.notifier.onEvent(permissionAsked('per_2'))
  await throwing.notifier.idle()
})

test('buildMessage truncates body to 120 chars', () => {
  const m = buildMessage({ device: device('a'), kind: 'permission', sessionId: 's', eventId: 'e', projectName: 'p', sessionTitle: 'T', detail: 'x'.repeat(500) })
  assert.equal(m.notification.body.length, 120)
})

test('older apps without the new preference keys still register; missing keys default to false', async () => {
  const { notifier, storage } = setup()
  assert.equal(validateDevice(device('a')), undefined)
  await notifier.upsertDevice(device('a'))
  assert.equal(storage.map.get('device/a').preferences.sessionInterrupted, false)
  assert.equal(storage.map.get('device/a').preferences.includeSubagents, false)
  assert.match(validateDevice({ ...device('b'), preferences: prefs({ includeSubagents: 'yes' }) }), /includeSubagents/)
})

test('interrupted pushes follow the sessionInterrupted preference', async () => {
  const { notifier, sender } = setup({ sessions: { root: { title: 'Root' } } })
  await notifier.upsertDevice(device('on', { sessionInterrupted: true }))
  await notifier.upsertDevice(device('off'))
  notifier.onEvent({ id: 'i1', type: 'session.execution.started', data: { sessionID: 'root' } })
  notifier.onEvent({ id: 'i2', type: 'session.execution.interrupted', data: { sessionID: 'root' } })
  await notifier.idle()
  assert.deepEqual(sender.sent.map((m) => [m.token, m.data.kind, m.android.notification.channel_id]), [['tok-on', 'interrupted', CHANNEL_UPDATES]])
  assert.match(sender.sent[0].notification.title, /session interrupted/)
})

test('subagent outcomes reach only devices that opted in', async () => {
  const { notifier, sender } = setup({ sessions: { child: { title: 'Child', parentID: 'root' }, root: { title: 'R' } } })
  await notifier.upsertDevice(device('sub', { sessionFinished: true, includeSubagents: true }))
  await notifier.upsertDevice(device('root-only', { sessionFinished: true }))
  notifier.onEvent({ id: 'f1', type: 'session.execution.failed', data: { sessionID: 'child', error: { message: 'x' } } })
  notifier.onEvent({ id: 'b1', type: 'session.status', data: { sessionID: 'child', status: { type: 'busy' } } })
  notifier.onEvent({ id: 'b2', type: 'session.status', data: { sessionID: 'child', status: { type: 'idle' } } })
  await notifier.idle()
  assert.deepEqual(sender.sent.map((m) => [m.token, m.data.kind]), [['tok-sub', 'failed'], ['tok-sub', 'finished']])
  assert.match(sender.sent[0].notification.title, /subagent failed/)
})

test('server options: events allowlist, subagents off, minRunSeconds, forced hideDetails', async () => {
  const { notifier, sender, advance } = setup({
    sessions: { root: { title: 'Secret title' }, child: { parentID: 'root' } },
    config: { events: ['finished', 'failed'], allowSubagents: false, minRunMs: 60_000, forceHideDetails: true },
  })
  await notifier.upsertDevice(device('a', { sessionFinished: true, includeSubagents: true }))
  notifier.onEvent(permissionAsked('per_x', 'root')) // not in events
  notifier.onEvent({ id: 'c1', type: 'session.execution.failed', data: { sessionID: 'child' } }) // subagents disabled
  notifier.onEvent({ id: 'r1', type: 'session.execution.started', data: { sessionID: 'root' } })
  advance(5_000)
  notifier.onEvent({ id: 'r2', type: 'session.execution.succeeded', data: { sessionID: 'root' } }) // too short
  notifier.onEvent({ id: 'r3', type: 'session.execution.started', data: { sessionID: 'root' } })
  advance(61_000)
  notifier.onEvent({ id: 'r4', type: 'session.execution.succeeded', data: { sessionID: 'root' } })
  await notifier.idle()
  assert.deepEqual(sender.sent.map((m) => m.data.kind), ['finished'])
  assert.doesNotMatch(JSON.stringify(sender.sent[0].notification), /Secret title|my-app/)
})

test('pruneInvalidTokens removes devices whose token the transport reported as unregistered', async () => {
  const sender = { ...fakeSender(), checkReceipts: async () => ['tok-b'] }
  const { notifier, storage } = setup({ sender })
  await notifier.upsertDevice(device('a'))
  await notifier.upsertDevice(device('b'))
  await notifier.pruneInvalidTokens()
  assert.deepEqual([...storage.map.keys()].filter((k) => k.startsWith('device/')), ['device/a'])
})
