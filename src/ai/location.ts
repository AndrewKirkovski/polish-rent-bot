// Dedicated location-enrichment flow.
//
// Resolves the most precise coordinates available for a listing and labels the
// precision, so amenity/commute scoring isn't run against a vague district centroid:
//   - Otodom: search results omit coordinates; the detail page carries exact ones.
//   - OLX: the API never exposes the street, but the description often names it
//     (captured by the AI parse as `addressHint`) — geocode that for street-level precision.
//     OLX's own map coords are district-center, so they're treated as district-level only.

import type { Listing, LocationPrecision, ParsedRentalData } from '../types.js';
import { geocodeAddress, buildAddressFromListing, warsawMetroLinesForStation } from './maps.js';
import type { GeocodedLocation } from './maps.js';
import { findMetroStation, haversineMeters, walkMetersFromCrow, WALK_DETOUR_FACTOR } from '../geo/metro.js';
import { fetchOtodomDetail } from '../crawlers/otodom.js';

/**
 * σ is a ~1σ radius, which covers only ~39% of a 2D Gaussian's mass. The gates hard-reject on
 * the optimistic edge of the region, so they need a radius that actually CONTAINS the true
 * position — otherwise a flat whose real location is 2σ from the fused point gets deleted for
 * a distance it doesn't have. 2σ (~86% of the mass) is the outer bound we enforce against.
 */
const OUTER_SIGMA_K = 2;

/** No honest region is larger than this; caps a pathological geocode box or ad-quoted radius. */
const MAX_OUTER_RADIUS_M = 25_000;

/** Fallback extent for a district/city centroid when the geocoder returned no bounds box. */
const ASSUMED_AREA_RADIUS_M = 2500;

/** Below this the district lookup cannot tighten anything we already hold (dzielnice run 2–5 km),
 *  so the geocode is skipped rather than paid for. */
const DISTRICT_AREA_USEFUL_BELOW_M = 1500;

export interface EnrichedLocation {
  lat: number | null;
  lng: number | null;
  precision: LocationPrecision;
  /** Distance from the returned point to the apartment, in ROUTE (walking-path) metres.
   *  Non-zero ONLY on the metro-annulus path, where the returned point is the STATION and the
   *  apartment sits on a ring around it. Every other branch returns a plausible apartment
   *  position, i.e. a disc, and leaves this 0. */
  anchorDistanceMeters: number;
  /** ~1σ positional uncertainty in CROW metres. Diagnostic/legacy: the gates use
   *  `outerRadiusMeters` instead, because σ is not a containing bound. */
  uncertaintyMeters: number;
  /** Honest OUTER bound of the uncertainty region, in ROUTE metres. This is the number every
   *  hard gate measures the optimistic edge from, so it must contain the true position. */
  outerRadiusMeters: number;
  source: string;
  evidence: string | null;
}

const capOuter = (meters: number): number => Math.max(0, Math.min(MAX_OUTER_RADIUS_M, Math.round(meters)));

/**
 * Outer radius (route metres) for a geocoded point: the wider of the precision-class estimate and
 * the geocoder's own measured extent, so an area match can't be reported tighter than the area it
 * actually covers.
 *
 * The precision-class figure is a σ, exactly as it is on the fused path, so it gets the same
 * OUTER_SIGMA_K inflation — otherwise identical geocoder evidence would yield a containing bound
 * through `fuseLocationCandidates` and a bare 1σ here, and this branch's listings would be rejected
 * for distances they may not have. A MEASURED extent is already a containing bound, so it is not
 * inflated; the wider of the two wins.
 */
function geocodeOuterRadius(geo: GeocodedLocation, classifiedUncertainty: number): number {
  return capOuter(walkMetersFromCrow(Math.max(
    OUTER_SIGMA_K * classifiedUncertainty,
    geo.areaRadiusMeters ?? 0,
  )));
}

export function classifyGeocodePrecision(
  geo: Pick<GeocodedLocation, 'locationType' | 'partialMatch' | 'resultTypes'>,
): { precision: 'street' | 'approximate'; uncertaintyMeters: number; weak?: true } {
  const types = new Set(geo.resultTypes);
  const addressType = ['street_address', 'premise', 'subpremise', 'intersection']
    .some((type) => types.has(type));
  const addressGeometry = geo.locationType === 'ROOFTOP' || geo.locationType === 'RANGE_INTERPOLATED';
  const intersection = types.has('intersection');
  if (!geo.partialMatch && (intersection || (addressType && addressGeometry))) {
    return { precision: 'street', uncertaintyMeters: geo.locationType === 'ROOFTOP' ? 50 : 125 };
  }
  // PARTIAL means the geocoder did not find what was asked for and answered with something else.
  // That is not a coarse answer, it is a different place: "przystanek Warszawa Zacisze-Wilno" comes
  // back partial and lands 1.5 km from the flat. Weak, so it cannot outrank the platform's own pin —
  // at sigma 1500 and reliability 0.5 it otherwise still outweighs a fuzzy pin (0.4/1800) and drags
  // the point across the district. Checked BEFORE the establishment case below, which is why that
  // one alone did not catch this.
  if (geo.partialMatch) return { precision: 'approximate', uncertaintyMeters: 1500, weak: true };
  if (types.has('route')) return { precision: 'approximate', uncertaintyMeters: 600 };
  if (types.has('neighborhood') || types.has('sublocality')) {
    return { precision: 'approximate', uncertaintyMeters: 1500 };
  }
  if (types.has('locality') || types.has('administrative_area_level_2')) {
    return { precision: 'approximate', uncertaintyMeters: 2500 };
  }
  // A BUSINESS, not a place the flat can be in. "Osiedle Wilno, Warszawa" resolves to
  // `Wierna 24 — real_estate_agency`: an agency that named itself after the estate, 1.8 km from
  // the estate itself. Estate/agency name collisions are systematic in this market.
  //
  // The problem is RELEVANCE, not precision — the office is pinpointed, it just says nothing about
  // the flat — so this is flagged `weak` for the caller to de-weight, rather than being handed a
  // large sigma it does not deserve. It must never outrank the platform's own map pin.
  if (types.has('establishment') || types.has('point_of_interest')) {
    return { precision: 'approximate', uncertaintyMeters: 1000, weak: true };
  }
  return { precision: 'approximate', uncertaintyMeters: 1000 };
}

