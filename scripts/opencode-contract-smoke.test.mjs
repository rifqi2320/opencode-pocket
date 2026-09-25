// Self-contained, offline fixture tests: node --test scripts/opencode-contract-smoke.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { listRows, nextCursor, objectKeys, unwrap } from './opencode-contract-smoke.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('fixture pins the supported v2 contract without private data', async () => {
  const fixture = JSON.parse(await readFile(path.join(root, 'compatibility/opencode-v2.json'), 'utf8'));
  assert.equal(fixture.server.testedVersion, '2.0.12');
  assert.equal(fixture.client.version, '2.0.5');
  assert.equal(fixture.requests.method, 'GET only');
  assert.equal(fixture.privacy.transcriptContent, false);
  assert.equal(fixture.privacy.noPrivateIdPathOrPromptValues, true);
  assert.ok(!JSON.stringify(fixture).match(/(?:ses_[A-Za-z0-9]+|\/Users\/|"prompt"\s*:)/));
});

test('supports array, wrapped and cursor-paginated session response envelopes', () => {
  const wrapped = { data: { items: [{ id: 'fixture-id' }] }, cursor: { next: 'fixture-cursor' } };
  assert.deepEqual(listRows(wrapped), [{ id: 'fixture-id' }]);
  assert.equal(nextCursor(wrapped), 'fixture-cursor');
  assert.deepEqual(listRows([{ id: 'fixture-id' }]), [{ id: 'fixture-id' }]);
  assert.deepEqual(listRows({ sessions: [{ id: 'fixture-id' }] }), [{ id: 'fixture-id' }]);
});

test('unwraps data envelopes and derives only object field names', () => {
  assert.deepEqual(unwrap({ data: { safe: true } }), { safe: true });
  assert.deepEqual(objectKeys({ data: { id: 'not persisted', title: 'not persisted' } }), ['id', 'title']);
});
