// OLX.pl crawler — pure HTTP, no browser needed
// Uses the public REST API at /api/v1/offers/

import type { Listing, CrawlResult } from '../types.js';

const OLX_API = 'https://www.olx.pl/api/v1';

const HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8',
  'Referer': 'https://www.olx.pl/',
};

// OLX category IDs for real estate rentals
export const OLX_CATEGORIES = {
  MIESZKANIA_WYNAJEM: 15,     // Mieszkania - Wynajem
  POKOJE_WYNAJEM: 1307,       // Pokoje - Wynajem (stancje i pokoje)
  DOMY_WYNAJEM: 18,           // Domy - Wynajem
} as const;

// Known city IDs
export const OLX_CITIES = {
  WARSZAWA: 17871,
  KRAKOW: 10609,
  WROCLAW: 20992,
  GDANSK: 4879,
  POZNAN: 15649,
  LODZ: 10820,
  KATOWICE: 8671,
} as const;

export const OLX_DISTRICTS: Record<string, Record<string, number>> = {
  warszawa: {
    bemowo: 367, bialoleka: 365, bielany: 369, mokotow: 353,
    ochota: 355, 'praga-poludnie': 381, 'praga-polnoc': 379, rembertow: 361,
    srodmiescie: 351, targowek: 377, ursus: 371, ursynow: 373,
    wawer: 383, wesola: 533, wilanow: 375, wlochy: 357, wola: 359, zoliborz: 363,
  },
};

interface OlxSearchParams {
  categoryId: number;
  cityId?: number;
  regionId?: number;
  offset?: number;
  limit?: number;
  sortBy?: string;
  priceFrom?: number;
  priceTo?: number;
  query?: string;
  rooms?: number;       // 1,2,3,4 — mapped to filter_enum_rooms
  districtId?: number;  // OLX district ID
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`OLX API ${res.status}: ${url.slice(0, 120)}`);
  }
  return await res.json() as T;
}

function buildSearchUrl(params: OlxSearchParams): string {
  const qs = new URLSearchParams();
  qs.set('offset', String(params.offset ?? 0));
  qs.set('limit', String(params.limit ?? 40));
  qs.set('category_id', String(params.categoryId));
  qs.set('sort_by', params.sortBy ?? 'created_at:desc');
  qs.set('filter_refiners', 'spell_checker');

  if (params.cityId) qs.set('city_id', String(params.cityId));
  if (params.regionId) qs.set('region_id', String(params.regionId));
  if (params.priceFrom) qs.set('filter_float_price:from', String(params.priceFrom));
  if (params.priceTo) qs.set('filter_float_price:to', String(params.priceTo));
  if (params.query) qs.set('query', params.query);

  // Room filter — VERIFIED working with live API
  const ROOM_ENUM: Record<number, string> = { 1: 'one', 2: 'two', 3: 'three', 4: 'four' };
  if (params.rooms && ROOM_ENUM[params.rooms]) {
    qs.set('filter_enum_rooms[0]', ROOM_ENUM[params.rooms]);
  }
  if (params.districtId) qs.set('district_id', String(params.districtId));

  return `${OLX_API}/offers/?${qs.toString()}`;
}

/** Sequential OLX queries across district × room combinations, deduped by offer id.
 *  One failed combo does not abort the rest (rate-limited to avoid API bans). */
export async function searchOlxRentals(params: {
  cityId?: number;
  districtIds?: number[];
  roomCounts?: number[];
  priceFrom?: number;
  priceTo?: number;
  limit?: number;
  maxPages?: number;
}): Promise<Listing[]> {
  const districtList = params.districtIds?.length ? params.districtIds : [undefined];
  const roomList = params.roomCounts?.length ? params.roomCounts : [undefined];
  const limit = params.limit ?? 40;
  const maxPages = params.maxPages ?? 1;
  const seen = new Set<string>();
  const all: Listing[] = [];

  for (const districtId of districtList) {
    for (const rooms of roomList) {
      try {
        let offset = 0;
        for (let page = 0; page < maxPages; page++) {
          try {
            const result = await searchOlx({
              categoryId: OLX_CATEGORIES.MIESZKANIA_WYNAJEM,
              cityId: params.cityId,
              districtId,
              rooms,
              priceFrom: params.priceFrom,
              priceTo: params.priceTo,
              limit,
              offset,
            });
            for (const l of result.listings) {
              const key = `${l.platform}:${l.platformId}`;
              if (!seen.has(key)) {
                seen.add(key);
                all.push(l);
              }
            }
            if (!result.hasNextPage || result.listings.length === 0) break;
            offset += limit;
          } catch (pageErr) {
            console.error(
              `[olx] Page failed (district=${districtId ?? 'city'}, rooms=${rooms ?? 'any'}, page=${page + 1}):`,
              pageErr instanceof Error ? pageErr.message : pageErr,
            );
            break;
          }
        }
      } catch (comboErr) {
        console.error(
          `[olx] Combo failed (district=${districtId ?? 'city'}, rooms=${rooms ?? 'any'}):`,
          comboErr instanceof Error ? comboErr.message : comboErr,
        );
      }
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 250));
    }
  }

  return all;
}

function getParamValue(params: any[], key: string): any {
  const param = params?.find((p: any) => p.key === key);
  if (!param) return null;

  if (key === 'price') return param.value?.value ?? null;
  if (key === 'rent') return param.value?.key ?? param.value?.value ?? null;
  if (key === 'm') return param.value?.key ?? null;

  // For label-based params (floor_select, builttype, rooms, etc.)
  return param.value?.label ?? param.value?.key ?? null;
}

