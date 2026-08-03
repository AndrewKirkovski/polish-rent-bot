// Shared rental search — OLX (multi-room, multi-district) + Otodom, post-filter, cross-platform dedup.

import { searchOlxRentals, OLX_DISTRICTS, OLX_CITIES } from '../crawlers/olx.js';
import { searchOtodom } from '../crawlers/otodom.js';
import type { Listing } from '../types.js';
import { dedupeCrossPlatform, stripDiacritics } from './listing-fingerprint.js';

export { stripDiacritics };

const CITY_ID_MAP: Record<string, number> = {
  warszawa: OLX_CITIES.WARSZAWA,
  krakow: OLX_CITIES.KRAKOW,
  wroclaw: OLX_CITIES.WROCLAW,
  gdansk: OLX_CITIES.GDANSK,
  poznan: OLX_CITIES.POZNAN,
  lodz: OLX_CITIES.LODZ,
  katowice: OLX_CITIES.KATOWICE,
};

export const CITY_PROVINCE_MAP: Record<string, string> = {
  warszawa: 'mazowieckie',
  krakow: 'malopolskie',
  wroclaw: 'dolnoslaskie',
  gdansk: 'pomorskie',
  poznan: 'wielkopolskie',
  lodz: 'lodzkie',
  katowice: 'slaskie',
};

export function resolveCityId(name: string): number | undefined {
  // Fold diacritics so "Kraków"/"Gdańsk" resolve to the ASCII keys (krakow/gdansk); otherwise the
  // lookup silently misses and the search falls back to all of Poland.
  return CITY_ID_MAP[stripDiacritics(name)];
}

/** Map roomsFrom/roomsTo to OLX API room counts (1–4). */
export function olxRoomCounts(roomsFrom?: number, roomsTo?: number): number[] | undefined {
  if (roomsFrom == null && roomsTo == null) return undefined;
  const from = roomsFrom ?? 1;
  const to = roomsTo ?? roomsFrom ?? 4;
  return [1, 2, 3, 4].filter((r) => r >= from && r <= to);
}

export function resolveOlxDistrictIds(city: string, districts: string[]): number[] {
  const cityDistricts = OLX_DISTRICTS[stripDiacritics(city)];
  if (!cityDistricts) return [];
  return districts
    .map((d) => cityDistricts[stripDiacritics(d)])
    .filter((id): id is number => id != null);
}

export interface RentalSearchParams {
  city: string;
  districts?: string[];
  province?: string;
  roomsFrom?: number;
  roomsTo?: number;
  areaFrom?: number;
  areaTo?: number;
  priceFrom?: number;
  priceTo?: number;
  ownerType?: 'ALL' | 'PRIVATE' | 'AGENCY';
  platforms?: 'olx' | 'otodom' | 'all';
  /** OLX pages per district×room combo (2 for interactive search, 1 for monitors). */
  olxMaxPages?: number;
  olxLimit?: number;
  otodomLimit?: number;
}

