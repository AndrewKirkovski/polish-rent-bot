// Google Maps integration — amenity proximity, commute scoring, geocoding
// Uses Places API (New) for nearby search, Distance Matrix API, Directions API, Geocoding API
// Smart amenity intelligence: transport-mode-aware, frequency-aware for transit stops

import { createHash } from 'node:crypto';
import { getMapsCacheEntry, setMapsCacheEntry, clearEmptyMapsCache } from '../storage/db.js';
import type { AmenityResult, NearbyPlace, CommuteResult, LocationScore } from '../types.js';

export type { AmenityResult, CommuteResult, LocationScore } from '../types.js';

export interface AmenityPreference {
  type: string;
  maxMinutes: number;
}

const API_KEY = process.env.GOOGLE_MAPS_API_KEY ?? '';
const MAPS_BASE = 'https://maps.googleapis.com/maps/api';
const PLACES_NEW_BASE = 'https://places.googleapis.com/v1';
const CACHE_TTL_DAYS = 7;
const SEARCH_RADIUS = 5000; // 5km — OLX coordinates are often district-center, not exact address
const MAX_PLACES_PER_TYPE = 3;

// For frequency estimation: route from the stop to a point ~2.5km north.
// Using a local offset instead of a fixed city center ensures it works in any Polish city.
function localTransitDest(stopLat: number, stopLng: number): string {
  return `${(stopLat + 0.022).toFixed(5)},${stopLng.toFixed(5)}`;
}

// ---------------------------------------------------------------------------
// Amenity type → Google Places API types (strict, no cross-contamination)
// ---------------------------------------------------------------------------

const AMENITY_SEARCHES: Record<string, string[][]> = {
  metro:       [['subway_station']],
  tram:        [['tram_stop']],                          // tram_stop works in Warsaw; light_rail_station returns 0
  bus:         [['bus_stop']],                            // bus_stop for local stops; bus_station is intercity terminals
  airport:     [['airport']],
  groceries:   [['supermarket'], ['grocery_store'], ['convenience_store']],
  gym:         [['gym'], ['fitness_center']],
  pool:        [['swimming_pool'], ['sports_complex']],
  supermarket: [['supermarket']],
  park:        [['park']],
  pharmacy:    [['pharmacy']],
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
  metro:       { walking: true,  transit: false, driving: false, checkFrequency: true,  transitFallback: false },
  tram:        { walking: true,  transit: false, driving: false, checkFrequency: true,  transitFallback: false },
  bus:         { walking: true,  transit: false, driving: false, checkFrequency: true,  transitFallback: false },
  airport:     { walking: false, transit: true,  driving: true,  checkFrequency: false, transitFallback: false },
  groceries:   { walking: true,  transit: true,  driving: false, checkFrequency: false, transitFallback: true  },
  gym:         { walking: true,  transit: false, driving: false, checkFrequency: false, transitFallback: false },
  pool:        { walking: true,  transit: false, driving: false, checkFrequency: false, transitFallback: false },
  supermarket: { walking: true,  transit: false, driving: false, checkFrequency: false, transitFallback: false },
  park:        { walking: true,  transit: false, driving: false, checkFrequency: false, transitFallback: false },
  pharmacy:    { walking: true,  transit: false, driving: false, checkFrequency: false, transitFallback: false },
};

function getTransportConfig(type: string): TransportConfig {
  return TRANSPORT_CONFIG[type] ?? { walking: true, transit: false, driving: false, checkFrequency: false, transitFallback: false };
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

function getNextMondayWarsaw10am(): number {
  // Timezone-safe: uses Intl.DateTimeFormat for all Warsaw time checks.
  // Works correctly regardless of system timezone (UTC in Docker, Warsaw locally, etc.)
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
  if (dayIdx === 1 && hour < 10) daysUntilMonday = 0;
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

  // Guess UTC: 10:00 Warsaw is 08:00 UTC (CEST/UTC+2) or 09:00 UTC (CET/UTC+1)
  const guessUtcMs = Date.UTC(y, m, d, 8, 0, 0);
  // Check what hour Warsaw shows for this guess and adjust
  const checkHour = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Warsaw', hour: 'numeric', hour12: false,
  }).format(new Date(guessUtcMs)));
  return Math.floor((guessUtcMs - (checkHour - 10) * 3_600_000) / 1000);
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
interface GeocodeResult { geometry: { location: { lat: number; lng: number } } }
interface GeocodeResponse { results: GeocodeResult[]; status: string; error_message?: string }

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
// Startup: clear stale error-cached data
// ---------------------------------------------------------------------------

try {
  const cleared = clearEmptyMapsCache();
  if (cleared > 0) {
    console.log(`[maps] Cleared ${cleared} stale empty-result cache entries`);
  }
} catch (err) {
  console.warn('[maps] Startup cache cleanup failed (DB may not be ready):', err instanceof Error ? err.message : err);
}

// ---------------------------------------------------------------------------
// Geocoding — fallback when listing has no coordinates
// ---------------------------------------------------------------------------

