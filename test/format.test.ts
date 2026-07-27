import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRentalCard, captionLength, CAPTION_LIMIT } from '../src/bot/format.js';
import { computeRentalCost } from '../src/cost.js';
import { mkListing, mkParsed, mkScore } from './helpers.js';

test('computeRentalCost sums najem + czynsz + media', () => {
  const c = computeRentalCost({ price: 4000, rent: 500 }, mkParsed({ adminFee: 600, estimatedMedia: { water: null, electricity: 200, gas: null, internet: null, heating: null, other: null } }));
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
  // Assert the tighter budget the trim actually targets (CAPTION_LIMIT - 24, leaving room
  // for the interactive "[ID] " prefix), and pass a long non-droppable fit line on top.
  const card = formatRentalCard(mkListing({ phone: '123' }), big, null, 'z'.repeat(200));
  assert.ok(captionLength(card) <= CAPTION_LIMIT - 24, `visible length ${captionLength(card)} > ${CAPTION_LIMIT - 24}`);
  assert.match(card, /\/мес/);                 // price kept
  assert.match(card, /example\.com/);          // url kept
  assert.match(card, /Kaucja/);                // contract/deposit kept
  assert.match(card, /🔥/);                    // the fit line survives the trim
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

test('metro result always shows station name and measured distance', () => {
  const score = mkScore([{
    type: 'metro',
    places: [{ name: 'Racławicka', lineName: 'M1', walkingMinutes: 7, distance: '500 m', distanceMeters: 500 }],
    nearest: { name: 'Racławicka', lineName: 'M1', walkingMinutes: 7, distance: '500 m', distanceMeters: 500 },
    withinLimit: true,
  }]);
  const card = formatRentalCard(mkListing(), mkParsed(), score);
  assert.match(card, /Racławicka \(M1\)/);
  assert.match(card, /500 m · 7 мин/);
});

test('approximate metro result shows distance range and warning evidence', () => {
  const score = mkScore([{
    type: 'metro',
    places: [{
      name: 'Bemowo', lineName: 'M2', walkingMinutes: 0, distance: '1 m',
      walkingMinutesRange: { min: 11, max: 16 },
      distanceMetersRange: { min: 850, max: 1150 },
      approximate: true,
    }],
    nearest: {
      name: 'Bemowo', lineName: 'M2', walkingMinutes: 0, distance: '1 m',
      walkingMinutesRange: { min: 11, max: 16 },
      distanceMetersRange: { min: 850, max: 1150 },
      approximate: true,
    },
    withinLimit: false,
    uncertain: false,
  }], {
    precision: 'approximate',
    locationWarning: 'примерная локация: описание, оценка ±150 м',
    locationEvidence: '1000 m od metra',
  });
  const card = formatRentalCard(mkListing(), mkParsed(), score);
  assert.match(card, /Bemowo \(M2\)/);
  assert.match(card, /~850 м–1,2 км · ~11–16 мин/);
  assert.match(card, /1000 m od metra/);
});

test('unknown metro distance still identifies the requested line', () => {
  const score = mkScore([{
    type: 'metro',
    requestedLine: 'M1',
    places: [],
    nearest: null,
    withinLimit: false,
    uncertain: true,
  }], {
    precision: 'none',
    locationUnknown: true,
    locationWarning: 'местоположение не удалось определить',
  });

  const card = formatRentalCard(mkListing(), mkParsed(), score);
  assert.match(card, /метро M1: станция\/расстояние неизвестны/);
  assert.match(card, /местоположение не удалось определить/);
});

test('partial Maps evidence renders a warning, not a false metro failure mark', () => {
  const score = mkScore([{
    type: 'metro',
    requestedLine: 'M1',
    places: [{
      name: 'Ratusz Arsenał',
      lineName: 'M1',
      walkingMinutes: 30,
      distance: '2 km',
      distanceMetersRange: { min: 1800, max: 2200 },
      walkingMinutesRange: { min: 27, max: 33 },
      approximate: true,
    }],
    nearest: {
      name: 'Ratusz Arsenał',
      lineName: 'M1',
      walkingMinutes: 30,
      distance: '2 km',
      distanceMetersRange: { min: 1800, max: 2200 },
      walkingMinutesRange: { min: 27, max: 33 },
      approximate: true,
    },
    withinLimit: false,
    uncertain: true,
    error: true,
  }]);

  const card = formatRentalCard(mkListing(), mkParsed(), score);
  assert.match(card, /Ratusz Arsenał \(M1\).*⚠️/);
  assert.doesNotMatch(card, /Ratusz Arsenał \(M1\).*✗/);
});
