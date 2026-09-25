import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { fetch as expoFetch } from "expo/fetch";
import { authHeaders, classifyFetchError, classifyHttpError, makeClient, reconnectDelay } from "./client";
import { secretKey } from "./credentialStore";
import { deleteCredential, getCredential, setCredential } from "./credentials";
import { fetchApi } from "./http";
import { reconcileSnapshot } from "./status";
import type { CoreError, PendingForm, PendingPermission, ProfileInput, PromptDelivery, PromptReceipt, ResourceState, ServerProfile, ServerSnapshot, SessionMessage, SessionRecord, SessionSnapshot } from "./types";
import { CoreError as CoreErrorClass } from "./types";

const PROFILES_KEY = "pocket.profiles.v1";
const RECEIPTS_KEY = "pocket.receipts.v1";
const PAGE_SIZE = 50;
const LIST_PAGE_SIZE = 100;
/** Home inventory covers sessions updated within this window; older work is reachable through search. */
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const requestTimeoutMs = 20_000;
/** Event-driven refresh passes run at most this often per server (throttle, not debounce). */
const minRefreshIntervalMs = 2_000;
type Listener = () => void;
type Runtime = { profile: ServerProfile; password: string; client: ReturnType<typeof makeClient>; headers: Record<string, string>; generation: number; writeCompatible?: boolean; authRejected?: boolean; stop?: () => void; abort?: AbortController; refreshTimer?: ReturnType<typeof setTimeout>; dirty: Map<string, number>; seenDirty: Map<string, number>; refreshing: Set<string>; inflight?: Promise<void>; refreshQueued?: "full" | "events"; lastRefreshAt?: number; snapshot: ServerSnapshot };
const blankResource = <T,>(): ResourceState<T> => ({ freshness: "offline" });

/** Core state and operations. Subscribe with `subscribe` and read snapshots using `getSnapshot`. */
export class PocketCore {
  private profiles: ServerProfile[] = [];
  private runtimes = new Map<string, Runtime>();
  private sessions = new Map<string, SessionSnapshot>();
  private receipts: PromptReceipt[] = [];
  private listeners = new Set<Listener>();
  private selectedKey: string | undefined;
  private removalHooks = new Set<(profile: ServerProfile, password: string) => void | Promise<void>>();

