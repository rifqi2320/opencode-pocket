import type { SessionModel, SessionModelRef } from './types';

/** Exact V2 payload for POST `/api/session/{sessionID}/model`. */
export function sessionModelPayload(model: SessionModelRef) {
  return { model: { providerID: model.providerID, id: model.id, ...(model.variant ? { variant: model.variant } : {}) } };
}

/** Converts only the public fields Pocket needs from OpenCode's `/api/model` response. */
export function normalizeModels(value: unknown): SessionModel[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>(); const models: SessionModel[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const providerID = typeof item.providerID === 'string' ? item.providerID : undefined;
    const id = typeof item.id === 'string' ? item.id : typeof item.modelID === 'string' ? item.modelID : undefined;
    if (!providerID || !id || item.enabled === false || seen.has(`${providerID}\u0000${id}`)) continue;
    seen.add(`${providerID}\u0000${id}`);
    const variants = Array.isArray(item.variants) ? item.variants.reduce<Array<{ id: string }>>((all, variant) => {
      const variantId = variant && typeof variant === 'object' ? (variant as Record<string, unknown>).id : undefined;
      if (typeof variantId === 'string') all.push({ id: variantId });
      return all;
    }, []) : [];
    models.push({ providerID, id, name: typeof item.name === 'string' && item.name ? item.name : id, variants });
  }
  return models.sort((a, b) => a.name.localeCompare(b.name) || a.providerID.localeCompare(b.providerID) || a.id.localeCompare(b.id));
}
