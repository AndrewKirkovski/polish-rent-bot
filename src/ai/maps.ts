// Google Maps integration — amenity proximity, commute scoring, geocoding
// Uses Places API (New) for nearby search, Distance Matrix API, Directions API, Geocoding API
// Smart amenity intelligence: transport-mode-aware, frequency-aware for transit stops

import { createHash } from 'node:crypto';
import { getMapsCacheEntry, setMapsCacheEntry, clearEmptyMapsCache } from '../storage/db.js';
import type { AmenityResult, NearbyPlace, CommuteResult, LocationScore, LocationPrecision, CentralStationEstimate } from '../types.js';
import {
  WARSZAWA_CENTRALNA,
  WALK_METERS_PER_MINUTE,
  METRO_SERVICE_RADIUS_M,
  nearestMetroStations,
  straightLineToCentralnaMeters,
  warsawMetroLinesForStation,
} from '../geo/metro.js';
import type { NearbyMetro, WarsawMetroLine } from '../geo/metro.js';

export type { AmenityResult, CommuteResult, LocationScore } from '../types.js';
// Metro line membership is now table-driven (verified coordinates); re-export so existing
// importers (location.ts, tests) keep resolving it from maps.
export { warsawMetroLinesForStation };

export interface AmenityPreference {
  type: string;
  maxMinutes: number;
  /** Optional transit line constraint. Currently supported for Warsaw metro (M1/M2). */
  line?: 'M1' | 'M2';
  /** Optional explicit metro-station whitelist (real station names). When set, proximity is
   *  measured to the nearest station on this list instead of a whole line. Names are validated
   *  against the verified table; unknown names are dropped. */
  stations?: string[];
}

export interface LocationEstimateContext {
  precision: LocationPrecision;
  anchorDistanceMeters: number;
  uncertaintyMeters: number;
  source: string;
  evidence?: string | null;
}

const API_KEY = process.env.GOOGLE_MAPS_API_KEY ?? '';
const MAPS_BASE = 'https://maps.googleapis.com/maps/api';
const PLACES_NEW_BASE = 'https://places.googleapis.com/v1';
const CACHE_TTL_DAYS = 7;
const SEARCH_RADIUS = 5000; // 5km — OLX coordinates are often district-center, not exact address
const MAX_PLACES_PER_TYPE = 3;
const MAX_LINE_PLACES = 20;
const MAX_DIRECTIONLESS_ANCHOR_FOR_STRICT_METERS = 3000;

// Warsaw metro station data, coordinates, line membership, and nearest-station search live
// in ../geo/metro.ts (verified, offline). warsawMetroLinesForStation is imported + re-exported
// above; nearest-station lookups use nearestMetroStations.

// For frequency estimation: route from the stop to a point ~2.5km north.
// Using a local offset instead of a fixed city center ensures it works in any Polish city.
function localTransitDest(stopLat: number, stopLng: number): string {
  return `${(stopLat + 0.022).toFixed(5)},${stopLng.toFixed(5)}`;
}

// ---------------------------------------------------------------------------
// Amenity type → Google Places API types (strict, no cross-contamination)
// ---------------------------------------------------------------------------

const AMENITY_SEARCHES: Record<string, string[][]> = {
  // metro is NOT here — it is computed offline from the verified station table (geo/metro.ts),
  // not from Google Places, so it can never return an invented station.
  tram:        [['tram_stop']],                          // tram_stop works in Warsaw; light_rail_station returns 0
  bus:         [['bus_stop']],                            // bus_stop for local stops; bus_station is intercity terminals
  airport:     [['airport']],
  groceries:   [['supermarket'], ['grocery_store'], ['convenience_store']],
  gym:         [['gym'], ['fitness_center']],
  pool:        [['swimming_pool'], ['sports_complex']],
  supermarket: [['supermarket']],
  park:        [['park']],
  pharmacy:    [['pharmacy']],
  cafe:        [['cafe']],
  restaurant:  [['restaurant']],
};

// ---------------------------------------------------------------------------
// Transport mode config per amenity type
// ---------------------------------------------------------------------------

interface TransportConfig {
  walking: boolean;        // measure walking distance (default for most)
  transit: boolean;        // measure transit distance (airport, groceries fallback)
  driving: boolean;        // measure driving/taxi distance (airport)
  checkFrequency: boolean; // estimate transit frequency at the stop (metro/tram/bus)
  transitFallback: boolean; // only check transit if walking > maxMinutes (groceries)
}

const TRANSPORT_CONFIG: Record<string, TransportConfig> = {
  // metro is computed offline (geo/metro.ts), so it has no Google transport config here.
  tram:        { walking: true,  transit: false, driving: false, checkFrequency: true,  transitFallback: false },
  bus:         { walking: true,  transit: false, driving: false, checkFrequency: true,  transitFallback: false },
  airport:     { walking: false, transit: true,  driving: true,  checkFrequency: false, transitFallback: false },
  groceries:   { walking: true,  transit: true,  driving: false, checkFrequency: false, transitFallback: true  },
  gym:         { walking: true,  transit: false, driving: false, checkFrequency: false, transitFallback: false },
  pool:        { walking: true,  transit: false, driving: false, checkFrequency: false, transitFallback: false },
  supermarket: { walking: true,  transit: false, driving: false, checkFrequency: false, transitFallback: false },
  park:        { walking: true,  transit: false, driving: false, checkFrequency: false, transitFallback: false },
  pharmacy:    { walking: true,  transit: false, driving: false, checkFrequency: false, transitFallback: false },
  cafe:        { walking: true,  transit: false, driving: false, checkFrequency: false, transitFallback: false },
  restaurant:  { walking: true,  transit: false, driving: false, checkFrequency: false, transitFallback: false },
};

function getTransportConfig(type: string): TransportConfig {
  return TRANSPORT_CONFIG[type] ?? { walking: true, transit: false, driving: false, checkFrequency: false, transitFallback: false };
}

/** Whether the nearest place is within `maxMinutes` by the type-appropriate metric.
 *  The per-place minutes are threshold-independent, so this is recomputed on every read
 *  (incl. cache hits) — the maps cache key omits maxMinutes, so the stored boolean can't
 *  be trusted across requests with different limits. */
