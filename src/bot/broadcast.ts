// Family broadcast — fan out Telegram messages to all authorized users.

import { getAuthorizedTelegramIds } from '../storage/db.js';

const BROADCAST_STAGGER_MS = 200;

export type BroadcastPhotosFn = (
  chatId: number | string,
  urls: string[],
  caption?: string,
) => Promise<void>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function broadcastToFamily(
  sendToOne: (chatId: number) => Promise<void>,
): Promise<{ delivered: number; failed: number[] }> {
  const ids = getAuthorizedTelegramIds();
  const failed: number[] = [];
  let delivered = 0;

  for (let i = 0; i < ids.length; i++) {
    const chatId = ids[i]!;
    try {
      await sendToOne(chatId);
      delivered++;
    } catch (err) {
      console.error(`[broadcast] Failed for chat ${chatId}:`, err instanceof Error ? err.message : err);
      failed.push(chatId);
    }
    if (i < ids.length - 1) await sleep(BROADCAST_STAGGER_MS);
  }

  return { delivered, failed };
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
  return async (_chatId, urls, caption) => {
    await broadcastToFamily((id) => baseSend(id, urls, caption));
  };
}
