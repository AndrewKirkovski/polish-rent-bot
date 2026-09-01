import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLocationUncertainty,
  computeWithinLimit,
  createUnknownLocationScore,
  shouldTreatAmenityMeasurementAsUnknown,
  warsawMetroLinesForStation,
  metroNearestWithUncertainty,
} from '../src/ai/maps.js';
import { classifyGeocodePrecision, isUsableDescriptionLocationHint, enrichListingLocation, fuseLocationCandidates, type LocCandidate } from '../src/ai/location.js';
import type { Listing, ParsedRentalData } from '../src/types.js';

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

test('incomplete Maps evidence may confirm a pass but cannot prove rejection', () => {
  assert.equal(shouldTreatAmenityMeasurementAsUnknown(true, false, false), true);
  assert.equal(shouldTreatAmenityMeasurementAsUnknown(false, true, false), true);
  assert.equal(shouldTreatAmenityMeasurementAsUnknown(true, true, true), false);
  assert.equal(shouldTreatAmenityMeasurementAsUnknown(false, false, false), false);
});

test('Warsaw metro station names resolve to canonical lines', () => {
  assert.deepEqual(warsawMetroLinesForStation('Dworzec Gdański'), ['M1']);
  assert.deepEqual(warsawMetroLinesForStation('Metro Bemowo'), ['M2']);
  assert.deepEqual(warsawMetroLinesForStation('Stacja metra Młociny'), ['M1']);
  assert.deepEqual(warsawMetroLinesForStation('M2 Rondo ONZ'), ['M2']);
  assert.deepEqual(warsawMetroLinesForStation('Świętokrzyska'), ['M1', 'M2']);
});

test('invented station name does not resolve to a metro line', () => {
  assert.deepEqual(warsawMetroLinesForStation('Bemowo Ratusz'), []);
});

const mlynowParsed = () => ({
  addressHint: null,
  locationHint: { query: 'metro Młynów, Warszawa', kind: 'transit_stop', anchorDistanceMeters: 70, uncertaintyMeters: 20, evidence: '70 m od metra Młynów' },
}) as unknown as ParsedRentalData;
const olxListing = (over: Partial<Listing>) => ({
  platform: 'olx', platformId: '1', url: 'x', slug: 's', title: 't', description: '',
  price: 5800, currency: 'PLN', rent: 1000, area: 82, rooms: 4,
  city: 'Warszawa', district: 'Wola', street: null, region: 'Mazowieckie',
  lat: 52.23850518, lng: 20.95938461, photos: [], createdAt: '', scrapedAt: '', ...over,
}) as unknown as Listing;

test('location fusion: a precise OLX pin cross-checked by a metro anchor → the building at street precision', async () => {
  // The pin is the seller's building pin (show_detailed=true); the "70 m from Metro Młynów" claim
  // must CONFIRM it (≈106 m measured), not replace it with the station centroid or inflate it.
  const e = await enrichListingLocation(olxListing({ coordsPrecise: true }), mlynowParsed());
  assert.equal(e.precision, 'street');
  assert.equal(e.anchorDistanceMeters, 0); // a real point, not a station annulus
  assert.ok(Math.abs(e.lat! - 52.23850518) < 3e-4 && Math.abs(e.lng! - 20.95938461) < 3e-4, `at the pin, got ${e.lat},${e.lng}`);
  assert.ok(e.uncertaintyMeters <= 200, `tight, got ${e.uncertaintyMeters}`);
});

test('location fusion: a fuzzy OLX pin is kept at the pin (not snapped to the station centroid)', async () => {
  const e = await enrichListingLocation(olxListing({ coordsPrecise: false }), mlynowParsed());
  assert.equal(e.anchorDistanceMeters, 0);
  // Stays at the pin (52.2385…), NOT the Młynów station centroid (52.23766, 20.9601).
  assert.ok(Math.abs(e.lat! - 52.23850518) < 3e-4, `at the pin, got ${e.lat}`);
  assert.ok(e.uncertaintyMeters <= 400, `metro-confirmed → tightened, got ${e.uncertaintyMeters}`);
});

