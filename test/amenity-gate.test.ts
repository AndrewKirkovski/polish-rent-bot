import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAmenityGate } from '../src/search/amenity-gate.js';
import { mkScore } from './helpers.js';
import type { LocationScore } from '../src/types.js';

function metro(min: number, within: boolean): LocationScore {
  return mkScore([{ type: 'metro', places: [{ name: 'M', walkingMinutes: min, distance: '' }], nearest: { name: 'M', walkingMinutes: min, distance: '' }, withinLimit: within }]);
}

test('strict off → always pass', () => {
  assert.equal(checkAmenityGate(metro(9, false), [{ type: 'metro', maxMinutes: 5 }], 'exact', false).pass, true);
});

test('strict + exact + over limit → reject with reason', () => {
  const g = checkAmenityGate(metro(9, false), [{ type: 'metro', maxMinutes: 5 }], 'exact', true);
  assert.equal(g.pass, false);
  assert.match(g.reason!, /метро/);
});

test('strict + within limit → pass', () => {
  assert.equal(checkAmenityGate(metro(4, true), [{ type: 'metro', maxMinutes: 5 }], 'exact', true).pass, true);
});

test('no coords (precision none) → keep-with-flag, never dropped', () => {
  assert.equal(checkAmenityGate(null, [{ type: 'metro', maxMinutes: 5 }], 'none', true).pass, true);
});

test('district centroid gets slack', () => {
  // 9 min > 5 limit, but within 5+5 slack for district-only coords
  assert.equal(checkAmenityGate(metro(9, false), [{ type: 'metro', maxMinutes: 5 }], 'district', true).pass, true);
});

test('non-walking amenity (groceries) is also enforced', () => {
  const s = mkScore([{ type: 'groceries', places: [{ name: 'G', walkingMinutes: 20, distance: '' }], nearest: { name: 'G', walkingMinutes: 20, distance: '' }, withinLimit: false }]);
  assert.equal(checkAmenityGate(s, [{ type: 'groceries', maxMinutes: 10 }], 'exact', true).pass, false);
});

test('transient Maps error (error:true) keeps-with-flag, does not hard-reject', () => {
  const s = mkScore([{ type: 'metro', places: [], nearest: null, withinLimit: false, error: true }]);
  assert.equal(checkAmenityGate(s, [{ type: 'metro', maxMinutes: 5 }], 'exact', true).pass, true);
});

test('genuine empty (no error) still hard-rejects in strict mode', () => {
  const s = mkScore([{ type: 'metro', places: [], nearest: null, withinLimit: false }]);
  assert.equal(checkAmenityGate(s, [{ type: 'metro', maxMinutes: 5 }], 'exact', true).pass, false);
});

test('new cafe amenity is enforced with a Russian label', () => {
  const s = mkScore([{ type: 'cafe', places: [{ name: 'C', walkingMinutes: 18, distance: '' }], nearest: { name: 'C', walkingMinutes: 18, distance: '' }, withinLimit: false }]);
  const g = checkAmenityGate(s, [{ type: 'cafe', maxMinutes: 10 }], 'exact', true);
  assert.equal(g.pass, false);
  assert.match(g.reason!, /кафе/);
});
