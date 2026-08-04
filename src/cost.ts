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
  /** false when the base rent is missing / "zapytaj o cenę" (price<=0): `total` is then just
   *  czynsz+media, NOT the real monthly cost, so it must not be treated as a budget figure. */
  basePriceKnown: boolean;
}

// Display order for the utility breakdown.
const MEDIA_ORDER: Array<{ key: keyof ParsedRentalData['estimatedMedia']; label: string }> = [
  { key: 'electricity', label: 'electricity' },
  { key: 'water', label: 'water' },
  { key: 'gas', label: 'gas' },
  { key: 'heating', label: 'heating' },
  { key: 'internet', label: 'internet' },
  { key: 'other', label: 'media' }, // lump zaliczka / undifferentiated "media ~X"
];

/** Display unit for a listing's price amount: 'zł' for PLN (the overwhelming common case), else the
 *  raw currency code — so a non-PLN reject message doesn't mislabel e.g. a EUR figure as zł. */
export function priceUnit(currency?: string | null): string {
  return (currency ?? 'PLN') === 'PLN' ? 'zł' : (currency as string);
}

/** Safe pre-parse budget skip: najem (base rent) alone is a guaranteed lower bound on the
 *  true total — czynsz/media are >= 0 and the AI may even refine czynsz below the crawler's
 *  value, so gating on price+rent could wrongly drop an in-budget flat. Gate on najem only.
 *  Only meaningful for a PLN price: a non-PLN number isn't comparable to a PLN budget, so let it
 *  fall through to the soft "бюджет не проверить" path (basePriceKnown) rather than hard-drop it. */
export function exceedsBudgetFloor(listing: Pick<Listing, 'price' | 'currency'>, priceTo: number): boolean {
  return (listing.currency ?? 'PLN') === 'PLN' && listing.price > priceTo;
}

export function computeRentalCost(
  listing: Pick<Listing, 'price' | 'rent'> & { currency?: string },
  parsed: ParsedRentalData | null | undefined,
): RentalCost {
  const najem = listing.price ?? 0;
  // Only a PLN base rent is a verifiable budget figure; a non-PLN listing (rare, e.g. EUR) must not
  // be summed/ranked as if the number were PLN — treat it like an unknown price.
  const basePriceKnown = najem > 0 && (listing.currency ?? 'PLN') === 'PLN';
  // Floor components at 0: the schema tolerates a wrong TYPE but not a negative VALUE, and a
  // hallucinated negative adminFee/utility (e.g. a "discount") would understate cost.total and could
  // slip a genuinely over-budget flat under the hard budget_max gate — defeating the whole reason the
  // total is computed in code rather than trusted from the LLM.
  const czynsz = Math.max(0, parsed?.adminFee ?? listing.rent ?? 0);

  const mediaParts: Array<{ label: string; value: number }> = [];
  const media = parsed?.estimatedMedia;
  if (media) {
    for (const { key, label } of MEDIA_ORDER) {
      const value = media[key];
      if (value != null && value > 0) mediaParts.push({ label, value });
    }
  }
  const mediaSum = mediaParts.reduce((sum, p) => sum + p.value, 0);

  return { najem, czynsz, mediaParts, mediaSum, total: najem + czynsz + mediaSum, basePriceKnown };
}
