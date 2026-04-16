// Test Otodom __NEXT_DATA__ extraction — parse server-rendered JSON, no complex scraping needed
// Discovery: Otodom is Next.js, all listing data is in __NEXT_DATA__ script tag
// Run: npx tsx src/experiments/test-otodom-nextdata.ts

import { writeFileSync, mkdirSync } from 'fs';

const RESULTS_DIR = '.local/recon';
mkdirSync(RESULTS_DIR, { recursive: true });

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'pl-PL,pl;q=0.9',
};

// Otodom search URL pattern
const SEARCH_URL = 'https://www.otodom.pl/pl/wyniki/wynajem/mieszkanie/mazowieckie/warszawa/warszawa/warszawa?limit=36&ownerTypeSingleSelect=ALL&by=DEFAULT&direction=DESC&viewType=listing';

async function extractNextData(url: string): Promise<any> {
  console.log(`Fetching: ${url.slice(0, 120)}`);
  const res = await fetch(url, { headers: HEADERS });
  console.log(`Status: ${res.status}`);

  if (!res.ok) {
    console.log(`Error: ${res.statusText}`);
    return null;
  }

  const html = await res.text();
  console.log(`HTML length: ${html.length}`);

  // Extract __NEXT_DATA__ JSON from the HTML
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!match) {
    console.log('No __NEXT_DATA__ found in HTML');
    // Check if we got a Cloudflare/captcha page
    if (html.includes('challenge') || html.includes('captcha')) {
      console.log('BLOCKED: Got a challenge/captcha page');
    }
    writeFileSync(`${RESULTS_DIR}/otodom-raw-html.html`, html.slice(0, 10000), { encoding: 'utf-8' });
    return null;
  }

  return JSON.parse(match[1]);
}

