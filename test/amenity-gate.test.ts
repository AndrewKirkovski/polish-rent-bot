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

test('district centroid stays with a warning instead of being rejected', () => {
  const g = checkAmenityGate(metro(0, true), [{ type: 'metro', maxMinutes: 7, line: 'M1' }], 'district', true);
  assert.equal(g.pass, true);
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

test('metro-line constraint appears in strict rejection reason', () => {
  const score = metro(9, false);
  score.amenities[0].requestedLine = 'M1';
  const g = checkAmenityGate(score, [{ type: 'metro', maxMinutes: 7, line: 'M1' }], 'exact', true);
  assert.equal(g.pass, false);
  assert.match(g.reason!, /метро M1/);
});

test('approximate range crossing the limit stays as uncertain', () => {
  const s = mkScore([{
    type: 'metro',
    requestedLine: 'M1',
    places: [{ name: 'Racławicka', walkingMinutes: 8, distance: '600 m', walkingMinutesRange: { min: 5, max: 11 }, approximate: true }],
    nearest: { name: 'Racławicka', walkingMinutes: 8, distance: '600 m', walkingMinutesRange: { min: 5, max: 11 }, approximate: true },
    withinLimit: false,
    uncertain: true,
  }], { precision: 'approximate' });
  assert.equal(checkAmenityGate(s, [{ type: 'metro', maxMinutes: 7, line: 'M1' }], 'approximate', true).pass, true);
});

test('approximate range wholly outside the limit is rejected', () => {
  const s = mkScore([{
    type: 'metro',
    requestedLine: 'M1',
    places: [{ name: 'Racławicka', walkingMinutes: 15, distance: '1 km', walkingMinutesRange: { min: 12, max: 18 }, approximate: true }],
    nearest: { name: 'Racławicka', walkingMinutes: 15, distance: '1 km', walkingMinutesRange: { min: 12, max: 18 }, approximate: true },
    withinLimit: false,
    uncertain: false,
  }], { precision: 'approximate' });
  const gate = checkAmenityGate(s, [{ type: 'metro', maxMinutes: 7, line: 'M1' }], 'approximate', true);
  assert.equal(gate.pass, false);
  assert.match(gate.reason!, /Racławicka/);
  assert.match(gate.reason!, /~12–18 мин пешком/);
});

test('two requested metro lines are gated against their own results', () => {
  const score = mkScore([
    {
      type: 'metro',
      requestedLine: 'M1',
      places: [{ name: 'Centrum', lineName: 'M1', walkingMinutes: 5, distance: '400 m' }],
      nearest: { name: 'Centrum', lineName: 'M1', walkingMinutes: 5, distance: '400 m' },
      withinLimit: true,
    },
    {
      type: 'metro',
      requestedLine: 'M2',
      places: [{ name: 'Rondo ONZ', lineName: 'M2', walkingMinutes: 12, distance: '900 m' }],
      nearest: { name: 'Rondo ONZ', lineName: 'M2', walkingMinutes: 12, distance: '900 m' },
      withinLimit: false,
    },
  ]);

  const gate = checkAmenityGate(score, [
    { type: 'metro', maxMinutes: 7, line: 'M1' },
    { type: 'metro', maxMinutes: 7, line: 'M2' },
  ], 'exact', true);

  assert.equal(gate.pass, false);
  assert.match(gate.reason!, /M2/);
});

test('generic metro result cannot be guessed as M1', () => {
  const gate = checkAmenityGate(
    metro(4, true),
    [{ type: 'metro', maxMinutes: 7, line: 'M1' }],
    'exact',
    true,
  );

  assert.equal(gate.pass, false);
  assert.match(gate.reason!, /M1 рядом не найдено/);
});
