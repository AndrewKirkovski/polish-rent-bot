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

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

// ---------------------------------------------------------------------------
// Rental listing — comprehensive AI analysis
// ---------------------------------------------------------------------------

const RENTAL_PROMPT = `You are an expert Polish real estate analyst helping a Russian-speaking renter evaluate apartments in Poland. Write all free-text fields in Russian.

Given the listing data below, produce a COMPREHENSIVE analysis in JSON. Read the Polish description carefully — landlords hide crucial details there.

CRITICAL fields to extract from the description:
- Kaucja (deposit): Look for "kaucja", "depozyt", "zabezpieczenie", "kaucja zwrotna", amounts like "2x czynsz"
- Contract type: "najem okazjonalny", "umowa najmu okazjonalnego", "najem instytucjonalny" — if NOT mentioned in the description, return null (do NOT assume najem zwykły)
- estimatedMedia: estimate the MONTHLY PLN cost of each utility the tenant pays SEPARATELY, on top of czynsz. If a utility is already included in czynsz (e.g. heating, water), leave it null here — do NOT also estimate it, or it gets double-counted. The app sums rent + czynsz + these to get the total, so keep the numbers realistic. (Do not compute the total yourself — the app does the arithmetic.)
- What's included in czynsz: often includes heating, garbage, water — extract this into adminFeeIncludes
- What tenant pays separately: gas, electricity, internet — extract this into tenantPays
- addressHint: the exact street/ulica (with building number if present) or a precise landmark from the description, for map geolocation. OLX hides the street in its API, but the description often names it. Null if nothing specific.
- isConcreteApartment: TRUE if this is ONE specific, real apartment offered for rent. Set FALSE when it is NOT a single concrete unit — e.g. an agency/portfolio post advertising many or "various" apartments, an investment / new-development sale, a price RANGE ("od X zł", "od ... do ..."), a generic "we have flats, call us" ad, or an obvious placeholder/scam. The app immediately discards anything where this is false.

DEEP analysis to produce:
- Translate and summarize the entire description into Russian — preserve ALL useful details
- Assess the apartment's vibe/style (modern? renovated? old? communist-era?)
- List ALL furniture and equipment mentioned
- Note landlord's personality/flexibility from the text
- Identify restrictions (pets, smoking, couples, ID requirements)
- Red flags or positive signals
- Who this apartment is best suited for

Return ONLY valid JSON (no markdown fences):
{
  "deposit": number or null,
  "depositNote": "e.g. 2600 PLN (1.3x monthly rent), refundable",
  "adminFee": number or null,
  "adminFeeIncludes": "what's covered in czynsz admin — heating, water, garbage, etc.",
  "tenantPays": "what tenant pays on top — gas, electricity, internet, etc.",
  "estimatedMedia": {
    "water": number or null,
    "electricity": number or null,
    "gas": number or null,
    "internet": number or null,
    "heating": number or null
  },
  "addressHint": "exact street/ulica + number or a clear landmark from the description, or null",
  "isConcreteApartment": true | false,
  "totalMonthlyCost": number or null,
  "totalBreakdown": "e.g. 2000 rent + 544 czynsz + ~200 utilities = ~2744 PLN",
  "contractType": "najem_okazjonalny" | "najem_zwykly" | "najem_instytucjonalny" | null,
  "contractNote": "any details about the contract mentioned",
  "availableFrom": "date string or 'immediately' or null",
  "minimumLease": "e.g. '12 months' or null",
  "petFriendly": true | false | null,
  "smokingAllowed": true | false | null,
  "furnished": "full" | "partial" | "none" | null,
  "parkingIncluded": true | false | null,
  "balcony": true | false | null,
  "descriptionSummary": "1-2 sentence Russian summary of the apartment — vibe, style, key features",
  "furnitureAndEquipment": ["list every item mentioned: bed type, desk, wardrobe, appliances, etc."],
  "kitchenDetails": "what's in the kitchen",
  "bathroomDetails": "what's in the bathroom",
  "internetReady": "e.g. 'PLAY/ORANGE cable ready, bring own contract'",
  "landlordNotes": "landlord personality, flexibility, restrictions, tone of the listing",
  "bestSuitedFor": "e.g. 'single professional working remotely'",
  "redFlags": ["any concerning things"],
  "positives": ["strong points of this listing"],
  "restrictions": ["no pets", "no smoking", "Polish ID required", etc.],
  "additionalNotes": ["anything else noteworthy"]
}`;

export async function parseRentalListing(listing: Listing, ctx: AiCallCtx = {}): Promise<ParsedRentalData> {
  const descHash = hashText(listing.description || listing.title);

  // Check cache
  const cached = getParsedListing(listing.platform, listing.platformId);
  if (cached && cached.description_hash === descHash) {
    try {
      const parsed = JSON.parse(cached.parsed_data);
      recordLocalCacheHit({ feature: 'parse_rental', ...ctx }, MODEL);
      return parsed;
    } catch {
      console.warn(`[parse-listing] Corrupt cache entry for ${listing.platform}:${listing.platformId}, re-parsing`);
    }
  }

  const userMessage = `Title: ${listing.title}
Rent price: ${listing.price} PLN/month
Czynsz admin (from structured data): ${listing.rent ?? 'not specified'} PLN
Deposit (from structured data): ${listing.deposit ?? 'not specified'} PLN
Area: ${listing.area ?? 'unknown'} m²
Rooms: ${listing.rooms ?? 'unknown'}
Floor: ${listing.floor ?? 'unknown'}
Building type: ${listing.buildingType ?? 'unknown'}
Heating: ${listing.heating ?? 'unknown'}
City: ${listing.city}, District: ${listing.district ?? 'unknown'}
Street: ${listing.street ?? 'unknown'}
Advertiser: ${listing.advertiserType ?? 'unknown'}
Coordinates: ${listing.lat ?? 'unknown'}, ${listing.lng ?? 'unknown'}

Full description (Polish):
${(listing.description || 'No description provided').slice(0, 8000)}`;

  const response = await createMessageTracked({
    model: MODEL,
    max_tokens: 2048,
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
      recordLocalCacheHit({ feature: 'parse_item', ...ctx }, MODEL);
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
    model: MODEL,
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
    recordLocalCacheHit({ feature: 'rejection_eval', ...ctx }, MODEL);
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
  if ('petFriendly' in universalParse && universalParse.petFriendly != null) {
    summaryParts.push(`Pets allowed: ${universalParse.petFriendly}`);
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
    model: MODEL,
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