test('location fusion: coords we derived earlier come back at the uncertainty they actually had', async () => {
  // An earlier pass fused this listing to ±520 route metres and persisted the point. Re-ingesting it
  // as a seller's building pin would report σ=120 — tighter than the evidence behind it — and the
  // gates now hard-reject from the optimistic edge, so laundered precision deletes listings.
  const e = await enrichListingLocation(
    olxListing({ coordsPrecise: true, coordsOuterRadiusMeters: 520 }),
    mlynowParsed(),
  );
  assert.match(e.source, /прошлого прохода/, 'labelled as our own earlier result, not a platform pin');
  // 520 route metres ÷ 1.3 ÷ 2σ = 200 m crow, then the agreeing metro anchor may tighten it — but it
  // must not be reported at the 120 m a platform pin would have claimed.
  assert.ok(e.uncertaintyMeters > 120, `must not be laundered tighter than its evidence, got ${e.uncertaintyMeters}`);
  assert.ok(e.uncertaintyMeters <= 200, `and no wider than it was, got ${e.uncertaintyMeters}`);
});

test('location fusion: a genuine platform pin is still trusted as one', async () => {
  // No coordsOuterRadiusMeters → these are OLX's own seller-placed coordinates, not ours.
  const e = await enrichListingLocation(olxListing({ coordsPrecise: true }), mlynowParsed());
  assert.match(e.source, /с площадки/);
  assert.ok(e.uncertaintyMeters <= 120, `platform pin keeps its tight prior, got ${e.uncertaintyMeters}`);
});

test('location fusion: a pin far from the claimed station is flagged as a conflict, not falsely tightened', async () => {
  // Pin is near Młynów, but the hint claims "at metro Politechnika" (~4 km away): the constraint must
  // NOT corroborate/tighten — the point stays coarse and the disagreement is surfaced.
  const parsed = {
    addressHint: null,
    locationHint: { query: 'metro Politechnika, Warszawa', kind: 'transit_stop', anchorDistanceMeters: 0, uncertaintyMeters: 20, evidence: 'przy metrze Politechnika' },
  } as unknown as ParsedRentalData;
  const e = await enrichListingLocation(olxListing({ coordsPrecise: false }), parsed);
  assert.equal(e.precision, 'district');
  assert.ok(e.uncertaintyMeters >= 1000, `not falsely tightened, got ${e.uncertaintyMeters}`);
  assert.match(e.source, /расхожден/);
});

test('applyLocationUncertainty honors the groceries transit fallback at an approximate location', () => {
  // Walk 19 min (over the 10-min limit) but 7 min by bus — the point gate passed via transit; after
  // uncertainty widening the WALKING range is still over limit, so this must stay within-limit by transit
  // (not hard-reject a supermarket that's a short bus ride away).
  const place = { name: 'Biedronka', walkingMinutes: 19, transitMinutes: 7, distanceMeters: 1425, distance: '1.4 км' };
  const amenities = [{ type: 'groceries', places: [place], nearest: place, withinLimit: true }] as unknown as Parameters<typeof applyLocationUncertainty>[0];
  const prefs = [{ type: 'groceries', maxMinutes: 10 }] as unknown as Parameters<typeof applyLocationUncertainty>[1];
  const [g] = applyLocationUncertainty(amenities, prefs, 300, 0);
  assert.equal(g.withinLimit, true, 'transit fallback should keep it within limit');
  // Sanity: the walking range really is over the limit, so the pass is due to transit, not walking.
  assert.ok((g.nearest?.walkingMinutesRange?.min ?? 0) > 10, `walking range should exceed limit, got ${JSON.stringify(g.nearest?.walkingMinutesRange)}`);
});

test('applyLocationUncertainty preserves an already-set uncertain flag (out-of-service-area metro)', () => {
  // offlineMetroAmenity flags an out-of-area metro uncertain:true / withinLimit:false (a non-Warsaw
  // listing whose nearest "Warsaw" station is ~250 km away). The uncertainty recompute must KEEP
  // uncertain (→ keep-with-flag), not collapse it to a false hard reject against that far station.
  const farStation = { name: 'Młociny', walkingMinutes: 3200, distanceMeters: 250000, distance: '250 км' };
  const amenities = [{ type: 'metro', requestedLine: undefined, places: [farStation], nearest: farStation, withinLimit: false, uncertain: true }] as unknown as Parameters<typeof applyLocationUncertainty>[0];
  const prefs = [{ type: 'metro', maxMinutes: 7 }] as unknown as Parameters<typeof applyLocationUncertainty>[1];
  const [m] = applyLocationUncertainty(amenities, prefs, 120, 0);
  assert.equal(m.uncertain, true, 'out-of-area metro uncertainty must survive the recompute');
  assert.equal(m.withinLimit, false);
});

