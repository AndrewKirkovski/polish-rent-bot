// Verified Warsaw Metro station table + offline geo helpers.
//
// Station names + coordinates are sourced from OpenStreetMap (station=subway within
// Warszawa), matched to the canonical operational M1/M2 line lists. Planned M3 stations
// and tram stops present in OSM are deliberately excluded. Metro identity here is
// AUTHORITATIVE and OFFLINE — the bot computes the nearest station from real coordinates
// and must never invent a station name, line, or distance.
//
// Currently 38 operational stations (M1: 21, M2: 18; Świętokrzyska is the single M1↔M2
// interchange). The 2026 western M2 extension (Lazurowa, Chrzanów, Karolin) is NOT yet
// included — add it here only with verified coordinates once the stations are operational.

export type WarsawMetroLine = 'M1' | 'M2';

export interface MetroStation {
  name: string;
  lines: WarsawMetroLine[];
  lat: number;
  lng: number;
}

/** Operational Warsaw metro stations. M1 listed south→north, then M2 stations west→east. */
export const WARSAW_METRO_STATIONS: readonly MetroStation[] = [
  { name: 'Kabaty', lines: ['M1'], lat: 52.13208, lng: 21.06507 },
  { name: 'Natolin', lines: ['M1'], lat: 52.14110, lng: 21.05644 },
  { name: 'Imielin', lines: ['M1'], lat: 52.14930, lng: 21.04611 },
  { name: 'Stokłosy', lines: ['M1'], lat: 52.15608, lng: 21.03472 },
  { name: 'Ursynów', lines: ['M1'], lat: 52.16205, lng: 21.02763 },
  { name: 'Służew', lines: ['M1'], lat: 52.17276, lng: 21.02629 },
  { name: 'Wilanowska', lines: ['M1'], lat: 52.18182, lng: 21.02315 },
  { name: 'Wierzbno', lines: ['M1'], lat: 52.18987, lng: 21.01680 },
  { name: 'Racławicka', lines: ['M1'], lat: 52.19886, lng: 21.01223 },
  { name: 'Pole Mokotowskie', lines: ['M1'], lat: 52.20878, lng: 21.00793 },
  { name: 'Politechnika', lines: ['M1'], lat: 52.21866, lng: 21.01530 },
  { name: 'Centrum', lines: ['M1'], lat: 52.23101, lng: 21.01019 },
  { name: 'Świętokrzyska', lines: ['M1', 'M2'], lat: 52.23510, lng: 21.00790 },
  { name: 'Ratusz Arsenał', lines: ['M1'], lat: 52.24522, lng: 21.00088 },
  { name: 'Dworzec Gdański', lines: ['M1'], lat: 52.25806, lng: 20.99419 },
  { name: 'Plac Wilsona', lines: ['M1'], lat: 52.26926, lng: 20.98450 },
  { name: 'Marymont', lines: ['M1'], lat: 52.27158, lng: 20.97194 },
  { name: 'Słodowiec', lines: ['M1'], lat: 52.27683, lng: 20.96013 },
  { name: 'Stare Bielany', lines: ['M1'], lat: 52.28183, lng: 20.94935 },
  { name: 'Wawrzyszew', lines: ['M1'], lat: 52.28635, lng: 20.93952 },
  { name: 'Młociny', lines: ['M1'], lat: 52.29077, lng: 20.92987 },
  { name: 'Bemowo', lines: ['M2'], lat: 52.23921, lng: 20.91550 },
  { name: 'Ulrychów', lines: ['M2'], lat: 52.24033, lng: 20.92987 },
  { name: 'Księcia Janusza', lines: ['M2'], lat: 52.23918, lng: 20.94438 },
  { name: 'Młynów', lines: ['M2'], lat: 52.23766, lng: 20.96010 },
  { name: 'Płocka', lines: ['M2'], lat: 52.23245, lng: 20.96638 },
  { name: 'Rondo Daszyńskiego', lines: ['M2'], lat: 52.23008, lng: 20.98289 },
  { name: 'Rondo ONZ', lines: ['M2'], lat: 52.23307, lng: 20.99810 },
  { name: 'Nowy Świat-Uniwersytet', lines: ['M2'], lat: 52.23682, lng: 21.01682 },
  { name: 'Centrum Nauki Kopernik', lines: ['M2'], lat: 52.23991, lng: 21.03179 },
  { name: 'Stadion Narodowy', lines: ['M2'], lat: 52.24683, lng: 21.04285 },
  { name: 'Dworzec Wileński', lines: ['M2'], lat: 52.25378, lng: 21.03580 },
  { name: 'Szwedzka', lines: ['M2'], lat: 52.26347, lng: 21.04552 },
  { name: 'Targówek Mieszkaniowy', lines: ['M2'], lat: 52.26925, lng: 21.05137 },
  { name: 'Trocka', lines: ['M2'], lat: 52.27510, lng: 21.05506 },
  { name: 'Zacisze', lines: ['M2'], lat: 52.28375, lng: 21.06215 },
  { name: 'Kondratowicza', lines: ['M2'], lat: 52.29208, lng: 21.04869 },
  { name: 'Bródno', lines: ['M2'], lat: 52.29359, lng: 21.02894 },
];