export async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  const cacheKey = `geocode:${hashStr(address)}`;
  const cached = getMapsCacheEntry(cacheKey);
  if (isCacheValid(cached)) return unwrapCache<{ lat: number; lng: number }>(cached!);

  const url = `${MAPS_BASE}/geocode/json?address=${encodeURIComponent(address)}&key=${API_KEY}&language=pl`;
  const res = await fetchJson<GeocodeResponse>(url);

  if (res.status !== 'OK' || res.results.length === 0) {
    console.error(`[maps] Geocode failed for "${address}": ${res.status} — ${res.error_message ?? 'no details'}`);
    return null;
  }

  const loc = res.results[0].geometry.location;
  const result = { lat: loc.lat, lng: loc.lng };
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

  const mondayTs = getNextMondayWarsaw10am();
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
// findNearbyAmenities — smart, transport-mode-aware
// ---------------------------------------------------------------------------

export async function findNearbyAmenities(
  lat: number,
  lng: number,
  amenityPrefs: AmenityPreference[],
): Promise<AmenityResult[]> {
  const results: AmenityResult[] = [];

  for (const pref of amenityPrefs) {
    const searches = AMENITY_SEARCHES[pref.type];
    if (!searches) {
      console.warn(`[maps] Unknown amenity type "${pref.type}", skipping`);
      results.push({ type: pref.type, places: [], nearest: null, withinLimit: false });
      continue;
    }

    const tc = getTransportConfig(pref.type);
    const cacheKey = `nearby5:${roundCoord(lat)}:${roundCoord(lng)}:${pref.type}`;
    const cached = getMapsCacheEntry(cacheKey);
    if (isCacheValid(cached)) {
      results.push(unwrapCache<AmenityResult>(cached!));
      continue;
    }

    // ---- A. Find places via Places API ----
    const allPlaces = new Map<string, NewPlaceResult>();
    let hadApiError = false;

    // Airport needs larger search radius (Chopin is ~10km from center, Modlin ~40km)
    const searchRadius = pref.type === 'airport' ? 50_000 : SEARCH_RADIUS;

    for (const types of searches) {
      try {
        const body = {
          includedTypes: types,
          maxResultCount: 10,
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
      results.push({ type: pref.type, places: [], nearest: null, withinLimit: false });
      continue;
    }

    if (allPlaces.size === 0) {
      const emptyResult: AmenityResult = { type: pref.type, places: [], nearest: null, withinLimit: false };
      setMapsCacheEntry(cacheKey, wrapCache(emptyResult));
      results.push(emptyResult);
      continue;
    }

    // ---- B. Measure distances ----
    // Filter to places with valid location FIRST — keeps placesArr[i] aligned with elements[i]
    const placesArr = Array.from(allPlaces.values())
      .filter(p => p.location != null)
      .slice(0, 10);
    const destinations = placesArr
      .map(p => `${p.location!.latitude},${p.location!.longitude}`)
      .join('|');

    let nearbyPlaces: NearbyPlace[] = [];

    // B1. Walking distances (for most amenities)
    if (tc.walking && destinations) {
      const distUrl = `${MAPS_BASE}/distancematrix/json?origins=${lat},${lng}&destinations=${destinations}&mode=walking&language=pl&key=${API_KEY}`;
      try {
        const distRes = await fetchJson<DistanceMatrixResponse>(distUrl);
        if (distRes.status !== 'OK') {
          console.error(`[maps] Walking DM for ${pref.type}: ${distRes.status} — ${distRes.error_message ?? ''}`);
          for (const p of placesArr.slice(0, MAX_PLACES_PER_TYPE)) {
            nearbyPlaces.push({ name: p.displayName?.text ?? 'Unknown', walkingMinutes: -1, distance: 'unknown' });
          }
        } else {
          const elements = distRes.rows[0]?.elements ?? [];
          for (let i = 0; i < elements.length && i < placesArr.length; i++) {
            const el = elements[i];
            if (el.status === 'OK') {
              nearbyPlaces.push({
                name: placesArr[i].displayName?.text ?? 'Unknown',
                walkingMinutes: Math.round(el.duration.value / 60),
                distance: el.distance.text,
              });
            }
          }
        }
      } catch (err) {
        console.error(`[maps] Walking DM failed for ${pref.type}:`, err);
        for (const p of placesArr.slice(0, MAX_PLACES_PER_TYPE)) {
          nearbyPlaces.push({ name: p.displayName?.text ?? 'Unknown', walkingMinutes: -1, distance: 'unknown' });
        }
      }

      nearbyPlaces = nearbyPlaces.filter(p => p.walkingMinutes >= 0);
      nearbyPlaces.sort((a, b) => a.walkingMinutes - b.walkingMinutes);
      nearbyPlaces = nearbyPlaces.slice(0, MAX_PLACES_PER_TYPE);
    }

    // B2. Transit distances (airport always, groceries as fallback)
    const needTransit = tc.transit && !tc.transitFallback; // airport: always
    const needTransitFallback = tc.transitFallback &&
      (nearbyPlaces.length === 0 || nearbyPlaces[0].walkingMinutes > pref.maxMinutes);

    if ((needTransit || needTransitFallback) && destinations) {
      const mondayTs = getNextMondayWarsaw10am();
      const transitUrl = `${MAPS_BASE}/distancematrix/json?origins=${lat},${lng}&destinations=${destinations}&mode=transit&departure_time=${mondayTs}&language=pl&key=${API_KEY}`;
      try {
        const transitRes = await fetchJson<DistanceMatrixResponse>(transitUrl);
        if (transitRes.status === 'OK') {
          const elements = transitRes.rows[0]?.elements ?? [];
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
            }
          }
        }
      } catch (err) {
        console.error(`[maps] Transit DM failed for ${pref.type}:`, err);
      }
    }

    // B3. Driving distances (airport only)
    if (tc.driving && destinations) {
      const drivingUrl = `${MAPS_BASE}/distancematrix/json?origins=${lat},${lng}&destinations=${destinations}&mode=driving&language=pl&key=${API_KEY}`;
      try {
        const drivingRes = await fetchJson<DistanceMatrixResponse>(drivingUrl);
        if (drivingRes.status === 'OK') {
          const elements = drivingRes.rows[0]?.elements ?? [];
          for (let i = 0; i < elements.length && i < placesArr.length; i++) {
            const el = elements[i];
            if (el.status === 'OK') {
              const drivingMins = Math.round(el.duration.value / 60);
              const existing = nearbyPlaces.find(p => p.name === (placesArr[i].displayName?.text ?? 'Unknown'));
              if (existing) {
                existing.drivingMinutes = drivingMins;
              }
            }
          }
        }
      } catch (err) {
        console.error(`[maps] Driving DM failed for ${pref.type}:`, err);
      }
    }

    // Sort: airport by transit time, others by walking time
    if (!tc.walking) {
      nearbyPlaces.sort((a, b) => (a.transitMinutes ?? 999) - (b.transitMinutes ?? 999));
    }
    nearbyPlaces = nearbyPlaces.slice(0, MAX_PLACES_PER_TYPE);

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
    let withinLimit = false;
    if (nearest) {
      if (tc.walking && nearest.walkingMinutes >= 0) {
        withinLimit = nearest.walkingMinutes <= pref.maxMinutes;
      }
      // Airport: check transit or driving
      if (!tc.walking) {
        withinLimit = (nearest.transitMinutes != null && nearest.transitMinutes <= pref.maxMinutes) ||
                      (nearest.drivingMinutes != null && nearest.drivingMinutes <= pref.maxMinutes);
      }
      // Groceries fallback: transit counts too
      if (tc.transitFallback && !withinLimit && nearest.transitMinutes != null) {
        withinLimit = nearest.transitMinutes <= pref.maxMinutes;
      }
    }

    const amenityResult: AmenityResult = {
      type: pref.type,
      places: nearbyPlaces,
      nearest,
      withinLimit,
    };

    setMapsCacheEntry(cacheKey, wrapCache(amenityResult));
    results.push(amenityResult);
  }

  return results;
}

