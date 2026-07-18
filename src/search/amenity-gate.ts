// Strict amenity proximity filter — when enabled, reject a listing if any amenity the
// user requested has its nearest instance over the limit. Enforces ALL requested
// amenity types (not only walking transit), keying off the per-amenity withinLimit
// that maps.ts already computes with the type-appropriate metric.

import type { LocationScore, LocationPrecision, AmenityResult } from '../types.js';
import type { AmenityPreference } from '../ai/maps.js';

/** Extra minutes of tolerance when coordinates are only a district centroid (approximate). */
const DISTRICT_SLACK_MIN = 5;

export const AMENITY_LABELS: Record<string, string> = {
  metro: 'метро',
  tram: 'трамвай',
  bus: 'автобус',
  gym: 'зал',
  pool: 'бассейн',
  groceries: 'продукты',
  supermarket: 'супермаркет',
  park: 'парк',
  pharmacy: 'аптека',
  airport: 'аэропорт',
  cafe: 'кафе',
  restaurant: 'рестораны',
};

/** Russian label for an amenity type (shared by the gate, fit-score, and card). */
export function amenityLabel(type: string): string {
  return AMENITY_LABELS[type] ?? type;
}

function unit(type: string): string {
  return type === 'airport' ? 'мин в пути' : 'мин пешком';
}

/** Best-known travel minutes for an amenity (walking → transit → driving). */
function nearestMinutes(result: AmenityResult): number | null {
  const n = result.nearest ?? result.places[0];
  if (!n) return null;
  if (n.walkingMinutes >= 0) return n.walkingMinutes;
  if (n.transitMinutes != null) return n.transitMinutes;
  if (n.drivingMinutes != null) return n.drivingMinutes;
  return null;
}

export function resolveStrictAmenities(explicit?: boolean): boolean {
  if (explicit != null) return explicit;
  return process.env.STRICT_WALKING_AMENITIES === 'true';
}

export interface AmenityGateResult {
  pass: boolean;
  reason?: string;
}

export function checkAmenityGate(
  locationScore: LocationScore | null,
  amenities: AmenityPreference[],
  precision: LocationPrecision | undefined,
  strict: boolean,
): AmenityGateResult {
  if (!strict) return { pass: true };
  if (amenities.length === 0) return { pass: true };

  // Keep-with-flag when we have no usable coordinates: a district centroid is still
  // checkable (with slack), but 'none'/null location can't be verified — don't drop
  // the whole class of listings (e.g. OLX posts without a street address).
  if (!locationScore || precision === 'none') {
    return { pass: true };
  }

  const slack = precision === 'district' ? DISTRICT_SLACK_MIN : 0;

  for (const pref of amenities) {
    const result = locationScore.amenities.find((a) => a.type === pref.type);
    // Transient Maps API/measurement failure → verdict unknown; keep-with-flag rather than
    // falsely rejecting "not nearby" (and, in the monitor, permanently dropping the listing).
    if (result?.error) continue;
    if (!result || result.places.length === 0) {
      return { pass: false, reason: `${amenityLabel(pref.type)} рядом не найдено` };
    }

    // Exact/street coords: trust the strict withinLimit directly (no slack).
    if (slack === 0) {
      if (!result.withinLimit) {
        const mins = nearestMinutes(result);
        return { pass: false, reason: `${amenityLabel(pref.type)} ${mins ?? '?'} ${unit(pref.type)} (лимит ${pref.maxMinutes} мин)` };
      }
      continue;
    }

    // District centroid: allow a small slack margin before rejecting.
    if (result.withinLimit) continue;
    const mins = nearestMinutes(result);
    if (mins != null && mins > pref.maxMinutes + slack) {
      return { pass: false, reason: `${amenityLabel(pref.type)} ${mins} ${unit(pref.type)} (лимит ${pref.maxMinutes}+${slack} мин, район)` };
    }
  }

  return { pass: true };
}
