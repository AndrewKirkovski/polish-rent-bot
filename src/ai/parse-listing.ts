// AI-powered comprehensive listing analysis using Claude
// Produces deep, human-readable assessments — not just field extraction

import { createHash } from 'node:crypto';
import type { Listing, ParsedRentalData, ParsedItemData, RejectionResult } from '../types.js';
import type { ItemListing } from '../crawlers/olx-items.js';
import { getParsedListing, saveParsedListing, getRejectionCache, saveRejectionCache } from '../storage/db.js';
import { ParsedRentalDataSchema, ParsedItemDataSchema, RejectionResultSchema } from './schemas.js';
import { createMessageTracked, recordLocalCacheHit } from './client.js';
import { computeRentalCost } from '../cost.js';

export type { ParsedRentalData, ParsedItemData } from '../types.js';

export interface AiCallCtx {
  userId?: number;
  monitorId?: number;
}

// Extraction runs on every listing — route it to Haiku (cheaper than Sonnet). Override via env.
const PARSE_MODEL = process.env.PARSE_MODEL || 'claude-haiku-4-5';

// Folded into the parse cache key; bump on any RENTAL_PROMPT/schema change so stale
// old-schema rows miss instead of returning objects without the new fields.
const RENTAL_PARSE_VERSION = 'wfh-v1';

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

// ---------------------------------------------------------------------------
// Rental listing — comprehensive AI analysis
// ---------------------------------------------------------------------------

const RENTAL_PROMPT = `You analyse Polish rental listings for a household of TWO adults who both WORK FROM HOME and share the flat. They have NO children, NO pets, are NOT students. Their priorities: TWO separate quiet rooms usable as home offices (for simultaneous video calls), reliable internet (ideally fibre / światłowód), low noise, good natural light, and true total cost. Do NOT spend effort on pet/family/student concerns. Write free-text fields in Russian, ONE short sentence max.

Read the Polish description carefully — landlords hide crucial details there. Return ONLY the JSON object below (no markdown fences, no extra text).

GROUND-TRUTH FACTS may be supplied in the input (internet / elevator / AC / build year). When a fact is given as true/false, DO NOT contradict it. Only infer that field from the description when it is marked "unknown".

Extraction notes:
- deposit (kaucja): "kaucja", "depozyt", "zabezpieczenie", "kaucja zwrotna", "2x czynsz".
- contractType: only if explicitly stated ("najem okazjonalny/instytucjonalny"); else null (never assume najem zwykły).
- estimatedMedia: monthly PLN the tenant pays SEPARATELY on top of czynsz. If a utility is already in czynsz, leave it null (no double counting). Do not compute a total — the app does.
- addressHint: exact ulica + number or a clear landmark, for geocoding; null if none.
- isConcreteApartment: FALSE for agency/portfolio posts, investment/new-build sales, price ranges ("od X zł"), generic "we have flats" ads, or scams; TRUE for one real, specific flat.
- separateRooms: number of CLOSABLE separate rooms (exclude a walk-through/przechodni room and the kitchen). layoutType: "rozkladowy" (rooms off a hall), "przechodni" (walk-through), or "open" (studio/open-plan).
- twoOfficeCapable: true if the flat plausibly fits TWO private desks/offices with doors for calls (needs ≥2 separable rooms, not przechodni).
- quiet: "quiet" if "od podwórza"/"cicha okolica"/top floor/courtyard; "noisy" if busy street/tram/nightlife; else "mixed" or null.
- naturalLight: "bright"/"average"/"dark" from exposure/floor/description; null if unclear.
- internetType: "fiber" if światłowód/fibre mentioned; "cable" if cable/UPC/Vectra; else "unknown".

JSON schema:
{
  "deposit": number|null,
  "depositNote": "напр. 6000 zł (2x аренды), возвратный" | null,
  "adminFee": number|null,
  "addressHint": "улица+номер или ориентир" | null,
  "isConcreteApartment": true|false,
  "estimatedMedia": { "water": number|null, "electricity": number|null, "gas": number|null, "internet": number|null, "heating": number|null },
  "contractType": "najem_okazjonalny"|"najem_zwykly"|"najem_instytucjonalny"|null,
  "availableFrom": "дата / 'сразу'" | null,
  "minimumLease": "напр. '12 месяцев'" | null,
  "furnished": "full"|"partial"|"none"|null,
  "balcony": true|false|null,
  "parkingIncluded": true|false|null,
  "separateRooms": number|null,
  "layoutType": "rozkladowy"|"przechodni"|"open"|null,
  "twoOfficeCapable": true|false|null,
  "quiet": "quiet"|"mixed"|"noisy"|null,
  "naturalLight": "bright"|"average"|"dark"|null,
  "internetType": "fiber"|"cable"|"unknown"|null,
  "descriptionSummary": "одно короткое предложение по-русски" | null,
  "redFlags": ["..."],
  "positives": ["сильные стороны для удалёнщиков"],
  "restrictions": ["напр. только без животных, нужен польский ID"]
}`;

