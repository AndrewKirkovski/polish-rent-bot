// Positional evidence as REGIONS, and their intersection.
//
// Every location signal says the same kind of thing: "the flat is somewhere in here". A map pin is
// a disc. A geocoder's bounds box is a disc. "5 min do metra Zacisze" is an annulus. The honest
// answer is the INTERSECTION of all of them, which is monotone — more evidence can only narrow it.
//
// WHY A SOLVER AND NOT ALGEBRA. Intersecting discs with annuli has no tidy closed form, and the
// shapes that matter here are exactly the awkward ones: the lens where two discs overlap without
// either containing the other, and the two points where two rings cross. Earlier versions handled
// each shape with its own rule and got the common cases wrong — an overlap that was not containment
// contributed nothing, so a 600 m estate box beside a fuzzy pin left the estimate at kilometres.
// A refining grid finds every one of those shapes with one piece of logic.
//
// It is cheap enough not to think about: a few thousand point tests against ≤8 regions, once per
// listing, against several Google round-trips in the same pass. It is also fully deterministic.
//
// EVERYTHING HERE IS CROW METRES. Callers convert ad-quoted walking distances before building a
// region; see the unit rule at the top of uncertainty.ts.

import { haversineMeters } from './metro.js';

export interface Region {
  /** Centre of the disc, or the station an annulus is drawn around. */
  lat: number;
  lng: number;
  /** Inner radius. 0 for a disc; the near edge of the ring for an annulus. */
  minRadius: number;
  /** Outer radius — the containing bound. */
  maxRadius: number;
  /**
   * How far this evidence is trusted, 0..1. It matters ONLY when the constraints cannot all hold:
   * the solver keeps the position satisfying the most reliability, so a mis-geocoded hint loses to
   * a pin corroborated by its district rather than being averaged with it into a region covering
   * both. When everything is consistent, reliability changes nothing.
   */
  reliability: number;
  source: string;
}

export interface RegionSolution {
  lat: number;
  lng: number;
  /** Smallest radius about `lat`/`lng` that still covers the whole surviving region. */
  radiusCrowMeters: number;
  /** Sources whose region contains the answer, and those it had to violate. */
  satisfied: string[];
  unsatisfied: string[];
}

const GRID = 25;          // cells per side, per level
const LEVELS = 4;         // 25^-4 of the seed box: metres, from a 5 km start
const MIN_RADIUS_M = 25;  // nothing here localizes a flat better than this

function contains(region: Region, lat: number, lng: number, tolerance: number): boolean {
  const d = haversineMeters(region.lat, region.lng, lat, lng);
  return d >= region.minRadius - tolerance && d <= region.maxRadius + tolerance;
}

function scoreAt(regions: Region[], lat: number, lng: number, tolerance: number): number {
  let score = 0;
  for (const region of regions) {
    if (contains(region, lat, lng, tolerance)) score += region.reliability;
  }
  return score;
}

interface Candidate {
  lat: number; lng: number; score: number;
  /** The surviving cells themselves, so the covering radius can be measured from whichever centre
   *  is finally chosen. Returning a radius instead forced `radius + offset` when the centre moved,
   *  a bound so lossy it clamped straight back to the seed and no evidence ever tightened. */
  survivors: Array<{ lat: number; lng: number }>;
  tolerance: number;
}

/**
 * Refine a grid inside one seed region. The answer lies inside EVERY region, so it lies inside this
 * one, and a box any larger only wastes resolution.
 */
