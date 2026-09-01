// Schema resilience: a malformed model response must degrade, never cost a whole listing.
//
// The rule this file exists to hold: losing ONE bad field is acceptable, losing everything
// alongside it is not. `.catch(x)` rescues at the level it is attached to, so an array-level catch
// discards every good element when a single one — or a soft count cap — fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParsedRentalDataSchema } from '../src/ai/schemas.js';

/** A minimally valid rental parse; each test perturbs only the field under review. */
function raw(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deposit: 6000,
    locationHint: {
      query: 'metro Zacisze, Warszawa', kind: 'transit_stop',
      anchorDistanceMeters: 400, uncertaintyMeters: 200, evidence: '5 min do metra',
    },
    ...extra,
  };
}

const hint = (query: string) => ({
  query, kind: 'transit_stop', anchorDistanceMeters: 400, uncertaintyMeters: 200, evidence: 'e',
});

test('more extra hints than the cap keeps the first four, not zero', () => {
  // "Never more than 4" is a soft instruction to a model, so a fifth entry is a normal event.
  // Zod's `.max(4)` would FAIL the array and the outer `.catch([])` would then swallow all five —
  // indistinguishable in the output from "this ad made no further claims at all".
  const parsed = ParsedRentalDataSchema.parse(raw({
    extraLocationHints: ['a', 'b', 'c', 'd', 'e'].map((n) => hint(`metro ${n}, Warszawa`)),
  }));
  assert.equal(parsed.extraLocationHints?.length, 4);
  assert.equal(parsed.extraLocationHints?.[0]?.query, 'metro a, Warszawa');
});

test('one malformed entry does not cost the valid ones', () => {
  const parsed = ParsedRentalDataSchema.parse(raw({
    extraLocationHints: [hint('metro Trocka, Warszawa'), 'not an object', null, hint('metro Bródno, Warszawa')],
  }));
  assert.equal(parsed.extraLocationHints?.length, 2);
  assert.deepEqual(parsed.extraLocationHints?.map((h) => h.query),
    ['metro Trocka, Warszawa', 'metro Bródno, Warszawa']);
});

test('a bad field inside an entry degrades that field only', () => {
  const parsed = ParsedRentalDataSchema.parse(raw({
    extraLocationHints: [{ ...hint('metro Trocka, Warszawa'), anchorDistanceMeters: 'soon', kind: 'metro' }],
  }));
  const [only] = parsed.extraLocationHints ?? [];
  assert.equal(only?.query, 'metro Trocka, Warszawa');
  assert.equal(only?.anchorDistanceMeters, null, 'unparseable distance falls back, entry survives');
  // An out-of-enum synonym keeps the geocodable query rather than collapsing to 'none'.
  assert.equal(only?.kind, 'landmark');
});

test('a non-array, or an absent field, is simply no extra claims', () => {
  assert.deepEqual(ParsedRentalDataSchema.parse(raw({ extraLocationHints: 'nope' })).extraLocationHints, []);
  assert.deepEqual(ParsedRentalDataSchema.parse(raw()).extraLocationHints, []);
});
