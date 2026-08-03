// Shared coordinate-trust logic for cached rental listings.
//
// cacheListing overwrites listing_json UNCONDITIONALLY on (platform, platform_id) conflict, so any
// cache write can silently downgrade a row that already holds address-grade coordinates. show_listing
// re-scores the metro / Warszawa Centralna block only from coords it TRUSTS, so a downgrade drops
// those lines on re-show. These helpers centralise the trust test + the "never downgrade" merge so
// every write site (find_rentals, the monitor's early + delivery caches) behaves identically.

import type { Listing } from '../types.js';

/** Coords are trustworthy for re-scoring when present AND either the platform pin was precise
 *  (coordsPrecise — set true when we persist a geocoded exact/street result) or the platform is
 *  Otodom (detail-page coords). This is exactly the gate show_listing uses to decide whether to
 *  recompute the location block. */
export function coordsTrustworthy(l: Pick<Listing, 'lat' | 'coordsPrecise' | 'platform'>): boolean {
  return l.lat != null && (l.coordsPrecise === true || l.platform === 'otodom');
}

/** Carry a prior cached row's trustworthy coords onto `current` when `current`'s own coords are NOT
 *  trustworthy — so a less-precise pass (a fuzzy OLX pin, an approximate/failed geocode) can never
 *  overwrite coords a richer pass already persisted. Mutates `current`; no-op when `current` is
 *  already trustworthy or `prior` isn't. */
export function preserveTrustworthyCoords(current: Listing, prior: Listing | null | undefined): void {
  if (prior && coordsTrustworthy(prior) && !coordsTrustworthy(current)) {
    current.lat = prior.lat;
    current.lng = prior.lng;
    current.coordsPrecise = prior.coordsPrecise;
  }
}
