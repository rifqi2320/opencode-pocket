// Expo Push Service sender: no credentials needed. Expo holds the Firebase sender key; a device's Expo push token
// is the only thing that lets this server reach it. Never logs push tokens.

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts'
const EXPO_TOKEN = /^Expo(nent)?PushToken\[[^\]]+\]$/

export function isExpoToken(token) {
  return typeof token === 'string' && EXPO_TOKEN.test(token)
}

/** Converts the FCM-v1-shaped message built by the notifier into an Expo push message. */
export function toExpoMessage(message) {
  const ttl = Number.parseInt(String(message.android?.ttl ?? ''), 10)
  return {
    to: message.token,
    title: message.notification?.title,
    body: message.notification?.body,
    data: message.data,
    sound: 'default',
    priority: 'high',
    ...(Number.isFinite(ttl) ? { ttl } : {}),
    ...(message.android?.notification?.channel_id ? { channelId: message.android.notification.channel_id } : {}),
  }
}

/** Maps an Expo ticket/receipt error to the sender result shape shared with the FCM sender. */
export function classifyExpoError(details, message) {
  const code = typeof details?.error === 'string' ? details.error : 'EXPO_ERROR'
  return {
    code,
    error: `${code}: ${String(message ?? 'Expo push failed').slice(0, 300)}`,
    invalidToken: code === 'DeviceNotRegistered',
    retryable: code === 'MessageRateExceeded',
  }
}

/**
 * Creates an Expo sender. `send(message)` resolves to `{ ok: true, id }` or `{ ok: false, code, error, invalidToken, retryable }`
 * and never throws. Expo reports some failures (notably DeviceNotRegistered) only in delayed receipts, so accepted tickets
 * are remembered and `checkReceipts()` later returns the tokens that turned out to be invalid.
 * @param {{ accessToken?: string, fetch?: typeof fetch, now?: () => number, timeoutMs?: number, receiptDelayMs?: number, maxTickets?: number }} input
 */
export function createExpoSender({ accessToken, fetch: fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15000, receiptDelayMs = 15 * 60_000, maxTickets = 1000 } = {}) {
  const headers = { accept: 'application/json', 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) }
  const tickets = new Map() // ticket id -> { token, at }

  async function post(url, body) {
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
    return { response, body: await response.json().catch(() => ({})) }
  }

  async function send(message) {
    if (!isExpoToken(message?.token)) return { ok: false, code: 'NOT_EXPO_TOKEN', error: 'Device token is not an Expo push token', invalidToken: false, retryable: false }
    try {
      const { response, body } = await post(EXPO_PUSH_URL, toExpoMessage(message))
      const ticket = Array.isArray(body?.data) ? body.data[0] : body?.data
      if (response.ok && ticket?.status === 'ok') {
        if (typeof ticket.id === 'string') {
          tickets.set(ticket.id, { token: message.token, at: now() })
          if (tickets.size > maxTickets) tickets.delete(tickets.keys().next().value)
        }
        return { ok: true, id: ticket.id }
      }
      if (ticket?.status === 'error') return { ok: false, ...classifyExpoError(ticket.details, ticket.message) }
      const first = Array.isArray(body?.errors) ? body.errors[0] : undefined
      const code = typeof first?.code === 'string' ? first.code : `HTTP_${response.status}`
      const retryable = response.status === 429 || response.status >= 500
      return { ok: false, code, error: `${code}: ${String(first?.message ?? `Expo push failed with HTTP ${response.status}`).slice(0, 300)}`, invalidToken: false, retryable }
    } catch (cause) {
      return { ok: false, code: 'NETWORK', error: `Expo push failed: ${String(cause?.name === 'TimeoutError' ? 'timeout' : cause?.message ?? cause)}`, invalidToken: false, retryable: true }
    }
  }

  /** Fetches receipts for tickets older than `receiptDelayMs`; resolves to the push tokens Expo reported as unregistered. */
  async function checkReceipts() {
    const due = [...tickets].filter(([, t]) => now() - t.at >= receiptDelayMs).slice(0, 1000)
    if (!due.length) return []
    let body
    try {
      ;({ body } = await post(EXPO_RECEIPTS_URL, { ids: due.map(([id]) => id) }))
    } catch {
      return [] // try again next time
    }
    const receipts = body?.data && typeof body.data === 'object' ? body.data : {}
    const invalid = new Set()
    for (const [id, t] of due) {
      const receipt = receipts[id]
      if (receipt?.status === 'error' && classifyExpoError(receipt.details, receipt.message).invalidToken) invalid.add(t.token)
      // Expo keeps receipts for about a day; drop checked or long-missing tickets either way.
      if (receipt || now() - t.at > 24 * 3_600_000) tickets.delete(id)
    }
    return [...invalid]
  }

  return { send, checkReceipts }
}

/**
 * Routes each message by its device token: Expo push tokens go through Expo, anything else through direct FCM
 * (only when this server has its own Firebase credentials).
 * @param {{ expo?: ReturnType<typeof createExpoSender> | null, fcm?: { send(message: any): Promise<any> } | null }} senders
 */
export function createRoutingSender({ expo = null, fcm = null }) {
  return {
    transports: [...(expo ? ['expo'] : []), ...(fcm ? ['fcm'] : [])],
    async send(message) {
      const target = isExpoToken(message?.token) ? expo : fcm
      if (target) return target.send(message)
      return { ok: false, code: 'NO_TRANSPORT', error: isExpoToken(message?.token) ? 'Expo push is disabled on this server' : 'This server has no Firebase credentials for direct FCM delivery', invalidToken: false, retryable: false }
    },
    async checkReceipts() {
      return expo ? expo.checkReceipts() : []
    },
  }
}
