// Optimistic-edge gating for loosely localized listings.
//
// THE RULE: when the location is a region rather than a point, the user's hard limits are still
// enforced — judged from the MOST OPTIMISTIC edge of that region. If the closest the flat could
// possibly be still breaks the limit, that is evidence and the listing is rejected. Uncertainty
// may only rescue a listing whose optimistic edge is INSIDE the limit.
//
// The counterpart matters just as much: `min` decides deletions, so these tests also pin the
// arithmetic that could make it too PESSIMISTIC (unit mix-ups, pace artefacts, pool truncation)
// and thereby reject flats that are genuinely close enough.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bandFor,
  optimisticMeters,
  pessimisticMeters,
  resolvePace,
  routeMetersFromCrow,
  widenPlace,
  MIN_OBSERVED_PACE,
  MAX_OBSERVED_PACE,
} from '../src/geo/uncertainty.js';
import { WALK_METERS_PER_MINUTE, findMetroStation, haversineMeters } from '../src/geo/metro.js';
import { crowMetersFromRoute } from '../src/geo/uncertainty.js';
import { applyLocationUncertainty, findNearbyAmenities, matchesAmenityRequest, modelledOptimisticCenter, pointToward } from '../src/ai/maps.js';
import { checkAmenityGate, checkCenterGate, isCoarsePrecision } from '../src/search/amenity-gate.js';
import { classifyGeocodePrecision, fuseLocationCandidates } from '../src/ai/location.js';
import type { AreaConstraint, LocCandidate, MetroConstraint } from '../src/ai/location.js';
import type { AmenityResult } from '../src/types.js';
import { mkScore } from './helpers.js';

const WHITELIST = ['Kabaty'];

/** A metro AmenityResult for a whitelist request, measured at `meters`/`minutes` from the anchor. */
function whitelistMetro(meters: number, minutes: number, name = 'Kabaty'): AmenityResult {
  const place = { name, walkingMinutes: minutes, distance: `${meters} m`, distanceMeters: meters };
  return { type: 'metro', requestedStations: WHITELIST, places: [place], nearest: place, withinLimit: false };
}

// ---------------------------------------------------------------------------
// The requirement, stated literally
// ---------------------------------------------------------------------------

test('whitelisted metro 10–20 min from the region edges HARD FAILS a 7-min limit', () => {
  // Region radius 390 m around a point 1170 m from the whitelisted station → the flat is between
  // 780 m (10 min) and 1560 m (20 min) away. Even the optimistic 10 min exceeds the 7-min limit.
  const [widened] = applyLocationUncertainty(
    [whitelistMetro(1170, 15)],
    [{ type: 'metro', maxMinutes: 7, stations: WHITELIST }],
    390,
  );
  assert.deepEqual(widened.nearest?.walkingMinutesRange, { min: 10, max: 20 });
  assert.equal(widened.withinLimit, false);
  assert.equal(widened.uncertain, false, 'a range wholly outside the limit is not uncertain');

  const gate = checkAmenityGate(
    mkScore([widened], { precision: 'approximate', locationOuterRadiusMeters: 390 }),
    [{ type: 'metro', maxMinutes: 7, stations: WHITELIST }],
    'approximate',
    true,
  );
  assert.equal(gate.pass, false);
  assert.match(gate.reason!, /Kabaty/);
  assert.match(gate.reason!, /~10–20 мин пешком/);
  assert.match(gate.reason!, /лимит 7 мин/);
  // The reason must not read as a surveyed distance — it quotes the region it was inferred from.
  assert.match(gate.reason!, /оценка по примерной локации ±390 м/);
  assert.equal(gate.inferred, true);
});

test('the same station is KEPT when the optimistic edge reaches inside the limit', () => {
  // Widen the region to 900 m and the flat could be 270 m (3 min) away — the range straddles the
  // limit, so the honest verdict is unknown, not rejection.
  const [widened] = applyLocationUncertainty(
    [whitelistMetro(1170, 15)],
    [{ type: 'metro', maxMinutes: 7, stations: WHITELIST }],
    900,
  );
  assert.equal(widened.nearest?.walkingMinutesRange?.min, 3);
  assert.equal(widened.uncertain, true);
  assert.equal(
    checkAmenityGate(
      mkScore([widened], { precision: 'approximate' }),
      [{ type: 'metro', maxMinutes: 7, stations: WHITELIST }],
      'approximate',
      true,
    ).pass,
    true,
  );
});

