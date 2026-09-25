import assert from 'node:assert/strict'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { test } from 'node:test'
import { classifyFcmError, createFcmSender, loadCredentials, signAssertion, FCM_SCOPE } from '../src/fcm.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const credentials = { clientEmail: 'sender@proj.iam.gserviceaccount.com', privateKey: pem, projectId: 'proj', tokenUri: 'https://oauth2.googleapis.com/token' }

test('loadCredentials: option, env fallback, and safe failures', () => {
  const sa = JSON.stringify({ type: 'service_account', client_email: 'a@b', private_key: pem, project_id: 'p1' })
  const ok = loadCredentials({ credentialsFile: '/x.json', env: {}, readFile: () => sa })
  assert.equal(ok.ok, true)
  assert.equal(ok.credentials.projectId, 'p1')
  assert.equal(ok.credentials.tokenUri, 'https://oauth2.googleapis.com/token')
  let read
  assert.equal(loadCredentials({ env: { GOOGLE_APPLICATION_CREDENTIALS: '/env.json' }, readFile: (p) => { read = p; return sa } }).ok, true)
  assert.equal(read, '/env.json')
  assert.equal(loadCredentials({ env: {} }).ok, false)
  const bad = loadCredentials({ credentialsFile: '/x', env: {}, readFile: () => '{"type":"authorized_user"}' })
  assert.equal(bad.ok, false)
  assert.ok(!bad.reason.includes('PRIVATE'))
  assert.equal(loadCredentials({ credentialsFile: '/missing', env: {}, readFile: () => { throw new Error('ENOENT') } }).ok, false)
})

test('signAssertion produces a verifiable RS256 JWT with the FCM scope', () => {
  const jwt = signAssertion(credentials, 1000)
  const [h, c, s] = jwt.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' })
  const claims = JSON.parse(Buffer.from(c, 'base64url'))
  assert.deepEqual(claims, { iss: credentials.clientEmail, scope: FCM_SCOPE, aud: credentials.tokenUri, iat: 1000, exp: 4600 })
  const v = createVerify('RSA-SHA256'); v.update(`${h}.${c}`)
  assert.ok(v.verify(publicKey, Buffer.from(s, 'base64url')))
})

test('classifyFcmError recognises invalid tokens', () => {
  const unregistered = classifyFcmError(404, { error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } })
  assert.equal(unregistered.code, 'UNREGISTERED')
  assert.equal(unregistered.invalidToken, true)
  const invalid = classifyFcmError(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'INVALID_ARGUMENT' }] } })
  assert.equal(invalid.invalidToken, true)
  const payloadBug = classifyFcmError(400, { error: { status: 'INVALID_ARGUMENT', message: 'Invalid value at message.android.ttl' } })
  assert.equal(payloadBug.invalidToken, false)
  assert.equal(classifyFcmError(503, {}).retryable, true)
  assert.equal(classifyFcmError(429, { error: { details: [{ errorCode: 'QUOTA_EXCEEDED' }] } }).retryable, true)
})

function fakeFetch(handlers) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url: String(url), init })
    const h = handlers(String(url), init, calls.length)
    return { ok: h.status >= 200 && h.status < 300, status: h.status, json: async () => h.body }
  }
  fn.calls = calls
  return fn
}

test('sender caches OAuth token until expiry and posts FCM v1 messages', async () => {
  let t = 0
  const fetch = fakeFetch((url) => (url.includes('oauth2')
    ? { status: 200, body: { access_token: 'ya29.tok', expires_in: 3600 } }
    : { status: 200, body: { name: 'projects/proj/messages/1' } }))
  const sender = createFcmSender({ credentials, projectId: 'proj', fetch, now: () => t })
  assert.deepEqual(await sender.send({ token: 'x' }), { ok: true, name: 'projects/proj/messages/1' })
  await sender.send({ token: 'y' })
  assert.equal(fetch.calls.filter((c) => c.url.includes('oauth2')).length, 1)
  const fcmCall = fetch.calls[1]
  assert.equal(fcmCall.url, 'https://fcm.googleapis.com/v1/projects/proj/messages:send')
  assert.equal(fcmCall.init.headers.authorization, 'Bearer ya29.tok')
  assert.deepEqual(JSON.parse(fcmCall.init.body), { message: { token: 'x' } })
  const tokenBody = new URLSearchParams(fetch.calls[0].init.body)
  assert.equal(tokenBody.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer')
  t = 3600_000 // past expiry (minus 60s skew)
  await sender.send({ token: 'z' })
  assert.equal(fetch.calls.filter((c) => c.url.includes('oauth2')).length, 2)
})

test('sender maps FCM errors and auth failures without throwing', async () => {
  const fetch = fakeFetch((url) => (url.includes('oauth2')
    ? { status: 200, body: { access_token: 'tok', expires_in: 3600 } }
    : { status: 404, body: { error: { status: 'NOT_FOUND', message: 'not found', details: [{ errorCode: 'UNREGISTERED' }] } } }))
  const r = await createFcmSender({ credentials, projectId: 'proj', fetch }).send({ token: 'x' })
  assert.deepEqual({ ok: r.ok, code: r.code, invalidToken: r.invalidToken }, { ok: false, code: 'UNREGISTERED', invalidToken: true })
  const authFail = fakeFetch(() => ({ status: 400, body: { error: 'invalid_grant' } }))
  const a = await createFcmSender({ credentials, projectId: 'proj', fetch: authFail }).send({ token: 'x' })
  assert.equal(a.ok, false)
  assert.equal(a.code, 'AUTH')
  const netFail = async () => { throw new Error('ECONNREFUSED') }
  const n = await createFcmSender({ credentials, projectId: 'proj', fetch: netFail }).send({ token: 'x' })
  assert.equal(n.ok, false)
})