async function main() {
  console.log('=== Otodom __NEXT_DATA__ Test ===\n');

  // 1. Fetch search results page
  console.log('--- Search Results ---');
  const searchData = await extractNextData(SEARCH_URL);

  if (searchData) {
    const pageProps = searchData.props?.pageProps;
    console.log(`\nbuildId: ${searchData.buildId}`);
    console.log(`pageProps keys: ${Object.keys(pageProps || {}).join(', ')}`);

    // Extract listing data from search results
    const tracking = pageProps?.tracking?.listing;
    if (tracking) {
      console.log(`\nResults: ${tracking.result_count} total, page ${tracking.page_nb}/${tracking.page_count}`);
      console.log(`Per page: ${tracking.results_per_page}`);
    }

    // Find actual listing items in the data
    const adImpressions = tracking?.ad_impressions;
    if (adImpressions) {
      console.log(`Ad IDs on page: ${adImpressions.slice(0, 10).join(', ')}... (${adImpressions.length} total)`);
    }

    // Check for search listing items
    const searchItems = pageProps?.data?.searchAds?.items;
    if (searchItems) {
      console.log(`\nSearch items: ${searchItems.length}`);
      const first = searchItems[0];
      if (first) {
        console.log(`First item keys: ${Object.keys(first).join(', ')}`);
        console.log(`Title: ${first.title}`);
        console.log(`Price: ${JSON.stringify(first.totalPrice || first.price)}`);
        console.log(`Area: ${first.areaInM2}`);
        console.log(`Rooms: ${first.roomsNumber}`);
      }
    }

    writeFileSync(`${RESULTS_DIR}/otodom-search-nextdata.json`, JSON.stringify(searchData, null, 2), { encoding: 'utf-8' });
    console.log(`\nFull search __NEXT_DATA__ saved to ${RESULTS_DIR}/otodom-search-nextdata.json`);

    // 2. Now fetch a single listing detail page
    // Get listing URL from the data we captured during recon
    const listingSlug = pageProps?.data?.searchAds?.items?.[0]?.slug;
    if (listingSlug) {
      const listingUrl = `https://www.otodom.pl/pl/oferta/${listingSlug}`;
      console.log(`\n--- Listing Detail: ${listingSlug} ---`);
      const listingData = await extractNextData(listingUrl);

      if (listingData) {
        const ad = listingData.props?.pageProps?.ad;
        if (ad) {
          console.log(`\nad keys: ${Object.keys(ad).join(', ')}`);
          console.log(`Title: ${ad.title}`);
          console.log(`Price: ${ad.price?.value || ad.price}`);
          console.log(`Area: ${ad.target?.Area || ad.areaInM2}`);
          console.log(`Rooms: ${ad.target?.Rooms_num?.[0]}`);
          console.log(`Floor: ${ad.target?.Floor_no?.[0]}`);
          console.log(`Building: ${ad.target?.Building_type?.[0]}`);
          console.log(`Heating: ${ad.target?.Heating?.[0]}`);
          console.log(`Location: ${ad.location?.address?.city?.name}, ${ad.location?.address?.district?.name}`);
          console.log(`Street: ${ad.location?.address?.street?.name} ${ad.location?.address?.street?.number}`);
          console.log(`Coordinates: ${ad.location?.coordinates?.latitude}, ${ad.location?.coordinates?.longitude}`);
          console.log(`Owner type: ${ad.advertiserType}`);
          console.log(`Agency: ${ad.agency?.name || 'none'}`);
          console.log(`Description length: ${ad.description?.length}`);
          console.log(`Images: ${ad.images?.length}`);
          console.log(`Created: ${ad.createdAt}`);
          console.log(`Modified: ${ad.modifiedAt}`);

          // THE BIG QUESTION: is contactDetails / phone in here?
          console.log(`\n--- Contact Details ---`);
          console.log(`contactDetails: ${JSON.stringify(ad.contactDetails)}`);
          console.log(`owner: ${JSON.stringify(ad.owner)}`);

          // Check for characteristics (structured params)
          console.log(`\n--- Characteristics ---`);
          ad.characteristics?.forEach((c: any) => {
            console.log(`  ${c.key}: ${c.value} (${c.label})`);
          });

          // Check target (legacy params)
          console.log(`\n--- Target params ---`);
          if (ad.target) {
            Object.entries(ad.target).forEach(([k, v]) => {
              if (v && k !== '__typename') console.log(`  ${k}: ${JSON.stringify(v)}`);
            });
          }

          // Check features
          console.log(`\n--- Features ---`);
          console.log(JSON.stringify(ad.features?.slice(0, 10), null, 2));

          writeFileSync(`${RESULTS_DIR}/otodom-listing-detail.json`, JSON.stringify(ad, null, 2), { encoding: 'utf-8' });
          console.log(`\nFull listing saved to ${RESULTS_DIR}/otodom-listing-detail.json`);
        }
      }
    }
  }

  // 3. Test Otodom GraphQL API directly (persisted query)
  // We captured the operations from our recon. Let's try calling them.
  console.log('\n--- GraphQL API Test ---');
  const gqlHeaders = {
    ...HEADERS,
    'Accept': 'application/json',
  };

  // Try the GetUser operation (no auth)
  const getUserUrl = 'https://www.otodom.pl/api/query?operationName=GetUser&variables=%7B%7D&extensions=%7B%22persistedQuery%22%3A%7B%22sha256Hash%22%3A%228d7d5db9bd29a5fef368e1cb2e72ef92e50a4580dbf8d2dc04e2b5b3a8c90cc4%22%2C%22version%22%3A1%7D%7D';
  const getUserRes = await fetch(getUserUrl, { headers: gqlHeaders });
  console.log(`GetUser: ${getUserRes.status}`);
  if (getUserRes.ok) {
    const userData = await getUserRes.json();
    console.log(`GetUser response: ${JSON.stringify(userData).slice(0, 300)}`);
  }

  console.log('\nDone.');
}

main().catch(console.error);
