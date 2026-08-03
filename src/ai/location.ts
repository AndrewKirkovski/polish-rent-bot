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
import { findMetroStation, haversineMeters } from '../geo/metro.js';
import { fetchOtodomDetail } from '../crawlers/otodom.js';

export interface EnrichedLocation {
  lat: number | null;
  lng: number | null;
  precision: LocationPrecision;
  anchorDistanceMeters: number;
  uncertaintyMeters: number;
  source: string;
  evidence: string | null;
}

export function classifyGeocodePrecision(
  geo: Pick<GeocodedLocation, 'locationType' | 'partialMatch' | 'resultTypes'>,
): { precision: 'street' | 'approximate'; uncertaintyMeters: number } {
  const types = new Set(geo.resultTypes);
  const addressType = ['street_address', 'premise', 'subpremise', 'intersection']
    .some((type) => types.has(type));
  const addressGeometry = geo.locationType === 'ROOFTOP' || geo.locationType === 'RANGE_INTERPOLATED';
  const intersection = types.has('intersection');
  if (!geo.partialMatch && (intersection || (addressType && addressGeometry))) {
    return { precision: 'street', uncertaintyMeters: geo.locationType === 'ROOFTOP' ? 50 : 125 };
  }
  if (geo.partialMatch) return { precision: 'approximate', uncertaintyMeters: 1500 };
  if (types.has('route')) return { precision: 'approximate', uncertaintyMeters: 600 };
  if (types.has('neighborhood') || types.has('sublocality')) {
    return { precision: 'approximate', uncertaintyMeters: 1500 };
  }
  if (types.has('locality') || types.has('administrative_area_level_2')) {
    return { precision: 'approximate', uncertaintyMeters: 2500 };
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
const STATION_FOOTPRINT_M = 150; // a metro "point" really spans its entrances

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

const clampMeters = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Collect every candidate point (platform pin, geocoded street, geocoded description anchor) plus
 *  an optional metro annulus. A transit_stop naming a known station is a CONSTRAINT, not a point. */
async function gatherLocationCandidates(
  listing: Listing,
  parsed?: Pick<ParsedRentalData, 'addressHint' | 'locationHint'> | null,
): Promise<{ candidates: LocCandidate[]; constraint: MetroConstraint | null; unverifiedEvidence: string | null }> {
  const candidates: LocCandidate[] = [];
  let constraint: MetroConstraint | null = null;
  let unverifiedEvidence: string | null = null;

  // Platform map pin. OLX self-declares precision via show_detailed (coordsPrecise): a precise
  // seller pin is building-accurate; a fuzzed one is only a neighborhood centroid. (Otodom pins
  // are returned as exact earlier; anything here with coordsPrecise unset is treated as fuzzy.)
  if (listing.lat != null && listing.lng != null) {
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
      candidates.push({
        lat: geo.lat, lng: geo.lng, sigma: q.uncertaintyMeters,
        reliability: listing.street ? 0.75 : 0.7, precisionFloor: q.precision,
        source: listing.street ? 'улица из объявления' : 'адрес из описания',
        evidence: listing.street ?? parsed?.addressHint ?? null,
      });
    } else {
      unverifiedEvidence ??= parsed?.addressHint ?? null;
    }
  }

  // AI description anchor. A transit_stop naming a known station → radial constraint (below);
  // any other geocodable anchor → a point candidate.
  const hint = parsed?.locationHint;
  if (hint && isUsableDescriptionLocationHint(hint, listing.city, listing.district)) {
    const station = hint.kind === 'transit_stop'
      ? findMetroStation(hint.query.split(',')[0]?.trim() ?? hint.query)
      : null;
    if (station) {
      constraint = {
        station,
        distance: clampMeters(hint.anchorDistanceMeters ?? 0, 0, 50_000),
        margin: clampMeters(Math.max(STATION_FOOTPRINT_M, hint.uncertaintyMeters ?? 400), STATION_FOOTPRINT_M, 20_000),
        evidence: hint.evidence,
      };
    } else {
      const geo = await geocodeAddress(`${hint.query}, ${listing.city}, Polska`);
      if (geo) {
        const q = classifyGeocodePrecision(geo);
        const pointLike = hint.kind === 'address' || hint.kind === 'intersection';
        // A stated distance to a non-station anchor (a landmark N m away) widens it into an annulus;
        // fold that distance into sigma so it stays a usable — if coarse — point candidate.
        const anchorDist = clampMeters(hint.anchorDistanceMeters ?? 0, 0, 50_000);
        const baseUnc = Math.max(hint.uncertaintyMeters ?? HINT_KIND_DEFAULT_UNC[hint.kind], pointLike ? q.uncertaintyMeters : geocodeAreaUncertainty(geo));
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

  return { candidates, constraint, unverifiedEvidence };
}

/** Fuse agreeing candidates (inverse-variance weighted) and apply the metro annulus constraint.
 *  Exported (pure) so the clustering/combine/constraint math can be unit-tested directly. */
export function fuseLocationCandidates(candidates: LocCandidate[], constraint: MetroConstraint | null): EnrichedLocation {
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
    sigma = Math.max(sigma, Math.sqrt(sse / sw));
  }
  let note = '';

  // Metro station as a radial CONSTRAINT: does the fused point genuinely sit on the claimed annulus?
  if (constraint) {
    const d = haversineMeters(lat, lng, constraint.station.lat, constraint.station.lng);
    const discrepancy = Math.abs(d - constraint.distance);
    // Corroborate only when the point is really near the annulus — the point's own sigma must NOT
    // buy agreement — and never tighten below the actual positional discrepancy. Corroboration can
    // only hold-or-tighten, never inflate: the 120 m "don't over-trust a metro hint" floor is
    // capped at the incoming sigma (Math.min(120, sigma)), so a point already tighter than 120 m
    // from independent evidence (precise pin + rooftop street) is preserved, not widened back to 120.
    if (discrepancy <= constraint.margin + STATION_FOOTPRINT_M) {
      sigma = clampMeters(Math.max(discrepancy, Math.min(sigma, constraint.margin + STATION_FOOTPRINT_M)), Math.min(120, sigma), sigma);
      note = `; ~${Math.round(d)} м до ${constraint.station.name}`;
    } else {
      sigma = Math.max(sigma, discrepancy); // sources disagree → widen + flag
      note = `; расхождение с ${constraint.station.name}`;
    }
  }

  // Honest precision follows the final uncertainty (an Otodom-exact candidate stays exact).
  let precision: LocationPrecision;
  if (cluster.some((c) => c.precisionFloor === 'exact')) precision = 'exact';
  else if (sigma <= 200) precision = 'street';
  else if (sigma <= 800) precision = 'approximate';
  else precision = 'district';

  const evidence = cluster.map((c) => c.evidence).find((e) => e != null) ?? constraint?.evidence ?? null;
  return {
    lat, lng, precision,
    anchorDistanceMeters: 0,
    uncertaintyMeters: Math.round(sigma),
    source: [...new Set(cluster.map((c) => c.source))].join(' + ') + note,
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
        return { lat: detail.lat, lng: detail.lng, precision: 'exact', anchorDistanceMeters: 0, uncertaintyMeters: 0, source: 'координаты Otodom', evidence: null };
      }
      if (detail?.street) {
        const geo = await geocodeAddress(buildAddressFromListing(detail));
        if (geo) {
          const quality = classifyGeocodePrecision(geo);
          return {
            lat: geo.lat,
            lng: geo.lng,
            precision: quality.precision,
            anchorDistanceMeters: 0,
            uncertaintyMeters: quality.uncertaintyMeters,
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
    return { lat: listing.lat, lng: listing.lng, precision: 'exact', anchorDistanceMeters: 0, uncertaintyMeters: 0, source: 'координаты Otodom', evidence: null };
  }

  // 3. Fuse every available signal (platform pin + geocoded street + description anchor) into the
  // tightest honest point. A named metro station acts as a radial CONSTRAINT that confirms/tightens
  // the point rather than replacing it — so a precise OLX pin + street + "70 m from Metro X" collapse
  // to the building, not the station centroid.
  const { candidates, constraint, unverifiedEvidence: unverifiedDescriptionEvidence } =
    await gatherLocationCandidates(listing, parsed);
  if (candidates.length > 0) {
    return fuseLocationCandidates(candidates, constraint);
  }

  // 4. No point candidate, but a "N m from Metro X" claim still localizes the flat to a ring near the
  // station — keep the annulus (point = station, anchorDistanceMeters = the claimed distance).
  if (constraint) {
    return {
      lat: constraint.station.lat,
      lng: constraint.station.lng,
      precision: 'approximate',
      anchorDistanceMeters: constraint.distance,
      uncertaintyMeters: constraint.margin,
      source: `ориентир из описания (остановка) ~${constraint.distance} м до ${constraint.station.name}`,
      evidence: constraint.evidence,
    };
  }

  // 7. Last resort — geocode the district/city centroid.
  if (listing.district || listing.city) {
    const geo = await geocodeAddress(buildAddressFromListing({ street: null, district: listing.district, city: listing.city }));
    if (geo) {
      return {
        lat: geo.lat,
        lng: geo.lng,
        precision: 'district',
        anchorDistanceMeters: 0,
        uncertaintyMeters: 2500,
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
    source: 'нет данных о месте',
    evidence: unverifiedDescriptionEvidence,
  };
}
