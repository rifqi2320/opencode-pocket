// Run with: node --test src/core/credentials.test.cjs
// Exercises the pure web credential store (no React Native runtime needed).
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  module._compile(ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }), filename);
};

const { createWebCredentialStore, secretKey, WEB_CREDENTIAL_PREFIX } = require(path.join(__dirname, "credentialStore.ts"));
const fakeStorage = () => { const m = new Map(); return { map: m, getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };

test("web credentials persist across store instances (simulated reload) under a namespaced key", () => {
  const storage = fakeStorage();
  createWebCredentialStore(() => storage).set("pocket.server.a.password", "s3cret");
  assert.equal(storage.map.get(WEB_CREDENTIAL_PREFIX + "pocket.server.a.password"), "s3cret");
  const reloaded = createWebCredentialStore(() => storage);
  assert.equal(reloaded.get("pocket.server.a.password"), "s3cret");
  reloaded.delete("pocket.server.a.password");
  assert.equal(createWebCredentialStore(() => storage).get("pocket.server.a.password"), null);
});

test("falls back to page memory when localStorage is missing or throws", () => {
  const missing = createWebCredentialStore(() => undefined);
  missing.set("k", "v"); assert.equal(missing.get("k"), "v");
  const throwing = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceeded"); }, removeItem() { throw new Error("x"); } };
  const store = createWebCredentialStore(() => throwing);
  store.set("k", "v"); assert.equal(store.get("k"), "v");
  store.delete("k"); assert.equal(store.get("k"), null);
  const accessorThrows = createWebCredentialStore(() => { throw new Error("blocked"); });
  accessorThrows.set("k", "v"); assert.equal(accessorThrows.get("k"), "v");
});

test("secret keys are SecureStore-safe and uuid ids are unchanged", () => {
  const uuid = "3f2b8c1e-9a4d-4f6b-8e2a-1c5d7e9f0a3b";
  assert.equal(secretKey(uuid), `pocket.server.${uuid}.password`);
  for (const id of [uuid, "my server/1", "a_b", "ü"]) assert.match(secretKey(id), /^[A-Za-z0-9._-]+$/);
  assert.notEqual(secretKey("a_b"), secretKey("a b"));
});
