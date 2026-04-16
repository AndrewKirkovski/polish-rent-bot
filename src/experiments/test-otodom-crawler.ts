// Test the Otodom crawler module end-to-end
// Run: npx tsx src/experiments/test-otodom-crawler.ts

import { searchOtodom, fetchOtodomDetail, closeBrowser } from '../crawlers/otodom.js';
import { writeFileSync, mkdirSync } from 'fs';

mkdirSync('.local/recon', { recursive: true });

async function main() {
  console.log('=== Otodom Crawler Test ===\n');

  try {
    // 1. Search page
    console.log('--- Search: Warsaw Apartments for Rent ---');
    const result = await searchOtodom({
      type: 'wynajem',
      estate: 'mieszkanie',
      province: 'mazowieckie',
      city: 'warszawa',
      limit: 36,
    });

    console.log(`\nTotal available: ${result.totalAvailable}`);
    console.log(`Got: ${result.listings.length} listings`);
    console.log(`Has next: ${result.hasNextPage}`);

    for (const l of result.listings.slice(0, 5)) {
      console.log(`\n  [${l.platformId}] ${l.title}`);
      console.log(`    Price: ${l.price} PLN | Rent: ${l.rent ?? 'n/a'} | Deposit: ${l.deposit ?? 'n/a'}`);
      console.log(`    Area: ${l.area}m² | Rooms: ${l.rooms} | Floor: ${l.floor}`);
      console.log(`    Location: ${l.city}, ${l.district ?? l.region}`);
      console.log(`    Type: ${l.advertiserType} | Building: ${l.buildingType}`);
      console.log(`    Phone: ${l.phone ?? 'n/a'}`);
      console.log(`    Photos: ${l.photos.length}`);
    }

    // 2. Detail page — pick first listing
    if (result.listings.length > 0) {
      const first = result.listings[0];
      console.log(`\n--- Detail: ${first.slug} ---`);
      const detail = await fetchOtodomDetail(first.url);

      if (detail) {
        console.log(`  Title: ${detail.title}`);
        console.log(`  Price: ${detail.price} PLN`);
        console.log(`  Rent: ${detail.rent ?? 'n/a'}`);
        console.log(`  Deposit: ${detail.deposit ?? 'n/a'}`);
        console.log(`  Area: ${detail.area}m²`);
        console.log(`  Rooms: ${detail.rooms}`);
        console.log(`  Floor: ${detail.floor}`);
        console.log(`  Building: ${detail.buildingType}`);
        console.log(`  Heating: ${detail.heating}`);
        console.log(`  Parking: ${detail.parking}`);
        console.log(`  Street: ${detail.street}`);
        console.log(`  Coords: ${detail.lat}, ${detail.lng}`);
        console.log(`  Phone: ${detail.phone ?? 'NOT AVAILABLE (needs login?)'}`);
        console.log(`  Contact: ${detail.contactName}`);
        console.log(`  Advertiser: ${detail.advertiserType}`);
        console.log(`  Agency: ${detail.agencyName ?? 'none'}`);
        console.log(`  Description: ${detail.description?.slice(0, 200)}...`);
        console.log(`  Photos: ${detail.photos.length}`);

        writeFileSync('.local/recon/otodom-crawler-detail.json', JSON.stringify(detail, null, 2), { encoding: 'utf-8' });
        console.log(`\n  Saved to .local/recon/otodom-crawler-detail.json`);
      }
    }

    // Save search results
    writeFileSync('.local/recon/otodom-crawler-test.json', JSON.stringify(result.listings, null, 2), { encoding: 'utf-8' });
    console.log(`\nSaved ${result.listings.length} search results to .local/recon/otodom-crawler-test.json`);

  } finally {
    await closeBrowser();
  }

  console.log('\nDone.');
}

main().catch(console.error);
