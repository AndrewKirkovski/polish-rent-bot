import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWithinLimit } from '../src/ai/maps.js';

const walk = { walking: true, transit: false, driving: false, checkFrequency: false, transitFallback: false };
const airport = { walking: false, transit: true, driving: true, checkFrequency: false, transitFallback: false };

// The exact cache-collision scenario: one cached place, two thresholds → must differ.
test('same place, different maxMinutes → recomputed withinLimit', () => {
  const stop = { name: 'M', walkingMinutes: 8, distance: '' };
  assert.equal(computeWithinLimit(stop, walk, 15), true);
  assert.equal(computeWithinLimit(stop, walk, 5), false);
});

test('airport uses transit/driving, not walking', () => {
  const air = { name: 'A', walkingMinutes: -1, transitMinutes: 40, drivingMinutes: 30, distance: '' };
  assert.equal(computeWithinLimit(air, airport, 45), true);
  assert.equal(computeWithinLimit(air, airport, 25), false);
});

test('null nearest → false', () => {
  assert.equal(computeWithinLimit(null, walk, 10), false);
});
