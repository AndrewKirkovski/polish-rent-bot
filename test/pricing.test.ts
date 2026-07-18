import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCost } from '../src/ai/pricing.js';

const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationTokens: 0, cacheReadTokens: 0 };

test('dated model id resolves to the alias pricing (Haiku)', () => {
  const dated = calculateCost('claude-haiku-4-5-20251001', usage);
  const alias = calculateCost('claude-haiku-4-5', usage);
  assert.ok(dated > 0, 'dated Haiku id must have non-zero cost');
  assert.equal(dated, alias);
  assert.equal(dated, 1.0 + 5.0); // $1/Mtok in + $5/Mtok out
});

test('unknown model → 0 (and does not throw)', () => {
  assert.equal(calculateCost('some-unknown-model', usage), 0);
});