/** Warszawa Centralna — the central railway station (OSM railway=station, PKP PLK). */
export const WARSZAWA_CENTRALNA = {
  lat: 52.22882,
  lng: 21.00316,
  address: 'Warszawa Centralna, Warszawa, Polska',
} as const;

/**
 * Beyond this straight-line distance from the nearest station a coordinate is not in the
 * Warsaw metro service area (any Warsaw address is well within it). Used to suppress metro /
 * Centralna content for listings in other cities, where the nearest "Warsaw" station would be
 * 100+ km away and misleading.
 */
export const METRO_SERVICE_RADIUS_M = 25_000;

// Walk model: straight-line distance scaled by a street-detour factor, at ~4.7 km/h.
// Kept here so the card, the gate, and tests all share one honest estimate.
export const WALK_DETOUR_FACTOR = 1.3;
export const WALK_METERS_PER_MINUTE = 78;

export function walkMetersFromCrow(crowMeters: number): number {
  return Math.round(crowMeters * WALK_DETOUR_FACTOR);
}

export function walkMinutesFor(walkMeters: number): number {
  return Math.max(1, Math.round(walkMeters / WALK_METERS_PER_MINUTE));
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in metres between two WGS84 points. */
export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Normalize a station name for matching: strip diacritics, metro/M1/M2 affixes, punctuation. */
function normalizeStationName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/^(?:stacja\s+)?metr[oa]\s+/, '')
    .replace(/^m[12]\s+/, '')
    .replace(/\s+(?:metro|m[12])$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const STATION_BY_KEY = new Map<string, MetroStation>(
  WARSAW_METRO_STATIONS.map((s) => [normalizeStationName(s.name), s]),
);

/** Canonical Warsaw line membership for a station name (M1/M2), from the verified table. */
export function warsawMetroLinesForStation(name: string): WarsawMetroLine[] {
  const s = STATION_BY_KEY.get(normalizeStationName(name));
  return s ? [...s.lines] : [];
}

export interface NearbyMetro {
  station: MetroStation;
  crowMeters: number;
  walkMeters: number;
  walkMinutes: number;
}

/**
 * The nearest metro stations to a coordinate, sorted by straight-line distance.
 * Deterministic and offline — never invents a station. Pass `line` to restrict to M1/M2.
 */
export function nearestMetroStations(
  lat: number,
  lng: number,
  opts: { line?: WarsawMetroLine; limit?: number } = {},
): NearbyMetro[] {
  const limit = opts.limit ?? 2;
  const pool = opts.line
    ? WARSAW_METRO_STATIONS.filter((s) => s.lines.includes(opts.line!))
    : WARSAW_METRO_STATIONS;
  return pool
    .map((station) => {
      const crow = haversineMeters(lat, lng, station.lat, station.lng);
      const walkMeters = walkMetersFromCrow(crow);
      return { station, crowMeters: Math.round(crow), walkMeters, walkMinutes: walkMinutesFor(walkMeters) };
    })
    .sort((a, b) => a.crowMeters - b.crowMeters)
    .slice(0, limit);
}

/** Straight-line distance (metres) from a coordinate to Warszawa Centralna. */
export function straightLineToCentralnaMeters(lat: number, lng: number): number {
  return Math.round(haversineMeters(lat, lng, WARSZAWA_CENTRALNA.lat, WARSZAWA_CENTRALNA.lng));
}
