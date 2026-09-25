import type { Attention, PocketSession } from './types';

export type SessionFilter = 'all' | 'needs' | 'working';

/** Needs You is reserved for a concrete request that can be answered or handed off. */
export function actionableRequests(session: Pick<PocketSession, 'attention' | 'rolledUpAttention'>): Attention[] {
  return (session.rolledUpAttention ?? session.attention).filter(request => request.kind === 'permission' || request.kind === 'form' || request.kind === 'unsupported');
}

export function hasFailure(session: Pick<PocketSession, 'failure' | 'attention' | 'rolledUpAttention'>) {
  return Boolean(session.failure) || [...session.attention, ...(session.rolledUpAttention ?? [])].some(request => request.kind === 'failure');
}

/** Each root family appears in one section only, with explicit human requests taking priority. */
export function groupSessionSections(sessions: PocketSession[], filter: SessionFilter) {
  const roots = sessions.filter(session => !session.isWorker);
  const filtered = roots.filter(session => filter === 'all' || (filter === 'needs' ? actionableRequests(session).length > 0 : session.status === 'running' || session.familyStatus === 'working'));
  const needs = filtered.filter(session => actionableRequests(session).length > 0);
  const failures = filtered.filter(session => !actionableRequests(session).length && hasFailure(session));
  const working = filtered.filter(session => !actionableRequests(session).length && !hasFailure(session) && (session.status === 'running' || session.familyStatus === 'working'));
  const unknown = filtered.filter(session => !actionableRequests(session).length && !hasFailure(session) && session.status !== 'running' && session.familyStatus !== 'working' && (session.status === 'unknown' || session.familyStatus === 'unknown' || session.familyCoverage !== 'complete'));
  const recent = filtered.filter(session => !needs.includes(session) && !failures.includes(session) && !working.includes(session) && !unknown.includes(session));
  return { needs, failures, working, unknown, recent };
}

/** Removing a saved profile is allowed only from its explicit confirmation step. */
export function canConfirmSavedServerRemoval(pendingId: string | undefined, serverId: string) {
  return pendingId === serverId;
}
