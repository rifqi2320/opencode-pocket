/** Pure notification helpers: no React Native / Expo imports so `node --test` can load this file directly. */

export const NOTIFICATIONS_KEY = "pocket.notifications.v1";
export const POCKET_PROTOCOL_VERSION = 1;
export const CHANNEL_ATTENTION = "pocket-attention";
export const CHANNEL_UPDATES = "pocket-updates";

export type NotificationPreferences = { needsPermission: boolean; needsAnswer: boolean; sessionFailed: boolean; sessionFinished: boolean; sessionInterrupted: boolean; includeSubagents: boolean; hideDetails: boolean };
export type NotificationPrefKey = keyof NotificationPreferences;
export const DEFAULT_PREFERENCES: NotificationPreferences = { needsPermission: true, needsAnswer: true, sessionFailed: true, sessionFinished: false, sessionInterrupted: false, includeSubagents: false, hideDetails: false };
/** Display order. `sessionInterrupted` and `includeSubagents` need plugin 0.2.0+. */
export const PREFERENCE_KEYS: readonly NotificationPrefKey[] = ["needsPermission", "needsAnswer", "sessionFailed", "sessionFinished", "sessionInterrupted", "includeSubagents", "hideDetails"];
/** Persisted per server profile. `enabled` stays false until the user turns notifications on. */
export type ServerNotificationRecord = { pairingId: string; enabled: boolean; preferences: NotificationPreferences };
export type NotificationStore = { deviceId?: string; servers: Record<string, ServerNotificationRecord> };
/** `events`/`subagents` come from plugin 0.2.0+ (its server options); older plugins omit them. */
export type PocketInfo = { protocolVersion: number; pluginVersion?: string; notificationsConfigured: boolean; events?: string[]; subagents?: boolean; transports?: string[] };
/** How this device's token reaches it: through the Expo Push Service, or direct FCM with the server's own Firebase key. */
export type PushTransport = "expo" | "fcm";
/** Plugin 0.3.0+ advertises `transports`; Expo is preferred because it needs no credentials on the server. Older plugins are FCM only. */
export function pushTransport(info?: PocketInfo): PushTransport {
  return info?.transports?.includes("expo") ? "expo" : "fcm";
}
/** Result of the last `info()` probe for a server. */
export type PluginProbe = { state: "unknown" } | { state: "checking" } | { state: "missing" } | { state: "unreachable"; message: string } | { state: "error"; message: string } | { state: "ok"; info: PocketInfo };
export type PushKind = "permission" | "question" | "failed" | "finished" | "interrupted" | "test";
export type PushData = { pairingId: string; kind: PushKind; sessionId?: string; eventId?: string };
export type NotificationStatusKind = "unsupported" | "checking" | "plugin-missing" | "plugin-unsupported" | "not-configured" | "unreachable" | "blocked" | "off" | "on" | "error";
export type NotificationStatus = { kind: NotificationStatusKind; label: string; tone: "neutral" | "success" | "warning" | "danger"; /** Whether the on/off control can be used. Turning off is always allowed. */ canToggle: boolean };

