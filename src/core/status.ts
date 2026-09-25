import type { Freshness, Observed } from "./types";

export type ExecutionEvidence = {
  active: boolean | undefined;
  outcome?: "success" | "error" | "interrupted";
  observedAt?: number | undefined;
  freshness?: Freshness | undefined;
};

/** Active-process membership is authoritative for foreground execution; missing evidence stays unknown. */
export function executionStatus(evidence: ExecutionEvidence): Observed<"running" | "inactive" | "unknown"> {
  return {
    value: evidence.active === true ? "running" : evidence.active === false ? "inactive" : "unknown",
    observedAt: evidence.observedAt ?? 0,
    freshness: evidence.freshness ?? "stale",
  };
}

export type SessionFreshnessEvidence = {
  transport: string;
  hasInventory: boolean;
  inventoryFreshness: Freshness;
  activeFreshness: Freshness;
  infoFailed?: boolean;
  messagesLoaded?: boolean;
  messagesFreshness?: Freshness;
};

/** Unrequested message history is not evidence that a connected session is offline. */
export function sessionFreshness(evidence: SessionFreshnessEvidence): "live" | "stale" | "offline" {
  if (evidence.transport === "offline" || evidence.transport === "auth-error" || !evidence.hasInventory) return "offline";
  if (evidence.transport !== "live" || evidence.infoFailed || evidence.inventoryFreshness !== "fresh" || evidence.activeFreshness !== "fresh") return "stale";
  if (evidence.messagesLoaded && evidence.messagesFreshness !== "fresh") return "stale";
  return "live";
}

export type DirtySnapshot<T> = { value: T; dirtyAtStart: number; generation: number };

/** A snapshot is publishable only for the connection generation that requested it. */
export function reconcileSnapshot<T>(input: DirtySnapshot<T>, currentGeneration: number, dirtyNow: number) {
  if (input.generation !== currentGeneration) return { publish: false, dirty: true } as const;
  return { publish: true, dirty: dirtyNow !== input.dirtyAtStart } as const;
}

export type RelatedSession = {
  id: string;
  serverId?: string;
  parentID?: string;
  forkedFrom?: unknown;
  relationship?: unknown;
  relation?: unknown;
  [key: string]: unknown;
};

/** A session is a worker only when the server gives an explicit parent/worker relationship. */
export function classifyRelationship(session: RelatedSession) {
  const relationValue = session.relationship ?? session.relation;
  const relation = typeof relationValue === "string" ? relationValue.toLowerCase() : undefined;
  if (session.forkedFrom || relation === "fork" || relation === "forked") return "fork" as const;
  if (relationValue !== undefined && relationValue !== null && relationValue !== "") {
    if (["worker", "subagent", "sub-agent"].includes(relation ?? "")) return session.parentID ? "subagent" as const : "unknown" as const;
    return "unknown" as const;
  }
  if (session.parentID) return "subagent" as const;
  return undefined;
}

export type SessionDescendant<T extends RelatedSession = RelatedSession> = { session: T; depth: number };

/** Return only explicitly linked workers, scoped to a server so repeated remote IDs cannot cross-link. */
export function sessionDescendants<T extends RelatedSession>(records: T[], parentId: string, serverId?: string): SessionDescendant<T>[] {
  const carriesServerIds = records.some(record => typeof record.serverId === "string");
  const parent = records.find(record => record.id === parentId && (!carriesServerIds || serverId === undefined || record.serverId === serverId));
  const scope = serverId ?? parent?.serverId;
  const inScope = (record: T) => !carriesServerIds || scope === undefined || record.serverId === scope;
  const found: SessionDescendant<T>[] = [];
  const seen = new Set<string>([parentId]);
  const frontier: Array<{ id: string; depth: number }> = [{ id: parentId, depth: 0 }];
  while (frontier.length && found.length < records.length) {
    const current = frontier.shift()!;
    for (const session of records) {
      if (!inScope(session) || session.parentID !== current.id || classifyRelationship(session) !== "subagent" || seen.has(session.id)) continue;
      seen.add(session.id);
      const depth = current.depth + 1;
      found.push({ session, depth });
      frontier.push({ id: session.id, depth });
    }
  }
  return found;
}

export type FamilyActivity = {
  status: "working" | "inactive" | "unknown";
  activeWorkerCount: number;
  descendants: SessionDescendant[];
};

/** A fresh active-session list can prove work is happening; absence proves inactivity only with complete inventory coverage. */
export function familyActivity<T extends RelatedSession>(input: {
  records: T[];
  parentId: string;
  serverId?: string;
  activeSessionIds?: string[];
  activeFreshness?: Freshness;
  sessionsCoverage?: "complete" | "partial" | "unknown";
}): FamilyActivity {
  const descendants = sessionDescendants(input.records, input.parentId, input.serverId);
  const active = input.activeFreshness === "fresh" && input.activeSessionIds !== undefined
    ? descendants.filter(({ session }) => input.activeSessionIds!.includes(session.id)).length
    : 0;
  return {
    status: active > 0 ? "working" : input.activeFreshness === "fresh" && input.sessionsCoverage === "complete" ? "inactive" : "unknown",
    activeWorkerCount: active,
    descendants,
  };
}

/** Keep a known request attached to its owning session while rolling it up to the root card. */
export function rollupFamilyRows<T extends { sessionID?: string }>(input: {
  records: RelatedSession[];
  parentId: string;
  serverId?: string;
  rows: T[];
}): Array<{ row: T; ownerSessionId: string; depth: number }> {
  const owners = new Map<string, number>([[input.parentId, 0]]);
  for (const { session, depth } of sessionDescendants(input.records, input.parentId, input.serverId)) owners.set(session.id, depth);
  return input.rows.flatMap(row => {
    const depth = typeof row.sessionID === "string" ? owners.get(row.sessionID) : undefined;
    return depth === undefined ? [] : [{ row, ownerSessionId: row.sessionID!, depth }];
  });
}
