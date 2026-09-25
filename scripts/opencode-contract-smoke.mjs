#!/usr/bin/env node
/**
 * Read-only Pocket Control contract probe for OpenCode v2.
 *
 * Usage: OPENCODE_BASE_URL=http://127.0.0.1:4096 OPENCODE_PASSWORD=... node scripts/opencode-contract-smoke.mjs
 * OPENCODE_BASE_URL defaults to http://127.0.0.1:4096. Credentials are read at
 * runtime, sent only as HTTP Basic auth (user `opencode`), and never printed or
 * written. Every request is GET; the probe never prints response/transcript data.
 * Run the fixture-only self-test with: node --test scripts/opencode-contract-smoke.test.mjs
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = path.join(ROOT, 'compatibility/opencode-v2.json');

export function unwrap(value) {
  return value && !Array.isArray(value) && value.data !== undefined ? value.data : value;
}

export function listRows(value) {
  const body = unwrap(value);
  if (Array.isArray(body)) return body;
  for (const key of ['items', 'sessions', 'results']) if (Array.isArray(body?.[key])) return body[key];
  return [];
}

export function nextCursor(value) {
  const body = unwrap(value);
  return value?.cursor?.next ?? value?.nextCursor ?? value?.next_cursor ??
    body?.cursor?.next ?? body?.nextCursor ?? body?.next_cursor ?? undefined;
}

export function objectKeys(value) {
  const body = unwrap(value);
  return body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort() : [];
}

function check(condition, label) {
  if (!condition) throw new Error(`Contract check failed: ${label}`);
}

async function main() {
  const base = (process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:4096').replace(/\/$/, '');
  const password = process.env.OPENCODE_PASSWORD;
  if (!password) throw new Error('Set OPENCODE_PASSWORD in the environment; credentials are never prompted for or displayed.');
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
  const auth = `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;

  async function get(route, query = {}, directory) {
    const url = new URL(`${base}${route}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    const headers = { authorization: auth, accept: 'application/json' };
    if (directory) url.searchParams.set('location[directory]', directory);
    let response;
    try {
      response = await fetch(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
    } catch {
      throw new Error('OpenCode server request failed (network, TLS, or redirect error)');
    }
    if (!response.ok) {
      // Do not include response body, URL, or credentials in diagnostics.
      const safeRoute = route.replace(/\/api\/session\/[^/]+(?=\/|$)/, '/api/session/{id}');
      throw new Error(`${safeRoute} returned HTTP ${response.status}`);
    }
    return response.json();
  }

  const observed = {};
  const infoRaw = await get('/api/info'); // also verifies server reachability and auth
  const info = unwrap(infoRaw);
  check(info && typeof info === 'object', '/api/info JSON object');
  observed.infoKeys = objectKeys(infoRaw);

  const page1 = await get('/api/session', { limit: 2 });
  const rows1 = listRows(page1);
  check(Array.isArray(rows1), '/api/session collection shape');
  observed.sessionCollectionKeys = objectKeys(page1);
  observed.sessionPageShape = Array.isArray(page1) ? 'array' : Array.isArray(page1?.data) ? 'data-array' : 'object-envelope';
  observed.sessionRowKeys = rows1[0] ? objectKeys(rows1[0]) : [];
  observed.sessionPageHasCursor = Boolean(nextCursor(page1));
  // Exercise pagination only when the server advertises another page.
  if (nextCursor(page1)) {
    const page2 = await get('/api/session', { limit: 2, cursor: nextCursor(page1) });
    check(Array.isArray(listRows(page2)), '/api/session cursor page shape');
  }

  const activeRaw = await get('/api/session/active');
  const active = unwrap(activeRaw);
  check(Array.isArray(active) || (active && typeof active === 'object'), '/api/session/active collection shape');
  observed.activeShape = Array.isArray(active) ? 'array' : 'object';
  observed.activeRowShape = Array.isArray(active) ? (typeof active[0] === 'string' ? 'string' : active[0] ? 'object' : 'empty') : 'object-map';
  observed.activeRowKeys = Array.isArray(active) && active[0] && typeof active[0] === 'object' ? objectKeys(active[0]) : [];

  const locationsRaw = await get('/api/debug/location');
  const locations = listRows(locationsRaw);
  check(Array.isArray(locations), '/api/debug/location collection shape');
  observed.locationShape = Array.isArray(unwrap(locationsRaw)) ? 'array' : 'wrapped-array';
  observed.locationRowShape = typeof locations[0] === 'string' ? 'string' : locations[0] ? 'object' : 'empty';
  observed.locationRowKeys = locations[0] && typeof locations[0] === 'object' ? objectKeys(locations[0]) : [];

  // With at least one session, validate metadata and message envelope/row shape.
  const sample = rows1[0];
  if (sample?.id) {
    const metadataRaw = await get(`/api/session/${encodeURIComponent(sample.id)}`);
    const metadata = unwrap(metadataRaw);
    check(metadata && typeof metadata === 'object' && !Array.isArray(metadata), 'session metadata object');
    check(typeof metadata.id === 'string', 'session metadata id field');
    observed.metadataKeys = objectKeys(metadataRaw);
    const messagesRaw = await get(`/api/session/${encodeURIComponent(sample.id)}/message`, { limit: 2 }, sample.directory);
    const messages = listRows(messagesRaw);
    check(Array.isArray(messages), 'session message collection shape');
    observed.messageCollectionKeys = objectKeys(messagesRaw);
    observed.messageCollectionShape = Array.isArray(messagesRaw) ? 'array' : Array.isArray(messagesRaw?.data) ? 'data-array' : 'object-envelope';
    if (messages[0]) {
      const message = unwrap(messages[0]);
      check(message && typeof message === 'object' && typeof (message.id ?? message.info?.id) === 'string', 'message row id field');
      observed.messageKeys = objectKeys(message);
      observed.messageInfoKeys = objectKeys(message.info);
      observed.messagePartShape = Array.isArray(message.parts) ? 'parts-array' : 'no-parts-array';
    } else observed.messageKeys = [];
  } else {
    observed.metadataKeys = [];
    observed.messageCollectionKeys = [];
    observed.messageKeys = [];
    observed.sessionRowKeys = [];
    observed.messageCollectionShape = 'not-observed-no-session';
    observed.messageInfoKeys = [];
    observed.messagePartShape = 'not-observed-no-session';
  }

  // The server's loaded-location inventory scopes global pending permission and
  // form queues. Retain only shape observations; never log row contents.
  const permissions = [];
  const forms = [];
  let blockerEndpointsChecked = false;
  for (const loc of locations) {
    const directory = typeof loc === 'string' ? loc : loc?.directory ?? loc?.path;
    if (!directory) continue;
    const [pRaw, fRaw] = await Promise.all([
      get('/api/permission/request', {}, directory),
      get('/api/form', {}, directory),
    ]);
    const p = listRows(pRaw), f = listRows(fRaw);
    check(Array.isArray(p), 'permission queue collection shape');
    check(Array.isArray(f), 'form queue collection shape');
    blockerEndpointsChecked = true;
    if (p[0]) permissions.push(p[0]);
    if (f[0]) forms.push(f[0]);
  }
  observed.permissionKeys = permissions[0] ? objectKeys(permissions[0]) : [];
  observed.formKeys = forms[0] ? objectKeys(forms[0]) : [];
  observed.permissionShape = 'array';
  observed.formShape = 'array';

  check(fixture.server.major === 2, 'fixture targets OpenCode v2');
  check(fixture.client.version === '2.0.5', 'fixture pins @opencode/client 2.0.5');
  const serverVersion = info.version ?? info.versionString ?? info.server?.version;
  const safeVersion = typeof serverVersion === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(serverVersion) ? serverVersion : 'unreported';
  console.log(`PASS OpenCode API contract; server=${safeVersion}; @opencode/client=${fixture.client.version}`);
  console.log('PASS auth + /api/info');
  console.log('PASS paginated /api/session');
  console.log('PASS /api/session/active');
  console.log('PASS /api/debug/location');
  console.log(sample?.id ? 'PASS session metadata + message shape' : 'SKIP session metadata + message shape (no session available)');
  console.log(blockerEndpointsChecked ? 'PASS permission + form queue shape' : 'SKIP permission + form queue shape (no loaded location available)');
  // Report schema field names and shape labels only; never serialize values,
  // identifiers, paths, prompts, transcript text, cursors, or queue contents.
  const fields = (keys) => keys.length ? keys.join(',') : '(none observed)';
  console.log(`SHAPE info=${fields(observed.infoKeys)}`);
  console.log(`SHAPE sessions=${observed.sessionPageShape}; row-fields=${fields(observed.sessionRowKeys)}; cursor=${observed.sessionPageHasCursor ? 'available' : 'not available'}`);
  console.log(`SHAPE active=${observed.activeShape}/${observed.activeRowShape}; row-fields=${fields(observed.activeRowKeys)}`);
  console.log(`SHAPE locations=${observed.locationShape}/${observed.locationRowShape}; row-fields=${fields(observed.locationRowKeys)}`);
  if (sample?.id) {
    console.log(`SHAPE metadata-fields=${fields(observed.metadataKeys)}; messages=${observed.messageCollectionShape}; message-fields=${fields(observed.messageKeys)}; message-info-fields=${fields(observed.messageInfoKeys)}; parts=${observed.messagePartShape}`);
  }
  if (blockerEndpointsChecked) console.log(`SHAPE permissions=array; item-fields=${fields(observed.permissionKeys)}; forms=array; item-fields=${fields(observed.formKeys)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FAIL OpenCode contract smoke: ${error.message}`);
    process.exitCode = 1;
  });
}
