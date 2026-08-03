// Shared HTML escaping for Telegram HTML parse_mode (was copy-pasted across format/tools/report).

/** Escape &, <, > for Telegram HTML parse_mode. Null/undefined → '' so it's safe on optional text. */
export function escapeHtml(text: string | number | null | undefined): string {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** sanitize-html options that keep only Telegram-supported tags (was duplicated in format + telegram). */
export const TELEGRAM_SANITIZE = {
  allowedTags: ['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
                'a', 'code', 'pre', 'blockquote', 'tg-emoji', 'tg-spoiler', 'span'],
  allowedAttributes: { 'a': ['href'], 'tg-emoji': ['emoji-id'], 'code': ['class'], 'span': ['class'], 'blockquote': ['expandable'] },
  transformTags: { 'strong': 'b', 'em': 'i', 'ins': 'u', 'strike': 's', 'del': 's' },
};
