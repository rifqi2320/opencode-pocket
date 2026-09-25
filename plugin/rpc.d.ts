// Types for the Pocket RPC (`@pocket/opencode-plugin/rpc`). Wire: POST /api/rpc/pocket/{method} with body {"input": ...}.

export declare const PROTOCOL_VERSION: 1
export declare const RPC_ID: 'pocket'

export interface PocketInfo {
  protocolVersion: 1
  pluginVersion: string
  notificationsConfigured: boolean
  /** Kinds this server pushes (plugin option `events`). Missing on plugin 0.1.x. */
  events?: PocketEventKind[]
  /** Whether devices may opt into subagent outcome pushes (plugin option `subagents`). */
  subagents?: boolean
}

export interface DevicePreferences {
  needsPermission: boolean
  needsAnswer: boolean
  sessionFailed: boolean
  sessionFinished: boolean
  /** Optional; defaults to false. */
  sessionInterrupted?: boolean
  /** Also push finished/failed/interrupted for subagent sessions. Optional; defaults to false. */
  includeSubagents?: boolean
  hideDetails: boolean
}

export interface UpsertDeviceInput {
  deviceId: string
  fcmToken: string
  platform: 'android' | 'ios'
  pairingId: string
  preferences: DevicePreferences
}

export type PocketEventKind = 'permission' | 'question' | 'failed' | 'finished' | 'interrupted'
export type PocketNotificationKind = PocketEventKind | 'test'

/** FCM `data` payload (all values are strings). */
export interface PocketPushData {
  pocket: '1'
  pairingId: string
  kind: PocketNotificationKind
  /** permission request id, form id, session event id, or `test-*`. */
  eventId: string
  sessionId?: string
}

export type TestNotificationResult = { ok: true } | { ok: false; error: string }

type JsonSchema = Readonly<Record<string, unknown>>

/** Portable RPC definition (plain JSON Schema) usable with `client.rpc(pocketRpc)` from @opencode/client. */
export declare const pocketRpc: {
  readonly id: 'pocket'
  readonly methods: {
    readonly info: { readonly input: JsonSchema; readonly output: JsonSchema }
    readonly upsertDevice: { readonly input: JsonSchema; readonly output: JsonSchema }
    readonly removeDevice: { readonly input: JsonSchema; readonly output: JsonSchema }
    readonly testNotification: { readonly input: JsonSchema; readonly output: JsonSchema }
  }
  readonly events: {}
}
export declare const preferencesSchema: JsonSchema
export default pocketRpc
