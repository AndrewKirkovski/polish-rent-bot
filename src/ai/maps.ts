// Google Maps integration — amenity proximity, commute scoring, geocoding
// Uses Places API (New) for nearby search, Distance Matrix API, Geocoding API

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

// Amenity type → New Places API search config
// The new API uses `includedTypes` (Table A types) instead of keyword search.
// Each entry is a list of type arrays — we run one search per entry and merge results.
const AMENITY_SEARCHES: Record<string, string[][]> = {
  metro:       [['subway_station'], ['transit_station']],
  tram:        [['tram_stop'], ['transit_station']],
  gym:         [['gym'], ['fitness_center']],
  pool:        [['swimming_pool'], ['sports_complex']],
  supermarket: [['supermarket']],
  park:        [['park']],
  pharmacy:    [['pharmacy']],
};

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
  const data = (await res.json()) as T;
  // New Places API returns HTTP 200 even for some errors — caller must check .error
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
// Google API response types
// ---------------------------------------------------------------------------

// New Places API (searchNearby)
interface NewPlaceResult {
  id: string;
  displayName?: { text: string; languageCode: string };
  location?: { latitude: number; longitude: number };
}
interface NewNearbySearchResponse {
  places?: NewPlaceResult[];
  error?: { code: number; message: string; status: string };
}

// Legacy APIs (Distance Matrix, Geocoding — still used, separate from Places)
interface DistanceMatrixElement {
  distance: { text: string; value: number };
  duration: { text: string; value: number };
  status: string;
}
interface DistanceMatrixResponse { rows: Array<{ elements: DistanceMatrixElement[] }>; status: string; error_message?: string }
interface GeocodeResult { geometry: { location: { lat: number; lng: number } } }
interface GeocodeResponse { results: GeocodeResult[]; status: string; error_message?: string }

// ---------------------------------------------------------------------------
// Startup: clear stale error-cached data
// ---------------------------------------------------------------------------

try {
  const cleared = clearEmptyMapsCache();
  if (cleared > 0) {
    console.log(`[maps] Cleared ${cleared} stale empty-result cache entries`);
  }
} catch {
  // DB might not be initialized yet — ignore
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

// Build a geocodable address from listing data
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
// findNearbyAmenities — uses New Places API (searchNearby POST endpoint)
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

    const cacheKey = `nearby4:${roundCoord(lat)}:${roundCoord(lng)}:${pref.type}`;
    const cached = getMapsCacheEntry(cacheKey);
    if (isCacheValid(cached)) {
      results.push(unwrapCache<AmenityResult>(cached!));
      continue;
    }

    // Run all searches for this amenity type via New Places API, collect unique places
    const allPlaces = new Map<string, NewPlaceResult>(); // keyed by place id
    let hadApiError = false;

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
              radius: SEARCH_RADIUS,
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

    // If ALL searches hit API errors (not just empty results), don't cache — let it retry
    if (allPlaces.size === 0 && hadApiError) {
      console.error(`[maps] All searches for ${pref.type} failed with API errors — not caching`);
      results.push({ type: pref.type, places: [], nearest: null, withinLimit: false });
      continue;
    }

    if (allPlaces.size === 0) {
      // Genuinely zero results (no errors) — cache the empty result
      const emptyResult: AmenityResult = { type: pref.type, places: [], nearest: null, withinLimit: false };
      setMapsCacheEntry(cacheKey, wrapCache(emptyResult));
      results.push(emptyResult);
      continue;
    }

    // Get walking distances to ALL found places (batched — Distance Matrix supports multiple destinations)
    const placesArr = Array.from(allPlaces.values()).slice(0, 10); // max 10 to limit API calls
    const destinations = placesArr
      .map(p => p.location ? `${p.location.latitude},${p.location.longitude}` : null)
      .filter((d): d is string => d !== null)
      .join('|');

    const distUrl = `${MAPS_BASE}/distancematrix/json?origins=${lat},${lng}&destinations=${destinations}&mode=walking&language=pl&key=${API_KEY}`;

    let nearbyPlaces: NearbyPlace[] = [];
    try {
      const distRes = await fetchJson<DistanceMatrixResponse>(distUrl);

      if (distRes.status !== 'OK') {
        console.error(`[maps] Distance Matrix for ${pref.type}: ${distRes.status} — ${distRes.error_message ?? 'no details'}`);
        // Don't cache if Distance Matrix itself fails — fallback to place names without distances
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
      console.error(`[maps] Distance matrix failed for ${pref.type}:`, err);
      // Fallback: use places without distance data
      for (const p of placesArr.slice(0, MAX_PLACES_PER_TYPE)) {
        nearbyPlaces.push({ name: p.displayName?.text ?? 'Unknown', walkingMinutes: -1, distance: 'unknown' });
      }
    }

    // Filter out invalid walking times (sentinel -1), sort by walking time, take top 3
    nearbyPlaces = nearbyPlaces.filter(p => p.walkingMinutes > 0);
    nearbyPlaces.sort((a, b) => a.walkingMinutes - b.walkingMinutes);
    nearbyPlaces = nearbyPlaces.slice(0, MAX_PLACES_PER_TYPE);

    const nearest = nearbyPlaces[0] ?? null;
    const amenityResult: AmenityResult = {
      type: pref.type,
      places: nearbyPlaces,
      nearest,
      withinLimit: nearest ? nearest.walkingMinutes <= pref.maxMinutes : false,
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
