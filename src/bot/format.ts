// Rich notification formatters for Telegram — plain text with Unicode box-drawing and emoji
// Formats rental and item listings with parsed AI data and location scores

import type TelegramBot from 'node-telegram-bot-api';
import type { Listing, ParsedRentalData, ParsedItemData, LocationScore } from '../types.js';
import type { ItemListing } from '../crawlers/olx-items.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPLN(amount: number | null | undefined): string {
  if (amount == null) return '—';
  return amount.toLocaleString('pl-PL') + ' PLN';
}

function kaucjaMultiple(deposit: number | null | undefined, rent: number | null | undefined): string {
  if (deposit == null || rent == null || rent === 0) return '';
  const ratio = deposit / rent;
  const rounded = Math.round(ratio * 10) / 10;
  if (rounded === Math.round(rounded)) {
    return ` (${Math.round(rounded)}\u00D7 czynsz)`;
  }
  return ` (${rounded}\u00D7 czynsz)`;
}

function contractLabel(type: string | null): string {
  if (!type) return '—';
  const labels: Record<string, string> = {
    najem_okazjonalny: 'najem okazjonalny',
    najem_zwykly: 'najem zwyk\u0142y',
    najem_instytucjonalny: 'najem instytucjonalny',
  };
  return labels[type] ?? type.replace(/_/g, ' ');
}

function boolIcon(val: boolean | null | undefined): string {
  if (val === true) return '\u2713';
  if (val === false) return 'brak';
  return '—';
}

function furnishedLabel(val: 'full' | 'partial' | 'none' | null | undefined): string {
  if (val === 'full') return 'tak';
  if (val === 'partial') return 'cz\u0119\u015Bciowo';
  if (val === 'none') return 'nie';
  return '—';
}

// ---------------------------------------------------------------------------
// formatRentalCard
// ---------------------------------------------------------------------------