function parseOlxOffer(raw: any): Listing {
  const params = raw.params ?? [];

  const priceVal = getParamValue(params, 'price');
  const rentVal = getParamValue(params, 'rent');
  const areaStr = getParamValue(params, 'm');
  const ROOM_KEY_MAP: Record<string, number> = { one: 1, two: 2, three: 3, four: 4 };
  const roomsParam = params?.find((p: any) => p.key === 'rooms');
  const roomsKey = roomsParam?.value?.key;
  const floorStr = getParamValue(params, 'floor_select');
  const buildingType = getParamValue(params, 'builttype');
  const furniture = getParamValue(params, 'furniture');
  const parking = getParamValue(params, 'parking');
  const windaStr = getParamValue(params, 'winda'); // elevator — OLX exposes it in search params
  const hasElevator = windaStr === 'Tak' || windaStr === true ? true
    : windaStr === 'Nie' || windaStr === false ? false : null;

  // Parse numeric values
  const area = areaStr ? parseFloat(String(areaStr).replace(/[^\d.]/g, '')) : null;
  const rooms = roomsKey ? (ROOM_KEY_MAP[roomsKey] ?? (parseInt(String(roomsKey).replace(/\D/g, ''), 10) || null)) : null;
  const floor = floorStr === 'Parter' ? 0 : floorStr ? parseInt(floorStr, 10) || null : null;

  const photos = (raw.photos ?? []).map((p: any) => {
    const link: string = p.link ?? '';
    return link.replace('{width}', String(p.width ?? 800)).replace('{height}', String(p.height ?? 600));
  });

  return {
    platformId: String(raw.id),
    platform: 'olx',
    url: raw.url ?? '',
    slug: raw.url?.split('/').filter(Boolean).pop()?.replace('.html', '') ?? '',
    title: raw.title ?? '',
    description: (raw.description ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    price: typeof priceVal === 'number' ? priceVal : parseFloat(String(priceVal)) || 0,
    currency: 'PLN',
    rent: rentVal ? (typeof rentVal === 'number' ? rentVal : parseFloat(String(rentVal)) || null) : null,
    deposit: null, // extracted via AI later
    area,
    rooms,
    floor,
    buildingFloor: null,
    buildingType,
    heating: null,
    furniture: furniture === true || furniture === 'Tak' ? true : furniture === false || furniture === 'Nie' ? false : null,
    parking,
    hasInternet: null,      // OLX search params don't reliably expose it — AI infers from description
    hasElevator,
    hasAc: null,
    buildYear: null,
    city: raw.location?.city?.name ?? '',
    district: raw.location?.district?.name ?? null,
    street: null,
    region: raw.location?.region?.name ?? '',
    lat: raw.map?.lat ?? null,
    lng: raw.map?.lon ?? null,
    phone: null, // fetched separately
    contactName: raw.contact?.name ?? raw.user?.name ?? null,
    advertiserType: raw.user?.is_business ? 'agency' : 'private',
    agencyName: raw.user?.company_name || null,
    photos,
    createdAt: raw.created_time ?? raw.last_refresh_time ?? '',
    scrapedAt: new Date().toISOString(),
  };
}

// --- Public API ---

export async function searchOlx(params: OlxSearchParams): Promise<CrawlResult> {
  const url = buildSearchUrl(params);
  const data = await fetchJson<any>(url);

  if (!data?.data) {
    return { platform: 'olx', listings: [], totalAvailable: 0, page: 0, hasNextPage: false, nextPageUrl: null };
  }

  const listings = data.data.map(parseOlxOffer);
  const nextUrl = data.links?.next?.href ?? null;
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 40;

  return {
    platform: 'olx',
    listings,
    totalAvailable: data.metadata?.visible_total_count ?? 0,
    page: Math.floor(offset / limit) + 1,
    hasNextPage: !!nextUrl,
    nextPageUrl: nextUrl,
  };
}

export async function fetchOlxPhone(offerId: string): Promise<string | null> {
  try {
    const data = await fetchJson<any>(`${OLX_API}/offers/${offerId}/phones/`);
    const phones = data?.data?.phones;
    return phones?.length ? phones[0] : null;
  } catch {
    // Phone API returns 400 for many listings (protected/no phone) — expected, not an error
    return null;
  }
}

export async function fetchAllPages(params: OlxSearchParams, maxPages = 25): Promise<Listing[]> {
  const allListings: Listing[] = [];
  let offset = params.offset ?? 0;
  const limit = params.limit ?? 40;

  for (let page = 0; page < maxPages; page++) {
    const result = await searchOlx({ ...params, offset, limit });
    allListings.push(...result.listings);

    console.log(`  OLX page ${page + 1}: ${result.listings.length} listings (total so far: ${allListings.length}/${result.totalAvailable})`);

    if (!result.hasNextPage || result.listings.length === 0) break;
    offset += limit;

    // Polite delay between pages
    await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
  }

  return allListings;
}

// Enrich listings with phone numbers (batched, with rate limiting)
export async function enrichWithPhones(listings: Listing[], delayMs = 500): Promise<void> {
  for (const listing of listings) {
    const phone = await fetchOlxPhone(listing.platformId);
    if (phone) listing.phone = phone;
    await new Promise((r) => setTimeout(r, delayMs + Math.random() * delayMs));
  }
}
