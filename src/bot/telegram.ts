// Telegram bot for Polish rent/items monitoring
// Auth-gated with password, supports one-shot search and persistent monitors

import TelegramBot from 'node-telegram-bot-api';
type Msg = TelegramBot.Message;
import { searchOlx, OLX_CATEGORIES, OLX_CITIES } from '../crawlers/olx.js';
import { searchItems } from '../crawlers/olx-items.js';
import type { ItemListing } from '../crawlers/olx-items.js';
import type { Listing } from '../types.js';
import {
  isUserAuthorized,
  authorizeUser,
  addUser,
  addMonitor,
  getMonitors,
  deactivateMonitor,
  getSeenCount,
} from '../storage/db.js';

// ---------------------------------------------------------------------------
// City mapping (command name -> OLX city ID)
// ---------------------------------------------------------------------------

const CITY_MAP: Record<string, number> = {
  warszawa: OLX_CITIES.WARSZAWA,
  krakow: OLX_CITIES.KRAKOW,
  wroclaw: OLX_CITIES.WROCLAW,
  gdansk: OLX_CITIES.GDANSK,
  poznan: OLX_CITIES.POZNAN,
  lodz: OLX_CITIES.LODZ,
  katowice: OLX_CITIES.KATOWICE,
};

function resolveCityId(name: string): number | undefined {
  return CITY_MAP[name.toLowerCase()];
}

// ---------------------------------------------------------------------------
// MarkdownV2 helpers
// ---------------------------------------------------------------------------

