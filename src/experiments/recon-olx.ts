// Recon OLX.pl — probe internal APIs, page structure, anti-bot measures
// Run: npm run recon:olx

import 'dotenv/config';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { writeFileSync, mkdirSync } from 'fs';

chromium.use(stealthPlugin());

const RESULTS_DIR = '.local/recon';
mkdirSync(RESULTS_DIR, { recursive: true });

const OLX_SEARCH_URL = 'https://www.olx.pl/nieruchomosci/mieszkania/wynajem/warszawa/';

interface NetworkLog {
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  contentType?: string;
  isApi?: boolean;
  responseSize?: number;
}

async function main() {
  console.log('=== OLX.pl Recon ===\n');

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
    const isApi = contentType.includes('json') || url.includes('/api/') || url.includes('graphql');

    // Update the network log entry
    const entry = networkLogs.find((e) => e.url === url);
    if (entry) {
      entry.status = res.status();
      entry.contentType = contentType;
      entry.isApi = isApi;
    }

    // Capture JSON API responses
    if (isApi && res.status() === 200) {
      try {
        const body = await res.text();
        if (body.length < 500_000) { // skip huge responses
          apiResponses.push({ url, body: body.slice(0, 10_000) }); // truncate for readability
        }
      } catch {
        // response body may be unavailable
      }
    }
  });

  // 1. Visit search results page
  console.log(`Navigating to: ${OLX_SEARCH_URL}`);
  const response = await page.goto(OLX_SEARCH_URL, { waitUntil: 'networkidle', timeout: 30_000 });

  console.log(`Status: ${response?.status()}`);
  console.log(`Final URL: ${page.url()}`);

  // Check for Cloudflare/WAF
  const pageTitle = await page.title();
  console.log(`Page title: ${pageTitle}`);

  // Check response headers for WAF indicators
  const headers = response?.headers() || {};
  const wafHeaders = ['cf-ray', 'cf-cache-status', 'server', 'x-powered-by', 'x-cdn'];
  console.log('\nWAF/CDN Headers:');
  for (const h of wafHeaders) {
    if (headers[h]) console.log(`  ${h}: ${headers[h]}`);
  }

  // 2. Check page structure
  console.log('\n--- Page Structure ---');

  // Look for listing cards
  const listingSelectors = [
    '[data-cy="l-card"]',
    '[data-testid="listing-grid"]',
    '.offer-wrapper',
    '[class*="listing"]',
    '[class*="offer"]',
    '[class*="card"]',
    'a[href*="/oferta/"]',
    'a[href*="/d/oferta/"]',
  ];

  for (const sel of listingSelectors) {
    const count = await page.locator(sel).count();
    if (count > 0) console.log(`  ${sel}: ${count} elements`);
  }

  // 3. Get first listing URL
  const firstListingLink = await page.locator('a[href*="/d/oferta/"]').first().getAttribute('href').catch(() => null)
    || await page.locator('a[href*="/oferta/"]').first().getAttribute('href').catch(() => null);

  console.log(`\nFirst listing link: ${firstListingLink}`);

  // 4. Visit a listing detail page
  if (firstListingLink) {
    const listingUrl = firstListingLink.startsWith('http') ? firstListingLink : `https://www.olx.pl${firstListingLink}`;
    console.log(`\n--- Visiting listing: ${listingUrl} ---`);

    await page.goto(listingUrl, { waitUntil: 'networkidle', timeout: 30_000 });

    const listingTitle = await page.title();
    console.log(`Listing title: ${listingTitle}`);

    // Look for phone number button
    const phoneSelectors = [
      '[data-testid="phones-container"]',
      '[data-cy="phone-button"]',
      'button:has-text("Pokaż numer")',
      'button:has-text("numer")',
      '[class*="phone"]',
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

    // Look for price, location, params
    const detailSelectors = [
      { name: 'price', sels: ['[data-testid="ad-price-container"]', '[class*="price"]', 'h3'] },
      { name: 'location', sels: ['[class*="location"]', '[data-testid="map-container"]'] },
      { name: 'params', sels: ['[data-testid="ad-params"]', '[class*="params"]', 'li[class*="param"]'] },
      { name: 'description', sels: ['[data-cy="ad_description"]', '[class*="description"]'] },
    ];

    console.log('\nDetail page elements:');
    for (const { name, sels } of detailSelectors) {
      for (const sel of sels) {
        const count = await page.locator(sel).count();
        if (count > 0) {
          console.log(`  [${name}] ${sel}: ${count} elements`);
          break;
        }
      }
    }
  }

  // 5. Analyze API calls
  console.log('\n--- API/JSON Endpoints Found ---');
  const apiCalls = networkLogs.filter((e) => e.isApi);
  for (const call of apiCalls) {
    console.log(`  ${call.method} ${call.status} ${call.url.slice(0, 150)}`);
  }

  // 6. Save full results
  const results = {
    timestamp: new Date().toISOString(),
    searchUrl: OLX_SEARCH_URL,
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

  writeFileSync(`${RESULTS_DIR}/olx-recon.json`, JSON.stringify(results, null, 2), { encoding: 'utf-8' });
  console.log(`\nFull results saved to ${RESULTS_DIR}/olx-recon.json`);

  // 7. Save a screenshot
  await page.screenshot({ path: `${RESULTS_DIR}/olx-listing.png`, fullPage: false });
  console.log(`Screenshot saved to ${RESULTS_DIR}/olx-listing.png`);

  // 8. Dump cookies (shows what auth state looks like)
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
