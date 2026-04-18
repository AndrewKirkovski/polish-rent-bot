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
    await safeSend(_bot!, msg.chat.id, 'Access granted. Welcome! Type /start for commands.', {
      parse_mode: 'HTML',
    });
    return false; // handled — don't run command
  }

  await safeSend(_bot!, msg.chat.id, 'Send the password to access this bot.');
  return false;
}

// (format.ts has its own esc() for HTML escaping)

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

  await safeSend(bot, chatId, text, { parse_mode: 'HTML', disable_web_page_preview: false });

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

// Safe sendMessage wrapper — catches errors, retries without parse_mode on parse failures
async function safeSend(bot: TelegramBot, chatId: number | string, text: string, opts?: TelegramBot.SendMessageOptions): Promise<void> {
  try {
    await bot.sendMessage(chatId, text, opts);
  } catch (err) {
    console.error('[telegram] sendMessage failed:', err instanceof Error ? err.message : err);
    // If HTML parsing failed, retry without parse_mode
    if (opts?.parse_mode && err instanceof Error && err.message.includes("can't parse entities")) {
      try {
        await bot.sendMessage(chatId, text); // plain text fallback
      } catch (retryErr) {
        console.error('[telegram] Plain text fallback also failed:', retryErr instanceof Error ? retryErr.message : retryErr);
      }
    }
  }
}

function makeSendFn(bot: TelegramBot): SendFn {
  return async (chatId, text, opts?) => {
    // Use HTML parse_mode — more robust escaping, clickable URLs
    await safeSend(bot, chatId, text, { parse_mode: 'HTML', ...opts } as TelegramBot.SendMessageOptions);
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

  // Polling error handlers — prevent unhandled rejections from killing the process
  bot.on('polling_error', (err) => console.error('[telegram] Polling error:', err.message));
  bot.on('error', (err) => console.error('[telegram] Bot error:', err.message));

  const sendFn = makeSendFn(bot);
  const sendPhotosFn = makeSendPhotosFn(bot);

  // --- /start ---
  bot.onText(/\/start/, async (msg: Msg) => {
    try {
      if (!(await ensureAuth(msg))) return;
      const text = [
        '\uD83C\uDDF5\uD83C\uDDF1 <b>Polish Rent &amp; Items Bot</b>',
        '',
        "I'm an AI-powered assistant that helps you find apartments and items in Poland.",
        '',
        'Just tell me what you need in plain language, for example:',
        '- "Find me a 2-room apartment in Krakow up to 3000 PLN"',
        '- "Search for a used iPhone 15 under 2500 PLN"',
        '- "Set up a monitor for rentals in Warszawa"',
        '',
        'Or use /help for more info.',
      ].join('\n');
      await safeSend(bot, msg.chat.id, text, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[telegram] /start handler error:', err);
    }
  });

  // --- /help ---
  bot.onText(/\/help/, async (msg: Msg) => {
    try {
      if (!(await ensureAuth(msg))) return;
      const text = [
        '<b>How to use this bot</b>',
        '',
        'Send me any message in natural language.',
        '',
        'I can:',
        '- Search rentals on OLX and Otodom',
        '- Search for used items by keyword',
        '- Analyze listings (costs, contract type, amenities)',
        '- Score locations (nearby metro, gym, pool, commute)',
        '- Create monitors that notify you of new listings',
        '',
        '<b>Examples:</b>',
        '"Find apartments in Gdansk, 2 rooms, max 2500 PLN"',
        '"Monitor iPhones under 3000 PLN in Warszawa"',
        '"Show my monitors"',
        '"Stop monitor 5"',
      ].join('\n');
      await safeSend(bot, msg.chat.id, text, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[telegram] /help handler error:', err);
    }
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
      await safeSend(bot, chatId, 'Something went wrong. Please try again later.');
    }
  });

  console.log('Telegram bot started (polling)');
  return bot;
}
