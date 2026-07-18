// Tool definitions for the Claude API + dispatcher that executes them
// Deep pipeline tools: find_rentals, find_items, create_monitor, update_monitor, delete_monitor, list_monitors
import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import { customAlphabet } from 'nanoid';

import { searchItems, fetchItemPhone } from '../crawlers/olx-items.js';
import type { ItemListing } from '../crawlers/olx-items.js';
import { parseRentalListing, parseItemListing, evaluateRejection, triageRentalListing } from './parse-listing.js';
import { scoreLocation } from './maps.js';
import type { AmenityPreference } from './maps.js';
import { formatRichRentalNotification, formatRichItemNotification, splitMessage, captionLength } from '../bot/format.js';
import { searchRentalListings, CITY_PROVINCE_MAP, resolveCityId } from '../search/rental-search.js';
import { enrichRentalListing } from '../search/enrich-listing.js';
import { checkAmenityGate, resolveStrictAmenities } from '../search/amenity-gate.js';
import { computeFitScore, preScore } from '../search/fit-score.js';
import {
  addMonitor,
  getMonitors,
  getMonitor,
  deactivateMonitor,
  getSeenCount,
  updateMonitorConfig,
  cacheListing,
  getCachedListingByResultId,
  getParsedListing,
  getAuthorizedTelegramIds,
} from '../storage/db.js';
import type { Listing, ParsedRentalData, ParsedItemData, LocationScore } from '../types.js';
import { computeRentalCost, exceedsBudgetFloor } from '../cost.js';

// ---------------------------------------------------------------------------
// Short human-readable ID generator (nanoid, unambiguous alphabet)
// ---------------------------------------------------------------------------

// Unambiguous alphabet: removed 0/O, 1/I/L, U/V confusion
const genId = customAlphabet('23456789ABCDEFGHJKMNPQRSTVWXYZ', 6);

// ---------------------------------------------------------------------------
// User context -- tracks state across the conversation for a single user
// ---------------------------------------------------------------------------

export interface UserContext {
  lastSearchResults: Array<Listing | ItemListing>;
  lastDetailListing: Listing | null;
  lastSearchId: string | null;
  /** Maps result ID → listing for reference by Claude */
  resultMap: Map<string, Listing | ItemListing>;
  userId: number;
  chatId: number;
}

const contexts = new Map<number, UserContext>();

export function getOrCreateContext(userId: number, chatId: number): UserContext {
  let ctx = contexts.get(userId);
  if (!ctx) {
    ctx = { lastSearchResults: [], lastDetailListing: null, lastSearchId: null, resultMap: new Map(), userId, chatId };
    contexts.set(userId, ctx);
  }
  // Always keep chatId up to date (user may message from different chats)
  ctx.chatId = chatId;
  return ctx;
}

function seedResultForFamily(ctx: UserContext, resultId: string, listing: Listing | ItemListing): void {
  ctx.resultMap.set(resultId, listing);
  for (const uid of getAuthorizedTelegramIds()) {
    if (uid === ctx.userId) continue;
    getOrCreateContext(uid, uid).resultMap.set(resultId, listing);
  }
}

function seedSearchResultsForFamily(ctx: UserContext, listings: (Listing | ItemListing)[]): void {
  ctx.lastSearchResults = listings;
  for (const uid of getAuthorizedTelegramIds()) {
    if (uid === ctx.userId) continue;
    getOrCreateContext(uid, uid).lastSearchResults = listings;
  }
}

// ---------------------------------------------------------------------------
// Send function types
// ---------------------------------------------------------------------------

type SendFn = (chatId: number, text: string, opts?: Record<string, unknown>) => Promise<void>;
type SendPhotosFn = (chatId: number, urls: string[], caption?: string) => Promise<void>;