// ---------------------------------------------------------------------------
// Region geometry
// ---------------------------------------------------------------------------

test('optimistic edge of a disc is max(0, d - r); of an annulus it has a zero valley', () => {
  const disc = bandFor(0, 500);
  assert.equal(optimisticMeters(1200, disc), 700);
  assert.equal(optimisticMeters(500, disc), 0);
  assert.equal(optimisticMeters(120, disc), 0, 'a place inside the disc could be at the door');
  assert.equal(pessimisticMeters(1200, disc), 1700);

  // "4 km from station X": the flat is on a ring, so a place 4 km from X could be right next to it,
  // while X ITSELF is ~3.7 km away.
  const ring = bandFor(4000, 300);
  assert.equal(optimisticMeters(4046, ring), 0);
  assert.equal(optimisticMeters(0, ring), 3700);
  assert.equal(optimisticMeters(6000, ring), 1700);
});

test('a crow-flies radius is converted to route metres before it is subtracted', () => {
  // A 700 m crow displacement shortens a WALKING route by up to ~910 m, not 700 m. Subtracting the
  // raw crow radius overstated the optimistic edge by ~30% and rejected flats that were in range.
  const band = bandFor(0, routeMetersFromCrow(700));
  const widened = widenPlace(1600, 21, band);
  assert.equal(widened.distanceMetersRange.min, 690, 'was 900 when the crow radius went in unconverted');
  // 8 min. The old math reported 11, which hard-rejected this flat against a 10-min limit even
  // though it can genuinely be reached in 8.
  assert.equal(widened.walkingMinutesRange.min, 8);
  assert.ok(widened.walkingMinutesRange.min <= 10);
});

// ---------------------------------------------------------------------------
// Pace: keep real measurements, discard rounding artefacts
// ---------------------------------------------------------------------------

test('pace from a very short walk is replaced by the walk model, not extrapolated', () => {
  // Google reports a 45 m hop as "1 min" → 45 m/min. Extrapolating a kilometre of uncertainty at
  // that pace invents ~13 minutes of walking that does not exist.
  assert.equal(resolvePace(45, 1), WALK_METERS_PER_MINUTE);
  assert.equal(resolvePace(0, 0), WALK_METERS_PER_MINUTE);

  const band = bandFor(1500, 300);
  const widened = widenPlace(45, 1, band);
  assert.equal(widened.walkingMinutesRange.min, 14, 'was 25 at the artefact pace');
});

test('a genuinely slow measured route keeps its own pace', () => {
  // 600 m in 12 min is a real, slow route (stairs, crossings). That is evidence, not noise.
  assert.equal(resolvePace(600, 12), 50);
  assert.ok(resolvePace(600, 12) >= MIN_OBSERVED_PACE);
  // Only physically impossible values are clamped.
  assert.equal(resolvePace(1000, 3), MAX_OBSERVED_PACE);
});

// ---------------------------------------------------------------------------
// Candidate pools: the closest-by-optimistic-edge station must survive truncation
// ---------------------------------------------------------------------------

test('a station inside the annulus is found even when it is the 10th nearest', async () => {
  // Anchored at Politechnika by "~4 km from the metro". Nearest-by-distance are Politechnika (0 m),
  // Pole Mokotowskie (1.6 km) and Centrum (1.8 km) — all ~3.7 km from where the flat could be.
  // Ratusz Arsenał sits at 4046 route metres, INSIDE the ring, so the flat may be at its door.
  // Ranking the pool by raw distance and keeping three would have hidden it and forced a reject.
  const results = await findNearbyAmenities(52.21866, 21.01530, [{ type: 'metro', maxMinutes: 7 }], {
    precision: 'approximate',
    anchorDistanceMeters: 4000,
    outerRadiusMeters: 300,
    uncertaintyMeters: 300,
    source: 'ориентир из описания',
  });
  assert.equal(results[0]?.places[0]?.name, 'Ratusz Arsenał');

  const [widened] = applyLocationUncertainty(results, [{ type: 'metro', maxMinutes: 7 }], 300, 4000);
  assert.equal(widened.nearest?.walkingMinutesRange?.min, 0);
  assert.equal(widened.uncertain, true);
  assert.equal(
    checkAmenityGate(mkScore([widened], { precision: 'approximate' }), [{ type: 'metro', maxMinutes: 7 }], 'approximate', true).pass,
    true,
  );
});

