// Dump raw Otodom search item structure from __NEXT_DATA__
// Run: npx tsx src/experiments/dump-otodom-item.ts

import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { writeFileSync, mkdirSync } from 'fs';

chromium.use(stealthPlugin());
mkdirSync('.local/recon', { recursive: true });

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'pl-PL',
  });
  const page = await ctx.newPage();

  await page.goto('https://www.otodom.pl/pl/wyniki/wynajem/mieszkanie/mazowieckie/warszawa/warszawa/warszawa?limit=36&viewType=listing', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const nextData = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    return el?.textContent ? JSON.parse(el.textContent) : null;
  });

  if (nextData) {
    const items = nextData.props?.pageProps?.data?.searchAds?.items;
    if (items?.length) {
      console.log('First item keys:', Object.keys(items[0]).join(', '));
      console.log(JSON.stringify(items[0], null, 2));
      writeFileSync('.local/recon/otodom-raw-search-item.json', JSON.stringify(items[0], null, 2), { encoding: 'utf-8' });
      console.log('\nSaved to .local/recon/otodom-raw-search-item.json');
    } else {
      console.log('pageProps keys:', Object.keys(nextData.props?.pageProps || {}).join(', '));
      console.log('data keys:', Object.keys(nextData.props?.pageProps?.data || {}).join(', '));
    }
  } else {
    console.log('No __NEXT_DATA__');
  }

  await browser.close();
}

main().catch(console.error);
