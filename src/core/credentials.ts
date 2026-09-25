import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { createWebCredentialStore, type KeyValueStorage } from "./credentialStore";

// Native: SecureStore (platform-protected storage). Web: there is no secure enclave, so
// persist in this origin's localStorage (namespaced) so saved servers survive a reload,
// falling back to page memory when localStorage is unavailable.
const web = createWebCredentialStore(() => (globalThis as { localStorage?: KeyValueStorage }).localStorage);

export async function getCredential(key: string): Promise<string | null> {
  if (Platform.OS === "web") return web.get(key);
  return SecureStore.getItemAsync(key);
}

/** An empty value means "no password"; it is stored as absence so native keychains never hold empty items. */
export async function setCredential(key: string, value: string): Promise<void> {
  if (!value) return deleteCredential(key);
  if (Platform.OS === "web") { web.set(key, value); return; }
  await SecureStore.setItemAsync(key, value);
}

export async function deleteCredential(key: string): Promise<void> {
  if (Platform.OS === "web") { web.delete(key); return; }
  await SecureStore.deleteItemAsync(key);
}
