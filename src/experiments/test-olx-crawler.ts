// Test the OLX crawler module end-to-end
// Run: npx tsx src/experiments/test-olx-crawler.ts

import { searchOlx, fetchOlxPhone, fetchAllPages, OLX_CATEGORIES, OLX_CITIES } from '../crawlers/olx.js';
import { writeFileSync, mkdirSync } from 'fs';

mkdirSync('.local/recon', { recursive: true });

async function main() {
  console.log('=== OLX Crawler Test ===\n');

  // 1. Single page search
  console.log('--- Single Page Search: Warsaw Apartments ---');
  const result = await searchOlx({
    categoryId: OLX_CATEGORIES.MIESZKANIA_WYNAJEM,
    cityId: OLX_CITIES.WARSZAWA,
    limit: 5,
  });

  console.log(`Total available: ${result.totalAvailable}`);
  console.log(`Got: ${result.listings.length} listings`);
  console.log(`Has next: ${result.hasNextPage}`);

  for (const l of result.listings) {
    console.log(`\n  [${l.platformId}] ${l.title}`);
    console.log(`    Price: ${l.price} PLN + rent: ${l.rent ?? 'n/a'} PLN`);
    console.log(`    Area: ${l.area}m² | Rooms: ${l.rooms} | Floor: ${l.floor}`);
    console.log(`    Location: ${l.city}, ${l.district ?? l.region}`);
    console.log(`    Type: ${l.advertiserType} | Building: ${l.buildingType}`);
    console.log(`    Photos: ${l.photos.length} | Furniture: ${l.furniture}`);
    console.log(`    Created: ${l.createdAt}`);
  }

  // 2. Phone number fetch
  if (result.listings.length > 0) {
    const first = result.listings[0];
    console.log(`\n--- Phone Test (offer ${first.platformId}) ---`);
    const phone = await fetchOlxPhone(first.platformId);
    console.log(`Phone: ${phone ?? 'none'}`);
  }

  // 3. Multi-page fetch (2 pages only for test)
  console.log('\n--- Multi-Page Fetch (2 pages) ---');
  const all = await fetchAllPages({
    categoryId: OLX_CATEGORIES.MIESZKANIA_WYNAJEM,
    cityId: OLX_CITIES.WARSZAWA,
    limit: 10,
  }, 2);
  console.log(`Total fetched: ${all.length} listings`);

  // 4. Save results
  writeFileSync('.local/recon/olx-crawler-test.json', JSON.stringify(all, null, 2), { encoding: 'utf-8' });
  console.log(`Saved to .local/recon/olx-crawler-test.json`);

  console.log('\nDone.');
}

main().catch(console.error);