/** Tolerant storage parse: unknown/garbled entries fall back to defaults instead of throwing. */
export function normalizeStore(raw: unknown): NotificationStore {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const servers: Record<string, ServerNotificationRecord> = {};
  const rawServers = value.servers && typeof value.servers === "object" ? value.servers as Record<string, unknown> : {};
  for (const [id, entry] of Object.entries(rawServers)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.pairingId !== "string" || !record.pairingId) continue;
    servers[id] = { pairingId: record.pairingId, enabled: record.enabled === true, preferences: normalizePreferences(record.preferences) };
  }
  return { ...(typeof value.deviceId === "string" && value.deviceId ? { deviceId: value.deviceId } : {}), servers };
}
export function normalizePreferences(raw: unknown): NotificationPreferences {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return Object.fromEntries(PREFERENCE_KEYS.map(key => [key, typeof value[key] === "boolean" ? value[key] as boolean : DEFAULT_PREFERENCES[key]])) as NotificationPreferences;
}
const LEGACY_PREFERENCES: readonly NotificationPrefKey[] = ["needsPermission", "needsAnswer", "sessionFailed", "sessionFinished", "hideDetails"];
const PREFERENCE_FOR_EVENT: Record<string, NotificationPrefKey> = { permission: "needsPermission", question: "needsAnswer", failed: "sessionFailed", finished: "sessionFinished", interrupted: "sessionInterrupted" };
/** Toggles worth showing for a server: only kinds its plugin pushes (plugin option `events`). Unknown/older plugins get the original set. */
export function availablePreferences(info?: PocketInfo): NotificationPrefKey[] {
  if (!info?.events) return [...LEGACY_PREFERENCES];
  const kinds = new Set(info.events.map(kind => PREFERENCE_FOR_EVENT[kind]).filter((key): key is NotificationPrefKey => !!key));
  const outcomes = kinds.has("sessionFailed") || kinds.has("sessionFinished") || kinds.has("sessionInterrupted");
  if (info.subagents !== false && outcomes) kinds.add("includeSubagents");
  kinds.add("hideDetails");
  return PREFERENCE_KEYS.filter(key => kinds.has(key));
}

/** Plugin RPC responses may be the raw value or an `{ data }` envelope; an `{ error }` envelope throws. */
export function unwrapRpcResult(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const value = body as Record<string, unknown>;
  if ("output" in value) return value.output;
  if ("data" in value) return value.data;
  if ("error" in value && !("ok" in value)) {
    const error = value.error as any;
    throw new Error(typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "Pocket plugin returned an error");
  }
  return body;
}
export function parsePocketInfo(value: unknown): PocketInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const info = value as Record<string, unknown>;
  const protocolVersion = typeof info.protocolVersion === "number" ? info.protocolVersion : Number(info.protocolVersion);
  if (!Number.isFinite(protocolVersion)) return undefined;
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
  const events = strings(info.events); const transports = strings(info.transports);
  return { protocolVersion, ...(typeof info.pluginVersion === "string" ? { pluginVersion: info.pluginVersion } : {}), notificationsConfigured: info.notificationsConfigured === true,
    ...(events ? { events } : {}), ...(typeof info.subagents === "boolean" ? { subagents: info.subagents } : {}), ...(transports ? { transports } : {}) };
}
export function parseTestResult(value: unknown): { ok: boolean; error?: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "Unexpected response from the plugin" };
  const result = value as Record<string, unknown>;
  return result.ok === true ? { ok: true } : { ok: false, error: typeof result.error === "string" && result.error ? result.error : "The plugin could not send a test notification" };
}
/** OpenCode RPC errors arrive as HTTP 400 `{ _tag: "RpcError", type, message }`; `rpc.unavailable` means the plugin is not loaded. */
export function rpcErrorType(body: unknown): string | undefined {
  return body && typeof body === "object" && (body as any)._tag === "RpcError" && typeof (body as any).type === "string" ? (body as any).type : undefined;
}
export function rpcPath(method: string) { return `/api/rpc/pocket/${encodeURIComponent(method)}`; }