  private startPromise?: Promise<void>;
  /** Idempotent; resolves once saved profiles are loaded and their connections have been started. */
  start() { return this.startPromise ??= this.load(); }
  private async load() {
    try {
      this.profiles = asArray<ServerProfile>(JSON.parse((await AsyncStorage.getItem(PROFILES_KEY)) || "[]"));
      this.receipts = asArray<PromptReceipt>(JSON.parse((await AsyncStorage.getItem(RECEIPTS_KEY)) || "[]"));
    } catch { this.profiles = []; this.receipts = []; }
    this.emit();
    await Promise.all(this.profiles.map(async profile => {
      // Passwords are optional: a missing credential means "no password", so every saved profile connects.
      // A secure-store read failure also connects without one; the server's 401 then surfaces as auth-error.
      const password = await getCredential(secretKey(profile.id)).catch(() => null);
      this.connect(profile, password ?? ""); void this.refresh(profile.id).catch(() => undefined);
    }));
  }
  /** Best-effort cleanup hooks (e.g. push unregistration), called with the removed profile and its password. */
  onProfileRemoved = (hook: (profile: ServerProfile, password: string) => void | Promise<void>) => { this.removalHooks.add(hook); return () => { this.removalHooks.delete(hook); }; };
  subscribe = (listener: Listener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => {
    const sessions = Array.from(this.sessions.values());
    const selectedSession = this.selectedKey ? this.sessions.get(this.selectedKey) : undefined;
    return { profiles: this.profiles, servers: this.getServers(), sessions, receipts: this.receipts,
      ...(selectedSession ? { selectedSession } : {}), ...(this.selectedKey ? { selectedKey: this.selectedKey } : {}) };
  };
  getServers = () => this.profiles.map(p => this.runtimes.get(p.id)?.snapshot ?? this.emptyServer(p));
  getSession = (serverId: string, sessionId: string) => this.sessions.get(key(serverId, sessionId));
  getReceipts = () => this.receipts;
  /** Saved password, or "" when the profile has none (passwords are optional). */
  async getPassword(serverId: string) { return (await getCredential(secretKey(serverId))) ?? ""; }

  /** Throws CoreError with kind network | tls | auth | incompatible | http so the UI can say what to fix. */
  async testConnection(input: ProfileInput, password = "") {
    validateEndpoint(input.url);
    let response: Response;
    try { response = await expoFetch(`${normalizeUrl(input.url)}/api/info`, { headers: { ...authHeaders(password), accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(requestTimeoutMs) } as RequestInit); }
    catch (error) { throw fetchFailure(error); }
    if (!response.ok) {
      const kind = classifyHttpError(response.status);
      throw new CoreErrorClass(kind === "auth" ? `Server rejected the credentials (${response.status})` : kind === "incompatible" ? "Server does not expose the OpenCode v2 API (404)" : `OpenCode request failed (${response.status})`, kind, response.status);
    }
    let result: any; try { result = await response.json(); } catch { result = undefined; }
    const info = result?.data ?? result;
    if (!info || typeof info !== "object" || Array.isArray(info)) throw new CoreErrorClass("Server did not return OpenCode info; is this an OpenCode v2 endpoint?", "incompatible", response.status);
    return info as Record<string, unknown>;
  }
  saveServer = (input: ProfileInput, password = "") => this.addProfile(input, password);
  removeServer = (serverId: string) => this.removeProfile(serverId);
  async selectSession(serverId: string, sessionId: string) {
    this.selectedKey = key(serverId, sessionId); this.getOrCreateSession(serverId, sessionId); this.emit();
    return this.loadSession(serverId, sessionId);
  }
  /** Server-side title search across all history (not limited to the recent window). Results are cached as session metadata so they can be opened. */
  async searchSessions(query: string, limit = 50): Promise<Record<string, SessionRecord[]>> {
    const text = query.trim(); if (!text) return {};
    const results: Record<string, SessionRecord[]> = {};
    await Promise.all(Array.from(this.runtimes.values()).map(async rt => {
      try {
        const result: any = await this.getRaw(rt, "/api/session", { search: text, limit, order: "desc" });
        const rows = (Array.isArray(result) ? result : result?.data ?? []).map(normalizeSession) as SessionRecord[];
        for (const row of rows) { const state = this.getOrCreateSession(rt.profile.id, row.id); if (!state.metadata.data) state.metadata = fresh(row); }
        // A subagent hit is shown through its root family, so walk each hit up to its ancestors.
        const byId = new Map(rows.map(row => [row.id, row]));
        for (const row of rows) {
          let parentId = row.parentID;
          for (let depth = 0; parentId && !byId.has(parentId) && depth < 20; depth++) {
            const state = this.getOrCreateSession(rt.profile.id, parentId);
            const parent = state.metadata.data ?? await this.get<SessionRecord>(rt, `/api/session/${enc(parentId)}`).then(normalizeSession).catch(() => undefined);
            if (!parent) break;
            if (!state.metadata.data) state.metadata = fresh(parent);
            byId.set(parent.id, parent); parentId = parent.parentID;
          }
        }
        results[rt.profile.id] = [...byId.values()];
      } catch { /* A failing server is omitted from results; its status card already reports the failure. */ }
    }));
    return results;
  }
  async refreshAll() { await Promise.all(this.profiles.map(profile => this.refresh(profile.id).catch(() => undefined))); }

  async addProfile(input: ProfileInput, password = "") {
    validateEndpoint(input.url);
    const profile: ServerProfile = { ...input, id: input.id ?? uuid(), url: normalizeUrl(input.url) };
    if (this.profiles.some(p => p.id === profile.id)) throw new Error("A profile with this ID already exists");
    await setCredential(secretKey(profile.id), password);
    this.profiles = [...this.profiles, profile];
    await this.persistProfiles(); this.connect(profile, password); this.emit();
    await this.refresh(profile.id);
    return profile;
  }
  async updateProfile(id: string, input: ProfileInput, password?: string) {
    const old = this.profiles.find(p => p.id === id); if (!old) throw new Error("Server profile not found");
    validateEndpoint(input.url);
    const next = { ...input, id, url: normalizeUrl(input.url) };
    const changed = old.url !== next.url || password !== undefined;
    if (changed) { this.disconnect(id); if (password !== undefined) await setCredential(secretKey(id), password); }
    this.profiles = this.profiles.map(p => p.id === id ? next : p);
    await this.persistProfiles();
    if (changed) { const secret = password ?? (await getCredential(secretKey(id)).catch(() => null)) ?? ""; this.dropSessionCache(id); this.connect(next, secret); await this.refresh(id); }
    else { const rt = this.runtimes.get(id); if (rt) { rt.profile = next; rt.snapshot.profile = next; } } // rename only: keep the live connection, update the shown name
    this.emit(); return next;
  }
  async removeProfile(id: string) {
    const removed = this.profiles.find(p => p.id === id);
    const removedPassword = removed && this.removalHooks.size ? this.runtimes.get(id)?.password ?? (await getCredential(secretKey(id)).catch(() => null)) ?? "" : "";
    this.disconnect(id); this.profiles = this.profiles.filter(p => p.id !== id); this.dropSessionCache(id);
    if (this.selectedKey?.startsWith(`${id}\u0000`)) this.selectedKey = undefined;
    this.receipts = this.receipts.filter(r => r.serverId !== id);
    await Promise.all([this.persistProfiles(), this.persistReceipts()]); this.emit();
    if (removed) for (const hook of this.removalHooks) void Promise.resolve().then(() => hook(removed, removedPassword)).catch(() => undefined);
    await deleteCredential(secretKey(id)).catch(() => undefined); // a secure-store failure must not resurrect the removed profile
  }
  async connectProfile(id: string) {
    const profile = this.profiles.find(p => p.id === id); if (!profile) throw new Error("Server profile not found");
    const password = (await getCredential(secretKey(id))) ?? "";
    this.disconnect(id); this.connect(profile, password); return this.refresh(id);
  }
  /** Explicit refresh. Reconnects a profile that has no live runtime or was auth-rejected (e.g. after a server-side fix). */
  async refresh(serverId?: string): Promise<void> {
    if (!serverId) return this.refreshAll();
    const rt = this.runtimes.get(serverId);
    if (!rt || rt.authRejected) { if (!this.profiles.some(p => p.id === serverId)) throw new Error("Server profile not found"); return this.connectProfile(serverId); }
    return this.runRefresh(rt, true);
  }
  /** Coalesces overlapping passes: a request during an in-flight pass queues exactly one follow-up pass. */
  private runRefresh(rt: Runtime, full: boolean): Promise<void> {
    if (rt.inflight) { if (rt.refreshQueued !== "full") rt.refreshQueued = full ? "full" : "events"; return rt.inflight; }
    rt.lastRefreshAt = Date.now();
    const pass = this.refreshPass(rt, full).finally(() => {
      rt.inflight = undefined; const queued = rt.refreshQueued; rt.refreshQueued = undefined;
      if (queued && this.runtimes.get(rt.profile.id) === rt) void this.runRefresh(rt, queued === "full").catch(() => undefined);
    });
    rt.inflight = pass; return pass;
  }
  /** Full passes reload every cached transcript; event passes only the selected session and sessions with new events. */
  private async refreshPass(rt: Runtime, full: boolean) {
    const serverId = rt.profile.id; const generation = rt.generation;
    await Promise.all([this.refreshSessions(rt), this.refreshActive(rt), this.refreshLocations(rt), this.refreshInfo(rt)]);
    await this.refreshBlockers(rt);
    const listedRelationships = (rt.snapshot.sessions.data ?? []).filter(session => typeof session.parentID === "string" && session.parentID.length > 0).map(session => session.id);
    const discovered = new Set([...(rt.snapshot.activeSessionIds.data ?? []), ...(rt.snapshot.permissions.data ?? []).map(x => x.sessionID), ...(rt.snapshot.forms.data ?? []).map(x => x.sessionID), ...listedRelationships]);
    await Promise.all([...discovered].map(sessionId => this.ensureSessionMetadata(rt, sessionId)));
    const selected = this.selectedKey ? this.sessions.get(this.selectedKey) : undefined;
    const reload = Array.from(this.sessions.values()).filter(s => s.serverId === serverId && s.messages.data !== undefined && (this.consumeDirty(rt, `session:${s.sessionId}`) || full || s === selected));
    await Promise.all([...reload.map(s => this.loadMessages(serverId, s.sessionId).catch(() => undefined)),
      // Session-scoped requests back the selected session's action cards; refresh them so answered requests disappear.
      ...(selected?.serverId === serverId ? [this.loadSessionInbox(rt, selected, sessionDirectory(selected)), this.loadSessionPermissions(rt, selected, sessionDirectory(selected)), this.loadSessionForms(rt, selected, sessionDirectory(selected))] : [])]);
    await this.reconcileReceipts(rt);
    if (this.runtimes.get(serverId) === rt && generation === rt.generation) { rt.snapshot.lastSyncAt = Date.now(); this.emit(); }
  }
  async loadMessages(serverId: string, sessionId: string, cursor?: string) {
    const rt = this.requireRuntime(serverId); const state = this.getOrCreateSession(serverId, sessionId); state.messages = { ...state.messages, freshness: "syncing" }; this.emit();
    try {
      // Newest page first (order=desc); `cursor.next` then walks toward older messages. The API
      // rejects `order` combined with a cursor, so follow-up pages send the cursor alone.
      const result: any = await this.getRaw(rt, `/api/session/${enc(sessionId)}/message`, cursor ? { limit: PAGE_SIZE, cursor } : { limit: PAGE_SIZE, order: "desc" }, sessionDirectory(state));
      const rows = oldestFirst(asArray<SessionMessage>(result?.data ?? result).map(normalizeMessage));
      const existing = state.messages.data ?? [];
      // A refresh re-reads the newest page; keep any earlier pages the user already loaded.
      const overlap = !cursor && rows.length ? existing.findIndex(message => message.id === rows[0]!.id) : -1;
      const earlier = overlap > 0 ? existing.slice(0, overlap) : [];
      state.messages = { data: cursor ? mergeMessages(rows, existing) : [...earlier, ...rows], freshness: "fresh", observedAt: Date.now() };
      const nextCursor = result?.cursor?.next;
      if (!earlier.length) { if (typeof nextCursor === "string" && rows.length >= PAGE_SIZE) state.messageCursor = nextCursor; else delete state.messageCursor; }
    }
    catch (error) { state.messages = failed(state.messages, error); throw error; }
    this.emit(); return state.messages;
  }
  async loadMoreMessages(serverId: string, sessionId: string) {
    const cursor = this.getSession(serverId, sessionId)?.messageCursor;
    if (!cursor) return this.getSession(serverId, sessionId)?.messages;
    return this.loadMessages(serverId, sessionId, cursor);
  }
  async loadSession(serverId: string, sessionId: string) {
    const rt = this.requireRuntime(serverId); const state = this.getOrCreateSession(serverId, sessionId);
    state.metadata = { ...state.metadata, freshness: "syncing" }; this.emit();
    try { const metadata = normalizeSession(await this.get<SessionRecord>(rt, `/api/session/${enc(sessionId)}`)); state.metadata = fresh(metadata); }
    catch (error) { state.metadata = failed(state.metadata, error); throw error; }
    const directory = state.metadata.data?.directory;
    await Promise.all([this.loadMessages(serverId, sessionId), this.loadSessionInbox(rt, state, directory), this.loadSessionPermissions(rt, state, directory), this.loadSessionForms(rt, state, directory)]);
    return state;
  }
  async sendPrompt(serverId: string, sessionId: string, text: string, delivery: PromptDelivery = "steer") {
    if (!text.trim()) throw new Error("Prompt cannot be empty");
    const rt = this.requireRuntime(serverId); this.assertWritable(rt); const messageId = `msg_${uuid().replace(/-/g, "")}`;
    const receipt: PromptReceipt = { id: uuid(), serverId, sessionId, messageId, delivery, submittedAt: Date.now(), state: "sending" };
    this.receipts = [...this.receipts, receipt]; await this.persistReceipts(); this.emit();
    try {
      await this.post(rt, `/api/session/${enc(sessionId)}/prompt`, { id: messageId, text, delivery, resume: true }, sessionDirectory(this.getSession(serverId, sessionId)));
      this.patchReceipt(receipt.id, "accepted");
      this.invalidate(rt, `session:${sessionId}`);
      void this.loadMessages(serverId, sessionId).then(snapshot => {
        if (snapshot.data?.some(message => message.id === messageId)) this.patchReceipt(receipt.id, "observed");
      }).catch(() => undefined);
      return this.receipts.find(r => r.id === receipt.id)!;
    } catch (error) {
      const status = (error as CoreError)?.status;
      this.patchReceipt(receipt.id, status && status >= 400 && status < 500 ? "rejected" : "unknown");
      throw error;
    }
  }
  async interrupt(serverId: string, sessionId: string) {
    const rt = this.requireRuntime(serverId); this.assertWritable(rt);
    try { const result = await this.post(rt, `/api/session/${enc(sessionId)}/interrupt`, undefined, sessionDirectory(this.getSession(serverId, sessionId)), { resume: false }); this.invalidate(rt, `session:${sessionId}`); void this.loadSession(serverId, sessionId).catch(() => undefined); return result; }
    catch (error) { this.invalidate(rt, `session:${sessionId}`); throw error; }
  }
  async replyPermission(serverId: string, sessionId: string, requestId: string, reply: "once" | "reject") {
    const rt = this.requireRuntime(serverId); this.assertWritable(rt);
    try { const result = await this.post(rt, `/api/session/${enc(sessionId)}/permission/${enc(requestId)}/reply`, { decision: reply }, sessionDirectory(this.getSession(serverId, sessionId))); this.invalidate(rt, "blockers"); this.invalidate(rt, `session:${sessionId}`); return result; }
    catch (error) { this.invalidate(rt, "blockers"); throw error; }
  }
  async replyForm(serverId: string, sessionId: string, formId: string, answers: unknown) {
    const rt = this.requireRuntime(serverId); this.assertWritable(rt);
    try { const result = await this.post(rt, `/api/session/${enc(sessionId)}/form/${enc(formId)}/reply`, { answers }, sessionDirectory(this.getSession(serverId, sessionId))); this.invalidate(rt, "blockers"); this.invalidate(rt, `session:${sessionId}`); return result; }
    catch (error) { this.invalidate(rt, "blockers"); throw error; }
  }

  private connect(profile: ServerProfile, password: string) {
    const client = makeClient(profile.url, password, expoFetch); const snapshot = this.emptyServer(profile);
    const rt: Runtime = { profile, password, client, headers: authHeaders(password), generation: 1, dirty: new Map(), seenDirty: new Map(), refreshing: new Set(), snapshot };
    this.runtimes.set(profile.id, rt); snapshot.transport = "connecting"; this.emit(); this.startEvents(rt);
  }
  private disconnect(id: string) { const rt = this.runtimes.get(id); if (!rt) return; rt.generation++; rt.abort?.abort(); rt.stop?.(); if (rt.refreshTimer) clearTimeout(rt.refreshTimer); this.runtimes.delete(id); }
  private async startEvents(rt: Runtime) {
    let attempt = 0;
    while (this.runtimes.get(rt.profile.id) === rt) {
      rt.snapshot.transport = attempt ? "reconnecting" : "connecting"; this.emit();
      try {
        const iterable = (rt.client as any).event.subscribe();
        for await (const event of iterable) {
          if (this.runtimes.get(rt.profile.id) !== rt) return;
          attempt = 0; this.onEvent(rt, event);
        }
      } catch (error) {
        if (this.runtimes.get(rt.profile.id) !== rt) return;
        if ((error as CoreError)?.kind === "auth" || [401, 403].includes((error as any)?.status ?? (error as any)?.statusCode)) { rt.authRejected = true; rt.snapshot.transport = "auth-error"; this.emit(); return; }
      }
      if (this.runtimes.get(rt.profile.id) !== rt) return;
      if (rt.authRejected) return;
      rt.snapshot.transport = "reconnecting"; this.markStale(rt); this.emit(); void this.refresh(rt.profile.id).catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, reconnectDelay(attempt++)));
    }
  }
  private onEvent(rt: Runtime, event: any) {
    const type = String(event?.type ?? ""); const props = event?.properties ?? event?.data ?? {};
    const sessionId = props.sessionID ?? props.sessionId ?? props.info?.sessionID;
    if (/permission|form/i.test(type)) this.invalidate(rt, "blockers");
    if (/session|message|tool|pty|shell|inbox/i.test(type)) {
      if (sessionId) this.invalidate(rt, `session:${sessionId}`); else this.invalidate(rt, "sessions");
    } else this.invalidate(rt, "sessions");
    // Dirty counters are not part of the snapshot; only re-render when the transport state actually changes.
    if (rt.snapshot.transport !== "live") { rt.snapshot.transport = "live"; this.emit(); }
  }
  private invalidate(rt: Runtime, key: string) { rt.dirty.set(key, (rt.dirty.get(key) ?? 0) + 1); this.scheduleRefresh(rt); }
  private consumeDirty(rt: Runtime, key: string) { const count = rt.dirty.get(key) ?? 0; const changed = count !== (rt.seenDirty.get(key) ?? 0); rt.seenDirty.set(key, count); return changed; }
  /** Throttle: a continuous event stream (token streaming) must not keep postponing the refresh as a debounce would. */
  private scheduleRefresh(rt: Runtime) {
    if (rt.refreshTimer) return;
    const wait = Math.max(750, (rt.lastRefreshAt ?? 0) + minRefreshIntervalMs - Date.now());
    rt.refreshTimer = setTimeout(() => { rt.refreshTimer = undefined; if (this.runtimes.get(rt.profile.id) === rt) void this.runRefresh(rt, false).catch(() => undefined); }, wait);
  }
  private async refreshSessions(rt: Runtime) {
    const keyName = "sessions"; if (rt.refreshing.has(keyName)) return; rt.refreshing.add(keyName);
    const captured = rt.dirty.get(keyName) ?? 0; rt.snapshot.sessions = { ...rt.snapshot.sessions, freshness: "syncing" }; this.emit();
    try {
      // Newest first; stop paging at the first session older than the recent window instead of walking all history.
      const all: SessionRecord[] = []; let cursor: string | undefined; let pages = 0; const cutoff = Date.now() - RECENT_WINDOW_MS;
      do {
        // `order` applies to the first page only; the cursor carries direction afterwards.
        const result: any = await this.getRaw(rt, "/api/session", { limit: LIST_PAGE_SIZE, ...(cursor ? { cursor } : { order: "desc" }) });
        const page: SessionRecord[] = Array.isArray(result) ? result : result.data ?? result.items ?? result.sessions ?? [];
        const recent = page.filter(session => sessionUpdatedAt(session) >= cutoff);
        // The server returns a `next` cursor even on the last page, so a short page also ends the walk.
        all.push(...recent); cursor = Array.isArray(result) || recent.length < page.length || page.length < LIST_PAGE_SIZE ? undefined : result.cursor?.next ?? result.nextCursor ?? result.next_cursor;
        if (++pages >= 50) { cursor = undefined; rt.snapshot.coverage.sessions = "partial"; rt.snapshot.coverage.reason = "Session pagination safety limit reached"; }
      } while (cursor);
       const normalized = all.map(normalizeSession);
       rt.snapshot.sessions = fresh(normalized); if (rt.snapshot.coverage.sessions !== "partial") rt.snapshot.coverage.sessions = "complete";
       for (const session of normalized) this.getOrCreateSession(rt.profile.id, session.id).metadata = fresh(session);
    } catch (error) { rt.snapshot.sessions = failed(rt.snapshot.sessions, error); rt.snapshot.coverage.sessions = "partial"; }
    finally { rt.refreshing.delete(keyName); }
    const rec = reconcileSnapshot({ value: 0, dirtyAtStart: captured, generation: rt.generation }, rt.generation, rt.dirty.get(keyName) ?? 0);
    this.emit(); if (rec.dirty) void this.refreshSessions(rt);
  }
  private async refreshActive(rt: Runtime) {
    try { const rows = await this.get<any>(rt, "/api/session/active"); const ids = Array.isArray(rows) ? rows.map((x: any) => typeof x === "string" ? x : x.id ?? x.sessionID).filter(Boolean) : Object.keys(rows ?? {}); rt.snapshot.activeSessionIds = fresh(ids); }
    catch (error) { rt.snapshot.activeSessionIds = failed(rt.snapshot.activeSessionIds, error); }
    this.emit();
  }
  private async refreshLocations(rt: Runtime) {
    try { const rows = await this.get<any[]>(rt, "/api/debug/location"); rt.snapshot.locations = fresh(asArray(rows).map((x: any) => typeof x === "string" ? x : x.directory ?? x.path).filter(Boolean)); }
    catch (error) { rt.snapshot.locations = failed(rt.snapshot.locations, error); }
    this.emit();
  }
  private async refreshBlockers(rt: Runtime) {
    const locations = rt.snapshot.locations.data;
    if (!locations) { rt.snapshot.coverage.blockers = "partial"; rt.snapshot.coverage.reason = "Loaded-location inventory unavailable"; this.emit(); return; }
    const permissions: PendingPermission[] = []; const forms: PendingForm[] = [];
    try {
      for (const directory of locations) {
        const [p, f] = await Promise.all([this.get<any[]>(rt, "/api/permission/request", { directory }), this.get<any[]>(rt, "/api/form", { directory })]);
        permissions.push(...asArray<PendingPermission>(p)); forms.push(...asArray<PendingForm>(f));
      }
      rt.snapshot.permissions = fresh(permissions); rt.snapshot.forms = fresh(forms); rt.snapshot.coverage.blockers = "complete";
    } catch (error) { rt.snapshot.permissions = failed(rt.snapshot.permissions, error); rt.snapshot.forms = failed(rt.snapshot.forms, error); rt.snapshot.coverage.blockers = "partial"; }
    this.emit();
  }
  private async refreshInfo(rt: Runtime) {
    try {
      const info = await this.get<Record<string, unknown>>(rt, "/api/info"); rt.snapshot.info = fresh(info);
      const version = typeof info.version === "string" ? info.version : "";
      rt.writeCompatible = /^2\./.test(version);
    } catch (error) { rt.snapshot.info = failed(rt.snapshot.info, error); rt.writeCompatible = false; }
    this.emit();
  }
  private async ensureSessionMetadata(rt: Runtime, sessionId: string) {
    let current: string | undefined = sessionId; const visited = new Set<string>();
    for (let depth = 0; current && depth < 20 && !visited.has(current); depth++) {
      visited.add(current); const state = this.getOrCreateSession(rt.profile.id, current);
      if (state.metadata.data) { this.includeDiscoveredSession(rt, state.metadata.data); current = state.metadata.data.parentID; continue; }
      try { const metadata = normalizeSession(await this.get<SessionRecord>(rt, `/api/session/${enc(current)}`)); state.metadata = fresh(metadata); this.includeDiscoveredSession(rt, metadata); current = metadata.parentID; }
      catch (error) { state.metadata = failed(state.metadata, error); return; }
    }
    this.emit();
  }
  private includeDiscoveredSession(rt: Runtime, record: SessionRecord) {
    const current = rt.snapshot.sessions.data;
    if (current?.some(item => item.id === record.id)) return;
    rt.snapshot.sessions = { data: [...(current ?? []), record], freshness: current ? rt.snapshot.sessions.freshness : "fresh", observedAt: rt.snapshot.sessions.observedAt ?? Date.now() };
    // Parents older than the recent window are fetched on demand so their workers group under them; this is expected, not a coverage gap.
  }
  private async reconcileReceipts(rt: Runtime) {
    for (const receipt of this.receipts.filter(r => r.serverId === rt.profile.id && (r.state === "unknown" || r.state === "accepted"))) {
      const state = this.getOrCreateSession(rt.profile.id, receipt.sessionId);
      try {
        try {
          const message = await this.get<any>(rt, `/api/session/${enc(receipt.sessionId)}/message/${enc(receipt.messageId)}`, {}, sessionDirectory(state));
          if (message) { this.patchReceipt(receipt.id, "observed"); continue; }
        } catch { /* A missing message alone cannot prove the prompt was rejected. */ }
        const inbox = await this.get<any[]>(rt, `/api/session/${enc(receipt.sessionId)}/inbox`, {}, sessionDirectory(state));
        if (asArray<any>(inbox).some(item => item.id === receipt.messageId || item.messageID === receipt.messageId)) this.patchReceipt(receipt.id, "accepted");
        // Absence from either snapshot is not proof the server did not admit this prompt.
      } catch { /* Keep delivery unknown until a future authoritative refresh can reconcile it. */ }
    }
  }
  private async loadSessionInbox(rt: Runtime, state: SessionSnapshot, directory?: string) { try { state.inbox = fresh(asArray(await this.get(rt, `/api/session/${enc(state.sessionId)}/inbox`, {}, directory))); } catch (error) { state.inbox = failed(state.inbox, error); } this.emit(); }
  private async loadSessionPermissions(rt: Runtime, state: SessionSnapshot, directory?: string) { try { state.permissions = fresh(asArray(await this.get(rt, `/api/session/${enc(state.sessionId)}/permission`, {}, directory))); } catch (error) { state.permissions = failed(state.permissions, error); } this.emit(); }
  private async loadSessionForms(rt: Runtime, state: SessionSnapshot, directory?: string) { try { state.forms = fresh(asArray(await this.get(rt, `/api/session/${enc(state.sessionId)}/form`, {}, directory))); } catch (error) { state.forms = failed(state.forms, error); } this.emit(); }

