import { useEffect, useState } from "react";
import { PocketCore } from "./core";
import { PocketNotifications } from "./notifications";
import type { NotificationPreferences } from "./notificationLogic";
import type { ProfileInput, SessionMessage } from "./types";
export * from "./types";
export * from "./status";
export { PocketCore } from "./core";
export type { NotificationsSnapshot, ServerNotificationView } from "./notifications";
export type { NotificationPreferences, NotificationStatus, PushTarget } from "./notificationLogic";

/** App-wide controller. Call `await pocketCore.start()` once during app bootstrap. */
export const pocketCore = new PocketCore();
/** Optional push registration with the Pocket server plugin (Android only). */
export const pocketNotifications = new PocketNotifications(pocketCore);

/** React binding: profiles, server snapshots, session snapshots, and prompt receipts. */
export function usePocketCore() {
  const [state, setState] = useState(() => pocketCore.getSnapshot());
  useEffect(() => {
    void pocketCore.start();
    return pocketCore.subscribe(() => setState(pocketCore.getSnapshot()));
  }, []);
  const [notifications, setNotifications] = useState(() => pocketNotifications.getSnapshot());
  useEffect(() => {
    void pocketNotifications.start().catch(() => undefined);
    const unsubscribe = pocketNotifications.subscribe(() => setNotifications(pocketNotifications.getSnapshot()));
    setNotifications(pocketNotifications.getSnapshot());
    return unsubscribe;
  }, []);
  return { ...state, notifications, core: pocketCore };
}

/** UI-facing facade. Session and request snapshots are server-profile isolated. */
export function usePocket() {
  const state = usePocketCore();
  const selected = state.selectedSession;
  const parentId = selected?.metadata.data?.parentID;
  const workers = selected ? state.sessions.filter(session => session.serverId === selected.serverId && session.metadata.data?.parentID === selected.sessionId) : [];
  const requests = selected ? [...(selected.permissions.data ?? []), ...(selected.forms.data ?? [])] : [];
  const messages: SessionMessage[] = selected?.messages.data ?? [];
  const freshness = selected?.messages.freshness ?? selected?.metadata.freshness ?? "offline";
  return {
    ...state,
    selected,
    messages,
    workers,
    requests,
    freshness,
    parentId,
    testConnection: (input: ProfileInput, password = "") => pocketCore.testConnection(input, password),
    saveServer: (input: ProfileInput, password = "") => pocketCore.saveServer(input, password),
    /** Edit a profile. Omit `password` to keep the saved one; pass "" to clear it. Reconnects when URL or password changes. */
    updateServer: (serverId: string, input: ProfileInput, password?: string) => pocketCore.updateProfile(serverId, input, password),
    /** Drop and re-establish the server connection with the saved credential, then refresh. */
    reconnectServer: (serverId: string) => pocketCore.connectProfile(serverId),
    removeServer: (serverId: string) => pocketCore.removeServer(serverId),
    selectSession: (serverId: string, sessionId: string) => pocketCore.selectSession(serverId, sessionId),
    loadMoreMessages: (serverId: string, sessionId: string) => pocketCore.loadMoreMessages(serverId, sessionId),
    refresh: (serverId?: string) => pocketCore.refresh(serverId),
    searchSessions: (query: string) => pocketCore.searchSessions(query),
    sendPrompt: (serverId: string, sessionId: string, text: string, delivery?: "steer" | "queue") => pocketCore.sendPrompt(serverId, sessionId, text, delivery),
    interrupt: (serverId: string, sessionId: string) => pocketCore.interrupt(serverId, sessionId),
    replyPermission: (serverId: string, sessionId: string, requestId: string, decision: "once" | "reject") => pocketCore.replyPermission(serverId, sessionId, requestId, decision),
    replyForm: (serverId: string, sessionId: string, formId: string, answers: unknown) => pocketCore.replyForm(serverId, sessionId, formId, answers),
    /** Request OS permission, fetch the FCM token and register with the server's Pocket plugin. Throws with a user-facing message. */
    enableNotifications: (serverId: string) => pocketNotifications.enable(serverId),
    /** Turn off locally and unregister from the plugin (best-effort). */
    disableNotifications: (serverId: string) => pocketNotifications.disable(serverId),
    setNotificationPreferences: (serverId: string, patch: Partial<NotificationPreferences>) => pocketNotifications.setPreferences(serverId, patch),
    sendTestNotification: (serverId: string) => pocketNotifications.sendTest(serverId),
    refreshNotifications: (serverId: string) => pocketNotifications.refresh(serverId),
    /** Session key currently on screen; its pushes are not shown as foreground banners. */
    setViewingSession: (key: string | undefined) => pocketNotifications.setViewing(key),
    /** Resolve a tapped notification request to a local server/session (waits for local state on cold start). */
    resolveNotificationTap: (request: unknown) => pocketNotifications.resolveTap(request),
  };
}
