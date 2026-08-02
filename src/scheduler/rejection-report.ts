// Builds the once-per-day aggregated monitor rejection report (Telegram HTML).
// Pure + unit-testable: given the rejection rows since the last report, produce
// the digest text (or null when there is nothing to report).
//
// Layout:
//   📋 Монитор за сутки — отклонено N
//
//   Стоит взглянуть:                        ← SOFT ("close enough") — links so you can reconsider
//   • дороже бюджета (3): <a>t1</a>, <a>t2</a>, <a>t3</a>
//   • далеко до удобств (1): <a>t</a>
//
//   Явно мимо: комната/подселение 40 · не по комнатам 8 · не квартира 5   ← HARD — tally only

import type { MonitorRejectionRow } from '../storage/db.js';
import { REJECTION_LABEL, type RejectionCategory } from '../search/rejection.js';

/** Max links listed per soft category before collapsing the rest into "+N". */
const SOFT_LINK_CAP = 5;

/** Fixed display order → deterministic output (and stable tests). */
const SOFT_ORDER: RejectionCategory[] = ['budget_max', 'budget_min', 'contract', 'amenity', 'criteria', 'error'];
const HARD_ORDER: RejectionCategory[] = ['room_coliving', 'room_count', 'not_concrete', 'budget_floor'];

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function link(row: MonitorRejectionRow): string {
  const title = esc((row.title || 'объявление').slice(0, 40));
  return `<a href="${esc(row.url)}">${title}</a>`;
}

export function buildRejectionReport(rows: MonitorRejectionRow[]): string | null {
  if (rows.length === 0) return null;

  // One physical flat can be rejected by several overlapping monitors in the same window; count it
  // once (first rejection wins) so the "отклонено N" header and per-category lists don't inflate.
  const seenListing = new Set<string>();
  rows = rows.filter((r) => {
    const key = `${r.platform}:${r.platform_id}`;
    if (seenListing.has(key)) return false;
    seenListing.add(key);
    return true;
  });
  if (rows.length === 0) return null;

  const byCat = new Map<string, MonitorRejectionRow[]>();
  for (const r of rows) {
    const arr = byCat.get(r.category);
    if (arr) arr.push(r);
    else byCat.set(r.category, [r]);
  }

  const lines: string[] = [`📋 <b>Монитор за сутки</b> — отклонено ${rows.length}`];

  // SOFT ("close enough") — label + links, capped.
  const softLines: string[] = [];
  for (const cat of SOFT_ORDER) {
    const items = byCat.get(cat);
    if (!items || items.length === 0) continue;
    const shown = items.slice(0, SOFT_LINK_CAP).map(link).join(', ');
    const extra = items.length > SOFT_LINK_CAP ? ` +${items.length - SOFT_LINK_CAP}` : '';
    softLines.push(`• ${REJECTION_LABEL[cat]} (${items.length}): ${shown}${extra}`);
  }
  if (softLines.length > 0) {
    lines.push('', '<b>Стоит взглянуть:</b>', ...softLines);
  }

  // HARD ("definitely not") — tally only.
  const hardTally: string[] = [];
  for (const cat of HARD_ORDER) {
    const items = byCat.get(cat);
    if (!items || items.length === 0) continue;
    hardTally.push(`${REJECTION_LABEL[cat]} ${items.length}`);
  }
  // Defensive: any category not in either fixed order (e.g. a future one added without updating
  // this file) is still tallied under its raw label, so the "отклонено N" header always equals
  // the sum of what's shown — a stray category can never be silently dropped from the report.
  const KNOWN = new Set<string>([...SOFT_ORDER, ...HARD_ORDER]);
  for (const [cat, items] of byCat) {
    if (KNOWN.has(cat) || items.length === 0) continue;
    hardTally.push(`${cat} ${items.length}`);
  }
  if (hardTally.length > 0) {
    lines.push('', `<b>Явно мимо:</b> ${hardTally.join(' · ')}`);
  }

  return lines.join('\n');
}
