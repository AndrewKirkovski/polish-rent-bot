// Shared HTML escaping for Telegram HTML parse_mode (was copy-pasted across format/tools/report).

/** Escape &, <, > for Telegram HTML parse_mode. Null/undefined → '' so it's safe on optional text. */
export function escapeHtml(text: string | number | null | undefined): string {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