  private async get<T>(rt: Runtime, path: string, query: Record<string, unknown> = {}, directory?: string): Promise<T> { const value: any = await this.request<T>(rt, "GET", path, undefined, query, directory); return value?.data !== undefined ? value.data : value; }
  private async getRaw<T>(rt: Runtime, path: string, query: Record<string, unknown> = {}, directory?: string): Promise<T> { return this.request<T>(rt, "GET", path, undefined, query, directory); }
  private async post<T>(rt: Runtime, path: string, body?: unknown, directory?: string, query: Record<string, unknown> = {}): Promise<T> { return this.request<T>(rt, "POST", path, body, query, directory); }
  private async request<T>(rt: Runtime, method: string, path: string, body?: unknown, query: Record<string, unknown> = {}, directory?: string): Promise<T> {
    const generation = rt.generation;
    const headers: Record<string,string> = { ...rt.headers, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try { response = await fetchApi(expoFetch, rt.profile.url, path, query, directory, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(requestTimeoutMs), redirect: "error" } as RequestInit); }
    catch (error) { throw fetchFailure(error); }
    if (this.runtimes.get(rt.profile.id) !== rt || rt.generation !== generation) throw new CoreErrorClass("Connection changed during request", "network");
    if (!response.ok) {
      const kind = classifyHttpError(response.status);
      if (kind === "auth") { rt.authRejected = true; rt.snapshot.transport = "auth-error"; this.emit(); }
      throw new CoreErrorClass(`OpenCode request failed (${response.status})`, kind, response.status);
    }
    if (response.status === 204) return undefined as T;
    try { return await response.json() as T; } catch { return undefined as T; }
  }
  private getOrCreateSession(serverId: string, sessionId: string) {
    const id = key(serverId, sessionId); let state = this.sessions.get(id);
    if (!state) { state = { serverId, sessionId, metadata: blankResource(), messages: blankResource(), inbox: blankResource(), permissions: blankResource(), forms: blankResource() }; this.sessions.set(id, state); }
    return state;
  }
  private emptyServer(profile: ServerProfile): ServerSnapshot { return { profile, info: blankResource(), sessions: blankResource(), activeSessionIds: blankResource(), locations: blankResource(), permissions: blankResource(), forms: blankResource(), coverage: { sessions: "unknown", blockers: "unknown" }, transport: "offline" }; }
  private requireRuntime(id: string) { const rt = this.runtimes.get(id); if (!rt) throw new Error("Server is not connected"); return rt; }
  private assertWritable(rt: Runtime) { if (rt.writeCompatible !== true) throw new CoreErrorClass("Writes are disabled until a compatible OpenCode v2 server is confirmed", "incompatible"); }
  private markStale(rt: Runtime) { for (const key of ["info", "sessions", "activeSessionIds", "locations", "permissions", "forms"] as const) { const r = rt.snapshot[key]; if (r.data !== undefined) r.freshness = "stale"; } }
  private dropSessionCache(id: string) { for (const [k,s] of this.sessions) if (s.serverId === id) this.sessions.delete(k); }
  private patchReceipt(id: string, state: PromptReceipt["state"]) { this.receipts = this.receipts.map(r => r.id === id ? { ...r, state } : r); void this.persistReceipts(); this.emit(); }
  private async persistProfiles() { await AsyncStorage.setItem(PROFILES_KEY, JSON.stringify(this.profiles)); }
  private async persistReceipts() { await AsyncStorage.setItem(RECEIPTS_KEY, JSON.stringify(this.receipts)); }
  private emit() { this.listeners.forEach(listener => listener()); }
}

