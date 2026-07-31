import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRentalCard, captionLength, CAPTION_LIMIT } from '../src/bot/format.js';
import { computeRentalCost } from '../src/cost.js';
import { mkListing, mkParsed, mkScore } from './helpers.js';

test('computeRentalCost sums najem + czynsz + media', () => {
  const c = computeRentalCost({ price: 4000, rent: 500 }, mkParsed({ adminFee: 600, estimatedMedia: { water: null, electricity: 200, gas: null, internet: null, heating: null, other: null } }));
  assert.equal(c.total, 4000 + 600 + 200); // adminFee overrides listing.rent
});

test('line 1 is rooms · m² · total price · [id] with no emoji', () => {
  const card = formatRentalCard(mkListing(), mkParsed(), null, 'ABC234');
  const line1 = card.split('\n')[0];
  assert.match(line1, /3к/);
  assert.match(line1, /60m²/);
  assert.match(line1, /zł/);
  assert.match(line1, /\[ABC234\]/);
  assert.doesNotMatch(line1, /[🏠💰🚇🔥📞]/); // no emoji on the headline
});

test('internet and "2 offices" tokens are dropped', () => {
  const card = formatRentalCard(
    mkListing({ hasInternet: true }),
    mkParsed({ twoOfficeCapable: true, internetType: 'fiber' }),
    null,
    'ABC234',
  );
  assert.doesNotMatch(card, /интернет|оптика|2 офиса/);
});

test('metro line shows the 2 nearest stations with walk distance/time', () => {
  const score = mkScore([], {
    metroNearest: [
      { name: 'Politechnika', lineName: 'M1', walkingMinutes: 6, distance: '450 м', distanceMeters: 450 },
      { name: 'Pole Mokotowskie', lineName: 'M1', walkingMinutes: 9, distance: '700 м', distanceMeters: 700 },
    ],
  });
  const card = formatRentalCard(mkListing(), mkParsed(), score, 'ABC234');
  assert.match(card, /Метро: Politechnika \(M1\) 450 м · 6 мин · Pole Mokotowskie \(M1\) 700 м · 9 мин/);
});

test('no coords → metro line says stations unknown', () => {
  const card = formatRentalCard(mkListing(), mkParsed(), mkScore([], { metroNearest: [], precision: 'none' }), 'ABC234');
  assert.match(card, /Метро: станции неизвестны/);
});

test('central station line shows distance + a min-based time range', () => {
  const score = mkScore([], {
    metroNearest: [{ name: 'Centrum', lineName: 'M1', walkingMinutes: 3, distance: '250 м', distanceMeters: 250 }],
    centralStation: { distanceText: '4,2 км', durationMinRange: { min: 17, max: 21 } },
  });
  const card = formatRentalCard(mkListing(), mkParsed(), score, 'ABC234');
  assert.match(card, /Центральный вокзал: 4,2 км · ~17–21 мин/);
});

test('central station line renders "не определён" when routing failed', () => {
  const score = mkScore([], {
    metroNearest: [{ name: 'Centrum', lineName: 'M1', walkingMinutes: 3, distance: '250 м', distanceMeters: 250 }],
    centralStation: null,
  });
  const card = formatRentalCard(mkListing(), mkParsed(), score, 'ABC234');
  assert.match(card, /Центральный вокзал: не определён/);
});

test('approximate location shows metro range and a warning on the central line', () => {
  const score = mkScore([], {
    precision: 'approximate',
    locationWarning: 'примерная локация: описание, погрешность ±150 м',
    metroNearest: [{
      name: 'Bemowo', lineName: 'M2', walkingMinutes: 0, distance: '',
      walkingMinutesRange: { min: 11, max: 16 }, distanceMetersRange: { min: 850, max: 1150 }, approximate: true,
    }],
    centralStation: { distanceText: '~5,0 км', durationMinRange: { min: 25, max: 35 } },
  });
  const card = formatRentalCard(mkListing(), mkParsed(), score, 'ABC234');
  assert.match(card, /Bemowo \(M2\) ~850 м–1,2 км · ~11–16 мин/);
  assert.match(card, /примерная локация/);
});

test('line 4 carries contract type and kaucja', () => {
  const card = formatRentalCard(
    mkListing(),
    mkParsed({ contractType: 'najem_okazjonalny', deposit: 4500 }),
    null,
    'ABC234',
  );
  assert.match(card, /Umowa: najem okazjonalny/);
  assert.match(card, /Kaucja: /);
});

test('the listing link is the last line', () => {
  const card = formatRentalCard(mkListing(), mkParsed({ descriptionSummary: 'ładne mieszkanie' }), null, 'ABC234');
  assert.equal(card.split('\n').at(-1), 'http://example.com/x');
});

test('over-budget card is trimmed under the caption budget, essentials kept', () => {
  const big = mkParsed({
    descriptionSummary: 'x'.repeat(2000),
    positives: ['p'.repeat(400)],
    redFlags: ['r'.repeat(400)],
    restrictions: ['только студенты'.repeat(30)],
    contractType: 'najem_okazjonalny',
  });
  const score = mkScore([], {
    metroNearest: [{ name: 'Politechnika', lineName: 'M1', walkingMinutes: 6, distance: '450 м', distanceMeters: 450 }],
    centralStation: { distanceText: '4,2 км', durationMinRange: { min: 17, max: 21 } },
  });
  const card = formatRentalCard(mkListing(), big, score, 'ABC234', 'z'.repeat(200));
  assert.ok(captionLength(card) <= CAPTION_LIMIT - 8, `visible length ${captionLength(card)} > ${CAPTION_LIMIT - 8}`);
  assert.match(card, /\[ABC234\]/);                       // id kept
  assert.match(card, /Метро: Politechnika/);              // metro kept
  assert.match(card, /Центральный вокзал/);               // central kept
  assert.match(card, /Kaucja/);                           // contract/deposit kept
  assert.equal(card.split('\n').at(-1), 'http://example.com/x'); // link stays last
});
