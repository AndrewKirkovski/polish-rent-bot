// Telegram bot — thin wrapper that delegates all user messages to the AI agent.
// Auth-gated with password. /start and /help are handled directly; everything
// else is forwarded to the agent via handleUserMessage.

import TelegramBot from 'node-telegram-bot-api';
type Msg = TelegramBot.Message;
import type { Listing } from '../types.js';
import type { ItemListing } from '../crawlers/olx-items.js';
import { handleUserMessage } from '../ai/agent.js';
import { sendPhotoAlbum, formatRichRentalNotification, formatRichItemNotification, splitMessage, captionLength, CAPTION_LIMIT } from './format.js';
import {
  isUserAuthorized,
  authorizeUser,
  addUser,
} from '../storage/db.js';
import type { ParsedRentalData, ParsedItemData, LocationScore } from '../types.js';
import { wrapBroadcastPhotos, broadcastToFamily, assertBroadcastOk } from './broadcast.js';
import { getAuthorizedTelegramIds } from '../storage/db.js';

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
// Convert Markdown from Claude's responses to Telegram-safe HTML
// Uses marked (full MD→HTML) + sanitize-html (whitelist Telegram-supported tags)
// ---------------------------------------------------------------------------

import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

// Configure marked for inline-only output (no <p> wrappers for single paragraphs)
marked.setOptions({ breaks: true, gfm: true });

