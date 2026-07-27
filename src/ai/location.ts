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

  // 3. Geocode a precise platform street. Platform district is useful only for a
  // platform-owned address; it can be wrong on OLX and must not contaminate an AI hint.
  if (listing.street) {
    const geo = await geocodeAddress(buildAddressFromListing({ street: listing.street, district: listing.district, city: listing.city }));
    if (geo) {
      const quality = classifyGeocodePrecision(geo);
      return {
        lat: geo.lat,
        lng: geo.lng,
        precision: quality.precision,
        anchorDistanceMeters: 0,
        uncertaintyMeters: quality.uncertaintyMeters,
        source: 'улица из объявления',
        evidence: listing.street,
      };
    }
  }

  // 4. Use the AI's structured, evidence-bearing description anchor. This may be a named building,
  // intersection, stop, or landmark; its uncertainty radius prevents false exactness.
  const hint = parsed?.locationHint;
  let unverifiedDescriptionEvidence: string | null = null;
  if (hint && isUsableDescriptionLocationHint(hint, listing.city, listing.district)) {
    const geo = await geocodeAddress(`${hint.query}, ${listing.city}, Polska`);
    if (geo) {
      const defaults: Record<Exclude<ParsedRentalData['locationHint']['kind'], 'none'>, number> = {
        address: 100,
        intersection: 175,
        building: 250,
        estate: 800,
        transit_stop: 400,
        landmark: 650,
        neighborhood: 1800,
      };
      const geocodeQuality = classifyGeocodePrecision(geo);
      const pointLikeHint = hint.kind === 'address' || hint.kind === 'intersection';
      return {
        lat: geo.lat,
        lng: geo.lng,
        precision: pointLikeHint ? geocodeQuality.precision : 'approximate',
        anchorDistanceMeters: Math.max(0, Math.min(50_000, hint.anchorDistanceMeters ?? 0)),
        uncertaintyMeters: Math.max(
          50,
          Math.min(
            20_000,
            Math.max(
              hint.uncertaintyMeters ?? defaults[hint.kind],
              pointLikeHint ? geocodeQuality.uncertaintyMeters : geocodeAreaUncertainty(geo),
            ),
          ),
        ),
        source: `ориентир из описания (${{
          address: 'адрес',
          intersection: 'перекрёсток',
          building: 'здание',
          estate: 'жилой массив',
          transit_stop: 'остановка',
          landmark: 'ориентир',
          neighborhood: 'район',
        }[hint.kind]})`,
        evidence: hint.evidence,
      };
    }
    unverifiedDescriptionEvidence = hint.evidence ?? hint.query;
  } else if (hint?.query || hint?.evidence) {
    unverifiedDescriptionEvidence = hint.evidence ?? hint.query;
  }

  // 5. Legacy fallback: an exact address/intersection extracted from the description.
  // It must not override a successfully geocoded structured location hint.
  if (parsed?.addressHint) {
    const geo = await geocodeAddress(`${parsed.addressHint}, ${listing.city}, Polska`);
    if (geo) {
      const quality = classifyGeocodePrecision(geo);
      // addressHint promises an exact address/intersection. A route/area/partial
      // Google match violates that contract and must fall through to district data.
      if (quality.precision === 'street') {
        return {
          lat: geo.lat,
          lng: geo.lng,
          precision: quality.precision,
          anchorDistanceMeters: 0,
          uncertaintyMeters: quality.uncertaintyMeters,
          source: 'адрес из описания',
          evidence: parsed.addressHint,
        };
      }
    }
    unverifiedDescriptionEvidence ??= parsed.addressHint;
  }

  // 6. OLX coordinates exist but are district-center (fuzzy).
  if (listing.lat != null && listing.lng != null) {
    return {
      lat: listing.lat,
      lng: listing.lng,
      precision: 'district',
      anchorDistanceMeters: 0,
      uncertaintyMeters: 2000,
      source: unverifiedDescriptionEvidence
        ? 'метка района с площадки; ориентир из описания не подтверждён'
        : 'метка района с площадки',
      evidence: unverifiedDescriptionEvidence,
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
