// Test Allegro API — Device Flow auth + search
// Run: npx tsx src/experiments/test-allegro.ts
// First run: will show a URL to authorize. Open it in browser, enter the code.
// Subsequent runs: uses saved token (auto-refreshes).

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import {
  startDeviceFlow,
  pollForToken,
  getValidToken,
  searchAllegro,
} from '../crawlers/allegro.js';

mkdirSync('.local/recon', { recursive: true });

async function ensureAuth(): Promise<void> {
  try {
    await getValidToken();
    console.log('Token loaded and valid.\n');
    return;
  } catch {
    // No token — start device flow
  }

  console.log('No saved token. Starting Device Flow...\n');
  const device = await startDeviceFlow();

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  ALLEGRO AUTHORIZATION                          ║');
  console.log('║                                                  ║');
  console.log(`║  1. Open: ${device.verification_uri_complete}`);
  console.log('║                                                  ║');
  console.log(`║  2. Or go to: ${device.verification_uri}`);
  console.log(`║     and enter code: ${device.user_code}`);
  console.log('║                                                  ║');
  console.log(`║  Waiting ${device.expires_in}s for authorization...`);
  console.log('╚══════════════════════════════════════════════════╝\n');

  const token = await pollForToken(device.device_code, device.interval);
  console.log(`Authorized! Token expires in ${Math.round(token.expires_in / 3600)}h\n`);
}

async function main() {
  console.log('=== Allegro API Test ===\n');

  await ensureAuth();

  // Search tests
  const queries = [
    { phrase: 'iPhone 14', label: 'iPhone 14' },
    { phrase: 'rower miejski', label: 'City bikes' },
    { phrase: 'PlayStation 5', label: 'PS5' },
  ];

  for (const { phrase, label } of queries) {
    console.log(`--- ${label}: "${phrase}" ---`);
    try {
      const result = await searchAllegro({ phrase, limit: 5 });
      console.log(`  Total: ${result.totalAvailable} items`);

      for (const item of result.items.slice(0, 3)) {
        console.log(`  [${item.platformId}] ${item.title}`);
        console.log(`    ${item.price} ${item.currency} | ${item.params.format} | Stock: ${item.params.stock}`);
        console.log(`    Delivery: ${item.params.deliveryPrice ?? 'n/a'} | Free: ${item.params.freeDelivery}`);
        console.log(`    Photos: ${item.photos.length} | Seller: ${item.contactName} (biz: ${item.isBusiness})`);
      }
    } catch (err) {
      console.error(`  Error: ${err}`);
    }
    console.log('');
  }

  // Save full results for one query
  try {
    const full = await searchAllegro({ phrase: 'iPhone 14', limit: 10 });
    writeFileSync('.local/recon/allegro-test.json', JSON.stringify(full.items, null, 2), { encoding: 'utf-8' });
    console.log(`Saved ${full.items.length} items to .local/recon/allegro-test.json`);
  } catch (err) {
    console.error(`Save error: ${err}`);
  }
}

main().catch(console.error);