function geocodeAreaUncertainty(geo: GeocodedLocation): number {
  const types = new Set(geo.resultTypes);
  if (geo.partialMatch) return 1500;
  if (types.has('locality') || types.has('administrative_area_level_2')) return 2500;
  if (types.has('neighborhood') || types.has('sublocality')) return 1500;
  if (types.has('route')) return 600;
  return 0;
}

/**
 * Uncertainty for a geocoded candidate, in CROW metres, never tighter than the area the geocoder
 * says it matched. The precision-class constants above are averages: a long street ("Puławska"
 * spans ~10 km) or a sprawling estate resolves to a `route`/`neighborhood` type whose real extent
 * dwarfs the 600/1500 m assumption. Understating it here would raise every downstream optimistic
 * edge and reject flats that are genuinely close to what the user asked for.
 */
function candidateSigma(geo: GeocodedLocation, classifiedUncertainty: number): number {
  return Math.max(classifiedUncertainty, geo.areaRadiusMeters ?? 0);
}

type UsableDescriptionLocationHint = ParsedRentalData['locationHint'] & {
  query: string;
  kind: Exclude<ParsedRentalData['locationHint']['kind'], 'none'>;
};

export function isUsableDescriptionLocationHint(
  hint: ParsedRentalData['locationHint'],
  city: string,
  district?: string | null,
): hint is UsableDescriptionLocationHint {
  if (!hint.query || hint.kind === 'none') return false;
  const normalizeLabel = (value: string): string => value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const normalizedCity = normalizeLabel(city);
  const stationQuery = (hint.query.split(',')[0]?.trim() ?? hint.query.trim())
    .replace(/\s+(?:warszawa|warsaw)(?:\s+polska)?$/i, '');
  const normalizedQuery = normalizeLabel(stationQuery).replace(/^(?:dzielnica|osiedle)\s+/, '');
  const duplicatesPlatformArea = ['building', 'estate', 'landmark', 'neighborhood'].includes(hint.kind)
    && (normalizedQuery === normalizedCity
      || (district != null && normalizedQuery === normalizeLabel(district)));
  if (duplicatesPlatformArea) return false;
  const claimsWarsawMetro = hint.kind === 'transit_stop'
    && (normalizedCity.includes('warszaw') || normalizedCity.includes('warsaw'))
    && (/\bmetr[oa]\b/.test(normalizedQuery) || /\bm[12]\b/.test(normalizedQuery));
  return !claimsWarsawMetro || warsawMetroLinesForStation(stationQuery).length > 0;
}

// ---------------------------------------------------------------------------
// Multi-source fusion — combine every available signal into the tightest honest point.
// ---------------------------------------------------------------------------

const AGREE_K = 1.5;             // two candidates "agree" when within AGREE_K*(σ_a + σ_b)
/** A metro "point" really spans its entrances. A physical extent, so this is CROW metres — every
 *  use that combines it with an ad-quoted (walking) distance must detour-scale it first. */
const STATION_FOOTPRINT_M = 150;
const STATION_FOOTPRINT_ROUTE_M = walkMetersFromCrow(STATION_FOOTPRINT_M);

type HintKind = Exclude<ParsedRentalData['locationHint']['kind'], 'none'>;
const HINT_KIND_DEFAULT_UNC: Record<HintKind, number> = {
  address: 100, intersection: 175, building: 250, estate: 800, transit_stop: 400, landmark: 650, neighborhood: 1800,
};
const HINT_KIND_LABEL: Record<HintKind, string> = {
  address: 'адрес', intersection: 'перекрёсток', building: 'здание', estate: 'жилой массив',
  transit_stop: 'остановка', landmark: 'ориентир', neighborhood: 'район',
};

export interface LocCandidate {
  lat: number; lng: number;
  sigma: number;           // ~1σ uncertainty radius, metres
  reliability: number;     // prior trust 0..1
  precisionFloor: LocationPrecision;
  source: string;
  evidence: string | null;
}
export interface MetroConstraint {
  station: { name: string; lat: number; lng: number };
  distance: number;        // apartment is ~this far from the station (anchorDistanceMeters)
  margin: number;          // ± tolerance incl. station footprint
  evidence: string | null;
}