export function computeWithinLimit(nearest: NearbyPlace | null, tc: TransportConfig, maxMinutes: number): boolean {
  if (!nearest) return false;
  let within = false;
  if (tc.walking && nearest.walkingMinutes >= 0) within = nearest.walkingMinutes <= maxMinutes;
  if (!tc.walking) {
    within = (nearest.transitMinutes != null && nearest.transitMinutes <= maxMinutes) ||
             (nearest.drivingMinutes != null && nearest.drivingMinutes <= maxMinutes);
  }
  if (tc.transitFallback && !within && nearest.transitMinutes != null) within = nearest.transitMinutes <= maxMinutes;
  return within;
}

/** Incomplete external evidence can confirm a pass, but must never prove rejection. */
export function shouldTreatAmenityMeasurementAsUnknown(
  hadApiError: boolean,
  hadDistanceError: boolean,
  withinLimit: boolean,
): boolean {
  return (hadApiError || hadDistanceError) && !withinLimit;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundCoord(v: number): string { return v.toFixed(4); }
function hashStr(t: string): string { return createHash('sha256').update(t, 'utf-8').digest('hex').slice(0, 16); }

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Google Maps API ${res.status}: ${res.statusText}`);
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Google Maps API POST ${res.status}: ${res.statusText}`);
  const data = (await res.json()) as T;
  return data;
}

function isCacheValid(entry: string | null): boolean {
  if (!entry) return false;
  try {
    const { cachedAt } = JSON.parse(entry) as { cachedAt: string };
    return Date.now() - new Date(cachedAt).getTime() < CACHE_TTL_DAYS * 86400_000;
  } catch { return false; }
}
function wrapCache<T>(data: T): string { return JSON.stringify({ cachedAt: new Date().toISOString(), data }); }
function unwrapCache<T>(entry: string): T { return (JSON.parse(entry) as { data: T }).data; }

// ---------------------------------------------------------------------------
// Next Monday 10:00 Warsaw time — baseline for transit frequency queries
// ---------------------------------------------------------------------------

function getNextMondayWarsawTs(targetHour = 10): number {
  // Timezone-safe: uses Intl.DateTimeFormat for all Warsaw time checks.
  // Works correctly regardless of system timezone (UTC in Docker, Warsaw locally, etc.)
  // Pinning transit routing to a fixed weekday hour keeps ETAs stable and reproducible
  // (avoids "now"-optimism, weekend gaps, and rush-hour skew).
  const now = new Date();

  // Get current day-of-week and hour in Warsaw
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Warsaw',
    weekday: 'short', hour: 'numeric', hour12: false,
  }).formatToParts(now);
  const weekday = parts.find(p => p.type === 'weekday')!.value;
  const hour = parseInt(parts.find(p => p.type === 'hour')!.value);

  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayIdx = dayMap[weekday] ?? 0;

  let daysUntilMonday: number;
  if (dayIdx === 1 && hour < targetHour) daysUntilMonday = 0;
  else if (dayIdx === 0) daysUntilMonday = 1;
  else daysUntilMonday = (8 - dayIdx) % 7 || 7;

  // Get target Monday's date components in Warsaw timezone
  const targetApprox = new Date(now.getTime() + daysUntilMonday * 86400_000);
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric', month: '2-digit', day: '2-digit', hour12: false,
  }).formatToParts(targetApprox);
  const y = parseInt(dateParts.find(p => p.type === 'year')!.value);
  const m = parseInt(dateParts.find(p => p.type === 'month')!.value) - 1;
  const d = parseInt(dateParts.find(p => p.type === 'day')!.value);

  // Guess UTC (targetHour Warsaw ≈ targetHour-2 UTC in CEST); the checkHour correction
  // below fixes the ±1h CET/CEST offset automatically for any target hour.
  const guessUtcMs = Date.UTC(y, m, d, targetHour - 2, 0, 0);
  // Check what hour Warsaw shows for this guess and adjust
  const checkHour = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Warsaw', hour: 'numeric', hour12: false,
  }).format(new Date(guessUtcMs)));
  return Math.floor((guessUtcMs - (checkHour - targetHour) * 3_600_000) / 1000);
}

// ---------------------------------------------------------------------------
// Google API response types
// ---------------------------------------------------------------------------

interface NewPlaceResult {
  id: string;
  displayName?: { text: string; languageCode: string };
  location?: { latitude: number; longitude: number };
}
interface NewNearbySearchResponse {
  places?: NewPlaceResult[];
  error?: { code: number; message: string; status: string };
}

interface DistanceMatrixElement {
  distance: { text: string; value: number };
  duration: { text: string; value: number };
  status: string;
}
interface DistanceMatrixResponse { rows: Array<{ elements: DistanceMatrixElement[] }>; status: string; error_message?: string }
interface GeocodeResult {
  geometry: {
    location: { lat: number; lng: number };
    location_type?: string;
  };
  partial_match?: boolean;
  types?: string[];
  formatted_address?: string;
}
interface GeocodeResponse { results: GeocodeResult[]; status: string; error_message?: string }

export interface GeocodedLocation {
  lat: number;
  lng: number;
  locationType: string | null;
  partialMatch: boolean;
  resultTypes: string[];
  formattedAddress: string | null;
}

// Directions API types (for transit frequency)
interface DirectionsTransitDetails {
  line?: { short_name?: string; name?: string; vehicle?: { type?: string } };
  departure_time?: { text: string; value: number };
  arrival_time?: { text: string; value: number };
  headway_secs?: number;
  num_stops?: number;
}
interface DirectionsStep {
  travel_mode: string;
  transit_details?: DirectionsTransitDetails;
}
interface DirectionsLeg {
  steps: DirectionsStep[];
  departure_time?: { value: number };
}
interface DirectionsRoute {
  legs: DirectionsLeg[];
}
interface DirectionsResponse {
  status: string;
  routes?: DirectionsRoute[];
  error_message?: string;
}

// ---------------------------------------------------------------------------
// Startup: clear stale error-cached data. Called explicitly from main so that merely importing
// maps.ts (e.g. in a test or a tool) has no DB side effect.
// ---------------------------------------------------------------------------

