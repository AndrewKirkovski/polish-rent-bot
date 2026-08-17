import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAmenityGate, checkCenterGate } from '../src/search/amenity-gate.js';
import { mkScore } from './helpers.js';
import type { LocationScore } from '../src/types.js';

function withCentral(minutes: { min: number; max: number } | null): LocationScore {
  return mkScore([], { centralStation: minutes ? { distanceText: '4 км', durationMinRange: minutes } : { distanceText: '~9 км', durationMinRange: null } });
}

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

test('district-level location is still gated: within-limit optimistic edge passes', () => {
  // The pref must match the fixture's result identity, or the gate takes the "criterion not found"
  // path instead and the within-limit logic this test names is never reached.
  const score = metro(3, true);
  score.amenities[0].requestedLine = 'M1';
  const g = checkAmenityGate(score, [{ type: 'metro', maxMinutes: 7, line: 'M1' }], 'district', true);
  assert.equal(g.pass, true);
  // Sanity: the same fixture over the limit DOES reject, proving the assertion above is sensitive.
  const over = metro(20, false);
  over.amenities[0].requestedLine = 'M1';
  assert.equal(checkAmenityGate(over, [{ type: 'metro', maxMinutes: 7, line: 'M1' }], 'district', true).pass, false);
});

test('district-level location is still gated: optimistic edge outside the limit rejects', () => {
  // A district centroid whose nearest whitelisted station is kilometres away even at the closest
  // edge of the district. Coarse coordinates are not a licence to ignore the user's hard limit.
  const s = mkScore([{
    type: 'metro',
    requestedLine: 'M1',
    places: [{ name: 'Kabaty', walkingMinutes: 100, distance: '8 км', walkingMinutesRange: { min: 74, max: 126 }, approximate: true }],
    nearest: { name: 'Kabaty', walkingMinutes: 100, distance: '8 км', walkingMinutesRange: { min: 74, max: 126 }, approximate: true },
    withinLimit: false,
    uncertain: false,
  }], { precision: 'district', locationOuterRadiusMeters: 3200 });
  const g = checkAmenityGate(s, [{ type: 'metro', maxMinutes: 7, line: 'M1' }], 'district', true);
  assert.equal(g.pass, false);
  assert.match(g.reason!, /Kabaty/);
  // Derived from a region → the reason says so, and quotes the radius it was derived from.
  assert.equal(g.inferred, true);
  assert.match(g.reason!, /оценка по примерной локации ±3,2 км/);
});

test('an exact-location rejection is not marked inferred', () => {
  const g = checkAmenityGate(metro(9, false), [{ type: 'metro', maxMinutes: 5 }], 'exact', true);
  assert.equal(g.pass, false);
  assert.equal(g.inferred, false);
});

test('a substituted criterion (unresolvable station whitelist) never hard-rejects', () => {
  const s = mkScore([{
    type: 'metro',
    requestedStations: ['Lazurowa'],
    places: [{ name: 'Centrum', walkingMinutes: 30, distance: '2 км' }],
    nearest: { name: 'Centrum', walkingMinutes: 30, distance: '2 км' },
    withinLimit: false,
    uncertain: true,
    criterionSubstituted: true,
  }], { precision: 'exact' });
  assert.equal(checkAmenityGate(s, [{ type: 'metro', maxMinutes: 7, stations: ['Lazurowa'] }], 'exact', true).pass, true);
});

test('a station whitelist is part of result identity, not just the line', () => {
  // Two metro prefs differing only by whitelist must each be judged against their own measurement.
  const s = mkScore([
    {
      type: 'metro',
      places: [{ name: 'Any station', walkingMinutes: 4, distance: '300 m' }],
      nearest: { name: 'Any station', walkingMinutes: 4, distance: '300 m' },
      withinLimit: true,
    },
    {
      type: 'metro',
      requestedStations: ['Kabaty'],
      places: [{ name: 'Kabaty', walkingMinutes: 40, distance: '3 км' }],
      nearest: { name: 'Kabaty', walkingMinutes: 40, distance: '3 км' },
      withinLimit: false,
    },
  ], { precision: 'exact' });
  assert.equal(checkAmenityGate(s, [{ type: 'metro', maxMinutes: 15 }], 'exact', true).pass, true);
  const g = checkAmenityGate(s, [{ type: 'metro', maxMinutes: 15, stations: ['Kabaty'] }], 'exact', true);
  assert.equal(g.pass, false);
  assert.match(g.reason!, /Kabaty/);
});

test('center filter: no maxCenterMinutes → always pass', () => {
  assert.equal(checkCenterGate(withCentral({ min: 40, max: 50 }), undefined, 'exact').pass, true);
});

test('center filter: within limit → pass', () => {
  assert.equal(checkCenterGate(withCentral({ min: 17, max: 21 }), 25, 'exact').pass, true);
});

test('center filter: optimistic time over limit → reject with reason', () => {
  const g = checkCenterGate(withCentral({ min: 30, max: 38 }), 25, 'exact');
  assert.equal(g.pass, false);
  assert.match(g.reason!, /центр/);
  assert.match(g.reason!, /25/);
});

test('center filter: no coordinates at all → keep-with-flag', () => {
  assert.equal(checkCenterGate(null, 25, 'none').pass, true);
  assert.equal(checkCenterGate(withCentral({ min: 40, max: 50 }), 25, 'none').pass, true);
});

test('center filter: district location is enforced from its optimistic edge', () => {
  // The range already accounts for the district's extent (centralStationEstimate measures a second
  // route from the centre-facing edge), so a min still over the limit is evidence, not ignorance.
  const score = withCentral({ min: 40, max: 50 });
  score.locationOuterRadiusMeters = 3200;
  const g = checkCenterGate(score, 25, 'district');
  assert.equal(g.pass, false);
  assert.equal(g.inferred, true);
  // Still passes when the optimistic edge fits, even though the pessimistic edge does not.
  assert.equal(checkCenterGate(withCentral({ min: 22, max: 48 }), 25, 'district').pass, true);
});

test('center filter: approximate location is enforced from its optimistic edge', () => {
  assert.equal(checkCenterGate(withCentral({ min: 33, max: 47 }), 25, 'approximate').pass, false);
  assert.equal(checkCenterGate(withCentral({ min: 18, max: 40 }), 25, 'approximate').pass, true);
});

test('center filter: a nonsense limit is ignored rather than rejecting everything', () => {
  assert.equal(checkCenterGate(withCentral({ min: 40, max: 50 }), 0, 'exact').pass, true);
  assert.equal(checkCenterGate(withCentral({ min: 40, max: 50 }), Number.NaN, 'exact').pass, true);
});

test('center filter: routing failed (no time) → keep-with-flag, not a false reject', () => {
  assert.equal(checkCenterGate(withCentral(null), 25, 'exact').pass, true);
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
