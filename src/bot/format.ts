// Rich notification formatters for Telegram
// Uses HTML parse_mode — sanitize user/AI text with esc()

import type TelegramBot from 'node-telegram-bot-api';
import sanitizeHtml from 'sanitize-html';
import type { Listing, ParsedRentalData, ParsedItemData, LocationScore } from '../types.js';
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

/** Visible length as Telegram counts it for caption limits: HTML tags don't count,
 *  but a custom emoji counts as its fallback character(s). Used to decide whether a
 *  card fits the 1024-char photo-caption budget and to drive the safety-trim. */
function visibleText(html: string): string {
  return html
    .replace(/<tg-emoji[^>]*>([^<]*)<\/tg-emoji>/g, '$1') // keep the fallback emoji
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/g, '$1')          // keep anchor text, drop href
    .replace(/<[^>]+>/g, '');                              // strip remaining tags
}

export function captionLength(html: string): number {
  return visibleText(html).length;
}

/** Telegram photo-caption limit. */
export const CAPTION_LIMIT = 1024;

/** Escape `&` so a raw URL is a valid HTML attribute value (Telegram HTML parse_mode). */
function escAttr(url: string): string {
  return url.replace(/&/g, '&amp;');
}

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

const CE = {
  yes:        '<tg-emoji emoji-id="5424972835095329742">👍</tg-emoji>',
  no:         '<tg-emoji emoji-id="5416036249397905594">👎</tg-emoji>',
  fire:       '<tg-emoji emoji-id="5425111515294354563">🔥</tg-emoji>',
  warning:    '<tg-emoji emoji-id="5357067430755585653">❗️</tg-emoji>',
  doubt:      '<tg-emoji emoji-id="5357585725934029727">❓</tg-emoji>',
  price:      '<tg-emoji emoji-id="5435999124245729290">💰</tg-emoji>',
  house:      '<tg-emoji emoji-id="5363840027245696377">🏠</tg-emoji>',
  phone:      '<tg-emoji emoji-id="5433866857666855412">📞</tg-emoji>',
  mail:       '<tg-emoji emoji-id="5224229095927205846">💌</tg-emoji>',
  person:     '<tg-emoji emoji-id="5425112292683435471">🐰</tg-emoji>',
  landlord:   '<tg-emoji emoji-id="5433767609562578028">🐸</tg-emoji>',
  thinking:   '<tg-emoji emoji-id="5424920651242687937">💭</tg-emoji>',
  pros:       '<tg-emoji emoji-id="5224694451338759997">↗️</tg-emoji>',
  cons:       '<tg-emoji emoji-id="5224340348465073584">↘️</tg-emoji>',
  pets:       '<tg-emoji emoji-id="5224205894513873252">🐾</tg-emoji>',
  kitchen:    '<tg-emoji emoji-id="5364142105180521805">🍴</tg-emoji>',
  ac:         '<tg-emoji emoji-id="5424976150810086048">☀️</tg-emoji>',
  bathroom:   '<tg-emoji emoji-id="5436199127987799646">💦</tg-emoji>',
  contract:   '<tg-emoji emoji-id="5364265065799239497">✏️</tg-emoji>',
  // Location & amenities
  location:   '<tg-emoji emoji-id="5192907870827467960">🗺</tg-emoji>',
  gym:        '<tg-emoji emoji-id="5443161635046833571">🍑</tg-emoji>',
  pool:       '<tg-emoji emoji-id="5199865266875420387">🏊</tg-emoji>',
  pharmacy:   '<tg-emoji emoji-id="5363970667265934950">🩹</tg-emoji>',
  furniture:  '<tg-emoji emoji-id="5219787086130859981">🏖</tg-emoji>',
  costBreak:  '<tg-emoji emoji-id="5422878175250106861">🛍</tg-emoji>',
} as const;

function ceYn(val: boolean | null | undefined): string {
  if (val === true) return CE.yes;
  if (val === false) return CE.no;
  return CE.doubt;
}

// ---------------------------------------------------------------------------
// Rental card — comprehensive
// ---------------------------------------------------------------------------

