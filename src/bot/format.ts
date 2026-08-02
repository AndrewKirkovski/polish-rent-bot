// Rich notification formatters for Telegram
// Uses HTML parse_mode — sanitize user/AI text with esc()

import type TelegramBot from 'node-telegram-bot-api';
import sanitizeHtml from 'sanitize-html';
import type { Listing, ParsedRentalData, ParsedItemData, LocationScore, NearbyPlace } from '../types.js';
import type { ItemListing } from '../crawlers/olx-items.js';
import { computeRentalCost } from '../cost.js';

/** Repair broken HTML from message splitting — close unclosed tags, strip orphan close tags */
function sanitizeChunk(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
                  'a', 'code', 'pre', 'blockquote', 'tg-emoji', 'tg-spoiler', 'span'],
    allowedAttributes: { 'a': ['href'], 'tg-emoji': ['emoji-id'], 'code': ['class'], 'span': ['class'], 'blockquote': ['expandable'] },
    transformTags: { 'strong': 'b', 'em': 'i', 'ins': 'u', 'strike': 's', 'del': 's' },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape HTML special chars in user/AI-generated text for Telegram HTML parse_mode */
function esc(text: string | number | null | undefined): string {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function pln(amount: number | null | undefined): string {
  if (amount == null) return '\u2014';
  return amount.toLocaleString('pl-PL') + ' PLN';
}

/** Truncate AI free-text so an over-long LLM summary can't push the card past
 *  Telegram's single-message limit (the "1-2 sentence" instruction is prompt-only). */
function trunc(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '\u2026';
}

function metricRangeDistance(meters: number, bound: 'lower' | 'upper'): string {
  const round = bound === 'lower' ? Math.floor : Math.ceil;
  if (meters < 1000) return `${round(meters / 50) * 50} м`;
  const km = round(meters / 100) / 10;
  return `${km.toFixed(1).replace('.', ',')} км`;
}

/** Visible length as Telegram counts it for caption limits: HTML tags don't count,
 *  but a custom emoji counts as its fallback character(s). Used to decide whether a
 *  card fits the 1024-char photo-caption budget and to drive the safety-trim. */
function visibleText(html: string): string {
  return html
    .replace(/<tg-emoji[^>]*>([^<]*)<\/tg-emoji>/g, '$1') // keep the fallback emoji
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/g, '$1')          // keep anchor text, drop href
    .replace(/<[^>]+>/g, '')                              // strip remaining tags
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); // count entities as 1 char (& last)
}

export function captionLength(html: string): number {
  return visibleText(html).length;
}

/** Telegram photo-caption limit. */
export const CAPTION_LIMIT = 1024;

/** Split text into chunks that fit Telegram's 4096 char limit.
 *  Each chunk is passed through sanitize-html to repair any broken HTML from the split. */
export function splitMessage(text: string, limit = 3500): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n\n', limit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = limit;

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);

  // Repair any broken HTML in each chunk (unclosed tags get closed, orphan close tags stripped)
  return chunks.map(chunk => sanitizeChunk(chunk));
}

// ---------------------------------------------------------------------------
// Custom emoji — premium animated emoji via tg-emoji tags
// ---------------------------------------------------------------------------

// Custom emoji the cards render — keep in sync with actual usage.
const CE = {
  fire:       '<tg-emoji emoji-id="5425111515294354563">🔥</tg-emoji>',
  warning:    '<tg-emoji emoji-id="5357067430755585653">❗️</tg-emoji>',
  price:      '<tg-emoji emoji-id="5435999124245729290">💰</tg-emoji>',
  house:      '<tg-emoji emoji-id="5363840027245696377">🏠</tg-emoji>',
  phone:      '<tg-emoji emoji-id="5433866857666855412">📞</tg-emoji>',
  thinking:   '<tg-emoji emoji-id="5424920651242687937">💭</tg-emoji>',
  pros:       '<tg-emoji emoji-id="5224694451338759997">↗️</tg-emoji>',
  cons:       '<tg-emoji emoji-id="5224340348465073584">↘️</tg-emoji>',
  location:   '<tg-emoji emoji-id="5192907870827467960">🗺</tg-emoji>',
  gym:        '<tg-emoji emoji-id="5443161635046833571">🍑</tg-emoji>',
} as const;

// ---------------------------------------------------------------------------
// Rental card — comprehensive
// ---------------------------------------------------------------------------

/** Render one nearby metro station: "Politechnika (M1) ~450 м · 6 мин" (ranges when approximate). */
function renderMetroPlace(p: NearbyPlace): string {
  const station = `${esc(p.name)}${p.lineName ? ` (${esc(p.lineName)})` : ''}`;
  const distance = p.distanceMetersRange
    ? `~${metricRangeDistance(p.distanceMetersRange.min, 'lower')}–${metricRangeDistance(p.distanceMetersRange.max, 'upper')}`
    : esc(p.distance);
  const minutes = p.walkingMinutesRange
    ? `~${p.walkingMinutesRange.min}–${p.walkingMinutesRange.max} мин`
    : p.walkingMinutes >= 0 ? `${p.walkingMinutes} мин` : '?';
  return `${station} ${distance} · ${minutes}`;
}