// ---------------------------------------------------------------------------
// Service area: "not a Warsaw listing" vs "far from the one station you allow"
// ---------------------------------------------------------------------------

test('a Warsaw-area flat far from its only whitelisted station hard-fails', async () => {
  // Legionowo: 12 km from Młociny (inside the metro service area) but 31 km from Kabaty. Measuring
  // the service area against the WHITELIST pool used to call this "out of area" and keep it.
  const results = await findNearbyAmenities(52.4, 20.93, [{ type: 'metro', maxMinutes: 7, stations: WHITELIST }]);
  assert.equal(results[0]?.uncertain, undefined, 'in the service area → a real verdict, not unknown');
  assert.equal(results[0]?.withinLimit, false);
  const gate = checkAmenityGate(mkScore(results, { precision: 'exact' }), [{ type: 'metro', maxMinutes: 7, stations: WHITELIST }], 'exact', true);
  assert.equal(gate.pass, false);
});

test('a listing in another city keeps metro as unknown rather than rejecting', async () => {
  // Kraków is 240 km from the nearest Warsaw station: the whitelist simply does not apply there.
  const results = await findNearbyAmenities(50.0647, 19.945, [{ type: 'metro', maxMinutes: 7, stations: WHITELIST }]);
  assert.equal(results[0]?.uncertain, true);
  assert.equal(
    checkAmenityGate(mkScore(results, { precision: 'exact' }), [{ type: 'metro', maxMinutes: 7, stations: WHITELIST }], 'exact', true).pass,
    true,
  );
});

test('an unresolvable station whitelist is flagged, never used to reject', async () => {
  // "Lazurowa" is a real 2026 M2 extension station absent from the verified table. Falling back to
  // all lines is fine for the card, but the gate must not reject against a criterion nobody asked
  // for. Białołęka is ~74 min from its nearest station, so the substituted verdict is over the
  // limit — exactly the case that would otherwise become a false rejection.
  const pref = { type: 'metro', maxMinutes: 7, stations: ['Lazurowa'] };
  const results = await findNearbyAmenities(52.32, 20.98, [pref]);
  assert.equal(results[0]?.criterionSubstituted, true);
  assert.equal(results[0]?.withinLimit, false);
  assert.equal(results[0]?.uncertain, true);
  assert.equal(checkAmenityGate(mkScore(results, { precision: 'exact' }), [pref], 'exact', true).pass, true);
});

// ---------------------------------------------------------------------------
// Result identity
// ---------------------------------------------------------------------------

test('metro result identity covers the station whitelist as well as the line', () => {
  assert.equal(matchesAmenityRequest({ type: 'metro', maxMinutes: 7 }, { type: 'metro' }), true);
  assert.equal(matchesAmenityRequest({ type: 'metro', maxMinutes: 7, stations: WHITELIST }, { type: 'metro' }), false);
  assert.equal(
    matchesAmenityRequest({ type: 'metro', maxMinutes: 7, stations: WHITELIST }, { type: 'metro', requestedStations: WHITELIST }),
    true,
  );
  assert.equal(
    matchesAmenityRequest({ type: 'metro', maxMinutes: 7, line: 'M1' }, { type: 'metro', requestedLine: 'M2' }),
    false,
  );
  // Non-metro types have no line/whitelist dimension.
  assert.equal(matchesAmenityRequest({ type: 'park', maxMinutes: 10 }, { type: 'park' }), true);
});

// ---------------------------------------------------------------------------
// The outer bound the gates enforce against
// ---------------------------------------------------------------------------

test('the enforced radius is a containing bound (2σ, in route metres), not σ', () => {
  const pin: LocCandidate = {
    lat: 52.2385, lng: 20.9594, sigma: 300, reliability: 0.85,
    precisionFloor: 'approximate', source: 'pin', evidence: null,
  };
  const fused = fuseLocationCandidates([pin], null);
  assert.equal(fused.uncertaintyMeters, 300, 'σ is still reported for diagnostics');
  // 2σ crow → route metres. Enforcing against σ alone would delete flats whose true position is
  // farther from the fused point than one standard deviation.
  assert.equal(fused.outerRadiusMeters, Math.round(routeMetersFromCrow(600)));
  assert.ok(fused.outerRadiusMeters > fused.uncertaintyMeters);
});

