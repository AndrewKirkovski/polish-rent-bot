// Rich notification formatters for Telegram
// Uses HTML parse_mode — sanitize user/AI text with esc()

import type TelegramBot from 'node-telegram-bot-api';
import type { Listing, ParsedRentalData, ParsedItemData, LocationScore } from '../types.js';
import type { ItemListing } from '../crawlers/olx-items.js';

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

/** Telegram message limit is 4096; truncate with a marker so we never exceed it */
function truncate(text: string, limit = 4000): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '\n\u2026 <i>(truncated)</i>';
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

  // Header
  lines.push(`<b>${CE.house} ${esc(listing.title)}</b>`);
  lines.push(listing.url);
  lines.push('');

  // AI Summary
  if (parsed?.descriptionSummary) {
    lines.push(`${CE.thinking} ${esc(parsed.descriptionSummary)}`);
    lines.push('');
  }

  // ---- COSTS (CRITICAL) ----
  lines.push(`<b>${CE.price} COSTS</b>`);
  lines.push(`Rent:        ${pln(listing.price)}`);
  if (parsed?.adminFee != null) {
    lines.push(`Czynsz admin: ${pln(parsed.adminFee)}`);
  } else if (listing.rent != null) {
    lines.push(`Czynsz admin: ${pln(listing.rent)}`);
  }
  if (parsed?.totalBreakdown) {
    lines.push(`${esc(parsed.totalBreakdown)}`);
  }
  if (parsed?.totalMonthlyCost != null) {
    lines.push(`\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
    lines.push(`TOTAL/month: ~${pln(parsed.totalMonthlyCost)}`);
  }

  // Kaucja
  if (parsed?.depositNote) {
    lines.push(`Kaucja: ${esc(parsed.depositNote)}`);
  } else if (parsed?.deposit != null) {
    lines.push(`Kaucja: ${pln(parsed.deposit)}`);
  } else if (listing.deposit != null) {
    lines.push(`Kaucja: ${pln(listing.deposit)}`);
  } else {
    lines.push(`Kaucja: ${CE.warning} not specified \u2014 ask landlord`);
  }

  // What's included / tenant pays
  if (parsed?.adminFeeIncludes) {
    lines.push(`Included in czynsz: ${esc(parsed.adminFeeIncludes)}`);
  }
  if (parsed?.tenantPays) {
    lines.push(`Tenant pays extra: ${esc(parsed.tenantPays)}`);
  }
  lines.push('');

  // ---- CONTRACT (CRITICAL) ----
  lines.push(`<b>${CE.contract} CONTRACT</b>`);
  if (parsed?.contractType) {
    const contractDisplay = parsed.contractType.replace(/_/g, ' ');
    lines.push(`Type: ${contractDisplay}`);
  }
  if (parsed?.contractNote) {
    lines.push(esc(parsed.contractNote));
  }
  if (parsed?.availableFrom) lines.push(`Available: ${esc(parsed.availableFrom)}`);
  if (parsed?.minimumLease) lines.push(`Min lease: ${esc(parsed.minimumLease)}`);

  const restrictions: string[] = [];
  restrictions.push(`${CE.pets} Pets: ${ceYn(parsed?.petFriendly)}`);
  restrictions.push(`Smoking: ${ceYn(parsed?.smokingAllowed)}`);
  if (parsed?.furnished) restrictions.push(`Furnished: ${parsed.furnished}`);
  if (parsed?.parkingIncluded != null) restrictions.push(`Parking: ${ceYn(parsed.parkingIncluded)}`);
  if (parsed?.balcony != null) restrictions.push(`Balcony: ${ceYn(parsed.balcony)}`);
  lines.push(restrictions.join(' | '));

  const restrictionsList = parsed?.restrictions ?? [];
  if (restrictionsList.length > 0) {
    lines.push(`${CE.warning} ${restrictionsList.map(r => esc(r)).join(', ')}`);
  }
  lines.push('');

  // ---- APARTMENT ----
  lines.push(`<b>${CE.house} APARTMENT</b>`);
  const details: string[] = [];
  if (listing.rooms != null) details.push(`${listing.rooms} rooms`);
  if (listing.area != null) details.push(`${listing.area} m\u00B2`);
  if (listing.floor != null) details.push(`floor ${listing.floor}`);
  if (listing.buildingType) details.push(esc(listing.buildingType));
  if (listing.heating) details.push(esc(listing.heating));
  if (details.length > 0) lines.push(details.join(' | '));

  if (parsed?.kitchenDetails) lines.push(`${CE.kitchen} Kitchen: ${esc(parsed.kitchenDetails)}`);
  if (parsed?.bathroomDetails) lines.push(`${CE.bathroom} Bathroom: ${esc(parsed.bathroomDetails)}`);
  if (parsed?.internetReady) lines.push(`${CE.ac} Internet: ${esc(parsed.internetReady)}`);

  const furnitureList = parsed?.furnitureAndEquipment ?? [];
  if (furnitureList.length > 0) {
    lines.push(`\uD83E\uDE91 Equipment: ${furnitureList.map(f => esc(f)).join(', ')}`);
  }
  lines.push('');

  // ---- LOCATION ----
  if (locationScore) {
    lines.push(`<b>\uD83D\uDCCD LOCATION (${locationScore.overallScore}/100)</b>`);
    const icons: Record<string, string> = {
      metro: '\uD83D\uDE87', tram: '\uD83D\uDE8B', gym: '\uD83C\uDFCB\uFE0F', pool: '\uD83C\uDFCA', supermarket: '\uD83D\uDED2', park: '\uD83C\uDF33', pharmacy: '\uD83D\uDC8A',
    };
    for (const a of locationScore.amenities) {
      const icon = icons[a.type] ?? '\uD83D\uDCCD';
      if (a.places.length > 0) {
        // Show all found places for this amenity type
        for (const p of a.places) {
          const isNearest = p === a.places[0];
          const mark = isNearest ? (a.withinLimit ? ' \u2713' : ' \u26A0\uFE0F') : '';
          lines.push(`${icon} ${esc(p.name)} \u2014 ${p.walkingMinutes} min (${p.distance})${mark}`);
        }
      } else {
        lines.push(`${icon} ${a.type}: not found within 3 km`);
      }
    }
    if (locationScore.commute) {
      lines.push(`\uD83C\uDFE2 \u2192 ${locationScore.commute.duration} by ${locationScore.commute.mode} (${locationScore.commute.distance})`);
    }
    if (listing.district) lines.push(`\uD83D\uDCCD ${esc(listing.district)}, ${esc(listing.city)}`);
    lines.push(locationScore.mapsLink);
  } else if (listing.lat && listing.lng) {
    lines.push(`\uD83D\uDCCD ${listing.district ? esc(listing.district) + ', ' : ''}${esc(listing.city)}`);
    lines.push(`https://www.google.com/maps?q=${listing.lat},${listing.lng}`);
  } else {
    lines.push(`\uD83D\uDCCD ${listing.district ? esc(listing.district) + ', ' : ''}${esc(listing.city)}`);
  }
  lines.push('');

  // ---- AI ASSESSMENT ----
  if (parsed?.bestSuitedFor) {
    lines.push(`${CE.person} Best for: ${esc(parsed.bestSuitedFor)}`);
  }
  if (parsed?.landlordNotes) {
    lines.push(`${CE.landlord} Landlord: ${esc(parsed.landlordNotes)}`);
  }
  const positives = parsed?.positives ?? [];
  if (positives.length > 0) {
    lines.push(`${CE.pros} ${positives.map(p => esc(p)).join(', ')}`);
  }
  const redFlags = parsed?.redFlags ?? [];
  if (redFlags.length > 0) {
    lines.push(`${CE.cons} ${redFlags.map(f => esc(f)).join(', ')}`);
  }
  const additionalNotes = parsed?.additionalNotes ?? [];
  if (additionalNotes.length > 0) {
    lines.push(additionalNotes.map(n => esc(n)).join(', '));
  }

  // Contact
  lines.push('');
  const contactParts: string[] = [];
  if (listing.phone) contactParts.push(`${CE.phone} ${listing.phone}`);
  if (listing.contactName) contactParts.push(`${CE.person} ${esc(listing.contactName)}`);
  if (listing.advertiserType) contactParts.push(listing.advertiserType);
  if (listing.agencyName) contactParts.push(esc(listing.agencyName));
  if (contactParts.length > 0) lines.push(contactParts.join(' | '));

  return truncate(lines.join('\n'));
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

  // Location + contact
  lines.push('');
  if (item.city) lines.push(`\uD83D\uDCCD ${item.district ? esc(item.district) + ', ' : ''}${esc(item.city)}`);
  if (item.phone) lines.push(`${CE.phone} ${item.phone}`);
  if (item.contactName) lines.push(`${CE.person} ${esc(item.contactName)}${item.isBusiness ? ' (business)' : ''}`);
  lines.push(`\uD83D\uDCF8 ${item.photos.length} photos`);

  return truncate(lines.join('\n'));
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