export function formatRentalCard(
  listing: Listing,
  parsed: ParsedRentalData | null | undefined,
  locationScore: LocationScore | null | undefined,
  resultId?: string | null,
  fitReason?: string | null,
): string {
  const cost = computeRentalCost(listing, parsed);
  const num = (n: number) => n.toLocaleString('pl-PL');
  const zl = (n: number) => `${num(n)} zł`;

  // --- Line 1 (no emoji): rooms · m² · total price · [ID] ---
  const headParts: string[] = [];
  if (listing.rooms != null) headParts.push(`${listing.rooms}к`);
  if (listing.area != null) headParts.push(`${listing.area}m²`);
  // When the base rent is unknown ("zapytaj o cenę") the total is only czynsz+media — not the real
  // monthly cost — so don't present it as the price.
  headParts.push(cost.basePriceKnown ? zl(cost.total) : 'цена по запросу');
  if (resultId) headParts.push(`[${resultId}]`);
  const headLine = `<b>${headParts.join(' · ')}</b>`;

  // --- Line 2: the 2 nearest metro stations with walk distance/time ---
  const metroLine = locationScore && locationScore.metroNearest.length > 0
    ? `Метро: ${locationScore.metroNearest.slice(0, 2).map(renderMetroPlace).join(' · ')}`
    : `Метро: станции неизвестны ⚠️`;

  // --- Line 3: transit to Warszawa Centralna + approximate-location triangle + range ---
  let centralLine: string;
  const central = locationScore?.centralStation ?? null;
  if (central) {
    const time = central.durationMinRange
      ? (central.durationMinRange.min === central.durationMinRange.max
          ? `~${central.durationMinRange.min} мин`
          : `~${central.durationMinRange.min}–${central.durationMinRange.max} мин`)
      : `время ⚠️`;
    centralLine = `Центральный вокзал: ${esc(central.distanceText)} · ${time}`;
  } else {
    centralLine = `Центральный вокзал: не определён ⚠️`;
  }
  if (locationScore?.locationWarning) {
    centralLine += ` · ⚠️ ${esc(locationScore.locationWarning)}`;
  }

  // --- Line 4: contract · kaucja · payment nuances ---
  const payLine: string[] = [];
  if (parsed?.contractType) payLine.push(`Umowa: ${esc(parsed.contractType.replace(/_/g, ' '))}`);
  if (parsed?.depositNote) payLine.push(`Kaucja: ${esc(trunc(parsed.depositNote, 48))}`);
  else if (parsed?.deposit != null) payLine.push(`Kaucja: ${zl(parsed.deposit)}`);
  else payLine.push(`Kaucja: ${CE.warning} ?`);
  if (cost.czynsz > 0 || cost.mediaSum > 0) {
    payLine.push(`${num(cost.najem)}+${num(cost.czynsz)}${cost.mediaSum > 0 ? `+~${num(cost.mediaSum)}` : ''}`);
  }
  if (parsed?.availableFrom) payLine.push(`с ${esc(trunc(parsed.availableFrom, 24))}`);
  if (parsed?.minimumLease) payLine.push(`мин. ${esc(trunc(parsed.minimumLease, 24))}`);
  const payLineStr = payLine.join(' · ');

  // --- Rest: title, key details, description, pros/cons, contact — link goes LAST ---
  const titleLine = esc(listing.title.slice(0, 80));

  const details: string[] = [];
  if (listing.floor != null) {
    const floorTxt = listing.buildingFloor != null ? `${listing.floor}/${listing.buildingFloor}эт` : `${listing.floor}эт`;
    const lift = listing.hasElevator === true ? ' 🛗' : listing.hasElevator === false ? ' без лифта' : '';
    details.push(`${floorTxt}${lift}`);
  }
  if (parsed?.furnished) details.push(parsed.furnished === 'none' ? 'без мебели' : parsed.furnished === 'full' ? 'меблир.' : 'част. мебл.');
  if (listing.buildYear != null) details.push(`${listing.buildYear}г`);
  if (parsed?.quiet === 'quiet') details.push('🔇 тихо');
  else if (parsed?.quiet === 'noisy') details.push('🔊 шумно');
  if (parsed?.naturalLight === 'bright') details.push('☀️ светло');
  else if (parsed?.naturalLight === 'dark') details.push('🌑 тёмно');
  if (listing.hasAc === true) details.push('❄️ кондиц.');
  const restriction = (parsed?.restrictions ?? [])[0];
  const detailsLine = (withRestriction: boolean) => {
    const parts = [...details, ...(withRestriction && restriction ? [esc(restriction)] : [])];
    return parts.length > 0 ? parts.join(' · ') : null;
  };

  const fitLine = fitReason ? `${CE.fire} ${esc(trunc(fitReason, 80))}` : null;
  const summaryLine = parsed?.descriptionSummary
    ? `${CE.thinking} ${esc(trunc(parsed.descriptionSummary, 200))}`
    : null;
  const positives = (parsed?.positives ?? []).slice(0, 2);
  const positivesLine = positives.length > 0 ? `${CE.pros} ${positives.map((p) => esc(p)).join(', ')}` : null;
  const redFlags = (parsed?.redFlags ?? []).slice(0, 2);
  const redFlagsLine = redFlags.length > 0 ? `${CE.cons} ${redFlags.map((f) => esc(f)).join(', ')}` : null;

  const contact: string[] = [];
  if (listing.phone) contact.push(`${CE.phone} ${esc(listing.phone)}`);
  if (listing.agencyName) contact.push(esc(listing.agencyName));
  const contactLine = contact.length > 0 ? contact.join(' · ') : null;

  // Assemble. Essentials (line 1-4 + link) never drop; the safety-trim sheds rest content
  // in order: summary → positives → red flags → details/restriction → fit.
  const assemble = (drop: { summary?: boolean; positives?: boolean; redFlags?: boolean; details?: boolean; fit?: boolean }): string => {
    // Blank line after each of the first 3 lines (headline / metro / center) for readability.
    const parts: string[] = [headLine, '', metroLine, '', centralLine, ''];
    if (payLineStr) parts.push(payLineStr);
    parts.push(titleLine);
    const dl = drop.details ? null : detailsLine(true);
    if (dl) parts.push(dl);
    if (!drop.fit && fitLine) parts.push(fitLine);
    if (!drop.summary && summaryLine) parts.push(summaryLine);
    if (!drop.positives && positivesLine) parts.push(positivesLine);
    if (!drop.redFlags && redFlagsLine) parts.push(redFlagsLine);
    if (contactLine) parts.push(contactLine);
    parts.push(listing.url); // link LAST
    return parts.join('\n');
  };

  const BUDGET = CAPTION_LIMIT - 8;
  const stages: Array<{ summary?: boolean; positives?: boolean; redFlags?: boolean; details?: boolean; fit?: boolean }> = [
    {},
    { summary: true },
    { summary: true, positives: true },
    { summary: true, positives: true, redFlags: true },
    { summary: true, positives: true, redFlags: true, details: true },
    { summary: true, positives: true, redFlags: true, details: true, fit: true },
  ];
  let card = assemble(stages[0]!);
  for (let i = 1; i < stages.length && captionLength(card) > BUDGET; i++) {
    card = assemble(stages[i]!);
  }
  return card;
}