/** Escape HTML special chars for Telegram HTML parse_mode */
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
        roomsFrom: { type: 'number', description: 'Number of ROOMS (Polish pokoje) in the apartment. For an EXACT count (e.g. "4 rooms") set roomsFrom AND roomsTo to the same value. For a range ("3-4") set both ends. If you set only roomsFrom it is treated as an exact count, not a minimum. Single-room/coliving rentals are auto-excluded.' },
        roomsTo: { type: 'number', description: 'Upper bound of the room range. Must be set (equal to roomsFrom for an exact count).' },
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
              type: { type: 'string', enum: ['metro', 'tram', 'bus', 'gym', 'pool', 'supermarket', 'groceries', 'park', 'pharmacy', 'airport', 'cafe', 'restaurant'], description: 'Amenity type' },
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
        rejectionCriteria: {
          type: 'string',
          description: 'Free-text criteria for rejecting listings. The AI will evaluate each listing against this. E.g. "no ground floor", "must have balcony", "exclude agencies"',
        },
        strictAmenities: {
          type: 'boolean',
          description: 'If true, hard-reject listings where metro/tram/bus are beyond maxMinutes walking distance. Default: score only on card. Set true when user asks for strict walking distance (e.g. "really 5 min walk to metro").',
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
        mandatoryKeywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords that MUST appear in the listing title. Used to filter out irrelevant results. E.g. for "Galaxy XR" search, mandatory keywords would be ["galaxy", "xr"]',
        },
        city: { type: 'string', description: 'City name to filter by' },
        priceFrom: { type: 'number', description: 'Minimum price in PLN' },
        priceTo: { type: 'number', description: 'Maximum price in PLN' },
        maxResults: { type: 'number', description: 'Number of results to show (default 5, max 10)' },
        rejectionCriteria: {
          type: 'string',
          description: 'Free-text criteria for rejecting items. The AI will evaluate each listing against this. E.g. "exclude non-AMOLED displays", "must have original box", "no scratches on screen"',
        },
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
        roomsFrom: { type: 'number', description: 'Number of ROOMS. For an exact count set roomsFrom AND roomsTo equal; for a range set both ends. A lone roomsFrom is treated as an EXACT count, not a minimum.' },
        roomsTo: { type: 'number', description: 'Upper bound of the room range (equal to roomsFrom for an exact count).' },
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
              type: { type: 'string', enum: ['metro', 'tram', 'bus', 'gym', 'pool', 'supermarket', 'groceries', 'park', 'pharmacy', 'airport', 'cafe', 'restaurant'] },
              maxMinutes: { type: 'number' },
            },
            required: ['type', 'maxMinutes'],
          },
          description: 'Desired nearby amenities',
        },
        workAddress: { type: 'string', description: 'Work/commute destination address' },
        commuteMode: { type: 'string', enum: ['transit', 'driving', 'walking', 'bicycling'] },
        contractPreference: { type: 'string', enum: ['najem_okazjonalny', 'any'] },
        rejectionCriteria: {
          type: 'string',
          description: 'Free-text criteria for rejecting listings. The AI will evaluate each listing against this.',
        },
        strictAmenities: {
          type: 'boolean',
          description: 'Hard-reject when metro/tram/bus exceed maxMinutes walking. Persisted in monitor config.',
        },
        // Item search params
        query: { type: 'string', description: 'Search keywords (for item monitors)' },
        mandatoryKeywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords that MUST appear in listing title (for item monitors). Same as find_items.',
        },
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
    description: 'List all active family monitors with config and seen counts.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },

  // ---- 7. get_listing ----
  {
    name: 'get_listing',
    description:
      'Fetch the full details of a previously-seen listing (accepted OR rejected). ' +
      'Use this when the user asks a question about a specific listing without asking to see it again — ' +
      'e.g. "how many rooms did the Wola one have?", "what was the contract type on R1?". ' +
      'Returns the full Listing JSON + AI parse so YOU can answer the question. Does NOT send anything to the user.',
    input_schema: {
      type: 'object' as const,
      properties: {
        resultId: { type: 'string', description: 'Result ID shown to the user (e.g. "ABC123") in cards or rejection messages' },
      },
      required: ['resultId'],
    },
  },

  // ---- 8. show_listing ----
  {
    name: 'show_listing',
    description:
      'Re-send the full rich card with photos for a previously-seen listing (accepted OR rejected) directly to the user. ' +
      'Use this when the user asks to SEE the listing — e.g. "show me R1", "show the Wola one", "can I see the rejected one again". ' +
      'The card and photos go straight to the user; do NOT also describe the listing in your reply — just confirm briefly.',
    input_schema: {
      type: 'object' as const,
      properties: {
        resultId: { type: 'string', description: 'Result ID shown to the user (e.g. "ABC123") in cards or rejection messages' },
      },
      required: ['resultId'],
    },
  },
];

// ---------------------------------------------------------------------------
// Send helpers — module-level so execShowListing can re-use them
// ---------------------------------------------------------------------------

const CAPTION_LIMIT = 1024;

async function sendRejection(
  chatId: number,
  sendFn: SendFn,
  resultId: string,
  _url: string,
  title: string,
  reason: string,
): Promise<void> {
  try {
    await sendFn(
      chatId,
      `❌ [<b>${resultId}</b>] ${escHtml(title.slice(0, 50))} — ${escHtml(reason)}`,
      { parse_mode: 'HTML' },
    );
  } catch (e) { console.error('[tools] rejection send failed:', e instanceof Error ? e.message : e); }
}

async function sendRentalCard(
  chatId: number,
  sendFn: SendFn,
  sendPhotosFn: SendPhotosFn,
  resultId: string,
  listing: Listing,
  parsedData: ParsedRentalData | null,
  locationScore: LocationScore | null,
  fitReason?: string | null,
): Promise<void> {
  const rawCard = formatRichRentalNotification(
    listing,
    parsedData ?? undefined,
    locationScore ?? undefined,
    fitReason,
  );
  const card = `<b>[${resultId}]</b>\n${rawCard}`;

  if (listing.photos.length > 0) {
    const caption = `[${resultId}] ${rawCard}`;
    if (captionLength(caption) <= CAPTION_LIMIT) {
      try {
        await sendPhotosFn(chatId, listing.photos.slice(0, 10), caption);
        return;
      } catch (e) {
        console.error('[tools] photo+caption failed:', e instanceof Error ? e.message : e);
      }
    }
  }

  const cardChunks = splitMessage(card);
  for (const chunk of cardChunks) {
    try {
      await sendFn(chatId, chunk, { parse_mode: 'HTML' });
    } catch (cardErr) {
      try { await sendFn(chatId, `[${resultId}] ${listing.title}\n${listing.url}\nPrice: ${listing.price} PLN`, { parse_mode: undefined }); } catch (e) { console.error('[tools] send failed:', e instanceof Error ? e.message : e); }
      break;
    }
  }
  if (listing.photos.length > 0) {
    try {
      await sendPhotosFn(chatId, listing.photos.slice(0, 10));
    } catch (photoErr) {
      console.error(`[sendRentalCard] Photo send error for ${listing.url}:`, photoErr);
    }
  }
}

