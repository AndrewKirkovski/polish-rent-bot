// Google Maps integration for amenity proximity and commute scoring
// Uses Places API (Nearby Search) and Distance Matrix API

import { createHash } from 'node:crypto';
import { getMapsCacheEntry, setMapsCacheEntry } from '../storage/db.js';
import type { AmenityResult, CommuteResult, LocationScore } from '../types.js';

// Re-export types for convenience
export type { AmenityResult, CommuteResult, LocationScore } from '../types.js';

// ---------------------------------------------------------------------------
// Types (maps-specific)
// ---------------------------------------------------------------------------

export interface AmenityPreference {
  type: string;
  maxMinutes: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_KEY = process.env.GOOGLE_MAPS_API_KEY ?? '';
const MAPS_BASE = 'https://maps.googleapis.com/maps/api';
const CACHE_TTL_DAYS = 7;

// Amenity type -> Google Places API type (or keyword search)
const AMENITY_TYPE_MAP: Record<string, { type?: string; keyword?: string }> = {
  metro: { type: 'subway_station' },
  gym: { type: 'gym' },
  pool: { keyword: 'basen', type: 'sports_complex' },
  supermarket: { type: 'supermarket' },
  park: { type: 'park' },
  pharmacy: { type: 'pharmacy' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundCoord(v: number): string {
  return v.toFixed(4);
}

function hashString(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 16);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Google Maps API error: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/** Check if cache entry is still valid (within TTL). */
function isCacheValid(entry: string | null): boolean {
  if (entry === null) return false;
  try {
    const parsed = JSON.parse(entry) as { cachedAt: string; data: unknown };
    if (!parsed.cachedAt) return false;
    const cachedAt = new Date(parsed.cachedAt).getTime();
    const ttlMs = CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
    return Date.now() - cachedAt < ttlMs;
  } catch {
    return false;
  }
}

function wrapCache<T>(data: T): string {
  return JSON.stringify({ cachedAt: new Date().toISOString(), data });
}

function unwrapCache<T>(entry: string): T {
  const parsed = JSON.parse(entry) as { data: T };
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Google Places Nearby Search response types
// ---------------------------------------------------------------------------

interface PlaceResult {
  name: string;
  geometry: {
    location: { lat: number; lng: number };
  };
  place_id: string;
}

interface NearbySearchResponse {
  results: PlaceResult[];
  status: string;
}

interface DistanceMatrixElement {
  distance: { text: string; value: number };
  duration: { text: string; value: number };
  status: string;
}

interface DistanceMatrixResponse {
  rows: Array<{
    elements: DistanceMatrixElement[];
  }>;
  status: string;
}

// ---------------------------------------------------------------------------
// findNearbyAmenities
// ---------------------------------------------------------------------------

export async function findNearbyAmenities(
  lat: number,
  lng: number,
  amenityTypes: AmenityPreference[],
): Promise<AmenityResult[]> {
  const results: AmenityResult[] = [];

  for (const pref of amenityTypes) {
    const mapping = AMENITY_TYPE_MAP[pref.type];
    if (!mapping) {
      results.push({
        type: pref.type,
        nearest: null,
        withinLimit: false,
      });
      continue;
    }

    const cacheKey = `nearby:${roundCoord(lat)}:${roundCoord(lng)}:${pref.type}`;
    const cached = getMapsCacheEntry(cacheKey);

    if (isCacheValid(cached)) {
      results.push(unwrapCache<AmenityResult>(cached!));
      continue;
    }

    // Build Nearby Search URL
    let url =
      `${MAPS_BASE}/place/nearbysearch/json` +
      `?location=${lat},${lng}` +
      `&radius=2000` +
      `&key=${API_KEY}`;

    if (mapping.type) {
      url += `&type=${mapping.type}`;
    }
    if (mapping.keyword) {
      url += `&keyword=${encodeURIComponent(mapping.keyword)}`;
    }

    const nearbyRes = await fetchJson<NearbySearchResponse>(url);

    if (
      nearbyRes.status !== 'OK' ||
      nearbyRes.results.length === 0
    ) {
      const amenityResult: AmenityResult = {
        type: pref.type,
        nearest: null,
        withinLimit: false,
      };
      setMapsCacheEntry(cacheKey, wrapCache(amenityResult));
      results.push(amenityResult);
      continue;
    }

    // Take the first (closest by API default) result and get walking distance
    const place = nearbyRes.results[0];
    const distUrl =
      `${MAPS_BASE}/distancematrix/json` +
      `?origins=${lat},${lng}` +
      `&destinations=${place.geometry.location.lat},${place.geometry.location.lng}` +
      `&mode=walking` +
      `&language=pl` +
      `&key=${API_KEY}`;

    const distRes = await fetchJson<DistanceMatrixResponse>(distUrl);
    const element = distRes.rows[0]?.elements[0];

    let amenityResult: AmenityResult;

    if (element && element.status === 'OK') {
      const walkingMinutes = Math.round(element.duration.value / 60);
      amenityResult = {
        type: pref.type,
        nearest: {
          name: place.name,
          walkingMinutes,
          distance: element.distance.text,
        },
        withinLimit: walkingMinutes <= pref.maxMinutes,
      };
    } else {
      amenityResult = {
        type: pref.type,
        nearest: {
          name: place.name,
          walkingMinutes: -1,
          distance: 'unknown',
        },
        withinLimit: false,
      };
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
  lat: number,
  lng: number,
  destAddress: string,
  mode: string = 'transit',
): Promise<CommuteResult> {
  const cacheKey = `commute:${roundCoord(lat)}:${roundCoord(lng)}:${hashString(destAddress)}:${mode}`;
  const cached = getMapsCacheEntry(cacheKey);

  if (isCacheValid(cached)) {
    return unwrapCache<CommuteResult>(cached!);
  }

  const url =
    `${MAPS_BASE}/distancematrix/json` +
    `?origins=${lat},${lng}` +
    `&destinations=${encodeURIComponent(destAddress)}` +
    `&mode=${mode}` +
    `&language=pl` +
    `&key=${API_KEY}`;

  const res = await fetchJson<DistanceMatrixResponse>(url);
  const element = res.rows[0]?.elements[0];

  if (!element || element.status !== 'OK') {
    throw new Error(
      `Distance Matrix failed: ${element?.status ?? res.status}`,
    );
  }

  const result: CommuteResult = {
    distance: element.distance.text,
    duration: element.duration.text,
    durationMinutes: Math.round(element.duration.value / 60),
    mode,
  };

  setMapsCacheEntry(cacheKey, wrapCache(result));
  return result;
}

// ---------------------------------------------------------------------------
// scoreLocation
// ---------------------------------------------------------------------------

export async function scoreLocation(
  lat: number,
  lng: number,
  amenityPrefs: AmenityPreference[],
  workAddress?: string,
  commuteMode: string = 'transit',
): Promise<LocationScore> {
  const amenities = await findNearbyAmenities(lat, lng, amenityPrefs);

  let commute: CommuteResult | null = null;
  if (workAddress) {
    try {
      commute = await calculateCommute(lat, lng, workAddress, commuteMode);
    } catch {
      // Commute calculation failed — leave as null
    }
  }

  // Score calculation: start at 100, subtract for each amenity not within limit
  const amenityCount = amenityPrefs.length;
  let withinCount = 0;
  for (const a of amenities) {
    if (a.withinLimit) withinCount++;
  }

  let overallScore: number;
  if (amenityCount === 0) {
    overallScore = 100;
  } else {
    overallScore = Math.round((withinCount / amenityCount) * 100);
  }

  const mapsLink = `https://www.google.com/maps/@${lat},${lng},15z`;

  return {
    amenities,
    commute,
    overallScore,
    mapsLink,
  };
}
