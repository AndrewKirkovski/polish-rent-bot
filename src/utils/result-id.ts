// Short human-readable listing result IDs (shared by search + monitor).

import { customAlphabet } from 'nanoid';

/** Unambiguous alphabet: no 0/O, 1/I/L, U/V confusion. */
const alphabet = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export const genResultId = customAlphabet(alphabet, 6);

/** Matches `[ABC123]` / `<b>[ABC123]</b>` style codes in Telegram text/captions. */
export const RESULT_ID_RE = /\[([23456789ABCDEFGHJKMNPQRSTVWXYZ]{6})\]/;

export function extractResultId(text: string | undefined | null): string | null {
  if (!text) return null;
  // Strip simple HTML tags so `<b>[ABC123]</b>` still matches.
  const plain = text.replace(/<[^>]+>/g, '');
  const m = plain.match(RESULT_ID_RE);
  return m?.[1] ?? null;
}

export function prefixResultIdHtml(resultId: string, cardHtml: string): string {
  return `<b>[${resultId}]</b>\n${cardHtml}`;
}

export function prefixResultIdPlain(resultId: string, cardHtml: string): string {
  return `[${resultId}] ${cardHtml}`;
}