const MD2_SPECIAL = /[_*\[\]()~`>#\+\-=|{}.!\\]/g;

function esc(text: string | number | null | undefined): string {
  if (text == null) return '';
  return String(text).replace(MD2_SPECIAL, '\\$&');
}

function link(label: string, url: string): string {
  const safeLabel = esc(label);
  // In MarkdownV2 links, only ) and \ need escaping inside the URL
  const safeUrl = url.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
  return `[${safeLabel}](${safeUrl})`;
}

// ---------------------------------------------------------------------------
// Listing formatters
// ---------------------------------------------------------------------------

function formatRentalListing(l: Listing, idx: number): string {
  const lines: string[] = [];

  lines.push(`*${esc(idx + 1)}\\. ${link(l.title, l.url)}*`);

  // Price line
  const priceParts: string[] = [`${esc(l.price)} ${esc(l.currency)}`];
  if (l.rent != null) priceParts.push(`czynsz: ${esc(l.rent)} PLN`);
  if (l.deposit != null) priceParts.push(`kaucja: ${esc(l.deposit)} PLN`);
  lines.push(`\uD83D\uDCB0 ${priceParts.join(' \\| ')}`);

  // Property details
  const details: string[] = [];
  if (l.area != null) details.push(`${esc(l.area)} m\u00B2`);
  if (l.rooms != null) details.push(`${esc(l.rooms)} rooms`);
  if (l.floor != null) details.push(`floor ${esc(l.floor)}`);
  if (l.buildingType) details.push(esc(l.buildingType));
  if (details.length > 0) lines.push(`\uD83C\uDFE0 ${details.join(' \\| ')}`);

  // Location
  const locParts: string[] = [];
  if (l.district) locParts.push(esc(l.district));
  if (l.city) locParts.push(esc(l.city));
  if (locParts.length > 0) lines.push(`\uD83D\uDCCD ${locParts.join(', ')}`);

  // Contact
  if (l.phone) lines.push(`\uD83D\uDCDE ${esc(l.phone)}`);
  if (l.advertiserType) lines.push(`\uD83D\uDC64 ${esc(l.advertiserType)}${l.agencyName ? ` \\- ${esc(l.agencyName)}` : ''}`);

  return lines.join('\n');
}

function formatItemListing(item: ItemListing, idx: number): string {
  const lines: string[] = [];

  lines.push(`*${esc(idx + 1)}\\. ${link(item.title, item.url)}*`);

  // Price
  const priceStr = `${esc(item.price)} ${esc(item.currency)}`;
  lines.push(`\uD83D\uDCB0 ${priceStr}${item.negotiable ? ' \\(negotiable\\)' : ''}`);

  // Condition
  if (item.condition) lines.push(`\uD83D\uDCE6 ${esc(item.condition)}`);

  // Location
  const locParts: string[] = [];
  if (item.district) locParts.push(esc(item.district));
  if (item.city) locParts.push(esc(item.city));
  if (locParts.length > 0) lines.push(`\uD83D\uDCCD ${locParts.join(', ')}`);

  // Key params (skip price/state — already shown)
  const skipKeys = new Set(['price', 'state']);
  const paramEntries = Object.entries(item.params).filter(([k]) => !skipKeys.has(k));
  if (paramEntries.length > 0) {
    const paramStr = paramEntries
      .slice(0, 5)
      .map(([k, v]) => `${esc(k)}: ${esc(v)}`)
      .join(', ');
    lines.push(`\u2699\uFE0F ${paramStr}`);
  }

  // Contact
  if (item.phone) lines.push(`\uD83D\uDCDE ${esc(item.phone)}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public: notification sender (used by the scheduler/poller)
// ---------------------------------------------------------------------------

let _bot: TelegramBot | null = null;

export async function sendNewListingNotification(
  chatId: number | string,
  listing: Listing | ItemListing,
): Promise<void> {
  if (!_bot) throw new Error('Bot not started — call startBot() first');

  const isItem = !('slug' in listing); // ItemListing lacks `slug`
  let text: string;

  if (isItem) {
    text = formatItemNotification(listing as ItemListing);
  } else {
    text = formatRentalNotification(listing as Listing);
  }

  await _bot.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', disable_web_page_preview: false });

  // Send first photo if available
  const photos = listing.photos;
  if (photos.length > 0) {
    try {
      await _bot.sendPhoto(chatId, photos[0]);
    } catch {
      // photo sending is best-effort
    }
  }
}

function formatRentalNotification(l: Listing): string {
  const lines: string[] = [];
  lines.push(`\uD83C\uDD95 *New rental listing*`);
  lines.push('');
  lines.push(formatRentalListing(l, 0).replace(/^\*\d+\\\.\s*/, '*').trim());
  return lines.join('\n');
}

function formatItemNotification(item: ItemListing): string {
  const lines: string[] = [];
  lines.push(`\uD83C\uDD95 *New item listing*`);
  lines.push('');
  lines.push(formatItemListing(item, 0).replace(/^\*\d+\\\.\s*/, '*').trim());
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

const BOT_PASSWORD = process.env.BOT_PASSWORD ?? '';

async function ensureAuth(msg: Msg): Promise<boolean> {
  const telegramId = msg.from?.id;
  if (!telegramId) return false;

  if (isUserAuthorized(telegramId)) return true;

  // Not authorized — check if the message is the password
  const text = (msg.text ?? '').trim();
  if (text === BOT_PASSWORD && BOT_PASSWORD !== '') {
    const username = msg.from?.username ?? msg.from?.first_name ?? String(telegramId);
    addUser(telegramId, username);
    authorizeUser(telegramId);
    await _bot!.sendMessage(msg.chat.id, 'Access granted\\. Welcome\\! Type /start for commands\\.', {
      parse_mode: 'MarkdownV2',
    });
    return false; // handled — don't run command
  }

  await _bot!.sendMessage(msg.chat.id, 'Send the password to access this bot\\.');
  return false;
}

// ---------------------------------------------------------------------------
// Bot startup
// ---------------------------------------------------------------------------

const startedAt = Date.now();

export function startBot(): TelegramBot {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) throw new Error('TELEGRAM_TOKEN env var is required');

  const bot = new TelegramBot(token, { polling: true });
  _bot = bot;

  // --- /start ---
  bot.onText(/\/start/, async (msg: Msg) => {
    if (!(await ensureAuth(msg))) return;
    const text = [
      `\uD83C\uDDF5\uD83C\uDDF1 *Polish Rent & Items Bot*`,
      '',
      'Available commands:',
      '/search\\_rent \\<city\\> \\[maxPrice\\] \\- one\\-shot rental search',
      '/search\\_item \\<query\\> \\[city\\] \\- one\\-shot items search',
      '/monitor\\_rent \\<city\\> \\<maxPrice\\> \\[rooms\\] \\- create rental monitor',
      '/monitor\\_item \\<query\\> \\[maxPrice\\] \\- create items monitor',
      '/monitors \\- list active monitors',
      '/stop \\<id\\> \\- deactivate a monitor',
      '/status \\- bot status',
      '/help \\- show this message',
    ].join('\n');
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'MarkdownV2' });
  });

  // --- /help ---
  bot.onText(/\/help/, async (msg: Msg) => {
    if (!(await ensureAuth(msg))) return;
    const text = [
      '*Commands*',
      '',
      '`/search_rent <city> [maxPrice]`',
      'Search OLX rentals in a city\\. Cities: warszawa, krakow, wroclaw, gdansk, poznan, lodz, katowice\\.',
      '',
      '`/search_item <query> [city]`',
      'Search OLX items by keyword\\. Optionally filter by city\\.',
      '',
      '`/monitor_rent <city> <maxPrice> [rooms]`',
      'Create a monitor that checks for new rentals periodically\\.',
      '',
      '`/monitor_item <query> [maxPrice]`',
      'Create a monitor for new items matching a keyword\\.',
      '',
      '`/monitors` \\- list your active monitors',
      '`/stop <id>` \\- deactivate a monitor',
      '`/status` \\- uptime and stats',
    ].join('\n');
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'MarkdownV2' });
  });

  // --- /search_rent <city> [maxPrice] ---
  bot.onText(/\/search_rent(?:\s+(.+))?/, async (msg: Msg, match: RegExpExecArray | null) => {
    if (!(await ensureAuth(msg))) return;
    const args = (match?.[1] ?? '').trim().split(/\s+/);
    const cityName = args[0];
    if (!cityName) {
      await bot.sendMessage(msg.chat.id, 'Usage: `/search_rent <city> [maxPrice]`\nCities: warszawa, krakow, wroclaw, gdansk, poznan, lodz, katowice', { parse_mode: 'Markdown' });
      return;
    }

    const cityId = resolveCityId(cityName);
    if (!cityId) {
      await bot.sendMessage(msg.chat.id, `Unknown city: ${cityName}. Available: warszawa, krakow, wroclaw, gdansk, poznan, lodz, katowice`);
      return;
    }

    const maxPrice = args[1] ? parseInt(args[1], 10) : undefined;
    await bot.sendMessage(msg.chat.id, '\u23F3 Searching OLX rentals...');

    try {
      const result = await searchOlx({
        categoryId: OLX_CATEGORIES.MIESZKANIA_WYNAJEM,
        cityId,
        priceTo: maxPrice,
        limit: 5,
      });

      if (result.listings.length === 0) {
        await bot.sendMessage(msg.chat.id, 'No listings found\\. Try different parameters\\.', { parse_mode: 'MarkdownV2' });
        return;
      }

      const formatted = result.listings
        .slice(0, 5)
        .map((l, i) => formatRentalListing(l, i))
        .join('\n\n');

      const header = `*Found ${esc(result.totalAvailable)} listings, showing top ${esc(Math.min(5, result.listings.length))}:*\n\n`;
      await bot.sendMessage(msg.chat.id, header + formatted, {
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      });
    } catch (err) {
      console.error('search_rent error:', err);
      await bot.sendMessage(msg.chat.id, 'Search failed. Please try again later.');
    }
  });

  // --- /search_item <query> [city] ---
  bot.onText(/\/search_item(?:\s+(.+))?/, async (msg: Msg, match: RegExpExecArray | null) => {
    if (!(await ensureAuth(msg))) return;
    const args = (match?.[1] ?? '').trim();
    if (!args) {
      await bot.sendMessage(msg.chat.id, 'Usage: `/search_item <query> [city]`', { parse_mode: 'Markdown' });
      return;
    }

    // Try to detect city as the last word
    const parts = args.split(/\s+/);
    const lastWord = parts[parts.length - 1].toLowerCase();
    let cityId: number | undefined;
    let query: string;

    if (parts.length > 1 && resolveCityId(lastWord)) {
      cityId = resolveCityId(lastWord);
      query = parts.slice(0, -1).join(' ');
    } else {
      query = args;
    }

    await bot.sendMessage(msg.chat.id, '\u23F3 Searching OLX items...');

    try {
      const result = await searchItems({ query, cityId, limit: 5 });

      if (result.items.length === 0) {
        await bot.sendMessage(msg.chat.id, 'No items found\\. Try different keywords\\.', { parse_mode: 'MarkdownV2' });
        return;
      }

      const formatted = result.items
        .slice(0, 5)
        .map((item, i) => formatItemListing(item, i))
        .join('\n\n');

      const header = `*Found ${esc(result.totalAvailable)} items, showing top ${esc(Math.min(5, result.items.length))}:*\n\n`;
      await bot.sendMessage(msg.chat.id, header + formatted, {
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      });
    } catch (err) {
      console.error('search_item error:', err);
      await bot.sendMessage(msg.chat.id, 'Search failed. Please try again later.');
    }
  });

  // --- /monitor_rent <city> <maxPrice> [rooms] ---
  bot.onText(/\/monitor_rent(?:\s+(.+))?/, async (msg: Msg, match: RegExpExecArray | null) => {
    if (!(await ensureAuth(msg))) return;
    const args = (match?.[1] ?? '').trim().split(/\s+/);

    if (args.length < 2 || !args[0]) {
      await bot.sendMessage(msg.chat.id, 'Usage: `/monitor_rent <city> <maxPrice> [rooms]`', { parse_mode: 'Markdown' });
      return;
    }

    const cityName = args[0];
    const cityId = resolveCityId(cityName);
    if (!cityId) {
      await bot.sendMessage(msg.chat.id, `Unknown city: ${cityName}. Available: warszawa, krakow, wroclaw, gdansk, poznan, lodz, katowice`);
      return;
    }

    const maxPrice = parseInt(args[1], 10);
    if (isNaN(maxPrice)) {
      await bot.sendMessage(msg.chat.id, 'maxPrice must be a number.');
      return;
    }

    const rooms = args[2] ? parseInt(args[2], 10) || undefined : undefined;
    const telegramId = msg.from!.id;

    try {
      const config = {
        categoryId: OLX_CATEGORIES.MIESZKANIA_WYNAJEM,
        cityId,
        city: cityName.toLowerCase(),
        priceTo: maxPrice,
        roomsFrom: rooms ?? null,
      };

      const monitorId = addMonitor(telegramId, 'rental' as const, 'olx' as const, config);

      const roomsStr = rooms ? `, ${esc(rooms)} rooms` : '';
      await bot.sendMessage(
        msg.chat.id,
        `\u2705 *Monitor created*\nID: \`${esc(monitorId)}\`\nCity: ${esc(cityName)}${roomsStr}\nMax price: ${esc(maxPrice)} PLN\n\nI'll notify you when new listings appear\\.`,
        { parse_mode: 'MarkdownV2' },
      );
    } catch (err) {
      console.error('monitor_rent error:', err);
      await bot.sendMessage(msg.chat.id, 'Failed to create monitor. Please try again.');
    }
  });

  // --- /monitor_item <query> [maxPrice] ---
  bot.onText(/\/monitor_item(?:\s+(.+))?/, async (msg: Msg, match: RegExpExecArray | null) => {
    if (!(await ensureAuth(msg))) return;
    const args = (match?.[1] ?? '').trim();

    if (!args) {
      await bot.sendMessage(msg.chat.id, 'Usage: `/monitor_item <query> [maxPrice]`', { parse_mode: 'Markdown' });
      return;
    }

    const parts = args.split(/\s+/);
    // Check if last part is a number (maxPrice)
    const lastPart = parts[parts.length - 1];
    let maxPrice: number | undefined;
    let query: string;

    if (parts.length > 1 && /^\d+$/.test(lastPart)) {
      maxPrice = parseInt(lastPart, 10);
      query = parts.slice(0, -1).join(' ');
    } else {
      query = args;
    }

    const telegramId = msg.from!.id;

    try {
      const config: Record<string, unknown> = { query };
      if (maxPrice != null) config.priceTo = maxPrice;

      const monitorId = addMonitor(telegramId, 'item' as const, 'olx' as const, config);

      const priceStr = maxPrice ? `\nMax price: ${esc(maxPrice)} PLN` : '';
      await bot.sendMessage(
        msg.chat.id,
        `\u2705 *Monitor created*\nID: \`${esc(monitorId)}\`\nQuery: ${esc(query)}${priceStr}\n\nI'll notify you when new items appear\\.`,
        { parse_mode: 'MarkdownV2' },
      );
    } catch (err) {
      console.error('monitor_item error:', err);
      await bot.sendMessage(msg.chat.id, 'Failed to create monitor. Please try again.');
    }
  });

  // --- /monitors ---
  bot.onText(/\/monitors/, async (msg: Msg) => {
    if (!(await ensureAuth(msg))) return;
    const telegramId = msg.from!.id;

    try {
      const monitors = getMonitors(telegramId);

      if (monitors.length === 0) {
        await bot.sendMessage(msg.chat.id, 'No active monitors\\. Create one with /monitor\\_rent or /monitor\\_item\\.', { parse_mode: 'MarkdownV2' });
        return;
      }

      const lines: string[] = ['*Your active monitors:*', ''];

      for (const m of monitors) {
        const seen = getSeenCount(m.id);
        const config = typeof m.config === 'string' ? JSON.parse(m.config) : m.config;
        let desc: string;

        if (m.type === 'rental') {
          const city = config.city ?? 'unknown';
          const rooms = config.roomsFrom ? `, ${esc(config.roomsFrom)}r` : '';
          desc = `Rent in ${esc(city)}, max ${esc(config.priceTo)} PLN${rooms}`;
        } else {
          const price = config.priceTo ? `, max ${esc(config.priceTo)} PLN` : '';
          desc = `Item: "${esc(config.query)}"${price}`;
        }

        lines.push(`\`${esc(m.id)}\` \\- ${desc} \\(${esc(seen)} seen\\)`);
      }

      lines.push('');
      lines.push('Stop with `/stop <id>`');

      await bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'MarkdownV2' });
    } catch (err) {
      console.error('monitors error:', err);
      await bot.sendMessage(msg.chat.id, 'Failed to load monitors. Please try again.');
    }
  });

  // --- /stop <id> ---
  bot.onText(/\/stop(?:\s+(.+))?/, async (msg: Msg, match: RegExpExecArray | null) => {
    if (!(await ensureAuth(msg))) return;
    const id = (match?.[1] ?? '').trim();

    if (!id) {
      await bot.sendMessage(msg.chat.id, 'Usage: `/stop <monitor_id>`', { parse_mode: 'Markdown' });
      return;
    }

    try {
      deactivateMonitor(parseInt(id, 10));
      await bot.sendMessage(msg.chat.id, `\u2705 Monitor \`${esc(id)}\` deactivated\\.`, { parse_mode: 'MarkdownV2' });
    } catch (err) {
      console.error('stop error:', err);
      await bot.sendMessage(msg.chat.id, 'Failed to deactivate monitor. Check the ID and try again.');
    }
  });

  // --- /status ---
  bot.onText(/\/status/, async (msg: Msg) => {
    if (!(await ensureAuth(msg))) return;
    const telegramId = msg.from!.id;

    try {
      const monitors = getMonitors(telegramId);
      const allMonitors = getMonitors();
      const uptimeMs = Date.now() - startedAt;
      const uptimeH = Math.floor(uptimeMs / 3_600_000);
      const uptimeM = Math.floor((uptimeMs % 3_600_000) / 60_000);

      const text = [
        '*Bot Status*',
        '',
        `Uptime: ${esc(uptimeH)}h ${esc(uptimeM)}m`,
        `Your monitors: ${esc(monitors.length)}`,
        `Total monitors: ${esc(allMonitors.length)}`,
      ].join('\n');

      await bot.sendMessage(msg.chat.id, text, { parse_mode: 'MarkdownV2' });
    } catch (err) {
      console.error('status error:', err);
      await bot.sendMessage(msg.chat.id, 'Failed to fetch status.');
    }
  });

  // --- Fallback: auth check for non-command messages ---
  bot.on('message', async (msg: Msg) => {
    // Skip messages already handled by onText handlers (commands)
    if (msg.text && msg.text.startsWith('/')) return;
    await ensureAuth(msg);
  });

  console.log('Telegram bot started (polling)');
  return bot;
}
