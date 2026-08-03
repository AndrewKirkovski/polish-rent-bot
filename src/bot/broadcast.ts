// Family broadcast — fan out Telegram messages to all authorized users.

import { getAuthorizedTelegramIds } from '../storage/db.js';

const BROADCAST_STAGGER_MS = 200;

export type BroadcastPhotosFn = (
  chatId: number | string,
  urls: string[],
  caption?: string,
  meta?: { resultId?: string },
) => Promise<void>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function broadcastToFamily(
  sendToOne: (chatId: number) => Promise<void>,
  opts: { retries?: number } = {},
): Promise<{ delivered: number; failed: number[]; deliveredIds: number[] }> {
  const ids = getAuthorizedTelegramIds();
  let delivered = 0;
  // Retry recipients that failed — a transient Telegram 429/timeout on one member must not
  // permanently drop that member's alert (the scheduler marks it notified household-wide).
  let pending = [...ids];
  const retries = opts.retries ?? 1;

  for (let attempt = 0; attempt <= retries && pending.length > 0; attempt++) {
    if (attempt > 0) await sleep(1000 * attempt); // backoff before retrying transient failures
    const stillFailed: number[] = [];
    for (let i = 0; i < pending.length; i++) {
      const chatId = pending[i]!;
      try {
        await sendToOne(chatId);
        delivered++;
      } catch (err) {
        console.error(`[broadcast] Failed for chat ${chatId} (attempt ${attempt + 1}):`, err instanceof Error ? err.message : err);
        stillFailed.push(chatId);
      }
      if (i < pending.length - 1) await sleep(BROADCAST_STAGGER_MS);
    }
    pending = stillFailed;
  }

  return { delivered, failed: pending, deliveredIds: ids.filter((id) => !pending.includes(id)) };
}

/** Throw only if NOBODY received the message — used by scheduler to decide whether to
 *  mark a listing seen. At-least-one-success counts as delivered: a single bad family
 *  member (e.g. blocked/invalid chat) must not block markListingSeen for everyone else,
 *  otherwise the healthy members get the same listing re-delivered every cycle. */
export function assertBroadcastOk(result: { delivered: number; failed: number[] }, context: string): void {
  if (result.delivered === 0) {
    throw new Error(`${context}: no authorized users received the message`);
  }
  if (result.failed.length > 0) {
    console.warn(`[broadcast] ${context}: delivered to ${result.delivered}, failed for chat IDs ${result.failed.join(', ')}`);
  }
}

export function wrapBroadcastPhotos(baseSend: BroadcastPhotosFn): BroadcastPhotosFn {
  return async (_chatId, urls, caption, meta) => {
    const result = await broadcastToFamily((id) => baseSend(id, urls, caption, meta));
    // Surface a TOTAL failure (nobody received the photo — e.g. expired CDN URLs or a caption
    // Telegram rejects) so the caller's try/catch text fallback is reachable; otherwise
    // sendRentalCard/sendItemCard would return having sent nothing. Partial delivery is fine.
    assertBroadcastOk(result, 'Card photos');
  };
}
