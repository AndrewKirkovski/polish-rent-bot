import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exceedsBudgetFloor } from '../src/cost.js';
import { rentalParseCacheKey } from '../src/ai/parse-listing.js';
import { mkListing } from './helpers.js';

test('exceedsBudgetFloor: base rent over budget → skip', () => {
  assert.equal(exceedsBudgetFloor(mkListing({ price: 8500 }), 8000), true);
});

test('exceedsBudgetFloor: base rent within budget → do not skip (even if czynsz might push over)', () => {
  // najem alone is under budget; czynsz/media are unknown pre-parse and must NOT trigger a skip.
  assert.equal(exceedsBudgetFloor(mkListing({ price: 4000, rent: 5000 }), 8000), false);
});

test('rentalParseCacheKey folds in the version — a bump misses old rows', () => {
  const desc = 'ładne mieszkanie na Mokotowie';
  assert.notEqual(rentalParseCacheKey(desc, 'wfh-v1'), rentalParseCacheKey(desc, 'wfh-v2'));
  assert.equal(rentalParseCacheKey(desc, 'wfh-v1'), rentalParseCacheKey(desc, 'wfh-v1'));
});