function refineFrom(regions: Region[], seed: Region): Candidate | null {
  let centreLat = seed.lat;
  let centreLng = seed.lng;
  let half = seed.maxRadius;
  const perDegLat = 110_540;
  const perDegLng = 111_320 * Math.cos((seed.lat * Math.PI) / 180);

  let survivors: Array<{ lat: number; lng: number }> = [];
  let best = -1;
  let tolerance = 0;

  for (let level = 0; level < LEVELS; level++) {
    const step = (2 * half) / (GRID - 1);
    // Half a cell diagonal: a thin annulus must not fall between two coarse samples and vanish.
    tolerance = (step * Math.SQRT2) / 2;
    const found: Array<{ lat: number; lng: number }> = [];
    best = -1;

    for (let i = 0; i < GRID; i++) {
      const lat = centreLat + (-half + i * step) / perDegLat;
      for (let j = 0; j < GRID; j++) {
        const lng = centreLng + (-half + j * step) / perDegLng;
        const score = scoreAt(regions, lat, lng, tolerance);
        if (score > best + 1e-9) {
          best = score;
          found.length = 0;
          found.push({ lat, lng });
        } else if (score > best - 1e-9) {
          found.push({ lat, lng });
        }
      }
    }
    if (found.length === 0) return null;
    survivors = found;

    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const p of found) {
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
      minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
    }
    centreLat = (minLat + maxLat) / 2;
    centreLng = (minLng + maxLng) / 2;
    // One cell of slack keeps a boundary the coarse grid clipped.
    half = Math.max(((maxLat - minLat) / 2) * perDegLat, ((maxLng - minLng) / 2) * perDegLng) + step;
  }

  return { lat: centreLat, lng: centreLng, score: best, survivors, tolerance };
}

/** Smallest radius about a centre that still covers every surviving cell. */
function coverRadius(centre: { lat: number; lng: number }, c: Candidate): number {
  let radius = 0;
  for (const p of c.survivors) {
    radius = Math.max(radius, haversineMeters(centre.lat, centre.lng, p.lat, p.lng));
  }
  return radius + c.tolerance;
}

/**
 * Intersect every region and return the smallest disc covering the result.
 *
 * MULTI-START. Seeding only on the tightest region would hand the answer to whichever evidence
 * happens to be tightest — a confidently mis-geocoded 600 m box beats a 3.6 km pin on size alone,
 * and the search would never even sample where the pin says the flat is. Every region is tried as a
 * seed and the most-corroborated result wins, so being narrow is not the same as being right.
 *
 * `preferredCentre` is the best positional estimate independent of this geometry (the weighted mean
 * of the point evidence). When it survives the intersection it is reported as the centre, because a
 * grid centroid would otherwise discard the sub-metre agreement of two precise sources. It never
 * changes WHICH region is found — only how that region is summarised.
 */
export function solveRegions(
  regions: Region[],
  preferredCentre?: { lat: number; lng: number } | null,
): RegionSolution | null {
  if (regions.length === 0) return null;

  let best: Candidate | null = null;
  for (const seed of regions) {
    const candidate = refineFrom(regions, seed);
    if (!candidate) continue;
    // Most corroboration wins; among equals, the tighter answer.
    if (!best || candidate.score > best.score + 1e-9
      || (candidate.score > best.score - 1e-9
        && coverRadius(candidate, candidate) < coverRadius(best, best))) {
      best = candidate;
    }
  }
  if (!best) return null;

  let centre = { lat: best.lat, lng: best.lng };
  const tolerance = Math.max(coverRadius(centre, best), MIN_RADIUS_M) * 0.02 + 1;

  if (preferredCentre) {
    const preferredScore = scoreAt(regions, preferredCentre.lat, preferredCentre.lng, tolerance);
    // Keep the independent position estimate when the intersection actually contains it, and
    // measure the covering radius from THERE — never inflate by the distance moved.
    if (preferredScore > best.score - 1e-9) centre = preferredCentre;
  }
  const lat = centre.lat;
  const lng = centre.lng;
  let radius = coverRadius(centre, best);

  // Never claim tighter than the floor, nor wider than the tightest satisfied containing evidence.
  const tightestSatisfied = regions
    .filter((r) => contains(r, lat, lng, tolerance))
    .reduce((acc, r) => Math.min(acc, r.maxRadius), Infinity);
  radius = Math.max(MIN_RADIUS_M, Math.min(radius, tightestSatisfied));

  const satisfied: string[] = [];
  const unsatisfied: string[] = [];
  for (const region of regions) {
    (contains(region, lat, lng, tolerance) ? satisfied : unsatisfied).push(region.source);
  }
  return { lat, lng, radiusCrowMeters: radius, satisfied, unsatisfied };
}
