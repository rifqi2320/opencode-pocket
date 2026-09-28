const assert = require('node:assert/strict');
const { test } = require('node:test');

test('session controls default safely, isolate sessions, and stay bounded', async () => {
  const C = await import('./sessionControls.ts');
  const empty = C.normalizeSessionControlsStore(null);
  assert.deepEqual(C.controlsForSession(empty, 'server\u0000session'), C.DEFAULT_SESSION_CONTROLS);

  const first = C.updateSessionControls(empty, 'server\u0000one', { delivery: 'queue', showThinking: false }, 10);
  const second = C.updateSessionControls(first, 'server\u0000two', { expandToolDetails: true }, 20);
  assert.deepEqual(C.controlsForSession(second, 'server\u0000one'), { delivery: 'queue', showThinking: false, expandToolDetails: false });
  assert.deepEqual(C.controlsForSession(second, 'server\u0000two'), { delivery: 'automatic', showThinking: true, expandToolDetails: true });

  let bounded = empty;
  for (let i = 0; i <= C.MAX_SESSION_CONTROL_RECORDS; i++) bounded = C.updateSessionControls(bounded, `server\u0000${i}`, {}, i);
  assert.equal(Object.keys(bounded.sessions).length, C.MAX_SESSION_CONTROL_RECORDS);
  assert.equal(bounded.sessions['server\u00000'], undefined);
});

test('session controls reject malformed persisted values', async () => {
  const C = await import('./sessionControls.ts');
  const store = C.normalizeSessionControlsStore({ sessions: { good: { delivery: 'steer', showThinking: false, expandToolDetails: true, updatedAt: 5 }, broken: { delivery: 'bad', showThinking: 'yes', updatedAt: Infinity } } });
  assert.deepEqual(C.controlsForSession(store, 'good'), { delivery: 'steer', showThinking: false, expandToolDetails: true });
  assert.deepEqual(C.controlsForSession(store, 'broken'), C.DEFAULT_SESSION_CONTROLS);
});
