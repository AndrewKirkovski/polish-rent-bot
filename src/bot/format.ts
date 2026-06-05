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

function yn(val: boolean | null | undefined): string {
  if (val === true) return '\u2713';
  if (val === false) return '\u2717';
  return '?';
}

function listItems(items: string[] | undefined, prefix = '\u2022 '): string {
  if (!items || items.length === 0) return '';
  return items.map(i => `${prefix}${esc(i)}`).join('\n');
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
  const lines: string[] = [];

  // ---- ИТОГО — всегда первой строкой (считаем в коде, не доверяем арифметике LLM) ----
  const cost = computeRentalCost(listing, parsed);
  const num = (n: number) => n.toLocaleString('pl-PL');
  const zl = (n: number) => `${num(n)} zł`;
  lines.push(`<b>${CE.price} ИТОГО: ~${zl(cost.total)}/мес</b>`);

  // Заголовок
  lines.push(`${CE.house} ${esc(listing.title)}`);
  lines.push(listing.url);
  lines.push('');

  // Краткое AI-резюме
  if (parsed?.descriptionSummary) {
    lines.push(`${CE.thinking} ${esc(parsed.descriptionSummary)}`);
    lines.push('');
  }

  // Стоимость — одной строкой
  const costParts = [`Аренда ${num(cost.najem)}`];
  if (cost.czynsz > 0) costParts.push(`czynsz ${num(cost.czynsz)}`);
  if (cost.mediaSum > 0) costParts.push(`~${num(cost.mediaSum)} коммун.`);
  const costStr = costParts.length > 1 ? `${costParts.join(' + ')} = ${zl(cost.total)}` : zl(cost.najem);
  lines.push(`${CE.costBreak} ${costStr}`);

  // Kaucja + тип договора — одной строкой
  const payLine: string[] = [];
  if (parsed?.depositNote) payLine.push(`Kaucja: ${esc(parsed.depositNote)}`);
  else if (parsed?.deposit != null) payLine.push(`Kaucja: ${zl(parsed.deposit)}`);
  else if (listing.deposit != null) payLine.push(`Kaucja: ${zl(listing.deposit)}`);
  else payLine.push(`Kaucja: ${CE.warning} не указана`);
  if (parsed?.contractType) payLine.push(`Договор: ${esc(parsed.contractType.replace(/_/g, ' '))}`);
  lines.push(payLine.join(' · '));
  lines.push('');

  // Квартира — одной строкой
  const apt: string[] = [];
  if (listing.rooms != null) apt.push(`${listing.rooms} комн`);
  if (listing.area != null) apt.push(`${listing.area} m²`);
  if (listing.floor != null) apt.push(`${listing.floor} эт`);
  if (parsed?.furnished) apt.push(`мебель: ${parsed.furnished}`);
  apt.push(`питомцы ${ceYn(parsed?.petFriendly)}`);
  apt.push(`курение ${ceYn(parsed?.smokingAllowed)}`);
  if (parsed?.parkingIncluded != null) apt.push(`парковка ${ceYn(parsed.parkingIncluded)}`);
  if (parsed?.balcony != null) apt.push(`балкон ${ceYn(parsed.balcony)}`);
  if (apt.length > 0) lines.push(`${CE.house} ${apt.join(' · ')}`);
  const restrictionsList = parsed?.restrictions ?? [];
  if (restrictionsList.length > 0) {
    lines.push(`${CE.warning} ${restrictionsList.slice(0, 3).map(r => esc(r)).join(', ')}`);
  }
  lines.push('');

  // Локация — одна строка на удобство (ближайшее место)
  if (locationScore) {
    const where = listing.district ? `${esc(listing.district)}, ${esc(listing.city)}` : esc(listing.city);
    const prec = locationScore.precision;
    const precBadge = prec === 'exact' ? ' · 📍 точно' : prec === 'street' ? ' · 📍 по улице' : prec === 'district' ? ' · 📍 примерно' : '';
    lines.push(`<b>${CE.location} ЛОКАЦИЯ ${locationScore.overallScore}/100</b> — ${where}${precBadge}`);
    const ruLabel: Record<string, string> = {
      metro: 'метро', tram: 'трамвай', bus: 'автобус', airport: 'аэропорт',
      groceries: 'продукты', supermarket: 'супермаркет', gym: 'зал',
      pool: 'бассейн', pharmacy: 'аптека', park: 'парк',
    };
    const icons: Record<string, string> = {
      metro: '🚇', tram: '🚋', bus: '🚌',
      airport: '✈️', groceries: '🛒',
      gym: CE.gym, pool: CE.pool, pharmacy: CE.pharmacy,
      supermarket: '🛒', park: '🌳',
    };
    for (const a of locationScore.amenities) {
      const icon = icons[a.type] ?? CE.location;
      const label = ruLabel[a.type] ?? esc(a.type);
      const mark = a.withinLimit ? CE.yes : CE.warning;
      if (a.places.length > 0) {
        const p = a.places[0];
        const parts: string[] = [esc(p.name)];
        if (p.walkingMinutes >= 0) parts.push(`${p.walkingMinutes} мин`);
        if (p.frequencyMinutes) {
          parts.push(`${p.lineName ? esc(p.lineName) + ' ' : ''}~${p.frequencyMinutes} мин`);
        } else if (p.transitMinutes) {
          parts.push(`${p.transitMinutes} мин транзит`);
        }
        lines.push(`${icon} ${label} ${mark} ${parts.join(' — ')}`);
      } else {
        lines.push(`${icon} ${label} ${CE.warning} рядом нет`);
      }
    }
    if (locationScore.commute) {
      lines.push(`→ ${esc(locationScore.commute.duration)} до работы`);
    }
    lines.push(locationScore.mapsLink);
  } else {
    lines.push(`${CE.location} ${listing.district ? esc(listing.district) + ', ' : ''}${esc(listing.city)}`);
    if (listing.lat && listing.lng) lines.push(`https://www.google.com/maps?q=${listing.lat},${listing.lng}`);
  }
  lines.push('');

  // Плюсы / минусы (кратко, до 3)
  const positives = (parsed?.positives ?? []).slice(0, 3);
  if (positives.length > 0) {
    lines.push(`${CE.pros} ${positives.map(p => esc(p)).join(', ')}`);
  }
  const redFlags = (parsed?.redFlags ?? []).slice(0, 3);
  if (redFlags.length > 0) {
    lines.push(`${CE.cons} ${redFlags.map(f => esc(f)).join(', ')}`);
  }

  // Контакт
  const contactParts: string[] = [];
  if (listing.phone) contactParts.push(`${CE.phone} ${esc(listing.phone)}`);
  if (listing.advertiserType) contactParts.push(esc(listing.advertiserType));
  if (listing.agencyName) contactParts.push(esc(listing.agencyName));
  if (contactParts.length > 0) lines.push(contactParts.join(' · '));

  return lines.join('\n');
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

  // PRICE + CONDITION first (most important info)
  lines.push(`<b>${CE.price} ${pln(item.price)}${item.negotiable ? ' (negotiable)' : ''}</b>`);
  if (item.condition) lines.push(`<b>${esc(item.condition)}</b>`);
  lines.push('');

  // Title + link
  lines.push(`${esc(item.title)}`);
  lines.push(item.url);
  lines.push('');

  // AI assessment
  if (parsed?.actualCondition) lines.push(`${CE.thinking} ${esc(parsed.actualCondition)}`);
  if (parsed?.priceAssessment) lines.push(`${CE.fire} ${esc(parsed.priceAssessment)}`);
  if (parsed?.descriptionSummary) lines.push(`${esc(parsed.descriptionSummary)}`);
  lines.push('');

  // Details
  const defects = parsed?.defects ?? [];
  if (defects.length > 0) {
    lines.push(`${CE.warning} Defects: ${defects.map(d => esc(d)).join(', ')}`);
  }
  const accessories = parsed?.includedAccessories ?? [];
  if (accessories.length > 0) {
    lines.push(`${CE.yes} Includes: ${accessories.map(a => esc(a)).join(', ')}`);
  }
  if (parsed?.whySelling) {
    lines.push(`${CE.doubt} Why selling: ${esc(parsed.whySelling)}`);
  }
  if (parsed?.bestFor) {
    lines.push(`${CE.person} Best for: ${esc(parsed.bestFor)}`);
  }
  const itemRedFlags = parsed?.redFlags ?? [];
  if (itemRedFlags.length > 0) {
    lines.push(`${CE.cons} ${itemRedFlags.map(f => esc(f)).join(', ')}`);
  }

  // Params
  const skipKeys = new Set(['price', 'state']);
  const paramEntries = Object.entries(item.params).filter(([k]) => !skipKeys.has(k));
  if (paramEntries.length > 0) {
    lines.push(`\u2699\uFE0F ${paramEntries.slice(0, 5).map(([k, v]) => `${k}: ${esc(v)}`).join(', ')}`);
  }

  // Location + shipping + contact
  lines.push('');
  const locationParts: string[] = [];
  if (item.city) locationParts.push(`${CE.location} ${item.district ? esc(item.district) + ', ' : ''}${esc(item.city)}`);
  locationParts.push(item.shipping ? `\uD83D\uDCE6 Shipping available` : `\uD83D\uDCCD Local pickup only`);
  lines.push(locationParts.join(' | '));
  if (item.phone) lines.push(`${CE.phone} ${esc(item.phone)}`);
  if (item.contactName) lines.push(`${CE.person} ${esc(item.contactName)}${item.isBusiness ? ' (business)' : ''}`);

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