/** Convert Markdown (including raw HTML) to Telegram-safe HTML */
function mdToHtml(text: string): string {
  const rawHtml = marked.parse(text, { async: false }) as string;

  // Pre-process: convert block elements to newlines before sanitize-html strips them
  let processed = rawHtml
    .replace(/<\/p>\s*<p>/g, '\n\n')        // paragraph breaks → double newline
    .replace(/<p>/g, '')                     // opening <p>
    .replace(/<\/p>/g, '\n')                 // closing <p> → newline
    .replace(/<br\s*\/?>/g, '\n')            // <br> → newline
    .replace(/<li>/g, '• ')                  // list items → bullet
    .replace(/<\/li>/g, '\n')                // end list item → newline
    .replace(/<\/?[uo]l>/g, '')              // strip <ul>/<ol> wrappers
    .replace(/<h[1-6][^>]*>/g, '<b>')        // headers → bold
    .replace(/<\/h[1-6]>/g, '</b>\n')        // close header → bold + newline
    .replace(/<hr\s*\/?>/g, '────────\n');   // horizontal rule

  // sanitize-html: keep only Telegram-supported tags
  const clean = sanitizeHtml(processed, {
    allowedTags: ['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
                  'a', 'code', 'pre', 'blockquote', 'tg-emoji', 'tg-spoiler', 'span'],
    allowedAttributes: { 'a': ['href'], 'tg-emoji': ['emoji-id'], 'code': ['class'], 'span': ['class'], 'blockquote': ['expandable'] },
    transformTags: {
      'strong': 'b',
      'em': 'i',
      'ins': 'u',
      'strike': 's',
      'del': 's',
    },
  });

  return clean.replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Enriched notification sender (used by scheduler)
// ---------------------------------------------------------------------------

/** Send message that MUST succeed — throws if both HTML and plain text fallback fail.
 *  Used by scheduler where failure must prevent markListingSeen. */
async function mustSend(bot: TelegramBot, chatId: number | string, text: string, opts?: TelegramBot.SendMessageOptions): Promise<void> {
  try {
    await bot.sendMessage(chatId, text, opts);
  } catch (err) {
    console.error('[telegram] mustSend failed:', err instanceof Error ? err.message : err);
    if (opts?.parse_mode && err instanceof Error && err.message.includes("can't parse entities")) {
      // Retry as plain text — if this also fails, let it throw
      const plain = stripHtml(text);
      await bot.sendMessage(chatId, plain);
    } else {
      throw err; // re-throw non-parse errors (network, blocked, etc.)
    }
  }
}

export async function broadcastEnrichedNotification(
  listing: Listing | ItemListing,
  parsedData?: ParsedRentalData | ParsedItemData | null,
  locationScore?: LocationScore | null,
  fitReason?: string | null,
): Promise<void> {
  const result = await broadcastToFamily(async (chatId) => {
    await sendEnrichedNotification(chatId, listing, parsedData, locationScore, fitReason);
  });
  assertBroadcastOk(result, 'Monitor alert');
}

/** Fan out a plain HTML text message to the whole family (used by the daily rejection report).
 *  Uses mustSend (which throws on a genuine per-recipient failure) + assertBroadcastOk, so a
 *  TOTAL delivery failure (nobody received it) THROWS — letting the caller leave its markers
 *  untouched and retry next cycle. Partial delivery (≥1 recipient) counts as sent. The scheduler
 *  wraps this in try/catch, so a throw never disturbs the monitor cycle. */
export async function broadcastText(text: string): Promise<void> {
  const bot = getBot();
  const result = await broadcastToFamily((id) =>
    mustSend(bot, id, text, { parse_mode: 'HTML', disable_web_page_preview: true }),
  );
  assertBroadcastOk(result, 'Daily rejection report');
}

export async function sendEnrichedNotification(
  chatId: number | string,
  listing: Listing | ItemListing,
  parsedData?: ParsedRentalData | ParsedItemData | null,
  locationScore?: LocationScore | null,
  fitReason?: string | null,
): Promise<void> {
  const bot = getBot();
  const isItem = !('slug' in listing); // ItemListing lacks `slug`

  let text: string;
  if (isItem) {
    text = formatRichItemNotification(listing as ItemListing, parsedData as ParsedItemData | undefined);
  } else {
    text = formatRichRentalNotification(listing as Listing, parsedData as ParsedRentalData | undefined, locationScore ?? undefined, fitReason);
  }

  // Split long cards to stay under Telegram's 4096 char limit
  const chunks = splitMessage(text);
  const photos = listing.photos;

  // Try photo+caption for short single-chunk cards (visible length, not raw HTML length)
  if (chunks.length === 1 && captionLength(text) <= CAPTION_LIMIT && photos.length > 0) {
    try {
      await sendPhotoAlbum(bot, chatId, photos, text);
      return;
    } catch {
      // Fallback to text + separate photos below
    }
  }

  // Send text chunks — mustSend throws on total failure so scheduler retries next cycle
  for (const chunk of chunks) {
    await mustSend(bot, chatId, chunk, { parse_mode: 'HTML', disable_web_page_preview: false });
  }
  if (photos.length > 0) {
    try { await sendPhotoAlbum(bot, chatId, photos); } catch { /* photos are best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Wrapper functions for the AI agent
// ---------------------------------------------------------------------------

type SendFn = (chatId: number | string, text: string, opts?: Record<string, unknown>) => Promise<void>;
type SendPhotosFn = (chatId: number | string, urls: string[], caption?: string) => Promise<void>;

/** Strip all HTML tags for plain text fallback — never show raw <tg-emoji> to user.
 *  Uses sanitize-html with allowedTags:[] to handle all edge cases (unclosed, nested, malformed). */
function stripHtml(html: string): string {
  // First: convert tg-emoji to their fallback emoji text before stripping
  const withFallbackEmoji = html.replace(/<tg-emoji[^>]*>([^<]*)<\/tg-emoji>/g, '$1');
  // Then: strip ALL remaining tags using sanitize-html (handles malformed/unclosed tags correctly)
  return sanitizeHtml(withFallbackEmoji, { allowedTags: [], allowedAttributes: {} })
    .replace(/\n{3,}/g, '\n\n').trim();
}

// Safe sendMessage wrapper — catches errors, retries with stripped HTML on parse failures
async function safeSend(bot: TelegramBot, chatId: number | string, text: string, opts?: TelegramBot.SendMessageOptions): Promise<void> {
  try {
    await bot.sendMessage(chatId, text, opts);
  } catch (err) {
    console.error('[telegram] sendMessage failed:', err instanceof Error ? err.message : err);
    // If HTML parsing failed, retry as plain text (strip all tags). Carry the caller's
    // notification preference so a silent message (e.g. rejection card) stays silent.
    if (opts?.parse_mode && err instanceof Error && err.message.includes("can't parse entities")) {
      try {
        const plain = stripHtml(text);
        await bot.sendMessage(chatId, plain, opts?.disable_notification ? { disable_notification: true } : undefined);
      } catch (retryErr) {
        console.error('[telegram] Plain text fallback also failed:', retryErr instanceof Error ? retryErr.message : retryErr);
      }
    }
  }
}

/** Family-broadcast send: renders Markdown→HTML ONCE, then fans out to every member. */
function makeBroadcastSendFn(bot: TelegramBot): SendFn {
  return async (_chatId, text, opts?) => {
    // If no explicit parse_mode override, transform Claude's Markdown to HTML (once, not per recipient)
    const finalText = (!opts || !('parse_mode' in opts)) ? mdToHtml(text) : text;
    const sendOpts = { parse_mode: 'HTML', ...opts } as TelegramBot.SendMessageOptions;
    await broadcastToFamily((id) => safeSend(bot, id, finalText, sendOpts));
  };
}

/** Best-effort echo of one member's question to the OTHER members (not the asker),
 *  so the shared thread shows who asked what. Never blocks the reply. */
function makeEchoFn(bot: TelegramBot): (askerChatId: number, senderName: string, text: string) => void {
  return (askerChatId, senderName, text) => {
    for (const id of getAuthorizedTelegramIds()) {
      if (id === askerChatId) continue;
      // Plain text (no parse_mode) — avoids having to HTML-escape arbitrary user input.
      safeSend(bot, id, `👤 ${senderName}: ${text}`).catch(() => {});
    }
  };
}

function makeSendPhotosFn(bot: TelegramBot): SendPhotosFn {
  return (chatId, urls, caption?) => sendPhotoAlbum(bot, chatId, urls, caption);
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

  const sendFn = makeBroadcastSendFn(bot);
  const sendPhotosFn = wrapBroadcastPhotos(makeSendPhotosFn(bot));
  const echoFn = makeEchoFn(bot);

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
  // Whole body wrapped: an uncaught throw here (e.g. a DB error in ensureAuth) would become
  // an unhandledRejection and main.ts hard-exits the process, killing the bot for everyone.
  bot.on('message', async (msg: Msg) => {
    try {
      const text = (msg.text ?? '').trim();
      if (!text) return;

      // Log custom emoji entities for collecting emoji IDs
      const customEmojis = (msg.entities ?? []).filter((e: any) => e.type === 'custom_emoji');
      if (customEmojis.length > 0) {
        for (const e of customEmojis) {
          const emojiChar = text.slice(e.offset, e.offset + e.length);
          console.log(`[emoji] Custom emoji: "${emojiChar}" → id: ${(e as any).custom_emoji_id}`);
        }
      }

      // /start and /help are handled above — skip them here
      if (/^\/start\b/.test(text) || /^\/help\b/.test(text)) return;

      if (!(await ensureAuth(msg))) return;

      const userId = msg.from!.id;
      const chatId = msg.chat.id;
      const senderName = msg.from?.first_name ?? msg.from?.username ?? String(userId);

      const typingFn = async (cid: number) => { await bot.sendChatAction(cid, 'typing'); };

      // Show the other members what was asked (best-effort, never blocks the reply).
      echoFn(chatId, senderName, text);

      await handleUserMessage(userId, chatId, text, senderName, sendFn, sendPhotosFn, typingFn);
    } catch (err) {
      console.error(`[telegram] message handler error for user ${msg.from?.id}:`, err);
      try { await safeSend(bot, msg.chat.id, 'Something went wrong. Please try again later.'); } catch { /* best-effort */ }
    }
  });

  console.log('Telegram bot started (polling)');
  return bot;
}