/** `platform` is Platform.OS; permission is the OS notification permission when known. */
export function deriveStatus(input: { platform: string; probe: PluginProbe; record?: ServerNotificationRecord; permission?: "granted" | "denied" | "undetermined"; lastError?: string }): NotificationStatus {
  const enabled = input.record?.enabled === true;
  if (input.platform === "web") return { kind: "unsupported", label: "Notifications are not available on web", tone: "neutral", canToggle: false };
  if (input.platform !== "android") return { kind: "unsupported", label: "Android only for now", tone: "neutral", canToggle: enabled };
  const probe = input.probe;
  if (probe.state === "unknown") return { kind: "checking", label: "Waiting for the server connection", tone: "neutral", canToggle: enabled };
  if (probe.state === "checking") return { kind: "checking", label: "Checking plugin…", tone: "neutral", canToggle: enabled };
  if (probe.state === "missing") return { kind: "plugin-missing", label: "Plugin not installed · see plugin/README.md", tone: "neutral", canToggle: enabled };
  if (probe.state === "unreachable") return { kind: "unreachable", label: "Server unreachable · can't check plugin", tone: "neutral", canToggle: enabled };
  if (probe.state === "error") return { kind: "error", label: probe.message, tone: "danger", canToggle: enabled };
  if (probe.info.protocolVersion !== POCKET_PROTOCOL_VERSION) return { kind: "plugin-unsupported", label: `Plugin protocol ${probe.info.protocolVersion} is not supported by this app`, tone: "warning", canToggle: enabled };
  if (enabled && input.permission === "denied") return { kind: "blocked", label: "Blocked in Android settings", tone: "warning", canToggle: true };
  if (enabled && input.lastError) return { kind: "error", label: input.lastError, tone: "danger", canToggle: true };
  if (!probe.info.notificationsConfigured) return { kind: "not-configured", label: "Plugin installed · push is turned off on the server", tone: "warning", canToggle: true };
  return enabled ? { kind: "on", label: "On", tone: "success", canToggle: true } : { kind: "off", label: "Off", tone: "neutral", canToggle: true };
}

const PUSH_KINDS: readonly PushKind[] = ["permission", "question", "failed", "finished", "interrupted", "test"];
/** Validates a push `data` payload. Anything not marked `pocket: '1'` is not ours. */
export function parsePushData(raw: unknown): PushData | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as Record<string, unknown>;
  if (String(data.pocket ?? "") !== "1" || typeof data.pairingId !== "string" || !data.pairingId) return undefined;
  const kind = PUSH_KINDS.includes(data.kind as PushKind) ? data.kind as PushKind : undefined;
  if (!kind) return undefined;
  return { pairingId: data.pairingId, kind, ...(typeof data.sessionId === "string" && data.sessionId ? { sessionId: data.sessionId } : {}), ...(typeof data.eventId === "string" ? { eventId: data.eventId } : {}) };
}
/** Maps an opaque pairingId back to the local server profile id (only among profiles that still exist). */
export function serverForPairing(store: NotificationStore, pairingId: string, profileIds?: readonly string[]) {
  for (const [serverId, record] of Object.entries(store.servers)) if (record.pairingId === pairingId && (!profileIds || profileIds.includes(serverId))) return serverId;
  return undefined;
}
export type PushTarget = { serverId: string; sessionId?: string; sessionKey?: string; kind: PushKind };
export function pushTarget(store: NotificationStore, raw: unknown, profileIds?: readonly string[]): PushTarget | undefined {
  const data = parsePushData(raw); if (!data) return undefined;
  const serverId = serverForPairing(store, data.pairingId, profileIds); if (!serverId) return undefined;
  return { serverId, kind: data.kind, ...(data.sessionId ? { sessionId: data.sessionId, sessionKey: `${serverId}\u0000${data.sessionId}` } : {}) };
}
/** Foreground presentation: show the banner unless the user is looking at that exact session right now. */
export function shouldPresentForeground(store: NotificationStore, request: unknown, viewingKey: string | undefined) {
  const target = pushTarget(store, extractPushPayload(request));
  return !(target?.sessionKey && viewingKey && target.sessionKey === viewingKey);
}
/** Pulls the data payload out of an expo-notifications request; Android can expose it in several places. */
export function extractPushPayload(request: unknown): Record<string, unknown> | undefined {
  const r = request as any;
  const candidates: unknown[] = [r?.content?.data, r?.trigger?.remoteMessage?.data];
  for (const text of [r?.content?.dataString, r?.content?.data?.dataString]) if (typeof text === "string") { try { candidates.push(JSON.parse(text)); } catch { /* not JSON */ } }
  for (const candidate of candidates) if (candidate && typeof candidate === "object" && String((candidate as Record<string, unknown>).pocket ?? "") === "1") return candidate as Record<string, unknown>;
  return undefined;
}