// Backward-compatible alias
export const formatRichRentalNotification = formatRentalCard;

// ---------------------------------------------------------------------------
// Item card
// ---------------------------------------------------------------------------

export function formatItemCard(
  item: ItemListing,
  parsed: ParsedItemData | null | undefined,
): string {
  const lines: string[] = [];

  lines.push(`<b>${CE.price} ${pln(item.price)}${item.negotiable ? ' ↕' : ''}</b>${item.condition ? ` · ${esc(item.condition)}` : ''}`);
  lines.push(`${esc(item.title.slice(0, 80))}`);
  lines.push(item.url);

  if (parsed?.actualCondition) lines.push(`${CE.thinking} ${esc(trunc(parsed.actualCondition, 120))}`);
  const defects = (parsed?.defects ?? []).slice(0, 2);
  if (defects.length > 0) lines.push(`${CE.warning} ${defects.map((d) => esc(d)).join(', ')}`);

  const loc = item.city ? `${item.district ? esc(item.district) + ', ' : ''}${esc(item.city)}` : '';
  lines.push(`${loc}${loc ? ' · ' : ''}${item.shipping ? '📦' : '📍'}`);
  if (item.phone) lines.push(`${CE.phone} ${esc(item.phone)}`);

  return lines.join('\n');
}

// Backward-compatible alias
export const formatRichItemNotification = formatItemCard;

// ---------------------------------------------------------------------------
// Photo album sender
// ---------------------------------------------------------------------------

export async function sendPhotoAlbum(
  bot: TelegramBot,
  chatId: number | string,
  photoUrls: string[],
  caption?: string,
): Promise<TelegramBot.Message[]> {
  const urls = photoUrls.slice(0, 10);
  if (urls.length === 0) return [];

  if (urls.length === 1) {
    const msg = await bot.sendPhoto(chatId, urls[0], { caption, parse_mode: caption ? 'HTML' : undefined });
    return [msg];
  }

  const media = urls.map((url, i) => ({
    type: 'photo' as const,
    media: url,
    ...(i === 0 && caption ? { caption, parse_mode: 'HTML' as const } : {}),
  }));

  return bot.sendMediaGroup(chatId, media);
}
