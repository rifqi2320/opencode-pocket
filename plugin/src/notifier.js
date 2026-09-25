// Notification policy core. Host-agnostic: the OpenCode wiring lives in index.js.
// Everything here is observational and fail-safe: errors are caught and logged, never thrown into OpenCode.
import { PROTOCOL_VERSION } from './rpc.js'

export const KINDS = /** @type {const} */ (['permission', 'question', 'failed', 'finished', 'interrupted', 'test'])
/** Kinds a server can push (everything but `test`); the `events` option narrows this list. */
export const EVENT_KINDS = KINDS.filter((kind) => kind !== 'test')
const PREFERENCE_FOR = { permission: 'needsPermission', question: 'needsAnswer', failed: 'sessionFailed', finished: 'sessionFinished', interrupted: 'sessionInterrupted' }
/** Session-outcome kinds that follow the root/subagent policy (requests always notify, subagents included). */
const OUTCOME = new Set(['failed', 'finished', 'interrupted'])
export const PREFERENCE_KEYS = ['needsPermission', 'needsAnswer', 'sessionFailed', 'sessionFinished', 'sessionInterrupted', 'includeSubagents', 'hideDetails']
/** Added after protocol 1 shipped; older apps omit them, so they default to false. */
const OPTIONAL_PREFERENCES = new Set(['sessionInterrupted', 'includeSubagents'])
const ATTENTION = new Set(['permission', 'question'])
export const CHANNEL_ATTENTION = 'pocket-attention'
export const CHANNEL_UPDATES = 'pocket-updates'

const DAY = 86_400_000
export const DEFAULTS = {
  throttleMs: 10_000, // per device + session + kind
  deviceTtlMs: 90 * DAY, // registrations not refreshed for 90 days expire
  sentTtlMs: 7 * DAY, // dedupe retention
  maxSent: 500, // bounded dedupe records in storage
  maxQueue: 200, // bounded in-memory work queue
  retryDelayMs: 3_000, // one bounded retry for transient FCM failures
  sessionCacheMs: 60_000,
  events: EVENT_KINDS, // kinds this server pushes at all; device preferences choose among them
  allowSubagents: true, // whether devices may opt into subagent outcome pushes
  minRunMs: 0, // finished pushes only for runs at least this long
  forceHideDetails: false, // generic text for every device regardless of its preference
}