test('applyLocationUncertainty keeps withinLimit and uncertain mutually exclusive (no double-count)', () => {
  // A groceries place reachable by transit (withinLimit via fallback) that ALSO carries a measurement
  // error must not be counted as BOTH within (1.0) and uncertain (0.5) — that inflates the amenities score.
  const place = { name: 'Biedronka', walkingMinutes: 25, transitMinutes: 6, distanceMeters: 1900, distance: '1.9 км' };
  const amenities = [{ type: 'groceries', places: [place], nearest: place, withinLimit: false, error: true, uncertain: true }] as unknown as Parameters<typeof applyLocationUncertainty>[0];
  const prefs = [{ type: 'groceries', maxMinutes: 10 }] as unknown as Parameters<typeof applyLocationUncertainty>[1];
  const [g] = applyLocationUncertainty(amenities, prefs, 300, 0);
  assert.equal(g.withinLimit, true, 'transit fallback → within limit');
  assert.equal(g.uncertain, false, 'must not also be uncertain when within limit');
});

const cand = (over: Partial<LocCandidate>): LocCandidate => ({ lat: 52.2385, lng: 20.9594, sigma: 120, reliability: 0.85, precisionFloor: 'street', source: 'pin', evidence: null, ...over });

test('fuseLocationCandidates: single candidate is returned unchanged', () => {
  const e = fuseLocationCandidates([cand({})], null);
  assert.equal(e.precision, 'street');
  assert.equal(e.uncertaintyMeters, 120);
  assert.ok(Math.abs(e.lat! - 52.2385) < 1e-6 && Math.abs(e.lng! - 20.9594) < 1e-6);
});

test('fuseLocationCandidates: two ~350 m-apart candidates are not reported as ±87 m (spread inflation)', () => {
  const a = cand({ lat: 52.2400, sigma: 120 });
  const b = cand({ lat: 52.2368, sigma: 125, reliability: 0.75, source: 'street' });
  const e = fuseLocationCandidates([a, b], null);
  assert.ok(e.uncertaintyMeters >= 150, `spread-inflated, got ${e.uncertaintyMeters}`); // inverse-variance alone ≈ 87
});

test('fuseLocationCandidates: a metro constraint on the annulus corroborates (keeps point, notes station)', () => {
  const e = fuseLocationCandidates([cand({})], { station: { name: 'Młynów', lat: 52.23766, lng: 20.9601 }, distance: 70, margin: 150, evidence: 'e' });
  assert.equal(e.precision, 'street');
  assert.match(e.source, /Młynów/);
  assert.ok(e.uncertaintyMeters <= 200);
});

test('fuseLocationCandidates: a corroborating metro constraint does not INFLATE a sub-120 m fused point', () => {
  // Two co-located candidates (precise pin σ=120 + rooftop street σ=50) fuse to ~46 m. A metro hint
  // that AGREES must hold-or-tighten — never widen the best-evidenced point back up to the 120 m floor.
  const pin = cand({ lat: 52.2385, lng: 20.9594, sigma: 120, reliability: 0.85, source: 'pin' });
  const street = cand({ lat: 52.2385, lng: 20.9594, sigma: 50, reliability: 0.7, source: 'street' });
  const preFuse = fuseLocationCandidates([pin, street], null);
  assert.ok(preFuse.uncertaintyMeters < 120, `precondition: sub-120 fuse, got ${preFuse.uncertaintyMeters}`);
  // Station ~104 m from the fused point, distance 100 → discrepancy ~4 m ≪ margin → corroborates.
  const withMetro = fuseLocationCandidates([pin, street], { station: { name: 'Młynów', lat: 52.23766, lng: 20.9601 }, distance: 100, margin: 150, evidence: 'e' });
  assert.match(withMetro.source, /Młynów/);
  assert.ok(withMetro.uncertaintyMeters <= preFuse.uncertaintyMeters + 1, `corroboration inflated it: was ${preFuse.uncertaintyMeters}, got ${withMetro.uncertaintyMeters}`);
  assert.ok(withMetro.uncertaintyMeters < 120, `must stay sub-120, got ${withMetro.uncertaintyMeters}`);
});

