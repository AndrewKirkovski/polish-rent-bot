import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WARSAW_METRO_STATIONS,
  WARSZAWA_CENTRALNA,
  METRO_SERVICE_RADIUS_M,
  nearestMetroStations,
  warsawMetroLinesForStation,
  haversineMeters,
  walkMetersFromCrow,
  walkMinutesFor,
} from '../src/geo/metro.js';

test('station table: 21 on M1, 18 on M2, Świętokrzyska is the single interchange', () => {
  const m1 = WARSAW_METRO_STATIONS.filter((s) => s.lines.includes('M1'));
  const m2 = WARSAW_METRO_STATIONS.filter((s) => s.lines.includes('M2'));
  assert.equal(m1.length, 21);
  assert.equal(m2.length, 18);
  const interchanges = WARSAW_METRO_STATIONS.filter((s) => s.lines.length === 2);
  assert.equal(interchanges.length, 1);
  assert.equal(interchanges[0]!.name, 'Świętokrzyska');
});

test('every station has plausible Warsaw coordinates', () => {
  for (const s of WARSAW_METRO_STATIONS) {
    assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lng), `${s.name} coords`);
    assert.ok(s.lat > 52.0 && s.lat < 52.4, `${s.name} lat in Warsaw`);
    assert.ok(s.lng > 20.8 && s.lng < 21.2, `${s.name} lng in Warsaw`);
  }
});

test('nearestMetroStations returns the on-site station first', () => {
  // Coordinates of Politechnika itself → it must be the closest.
  const near = nearestMetroStations(52.21866, 21.01530, { limit: 2 });
  assert.equal(near[0]!.station.name, 'Politechnika');
  assert.equal(near.length, 2);
  // Sorted ascending by distance.
  assert.ok(near[0]!.crowMeters <= near[1]!.crowMeters);
});

test('line filter never returns an off-line station', () => {
  // Rondo ONZ is M2-only; asking for M1 must yield only M1 stations.
  const m1Only = nearestMetroStations(52.23307, 20.99810, { line: 'M1', limit: 3 });
  for (const n of m1Only) assert.ok(n.station.lines.includes('M1'), `${n.station.name} on M1`);
});

test('warsawMetroLinesForStation resolves names, affixes, and the interchange', () => {
  assert.deepEqual(warsawMetroLinesForStation('Dworzec Gdański'), ['M1']);
  assert.deepEqual(warsawMetroLinesForStation('Metro Bemowo'), ['M2']);
  assert.deepEqual(warsawMetroLinesForStation('Stacja metra Młociny'), ['M1']);
  assert.deepEqual(warsawMetroLinesForStation('M2 Rondo ONZ'), ['M2']);
  assert.deepEqual(warsawMetroLinesForStation('Świętokrzyska'), ['M1', 'M2']);
  assert.deepEqual(warsawMetroLinesForStation('Bemowo Ratusz'), []); // not a real station
});

test('haversine + walk model are sane', () => {
  // Politechnika → Centrum is roughly 1.3–1.5 km straight line.
  const d = haversineMeters(52.21866, 21.01530, 52.23101, 21.01019);
  assert.ok(d > 1200 && d < 1700, `dist ${d}`);
  assert.equal(walkMetersFromCrow(1000), 1300); // 1.3× detour
  assert.equal(walkMinutesFor(780), 10);        // ~78 m/min
});

test('Warszawa Centralna sits next to Centrum', () => {
  const d = haversineMeters(WARSZAWA_CENTRALNA.lat, WARSZAWA_CENTRALNA.lng, 52.23101, 21.01019);
  assert.ok(d < 1000, `Centralna↔Centrum ${d} m`);
});

test('service-area guard: any Warsaw point is in-area, other cities are out', () => {
  // Far Warsaw edges (Kabaty, Bródno, NE outskirts) are still within the service radius.
  const warsaw = [[52.13208, 21.06507], [52.29359, 21.02894], [52.34, 21.10]];
  for (const [lat, lng] of warsaw) {
    assert.ok(nearestMetroStations(lat, lng, { limit: 1 })[0]!.crowMeters <= METRO_SERVICE_RADIUS_M, `Warsaw ${lat},${lng} in-area`);
  }
  // Kraków, Wrocław, Gdańsk are far outside → metro/Centralna would be suppressed.
  const otherCities = [[50.06465, 19.94498], [51.10, 17.03], [54.35, 18.65]];
  for (const [lat, lng] of otherCities) {
    assert.ok(nearestMetroStations(lat, lng, { limit: 1 })[0]!.crowMeters > METRO_SERVICE_RADIUS_M, `${lat},${lng} out-of-area`);
  }
});
