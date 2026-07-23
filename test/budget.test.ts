import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exceedsBudgetFloor, computeRentalCost } from '../src/cost.js';
import { rentalParseCacheKey } from '../src/ai/parse-listing.js';
import { mkListing, mkParsed } from './helpers.js';
import { extractResultId, prefixResultIdHtml } from '../src/utils/result-id.js';

test('exceedsBudgetFloor: base rent over budget → skip', () => {
  assert.equal(exceedsBudgetFloor(mkListing({ price: 8500 }), 8000), true);
});

test('exceedsBudgetFloor: base rent within budget → do not skip (even if czynsz might push over)', () => {
  // najem alone is under budget; czynsz/media are unknown pre-parse and must NOT trigger a skip.
  assert.equal(exceedsBudgetFloor(mkListing({ price: 4000, rent: 5000 }), 8000), false);
});

test('rentalParseCacheKey folds in the version — a bump misses old rows', () => {
  const listing = mkListing({ description: 'ładne mieszkanie na Mokotowie' });
  assert.notEqual(rentalParseCacheKey(listing, 'wfh-v1'), rentalParseCacheKey(listing, 'wfh-v2'));
  assert.equal(rentalParseCacheKey(listing, 'wfh-v1'), rentalParseCacheKey(listing, 'wfh-v1'));
});

test('rentalParseCacheKey misses when title changes even if description is set', () => {
  const a = mkListing({ title: 'A', description: 'same body' });
  const b = mkListing({ title: 'B', description: 'same body' });
  assert.notEqual(rentalParseCacheKey(a), rentalParseCacheKey(b));
});

test('rentalParseCacheKey misses when cost-relevant structured fields change', () => {
  const a = mkListing({ description: 'same', rent: 500 });
  const b = mkListing({ description: 'same', rent: 900 });
  assert.notEqual(rentalParseCacheKey(a), rentalParseCacheKey(b));
});

test('rentalParseCacheKey stable for identical listing inputs', () => {
  const a = mkListing({ description: 'x', price: 4000, hasInternet: true });
  const b = mkListing({ description: 'x', price: 4000, hasInternet: true });
  assert.equal(rentalParseCacheKey(a), rentalParseCacheKey(b));
});

test('computeRentalCost includes estimatedMedia.other lump', () => {
  const c = computeRentalCost(
    { price: 4000, rent: 500 },
    mkParsed({
      adminFee: 600,
      estimatedMedia: {
        water: null, electricity: 200, gas: null, internet: null, heating: null, other: 400,
      },
    }),
  );
  assert.equal(c.total, 4000 + 600 + 200 + 400);
  assert.ok(c.mediaParts.some((p) => p.label === 'media' && p.value === 400));
});

test('extractResultId reads codes from HTML captions', () => {
  assert.equal(extractResultId('<b>[GM7WX3]</b>\nrest'), 'GM7WX3');
  assert.equal(extractResultId('[GM7WX3] rest'), 'GM7WX3');
  assert.equal(extractResultId('no code here'), null);
});

test('prefixResultIdHtml prepends bold bracket id', () => {
  assert.equal(prefixResultIdHtml('ABC234', 'hello'), '<b>[ABC234]</b>\nhello');
});
