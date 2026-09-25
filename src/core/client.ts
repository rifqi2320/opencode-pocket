import { OpenCode } from "@opencode/client";
import type { CoreErrorKind } from "./types";

export type OpenCodeClient = ReturnType<typeof OpenCode.make>;

export function makeClient(url: string, password: string, transport: typeof fetch = fetch) {
  return OpenCode.make({ baseUrl: url, headers: authHeaders(password), fetch: transport });
}

/** Basic auth for password-protected servers; no header at all when the profile has no password. */
export function authHeaders(password: string): Record<string, string> { return password ? { authorization: `Basic ${basic("opencode", password)}` } : {}; }

/** Map a thrown fetch error (no HTTP response) to a TLS or network failure. */
export function classifyFetchError(error: unknown): "tls" | "network" {
  const text = `${(error as any)?.name ?? ""} ${(error as any)?.message ?? ""} ${(error as any)?.cause?.message ?? ""} ${(error as any)?.code ?? ""}`;
  return /ssl|tls|certificate|cert_|handshake|trust anchor|self.signed|x509/i.test(text) ? "tls" : "network";
}

function basic(user: string, password: string) {
  const value = `${user}:${password}`;
  // btoa is present in Hermes. Encode UTF-8 first for non-ASCII credentials.
  const encoded = typeof btoa === "function" ? btoa(unescape(encodeURIComponent(value))) : value;
  return encoded;
}

export function classifyHttpError(status: number): CoreErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "incompatible";
  return "http";
}

/** Adds bounded reconnect jitter. */
export function reconnectDelay(attempt: number, random = Math.random) {
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
  return Math.round(base * (0.8 + random() * 0.4));
}
