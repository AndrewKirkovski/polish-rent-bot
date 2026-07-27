// Deterministic 0..100 fit score from the AI-extracted signals + crawler ground truth,
// weighted by the household profile. Also returns a short Russian "why it fits" line.

import type { Listing, ParsedRentalData, LocationScore } from '../types.js';
import { HOUSEHOLD_PROFILE, type HouseholdProfile } from '../profile.js';
import { computeRentalCost } from '../cost.js';
import { amenityLabel } from './amenity-gate.js';

export interface FitResult {
  score: number;       // 0..100
  reason: string;      // short Russian summary of the strongest fit signals
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Cheap crawler-only pre-rank (no AI needed) so the best candidates get enriched first.
 *  Uses only pre-enrichment fields: budget (base rate, no media yet) and OLX elevator.
 *  Internet/quiet/two-office come from the AI parse and drive the full computeFitScore. */
export function preScore(listing: Listing, profile: HouseholdProfile = HOUSEHOLD_PROFILE): number {
  let s = 0;
  const base = listing.price + (listing.rent ?? 0);
  const { from, to } = profile.budgetTotalPln;
  if (to > from && base > 0) s += 0.5 * clamp01((to - base) / (to - from));
  if (listing.hasElevator === true) s += 0.05;
  return s;
}

export function computeFitScore(
  listing: Listing,
  parsed: ParsedRentalData | null | undefined,
  locationScore: LocationScore | null | undefined,
  profile: HouseholdProfile = HOUSEHOLD_PROFILE,
): FitResult {
  const w = profile.weights;
  const parts: Array<{ key: string; weight: number; value: number }> = [];
  const reasons: string[] = [];

  // --- Two office-capable rooms (the #1 need) ---
  let office = 0.5; // unknown → neutral
  if (parsed?.twoOfficeCapable === true) { office = 1; reasons.push('2 офиса'); }
  else if (parsed?.twoOfficeCapable === false) office = 0;
  else if (parsed?.separateRooms != null) office = clamp01(parsed.separateRooms / 2);
  parts.push({ key: 'twoOfficeCapable', weight: w.twoOfficeCapable ?? 0, value: office });

  // --- Internet: down-ranked when unknown, never zeroed. Fibre is an AI inference. ---
  let net = 0.4;
  if (parsed?.internetType === 'fiber') { net = 1; reasons.push('оптика'); }
  else if (listing.hasInternet === true || parsed?.internetType === 'cable') { net = 0.7; reasons.push('интернет'); }
  parts.push({ key: 'internet', weight: w.internet ?? 0, value: net });

  // --- Quiet ---
  let quiet = 0.5;
  if (parsed?.quiet === 'quiet') { quiet = 1; reasons.push('тихо'); }
  else if (parsed?.quiet === 'mixed') quiet = 0.5;
  else if (parsed?.quiet === 'noisy') quiet = 0;
  parts.push({ key: 'quiet', weight: w.quiet ?? 0, value: quiet });

  // --- Natural light ---
  let light = 0.5;
  if (parsed?.naturalLight === 'bright') { light = 1; reasons.push('светло'); }
  else if (parsed?.naturalLight === 'average') light = 0.5;
  else if (parsed?.naturalLight === 'dark') light = 0;
  parts.push({ key: 'naturalLight', weight: w.naturalLight ?? 0, value: light });

  // --- Budget headroom (cheaper within band = better) ---
  const total = computeRentalCost(listing, parsed).total;
  const { from, to } = profile.budgetTotalPln;
  let budget = 0.5;
  if (total > 0 && to > from) {
    budget = clamp01((to - total) / (to - from)); // at/under `from` → 1, at `to` → 0
  }
  parts.push({ key: 'budget', weight: w.budget ?? 0, value: budget });

  // --- Amenities (fraction of requested within limit) ---
  if (locationScore && !locationScore.locationUnknown && locationScore.amenities.length > 0) {
    const within = locationScore.amenities.filter((a) => a.withinLimit).length;
    const uncertain = locationScore.amenities.filter((a) => a.uncertain).length;
    parts.push({ key: 'amenities', weight: w.amenities ?? 0, value: (within + uncertain * 0.5) / locationScore.amenities.length });
  }

  // --- Elevator ---
  if (listing.hasElevator != null) {
    parts.push({ key: 'elevator', weight: w.elevator ?? 0, value: listing.hasElevator ? 1 : 0 });
    if (listing.hasElevator) reasons.push('лифт');
  }

  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const weighted = parts.reduce((s, p) => s + p.weight * p.value, 0);
  const score = totalWeight > 0 ? Math.round((weighted / totalWeight) * 100) : 50;

  // Append the genuinely nearest within-limit amenity (smallest walking time) to the reason.
  if (locationScore) {
    const near = locationScore.amenities
      .filter((a) => a.withinLimit && (a.places[0]?.walkingMinutes ?? -1) >= 0)
      .sort((a, b) => a.places[0]!.walkingMinutes - b.places[0]!.walkingMinutes)[0];
    if (near) {
      const place = near.places[0]!;
      const minutes = place.walkingMinutesRange
        ? `${place.walkingMinutesRange.min}-${place.walkingMinutesRange.max}м`
        : `${place.walkingMinutes}м`;
      reasons.push(`${amenityLabel(near.type)} ${minutes}`);
    }
  }

  return { score, reason: reasons.slice(0, 4).join(' · ') };
}