export function formatRentalCard(
  listing: Listing,
  parsed: ParsedRentalData | null | undefined,
  locationScore: LocationScore | null | undefined,
): string {
  const cost = computeRentalCost(listing, parsed);
  const num = (n: number) => n.toLocaleString('pl-PL');
  const zl = (n: number) => `${num(n)} zł`;

  // --- Essential lines (never dropped) ---
  const breakdown = cost.czynsz > 0 || cost.mediaSum > 0
    ? ` (${num(cost.najem)}+${num(cost.czynsz)}${cost.mediaSum > 0 ? `+~${num(cost.mediaSum)}` : ''})`
    : '';
  const priceLine = `<b>${CE.price} ~${zl(cost.total)}/мес</b>${breakdown}`;
  const titleLine = `${CE.house} ${esc(listing.title.slice(0, 80))}`;
  const urlLine = listing.url;

  const payLine: string[] = [];
  if (parsed?.depositNote) payLine.push(`Kaucja: ${esc(parsed.depositNote)}`);
  else if (parsed?.deposit != null) payLine.push(`Kaucja: ${zl(parsed.deposit)}`);
  else payLine.push(`Kaucja: ${CE.warning} ?`);
  if (parsed?.contractType) payLine.push(esc(parsed.contractType.replace(/_/g, ' ')));
  const payLineStr = payLine.join(' · ');

  // --- Apartment line; the trailing restriction note is droppable ---
  const aptBase: string[] = [];
  if (listing.rooms != null) aptBase.push(`${listing.rooms}к`);
  if (listing.area != null) aptBase.push(`${listing.area}m²`);
  if (listing.floor != null) aptBase.push(`${listing.floor}эт`);
  if (parsed?.furnished) aptBase.push(parsed.furnished);
  aptBase.push(`🐾${ceYn(parsed?.petFriendly)} 🚬${ceYn(parsed?.smokingAllowed)}`);
  const restriction = (parsed?.restrictions ?? [])[0];
  const aptLine = (withRestriction: boolean) =>
    `${CE.house} ${[...aptBase, ...(withRestriction && restriction ? [esc(restriction)] : [])].join(' · ')}`;

  // --- Location line; the map link is folded into the 🗺 icon (no standalone line) ---
  let locationLine: string;
  if (locationScore) {
    const icons: Record<string, string> = { metro: '🚇', tram: '🚋', bus: '🚌', groceries: '🛒', gym: CE.gym };
    const amenParts = locationScore.amenities.map((a) => {
      const icon = icons[a.type] ?? '·';
      const mark = a.withinLimit ? '✓' : '✗';
      const p = a.places[0];
      const mins = p && p.walkingMinutes >= 0 ? `${p.walkingMinutes}m` : '?';
      return `${icon}${mins}${mark}`;
    });
    // Fold the map link into the place name (no standalone URL line). Plain text inside
    // <a> is safe; avoid nesting a <tg-emoji> in the anchor.
    const where = listing.district ? esc(listing.district) : esc(listing.city);
    const whereLinked = `<a href="${escAttr(locationScore.mapsLink)}">${where}</a>`;
    const commute = locationScore.commute ? ` →${esc(locationScore.commute.duration)}` : '';
    locationLine = `${CE.location} ${locationScore.overallScore} · ${amenParts.join(' ')}${commute} · ${whereLinked}`;
  } else {
    locationLine = `${CE.location} ${listing.district ? esc(listing.district) + ', ' : ''}${esc(listing.city)}`;
  }

  const contact: string[] = [];
  if (listing.phone) contact.push(`${CE.phone} ${esc(listing.phone)}`);
  if (listing.agencyName) contact.push(esc(listing.agencyName));
  const contactLine = contact.length > 0 ? contact.join(' · ') : null;

  // --- Droppable lines ---
  const summaryLine = parsed?.descriptionSummary
    ? `${CE.thinking} ${esc(trunc(parsed.descriptionSummary, 200))}`
    : null;
  const positives = (parsed?.positives ?? []).slice(0, 2);
  const positivesLine = positives.length > 0 ? `${CE.pros} ${positives.map((p) => esc(p)).join(', ')}` : null;
  const redFlags = (parsed?.redFlags ?? []).slice(0, 2);
  const redFlagsLine = redFlags.length > 0 ? `${CE.cons} ${redFlags.map((f) => esc(f)).join(', ')}` : null;

  // Assemble with progressively dropped non-essential content so a rich card still
  // fits the photo-caption budget. Essentials (price/title/url/kaucja/apt/location/contact)
  // are never dropped. Drop order: summary → positives → restriction note → red flags.
  const assemble = (drop: { summary?: boolean; positives?: boolean; restriction?: boolean; redFlags?: boolean }): string => {
    const parts: string[] = [priceLine, titleLine, urlLine];
    if (!drop.summary && summaryLine) parts.push(summaryLine);
    parts.push(payLineStr);
    parts.push(aptLine(!drop.restriction));
    parts.push(locationLine);
    if (!drop.positives && positivesLine) parts.push(positivesLine);
    if (!drop.redFlags && redFlagsLine) parts.push(redFlagsLine);
    if (contactLine) parts.push(contactLine);
    return parts.join('\n');
  };

  // Budget kept below CAPTION_LIMIT to leave room for the interactive path's "[ID] " prefix.
  const BUDGET = CAPTION_LIMIT - 24;
  const stages: Array<{ summary?: boolean; positives?: boolean; restriction?: boolean; redFlags?: boolean }> = [
    {},
    { summary: true },
    { summary: true, positives: true },
    { summary: true, positives: true, restriction: true },
    { summary: true, positives: true, restriction: true, redFlags: true },
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
): Promise<void> {
  const urls = photoUrls.slice(0, 10);
  if (urls.length === 0) return;

  if (urls.length === 1) {
    await bot.sendPhoto(chatId, urls[0], { caption, parse_mode: caption ? 'HTML' : undefined });
    return;
  }

  const media = urls.map((url, i) => ({
    type: 'photo' as const,
    media: url,
    ...(i === 0 && caption ? { caption, parse_mode: 'HTML' as const } : {}),
  }));

  await bot.sendMediaGroup(chatId, media);
}
