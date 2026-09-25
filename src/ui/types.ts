/** UI-only projections. Raw OpenCode API payloads and mutation semantics stay in src/core. */
export type Attention = { id: string; kind: 'permission' | 'form' | 'failure' | 'unsupported'; label: string; ownerSessionKey?: string };
export type PocketFormRequest = { id: string; sessionID: string; title: string; fields: unknown[] };
export type Worker = { id: string; title: string; status: string; relation: string; depth?: number; needsYou?: boolean; sessionKey?: string };
export type PocketToolStep = {
  kind: 'tool'; id: string; name: string;
  /** One-line human summary derived from the tool input (command, path, pattern…). */
  title: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  durationMs?: number;
  input?: string; inputTruncated?: boolean;
  output?: string; outputTruncated?: boolean;
  error?: string; exitCode?: number;
};
export type PocketStep =
  | PocketToolStep
  | { kind: 'reasoning'; id: string; text: string; durationMs?: number }
  /** Narration the assistant wrote between tool calls. */
  | { kind: 'text'; id: string; text: string }
  /** Context/system events (compaction, agent switch, injected instructions, unknown parts). */
  | { kind: 'note'; id: string; label: string; text?: string };
export type PocketTurn =
  | { kind: 'user'; id: string; text: string; time?: string; files?: string[] }
  | { kind: 'assistant'; id: string; steps: PocketStep[]; finalText?: string; error?: string; outcome?: string; running?: boolean; durationMs?: number; time?: string; agent?: string };
export type PocketSession = {
  id: string;
  server: string;
  /** Server profile id; groups sessions per server when names collide. */
  serverId?: string;
  project: string;
  /** Absolute working directory reported by OpenCode (the project/folder the session runs in). */
  directory?: string;
  title: string;
  status: 'running' | 'inactive' | 'unknown';
  /** Explicit server-reported failure evidence; never treated as a pending human decision. */
  failure?: string;
  /** Family execution is separate from this session's foreground status. */
  familyStatus?: 'working' | 'inactive' | 'unknown';
  activeWorkerCount?: number;
  familyCoverage?: 'complete' | 'partial' | 'unknown';
  isWorker?: boolean;
  summary: string;
  lastSeen: string;
  freshness: 'live' | 'stale' | 'offline';
  attention: Attention[];
  forms: PocketFormRequest[];
  /** Known descendant requests surfaced on home cards; detail actions stay scoped to this session. */
  rolledUpAttention?: Attention[];
  workers: Worker[];
  /** Conversation turns, oldest first (see src/ui/turns.ts). */
  messages: PocketTurn[];
  /** Older messages exist on the server beyond the loaded page. */
  hasEarlier?: boolean;
  agent?: string;
  model?: string;
  pending?: number;
  pendingItems?: Array<{ id: string; text: string }>;
  coverage?: 'complete' | 'partial' | 'unknown';
};
export type PocketServer = {
  id: string;
  name: string;
  url: string;
  state: 'connected' | 'connecting' | 'offline' | 'auth-error' | 'incompatible' | 'unverified' | 'stale' | 'error';
  version?: string;
  transport?: string;
  lastSync?: string;
  coverage?: string;
  error?: string;
};
/** Per-server push notification controls (see src/core/notifications.ts). */
export type NotificationPrefKey = 'needsPermission' | 'needsAnswer' | 'sessionFailed' | 'sessionFinished' | 'sessionInterrupted' | 'includeSubagents' | 'hideDetails';
export type PocketServerNotifications = {
  enabled: boolean;
  busy: boolean;
  preferences: Record<NotificationPrefKey, boolean>;
  /** Toggles the server's plugin supports, in display order; all when unknown. */
  available?: NotificationPrefKey[];
  status: { kind: string; label: string; tone: 'neutral' | 'success' | 'warning' | 'danger'; canToggle: boolean };
};
