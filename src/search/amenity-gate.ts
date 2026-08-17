// Strict amenity proximity filter — when enabled, reject a listing if any amenity the
// user requested has its nearest instance over the limit. Enforces ALL requested
// amenity types (not only walking transit), keying off the per-amenity withinLimit
// that maps.ts already computes with the type-appropriate metric.

import type { LocationScore, LocationPrecision, AmenityResult } from '../types.js';
import { matchesAmenityRequest, formatRuRadius, type AmenityPreference } from '../ai/maps.js';

/**
 * Precision classes where the coordinates describe a REGION large enough that a Places search
 * centred on them could have missed an amenity near the flat's true position. The limits are still
 * enforced for these — from the optimistic edge of the region — but an EMPTY result is treated as
 * unknown rather than as a confirmed absence. (Street precision tops out around 500 m against a
 * 5 km search radius, so an empty result there really is an absence.)
 */
export function isCoarsePrecision(precision: LocationPrecision | undefined): boolean {
  return precision === 'approximate' || precision === 'district';
}

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
  /** The verdict rests on a REGION rather than a measured position. Used to label the reason so a
   *  digest line can't be read as a surveyed distance; it does not change the caller's handling. */
  inferred?: boolean;
}

/** Whether the verdict was derived from a region. Keyed on the ACTUAL radius the ranges were built
 *  from, not the precision label — a `street`-classified geocode with a wide bounds box is just as
 *  inferred as a district centroid, and mislabelling it would understate the caveat. */
function verdictIsInferred(locationScore: LocationScore | null): boolean {
  return (locationScore?.locationOuterRadiusMeters ?? 0) > 0;
}

/**
 * Hard filter on the user's amenity limits.
 *
 * An approximate or district-level location is still enforced, judged from the MOST OPTIMISTIC
 * edge of the uncertainty region: if the closest the flat could possibly be still breaks the
 * limit, that is evidence, not ignorance. (A whitelisted station 10–20 min away from the region's
 * edges fails a 7-min requirement — 10 already exceeds 7.) Uncertainty may only ever rescue a
 * listing whose optimistic edge is INSIDE the limit; `applyLocationUncertainty` marks exactly
 * those `uncertain`.
 *
 * Genuine ignorance still passes: no coordinates at all, a failed measurement, or a criterion we
 * could not honour.
 */
export function checkAmenityGate(
  locationScore: LocationScore | null,
  amenities: AmenityPreference[],
  precision: LocationPrecision | undefined,
  strict: boolean,
): AmenityGateResult {
  if (!strict) return { pass: true };
  if (amenities.length === 0) return { pass: true };

  // No coordinates at all → nothing to measure from, so no verdict is possible. The card carries
  // a warning so users can decide whether to verify it with the landlord.
  if (!locationScore || precision === 'none') {
    return { pass: true };
  }
  const inferred = verdictIsInferred(locationScore);

  for (const pref of amenities) {
    const result = locationScore.amenities.find((a) => matchesAmenityRequest(pref, a));
    // Transient Maps API/measurement failure → verdict unknown; keep-with-flag rather than
    // falsely rejecting "not nearby" (and, in the monitor, permanently dropping the listing).
    if (result?.error) continue;
    // We measured something other than what was asked for (e.g. a station whitelist that matched
    // no real station). Never hard-reject against a substituted criterion.
    if (result?.criterionSubstituted) continue;
    if (!result || result.places.length === 0) {
      if (isCoarsePrecision(precision)) continue;
      const line = pref.type === 'metro' && pref.line ? ` ${pref.line}` : '';
      const reason = `${amenityLabel(pref.type)}${line} рядом не найдено`;
      return { pass: false, reason: withInferenceNote(reason, inferred, locationScore), inferred };
    }

    // A range that crosses the requested threshold remains a warning. If the whole
    // range is outside, the evidence is strong enough to enforce the user's limit.
    if (result.uncertain) continue;

    if (!result.withinLimit) {
      if (pref.type === 'metro') {
        const reason = metroRejectionReason(result, pref);
        if (reason) return { pass: false, reason: withInferenceNote(reason, inferred, locationScore), inferred };
      }
      // Show the range the gate actually judged (for an approximate anchor), not the point-search
      // minutes — otherwise the message can read "9 мин (лимит 7)" for a listing kept for its range.
      const n = result.nearest ?? result.places[0];
      const mins = n?.walkingMinutesRange
        ? `~${n.walkingMinutesRange.min}–${n.walkingMinutesRange.max}`
        : String(nearestMinutes(result) ?? '?');
      const line = pref.type === 'metro' && pref.line ? ` ${pref.line}` : '';
      const reason = `${amenityLabel(pref.type)}${line} ${mins} ${unit(pref.type)} (лимит ${pref.maxMinutes} мин)`;
      return { pass: false, reason: withInferenceNote(reason, inferred, locationScore), inferred };
    }
  }

  return { pass: true };
}

/** Tell the reader when a rejection was inferred from a region rather than measured at an address,
 *  so a digest line can't be mistaken for a surveyed distance. */
function withInferenceNote(reason: string, inferred: boolean, locationScore: LocationScore | null): string {
  if (!inferred) return reason;
  const radius = locationScore?.locationOuterRadiusMeters;
  return radius != null && radius > 0
    ? `${reason} — оценка по примерной локации ±${formatRuRadius(radius)}`
    : `${reason} — оценка по примерной локации`;
}

/**
 * Hard filter on public-transport time to the city center (Warszawa Centralna). Mirrors the
 * amenity gate: an approximate or district-level location is still enforced, from the optimistic
 * (min) edge of its region — `centralStationEstimate` measures that edge with a second route for
 * a loosely localized flat, and floors it at what transit can physically achieve over the
 * remaining straight-line distance. Only genuine ignorance passes: no coordinates, or a routing
 * failure that leaves us without a time at all.
 */
export function checkCenterGate(
  locationScore: LocationScore | null,
  maxCenterMinutes: number | undefined,
  precision: LocationPrecision | undefined,
): AmenityGateResult {
  // Ignore a nonsense limit rather than rejecting everything (0) or nothing (NaN).
  if (maxCenterMinutes == null || !Number.isFinite(maxCenterMinutes) || maxCenterMinutes <= 0) return { pass: true };
  if (!locationScore || precision === 'none') return { pass: true };
  const central = locationScore.centralStation;
  if (!central || !central.durationMinRange) return { pass: true }; // routing unknown → keep-with-flag
  if (central.durationMinRange.min > maxCenterMinutes) {
    const { min, max } = central.durationMinRange;
    const inferred = verdictIsInferred(locationScore);
    const reason = `центр (Warszawa Centralna): ~${min}–${max} мин > лимит ${maxCenterMinutes} мин`;
    return { pass: false, reason: withInferenceNote(reason, inferred, locationScore), inferred };
  }
  return { pass: true };
}
