// @pocket/opencode-plugin — OpenCode v2 server plugin that sends FCM push hints to Pocket Control.
// Observational only: uses ctx.event.subscribe + ctx.session.get, registers the `pocket` RPC,
// and never registers session/tool/permission hooks.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createFcmSender, loadCredentials } from './fcm.js'
import { createNotifier } from './notifier.js'
import { pocketRpc } from './rpc.js'

export const PLUGIN_ID = 'pocket'

export const PLUGIN_VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  } catch {
    return '0.0.0'
  }
})()

function makeLog(verbose) {
  return (level, message, extra) => {
    if (level === 'info' && !verbose) return
    try {
      const suffix = extra ? ` ${JSON.stringify(extra)}` : ''
      ;(level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`${message}${suffix}`)
    } catch {}
  }
}

function unwrap(value) {
  return value && typeof value === 'object' && 'data' in value && value.data && typeof value.data === 'object' && !('id' in value) ? value.data : value
}

/**
 * Plugin options (all optional):
 *   credentialsFile     path to a Firebase service-account JSON (else GOOGLE_APPLICATION_CREDENTIALS)
 *   firebaseProjectId   overrides project_id from the credentials file
 *   projectName         overrides the project name shown in notification titles
 *   throttleSeconds     per device+session+kind minimum interval (default 10)
 *   verbose             log info-level messages
 */
export async function setup(ctx) {
  const options = ctx.options ?? {}
  const log = makeLog(!!options.verbose)
  const location = ctx.location ?? {}
  const directory = location.directory
  const projectName = typeof options.projectName === 'string' && options.projectName
    ? options.projectName
    : path.basename(location.project?.directory || directory || '') || 'OpenCode'

  let sender = null
  try {
    const loaded = loadCredentials({ credentialsFile: typeof options.credentialsFile === 'string' ? options.credentialsFile : undefined })
    const projectId = (typeof options.firebaseProjectId === 'string' && options.firebaseProjectId) || (loaded.ok ? loaded.credentials.projectId : undefined)
    if (!loaded.ok) log('warn', `pocket: notifications disabled: ${loaded.reason}`)
    else if (!projectId) log('warn', 'pocket: notifications disabled: no Firebase project id')
    else sender = createFcmSender({ credentials: loaded.credentials, projectId })
  } catch (cause) {
    log('warn', 'pocket: notifications disabled: credential setup failed', { error: String(cause?.message ?? cause) })
  }

  const notifier = createNotifier({
    storage: ctx.storage,
    sender,
    pluginVersion: PLUGIN_VERSION,
    projectName,
    log,
    config: Number(options.throttleSeconds) >= 0 && options.throttleSeconds !== undefined ? { throttleMs: Number(options.throttleSeconds) * 1000 } : {},
    lookupSession: async (sessionID) => {
      const info = unwrap(await ctx.session.get({ sessionID }))
      return info && typeof info === 'object' ? { title: info.title, parentID: info.parentID } : undefined
    },
  })

  const registration = await ctx.rpc.register(pocketRpc, {
    info: async () => notifier.info(),
    upsertDevice: async (input) => notifier.upsertDevice(input),
    removeDevice: async (input) => notifier.removeDevice(input),
    testNotification: async (input) => {
      try {
        return await notifier.testNotification(input)
      } catch (cause) {
        return { ok: false, error: String(cause?.message ?? cause) }
      }
    },
  })

  const controller = new AbortController()
  const timers = []
  if (sender) {
    // One event subscription per plugin instance. The stream is server-wide, so only handle this instance's location.
    ;(async () => {
      let backoff = 1000
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            backoff = 1000
            const eventDir = event?.location?.directory
            if (eventDir && directory && eventDir !== directory) continue
            notifier.onEvent(event)
          }
        } catch (cause) {
          if (controller.signal.aborted) break
          log('warn', 'pocket: event stream error; resubscribing', { error: String(cause?.message ?? cause) })
        }
        if (controller.signal.aborted) break
        await new Promise((r) => { const t = setTimeout(r, backoff); timers.push(t) })
        backoff = Math.min(backoff * 2, 30_000)
      }
    })().catch(() => {})
    const t = setTimeout(() => { notifier.compact().catch(() => {}) }, 5_000)
    timers.push(t)
    t.unref?.()
  }

  return async () => {
    controller.abort()
    notifier.stop()
    for (const t of timers) clearTimeout(t)
    try { await registration.dispose() } catch {}
  }
}

export default { id: PLUGIN_ID, setup }
