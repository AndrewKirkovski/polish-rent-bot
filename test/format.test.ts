import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRentalCard, captionLength, CAPTION_LIMIT } from '../src/bot/format.js';
import { computeRentalCost } from '../src/cost.js';
import { mkListing, mkParsed, mkScore } from './helpers.js';

test('computeRentalCost sums najem + czynsz + media', () => {
  const c = computeRentalCost({ price: 4000, rent: 500 }, mkParsed({ adminFee: 600, estimatedMedia: { water: null, electricity: 200, gas: null, internet: null, heating: null } }));
  assert.equal(c.total, 4000 + 600 + 200); // adminFee overrides listing.rent
});

test('card has no pet/smoking icons and shows WFH strip', () => {
  const card = formatRentalCard(
    mkListing({ hasInternet: true, hasElevator: true, phone: '123' }),
    mkParsed({ twoOfficeCapable: true, quiet: 'quiet', internetType: 'fiber' }),
    null,
  );
  assert.doesNotMatch(card, /🐾|🚬/);          // pet/smoking removed
  assert.match(card, /2 офиса/);               // persona strip present
  assert.match(card, /оптика/);
});

test('over-budget card is trimmed under the caption budget, essentials kept', () => {
  const big = mkParsed({
    descriptionSummary: 'x'.repeat(2000),
    positives: ['p'.repeat(400)],
    redFlags: ['r'.repeat(400)],
    restrictions: ['только студенты'.repeat(30)],
    contractType: 'najem_okazjonalny',
  });
  const card = formatRentalCard(mkListing({ phone: '123' }), big, null);
  assert.ok(captionLength(card) <= CAPTION_LIMIT, `visible length ${captionLength(card)} > ${CAPTION_LIMIT}`);
  assert.match(card, /\/мес/);                 // price kept
  assert.match(card, /example\.com/);          // url kept
  assert.match(card, /Kaucja/);                // contract/deposit kept
});

test('fit reason line renders when provided', () => {
  const card = formatRentalCard(mkListing(), mkParsed(), null, '82 · 2 офиса · оптика · метро 4м');
  assert.match(card, /82 · 2 офиса · оптика · метро 4м/);
});

test('card location line renders cafe/restaurant icons', () => {
  const score = mkScore([
    { type: 'cafe', places: [{ name: 'C', walkingMinutes: 4, distance: '' }], nearest: { name: 'C', walkingMinutes: 4, distance: '' }, withinLimit: true },
    { type: 'restaurant', places: [{ name: 'R', walkingMinutes: 6, distance: '' }], nearest: { name: 'R', walkingMinutes: 6, distance: '' }, withinLimit: false },
  ]);
  const card = formatRentalCard(mkListing({ district: 'Wola' }), mkParsed(), score);
  assert.match(card, /☕/);
  assert.match(card, /🍽/);
});