function sessionUpdatedAt(session: SessionRecord) {
  const time = session.time as { updated?: unknown; created?: unknown } | undefined;
  const value = typeof time?.updated === "number" ? time.updated : typeof time?.created === "number" ? time.created : undefined;
  // Unknown timestamps stay visible rather than silently dropping work.
  return value ?? Number.POSITIVE_INFINITY;
}
function fresh<T>(data: T): ResourceState<T> { return { data, observedAt: Date.now(), freshness: "fresh" }; }
function failed<T>(state: ResourceState<T>, error: unknown): ResourceState<T> { return { ...state, freshness: state.data === undefined ? "offline" : "stale", error: error as CoreError }; }
function asArray<T>(value: unknown): T[] { return Array.isArray(value) ? value : []; }
function mergeMessages(existing: SessionMessage[], page: SessionMessage[]) { const byId = new Map(existing.map(message => [message.id, message])); for (const message of page) byId.set(message.id, message); return [...byId.values()]; }
function normalizeSession(session: SessionRecord): SessionRecord { return { ...session, ...(session.directory || !session.location?.directory ? {} : { directory: session.location.directory }) }; }
/** Pages may arrive newest-first; store them oldest-first using the reported creation time. */
function oldestFirst(rows: SessionMessage[]) {
  const created = (message: SessionMessage) => { const time = message.time as unknown; return typeof time === "number" ? time : time && typeof time === "object" && typeof (time as { created?: unknown }).created === "number" ? (time as { created: number }).created : undefined; };
  const first = rows.length > 1 ? created(rows[0]!) : undefined; const last = rows.length > 1 ? created(rows[rows.length - 1]!) : undefined;
  return first !== undefined && last !== undefined && first > last ? [...rows].reverse() : rows;
}
function normalizeMessage(message: SessionMessage): SessionMessage {
  const role = message.role ?? message.type;
  const text = message.text === undefined ? contentText(message.content) : message.text;
  return { ...message, ...(role ? { role } : {}), ...(text === undefined ? {} : { text }) };
}
function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  // Only answer text: v2 assistant content also carries reasoning and tool parts, which are not message text.
  if (Array.isArray(content)) return content.filter(part => typeof part === "string" || !part || typeof part !== "object" || !("type" in part) || (part as { type?: unknown }).type === "text").map(contentText).filter((item): item is string => item !== undefined).join("\n");
  if (content && typeof content === "object" && "text" in content && typeof (content as { text?: unknown }).text === "string") return (content as { text: string }).text;
  return undefined;
}
function fetchFailure(error: unknown) { const kind = classifyFetchError(error); return new CoreErrorClass(kind === "tls" ? "Server TLS certificate could not be verified" : "Could not reach server", kind); }
function key(serverId: string, sessionId: string) { return `${serverId}\u0000${sessionId}`; }
function enc(value: string) { return encodeURIComponent(value); }
function sessionDirectory(state?: SessionSnapshot) { return state?.metadata.data?.directory; }
function normalizeUrl(url: string) { return url.trim().replace(/\/+$/, ""); }
function validateEndpoint(url: string) { let parsed: URL; try { parsed = new URL(url); } catch { throw new Error("Enter a valid HTTPS server URL"); } if (parsed.protocol !== "https:") throw new Error("Server profiles must use HTTPS"); if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("URL must not contain credentials, query parameters, or a fragment"); }
function uuid() { return Crypto.randomUUID(); }
