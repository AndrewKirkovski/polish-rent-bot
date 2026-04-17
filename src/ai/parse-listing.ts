// AI-powered listing data extraction using Claude
// Parses rental and item listings to extract structured data with caching

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import type { Listing, ParsedRentalData, ParsedItemData } from '../types.js';
import type { ItemListing } from '../crawlers/olx-items.js';
import { getParsedListing, saveParsedListing } from '../storage/db.js';

// Re-export types for convenience
export type { ParsedRentalData, ParsedItemData } from '../types.js';

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client === null) {
    _client = new Anthropic();
  }
  return _client;
}

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// Hash helper
// ---------------------------------------------------------------------------

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

// ---------------------------------------------------------------------------
// Rental listing parser
// ---------------------------------------------------------------------------

const RENTAL_SYSTEM_PROMPT = `You are a Polish real estate listing data extractor. Given a rental listing's title, description, and metadata, extract structured information. Return ONLY valid JSON — no markdown fences, no explanation.

The JSON must match this schema exactly:
{
  "deposit": number | null,
  "adminFee": number | null,
  "estimatedMedia": {
    "water": number | null,
    "electricity": number | null,
    "gas": number | null,
    "internet": number | null,
    "heating": number | null
  },
  "totalMonthlyCost": number | null,
  "contractType": "najem_okazjonalny" | "najem_zwykly" | "najem_instytucjonalny" | null,
  "availableFrom": string | null,
  "minimumLease": string | null,
  "petFriendly": boolean | null,
  "smokingAllowed": boolean | null,
  "furnished": "full" | "partial" | "none" | null,
  "parkingIncluded": boolean | null,
  "balcony": boolean | null,
  "additionalNotes": string[]
}

Rules:
- "deposit" is "kaucja" in PLN. If described as "2x czynsz", multiply the rent amount.
- "adminFee" is "czynsz administracyjny" or "czynsz do spółdzielni" — only if it differs from the main rent field.
- "estimatedMedia" — extract monthly utility estimates if mentioned. Values in PLN.
- "totalMonthlyCost" = rent + adminFee + sum of all estimated media. If any component is unknown, set to null.
- "contractType" — look for "najem okazjonalny", "umowa najmu okazjonalnego", etc.
- "availableFrom" — ISO date string (YYYY-MM-DD) or descriptive string like "od zaraz".
- "minimumLease" — e.g. "12 miesięcy", "1 rok".
- "petFriendly" — look for "zwierzęta", "pies", "kot" mentions.
- "smokingAllowed" — look for "palenie", "niepalący".
- "furnished" — "full" if fully furnished ("umeblowane"), "partial" if partially, "none" if empty.
- "parkingIncluded" — look for "parking", "garaż", "miejsce postojowe".
- "balcony" — look for "balkon", "taras", "loggia".
- "additionalNotes" — any important info not captured above (max 5 items, each max 100 chars).
- Use null for unknown/unmentioned fields. Never guess.`;

export async function parseRentalListing(
  listing: Listing,
): Promise<ParsedRentalData> {
  // Check cache first
  const descriptionHash = hashText(listing.description);
  const cached = getParsedListing(listing.platform, listing.platformId);

  if (cached !== undefined && cached.description_hash === descriptionHash) {
    return JSON.parse(cached.parsed_data) as ParsedRentalData;
  }

  // Build input for Claude
  const inputText = [
    `Title: ${listing.title}`,
    `Price (rent): ${listing.price} ${listing.currency}`,
    listing.rent != null ? `Czynsz (admin fee from listing): ${listing.rent} PLN` : '',
    listing.deposit != null ? `Deposit from listing fields: ${listing.deposit} PLN` : '',
    listing.area != null ? `Area: ${listing.area} m²` : '',
    listing.rooms != null ? `Rooms: ${listing.rooms}` : '',
    listing.floor != null ? `Floor: ${listing.floor}` : '',
    listing.heating ? `Heating: ${listing.heating}` : '',
    listing.furniture != null ? `Furniture field: ${listing.furniture}` : '',
    listing.parking ? `Parking field: ${listing.parking}` : '',
    '',
    `Description:`,
    listing.description,
  ]
    .filter(Boolean)
    .join('\n');

  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    temperature: 0,
    system: RENTAL_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: inputText }],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude for rental listing parse');
  }

  const parsed = JSON.parse(textBlock.text) as ParsedRentalData;

  // Save to cache
  saveParsedListing(
    listing.platform,
    listing.platformId,
    'rental',
    JSON.stringify(parsed),
    descriptionHash,
  );

  return parsed;
}

// ---------------------------------------------------------------------------
// Item listing parser
// ---------------------------------------------------------------------------

const ITEM_SYSTEM_PROMPT = `You are a Polish marketplace listing data extractor. Given an item listing's title, description, and metadata, extract structured information. Return ONLY valid JSON — no markdown fences, no explanation.

The JSON must match this schema exactly:
{
  "actualCondition": string,
  "whySelling": string | null,
  "defects": string[],
  "includedAccessories": string[],
  "additionalNotes": string[]
}

Rules:
- "actualCondition" — your assessment of the real condition based on description. Be honest — e.g. "Good, light wear" not just repeating the category label.
- "whySelling" — reason for selling if mentioned.
- "defects" — list of specific defects, scratches, damage mentioned. Empty array if none.
- "includedAccessories" — what comes with the item (charger, box, cables, etc.). Empty array if not mentioned.
- "additionalNotes" — any important info not captured above (max 5 items, each max 100 chars).
- Use null for unknown/unmentioned fields. Never guess.`;

export async function parseItemListing(
  item: ItemListing,
): Promise<ParsedItemData> {
  // Check cache first
  const descriptionHash = hashText(item.description);
  const cached = getParsedListing(item.platform, item.platformId);

  if (cached !== undefined && cached.description_hash === descriptionHash) {
    return JSON.parse(cached.parsed_data) as ParsedItemData;
  }

  // Build input for Claude
  const paramLines = Object.entries(item.params)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');

  const inputText = [
    `Title: ${item.title}`,
    `Price: ${item.price} ${item.currency}${item.negotiable ? ' (negotiable)' : ''}`,
    item.condition ? `Listed condition: ${item.condition}` : '',
    item.categoryName ? `Category: ${item.categoryName}` : '',
    paramLines ? `Parameters:\n${paramLines}` : '',
    '',
    `Description:`,
    item.description,
  ]
    .filter(Boolean)
    .join('\n');

  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    temperature: 0,
    system: ITEM_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: inputText }],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude for item listing parse');
  }

  const parsed = JSON.parse(textBlock.text) as ParsedItemData;

  // Save to cache
  saveParsedListing(
    item.platform,
    item.platformId,
    'item',
    JSON.stringify(parsed),
    descriptionHash,
  );

  return parsed;
}
