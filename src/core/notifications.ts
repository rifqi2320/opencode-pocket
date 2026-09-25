import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { fetch as expoFetch } from "expo/fetch";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { authHeaders, classifyFetchError } from "./client";
import type { PocketCore } from "./core";
import { fetchApi } from "./http";
import { CHANNEL_ATTENTION, CHANNEL_UPDATES, NOTIFICATIONS_KEY, POCKET_PROTOCOL_VERSION, availablePreferences, deriveStatus, extractPushPayload, normalizePreferences, normalizeStore, parsePocketInfo, parseTestResult, pushTarget, rpcErrorType, rpcPath, shouldPresentForeground, unwrapRpcResult } from "./notificationLogic";
import type { NotificationPreferences, NotificationPrefKey, NotificationStatus, NotificationStore, PluginProbe, PushTarget, ServerNotificationRecord } from "./notificationLogic";

const rpcTimeoutMs = 15_000;
type Listener = () => void;
type RpcTarget = { url: string; password: string };
export type PocketRpcErrorKind = "missing" | "auth" | "network" | "tls" | "http" | "invalid";
export class PocketRpcError extends Error {
  constructor(message: string, readonly kind: PocketRpcErrorKind, readonly status?: number) { super(message); this.name = "PocketRpcError"; }
}

/**
 * The single Pocket plugin RPC boundary: `POST {server}/api/rpc/pocket/{method}` with the same Basic auth as core
 * requests (none for passwordless servers). Adjust envelope handling here (and in `unwrapRpcResult`) only.
 */
export async function callPocketRpc(target: RpcTarget, method: string, input: unknown = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchApi(expoFetch as unknown as typeof fetch, target.url, rpcPath(method), {}, undefined, {
      method: "POST", headers: { ...authHeaders(target.password), accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ input: input ?? {} }), redirect: "error", signal: AbortSignal.timeout(rpcTimeoutMs),
    } as RequestInit);
  } catch (error) { const kind = classifyFetchError(error); throw new PocketRpcError(kind === "tls" ? "Server TLS certificate could not be verified" : "Could not reach server", kind); }
  if (response.status === 404) throw new PocketRpcError("Pocket plugin is not installed on this server", "missing", 404);
  if (response.status === 401 || response.status === 403) throw new PocketRpcError(`Server rejected the credentials (${response.status})`, "auth", response.status);
  if (!response.ok) {
    let body: unknown; try { body = await response.json(); } catch { body = undefined; }
    const type = rpcErrorType(body);
    if (type === "rpc.unavailable" || type === "rpc.method_not_found") throw new PocketRpcError("Pocket plugin is not installed on this server", "missing", response.status);
    throw new PocketRpcError(typeof (body as any)?.message === "string" ? `Pocket plugin: ${(body as any).message}` : `Pocket plugin request failed (${response.status})`, "http", response.status);
  }
  if (response.status === 204) return undefined;
  let body: unknown; try { body = await response.json(); } catch { body = undefined; }
  try { return unwrapRpcResult(body); } catch (error) { throw new PocketRpcError((error as Error).message, "invalid", response.status); }
}

export type ServerNotificationView = {
  enabled: boolean;
  preferences: NotificationPreferences;
  /** Preference toggles this server's plugin supports (its `events` option), in display order. */
  available: NotificationPrefKey[];
  status: NotificationStatus;
  /** An enable/disable/preference/test request for this server is in flight. */
  busy: boolean;
};
export type NotificationsSnapshot = {
  /** True only on Android, the only platform with a push path today. */
  supported: boolean;
  platform: string;
  servers: Record<string, ServerNotificationView>;
};

