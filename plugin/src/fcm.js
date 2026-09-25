// FCM HTTP v1 sender with a zero-dependency OAuth2 service-account flow.
// Never logs tokens, private keys or FCM registration identifiers.
import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'

/**
 * Loads service-account credentials. Returns `{ ok: true, credentials }` or `{ ok: false, reason }`.
 * `reason` never contains key material.
 * @param {{ credentialsFile?: string, env?: Record<string, string | undefined>, readFile?: (p: string) => string }} input
 */
export function loadCredentials({ credentialsFile, env = process.env, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  const file = credentialsFile || env.GOOGLE_APPLICATION_CREDENTIALS
  if (!file) return { ok: false, reason: 'No credentialsFile option or GOOGLE_APPLICATION_CREDENTIALS set' }
  let parsed
  try {
    parsed = JSON.parse(readFile(file))
  } catch {
    return { ok: false, reason: 'Credentials file is missing or not valid JSON' }
  }
  if (!parsed || parsed.type !== 'service_account' || typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
    return { ok: false, reason: 'Credentials file is not a Google service-account key' }
  }
  return {
    ok: true,
    credentials: {
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
      projectId: typeof parsed.project_id === 'string' ? parsed.project_id : undefined,
      tokenUri: typeof parsed.token_uri === 'string' ? parsed.token_uri : DEFAULT_TOKEN_URI,
    },
  }
}

const b64url = (input) => Buffer.from(input).toString('base64url')

/** Builds an RS256-signed JWT assertion for the OAuth2 jwt-bearer grant. */
export function signAssertion(credentials, nowSeconds) {
  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = { iss: credentials.clientEmail, scope: FCM_SCOPE, aud: credentials.tokenUri, iat: nowSeconds, exp: nowSeconds + 3600 }
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
  const signer = createSign('RSA-SHA256')
  signer.update(unsigned)
  signer.end()
  return `${unsigned}.${signer.sign(credentials.privateKey).toString('base64url')}`
}

/**
 * Classifies an FCM v1 error response.
 * @returns {{ code: string, message: string, invalidToken: boolean, retryable: boolean }}
 */
export function classifyFcmError(status, body) {
  const error = body && typeof body === 'object' ? body.error : undefined
  const details = Array.isArray(error?.details) ? error.details : []
  const fcmCode = details.find((d) => typeof d?.errorCode === 'string')?.errorCode
  const code = String(fcmCode || error?.status || `HTTP_${status}`)
  const message = typeof error?.message === 'string' ? error.message : `FCM request failed with HTTP ${status}`
  const fieldViolations = details.flatMap((d) => (Array.isArray(d?.fieldViolations) ? d.fieldViolations : []))
  const aboutToken = /registration token/i.test(message) || fieldViolations.some((v) => /token/i.test(String(v?.field ?? '')))
  const invalidToken =
    code === 'UNREGISTERED' ||
    status === 404 ||
    ((code === 'INVALID_ARGUMENT' || error?.status === 'INVALID_ARGUMENT') && aboutToken) ||
    code === 'SENDER_ID_MISMATCH'
  const retryable = !invalidToken && (status === 429 || status >= 500 || code === 'UNAVAILABLE' || code === 'INTERNAL' || code === 'QUOTA_EXCEEDED')
  return { code, message: message.slice(0, 300), invalidToken, retryable }
}

/**
 * Creates an FCM sender. `send(message)` resolves to
 * `{ ok: true, name }` or `{ ok: false, code, error, invalidToken, retryable }`; it never throws.
 * @param {{ credentials: any, projectId: string, fetch?: typeof fetch, now?: () => number, timeoutMs?: number }} input
 */
export function createFcmSender({ credentials, projectId, fetch: fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15000 }) {
  let cached // { token, expiresAt }
  let pending

  async function fetchToken() {
    const assertion = signAssertion(credentials, Math.floor(now() / 1000))
    const response = await fetchImpl(credentials.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || typeof body.access_token !== 'string') {
      throw new Error(`OAuth token request failed (HTTP ${response.status}${body?.error ? `: ${String(body.error)}` : ''})`)
    }
    const ttl = Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600
    cached = { token: body.access_token, expiresAt: now() + (ttl - 60) * 1000 }
    return cached.token
  }

  async function accessToken() {
    if (cached && cached.expiresAt > now()) return cached.token
    if (!pending) pending = fetchToken().finally(() => { pending = undefined })
    return pending
  }

  async function send(message) {
    let token
    try {
      token = await accessToken()
    } catch (cause) {
      return { ok: false, code: 'AUTH', error: String(cause?.message ?? cause), invalidToken: false, retryable: true }
    }
    try {
      const response = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const body = await response.json().catch(() => ({}))
      if (response.ok) return { ok: true, name: typeof body.name === 'string' ? body.name : undefined }
      if (response.status === 401) cached = undefined
      const c = classifyFcmError(response.status, body)
      return { ok: false, code: c.code, error: `${c.code}: ${c.message}`, invalidToken: c.invalidToken, retryable: c.retryable }
    } catch (cause) {
      return { ok: false, code: 'NETWORK', error: `FCM request failed: ${String(cause?.name === 'TimeoutError' ? 'timeout' : cause?.message ?? cause)}`, invalidToken: false, retryable: true }
    }
  }

  return { send, accessToken }
}
