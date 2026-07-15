import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFitScore, preScore } from '../src/search/fit-score.js';
import { mkListing, mkParsed, mkScore } from './helpers.js';

test('two offices + fiber + quiet scores high', () => {
  const l = mkListing();
  const p = mkParsed({ twoOfficeCapable: true, quiet: 'quiet', naturalLight: 'bright', internetType: 'fiber' });
  const { score, reason } = computeFitScore(l, p, null);
  assert.ok(score >= 80, `expected high score, got ${score}`);
  assert.match(reason, /2 офиса/);
  assert.match(reason, /оптика/);
});

test('no offices + noisy scores low', () => {
  const l = mkListing();
  const p = mkParsed({ twoOfficeCapable: false, quiet: 'noisy' });
  const { score } = computeFitScore(l, p, null);
  assert.ok(score <= 45, `expected low score, got ${score}`);
});

test('unknown internet is down-ranked, not zeroed', () => {
  const hi = computeFitScore(mkListing(), mkParsed({ twoOfficeCapable: true, internetType: 'fiber' }), null).score;
  const lo = computeFitScore(mkListing({ hasInternet: null }), mkParsed({ twoOfficeCapable: true }), null).score;
  assert.ok(lo < hi);         // unknown internet loses points
  assert.ok(lo > 0);          // but not a dealbreaker
});

test('preScore ranks cheaper-in-band + elevator higher', () => {
  const cheapLift = preScore(mkListing({ price: 3000, rent: 200, hasElevator: true }));
  const dearNoLift = preScore(mkListing({ price: 7500, rent: 400 }));
  assert.ok(cheapLift > dearNoLift);
});

test('within-limit amenities lift the score and the nearest is named in Russian', () => {
  const score = mkScore([
    { type: 'cafe', places: [{ name: 'C', walkingMinutes: 4, distance: '' }], nearest: { name: 'C', walkingMinutes: 4, distance: '' }, withinLimit: true },
    { type: 'restaurant', places: [{ name: 'R', walkingMinutes: 6, distance: '' }], nearest: { name: 'R', walkingMinutes: 6, distance: '' }, withinLimit: true },
  ]);
  const withAmen = computeFitScore(mkListing(), mkParsed({ twoOfficeCapable: true }), score);
  const noAmen = computeFitScore(mkListing(), mkParsed({ twoOfficeCapable: true }), null);
  assert.ok(withAmen.score >= noAmen.score);   // both cafe+restaurant within → amenities term = 1
  assert.match(withAmen.reason, /кафе 4м/);     // shared AMENITY_LABELS, not English 'cafe'
});