// ---------------------------------------------------------------------------
// calculateCommute
// ---------------------------------------------------------------------------

export async function calculateCommute(
  lat: number, lng: number, destAddress: string, mode = 'transit',
): Promise<CommuteResult> {
  const cacheKey = `commute:${roundCoord(lat)}:${roundCoord(lng)}:${hashStr(destAddress)}:${mode}`;
  const cached = getMapsCacheEntry(cacheKey);
  if (isCacheValid(cached)) return unwrapCache<CommuteResult>(cached!);

  const url = `${MAPS_BASE}/distancematrix/json?origins=${lat},${lng}&destinations=${encodeURIComponent(destAddress)}&mode=${mode}&language=pl&key=${API_KEY}`;
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

export async function scoreLocation(
  lat: number,
  lng: number,
  amenityPrefs: AmenityPreference[],
  workAddress?: string,
  commuteMode = 'transit',
): Promise<LocationScore> {
  console.log(`[maps] Scoring location ${lat},${lng} for ${amenityPrefs.length} amenities`);

  const amenities = await findNearbyAmenities(lat, lng, amenityPrefs);

  let commute: CommuteResult | null = null;
  if (workAddress) {
    try {
      commute = await calculateCommute(lat, lng, workAddress, commuteMode);
    } catch (err) { console.error('[maps] Commute calculation failed:', err instanceof Error ? err.message : err); }
  }

  const total = amenityPrefs.length;
  const met = amenities.filter(a => a.withinLimit).length;
  const overallScore = total === 0 ? 100 : Math.round((met / total) * 100);

  return {
    amenities,
    commute,
    overallScore,
    mapsLink: `https://www.google.com/maps/@${lat},${lng},15z`,
  };
}
