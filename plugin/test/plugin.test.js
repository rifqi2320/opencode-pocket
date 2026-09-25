import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import plugin, { PLUGIN_VERSION } from '../index.js'
import { pocketRpc } from '../rpc.js'
import { memoryStorage } from './helpers.js'

function fakeCtx({ options = {}, directory = '/work/my-app' } = {}) {
  const pushed = []
  let wake
  const rpc = { registered: undefined }
  const ctx = {
    options,
    location: { directory, project: { id: 'p', directory, canonical: directory } },
    storage: memoryStorage(),
    rpc: { async register(def, handlers) { rpc.registered = { def, handlers }; return { async dispose() {}, events: { async emit() {} } } } },
    session: { async get({ sessionID }) { return { id: sessionID, title: 'Session title' } } },
    event: {
      subscribe({ signal }) {
        return (async function* () {
          while (!signal.aborted) {
            if (pushed.length) { yield pushed.shift(); continue }
            await new Promise((r) => { wake = r; signal.addEventListener('abort', r, { once: true }) })
          }
        })()
      },
    },
  }
  return { ctx, rpc, emit(e) { pushed.push(e); wake?.() } }
}

test('default export shape matches the OpenCode v2 loader contract', () => {
  assert.equal(plugin.id, 'pocket')
  assert.equal(typeof plugin.setup, 'function')
  assert.equal(pocketRpc.id, 'pocket')
  assert.deepEqual(Object.keys(pocketRpc.methods).sort(), ['info', 'removeDevice', 'testNotification', 'upsertDevice'])
})

test('without credentials: RPC works, notifications report unconfigured', async () => {
  const saved = process.env.GOOGLE_APPLICATION_CREDENTIALS
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS
  const warn = console.warn; console.warn = () => {}
  try {
    const { ctx, rpc } = fakeCtx()
    const cleanup = await plugin.setup(ctx)
    const h = rpc.registered.handlers
    assert.deepEqual(await h.info(undefined), { protocolVersion: 1, pluginVersion: PLUGIN_VERSION, notificationsConfigured: false, events: ['permission', 'question', 'failed', 'finished', 'interrupted'], subagents: true })
    const input = { deviceId: 'd', fcmToken: 't', platform: 'ios', pairingId: 'p', preferences: { needsPermission: true, needsAnswer: true, sessionFailed: true, sessionFinished: false, hideDetails: false } }
    assert.deepEqual(await h.upsertDevice(input), { ok: true })
    const t = await h.testNotification({ deviceId: 'd' })
    assert.equal(t.ok, false)
    assert.deepEqual(await h.removeDevice({ deviceId: 'd' }), { ok: true })
    await cleanup()
  } finally {
    console.warn = warn
    if (saved !== undefined) process.env.GOOGLE_APPLICATION_CREDENTIALS = saved
  }
})

test('with credentials: events for this location only reach the notifier', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pocket-'))
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const file = path.join(dir, 'sa.json')
  writeFileSync(file, JSON.stringify({ type: 'service_account', client_email: 'x@y', private_key: pem, project_id: 'proj' }))
  const realFetch = globalThis.fetch
  const messages = []
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('oauth2')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) }
    messages.push(JSON.parse(init.body).message)
    return { ok: true, status: 200, json: async () => ({ name: 'n' }) }
  }
  try {
    const { ctx, rpc, emit } = fakeCtx({ options: { credentialsFile: file, throttleSeconds: 0 } })
    const cleanup = await plugin.setup(ctx)
    const h = rpc.registered.handlers
    assert.equal((await h.info({})).notificationsConfigured, true)
    await h.upsertDevice({ deviceId: 'd', fcmToken: 't', platform: 'android', pairingId: 'pair', preferences: { needsPermission: true, needsAnswer: true, sessionFailed: true, sessionFinished: false, hideDetails: false } })
    emit({ id: 'e1', type: 'permission.asked', location: { directory: '/elsewhere' }, data: { id: 'per_other', sessionID: 's', action: 'edit', resources: [] } })
    emit({ id: 'e2', type: 'permission.asked', location: { directory: '/work/my-app' }, data: { id: 'per_mine', sessionID: 's', action: 'edit', resources: ['src/a.ts'] } })
    for (let i = 0; i < 50 && messages.length < 1; i++) await new Promise((r) => setTimeout(r, 10))
    await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(messages.map((m) => m.data.eventId), ['per_mine'])
    assert.equal(messages[0].notification.title, 'my-app: permission needed')
    assert.equal(messages[0].notification.body, 'Session title · edit src/a.ts')
    assert.deepEqual(await h.testNotification({ deviceId: 'd' }), { ok: true })
    await cleanup()
  } finally {
    globalThis.fetch = realFetch
  }
})

test('notifierConfig maps options and ignores invalid values', async () => {
  const { notifierConfig } = await import('../src/index.js')
  const warnings = []
  const log = (_level, message) => warnings.push(message)
  assert.deepEqual(notifierConfig({ throttleSeconds: 5, minRunSeconds: 30, events: ['finished', 'bogus', 'permission'], subagents: false, hideDetails: true }, log),
    { throttleMs: 5000, minRunMs: 30000, events: ['permission', 'finished'], allowSubagents: false, forceHideDetails: true })
  assert.equal(warnings.length, 1)
  assert.deepEqual(notifierConfig({ throttleSeconds: -1, minRunSeconds: '9', events: 'all' }, log), {})
  assert.equal(warnings.length, 4)
})
