/** Pure credential helpers (no React Native imports) so they can be unit tested under plain Node. */
export type KeyValueStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };

export const WEB_CREDENTIAL_PREFIX = "pocket.credential.v1.";

/** SecureStore keys allow only [A-Za-z0-9._-]; escape anything else (and "_" itself) injectively. */
export function secretKey(id: string) { return `pocket.server.${id.replace(/[^A-Za-z0-9.-]/g, c => `_${c.charCodeAt(0).toString(16)}_`)}.password`; }

/**
 * Web credential store persisted in localStorage under a namespaced key so saved servers
 * reconnect after a reload. Falls back to page memory when storage is missing or throws
 * (private mode, blocked site data, quota).
 */
export function createWebCredentialStore(storage: () => KeyValueStorage | undefined) {
  const memory = new Map<string, string>();
  const local = () => { try { return storage(); } catch { return undefined; } };
  return {
    get(key: string): string | null {
      const s = local(); const name = WEB_CREDENTIAL_PREFIX + key;
      if (s) { try { const value = s.getItem(name); if (value !== null) return value; } catch { /* fall through to memory */ } }
      return memory.get(key) ?? null;
    },
    set(key: string, value: string) {
      const s = local(); memory.set(key, value);
      if (s) { try { s.setItem(WEB_CREDENTIAL_PREFIX + key, value); } catch { /* memory copy still serves this page */ } }
    },
    delete(key: string) {
      const s = local(); memory.delete(key);
      if (s) { try { s.removeItem(WEB_CREDENTIAL_PREFIX + key); } catch { /* ignore */ } }
    },
  };
}
