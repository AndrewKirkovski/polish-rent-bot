// Deterministic rental cost computation.
//
// The LLM is unreliable at arithmetic (it has produced totals that don't add up),
// so the monthly total and its breakdown are computed HERE in code from the
// structured numeric fields the parse extracts — rent (najem) + czynsz
// administracyjny + estimated utilities — never from any LLM-written total.

import type { Listing, ParsedRentalData } from './types.js';

export interface RentalCost {
  najem: number; // advertised monthly rent (listing.price)
  czynsz: number; // czynsz administracyjny (admin fee)
  mediaParts: Array<{ label: string; value: number }>; // utilities paid on top of czynsz
  mediaSum: number; // sum of mediaParts
  total: number; // najem + czynsz + mediaSum
}

// Display order for the utility breakdown.
const MEDIA_ORDER: Array<{ key: keyof ParsedRentalData['estimatedMedia']; label: string }> = [
  { key: 'electricity', label: 'electricity' },
  { key: 'water', label: 'water' },
  { key: 'gas', label: 'gas' },
  { key: 'heating', label: 'heating' },
  { key: 'internet', label: 'internet' },
];

/** Safe pre-parse budget skip: najem (base rent) alone is a guaranteed lower bound on the
 *  true total — czynsz/media are >= 0 and the AI may even refine czynsz below the crawler's
 *  value, so gating on price+rent could wrongly drop an in-budget flat. Gate on najem only. */
export function exceedsBudgetFloor(listing: Pick<Listing, 'price'>, priceTo: number): boolean {
  return listing.price > priceTo;
}

export function computeRentalCost(
  listing: Pick<Listing, 'price' | 'rent'>,
  parsed: ParsedRentalData | null | undefined,
): RentalCost {
  const najem = listing.price ?? 0;
  const czynsz = parsed?.adminFee ?? listing.rent ?? 0;

  const mediaParts: Array<{ label: string; value: number }> = [];
  const media = parsed?.estimatedMedia;
  if (media) {
    for (const { key, label } of MEDIA_ORDER) {
      const value = media[key];
      if (value != null) mediaParts.push({ label, value });
    }
  }
  const mediaSum = mediaParts.reduce((sum, p) => sum + p.value, 0);

  return { najem, czynsz, mediaParts, mediaSum, total: najem + czynsz + mediaSum };
}