test('an exact location carries no region at all', () => {
  const exact: LocCandidate = {
    lat: 52.2385, lng: 20.9594, sigma: 0.0001, reliability: 1,
    precisionFloor: 'exact', source: 'otodom', evidence: null,
  };
  const fused = fuseLocationCandidates([exact], null);
  assert.equal(fused.precision, 'exact');
  assert.equal(fused.outerRadiusMeters, 0);
});

// ---------------------------------------------------------------------------
// Leniency that must survive
// ---------------------------------------------------------------------------

test('coarse precision is classified as inferred; exact and none are not', () => {
  assert.equal(isCoarsePrecision('approximate'), true);
  assert.equal(isCoarsePrecision('district'), true);
  assert.equal(isCoarsePrecision('exact'), false);
  assert.equal(isCoarsePrecision('street'), false);
  assert.equal(isCoarsePrecision('none'), false);
  assert.equal(isCoarsePrecision(undefined), false);
});

test('a transient measurement failure still keeps the listing, whatever the range says', () => {
  const [widened] = applyLocationUncertainty(
    [{ ...whitelistMetro(9000, 115), error: true, uncertain: true }],
    [{ type: 'metro', maxMinutes: 7, stations: WHITELIST }],
    300,
  );
  assert.equal(widened.uncertain, true);
  assert.equal(
    checkAmenityGate(mkScore([widened], { precision: 'approximate' }), [{ type: 'metro', maxMinutes: 7, stations: WHITELIST }], 'approximate', true).pass,
    true,
  );
});

test('a transit-only amenity at a coarse location is unknown, not rejected on a point measurement', () => {
  // The airport has no walking range to widen, and the point measurement was taken at the anchor
  // rather than at the flat — so an over-limit result there is not evidence about the flat.
  const place = { name: 'Chopin', walkingMinutes: -1, distance: '12 км', transitMinutes: 55, drivingMinutes: 45 };
  const [widened] = applyLocationUncertainty(
    [{ type: 'airport', places: [place], nearest: place, withinLimit: false }],
    [{ type: 'airport', maxMinutes: 40 }],
    1500,
  );
  assert.equal(widened.withinLimit, false);
  assert.equal(widened.uncertain, true);
  assert.equal(
    checkAmenityGate(mkScore([widened], { precision: 'district' }), [{ type: 'airport', maxMinutes: 40 }], 'district', true).pass,
    true,
  );
});

test('groceries reachable by transit stay within limit despite a widened walking range', () => {
  const place = { name: 'Biedronka', walkingMinutes: 25, distance: '1,9 км', distanceMeters: 1900, transitMinutes: 8 };
  const [widened] = applyLocationUncertainty(
    [{ type: 'groceries', places: [place], nearest: place, withinLimit: false, bestTransitMinutes: 8 }],
    [{ type: 'groceries', maxMinutes: 15 }],
    600,
  );
  assert.equal(widened.withinLimit, true);
  assert.equal(widened.uncertain, false, 'within-limit and uncertain must stay mutually exclusive');
});

// ---------------------------------------------------------------------------
// The modelled optimistic centre time (used when no edge route could be measured)
// ---------------------------------------------------------------------------

// A disc-shaped region: the measured point is itself a position the flat could occupy.
const disc = (base: number, reach: number, edgeCrow: number) =>
  modelledOptimisticCenter(base, reach, edgeCrow, true);

test('modelled optimistic centre time cannot be talked down to nothing by a wide region', () => {
  // The old model subtracted region / walking-pace with no bound: a 2.5 km region cut 33 minutes off
  // a transit time, `min` clamped to 1, and the gate could never fire. The saving is now capped and
  // floored by what transit can physically do over the distance that remains.
  assert.equal(disc(55, 2500, 9000), 43, 'saving capped at 12 min, not 33');
  // 9 km left after the region is subtracted → no transit beats ~16 min over it.
  assert.equal(disc(20, 2500, 9000), 16, 'physical floor holds, not base - 32');
  // A region that swallows the whole distance genuinely cannot be gated.
  assert.equal(disc(30, 20_000, 0), 18);
});

test('modelled optimistic centre time still credits a small region honestly', () => {
  // Street precision, ~500 route metres of slack: a few minutes of walking, no floor interference.
  assert.equal(disc(34, 520, 4200), 27);
});