/**
 * A region the flat is CONTAINED IN — a geocoder's measured bounds box for a named area ("Osiedle
 * Wilno", "Targówek"). Unlike a candidate it is not a guess at the position, so it never moves the
 * point and never widens the estimate; it can only CLIP it. Evidence that says "inside this box"
 * intersects with everything else, and intersection is monotone: more of it is always tighter.
 *
 * There is deliberately NO reliability weight here. Containment is a hard geometric fact, not a
 * score to be traded off: either the flat is inside the box or the box is wrong. A weight field
 * existed while a solver combined areas by weighted corroboration; that solver is gone, and leaving
 * the field would invite the next reader to assume containment is negotiable.
 *
 * This is the difference between averaging evidence and intersecting it. Fed through
 * `candidateSigma` a 600 m estate box becomes a 600 m σ, which OUTER_SIGMA_K then doubles to a
 * 1200 m radius — the box made the answer VAGUER than the box itself.
 */
export interface AreaConstraint {
  lat: number; lng: number;
  /** Measured containing radius, CROW metres — already a bound, so never OUTER_SIGMA_K-inflated. */
  radiusCrowMeters: number;
  source: string;
}

const clampMeters = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));


type AnyHint = ParsedRentalData['locationHint'];

/**
 * Choose which of the ad's anchors leads, by DISTANCE rather than by the order the model emitted.
 *
 * A claim of "at/under the building" (anchorDistanceMeters 0) pins the flat outright; "N minutes to
 * a station across town" only draws a ring around that station. The parse prompt already ranks them
 * that way and the model does not reliably comply: on the ad that prompted this work it led with
 * "5 minut do stacji metra Dworzec Wileński" — a TRAIN time to a station 3.3 km away, which then
 * contradicted the map pin — and demoted "Osiedle ma własny przystanek kolejowy Warszawa
 * Zacisze-Wilno", distance 0 and the single most informative line in the ad.
 *
 * Promoting is what makes that line usable at all. The primary anchor is geocoded when it is not a
 * known metro station; an extra is only ever matched offline against the metro table, so a RAIL
 * stop like Zacisze-Wilno is silently dropped while it stays an extra.
 *
 * Whatever is displaced is returned in `demoted` and still becomes a ring, so reordering never
 * loses evidence — it only changes which claim gets the geocode.
 */
export function pickPrimaryAnchor(
  primary: AnyHint | undefined,
  extras: AnyHint[] | undefined,
  city: string,
  district?: string | null,
): { hint: AnyHint | undefined; demoted: AnyHint[] } {
  const atBuilding = (h: AnyHint) => (h.anchorDistanceMeters ?? 0) === 0;
  // Only displace a primary that is genuinely worse: one quoting a real distance to somewhere else.
  if (!primary || atBuilding(primary)) return { hint: primary, demoted: [] };

  const promoted = (extras ?? []).find((h) =>
    h != null && atBuilding(h) && isUsableDescriptionLocationHint(h, city, district));
  return promoted ? { hint: promoted, demoted: [primary] } : { hint: primary, demoted: [] };
}

/** Collect every candidate point (platform pin, geocoded street, geocoded description anchor) plus
 *  an optional metro annulus. A transit_stop naming a known station is a CONSTRAINT, not a point. */
