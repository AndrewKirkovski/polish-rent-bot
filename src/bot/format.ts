// Rich notification formatters for Telegram MarkdownV2
// Formats rental and item listings with parsed AI data and location scores

import type TelegramBot from 'node-telegram-bot-api';
import type { Listing, ParsedRentalData, ParsedItemData, LocationScore } from '../types.js';
import type { ItemListing } from '../crawlers/olx-items.js';

// ---------------------------------------------------------------------------
// MarkdownV2 helpers (same pattern as telegram.ts)
// ---------------------------------------------------------------------------

const MD2_SPECIAL = /[_*\[\]()~`>#\+\-=|{}.!\\]/g;

function esc(text: string | number | null | undefined): string {
  if (text == null) return '';
  return String(text).replace(MD2_SPECIAL, '\\$&');
}

function link(label: string, url: string): string {
  const safeLabel = esc(label);
  const safeUrl = url.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
  return `[${safeLabel}](${safeUrl})`;
}

function bold(text: string): string {
  return `*${esc(text)}*`;
}

// ---------------------------------------------------------------------------
// Amenity emoji map
// ---------------------------------------------------------------------------

const AMENITY_EMOJI: Record<string, string> = {
  metro: '\uD83D\uDE87',
  gym: '\uD83C\uDFCB\uFE0F',
  pool: '\uD83C\uDFCA',
  supermarket: '\uD83D\uDED2',
  park: '\uD83C\uDF33',
  pharmacy: '\uD83D\uDC8A',
};

// ---------------------------------------------------------------------------
// formatRichRentalNotification
// ---------------------------------------------------------------------------

export function formatRichRentalNotification(
  listing: Listing,
  parsedData?: ParsedRentalData,
  locationScore?: LocationScore,
): string {
  const lines: string[] = [];

  // Header
  lines.push(`\uD83C\uDD95 ${bold('New rental listing')}`);
  lines.push('');

  // Title + link
  lines.push(`*${link(listing.title, listing.url)}*`);
  lines.push('');

  // Price breakdown table
  lines.push(`\uD83D\uDCB0 ${bold('Price breakdown')}`);
  lines.push(`  Rent: ${esc(listing.price)} ${esc(listing.currency)}`);

  if (listing.rent != null) {
    lines.push(`  Czynsz admin: ${esc(listing.rent)} PLN`);
  } else if (parsedData?.adminFee != null) {
    lines.push(`  Czynsz admin: ${esc(parsedData.adminFee)} PLN`);
  }

  if (parsedData) {
    const media = parsedData.estimatedMedia;
    const mediaItems: string[] = [];
    if (media.water != null) mediaItems.push(`water ${media.water}`);
    if (media.electricity != null) mediaItems.push(`electricity ${media.electricity}`);
    if (media.gas != null) mediaItems.push(`gas ${media.gas}`);
    if (media.internet != null) mediaItems.push(`internet ${media.internet}`);
    if (media.heating != null) mediaItems.push(`heating ${media.heating}`);

    if (mediaItems.length > 0) {
      lines.push(`  Media est\\.: ${esc(mediaItems.join(', '))} PLN`);
    }

    if (parsedData.totalMonthlyCost != null) {
      lines.push(`  *Total/mo: ${esc(parsedData.totalMonthlyCost)} PLN*`);
    }
  }

  // Deposit
  const deposit = parsedData?.deposit ?? listing.deposit;
  if (deposit != null) {
    lines.push(`  Kaucja: ${esc(deposit)} PLN`);
  }

  lines.push('');

  // Property details
  const details: string[] = [];
  if (listing.area != null) details.push(`${listing.area} m\u00B2`);
  if (listing.rooms != null) details.push(`${listing.rooms} rooms`);
  if (listing.floor != null) {
    const floorStr = listing.buildingFloor != null
      ? `floor ${listing.floor}/${listing.buildingFloor}`
      : `floor ${listing.floor}`;
    details.push(floorStr);
  }
  if (listing.buildingType) details.push(listing.buildingType);
  if (details.length > 0) {
    lines.push(`\uD83C\uDFE0 ${esc(details.join(' | '))}`);
  }

  // Contract info (from parsed data)
  if (parsedData) {
    const contractParts: string[] = [];

    if (parsedData.contractType) {
      const typeLabel = parsedData.contractType.replace(/_/g, ' ');
      contractParts.push(`Contract: ${typeLabel}`);
    }
    if (parsedData.availableFrom) {
      contractParts.push(`From: ${parsedData.availableFrom}`);
    }
    if (parsedData.minimumLease) {
      contractParts.push(`Min lease: ${parsedData.minimumLease}`);
    }

    if (contractParts.length > 0) {
      lines.push(`\uD83D\uDCDD ${esc(contractParts.join(' | '))}`);
    }

    // Amenity flags
    const flags: string[] = [];
    if (parsedData.petFriendly === true) flags.push('\uD83D\uDC3E Pets OK');
    if (parsedData.petFriendly === false) flags.push('\uD83D\uDEAB No pets');
    if (parsedData.smokingAllowed === true) flags.push('\uD83D\uDEAC Smoking OK');
    if (parsedData.smokingAllowed === false) flags.push('\uD83D\uDEAD No smoking');
    if (parsedData.furnished) {
      const fLabel: Record<string, string> = {
        full: '\uD83D\uDECB Furnished',
        partial: '\uD83E\uDE91 Partially furnished',
        none: '\uD83D\uDCE6 Unfurnished',
      };
      flags.push(fLabel[parsedData.furnished] ?? '');
    }
    if (parsedData.parkingIncluded === true) flags.push('\uD83C\uDD7F\uFE0F Parking');
    if (parsedData.balcony === true) flags.push('\uD83C\uDF05 Balcony');

    const validFlags = flags.filter(Boolean);
    if (validFlags.length > 0) {
      lines.push(esc(validFlags.join(' | ')));
    }

    // Additional notes
    if (parsedData.additionalNotes.length > 0) {
      lines.push('');
      lines.push(`\uD83D\uDCCC ${bold('Notes')}`);
      for (const note of parsedData.additionalNotes.slice(0, 5)) {
        lines.push(`  \\- ${esc(note)}`);
      }
    }
  }

  // Location score
  if (locationScore) {
    lines.push('');
    lines.push(`\uD83D\uDCCD ${bold('Location')} \\(score: ${esc(locationScore.overallScore)}/100\\)`);

    for (const a of locationScore.amenities) {
      const emoji = AMENITY_EMOJI[a.type] ?? '\uD83D\uDCCD';
      if (a.nearest) {
        const check = a.withinLimit ? '\u2705' : '\u274C';
        lines.push(
          `  ${emoji} ${esc(a.type)}: ${esc(a.nearest.name)} \\- ${esc(a.nearest.walkingMinutes)} min \\(${esc(a.nearest.distance)}\\) ${check}`,
        );
      } else {
        lines.push(`  ${emoji} ${esc(a.type)}: not found nearby`);
      }
    }

    if (locationScore.commute) {
      const c = locationScore.commute;
      lines.push(
        `  \uD83D\uDE8C Commute: ${esc(c.duration)} \\(${esc(c.distance)}, ${esc(c.mode)}\\)`,
      );
    }

    lines.push(`  ${link('Google Maps', locationScore.mapsLink)}`);
  }

  lines.push('');

  // Location
  const locParts: string[] = [];
  if (listing.district) locParts.push(listing.district);
  if (listing.city) locParts.push(listing.city);
  if (locParts.length > 0 && !locationScore) {
    lines.push(`\uD83D\uDCCD ${esc(locParts.join(', '))}`);
  }

  // Photos count
  if (listing.photos.length > 0) {
    lines.push(`\uD83D\uDCF7 ${esc(listing.photos.length)} photos`);
  }

  // Contact
  if (listing.phone) {
    lines.push(`\uD83D\uDCDE ${esc(listing.phone)}`);
  }
  if (listing.advertiserType) {
    const contactStr = listing.agencyName
      ? `${listing.advertiserType} - ${listing.agencyName}`
      : listing.advertiserType;
    lines.push(`\uD83D\uDC64 ${esc(contactStr)}`);
  }

  // Links
  lines.push('');
  lines.push(link('\uD83D\uDD17 Open listing', listing.url));
  if (listing.lat != null && listing.lng != null && !locationScore) {
    const mapsUrl = `https://www.google.com/maps/@${listing.lat},${listing.lng},15z`;
    lines.push(link('\uD83D\uDDFA Show on map', mapsUrl));
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// formatRichItemNotification
// ---------------------------------------------------------------------------

export function formatRichItemNotification(
  item: ItemListing,
  parsedData?: ParsedItemData,
): string {
  const lines: string[] = [];

  // Header
  lines.push(`\uD83C\uDD95 ${bold('New item listing')}`);
  lines.push('');

  // Title + link
  lines.push(`*${link(item.title, item.url)}*`);
  lines.push('');

  // Price
  const priceStr = `${item.price} ${item.currency}`;
  lines.push(
    `\uD83D\uDCB0 ${esc(priceStr)}${item.negotiable ? ' \\(negotiable\\)' : ''}`,
  );

  // Condition
  if (parsedData) {
    lines.push(`\uD83D\uDCE6 ${bold('Condition')}: ${esc(parsedData.actualCondition)}`);
  } else if (item.condition) {
    lines.push(`\uD83D\uDCE6 ${esc(item.condition)}`);
  }

  // Why selling
  if (parsedData?.whySelling) {
    lines.push(`\uD83D\uDCAC Why selling: ${esc(parsedData.whySelling)}`);
  }

  // Defects
  if (parsedData && parsedData.defects.length > 0) {
    lines.push('');
    lines.push(`\u26A0\uFE0F ${bold('Defects')}`);
    for (const defect of parsedData.defects) {
      lines.push(`  \\- ${esc(defect)}`);
    }
  }

  // Included accessories
  if (parsedData && parsedData.includedAccessories.length > 0) {
    lines.push('');
    lines.push(`\uD83D\uDCE5 ${bold('Included')}`);
    for (const acc of parsedData.includedAccessories) {
      lines.push(`  \\- ${esc(acc)}`);
    }
  }

  // Parameters (from raw listing)
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
    lines.push(`\u2699\uFE0F ${esc(paramStr)}`);
  }

  // Additional notes
  if (parsedData && parsedData.additionalNotes.length > 0) {
    lines.push('');
    lines.push(`\uD83D\uDCCC ${bold('Notes')}`);
    for (const note of parsedData.additionalNotes.slice(0, 5)) {
      lines.push(`  \\- ${esc(note)}`);
    }
  }

  // Location
  const locParts: string[] = [];
  if (item.district) locParts.push(item.district);
  if (item.city) locParts.push(item.city);
  if (locParts.length > 0) {
    lines.push('');
    lines.push(`\uD83D\uDCCD ${esc(locParts.join(', '))}`);
  }

  // Photos count
  if (item.photos.length > 0) {
    lines.push(`\uD83D\uDCF7 ${esc(item.photos.length)} photos`);
  }

  // Contact
  if (item.phone) {
    lines.push(`\uD83D\uDCDE ${esc(item.phone)}`);
  }

  // Link
  lines.push('');
  lines.push(link('\uD83D\uDD17 Open listing', item.url));

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// sendPhotoAlbum
// ---------------------------------------------------------------------------

export async function sendPhotoAlbum(
  bot: TelegramBot,
  chatId: number | string,
  photoUrls: string[],
  caption?: string,
): Promise<void> {
  if (photoUrls.length === 0) return;

  // Telegram media groups support up to 10 photos
  const urls = photoUrls.slice(0, 10);

  type ParseMode = 'Markdown' | 'MarkdownV2' | 'HTML';
  const media: Array<{
    type: 'photo';
    media: string;
    caption?: string;
    parse_mode?: ParseMode;
  }> = urls.map((url, i) => {
    const entry: {
      type: 'photo';
      media: string;
      caption?: string;
      parse_mode?: ParseMode;
    } = {
      type: 'photo',
      media: url,
    };
    // First photo gets the caption
    if (i === 0 && caption) {
      entry.caption = caption;
      entry.parse_mode = 'MarkdownV2';
    }
    return entry;
  });

  await bot.sendMediaGroup(chatId, media);
}
