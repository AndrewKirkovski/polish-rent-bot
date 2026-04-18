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
// Rental card — comprehensive
// ---------------------------------------------------------------------------

export function formatRentalCard(
  listing: Listing,
  parsed: ParsedRentalData | null | undefined,
  locationScore: LocationScore | null | undefined,
): string {
  const lines: string[] = [];

  // Header
  lines.push(`<b>\uD83C\uDFE0 ${esc(listing.title)}</b>`);
  lines.push(listing.url);
  lines.push('');

  // AI Summary (the most valuable part)
  if (parsed?.descriptionSummary) {
    lines.push(`\uD83D\uDCDD ${esc(parsed.descriptionSummary)}`);
    lines.push('');
  }

  // ---- COSTS (CRITICAL) ----
  lines.push('<b>\uD83D\uDCB0 COSTS</b>');
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
    lines.push(`Kaucja: \u26A0\uFE0F not specified \u2014 ask landlord`);
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
  lines.push('<b>\uD83D\uDCCB CONTRACT</b>');
  if (parsed?.contractType) {
    const contractDisplay = parsed.contractType.replace(/_/g, ' ');
    lines.push(`Type: ${contractDisplay}`);
  } else {
    lines.push(`Type: \u26A0\uFE0F not specified`);
  }
  if (parsed?.contractNote) {
    lines.push(esc(parsed.contractNote));
  }
  if (parsed?.availableFrom) lines.push(`Available: ${esc(parsed.availableFrom)}`);
  if (parsed?.minimumLease) lines.push(`Min lease: ${esc(parsed.minimumLease)}`);

  const restrictions: string[] = [];
  restrictions.push(`Pets: ${yn(parsed?.petFriendly)}`);
  restrictions.push(`Smoking: ${yn(parsed?.smokingAllowed)}`);
  if (parsed?.furnished) restrictions.push(`Furnished: ${parsed.furnished}`);
  if (parsed?.parkingIncluded != null) restrictions.push(`Parking: ${yn(parsed.parkingIncluded)}`);
  if (parsed?.balcony != null) restrictions.push(`Balcony: ${yn(parsed.balcony)}`);
  lines.push(restrictions.join(' | '));

  const restrictionsList = parsed?.restrictions ?? [];
  if (restrictionsList.length > 0) {
    lines.push(`\u26A0\uFE0F ${restrictionsList.map(r => esc(r)).join(', ')}`);
  }
  lines.push('');

  // ---- APARTMENT ----
  lines.push('<b>\uD83C\uDFE0 APARTMENT</b>');
  const details: string[] = [];
  if (listing.rooms != null) details.push(`${listing.rooms} rooms`);
  if (listing.area != null) details.push(`${listing.area} m\u00B2`);
  if (listing.floor != null) details.push(`floor ${listing.floor}`);
  if (listing.buildingType) details.push(esc(listing.buildingType));
  if (listing.heating) details.push(esc(listing.heating));
  if (details.length > 0) lines.push(details.join(' | '));

  if (parsed?.kitchenDetails) lines.push(`\uD83C\uDF73 Kitchen: ${esc(parsed.kitchenDetails)}`);
  if (parsed?.bathroomDetails) lines.push(`\uD83D\uDEBF Bathroom: ${esc(parsed.bathroomDetails)}`);
  if (parsed?.internetReady) lines.push(`\uD83C\uDF10 Internet: ${esc(parsed.internetReady)}`);

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
    lines.push(`\uD83D\uDC64 Best for: ${esc(parsed.bestSuitedFor)}`);
  }
  if (parsed?.landlordNotes) {
    lines.push(`\uD83D\uDDE3 Landlord: ${esc(parsed.landlordNotes)}`);
  }
  const positives = parsed?.positives ?? [];
  if (positives.length > 0) {
    lines.push(`\u2705 ${positives.map(p => esc(p)).join(', ')}`);
  }
  const redFlags = parsed?.redFlags ?? [];
  if (redFlags.length > 0) {
    lines.push(`\uD83D\uDEA9 ${redFlags.map(f => esc(f)).join(', ')}`);
  }
  const additionalNotes = parsed?.additionalNotes ?? [];
  if (additionalNotes.length > 0) {
    lines.push(`\uD83D\uDCCC ${additionalNotes.map(n => esc(n)).join(', ')}`);
  }

  // Contact
  lines.push('');
  const contactParts: string[] = [];
  if (listing.phone) contactParts.push(`\uD83D\uDCDE ${listing.phone}`);
  if (listing.contactName) contactParts.push(esc(listing.contactName));
  if (listing.advertiserType) contactParts.push(listing.advertiserType);
  if (listing.agencyName) contactParts.push(esc(listing.agencyName));
  if (contactParts.length > 0) lines.push(contactParts.join(' | '));
  lines.push(`\uD83D\uDCF8 ${listing.photos.length} photos`);

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

  lines.push(`<b>\uD83D\uDECD ${esc(item.title)}</b>`);
  lines.push(item.url);
  lines.push('');

  // AI summary
  if (parsed?.descriptionSummary) {
    lines.push(`\uD83D\uDCDD ${esc(parsed.descriptionSummary)}`);
    lines.push('');
  }

  // Price
  lines.push(`\uD83D\uDCB0 ${pln(item.price)}${item.negotiable ? ' (negotiable)' : ''}`);
  if (item.condition) lines.push(`\uD83D\uDCE6 Condition: ${esc(item.condition)}`);
  if (parsed?.actualCondition) lines.push(`\uD83D\uDD0D AI assessment: ${esc(parsed.actualCondition)}`);
  if (parsed?.priceAssessment) lines.push(`\uD83D\uDCA1 ${esc(parsed.priceAssessment)}`);
  lines.push('');

  // Details
  const defects = parsed?.defects ?? [];
  if (defects.length > 0) {
    lines.push(`\u26A0\uFE0F Defects: ${defects.map(d => esc(d)).join(', ')}`);
  }
  const accessories = parsed?.includedAccessories ?? [];
  if (accessories.length > 0) {
    lines.push(`\uD83D\uDCE6 Includes: ${accessories.map(a => esc(a)).join(', ')}`);
  }
  if (parsed?.whySelling) {
    lines.push(`\uD83D\uDCAC Why selling: ${esc(parsed.whySelling)}`);
  }
  if (parsed?.bestFor) {
    lines.push(`\uD83D\uDC64 Best for: ${esc(parsed.bestFor)}`);
  }
  const itemRedFlags = parsed?.redFlags ?? [];
  if (itemRedFlags.length > 0) {
    lines.push(`\uD83D\uDEA9 ${itemRedFlags.map(f => esc(f)).join(', ')}`);
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
  if (item.phone) lines.push(`\uD83D\uDCDE ${item.phone}`);
  if (item.contactName) lines.push(`\uD83D\uDC64 ${esc(item.contactName)}${item.isBusiness ? ' (business)' : ''}`);
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
): Promise<void> {
  const urls = photoUrls.slice(0, 10);
  if (urls.length === 0) return;

  if (urls.length === 1) {
    await bot.sendPhoto(chatId, urls[0]);
    return;
  }

  const media = urls.map((url) => ({
    type: 'photo' as const,
    media: url,
  }));

  await bot.sendMediaGroup(chatId, media);
}
