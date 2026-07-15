// Otodom.pl crawler — Playwright with stealth, extracts __NEXT_DATA__
// Otodom is Next.js, all listing data lives in the __NEXT_DATA__ script tag

import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { BrowserContext, Page } from 'playwright';
import type { Listing, CrawlResult } from '../types.js';
import { AsyncMutex } from '../utils/mutex.js';

chromium.use(stealthPlugin());

// All Playwright operations go through this mutex — prevents race conditions
// on browser launch, context creation, and concurrent page navigation
const browserMutex = new AsyncMutex();

const CONTEXT_OPTIONS = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1920, height: 1080 },
  locale: 'pl-PL',
  timezoneId: 'Europe/Warsaw',
};

// Otodom search URL builder
interface OtodomSearchParams {
  type: 'wynajem' | 'sprzedaz';
  estate: 'mieszkanie' | 'dom' | 'pokoj' | 'dzialka' | 'lokal' | 'garaz';
  province?: string;       // e.g. 'mazowieckie'
  city?: string;           // e.g. 'warszawa'
  district?: string;       // e.g. 'mokotow'
  priceFrom?: number;
  priceTo?: number;
  areaFrom?: number;
  areaTo?: number;
  roomsFrom?: number;
  roomsTo?: number;
  ownerType?: 'ALL' | 'PRIVATE' | 'AGENCY';
  page?: number;
  limit?: number;
}

export function buildOtodomUrl(params: OtodomSearchParams): string {
  const parts = [
    'https://www.otodom.pl/pl/wyniki',
    params.type,
    params.estate,
    params.province ?? 'cala-polska',
  ];

  if (params.city) {
    parts.push(params.city);
    parts.push(params.city); // otodom duplicates city in the path
  }

  const qs = new URLSearchParams();
  qs.set('viewType', 'listing');
  qs.set('limit', String(params.limit ?? 36));
  qs.set('by', 'DEFAULT');
  qs.set('direction', 'DESC');
  qs.set('ownerTypeSingleSelect', params.ownerType ?? 'ALL');

  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.priceFrom) qs.set('priceMin', String(params.priceFrom));
  if (params.priceTo) qs.set('priceMax', String(params.priceTo));
  if (params.areaFrom) qs.set('areaMin', String(params.areaFrom));
  if (params.areaTo) qs.set('areaMax', String(params.areaTo));

  // Room filter — VERIFIED: Otodom uses enum strings, not numeric ranges
  const ROOM_ENUM_OTODOM: Record<number, string> = { 1: 'ONE', 2: 'TWO', 3: 'THREE', 4: 'FOUR', 5: 'FIVE', 6: 'SIX' };
  if (params.roomsFrom) {
    const values: string[] = [];
    const from = params.roomsFrom;
    const to = params.roomsTo ?? 6; // default to max — "at least N rooms"
    for (let i = from; i <= to && i <= 6; i++) {
      if (ROOM_ENUM_OTODOM[i]) values.push(ROOM_ENUM_OTODOM[i]);
    }
    if (values.length > 0) qs.set('roomsNumber', `[${values.join(',')}]`);
  }

  // District filter — VERIFIED: uses locations query param, not URL path
  if (params.district && params.city) {
    const province = params.province ?? 'mazowieckie';
    const city = params.city;
    qs.set('locations', `[${province}/${city}/${city}/${city}/${params.district}]`);
  }

  return `${parts.join('/')}?${qs.toString()}`;
}

// --- Browser Management (singleton browser + singleton context) ---

let _browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let _context: BrowserContext | null = null;

async function getContext(): Promise<BrowserContext> {
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    _context = null; // reset context when browser restarts
  }
  if (!_context) {
    _context = await _browser.newContext(CONTEXT_OPTIONS);
  }
  return _context;
}

// --- Cookie Consent ---

async function dismissCookieConsent(page: Page): Promise<void> {
  try {
    const acceptBtn = page.locator('#onetrust-accept-btn-handler');
    if (await acceptBtn.isVisible({ timeout: 3000 })) {
      await acceptBtn.click();
      await page.waitForTimeout(500);
    }
  } catch {
    // no cookie banner, fine
  }
}

// --- __NEXT_DATA__ Extraction ---

