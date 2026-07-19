// Shared rejection taxonomy — classifies WHY a listing was rejected into a
// "soft" (close enough — worth a look) vs "hard" (definitely not) tier, plus a
// short Russian label.
//
// Used by two callers so the two paths stay consistent:
//  - interactive search (src/ai/tools.ts): SHOW soft rejects (❌ card), stay SILENT on hard ones.
//  - once-per-day monitor report (src/scheduler/rejection-report.ts): list soft rejects with
//    links ("стоит взглянуть"), tally hard ones ("явно мимо").

export type RejectionCategory =
  | 'room_coliving' // triage: a room / coliving offer, not a whole apartment
  | 'room_count'    // wrong number of rooms
  | 'not_concrete'  // aggregator / investment / price-range post — not one concrete flat
  | 'budget_floor'  // base rent ALONE already over the max budget (grossly over)
  | 'budget_max'    // estimated total a bit over the max budget
  | 'budget_min'    // estimated total under the min budget
  | 'contract'      // contract type differs from the requested one
  | 'amenity'       // too far from a required amenity / commute
  | 'criteria'      // matched the user's explicit exclude-criteria
  | 'error';        // processing error while analyzing the listing

export type RejectionTier = 'soft' | 'hard';

/** "hard" = definitely not (structurally wrong) → silent in manual, tally-only in the report.
 *  "soft" = close enough (borderline) → shown in manual, listed with links in the report. */
export const REJECTION_TIER: Record<RejectionCategory, RejectionTier> = {
  room_coliving: 'hard',
  room_count: 'hard',
  not_concrete: 'hard',
  budget_floor: 'hard',
  budget_max: 'soft',
  budget_min: 'soft',
  contract: 'soft',
  amenity: 'soft',
  criteria: 'soft',
  error: 'soft',
};

/** Short Russian label for the daily report. */
export const REJECTION_LABEL: Record<RejectionCategory, string> = {
  room_coliving: 'комната/подселение',
  room_count: 'не по комнатам',
  not_concrete: 'не квартира',
  budget_floor: 'аренда выше бюджета',
  budget_max: 'дороже бюджета',
  budget_min: 'дешевле мин. бюджета',
  contract: 'другой договор',
  amenity: 'далеко до удобств',
  criteria: 'по вашим критериям',
  error: 'ошибка обработки',
};

export function isSoftRejection(category: RejectionCategory): boolean {
  return REJECTION_TIER[category] === 'soft';
}