async function gatherLocationCandidates(
  listing: Listing,
  parsed?: Pick<ParsedRentalData, 'addressHint' | 'locationHint' | 'extraLocationHints'> | null,
): Promise<{ candidates: LocCandidate[]; constraint: MetroConstraint | null; extraConstraints: MetroConstraint[]; areas: AreaConstraint[]; unverifiedEvidence: string | null }> {
  const candidates: LocCandidate[] = [];
  const areas: AreaConstraint[] = [];
  const extraConstraints: MetroConstraint[] = [];
  let constraint: MetroConstraint | null = null;
  let unverifiedEvidence: string | null = null;

  // Coordinates we DERIVED on an earlier pass and persisted (see Listing.coordsOuterRadiusMeters).
  // Held back rather than pushed here: they were computed from the same street/description evidence
  // this pass re-derives below, so they are not an independent source. Fusing both would count one
  // piece of evidence twice and report a point tighter than the evidence supports — which, now that
  // the gates hard-reject from the optimistic edge, means deleting listings for distances they may
  // not have. Used only as a FALLBACK when this pass produces no text-derived candidate (e.g. the
  // parse varied and dropped the addressHint), and always at the uncertainty it actually had.
  const derivedPin = listing.lat != null && listing.lng != null && listing.coordsOuterRadiusMeters != null
    ? {
        lat: listing.lat, lng: listing.lng,
        // Invert the stored 2σ route radius back to the ~1σ crow σ the fusion works in.
        sigma: clampMeters((listing.coordsOuterRadiusMeters / WALK_DETOUR_FACTOR) / OUTER_SIGMA_K, 25, 20_000),
        reliability: 0.8, precisionFloor: 'street' as LocationPrecision,
        source: 'уточнённые координаты с прошлого прохода', evidence: null,
      } satisfies LocCandidate
    : null;

  // Platform map pin. OLX self-declares precision via show_detailed (coordsPrecise): a precise
  // seller pin is building-accurate; a fuzzed one is only a neighborhood centroid. (Otodom pins
  // are returned as exact earlier; anything here with coordsPrecise unset is treated as fuzzy.)
  if (listing.lat != null && listing.lng != null && derivedPin == null) {
    candidates.push(listing.coordsPrecise
      ? { lat: listing.lat, lng: listing.lng, sigma: 120, reliability: 0.85, precisionFloor: 'street', source: 'точная метка с площадки', evidence: null }
      : { lat: listing.lat, lng: listing.lng, sigma: 1800, reliability: 0.4, precisionFloor: 'district', source: 'метка района с площадки', evidence: null });
  }

  // Street: platform street (Otodom) preferred, else the AI addressHint. A route-grade match is
  // kept as a coarse (~600 m) anchor rather than discarded — still better than a district centroid.
  const streetQuery = listing.street
    ? buildAddressFromListing({ street: listing.street, district: listing.district, city: listing.city })
    : parsed?.addressHint ? `${parsed.addressHint}, ${listing.city}, Polska` : null;
  if (streetQuery) {
    const geo = await geocodeAddress(streetQuery);
    if (geo) {
      const q = classifyGeocodePrecision(geo);
      // This branch asked for a STREET ADDRESS. An establishment answer means the geocoder did not
      // find one and matched a business instead — "Osiedle Wilno, Warszawa" returns `Wierna 24,
      // real_estate_agency`, an agency named after the estate and 1.8 km from it. That is a
      // non-answer, not a coarse answer, so it is recorded as unverified rather than believed.
      //
      // De-weighting it is not enough: fusion weights by reliability/σ², and an establishment's
      // tight σ beats a fuzzy pin's 1800 m however far its reliability is cut. At 0.3 it still
      // dragged the point 1.2 km and the card still misreported every metro distance.
      //
      // A landmark with a stated distance ("300 m od Galerii Północnej") is genuinely useful and is
      // handled in the locationHint branch below; it is not affected by this.
      if (q.weak) {
        unverifiedEvidence ??= parsed?.addressHint ?? listing.street ?? null;
      } else {
      candidates.push({
        lat: geo.lat, lng: geo.lng, sigma: candidateSigma(geo, q.uncertaintyMeters),
        reliability: listing.street ? 0.75 : 0.7,
        precisionFloor: q.precision,
        source: listing.street ? 'улица из объявления' : 'адрес из описания',
        evidence: listing.street ?? parsed?.addressHint ?? null,
      });
      }
      // The same match ALSO bounds the flat: the geocoder measured the area it matched, and the
      // flat is inside it. Kept as a containment constraint so it can tighten the fused point
      // instead of only inflating this candidate's σ.
      // Containment asserts "the flat is INSIDE this". True of a neighbourhood or a street, false
      // of an office, so a weak match contributes no area however tidy its bounds box looks.
      if (!q.weak && geo.areaRadiusMeters != null && geo.areaRadiusMeters > 0) {
        areas.push({
          lat: geo.lat, lng: geo.lng, radiusCrowMeters: geo.areaRadiusMeters,
          source: listing.street ? 'граница улицы' : 'граница участка из описания',
        });
      }
    } else {
      unverifiedEvidence ??= parsed?.addressHint ?? null;
    }
  }

  // AI description anchor. A transit_stop naming a known station → radial constraint (below);
  // any other geocodable anchor → a point candidate.
  //
  // PICK THE ANCHOR BY DISTANCE, not by the order the model happened to emit. A claim of "at/under
  // the building" (anchorDistanceMeters 0) pins the flat outright; a claim of "N minutes to a
  // station across town" only draws a ring. The prompt already ranks them that way, and the model
  // does not always comply — on the ad that prompted this work it made "5 minut do stacji metra
  // Dworzec Wileński" primary (a TRAIN time, 3.3 km away, which then contradicted the pin) and
  // demoted "Osiedle ma własny przystanek kolejowy Warszawa Zacisze-Wilno" — distance 0, the single
  // most informative line in the ad — into the extras, where it was dropped for not being a metro.
  //
  // Promoting costs nothing extra: the primary path already geocodes a non-metro anchor, whereas
  // extras are only ever matched offline against the metro table.
  const { hint, demoted } = pickPrimaryAnchor(
    parsed?.locationHint, parsed?.extraLocationHints, listing.city, listing.district);
  if (hint && isUsableDescriptionLocationHint(hint, listing.city, listing.district)) {
    // findMetroStation's table is WARSAW-ONLY and matches on a bare name, so several ordinary Polish
    // words (Centrum, Politechnika, Bemowo…) collide with real Warsaw stations. Only treat a
    // transit_stop as a metro constraint for a Warsaw listing — otherwise a Kraków/Wrocław flat would
    // be pinned to a same-named Warsaw station ~250 km away (fabricating a Warsaw metro/commute block).
    // A non-Warsaw transit_stop falls through to the generic geocode-in-its-own-city anchor below.
    const cityLc = (listing.city ?? '').toLowerCase();
    const inWarsaw = cityLc.includes('warszaw') || cityLc.includes('warsaw');
    const station = hint.kind === 'transit_stop' && inWarsaw
      ? findMetroStation(hint.query.split(',')[0]?.trim() ?? hint.query)
      : null;
    if (station) {
      constraint = {
        station,
        // Both are ROUTE metres: the ad quotes walking distance, so the station footprint is
        // detour-scaled before it can act as the floor.
        distance: clampMeters(hint.anchorDistanceMeters ?? 0, 0, 50_000),
        margin: clampMeters(Math.max(STATION_FOOTPRINT_ROUTE_M, hint.uncertaintyMeters ?? 400), STATION_FOOTPRINT_ROUTE_M, 20_000),
        evidence: hint.evidence,
      };
    } else {
      const geo = await geocodeAddress(`${hint.query}, ${listing.city}, Polska`);
      const q0 = geo ? classifyGeocodePrecision(geo) : null;
      // An establishment answer here is the SAME trap the street branch guards, on the branch that
      // actually receives estate and landmark names — "Osiedle Wilno" is an `estate` hint, and the
      // agency that shares its name is what this geocode returns. Guarding only the street branch
      // left the motivating example itself reachable through a path that was never patched.
      if (geo && q0?.weak) {
        unverifiedEvidence ??= hint.evidence ?? hint.query;
      } else if (geo) {
        const q = q0!;
        const pointLike = hint.kind === 'address' || hint.kind === 'intersection';
        // A stated distance to a non-station anchor (a landmark N m away) widens it into an annulus;
        // fold that distance into sigma so it stays a usable — if coarse — point candidate.
        const anchorDist = clampMeters(hint.anchorDistanceMeters ?? 0, 0, 50_000);
        const baseUnc = Math.max(
          hint.uncertaintyMeters ?? HINT_KIND_DEFAULT_UNC[hint.kind],
          candidateSigma(geo, pointLike ? q.uncertaintyMeters : geocodeAreaUncertainty(geo)),
        );
        candidates.push({
          lat: geo.lat, lng: geo.lng,
          sigma: clampMeters(Math.max(baseUnc, anchorDist), 50, 20_000),
          reliability: pointLike ? 0.65 : 0.5,
          precisionFloor: pointLike ? q.precision : 'approximate',
          source: `ориентир из описания (${HINT_KIND_LABEL[hint.kind]})`,
          evidence: hint.evidence,
        });
      } else {
        unverifiedEvidence ??= hint.evidence ?? hint.query;
      }
    }
  } else if (hint?.query || hint?.evidence) {
    unverifiedEvidence ??= hint.evidence ?? hint.query;
  }

  // FURTHER rings. Every other distance claim in the ad is another circle the flat sits on, and
  // circles intersect: a second "N min do X" cuts the region down far more than any single anchor
  // can. Only station claims are taken here — they resolve offline against the verified table, so
  // an extra ring costs nothing and cannot invent a place. Non-station extras are left alone
  // rather than turned into more geocodes per listing.
  const cityLcExtra = (listing.city ?? '').toLowerCase();
  const inWarsawExtra = cityLcExtra.includes('warszaw') || cityLcExtra.includes('warsaw');
  for (const extra of [...demoted, ...(parsed?.extraLocationHints ?? [])]) {
    if (extra === hint) continue;   // promoted to primary; not independent corroboration
    if (!inWarsawExtra || extra.kind !== 'transit_stop' || !extra.query) continue;
    if (!isUsableDescriptionLocationHint(extra, listing.city, listing.district)) continue;
    const station = findMetroStation(extra.query.split(',')[0]?.trim() ?? extra.query);
    // Never the same ring twice: a duplicate would masquerade as independent corroboration and
    // tighten sigma on evidence already counted.
    if (!station || station.name === constraint?.station.name) continue;
    if (extraConstraints.some((c) => c.station.name === station.name)) continue;
    extraConstraints.push({
      station,
      distance: clampMeters(extra.anchorDistanceMeters ?? 0, 0, 50_000),
      margin: clampMeters(Math.max(STATION_FOOTPRINT_ROUTE_M, extra.uncertaintyMeters ?? 400), STATION_FOOTPRINT_ROUTE_M, 20_000),
      evidence: extra.evidence,
    });
  }

  // Fall back to the point an earlier pass derived only if this pass found nothing text-derived —
  // otherwise it would double-count the evidence that produced it (see `derivedPin` above).
  if (derivedPin && candidates.length === 0) candidates.push(derivedPin);

  // The district is CONTAINMENT evidence, and it holds whether or not a pin exists. It used to be
  // consulted only as a last-resort fallback (step 7), so a listing WITH a pin was never narrowed
  // by the district it sits in — evidence we already had, thrown away. Skipped when it cannot pay
  // for itself: with no candidate the fallback handles it, and a district box (Warsaw dzielnice run
  // 2–5 km) cannot tighten an area we already hold below DISTRICT_AREA_USEFUL_BELOW_M.
  // The district is a FLOOR, not an optimization: a listing filed under Targówek is in Targówek,
  // so no estimate for it may ever be vaguer than Targówek. The 10.8 km card was 2.5x wider than
  // the district's own 4.3 km extent — an answer less certain than free structured data we already
  // held. Gathering it here makes that impossible by construction, whatever the next bug is.
  //
  // Skipped only when it cannot bind: a tighter area already holds a smaller bound, so the district
  // could not narrow anything and the geocode would be spent for nothing. Cached, and district
  // strings repeat across nearly every listing.
  // Point evidence counts too. A precise platform pin is ~120 m sigma, so its containing bound is
  // already far tighter than any dzielnica — geocoding the district for such a listing buys
  // nothing and was firing on every OLX listing that had a pin but no usable street text.
  const tightestArea = Math.min(
    Infinity,
    ...areas.map((a) => a.radiusCrowMeters),
    ...candidates.map((c) => OUTER_SIGMA_K * c.sigma),
  );
  if (tightestArea > DISTRICT_AREA_USEFUL_BELOW_M && (listing.district || listing.city)) {
    const geo = await geocodeAddress(
      buildAddressFromListing({ street: null, district: listing.district, city: listing.city }));
    if (geo) {
      areas.push({
        lat: geo.lat, lng: geo.lng,
        // A geocoder that returns no bounds box must not silently drop the floor; fall back to the
        // same assumed extent the last-resort district branch uses.
        radiusCrowMeters: geo.areaRadiusMeters && geo.areaRadiusMeters > 0
          ? geo.areaRadiusMeters : ASSUMED_AREA_RADIUS_M,
        source: listing.district ? 'граница района' : 'граница города',
      });
    }
  }

  return { candidates, constraint, extraConstraints, areas, unverifiedEvidence };
}