async function extractNextData(page: Page): Promise<any | null> {
  const raw = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    return el?.textContent ?? null;
  });
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[otodom] Malformed __NEXT_DATA__ JSON (${raw.length} chars):`, err instanceof Error ? err.message : err);
    return null;
  }
}

// --- Listing Parsing ---

// Otodom uses enum strings for rooms/floors in search items
const ROOM_MAP: Record<string, number> = {
  ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9, TEN: 10,
};
const FLOOR_MAP: Record<string, number> = {
  GROUND: 0, FIRST: 1, SECOND: 2, THIRD: 3, FOURTH: 4, FIFTH: 5, SIXTH: 6,
  SEVENTH: 7, EIGHTH: 8, NINTH: 9, TENTH: 10, ABOVE_TENTH: 11, GARRET: -1,
};

function findDistrict(locations: any[]): string | null {
  const district = locations?.find((l: any) => l.locationLevel === 'district');
  return district?.name ?? null;
}

function parseOtodomSearchItem(item: any): Listing | null {
  if (!item?.id) return null;

  const slug = item.slug ?? '';
  const locations = item.location?.reverseGeocoding?.locations ?? [];

  return {
    platformId: String(item.id),
    platform: 'otodom',
    url: `https://www.otodom.pl/pl/oferta/${slug}`,
    slug,
    title: item.title ?? '',
    description: item.shortDescription ?? '',
    price: item.totalPrice?.value ?? 0,
    currency: item.totalPrice?.currency ?? 'PLN',
    rent: item.rentPrice?.value ?? null,
    deposit: null, // not in search results
    area: item.areaInSquareMeters ?? null,
    rooms: item.roomsNumber ? (ROOM_MAP[item.roomsNumber] ?? (parseInt(item.roomsNumber, 10) || null)) : null,
    floor: item.floorNumber ? (FLOOR_MAP[item.floorNumber] ?? (parseInt(item.floorNumber, 10) || null)) : null,
    buildingFloor: null,
    buildingType: item.estate ?? null,
    heating: null,
    furniture: null,
    parking: null,
    hasInternet: null,   // search items don't carry the detail block — filled by enrichment
    hasElevator: null,
    hasAc: null,
    buildYear: null,
    city: item.location?.address?.city?.name ?? '',
    district: findDistrict(locations),
    street: item.location?.address?.street?.name ?? null,
    region: item.location?.address?.province?.name ?? '',
    lat: null, // not in search results
    lng: null,
    phone: null,
    contactName: item.advertOwner?.name ?? null,
    advertiserType: item.isPrivateOwner ? 'private'
      : item.agency?.type === 'AGENCY' ? 'agency'
      : item.agency?.type === 'DEVELOPER' ? 'developer' : null,
    agencyName: item.agency?.name ?? null,
    photos: (item.images ?? []).map((img: any) => img.large ?? img.medium ?? ''),
    createdAt: item.createdAtFirst ?? item.dateCreated ?? '',
    scrapedAt: new Date().toISOString(),
  };
}

function parseOtodomDetailAd(ad: any): Listing | null {
  if (!ad?.id) return null;

  const slug = ad.slug ?? '';
  const target = ad.target ?? {};

  // Landlord-checked amenity lists: a present tag is a reliable true, but an absent tag
  // means "not stated", not false — so emit true-or-null and let the AI infer the rest.
  const mediaTypes: string[] = Array.isArray(target.Media_types) ? target.Media_types.map((m: unknown) => String(m).toLowerCase()) : [];
  const extras: string[] = Array.isArray(target.Extras_types) ? target.Extras_types.map((e: unknown) => String(e).toLowerCase()) : [];
  const hasInternet = mediaTypes.some((m) => m.includes('internet')) ? true : null;
  const hasElevator = extras.includes('lift') ? true : null;
  const hasAc = extras.includes('air_conditioning') ? true : null;
  const buildYear = target.Build_year ? (parseInt(String(target.Build_year), 10) || null) : null;

  return {
    platformId: String(ad.id),
    platform: 'otodom',
    url: ad.url ?? `https://www.otodom.pl/pl/oferta/${slug}`,
    slug,
    title: ad.title ?? '',
    description: ad.description ?? '',
    price: ad.price?.value ?? target.Price ?? 0,
    currency: ad.price?.currency ?? 'PLN',
    rent: target.Rent ? parseFloat(String(target.Rent)) : null,
    deposit: target.Deposit ? parseFloat(String(target.Deposit)) : null,
    area: target.Area ? parseFloat(String(target.Area)) : null,
    rooms: target.Rooms_num?.[0] ? parseInt(target.Rooms_num[0], 10) : null,
    floor: target.Floor_no?.[0] != null
      ? (FLOOR_MAP[target.Floor_no[0]] ?? (parseInt(target.Floor_no[0], 10) || null))
      : null,
    buildingFloor: target.Building_floors_num ? parseInt(String(target.Building_floors_num), 10) : null,
    buildingType: target.Building_type?.[0] ?? null,
    heating: target.Heating?.[0] ?? null,
    furniture: target.Equipment_types ? true : null,
    parking: target.Parking_type?.[0] ?? null,
    hasInternet,
    hasElevator,
    hasAc,
    buildYear,
    city: ad.location?.address?.city?.name ?? '',
    district: ad.location?.address?.district?.name ?? null,
    street: ad.location?.address?.street?.name
      ? `${ad.location.address.street.name} ${ad.location.address.street.number ?? ''}`.trim()
      : null,
    region: ad.location?.address?.province?.name ?? '',
    lat: ad.location?.coordinates?.latitude ?? null,
    lng: ad.location?.coordinates?.longitude ?? null,
    phone: ad.contactDetails?.phone ?? null,
    contactName: ad.owner?.name ?? null,
    advertiserType: (ad.advertiserType === 'AGENCY' || ad.agency) ? 'agency'
      : ad.advertiserType === 'DEVELOPER' ? 'developer'
      : (ad.advertiserType === 'PRIVATE' || ad.owner?.type === 'PRIVATE') ? 'private' : null,
    agencyName: ad.agency?.name ?? null,
    photos: (ad.images ?? []).map((img: any) => img.large ?? img.medium ?? img.small ?? ''),
    createdAt: ad.createdAt ?? '',
    scrapedAt: new Date().toISOString(),
  };
}