test('the physical floor never overrides a measured journey time', () => {
  // 15 km out but on a fast rail corridor: measured 24 min beats the floor's 35 km/h assumption
  // (which would demand 25). `min` must not exceed a time already measured at a point the flat could
  // occupy, or a listing is rejected for a journey the same call measured as within the limit.
  assert.equal(disc(24, 520, 14_600), 24);
  // The floor still does its job when it does not contradict the measurement.
  assert.equal(disc(40, 520, 14_600), 33);
});

test('an annulus is not capped by the anchor time — the flat is not AT the anchor', () => {
  // The measured point is a station the ring explicitly excludes, so its 20-minute time says nothing
  // about the flat, which sits at least the ring's inner radius away. Capping by it would understate.
  assert.equal(modelledOptimisticCenter(20, 700, 14_600, false), 25, 'floor applies, uncapped');
  // Same numbers for a disc DO cap, because there the anchor is a place the flat could be.
  assert.equal(modelledOptimisticCenter(20, 700, 14_600, true), 20);
});

// ---------------------------------------------------------------------------
// A ring is not a disc
// ---------------------------------------------------------------------------

test('displacing onto a ring passes the destination when the destination is inside the hole', () => {
  // Anchored at Centrum, which is ~536 m from Centralna, by "4 km from the metro". The closest the
  // flat could be to Centralna is on the ring BEYOND it, so the point we measure from has to
  // overshoot. Clamping at the destination would return Centralna itself, and routing Centralna to
  // itself reads as ~0 minutes — silently switching the centre limit off for these listings.
  const centrum = { lat: 52.2297, lng: 21.0122 };
  const centralna = { lat: 52.2288, lng: 21.0031 };
  const total = haversineMeters(centrum.lat, centrum.lng, centralna.lat, centralna.lng);
  const ringInnerCrow = crowMetersFromRoute(bandFor(4000, 595).minMeters);
  assert.ok(ringInnerCrow > total, 'precondition: the ring encloses the destination');

  const edge = pointToward(centrum.lat, centrum.lng, centralna.lat, centralna.lng, ringInnerCrow);
  const edgeToCentralna = haversineMeters(edge.lat, edge.lng, centralna.lat, centralna.lng);
  assert.ok(edgeToCentralna > 1500, `edge must not collapse onto the destination, got ${Math.round(edgeToCentralna)} m`);
  // It lands on the ring: its distance from the anchor is the ring's inner radius.
  const edgeToAnchor = haversineMeters(edge.lat, edge.lng, centrum.lat, centrum.lng);
  assert.ok(Math.abs(edgeToAnchor - ringInnerCrow) < 50, `expected ~${Math.round(ringInnerCrow)} m from the anchor, got ${Math.round(edgeToAnchor)}`);
});

test('an annulus keeps its inner hole: a place inside the hole is not "reachable at zero"', () => {
  // "4 km from Centrum", margin 400 + station footprint → the flat is 3.4–4.6 km from the station in
  // SOME direction, so anything within 3.4 km of the station — Centralna among them — is still far.
  // Collapsing the ring to a disc of radius (anchor + outer) would report a zero optimistic edge and
  // silently disable the centre limit for exactly these listings.
  const ring = bandFor(4000, 595);
  assert.equal(ring.minMeters, 3405);
  assert.ok(optimisticMeters(700, ring) > 2000, 'a place near the station is far from the ring');
  assert.equal(optimisticMeters(4000, ring), 0, 'a place on the ring could be at the door');
});

// ---------------------------------------------------------------------------
// Pools collected around the wrong point
// ---------------------------------------------------------------------------

test('an annulus does not hard-reject a Google-searched amenity', () => {
  // "4 km from metro X" and nothing else: the grocery pool was searched AROUND THE STATION and
  // capped by distance from it, so the shop nearest where the flat could actually be was never
  // measured. Rejecting on that pool would be rejecting on the wrong search centre.
  const place = { name: 'Biedronka', walkingMinutes: 6, distance: '450 m', distanceMeters: 450 };
  const [widened] = applyLocationUncertainty(
    [{ type: 'groceries', places: [place], nearest: place, withinLimit: true }],
    [{ type: 'groceries', maxMinutes: 10 }],
    550,
    4000,
  );
  assert.equal(widened.withinLimit, false);
  assert.equal(widened.uncertain, true, 'unknown, not a rejection');
  // Metro is exempt: its pool is the complete offline table, already ranked by optimistic edge.
  const station = { name: 'Kabaty', walkingMinutes: 6, distance: '450 m', distanceMeters: 450 };
  const [metro] = applyLocationUncertainty(
    [{ type: 'metro', places: [station], nearest: station, withinLimit: true }],
    [{ type: 'metro', maxMinutes: 10 }],
    550,
    4000,
  );
  assert.equal(metro.uncertain, false);
});

