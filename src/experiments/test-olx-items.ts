// Test OLX items crawler with various queries
// Run: npx tsx src/experiments/test-olx-items.ts

import { searchItems, fetchItemPhone, OLX_CITIES } from '../crawlers/olx-items.js';
import { writeFileSync, mkdirSync } from 'fs';

mkdirSync('.local/recon', { recursive: true });

async function main() {
  console.log('=== OLX Items Crawler Test ===\n');

  // Test queries for different used item types
  const queries = [
    { query: 'rower miejski', label: 'City bikes' },
    { query: 'iPhone 14', label: 'iPhone 14' },
    { query: 'kanapa narożnik', label: 'Corner sofas' },
    { query: 'PlayStation 5', label: 'PS5' },
    { query: 'biurko', label: 'Desks' },
  ];

  for (const { query, label } of queries) {
    console.log(`--- ${label}: "${query}" (Warsaw) ---`);
    const result = await searchItems({
      query,
      cityId: OLX_CITIES.WARSZAWA,
      limit: 3,
    });

    console.log(`  Total: ${result.totalAvailable} items`);
    for (const item of result.items) {
      console.log(`  [${item.platformId}] ${item.title}`);
      console.log(`    ${item.price} ${item.currency}${item.negotiable ? ' (negocjuj)' : ''} | ${item.condition ?? 'n/a'}`);
      console.log(`    ${item.city}, ${item.district ?? item.region} | Photos: ${item.photos.length}`);
      console.log(`    Params: ${Object.entries(item.params).filter(([k]) => k !== 'price').map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
    console.log('');
  }

  // Test with phone number
  const phoneTest = await searchItems({ query: 'monitor', cityId: OLX_CITIES.WARSZAWA, limit: 1 });
  if (phoneTest.items.length > 0) {
    const item = phoneTest.items[0];
    console.log(`--- Phone test: ${item.title} ---`);
    const phone = await fetchItemPhone(item.platformId);
    console.log(`  Phone: ${phone ?? 'none'}`);
  }

  // Save sample results
  const fullResult = await searchItems({ query: 'rower', cityId: OLX_CITIES.WARSZAWA, limit: 10 });
  writeFileSync('.local/recon/olx-items-test.json', JSON.stringify(fullResult.items, null, 2), { encoding: 'utf-8' });
  console.log(`\nSaved ${fullResult.items.length} items to .local/recon/olx-items-test.json`);
}

main().catch(console.error);
