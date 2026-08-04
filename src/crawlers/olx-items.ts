// OLX.pl used items crawler — reuses the same REST API as the rental crawler
// For items, we use query-based search instead of category-based

const OLX_API = 'https://www.olx.pl/api/v1';

const HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8',
  'Referer': 'https://www.olx.pl/',
};

// Generic item listing — simpler than rental Listing
export interface ItemListing {
  platformId: string;
  platform: 'olx';
  url: string;
  title: string;
  description: string;
  price: number;
  currency: string;
  negotiable: boolean;
  condition: string | null;   // nowy, używany, uszkodzony
  city: string;
  district: string | null;
  region: string;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  contactName: string | null;
  isBusiness: boolean;
  photos: string[];
  categoryId: number;
  categoryName: string | null;
  params: Record<string, string>; // all raw params as key-value
  shipping: boolean;              // delivery/przesyłka available
  createdAt: string;
  scrapedAt: string;
}

export interface ItemSearchParams {
  query: string;              // free-text search
  cityId?: number;
  regionId?: number;
  categoryId?: number;        // optional, to narrow to a specific OLX category
  priceFrom?: number;
  priceTo?: number;
  offset?: number;
  limit?: number;
  sortBy?: string;            // 'created_at:desc' | 'filter_float_price:asc' | etc.
}

export interface ItemCrawlResult {
  items: ItemListing[];
  totalAvailable: number;
  page: number;
  hasNextPage: boolean;
  nextPageUrl: string | null;
}

function buildItemSearchUrl(params: ItemSearchParams): string {
  const qs = new URLSearchParams();
  qs.set('offset', String(params.offset ?? 0));
  qs.set('limit', String(params.limit ?? 40));
  qs.set('sort_by', params.sortBy ?? 'created_at:desc');
  qs.set('filter_refiners', 'spell_checker');
  qs.set('query', params.query);

  if (params.cityId) qs.set('city_id', String(params.cityId));
  if (params.regionId) qs.set('region_id', String(params.regionId));
  if (params.categoryId) qs.set('category_id', String(params.categoryId));
  if (params.priceFrom) qs.set('filter_float_price:from', String(params.priceFrom));
  if (params.priceTo) qs.set('filter_float_price:to', String(params.priceTo));

  return `${OLX_API}/offers/?${qs.toString()}`;
}

function parseItemOffer(raw: any): ItemListing {
  const params = raw.params ?? [];
  const priceParam = params.find((p: any) => p.key === 'price');
  const price = priceParam?.value?.value ?? 0;
  const negotiable = priceParam?.value?.negotiable ?? false;

  // Collect all params as key-value map
  const paramMap: Record<string, string> = {};
  for (const p of params) {
    paramMap[p.key] = p.value?.label ?? p.value?.key ?? String(p.value?.value ?? '');
  }

  const condition = paramMap['state'] ?? null; // "nowe", "używane", "uszkodzone"

  const photos = (raw.photos ?? []).map((p: any) => {
    const link: string = p.link ?? '';
    return link.replace('{width}', String(p.width ?? 800)).replace('{height}', String(p.height ?? 600));
  }).filter((u: string) => u.length > 0); // drop empty URLs (missing link) — an empty media fails the Telegram album (mirrors Otodom)

  return {
    platformId: String(raw.id),
    platform: 'olx',
    url: raw.url ?? '',
    title: raw.title ?? '',
    description: (raw.description ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    price,
    currency: priceParam?.value?.currency ?? 'PLN',
    negotiable,
    condition,
    city: raw.location?.city?.name ?? '',
    district: raw.location?.district?.name ?? null,
    region: raw.location?.region?.name ?? '',
    lat: raw.map?.lat ?? null,
    lng: raw.map?.lon ?? null,
    phone: null, // fetched separately if needed
    contactName: raw.contact?.name ?? raw.user?.name ?? null,
    isBusiness: raw.user?.is_business ?? false,
    photos,
    categoryId: raw.category?.id ?? 0,
    categoryName: raw.category?.name ?? null,
    params: paramMap,
    shipping: raw.delivery?.rock?.active === true,
    createdAt: raw.created_time ?? raw.last_refresh_time ?? '',
    scrapedAt: new Date().toISOString(),
  };
}

// --- Public API ---

export async function searchItems(params: ItemSearchParams): Promise<ItemCrawlResult> {
  const url = buildItemSearchUrl(params);
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`OLX items API ${res.status}: ${url.slice(0, 120)}`);
  }
  const data = await res.json();

  if (!data?.data) {
    return { items: [], totalAvailable: 0, page: 0, hasNextPage: false, nextPageUrl: null };
  }

  const items = data.data.map(parseItemOffer);
  const nextUrl = data.links?.next?.href ?? null;
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 40;

  return {
    items,
    totalAvailable: data.metadata?.visible_total_count ?? 0,
    page: Math.floor(offset / limit) + 1,
    hasNextPage: !!nextUrl,
    nextPageUrl: nextUrl,
  };
}

export async function fetchItemPhone(offerId: string): Promise<string | null> {
  try {
    const res = await fetch(`${OLX_API}/offers/${offerId}/phones/`, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.phones?.[0] ?? null;
  } catch (err) {
    console.warn(`[olx-items] Phone fetch failed for ${offerId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// Re-export city IDs from the rental crawler — same values
export { OLX_CITIES } from './olx.js';
