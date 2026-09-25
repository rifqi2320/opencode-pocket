// Run with: node --test src/core/notifications.test.cjs
// Pure notification helpers only (no RN runtime): pairing lookup, RPC unwrap, status derivation, push parsing.
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  module._compile(ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }), filename);
};

const L = require(path.join(__dirname, "notificationLogic.ts"));
const store = { deviceId: "dev", servers: {
  a: { pairingId: "pair-a", enabled: true, preferences: L.DEFAULT_PREFERENCES },
  b: { pairingId: "pair-b", enabled: false, preferences: L.DEFAULT_PREFERENCES },
} };
const ok = (info = {}) => ({ state: "ok", info: { protocolVersion: 1, notificationsConfigured: true, ...info } });

test("RPC results unwrap raw values and { data } envelopes; { error } envelopes throw", () => {
  const info = { protocolVersion: 1, pluginVersion: "0.1.0", notificationsConfigured: true };
  assert.deepEqual(L.unwrapRpcResult(info), info);
  assert.deepEqual(L.unwrapRpcResult({ data: info }), info);
  assert.equal(L.unwrapRpcResult({ data: null }), null);
  assert.deepEqual(L.unwrapRpcResult({ ok: false, error: "no creds" }), { ok: false, error: "no creds" });
  assert.throws(() => L.unwrapRpcResult({ error: { message: "boom" } }), /boom/);
  assert.equal(L.unwrapRpcResult(undefined), undefined);
  assert.equal(L.rpcPath("upsertDevice"), "/api/rpc/pocket/upsertDevice");
});

test("info and test results parse tolerantly", () => {
  assert.deepEqual(L.parsePocketInfo({ protocolVersion: 1, pluginVersion: "0.1.0", notificationsConfigured: true }), { protocolVersion: 1, pluginVersion: "0.1.0", notificationsConfigured: true });
  assert.equal(L.parsePocketInfo({ pluginVersion: "x" }), undefined);
  assert.equal(L.parsePocketInfo({ protocolVersion: 1 }).notificationsConfigured, false);
  assert.deepEqual(L.parseTestResult({ ok: true }), { ok: true });
  assert.deepEqual(L.parseTestResult({ ok: false, error: "FCM rejected" }), { ok: false, error: "FCM rejected" });
  assert.equal(L.parseTestResult(null).ok, false);
});

test("pairingId maps back to an existing server profile only", () => {
  assert.equal(L.serverForPairing(store, "pair-b"), "b");
  assert.equal(L.serverForPairing(store, "nope"), undefined);
  assert.equal(L.serverForPairing(store, "pair-a", ["b"]), undefined);
  const target = L.pushTarget(store, { pocket: "1", pairingId: "pair-a", kind: "permission", sessionId: "ses_1", eventId: "e" }, ["a", "b"]);
  assert.deepEqual(target, { serverId: "a", kind: "permission", sessionId: "ses_1", sessionKey: "a\u0000ses_1" });
  assert.deepEqual(L.pushTarget(store, { pocket: "1", pairingId: "pair-a", kind: "test", eventId: "e" }), { serverId: "a", kind: "test" });
  assert.equal(L.pushTarget(store, { pairingId: "pair-a", kind: "permission" }), undefined, "not marked pocket");
  assert.equal(L.pushTarget(store, { pocket: "1", pairingId: "pair-a", kind: "tokens" }), undefined, "unknown kind");
});

test("push payload is found in content.data, remoteMessage.data or dataString", () => {
  const data = { pocket: "1", pairingId: "pair-a", kind: "question", sessionId: "s" };
  assert.deepEqual(L.extractPushPayload({ content: { data } }), data);
  assert.deepEqual(L.extractPushPayload({ content: { data: {} }, trigger: { remoteMessage: { data } } }), data);
  assert.deepEqual(L.extractPushPayload({ content: { dataString: JSON.stringify(data) } }), data);
  assert.equal(L.extractPushPayload({ content: { data: { other: 1 } } }), undefined);
});

test("foreground banner is suppressed only while viewing that exact session", () => {
  const request = { content: { data: { pocket: "1", pairingId: "pair-a", kind: "permission", sessionId: "s1" } } };
  assert.equal(L.shouldPresentForeground(store, request, "a\u0000s1"), false);
  assert.equal(L.shouldPresentForeground(store, request, "a\u0000s2"), true);
  assert.equal(L.shouldPresentForeground(store, request, undefined), true);
  assert.equal(L.shouldPresentForeground(store, { content: { data: {} } }, "a\u0000s1"), true, "foreign notifications always show");
});