test('fuseLocationCandidates: a pin far from the claimed station is flagged as conflict, not tightened', () => {
  const fuzzy = cand({ sigma: 1800, reliability: 0.4, precisionFloor: 'district', source: 'pin' });
  const e = fuseLocationCandidates([fuzzy], { station: { name: 'Politechnika', lat: 52.21866, lng: 21.01530 }, distance: 0, margin: 400, evidence: 'e' });
  assert.equal(e.precision, 'district');
  assert.match(e.source, /расхожден/);
  assert.ok(e.uncertaintyMeters >= 1000);
});

test('metroNearestWithUncertainty keeps the truly-nearest station first when anchor offset > uncertainty', () => {
  // At Politechnika: nearest is Politechnika (0 m), second is Pole Mokotowskie (~1.6 km walk).
  // With anchorDistanceMeters(1500) > uncertaintyMeters(600) the derived range-min inverts
  // (Politechnika range-min 900 > Pole Mokotowskie range-min 0), which previously reordered
  // the display. The nearest station must still be shown first.
  const places = metroNearestWithUncertainty(52.21866, 21.01530, {
    precision: 'approximate', anchorDistanceMeters: 1500, uncertaintyMeters: 600, outerRadiusMeters: 600, source: 't',
  });
  assert.equal(places[0]!.name, 'Politechnika');
  assert.ok(places[0]!.distanceMetersRange, 'ranges applied when approximate');
});

test('invented Warsaw metro name cannot become a description geocoding anchor', () => {
  assert.equal(isUsableDescriptionLocationHint({
    query: 'metro Bemowo Ratusz, Warszawa',
    kind: 'transit_stop',
    anchorDistanceMeters: 1000,
    uncertaintyMeters: 200,
    evidence: '1000 m od metra Bemowo Ratusz',
  }, 'Warszawa'), false);
  assert.equal(isUsableDescriptionLocationHint({
    query: 'metro Bemowo, Warszawa',
    kind: 'transit_stop',
    anchorDistanceMeters: 1000,
    uncertaintyMeters: 200,
    evidence: '1000 m od metra Bemowo',
  }, 'Warszawa'), true);
  assert.equal(isUsableDescriptionLocationHint({
    query: 'stacja metra Bemowo Warszawa Polska',
    kind: 'transit_stop',
    anchorDistanceMeters: 1000,
    uncertaintyMeters: 200,
    evidence: '1000 m od metra Bemowo',
  }, 'Warsaw'), true);
});

test('platform district alone cannot be promoted to a stronger description anchor', () => {
  const base = {
    kind: 'neighborhood' as const,
    anchorDistanceMeters: 0,
    uncertaintyMeters: 1800,
    evidence: 'Bemowo',
  };
  assert.equal(isUsableDescriptionLocationHint({
    ...base,
    query: 'dzielnica Bemowo, Warszawa',
  }, 'Warszawa', 'Bemowo'), false);
  assert.equal(isUsableDescriptionLocationHint({
    ...base,
    query: 'Jelonki, Warszawa',
  }, 'Warszawa', 'Bemowo'), true);
});

test('geocoder only treats address-grade matches as street precision', () => {
  assert.deepEqual(classifyGeocodePrecision({
    locationType: 'ROOFTOP',
    partialMatch: false,
    resultTypes: ['street_address'],
  }), { precision: 'street', uncertaintyMeters: 50 });
  assert.deepEqual(classifyGeocodePrecision({
    locationType: 'GEOMETRIC_CENTER',
    partialMatch: false,
    resultTypes: ['route'],
  }), { precision: 'approximate', uncertaintyMeters: 600 });
  // A partial match is the geocoder saying it did not find the query — weak, so it never becomes
  // a position candidate that could outrank the platform's own pin.
  assert.deepEqual(classifyGeocodePrecision({
    locationType: 'APPROXIMATE',
    partialMatch: true,
    resultTypes: ['locality'],
  }), { precision: 'approximate', uncertaintyMeters: 1500, weak: true });
  assert.deepEqual(classifyGeocodePrecision({
    locationType: 'ROOFTOP',
    partialMatch: false,
    resultTypes: ['locality'],
  }), { precision: 'approximate', uncertaintyMeters: 2500 });
});

