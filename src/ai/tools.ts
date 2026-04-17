// Tool definitions for the Claude API + dispatcher that executes them
// Deep pipeline tools: find_rentals, find_items, create_monitor, update_monitor, delete_monitor, list_monitors
import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';

import { searchOlx, fetchOlxPhone, OLX_CATEGORIES, OLX_CITIES } from '../crawlers/olx.js';
import { searchItems, fetchItemPhone } from '../crawlers/olx-items.js';
import type { ItemListing } from '../crawlers/olx-items.js';
import { searchOtodom, fetchOtodomDetail } from '../crawlers/otodom.js';
import { parseRentalListing, parseItemListing } from './parse-listing.js';
import { scoreLocation } from './maps.js';
import type { AmenityPreference } from './maps.js';
import { formatRichRentalNotification, formatRichItemNotification } from '../bot/format.js';
import {
  addMonitor,
  getMonitors,
  getMonitor,
  deactivateMonitor,
  getSeenCount,
  updateMonitorConfig,
} from '../storage/db.js';
import type { Listing, ParsedRentalData, LocationScore } from '../types.js';

// ---------------------------------------------------------------------------
// User context -- tracks state across the conversation for a single user
// ---------------------------------------------------------------------------

export interface UserContext {
  lastSearchResults: Array<Listing | ItemListing>;
  lastDetailListing: Listing | null;
  userId: number;
  chatId: number;
}

const contexts = new Map<number, UserContext>();

export function getOrCreateContext(userId: number, chatId: number): UserContext {
  let ctx = contexts.get(userId);
  if (!ctx) {
    ctx = { lastSearchResults: [], lastDetailListing: null, userId, chatId };
    contexts.set(userId, ctx);
  }
  // Always keep chatId up to date (user may message from different chats)
  ctx.chatId = chatId;
  return ctx;
}

// ---------------------------------------------------------------------------
// City name -> OLX city ID mapping
// ---------------------------------------------------------------------------

const CITY_ID_MAP: Record<string, number> = {
  warszawa: OLX_CITIES.WARSZAWA,
  krakow: OLX_CITIES.KRAKOW,
  wroclaw: OLX_CITIES.WROCLAW,
  gdansk: OLX_CITIES.GDANSK,
  poznan: OLX_CITIES.POZNAN,
  lodz: OLX_CITIES.LODZ,
  katowice: OLX_CITIES.KATOWICE,
};

// City -> default province for Otodom
const CITY_PROVINCE_MAP: Record<string, string> = {
  warszawa: 'mazowieckie',
  krakow: 'malopolskie',
  wroclaw: 'dolnoslaskie',
  gdansk: 'pomorskie',
  poznan: 'wielkopolskie',
  lodz: 'lodzkie',
  katowice: 'slaskie',
};

function resolveCityId(name: string): number | undefined {
  return CITY_ID_MAP[name.toLowerCase().trim()];
}

// ---------------------------------------------------------------------------
// Send function types
// ---------------------------------------------------------------------------

type SendFn = (chatId: number, text: string) => Promise<void>;
type SendPhotosFn = (chatId: number, urls: string[]) => Promise<void>;

