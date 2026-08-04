// AI-powered comprehensive listing analysis using Claude
// Produces deep, human-readable assessments — not just field extraction

import { createHash } from 'node:crypto';
import type { Listing, ParsedRentalData, ParsedItemData, RejectionResult } from '../types.js';
import type { ItemListing } from '../crawlers/olx-items.js';
import { getParsedListing, saveParsedListing, getRejectionCache, saveRejectionCache } from '../storage/db.js';
import { ParsedRentalDataSchema, ParsedItemDataSchema, RejectionResultSchema, RentalTriageSchema } from './schemas.js';
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
export const RENTAL_PARSE_VERSION = 'wfh-v6-location-evidence-validation';
export const ITEM_PARSE_VERSION = 'v2';
// Folded into the rejection cache key; bump on any REJECTION_PROMPT change so already-cached
// verdicts computed under the old rejection rules are re-evaluated instead of served stale.
export const REJECTION_PROMPT_VERSION = 'rej-v1';

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function triFact(v: boolean | null | undefined): string {
  return v === true ? 'yes' : v === false ? 'no' : 'unknown';
}

function locationWords(value: string): string[] {
  const generic = new Set([
    'metro', 'metra', 'stacja', 'station', 'przystanek', 'przystanku', 'stop',
    'warszawa', 'warsaw', 'polska', 'poland', 'ul', 'ulica', 'aleja',
    'od', 'do', 'przy', 'obok', 'm', 'km', 'min', 'm1', 'm2',
  ]);
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !/^\d+$/.test(word) && !generic.has(word));
}

/** Two location words are "the same place" if identical or they share a prefix proportional to the
 *  shorter word (min 4 chars). A fixed 4-char prefix both over-matched distinct places (Wilanowska
 *  vs Wilanowie) and under-matched short Polish declensions (wola vs woli). */
function locationWordsSimilar(a: string, b: string): boolean {
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen < 4) return false;
  const need = Math.min(6, Math.ceil(minLen * 0.7));
  return a.slice(0, need) === b.slice(0, need);
}

export function locationEvidenceSupportsAnchor(query: string, evidence: string): boolean {
  const anchorWords = locationWords(query);
  const evidenceWords = locationWords(evidence);
  if (anchorWords.length === 0 || evidenceWords.length === 0) return false;
  const matched = anchorWords.filter((anchor) => evidenceWords.some((word) => locationWordsSimilar(word, anchor)));
  const required = anchorWords.length === 1 ? 1 : Math.ceil(anchorWords.length * 0.6);
  return matched.length >= required;
}

/**
 * Enforce the meaning of a selected location anchor independently of the LLM.
 * An address, intersection, building/estate, or neighborhood identifies where
 * the apartment is; a distance quoted to some other place must not move it.
 */
export function normalizeLocationHint(
  hint: ParsedRentalData['locationHint'],
): ParsedRentalData['locationHint'] {
  const fixedAnchorKinds = new Set(['address', 'intersection', 'building', 'estate', 'neighborhood']);
  if (!fixedAnchorKinds.has(hint.kind) || (hint.anchorDistanceMeters ?? 0) === 0) {
    const usesRemoteAnchor = hint.kind === 'transit_stop' || hint.kind === 'landmark';
    const hasPositiveDistance = (hint.anchorDistanceMeters ?? 0) > 0;
    if (
      usesRemoteAnchor &&
      hasPositiveDistance &&
      (!hint.query || !hint.evidence || !locationEvidenceSupportsAnchor(hint.query, hint.evidence))
    ) {
      return {
        query: null,
        kind: 'none',
        anchorDistanceMeters: null,
        uncertaintyMeters: null,
        evidence: hint.evidence,
      };
    }
    return hint;
  }

  if (
    hint.query &&
    hint.evidence &&
    locationEvidenceSupportsAnchor(hint.query, hint.evidence)
  ) {
    const normalizedQuery = hint.query
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase();
    const transitAnchor = /\b(?:metro|metra|stacja|przystanek|dworzec)\b/.test(normalizedQuery);
    return {
      ...hint,
      kind: transitAnchor ? 'transit_stop' : 'landmark',
    };
  }

  return {
    ...hint,
    anchorDistanceMeters: 0,
    // The model coupled this evidence to the wrong anchor, so do not display it
    // as support for the selected location.
    evidence: null,
  };
}

/**
 * Fingerprint for a rental parse — version + every field that goes into the LLM user
 * message. Same inputs → cache hit (search ↔ monitor share). Different inputs → miss.
 */
