// Rich notification formatters for Telegram
// Plain text with emoji — no Markdown parsing issues

import type TelegramBot from 'node-telegram-bot-api';
import type { Listing, ParsedRentalData, ParsedItemData, LocationScore } from '../types.js';
import type { ItemListing } from '../crawlers/olx-items.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pln(amount: number | null | undefined): string {
  if (amount == null) return '—';
  return amount.toLocaleString('pl-PL') + ' PLN';
}

function yn(val: boolean | null | undefined): string {
  if (val === true) return '✓';
  if (val === false) return '✗';
  return '?';
}

function listItems(items: string[] | undefined, prefix = '• '): string {
  if (!items || items.length === 0) return '';
  return items.map(i => `${prefix}${i}`).join('\n');
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
  lines.push(`🏠 ${listing.title}`);
  lines.push(listing.url);
  lines.push('');

  // AI Summary (the most valuable part)
  if (parsed?.descriptionSummary) {
    lines.push(`📝 ${parsed.descriptionSummary}`);
    lines.push('');
  }

  // ---- COSTS (CRITICAL) ----
  lines.push('━━━ 💰 COSTS ━━━');
  lines.push(`Rent:        ${pln(listing.price)}`);
  if (parsed?.adminFee != null) {
    lines.push(`Czynsz admin: ${pln(parsed.adminFee)}`);
  } else if (listing.rent != null) {
    lines.push(`Czynsz admin: ${pln(listing.rent)}`);
  }
  if (parsed?.totalBreakdown) {
    lines.push(`${parsed.totalBreakdown}`);
  }
  if (parsed?.totalMonthlyCost != null) {
    lines.push(`━━━━━━━━━━━━━━━━`);
    lines.push(`TOTAL/month: ~${pln(parsed.totalMonthlyCost)}`);
  }

  // Kaucja
  if (parsed?.depositNote) {
    lines.push(`Kaucja: ${parsed.depositNote}`);
  } else if (parsed?.deposit != null) {
    lines.push(`Kaucja: ${pln(parsed.deposit)}`);
  } else if (listing.deposit != null) {
    lines.push(`Kaucja: ${pln(listing.deposit)}`);
  } else {
    lines.push(`Kaucja: ⚠️ not specified — ask landlord`);
  }

  // What's included / tenant pays
  if (parsed?.adminFeeIncludes) {
    lines.push(`Included in czynsz: ${parsed.adminFeeIncludes}`);
  }
  if (parsed?.tenantPays) {
    lines.push(`Tenant pays extra: ${parsed.tenantPays}`);
  }
  lines.push('');

  // ---- CONTRACT (CRITICAL) ----
  lines.push('━━━ 📋 CONTRACT ━━━');
  if (parsed?.contractType) {
    const contractDisplay = parsed.contractType.replace(/_/g, ' ');
    lines.push(`Type: ${contractDisplay}`);
  } else {
    lines.push(`Type: ⚠️ not specified`);
  }
  if (parsed?.contractNote) {
    lines.push(parsed.contractNote);
  }
  if (parsed?.availableFrom) lines.push(`Available: ${parsed.availableFrom}`);
  if (parsed?.minimumLease) lines.push(`Min lease: ${parsed.minimumLease}`);

  const restrictions: string[] = [];
  restrictions.push(`Pets: ${yn(parsed?.petFriendly)}`);
  restrictions.push(`Smoking: ${yn(parsed?.smokingAllowed)}`);
  if (parsed?.furnished) restrictions.push(`Furnished: ${parsed.furnished}`);
  if (parsed?.parkingIncluded != null) restrictions.push(`Parking: ${yn(parsed.parkingIncluded)}`);
  if (parsed?.balcony != null) restrictions.push(`Balcony: ${yn(parsed.balcony)}`);
  lines.push(restrictions.join(' | '));

  if (parsed?.restrictions && parsed.restrictions.length > 0) {
    lines.push(`⚠️ ${parsed.restrictions.join(', ')}`);
  }
  lines.push('');

  // ---- APARTMENT ----
  lines.push('━━━ 🏠 APARTMENT ━━━');
  const details: string[] = [];
  if (listing.rooms != null) details.push(`${listing.rooms} rooms`);
  if (listing.area != null) details.push(`${listing.area} m²`);
  if (listing.floor != null) details.push(`floor ${listing.floor}`);
  if (listing.buildingType) details.push(listing.buildingType);
  if (listing.heating) details.push(listing.heating);
  if (details.length > 0) lines.push(details.join(' | '));

  if (parsed?.kitchenDetails) lines.push(`🍳 Kitchen: ${parsed.kitchenDetails}`);
  if (parsed?.bathroomDetails) lines.push(`🚿 Bathroom: ${parsed.bathroomDetails}`);
  if (parsed?.internetReady) lines.push(`🌐 Internet: ${parsed.internetReady}`);

  if (parsed?.furnitureAndEquipment && parsed.furnitureAndEquipment.length > 0) {
    lines.push(`🪑 Equipment: ${parsed.furnitureAndEquipment.join(', ')}`);
  }
  lines.push('');

  // ---- LOCATION ----
  if (locationScore) {
    lines.push(`━━━ 📍 LOCATION (${locationScore.overallScore}/100) ━━━`);
    const icons: Record<string, string> = {
      metro: '🚇', tram: '🚋', gym: '🏋️', pool: '🏊', supermarket: '🛒', park: '🌳', pharmacy: '💊',
    };
    for (const a of locationScore.amenities) {
      const icon = icons[a.type] ?? '📍';
      if (a.places.length > 0) {
        // Show all found places for this amenity type
        for (const p of a.places) {
          const check = p.walkingMinutes <= (a.withinLimit ? 999 : 0) ? '' : '';
          const isNearest = p === a.places[0];
          const mark = isNearest ? (a.withinLimit ? ' ✓' : ' ⚠️') : '';
          lines.push(`${icon} ${p.name} — ${p.walkingMinutes} min (${p.distance})${mark}`);
        }
      } else {
        lines.push(`${icon} ${a.type}: not found within 3 km`);
      }
    }
    if (locationScore.commute) {
      lines.push(`🏢 → ${locationScore.commute.duration} by ${locationScore.commute.mode} (${locationScore.commute.distance})`);
    }
    if (listing.district) lines.push(`📍 ${listing.district}, ${listing.city}`);
    lines.push(locationScore.mapsLink);
  } else if (listing.lat && listing.lng) {
    lines.push(`📍 ${listing.district ? listing.district + ', ' : ''}${listing.city}`);
    lines.push(`https://www.google.com/maps?q=${listing.lat},${listing.lng}`);
  } else {
    lines.push(`📍 ${listing.district ? listing.district + ', ' : ''}${listing.city}`);
  }
  lines.push('');

  // ---- AI ASSESSMENT ----
  if (parsed?.bestSuitedFor) {
    lines.push(`👤 Best for: ${parsed.bestSuitedFor}`);
  }
  if (parsed?.landlordNotes) {
    lines.push(`🗣 Landlord: ${parsed.landlordNotes}`);
  }
  if (parsed?.positives && parsed.positives.length > 0) {
    lines.push(`✅ ${parsed.positives.join(', ')}`);
  }
  if (parsed?.redFlags && parsed.redFlags.length > 0) {
    lines.push(`🚩 ${parsed.redFlags.join(', ')}`);
  }

  // Contact
  lines.push('');
  const contactParts: string[] = [];
  if (listing.phone) contactParts.push(`📞 ${listing.phone}`);
  if (listing.contactName) contactParts.push(listing.contactName);
  if (listing.advertiserType) contactParts.push(listing.advertiserType);
  if (listing.agencyName) contactParts.push(listing.agencyName);
  if (contactParts.length > 0) lines.push(contactParts.join(' | '));
  lines.push(`📸 ${listing.photos.length} photos`);

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

  lines.push(`🛍 ${item.title}`);
  lines.push(item.url);
  lines.push('');

  // AI summary
  if (parsed?.descriptionSummary) {
    lines.push(`📝 ${parsed.descriptionSummary}`);
    lines.push('');
  }

  // Price
  lines.push(`💰 ${pln(item.price)}${item.negotiable ? ' (negotiable)' : ''}`);
  if (item.condition) lines.push(`📦 Condition: ${item.condition}`);
  if (parsed?.actualCondition) lines.push(`🔍 AI assessment: ${parsed.actualCondition}`);
  if (parsed?.priceAssessment) lines.push(`💡 ${parsed.priceAssessment}`);
  lines.push('');

  // Details
  if (parsed?.defects && parsed.defects.length > 0) {
    lines.push(`⚠️ Defects: ${parsed.defects.join(', ')}`);
  }
  if (parsed?.includedAccessories && parsed.includedAccessories.length > 0) {
    lines.push(`📦 Includes: ${parsed.includedAccessories.join(', ')}`);
  }
  if (parsed?.whySelling) {
    lines.push(`💬 Why selling: ${parsed.whySelling}`);
  }
  if (parsed?.bestFor) {
    lines.push(`👤 Best for: ${parsed.bestFor}`);
  }
  if (parsed?.redFlags && parsed.redFlags.length > 0) {
    lines.push(`🚩 ${parsed.redFlags.join(', ')}`);
  }

  // Params
  const skipKeys = new Set(['price', 'state']);
  const paramEntries = Object.entries(item.params).filter(([k]) => !skipKeys.has(k));
  if (paramEntries.length > 0) {
    lines.push(`⚙️ ${paramEntries.slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  }

  // Location + contact
  lines.push('');
  if (item.city) lines.push(`📍 ${item.district ? item.district + ', ' : ''}${item.city}`);
  if (item.phone) lines.push(`📞 ${item.phone}`);
  if (item.contactName) lines.push(`👤 ${item.contactName}${item.isBusiness ? ' (business)' : ''}`);
  lines.push(`📸 ${item.photos.length} photos`);

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
