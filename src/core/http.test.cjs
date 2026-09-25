// Run with: node --test src/core/http.test.cjs
// Capture the URL at the same fetch boundary used by PocketCore; never contact a server.
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  module._compile(ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }), filename);
};

const { fetchApi } = require(path.join(__dirname, "http.ts"));
const base = "https://opencode.example/prefix";
const interruptPath = "/api/session/ses_test/interrupt";

test("interrupt with a session directory sends resume=false and location[directory] as independent query params", async () => {
  const captured = [];
  const captureFetch = async (url) => { captured.push(String(url)); return { ok: true, status: 204 }; };
  await fetchApi(captureFetch, base, interruptPath, { resume: false }, "/workspace/a & b", { method: "POST" });

  assert.equal(captured.length, 1);
  const requestUrl = new URL(captured[0]);
  assert.equal(requestUrl.pathname, "/prefix/api/session/ses_test/interrupt");
  assert.deepEqual([...requestUrl.searchParams.entries()], [["resume", "false"], ["location[directory]", "/workspace/a & b"]]);
  assert.equal((captured[0].match(/\?/g) ?? []).length, 1);
});

test("interrupt without a session directory keeps only resume=false", async () => {
  const captured = [];
  const captureFetch = async (url) => { captured.push(String(url)); return { ok: true, status: 204 }; };
  await fetchApi(captureFetch, base, interruptPath, { resume: false }, undefined, { method: "POST" });

  assert.equal(captured.length, 1);
  const requestUrl = new URL(captured[0]);
  assert.equal(requestUrl.searchParams.get("resume"), "false");
  assert.equal(requestUrl.searchParams.has("location[directory]"), false);
  assert.equal((captured[0].match(/\?/g) ?? []).length, 1);
});

test("location is sent as the location[directory] deepObject key OpenCode v2 reads, never a plain directory param", async () => {
  const captured = [];
  await fetchApi(async (url) => { captured.push(String(url)); return { ok: true, status: 200 }; }, base, "/api/permission/request", {}, "/code/api", { method: "GET" });
  assert.match(captured[0], /\?location%5Bdirectory%5D=%2Fcode%2Fapi$/);
  assert.equal(new URL(captured[0]).searchParams.has("directory"), false);
});