/** Fuse agreeing candidates (inverse-variance weighted) and apply the metro annulus constraint.
 *  Exported (pure) so the clustering/combine/constraint math can be unit-tested directly. */
export function fuseLocationCandidates(
  candidates: LocCandidate[],
  constraint: MetroConstraint | null,
  areas: AreaConstraint[] = [],
  extraConstraints: MetroConstraint[] = [],
): EnrichedLocation {
  // Exported for direct unit testing, so it cannot rely on its production caller's guard.
  if (candidates.length === 0) {
    return {
      lat: null, lng: null, precision: 'none', anchorDistanceMeters: 0,
      uncertaintyMeters: 0, outerRadiusMeters: 0, source: 'нет данных о месте', evidence: null,
    };
  }
  const primary = [...candidates].sort((a, b) => b.reliability / b.sigma - a.reliability / a.sigma)[0]!;
  const cluster = candidates.filter((c) =>
    c === primary || haversineMeters(primary.lat, primary.lng, c.lat, c.lng) <= AGREE_K * (primary.sigma + c.sigma));

  const lat0 = primary.lat, lng0 = primary.lng;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  let sw = 0, sx = 0, sy = 0, invVar = 0;
  for (const c of cluster) {
    const w = c.reliability / (c.sigma * c.sigma);
    sx += w * (c.lng - lng0) * cosLat * 111_320;
    sy += w * (c.lat - lat0) * 110_540;
    sw += w;
    invVar += 1 / (c.sigma * c.sigma);
  }
  const lat = lat0 + sy / sw / 110_540;
  const lng = lng0 + sx / sw / (cosLat * 111_320);
  let sigma = Math.sqrt(1 / invVar);
  // Inverse-variance combine assumes the inputs agree; if the cluster is actually spread out
  // (two "precise" points 360 m apart), don't report tighter than that spread. Inflate by the
  // weighted RMS distance of members from the fused point.
  if (cluster.length > 1) {
    let sse = 0;
    for (const c of cluster) {
      const dm = haversineMeters(lat, lng, c.lat, c.lng);
      sse += (c.reliability / (c.sigma * c.sigma)) * dm * dm;
    }
    const spread = Math.sqrt(sse / sw);
    // A spread the BEST source's own containing bound cannot explain does not mean the flat is
    // smeared across the gap — it means one of these fixes is wrong (a mis-geocoded addressHint
    // sitting kilometres from a real platform pin). Covering both leaves us vaguer than simply
    // trusting the best source, and that inflated radius is not harmless: once it exceeds the
    // distance to a place, `optimisticMeters` returns 0 for every candidate, every range reads
    // "0 – something", and the distance gates lose the lower bound they judge on.
    if (spread > OUTER_SIGMA_K * primary.sigma) {
      const alone = fuseLocationCandidates([primary], constraint, areas, extraConstraints);
      return { ...alone, source: `${alone.source}; расхождение ${Math.round(spread)} м отброшено` };
    }
    sigma = Math.max(sigma, spread);
  }
  let note = '';

  // Metro stations as radial CONSTRAINTS: does the fused point genuinely sit on each claimed ring?
  // Rings intersect, so every corroborating one tightens further — "5 min do Zacisza" and "10 min
  // do Trockiej" together localize a flat far better than either alone, which is the whole reason
  // the extras are parsed instead of discarded as second-best anchors.
  //
  // The PRIMARY ring keeps its original disagree-and-widen behaviour; a contradicting EXTRA is
  // dropped instead. An extra is bonus evidence, and one bad parse among several must not be able
  // to degrade an estimate the other evidence already established.
  // Rings the fused point actually sits on. A contradicted ring is a FALSE CLAIM, and the
  // containment pass below must never see it: that pass maximises satisfied evidence, so offering
  // it a ring the point cannot reach makes moving the point 3 km the highest-scoring answer. It did
  // exactly that — reporting Dworzec Wileński as the nearest station, at 695 m "precision", for a
  // flat in Targówek. Layer 1 decides what is credible; layer 2 only intersects what survived.
  const credibleRings: MetroConstraint[] = [];
  for (const [index, ring] of [constraint, ...extraConstraints].filter((c): c is MetroConstraint => c != null).entries()) {
    const isPrimary = index === 0 && constraint != null;
    const crowToStation = haversineMeters(lat, lng, ring.station.lat, ring.station.lng);
    // `constraint.distance` and `.margin` are ad-quoted WALKING metres, so the separation has to be
    // converted before they can be compared. Comparing a crow distance against a route one made a
    // perfectly corroborating candidate look ~23% off — enough to flag agreeing evidence as
    // "расхождение" on the card once the stated distance passed ~2.5 km.
    const d = walkMetersFromCrow(crowToStation);
    const discrepancy = Math.abs(d - ring.distance);
    // Corroborate only when the point is really near the annulus — the point's own sigma must NOT
    // buy agreement — and never tighten below the actual positional discrepancy. Corroboration can
    // only hold-or-tighten, never inflate: the 120 m "don't over-trust a metro hint" floor is
    // capped at the incoming sigma (Math.min(120, sigma)), so a point already tighter than 120 m
    // from independent evidence (precise pin + rooftop street) is preserved, not widened back to 120.
    // σ is a CROW radius, so the route-metre discrepancy converts back before it can size σ.
    const agreementBandRoute = ring.margin + STATION_FOOTPRINT_ROUTE_M;
    const discrepancyCrow = discrepancy / WALK_DETOUR_FACTOR;
    const agreementBandCrow = agreementBandRoute / WALK_DETOUR_FACTOR;
    if (discrepancy <= agreementBandRoute) {
      sigma = clampMeters(Math.max(discrepancyCrow, Math.min(sigma, agreementBandCrow)), Math.min(120, sigma), sigma);
      credibleRings.push(ring);
      note += `; ~${Math.round(d)} м до ${ring.station.name}`;
    } else if (isPrimary) {
      // CONTRADICTED, so distrust it — do not widen to cover it. The old behaviour set sigma to the
      // discrepancy, which is how "5 minut do stacji metra Dworzec Wileński" (a station 3.4 km
      // away, i.e. marketing) turned a ~900 m estimate into 10.8 km: adding evidence made the
      // answer five times worse, and the card became "~0 м–11,4 км".
      //
      // Widening was never the right shape anyway. A contradiction means two MUTUALLY EXCLUSIVE
      // possibilities — near the pin, or near the station — and the truth is the union of two small
      // areas, not one disc covering both and everything between, which is mostly places the flat
      // certainly is not. So the point is kept, the claim is flagged, and the gate's existing
      // `uncertain` path keeps the listing with a warning instead of deleting it.
      //
      // The contract this has to honour is "not falsely TIGHTENED" — and nothing here tightens.
      note += `; расхождение с ${ring.station.name}`;
    } else {
      note += `; ${ring.station.name} не подтвердилась`;
    }
  }

  // Honest precision follows the final uncertainty (an Otodom-exact candidate stays exact).
  let precision: LocationPrecision;
  if (cluster.some((c) => c.precisionFloor === 'exact')) precision = 'exact';
  else if (sigma <= 200) precision = 'street';
  else if (sigma <= 800) precision = 'approximate';
  else precision = 'district';

  let bestLat = lat, bestLng = lng, bestRadiusCrow = OUTER_SIGMA_K * sigma, refinedBy: string[] = [];

  // CONTAINMENT. An area is evidence of the form "the flat is inside this", and there are exactly
  // two cases:
  //
  //   * CONTAINED (d + r <= R) — the area disc lies wholly inside the disc we hold, so the
  //     intersection IS that area. Its centre and radius are the answer, and adopting both is
  //     sound: nothing outside it was ever possible.
  //   * merely OVERLAPPING — the lens reaches the far edge of our own disc (that edge point is
  //     still inside the area), so NO disc centred where we are can be smaller than R. There is
  //     nothing to win here without moving the point onto a synthetic centre, and a district
  //     centroid is not evidence about where the flat is.
  //
  // A grid solver used to sit here and reported tighter numbers for the overlapping case — 3380 m
  // where 4680 m is the true bound. It was not finding a better answer; it was clamping the radius
  // to the area's own `r` about a point `d` away, the same unsound `r`-instead-of-`d + r` step this
  // loop had. Tighter-looking and wrong, on the number that gates deletion.
  for (const area of [...areas].sort((a, b) => a.radiusCrowMeters - b.radiusCrowMeters)) {
    const d = haversineMeters(bestLat, bestLng, area.lat, area.lng);
    if (d + area.radiusCrowMeters <= bestRadiusCrow) {
      bestLat = area.lat;
      bestLng = area.lng;
      bestRadiusCrow = area.radiusCrowMeters;
      if (!refinedBy.includes(area.source)) refinedBy = [...refinedBy, area.source];
    }
  }

  // A tighter region is a tighter σ. The radius is a CONTAINING bound, so the equivalent σ divides
  // back by OUTER_SIGMA_K — keeping `precision` consistent with the region actually reported.
  const finalSigma = Math.min(sigma, bestRadiusCrow / OUTER_SIGMA_K);
  if (finalSigma < sigma) {
    precision = cluster.some((c) => c.precisionFloor === 'exact') ? 'exact'
      : finalSigma <= 200 ? 'street'
      : finalSigma <= 800 ? 'approximate'
      : 'district';
  }

  const evidence = cluster.map((c) => c.evidence).find((e) => e != null) ?? constraint?.evidence ?? null;
  return {
    lat: bestLat, lng: bestLng, precision,
    anchorDistanceMeters: 0,
    uncertaintyMeters: Math.round(finalSigma),
    outerRadiusMeters: capOuter(walkMetersFromCrow(bestRadiusCrow)),
    source: [...new Set(cluster.map((c) => c.source))].join(' + ') + note
      + (refinedBy.length > 0 ? `; сужено по ${refinedBy.map((r) => `«${r}»`).join(', ')}` : ''),
    evidence,
  };
}