test('description-anchor uncertainty produces conservative distance and time ranges', () => {
  const [result] = applyLocationUncertainty([{
    type: 'metro',
    places: [{ name: 'Bemowo', walkingMinutes: 0, distance: '1 m', distanceMeters: 1, lineName: 'M2' }],
    nearest: { name: 'Bemowo', walkingMinutes: 0, distance: '1 m', distanceMeters: 1, lineName: 'M2' },
    withinLimit: true,
  }], [{ type: 'metro', maxMinutes: 7 }], 150, 1000);
  assert.deepEqual(result.nearest?.distanceMetersRange, { min: 849, max: 1151 });
  // A 1 m / 0 min measurement carries no usable pace, so the shared walk model (78 m/min) converts
  // the widened distances — not the 75 m/min literal this file used to hardcode.
  assert.deepEqual(result.nearest?.walkingMinutesRange, { min: 10, max: 15 });
  assert.equal(result.withinLimit, false);
  assert.equal(result.uncertain, false);
});

test('uncertainty time range preserves Google measured route pace', () => {
  const [result] = applyLocationUncertainty([{
    type: 'metro',
    requestedLine: 'M1',
    places: [{ name: 'Centrum', walkingMinutes: 12, distance: '600 m', distanceMeters: 600, lineName: 'M1' }],
    nearest: { name: 'Centrum', walkingMinutes: 12, distance: '600 m', distanceMeters: 600, lineName: 'M1' },
    withinLimit: false,
  }], [{ type: 'metro', maxMinutes: 15, line: 'M1' }], 300);

  // The two ends bracket the pace: `max` keeps the slow measured route (600 m in 12 min = 50 m/min),
  // while `min` uses the walk model — the closest possible position is a different, shorter route
  // that has no reason to inherit this one's detours.
  assert.deepEqual(result.nearest?.walkingMinutesRange, { min: 3, max: 18 });
  assert.equal(result.uncertain, true);
});

test('approximate anchor selects the closest plausible station, not only point-nearest', () => {
  const [result] = applyLocationUncertainty([{
    type: 'metro',
    requestedLine: 'M1',
    places: [
      { name: 'At anchor', walkingMinutes: 1, distance: '75 m', distanceMeters: 75, lineName: 'M1' },
      { name: 'At possible apartment', walkingMinutes: 13, distance: '975 m', distanceMeters: 975, lineName: 'M1' },
    ],
    nearest: { name: 'At anchor', walkingMinutes: 1, distance: '75 m', distanceMeters: 75, lineName: 'M1' },
    withinLimit: true,
  }], [{ type: 'metro', maxMinutes: 7, line: 'M1' }], 100, 1000);

  assert.equal(result.nearest?.name, 'At possible apartment');
  assert.equal(result.nearest?.distanceMetersRange?.min, 0);
  assert.equal(result.uncertain, true);
});

test('line-specific uncertainty uses the matching M1 and M2 thresholds', () => {
  const results = applyLocationUncertainty([
    {
      type: 'metro',
      requestedLine: 'M1',
      places: [{ name: 'Centrum', walkingMinutes: 10, distance: '750 m', distanceMeters: 750, lineName: 'M1' }],
      nearest: { name: 'Centrum', walkingMinutes: 10, distance: '750 m', distanceMeters: 750, lineName: 'M1' },
      withinLimit: false,
    },
    {
      type: 'metro',
      requestedLine: 'M2',
      places: [{ name: 'Rondo ONZ', walkingMinutes: 10, distance: '750 m', distanceMeters: 750, lineName: 'M2' }],
      nearest: { name: 'Rondo ONZ', walkingMinutes: 10, distance: '750 m', distanceMeters: 750, lineName: 'M2' },
      withinLimit: true,
    },
  ], [
    { type: 'metro', maxMinutes: 5, line: 'M1' },
    { type: 'metro', maxMinutes: 15, line: 'M2' },
  ], 75);

  assert.equal(results[0]?.withinLimit, false);
  assert.equal(results[0]?.uncertain, false);
  assert.equal(results[1]?.withinLimit, true);
  assert.equal(results[1]?.uncertain, false);
});

test('any plausible station crossing the limit keeps the result uncertain', () => {
  const [result] = applyLocationUncertainty([{
    type: 'metro',
    requestedLine: 'M1',
    places: [
      { name: 'Point nearest', walkingMinutes: 15, distance: '1.1 km', distanceMeters: 1100, lineName: 'M1' },
      { name: 'Area edge', walkingMinutes: 20, distance: '1.5 km', distanceMeters: 1500, lineName: 'M1' },
    ],
    nearest: { name: 'Point nearest', walkingMinutes: 15, distance: '1.1 km', distanceMeters: 1100, lineName: 'M1' },
    withinLimit: false,
  }], [{ type: 'metro', maxMinutes: 7, line: 'M1' }], 100, 1500);

  assert.equal(result.withinLimit, false);
  assert.equal(result.uncertain, true);
});