export function rentalParseCacheKey(
  listing: Pick<
    Listing,
    | 'description'
    | 'title'
    | 'price'
    | 'rent'
    | 'deposit'
    | 'area'
    | 'rooms'
    | 'floor'
    | 'buildingFloor'
    | 'buildingType'
    | 'heating'
    | 'hasInternet'
    | 'hasElevator'
    | 'hasAc'
    | 'buildYear'
    | 'city'
    | 'district'
    | 'street'
    | 'lat'
    | 'lng'
    | 'advertiserType'
  >,
  version = RENTAL_PARSE_VERSION,
): string {
  const desc = (listing.description || '').slice(0, 8000);
  const parts = [
    version,
    `model:${PARSE_MODEL}`, // a model swap must re-parse, not serve the old model's cached output
    `title:${listing.title}`,
    desc,
    `price:${listing.price}`,
    `rent:${listing.rent ?? ''}`,
    `deposit:${listing.deposit ?? ''}`,
    `area:${listing.area ?? ''}`,
    `rooms:${listing.rooms ?? ''}`,
    `floor:${listing.floor ?? ''}`,
    `buildingFloor:${listing.buildingFloor ?? ''}`,
    `buildingType:${listing.buildingType ?? ''}`,
    `heating:${listing.heating ?? ''}`,
    `internet:${triFact(listing.hasInternet)}`,
    `elevator:${triFact(listing.hasElevator)}`,
    `ac:${triFact(listing.hasAc)}`,
    `buildYear:${listing.buildYear ?? ''}`,
    `city:${listing.city}`,
    `district:${listing.district ?? ''}`,
    `street:${listing.street ?? ''}`,
    `lat:${listing.lat ?? ''}`,
    `lng:${listing.lng ?? ''}`,
    `advertiser:${listing.advertiserType ?? ''}`,
  ];
  return hashText(parts.join('\n'));
}

