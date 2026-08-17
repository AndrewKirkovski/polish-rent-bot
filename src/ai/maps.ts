// Google Maps integration — amenity proximity, commute scoring, geocoding
// Uses Places API (New) for nearby search, Distance Matrix API, Directions API, Geocoding API
// Smart amenity intelligence: transport-mode-aware, frequency-aware for transit stops

import { createHash } from 'node:crypto';
import { getMapsCacheEntry, setMapsCacheEntry } from '../storage/db.js';
import type { AmenityResult, NearbyPlace, CommuteResult, LocationScore, LocationPrecision, CentralStationEstimate } from '../types.js';
import {
  WARSZAWA_CENTRALNA,
  WALK_METERS_PER_MINUTE,
  METRO_SERVICE_RADIUS_M,
  nearestMetroStations,
  straightLineToCentralnaMeters,
  warsawMetroLinesForStation,
  haversineMeters,
} from '../geo/metro.js';
import type { NearbyMetro, WarsawMetroLine } from '../geo/metro.js';
import {
  bandFor,
  bandIsEmpty,
  crowMetersFromRoute,
  routeMetersFromCrow,
  optimisticMeters,
  widenPlace,
  type UncertaintyBand,
} from '../geo/uncertainty.js';

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
  /** Route metres from the returned point to the apartment; non-zero only for the metro annulus. */
  anchorDistanceMeters: number;
  /** ~1σ crow-flies uncertainty. Diagnostic only — never the basis of a hard verdict. */
  uncertaintyMeters: number;
  /** Containing outer bound of the region, in ROUTE metres. All range math derives from this. */
  outerRadiusMeters: number;
  source: string;
  evidence?: string | null;
}

/** The band of possible apartment-to-anchor route distances implied by an estimate. */
function bandForEstimate(estimate?: LocationEstimateContext | null): UncertaintyBand {
  if (!estimate) return { minMeters: 0, maxMeters: 0 };
  return bandFor(estimate.anchorDistanceMeters, estimate.outerRadiusMeters);
}

/** Whether an estimate localizes the flat loosely enough that point measurements need widening. */
export function estimateNeedsWidening(estimate?: LocationEstimateContext | null): boolean {
  return !!estimate && !bandIsEmpty(bandForEstimate(estimate));
}

const API_KEY = process.env.GOOGLE_MAPS_API_KEY ?? '';
const MAPS_BASE = 'https://maps.googleapis.com/maps/api';
const PLACES_NEW_BASE = 'https://places.googleapis.com/v1';
const CACHE_TTL_DAYS = 7;
const SEARCH_RADIUS = 5000; // 5km — OLX coordinates are often district-center, not exact address
const MAX_PLACES_PER_TYPE = 3;
/**
 * How many MEASURED places to keep per amenity type.
 *
 * Deliberately larger than MAX_PLACES_PER_TYPE (which stays the offline metro pool size). Once a
 * coarse location can hard-reject, dropping candidates before the uncertainty ranges are computed
 * becomes a false-rejection source: for an anchored ("N m from X") location the closest possible
 * amenity is the one nearest the ring, not the one nearest the anchor. Keeping the whole measured
 * set lets applyLocationUncertainty re-rank by the derived optimistic edge — and keeps this
 * function's output independent of any particular region, so the 7-day cache stays reusable.
 */
const KEPT_PLACES_PER_TYPE = 10;
const MAX_LINE_PLACES = 20;

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

/**
 * Whether an AmenityResult is the measurement of THIS preference. Identity is the type plus every
 * constraint that changes what gets measured — line AND station whitelist. Keying on line alone
 * let two metro prefs that differ only by whitelist resolve to each other, so a strict "7 min to
 * one of these 5 stations" pref could be judged against a loose "any metro" measurement.
 */