// ---------------------------------------------------------------------------
// Tool definitions (Claude API format) -- 6 deep pipeline tools
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS: Tool[] = [
  // ---- 1. find_rentals ----
  {
    name: 'find_rentals',
    description:
      'Full pipeline: search rental apartments on OLX and/or Otodom, analyze each with AI, check location amenities, filter by budget, and send rich cards with photos directly to the user. Call ONCE after confirming criteria.',
    input_schema: {
      type: 'object' as const,
      properties: {
        city: {
          type: 'string',
          description: 'City name (e.g. "warszawa", "krakow", "wroclaw", "gdansk", "poznan", "lodz", "katowice")',
        },
        districts: {
          type: 'array',
          items: { type: 'string' },
          description: 'District names within the city (e.g. ["mokotow", "wola"])',
        },
        province: {
          type: 'string',
          description: 'Province/voivodeship (e.g. "mazowieckie"). Auto-resolved from city if omitted.',
        },
        priceFrom: { type: 'number', description: 'Minimum TOTAL monthly budget in PLN (rent + czynsz + media)' },
        priceTo: { type: 'number', description: 'Maximum TOTAL monthly budget in PLN (rent + czynsz + media)' },
        roomsFrom: { type: 'number', description: 'Minimum number of rooms' },
        roomsTo: { type: 'number', description: 'Maximum number of rooms' },
        areaFrom: { type: 'number', description: 'Minimum area in m2' },
        areaTo: { type: 'number', description: 'Maximum area in m2' },
        ownerType: {
          type: 'string',
          enum: ['ALL', 'PRIVATE', 'AGENCY'],
          description: 'Filter by owner type',
        },
        platforms: {
          type: 'string',
          enum: ['olx', 'otodom', 'all'],
          description: 'Platforms to search. Defaults to "all".',
        },
        amenities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['metro', 'gym', 'pool', 'supermarket', 'park', 'pharmacy'], description: 'Amenity type' },
              maxMinutes: { type: 'number', description: 'Maximum walking minutes to this amenity' },
            },
            required: ['type', 'maxMinutes'],
          },
          description: 'Desired nearby amenities with maximum walking time',
        },
        workAddress: { type: 'string', description: 'Work/commute destination address for commute calculation' },
        commuteMode: {
          type: 'string',
          enum: ['transit', 'driving', 'walking', 'bicycling'],
          description: 'Commute transport mode (default: transit)',
        },
        maxResults: {
          type: 'number',
          description: 'Number of final results to show (default 5, max 10)',
        },
        contractPreference: {
          type: 'string',
          enum: ['najem_okazjonalny', 'any'],
          description: 'Preferred contract type. "najem_okazjonalny" filters for that type only.',
        },
      },
      required: ['city'],
    },
  },

  // ---- 2. find_items ----
  {
    name: 'find_items',
    description:
      'Search for items (furniture, electronics, etc.) on OLX, analyze condition with AI, and send formatted item cards with photos directly to the user.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search keywords (e.g. "biurko", "iphone 15", "sofa")' },
        city: { type: 'string', description: 'City name to filter by' },
        priceFrom: { type: 'number', description: 'Minimum price in PLN' },
        priceTo: { type: 'number', description: 'Maximum price in PLN' },
        maxResults: { type: 'number', description: 'Number of results to show (default 5, max 10)' },
      },
      required: ['query'],
    },
  },

  // ---- 3. create_monitor ----
  {
    name: 'create_monitor',
    description:
      'Create a persistent monitor that periodically checks for new listings matching the criteria and sends notifications to the user.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['rental', 'item'], description: 'Monitor type' },
        // Rental search params
        city: { type: 'string', description: 'City name' },
        districts: {
          type: 'array',
          items: { type: 'string' },
          description: 'District names',
        },
        province: { type: 'string', description: 'Province' },
        priceFrom: { type: 'number', description: 'Min price / budget' },
        priceTo: { type: 'number', description: 'Max total monthly budget in PLN' },
        roomsFrom: { type: 'number', description: 'Min rooms' },
        roomsTo: { type: 'number', description: 'Max rooms' },
        areaFrom: { type: 'number', description: 'Min area m2' },
        areaTo: { type: 'number', description: 'Max area m2' },
        ownerType: { type: 'string', enum: ['ALL', 'PRIVATE', 'AGENCY'] },
        platforms: {
          type: 'string',
          enum: ['olx', 'otodom', 'all'],
          description: 'Platforms to monitor (default "all")',
        },
        amenities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              maxMinutes: { type: 'number' },
            },
            required: ['type', 'maxMinutes'],
          },
          description: 'Desired nearby amenities',
        },
        workAddress: { type: 'string', description: 'Work/commute destination address' },
        commuteMode: { type: 'string', enum: ['transit', 'driving', 'walking', 'bicycling'] },
        contractPreference: { type: 'string', enum: ['najem_okazjonalny', 'any'] },
        // Item search params
        query: { type: 'string', description: 'Search keywords (for item monitors)' },
      },
      required: ['type'],
    },
  },

  // ---- 4. update_monitor ----
  {
    name: 'update_monitor',
    description: 'Update an existing monitor\'s configuration. Merges the provided updates into the existing config.',
    input_schema: {
      type: 'object' as const,
      properties: {
        monitorId: { type: 'number', description: 'Monitor ID to update' },
        updates: {
          type: 'object',
          description: 'Partial config updates to merge (e.g. {priceTo: 4000, districts: ["mokotow"]})',
        },
      },
      required: ['monitorId', 'updates'],
    },
  },

  // ---- 5. delete_monitor ----
  {
    name: 'delete_monitor',
    description: 'Deactivate/delete a monitor. It will stop checking for new listings.',
    input_schema: {
      type: 'object' as const,
      properties: {
        monitorId: { type: 'number', description: 'Monitor ID to deactivate' },
      },
      required: ['monitorId'],
    },
  },

  // ---- 6. list_monitors ----
  {
    name: 'list_monitors',
    description: 'List all active monitors for the current user, showing their config and how many listings have been seen.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

// ---------------------------------------------------------------------------
// 1. find_rentals -- THE BIG ONE
// ---------------------------------------------------------------------------

interface RejectionReason {
  url: string;
  title: string;
  reason: string;
}

async function execFindRentals(
  input: Record<string, unknown>,
  ctx: UserContext,
  sendFn: SendFn,
  sendPhotosFn: SendPhotosFn,
): Promise<string> {
  const city = String(input.city ?? '').toLowerCase().trim();
  const districts = (input.districts as string[] | undefined) ?? [];
  const province = input.province
    ? String(input.province).toLowerCase().trim()
    : CITY_PROVINCE_MAP[city];
  const priceFrom = input.priceFrom as number | undefined;
  const priceTo = input.priceTo as number | undefined;
  const roomsFrom = input.roomsFrom as number | undefined;
  const roomsTo = input.roomsTo as number | undefined;
  const areaFrom = input.areaFrom as number | undefined;
  const areaTo = input.areaTo as number | undefined;
  const ownerType = input.ownerType as string | undefined;
  const platformsInput = (input.platforms as string | undefined) ?? 'all';
  const amenities = (input.amenities as Array<{ type: string; maxMinutes: number }> | undefined) ?? [];
  const workAddress = input.workAddress as string | undefined;
  const commuteMode = (input.commuteMode as string | undefined) ?? 'transit';
  const maxResults = Math.min(Math.max((input.maxResults as number) || 5, 1), 10);
  const contractPreference = input.contractPreference as string | undefined;

  const doOlx = platformsInput === 'olx' || platformsInput === 'all';
  const doOtodom = platformsInput === 'otodom' || platformsInput === 'all';

  // ---- Step A: Search OLX + Otodom in parallel ----
  const searchPromises: Promise<Listing[]>[] = [];

  // Strip diacritics helper for URL-safe district names
  const stripDiacritics = (s: string) => s.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l');

  if (doOlx) {
    const cityId = resolveCityId(city);
    // Don't pass priceTo to OLX — user budget is TOTAL but API filters RENT only.
    // Don't pre-filter price at all — let AI parse determine total and filter after.
    // Fetch multiple pages to get enough results.
    searchPromises.push(
      (async () => {
        const page1 = await searchOlx({ categoryId: OLX_CATEGORIES.MIESZKANIA_WYNAJEM, cityId, limit: 40 });
        const results = [...page1.listings];
        // Fetch page 2 if available
        if (page1.hasNextPage) {
          const page2 = await searchOlx({ categoryId: OLX_CATEGORIES.MIESZKANIA_WYNAJEM, cityId, limit: 40, offset: 40 });
          results.push(...page2.listings);
        }
        return results;
      })(),
    );
  }

  if (doOtodom) {
    // If districts are specified, search each district. Otherwise search the city.
    const districtList = districts.length > 0 ? districts : [undefined];
    for (const district of districtList) {
      searchPromises.push(
        searchOtodom({
          type: 'wynajem',
          estate: 'mieszkanie',
          province,
          city: city || undefined,
          district: district ? stripDiacritics(district) : undefined, // URL-safe, no diacritics
          priceFrom,
          priceTo, // Otodom filters on advertised price, close enough
          areaFrom,
          areaTo,
          roomsFrom,
          roomsTo,
          ownerType: (ownerType as 'ALL' | 'PRIVATE' | 'AGENCY') ?? undefined,
          limit: 36,
        }).then((r) => r.listings),
      );
    }
  }

  const searchResults = await Promise.all(searchPromises);
  const allListings = searchResults.flat();
  console.log(`[find_rentals] Search results: ${allListings.length} total (OLX: ${doOlx}, Otodom: ${doOtodom})`);
  console.log(`[find_rentals] Params: city=${city}, districts=${districts.join(',')}, rooms=${roomsFrom}-${roomsTo}, priceTo=${priceTo}`);

  // ---- Filter by rooms/area (for OLX which doesn't filter well) ----
  let filtered = allListings;
  if (roomsFrom != null) {
    filtered = filtered.filter((l) => l.rooms == null || l.rooms >= roomsFrom);
  }
  if (roomsTo != null) {
    filtered = filtered.filter((l) => l.rooms == null || l.rooms <= roomsTo);
  }
  if (areaFrom != null) {
    filtered = filtered.filter((l) => l.area == null || l.area >= areaFrom);
  }
  if (areaTo != null) {
    filtered = filtered.filter((l) => l.area == null || l.area <= areaTo);
  }

  // Filter by district — use substring matching, normalize diacritics
  if (districts.length > 0) {
    const normalize = (s: string) => s.toLowerCase().trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/ł/g, 'l');
    const normalizedDistricts = districts.map(normalize);
    filtered = filtered.filter((l) => {
      if (!l.district) return true; // keep listings without district info
      const nd = normalize(l.district);
      // Substring match: "stary mokotow" contains "mokotow"
      return normalizedDistricts.some(d => nd.includes(d) || d.includes(nd));
    });
  }

  // Deduplicate by platformId + platform
  const seen = new Set<string>();
  const deduped: Listing[] = [];
  for (const l of filtered) {
    const key = `${l.platform}:${l.platformId}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(l);
    }
  }

  // Sort by newest first (most relevant for monitoring new listings)
  deduped.sort((a, b) => {
    const ta = new Date(a.createdAt || 0).getTime();
    const tb = new Date(b.createdAt || 0).getTime();
    return tb - ta; // newest first
  });

  if (deduped.length === 0) {
    return `No rental listings found matching your criteria. I searched ${doOlx ? 'OLX' : ''}${doOlx && doOtodom ? ' + ' : ''}${doOtodom ? 'Otodom' : ''} for ${roomsFrom ?? 'any'}-room apartments in ${city}${districts.length ? ' (' + districts.join(', ') + ')' : ''}. Try broadening the search (more districts, relax room count, or add more platforms).`;
  }

  // ---- Step B: Send progress message ----
  const candidateCount = Math.min(deduped.length, 25);
  await sendFn(
    ctx.chatId,
    `Found ${deduped.length} listings. Analyzing top ${candidateCount}...`,
  );

  // ---- Step C: Analyze top candidates ----
  const candidates = deduped.slice(0, 25);
  const accepted: Array<{
    listing: Listing;
    parsedData: ParsedRentalData | null;
    locationScore: LocationScore | null;
  }> = [];
  const rejected: RejectionReason[] = [];

  // Store all candidates in context for later reference
  ctx.lastSearchResults = candidates;

  for (let i = 0; i < candidates.length; i++) {
    const listing = candidates[i];

    // Send progress update every 3-4 listings
    if (i > 0 && i % 3 === 0) {
      await sendFn(
        ctx.chatId,
        `Analyzing listing ${i + 1}/${candidateCount}...`,
      );
    }

    // Stop if we have enough accepted results
    if (accepted.length >= maxResults) break;

    try {
      // Fetch detail page for richer data
      console.log(`[find_rentals] ${i + 1}/${candidateCount}: ${listing.platform} "${listing.title.slice(0, 50)}"`);
      let enrichedListing = listing;
      if (listing.platform === 'otodom') {
        try {
          const detail = await fetchOtodomDetail(listing.url);
          if (detail) enrichedListing = detail;
        } catch (detailErr) {
          console.error(`[find_rentals] Detail fetch failed, using search data:`, detailErr);
        }
      } else if (listing.platform === 'olx' && !listing.phone) {
        try {
          const phone = await fetchOlxPhone(listing.platformId);
          if (phone) enrichedListing = { ...listing, phone };
        } catch { /* phone is optional */ }
      }

      // AI extraction — best effort, don't block on failure
      let parsedData: ParsedRentalData | null = null;
      if (enrichedListing.description) {
        try {
          console.log(`[find_rentals] AI parsing...`);
          parsedData = await parseRentalListing(enrichedListing);
          console.log(`[find_rentals] AI parsed: total=${parsedData?.totalMonthlyCost}, contract=${parsedData?.contractType}, kaucja=${parsedData?.deposit}`);
        } catch (parseErr) {
          console.error(`[find_rentals] AI parse failed (showing listing anyway):`, parseErr);
        }
      }

      // Budget filter: check if estimated total exceeds budget
      if (priceTo != null && parsedData?.totalMonthlyCost != null) {
        if (parsedData.totalMonthlyCost > priceTo) {
          rejected.push({
            url: enrichedListing.url,
            title: enrichedListing.title,
            reason: `estimated total ${parsedData.totalMonthlyCost} PLN exceeds budget ${priceTo} PLN`,
          });
          continue;
        }
      }

      // Contract preference filter
      if (
        contractPreference === 'najem_okazjonalny' &&
        parsedData?.contractType != null &&
        parsedData.contractType !== 'najem_okazjonalny'
      ) {
        rejected.push({
          url: enrichedListing.url,
          title: enrichedListing.title,
          reason: `contract type "${parsedData.contractType}" does not match preference "najem_okazjonalny"`,
        });
        continue;
      }

      // Location scoring — geocode if no coordinates
      let locationScore: LocationScore | null = null;
      let lat = enrichedListing.lat;
      let lng = enrichedListing.lng;
      const wantLocation = amenities.length > 0 || workAddress;

      if (!lat || !lng) {
        // Try to geocode from address info
        try {
          const { geocodeAddress, buildAddressFromListing } = await import('./maps.js');
          const addr = buildAddressFromListing(enrichedListing);
          console.log(`[find_rentals] No coords, geocoding: "${addr}"`);
          const geo = await geocodeAddress(addr);
          if (geo) { lat = geo.lat; lng = geo.lng; }
        } catch { /* geocoding is best-effort */ }
      }

      if (lat && lng && wantLocation) {
        try {
          const amenityPrefs: AmenityPreference[] = amenities.map((a) => ({
            type: a.type,
            maxMinutes: a.maxMinutes,
          }));

          locationScore = await scoreLocation(
            lat,
            lng,
            amenityPrefs,
            workAddress,
            commuteMode,
          );

          // Amenity check is SOFT — don't reject, just note in the score
          // The card will show ✓/⚠️ per amenity, AI summarizes at the end
        } catch (locErr) {
          console.error(`[find_rentals] Location scoring error for ${enrichedListing.url}:`, locErr);
          // Don't reject, just skip location data
        }
      }

      accepted.push({
        listing: enrichedListing,
        parsedData,
        locationScore,
      });
    } catch (err) {
      console.error(`[find_rentals] Error processing ${listing.url}:`, err);
      rejected.push({
        url: listing.url,
        title: listing.title,
        reason: `processing error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ---- Step D: Send results to user ----
  if (accepted.length === 0) {
    const rejectionSummary = rejected.length > 0
      ? `\nRejection reasons:\n${rejected.map((r) => `- ${r.title}: ${r.reason}`).join('\n')}`
      : '';
    return `Analyzed ${candidateCount} listings but none passed the filters.${rejectionSummary}\nTry increasing the budget, relaxing amenity requirements, or broadening the search area.`;
  }

  for (let i = 0; i < accepted.length; i++) {
    const { listing, parsedData, locationScore } = accepted[i];

    // Send photos first (if available)
    if (listing.photos.length > 0) {
      try {
        await sendPhotosFn(ctx.chatId, listing.photos.slice(0, 10));
      } catch (photoErr) {
        console.error(`[find_rentals] Photo send error for ${listing.url}:`, photoErr);
      }
    }

    // Send the rich card
    const card = formatRichRentalNotification(
      listing,
      parsedData ?? undefined,
      locationScore ?? undefined,
    );
    await sendFn(ctx.chatId, card);
  }

  // Update context with the accepted listings for later reference
  ctx.lastSearchResults = accepted.map((a) => a.listing);
  if (accepted.length > 0) {
    ctx.lastDetailListing = accepted[0].listing;
  }

  // ---- Step E: Return summary to Claude ----
  const rejectionBreakdown = rejected.length > 0
    ? `\nRejected ${rejected.length}: ${rejected.map((r) => r.reason).join('; ')}`
    : '';

  return `Showed ${accepted.length} listing(s) to the user with photos and rich cards. Analyzed ${candidateCount} candidates total.${rejectionBreakdown}`;
}

// ---------------------------------------------------------------------------
// 2. find_items
// ---------------------------------------------------------------------------

async function execFindItems(
  input: Record<string, unknown>,
  ctx: UserContext,
  sendFn: SendFn,
  sendPhotosFn: SendPhotosFn,
): Promise<string> {
  const query = String(input.query ?? '');
  const city = input.city ? String(input.city).toLowerCase().trim() : undefined;
  const cityId = city ? resolveCityId(city) : undefined;
  const priceFrom = input.priceFrom as number | undefined;
  const priceTo = input.priceTo as number | undefined;
  const maxResults = Math.min(Math.max((input.maxResults as number) || 5, 1), 10);

  const result = await searchItems({
    query,
    cityId,
    priceFrom,
    priceTo,
    limit: 30,
  });

  if (result.items.length === 0) {
    return 'No items found matching your search. Try different keywords or remove the city filter.';
  }

  const candidates = result.items.slice(0, maxResults * 2); // get extra for potential filtering
  ctx.lastSearchResults = candidates;

  await sendFn(ctx.chatId, `Found ${result.totalAvailable} items. Analyzing top ${Math.min(candidates.length, maxResults)}...`);

  const shown: ItemListing[] = [];

  for (let i = 0; i < candidates.length && shown.length < maxResults; i++) {
    const item = candidates[i];

    // AI condition analysis
    let parsedData = null;
    if (item.description) {
      try {
        parsedData = await parseItemListing(item);
      } catch (parseErr) {
        console.error(`[find_items] Parse error for ${item.url}:`, parseErr);
      }
    }

    // Fetch phone if not available
    if (!item.phone) {
      try {
        const phone = await fetchItemPhone(item.platformId);
        if (phone) item.phone = phone;
      } catch {
        // ignore phone fetch errors
      }
    }

    // Send photos
    if (item.photos.length > 0) {
      try {
        await sendPhotosFn(ctx.chatId, item.photos.slice(0, 10));
      } catch (photoErr) {
        console.error(`[find_items] Photo send error for ${item.url}:`, photoErr);
      }
    }

    // Send the rich card
    const card = formatRichItemNotification(item, parsedData ?? undefined);
    await sendFn(ctx.chatId, card);

    shown.push(item);
  }

  ctx.lastSearchResults = shown;

  return `Showed ${shown.length} item(s) to the user with photos and condition analysis. Total available: ${result.totalAvailable}.`;
}

// ---------------------------------------------------------------------------
// 3. create_monitor
// ---------------------------------------------------------------------------

async function execCreateMonitor(
  input: Record<string, unknown>,
  ctx: UserContext,
): Promise<string> {
  const type = String(input.type ?? 'rental') as 'rental' | 'item';
  const platformsInput = (input.platforms as string | undefined) ?? 'all';
  const platform = platformsInput === 'all' ? 'all' : platformsInput;

  // Build config from input, omitting undefined values
  const config: Record<string, unknown> = {};
  const configKeys = [
    'city', 'districts', 'province', 'priceFrom', 'priceTo',
    'roomsFrom', 'roomsTo', 'areaFrom', 'areaTo', 'ownerType',
    'query', 'workAddress', 'commuteMode', 'amenities',
    'contractPreference', 'platforms',
  ];
  for (const key of configKeys) {
    if (input[key] !== undefined && input[key] !== null) {
      config[key] = input[key];
    }
  }

  // Auto-resolve province from city if not provided
  if (config.city && !config.province) {
    const prov = CITY_PROVINCE_MAP[String(config.city).toLowerCase().trim()];
    if (prov) config.province = prov;
  }

  const monitorId = addMonitor(
    ctx.userId,
    type,
    platform as 'olx' | 'otodom' | 'all',
    config,
  );

  const details: string[] = [`Monitor created! ID: ${monitorId}`];
  details.push(`Type: ${type}`);
  details.push(`Platform: ${platform}`);
  for (const [k, v] of Object.entries(config)) {
    if (v != null) {
      if (Array.isArray(v)) {
        details.push(`${k}: ${JSON.stringify(v)}`);
      } else {
        details.push(`${k}: ${v}`);
      }
    }
  }
  details.push('\nI will notify you when new matching listings appear.');

  return details.join('\n');
}

// ---------------------------------------------------------------------------
// 4. update_monitor
// ---------------------------------------------------------------------------

async function execUpdateMonitor(
  input: Record<string, unknown>,
): Promise<string> {
  const monitorId = input.monitorId as number;
  const updates = input.updates as Record<string, unknown> | undefined;

  if (!monitorId) return 'monitorId is required.';
  if (!updates || Object.keys(updates).length === 0) return 'No updates provided.';

  const monitor = getMonitor(monitorId);
  if (!monitor) return `Monitor #${monitorId} not found.`;
  if (!monitor.active) return `Monitor #${monitorId} is inactive. Create a new one instead.`;

  // Merge updates into existing config
  const existingConfig = JSON.parse(monitor.config) as Record<string, unknown>;
  const newConfig = { ...existingConfig, ...updates };

  updateMonitorConfig(monitorId, newConfig);

  return `Monitor #${monitorId} updated.\nNew config: ${JSON.stringify(newConfig, null, 2)}`;
}

// ---------------------------------------------------------------------------
// 5. delete_monitor
// ---------------------------------------------------------------------------

async function execDeleteMonitor(
  input: Record<string, unknown>,
): Promise<string> {
  const monitorId = input.monitorId as number;
  if (!monitorId) return 'monitorId is required.';

  const monitor = getMonitor(monitorId);
  if (!monitor) return `Monitor #${monitorId} not found.`;

  deactivateMonitor(monitorId);
  return `Monitor #${monitorId} has been deactivated. You will no longer receive notifications for it.`;
}

// ---------------------------------------------------------------------------
// 6. list_monitors
// ---------------------------------------------------------------------------

async function execListMonitors(
  ctx: UserContext,
): Promise<string> {
  const monitors = getMonitors(ctx.userId);

  if (monitors.length === 0) {
    return 'You have no active monitors. I can create one for you if you\'d like to be notified about new listings.';
  }

  const lines: string[] = [`You have ${monitors.length} active monitor(s):\n`];

  for (const m of monitors) {
    const seenCount = getSeenCount(m.id);
    const config = JSON.parse(m.config) as Record<string, unknown>;
    const parts: string[] = [];

    parts.push(`Monitor #${m.id} (${m.type}, ${m.platform})`);
    if (config.city) parts.push(`  City: ${config.city}`);
    if (config.districts) parts.push(`  Districts: ${(config.districts as string[]).join(', ')}`);
    if (config.query) parts.push(`  Query: "${config.query}"`);
    if (config.priceTo) parts.push(`  Max budget: ${config.priceTo} PLN`);
    if (config.roomsFrom) parts.push(`  Rooms: ${config.roomsFrom}${config.roomsTo ? `-${config.roomsTo}` : '+'}`);
    if (config.amenities) {
      const amens = config.amenities as Array<{ type: string; maxMinutes: number }>;
      parts.push(`  Amenities: ${amens.map((a) => `${a.type} (${a.maxMinutes}min)`).join(', ')}`);
    }
    if (config.workAddress) parts.push(`  Commute to: ${config.workAddress}`);
    if (config.contractPreference) parts.push(`  Contract: ${config.contractPreference}`);
    parts.push(`  Listings seen: ${seenCount}`);
    parts.push(`  Created: ${m.created_at}`);

    lines.push(parts.join('\n'));
  }

  return lines.join('\n\n');
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  userId: number,
  chatId: number,
  context: UserContext,
  sendFn: (chatId: number, text: string) => Promise<void>,
  sendPhotosFn: (chatId: number, urls: string[]) => Promise<void>,
): Promise<string> {
  try {
    switch (name) {
      case 'find_rentals':
        return await execFindRentals(input, context, sendFn, sendPhotosFn);
      case 'find_items':
        return await execFindItems(input, context, sendFn, sendPhotosFn);
      case 'create_monitor':
        return await execCreateMonitor(input, context);
      case 'update_monitor':
        return await execUpdateMonitor(input);
      case 'delete_monitor':
        return await execDeleteMonitor(input);
      case 'list_monitors':
        return await execListMonitors(context);
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tool:${name}] Error:`, err);
    return `Tool error: ${message}`;
  }
}