/** Push registration against the optional Pocket plugin on each server. Never blocks core monitoring/control. */
export class PocketNotifications {
  private store: NotificationStore = { servers: {} };
  private probes = new Map<string, PluginProbe>();
  private probing = new Map<string, Promise<void>>();
  private lastErrors = new Map<string, string>();
  private busy = new Set<string>();
  private connected = new Map<string, boolean>();
  private listeners = new Set<Listener>();
  private permission: "granted" | "denied" | "undetermined" | undefined;
  private token: string | undefined;
  private viewingKey: string | undefined;
  private startPromise?: Promise<void>;
  private snapshot: NotificationsSnapshot = { supported: Platform.OS === "android", platform: Platform.OS, servers: {} };
  private profileIds = "";

  constructor(private core: PocketCore) {}

  start() { return this.startPromise ??= this.load(); }
  subscribe = (listener: Listener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  /** The session key (`${serverId}\u0000${sessionId}`) currently on screen; suppresses its foreground banner. */
  setViewing(key: string | undefined) { this.viewingKey = key; }

  /** Maps a tapped notification to a local server/session. Waits for local state so it also works on cold start. */
  async resolveTap(request: unknown): Promise<PushTarget | undefined> {
    await Promise.all([this.start(), this.core.start()]);
    return pushTarget(this.store, extractPushPayload(request), this.core.getSnapshot().profiles.map(p => p.id));
  }

  async enable(serverId: string) {
    if (Platform.OS !== "android") throw new Error(Platform.OS === "web" ? "Notifications are not available on web" : "Notifications are Android only for now");
    await this.start();
    return this.withBusy(serverId, async () => {
      let permission = await Notifications.getPermissionsAsync();
      if (!permission.granted && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
      this.permission = permission.granted ? "granted" : permission.canAskAgain ? "undetermined" : "denied";
      if (!permission.granted) throw new Error("Notification permission was not granted. Allow it in Android settings.");
      await this.probe(serverId, true);
      const probe = this.probes.get(serverId);
      if (probe?.state === "missing") throw new Error("Pocket plugin is not installed on this server");
      if (probe?.state === "unreachable" || probe?.state === "error") throw new Error(probe.message);
      if (probe?.state === "ok" && probe.info.protocolVersion !== POCKET_PROTOCOL_VERSION) throw new Error("This plugin version is not supported by the app");
      const record = this.recordFor(serverId);
      await this.register(serverId, record);
      record.enabled = true; this.lastErrors.delete(serverId); await this.persist();
    });
  }
  async disable(serverId: string) {
    await this.start();
    return this.withBusy(serverId, async () => {
      const record = this.store.servers[serverId]; if (!record) return;
      // Forget the pairing locally first: a stale push can no longer route here even if unregistering fails.
      this.store.servers[serverId] = { ...record, enabled: false, pairingId: randomId() }; this.lastErrors.delete(serverId); await this.persist();
      const target = await this.target(serverId);
      if (target && this.store.deviceId) await callPocketRpc(target, "removeDevice", { deviceId: this.store.deviceId }).catch(() => undefined);
    });
  }
  async setPreferences(serverId: string, patch: Partial<NotificationPreferences>) {
    await this.start();
    const record = this.recordFor(serverId);
    record.preferences = normalizePreferences({ ...record.preferences, ...patch }); await this.persist();
    if (!record.enabled) return;
    return this.withBusy(serverId, async () => {
      try { await this.register(serverId, record); this.lastErrors.delete(serverId); }
      catch (error) { this.lastErrors.set(serverId, messageOf(error)); throw error; }
    });
  }
  /** Asks the plugin to send a test push to this device. Resolves with the plugin's `{ ok, error? }`. */
  async sendTest(serverId: string): Promise<{ ok: boolean; error?: string }> {
    await this.start();
    return this.withBusy(serverId, async () => {
      const target = await this.target(serverId); if (!target || !this.store.deviceId) return { ok: false, error: "Server profile not found" };
      try { return parseTestResult(await callPocketRpc(target, "testNotification", { deviceId: this.store.deviceId })); }
      catch (error) { return { ok: false, error: messageOf(error) }; }
    });
  }
  /** Re-checks the plugin and, when enabled, re-registers this device. */
  refresh(serverId: string) { return this.probe(serverId, true); }

  private async load() {
    try { this.store = normalizeStore(JSON.parse((await AsyncStorage.getItem(NOTIFICATIONS_KEY)) || "{}")); } catch { this.store = { servers: {} }; }
    if (!this.store.deviceId) { this.store.deviceId = randomId(); await this.persist().catch(() => undefined); }
    this.core.onProfileRemoved((profile, password) => this.forget(profile.id, { url: profile.url, password }));
    if (Platform.OS === "android") {
      Notifications.setNotificationHandler({
        handleNotification: async notification => {
          const show = shouldPresentForeground(this.store, notification.request, this.viewingKey);
          return { shouldShowBanner: show, shouldShowList: true, shouldPlaySound: show, shouldSetBadge: false };
        },
      });
      // A push is only a hint that something changed: refresh that server's authoritative state.
      Notifications.addNotificationReceivedListener(notification => {
        const target = pushTarget(this.store, extractPushPayload(notification.request));
        if (target) void this.core.refresh(target.serverId).catch(() => undefined);
      });
      Notifications.addPushTokenListener(token => {
        const next = typeof token.data === "string" ? token.data : undefined;
        if (!next || next === this.token) return;
        this.token = next; void this.registerAllEnabled();
      });
      await Promise.all([
        Notifications.setNotificationChannelAsync(CHANNEL_ATTENTION, { name: "Needs you", importance: Notifications.AndroidImportance.HIGH }),
        Notifications.setNotificationChannelAsync(CHANNEL_UPDATES, { name: "Session updates", importance: Notifications.AndroidImportance.DEFAULT }),
      ]).catch(() => undefined);
      await this.readPermission();
      // The user can revoke/grant notifications in Android settings while the app is in the background.
      AppState.addEventListener("change", state => { if (state === "active") void this.readPermission().then(() => this.emit()); });
    }
    // Subscribe only after permission is known so the first (re)connect transition can refresh registrations.
    this.core.subscribe(this.onCoreChange);
    this.onCoreChange(); this.emit();
  }

  private async readPermission() {
    try { const permission = await Notifications.getPermissionsAsync(); this.permission = permission.granted ? "granted" : permission.canAskAgain ? "undetermined" : "denied"; } catch { /* keep the last known value */ }
  }
  /** Probe servers when they (re)connect; registration refresh rides on the same transition. */
  private onCoreChange = () => {
    const servers = this.core.getServers(); const ids = servers.map(s => s.profile.id);
    for (const server of servers) {
      const id = server.profile.id; const connected = server.info.data !== undefined && server.info.freshness === "fresh";
      const before = this.connected.get(id) ?? false; this.connected.set(id, connected);
      if (connected && !before && Platform.OS === "android") void this.probe(id, false);
    }
    for (const id of [...this.connected.keys()]) if (!ids.includes(id)) { this.connected.delete(id); this.probes.delete(id); this.lastErrors.delete(id); }
    const joined = ids.join("\u0000"); if (joined !== this.profileIds) { this.profileIds = joined; this.emit(); }
  };
  private probe(serverId: string, force: boolean): Promise<void> {
    const inflight = this.probing.get(serverId); if (inflight && !force) return inflight;
    const run = (async () => {
      if (!this.probes.has(serverId) || this.probes.get(serverId)?.state !== "ok") { this.probes.set(serverId, { state: "checking" }); this.emit(); }
      const target = await this.target(serverId); if (!target) return;
      try {
        const info = parsePocketInfo(await callPocketRpc(target, "info", {}));
        this.probes.set(serverId, info ? { state: "ok", info } : { state: "error", message: "Pocket plugin returned unexpected info" });
      } catch (error) {
        const kind = (error as PocketRpcError)?.kind;
        this.probes.set(serverId, kind === "missing" ? { state: "missing" } : kind === "network" || kind === "tls" ? { state: "unreachable", message: messageOf(error) } : { state: "error", message: messageOf(error) });
      }
      this.emit();
      const probe = this.probes.get(serverId); const record = this.store.servers[serverId];
      if (record?.enabled && probe?.state === "ok" && probe.info.protocolVersion === POCKET_PROTOCOL_VERSION && this.permission === "granted") {
        try { await this.register(serverId, record); this.lastErrors.delete(serverId); } catch (error) { this.lastErrors.set(serverId, messageOf(error)); }
        this.emit();
      }
    })().finally(() => { if (this.probing.get(serverId) === run) this.probing.delete(serverId); });
    this.probing.set(serverId, run); return run;
  }
  private async registerAllEnabled() {
    await Promise.all(Object.entries(this.store.servers).filter(([, record]) => record.enabled).map(async ([serverId, record]) => {
      const probe = this.probes.get(serverId); if (probe?.state !== "ok") return;
      try { await this.register(serverId, record); this.lastErrors.delete(serverId); } catch (error) { this.lastErrors.set(serverId, messageOf(error)); }
    }));
    this.emit();
  }
  private async register(serverId: string, record: ServerNotificationRecord) {
    const target = await this.target(serverId); if (!target) throw new Error("Server profile not found");
    const fcmToken = await this.pushToken();
    await callPocketRpc(target, "upsertDevice", { deviceId: this.store.deviceId, fcmToken, platform: "android", pairingId: record.pairingId, preferences: record.preferences });
  }
  private async pushToken() {
    if (this.token) return this.token;
    const token = await Notifications.getDevicePushTokenAsync();
    if (typeof token.data !== "string" || !token.data) throw new Error("Could not get a push token from Firebase");
    this.token = token.data; return this.token;
  }
  private async forget(serverId: string, target: RpcTarget) {
    await this.start();
    const record = this.store.servers[serverId];
    delete this.store.servers[serverId]; this.probes.delete(serverId); this.lastErrors.delete(serverId); await this.persist().catch(() => undefined);
    if (record?.enabled && this.store.deviceId) await callPocketRpc(target, "removeDevice", { deviceId: this.store.deviceId }).catch(() => undefined);
  }
  private async target(serverId: string): Promise<RpcTarget | undefined> {
    const profile = this.core.getSnapshot().profiles.find(p => p.id === serverId); if (!profile) return undefined;
    return { url: profile.url, password: await this.core.getPassword(serverId).catch(() => "") };
  }
  private recordFor(serverId: string) {
    return this.store.servers[serverId] ??= { pairingId: randomId(), enabled: false, preferences: normalizePreferences(undefined) };
  }
  private async withBusy<T>(serverId: string, work: () => Promise<T>) {
    this.busy.add(serverId); this.emit();
    try { return await work(); } finally { this.busy.delete(serverId); this.emit(); }
  }
  private async persist() { await AsyncStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(this.store)); this.emit(); }
  private emit() {
    const servers: Record<string, ServerNotificationView> = {};
    for (const profile of this.core.getSnapshot().profiles) {
      const record = this.store.servers[profile.id]; const lastError = this.lastErrors.get(profile.id);
      const probe = this.probes.get(profile.id) ?? { state: "unknown" as const };
      servers[profile.id] = {
        enabled: record?.enabled === true, preferences: record?.preferences ?? normalizePreferences(undefined), busy: this.busy.has(profile.id),
        available: availablePreferences(probe.state === "ok" ? probe.info : undefined),
        status: deriveStatus({ platform: Platform.OS, probe, ...(record ? { record } : {}), ...(this.permission ? { permission: this.permission } : {}), ...(lastError ? { lastError } : {}) }),
      };
    }
    this.snapshot = { supported: Platform.OS === "android", platform: Platform.OS, servers };
    this.listeners.forEach(listener => listener());
  }
}

function randomId() { return Crypto.randomUUID(); }
function messageOf(error: unknown) { return error instanceof Error && error.message ? error.message.replace(/https?:\/\/\S+/g, "[server URL]") : "Notification request failed"; }
