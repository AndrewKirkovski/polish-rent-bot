// Recon Otodom.pl — probe internal APIs, page structure, anti-bot measures
// Run: npm run recon:otodom

import 'dotenv/config';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { writeFileSync, mkdirSync } from 'fs';

chromium.use(stealthPlugin());

const RESULTS_DIR = '.local/recon';
mkdirSync(RESULTS_DIR, { recursive: true });

const OTODOM_SEARCH_URL = 'https://www.otodom.pl/pl/wyniki/wynajem/mieszkanie/mazowieckie/warszawa/warszawa/warszawa?limit=36&ownerTypeSingleSelect=ALL&by=DEFAULT&direction=DESC&viewType=listing';

interface NetworkLog {
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  contentType?: string;
  isApi?: boolean;
}

async function main() {
  console.log('=== Otodom.pl Recon ===\n');

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
  });

  const page = await context.newPage();
  const networkLogs: NetworkLog[] = [];
  const apiResponses: { url: string; body: string }[] = [];

  // Intercept ALL network requests
  page.on('request', (req) => {
    networkLogs.push({
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
    });
  });

  page.on('response', async (res) => {
    const url = res.url();
    const contentType = res.headers()['content-type'] || '';
    const isApi = contentType.includes('json') || url.includes('/api/') || url.includes('graphql') || url.includes('_next/data');

    const entry = networkLogs.find((e) => e.url === url);
    if (entry) {
      entry.status = res.status();
      entry.contentType = contentType;
      entry.isApi = isApi;
    }

    if (isApi && res.status() === 200) {
      try {
        const body = await res.text();
        if (body.length < 500_000) {
          apiResponses.push({ url, body: body.slice(0, 10_000) });
        }
      } catch {
        // response body may be unavailable
      }
    }
  });

  // 1. Visit search results page
  console.log(`Navigating to: ${OTODOM_SEARCH_URL}`);
  const response = await page.goto(OTODOM_SEARCH_URL, { waitUntil: 'networkidle', timeout: 30_000 });

  console.log(`Status: ${response?.status()}`);
  console.log(`Final URL: ${page.url()}`);

  const pageTitle = await page.title();
  console.log(`Page title: ${pageTitle}`);

  // Check response headers
  const headers = response?.headers() || {};
  const wafHeaders = ['cf-ray', 'cf-cache-status', 'server', 'x-powered-by', 'x-cdn', 'x-frame-options'];
  console.log('\nWAF/CDN Headers:');
  for (const h of wafHeaders) {
    if (headers[h]) console.log(`  ${h}: ${headers[h]}`);
  }

  // 2. Check for Next.js indicators
  console.log('\n--- Framework Detection ---');
  const nextData = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    if (el) return el.textContent?.slice(0, 3000);
    return null;
  });

  if (nextData) {
    console.log('  __NEXT_DATA__ found! (Next.js confirmed)');
    console.log(`  Preview: ${nextData.slice(0, 500)}...`);
    writeFileSync(`${RESULTS_DIR}/otodom-nextdata.json`, nextData, { encoding: 'utf-8' });
    console.log(`  Full __NEXT_DATA__ saved to ${RESULTS_DIR}/otodom-nextdata.json`);
  } else {
    console.log('  No __NEXT_DATA__ found');
  }

  // 3. Check page structure — listing cards
  console.log('\n--- Page Structure ---');
  const listingSelectors = [
    '[data-cy="search.listing"]',
    '[data-cy="listing-item"]',
    '[data-cy="listing-item-link"]',
    'a[href*="/pl/oferta/"]',
    '[class*="listing"]',
    '[class*="offer"]',
    'article',
    'li[data-cy]',
  ];

  for (const sel of listingSelectors) {
    const count = await page.locator(sel).count();
    if (count > 0) console.log(`  ${sel}: ${count} elements`);
  }

  // 4. Get first listing URL
  const firstListingLink = await page.locator('a[href*="/pl/oferta/"]').first().getAttribute('href').catch(() => null);

  console.log(`\nFirst listing link: ${firstListingLink}`);

  // 5. Visit a listing detail page
  if (firstListingLink) {
    const listingUrl = firstListingLink.startsWith('http') ? firstListingLink : `https://www.otodom.pl${firstListingLink}`;
    console.log(`\n--- Visiting listing: ${listingUrl} ---`);

    await page.goto(listingUrl, { waitUntil: 'networkidle', timeout: 30_000 });

    const listingTitle = await page.title();
    console.log(`Listing title: ${listingTitle}`);

    // Check __NEXT_DATA__ on detail page (contains all listing data!)
    const detailNextData = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      return el?.textContent || null;
    });

    if (detailNextData) {
      console.log(`  __NEXT_DATA__ on detail page: ${detailNextData.length} chars`);
      writeFileSync(`${RESULTS_DIR}/otodom-listing-nextdata.json`, detailNextData, { encoding: 'utf-8' });
      console.log(`  Saved to ${RESULTS_DIR}/otodom-listing-nextdata.json`);

      // Parse and extract key fields
      try {
        const parsed = JSON.parse(detailNextData);
        const props = parsed?.props?.pageProps;
        if (props) {
          console.log(`  pageProps keys: ${Object.keys(props).join(', ')}`);
          if (props.ad) {
            const ad = props.ad;
            console.log(`  ad keys: ${Object.keys(ad).join(', ')}`);
            console.log(`  title: ${ad.title}`);
            console.log(`  price: ${JSON.stringify(ad.target?.Price || ad.price)}`);
            console.log(`  area: ${ad.target?.Area || ad.areaInM2}`);
            console.log(`  location: ${JSON.stringify(ad.location?.address)}`);
          }
        }
      } catch {
        console.log('  Failed to parse __NEXT_DATA__');
      }
    }

    // Look for phone number button
    const phoneSelectors = [
      'button:has-text("numer")',
      'button:has-text("telefon")',
      '[data-cy*="phone"]',
      '[class*="phone"]',
      '[data-testid*="phone"]',
    ];

    console.log('\nPhone button:');
    for (const sel of phoneSelectors) {
      const count = await page.locator(sel).count();
      if (count > 0) {
        console.log(`  ${sel}: ${count} elements`);
        const text = await page.locator(sel).first().textContent().catch(() => null);
        if (text) console.log(`    text: "${text.trim()}"`);
      }
    }
  }

  // 6. Analyze API calls
  console.log('\n--- API/JSON Endpoints Found ---');
  const apiCalls = networkLogs.filter((e) => e.isApi);
  for (const call of apiCalls) {
    console.log(`  ${call.method} ${call.status} ${call.url.slice(0, 150)}`);
  }

  // 7. Look specifically for _next/data calls (Next.js data fetching)
  const nextDataCalls = networkLogs.filter((e) => e.url.includes('_next/data'));
  if (nextDataCalls.length > 0) {
    console.log('\n--- _next/data Calls ---');
    for (const call of nextDataCalls) {
      console.log(`  ${call.method} ${call.status} ${call.url}`);
    }
  }

  // 8. Save full results
  const results = {
    timestamp: new Date().toISOString(),
    searchUrl: OTODOM_SEARCH_URL,
    finalUrl: page.url(),
    pageTitle,
    headers,
    networkLogs: networkLogs.filter((e) => !e.url.includes('.png') && !e.url.includes('.jpg') && !e.url.includes('.gif') && !e.url.includes('.woff')),
    apiCalls,
    apiResponses: apiResponses.map((r) => ({
      url: r.url,
      preview: r.body.slice(0, 2000),
    })),
  };

  writeFileSync(`${RESULTS_DIR}/otodom-recon.json`, JSON.stringify(results, null, 2), { encoding: 'utf-8' });
  console.log(`\nFull results saved to ${RESULTS_DIR}/otodom-recon.json`);

  await page.screenshot({ path: `${RESULTS_DIR}/otodom-listing.png`, fullPage: false });
  console.log(`Screenshot saved to ${RESULTS_DIR}/otodom-listing.png`);

  // Dump cookies
  const cookies = await context.cookies();
  console.log(`\nCookies: ${cookies.length} total`);
  const authCookies = cookies.filter((c) => c.name.includes('token') || c.name.includes('session') || c.name.includes('auth') || c.name.includes('user'));
  if (authCookies.length > 0) {
    console.log('Auth-related cookies:');
    for (const c of authCookies) {
      console.log(`  ${c.name} = ${c.value.slice(0, 30)}... (domain: ${c.domain})`);
    }
  }

  await browser.close();
  console.log('\nDone.');
}

main().catch(console.error);
