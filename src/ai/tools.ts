// Tool definitions for the Claude API + dispatcher that executes them
import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';

import { searchOlx, fetchOlxPhone, OLX_CATEGORIES, OLX_CITIES } from '../crawlers/olx.js';
import { searchItems } from '../crawlers/olx-items.js';
import type { ItemListing } from '../crawlers/olx-items.js';
import { searchOtodom, fetchOtodomDetail } from '../crawlers/otodom.js';
import {
  addMonitor,
  getMonitors,
  getMonitor,
  getDb,
  deactivateMonitor,
  getSeenCount,
} from '../storage/db.js';
import type { Listing } from '../types.js';

// ---------------------------------------------------------------------------
// User context — tracks state across the conversation for a single user
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
// City name → OLX city ID mapping
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

// City → default province for Otodom
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
// Tool definitions (Claude API format)
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'search_rentals',
    description:
      'Search for rental apartments/rooms on OLX and/or Otodom. Returns a numbered list of listings with price, area, rooms, district, and contact info.',
    input_schema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: 'City name (e.g. "warszawa", "krakow", "wroclaw", "gdansk", "poznan", "lodz", "katowice")',
        },
        platforms: {
          type: 'array',
          items: { type: 'string', enum: ['olx', 'otodom'] },
          description: 'Platforms to search. Defaults to ["olx"].',
        },
        district: {
          type: 'string',
          description: 'District within the city (e.g. "mokotow", "wola", "srodmiescie")',
        },
        province: {
          type: 'string',
          description: 'Province/voivodeship (e.g. "mazowieckie"). Auto-resolved from city if omitted.',
        },
        priceFrom: { type: 'number', description: 'Minimum monthly rent in PLN' },
        priceTo: { type: 'number', description: 'Maximum monthly rent in PLN' },
        roomsFrom: { type: 'number', description: 'Minimum number of rooms' },
        roomsTo: { type: 'number', description: 'Maximum number of rooms' },
        areaFrom: { type: 'number', description: 'Minimum area in m²' },
        areaTo: { type: 'number', description: 'Maximum area in m²' },
        ownerType: {
          type: 'string',
          enum: ['ALL', 'PRIVATE', 'AGENCY'],
          description: 'Filter by owner type (Otodom only)',
        },
        limit: {
          type: 'number',
          description: 'Number of results to return (default 5, max 10)',
        },
      },
      required: ['city'],
    },
  },
  {
    name: 'search_items',
    description:
      'Search for items (furniture, electronics, etc.) on OLX by keyword. Returns a numbered list of items with price, condition, and location.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords (e.g. "biurko", "iphone 15", "sofa")' },
        city: { type: 'string', description: 'City name to filter by' },
        priceFrom: { type: 'number', description: 'Minimum price in PLN' },
        priceTo: { type: 'number', description: 'Maximum price in PLN' },
        limit: { type: 'number', description: 'Number of results (default 5, max 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_listing_details',
    description:
      'Get full details for a specific listing. Use listingRef (number from previous search results) or provide a direct URL. Returns description, all amenities, contact info, deposit, and more.',
    input_schema: {
      type: 'object',
      properties: {
        listingRef: {
          type: 'number',
          description: 'Number from the previous search results (1-based index)',
        },
        url: { type: 'string', description: 'Direct listing URL (otodom.pl or olx.pl)' },
      },
    },
  },
  {
    name: 'get_phone_number',
    description: 'Fetch the phone number for an OLX listing.',
    input_schema: {
      type: 'object',
      properties: {
        platformId: { type: 'string', description: 'OLX listing platform ID' },
        platform: { type: 'string', enum: ['olx'], description: 'Platform (only OLX supports phone fetch)' },
      },
      required: ['platformId'],
    },
  },
  {
    name: 'create_monitor',
    description:
      'Create a persistent monitor that periodically checks for new listings matching the criteria and sends notifications to the user.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['rental', 'item'], description: 'Monitor type' },
        platforms: {
          type: 'array',
          items: { type: 'string', enum: ['olx', 'otodom'] },
          description: 'Platforms to monitor',
        },
        city: { type: 'string', description: 'City name' },
        district: { type: 'string', description: 'District' },
        province: { type: 'string', description: 'Province' },
        priceFrom: { type: 'number', description: 'Min price' },
        priceTo: { type: 'number', description: 'Max price' },
        roomsFrom: { type: 'number', description: 'Min rooms' },
        roomsTo: { type: 'number', description: 'Max rooms' },
        areaFrom: { type: 'number', description: 'Min area m²' },
        areaTo: { type: 'number', description: 'Max area m²' },
        ownerType: { type: 'string', enum: ['ALL', 'PRIVATE', 'AGENCY'] },
        query: { type: 'string', description: 'Search keywords (for item monitors)' },
        workAddress: { type: 'string', description: 'Work/commute destination address' },
        commuteMode: { type: 'string', enum: ['transit', 'driving', 'walking', 'bicycling'] },
        amenities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Desired nearby amenities (metro, gym, supermarket, park, pool)',
        },
      },
      required: ['type'],
    },
  },
  {
    name: 'update_monitor',
    description: 'Update an existing monitor\'s configuration.',
    input_schema: {
      type: 'object',
      properties: {
        monitorId: { type: 'number', description: 'Monitor ID to update' },
        updates: {
          type: 'object',
          description: 'Partial config updates to merge into the existing monitor config',
        },
      },
      required: ['monitorId', 'updates'],
    },
  },
  {
    name: 'delete_monitor',
    description: 'Deactivate/delete a monitor. It will stop checking for new listings.',
    input_schema: {
      type: 'object',
      properties: {
        monitorId: { type: 'number', description: 'Monitor ID to deactivate' },
      },
      required: ['monitorId'],
    },
  },
  {
    name: 'list_monitors',
    description: 'List all active monitors for the current user, showing their config and how many listings have been seen.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'check_location',
    description:
      'Check amenities near a location and/or calculate commute time. Can resolve a listing from the last search results by number, or use lat/lng directly.',
    input_schema: {
      type: 'object',
      properties: {
        lat: { type: 'number', description: 'Latitude' },
        lng: { type: 'number', description: 'Longitude' },
        listingRef: { type: 'number', description: 'Listing number from last search results (resolves lat/lng from context)' },
        checkAmenities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Amenities to check for nearby (e.g. ["metro", "gym", "supermarket"])',
        },
        commuteToAddress: { type: 'string', description: 'Destination address for commute calculation' },
        commuteMode: {
          type: 'string',
          enum: ['transit', 'driving', 'walking', 'bicycling'],
          description: 'Commute transport mode (default: transit)',
        },
      },
    },
  },
  {
    name: 'send_listing_photos',
    description: 'Send listing photos as a Telegram photo album to the user.',
    input_schema: {
      type: 'object',
      properties: {
        listingRef: { type: 'number', description: 'Listing number from last search results' },
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Direct photo URLs to send (if not using listingRef)',
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Listing condensers — produce concise summaries for Claude's context
// ---------------------------------------------------------------------------

function condenseListing(listing: Listing, index: number): string {
  const parts: string[] = [];
  parts.push(`#${index + 1}: ${listing.title}`);
  parts.push(`  Platform: ${listing.platform} | ID: ${listing.platformId}`);
  parts.push(`  Price: ${listing.price} PLN/month`);
  if (listing.rent != null) {
    parts.push(`  Czynsz (admin fee): ${listing.rent} PLN`);
    parts.push(`  Total monthly: ${listing.price + listing.rent} PLN`);
  }
  if (listing.deposit != null) parts.push(`  Kaucja (deposit): ${listing.deposit} PLN`);
  if (listing.area != null) parts.push(`  Area: ${listing.area} m²`);
  if (listing.rooms != null) parts.push(`  Rooms: ${listing.rooms}`);
  if (listing.floor != null) parts.push(`  Floor: ${listing.floor}`);
  if (listing.buildingType) parts.push(`  Building: ${listing.buildingType}`);
  if (listing.district) parts.push(`  District: ${listing.district}`);
  parts.push(`  City: ${listing.city}`);
  if (listing.advertiserType) parts.push(`  Owner: ${listing.advertiserType}${listing.agencyName ? ` (${listing.agencyName})` : ''}`);
  if (listing.phone) parts.push(`  Phone: ${listing.phone}`);
  parts.push(`  URL: ${listing.url}`);
  if (listing.photos.length > 0) parts.push(`  Photos: ${listing.photos.length} available`);
  return parts.join('\n');
}

function condenseItem(item: ItemListing, index: number): string {
  const parts: string[] = [];
  parts.push(`#${index + 1}: ${item.title}`);
  parts.push(`  Platform: olx | ID: ${item.platformId}`);
  parts.push(`  Price: ${item.price} ${item.currency}${item.negotiable ? ' (negotiable)' : ''}`);
  if (item.condition) parts.push(`  Condition: ${item.condition}`);
  if (item.district) parts.push(`  District: ${item.district}`);
  parts.push(`  City: ${item.city}`);
  if (item.phone) parts.push(`  Phone: ${item.phone}`);
  parts.push(`  URL: ${item.url}`);
  if (item.photos.length > 0) parts.push(`  Photos: ${item.photos.length} available`);
  return parts.join('\n');
}

function condenseDetailListing(listing: Listing): string {
  const parts: string[] = [];
  parts.push(`Title: ${listing.title}`);
  parts.push(`Platform: ${listing.platform} | ID: ${listing.platformId}`);
  parts.push(`URL: ${listing.url}`);
  parts.push(`Price: ${listing.price} PLN/month`);
  if (listing.rent != null) {
    parts.push(`Czynsz (admin fee): ${listing.rent} PLN`);
    parts.push(`Total monthly cost: ${listing.price + listing.rent} PLN`);
  }
  if (listing.deposit != null) parts.push(`Kaucja (deposit): ${listing.deposit} PLN`);
  if (listing.area != null) parts.push(`Area: ${listing.area} m²`);
  if (listing.rooms != null) parts.push(`Rooms: ${listing.rooms}`);
  if (listing.floor != null) parts.push(`Floor: ${listing.floor}${listing.buildingFloor ? ` / ${listing.buildingFloor}` : ''}`);
  if (listing.buildingType) parts.push(`Building type: ${listing.buildingType}`);
  if (listing.heating) parts.push(`Heating: ${listing.heating}`);
  if (listing.furniture != null) parts.push(`Furnished: ${listing.furniture ? 'yes' : 'no'}`);
  if (listing.parking) parts.push(`Parking: ${listing.parking}`);
  parts.push(`City: ${listing.city}`);
  if (listing.district) parts.push(`District: ${listing.district}`);
  if (listing.street) parts.push(`Street: ${listing.street}`);
  if (listing.lat != null && listing.lng != null) parts.push(`Coordinates: ${listing.lat}, ${listing.lng}`);
  if (listing.advertiserType) parts.push(`Owner: ${listing.advertiserType}${listing.agencyName ? ` (${listing.agencyName})` : ''}`);
  if (listing.contactName) parts.push(`Contact: ${listing.contactName}`);
  if (listing.phone) parts.push(`Phone: ${listing.phone}`);
  parts.push(`Photos: ${listing.photos.length} available`);
  if (listing.description) {
    const desc = listing.description.length > 1000
      ? listing.description.slice(0, 1000) + '...'
      : listing.description;
    parts.push(`\nDescription:\n${desc}`);
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Resolve a listingRef (1-based) from context
// ---------------------------------------------------------------------------

function resolveListingRef(
  ref: number,
  ctx: UserContext,
): Listing | ItemListing | null {
  if (ref < 1 || ref > ctx.lastSearchResults.length) return null;
  return ctx.lastSearchResults[ref - 1];
}

function isRentalListing(item: Listing | ItemListing): item is Listing {
  return 'slug' in item;
}

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

type SendPhotosFn = (chatId: number, urls: string[]) => Promise<void>;

async function execSearchRentals(
  input: Record<string, unknown>,
  ctx: UserContext,
): Promise<string> {
  const city = String(input.city ?? '').toLowerCase().trim();
  const platforms = (input.platforms as string[] | undefined) ?? ['olx'];
  const district = input.district ? String(input.district).toLowerCase().trim() : undefined;
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
  const limit = Math.min(Math.max((input.limit as number) || 5, 1), 10);

  const allListings: Listing[] = [];

  // OLX search
  if (platforms.includes('olx')) {
    const cityId = resolveCityId(city);
    const result = await searchOlx({
      categoryId: OLX_CATEGORIES.MIESZKANIA_WYNAJEM,
      cityId,
      priceFrom,
      priceTo,
      limit: limit * 2, // fetch extra, we'll trim later
    });
    allListings.push(...result.listings);
  }

  // Otodom search
  if (platforms.includes('otodom')) {
    const result = await searchOtodom({
      type: 'wynajem',
      estate: 'mieszkanie',
      province,
      city: city || undefined,
      district,
      priceFrom,
      priceTo,
      areaFrom,
      areaTo,
      roomsFrom,
      roomsTo,
      ownerType: (ownerType as 'ALL' | 'PRIVATE' | 'AGENCY') ?? undefined,
      limit: limit * 2,
    });
    allListings.push(...result.listings);
  }

  // Filter by rooms if OLX (OLX doesn't support rooms filter in API params well)
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

  const results = deduped.slice(0, limit);
  ctx.lastSearchResults = results;

  if (results.length === 0) {
    return 'No rental listings found matching your criteria. Try broadening the search (higher price, fewer rooms, different district, or add more platforms).';
  }

  const summaries = results.map((l, i) => condenseListing(l, i));
  return `Found ${deduped.length} listings (showing ${results.length}):\n\n${summaries.join('\n\n')}`;
}

async function execSearchItems(
  input: Record<string, unknown>,
  ctx: UserContext,
): Promise<string> {
  const query = String(input.query ?? '');
  const city = input.city ? String(input.city).toLowerCase().trim() : undefined;
  const cityId = city ? resolveCityId(city) : undefined;
  const priceFrom = input.priceFrom as number | undefined;
  const priceTo = input.priceTo as number | undefined;
  const limit = Math.min(Math.max((input.limit as number) || 5, 1), 10);

  const result = await searchItems({
    query,
    cityId,
    priceFrom,
    priceTo,
    limit: limit * 2,
  });

  const items = result.items.slice(0, limit);
  // Store as generic results for reference
  ctx.lastSearchResults = items;

  if (items.length === 0) {
    return 'No items found matching your search. Try different keywords or remove the city filter.';
  }

  const summaries = items.map((item, i) => condenseItem(item, i));
  return `Found ${result.totalAvailable} items (showing ${items.length}):\n\n${summaries.join('\n\n')}`;
}

async function execGetListingDetails(
  input: Record<string, unknown>,
  ctx: UserContext,
): Promise<string> {
  const listingRef = input.listingRef as number | undefined;
  const url = input.url as string | undefined;

  let listing: Listing | ItemListing | null = null;

  if (listingRef != null) {
    listing = resolveListingRef(listingRef, ctx);
    if (!listing) {
      return `Listing #${listingRef} not found. I only have ${ctx.lastSearchResults.length} results from the last search.`;
    }
  }

  // If we have a URL (direct or resolved from listing), fetch full details
  const targetUrl = url ?? (listing ? listing.url : null);

  if (!targetUrl) {
    return 'Please provide either a listingRef (number from search results) or a direct URL.';
  }

  // For Otodom listings, fetch full detail page
  if (targetUrl.includes('otodom.pl')) {
    const detail = await fetchOtodomDetail(targetUrl);
    if (!detail) {
      return 'Could not fetch details for this Otodom listing. The listing may have been removed.';
    }
    ctx.lastDetailListing = detail;
    return condenseDetailListing(detail);
  }

  // For OLX listings, we already have most data; try to enrich with phone
  if (listing && isRentalListing(listing)) {
    if (!listing.phone) {
      const phone = await fetchOlxPhone(listing.platformId);
      if (phone) listing.phone = phone;
    }
    ctx.lastDetailListing = listing;
    return condenseDetailListing(listing);
  }

  // If it's an OLX item listing, return what we have
  if (listing && !isRentalListing(listing)) {
    const item = listing as ItemListing;
    if (!item.phone) {
      const phone = await fetchOlxPhone(item.platformId);
      if (phone) item.phone = phone;
    }
    return condenseItem(item, 0);
  }

  // URL provided but no listing in context — try fetching as Otodom
  if (targetUrl.includes('olx.pl')) {
    return 'For OLX listings, please search first and then reference by number. OLX does not have a public detail API.';
  }

  return 'Could not determine how to fetch details for this listing.';
}

async function execGetPhoneNumber(
  input: Record<string, unknown>,
): Promise<string> {
  const platformId = String(input.platformId ?? '');
  if (!platformId) return 'platformId is required.';

  const phone = await fetchOlxPhone(platformId);
  return phone ? `Phone number: ${phone}` : 'Phone number not available for this listing.';
}

async function execCreateMonitor(
  input: Record<string, unknown>,
  ctx: UserContext,
): Promise<string> {
  const type = String(input.type ?? 'rental') as 'rental' | 'item';
  const platforms = (input.platforms as string[] | undefined) ?? ['olx'];
  const platform = platforms.length === 1 ? platforms[0] : 'all';

  // Build config from input, omitting undefined values
  const config: Record<string, unknown> = {};
  const configKeys = [
    'city', 'district', 'province', 'priceFrom', 'priceTo',
    'roomsFrom', 'roomsTo', 'areaFrom', 'areaTo', 'ownerType',
    'query', 'workAddress', 'commuteMode', 'amenities',
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
  details.push(`Platforms: ${platforms.join(', ')}`);
  for (const [k, v] of Object.entries(config)) {
    if (v != null) details.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
  }
  details.push('\nI will notify you when new matching listings appear.');

  return details.join('\n');
}

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
  const existingConfig = JSON.parse(monitor.config);
  const newConfig = { ...existingConfig, ...updates };

  // Update in DB
  const db = getDb();
  db.prepare('UPDATE monitors SET config = ? WHERE id = ?').run(
    JSON.stringify(newConfig),
    monitorId,
  );

  return `Monitor #${monitorId} updated.\nNew config: ${JSON.stringify(newConfig, null, 2)}`;
}

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

async function execListMonitors(
  ctx: UserContext,
): Promise<string> {
  const monitors = getMonitors(ctx.userId);

  if (monitors.length === 0) {
    return 'You have no active monitors. I can create one for you if you\'d like to be notified about new listings.';
  }

  const lines: string[] = [`You have ${monitors.length} active monitor(s):\n`];

  for (const m of monitors) {
    const seen = getSeenCount(m.id);
    const config = JSON.parse(m.config);
    const parts: string[] = [];

    parts.push(`Monitor #${m.id} (${m.type}, ${m.platform})`);
    if (config.city) parts.push(`  City: ${config.city}`);
    if (config.district) parts.push(`  District: ${config.district}`);
    if (config.query) parts.push(`  Query: "${config.query}"`);
    if (config.priceTo) parts.push(`  Max price: ${config.priceTo} PLN`);
    if (config.roomsFrom) parts.push(`  Rooms: ${config.roomsFrom}${config.roomsTo ? `-${config.roomsTo}` : '+'}`);
    parts.push(`  Listings seen: ${seen}`);
    parts.push(`  Created: ${m.created_at}`);

    lines.push(parts.join('\n'));
  }

  return lines.join('\n\n');
}

async function execCheckLocation(
  input: Record<string, unknown>,
  ctx: UserContext,
): Promise<string> {
  let lat = input.lat as number | undefined;
  let lng = input.lng as number | undefined;

  // Resolve from listing ref if provided
  if (input.listingRef != null) {
    const listing = resolveListingRef(input.listingRef as number, ctx);
    if (!listing) {
      return `Listing #${input.listingRef} not found in the last search results.`;
    }
    if (isRentalListing(listing)) {
      lat = listing.lat ?? undefined;
      lng = listing.lng ?? undefined;
    }
    if (lat == null || lng == null) {
      return 'This listing does not have coordinates. Try fetching full details first with get_listing_details, or provide lat/lng manually.';
    }
  }

  if (lat == null || lng == null) {
    return 'Please provide lat/lng coordinates or a listingRef that has coordinates.';
  }

  // TODO: Implement Google Maps API calls in maps.ts
  // For now, return a stub acknowledging the request
  const checkAmenities = (input.checkAmenities as string[] | undefined) ?? [];
  const commuteToAddress = input.commuteToAddress as string | undefined;
  const commuteMode = input.commuteMode as string | undefined ?? 'transit';

  const parts: string[] = [];
  parts.push(`Location: ${lat}, ${lng}`);

  if (checkAmenities.length > 0) {
    parts.push(`\nAmenity check requested for: ${checkAmenities.join(', ')}`);
    parts.push('(Location checking will be available once Google Maps integration is complete. For now, you can check the location on Google Maps directly.)');
  }

  if (commuteToAddress) {
    parts.push(`\nCommute check requested: to "${commuteToAddress}" by ${commuteMode}`);
    parts.push('(Commute calculation will be available once Google Maps integration is complete.)');
  }

  parts.push(`\nGoogle Maps link: https://www.google.com/maps?q=${lat},${lng}`);

  return parts.join('\n');
}

async function execSendListingPhotos(
  input: Record<string, unknown>,
  ctx: UserContext,
  sendPhotosFn: SendPhotosFn | null,
): Promise<string> {
  let urls = input.urls as string[] | undefined;

  // Resolve from listing ref
  if (input.listingRef != null && !urls) {
    const listing = resolveListingRef(input.listingRef as number, ctx);
    if (!listing) {
      return `Listing #${input.listingRef} not found in the last search results.`;
    }
    urls = listing.photos;
  }

  if (!urls || urls.length === 0) {
    return 'No photos available for this listing.';
  }

  // Limit to 10 photos (Telegram album limit)
  const toSend = urls.slice(0, 10);

  if (sendPhotosFn) {
    try {
      await sendPhotosFn(ctx.chatId, toSend);
      return `${toSend.length} photo(s) sent to the chat.`;
    } catch (err) {
      return `Failed to send photos: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return `${toSend.length} photo URLs available but photo sending is not configured.`;
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
  sendPhotosFn: SendPhotosFn | null = null,
): Promise<string> {
  try {
    switch (name) {
      case 'search_rentals':
        return await execSearchRentals(input, context);
      case 'search_items':
        return await execSearchItems(input, context);
      case 'get_listing_details':
        return await execGetListingDetails(input, context);
      case 'get_phone_number':
        return await execGetPhoneNumber(input);
      case 'create_monitor':
        return await execCreateMonitor(input, context);
      case 'update_monitor':
        return await execUpdateMonitor(input);
      case 'delete_monitor':
        return await execDeleteMonitor(input);
      case 'list_monitors':
        return await execListMonitors(context);
      case 'check_location':
        return await execCheckLocation(input, context);
      case 'send_listing_photos':
        return await execSendListingPhotos(input, context, sendPhotosFn);
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tool:${name}] Error:`, err);
    return `Tool error: ${message}`;
  }
}
