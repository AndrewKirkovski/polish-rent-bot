// Strict amenity proximity filter — when enabled, reject a listing if any amenity the
// user requested has its nearest instance over the limit. Enforces ALL requested
// amenity types (not only walking transit), keying off the per-amenity withinLimit
// that maps.ts already computes with the type-appropriate metric.

import type { LocationScore, LocationPrecision, AmenityResult } from '../types.js';
import type { AmenityPreference } from '../ai/maps.js';

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

function metricDistance(meters: number, bound: 'lower' | 'upper'): string {
  const round = bound === 'lower' ? Math.floor : Math.ceil;
  if (meters < 1000) return `${round(meters / 50) * 50} м`;
  return `${(round(meters / 100) / 10).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} км`;
}

function metroRejectionReason(result: AmenityResult, pref: AmenityPreference): string | null {
  const nearest = result.nearest ?? result.places[0];
  if (!nearest) return null;
  const station = nearest.name;
  const distance = nearest.distanceMetersRange
    ? `~${metricDistance(nearest.distanceMetersRange.min, 'lower')}–${metricDistance(nearest.distanceMetersRange.max, 'upper')}`
    : nearest.distance;
  const minutes = nearest.walkingMinutesRange
    ? `~${nearest.walkingMinutesRange.min}–${nearest.walkingMinutesRange.max}`
    : String(nearest.walkingMinutes);
  const line = pref.line ? ` ${pref.line}` : '';
  return `метро${line}: ${station}, ${distance}, ${minutes} мин пешком (лимит ${pref.maxMinutes} мин)`;
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

  // Missing/district-only location is an UNKNOWN verdict, not a rejection. The card carries
  // a warning so users can decide whether to verify it with the landlord.
  if (!locationScore || precision === 'none' || precision === 'district') {
    return { pass: true };
  }

  for (const pref of amenities) {
    const sameType = locationScore.amenities.filter((a) => a.type === pref.type);
    const result = pref.type !== 'metro'
      ? sameType[0]
      : pref.line
        ? sameType.find((a) => a.requestedLine === pref.line)
        : sameType.find((a) => a.requestedLine == null);
    // Transient Maps API/measurement failure → verdict unknown; keep-with-flag rather than
    // falsely rejecting "not nearby" (and, in the monitor, permanently dropping the listing).
    if (result?.error) continue;
    if (!result || result.places.length === 0) {
      if (precision === 'approximate') continue;
      const line = pref.type === 'metro' && pref.line ? ` ${pref.line}` : '';
      return { pass: false, reason: `${amenityLabel(pref.type)}${line} рядом не найдено` };
    }

    // A range that crosses the requested threshold remains a warning. If the whole
    // range is outside, the evidence is strong enough to enforce the user's limit.
    if (result.uncertain) continue;

    if (!result.withinLimit) {
      if (pref.type === 'metro') {
        const reason = metroRejectionReason(result, pref);
        if (reason) return { pass: false, reason };
      }
      const mins = nearestMinutes(result);
      const line = pref.type === 'metro' && pref.line ? ` ${pref.line}` : '';
      return { pass: false, reason: `${amenityLabel(pref.type)}${line} ${mins ?? '?'} ${unit(pref.type)} (лимит ${pref.maxMinutes} мин)` };
    }
  }

  return { pass: true };
}

/**
 * Hard filter on public-transport time to the city center (Warszawa Centralna). Mirrors the
 * amenity gate's leniency: unknown/district-only locations and routing failures keep the listing
 * (with the card's warning) rather than falsely rejecting. Rejects only when even the optimistic
 * (min) transit time already exceeds the limit.
 */
export function checkCenterGate(
  locationScore: LocationScore | null,
  maxCenterMinutes: number | undefined,
  precision: LocationPrecision | undefined,
): AmenityGateResult {
  if (maxCenterMinutes == null) return { pass: true };
  if (!locationScore || precision === 'none' || precision === 'district') return { pass: true };
  const central = locationScore.centralStation;
  if (!central || !central.durationMinRange) return { pass: true }; // routing unknown → keep-with-flag
  if (central.durationMinRange.min > maxCenterMinutes) {
    const { min, max } = central.durationMinRange;
    return { pass: false, reason: `центр (Warszawa Centralna): ~${min}–${max} мин > лимит ${maxCenterMinutes} мин` };
  }
  return { pass: true };
}