/** Fingerprint for an item parse — same rule as rentals. */
export function itemParseCacheKey(
  item: Pick<ItemListing, 'description' | 'title' | 'price' | 'currency' | 'negotiable' | 'condition' | 'city' | 'contactName' | 'isBusiness' | 'params'>,
  version = ITEM_PARSE_VERSION,
): string {
  const desc = (item.description || '').slice(0, 8000);
  const params = Object.entries(item.params)
    .filter(([k]) => k !== 'price')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join(',');
  const parts = [
    version,
    `model:${PARSE_MODEL}`,
    `title:${item.title}`,
    desc,
    `price:${item.price}`,
    `currency:${item.currency}`,
    `negotiable:${item.negotiable ? 1 : 0}`,
    `condition:${item.condition ?? ''}`,
    `city:${item.city}`,
    `contact:${item.contactName ?? ''}`,
    `business:${item.isBusiness ? 1 : 0}`,
    `params:${params}`,
  ];
  return hashText(parts.join('\n'));
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
- adminFee (czynsz administracyjny): prefer structured input when given; if missing, extract from the description ("czynsz admin.", "cz. adm.", "czynsz 800 zł" when clearly the admin fee, not najem).
- estimatedMedia — CRITICAL for true monthly cost. Fill EVERY utility the TENANT pays SEPARATELY on top of czynsz. If a utility is already inside czynsz, leave that field null (no double counting). Do NOT invent a total — the app sums fields.
  Categories: water, electricity, gas, heating (CO/ogrzewanie), internet, other (undifferentiated lump).
  Polish patterns — be clever:
  • "media w cenie" / "media w czynszu" / "czynsz z mediami" / "wszystkie opłaty w cenie" → all media null.
  • "czynsz + media" / "+ media" / "media osobno" / "media wg zużycia" / "zaliczki na media" / "opłaty poza czynszem" → tenant pays media; extract amounts or ESTIMATE typical Warsaw monthly zł for this flat size — do not leave null just because no exact number.
  • Lump only ("zaliczka na media 400 zł", "media ok. 500") with no breakdown → put the amount in "other"; do not fake a precise 5-way split.
  • Partial breakdown ("prąd ~200, reszta media 300") → fill known keys; remainder → other.
  • "CO w czynszu" / "ogrzewanie w czynszu" → heating null; "CO osobno" / "wg zużycia" → estimate heating.
  • "internet w cenie" → internet null; "światłowód do podłączenia" / not included → estimate internet if tenant must pay.
  • "prąd według licznika" with no number → still estimate electricity.
  Prefer slightly conservative (higher) estimates over optimistic nulls when the ad is clearly "+ media" without numbers — underestimating breaks budget filters.
- addressHint: ONLY an exact street/address or intersection that identifies the apartment location; null for a vague district or a destination merely described as nearby.
- locationHint: reason carefully about every location clue in the title and description. Extract the best GOOGLE-GEOCODABLE ANCHOR for where the apartment probably is:
  • Prefer exact address/number, then intersection, named building, named residential estate, a stop explicitly said to be at/under the building, then a landmark or named transit stop with a stated distance from the apartment.
  • Use kind "building" only for one point-like building or complex. Use kind "estate" for an osiedle or other named residential area (for example "osiedle Przyjaźń"); an estate is not precise enough to treat as one building.
  • Preserve names verbatim from the listing. NEVER invent, silently correct, merge, or rename a station/stop. Google will validate the name later.
  • The query must include city and enough Polish context to geocode (e.g. "przystanek Hala Wola, Warszawa" or "metro Bemowo Ratusz, Warszawa").
  • anchorDistanceMeters is ONLY the distance from THE SELECTED query anchor to the apartment. Exact address/intersection/building/estate or "at/under the stop" → 0. If query is "metro X" and the ad says "1000m from metro X" → 1000. If query is the apartment's estate/building, keep 0 even when the same sentence mentions 1000m to a DIFFERENT place. Never attach one place's distance to another anchor. Do not convert bus/tram stop counts into walking metres.
  • uncertaintyMeters is the conservative ± margin around anchorDistanceMeters: address 50-100m; intersection/building 100-250m; estate 500-1200m; exact stated metric distance ±100-250m; "next to stop" ±200-400m; vague landmark ±400-800m; neighborhood ±1200-2500m. If only "nearby" is stated, use a broad margin, not false precision.
  • If the ad only gives a district with no better clue, set query null/kind none; the platform district pin is handled separately.
  • evidence is one short quote-like source phrase from the ad, not an inference.
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
  "addressHint": "точный адрес/перекрёсток" | null,
  "locationHint": {
    "query": "Google query grounded in the ad, with city" | null,
    "kind": "address"|"intersection"|"building"|"estate"|"transit_stop"|"landmark"|"neighborhood"|"none",
    "anchorDistanceMeters": number|null,
    "uncertaintyMeters": number|null,
    "evidence": "short source phrase from the listing" | null
  },
  "isConcreteApartment": true|false,
  "estimatedMedia": { "water": number|null, "electricity": number|null, "gas": number|null, "internet": number|null, "heating": number|null, "other": number|null },
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

// ---------------------------------------------------------------------------
// Rental triage — cheap Haiku gate run BEFORE the expensive enrich + full parse.
// Answers only "is this one whole apartment?" and its room count, so we never spend
// enrichment/full-analysis effort on single-room, coliving, shared, or non-flat listings.
// ---------------------------------------------------------------------------

const TRIAGE_PROMPT = `Classify a Polish rental listing from its title + short description. Answer ONLY whether it is ONE whole self-contained apartment offered for rent, and its room count.

apartment = false when it is NOT a single independent flat, e.g.: a single room ("pokój do wynajęcia", "wynajmę pokój"), a bed/place in a shared room ("miejsce w pokoju", "łóżko"), a student room (stancja), a roommate/coliving offer (współlokator, coliving, rooms rented separately "pokoje wynajmowane osobno", per-person pricing "za osobę" / "zł/os"), an agency portfolio advertising many flats, a new-development sale, or a price range. apartment = true for a normal mieszkanie / apartament / kawalerka (studio) rented as a whole — a plain capacity phrase like "idealne dla 2 osób" is NOT coliving.

rooms = the apartment's room count (pokoje; kawalerka/studio = 1) if determinable, else null.

Return ONLY JSON, no prose: {"apartment": true|false, "rooms": number|null}`;

export interface RentalTriage {
  apartment: boolean;
  rooms: number | null;
}

/** Cheap pre-parse gate. Fails OPEN (returns apartment:true) on any error so a triage
 *  hiccup never wrongly drops a real listing. */
export async function triageRentalListing(
  listing: Pick<Listing, 'title' | 'description' | 'rooms'>,
  ctx: AiCallCtx = {},
): Promise<RentalTriage> {
  const fallback: RentalTriage = { apartment: true, rooms: listing.rooms ?? null };
  try {
    const userMessage = `Title: ${listing.title}
Structured rooms (from platform, may be missing): ${listing.rooms ?? 'unknown'}
Description (Polish, truncated):
${(listing.description || 'No description').slice(0, 600)}`;

    const response = await createMessageTracked({
      model: PARSE_MODEL,
      max_tokens: 64,
      temperature: 0,
      // No cache_control: the prompt is far below the min cacheable size, so it would be
      // inert. Triage is intentionally uncached — it's the cheapest call and the monitor
      // path is already gated by isListingSeen.
      system: TRIAGE_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }, { feature: 'triage_rental', ...ctx }, { timeout: 30_000 });

    const textBlock = response.content.find((b: { type: string }) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') return fallback;
    const match = textBlock.text.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    return RentalTriageSchema.parse(JSON.parse(match[0])) as RentalTriage;
  } catch (err) {
    console.error('[triage] failed, keeping listing:', err instanceof Error ? err.message : err);
    return fallback;
  }
}

export async function parseRentalListing(listing: Listing, ctx: AiCallCtx = {}): Promise<ParsedRentalData> {
  const descHash = rentalParseCacheKey(listing);

  // Check cache — hit only when fingerprint matches (same parse inputs).
  const cached = getParsedListing(listing.platform, listing.platformId);
  if (cached && cached.description_hash === descHash) {
    try {
      const parsed = JSON.parse(cached.parsed_data);
      // Old rows may predate estimatedMedia.other — normalize so consumers can rely on the key.
      if (parsed?.estimatedMedia && parsed.estimatedMedia.other === undefined) {
        parsed.estimatedMedia.other = null;
      }
      if (!parsed?.locationHint) {
        parsed.locationHint = { query: null, kind: 'none', anchorDistanceMeters: null, uncertaintyMeters: null, evidence: null };
      }
      recordLocalCacheHit({ feature: 'parse_rental', ...ctx }, PARSE_MODEL);
      return parsed;
    } catch {
      console.warn(`[parse-listing] Corrupt cache entry for ${listing.platform}:${listing.platformId}, re-parsing`);
    }
  }

  const tri = triFact;
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

  const truncated = response.stop_reason === 'max_tokens';
  if (truncated) {
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
    parsed.locationHint = normalizeLocationHint(parsed.locationHint);
  } catch (parseErr) {
    console.error('[parse-listing] Failed to parse/validate AI JSON:', jsonStr.slice(0, 200));
    throw new Error('AI returned invalid JSON');
  }

  // Truncated responses may look valid but omit fields — do not poison the shared cache.
  if (!truncated) {
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
  } else {
    console.warn(`[parse-listing] Skipping cache write for truncated parse ${listing.platform}:${listing.platformId}`);
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
  const descHash = itemParseCacheKey(item);

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

  const truncated = response.stop_reason === 'max_tokens';
  if (truncated) {
    console.error(`[parse-listing] TRUNCATED (max_tokens) item ${item.platform}:${item.platformId}`);
  }

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

  if (!truncated) {
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
  } else {
    console.warn(`[parse-listing] Skipping cache write for truncated item parse ${item.platform}:${item.platformId}`);
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
  listing: { platform: string; platformId: string; title: string; price?: number | null; description?: string | null },
  universalParse: ParsedRentalData | ParsedItemData,
  rejectionCriteria: string,
  ctx: AiCallCtx = {},
): Promise<RejectionResult> {
  // Build a compact summary from listing + universal parse for the rejection prompt.
  // (The cache key is derived from this summary below, once it is fully built.)
  const summaryParts: string[] = [`Title: ${listing.title}`];

  // Listing-level fields (from crawler data — always available)
  const l = listing as Record<string, unknown>;
  if (l.floor != null) summaryParts.push(`Floor: ${l.floor}`);
  if (l.area != null) summaryParts.push(`Area: ${l.area} m²`);
  if (l.rooms != null) summaryParts.push(`Rooms: ${l.rooms}`);
  if (l.district) summaryParts.push(`District: ${l.district}`);
  if (l.city) summaryParts.push(`City: ${l.city}`);
  if (l.advertiserType) summaryParts.push(`Advertiser: ${l.advertiserType}`);
  // Use the listing's real currency, not a hardcoded 'PLN' — otherwise a non-PLN (e.g. EUR) flat is
  // handed to the rejection LLM as a fabricated PLN figure and can slip a free-text budget criterion.
  const cur = typeof l.currency === 'string' ? l.currency : 'PLN';
  if (l.price != null) summaryParts.push(`Rent price: ${l.price} ${cur}`);
  if (l.rent != null) summaryParts.push(`Czynsz admin: ${l.rent} ${cur}`);

  // AI-parsed fields
  // Total monthly cost is computed in code (rentals only) — the LLM's own total is unreliable.
  if ('estimatedMedia' in universalParse) {
    const cost = computeRentalCost(
      {
        price: typeof l.price === 'number' ? l.price : 0,
        rent: typeof l.rent === 'number' ? l.rent : null,
        currency: typeof l.currency === 'string' ? l.currency : undefined,
      },
      universalParse as ParsedRentalData,
    );
    // Only assert a PLN total when the base rent is actually known in PLN; otherwise the "total"
    // is just czynsz+media (understated) or a foreign-currency sum mislabelled as PLN — never hand
    // the rejection LLM a fabricated number.
    if (cost.basePriceKnown && cost.total > 0) {
      summaryParts.push(`Total monthly cost: ${cost.total} PLN`);
    } else if (!cost.basePriceKnown) {
      summaryParts.push(`Total monthly cost: base rent not stated (price on request or non-PLN)`);
    }
    // Deposit (kaucja): surface it so deposit-based rejection criteria (e.g. "залог не больше 5000")
    // can actually fire — the LLM only sees this summary. Prefer the parsed numeric, then the
    // parsed note, then the crawler value.
    const rp = universalParse as ParsedRentalData;
    const deposit = rp.deposit ?? (typeof l.deposit === 'number' ? l.deposit : null);
    // A kaucja parsed from the Polish description (rp.deposit) is quoted in zł regardless of the
    // platform's listing currency, so label it PLN; only the crawler's structured l.deposit follows
    // the listing currency. (Mirrors the base-rent block's care not to hand the LLM a mislabeled sum.)
    if (deposit != null) summaryParts.push(`Deposit (kaucja): ${deposit} ${rp.deposit != null ? 'PLN' : cur}`);
    else if (rp.depositNote) summaryParts.push(`Deposit (kaucja): ${rp.depositNote}`);
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
  // WFH-core signals the household ranks on — surface them so free-text criteria like "обязательно
  // оптоволокно" / "только светлые" / "минимум 2 отдельные комнаты" can actually fire (the rejection
  // LLM only sees this summary; a missing field is treated as PASS).
  if ('separateRooms' in universalParse && universalParse.separateRooms != null) {
    summaryParts.push(`Separate (non-passthrough) rooms: ${universalParse.separateRooms}`);
  }
  if ('layoutType' in universalParse && universalParse.layoutType != null) {
    summaryParts.push(`Layout: ${universalParse.layoutType}`);
  }
  if ('naturalLight' in universalParse && universalParse.naturalLight != null) {
    summaryParts.push(`Natural light: ${universalParse.naturalLight}`);
  }
  if ('internetType' in universalParse && universalParse.internetType != null) {
    summaryParts.push(`Internet: ${universalParse.internetType}`);
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

  // Derive the cache key from EXACTLY what the rejection LLM sees. summaryParts folds in every
  // verdict-driving input (rent price + czynsz admin, the computed PLN total, floor/area/rooms/
  // district, and the parse-derived contract/quiet/condition/etc.), so any change that would alter
  // the verdict busts the cache and forces a fresh evaluation — while a stable listing keeps hitting
  // cache (the underlying parse is itself cached). Parse identity uses the version constant for THIS
  // parse type so an ITEM_PARSE_VERSION bump invalidates item verdicts and a RENTAL_PARSE_VERSION
  // bump rental verdicts — not the wrong half.
  const parseVersion = 'estimatedMedia' in universalParse ? RENTAL_PARSE_VERSION : ITEM_PARSE_VERSION;
  const criteriaHash = hashText(`${REJECTION_PROMPT_VERSION}::${parseVersion}::${PARSE_MODEL}::${rejectionCriteria}::${summaryParts.join('\n')}`);
  const cached = getRejectionCache(listing.platform, listing.platformId, criteriaHash);
  if (cached) {
    recordLocalCacheHit({ feature: 'rejection_eval', ...ctx }, PARSE_MODEL);
    return cached;
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
  let cacheable = true;
  try {
    const raw = JSON.parse(rejJsonStr);
    result = RejectionResultSchema.parse(raw) as RejectionResult;
    // RejectionResultSchema.rejected has `.catch(false)` for parse robustness, which silently
    // coerces a wrong-typed value (e.g. "yes", 1) to false. That coercion is itself a FAIL-OPEN
    // guess — treat it exactly like a JSON-parse failure: use it for this call but do NOT persist
    // it as a permanent "passes" verdict.
    if (typeof raw?.rejected !== 'boolean') cacheable = false;
  } catch (parseErr) {
    console.error('[evaluateRejection] Failed to parse AI JSON:', rejJsonStr.slice(0, 200));
    // A malformed/truncated response FAILS OPEN (rejected=false) — don't persist that as a
    // permanent "passes" verdict, or a genuinely-rejectable flat is shown forever on a one-off blip.
    result = { rejected: false, rejectionReason: null };
    cacheable = false;
  }

  // Cache the rejection result (only a genuine verdict, never a fail-open default).
  if (cacheable) {
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
  }

  return result;
}
