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
import { classifyGeocodePrecision, isUsableDescriptionLocationHint, enrichListingLocation } from '../src/ai/location.js';
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

test('transit_stop hint for a known station uses verified coords + tight uncertainty (not a fuzzy geocode)', async () => {
  // "70 m from Metro Młynów" must stay precise so a strict metro/center filter can act on it,
  // instead of being inflated to Google's ~1.5 km area for "metro Młynów".
  const listing = {
    platform: 'olx', platformId: '1', url: 'x', slug: 's', title: 't', description: '',
    price: 5800, currency: 'PLN', rent: 1000, area: 82, rooms: 4,
    city: 'Warszawa', district: 'Wola', street: null, region: 'Mazowieckie',
    lat: 52.2385, lng: 20.9594, photos: [], createdAt: '', scrapedAt: '',
  } as unknown as Listing;
  const parsed = {
    addressHint: null,
    locationHint: { query: 'metro Młynów, Warszawa', kind: 'transit_stop', anchorDistanceMeters: 70, uncertaintyMeters: 20, evidence: '70 m od metra Młynów' },
  } as unknown as ParsedRentalData;
  const e = await enrichListingLocation(listing, parsed);
  assert.equal(e.precision, 'approximate');
  assert.ok(Math.abs(e.lat! - 52.23766) < 0.002 && Math.abs(e.lng! - 20.9601) < 0.002, `Młynów coords, got ${e.lat},${e.lng}`);
  assert.equal(e.uncertaintyMeters, 150); // floored/tight, NOT inflated to 1500
  assert.equal(e.anchorDistanceMeters, 70);
});

test('metroNearestWithUncertainty keeps the truly-nearest station first when anchor offset > uncertainty', () => {
  // At Politechnika: nearest is Politechnika (0 m), second is Pole Mokotowskie (~1.6 km walk).
  // With anchorDistanceMeters(1500) > uncertaintyMeters(600) the derived range-min inverts
  // (Politechnika range-min 900 > Pole Mokotowskie range-min 0), which previously reordered
  // the display. The nearest station must still be shown first.
  const places = metroNearestWithUncertainty(52.21866, 21.01530, {
    precision: 'approximate', anchorDistanceMeters: 1500, uncertaintyMeters: 600, source: 't',
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
  assert.deepEqual(classifyGeocodePrecision({
    locationType: 'APPROXIMATE',
    partialMatch: true,
    resultTypes: ['locality'],
  }), { precision: 'approximate', uncertaintyMeters: 1500 });
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
  assert.deepEqual(result.nearest?.walkingMinutesRange, { min: 11, max: 16 });
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

  assert.deepEqual(result.nearest?.walkingMinutesRange, { min: 6, max: 18 });
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
  const [result] = applyLocationUncertainty([{
    type: 'metro',
    requestedLine: 'M1',
    places: [
      { name: 'Ambiguous', walkingMinutes: 10, distance: '500 m', distanceMeters: 500, lineName: 'M1' },
      { name: 'Reliably close', walkingMinutes: 3, distance: '1 km', distanceMeters: 1000, lineName: 'M1' },
    ],
    nearest: { name: 'Ambiguous', walkingMinutes: 10, distance: '500 m', distanceMeters: 500, lineName: 'M1' },
    withinLimit: true,
  }], [{ type: 'metro', maxMinutes: 7, line: 'M1' }], 500);

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

test('large directionless anchor offset cannot produce a strict rejection', () => {
  const [result] = applyLocationUncertainty([{
    type: 'metro',
    requestedLine: 'M1',
    places: [{ name: 'Station near anchor', walkingMinutes: 5, distance: '350 m', distanceMeters: 350, lineName: 'M1' }],
    nearest: { name: 'Station near anchor', walkingMinutes: 5, distance: '350 m', distanceMeters: 350, lineName: 'M1' },
    withinLimit: true,
  }], [{ type: 'metro', maxMinutes: 7, line: 'M1' }], 500, 12_000);

  assert.equal(result.withinLimit, false);
  assert.equal(result.uncertain, true);
});
