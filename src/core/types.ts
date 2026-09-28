export type ServerProfile = {
  id: string;
  name: string;
  /** HTTP(S) origin including any reverse-proxy base path; no trailing slash. */
  url: string;
};

export type ProfileInput = Omit<ServerProfile, "id"> & { id?: string };
export type Freshness = "fresh" | "syncing" | "stale" | "offline";
export type Coverage = "complete" | "partial" | "unknown";
export type Observed<T> = { value: T; observedAt: number; freshness: Freshness };
export type SessionRecord = Record<string, unknown> & { id: string; directory?: string; location?: { directory?: string }; parentID?: string };
export type SessionMessage = Record<string, unknown> & { id: string; role?: string; type?: string; content?: unknown; text?: string };
export type PendingPermission = Record<string, unknown> & { id: string; sessionID: string };
export type PendingForm = Record<string, unknown> & { id: string; sessionID: string };
export type PromptDelivery = "steer" | "queue";
/** A server-advertised model usable for later turns in an existing session. */
export type SessionModel = { providerID: string; id: string; name: string; variants: Array<{ id: string }> };
export type SessionModelRef = { providerID: string; id: string; variant?: string };
export type PromptReceiptState = "sending" | "accepted" | "observed" | "rejected" | "unknown";
export type PromptReceipt = {
  id: string;
  serverId: string;
  sessionId: string;
  messageId: string;
  delivery: PromptDelivery;
  submittedAt: number;
  state: PromptReceiptState;
};

export type ResourceState<T> = {
  data?: T;
  freshness: Freshness;
  observedAt?: number;
  error?: CoreError;
};

export type CoreErrorKind = "network" | "tls" | "auth" | "incompatible" | "http" | "unknown";
export class CoreError extends Error {
  constructor(message: string, readonly kind: CoreErrorKind, readonly status?: number) {
    super(message);
    this.name = "CoreError";
  }
}

export type ServerSnapshot = {
  profile: ServerProfile;
  info: ResourceState<Record<string, unknown>>;
  sessions: ResourceState<SessionRecord[]>;
  activeSessionIds: ResourceState<string[]>;
  locations: ResourceState<string[]>;
  permissions: ResourceState<PendingPermission[]>;
  forms: ResourceState<PendingForm[]>;
  coverage: { sessions: Coverage; blockers: Coverage; reason?: string };
  transport: "connecting" | "live" | "reconnecting" | "polling" | "offline" | "auth-error";
  lastSyncAt?: number;
};

export type SessionSnapshot = {
  serverId: string;
  sessionId: string;
  metadata: ResourceState<SessionRecord>;
  messages: ResourceState<SessionMessage[]>;
  inbox: ResourceState<Record<string, unknown>[]>;
  permissions: ResourceState<PendingPermission[]>;
  forms: ResourceState<PendingForm[]>;
  messageCursor?: string;
};
