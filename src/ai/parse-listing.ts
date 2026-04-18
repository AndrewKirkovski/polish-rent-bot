// AI-powered comprehensive listing analysis using Claude
// Produces deep, human-readable assessments — not just field extraction

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import type { Listing, ParsedRentalData, ParsedItemData, RejectionResult } from '../types.js';
import type { ItemListing } from '../crawlers/olx-items.js';
import { getParsedListing, saveParsedListing, getRejectionCache, saveRejectionCache } from '../storage/db.js';
import { ParsedRentalDataSchema, ParsedItemDataSchema, RejectionResultSchema } from './schemas.js';

export type { ParsedRentalData, ParsedItemData } from '../types.js';

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

// ---------------------------------------------------------------------------
// Rental listing — comprehensive AI analysis
// ---------------------------------------------------------------------------

const RENTAL_PROMPT = `You are an expert Polish real estate analyst helping an English-speaking renter evaluate apartments in Poland.

Given the listing data below, produce a COMPREHENSIVE analysis in JSON. Read the Polish description carefully — landlords hide crucial details there.

CRITICAL fields to extract from the description:
- Kaucja (deposit): Look for "kaucja", "depozyt", "zabezpieczenie", "kaucja zwrotna", amounts like "2x czynsz"
- Contract type: "najem okazjonalny", "umowa najmu okazjonalnego", "najem instytucjonalny" — if NOT mentioned in the description, return null (do NOT assume najem zwykły)
- Total monthly cost: rent + czynsz administracyjny + estimated utilities. Calculate this explicitly.
- What's included in czynsz: often includes heating, garbage, water — extract this
- What tenant pays separately: gas, electricity, internet — extract this

DEEP analysis to produce:
- Translate and summarize the entire description into English — preserve ALL useful details
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
  "descriptionSummary": "2-4 sentence English summary of the apartment — vibe, style, key features",
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

export async function parseRentalListing(listing: Listing): Promise<ParsedRentalData> {
  const descHash = hashText(listing.description || listing.title);

  // Check cache
  const cached = getParsedListing(listing.platform, listing.platformId);
  if (cached && cached.description_hash === descHash) {
    try { return JSON.parse(cached.parsed_data); } catch { /* re-parse below */ }
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

  const response = await getClient().messages.create({
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
  }, { timeout: 30_000 });

  const textBlock = response.content.find((b) => b.type === 'text');
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

const ITEM_PROMPT = `You are an expert at evaluating used items for sale. Given a Polish item listing, produce a comprehensive analysis in English.

Read the Polish description carefully. Extract:
- Real condition (not just the tag — what does the seller actually say?)
- Why they're selling (if mentioned)
- Any defects, scratches, issues
- What's included (accessories, original box, charger, etc.)
- Whether the price seems fair
- Who should buy this

Return ONLY valid JSON (no markdown fences):
{
  "actualCondition": "detailed English assessment from description",
  "whySelling": "reason if mentioned, null otherwise",
  "defects": ["list of any issues mentioned"],
  "includedAccessories": ["charger", "original box", etc.],
  "priceAssessment": "seems fair / overpriced / good deal — brief note",
  "descriptionSummary": "1-2 sentence English summary",
  "bestFor": "who should buy this",
  "redFlags": ["any concerns"],
  "additionalNotes": ["anything else noteworthy"]
}`;

export async function parseItemListing(item: ItemListing): Promise<ParsedItemData> {
  const descHash = hashText(item.description || item.title);

  const cached = getParsedListing(item.platform, item.platformId);
  if (cached && cached.description_hash === descHash) {
    try { return JSON.parse(cached.parsed_data); } catch { /* re-parse below */ }
  }

  const userMessage = `Title: ${item.title}
Price: ${item.price} ${item.currency}${item.negotiable ? ' (negotiable)' : ''}
Condition tag: ${item.condition ?? 'not specified'}
City: ${item.city}
Seller: ${item.contactName ?? 'unknown'}${item.isBusiness ? ' (business)' : ' (private)'}
Category params: ${Object.entries(item.params).filter(([k]) => k !== 'price').map(([k, v]) => `${k}: ${v}`).join(', ')}

Full description (Polish):
${(item.description || 'No description provided').slice(0, 8000)}`;

  const response = await getClient().messages.create({
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
  }, { timeout: 30_000 });

  const textBlock = response.content.find((b) => b.type === 'text');
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
Return ONLY valid JSON (no markdown fences):
{"rejected": true/false, "rejectionReason": "reason string or null"}
Set rejected=true and provide rejectionReason if the listing fails ANY of the criteria.
If the listing passes all criteria, set rejected=false and rejectionReason=null.`;

export async function evaluateRejection(
  listing: { platform: string; platformId: string; title: string },
  universalParse: ParsedRentalData | ParsedItemData,
  rejectionCriteria: string,
): Promise<RejectionResult> {
  const criteriaHash = hashText(rejectionCriteria);

  // Check rejection cache
  const cached = getRejectionCache(listing.platform, listing.platformId, criteriaHash);
  if (cached) return cached;

  // Build a compact summary from the universal parse for the rejection prompt
  const summaryParts: string[] = [`Title: ${listing.title}`];

  // Rental-specific fields
  if ('totalMonthlyCost' in universalParse && universalParse.totalMonthlyCost != null) {
    summaryParts.push(`Total monthly cost: ${universalParse.totalMonthlyCost} PLN`);
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

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 256,
    temperature: 0,
    system: REJECTION_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  }, { timeout: 15_000 });

  const textBlock = response.content.find((b) => b.type === 'text');
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
