import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintListing, fingerprintsMatch, dedupeCrossPlatform } from '../src/search/listing-fingerprint.js';
import { mkListing } from './helpers.js';

test('cross-platform match ignores district', () => {
  const a = fingerprintListing(mkListing({ platform: 'olx', district: 'Mokotow' }));
  const b = fingerprintListing(mkListing({ platform: 'otodom', district: null }));
  assert.equal(fingerprintsMatch(a, b), true);
});

test('different area does not match', () => {
  const a = fingerprintListing(mkListing({ area: 60 }));
  const b = fingerprintListing(mkListing({ area: 95 }));
  assert.equal(fingerprintsMatch(a, b), false);
});

test('two area-less flats with a merely-similar title are NOT merged (area gate cannot auto-pass)', () => {
  const a = fingerprintListing(mkListing({ area: null, price: 4000, title: 'Jasne 2 pokoje Mokotow parking' }));
  const b = fingerprintListing(mkListing({ area: null, price: 4000, title: 'Jasne 2 pokoje Mokotow balkon' }));
  assert.equal(fingerprintsMatch(a, b), false); // jaccard ~0.6 < 0.85 required when area is unknown
  // The same pair WITH a known matching area is a genuine duplicate.
  const c = fingerprintListing(mkListing({ area: 50, price: 4000, title: 'Jasne 2 pokoje Mokotow parking' }));
  const d = fingerprintListing(mkListing({ area: 50, price: 4000, title: 'Jasne 2 pokoje Mokotow balkon' }));
  assert.equal(fingerprintsMatch(c, d), true);
});

test('dedupe keeps higher-quality record and merges phone', () => {
  const olx = mkListing({ platform: 'olx', platformId: 'o1', phone: '111', photos: [] });
  const oto = mkListing({ platform: 'otodom', platformId: 't1', phone: null, lat: 52.1, lng: 21.0, photos: ['a', 'b', 'c', 'd'] });
  const out = dedupeCrossPlatform([olx, oto]);
  assert.equal(out.length, 1);
  assert.equal(out[0].platform, 'otodom');      // coords + otodom → higher quality
  assert.equal(out[0].phone, '111');            // phone merged from dropped OLX record
});
