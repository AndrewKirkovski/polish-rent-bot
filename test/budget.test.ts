import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exceedsBudgetFloor, computeRentalCost } from '../src/cost.js';
import { locationEvidenceSupportsAnchor, normalizeLocationHint, rentalParseCacheKey } from '../src/ai/parse-listing.js';
import { ParsedRentalDataSchema } from '../src/ai/schemas.js';
import { mkListing, mkParsed } from './helpers.js';
import { extractResultId, prefixResultIdHtml } from '../src/utils/result-id.js';

test('exceedsBudgetFloor: base rent over budget → skip', () => {
  assert.equal(exceedsBudgetFloor(mkListing({ price: 8500 }), 8000), true);
});

test('exceedsBudgetFloor: base rent within budget → do not skip (even if czynsz might push over)', () => {
  // najem alone is under budget; czynsz/media are unknown pre-parse and must NOT trigger a skip.
  assert.equal(exceedsBudgetFloor(mkListing({ price: 4000, rent: 5000 }), 8000), false);
});

test('exceedsBudgetFloor: a non-PLN price is never a hard floor (falls through to the soft unverifiable path)', () => {
  // A sub-PLN currency number over the PLN budget must NOT hard-drop the flat; only PLN is comparable.
  assert.equal(exceedsBudgetFloor(mkListing({ price: 9000, currency: 'CZK' }), 8000), false);
  assert.equal(exceedsBudgetFloor(mkListing({ price: 9000, currency: 'PLN' }), 8000), true);
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

test('building anchor cannot inherit distance evidence about another place', () => {
  const hint = normalizeLocationHint({
    query: 'osiedle Przyjaźń Jelonki Bemowo, Warszawa',
    kind: 'building',
    anchorDistanceMeters: 1000,
    uncertaintyMeters: 250,
    evidence: '3 przystanki (1000 m) od metra Bemowo Ratusz',
  });

  assert.equal(hint.anchorDistanceMeters, 0);
  assert.equal(hint.evidence, null);
  assert.equal(hint.uncertaintyMeters, 250);
});

test('remote building named by its own distance evidence becomes a landmark anchor', () => {
  const hint = normalizeLocationHint({
    query: 'Hala Targowa Wola, Warszawa',
    kind: 'building',
    anchorDistanceMeters: 1000,
    uncertaintyMeters: 250,
    evidence: '1000 m od Hali Targowej Wola',
  });

  assert.equal(hint.kind, 'landmark');
  assert.equal(hint.anchorDistanceMeters, 1000);
  assert.equal(hint.evidence, '1000 m od Hali Targowej Wola');
});

test('transit anchor keeps an explicitly stated distance', () => {
  const hint = normalizeLocationHint({
    query: 'metro Bemowo, Warszawa',
    kind: 'transit_stop',
    anchorDistanceMeters: 1000,
    uncertaintyMeters: 200,
    evidence: '1000 m od metra Bemowo',
  });

  assert.equal(hint.anchorDistanceMeters, 1000);
  assert.equal(hint.evidence, '1000 m od metra Bemowo');
});

test('distance evidence cannot be attached to a different transit anchor', () => {
  const hint = normalizeLocationHint({
    query: 'przystanek Hala Wola, Warszawa',
    kind: 'transit_stop',
    anchorDistanceMeters: 250,
    uncertaintyMeters: 100,
    evidence: '250 m od przystanku Ciepłownia Wola',
  });

  assert.equal(hint.kind, 'none');
  assert.equal(hint.query, null);
  assert.equal(hint.anchorDistanceMeters, null);
  assert.equal(hint.evidence, '250 m od przystanku Ciepłownia Wola');
});

test('anchor evidence matching tolerates normal Polish inflection', () => {
  assert.equal(
    locationEvidenceSupportsAnchor('Hala Targowa Wola, Warszawa', 'blisko Hali Targowej Wola'),
    true,
  );
  assert.equal(
    locationEvidenceSupportsAnchor('M1 Centrum, Warszawa', '7 minut pieszo do metra Centrum'),
    true,
  );
});

test('city-scale stated anchor distance is preserved', () => {
  const hint = normalizeLocationHint({
    query: 'metro Młociny, Warszawa',
    kind: 'transit_stop',
    anchorDistanceMeters: 12_000,
    uncertaintyMeters: 500,
    evidence: '12 km od metra Młociny',
  });

  assert.equal(hint.anchorDistanceMeters, 12_000);
  assert.equal(hint.uncertaintyMeters, 500);
});

test('rental schema accepts city-scale location evidence without failing the whole parse', () => {
  const parsed = ParsedRentalDataSchema.parse({
    locationHint: {
      query: 'metro Młociny, Warszawa',
      kind: 'transit_stop',
      anchorDistanceMeters: 12_000,
      uncertaintyMeters: 500,
      evidence: '12 km od metra Młociny',
    },
  });

  assert.equal(parsed.locationHint.anchorDistanceMeters, 12_000);
});

test('named estate is a fixed area anchor, not a displaced point', () => {
  const hint = normalizeLocationHint({
    query: 'osiedle Przyjaźń, Warszawa',
    kind: 'estate',
    anchorDistanceMeters: 800,
    uncertaintyMeters: 700,
    evidence: '800 m od przystanku',
  });

  assert.equal(hint.anchorDistanceMeters, 0);
  assert.equal(hint.evidence, null);
  assert.equal(hint.uncertaintyMeters, 700);
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

test('computeRentalCost flags a missing base price and does not present czynsz+media as the cost', () => {
  const c = computeRentalCost({ price: 0, rent: 500 }, mkParsed({ adminFee: 600, estimatedMedia: { water: null, electricity: 200, gas: null, internet: null, heating: null, other: null } }));
  assert.equal(c.basePriceKnown, false);
  assert.equal(c.najem, 0);
  assert.equal(c.total, 800); // 0 + 600 + 200 — NOT a real monthly total
});

test('computeRentalCost floors a hallucinated negative adminFee/media at 0 (cannot understate total under budget_max)', () => {
  const c = computeRentalCost({ price: 4000, rent: null }, mkParsed({ adminFee: -500, estimatedMedia: { water: 100, electricity: -200, gas: null, internet: null, heating: null, other: null } }));
  assert.equal(c.czynsz, 0);       // -500 floored to 0, not subtracted
  assert.equal(c.mediaSum, 100);   // -200 dropped, 100 kept
  assert.equal(c.total, 4100);     // 4000 + 0 + 100 — never 4000 - 500 - 200
});

test('computeRentalCost: a negative AI adminFee falls back to the crawler czynsz, not discards it', () => {
  // najem 7000 + real crawler czynsz 1500 = 8500 (over an 8000 budget). A bogus adminFee:-300 must NOT
  // win the ?? and floor to 0 (which would understate to 7000 and slip under budget) — fall back to rent.
  const c = computeRentalCost({ price: 7000, rent: 1500 }, mkParsed({ adminFee: -300 }));
  assert.equal(c.czynsz, 1500);
  assert.equal(c.total, 8500);
});

test('rental schema tolerates a unit-suffixed numeric instead of discarding the whole parse', () => {
  const p = ParsedRentalDataSchema.parse({ deposit: '6000 zł', adminFee: 600, estimatedMedia: { electricity: '~200' } });
  assert.equal(p.deposit, null);                    // bad field → null, not a thrown parse
  assert.equal(p.adminFee, 600);                    // sibling fields survive
  assert.equal(p.estimatedMedia.electricity, null);
});

test('locationEvidenceSupportsAnchor accepts a Polish declension (wola/woli)', () => {
  assert.equal(locationEvidenceSupportsAnchor('metro Wola, Warszawa', 'przy stacji Woli'), true);
});

test('a malformed locationHint kind keeps the geocodable query (→ landmark) instead of sinking the parse', () => {
  // Haiku emitting an out-of-enum kind synonym ("transit") must NOT throw AND must not discard the
  // still-usable query — it collapses to 'landmark' (a geocodable point anchor), keeping the location.
  const a = ParsedRentalDataSchema.parse({ adminFee: 600, locationHint: { query: 'metro Bemowo', kind: 'transit' } });
  assert.equal(a.locationHint.kind, 'landmark');
  assert.equal(a.locationHint.query, 'metro Bemowo');
  assert.equal(a.adminFee, 600);
  // A bare-string locationHint (the whole object is malformed) still collapses to the 'none' default.
  const b = ParsedRentalDataSchema.parse({ adminFee: 600, locationHint: 'metro Bemowo' });
  assert.equal(b.locationHint.kind, 'none');
  assert.equal(b.adminFee, 600);
});

test('a bad top-level enum / boolean / array value collapses instead of discarding the whole parse', () => {
  // A single out-of-vocabulary value from Haiku (wrong enum, "tak" for a boolean, a string for an
  // array) must fall back to its safe default — NOT throw and lose the entire listing analysis.
  const p = ParsedRentalDataSchema.parse({
    adminFee: 600,
    contractType: 'standard',   // not in the enum
    furnished: 'yes',           // not in the enum
    quiet: 'silent',            // not in the enum
    internetType: '5G',         // not in the enum
    balcony: 'tak',             // not a boolean
    parkingIncluded: 'nie',     // not a boolean
    positives: ['jasne', 42, 'ciche'], // mixed array — drop the bad element, keep the strings
    restrictions: 'без животных',       // bare string → single-element array (per-element tolerance)
  });
  assert.equal(p.contractType, null);
  assert.equal(p.furnished, null);
  assert.equal(p.quiet, null);
  assert.equal(p.internetType, null);
  assert.equal(p.balcony, null);
  assert.equal(p.parkingIncluded, null);
  assert.deepEqual(p.positives, ['jasne', 'ciche']);   // valid string elements survive one bad sibling
  assert.deepEqual(p.restrictions, ['без животных']);   // coerced, not dropped
  assert.equal(p.adminFee, 600); // sibling fields survive
});

test('estimatedMedia given as null / a non-object collapses to defaults instead of sinking the parse', () => {
  const a = ParsedRentalDataSchema.parse({ adminFee: 600, estimatedMedia: null });
  assert.equal(a.estimatedMedia.electricity, null);
  assert.equal(a.adminFee, 600);
  const b = ParsedRentalDataSchema.parse({ adminFee: 600, estimatedMedia: 'media w cenie' });
  assert.equal(b.estimatedMedia.water, null);
  assert.equal(b.adminFee, 600);
});

test('extractResultId reads codes from HTML captions', () => {
  assert.equal(extractResultId('<b>[GM7WX3]</b>\nrest'), 'GM7WX3');
  assert.equal(extractResultId('[GM7WX3] rest'), 'GM7WX3');
  assert.equal(extractResultId('no code here'), null);
});

test('prefixResultIdHtml prepends bold bracket id', () => {
  assert.equal(prefixResultIdHtml('ABC234', 'hello'), '<b>[ABC234]</b>\nhello');
});