export function formatRentalCard(
  listing: Listing,
  parsed: ParsedRentalData | null,
  locationScore: LocationScore | null,
): string {
  const lines: string[] = [];

  // Header
  lines.push(`\uD83C\uDFE0 ${listing.title}`);
  lines.push(`\uD83D\uDD17 ${listing.url}`);

  // --- Costs ---
  lines.push('');
  lines.push('\u2501\u2501\u2501 \uD83D\uDCB0 KOSZTY \u2501\u2501\u2501');

  const rentPrice = listing.price;
  lines.push(`Czynsz najmu:    ${formatPLN(rentPrice)}`);

  const adminFee = listing.rent ?? parsed?.adminFee ?? null;
  if (adminFee != null) {
    lines.push(`Czynsz admin:      ${formatPLN(adminFee)}`);
  }

  // Media estimate
  if (parsed) {
    const media = parsed.estimatedMedia;
    const mediaParts: string[] = [];
    if (media.water != null) mediaParts.push(`woda ${media.water}`);
    if (media.electricity != null) mediaParts.push(`pr\u0105d ${media.electricity}`);
    if (media.gas != null) mediaParts.push(`gaz ${media.gas}`);
    if (media.internet != null) mediaParts.push(`internet ${media.internet}`);
    if (media.heating != null) mediaParts.push(`ogrzewanie ${media.heating}`);

    if (mediaParts.length > 0) {
      // Sum up known media costs for the total line
      const mediaTotal = [media.water, media.electricity, media.gas, media.internet, media.heating]
        .filter((v): v is number => v != null)
        .reduce((sum, v) => sum + v, 0);
      lines.push(`Media (est.):     ~${formatPLN(mediaTotal)}`);
    }
  }

  lines.push('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');

  // Total
  if (parsed?.totalMonthlyCost != null) {
    lines.push(`RAZEM/mies.:   ~${formatPLN(parsed.totalMonthlyCost)}`);
  } else if (adminFee != null) {
    lines.push(`RAZEM/mies.:   ~${formatPLN(rentPrice + adminFee)}`);
  }

  // Deposit
  const deposit = parsed?.deposit ?? listing.deposit;
  if (deposit != null) {
    lines.push(`Kaucja:          ${formatPLN(deposit)}${kaucjaMultiple(deposit, rentPrice)}`);
  } else {
    lines.push('Kaucja:          nie podano \u2014 zapytaj wynajmuj\u0105cego');
  }

  // --- Contract ---
  if (parsed) {
    lines.push('');
    lines.push('\u2501\u2501\u2501 \uD83D\uDCCB UMOWA \u2501\u2501\u2501');

    const contractParts: string[] = [];
    contractParts.push(`Typ: ${contractLabel(parsed.contractType)}`);

    if (parsed.availableFrom) contractParts.push(`Od: ${parsed.availableFrom}`);
    if (parsed.minimumLease) contractParts.push(`Min: ${parsed.minimumLease}`);

    lines.push(contractParts.join(' | '));

    const flags: string[] = [];
    flags.push(`Zwierz\u0119ta: ${boolIcon(parsed.petFriendly)}`);
    flags.push(`Meble: ${furnishedLabel(parsed.furnished)}`);
    flags.push(`Parking: ${boolIcon(parsed.parkingIncluded)}`);
    lines.push(flags.join(' | '));
  }

  // --- Property details ---
  lines.push('');
  lines.push('\u2501\u2501\u2501 \uD83C\uDFE0 MIESZKANIE \u2501\u2501\u2501');

  const propParts: string[] = [];
  if (listing.rooms != null) propParts.push(`${listing.rooms} poko${listing.rooms === 1 ? 'j' : listing.rooms < 5 ? 'je' : 'i'}`);
  if (listing.area != null) propParts.push(`${listing.area} m\u00B2`);
  if (listing.floor != null) {
    const floorStr = listing.buildingFloor != null
      ? `pi\u0119tro ${listing.floor}/${listing.buildingFloor}`
      : `pi\u0119tro ${listing.floor}`;
    propParts.push(floorStr);
  }
  if (propParts.length > 0) {
    lines.push(propParts.join(' | '));
  }

  const buildingParts: string[] = [];
  if (listing.buildingType) buildingParts.push(listing.buildingType);
  if (listing.heating) buildingParts.push(`ogrzewanie ${listing.heating}`);
  if (parsed?.balcony === true) buildingParts.push('balkon');
  if (buildingParts.length > 0) {
    lines.push(buildingParts.join(' | '));
  }

  // --- Location ---
  if (locationScore) {
    lines.push('');
    lines.push(`\u2501\u2501\u2501 \uD83D\uDCCD LOKALIZACJA (${locationScore.overallScore}/100) \u2501\u2501\u2501`);

    const amenityEmoji: Record<string, string> = {
      metro: '\uD83D\uDE87',
      gym: '\uD83C\uDFCB\uFE0F',
      pool: '\uD83C\uDFCA',
      supermarket: '\uD83D\uDED2',
      park: '\uD83C\uDF33',
      pharmacy: '\uD83D\uDC8A',
    };

    for (const a of locationScore.amenities) {
      const emoji = amenityEmoji[a.type] ?? '\uD83D\uDCCD';
      if (a.nearest) {
        const check = a.withinLimit ? '\u2713' : '\u2717';
        lines.push(`${emoji} ${a.nearest.name} \u2014 ${a.nearest.walkingMinutes} min ${check}`);
      } else {
        lines.push(`${emoji} ${a.type}: nie znaleziono w pobli\u017Cu`);
      }
    }

    if (locationScore.commute) {
      const c = locationScore.commute;
      lines.push(`\uD83C\uDFE2 \u2192 ${c.duration} (${c.mode})`);
    }
  }

  // Location line
  const locParts: string[] = [];
  if (listing.district) locParts.push(listing.district);
  if (listing.city) locParts.push(listing.city);
  if (locParts.length > 0) {
    lines.push(`\uD83D\uDCCD ${locParts.join(', ')}`);
  }

  // --- Contact ---
  const contactParts: string[] = [];
  if (listing.contactName) contactParts.push(listing.contactName);
  if (listing.advertiserType) {
    const typeLabel = listing.advertiserType === 'private' ? 'Prywatny' :
      listing.advertiserType === 'agency' ? `Agencja${listing.agencyName ? ` (${listing.agencyName})` : ''}` :
        listing.advertiserType === 'developer' ? 'Deweloper' : listing.advertiserType;
    contactParts.push(typeLabel);
  }
  if (listing.phone) contactParts.push(listing.phone);

  if (contactParts.length > 0) {
    lines.push('');
    lines.push(`\uD83D\uDCDE ${contactParts.join(' | ')}`);
  }

  // Notes from parsed data
  if (parsed && parsed.additionalNotes.length > 0) {
    lines.push('');
    lines.push('\uD83D\uDCCC Uwagi:');
    for (const note of parsed.additionalNotes.slice(0, 5)) {
      lines.push(`  - ${note}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// formatItemCard
// ---------------------------------------------------------------------------

export function formatItemCard(
  item: ItemListing,
  parsed: ParsedItemData | null,
): string {
  const lines: string[] = [];

  // Header
  lines.push(`\uD83D\uDCE6 ${item.title}`);
  lines.push(`\uD83D\uDD17 ${item.url}`);

  // Price
  lines.push('');
  const priceStr = `${item.price} ${item.currency}`;
  lines.push(`\uD83D\uDCB0 ${priceStr}${item.negotiable ? ' (do negocjacji)' : ''}`);

  // Condition
  if (parsed) {
    lines.push(`\uD83D\uDCE6 Stan: ${parsed.actualCondition}`);
  } else if (item.condition) {
    lines.push(`\uD83D\uDCE6 Stan: ${item.condition}`);
  }

  // Why selling
  if (parsed?.whySelling) {
    lines.push(`\uD83D\uDCAC Pow\u00F3d sprzeda\u017Cy: ${parsed.whySelling}`);
  }

  // Defects
  if (parsed && parsed.defects.length > 0) {
    lines.push('');
    lines.push('\u26A0\uFE0F Wady:');
    for (const defect of parsed.defects) {
      lines.push(`  - ${defect}`);
    }
  }

  // Included accessories
  if (parsed && parsed.includedAccessories.length > 0) {
    lines.push('');
    lines.push('\uD83D\uDCE5 W zestawie:');
    for (const acc of parsed.includedAccessories) {
      lines.push(`  - ${acc}`);
    }
  }

  // Parameters
  const skipKeys = new Set(['price', 'state']);
  const paramEntries = Object.entries(item.params).filter(
    ([k]) => !skipKeys.has(k),
  );
  if (paramEntries.length > 0) {
    lines.push('');
    const paramStr = paramEntries
      .slice(0, 5)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    lines.push(`\u2699\uFE0F ${paramStr}`);
  }

  // Notes
  if (parsed && parsed.additionalNotes.length > 0) {
    lines.push('');
    lines.push('\uD83D\uDCCC Uwagi:');
    for (const note of parsed.additionalNotes.slice(0, 5)) {
      lines.push(`  - ${note}`);
    }
  }

  // Location
  const locParts: string[] = [];
  if (item.district) locParts.push(item.district);
  if (item.city) locParts.push(item.city);
  if (locParts.length > 0) {
    lines.push('');
    lines.push(`\uD83D\uDCCD ${locParts.join(', ')}`);
  }

  // Photos count
  if (item.photos.length > 0) {
    lines.push(`\uD83D\uDCF7 ${item.photos.length} zdj\u0119\u0107`);
  }

  // Contact
  if (item.phone) {
    lines.push(`\uD83D\uDCDE ${item.phone}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Backward-compatible aliases (used by telegram.ts sendEnrichedNotification)
// ---------------------------------------------------------------------------

export function formatRichRentalNotification(
  listing: Listing,
  parsedData?: ParsedRentalData,
  locationScore?: LocationScore,
): string {
  return formatRentalCard(listing, parsedData ?? null, locationScore ?? null);
}

export function formatRichItemNotification(
  item: ItemListing,
  parsedData?: ParsedItemData,
): string {
  return formatItemCard(item, parsedData ?? null);
}

// ---------------------------------------------------------------------------
// sendPhotoAlbum — send up to 10 photos as a Telegram media group
// No caption on photos — send the card as a separate message instead.
// ---------------------------------------------------------------------------

export async function sendPhotoAlbum(
  bot: TelegramBot,
  chatId: number | string,
  photoUrls: string[],
): Promise<void> {
  if (photoUrls.length === 0) return;

  // Telegram media groups support up to 10 photos
  const urls = photoUrls.slice(0, 10);

  const media: Array<{ type: 'photo'; media: string }> = urls.map((url) => ({
    type: 'photo',
    media: url,
  }));

  await bot.sendMediaGroup(chatId, media);
}
