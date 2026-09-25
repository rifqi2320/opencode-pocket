// Shared Pocket RPC definition. Import-safe for clients: no server code, no dependencies.
// Schemas are plain JSON Schema, which OpenCode v2 accepts as a portable RPC schema.

export const PROTOCOL_VERSION = 1
export const RPC_ID = 'pocket'

const str = (maxLength) => ({ type: 'string', minLength: 1, maxLength })
const ok = { type: 'object', properties: { ok: { const: true } }, required: ['ok'] }

export const preferencesSchema = {
  type: 'object',
  properties: {
    needsPermission: { type: 'boolean' },
    needsAnswer: { type: 'boolean' },
    sessionFailed: { type: 'boolean' },
    sessionFinished: { type: 'boolean' },
    hideDetails: { type: 'boolean' },
  },
  required: ['needsPermission', 'needsAnswer', 'sessionFailed', 'sessionFinished', 'hideDetails'],
}

export const pocketRpc = {
  id: RPC_ID,
  methods: {
    // Input is ignored; accept anything (including a missing input) so capability probes never fail on shape.
    info: {
      input: {},
      output: {
        type: 'object',
        properties: {
          protocolVersion: { const: PROTOCOL_VERSION },
          pluginVersion: { type: 'string' },
          notificationsConfigured: { type: 'boolean' },
        },
        required: ['protocolVersion', 'pluginVersion', 'notificationsConfigured'],
      },
    },
    upsertDevice: {
      input: {
        type: 'object',
        properties: {
          deviceId: str(200),
          fcmToken: str(4096),
          platform: { enum: ['android', 'ios'] },
          pairingId: str(200),
          preferences: preferencesSchema,
        },
        required: ['deviceId', 'fcmToken', 'platform', 'pairingId', 'preferences'],
      },
      output: ok,
    },
    removeDevice: {
      input: { type: 'object', properties: { deviceId: str(200) }, required: ['deviceId'] },
      output: ok,
    },
    testNotification: {
      input: { type: 'object', properties: { deviceId: str(200) }, required: ['deviceId'] },
      output: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, error: { type: 'string' } },
        required: ['ok'],
      },
    },
  },
  events: {},
}

export default pocketRpc