export function matchesAmenityRequest(pref: AmenityPreference, result: { type: string; requestedLine?: 'M1' | 'M2'; requestedStations?: string[] }): boolean {
  if (pref.type !== result.type) return false;
  if (pref.type !== 'metro') return true;
  if (pref.line !== result.requestedLine) return false;
  const a = pref.stations ?? [];
  const b = result.requestedStations ?? [];
  return a.length === b.length && a.every((name, i) => name === b[i]);
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
interface GeocodeLatLng { lat: number; lng: number }
interface GeocodeViewport { northeast: GeocodeLatLng; southwest: GeocodeLatLng }
interface GeocodeResult {
  geometry: {
    location: GeocodeLatLng;
    location_type?: string;
    /** Tight box around the result (present for area-grade results). More honest than a
     *  guessed radius: a district's real extent instead of a flat 2.5 km assumption. */
    bounds?: GeocodeViewport;
    /** Recommended display box. Always present; wider than `bounds` for small results. */
    viewport?: GeocodeViewport;
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
  /** Half the diagonal of the geocoder's `bounds` box, in CROW metres — a measured radius that
   *  covers the whole matched area. Undefined when the geocoder returned no bounds (or for a
   *  cache entry written before this field existed). */
  areaRadiusMeters?: number;
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
// Geocoding — fallback when listing has no coordinates
// ---------------------------------------------------------------------------

/**
 * Crow radius around `origin` that covers the whole box: the largest distance from `origin` to any
 * corner. NOT half the diagonal — that is the radius about the box's CENTRE, and a geocoder's
 * `location` is a label point that can sit well off centre for an irregular area, so half-diagonal
 * would leave the far corner outside the region and overstate the optimistic edge.
 */
function boxRadiusMeters(box: GeocodeViewport, origin: GeocodeLatLng): number {
  const corners: GeocodeLatLng[] = [
    box.northeast,
    box.southwest,
    { lat: box.northeast.lat, lng: box.southwest.lng },
    { lat: box.southwest.lat, lng: box.northeast.lng },
  ];
  return Math.round(Math.max(...corners.map((c) => haversineMeters(origin.lat, origin.lng, c.lat, c.lng))));
}

export async function geocodeAddress(address: string): Promise<GeocodedLocation | null> {
  // Cache generation bumped to 3 when areaRadiusMeters was added: a gen-2 entry has no bounds
  // data, and silently treating that as "no extent" would fall back to the guessed radius for
  // a week. Bumping re-geocodes once instead.
  const cacheKey = `geocode3:${hashStr(address)}`;
  const cached = getMapsCacheEntry(cacheKey);
  if (isCacheValid(cached)) return unwrapCache<GeocodedLocation>(cached!);

  // components=country:PL keeps a loose street name from matching a same-named place abroad;
  // a cross-country match would otherwise land >25 km from any Warsaw station and silently
  // disarm both the metro and the center gate (see METRO_SERVICE_RADIUS_M suppression).
  const url = `${MAPS_BASE}/geocode/json?address=${encodeURIComponent(address)}&components=country:PL&key=${API_KEY}&language=pl`;
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
  // Prefer `bounds` (the tight box around the matched feature) over `viewport` (a display box
  // padded to a minimum size even for a single building) so a street address doesn't inherit a
  // few-hundred-metre radius it doesn't have.
  const box = first.geometry.bounds ?? null;
  const result: GeocodedLocation = {
    lat: loc.lat,
    lng: loc.lng,
    locationType: first.geometry.location_type ?? null,
    partialMatch: first.partial_match === true,
    resultTypes: first.types ?? [],
    formattedAddress: first.formatted_address ?? null,
    ...(box ? { areaRadiusMeters: boxRadiusMeters(box, loc) } : {}),
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

/** Uncertainty radius for display: "±650 м" / "±1,8 км". Shared by the card warning and the
 *  rejection reasons so both quote the same number. */
export function formatRuRadius(meters: number): string {
  return meters >= 1000
    ? `${(meters / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км`
    : `${Math.round(meters)} м`;
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

/** Metro AmenityResult computed offline: nearest station on the requested whitelist, else line, else any.
 *  `band` (when the location is uncertain) changes WHICH stations are kept: the closest station by
 *  optimistic edge is not the closest by raw distance once the region is an annulus, so the pool is
 *  ranked by the edge before truncation. The table is small (38 stations) — ranking the whole pool
 *  costs nothing and removes the truncation blind spot entirely. */
function offlineMetroAmenity(
  lat: number,
  lng: number,
  pref: AmenityPreference,
  band: UncertaintyBand,
): AmenityResult {
  // Rank over the FULL pool, then truncate — see the note above.
  const pool = nearestMetroStations(lat, lng, { line: pref.line, stations: pref.stations, limit: Infinity });
  // A whitelist that resolved to ZERO known stations (every name mistyped / not in the verified
  // table) must not turn every candidate into a false "метро рядом не найдено" reject. Fall back to
  // the requested line (else all stations) so the card still shows a real station — but flag the
  // substitution: the gate must never HARD-REJECT against a criterion the user didn't ask for.
  const whitelistUnresolved = pool.length === 0 && !!pref.stations && pref.stations.length > 0;
  const near = whitelistUnresolved
    ? nearestMetroStations(lat, lng, { line: pref.line, limit: Infinity })
    : pool;
  if (whitelistUnresolved) {
    console.warn(`[maps] Metro whitelist resolved to no known stations (${pref.stations!.join(', ')}) — judging against ${pref.line ?? 'all lines'} and flagging the verdict as unknown`);
  }
  const ranked = [...near].sort((a, b) =>
    optimisticMeters(a.walkMeters, band) - optimisticMeters(b.walkMeters, band)
    || a.crowMeters - b.crowMeters);
  const places = ranked.slice(0, MAX_PLACES_PER_TYPE).map((n) => offlineMetroPlace(n, pref.line));
  const nearest = places[0] ?? null;
  // Out of the Warsaw metro service area — a listing in ANOTHER CITY that carries a metro pref: the
  // nearest Warsaw station is 100+ km away. Treat metro as UNKNOWN rather than a confident hard
  // reject naming a station ~250 km away; mirrors the inMetroArea suppression in scoreLocation.
  //
  // Measured against the UNRESTRICTED table, not the whitelist/line pool. Using the filtered pool
  // conflated "this listing isn't in Warsaw" with "this Warsaw listing is far from the one station
  // the user allows" — and the second case is exactly what the user wants rejected.
  const outOfArea = (nearestMetroStations(lat, lng, { limit: 1 })[0]?.crowMeters ?? Infinity) > METRO_SERVICE_RADIUS_M;
  const withinLimit = !outOfArea && nearest != null && nearest.walkingMinutes <= pref.maxMinutes;
  return {
    type: 'metro',
    requestedLine: pref.line,
    requestedStations: pref.stations,
    places,
    nearest,
    withinLimit,
    // Mutually exclusive with withinLimit — the amenity score treats them as separate buckets, so a
    // result in both would count more than once. (outOfArea already forces withinLimit false; a
    // substituted whitelist does not, and a substituted station CAN be within limit.)
    uncertain: (!withinLimit && (outOfArea || whitelistUnresolved)) || undefined,
    ...(whitelistUnresolved ? { criterionSubstituted: true } : {}),
  };
}

/** Expand one place's point distance into a ± range using the uncertainty band. Order-preserving:
 *  unlike applyLocationUncertainty (which re-sorts by the derived range for gate selection), this
 *  keeps the input's nearest-first-by-true-distance order for display. */
function expandPlaceRange(place: NearbyPlace, band: UncertaintyBand): NearbyPlace {
  if (place.walkingMinutes < 0) return place;
  const baseMeters = place.distanceMeters ?? place.walkingMinutes * WALK_METERS_PER_MINUTE;
  return {
    ...place,
    ...widenPlace(baseMeters, place.walkingMinutes, band),
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
  if (!estimateNeedsWidening(estimate)) return raw;
  const band = bandForEstimate(estimate);
  return raw.map((p) => expandPlaceRange(p, band));
}

/**
 * Public-transport estimate to Warszawa Centralna, pinned to a weekday 11:00 departure and
 * returned as a min-based range. Falls back to an offline straight-line distance (no time)
 * if the routing API fails — never a fabricated time.
 */
/** Fastest plausible public transport, door to door, including access and waiting: ~35 km/h.
 *  A lower bound on minutes per crow-flies kilometre — nothing in Warsaw beats this. */
const MIN_TRANSIT_MINUTES_PER_KM = 1.7;
/** A trip only contains so much walking, so displacing the origin can only save so much time.
 *  Without this cap the old `radius / walking-pace` model subtracted 33 min for a 2.5 km radius
 *  and the center gate could never fire. */
const MAX_WALK_SAVINGS_MINUTES = 12;
/** Above this outer radius (route metres) we stop modelling the optimistic edge and MEASURE it
 *  with a second route from the centre-facing edge of the region. */
const MEASURE_EDGE_ABOVE_METERS = 800;
/** A point inside the region may be better connected than the centre-facing edge point we measured
 *  — a metro station sitting in the region away from the centre beats a nearer bus-only spot — so
 *  the measured edge time is NOT itself a lower bound. Allowance grows with the region, because a
 *  bigger region holds more chances of a faster link, and is capped so it can't erase the gate. */
const EDGE_SLACK_BASE_MINUTES = 5;
const EDGE_SLACK_PER_KM_MINUTES = 2;
const EDGE_SLACK_CAP_MINUTES = 15;

/**
 * Optimistic minutes to the centre WITHOUT a second measurement: the centroid's measured time less
 * a bounded walking saving, floored by what transit can physically achieve over the straight-line
 * distance that remains. The floor is what stops the old unbounded `radius / walking-pace`
 * subtraction from driving `min` to 1 and disabling the gate.
 */
export function modelledOptimisticCenter(
  base: number,
  reach: number,
  edgeCrowMeters: number,
  baseIsAchievable: boolean,
): number {
  const saving = Math.min(MAX_WALK_SAVINGS_MINUTES, Math.ceil(reach / WALK_METERS_PER_MINUTE));
  const physicalFloor = Math.ceil((edgeCrowMeters / 1000) * MIN_TRANSIT_MINUTES_PER_KM);
  const modelled = Math.max(1, physicalFloor, base - saving);
  // When the measured point is itself a position the flat could occupy (any disc-shaped region),
  // `base` caps the regional optimum: the floor's 35 km/h assumption must not override a real
  // measurement wherever transit actually beats it — the long suburban-rail corridors do — or a
  // listing gets rejected for a journey the very same call measured as within the limit.
  //
  // For an ANNULUS the anchor is a station the flat is explicitly NOT at (the ring has a hole), so
  // `base` is not achievable and capping by it would understate the optimum instead.
  return baseIsAchievable ? Math.max(1, Math.min(base, modelled)) : modelled;
}

/**
 * Move `crowMeters` from (lat,lng) along the ray toward (toLat,toLng), PAST the destination if that
 * is how far we were asked to go.
 *
 * Overshoot is required, not a quirk: when the destination lies inside an annulus's hole, the ring
 * point closest to it sits on this same ray BEYOND it (for a circle of radius R about S and a point
 * P inside with |SP| = d, the nearest ring point is at R along S→P, i.e. R − d past P). Clamping at
 * the destination would silently return the destination itself, and routing it to itself yields ~0
 * minutes — which reads as "no limit is enforceable" for precisely the listings we mean to judge.
 */
export function pointToward(lat: number, lng: number, toLat: number, toLng: number, crowMeters: number): { lat: number; lng: number } {
  const total = haversineMeters(lat, lng, toLat, toLng);
  if (total <= 0) return { lat, lng };
  const f = crowMeters / total;
  return { lat: lat + (toLat - lat) * f, lng: lng + (toLng - lng) * f };
}

export async function centralStationEstimate(
  lat: number,
  lng: number,
  approximate = false,
  outerRadiusMeters = 0,
  anchorDistanceMeters = 0,
): Promise<CentralStationEstimate> {
  const departure = getNextMondayWarsawTs(11);
  try {
    const c = await calculateCommute(lat, lng, WARSZAWA_CENTRALNA.address, 'transit', departure);
    const base = c.durationMinutes;
    if (!approximate) {
      return { distanceText: ruDistanceText(c.distance), durationMinRange: { min: base, max: Math.max(base + 1, Math.ceil(base * 1.25)) } };
    }

    // Where the apartment may be, relative to this point. Derived through the SAME band the amenity
    // ranges use, so a ring is treated as a ring: collapsing an annulus to a disc of radius
    // (anchor + outer) would claim a flat "4 km from Centrum" could be next to Centralna, when the
    // ring's inner radius puts it at least ~2.6 km away in every direction.
    const band = bandFor(anchorDistanceMeters, outerRadiusMeters);
    const routeToCentralna = routeMetersFromCrow(straightLineToCentralnaMeters(lat, lng));
    // Closest the flat could be to Centralna, and hence how far it still has to travel.
    const edgeCrowMeters = crowMetersFromRoute(optimisticMeters(routeToCentralna, band));
    // Region reaches Centralna → the flat could be next door to it, so no limit is enforceable.
    // Short-circuit rather than pay for a Centralna→Centralna route that only returns ZERO_RESULTS.
    const containsCentralna = edgeCrowMeters <= 0;
    // Displace along the ray to Centralna by the band-clamped distance, landing on the closest
    // position the flat could occupy. For a disc that is min(distance, radius) — the previous
    // behaviour; for a ring it lands ON the ring, whether Centralna is outside it or (via
    // pointToward's deliberate overshoot) inside its hole.
    const reach = outerRadiusMeters + anchorDistanceMeters;
    const displacementCrow = crowMetersFromRoute(
      Math.min(band.maxMeters, Math.max(band.minMeters, routeToCentralna)),
    );
    // Whether the measured point is itself a place the flat could be. False for an annulus, whose
    // inner radius excludes the anchor — so its measured time can't cap the regional optimum.
    const baseIsAchievable = band.minMeters <= 0;

    let min: number;
    if (reach > MEASURE_EDGE_ABOVE_METERS && !containsCentralna) {
      // MEASURE the optimistic edge: route again from the centre-facing edge of the region. A real
      // transit time for the most favourable position, instead of subtracting walking-pace minutes
      // from a transit time — which is what made this gate inoperative for coarse locations.
      const edge = pointToward(lat, lng, WARSZAWA_CENTRALNA.lat, WARSZAWA_CENTRALNA.lng, displacementCrow);
      const slack = Math.min(
        EDGE_SLACK_CAP_MINUTES,
        EDGE_SLACK_BASE_MINUTES + Math.ceil((displacementCrow / 1000) * EDGE_SLACK_PER_KM_MINUTES),
      );
      try {
        const ec = await calculateCommute(edge.lat, edge.lng, WARSZAWA_CENTRALNA.address, 'transit', departure);
        // A MEASURED route is stronger evidence than any model, so it is NOT floored by
        // MIN_TRANSIT_MINUTES_PER_KM: the floor describes this very point, and letting a constant
        // override a real measurement of it would reject listings with a genuinely fast link
        // (suburban rail beats the 35 km/h assumption on the long corridors).
        min = Math.max(1, ec.durationMinutes - slack);
      } catch (err) {
        // Edge routing failed while the centroid succeeded: fall back to the modelled saving rather
        // than pretending the centroid time is the regional optimum.
        console.warn('[maps] Centralna edge estimate failed, falling back to modelled savings:', err instanceof Error ? err.message : err);
        min = modelledOptimisticCenter(base, reach, edgeCrowMeters, baseIsAchievable);
      }
    } else if (containsCentralna) {
      min = 1;
    } else {
      min = modelledOptimisticCenter(base, reach, edgeCrowMeters, baseIsAchievable);
    }

    // Display-only upper bound. The walking-savings term is capped like the modelled min so a wide
    // region doesn't render an uninformative "~8–109 мин" on the card.
    const spread = Math.min(MAX_WALK_SAVINGS_MINUTES, Math.ceil(reach / WALK_METERS_PER_MINUTE));
    const max = Math.max(min + 1, Math.ceil(base * 1.25) + spread);
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
  estimate?: LocationEstimateContext,
): Promise<AmenityResult[]> {
  const results: AmenityResult[] = [];
  // The metro pool must be ranked by the optimistic edge, which depends on the region — so the
  // estimate has to reach this far down, not just the later widening pass.
  const band = bandForEstimate(estimate);

  for (const pref of amenityPrefs) {
    // Metro is deterministic and offline — nearest station(s) from the verified table.
    if (pref.type === 'metro') {
      results.push(offlineMetroAmenity(lat, lng, pref, band));
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
    // Generation 10: the kept-place set changed (distance-sorted before truncation, and more of it
    // retained), so gen-9 entries would serve a top-3 chosen by the old insertion-order slice.
    const cacheKey = `nearby10:${roundCoord(lat)}:${roundCoord(lng)}:${pref.type}:${requestedMetroLine ?? 'any'}`;
    const cached = getMapsCacheEntry(cacheKey);
    if (isCacheValid(cached)) {
      const r = unwrapCache<AmenityResult>(cached!);
      // The cache key omits maxMinutes; recompute withinLimit for THIS request's threshold
      // from the (threshold-independent) cached place minutes rather than trusting the
      // boolean that was written under whatever limit first populated the entry. Apply the
      // transit fallback from the persisted bestTransitMinutes so a non-nearest transit-close
      // grocery isn't lost on cache read (matches the fresh compute above).
      r.withinLimit = computeWithinLimit(r.nearest, tc, pref.maxMinutes)
        || (tc.transitFallback && r.bestTransitMinutes != null && r.bestTransitMinutes <= pref.maxMinutes);
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
    // Filter to places with valid location FIRST — keeps placesArr[i] aligned with elements[i].
    // Sort by straight-line distance BEFORE truncating: `allPlaces` is a Map in search-group
    // insertion order, so a bare slice kept only the first group — for groceries that meant ten
    // supermarkets up to 5 km away while a convenience store 80 m away was never measured.
    const placesArr = eligiblePlaces
      .filter(p => p.location != null)
      .sort((a, b) =>
        haversineMeters(lat, lng, a.location!.latitude, a.location!.longitude)
        - haversineMeters(lat, lng, b.location!.latitude, b.location!.longitude))
      .slice(0, requestedMetroLine ? MAX_LINE_PLACES : 10);
    const destinations = placesArr
      .map(p => `${p.location!.latitude},${p.location!.longitude}`)
      .join('|');

    let nearbyPlaces: NearbyPlace[] = [];
    // Track Distance-Matrix failures so a transient DM error isn't cached for 7 days as a
    // false "amenity not reachable" (which would poison the card, fit-score and strict gate).
    //
    // Only UNMEASURABLE places count as incompleteness. A place without coordinates might have been
    // the closer option, so it keeps an over-limit result UNKNOWN. The distance CAP does not: the
    // pool is now sorted by distance first, so everything dropped is strictly farther than what we
    // kept and cannot change a proximity verdict. Comparing against the pre-cap pool size made this
    // permanently true for every multi-group type (groceries searches 3 types × 10 results), which
    // silently turned every over-limit grocery/gym/pool verdict into a keep-with-flag.
    let hadDistanceError = eligiblePlaces.some((p) => p.location == null);

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
      nearbyPlaces = nearbyPlaces.slice(0, requestedMetroLine ? MAX_LINE_PLACES : KEPT_PLACES_PER_TYPE);
    }

    // B2. Transit distances (airport always, groceries as fallback)
    const needTransit = tc.transit && !tc.transitFallback; // airport: always
    // Fetch transit UNCONDITIONALLY for transitFallback types (groceries), not only when
    // walking > maxMinutes: the cache key omits maxMinutes and withinLimit is recomputed
    // per-threshold on cache hits (computeWithinLimit), which needs transitMinutes to always
    // be present — otherwise a later smaller-threshold read can't apply the transit fallback.
    const needTransitFallback = tc.transitFallback;
    // MIN transit minutes across ALL measured places (incl. those ranked past the kept top-3 by
    // walking). Stored on the result so the point-path gate matches applyLocationUncertainty AND the
    // cache-hit recompute can re-apply the transit fallback (nearest alone loses the signal).
    let bestTransitMinutes: number | null = null;

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
              // Track the best (min) transit time across EVERY measured place, even one that won't be
              // kept in the top-3 — the transit-fallback gate only needs the closest-by-transit grocery.
              if (tc.transitFallback) bestTransitMinutes = bestTransitMinutes == null ? transitMins : Math.min(bestTransitMinutes, transitMins);
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
                } else if (nearbyPlaces.length < KEPT_PLACES_PER_TYPE) {
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
    nearbyPlaces = nearbyPlaces.slice(0, requestedMetroLine ? MAX_LINE_PLACES : KEPT_PLACES_PER_TYPE);

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
    let withinLimit = computeWithinLimit(nearest, tc, pref.maxMinutes);
    // Transit fallback (groceries): a supermarket far on foot but a short transit ride within the
    // limit satisfies the gate even when it isn't the nearest-by-walking place — match
    // applyLocationUncertainty (which scans all places), so the point path isn't stricter.
    if (!withinLimit && tc.transitFallback && bestTransitMinutes != null) withinLimit = bestTransitMinutes <= pref.maxMinutes;

    const amenityResult: AmenityResult = {
      type: pref.type,
      requestedLine: requestedMetroLine,
      places: nearbyPlaces,
      nearest,
      withinLimit,
      // Persist the threshold-independent transit-fallback signal so a cache-hit recompute (below)
      // doesn't lose it (it can't be reconstructed from `nearest` alone).
      ...(tc.transitFallback ? { bestTransitMinutes } : {}),
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

/**
 * Expand point-based Google distances into honest ranges for a loosely localized flat.
 *
 * The `min` of each range is the OPTIMISTIC EDGE — the closest the flat could possibly be — and
 * the gates hard-reject when even that violates the user's limit. So this function decides
 * deletions: `min` must be a true lower bound (all the geometry lives in geo/uncertainty.ts,
 * in one unit), and `uncertain` must mean "the range straddles the limit", never "the evidence
 * was coarse". Coarseness is what the range already expresses.
 */
export function applyLocationUncertainty(
  amenities: AmenityResult[],
  amenityPrefs: AmenityPreference[],
  outerRadiusMeters: number,
  anchorDistanceMeters = 0,
): AmenityResult[] {
  const band = bandFor(anchorDistanceMeters, outerRadiusMeters);
  if (bandIsEmpty(band)) return amenities;

  return amenities.map((amenity) => {
    const places = amenity.places.map((place) => {
      if (place.walkingMinutes < 0) return place;
      const baseMeters = place.distanceMeters ?? place.walkingMinutes * WALK_METERS_PER_MINUTE;
      return { ...place, ...widenPlace(baseMeters, place.walkingMinutes, band), approximate: true };
    }).sort((a, b) => {
      const aRange = a.distanceMetersRange;
      const bRange = b.distanceMetersRange;
      if (aRange && bRange) {
        return aRange.min - bRange.min || aRange.max - bRange.max;
      }
      return a.walkingMinutes - b.walkingMinutes;
    });
    const pref = amenityPrefs.find((candidate) => matchesAmenityRequest(candidate, amenity));
    const ranges = places
      .map((place) => place.walkingMinutesRange)
      .filter((range): range is { min: number; max: number } => range != null);
    if (places.length === 0) {
      // This branch only runs for an APPROXIMATE/anchored location, where the true position could
      // sit closer to a place than the point search reached — so an empty result is UNKNOWN (0.5),
      // not a confirmed absence. (A confirmed exact-location empty scores 0 in the non-anchored path.)
      return { ...amenity, places, nearest: null, withinLimit: false, uncertain: true };
    }
    if (!pref) {
      return { ...amenity, places, nearest: places[0] ?? null };
    }
    if (ranges.length === 0) {
      // Transit/driving-only types (airport) carry no walking range, so there is nothing to widen
      // and the point measurement survives. That point sits at the anchor, not at the flat, so an
      // over-limit verdict here is not evidence about the flat — keep it UNKNOWN rather than let a
      // coarse anchor hard-reject on an un-widened number.
      const pointWithin = computeWithinLimit(places[0] ?? null, getTransportConfig(amenity.type), pref.maxMinutes);
      return {
        ...amenity,
        places,
        nearest: places[0] ?? null,
        withinLimit: pointWithin,
        uncertain: pointWithin ? undefined : true,
      };
    }
    // Transit fallback (groceries): a place reachable by transit within the limit is within-limit
    // regardless of the widened WALKING range — mirrors computeWithinLimit on the point-based path.
    // Without this, uncertainty expansion would falsely hard-reject a supermarket that is far on foot
    // but a short bus ride away (transit time doesn't grow with the walking-range widening).
    const tc = getTransportConfig(amenity.type);
    const transitPlace = tc.transitFallback
      ? places.find((place) => place.transitMinutes != null && place.transitMinutes <= pref.maxMinutes) ?? null
      : null;
    // Also honor bestTransitMinutes — the point path computes it across ALL measured places (incl. a
    // transit-close supermarket ranked past the kept top-3 by walking, which is absent from `places`).
    // Without it, the approximate path would be STRICTER than the exact/point path it mirrors.
    const transitWithinLimit = tc.transitFallback && amenity.bestTransitMinutes != null && amenity.bestTransitMinutes <= pref.maxMinutes;
    const withinLimit = ranges.some((range) => range.max <= pref.maxMinutes) || transitPlace != null || transitWithinLimit;
    // `uncertain` must be MUTUALLY EXCLUSIVE with `withinLimit` — the amenities score counts them as
    // separate buckets (within=1, uncertain=0.5), so an amenity in both double-counts (>1.0). Gate the
    // whole expression on !withinLimit.
    //
    // The ONLY reasons to withhold a verdict are: the measurement itself failed or was incomplete
    // (`error`), the criterion we measured isn't the one requested (`amenity.uncertain` from
    // offlineMetroAmenity — out-of-service-area or an unresolvable whitelist), or the range genuinely
    // straddles the limit. A merely COARSE anchor is not a reason: the range already carries the
    // coarseness, and its optimistic edge is a real lower bound. (A `MAX_DIRECTIONLESS_ANCHOR`
    // override used to force uncertainty here for large anchors, which kept flats whose closest
    // possible position was still far outside the limit.)
    //
    // One more genuine unknown: for an ANNULUS (`band.minMeters > 0`, i.e. localized only as "N m
    // from X"), a Google-searched pool was collected AROUND THE ANCHOR and capped by distance from
    // it, so the amenity nearest where the flat could actually be was never measured. Rejecting on
    // that pool would be rejecting on the wrong search centre. Metro is exempt: its pool is the
    // complete offline station table, already ranked by the optimistic edge.
    const poolCentredOnWrongPoint = band.minMeters > 0 && amenity.type !== 'metro';
    const uncertain = !withinLimit && (
      amenity.error === true
      || amenity.uncertain === true
      || poolCentredOnWrongPoint
      || ranges.some((range) => range.min <= pref.maxMinutes)
    );
    const representative = withinLimit
      ? (places
          .filter((place) => (place.walkingMinutesRange?.max ?? Infinity) <= pref.maxMinutes)
          .sort((a, b) => (a.walkingMinutesRange?.max ?? Infinity) - (b.walkingMinutesRange?.max ?? Infinity))[0]
          ?? transitPlace ?? places[0])
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
      // Mirror the full request identity (line AND whitelist) so matchesAmenityRequest can pair a
      // pref with its placeholder result — otherwise the gate reads it as "criterion not measured".
      requestedLine: pref.type === 'metro' ? pref.line : undefined,
      requestedStations: pref.type === 'metro' ? pref.stations : undefined,
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

  const pointAmenities = await findNearbyAmenities(lat, lng, amenityPrefs, estimate);
  const amenities = estimateNeedsWidening(estimate)
    ? applyLocationUncertainty(
        pointAmenities,
        amenityPrefs,
        estimate!.outerRadiusMeters,
        estimate!.anchorDistanceMeters,
      )
    : pointAmenities;

  const approximate = !!estimate && estimate.precision !== 'exact' && estimate.precision !== 'street';
  // The center-time widening must follow the SAME positional uncertainty the amenity gate + metro
  // card use (any non-empty region, INCLUDING street precision's ±50-200 m), not the coarser
  // `approximate` flag. Otherwise a street-precision flat gets lenient amenity gates but a firm,
  // un-widened center gate for the identical uncertainty — inconsistently hard-rejecting a
  // borderline flat whose true transit time to Centralna is within the limit. (The triangle warning
  // stays on `approximate` so a street flat isn't labelled "примерная локация".)
  const widenCenter = estimateNeedsWidening(estimate);

  // Always-present card content: 2 nearest stations + transit time to Warszawa Centralna — but
  // only inside the Warsaw metro service area. For a listing in another city (multi-city search),
  // the nearest "Warsaw" station would be 100+ km away, so suppress metro + Centralna entirely
  // (also spares a pointless Distance Matrix call).
  const nearestStation = nearestMetroStations(lat, lng, { limit: 1 })[0];
  const inMetroArea = nearestStation != null && nearestStation.crowMeters <= METRO_SERVICE_RADIUS_M;
  const metroNearest = inMetroArea ? metroNearestWithUncertainty(lat, lng, estimate) : [];
  const centralStation = inMetroArea
    ? await centralStationEstimate(lat, lng, widenCenter, estimate?.outerRadiusMeters ?? 0, estimate?.anchorDistanceMeters ?? 0)
    : null;

  let commute: CommuteResult | null = null;
  if (workAddress) {
    try {
      commute = await calculateCommute(lat, lng, workAddress, commuteMode);
    } catch (err) { console.error('[maps] Commute calculation failed:', err instanceof Error ? err.message : err); }
  }

  const total = amenityPrefs.length;
  const met = amenities.filter(a => a.withinLimit).length;
  // Exclude within-limit from the uncertain bucket so they can't double-count; clamp to 100.
  const uncertain = amenities.filter(a => a.uncertain && !a.withinLimit).length;
  const overallScore = total === 0 ? 100 : Math.min(100, Math.round(((met + uncertain * 0.5) / total) * 100));

  // Show the radius the GATES enforce against (the containing outer bound), not the tighter ~1σ —
  // otherwise the card advertises a precision the reject reasons don't use.
  const shownRadius = estimate?.outerRadiusMeters ?? 0;
  const uncertaintyText = formatRuRadius(shownRadius);
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
    locationOuterRadiusMeters: estimate?.outerRadiusMeters,
  };
}
