// Enrich rental listings with detail-page data (Otodom) or phone (OLX).

import { fetchOtodomDetail } from '../crawlers/otodom.js';
import { fetchOlxPhone } from '../crawlers/olx.js';
import type { Listing } from '../types.js';

export async function enrichRentalListing(listing: Listing): Promise<Listing> {
  if (listing.platform === 'otodom') {
    try {
      const detail = await fetchOtodomDetail(listing.url);
      if (detail) return detail;
    } catch (err) {
      console.error(`[enrich] Otodom detail failed for ${listing.url}:`, err instanceof Error ? err.message : err);
    }
    return listing;
  }

  if (listing.platform === 'olx' && !listing.phone) {
    try {
      const phone = await fetchOlxPhone(listing.platformId);
      if (phone) return { ...listing, phone };
    } catch (err) {
      console.warn(`[enrich] OLX phone failed for ${listing.platformId}:`, err instanceof Error ? err.message : err);
    }
  }

  return listing;
}
