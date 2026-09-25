import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createExpoSender, createRoutingSender, isExpoToken, toExpoMessage } from '../src/expo.js'
import { buildMessage } from '../src/notifier.js'

const device = { deviceId: 'd', fcmToken: 'ExponentPushToken[xyz]', pairingId: 'pair', preferences: { hideDetails: false } }
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

test('isExpoToken recognises both Expo token spellings only', () => {
  assert.equal(isExpoToken('ExponentPushToken[abc]'), true)
  assert.equal(isExpoToken('ExpoPushToken[abc]'), true)
  assert.equal(isExpoToken('dGhpcyBpcyBhbiBGQ00gdG9rZW4'), false)
  assert.equal(isExpoToken(undefined), false)
})

test('toExpoMessage keeps title, body, data, channel and ttl from the FCM-shaped message', () => {
  const message = buildMessage({ device, kind: 'permission', sessionId: 'ses_1', eventId: 'per_1', projectName: 'api', sessionTitle: 'Fix bug', detail: 'bash npm test' })
  assert.deepEqual(toExpoMessage(message), {
    to: 'ExponentPushToken[xyz]', title: 'api: permission needed', body: 'Fix bug · bash npm test',
    data: { pocket: '1', pairingId: 'pair', kind: 'permission', eventId: 'per_1', sessionId: 'ses_1' },
    sound: 'default', priority: 'high', ttl: 86400, channelId: 'pocket-attention',
  })
})

test('send maps tickets: ok, DeviceNotRegistered, rate limit, HTTP errors, network failure', async () => {
  const replies = [
    response(200, { data: { status: 'ok', id: 't1' } }),
    response(200, { data: { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } } }),
    response(200, { data: { status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } } }),
    response(503, { errors: [{ code: 'INTERNAL_SERVER_ERROR', message: 'oops' }] }),
  ]
  let calls = 0
  const sender = createExpoSender({ fetch: async () => { if (calls === replies.length) throw new Error('offline'); return replies[calls++] } })
  const msg = { token: 'ExponentPushToken[xyz]', notification: { title: 't', body: 'b' }, data: {} }
  assert.deepEqual(await sender.send(msg), { ok: true, id: 't1' })
  assert.deepEqual(await sender.send(msg), { ok: false, code: 'DeviceNotRegistered', error: 'DeviceNotRegistered: not registered', invalidToken: true, retryable: false })
  assert.equal((await sender.send(msg)).retryable, true)
  const http = await sender.send(msg)
  assert.equal(http.code, 'INTERNAL_SERVER_ERROR'); assert.equal(http.retryable, true)
  const offline = await sender.send(msg)
  assert.equal(offline.code, 'NETWORK'); assert.equal(offline.retryable, true)
  assert.equal((await sender.send({ ...msg, token: 'raw' })).code, 'NOT_EXPO_TOKEN')
})

test('access token is sent only when configured', async () => {
  const seen = []
  const fetch = async (_url, init) => { seen.push(init.headers.authorization); return response(200, { data: { status: 'ok', id: 'x' } }) }
  const msg = { token: 'ExponentPushToken[xyz]', notification: {}, data: {} }
  await createExpoSender({ fetch }).send(msg)
  await createExpoSender({ fetch, accessToken: 'secret' }).send(msg)
  assert.deepEqual(seen, [undefined, 'Bearer secret'])
})

test('checkReceipts waits for the delay and reports unregistered tokens once', async () => {
  let t = 0
  const receiptBodies = []
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    if (url.endsWith('/send')) return response(200, { data: { status: 'ok', id: `ticket-${body.to}` } })
    receiptBodies.push(body)
    return response(200, { data: { 'ticket-ExponentPushToken[a]': { status: 'ok' }, 'ticket-ExponentPushToken[b]': { status: 'error', details: { error: 'DeviceNotRegistered' } } } })
  }
  const sender = createExpoSender({ fetch, now: () => t, receiptDelayMs: 1000 })
  await sender.send({ token: 'ExponentPushToken[a]', data: {} })
  await sender.send({ token: 'ExponentPushToken[b]', data: {} })
  assert.deepEqual(await sender.checkReceipts(), [])
  t = 1000
  assert.deepEqual(await sender.checkReceipts(), ['ExponentPushToken[b]'])
  assert.deepEqual(receiptBodies, [{ ids: ['ticket-ExponentPushToken[a]', 'ticket-ExponentPushToken[b]'] }])
  assert.deepEqual(await sender.checkReceipts(), [])
})

test('routing sends Expo tokens through Expo and raw tokens through FCM', async () => {
  const via = []
  const fake = (name) => ({ send: async (m) => { via.push([name, m.token]); return { ok: true } }, checkReceipts: async () => [] })
  const both = createRoutingSender({ expo: fake('expo'), fcm: fake('fcm') })
  assert.deepEqual(both.transports, ['expo', 'fcm'])
  await both.send({ token: 'ExponentPushToken[a]' })
  await both.send({ token: 'raw' })
  assert.deepEqual(via, [['expo', 'ExponentPushToken[a]'], ['fcm', 'raw']])
  const expoOnly = createRoutingSender({ expo: fake('expo') })
  assert.equal((await expoOnly.send({ token: 'raw' })).code, 'NO_TRANSPORT')
  assert.deepEqual(createRoutingSender({ fcm: fake('fcm') }).transports, ['fcm'])
})