// --- Public API ---

export async function searchOtodom(params: OtodomSearchParams): Promise<CrawlResult> {
  return browserMutex.run(async () => {
  const url = buildOtodomUrl(params);
  const context = await getContext();
  const page = await context.newPage();

  try {
    console.log(`  Otodom: navigating to ${url.slice(0, 100)}...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await dismissCookieConsent(page);
    await page.waitForTimeout(1000); // let hydration finish

    const nextData = await extractNextData(page);
    if (!nextData) {
      console.error(`  Otodom: no __NEXT_DATA__ found at ${url.slice(0, 120)}`);
      return { platform: 'otodom', listings: [], totalAvailable: 0, page: 0, hasNextPage: false, nextPageUrl: null };
    }

    const pageProps = nextData.props?.pageProps;
    const tracking = pageProps?.tracking?.listing;
    const items = pageProps?.data?.searchAds?.items ?? [];

    const listings = items.map(parseOtodomSearchItem).filter(Boolean) as Listing[];

    const currentPage = params.page ?? 1;
    const pageCount = tracking?.page_count ?? 1;

    return {
      platform: 'otodom',
      listings,
      totalAvailable: tracking?.result_count ?? listings.length,
      page: currentPage,
      hasNextPage: currentPage < pageCount,
      nextPageUrl: currentPage < pageCount ? buildOtodomUrl({ ...params, page: currentPage + 1 }) : null,
    };
  } finally {
    await page.close();
  }
  }); // browserMutex.run
}

export async function fetchOtodomDetail(listingUrl: string): Promise<Listing | null> {
  return browserMutex.run(async () => {
    const context = await getContext();
    const page = await context.newPage();

    try {
      await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await dismissCookieConsent(page);
      await page.waitForTimeout(1000);

      const nextData = await extractNextData(page);
      const ad = nextData?.props?.pageProps?.ad;
      if (!ad) {
        console.error(`  Otodom: no ad data in __NEXT_DATA__ at ${listingUrl.slice(0, 120)}`);
        return null;
      }

      return parseOtodomDetailAd(ad);
    } finally {
      await page.close();
    }
  }); // browserMutex.run
}

export async function fetchAllOtodomPages(params: OtodomSearchParams, maxPages = 10): Promise<Listing[]> {
  const allListings: Listing[] = [];

  for (let p = 1; p <= maxPages; p++) {
    const result = await searchOtodom({ ...params, page: p });
    allListings.push(...result.listings);

    console.log(`  Otodom page ${p}: ${result.listings.length} listings (total: ${allListings.length}/${result.totalAvailable})`);

    if (!result.hasNextPage || result.listings.length === 0) break;

    // Polite delay
    await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));
  }

  return allListings;
}

export async function closeBrowser(): Promise<void> {
  await browserMutex.run(async () => {
    if (_context) { await _context.close().catch(() => {}); _context = null; }
    if (_browser) { await _browser.close().catch(() => {}); _browser = null; }
  });
}