export async function enrichListingLocation(
  listing: Listing,
  parsed?: Pick<ParsedRentalData, 'addressHint' | 'locationHint'> | null,
): Promise<EnrichedLocation> {
  // 1. Otodom search results omit coordinates — the detail page has exact ones.
  if (listing.platform === 'otodom' && (listing.lat == null || listing.lng == null)) {
    try {
      const detail = await fetchOtodomDetail(listing.url);
      if (detail?.lat != null && detail?.lng != null) {
        return { lat: detail.lat, lng: detail.lng, precision: 'exact', anchorDistanceMeters: 0, uncertaintyMeters: 0, outerRadiusMeters: 0, source: 'координаты Otodom', evidence: null };
      }
      if (detail?.street) {
        const geo = await geocodeAddress(buildAddressFromListing(detail));
        const quality0 = geo ? classifyGeocodePrecision(geo) : null;
        // A weak match must not take this early return: it bypasses the fusion pipeline entirely,
        // so there is no pin, no district and no contradiction check left to catch a business that
        // merely shares the street's name. Falling through lets the normal path judge it.
        if (geo && quality0 && !quality0.weak) {
          const quality = quality0;
          return {
            lat: geo.lat,
            lng: geo.lng,
            precision: quality.precision,
            anchorDistanceMeters: 0,
            uncertaintyMeters: quality.uncertaintyMeters,
            outerRadiusMeters: geocodeOuterRadius(geo, quality.uncertaintyMeters),
            source: 'адрес Otodom',
            evidence: detail.street,
          };
        }
      }
    } catch (e) {
      console.warn(`[location] Otodom detail fetch failed for ${listing.url}:`, e instanceof Error ? e.message : e);
    }
  }

  // 2. Otodom already carries exact detail-page coordinates.
  if (listing.platform === 'otodom' && listing.lat != null && listing.lng != null) {
    return { lat: listing.lat, lng: listing.lng, precision: 'exact', anchorDistanceMeters: 0, uncertaintyMeters: 0, outerRadiusMeters: 0, source: 'координаты Otodom', evidence: null };
  }

  // 3. Fuse every available signal (platform pin + geocoded street + description anchor) into the
  // tightest honest point. A named metro station acts as a radial CONSTRAINT that confirms/tightens
  // the point rather than replacing it — so a precise OLX pin + street + "70 m from Metro X" collapse
  // to the building, not the station centroid.
  const { candidates, constraint, extraConstraints, areas, unverifiedEvidence: unverifiedDescriptionEvidence } =
    await gatherLocationCandidates(listing, parsed);
  if (candidates.length > 0) {
    return fuseLocationCandidates(candidates, constraint, areas, extraConstraints);
  }

  // NOT DONE HERE: with no point candidate, two rings cross at TWO points — mirror images across
  // the line joining the stations, often a kilometre apart. Nothing in this branch says which side
  // the flat is on, so picking one would be a coin flip dressed as precision. The crossing is used
  // only in `fuseLocationCandidates`, where an existing point disambiguates it. Wiring it here
  // needs a real tiebreaker (the district polygon the flat sits in).

  // 4. No point candidate, but a "N m from Metro X" claim still localizes the flat to a ring near the
  // station — keep the annulus (point = station, anchorDistanceMeters = the claimed distance).
  if (constraint) {
    return {
      lat: constraint.station.lat,
      lng: constraint.station.lng,
      precision: 'approximate',
      // Ads quote WALKING distance ("500 m od metra"), which is already route metres — the
      // parse copies it verbatim, so it must not be detour-scaled a second time here.
      anchorDistanceMeters: constraint.distance,
      // The field's contract is CROW metres; the margin is ad-quoted walking metres.
      uncertaintyMeters: Math.round(constraint.margin / WALK_DETOUR_FACTOR),
      // A station spans ~STATION_FOOTPRINT_M of entrances, so the honest ring is margin + that,
      // in route metres.
      //
      // NO DISTRICT FLOOR HERE, deliberately. On this branch the pair (anchorDistanceMeters,
      // outerRadiusMeters) is an ANNULUS: `bandFor` reads it as `distance ± outer`, so `outer` is a
      // band half-width, not a radius from a point. Clamping it with a district's disc radius is a
      // category error — the two measure different things — and an earlier attempt here did exactly
      // that, shrinking the half-width to an unrelated quantity and reporting the flat as far
      // closer to the station than any evidence said. Bounding a ring by an area needs the area to
      // clip the ring's own edges, which this representation cannot express.
      outerRadiusMeters: capOuter(constraint.margin + STATION_FOOTPRINT_ROUTE_M),
      source: `ориентир из описания (остановка) ~${constraint.distance} м до ${constraint.station.name}`,
      evidence: constraint.evidence,
    };
  }

  // 7. Last resort — geocode the district/city centroid. The gates still enforce their limits
  // here (from the optimistic edge of the area), so the radius must be the area's REAL extent:
  // Warsaw dzielnice range from ~15 km² (Śródmieście) to ~80 km² (Wawer), and a flat 2.5 km
  // guess would delete flats in the centre-facing corner of a large outer district.
  if (listing.district || listing.city) {
    const geo = await geocodeAddress(buildAddressFromListing({ street: null, district: listing.district, city: listing.city }));
    if (geo) {
      const areaRadius = geo.areaRadiusMeters ?? ASSUMED_AREA_RADIUS_M;
      return {
        lat: geo.lat,
        lng: geo.lng,
        precision: 'district',
        anchorDistanceMeters: 0,
        uncertaintyMeters: areaRadius,
        outerRadiusMeters: capOuter(walkMetersFromCrow(areaRadius)),
        source: unverifiedDescriptionEvidence
          ? 'центр района или города; ориентир из описания не подтверждён'
          : 'центр района или города',
        evidence: unverifiedDescriptionEvidence,
      };
    }
  }

  return {
    lat: null,
    lng: null,
    precision: 'none',
    anchorDistanceMeters: 0,
    uncertaintyMeters: 0,
    outerRadiusMeters: 0,
    source: 'нет данных о месте',
    evidence: unverifiedDescriptionEvidence,
  };
}