export function initMapsCacheMaintenance(): void {
  try {
    const cleared = clearEmptyMapsCache();
    if (cleared > 0) {
      console.log(`[maps] Cleared ${cleared} stale error-cached entries`);
    }
  } catch (err) {
    console.warn('[maps] Startup cache cleanup failed (DB may not be ready):', err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Geocoding — fallback when listing has no coordinates
// ---------------------------------------------------------------------------

export async function geocodeAddress(address: string): Promise<GeocodedLocation | null> {
  const cacheKey = `geocode2:${hashStr(address)}`;
  const cached = getMapsCacheEntry(cacheKey);
  if (isCacheValid(cached)) return unwrapCache<GeocodedLocation>(cached!);

  const url = `${MAPS_BASE}/geocode/json?address=${encodeURIComponent(address)}&key=${API_KEY}&language=pl`;
  let res: GeocodeResponse;
  try {
    res = await fetchJson<GeocodeResponse>(url);
  } catch (err) {
    // Honor the Promise<...|null> contract for transport errors too, so a single failed fetch in
    // the fusion's gatherLocationCandidates degrades to "no candidate" instead of aborting enrichment.
    console.error(`[maps] Geocode fetch failed for "${address}":`, err instanceof Error ? err.message : err);
    return null;
  }

  if (res.status !== 'OK' || res.results.length === 0) {
    console.error(`[maps] Geocode failed for "${address}": ${res.status} — ${res.error_message ?? 'no details'}`);
    return null;
  }

  const first = res.results[0];
  const loc = first.geometry.location;
  const result: GeocodedLocation = {
    lat: loc.lat,
    lng: loc.lng,
    locationType: first.geometry.location_type ?? null,
    partialMatch: first.partial_match === true,
    resultTypes: first.types ?? [],
    formattedAddress: first.formatted_address ?? null,
  };
  setMapsCacheEntry(cacheKey, wrapCache(result));
  return result;
}

export function buildAddressFromListing(listing: {
  street?: string | null; district?: string | null; city: string;
}): string {
  const parts: string[] = [];
  if (listing.street) parts.push(listing.street);
  if (listing.district) parts.push(listing.district);
  parts.push(listing.city);
  parts.push('Polska');
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Transit frequency estimation — Directions API
// ---------------------------------------------------------------------------

interface FrequencyResult {
  frequencyMinutes: number | null;
  lineName: string | null;
}

async function estimateTransitFrequency(
  stopLat: number, stopLng: number, amenityType: string,
): Promise<FrequencyResult> {
  const cacheKey = `freq2:${roundCoord(stopLat)}:${roundCoord(stopLng)}:${amenityType}`;
  const cached = getMapsCacheEntry(cacheKey);
  if (isCacheValid(cached)) return unwrapCache<FrequencyResult>(cached!);

  const mondayTs = getNextMondayWarsawTs();
  const origin = `${stopLat},${stopLng}`;

  // Call 1: directions at Monday 10:00 — route to a local point ~2.5km away
  const dest = localTransitDest(stopLat, stopLng);
  const url1 = `${MAPS_BASE}/directions/json?origin=${origin}&destination=${dest}&mode=transit&departure_time=${mondayTs}&alternatives=true&key=${API_KEY}`;

  try {
    const dir1 = await fetchJson<DirectionsResponse>(url1);
    if (dir1.status !== 'OK' || !dir1.routes?.length) {
      console.error(`[maps] Directions for freq (${amenityType}): ${dir1.status}`);
      const empty: FrequencyResult = { frequencyMinutes: null, lineName: null };
      setMapsCacheEntry(cacheKey, wrapCache(empty));
      return empty;
    }

    // Extract the first transit step from first route — find matching vehicle type
    const targetVehicle = amenityType === 'metro' ? 'SUBWAY' : amenityType === 'tram' ? 'TRAM' : 'BUS';
    let firstLineName: string | null = null;
    let firstDepartureTs: number | null = null;

    for (const route of dir1.routes) {
      for (const leg of route.legs) {
        for (const step of leg.steps) {
          if (step.transit_details) {
            const td = step.transit_details;
            const vType = td.line?.vehicle?.type ?? '';

            // Check for headway_secs first (Google sometimes provides it)
            if (td.headway_secs && (vType === targetVehicle || !firstLineName)) {
              const result: FrequencyResult = {
                frequencyMinutes: Math.round(td.headway_secs / 60),
                lineName: td.line?.short_name ?? td.line?.name ?? null,
              };
              setMapsCacheEntry(cacheKey, wrapCache(result));
              return result;
            }

            // Collect first departure for the target vehicle type
            if (vType === targetVehicle && !firstLineName && td.departure_time) {
              firstLineName = td.line?.short_name ?? td.line?.name ?? null;
              firstDepartureTs = td.departure_time.value;
            }
          }
        }
      }
    }

    if (!firstDepartureTs || !firstLineName) {
      // No matching transit found — try any transit line
      for (const route of dir1.routes) {
        for (const leg of route.legs) {
          for (const step of leg.steps) {
            if (step.transit_details?.departure_time && !firstLineName) {
              firstLineName = step.transit_details.line?.short_name ?? step.transit_details.line?.name ?? null;
              firstDepartureTs = step.transit_details.departure_time.value;
            }
          }
        }
      }
    }

    if (!firstDepartureTs) {
      const empty: FrequencyResult = { frequencyMinutes: null, lineName: firstLineName };
      setMapsCacheEntry(cacheKey, wrapCache(empty));
      return empty;
    }

    // Call 2: directions 15 minutes later to estimate frequency
    const url2 = `${MAPS_BASE}/directions/json?origin=${origin}&destination=${dest}&mode=transit&departure_time=${mondayTs + 900}&alternatives=true&key=${API_KEY}`;

    const dir2 = await fetchJson<DirectionsResponse>(url2);
    if (dir2.status === 'OK' && dir2.routes?.length) {
      // Find the same line in second call
      for (const route of dir2.routes) {
        for (const leg of route.legs) {
          for (const step of leg.steps) {
            if (step.transit_details?.departure_time) {
              const td = step.transit_details;
              const lineName2 = td.line?.short_name ?? td.line?.name ?? null;
              if (lineName2 === firstLineName && td.departure_time) {
                const diffSec = td.departure_time.value - firstDepartureTs!;
                if (diffSec > 0 && diffSec < 3600) {
                  const result: FrequencyResult = {
                    frequencyMinutes: Math.round(diffSec / 60),
                    lineName: firstLineName,
                  };
                  setMapsCacheEntry(cacheKey, wrapCache(result));
                  return result;
                }
              }
            }
          }
        }
      }
    }

    // Could not determine frequency from two calls
    const result: FrequencyResult = { frequencyMinutes: null, lineName: firstLineName };
    setMapsCacheEntry(cacheKey, wrapCache(result));
    return result;
  } catch (err) {
    console.error(`[maps] Frequency estimation failed for ${amenityType}:`, err);
    // Cache the failure to prevent repeated API calls on consistently failing stops
    const empty: FrequencyResult = { frequencyMinutes: null, lineName: null };
    setMapsCacheEntry(cacheKey, wrapCache(empty));
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Offline metro (verified station table) — never invents a station
// ---------------------------------------------------------------------------

/** Russian distance label from metres: "450 м" / "1,2 км". */
function formatRuMeters(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} м`;
  return `${(m / 1000).toFixed(1).replace('.', ',')} км`;
}

/** Localize a Google distance string ("4,2 km" / "850 m") to Russian units. */
function ruDistanceText(text: string): string {
  return text.replace(/\bkm\b/i, 'км').replace(/\bm\b/i, 'м');
}

function offlineMetroPlace(n: NearbyMetro, requestedLine?: WarsawMetroLine): NearbyPlace {
  return {
    name: n.station.name,
    lineName: requestedLine ?? n.station.lines.join('/'),
    walkingMinutes: n.walkMinutes,
    distance: formatRuMeters(n.walkMeters),
    distanceMeters: n.walkMeters,
  };
}

/** Metro AmenityResult computed offline: nearest station on the requested whitelist, else line, else any. */
function offlineMetroAmenity(lat: number, lng: number, pref: AmenityPreference): AmenityResult {
  let near = nearestMetroStations(lat, lng, { line: pref.line, stations: pref.stations, limit: MAX_PLACES_PER_TYPE });
  // A whitelist that resolved to ZERO known stations (every name mistyped / not in the verified
  // table) must not turn every candidate into a false "метро рядом не найдено" reject. Fall back to
  // the requested line (else all stations) so the gate still judges against a real nearest station.
  if (near.length === 0 && pref.stations && pref.stations.length > 0) {
    near = nearestMetroStations(lat, lng, { line: pref.line, limit: MAX_PLACES_PER_TYPE });
  }
  const places = near.map((n) => offlineMetroPlace(n, pref.line));
  const nearest = places[0] ?? null;
  const withinLimit = nearest != null && nearest.walkingMinutes <= pref.maxMinutes;
  return { type: 'metro', requestedLine: pref.line, places, nearest, withinLimit };
}

/** Expand one place's point distance into a ± range using the anchor uncertainty. Order-preserving:
 *  unlike applyLocationUncertainty (which re-sorts by the derived range for gate selection), this
 *  keeps the input's nearest-first-by-true-distance order for display. */
function expandPlaceRange(place: NearbyPlace, radiusMin: number, radiusMax: number): NearbyPlace {
  if (place.walkingMinutes < 0) return place;
  const baseMeters = place.distanceMeters ?? place.walkingMinutes * 75;
  const minMeters = baseMeters < radiusMin
    ? radiusMin - baseMeters
    : baseMeters > radiusMax ? baseMeters - radiusMax : 0;
  const maxMeters = baseMeters + radiusMax;
  const metersPerMinute = place.walkingMinutes > 0 && baseMeters > 0 ? baseMeters / place.walkingMinutes : 75;
  return {
    ...place,
    walkingMinutesRange: { min: Math.max(0, Math.floor(minMeters / metersPerMinute)), max: Math.max(1, Math.ceil(maxMeters / metersPerMinute)) },
    distanceMetersRange: { min: minMeters, max: maxMeters },
    approximate: true,
  };
}

/** The 2 closest stations (any line) for the card, widened to ranges when location is approximate. */
export function metroNearestWithUncertainty(
  lat: number,
  lng: number,
  estimate?: LocationEstimateContext,
): NearbyPlace[] {
  // nearestMetroStations returns nearest-first by true distance — preserve that order for display.
  const raw = nearestMetroStations(lat, lng, { limit: 2 }).map((n) => offlineMetroPlace(n));
  if (!estimate || (estimate.uncertaintyMeters <= 0 && estimate.anchorDistanceMeters <= 0)) return raw;
  const radiusMin = Math.max(0, estimate.anchorDistanceMeters - estimate.uncertaintyMeters);
  const radiusMax = estimate.anchorDistanceMeters + estimate.uncertaintyMeters;
  return raw.map((p) => expandPlaceRange(p, radiusMin, radiusMax));
}

/**
 * Public-transport estimate to Warszawa Centralna, pinned to a weekday 11:00 departure and
 * returned as a min-based range. Falls back to an offline straight-line distance (no time)
 * if the routing API fails — never a fabricated time.
 */
export async function centralStationEstimate(
  lat: number,
  lng: number,
  approximate = false,
  uncertaintyMeters = 0,
  anchorDistanceMeters = 0,
): Promise<CentralStationEstimate> {
  try {
    const c = await calculateCommute(lat, lng, WARSZAWA_CENTRALNA.address, 'transit', getNextMondayWarsawTs(11));
    const base = c.durationMinutes;
    // For an uncertain location the true door-to-door time straddles `base`: widen the range BOTH
    // ways so the min is genuinely optimistic. checkCenterGate rejects only when even the optimistic
    // min exceeds the limit, so a symmetric range keeps borderline approximate flats (with a ⚠️).
    // Fold in anchorDistanceMeters too: on the metro-annulus path (localized only as "N m from
    // Metro X") base is measured from the STATION, and the flat sits `anchorDistanceMeters` away —
    // so the optimistic min must account for that offset as well, matching the metro/amenity ranges.
    const extra = approximate ? Math.ceil((anchorDistanceMeters + uncertaintyMeters) / WALK_METERS_PER_MINUTE) : 0;
    const min = Math.max(1, base - extra);
    const max = Math.max(min + 1, Math.ceil(base * 1.25) + extra);
    return { distanceText: ruDistanceText(c.distance), durationMinRange: { min, max } };
  } catch (err) {
    console.error('[maps] Centralna estimate failed:', err instanceof Error ? err.message : err);
    return {
      distanceText: `~${formatRuMeters(straightLineToCentralnaMeters(lat, lng))}`,
      durationMinRange: null,
    };
  }
}

// ---------------------------------------------------------------------------
// findNearbyAmenities — smart, transport-mode-aware
// ---------------------------------------------------------------------------

export async function findNearbyAmenities(
  lat: number,
  lng: number,
  amenityPrefs: AmenityPreference[],
): Promise<AmenityResult[]> {
  const results: AmenityResult[] = [];

  for (const pref of amenityPrefs) {
    // Metro is deterministic and offline — nearest station(s) from the verified table.
    if (pref.type === 'metro') {
      results.push(offlineMetroAmenity(lat, lng, pref));
      continue;
    }

    const searches = AMENITY_SEARCHES[pref.type];
    if (!searches) {
      console.warn(`[maps] Unknown amenity type "${pref.type}", skipping`);
      results.push({ type: pref.type, requestedLine: pref.line, places: [], nearest: null, withinLimit: false });
      continue;
    }

    const tc = getTransportConfig(pref.type);
    const requestedMetroLine = pref.type === 'metro' ? pref.line : undefined;
    const cacheKey = `nearby9:${roundCoord(lat)}:${roundCoord(lng)}:${pref.type}:${requestedMetroLine ?? 'any'}`;
    const cached = getMapsCacheEntry(cacheKey);
    if (isCacheValid(cached)) {
      const r = unwrapCache<AmenityResult>(cached!);
      // The cache key omits maxMinutes; recompute withinLimit for THIS request's threshold
      // from the (threshold-independent) cached place minutes rather than trusting the
      // boolean that was written under whatever limit first populated the entry.
      r.withinLimit = computeWithinLimit(r.nearest, tc, pref.maxMinutes);
      results.push(r);
      continue;
    }

    // ---- A. Find places via Places API ----
    const allPlaces = new Map<string, NewPlaceResult>();
    let hadApiError = false;

    // Airport needs larger search radius (Chopin is ~10km from center, Modlin ~40km)
    const searchRadius = pref.type === 'airport'
      ? 50_000
      : requestedMetroLine ? 50_000 : SEARCH_RADIUS;

    for (const types of searches) {
      try {
        const body = {
          includedTypes: types,
          maxResultCount: requestedMetroLine ? 20 : 10,
          rankPreference: 'DISTANCE',
          languageCode: 'pl',
          locationRestriction: {
            circle: {
              center: { latitude: lat, longitude: lng },
              radius: searchRadius,
            },
          },
        };

        const nearbyRes = await postJson<NewNearbySearchResponse>(
          `${PLACES_NEW_BASE}/places:searchNearby`,
          body,
          {
            'X-Goog-Api-Key': API_KEY,
            'X-Goog-FieldMask': 'places.id,places.displayName,places.location',
          },
        );

        if (nearbyRes.error) {
          console.error(`[maps] Nearby search ${pref.type} (types: ${types.join(',')}): API error ${nearbyRes.error.code} — ${nearbyRes.error.message}`);
          hadApiError = true;
          continue;
        }

        if (nearbyRes.places) {
          for (const place of nearbyRes.places) {
            if (place.id && !allPlaces.has(place.id)) {
              allPlaces.set(place.id, place);
            }
          }
        }
      } catch (err) {
        console.error(`[maps] Nearby search failed for ${pref.type}/${types.join(',')}:`, err);
        hadApiError = true;
      }
    }

    if (allPlaces.size === 0 && hadApiError) {
      console.error(`[maps] All searches for ${pref.type} failed with API errors — not caching`);
      // error:true → the strict gate keeps-with-flag rather than falsely rejecting "not nearby".
      results.push({
        type: pref.type,
        requestedLine: requestedMetroLine,
        places: [],
        nearest: null,
        withinLimit: false,
        uncertain: true,
        error: true,
      });
      continue;
    }

    const eligiblePlaces = requestedMetroLine
      ? Array.from(allPlaces.values()).filter((place) =>
          warsawMetroLinesForStation(place.displayName?.text ?? '').includes(requestedMetroLine))
      : Array.from(allPlaces.values());

    if (eligiblePlaces.length === 0) {
      const emptyResult: AmenityResult = {
        type: pref.type,
        requestedLine: requestedMetroLine,
        places: [],
        nearest: null,
        withinLimit: false,
      };
      setMapsCacheEntry(cacheKey, wrapCache(emptyResult));
      results.push(emptyResult);
      continue;
    }

    // ---- B. Measure distances ----
    // Filter to places with valid location FIRST — keeps placesArr[i] aligned with elements[i]
    const placesArr = eligiblePlaces
      .filter(p => p.location != null)
      .slice(0, requestedMetroLine ? MAX_LINE_PLACES : 10);
    const destinations = placesArr
      .map(p => `${p.location!.latitude},${p.location!.longitude}`)
      .join('|');

    let nearbyPlaces: NearbyPlace[] = [];
    // Track Distance-Matrix failures so a transient DM error isn't cached for 7 days as a
    // false "amenity not reachable" (which would poison the card, fit-score and strict gate).
    // A place without coordinates cannot be measured and might be the closer option.
    // Preserve that incompleteness so an over-limit result remains UNKNOWN.
    let hadDistanceError = placesArr.length < eligiblePlaces.length;

    // B1. Walking distances (for most amenities)
    if (tc.walking && destinations) {
      const distUrl = `${MAPS_BASE}/distancematrix/json?origins=${lat},${lng}&destinations=${destinations}&mode=walking&language=pl&key=${API_KEY}`;
      try {
        const distRes = await fetchJson<DistanceMatrixResponse>(distUrl);
        if (distRes.status !== 'OK') {
          console.error(`[maps] Walking DM for ${pref.type}: ${distRes.status} — ${distRes.error_message ?? ''}`);
          hadDistanceError = true;
          for (const p of placesArr.slice(0, MAX_PLACES_PER_TYPE)) {
            nearbyPlaces.push({ name: p.displayName?.text ?? 'Unknown', walkingMinutes: -1, distance: 'unknown' });
          }
        } else {
          const elements = distRes.rows[0]?.elements ?? [];
          if (elements.length < placesArr.length) hadDistanceError = true;
          for (let i = 0; i < elements.length && i < placesArr.length; i++) {
            const el = elements[i];
            if (el.status === 'OK') {
              nearbyPlaces.push({
                name: placesArr[i].displayName?.text ?? 'Unknown',
                walkingMinutes: Math.round(el.duration.value / 60),
                distance: el.distance.text,
                distanceMeters: el.distance.value,
                ...(pref.type === 'metro'
                  ? { lineName: requestedMetroLine ?? (warsawMetroLinesForStation(placesArr[i].displayName?.text ?? '').join('/') || undefined) }
                  : {}),
              });
            } else {
              hadDistanceError = true;
              console.error(`[maps] Walking DM element for ${pref.type}/${placesArr[i].displayName?.text ?? 'Unknown'}: ${el.status}`);
            }
          }
        }
      } catch (err) {
        console.error(`[maps] Walking DM failed for ${pref.type}:`, err);
        hadDistanceError = true;
        for (const p of placesArr.slice(0, MAX_PLACES_PER_TYPE)) {
          nearbyPlaces.push({ name: p.displayName?.text ?? 'Unknown', walkingMinutes: -1, distance: 'unknown' });
        }
      }

      nearbyPlaces = nearbyPlaces.filter(p => p.walkingMinutes >= 0);
      nearbyPlaces.sort((a, b) => a.walkingMinutes - b.walkingMinutes);
      nearbyPlaces = nearbyPlaces.slice(0, requestedMetroLine ? MAX_LINE_PLACES : MAX_PLACES_PER_TYPE);
    }

    // B2. Transit distances (airport always, groceries as fallback)
    const needTransit = tc.transit && !tc.transitFallback; // airport: always
    // Fetch transit UNCONDITIONALLY for transitFallback types (groceries), not only when
    // walking > maxMinutes: the cache key omits maxMinutes and withinLimit is recomputed
    // per-threshold on cache hits (computeWithinLimit), which needs transitMinutes to always
    // be present — otherwise a later smaller-threshold read can't apply the transit fallback.
    const needTransitFallback = tc.transitFallback;

    if ((needTransit || needTransitFallback) && destinations) {
      const mondayTs = getNextMondayWarsawTs();
      const transitUrl = `${MAPS_BASE}/distancematrix/json?origins=${lat},${lng}&destinations=${destinations}&mode=transit&departure_time=${mondayTs}&language=pl&key=${API_KEY}`;
      try {
        const transitRes = await fetchJson<DistanceMatrixResponse>(transitUrl);
        if (transitRes.status !== 'OK') {
          console.error(`[maps] Transit DM for ${pref.type}: ${transitRes.status} — ${transitRes.error_message ?? ''}`);
          hadDistanceError = true; // mirror B1 — a non-OK status is a measurement failure
        }
        if (transitRes.status === 'OK') {
          const elements = transitRes.rows[0]?.elements ?? [];
          if (elements.length < placesArr.length) hadDistanceError = true;
          for (let i = 0; i < elements.length && i < placesArr.length; i++) {
            const el = elements[i];
            if (el.status === 'OK') {
              const transitMins = Math.round(el.duration.value / 60);
              // For airport: create places array from transit (walking not applicable → -1)
              if (!tc.walking) {
                nearbyPlaces.push({
                  name: placesArr[i].displayName?.text ?? 'Unknown',
                  walkingMinutes: -1,
                  distance: el.distance.text,
                  transitMinutes: transitMins,
                });
              } else {
                // For groceries fallback: annotate existing or add new
                const existing = nearbyPlaces.find(p => p.name === (placesArr[i].displayName?.text ?? 'Unknown'));
                if (existing) {
                  existing.transitMinutes = transitMins;
                } else if (nearbyPlaces.length < MAX_PLACES_PER_TYPE) {
                  nearbyPlaces.push({
                    name: placesArr[i].displayName?.text ?? 'Unknown',
                    walkingMinutes: -1,
                    distance: el.distance.text,
                    transitMinutes: transitMins,
                  });
                }
              }
            } else {
              hadDistanceError = true;
              console.error(`[maps] Transit DM element for ${pref.type}/${placesArr[i].displayName?.text ?? 'Unknown'}: ${el.status}`);
            }
          }
        }
      } catch (err) {
        console.error(`[maps] Transit DM failed for ${pref.type}:`, err);
        hadDistanceError = true;
      }
    }

    // B3. Driving distances (airport only)
    if (tc.driving && destinations) {
      const drivingUrl = `${MAPS_BASE}/distancematrix/json?origins=${lat},${lng}&destinations=${destinations}&mode=driving&language=pl&key=${API_KEY}`;
      try {
        const drivingRes = await fetchJson<DistanceMatrixResponse>(drivingUrl);
        if (drivingRes.status !== 'OK') {
          console.error(`[maps] Driving DM for ${pref.type}: ${drivingRes.status} — ${drivingRes.error_message ?? ''}`);
          hadDistanceError = true;
        }
        if (drivingRes.status === 'OK') {
          const elements = drivingRes.rows[0]?.elements ?? [];
          if (elements.length < placesArr.length) hadDistanceError = true;
          for (let i = 0; i < elements.length && i < placesArr.length; i++) {
            const el = elements[i];
            if (el.status === 'OK') {
              const drivingMins = Math.round(el.duration.value / 60);
              const existing = nearbyPlaces.find(p => p.name === (placesArr[i].displayName?.text ?? 'Unknown'));
              if (existing) {
                existing.drivingMinutes = drivingMins;
              }
            } else {
              hadDistanceError = true;
              console.error(`[maps] Driving DM element for ${pref.type}/${placesArr[i].displayName?.text ?? 'Unknown'}: ${el.status}`);
            }
          }
        }
      } catch (err) {
        console.error(`[maps] Driving DM failed for ${pref.type}:`, err);
        hadDistanceError = true;
      }
    }

    // Sort: airport by transit time, others by walking time
    if (!tc.walking) {
      nearbyPlaces.sort((a, b) => (a.transitMinutes ?? 999) - (b.transitMinutes ?? 999));
    }
    nearbyPlaces = nearbyPlaces.slice(0, requestedMetroLine ? MAX_LINE_PLACES : MAX_PLACES_PER_TYPE);

    // ---- C. Transit frequency for nearest stop (metro/tram/bus) ----
    if (tc.checkFrequency && nearbyPlaces.length > 0) {
      const nearest = nearbyPlaces[0];
      // Find the original place by matching name AND using its stored coordinates
      // placesArr is filtered to only include places with valid location (Fix #2)
      const nearestPlace = placesArr.find(p => (p.displayName?.text ?? 'Unknown') === nearest.name);
      const freqLat = nearestPlace?.location?.latitude;
      const freqLng = nearestPlace?.location?.longitude;
      if (freqLat != null && freqLng != null) {
        try {
          const freq = await estimateTransitFrequency(freqLat, freqLng, pref.type);
          if (freq.frequencyMinutes != null) nearest.frequencyMinutes = freq.frequencyMinutes;
          if (freq.lineName) nearest.lineName = freq.lineName;
          console.log(`[maps] Frequency for ${pref.type} at "${nearest.name}": ${freq.lineName ?? '?'} every ~${freq.frequencyMinutes ?? '?'} min`);
        } catch (err) {
          console.error(`[maps] Frequency estimation failed for ${pref.type}:`, err);
        }
      }
    }

    // ---- D. Compute withinLimit ----
    const nearest = nearbyPlaces[0] ?? null;
    const withinLimit = computeWithinLimit(nearest, tc, pref.maxMinutes);

    const amenityResult: AmenityResult = {
      type: pref.type,
      requestedLine: requestedMetroLine,
      places: nearbyPlaces,
      nearest,
      withinLimit,
    };

    // Missing candidates or route measurements can only hide a closer result.
    // A measured pass remains valid; an apparent failure is UNKNOWN and must be retried.
    if (shouldTreatAmenityMeasurementAsUnknown(hadApiError, hadDistanceError, withinLimit)) {
      console.error(`[maps] Incomplete evidence for ${pref.type} — returning uncached unknown (will retry next lookup)`);
      results.push({ ...amenityResult, uncertain: true, error: true });
      continue;
    }

    setMapsCacheEntry(cacheKey, wrapCache(amenityResult));
    results.push(amenityResult);
  }

  return results;
}

// ---------------------------------------------------------------------------
// calculateCommute
// ---------------------------------------------------------------------------

export async function calculateCommute(
  lat: number, lng: number, destAddress: string, mode = 'transit', departureTime?: number,
): Promise<CommuteResult> {
  // Fold the departure day into the cache key so a pinned weekday ETA stays stable within a day
  // but refreshes across days.
  const depKey = departureTime != null ? `:dep${Math.floor(departureTime / 86_400)}` : '';
  const cacheKey = `commute:${roundCoord(lat)}:${roundCoord(lng)}:${hashStr(destAddress)}:${mode}${depKey}`;
  const cached = getMapsCacheEntry(cacheKey);
  if (isCacheValid(cached)) return unwrapCache<CommuteResult>(cached!);

  const depParam = departureTime != null ? `&departure_time=${departureTime}` : '';
  const url = `${MAPS_BASE}/distancematrix/json?origins=${lat},${lng}&destinations=${encodeURIComponent(destAddress)}&mode=${mode}${depParam}&language=pl&key=${API_KEY}`;
  const res = await fetchJson<DistanceMatrixResponse>(url);

  if (res.status !== 'OK') {
    throw new Error(`Distance Matrix API error: ${res.status} — ${res.error_message ?? 'no details'}`);
  }

  const el = res.rows[0]?.elements[0];
  if (!el || el.status !== 'OK') throw new Error(`Distance Matrix failed: ${el?.status ?? res.status}`);

  const result: CommuteResult = {
    distance: el.distance.text,
    duration: el.duration.text,
    durationMinutes: Math.round(el.duration.value / 60),
    mode,
  };

  setMapsCacheEntry(cacheKey, wrapCache(result));
  return result;
}

// ---------------------------------------------------------------------------
// scoreLocation — orchestrates amenity search + commute, computes score
// ---------------------------------------------------------------------------

/** Expand point-based Google distances by the uncertainty of a description-derived anchor. */
export function applyLocationUncertainty(
  amenities: AmenityResult[],
  amenityPrefs: AmenityPreference[],
  uncertaintyMeters: number,
  anchorDistanceMeters = 0,
): AmenityResult[] {
  if (uncertaintyMeters <= 0 && anchorDistanceMeters <= 0) return amenities;
  const radiusMin = Math.max(0, anchorDistanceMeters - uncertaintyMeters);
  const radiusMax = anchorDistanceMeters + uncertaintyMeters;
  const anchorTooBroadForStrictVerdict = anchorDistanceMeters > MAX_DIRECTIONLESS_ANCHOR_FOR_STRICT_METERS;

  return amenities.map((amenity) => {
    const places = amenity.places.map((place) => {
      if (place.walkingMinutes < 0) return place;
      const baseMeters = place.distanceMeters ?? place.walkingMinutes * 75;
      const minMeters = baseMeters < radiusMin
        ? radiusMin - baseMeters
        : baseMeters > radiusMax ? baseMeters - radiusMax : 0;
      const maxMeters = baseMeters + radiusMax;
      const observedMetersPerMinute = place.walkingMinutes > 0 && baseMeters > 0
        ? baseMeters / place.walkingMinutes
        : 75;
      const walkingMinutesRange = {
        min: Math.max(0, Math.floor(minMeters / observedMetersPerMinute)),
        max: Math.max(1, Math.ceil(maxMeters / observedMetersPerMinute)),
      };
      const distanceMetersRange = { min: minMeters, max: maxMeters };
      return { ...place, walkingMinutesRange, distanceMetersRange, approximate: true };
    }).sort((a, b) => {
      const aRange = a.distanceMetersRange;
      const bRange = b.distanceMetersRange;
      if (aRange && bRange) {
        return aRange.min - bRange.min || aRange.max - bRange.max;
      }
      return a.walkingMinutes - b.walkingMinutes;
    });
    const pref = amenityPrefs.find((candidate) =>
      candidate.type === amenity.type &&
      (candidate.type !== 'metro' || candidate.line === amenity.requestedLine));
    const ranges = places
      .map((place) => place.walkingMinutesRange)
      .filter((range): range is { min: number; max: number } => range != null);
    if (places.length === 0) {
      // This branch only runs for an APPROXIMATE/anchored location, where the true position could
      // sit closer to a place than the point search reached — so an empty result is UNKNOWN (0.5),
      // not a confirmed absence. (A confirmed exact-location empty scores 0 in the non-anchored path.)
      return { ...amenity, places, nearest: null, withinLimit: false, uncertain: true };
    }
    if (!pref || ranges.length === 0) {
      return { ...amenity, places, nearest: places[0] ?? null };
    }
    const withinLimit = ranges.some((range) => range.max <= pref.maxMinutes);
    const uncertain = amenity.error === true
      || (!withinLimit && anchorTooBroadForStrictVerdict)
      || (!withinLimit && ranges.some((range) => range.min <= pref.maxMinutes));
    const representative = withinLimit
      ? places
          .filter((place) => (place.walkingMinutesRange?.max ?? Infinity) <= pref.maxMinutes)
          .sort((a, b) => (a.walkingMinutesRange?.max ?? Infinity) - (b.walkingMinutesRange?.max ?? Infinity))[0]
      : uncertain
        ? places
            .filter((place) => (place.walkingMinutesRange?.min ?? Infinity) <= pref.maxMinutes)
            .sort((a, b) =>
              (a.walkingMinutesRange?.min ?? Infinity) - (b.walkingMinutesRange?.min ?? Infinity) ||
              (a.walkingMinutesRange?.max ?? Infinity) - (b.walkingMinutesRange?.max ?? Infinity))[0]
          ?? places[0]
        : places[0];
    const orderedPlaces = representative
      ? [representative, ...places.filter((place) => place !== representative)]
      : places;
    return {
      ...amenity,
      places: orderedPlaces,
      nearest: representative ?? null,
      withinLimit,
      uncertain,
    };
  });
}

export function createUnknownLocationScore(
  amenityPrefs: AmenityPreference[],
  city: string,
  warning = 'точное местоположение не удалось определить',
  evidence?: string | null,
): LocationScore {
  return {
    amenities: amenityPrefs.map((pref) => ({
      type: pref.type,
      requestedLine: pref.type === 'metro' ? pref.line : undefined,
      places: [],
      nearest: null,
      withinLimit: false,
      uncertain: true,
    })),
    commute: null,
    metroNearest: [],
    centralStation: null,
    overallScore: 50,
    mapsLink: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(city)}`,
    precision: 'none',
    locationUnknown: true,
    locationWarning: warning,
    locationEvidence: evidence ?? undefined,
  };
}

export async function scoreLocation(
  lat: number,
  lng: number,
  amenityPrefs: AmenityPreference[],
  workAddress?: string,
  commuteMode = 'transit',
  estimate?: LocationEstimateContext,
): Promise<LocationScore> {
  console.log(`[maps] Scoring location ${lat},${lng} for ${amenityPrefs.length} amenities`);

  const pointAmenities = await findNearbyAmenities(lat, lng, amenityPrefs);
  const amenities = estimate && (estimate.uncertaintyMeters > 0 || estimate.anchorDistanceMeters > 0)
    ? applyLocationUncertainty(
        pointAmenities,
        amenityPrefs,
        estimate.uncertaintyMeters,
        estimate.anchorDistanceMeters,
      )
    : pointAmenities;

  const approximate = !!estimate && estimate.precision !== 'exact' && estimate.precision !== 'street';

  // Always-present card content: 2 nearest stations + transit time to Warszawa Centralna — but
  // only inside the Warsaw metro service area. For a listing in another city (multi-city search),
  // the nearest "Warsaw" station would be 100+ km away, so suppress metro + Centralna entirely
  // (also spares a pointless Distance Matrix call).
  const nearestStation = nearestMetroStations(lat, lng, { limit: 1 })[0];
  const inMetroArea = nearestStation != null && nearestStation.crowMeters <= METRO_SERVICE_RADIUS_M;
  const metroNearest = inMetroArea ? metroNearestWithUncertainty(lat, lng, estimate) : [];
  const centralStation = inMetroArea
    ? await centralStationEstimate(lat, lng, approximate, estimate?.uncertaintyMeters ?? 0, estimate?.anchorDistanceMeters ?? 0)
    : null;

  let commute: CommuteResult | null = null;
  if (workAddress) {
    try {
      commute = await calculateCommute(lat, lng, workAddress, commuteMode);
    } catch (err) { console.error('[maps] Commute calculation failed:', err instanceof Error ? err.message : err); }
  }

  const total = amenityPrefs.length;
  const met = amenities.filter(a => a.withinLimit).length;
  const uncertain = amenities.filter(a => a.uncertain).length;
  const overallScore = total === 0 ? 100 : Math.round(((met + uncertain * 0.5) / total) * 100);

  const uncertaintyText = estimate && estimate.uncertaintyMeters >= 1000
    ? `${(estimate.uncertaintyMeters / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км`
    : `${estimate?.uncertaintyMeters ?? 0} м`;
  const locationWarning = approximate
    ? `примерная локация: ${estimate!.source}, погрешность ±${uncertaintyText}`
    : undefined;

  return {
    amenities,
    commute,
    metroNearest,
    centralStation,
    overallScore,
    mapsLink: `https://www.google.com/maps?q=${lat},${lng}`,
    precision: estimate?.precision,
    locationWarning,
    locationEvidence: estimate?.evidence ?? undefined,
  };
}
