// Run with: node --test src/core/status.test.cjs
// Compile the production TypeScript module in-memory; no generated test artifacts or package edits.
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpile(source, {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  });
  module._compile(output, filename);
};

const { classifyRelationship, executionStatus, familyActivity, rollupFamilyRows, sessionDescendants, sessionFreshness, reconcileSnapshot } = require(path.join(__dirname, "status.ts"));

test("foreground activity stays independent of a historical outcome", () => {
  assert.equal(executionStatus({ active: true, outcome: "error", observedAt: 12, freshness: "fresh" }).value, "running");
  assert.equal(executionStatus({ active: false, outcome: "success" }).value, "inactive");
  assert.equal(executionStatus({ active: undefined, outcome: "success" }).value, "unknown");
});

test("relationship projection keeps roots, delegated children, and explicit forks distinct", () => {
  assert.equal(classifyRelationship({ id: "root" }), undefined);
  assert.equal(classifyRelationship({ id: "worker", parentID: "root" }), "subagent");
  // A fork may also carry a parent link; the explicit fork evidence must win.
  assert.equal(classifyRelationship({ id: "fork", parentID: "root", forkedFrom: "msg_1" }), "fork");
  assert.equal(classifyRelationship({ id: "unknown", parentID: "root", relationship: "related" }), "unknown");
});

test("an idle root remains inactive while a fresh active worker puts its family in Working", () => {
  const records = [{ id: "root" }, { id: "worker", parentID: "root" }];
  const rootStatus = executionStatus({ active: false, freshness: "fresh" }).value;
  const family = familyActivity({ records, parentId: "root", activeSessionIds: ["worker"], activeFreshness: "fresh", sessionsCoverage: "complete" });
  assert.equal(rootStatus, "inactive");
  assert.deepEqual({ status: family.status, activeWorkerCount: family.activeWorkerCount }, { status: "working", activeWorkerCount: 1 });
});

test("nested active grandchildren roll up through their worker ancestors", () => {
  const records = [{ id: "root" }, { id: "worker", parentID: "root" }, { id: "grandchild", parentID: "worker" }];
  const rootFamily = familyActivity({ records, parentId: "root", activeSessionIds: ["grandchild"], activeFreshness: "fresh", sessionsCoverage: "complete" });
  const workerFamily = familyActivity({ records, parentId: "worker", activeSessionIds: ["grandchild"], activeFreshness: "fresh", sessionsCoverage: "complete" });
  assert.deepEqual(rootFamily.descendants.map(item => [item.session.id, item.depth]), [["worker", 1], ["grandchild", 2]]);
  assert.equal(rootFamily.activeWorkerCount, 1);
  assert.equal(workerFamily.status, "working");
});

test("forks, unknown relationships, and matching IDs on another server are not root workers", () => {
  const records = [
    { id: "root", serverId: "server-a" },
    { id: "worker", serverId: "server-a", parentID: "root" },
    { id: "fork", serverId: "server-a", parentID: "root", forkedFrom: "msg" },
    { id: "unknown", serverId: "server-a", parentID: "root", relationship: "related" },
    { id: "worker", serverId: "server-b", parentID: "root" },
  ];
  assert.deepEqual(sessionDescendants(records, "root", "server-a").map(item => item.session.id), ["worker"]);
  const family = familyActivity({ records, parentId: "root", serverId: "server-a", activeSessionIds: ["worker"], activeFreshness: "fresh", sessionsCoverage: "complete" });
  assert.equal(family.activeWorkerCount, 1);
});

test("a descendant blocker rolls up with its owner unchanged", () => {
  const records = [{ id: "root" }, { id: "worker", parentID: "root" }, { id: "other" }];
  const blockers = [
    { id: "permission-1", sessionID: "worker", kind: "permission" },
    { id: "permission-2", sessionID: "other", kind: "permission" },
  ];
  const rolled = rollupFamilyRows({ records, parentId: "root", rows: blockers });
  assert.deepEqual(rolled.map(item => [item.row.id, item.ownerSessionId, item.depth]), [["permission-1", "worker", 1]]);
});

test("stale active snapshots and incomplete inventory do not report a family as ready", () => {
  const records = [{ id: "root" }, { id: "worker", parentID: "root" }];
  assert.equal(familyActivity({ records, parentId: "root", activeSessionIds: [], activeFreshness: "stale", sessionsCoverage: "complete" }).status, "unknown");
  assert.equal(familyActivity({ records, parentId: "root", activeSessionIds: [], activeFreshness: "fresh", sessionsCoverage: "partial" }).status, "unknown");
  // Positive fresh evidence remains useful even when the inventory is partial.
  assert.equal(familyActivity({ records, parentId: "root", activeSessionIds: ["worker"], activeFreshness: "fresh", sessionsCoverage: "partial" }).status, "working");
});

test("connected inventory remains live before message history is requested", () => {
  assert.equal(sessionFreshness({ transport: "live", hasInventory: true, inventoryFreshness: "fresh", activeFreshness: "fresh", messagesLoaded: false, messagesFreshness: "offline" }), "live");
  assert.equal(sessionFreshness({ transport: "live", hasInventory: true, inventoryFreshness: "fresh", activeFreshness: "stale" }), "stale");
  assert.equal(sessionFreshness({ transport: "auth-error", hasInventory: true, inventoryFreshness: "fresh", activeFreshness: "fresh" }), "offline");
});

test("snapshot stays publishable but remains dirty when an event arrives during the read", () => {
  const readStartedAtDirtyCount = 7;
  const result = reconcileSnapshot(
    { value: ["snapshot captured before event"], dirtyAtStart: readStartedAtDirtyCount, generation: 3 },
    3,
    8,
  );
  assert.deepEqual(result, { publish: true, dirty: true });
});

test("a completed snapshot is clean only when neither its dirty count nor connection changed", () => {
  assert.deepEqual(
    reconcileSnapshot({ value: 1, dirtyAtStart: 4, generation: 9 }, 9, 4),
    { publish: true, dirty: false },
  );
  assert.deepEqual(
    reconcileSnapshot({ value: 1, dirtyAtStart: 4, generation: 9 }, 10, 4),
    { publish: false, dirty: true },
  );
});
