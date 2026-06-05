// Dedicated location-enrichment flow.
//
// Resolves the most precise coordinates available for a listing and labels the
// precision, so amenity/commute scoring isn't run against a vague district centroid:
//   - Otodom: search results omit coordinates; the detail page carries exact ones.
//   - OLX: the API never exposes the street, but the description often names it
//     (captured by the AI parse as `addressHint`) — geocode that for street-level precision.
//     OLX's own map coords are district-center, so they're treated as district-level only.

import type { Listing, LocationPrecision } from '../types.js';
import { geocodeAddress, buildAddressFromListing } from './maps.js';
import { fetchOtodomDetail } from '../crawlers/otodom.js';

export interface EnrichedLocation {
  lat: number | null;
  lng: number | null;
  precision: LocationPrecision;
}

export async function enrichListingLocation(
  listing: Listing,
  parsed?: { addressHint?: string | null } | null,
): Promise<EnrichedLocation> {
  // 1. Otodom search results omit coordinates — the detail page has exact ones.
  if (listing.platform === 'otodom' && (listing.lat == null || listing.lng == null)) {
    try {
      const detail = await fetchOtodomDetail(listing.url);
      if (detail?.lat != null && detail?.lng != null) {
        return { lat: detail.lat, lng: detail.lng, precision: 'exact' };
      }
      if (detail?.street) {
        const geo = await geocodeAddress(buildAddressFromListing(detail));
        if (geo) return { lat: geo.lat, lng: geo.lng, precision: 'street' };
      }
    } catch (e) {
      console.warn(`[location] Otodom detail fetch failed for ${listing.url}:`, e instanceof Error ? e.message : e);
    }
  }

  // 2. Otodom already carries exact detail-page coordinates.
  if (listing.platform === 'otodom' && listing.lat != null && listing.lng != null) {
    return { lat: listing.lat, lng: listing.lng, precision: 'exact' };
  }

  // 3. Geocode a precise street address — from the platform field or the AI-parsed hint.
  const street = listing.street ?? parsed?.addressHint ?? null;
  if (street) {
    const geo = await geocodeAddress(buildAddressFromListing({ street, district: listing.district, city: listing.city }));
    if (geo) return { lat: geo.lat, lng: geo.lng, precision: 'street' };
  }

  // 4. OLX coordinates exist but are district-center (fuzzy).
  if (listing.lat != null && listing.lng != null) {
    return { lat: listing.lat, lng: listing.lng, precision: 'district' };
  }

  // 5. Last resort — geocode the district/city centroid.
  if (listing.district || listing.city) {
    const geo = await geocodeAddress(buildAddressFromListing({ street: null, district: listing.district, city: listing.city }));
    if (geo) return { lat: geo.lat, lng: geo.lng, precision: 'district' };
  }

  return { lat: null, lng: null, precision: 'none' };
}