export async function parseRentalListing(listing: Listing, ctx: AiCallCtx = {}): Promise<ParsedRentalData> {
  const descHash = hashText(`${RENTAL_PARSE_VERSION}\n${listing.description || listing.title}`);

  // Check cache
  const cached = getParsedListing(listing.platform, listing.platformId);
  if (cached && cached.description_hash === descHash) {
    try {
      const parsed = JSON.parse(cached.parsed_data);
      recordLocalCacheHit({ feature: 'parse_rental', ...ctx }, PARSE_MODEL);
      return parsed;
    } catch {
      console.warn(`[parse-listing] Corrupt cache entry for ${listing.platform}:${listing.platformId}, re-parsing`);
    }
  }

  const tri = (v: boolean | null) => (v === true ? 'yes' : v === false ? 'no' : 'unknown');
  const userMessage = `Title: ${listing.title}
Rent price: ${listing.price} PLN/month
Czynsz admin (from structured data): ${listing.rent ?? 'not specified'} PLN
Deposit (from structured data): ${listing.deposit ?? 'not specified'} PLN
Area: ${listing.area ?? 'unknown'} m²
Rooms: ${listing.rooms ?? 'unknown'}
Floor: ${listing.floor ?? 'unknown'}${listing.buildingFloor != null ? ` of ${listing.buildingFloor}` : ''}
Building type: ${listing.buildingType ?? 'unknown'}
Heating: ${listing.heating ?? 'unknown'}
City: ${listing.city}, District: ${listing.district ?? 'unknown'}
Street: ${listing.street ?? 'unknown'}
Advertiser: ${listing.advertiserType ?? 'unknown'}
Coordinates: ${listing.lat ?? 'unknown'}, ${listing.lng ?? 'unknown'}

GROUND-TRUTH FACTS (do NOT contradict; infer only the 'unknown' ones from the description):
- internet available: ${tri(listing.hasInternet)}
- elevator (winda): ${tri(listing.hasElevator)}
- air conditioning: ${tri(listing.hasAc)}
- build year: ${listing.buildYear ?? 'unknown'}

Full description (Polish):
${(listing.description || 'No description provided').slice(0, 8000)}`;

  const response = await createMessageTracked({
    model: PARSE_MODEL,
    max_tokens: 4096,
    temperature: 0,
    system: [
      {
        type: 'text' as const,
        text: RENTAL_PROMPT,
        cache_control: { type: 'ephemeral' as const },
      },
    ],
    messages: [{ role: 'user', content: userMessage }],
  }, { feature: 'parse_rental', ...ctx }); // uses client defaults: 120s timeout, 3 retries

  if (response.stop_reason === 'max_tokens') {
    console.error(`[parse-listing] TRUNCATED (max_tokens) for ${listing.platform}:${listing.platformId} "${listing.title.slice(0, 40)}" — raise max_tokens or trim schema`);
  }

  const textBlock = response.content.find((b: { type: string }) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text in Claude response');
  }

  // Clean potential markdown fences and robustly extract JSON
  let jsonStr = textBlock.text.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  // Robustly extract first JSON object if there's surrounding text
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) jsonStr = jsonMatch[0];

  let parsed: ParsedRentalData;
  try {
    const raw = JSON.parse(jsonStr);
    parsed = ParsedRentalDataSchema.parse(raw) as ParsedRentalData;
  } catch (parseErr) {
    console.error('[parse-listing] Failed to parse/validate AI JSON:', jsonStr.slice(0, 200));
    throw new Error('AI returned invalid JSON');
  }

  try {
    saveParsedListing(
      listing.platform,
      listing.platformId,
      'rental',
      JSON.stringify(parsed),
      descHash,
    );
  } catch (dbErr) {
    console.error('[parse-listing] Cache write failed:', dbErr);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Item listing — condition and value analysis
// ---------------------------------------------------------------------------

const ITEM_PROMPT = `You are an expert at evaluating used items for sale. Given a Polish item listing, produce a comprehensive analysis. Write all free-text fields in Russian.

Read the Polish description carefully. Extract:
- Real condition (not just the tag — what does the seller actually say?)
- Why they're selling (if mentioned)
- Any defects, scratches, issues
- What's included (accessories, original box, charger, etc.)
- Whether the price seems fair
- Who should buy this

Return ONLY valid JSON (no markdown fences):
{
  "actualCondition": "detailed Russian assessment from description",
  "whySelling": "reason if mentioned, null otherwise",
  "defects": ["list of any issues mentioned"],
  "includedAccessories": ["charger", "original box", etc.],
  "priceAssessment": "seems fair / overpriced / good deal — brief note",
  "descriptionSummary": "1-2 sentence Russian summary",
  "bestFor": "who should buy this",
  "redFlags": ["any concerns"],
  "additionalNotes": ["anything else noteworthy"]
}`;

export async function parseItemListing(item: ItemListing, ctx: AiCallCtx = {}): Promise<ParsedItemData> {
  const descHash = hashText(item.description || item.title);

  const cached = getParsedListing(item.platform, item.platformId);
  if (cached && cached.description_hash === descHash) {
    try {
      const parsed = JSON.parse(cached.parsed_data);
      recordLocalCacheHit({ feature: 'parse_item', ...ctx }, PARSE_MODEL);
      return parsed;
    } catch {
      console.warn(`[parse-listing] Corrupt cache entry for ${item.platform}:${item.platformId}, re-parsing`);
    }
  }

  const userMessage = `Title: ${item.title}
Price: ${item.price} ${item.currency}${item.negotiable ? ' (negotiable)' : ''}
Condition tag: ${item.condition ?? 'not specified'}
City: ${item.city}
Seller: ${item.contactName ?? 'unknown'}${item.isBusiness ? ' (business)' : ' (private)'}
Category params: ${Object.entries(item.params).filter(([k]) => k !== 'price').map(([k, v]) => `${k}: ${v}`).join(', ')}

Full description (Polish):
${(item.description || 'No description provided').slice(0, 8000)}`;

  const response = await createMessageTracked({
    model: PARSE_MODEL,
    max_tokens: 1024,
    temperature: 0,
    system: [
      {
        type: 'text' as const,
        text: ITEM_PROMPT,
        cache_control: { type: 'ephemeral' as const },
      },
    ],
    messages: [{ role: 'user', content: userMessage }],
  }, { feature: 'parse_item', ...ctx }); // uses client defaults: 120s timeout, 3 retries

  const textBlock = response.content.find((b: { type: string }) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text in Claude response');
  }

  let jsonStr = textBlock.text.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  const itemJsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (itemJsonMatch) jsonStr = itemJsonMatch[0];

  let parsed: ParsedItemData;
  try {
    const raw = JSON.parse(jsonStr);
    parsed = ParsedItemDataSchema.parse(raw) as ParsedItemData;
  } catch (parseErr) {
    console.error('[parse-listing] Failed to parse/validate AI item JSON:', jsonStr.slice(0, 200));
    throw new Error('AI returned invalid JSON');
  }

  try {
    saveParsedListing(
      item.platform,
      item.platformId,
      'item',
      JSON.stringify(parsed),
      descHash,
    );
  } catch (dbErr) {
    console.error('[parse-listing] Cache write failed:', dbErr);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Rejection evaluation — tiny Claude call against user criteria
// Two-tier cache: universal parse is cached separately, rejection is cached
// per (platform, platformId, hash(criteria))
// ---------------------------------------------------------------------------

const REJECTION_PROMPT = `You evaluate rental/item listings against user rejection criteria.
Given a listing summary and the user's criteria, determine if the listing should be rejected.

CRITICAL RULES:
- ONLY reject if the listing EXPLICITLY contradicts a criterion (e.g. criterion says "no ground floor" and listing says "floor: 0")
- NEVER reject because information is MISSING or not mentioned. Absence of info is NOT a reason to reject.
- If the listing doesn't mention something the criteria asks about, assume it PASSES (benefit of the doubt).
- Be conservative: when in doubt, do NOT reject.

Return ONLY valid JSON (no markdown fences):
{"rejected": true/false, "rejectionReason": "reason string or null"}
The rejectionReason MUST be written in Russian, short (e.g. "первый этаж", "только агентство").
Set rejected=true ONLY if the listing clearly violates a criterion.
If the listing passes or info is unclear, set rejected=false and rejectionReason=null.`;

export async function evaluateRejection(
  listing: { platform: string; platformId: string; title: string },
  universalParse: ParsedRentalData | ParsedItemData,
  rejectionCriteria: string,
  ctx: AiCallCtx = {},
): Promise<RejectionResult> {
  const criteriaHash = hashText(rejectionCriteria);

  // Check rejection cache
  const cached = getRejectionCache(listing.platform, listing.platformId, criteriaHash);
  if (cached) {
    recordLocalCacheHit({ feature: 'rejection_eval', ...ctx }, PARSE_MODEL);
    return cached;
  }

  // Build a compact summary from listing + universal parse for the rejection prompt
  const summaryParts: string[] = [`Title: ${listing.title}`];

  // Listing-level fields (from crawler data — always available)
  const l = listing as Record<string, unknown>;
  if (l.floor != null) summaryParts.push(`Floor: ${l.floor}`);
  if (l.area != null) summaryParts.push(`Area: ${l.area} m²`);
  if (l.rooms != null) summaryParts.push(`Rooms: ${l.rooms}`);
  if (l.district) summaryParts.push(`District: ${l.district}`);
  if (l.city) summaryParts.push(`City: ${l.city}`);
  if (l.advertiserType) summaryParts.push(`Advertiser: ${l.advertiserType}`);
  if (l.price != null) summaryParts.push(`Rent price: ${l.price} PLN`);
  if (l.rent != null) summaryParts.push(`Czynsz admin: ${l.rent} PLN`);

  // AI-parsed fields
  // Total monthly cost is computed in code (rentals only) — the LLM's own total is unreliable.
  if ('estimatedMedia' in universalParse) {
    const cost = computeRentalCost(
      {
        price: typeof l.price === 'number' ? l.price : 0,
        rent: typeof l.rent === 'number' ? l.rent : null,
      },
      universalParse as ParsedRentalData,
    );
    if (cost.total > 0) {
      summaryParts.push(`Total monthly cost: ${cost.total} PLN`);
    }
  }
  if ('contractType' in universalParse && universalParse.contractType != null) {
    summaryParts.push(`Contract type: ${universalParse.contractType}`);
  }
  if ('twoOfficeCapable' in universalParse && universalParse.twoOfficeCapable != null) {
    summaryParts.push(`Fits two home offices: ${universalParse.twoOfficeCapable}`);
  }
  if ('quiet' in universalParse && universalParse.quiet != null) {
    summaryParts.push(`Quiet: ${universalParse.quiet}`);
  }
  if ('furnished' in universalParse && universalParse.furnished != null) {
    summaryParts.push(`Furnished: ${universalParse.furnished}`);
  }
  if ('balcony' in universalParse && universalParse.balcony != null) {
    summaryParts.push(`Balcony: ${universalParse.balcony}`);
  }
  if ('parkingIncluded' in universalParse && universalParse.parkingIncluded != null) {
    summaryParts.push(`Parking: ${universalParse.parkingIncluded}`);
  }
  if ('restrictions' in universalParse) {
    const restrictions = universalParse.restrictions as string[];
    if (restrictions.length > 0) summaryParts.push(`Restrictions: ${restrictions.join(', ')}`);
  }

  // Item-specific fields
  if ('actualCondition' in universalParse) {
    summaryParts.push(`Condition: ${universalParse.actualCondition}`);
  }
  if ('defects' in universalParse) {
    const defects = universalParse.defects as string[];
    if (defects.length > 0) summaryParts.push(`Defects: ${defects.join(', ')}`);
  }
  if ('includedAccessories' in universalParse) {
    const accessories = universalParse.includedAccessories as string[];
    if (accessories.length > 0) summaryParts.push(`Included: ${accessories.join(', ')}`);
  }

  // Common fields
  if (universalParse.descriptionSummary) {
    summaryParts.push(`Summary: ${universalParse.descriptionSummary}`);
  }

  const userMessage = `LISTING SUMMARY:
${summaryParts.join('\n')}

USER REJECTION CRITERIA:
${rejectionCriteria}`;

  const response = await createMessageTracked({
    model: PARSE_MODEL,
    max_tokens: 256,
    temperature: 0,
    system: [{ type: 'text' as const, text: REJECTION_PROMPT, cache_control: { type: 'ephemeral' as const } }],
    messages: [{ role: 'user', content: userMessage }],
  }, { feature: 'rejection_eval', ...ctx }, { timeout: 45_000 }); // shorter timeout OK for tiny call

  const textBlock = response.content.find((b: { type: string }) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text in Claude rejection response');
  }

  let rejJsonStr = textBlock.text.trim();
  if (rejJsonStr.startsWith('```')) {
    rejJsonStr = rejJsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  const rejJsonMatch = rejJsonStr.match(/\{[\s\S]*\}/);
  if (rejJsonMatch) rejJsonStr = rejJsonMatch[0];

  let result: RejectionResult;
  try {
    const raw = JSON.parse(rejJsonStr);
    result = RejectionResultSchema.parse(raw) as RejectionResult;
  } catch (parseErr) {
    console.error('[evaluateRejection] Failed to parse AI JSON:', rejJsonStr.slice(0, 200));
    // Default to not rejected on parse failure
    result = { rejected: false, rejectionReason: null };
  }

  // Cache the rejection result
  try {
    saveRejectionCache(
      listing.platform,
      listing.platformId,
      criteriaHash,
      result.rejected,
      result.rejectionReason,
    );
  } catch (dbErr) {
    console.error('[evaluateRejection] Cache write failed:', dbErr);
  }

  return result;
}
