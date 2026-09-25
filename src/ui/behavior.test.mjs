import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { actionableRequests, canConfirmSavedServerRemoval, groupSessionSections } from './behavior.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const makeSession = (id, overrides = {}) => ({
  id, server: 'Fixture', project: 'fixture', title: id, status: 'inactive', familyStatus: 'inactive', familyCoverage: 'complete',
  summary: 'No active execution observed', lastSeen: 'not observed', freshness: 'live', attention: [], forms: [], workers: [], messages: [], ...overrides,
});

test('Needs You contains only a permission, unanswered form, or OpenCode handoff', () => {
  const permission = { id: 'p1', kind: 'permission', label: 'Allow write', ownerSessionKey: 'worker-1' };
  const form = { id: 'f1', kind: 'form', label: 'Answer question', ownerSessionKey: 'worker-2' };
  const handoff = { id: 'u1', kind: 'unsupported', label: 'Continue in OpenCode', ownerSessionKey: 'worker-3' };
  const failed = { id: 'e1', kind: 'failure', label: 'Tool failed' };
  assert.deepEqual(actionableRequests(makeSession('requests', { attention: [permission, form, handoff, failed] })), [permission, form, handoff]);
});

test('failed, inactive and quiet families stay out of Needs You and have separate sections', () => {
  const input = [
    makeSession('failure', { failure: 'Failure reported in session activity' }),
    makeSession('failed-request', { failure: 'Failure reported', attention: [{ id: 'p', kind: 'permission', label: 'Allow action' }] }),
    makeSession('working', { status: 'running' }),
    makeSession('quiet'),
    makeSession('unknown', { familyCoverage: 'unknown' }),
  ];
  const sections = groupSessionSections(input, 'all');
  assert.deepEqual(sections.needs.map(session => session.id), ['failed-request']);
  assert.deepEqual(sections.failures.map(session => session.id), ['failure']);
  assert.deepEqual(sections.working.map(session => session.id), ['working']);
  assert.deepEqual(sections.unknown.map(session => session.id), ['unknown']);
  assert.deepEqual(sections.recent.map(session => session.id), ['quiet']);
  const occurrences = Object.values(sections).flat().map(session => session.id);
  assert.equal(new Set(occurrences).size, occurrences.length, 'a root family must appear in one section only');
});

test('saved-server deletion stays gated until the matching explicit confirmation', () => {
  assert.equal(canConfirmSavedServerRemoval(undefined, 'fixture-server'), false);
  assert.equal(canConfirmSavedServerRemoval('another-server', 'fixture-server'), false);
  assert.equal(canConfirmSavedServerRemoval('fixture-server', 'fixture-server'), true);
});

const uiFiles = ['src/ui/SessionsScreen.tsx', 'src/ui/SessionDetailScreen.tsx', 'src/ui/ServersScreen.tsx', 'src/ui/FormReplyCard.tsx'];
const readUi = async () => (await Promise.all(uiFiles.map(file => readFile(path.join(root, file), 'utf8')))).join('\n');

test('interactive controls use Pressable semantics, not clickable Text', async () => {
  const screens = await readUi();
  const components = await readFile(path.join(root, 'src/ui/components.tsx'), 'utf8');
  assert.doesNotMatch(screens, /<Text[^>]*\bonPress=/, 'Text must not carry pointer-only actions');
  assert.match(components, /<AccessiblePressable[^>]*accessibilityRole="button"/, 'shared actions should use the native Pressable wrapper');
  assert.match(components, /key === 'Enter'/, 'web buttons keep an explicit Enter activation fallback');
});

test('pages have no fixed width and mobile-web inputs are promoted to 16px', async () => {
  const screens = await readUi();
  const components = await readFile(path.join(root, 'src/ui/components.tsx'), 'utf8');
  assert.doesNotMatch(screens, /page: \{[^}]*\bwidth: \d/);
  assert.match(components, /fontSize: Platform\.OS === 'web' \? 16/);
});

test('text tokens clear WCAG AA on every surface in both palettes', async () => {
  const theme = await readFile(path.join(root, 'src/ui/theme.ts'), 'utf8');
  const linear = value => { const channel = parseInt(value, 16) / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; };
  const luminance = color => [1, 3, 5].map(index => linear(color.slice(index, index + 2))).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const contrast = (foreground, background) => { const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a); return (high + 0.05) / (low + 0.05); };
  const palettes = [...theme.matchAll(/const (dark|light): Palette = \{([\s\S]*?)\n\};/g)];
  assert.equal(palettes.length, 2, 'dark and light palettes should be present');
  for (const [, name, body] of palettes) {
    const token = key => body.match(new RegExp(`\\b${key}: '(#[0-9A-Fa-f]{6})'`))?.[1];
    for (const surface of ['bg', 'surface']) for (const text of ['text', 'muted', 'faint', 'danger']) {
      assert.ok(contrast(token(text), token(surface)) >= 4.5, `${name}: ${text} on ${surface}`);
    }
    assert.ok(contrast(token('accentText'), token('accent')) >= 4.5, `${name}: primary button label`);
  }
});
