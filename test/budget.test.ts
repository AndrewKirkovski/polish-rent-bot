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

test('extractResultId reads codes from HTML captions', () => {
  assert.equal(extractResultId('<b>[GM7WX3]</b>\nrest'), 'GM7WX3');
  assert.equal(extractResultId('[GM7WX3] rest'), 'GM7WX3');
  assert.equal(extractResultId('no code here'), null);
});

test('prefixResultIdHtml prepends bold bracket id', () => {
  assert.equal(prefixResultIdHtml('ABC234', 'hello'), '<b>[ABC234]</b>\nhello');
});
