import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REJECTION_TIER, isSoftRejection, type RejectionCategory } from '../src/search/rejection.js';
import { buildRejectionReport } from '../src/scheduler/rejection-report.js';
import type { MonitorRejectionRow } from '../src/storage/db.js';

// --- taxonomy ---------------------------------------------------------------

test('hard rejects are the structural/gross ones ("definitely not")', () => {
  for (const cat of ['room_coliving', 'room_count', 'not_concrete', 'budget_floor'] as RejectionCategory[]) {
    assert.equal(REJECTION_TIER[cat], 'hard', cat);
    assert.equal(isSoftRejection(cat), false, cat);
  }
});

test('soft rejects are the borderline ones ("close enough")', () => {
  for (const cat of ['budget_max', 'budget_min', 'contract', 'amenity', 'criteria', 'error'] as RejectionCategory[]) {
    assert.equal(REJECTION_TIER[cat], 'soft', cat);
    assert.equal(isSoftRejection(cat), true, cat);
  }
});

// --- report builder ---------------------------------------------------------

let seq = 0;
function mkRow(category: RejectionCategory, over: Partial<MonitorRejectionRow> = {}): MonitorRejectionRow {
  seq++;
  return {
    id: seq,
    monitor_id: 1,
    platform: 'olx',
    platform_id: `p${seq}`,
    title: `Квартира ${seq}`,
    url: `https://example.com/${seq}`,
    price: 3000,
    category,
    reason: null,
    rejected_at: '2026-07-19 07:00:00',
    ...over,
  };
}

test('empty rows → no report (do not broadcast an empty digest)', () => {
  assert.equal(buildRejectionReport([]), null);
});

test('total count line reflects all rows', () => {
  const out = buildRejectionReport([mkRow('budget_max'), mkRow('room_coliving'), mkRow('amenity')])!;
  assert.match(out, /отклонено 3/);
});

test('soft rejects listed with links under "Стоит взглянуть"', () => {
  const out = buildRejectionReport([mkRow('budget_max'), mkRow('budget_max')])!;
  assert.match(out, /Стоит взглянуть:/);
  assert.match(out, /дороже бюджета \(2\):/);
  assert.equal((out.match(/<a href="https:\/\/example\.com\//g) ?? []).length, 2);
  assert.doesNotMatch(out, /Явно мимо/); // no hard rows
});

test('hard rejects tallied under "Явно мимо" with no links', () => {
  const rows = [mkRow('room_coliving'), mkRow('room_coliving'), mkRow('room_coliving'), mkRow('room_count'), mkRow('room_count')];
  const out = buildRejectionReport(rows)!;
  assert.match(out, /Явно мимо:.*комната\/подселение 3/);
  assert.match(out, /не по комнатам 2/);
  assert.doesNotMatch(out, /Стоит взглянуть/); // no soft rows
  assert.doesNotMatch(out, /<a href=/);        // hard rows are tally-only, never linked
});

test('soft link list caps at 5 and collapses the rest into "+N"', () => {
  const rows = Array.from({ length: 7 }, () => mkRow('budget_max'));
  const out = buildRejectionReport(rows)!;
  assert.match(out, /дороже бюджета \(7\):/);
  assert.equal((out.match(/<a href=/g) ?? []).length, 5); // only 5 links shown
  assert.match(out, /\+2/);                                // remaining 2 collapsed
});

test('location rejects show their reason, so an inferred verdict is not read as a measured one', () => {
  const reason = 'метро: Wilanowska, ~2,6 км–5,0 км, ~33–65 мин пешком (лимит 7 мин) — оценка по примерной локации ±1,2 км';
  const out = buildRejectionReport([mkRow('amenity', { reason })])!;
  assert.match(out, /~33–65 мин пешком/);
  assert.match(out, /оценка по примерной локации/);
  // Other soft categories stay compact — one line, links only.
  const budget = buildRejectionReport([mkRow('budget_max', { reason: 'дороже на 400 zł' })])!;
  assert.doesNotMatch(budget, /дороже на 400/);
});

test('an over-long location reason is trimmed rather than blowing the message limit', () => {
  const out = buildRejectionReport([mkRow('amenity', { reason: 'м'.repeat(400) })])!;
  assert.match(out, /…/);
  assert.ok(out.length < 400, `expected a trimmed line, got ${out.length} chars`);
});

test('a location reject with no recorded reason still renders as a link', () => {
  const out = buildRejectionReport([mkRow('amenity', { reason: null })])!;
  assert.match(out, /далеко до удобств \(1\)/);
  assert.match(out, /<a href="https:\/\/example\.com\//);
  assert.doesNotMatch(out, /[·—]\s*$/m, 'no dangling separator when there is no reason');
});

test('titles are HTML-escaped in links', () => {
  const out = buildRejectionReport([mkRow('amenity', { title: 'Loft <b>& sauna</b>' })])!;
  assert.match(out, /Loft &lt;b&gt;&amp; sauna/);
  assert.doesNotMatch(out, /<b>& sauna/); // raw markup must not leak
});

test('unknown category is still tallied so the header count never overstates', () => {
  const out = buildRejectionReport([mkRow('budget_max'), mkRow('mystery_new' as RejectionCategory)])!;
  assert.match(out, /отклонено 2/);                 // both counted
  assert.match(out, /Явно мимо:.*mystery_new 1/);   // stray category shown, not silently dropped
});

test('mixed soft + hard → both sections present, soft above hard', () => {
  const out = buildRejectionReport([mkRow('budget_max'), mkRow('room_coliving')])!;
  const softIdx = out.indexOf('Стоит взглянуть');
  const hardIdx = out.indexOf('Явно мимо');
  assert.ok(softIdx > 0 && hardIdx > 0);
  assert.ok(softIdx < hardIdx, 'soft section should come before hard tally');
});