test('a substituted criterion that happens to be within limit is not double-counted', async () => {
  // withinLimit and uncertain must stay mutually exclusive — the amenity score treats them as
  // separate buckets, so a result in both would score above 1.0.
  const pref = { type: 'metro', maxMinutes: 30, stations: ['Lazurowa'] };
  const results = await findNearbyAmenities(52.21866, 21.0153, [pref]);
  assert.equal(results[0]?.criterionSubstituted, true);
  assert.equal(results[0]?.withinLimit, true);
  assert.equal(results[0]?.uncertain, undefined);
});

test('the center gate needs a time: a routing failure is never a rejection', () => {
  const score = mkScore([], {
    precision: 'district',
    centralStation: { distanceText: '~9 км', durationMinRange: null },
  });
  assert.equal(checkCenterGate(score, 25, 'district').pass, true);
});

// ---------------------------------------------------------------------------
// The estimate must not degrade — a vague listing is KEPT, not deleted
// ---------------------------------------------------------------------------

test('a loosely localized listing still slips through the metro gate', () => {
  // Deliberate: uncertainty may not delete a flat. A wide region collapses every optimistic edge
  // to 0, and that keeps the listing with a warning rather than rejecting it — losing a real
  // apartment to a bad geocode is the worse failure. The fix for a useless region belongs
  // upstream, in the estimate (see the fusion test below), not in this gate.
  const place = { name: 'Zacisze', walkingMinutes: 8, distance: '598 m', distanceMeters: 598 };
  const amenity: AmenityResult = {
    type: 'metro', places: [place], nearest: place, withinLimit: false,
  };
  const [widened] = applyLocationUncertainty([amenity], [{ type: 'metro', maxMinutes: 7 }], 4680, 0);

  assert.equal(widened.uncertain, true);
  assert.equal(
    checkAmenityGate(mkScore([widened], { precision: 'district' }), [{ type: 'metro', maxMinutes: 7 }], 'district', true).pass,
    true,
    'a vaguely located flat must be kept with a warning, never deleted',
  );
});

test('a candidate its own bound cannot explain is dropped, not absorbed as radius', () => {
  // A district pin plus a mis-geocoded addressHint ~8.4 km away. Fusing them reported the flat as
  // "somewhere in ~10 km", which is VAGUER than simply trusting the pin — and that inflated radius
  // is what collapsed every optimistic edge. Prefer the best source and say the other was dropped.
  const pin: LocCandidate = {
    lat: 52.28055, lng: 21.05787, sigma: 1800, reliability: 0.4,
    precisionFloor: 'district', source: 'метка района с площадки', evidence: null,
  };
  const misGeocoded: LocCandidate = {
    lat: 52.28055, lng: 20.93447, sigma: 3800, reliability: 0.7,
    precisionFloor: 'approximate', source: 'адрес из описания', evidence: 'Osiedle Wilno',
  };
  const fused = fuseLocationCandidates([pin, misGeocoded], null);

  const pinAlone = fuseLocationCandidates([pin], null);
  assert.equal(fused.outerRadiusMeters, pinAlone.outerRadiusMeters,
    'the estimate must be no vaguer than trusting the pin on its own');
  assert.ok(fused.outerRadiusMeters < 6000, `expected the pin's own bound, got ${fused.outerRadiusMeters} m`);
  assert.match(fused.source, /отброшено/, 'the discard has to be visible in the source trail');
  assert.equal(fused.lat, pin.lat);
});

// ---------------------------------------------------------------------------
// Intersecting evidence: a measured area CLIPS the estimate, never widens it
// ---------------------------------------------------------------------------

const WILNO_PIN: LocCandidate = {
  lat: 52.28055, lng: 21.05787, sigma: 1800, reliability: 0.4,
  precisionFloor: 'district', source: 'метка района с площадки', evidence: null,
};