export function truncate(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

const deviceKey = (deviceId) => `device/${encodeURIComponent(deviceId)}`
const sentKey = (key) => `sent/${encodeURIComponent(key)}`

/**
 * Builds the FCM v1 `message` object (without the top-level `{ message }` wrapper).
 * @param {{ device: any, kind: string, sessionId?: string, eventId: string, projectName: string, sessionTitle?: string, detail?: string, subagent?: boolean, forceHideDetails?: boolean }} input
 */
export function buildMessage({ device, kind, sessionId, eventId, projectName, sessionTitle, detail, subagent = false, forceHideDetails = false }) {
  const hide = forceHideDetails || !!device.preferences?.hideDetails
  const attention = ATTENTION.has(kind)
  const project = truncate(projectName || 'OpenCode', 40)
  const title = truncate(sessionTitle || 'Untitled session', 60)
  const who = subagent ? 'subagent' : 'session'
  let notification
  if (hide) {
    const bodies = {
      permission: 'A session needs your attention',
      question: 'A session needs your attention',
      failed: 'A session stopped with an error',
      finished: 'A session finished',
      interrupted: 'A session was interrupted',
      test: 'Test notification',
    }
    notification = { title: attention ? 'OpenCode needs you' : 'Session update', body: bodies[kind] }
  } else if (kind === 'permission') {
    notification = { title: `${project}: permission needed`, body: truncate(`${title} · ${detail ?? ''}`, 120) }
  } else if (kind === 'question') {
    notification = { title: `${project}: question`, body: truncate(detail || title, 120) }
  } else if (kind === 'failed') {
    notification = { title: `${project}: ${who} failed`, body: truncate(detail ? `${title} · ${detail}` : title, 120) }
  } else if (kind === 'finished') {
    notification = { title: `${project}: ${who} finished`, body: truncate(title, 120) }
  } else if (kind === 'interrupted') {
    notification = { title: `${project}: ${who} interrupted`, body: truncate(title, 120) }
  } else {
    notification = { title: 'Pocket Control', body: truncate(`Notifications from ${project} are working`, 120) }
  }
  const tag = `${kind}-${sessionId ?? 'none'}`.slice(0, 64)
  /** @type {Record<string, string>} */
  const data = { pocket: '1', pairingId: String(device.pairingId), kind, eventId: String(eventId) }
  if (sessionId) data.sessionId = String(sessionId)
  return {
    token: device.fcmToken,
    notification,
    data,
    android: {
      priority: 'HIGH',
      collapse_key: tag,
      ttl: '86400s',
      notification: { channel_id: attention ? CHANNEL_ATTENTION : CHANNEL_UPDATES, tag },
    },
    apns: {
      headers: { 'apns-priority': '10', 'apns-collapse-id': tag },
      payload: { aps: { sound: 'default', ...(sessionId ? { 'thread-id': String(sessionId) } : {}) } },
    },
  }
}

/** Validates an upsertDevice input. Returns an error string or undefined. */
export function validateDevice(input) {
  if (!input || typeof input !== 'object') return 'input must be an object'
  for (const [key, max] of [['deviceId', 200], ['fcmToken', 4096], ['pairingId', 200]]) {
    const v = input[key]
    if (typeof v !== 'string' || v.length === 0 || v.length > max) return `${key} must be a non-empty string`
  }
  if (input.platform !== 'android' && input.platform !== 'ios') return 'platform must be android or ios'
  const p = input.preferences
  if (!p || typeof p !== 'object') return 'preferences must be an object'
  for (const key of PREFERENCE_KEYS) {
    if (p[key] === undefined && OPTIONAL_PREFERENCES.has(key)) continue
    if (typeof p[key] !== 'boolean') return `preferences.${key} must be a boolean`
  }
  return undefined
}

/**
 * @param {{
 *   storage: { get(k: string): Promise<any>, set(k: string, v: any): Promise<void>, remove(k: string): Promise<void>, scan(o: { prefix: string, after?: string, limit?: number }): Promise<{ entries: readonly { key: string, value: any }[], next?: string }> },
 *   sender?: { send(message: any): Promise<any> } | null,
 *   pluginVersion: string,
 *   projectName: string,
 *   lookupSession?: (sessionId: string) => Promise<{ title?: string, parentID?: string } | undefined>,
 *   now?: () => number,
 *   log?: (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void,
 *   sleep?: (ms: number) => Promise<void>,
 *   config?: Partial<typeof DEFAULTS>,
 * }} deps
 */
export function createNotifier(deps) {
  const { storage, sender = null, pluginVersion, projectName } = deps
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const cfg = { ...DEFAULTS, ...(deps.config ?? {}) }

  const queue = []
  const running = new Map() // sessionId -> start time, for sessions observed active since this process started
  const resolved = new Set() // permission/form ids resolved before a push went out
  const sessions = new Map() // sessionId -> { title?, parentID?, known: boolean, at }
  const sentMemory = new Set()
  const throttle = new Map()
  let working
  let stopped = false
  let sentWrites = 0

  const safe = async (label, fn, fallback) => {
    try {
      return await fn()
    } catch (cause) {
      log('warn', `pocket: ${label} failed`, { error: String(cause?.message ?? cause) })
      return fallback
    }
  }

  // ---------- devices ----------
  async function listDevices() {
    const devices = []
    let after
    for (let page = 0; page < 50; page++) {
      const res = await storage.scan({ prefix: 'device/', after, limit: 100 })
      for (const entry of res.entries) {
        const d = entry.value
        if (!d || typeof d !== 'object' || typeof d.fcmToken !== 'string') continue
        if (typeof d.refreshedAt === 'number' && now() - d.refreshedAt > cfg.deviceTtlMs) {
          await safe('expire device', () => storage.remove(entry.key))
          continue
        }
        devices.push(d)
      }
      if (!res.next) break
      after = res.next
    }
    return devices
  }

  async function upsertDevice(input) {
    const error = validateDevice(input)
    if (error) throw new Error(error)
    const record = {
      deviceId: input.deviceId,
      fcmToken: input.fcmToken,
      platform: input.platform,
      pairingId: input.pairingId,
      preferences: Object.fromEntries(PREFERENCE_KEYS.map((key) => [key, input.preferences[key] === true])),
      refreshedAt: now(),
    }
    await storage.set(deviceKey(input.deviceId), record)
    log('info', 'pocket: device registered', { platform: record.platform })
    return { ok: true }
  }

  async function removeDevice(input) {
    if (input && typeof input.deviceId === 'string' && input.deviceId) await storage.remove(deviceKey(input.deviceId))
    return { ok: true }
  }

  async function getDevice(deviceId) {
    const d = await storage.get(deviceKey(deviceId))
    return d && typeof d === 'object' && typeof d.fcmToken === 'string' ? d : undefined
  }

  /** Sends one message; prunes the device on an invalid token; one bounded retry for transient errors. */
  async function deliver(device, message, { retry = true } = {}) {
    let result = await sender.send(message)
    if (!result.ok && result.retryable && retry && !stopped) {
      await sleep(cfg.retryDelayMs)
      result = await sender.send(message)
    }
    if (!result.ok && result.invalidToken) {
      // Only prune if the stored token is still the one that failed (the app may have re-registered meanwhile).
      const current = await safe('read device', () => getDevice(device.deviceId))
      if (current && current.fcmToken === device.fcmToken) await safe('prune device', () => storage.remove(deviceKey(device.deviceId)))
      log('info', 'pocket: removed device with invalid FCM registration', { code: result.code })
    } else if (!result.ok) {
      log('warn', 'pocket: FCM send failed', { code: result.code })
    }
    return result
  }

  async function testNotification(input) {
    if (!sender) return { ok: false, error: 'Notifications are not configured on the server (missing Firebase credentials)' }
    const device = await getDevice(input?.deviceId)
    if (!device) return { ok: false, error: 'Device is not registered' }
    const message = buildMessage({ device, kind: 'test', eventId: `test-${now().toString(36)}`, projectName, forceHideDetails: cfg.forceHideDetails })
    const result = await deliver(device, message, { retry: false })
    if (result.ok) return { ok: true }
    return { ok: false, error: result.invalidToken ? `${result.error} (device registration removed)` : result.error }
  }

  function info() {
    return { protocolVersion: PROTOCOL_VERSION, pluginVersion, notificationsConfigured: !!sender, events: [...cfg.events], subagents: cfg.allowSubagents }
  }

  // ---------- event intake (cheap, synchronous) ----------
  function rememberSession(sessionId, patch) {
    const prev = sessions.get(sessionId) ?? { known: false }
    sessions.set(sessionId, { ...prev, ...patch, at: now() })
  }

  function enqueue(job) {
    if (queue.length >= cfg.maxQueue) {
      log('warn', 'pocket: notification queue full, dropping job', { kind: job.kind })
      return
    }
    queue.push(job)
    schedule()
  }

  /** Classifies one OpenCode event. Never throws, never awaits. */
  function onEvent(event) {
    try {
      if (stopped || !event || typeof event.type !== 'string') return
      const d = event.data ?? {}
      switch (event.type) {
        case 'session.created':
          if (d.sessionID) rememberSession(d.sessionID, { title: d.title, parentID: d.parentID, known: true })
          return
        case 'session.renamed':
          if (d.sessionID && sessions.has(d.sessionID)) rememberSession(d.sessionID, { title: d.title })
          return
        case 'permission.asked':
          if (!d.id || !d.sessionID) return
          enqueue({
            kind: 'permission',
            sessionId: d.sessionID,
            eventId: d.id,
            dedupeKey: `permission/${d.id}`,
            detail: [d.action, ...(Array.isArray(d.resources) ? d.resources : [])].filter(Boolean).join(' '),
          })
          return
        case 'form.created': {
          const form = d.form ?? {}
          if (!form.id || !form.sessionID) return
          enqueue({ kind: 'question', sessionId: form.sessionID, eventId: form.id, dedupeKey: `form/${form.id}`, detail: form.title })
          return
        }
        case 'permission.replied':
          if (d.requestID) resolved.add(d.requestID)
          return
        case 'form.replied':
        case 'form.cancelled':
          if (d.id) resolved.add(d.id)
          return
        case 'session.execution.started':
          if (d.sessionID) markRunning(d.sessionID)
          return
        case 'session.status':
          if (!d.sessionID) return
          if (d.status?.type === 'busy') markRunning(d.sessionID)
          else if (d.status?.type === 'idle') finish(d.sessionID, event)
          return
        case 'session.execution.succeeded':
        case 'session.idle':
          if (d.sessionID) finish(d.sessionID, event)
          return
        case 'session.execution.interrupted':
          if (!d.sessionID) return
          running.delete(d.sessionID)
          enqueue({ kind: 'interrupted', sessionId: d.sessionID, eventId: event.id, dedupeKey: `interrupted/${d.sessionID}/${event.durable?.seq ?? event.id}` })
          return
        case 'session.execution.failed':
          if (!d.sessionID) return
          running.delete(d.sessionID)
          enqueue({
            kind: 'failed',
            sessionId: d.sessionID,
            eventId: event.id,
            dedupeKey: `failed/${d.sessionID}/${event.durable?.seq ?? event.id}`,
            detail: d.error?.message,
          })
          return
        default:
      }
    } catch (cause) {
      log('warn', 'pocket: event classification failed', { error: String(cause?.message ?? cause) })
    }
  }

  function markRunning(sessionId) {
    if (!running.has(sessionId)) running.set(sessionId, now())
  }

  // A finished push needs an observed active -> inactive boundary in this process (conservative after restarts).
  function finish(sessionId, event) {
    const startedAt = running.get(sessionId)
    if (startedAt === undefined) return
    running.delete(sessionId)
    if (now() - startedAt < cfg.minRunMs) return
    enqueue({ kind: 'finished', sessionId, eventId: event.id, dedupeKey: `finished/${sessionId}/${event.durable?.seq ?? event.id}` })
  }

  // ---------- worker ----------
  function schedule() {
    if (working || stopped) return
    working = (async () => {
      while (queue.length && !stopped) {
        const job = queue.shift()
        await safe(`process ${job.kind}`, () => process(job))
      }
    })().finally(() => {
      working = undefined
      if (queue.length && !stopped) schedule()
    })
  }

  async function resolveSession(sessionId) {
    const cached = sessions.get(sessionId)
    if (cached?.known && now() - cached.at < cfg.sessionCacheMs) return cached
    if (!deps.lookupSession) return cached
    const info = await safe('session lookup', () => deps.lookupSession(sessionId))
    if (!info) return cached
    const next = { title: info.title, parentID: info.parentID, known: true, at: now() }
    sessions.set(sessionId, next)
    return next
  }

  async function alreadySent(key) {
    if (sentMemory.has(key)) return true
    const stored = await safe('dedupe read', () => storage.get(sentKey(key)))
    if (stored != null) {
      sentMemory.add(key)
      return true
    }
    return false
  }

  async function markSent(key) {
    sentMemory.add(key)
    if (sentMemory.size > cfg.maxSent * 2) sentMemory.clear()
    await safe('dedupe write', () => storage.set(sentKey(key), now()))
    if (++sentWrites % 50 === 0) await compact()
  }

  async function process(job) {
    if (!sender) return
    if (!cfg.events.includes(job.kind)) return
    if (resolved.has(job.eventId)) return
    if (await alreadySent(job.dedupeKey)) return
    const session = await resolveSession(job.sessionId)
    // Outcome policy: subagent outcomes go only to devices that opted in (and only if the server allows it).
    // Finished pushes also need the session to be known, so an unresolved lookup never looks like a root.
    const subagent = !!session?.parentID
    if (OUTCOME.has(job.kind) && subagent && !cfg.allowSubagents) return
    if (job.kind === 'finished' && !session?.known) return
    const devices = (await safe('list devices', listDevices, [])).filter((d) =>
      d.preferences?.[PREFERENCE_FOR[job.kind]] === true && !(OUTCOME.has(job.kind) && subagent && d.preferences?.includeSubagents !== true))
    await markSent(job.dedupeKey) // mark first: losing a push is preferable to duplicates
    if (resolved.has(job.eventId)) return
    for (const device of devices) {
      if (stopped) return
      const tKey = `${device.deviceId}|${job.sessionId}|${job.kind}`
      const last = throttle.get(tKey)
      if (last !== undefined && now() - last < cfg.throttleMs) continue
      throttle.set(tKey, now())
      if (throttle.size > 1000) for (const [k, t] of throttle) if (now() - t > cfg.throttleMs) throttle.delete(k)
      const message = buildMessage({
        device,
        kind: job.kind,
        sessionId: job.sessionId,
        eventId: job.eventId,
        projectName,
        sessionTitle: session?.title,
        detail: job.detail,
        subagent: OUTCOME.has(job.kind) && subagent,
        forceHideDetails: cfg.forceHideDetails,
      })
      await safe('deliver', () => deliver(device, message))
    }
  }

  /** Drops expired dedupe records and bounds their count. */
  async function compact() {
    await safe('compact', async () => {
      const entries = []
      let after
      for (let page = 0; page < 100; page++) {
        const res = await storage.scan({ prefix: 'sent/', after, limit: 200 })
        entries.push(...res.entries)
        if (!res.next) break
        after = res.next
      }
      const cutoff = now() - cfg.sentTtlMs
      const alive = []
      for (const e of entries) {
        if (typeof e.value !== 'number' || e.value < cutoff) await storage.remove(e.key)
        else alive.push(e)
      }
      alive.sort((a, b) => a.value - b.value)
      for (const e of alive.slice(0, Math.max(0, alive.length - cfg.maxSent))) await storage.remove(e.key)
    })
  }

  return {
    info,
    upsertDevice,
    removeDevice,
    testNotification,
    onEvent,
    compact,
    listDevices,
    /** Resolves when the queue is drained (tests). */
    async idle() {
      while (working) await working
    },
    stop() {
      stopped = true
      queue.length = 0
    },
  }
}