export async function searchRentalListings(params: RentalSearchParams): Promise<Listing[]> {
  const city = params.city.toLowerCase().trim();
  const districts = params.districts ?? [];
  const province = params.province ?? CITY_PROVINCE_MAP[stripDiacritics(city)];
  const platforms = params.platforms ?? 'all';
  const doOlx = platforms === 'olx' || platforms === 'all';
  const doOtodom = platforms === 'otodom' || platforms === 'all';
  const roomsTo = params.roomsTo ?? params.roomsFrom;

  const searchPromises: Promise<Listing[]>[] = [];

  if (doOlx) {
    const cityId = resolveCityId(city);
    let districtIds: number[] | undefined;
    if (districts.length > 0) {
      districtIds = resolveOlxDistrictIds(city, districts);
      if (districtIds.length === 0) {
        console.warn(
          `[rental-search] Districts requested but no OLX IDs resolved for ${city}: ${districts.join(', ')}`,
        );
      }
    }
    const roomCounts = olxRoomCounts(params.roomsFrom, roomsTo);

    // A room request that maps to NO OLX bucket (e.g. 5+, OLX caps at 4) yields []. Skipping
    // OLX avoids fetching every room (empty === undefined downstream) and relying on the
    // post-filter; Otodom supports exact 5/6 counts, so it still covers those searches.
    // Rooms mapped to no OLX bucket (roomsFrom>=5 — OLX caps its room filter at 4). Otodom supports
    // exact 5/6 counts, so when Otodom will also run we skip OLX and let Otodom cover it. But in
    // OLX-ONLY mode skipping would queue NOTHING and return [] silently (the all-failed guard can't
    // fire on 0 promises) — OLX DOES carry 5+ flats, they just can't be enum-filtered — so fetch OLX
    // UNFILTERED and let the room post-filter below enforce the count.
    const roomsOutOfOlxRange = params.roomsFrom != null && roomCounts != null && roomCounts.length === 0;
    if (roomsOutOfOlxRange && doOtodom) {
      console.warn(`[rental-search] rooms ${params.roomsFrom}-${roomsTo} out of OLX range (1-4) — skipping OLX, using Otodom only`);
    } else {
      if (roomsOutOfOlxRange) {
        console.warn(`[rental-search] rooms ${params.roomsFrom}-${roomsTo} out of OLX range (1-4); OLX-only — fetching unfiltered and post-filtering by room count`);
      }
      searchPromises.push(
        searchOlxRentals({
          cityId,
          districtIds: districtIds?.length ? districtIds : undefined,
          // Out of OLX's bucket range → fetch every room count and let the post-filter enforce it.
          roomCounts: roomsOutOfOlxRange ? undefined : roomCounts,
          // Only priceTo (a najem<=maxTotal necessary bound). priceFrom filters base rent,
          // which would wrongly drop low-najem/high-czynsz flats — enforced post-parse instead.
          priceTo: params.priceTo,
          limit: params.olxLimit ?? 40,
          maxPages: params.olxMaxPages ?? 2,
        }),
      );
    }
  }

  if (doOtodom) {
    const districtList = districts.length > 0 ? districts : [undefined];
    for (const district of districtList) {
      searchPromises.push(
        searchOtodom({
          type: 'wynajem',
          estate: 'mieszkanie',
          province,
          city: city || undefined,
          district: district ? stripDiacritics(district) : undefined,
          // priceFrom omitted on purpose (base-rent min → false negatives); enforced post-parse.
          priceTo: params.priceTo,
          areaFrom: params.areaFrom,
          areaTo: params.areaTo,
          roomsFrom: params.roomsFrom,
          roomsTo,
          ownerType: params.ownerType,
          limit: params.otodomLimit ?? 36,
        }).then((r) => r.listings),
      );
    }
  }

  const searchResults = await Promise.allSettled(searchPromises);
  let filtered = searchResults
    .filter((r): r is PromiseFulfilledResult<Listing[]> => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  const failed = searchResults.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    console.error('[rental-search] Some searches failed:', failed.map((r) => (r as PromiseRejectedResult).reason));
  }
  // Distinguish a genuine empty result from a total backend outage: if NOTHING was fetched
  // successfully and at least one fetch errored, surface it so the caller can say "search failed,
  // retry" instead of the misleading "no results — broaden your search".
  if (searchResults.length - failed.length === 0 && failed.length > 0) {
    throw new Error(`rental search failed: all ${failed.length} backend fetch(es) errored`);
  }

  if (params.roomsFrom != null) {
    filtered = filtered.filter((l) => l.rooms == null || l.rooms >= params.roomsFrom!);
  }
  if (roomsTo != null) {
    filtered = filtered.filter((l) => l.rooms == null || l.rooms <= roomsTo);
  }
  if (params.areaFrom != null) {
    filtered = filtered.filter((l) => l.area == null || l.area >= params.areaFrom!);
  }
  if (params.areaTo != null) {
    filtered = filtered.filter((l) => l.area == null || l.area <= params.areaTo!);
  }

  if (params.ownerType && params.ownerType !== 'ALL') {
    const wantPrivate = params.ownerType === 'PRIVATE';
    filtered = filtered.filter((l) => {
      if (!l.advertiserType) return true;
      return wantPrivate ? l.advertiserType === 'private' : l.advertiserType === 'agency';
    });
  }

  if (districts.length > 0) {
    const normalizedDistricts = districts.map(stripDiacritics);
    filtered = filtered.filter((l) => {
      // Results are already district-scoped server-side (OLX district_id / Otodom locations), and
      // most Otodom + some OLX items carry a null district label. Match the null-passthrough
      // convention of the sibling filters above; only drop a listing whose KNOWN district differs.
      if (!l.district) return true;
      const nd = stripDiacritics(l.district);
      return normalizedDistricts.some((d) => nd.includes(d) || d.includes(nd));
    });
  }

  const seen = new Set<string>();
  const platformDeduped: Listing[] = [];
  for (const l of filtered) {
    const key = `${l.platform}:${l.platformId}`;
    if (!seen.has(key)) {
      seen.add(key);
      platformDeduped.push(l);
    }
  }

  const deduped = dedupeCrossPlatform(platformDeduped);

  deduped.sort((a, b) => {
    // Date.parse yields NaN for an unparseable string; `|| 0` folds NaN AND '' to the epoch so the
    // comparator never returns NaN (which would corrupt the sort order).
    const ta = Date.parse(a.createdAt) || 0;
    const tb = Date.parse(b.createdAt) || 0;
    return tb - ta;
  });

  return deduped;
}
