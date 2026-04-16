// Test OLX REST API — direct HTTP, no browser needed for listings
// Discovery: OLX has /api/v1/offers/ endpoint returning JSON
// Run: npx tsx src/experiments/test-olx-api.ts

import { writeFileSync, mkdirSync } from 'fs';

const RESULTS_DIR = '.local/recon';
mkdirSync(RESULTS_DIR, { recursive: true });

// OLX REST API endpoint — category_id 15 = Mieszkania Wynajem
// Found by DEENUU1/property-aggregator and confirmed by our recon
const OLX_API_BASE = 'https://www.olx.pl/api/v1';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8',
  'Referer': 'https://www.olx.pl/',
};

async function fetchJson(url: string) {
  const res = await fetch(url, { headers: HEADERS });
  console.log(`${res.status} ${url.slice(0, 120)}`);
  if (!res.ok) {
    console.log(`  Error: ${res.statusText}`);
    const text = await res.text();
    console.log(`  Body: ${text.slice(0, 500)}`);
    return null;
  }
  return res.json();
}

async function main() {
  console.log('=== OLX REST API Test ===\n');

  // 1. Search offers — Warsaw, Mieszkania, Wynajem
  // category_id: 15 = Mieszkania Wynajem (from DEENUU1 scraper)
  // Also try filter by city
  const searchUrl = `${OLX_API_BASE}/offers/?offset=0&limit=10&category_id=15&region_id=2&city_id=17871&sort_by=created_at%3Adesc&filter_refiners=spell_checker`;
  console.log('--- Search Offers ---');
  const searchData = await fetchJson(searchUrl);

  if (searchData) {
    console.log(`\nTotal found: ${searchData.data?.length || 0} offers`);
    console.log(`Metadata:`, JSON.stringify(searchData.metadata, null, 2)?.slice(0, 500));
    console.log(`Links:`, JSON.stringify(searchData.links, null, 2)?.slice(0, 300));

    // Examine first offer structure
    const firstOffer = searchData.data?.[0];
    if (firstOffer) {
      console.log(`\n--- First Offer Structure ---`);
      console.log(`Keys: ${Object.keys(firstOffer).join(', ')}`);
      console.log(`ID: ${firstOffer.id}`);
      console.log(`Title: ${firstOffer.title}`);
      console.log(`URL: ${firstOffer.url}`);
      console.log(`Created: ${firstOffer.created_time}`);
      console.log(`Price: ${JSON.stringify(firstOffer.params?.find((p: any) => p.key === 'price') || firstOffer.price)}`);
      console.log(`Location: ${JSON.stringify(firstOffer.location)}`);
      console.log(`Params: ${JSON.stringify(firstOffer.params?.map((p: any) => `${p.key}=${p.value?.label || p.value?.key}`))}`);
      console.log(`Photos: ${firstOffer.photos?.length || 0}`);
      console.log(`Description: ${firstOffer.description?.slice(0, 200)}...`);

      // Check if contact/phone is in the offer data
      console.log(`\nContact: ${JSON.stringify(firstOffer.contact)}`);
      console.log(`User: ${JSON.stringify(firstOffer.user)}`);

      // Save full offer for analysis
      writeFileSync(`${RESULTS_DIR}/olx-offer-sample.json`, JSON.stringify(firstOffer, null, 2), { encoding: 'utf-8' });
      console.log(`\nFull offer saved to ${RESULTS_DIR}/olx-offer-sample.json`);
    }

    // Save full search results
    writeFileSync(`${RESULTS_DIR}/olx-api-search.json`, JSON.stringify(searchData, null, 2), { encoding: 'utf-8' });
    console.log(`Full search results saved to ${RESULTS_DIR}/olx-api-search.json`);
  }

  // 2. Test the phone number endpoint (requires auth)
  if (searchData?.data?.[0]?.id) {
    const offerId = searchData.data[0].id;
    console.log(`\n--- Phone Number Test (offer ${offerId}) ---`);
    const phoneUrl = `${OLX_API_BASE}/offers/${offerId}/phones/`;
    const phoneData = await fetchJson(phoneUrl);
    if (phoneData) {
      console.log(`Phone response: ${JSON.stringify(phoneData)}`);
    } else {
      console.log('Phone endpoint requires auth (expected)');
    }
  }

  // 3. Test user endpoint
  if (searchData?.data?.[0]?.user?.id) {
    const userId = searchData.data[0].user.id;
    console.log(`\n--- User Info Test (user ${userId}) ---`);
    const userData = await fetchJson(`${OLX_API_BASE}/users/${userId}/`);
    if (userData) {
      console.log(`User: ${JSON.stringify(userData.data, null, 2)?.slice(0, 500)}`);
    }
  }

  // 4. Test category listing to find all rental category IDs
  console.log(`\n--- Categories ---`);
  const catUrl = `${OLX_API_BASE}/categories/`;
  const catData = await fetchJson(catUrl);
  if (catData) {
    const realEstateCats = catData.data?.filter((c: any) =>
      c.name?.toLowerCase().includes('nieruchomo') ||
      c.name?.toLowerCase().includes('mieszkan') ||
      c.parent_id === 3 || c.parent_id === 1
    );
    console.log(`Real estate categories: ${JSON.stringify(realEstateCats?.map((c: any) => ({ id: c.id, name: c.name, parent: c.parent_id })))}`);
    writeFileSync(`${RESULTS_DIR}/olx-categories.json`, JSON.stringify(catData, null, 2), { encoding: 'utf-8' });
  }

  console.log('\nDone.');
}

main().catch(console.error);