async function sendItemCard(
  chatId: number,
  sendFn: SendFn,
  sendPhotosFn: SendPhotosFn,
  resultId: string,
  item: ItemListing,
  parsedData: ParsedItemData | null,
): Promise<void> {
  const rawCard = formatRichItemNotification(item, parsedData ?? undefined);
  const card = `<b>[${resultId}]</b>\n${rawCard}`;

  if (item.photos.length > 0) {
    const caption = `[${resultId}] ${rawCard}`;
    if (caption.length <= CAPTION_LIMIT) {
      try {
        await sendPhotosFn(chatId, item.photos.slice(0, 10), caption);
        return;
      } catch (e) {
        console.error('[tools] photo+caption failed:', e instanceof Error ? e.message : e);
      }
    }
  }

  const itemChunks = splitMessage(card);
  for (const chunk of itemChunks) {
    try {
      await sendFn(chatId, chunk, { parse_mode: 'HTML' });
    } catch (cardErr) {
      try { await sendFn(chatId, `[${resultId}] ${item.title}\n${item.url}\nPrice: ${item.price} PLN`, { parse_mode: undefined }); } catch (e) { console.error('[tools] send failed:', e instanceof Error ? e.message : e); }
      break;
    }
  }
  if (item.photos.length > 0) {
    try {
      await sendPhotosFn(chatId, item.photos.slice(0, 10));
    } catch (photoErr) {
      console.error(`[sendItemCard] Photo send error for ${item.url}:`, photoErr);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. find_rentals -- THE BIG ONE
// ---------------------------------------------------------------------------

interface RejectionReason {
  id: string;
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
  // If roomsFrom is set but roomsTo is not, default to exact match
  const roomsTo = (input.roomsTo as number | undefined) ?? roomsFrom;
  const areaFrom = input.areaFrom as number | undefined;
  const areaTo = input.areaTo as number | undefined;
  const ownerType = input.ownerType as string | undefined;
  const platformsInput = (input.platforms as string | undefined) ?? 'all';
  const amenities = (input.amenities as Array<{ type: string; maxMinutes: number }> | undefined) ?? [];
  const workAddress = input.workAddress as string | undefined;
  const commuteMode = (input.commuteMode as string | undefined) ?? 'transit';
  const maxResults = Math.min(Math.max((input.maxResults as number) || 5, 1), 10);
  const contractPreference = input.contractPreference as string | undefined;
  const rejectionCriteria = input.rejectionCriteria as string | undefined;
  const strictAmenities = resolveStrictAmenities(input.strictAmenities as boolean | undefined);

  console.log(`[find_rentals] Params: city=${city}, districts=${districts.join(',')}, rooms=${roomsFrom}-${roomsTo}, priceTo=${priceTo}, rejection=${rejectionCriteria ?? 'none'}, strictAmenities=${strictAmenities}`);

  const doOlx = platformsInput === 'olx' || platformsInput === 'all';
  const doOtodom = platformsInput === 'otodom' || platformsInput === 'all';

  const deduped = await searchRentalListings({
    city,
    districts,
    province,
    roomsFrom,
    roomsTo,
    areaFrom,
    areaTo,
    priceFrom,
    priceTo,
    ownerType: ownerType as 'ALL' | 'PRIVATE' | 'AGENCY' | undefined,
    platforms: platformsInput as 'olx' | 'otodom' | 'all',
    olxMaxPages: 2,
  });

  // Rank best-structural-fit first (cheap, crawler-only) so the most promising candidates
  // are analyzed and streamed first; the full AI fit score is shown per card.
  deduped.sort((a, b) => preScore(b) - preScore(a));

  console.log(`[find_rentals] Search results: ${deduped.length} total (OLX: ${doOlx}, Otodom: ${doOtodom})`);

  if (deduped.length === 0) {
    return `No rental listings found matching your criteria. I searched ${doOlx ? 'OLX' : ''}${doOlx && doOtodom ? ' + ' : ''}${doOtodom ? 'Otodom' : ''} for ${roomsFrom ?? 'any'}-room apartments in ${city}${districts.length ? ' (' + districts.join(', ') + ')' : ''}. Try broadening the search (more districts, relax room count, or add more platforms).`;
  }

  // ---- Step B: Send progress message ----
  const debugLimit = process.env.DEBUG_LIMIT ? parseInt(process.env.DEBUG_LIMIT, 10) : 0;
  const candidateCount = debugLimit > 0 ? Math.min(deduped.length, debugLimit) : Math.min(deduped.length, 25);
  const searchId = genId();
  ctx.lastSearchId = searchId;
  try { await sendFn(ctx.chatId, `${deduped.length} найдено, анализ ${candidateCount}… [${searchId}]`, { parse_mode: undefined }); } catch (e) { console.error('[tools] send failed:', e instanceof Error ? e.message : e); }

  // ---- Step C: Analyze candidates and STREAM results to user ----
  const candidates = deduped.slice(0, candidateCount);
  const accepted: Listing[] = [];
  const acceptedIds: string[] = [];
  const rejected: RejectionReason[] = [];

  ctx.lastSearchResults = candidates;
  seedSearchResultsForFamily(ctx, candidates);

  let actualAnalyzed = 0;
  for (let i = 0; i < candidates.length; i++) {
    const listing = candidates[i];

    // Stop if we have enough accepted results
    if (accepted.length >= maxResults) break;

    // Reserve a result ID for this candidate up-front so even rejection paths
    // (and the catch-all error handler below) can reference it.
    const resultId = genId();

    // Pre-parse budget short-circuit: base rent alone already over budget → the true total
    // can only be higher, so skip the expensive enrich + AI parse (see exceedsBudgetFloor).
    if (priceTo != null && exceedsBudgetFloor(listing, priceTo)) {
      const reason = `дороже бюджета (аренда ${listing.price} zł > ${priceTo})`;
      // Cache the (un-enriched) listing so the advertised [ID] is still resolvable via
      // show_listing, matching the other rejection paths.
      try { cacheListing({ platform: listing.platform, platformId: listing.platformId, kind: 'rental', resultId, listing }); } catch (e) { console.error('[find_rentals] cache pre-reject failed:', e instanceof Error ? e.message : e); }
      seedResultForFamily(ctx, resultId, listing);
      rejected.push({ id: resultId, url: listing.url, title: listing.title, reason });
      await sendRejection(ctx.chatId, sendFn, resultId, listing.url, listing.title, reason);
      continue;
    }

    actualAnalyzed++; // count only candidates that reach real analysis

    try {
      // Cheap AI triage BEFORE the expensive enrich + full parse: drop single-room /
      // coliving / non-apartment listings, and enforce the room count when the platform
      // didn't report it (fixes null-rooms leaking past the search filter).
      const triage = await triageRentalListing(listing, { userId: ctx.userId });
      const effRooms = listing.rooms ?? triage.rooms;
      let triageDrop: string | null = null;
      if (!triage.apartment) {
        triageDrop = 'комната/подселение, не отдельная квартира';
      } else if (effRooms != null && ((roomsFrom != null && effRooms < roomsFrom) || (roomsTo != null && effRooms > roomsTo))) {
        triageDrop = `${effRooms}-комн. — не подходит по числу комнат`;
      }
      if (triageDrop) {
        // Cache/seed the (un-enriched) listing so the advertised [ID] resolves via
        // show_listing, matching the budget short-circuit and every other reject path.
        try { cacheListing({ platform: listing.platform, platformId: listing.platformId, kind: 'rental', resultId, listing }); } catch (e) { console.error('[find_rentals] triage-drop cache failed:', e instanceof Error ? e.message : e); }
        seedResultForFamily(ctx, resultId, listing);
        rejected.push({ id: resultId, url: listing.url, title: listing.title, reason: triageDrop });
        await sendRejection(ctx.chatId, sendFn, resultId, listing.url, listing.title, triageDrop);
        continue;
      }

      // Fetch detail page / phone for richer data
      console.log(`[find_rentals] ${i + 1}/${candidateCount}: ${listing.platform} "${listing.title.slice(0, 50)}"`);
      const enrichedListing = await enrichRentalListing(listing);

      // Cache the enriched Listing immediately so show_listing / get_listing
      // can recall it later — including rejected ones.
      try {
        cacheListing({
          platform: enrichedListing.platform,
          platformId: enrichedListing.platformId,
          kind: 'rental',
          resultId,
          listing: enrichedListing,
        });
      } catch (cacheErr) {
        console.error('[find_rentals] cacheListing failed:', cacheErr instanceof Error ? cacheErr.message : cacheErr);
      }
      seedResultForFamily(ctx, resultId, enrichedListing);

      // AI extraction — best effort, don't block on failure
      let parsedData: ParsedRentalData | null = null;
      if (enrichedListing.description) {
        try {
          console.log(`[find_rentals] AI parsing...`);
          parsedData = await parseRentalListing(enrichedListing, { userId: ctx.userId });
          console.log(`[find_rentals] AI parsed: contract=${parsedData?.contractType}, kaucja=${parsedData?.deposit}, offices=${parsedData?.twoOfficeCapable}, quiet=${parsedData?.quiet}`);
        } catch (parseErr) {
          console.error(`[find_rentals] AI parse FAILED for "${enrichedListing.title}":`, parseErr instanceof Error ? parseErr.message : parseErr);
        }
      }

      // Always discard listings that aren't a single concrete apartment (aggregator/agency
      // posts, investment offers, price ranges) — "это не конкретная квартира".
      if (parsedData?.isConcreteApartment === false) {
        const reason = 'это не конкретная квартира';
        rejected.push({ id: resultId, url: enrichedListing.url, title: enrichedListing.title, reason });
        await sendRejection(ctx.chatId, sendFn, resultId, enrichedListing.url, enrichedListing.title, reason);
        continue;
      }

      // Budget filter — use the SAME code-computed total the card displays (cost.ts),
      // not the LLM's totalMonthlyCost, so the gate and the shown ИТОГО can never disagree.
      const estimatedTotal = computeRentalCost(enrichedListing, parsedData).total;

      if (priceTo != null && estimatedTotal > priceTo) {
        const reason = `итог ~${estimatedTotal} zł превышает бюджет ${priceTo} zł`;
        rejected.push({ id: resultId, url: enrichedListing.url, title: enrichedListing.title, reason });
        await sendRejection(ctx.chatId, sendFn, resultId, enrichedListing.url, enrichedListing.title, reason);
        continue;
      }
      // Minimum-total gate (priceFrom is the min TOTAL, not base rent — enforced here on the
      // full computed total rather than by the platform base-rent filter, to avoid false negatives).
      if (priceFrom != null && estimatedTotal > 0 && estimatedTotal < priceFrom) {
        const reason = `итог ~${estimatedTotal} zł ниже мин. бюджета ${priceFrom} zł`;
        rejected.push({ id: resultId, url: enrichedListing.url, title: enrichedListing.title, reason });
        await sendRejection(ctx.chatId, sendFn, resultId, enrichedListing.url, enrichedListing.title, reason);
        continue;
      }

      // Contract preference filter
      if (
        contractPreference === 'najem_okazjonalny' &&
        parsedData?.contractType != null &&
        parsedData.contractType !== 'najem_okazjonalny'
      ) {
        const reason = `тип договора не «najem okazjonalny» (${parsedData.contractType.replace(/_/g, ' ')})`;
        rejected.push({ id: resultId, url: enrichedListing.url, title: enrichedListing.title, reason });
        await sendRejection(ctx.chatId, sendFn, resultId, enrichedListing.url, enrichedListing.title, reason);
        continue;
      }

      // AI rejection criteria filter (two-tier: separate tiny call, cached per criteria)
      if (rejectionCriteria && parsedData) {
        try {
          const rejectionResult = await evaluateRejection(enrichedListing, parsedData, rejectionCriteria, { userId: ctx.userId });
          if (rejectionResult.rejected) {
            const reason = rejectionResult.rejectionReason ?? 'отклонено по вашим критериям';
            rejected.push({ id: resultId, url: enrichedListing.url, title: enrichedListing.title, reason });
            await sendRejection(ctx.chatId, sendFn, resultId, enrichedListing.url, enrichedListing.title, reason);
            continue;
          }
        } catch (rejErr) {
          console.error(`[find_rentals] Rejection eval failed for "${enrichedListing.title}":`, rejErr instanceof Error ? rejErr.message : rejErr);
        }
      }

      // Location scoring — geocode if no coordinates
      let locationScore: LocationScore | null = null;
      const wantLocation = amenities.length > 0 || !!workAddress;

      if (wantLocation) {
        try {
          const { enrichListingLocation } = await import('./location.js');
          const enriched = await enrichListingLocation(enrichedListing, parsedData);
          if (enriched.lat != null && enriched.lng != null) {
            // Write the precise coords back, and re-cache so disk recall (show_listing /
            // get_listing) yields the same precise map link as the card we send now.
            enrichedListing.lat = enriched.lat;
            enrichedListing.lng = enriched.lng;
            try {
              cacheListing({ platform: enrichedListing.platform, platformId: enrichedListing.platformId, kind: 'rental', resultId, listing: enrichedListing });
            } catch (e) { console.warn('[find_rentals] re-cache after enrich failed:', e instanceof Error ? e.message : e); }
            const amenityPrefs: AmenityPreference[] = amenities.map((a) => ({
              type: a.type,
              maxMinutes: a.maxMinutes,
            }));
            locationScore = await scoreLocation(enriched.lat, enriched.lng, amenityPrefs, workAddress, commuteMode);
            if (locationScore) locationScore.precision = enriched.precision;
          }
        } catch (locErr) {
          console.error(`[find_rentals] Location enrich/scoring error for ${enrichedListing.url}:`, locErr instanceof Error ? locErr.message : locErr);
        }
      }

      const amenityPrefs: AmenityPreference[] = amenities.map((a) => ({
        type: a.type,
        maxMinutes: a.maxMinutes,
      }));
      const gate = checkAmenityGate(
        locationScore,
        amenityPrefs,
        locationScore?.precision,
        strictAmenities,
      );
      if (!gate.pass) {
        const reason = gate.reason ?? 'не прошло фильтр метро/трамвая';
        rejected.push({ id: resultId, url: enrichedListing.url, title: enrichedListing.title, reason });
        await sendRejection(ctx.chatId, sendFn, resultId, enrichedListing.url, enrichedListing.title, reason);
        continue;
      }

      // ---- STREAM: send card to user immediately (fit score + best-fit signals on the card) ----
      const fit = computeFitScore(enrichedListing, parsedData, locationScore);
      const fitReason = `${fit.score}${fit.reason ? ' · ' + fit.reason : ''}`;
      await sendRentalCard(ctx.chatId, sendFn, sendPhotosFn, resultId, enrichedListing, parsedData, locationScore, fitReason);
      accepted.push(enrichedListing);
      acceptedIds.push(resultId);
    } catch (err) {
      console.error(`[find_rentals] Error processing ${listing.url}:`, err);
      const reason = `ошибка обработки: ${err instanceof Error ? err.message : String(err)}`;
      // Cache/seed so the advertised [ID] resolves via show_listing even on an enrich throw
      // (matches every other reject path).
      try { cacheListing({ platform: listing.platform, platformId: listing.platformId, kind: 'rental', resultId, listing }); } catch (e) { console.error('[find_rentals] catch-all cache failed:', e instanceof Error ? e.message : e); }
      seedResultForFamily(ctx, resultId, listing);
      rejected.push({ id: resultId, url: listing.url, title: listing.title, reason });
      await sendRejection(ctx.chatId, sendFn, resultId, listing.url, listing.title, reason);
    }
  }

  // ---- Step D: Summary ----
  if (accepted.length === 0) {
    const rejectionSummary = rejected.length > 0
      ? `\nRejection reasons:\n${rejected.map((r) => `- ${r.title}: ${r.reason}`).join('\n')}`
      : '';
    return `Analyzed ${candidateCount} listings but none passed the filters.${rejectionSummary}\nTry increasing the budget, ${strictAmenities ? 'расширьте радиус метро' : 'broaden the search area'}.`;
  }

  // Send a brief "done" summary
  try { await sendFn(ctx.chatId, `Готово [${searchId}]: ${accepted.length} показано, ${rejected.length} отклонено.`, { parse_mode: undefined }); } catch (e) { console.error('[tools] send failed:', e instanceof Error ? e.message : e); }

  // Update context
  ctx.lastSearchResults = accepted;
  seedSearchResultsForFamily(ctx, accepted);
  if (accepted.length > 0) {
    ctx.lastDetailListing = accepted[0];
  }

  // Return summary to Claude — include IDs so it can reference specific results
  const rejectionBreakdown = rejected.length > 0
    ? `\nRejected ${rejected.length}: ${rejected.map((r) => r.reason).join('; ')}`
    : '';
  const idList = acceptedIds.map((id, i) => `${id}: "${accepted[i]?.title?.slice(0, 50) ?? '?'}"`).join(', ');

  return `Search ${searchId}: showed ${accepted.length} listing(s). Result IDs: ${idList}. Analyzed ${actualAnalyzed} of ${deduped.length} candidates.${rejectionBreakdown}\n\nIMPORTANT: The user has ALREADY seen full details. When they reference a result by ID (e.g. "${acceptedIds[0] ?? 'ABC123'}"), use that ID. Do NOT repeat listing details. Just offer next steps.`;
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
  const rejectionCriteria = input.rejectionCriteria as string | undefined;

  console.log(`[find_items] Params: query=${query}, city=${city ?? 'any'}, mandatory=${(input.mandatoryKeywords as string[] ?? []).join(',')}, rejection=${rejectionCriteria ?? 'none'}`);

  const result = await searchItems({
    query,
    cityId,
    priceFrom,
    priceTo,
    limit: 30,
  });

  // Pre-filter by mandatory keywords in title before AI parsing
  const mandatoryKeywords = (input.mandatoryKeywords as string[] ?? []).map(k => k.toLowerCase());

  let filteredItems = result.items;
  if (mandatoryKeywords.length > 0) {
    filteredItems = filteredItems.filter(item => {
      const titleLower = item.title.toLowerCase();
      return mandatoryKeywords.every(kw => titleLower.includes(kw));
    });
    console.log(`[find_items] Filtered by mandatory keywords [${mandatoryKeywords.join(', ')}]: ${filteredItems.length} of ${result.items.length}`);
  }

  if (filteredItems.length === 0) {
    return 'No items found matching your search. Try different keywords or remove the city filter.';
  }

  const debugLimit = process.env.DEBUG_LIMIT ? parseInt(process.env.DEBUG_LIMIT, 10) : 0;
  const candidateLimit = debugLimit > 0 ? Math.min(filteredItems.length, debugLimit) : maxResults * 2;
  const candidates = filteredItems.slice(0, candidateLimit); // get extra for potential filtering
  ctx.lastSearchResults = candidates;
  seedSearchResultsForFamily(ctx, candidates);

  const displayTotal = mandatoryKeywords.length > 0 ? filteredItems.length : result.totalAvailable;
  const searchId = genId();
  ctx.lastSearchId = searchId;
  // Don't clear resultMap — old IDs stay resolvable across searches
  try { await sendFn(ctx.chatId, `${displayTotal} найдено… [${searchId}]`, { parse_mode: undefined }); } catch (e) { console.error('[tools] send failed:', e instanceof Error ? e.message : e); }

  const shown: ItemListing[] = [];
  const shownIds: string[] = [];
  const itemRejected: RejectionReason[] = [];

  for (let i = 0; i < candidates.length && shown.length < maxResults; i++) {
    const item = candidates[i];

    // Reserve a result ID up-front so even rejection paths can reference it.
    const resultId = genId();

    try {
      // Fetch phone if not available
      let enrichedItem = item;
      if (!item.phone) {
        try {
          const phone = await fetchItemPhone(item.platformId);
          if (phone) enrichedItem = { ...item, phone };
        } catch (e) { console.warn(`[find_items] Phone fetch failed for ${item.platformId}:`, e instanceof Error ? e.message : e); }
      }

      // Cache the enriched item immediately so show_listing / get_listing
      // can recall it later — including rejected ones.
      try {
        cacheListing({
          platform: enrichedItem.platform,
          platformId: enrichedItem.platformId,
          kind: 'item',
          resultId,
          listing: enrichedItem,
        });
      } catch (cacheErr) {
        console.error('[find_items] cacheListing failed:', cacheErr instanceof Error ? cacheErr.message : cacheErr);
      }
      seedResultForFamily(ctx, resultId, enrichedItem);

      // AI condition analysis
      let parsedData: ParsedItemData | null = null;
      if (enrichedItem.description) {
        try {
          parsedData = await parseItemListing(enrichedItem, { userId: ctx.userId });
        } catch (parseErr) {
          console.error(`[find_items] AI parse FAILED for "${enrichedItem.title}":`, parseErr instanceof Error ? parseErr.message : parseErr);
        }
      }

      // AI rejection criteria filter — send rejection inline
      if (rejectionCriteria && parsedData) {
        try {
          const rejectionResult = await evaluateRejection(enrichedItem, parsedData, rejectionCriteria, { userId: ctx.userId });
          if (rejectionResult.rejected) {
            const reason = rejectionResult.rejectionReason ?? 'отклонено по вашим критериям';
            itemRejected.push({ id: resultId, url: enrichedItem.url, title: enrichedItem.title, reason });
            await sendRejection(ctx.chatId, sendFn, resultId, enrichedItem.url, enrichedItem.title, reason);
            continue;
          }
        } catch (rejErr) {
          console.error(`[find_items] Rejection eval failed for "${enrichedItem.title}":`, rejErr instanceof Error ? rejErr.message : rejErr);
        }
      }

      // Send card immediately with result ID
      await sendItemCard(ctx.chatId, sendFn, sendPhotosFn, resultId, enrichedItem, parsedData);
      shown.push(enrichedItem);
      shownIds.push(resultId);
    } catch (err) {
      console.error(`[find_items] Error processing ${item.url}:`, err);
      const reason = `ошибка обработки: ${err instanceof Error ? err.message : String(err)}`;
      itemRejected.push({ id: resultId, url: item.url, title: item.title, reason });
      await sendRejection(ctx.chatId, sendFn, resultId, item.url, item.title, reason);
    }
  }

  // Done summary
  try { await sendFn(ctx.chatId, `Готово [${searchId}]: ${shown.length} показано.`, { parse_mode: undefined }); } catch (e) { console.error('[tools] send failed:', e instanceof Error ? e.message : e); }

  ctx.lastSearchResults = shown;
  seedSearchResultsForFamily(ctx, shown);

  const itemRejectionBreakdown = itemRejected.length > 0
    ? `\nRejected ${itemRejected.length}: ${itemRejected.map((r) => r.reason).join('; ')}`
    : '';
  const idList = shownIds.map((id, i) => `${id}: "${shown[i]?.title?.slice(0, 50) ?? '?'}"`).join(', ');

  return `Search ${searchId}: showed ${shown.length} item(s). Result IDs: ${idList}. Total available: ${displayTotal}${mandatoryKeywords.length > 0 ? ` (filtered from ${result.totalAvailable} by mandatory keywords)` : ''}.${itemRejectionBreakdown}\n\nIMPORTANT: The user has ALREADY seen full details. When they reference a result by ID (e.g. "${shownIds[0] ?? 'ABC123'}"), use that ID. Do NOT repeat listing details. Just offer next steps.`;
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
    'query', 'mandatoryKeywords', 'workAddress', 'commuteMode', 'amenities',
    'contractPreference', 'platforms', 'rejectionCriteria', 'strictAmenities', 'limit',
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
  details.push('\nСемья будет получать уведомления о новых объявлениях.');

  return details.join('\n');
}

// ---------------------------------------------------------------------------
// 4. update_monitor
// ---------------------------------------------------------------------------

async function execUpdateMonitor(
  input: Record<string, unknown>,
  _context: UserContext,
): Promise<string> {
  const monitorId = input.monitorId as number;
  const updates = input.updates as Record<string, unknown> | undefined;

  if (!monitorId) return 'monitorId is required.';
  if (!updates || Object.keys(updates).length === 0) return 'No updates provided.';

  const monitor = getMonitor(monitorId);
  if (!monitor) return `Monitor #${monitorId} not found.`;
  // No ownership check — all members share one household; anyone can manage any monitor.
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
  _context: UserContext,
): Promise<string> {
  const monitorId = input.monitorId as number;
  if (!monitorId) return 'monitorId is required.';

  const monitor = getMonitor(monitorId);
  if (!monitor) return `Monitor #${monitorId} not found.`;
  // No ownership check — household model: any member can delete any monitor.

  deactivateMonitor(monitorId);
  return `Monitor #${monitorId} has been deactivated. You will no longer receive notifications for it.`;
}

// ---------------------------------------------------------------------------
// 6. list_monitors
// ---------------------------------------------------------------------------

async function execListMonitors(
  _ctx: UserContext,
): Promise<string> {
  const monitors = getMonitors();

  if (monitors.length === 0) {
    return 'No active monitors. I can create one if you want ongoing alerts.';
  }

  const lines: string[] = [`Active monitors (${monitors.length}):\n`];

  for (const m of monitors) {
    const seenCount = getSeenCount(m.id);
    const config = JSON.parse(m.config) as Record<string, unknown>;
    const parts: string[] = [];

    parts.push(`Monitor #${m.id} (${m.type}, ${m.platform}, user ${m.user_id})`);
    if (config.city) parts.push(`  City: ${config.city}`);
    if (config.districts) parts.push(`  Districts: ${(config.districts as string[]).join(', ')}`);
    if (config.query) parts.push(`  Query: "${config.query}"`);
    if (config.priceTo) parts.push(`  Max budget: ${config.priceTo} PLN`);
    if (config.roomsFrom) {
      // roomsTo defaults to roomsFrom at runtime (exact match), so a lone roomsFrom is an
      // exact count — render it as such, not as "N+" which wrongly reads as a minimum.
      const rf = config.roomsFrom as number;
      const rt = config.roomsTo as number | undefined;
      parts.push(`  Rooms: ${rt != null && rt !== rf ? `${rf}-${rt}` : rf}`);
    }
    if (config.amenities) {
      const amens = config.amenities as Array<{ type: string; maxMinutes: number }>;
      parts.push(`  Amenities: ${amens.map((a) => `${a.type} (${a.maxMinutes}min)`).join(', ')}`);
    }
    if (config.workAddress) parts.push(`  Commute to: ${config.workAddress}`);
    if (config.contractPreference) parts.push(`  Contract: ${config.contractPreference}`);
    if (config.rejectionCriteria) parts.push(`  Rejection criteria: "${config.rejectionCriteria}"`);
    if (config.strictAmenities) parts.push(`  Strict walking amenities: yes`);
    if (config.mandatoryKeywords) parts.push(`  Mandatory keywords: ${(config.mandatoryKeywords as string[]).join(', ')}`);
    parts.push(`  Listings seen: ${seenCount}`);
    parts.push(`  Created: ${m.created_at}`);

    lines.push(parts.join('\n'));
  }

  return lines.join('\n\n');
}

// ---------------------------------------------------------------------------
// 7. get_listing — return cached listing JSON + AI parse to the agent
// ---------------------------------------------------------------------------

interface CachedLookupResult {
  kind: 'rental' | 'item';
  listing: Listing | ItemListing;
}

function lookupCachedListing(resultId: string, ctx: UserContext): CachedLookupResult | null {
  // Fast path: in-memory result map (current process)
  const inMem = ctx.resultMap.get(resultId);
  if (inMem) {
    // Heuristic: rental Listings have `rooms`/`area` props; ItemListings don't.
    const kind: 'rental' | 'item' = 'rooms' in inMem || 'area' in inMem ? 'rental' : 'item';
    return { kind, listing: inMem };
  }

  // Disk fallback: cached_listings table (survives restarts)
  const onDisk = getCachedListingByResultId(resultId);
  if (!onDisk) return null;

  // Re-populate in-memory map so follow-ups skip the disk hit.
  ctx.resultMap.set(resultId, onDisk.listing);
  return { kind: onDisk.kind, listing: onDisk.listing };
}

async function execGetListing(
  input: Record<string, unknown>,
  ctx: UserContext,
): Promise<string> {
  const resultId = String(input.resultId ?? '').trim();
  if (!resultId) return 'resultId is required.';

  const found = lookupCachedListing(resultId, ctx);
  if (!found) {
    return `No cached listing found for result ID "${resultId}". The user may be referencing an ID from a different session, a typo, or a listing that was never fetched. Ask them to re-run the search or paste a URL.`;
  }

  const { kind, listing } = found;
  const parsedRow = getParsedListing(listing.platform, listing.platformId);
  let parsedData: ParsedRentalData | ParsedItemData | null = null;
  if (parsedRow?.parsed_data) {
    try { parsedData = JSON.parse(parsedRow.parsed_data); } catch { /* ignore */ }
  }

  return JSON.stringify({ resultId, kind, listing, parsed: parsedData }, null, 2);
}

// ---------------------------------------------------------------------------
// 8. show_listing — re-send the rich card + photos to the user
// ---------------------------------------------------------------------------

async function execShowListing(
  input: Record<string, unknown>,
  ctx: UserContext,
  sendFn: SendFn,
  sendPhotosFn: SendPhotosFn,
): Promise<string> {
  const resultId = String(input.resultId ?? '').trim();
  if (!resultId) return 'resultId is required.';

  const found = lookupCachedListing(resultId, ctx);
  if (!found) {
    try { await sendFn(ctx.chatId, `No cached listing for [<b>${resultId}</b>]. It may be from a previous session or a typo.`, { parse_mode: 'HTML' }); } catch (e) { console.error('[tools] send failed:', e instanceof Error ? e.message : e); }
    return `No cached listing for "${resultId}". Told the user.`;
  }

  const { kind, listing } = found;
  const parsedRow = getParsedListing(listing.platform, listing.platformId);
  let parsedData: ParsedRentalData | ParsedItemData | null = null;
  if (parsedRow?.parsed_data) {
    try { parsedData = JSON.parse(parsedRow.parsed_data); } catch { /* ignore */ }
  }

  if (kind === 'rental') {
    const rental = listing as Listing;
    await sendRentalCard(ctx.chatId, sendFn, sendPhotosFn, resultId, rental, parsedData as ParsedRentalData | null, null);
    const photoCount = rental.photos?.length ?? 0;
    return `Sent rental card [${resultId}] — "${rental.title.slice(0, 60)}" — ${photoCount} photo(s).`;
  } else {
    const item = listing as ItemListing;
    await sendItemCard(ctx.chatId, sendFn, sendPhotosFn, resultId, item, parsedData as ParsedItemData | null);
    const photoCount = item.photos?.length ?? 0;
    return `Sent item card [${resultId}] — "${item.title.slice(0, 60)}" — ${photoCount} photo(s).`;
  }
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  _userId: number,
  _chatId: number,
  context: UserContext,
  sendFn: (chatId: number, text: string, opts?: Record<string, unknown>) => Promise<void>,
  sendPhotosFn: (chatId: number, urls: string[], caption?: string) => Promise<void>,
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
        return await execUpdateMonitor(input, context);
      case 'delete_monitor':
        return await execDeleteMonitor(input, context);
      case 'list_monitors':
        return await execListMonitors(context);
      case 'get_listing':
        return await execGetListing(input, context);
      case 'show_listing':
        return await execShowListing(input, context, sendFn, sendPhotosFn);
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tool:${name}] Error:`, err);
    return `Tool error: ${message}`;
  }
}