test("status derivation covers platform, plugin and registration states", () => {
  const on = store.servers.a; const off = store.servers.b;
  assert.equal(L.deriveStatus({ platform: "web", probe: ok(), record: on }).kind, "unsupported");
  assert.equal(L.deriveStatus({ platform: "ios", probe: ok(), record: off }).label, "Android only for now");
  assert.equal(L.deriveStatus({ platform: "android", probe: { state: "unknown" } }).kind, "checking");
  const missing = L.deriveStatus({ platform: "android", probe: { state: "missing" }, record: off });
  assert.equal(missing.kind, "plugin-missing"); assert.match(missing.label, /Plugin not installed/); assert.equal(missing.canToggle, false);
  assert.equal(L.deriveStatus({ platform: "android", probe: { state: "missing" }, record: on }).canToggle, true, "turning off is always allowed");
  assert.equal(L.deriveStatus({ platform: "android", probe: ok({ protocolVersion: 2 }), record: off }).kind, "plugin-unsupported");
  assert.equal(L.deriveStatus({ platform: "android", probe: ok({ notificationsConfigured: false }), record: off }).kind, "not-configured");
  assert.equal(L.deriveStatus({ platform: "android", probe: ok(), record: off }).kind, "off");
  assert.equal(L.deriveStatus({ platform: "android", probe: ok() }).kind, "off");
  assert.equal(L.deriveStatus({ platform: "android", probe: ok(), record: on }).kind, "on");
  assert.equal(L.deriveStatus({ platform: "android", probe: ok(), record: on, permission: "denied" }).kind, "blocked");
  assert.equal(L.deriveStatus({ platform: "android", probe: ok(), record: on, lastError: "Server rejected" }).kind, "error");
  assert.equal(L.deriveStatus({ platform: "android", probe: { state: "unreachable", message: "x" }, record: on }).kind, "unreachable");
});

test("stored state normalizes with safe defaults", () => {
  assert.deepEqual(L.normalizeStore(null), { servers: {} });
  const parsed = L.normalizeStore({ deviceId: "d", servers: { a: { pairingId: "p", enabled: "yes", preferences: { sessionFinished: true } }, bad: { enabled: true }, junk: 3 } });
  assert.equal(parsed.deviceId, "d");
  assert.deepEqual(Object.keys(parsed.servers), ["a"]);
  assert.equal(parsed.servers.a.enabled, false);
  assert.deepEqual(parsed.servers.a.preferences, { ...L.DEFAULT_PREFERENCES, sessionFinished: true });
  assert.deepEqual(L.DEFAULT_PREFERENCES, { needsPermission: true, needsAnswer: true, sessionFailed: true, sessionFinished: false, sessionInterrupted: false, includeSubagents: false, hideDetails: false });
});

test("OpenCode RPC envelopes: {output} unwraps and RpcError types are recognised", async () => {
  const { unwrapRpcResult, rpcErrorType } = await import("./notificationLogic.ts");
  assert.deepEqual(unwrapRpcResult({ output: { ok: true } }), { ok: true });
  assert.equal(rpcErrorType({ _tag: "RpcError", type: "rpc.unavailable", message: "RPC is unavailable: pocket" }), "rpc.unavailable");
  assert.equal(rpcErrorType({ message: "x" }), undefined);
});

test("availablePreferences follows the plugin's events option; older plugins keep the original toggles", () => {
  const legacy = ["needsPermission", "needsAnswer", "sessionFailed", "sessionFinished", "hideDetails"];
  assert.deepEqual(L.availablePreferences(undefined), legacy);
  assert.deepEqual(L.availablePreferences({ protocolVersion: 1, notificationsConfigured: true }), legacy);
  assert.deepEqual(L.availablePreferences({ protocolVersion: 1, notificationsConfigured: true, events: ["permission", "question", "failed", "finished", "interrupted"], subagents: true }), L.PREFERENCE_KEYS);
  assert.deepEqual(L.availablePreferences({ protocolVersion: 1, notificationsConfigured: true, events: ["permission", "finished"], subagents: false }), ["needsPermission", "sessionFinished", "hideDetails"]);
  assert.deepEqual(L.availablePreferences({ protocolVersion: 1, notificationsConfigured: true, events: ["question"] }), ["needsAnswer", "hideDetails"]);
  assert.deepEqual(L.parsePocketInfo({ protocolVersion: 1, notificationsConfigured: true, events: ["failed", 3], subagents: false }), { protocolVersion: 1, notificationsConfigured: true, events: ["failed"], subagents: false });
  assert.equal(L.parsePushData({ pocket: "1", pairingId: "p", kind: "interrupted", sessionId: "s" }).kind, "interrupted");
});
