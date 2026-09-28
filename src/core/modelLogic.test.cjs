const assert = require('node:assert/strict');
const { test } = require('node:test');

test('normalizes enabled server models and their variants', async () => {
  const { normalizeModels } = await import('./modelLogic.ts');
  assert.deepEqual(normalizeModels([
    { providerID: 'openai', id: 'gpt-5.6', name: 'GPT-5.6', enabled: true, variants: [{ id: 'fast' }, { id: 2 }] },
    { providerID: 'anthropic', modelID: 'claude-sonnet', enabled: true, variants: [] },
    { providerID: 'openai', id: 'gpt-5.6', enabled: true },
    { providerID: 'off', id: 'hidden', enabled: false },
    { id: 'missing-provider' },
  ]), [
    { providerID: 'anthropic', id: 'claude-sonnet', name: 'claude-sonnet', variants: [] },
    { providerID: 'openai', id: 'gpt-5.6', name: 'GPT-5.6', variants: [{ id: 'fast' }] },
  ]);
});

test('uses the exact V2 model-switch payload and omits an absent variant', async () => {
  const { sessionModelPayload } = await import('./modelLogic.ts');
  assert.deepEqual(sessionModelPayload({ providerID: 'openai', id: 'gpt-5.6', variant: 'fast' }), {
    model: { providerID: 'openai', id: 'gpt-5.6', variant: 'fast' },
  });
  assert.deepEqual(sessionModelPayload({ providerID: 'openai', id: 'gpt-5.6' }), {
    model: { providerID: 'openai', id: 'gpt-5.6' },
  });
});
