import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOtodomDetailAd } from '../src/crawlers/otodom.js';
import { computeRentalCost } from '../src/cost.js';

// The Otodom __NEXT_DATA__ `target` block stores values as strings. Ensure the price
// fallback is numeric-coerced so it can't string-concatenate in computeRentalCost.
test('detail price falls back to numeric target.Price (not a string)', () => {
  const ad = {
    id: 1, slug: 's', title: 't', description: '',
    price: null,                       // ad.price.value absent → fall back to target.Price
    target: { Price: '3000', Rent: '500', Area: '55', Rooms_num: ['3'] },
    location: { address: {} },
  };
  const listing = parseOtodomDetailAd(ad)!;
  assert.equal(typeof listing.price, 'number');
  assert.equal(listing.price, 3000);
  // The whole point: total must add, not concatenate.
  assert.equal(computeRentalCost(listing, null).total, 3000 + 500);
});

test('detail price prefers ad.price.value when present', () => {
  const ad = { id: 2, slug: 's', title: 't', description: '', price: { value: 4200, currency: 'PLN' }, target: { Price: '9999' }, location: { address: {} } };
  assert.equal(parseOtodomDetailAd(ad)!.price, 4200);
});
