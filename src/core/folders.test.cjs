// Run with: node --test src/core/folders.test.cjs
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  module._compile(ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }), filename);
};

const { folderName, normalizeDirectory, resolveFolderInput } = require(path.join(__dirname, "folders.ts"));
const known = ["/home/me/code/api", "/home/me/code/web/", "/srv/web", "/home/me/code/docs"];

test("normalizeDirectory trims whitespace and trailing separators but keeps roots", () => {
  assert.equal(normalizeDirectory("  /home/me/code/api/  "), "/home/me/code/api");
  assert.equal(normalizeDirectory("/"), "/");
  assert.equal(normalizeDirectory("C:\\"), "C:\\");
  assert.equal(normalizeDirectory("C:\\work\\"), "C:\\work");
  assert.equal(folderName("/home/me/code/api/"), "api");
});

test("absolute paths pass through for the server to confirm", () => {
  assert.deepEqual(resolveFolderInput("/tmp/new-project/", known), { ok: true, directory: "/tmp/new-project" });
  assert.deepEqual(resolveFolderInput("D:\\repos\\x", known), { ok: true, directory: "D:\\repos\\x" });
});

test("a bare folder name must match exactly one known folder", () => {
  assert.deepEqual(resolveFolderInput("api", known), { ok: true, directory: "/home/me/code/api" });
  assert.deepEqual(resolveFolderInput(" docs ", known), { ok: true, directory: "/home/me/code/docs" });
  const ambiguous = resolveFolderInput("web", known);
  assert.equal(ambiguous.ok, false); assert.match(ambiguous.error, /More than one.*\/home\/me\/code\/web.*\/srv\/web/);
  const missing = resolveFolderInput("nope", known);
  assert.equal(missing.ok, false); assert.match(missing.error, /does not exist/);
});

test("empty, home-relative and relative paths are rejected before reaching the server", () => {
  assert.equal(resolveFolderInput("   ", known).ok, false);
  assert.match(resolveFolderInput("~/code/api", known).error, /full path/);
  assert.match(resolveFolderInput("code/api", known).error, /absolute path/);
});
