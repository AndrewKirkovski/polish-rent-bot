// Cross-platform listing dedup via conservative fingerprint matching.

import type { Listing } from '../types.js';

const STOPWORDS = new Set([
  'na', 'do', 'w', 'z', 'od', 'i', 'a', 'o', 'u', 'the', 'for', 'mieszkanie', 'wynajem', 'pl', 'zł',
]);

export function stripDiacritics(s: string): string {
  return s.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l');
}

function titleKey(title: string): string {
  const tokens = stripDiacritics(title)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  return tokens.slice(0, 12).join(' ');
}

function jaccard(a: string, b: string): number {
  if (!a || !b) return 0;
  const sa = new Set(a.split(' '));
  const sb = new Set(b.split(' '));
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface ListingFingerprint {
  city: string;
  rooms: number | null;
  areaBucket: number;
  priceBucket: number;
  titleKey: string;
  streetKey: string;
}

export function fingerprintListing(
  listing: Listing,
  streetHint?: string | null,
): ListingFingerprint {
  // NOTE: district is deliberately EXCLUDED — the same flat cross-posted to OLX and
  // Otodom (or reposted) frequently carries a different/absent district label, so
  // keying on district would defeat the cross-platform match this dedup exists for.
  return {
    city: stripDiacritics(listing.city),
    rooms: listing.rooms,
    areaBucket: listing.area != null ? Math.round(listing.area / 5) * 5 : 0,
    priceBucket: Math.round(listing.price / 50) * 50,
    titleKey: titleKey(listing.title),
    streetKey: stripDiacritics(listing.street ?? streetHint ?? ''),
  };
}

export function fingerprintKey(fp: ListingFingerprint): string {
  return `${fp.city}|${fp.rooms ?? 'x'}|${fp.areaBucket}|${fp.priceBucket}|${fp.titleKey}`;
}

function bucketsClose(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

export function fingerprintsMatch(a: ListingFingerprint, b: ListingFingerprint): boolean {
  if (a.city !== b.city) return false;
  if (a.rooms != null && b.rooms != null && a.rooms !== b.rooms) return false;
  // An UNKNOWN room count must not force-split a genuine cross-post (same lenient philosophy as the
  // area gate below); differing KNOWN counts are already rejected above.
  // areaBucket 0 means "area unknown". Only apply the area gate when BOTH areas are known —
  // otherwise two different area-less flats auto-pass it and can be merged as false duplicates.
  const areaKnown = a.areaBucket > 0 && b.areaBucket > 0;
  if (areaKnown && !bucketsClose(a.areaBucket, b.areaBucket, 5)) return false;
  // priceBucket 0 means "price unknown" (unparseable, or Otodom "zapytaj o cenę"). Same lenient
  // philosophy as the area/rooms gates: only enforce the price gate when BOTH prices are known, else a
  // flat cross-posted with the price hidden on one side would never dedup against its priced copy.
  const priceKnown = a.priceBucket > 0 && b.priceBucket > 0;
  if (priceKnown && !bucketsClose(a.priceBucket, b.priceBucket, 50)) return false;

  if (a.streetKey && b.streetKey && a.streetKey === b.streetKey) return true;
  // With a known area corroborating, a 0.6 title match is enough; with area unknown, demand a much
  // stronger title match so generic "2 pokoje Mokotów" titles don't collapse distinct flats.
  return jaccard(a.titleKey, b.titleKey) >= (areaKnown ? 0.6 : 0.85);
}

function listingQuality(listing: Listing): number {
  let score = 0;
  if (listing.lat != null && listing.lng != null) score += 3;
  if (listing.phone) score += 2;
  if (listing.photos.length > 3) score += 1;
  if (listing.platform === 'otodom') score += 1;
  return score;
}

/** Recover fields the kept (winning) record is missing from a dropped duplicate —
 *  most importantly the phone, which the higher-quality record (e.g. one chosen for
 *  precise coords) may lack. Mutates and returns `winner`. */
function mergeFromDuplicate(winner: Listing, loser: Listing): Listing {
  if (!winner.phone && loser.phone) winner.phone = loser.phone;
  if ((winner.lat == null || winner.lng == null) && loser.lat != null && loser.lng != null) {
    winner.lat = loser.lat;
    winner.lng = loser.lng;
  }
  if (winner.photos.length === 0 && loser.photos.length > 0) winner.photos = loser.photos;
  if (!winner.district && loser.district) winner.district = loser.district;
  return winner;
}

export function dedupeCrossPlatform(listings: Listing[]): Listing[] {
  if (process.env.LISTING_DEDUP_ENABLED === 'false') return listings;

  const kept: Listing[] = [];
  const fps: ListingFingerprint[] = [];

  for (const listing of listings) {
    const fp = fingerprintListing(listing);
    let dupIdx = -1;
    for (let i = 0; i < fps.length; i++) {
      if (fingerprintsMatch(fp, fps[i]!)) {
        dupIdx = i;
        break;
      }
    }
    if (dupIdx === -1) {
      kept.push(listing);
      fps.push(fp);
      continue;
    }

    const existing = kept[dupIdx]!;
    if (listingQuality(listing) > listingQuality(existing)) {
      console.log(`[dedup] kept ${listing.platform}:${listing.platformId}, merged from ${existing.platform}:${existing.platformId}`);
      kept[dupIdx] = mergeFromDuplicate(listing, existing);
      fps[dupIdx] = fp;
    } else {
      console.log(`[dedup] dropped ${listing.platform}:${listing.platformId} (dup of ${existing.platform}:${existing.platformId})`);
      mergeFromDuplicate(existing, listing);
    }
  }

  return kept;
}

/** Stable key for the PERSISTENT, household-wide notification-dedup table (notified_fingerprints) —
 *  a physical flat is alerted at most once across cycles and monitors. It is an exact key over
 *  city|rooms|areaBucket|priceBucket|titleKey. Known limitation: because it hashes the fuzzy titleKey
 *  as an exact component and omits streetKey, it can differ for two records that fingerprintsMatch()
 *  considers the SAME flat (a cross-post whose title differs, matched there via streetKey or a
 *  title-jaccard), so such a repost can occasionally produce one extra alert. Fully closing that would
 *  require storing the fingerprint components and doing a fingerprintsMatch()-based lookup rather than
 *  an exact key — deferred as disproportionate to the one-duplicate-alert impact. */
export function notificationDedupKey(listing: Listing): string {
  const fp = fingerprintListing(listing);
  return fingerprintKey(fp);
}
