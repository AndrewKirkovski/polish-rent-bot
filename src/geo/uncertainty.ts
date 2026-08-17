// Positional-uncertainty geometry — the single source of truth for turning a location
// estimate into optimistic/pessimistic distance and walking-time bounds.
//
// WHY THIS EXISTS: the gates hard-reject a listing when even the MOST OPTIMISTIC edge of the
// uncertainty region still violates the user's limit. That makes `min` load-bearing for a
// permanent decision, so it must be a genuine lower bound — never inflated by a unit mix-up
// or a pace artefact. Two rules keep it honest:
//
//   1. ONE UNIT. Everything here is ROUTE metres (walking-path metres, what Google's
//      distance matrix returns). Crow-flies radii are converted at the source with
//      walkMetersFromCrow before they reach this module. Subtracting a crow radius from a
//      route distance would overstate `min` by ~30% (≈ r/260 minutes) and permanently reject
//      flats that are genuinely within the limit.
//   2. ERR OPTIMISTIC. Where a bound is modelled rather than measured, round in the lenient
//      direction. A too-low `min` keeps a listing with a ⚠️; a too-high `min` deletes it.

import { WALK_DETOUR_FACTOR, WALK_METERS_PER_MINUTE, walkMetersFromCrow } from './metro.js';

/** Crow metres → route metres. Re-exported from the shared walk model so callers of this module
 *  have one import for the whole unit conversion, in both directions. */
export { walkMetersFromCrow as routeMetersFromCrow };

/** Outer sanity band for a walking pace (route metres per minute). A genuinely slow route —
 *  stairs, crossings, a long detour — really does measure ~50 m/min, and that is EVIDENCE we
 *  should keep. This band only catches values no walk can produce. */
export const MIN_OBSERVED_PACE = 30;
export const MAX_OBSERVED_PACE = 120;
/** Below this route distance the observed pace is dominated by Google's integer-minute rounding
 *  (a 45 m walk reported as "1 min" implies 45 m/min) and extrapolating a kilometre of
 *  uncertainty at that pace invents minutes. Use the shared walk model instead. */
const PACE_TRUSTWORTHY_ABOVE_METERS = 200;

/**
 * Where the apartment may be, expressed as a band of ROUTE metres from the anchor point.
 * A disc (the usual case: a point with a radius) has `min = 0`. An annulus (localized only
 * as "N m from Metro X", where the anchor IS the station) has `min > 0`.
 */
export interface UncertaintyBand {
  /** Smallest possible route distance from the anchor point to the apartment. */
  minMeters: number;
  /** Largest possible route distance from the anchor point to the apartment. */
  maxMeters: number;
}

/** Route metres → crow metres. Needed to displace a coordinate geographically. */
export function crowMetersFromRoute(routeMeters: number): number {
  return routeMeters / WALK_DETOUR_FACTOR;
}

/**
 * Build the band from an estimate's anchor distance and outer radius, both already in ROUTE
 * metres. `anchorDistanceMeters` is 0 for every disc-shaped estimate.
 */
export function bandFor(anchorDistanceMeters: number, outerRadiusMeters: number): UncertaintyBand {
  return {
    minMeters: Math.max(0, anchorDistanceMeters - outerRadiusMeters),
    maxMeters: Math.max(0, anchorDistanceMeters + outerRadiusMeters),
  };
}

/** No region at all (an exact position): bandFor clamps both ends ≥ 0 with max ≥ min, so a zero
 *  outer radius and zero anchor is the only way maxMeters reaches 0. */
export function bandIsEmpty(band: UncertaintyBand): boolean {
  return band.maxMeters <= 0;
}

/**
 * Smallest route distance from the apartment to a place measured at `placeMeters` from the
 * anchor. The apartment sits somewhere in `band`, so by the triangle inequality the place can
 * be as close as the gap between `placeMeters` and the band — and zero when the place falls
 * inside the band (the apartment could be standing on it).
 *
 * V-shaped in `placeMeters`, with a flat zero valley across the band. THAT IS WHY candidate
 * pools must be ranked by this value, not by raw distance: for an annulus the closest-by-
 * optimistic-edge station can be far down a nearest-first list.
 */
export function optimisticMeters(placeMeters: number, band: UncertaintyBand): number {
  if (placeMeters < band.minMeters) return band.minMeters - placeMeters;
  if (placeMeters > band.maxMeters) return placeMeters - band.maxMeters;
  return 0;
}

/** Largest route distance from the apartment to that place. */
export function pessimisticMeters(placeMeters: number, band: UncertaintyBand): number {
  return placeMeters + band.maxMeters;
}

/**
 * Walking pace to convert the widened distances into minutes. Uses the measured pace only
 * when the walk was long enough for integer-minute rounding not to dominate, and clamps it
 * to a plausible band either way.
 */
export function resolvePace(placeMeters: number, walkingMinutes: number): number {
  if (walkingMinutes <= 0 || placeMeters <= 0) return WALK_METERS_PER_MINUTE;
  if (placeMeters < PACE_TRUSTWORTHY_ABOVE_METERS) return WALK_METERS_PER_MINUTE;
  const observed = placeMeters / walkingMinutes;
  return Math.min(MAX_OBSERVED_PACE, Math.max(MIN_OBSERVED_PACE, observed));
}

export interface WidenedPlace {
  distanceMetersRange: { min: number; max: number };
  walkingMinutesRange: { min: number; max: number };
}

/**
 * Expand one measured place into honest ranges. `placeMeters`/`walkingMinutes` are the
 * point-based measurement from the anchor; `band` is where the apartment actually may be.
 *
 * The two ends BRACKET the pace rather than sharing one value. The measured pace describes the
 * route to the anchor; the optimistic edge is a different, shorter route that has no reason to
 * inherit that route's detours, so `min` uses the faster of (measured, model) and `max` the slower.
 * Combined with floor/ceil, rounding always widens the range — never narrows it.
 */
export function widenPlace(placeMeters: number, walkingMinutes: number, band: UncertaintyBand): WidenedPlace {
  const minMeters = optimisticMeters(placeMeters, band);
  const maxMeters = pessimisticMeters(placeMeters, band);
  const pace = resolvePace(placeMeters, walkingMinutes);
  const fastPace = Math.max(pace, WALK_METERS_PER_MINUTE);
  const slowPace = Math.min(pace, WALK_METERS_PER_MINUTE);
  return {
    distanceMetersRange: { min: Math.round(minMeters), max: Math.round(maxMeters) },
    walkingMinutesRange: {
      min: Math.max(0, Math.floor(minMeters / fastPace)),
      max: Math.max(1, Math.ceil(maxMeters / slowPace)),
    },
  };
}
