// Monitor scheduler — runs active monitors on an interval, detects new listings,
// and calls a notification callback for each unseen result.

import { searchOlx, OLX_CATEGORIES } from '../crawlers/olx.js';
import { searchItems } from '../crawlers/olx-items.js';
import { searchOtodom } from '../crawlers/otodom.js';
import { getMonitors, isListingSeen, markListingSeen, cleanOldSeen, type MonitorRow } from '../storage/db.js';
import type { Listing } from '../types.js';
import type { ItemListing } from '../crawlers/olx-items.js';
import { parseRentalListing, parseItemListing } from '../ai/parse-listing.js';
import { scoreLocation } from '../ai/maps.js';

// ---------------------------------------------------------------------------
// City name → OLX city ID mapping (case-insensitive)
// ---------------------------------------------------------------------------

const CITY_ID_MAP: Record<string, number> = {
  warszawa: 17871,
  krakow: 10609,
  wroclaw: 20992,
  gdansk: 4879,
  poznan: 15649,
  lodz: 10820,
  katowice: 8671,
};

function resolveCityId(name: string | undefined): number | undefined {
  if (!name) return undefined;
  return CITY_ID_MAP[name.toLowerCase().trim()];
}

// ---------------------------------------------------------------------------
// Monitor config types (what lives inside monitor.config JSON column)
// ---------------------------------------------------------------------------

interface RentalConfig {
  city?: string;
  province?: string;
  district?: string;
  priceFrom?: number;
  priceTo?: number;
  roomsFrom?: number;
  limit?: number;
}

interface ItemConfig {
  query: string;
  city?: string;
  priceFrom?: number;
  priceTo?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

// ---------------------------------------------------------------------------
// runMonitor — execute a single monitor and return only NEW (unseen) listings
// ---------------------------------------------------------------------------

export async function runMonitor(monitor: MonitorRow): Promise<(Listing | ItemListing)[]> {
  const config = JSON.parse(monitor.config);
  const newListings: (Listing | ItemListing)[] = [];

  if (monitor.type === 'rental') {
    const rc = config as RentalConfig;
    const cityId = resolveCityId(rc.city);
    const allResults: Listing[] = [];

    // OLX rental
    if (monitor.platform === 'olx' || monitor.platform === 'all') {
      const olxResult = await searchOlx({
        categoryId: OLX_CATEGORIES.MIESZKANIA_WYNAJEM,
        cityId,
        priceFrom: rc.priceFrom,
        priceTo: rc.priceTo,
        limit: rc.limit,
      });
      allResults.push(...olxResult.listings);
    }

    // Otodom rental
    if (monitor.platform === 'otodom' || monitor.platform === 'all') {
      const otodomResult = await searchOtodom({
        type: 'wynajem',
        estate: 'mieszkanie',
        city: rc.city?.toLowerCase().trim(),
        province: rc.province,
        district: rc.district,
        priceFrom: rc.priceFrom,
        priceTo: rc.priceTo,
        roomsFrom: rc.roomsFrom,
        limit: rc.limit,
      });
      allResults.push(...otodomResult.listings);
    }

    // Filter to unseen — DON'T mark as seen yet (mark AFTER successful notification)
    for (const listing of allResults) {
      if (!isListingSeen(monitor.id, listing.platform, listing.platformId)) {
        newListings.push(listing);
      }
    }
  } else if (monitor.type === 'item') {
    const ic = config as ItemConfig;
    const cityId = resolveCityId(ic.city);

    const result = await searchItems({
      query: ic.query,
      cityId,
      priceFrom: ic.priceFrom,
      priceTo: ic.priceTo,
      limit: ic.limit,
    });

    for (const item of result.items) {
      if (!isListingSeen(monitor.id, item.platform, item.platformId)) {
        newListings.push(item);
      }
    }
  }

  return newListings;
}

// ---------------------------------------------------------------------------
// runAllMonitors — iterate over every active monitor with polite delays
// ---------------------------------------------------------------------------

export interface MonitorResult {
  monitor: MonitorRow;
  newListings: (Listing | ItemListing)[];
}

export async function runAllMonitors(): Promise<MonitorResult[]> {
  const monitors = getMonitors();
  const results: MonitorResult[] = [];

  for (const monitor of monitors) {
    try {
      const newListings = await runMonitor(monitor);
      results.push({ monitor, newListings });
    } catch (err) {
      console.error(`[scheduler] Monitor #${monitor.id} (user ${monitor.user_id}) failed:`, err);
    }

    // Polite 2–5 s delay between monitors to avoid hammering APIs
    if (monitor !== monitors[monitors.length - 1]) {
      await randomDelay(2000, 5000);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// startScheduler — runs monitors on a repeating interval
// ---------------------------------------------------------------------------

export function startScheduler(
  intervalMinutes: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  notifyFn: (userId: number, listing: Listing | ItemListing, parsedData?: any, locationScore?: any) => void | Promise<void>,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function cycle(): Promise<void> {
    if (stopped) return;

    console.log(`[scheduler] Starting monitor cycle at ${new Date().toISOString()}`);

    try {
      const results = await runAllMonitors();

      for (const { monitor, newListings } of results) {
        for (const listing of newListings) {
          try {
            // AI-parse the listing for structured data
            let parsedData = null;
            try {
              if (monitor.type === 'rental') {
                parsedData = await parseRentalListing(listing as Listing);
              } else {
                parsedData = await parseItemListing(listing as ItemListing);
              }
            } catch (parseErr) {
              console.error(`[scheduler] AI parse failed:`, parseErr);
            }

            // Score location if monitor has amenity prefs
            let locationScore = null;
            const config = JSON.parse(monitor.config);
            if (config.amenities && listing.lat && listing.lng) {
              try {
                locationScore = await scoreLocation(
                  listing.lat,
                  listing.lng,
                  config.amenities,
                  config.workAddress,
                  config.commuteMode,
                );
              } catch (mapErr) {
                console.error(`[scheduler] Maps scoring failed:`, mapErr);
              }
            }

            await notifyFn(monitor.user_id, listing, parsedData, locationScore);
            // Mark as seen ONLY after successful notification — prevents permanent data loss
            markListingSeen(monitor.id, listing.platform, listing.platformId, listing.url, listing.title, listing.price);
          } catch (notifyErr) {
            console.error(`[scheduler] Notify failed for user ${monitor.user_id} — listing NOT marked as seen (will retry next cycle):`, notifyErr);
          }
        }
      }

      // Purge listings older than 30 days from the seen table
      cleanOldSeen(30);

      const totalNew = results.reduce((sum, r) => sum + r.newListings.length, 0);
      console.log(`[scheduler] Cycle complete — ${results.length} monitors, ${totalNew} new listings`);
    } catch (err) {
      console.error('[scheduler] Cycle error:', err);
    }

    // Schedule next cycle (unless stopped during this one)
    if (!stopped) {
      timer = setTimeout(cycle, intervalMinutes * 60 * 1000);
    }
  }

  // First run is immediate
  cycle();

  // Return a stop function
  return () => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    console.log('[scheduler] Stopped');
  };
}
