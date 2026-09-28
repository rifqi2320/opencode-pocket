/** Local, per-session Pocket controls. These never modify OpenCode server or CLI configuration. */
export const SESSION_CONTROLS_KEY = 'pocket.session-controls.v1';
export const MAX_SESSION_CONTROL_RECORDS = 100;

export type PromptDeliveryPreference = 'automatic' | 'steer' | 'queue';
export type SessionControls = {
  delivery: PromptDeliveryPreference;
  showThinking: boolean;
  expandToolDetails: boolean;
};
type StoredSessionControls = SessionControls & { updatedAt: number };
export type SessionControlsStore = { sessions: Record<string, StoredSessionControls> };

export const DEFAULT_SESSION_CONTROLS: SessionControls = {
  delivery: 'automatic',
  showThinking: true,
  expandToolDetails: false,
};

export function sessionControlsId(serverId: string, sessionId: string) { return `${serverId}\u0000${sessionId}`; }

function normalize(value: unknown): StoredSessionControls {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    delivery: raw.delivery === 'steer' || raw.delivery === 'queue' || raw.delivery === 'automatic' ? raw.delivery : DEFAULT_SESSION_CONTROLS.delivery,
    showThinking: typeof raw.showThinking === 'boolean' ? raw.showThinking : DEFAULT_SESSION_CONTROLS.showThinking,
    expandToolDetails: typeof raw.expandToolDetails === 'boolean' ? raw.expandToolDetails : DEFAULT_SESSION_CONTROLS.expandToolDetails,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  };
}

/** Tolerant parse for AsyncStorage: malformed or legacy values safely become an empty store. */
export function normalizeSessionControlsStore(value: unknown): SessionControlsStore {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const sessions: Record<string, StoredSessionControls> = {};
  if (raw.sessions && typeof raw.sessions === 'object') {
    for (const [id, controls] of Object.entries(raw.sessions as Record<string, unknown>)) {
      if (id) sessions[id] = normalize(controls);
    }
  }
  return { sessions };
}

export function controlsForSession(store: SessionControlsStore, id: string): SessionControls {
  const { updatedAt: _updatedAt, ...controls } = store.sessions[id] ?? normalize(undefined);
  return controls;
}

/** Updates one record and retains only the newest bounded set of per-session preferences. */
export function updateSessionControls(store: SessionControlsStore, id: string, patch: Partial<SessionControls>, now = Date.now()): SessionControlsStore {
  const current = controlsForSession(store, id);
  const next: SessionControlsStore = { sessions: { ...store.sessions, [id]: { ...current, ...patch, updatedAt: now } } };
  const overflow = Object.entries(next.sessions)
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(MAX_SESSION_CONTROL_RECORDS);
  for (const [staleId] of overflow) delete next.sessions[staleId];
  return next;
}
