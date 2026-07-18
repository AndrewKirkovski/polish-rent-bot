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
    target: { Price: '3000', Rent: '500', Area: '55', Rooms_num: ['3'], Floor_no: ['floor_4'], Building_floors_num: '8' },
    location: { address: {} },
  };
  const listing = parseOtodomDetailAd(ad)!;
  assert.equal(typeof listing.price, 'number');
  assert.equal(listing.price, 3000);
  // The whole point: total must add, not concatenate.
  assert.equal(computeRentalCost(listing, null).total, 3000 + 500);
  // Detail floor is "floor_N", not the search-item enum — must parse to a number.
  assert.equal(listing.floor, 4);
  assert.equal(listing.buildingFloor, 8);
});

test('detail floor handles ground_floor', () => {
  const ad = { id: 3, slug: 's', title: 't', description: '', price: { value: 3000 }, target: { Floor_no: ['ground_floor'] }, location: { address: {} } };
  assert.equal(parseOtodomDetailAd(ad)!.floor, 0);
});

test('detail price prefers ad.price.value when present', () => {
  const ad = { id: 2, slug: 's', title: 't', description: '', price: { value: 4200, currency: 'PLN' }, target: { Price: '9999' }, location: { address: {} } };
  assert.equal(parseOtodomDetailAd(ad)!.price, 4200);
});
