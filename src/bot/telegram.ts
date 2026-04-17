// Telegram bot — thin wrapper that delegates all user messages to the AI agent.
// Auth-gated with password. /start and /help are handled directly; everything
// else is forwarded to the agent via handleUserMessage.

import TelegramBot from 'node-telegram-bot-api';
type Msg = TelegramBot.Message;
import type { Listing } from '../types.js';
import type { ItemListing } from '../crawlers/olx-items.js';
import { handleUserMessage } from '../ai/agent.js';
import { sendPhotoAlbum, formatRichRentalNotification, formatRichItemNotification } from './format.js';
import {
  isUserAuthorized,
  authorizeUser,
  addUser,
} from '../storage/db.js';
import type { ParsedRentalData, ParsedItemData, LocationScore } from '../types.js';

// ---------------------------------------------------------------------------
// Bot instance (module-level for notification use)
// ---------------------------------------------------------------------------

let _bot: TelegramBot | null = null;

export function getBot(): TelegramBot {
  if (!_bot) throw new Error('Bot not started — call startBot() first');
  return _bot;
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

  await _bot!.sendMessage(msg.chat.id, 'Send the password to access this bot.');
  return false;
}

// ---------------------------------------------------------------------------
// MarkdownV2 helpers (kept for /start and /help)
// ---------------------------------------------------------------------------

const MD2_SPECIAL = /[_*\[\]()~`>#\+\-=|{}.!\\]/g;

function esc(text: string | number | null | undefined): string {
  if (text == null) return '';
  return String(text).replace(MD2_SPECIAL, '\\$&');
}

// ---------------------------------------------------------------------------
// Enriched notification sender (used by scheduler)
// ---------------------------------------------------------------------------

export async function sendEnrichedNotification(
  chatId: number | string,
  listing: Listing | ItemListing,
  parsedData?: ParsedRentalData | ParsedItemData | null,
  locationScore?: LocationScore | null,
): Promise<void> {
  const bot = getBot();
  const isItem = !('slug' in listing); // ItemListing lacks `slug`

  let text: string;
  if (isItem) {
    text = formatRichItemNotification(listing as ItemListing, parsedData as ParsedItemData | undefined);
  } else {
    text = formatRichRentalNotification(listing as Listing, parsedData as ParsedRentalData | undefined, locationScore ?? undefined);
  }

  await bot.sendMessage(chatId, text, { disable_web_page_preview: false });

  // Send photo album if available
  const photos = listing.photos;
  if (photos.length > 0) {
    try {
      await sendPhotoAlbum(bot, chatId, photos);
    } catch {
      // photo sending is best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Wrapper functions for the AI agent
// ---------------------------------------------------------------------------

type SendFn = (chatId: number | string, text: string, opts?: Record<string, unknown>) => Promise<void>;
type SendPhotosFn = (chatId: number | string, urls: string[]) => Promise<void>;

function makeSendFn(bot: TelegramBot): SendFn {
  return async (chatId, text, opts?) => {
    // Don't force MarkdownV2 on AI responses — Claude returns plain text
    // Only use MarkdownV2 when explicitly passed in opts
    await bot.sendMessage(chatId, text, opts as TelegramBot.SendMessageOptions);
  };
}

function makeSendPhotosFn(bot: TelegramBot): SendPhotosFn {
  return (chatId, urls) => sendPhotoAlbum(bot, chatId, urls);
}

// ---------------------------------------------------------------------------
// Bot startup
// ---------------------------------------------------------------------------

export function startBot(): TelegramBot {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) throw new Error('TELEGRAM_TOKEN env var is required');

  const bot = new TelegramBot(token, { polling: true });
  _bot = bot;

  const sendFn = makeSendFn(bot);
  const sendPhotosFn = makeSendPhotosFn(bot);

  // --- /start ---
  bot.onText(/\/start/, async (msg: Msg) => {
    if (!(await ensureAuth(msg))) return;
    const text = [
      `\uD83C\uDDF5\uD83C\uDDF1 *Polish Rent & Items Bot*`,
      '',
      `I'm an AI\\-powered assistant that helps you find apartments and items in Poland\\.`,
      '',
      'Just tell me what you need in plain language, for example:',
      `\\- "Find me a 2\\-room apartment in Krakow up to 3000 PLN"`,
      `\\- "Search for a used iPhone 15 under 2500 PLN"`,
      `\\- "Set up a monitor for rentals in Warszawa"`,
      '',
      'Or use these commands:',
      '/help \\- show available commands',
      '/start \\- show this welcome message',
    ].join('\n');
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'MarkdownV2' });
  });

  // --- /help ---
  bot.onText(/\/help/, async (msg: Msg) => {
    if (!(await ensureAuth(msg))) return;
    const text = [
      '*How to use this bot*',
      '',
      'Send me any message in natural language and I\u2019ll figure out what to do\\.',
      '',
      'I can:',
      `\\- Search rentals on OLX, Otodom, and Allegro`,
      `\\- Search for items by keyword`,
      `\\- Create persistent monitors that notify you of new listings`,
      `\\- Analyze listing details \\(costs, contract type, amenities\\)`,
      `\\- Score locations \\(nearby amenities, commute times\\)`,
      '',
      'Examples:',
      `"Find apartments in Gdansk, 2 rooms, max 2500 PLN"`,
      `"Monitor iPhones under 3000 PLN in Warszawa"`,
      `"Show my monitors"`,
      `"Stop monitor 5"`,
      `"What\u2019s the bot status?"`,
    ].join('\n');
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'MarkdownV2' });
  });

  // --- Catch-all: forward everything else to AI agent ---
  bot.on('message', async (msg: Msg) => {
    const text = (msg.text ?? '').trim();
    if (!text) return;

    // /start and /help are handled above — skip them here
    if (/^\/start\b/.test(text) || /^\/help\b/.test(text)) return;

    if (!(await ensureAuth(msg))) return;

    const userId = msg.from!.id;
    const chatId = msg.chat.id;

    const typingFn = async (cid: number) => { await bot.sendChatAction(cid, 'typing'); };

    try {
      await handleUserMessage(userId, chatId, text, sendFn, sendPhotosFn, typingFn);
    } catch (err) {
      console.error(`[telegram] Agent error for user ${userId}:`, err);
      await bot.sendMessage(chatId, 'Something went wrong. Please try again later.');
    }
  });

  console.log('Telegram bot started (polling)');
  return bot;
}