test('a named area the flat sits in tightens the estimate', () => {
  // "Osiedle Wilno" geocodes to a ~600 m estate box around the pin. The flat is INSIDE it, so the
  // answer is the intersection — 600 m crow, not the pin's own 2σ 3600 m. Averaging the two (what
  // candidateSigma did with an extent) could only ever make the answer wider than the box itself.
  const estate: AreaConstraint = {
    lat: 52.28055, lng: 21.05787, radiusCrowMeters: 600, source: 'граница участка из описания',
  };
  const pinOnly = fuseLocationCandidates([WILNO_PIN], null);
  const clipped = fuseLocationCandidates([WILNO_PIN], null, [estate]);

  assert.ok(clipped.outerRadiusMeters < pinOnly.outerRadiusMeters,
    `expected a tighter bound than ${pinOnly.outerRadiusMeters} m, got ${clipped.outerRadiusMeters} m`);
  assert.equal(clipped.outerRadiusMeters, Math.round(routeMetersFromCrow(600)));
  assert.match(clipped.source, /сужено по/);
});

test('more evidence is never worse: intersecting areas is monotone', () => {
  const wide: AreaConstraint = { lat: 52.28055, lng: 21.05787, radiusCrowMeters: 2500, source: 'район' };
  const tight: AreaConstraint = { lat: 52.28055, lng: 21.05787, radiusCrowMeters: 600, source: 'участок' };
  const one = fuseLocationCandidates([WILNO_PIN], null, [tight]);
  const both = fuseLocationCandidates([WILNO_PIN], null, [tight, wide]);
  assert.equal(both.outerRadiusMeters, one.outerRadiusMeters, 'adding a wider area must not loosen the bound');
});

test('an area disjoint from the point is ignored, not absorbed', () => {
  // The Osiedle Wilno failure in area form: a box 8 km away cannot describe the same flat. Covering
  // both is what produced a 10 km region, so a disjoint constraint contributes nothing.
  const elsewhere: AreaConstraint = {
    lat: 52.28055, lng: 20.93447, radiusCrowMeters: 600, source: 'ошибочный геокод',
  };
  const pinOnly = fuseLocationCandidates([WILNO_PIN], null);
  const withBadArea = fuseLocationCandidates([WILNO_PIN], null, [elsewhere]);
  assert.equal(withBadArea.outerRadiusMeters, pinOnly.outerRadiusMeters);
  assert.doesNotMatch(withBadArea.source, /сужено по/);
});



// ---------------------------------------------------------------------------
// Rings intersect: a second quoted station is evidence, not a spare anchor
// ---------------------------------------------------------------------------




test('an overlapping area now tightens too, without moving the point', () => {
  // The lens. An area that overlaps the fused disc without containing it used to contribute
  // NOTHING — the old rule only fired on full containment, so a district left a 4.7 km estimate
  // untouched. The flat is in the overlap, which is smaller than either, so it must tighten. The
  // point still may not move: a district centroid is not evidence about where the flat is.
  const district: AreaConstraint = {
    lat: 52.29200, lng: 21.04500, radiusCrowMeters: 2600, reliability: 0.95, source: 'граница района',
  };
  const pinOnly = fuseLocationCandidates([WILNO_PIN], null);
  const withDistrict = fuseLocationCandidates([WILNO_PIN], null, [district]);

  assert.ok(withDistrict.outerRadiusMeters < pinOnly.outerRadiusMeters,
    `overlap must tighten: ${withDistrict.outerRadiusMeters} vs ${pinOnly.outerRadiusMeters}`);
  assert.equal(withDistrict.lat, pinOnly.lat, 'an overlapping area may not move the point');
  assert.equal(withDistrict.lng, pinOnly.lng);
});

test('a tighter area binds to its own radius and keeps the pin as the point', () => {
  const estate: AreaConstraint = {
    lat: 52.28300, lng: 21.06100, radiusCrowMeters: 600, reliability: 0.7, source: 'участок',
  };
  const fused = fuseLocationCandidates([WILNO_PIN], null, [estate]);
  assert.equal(fused.outerRadiusMeters, Math.round(routeMetersFromCrow(600)));
  assert.equal(fused.lat, WILNO_PIN.lat, 'the pin is the position evidence; the box is only a bound');
  assert.equal(fused.precision, 'approximate');
});

test('an ad ring is inherently wide, and is never allowed to widen the estimate', () => {
  // A quoted "N m to the metro" carries the ad's own margin PLUS the station footprint on both
  // edges, so even a tight claim is a band a few hundred metres wide. It may corroborate, and it
  // may be ignored, but it must never make the answer worse than the point evidence alone.
  const zacisze = findMetroStation('Zacisze')!;
  const trocka = findMetroStation('Trocka')!;
  const pinOnly = fuseLocationCandidates([WILNO_PIN], null);
  const withRings = fuseLocationCandidates(
    [WILNO_PIN],
    { station: zacisze, distance: 598, margin: 100, evidence: null },
    [],
    [{ station: trocka, distance: 826, margin: 100, evidence: null }],
  );
  assert.ok(withRings.outerRadiusMeters <= pinOnly.outerRadiusMeters);
  assert.match(withRings.source, /Zacisze/);
  assert.match(withRings.source, /Trocka/);
});

