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
  if ((a.rooms == null) !== (b.rooms == null)) return false;
  // areaBucket 0 means "area unknown". Only apply the area gate when BOTH areas are known —
  // otherwise two different area-less flats auto-pass it and can be merged as false duplicates.
  const areaKnown = a.areaBucket > 0 && b.areaBucket > 0;
  if (areaKnown && !bucketsClose(a.areaBucket, b.areaBucket, 5)) return false;
  if (!bucketsClose(a.priceBucket, b.priceBucket, 50)) return false;

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

/** Stable key for cross-monitor notification dedup within one scheduler cycle. */
export function notificationDedupKey(listing: Listing): string {
  const fp = fingerprintListing(listing);
  return fingerprintKey(fp);
}