test('displayed station is the candidate that proves a certain within-limit verdict', () => {
  // 'Ambiguous' sorts first (smaller optimistic edge) but its range straddles the 7-min limit;
  // 'Reliably close' is farther yet walks faster, so its whole range fits — that is the candidate
  // the verdict rests on, so it must be the one displayed.
  const [result] = applyLocationUncertainty([{
    type: 'metro',
    requestedLine: 'M1',
    places: [
      { name: 'Ambiguous', walkingMinutes: 5, distance: '250 m', distanceMeters: 250, lineName: 'M1' },
      { name: 'Reliably close', walkingMinutes: 4, distance: '300 m', distanceMeters: 300, lineName: 'M1' },
    ],
    nearest: { name: 'Ambiguous', walkingMinutes: 5, distance: '250 m', distanceMeters: 250, lineName: 'M1' },
    withinLimit: true,
  }], [{ type: 'metro', maxMinutes: 7, line: 'M1' }], 200);

  assert.deepEqual(result.places.find((p) => p.name === 'Ambiguous')?.walkingMinutesRange, { min: 0, max: 9 });
  assert.equal(result.withinLimit, true);
  assert.equal(result.uncertain, false);
  assert.equal(result.nearest?.name, 'Reliably close');
  assert.equal(result.places[0]?.name, 'Reliably close');
});

test('missing location creates a warning, not a false failure result', () => {
  const score = createUnknownLocationScore(
    [{ type: 'metro', maxMinutes: 7, line: 'M1' }],
    'Warszawa',
    undefined,
    'niepotwierdzony przystanek',
  );
  assert.equal(score.locationUnknown, true);
  assert.match(score.locationWarning!, /nie udało|местоположение/i);
  assert.equal(score.locationEvidence, 'niepotwierdzony przystanek');
  assert.equal(score.amenities[0]?.uncertain, true);
});

test('empty amenity result at an approximate anchor remains unknown, not failed', () => {
  const [result] = applyLocationUncertainty([{
    type: 'metro',
    requestedLine: 'M1',
    places: [],
    nearest: null,
    withinLimit: false,
  }], [{ type: 'metro', maxMinutes: 7, line: 'M1' }], 800);

  assert.equal(result.withinLimit, false);
  assert.equal(result.uncertain, true);
});

test('location ranges preserve uncertainty from incomplete Maps evidence', () => {
  const [result] = applyLocationUncertainty([{
    type: 'metro',
    requestedLine: 'M1',
    places: [{ name: 'Measured far station', walkingMinutes: 30, distance: '2 km', distanceMeters: 2000, lineName: 'M1' }],
    nearest: { name: 'Measured far station', walkingMinutes: 30, distance: '2 km', distanceMeters: 2000, lineName: 'M1' },
    withinLimit: false,
    uncertain: true,
    error: true,
  }], [{ type: 'metro', maxMinutes: 7, line: 'M1' }], 100);

  assert.equal(result.withinLimit, false);
  assert.equal(result.error, true);
  assert.equal(result.uncertain, true);
  assert.equal(result.nearest?.name, 'Measured far station');
});

test('a large anchor offset still rejects when the optimistic edge is far outside the limit', () => {
  // "12 km from X" puts the flat on a wide ring around X. The only measured station sits 350 m from
  // X — i.e. ~11 km from the closest point the flat could occupy. Directionlessness does not make
  // that unknown: no position on the ring is 7 minutes from this station, so it is a hard fail.
  const [result] = applyLocationUncertainty([{
    type: 'metro',
    requestedLine: 'M1',
    places: [{ name: 'Station near anchor', walkingMinutes: 5, distance: '350 m', distanceMeters: 350, lineName: 'M1' }],
    nearest: { name: 'Station near anchor', walkingMinutes: 5, distance: '350 m', distanceMeters: 350, lineName: 'M1' },
    withinLimit: true,
  }], [{ type: 'metro', maxMinutes: 7, line: 'M1' }], 500, 12_000);

  assert.equal(result.withinLimit, false);
  assert.equal(result.uncertain, false);
  assert.ok((result.nearest?.walkingMinutesRange?.min ?? 0) > 7);
});