// ---------------------------------------------------------------------------
// A contradicted claim is false evidence — not a bigger search area
// ---------------------------------------------------------------------------

test('a station claim the point cannot reach never widens the estimate', () => {
  // The real NCVVYE card. The ad said "5 minut do stacji metra Dworzec Wileński" for a flat in
  // Targówek, 3.3 km away. Widening sigma to that discrepancy is what produced "~0 м–11,4 км ·
  // ~0–146 мин": adding evidence made the answer five times worse.
  const dw = findMetroStation('Dworzec Wileński')!;
  const ring: MetroConstraint = { station: dw, distance: 300, margin: 200, evidence: '5 minut' };
  const pinOnly = fuseLocationCandidates([WILNO_PIN], null);
  const withFalseClaim = fuseLocationCandidates([WILNO_PIN], ring);

  assert.equal(withFalseClaim.outerRadiusMeters, pinOnly.outerRadiusMeters,
    'a contradicted claim must leave the estimate exactly as it was');
  assert.match(withFalseClaim.source, /расхожден/, 'and it still has to be surfaced');
});

test('a contradicted claim does not drag the point onto its station either', () => {
  // The containment pass maximises satisfied evidence, so a ring left in its input made moving the
  // point 3.3 km the highest-scoring answer — it reported Dworzec Wileński as the nearest station,
  // at 695 m "precision", for a flat in Targówek. Only corroborated rings may reach that pass.
  const dw = findMetroStation('Dworzec Wileński')!;
  const district: AreaConstraint = {
    lat: 52.28238, lng: 21.06537, radiusCrowMeters: 4306, reliability: 0.95, source: 'граница района',
  };
  const fused = fuseLocationCandidates(
    [WILNO_PIN],
    { station: dw, distance: 300, margin: 200, evidence: null },
    [district],
  );
  assert.ok(haversineMeters(fused.lat!, fused.lng!, WILNO_PIN.lat, WILNO_PIN.lng) < 50,
    `the point must stay on the pin, moved ${Math.round(haversineMeters(fused.lat!, fused.lng!, WILNO_PIN.lat, WILNO_PIN.lng))} m`);
});

test('the estimate is never vaguer than a containing area, whatever else happens', () => {
  // The floor. A listing filed under a district is in that district, so no estimate for it may be
  // wider — the shipped card was 2.5x wider than the district's own extent.
  const tightDistrict: AreaConstraint = {
    lat: WILNO_PIN.lat, lng: WILNO_PIN.lng, radiusCrowMeters: 1500,
    reliability: 0.95, source: 'граница района',
  };
  const dw = findMetroStation('Dworzec Wileński')!;
  const fused = fuseLocationCandidates(
    [WILNO_PIN],
    { station: dw, distance: 300, margin: 200, evidence: null },  // false claim
    [tightDistrict],
  );
  assert.ok(fused.outerRadiusMeters <= Math.round(routeMetersFromCrow(1500)),
    `expected the district floor, got ${fused.outerRadiusMeters} m`);
});

test('an establishment match is not a position candidate', () => {
  // "Osiedle Wilno, Warszawa" geocodes to `Wierna 24 — real_estate_agency`: an agency named after
  // the estate, 1.8 km from it. Classified weak so the address branch records it as unverified
  // instead of believing it — de-weighting alone was not enough, because fusion weights by
  // reliability/σ² and an establishment's tight σ beats a fuzzy pin's 1800 m regardless.
  const agency = classifyGeocodePrecision({
    locationType: 'ROOFTOP', partialMatch: false,
    resultTypes: ['establishment', 'point_of_interest', 'real_estate_agency'],
  });
  assert.equal(agency.weak, true);
  // A genuine street address is untouched by the new class.
  const street = classifyGeocodePrecision({
    locationType: 'ROOFTOP', partialMatch: false, resultTypes: ['street_address'],
  });
  assert.equal(street.weak, undefined);
  assert.equal(street.precision, 'street');
});
