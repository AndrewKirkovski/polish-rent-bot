// Monitor scheduler — runs active monitors on an interval, detects new listings,
// and calls a notification callback for each unseen result.

import { searchOlx, OLX_CATEGORIES, OLX_DISTRICTS } from '../crawlers/olx.js';
import { searchItems } from '../crawlers/olx-items.js';
import { searchOtodom } from '../crawlers/otodom.js';
import { getMonitors, isListingSeen, markListingSeen, cleanOldSeen, startMonitorRun, finishMonitorRun, type MonitorRow } from '../storage/db.js';
import type { Listing } from '../types.js';
import type { ItemListing } from '../crawlers/olx-items.js';
import { parseRentalListing, parseItemListing, evaluateRejection } from '../ai/parse-listing.js';
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

const stripDiacritics = (s: string) => s.toLowerCase().trim()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/ł/g, 'l');

// ---------------------------------------------------------------------------
// Monitor config types (what lives inside monitor.config JSON column)
// ---------------------------------------------------------------------------

interface RentalConfig {
  city?: string;
  province?: string;
  districts?: string[];     // plural array — matches create_monitor storage
  district?: string;        // legacy singular (fallback)
  priceFrom?: number;
  priceTo?: number;
  roomsFrom?: number;
  roomsTo?: number;
  areaFrom?: number;
  areaTo?: number;
  ownerType?: 'ALL' | 'PRIVATE' | 'AGENCY';
  limit?: number;
}

interface ItemConfig {
  query: string;
  mandatoryKeywords?: string[];
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

export interface RunMonitorResult {
  totalFound: number;
  newListings: (Listing | ItemListing)[];
}

export async function runMonitor(monitor: MonitorRow): Promise<RunMonitorResult> {
  const config = JSON.parse(monitor.config);
  const newListings: (Listing | ItemListing)[] = [];
  let totalFound = 0;

  if (monitor.type === 'rental') {
    const rc = config as RentalConfig;
    const cityId = resolveCityId(rc.city);
    const districts = rc.districts ?? (rc.district ? [rc.district] : []);
    const allResults: Listing[] = [];

    // Resolve OLX district ID from first district name
    let olxDistrictId: number | undefined;
    if (districts.length > 0 && rc.city) {
      const cityDistricts = OLX_DISTRICTS[stripDiacritics(rc.city)];
      if (cityDistricts) olxDistrictId = cityDistricts[stripDiacritics(districts[0])];
    }

    // OLX rental
    if (monitor.platform === 'olx' || monitor.platform === 'all') {
      const olxResult = await searchOlx({
        categoryId: OLX_CATEGORIES.MIESZKANIA_WYNAJEM,
        cityId,
        rooms: rc.roomsFrom,
        districtId: olxDistrictId,
        limit: rc.limit ?? 40,
      });
      allResults.push(...olxResult.listings);
    }

    // Otodom rental — search per district if specified
    if (monitor.platform === 'otodom' || monitor.platform === 'all') {
      const districtList = districts.length > 0 ? districts : [undefined];
      for (const district of districtList) {
        try {
          const otodomResult = await searchOtodom({
            type: 'wynajem',
            estate: 'mieszkanie',
            city: rc.city?.toLowerCase().trim(),
            province: rc.province,
            district: district ? stripDiacritics(district) : undefined,
            priceFrom: rc.priceFrom,
            priceTo: rc.priceTo,
            areaFrom: rc.areaFrom,
            areaTo: rc.areaTo,
            roomsFrom: rc.roomsFrom,
            roomsTo: rc.roomsTo,
            ownerType: rc.ownerType,
            limit: rc.limit ?? 36,
          });
          allResults.push(...otodomResult.listings);
        } catch (err) {
          console.error(`[scheduler] Otodom search failed for monitor #${monitor.id}:`, err instanceof Error ? err.message : err);
        }
      }
    }

    // ---- Post-search filtering (matches find_rentals logic in tools.ts) ----
    const roomsTo = rc.roomsTo ?? rc.roomsFrom; // default to exact match
    let filtered = allResults;
    if (rc.roomsFrom != null) {
      filtered = filtered.filter((l) => l.rooms == null || l.rooms >= rc.roomsFrom!);
    }
    if (roomsTo != null) {
      filtered = filtered.filter((l) => l.rooms == null || l.rooms <= roomsTo);
    }
    if (rc.areaFrom != null) {
      filtered = filtered.filter((l) => l.area == null || l.area >= rc.areaFrom!);
    }
    if (rc.areaTo != null) {
      filtered = filtered.filter((l) => l.area == null || l.area <= rc.areaTo!);
    }
    // District substring matching
    if (districts.length > 0) {
      const normalizedDistricts = districts.map(stripDiacritics);
      filtered = filtered.filter((l) => {
        if (!l.district) return true; // keep listings without district info
        const nd = stripDiacritics(l.district);
        return normalizedDistricts.some(d => nd.includes(d) || d.includes(nd));
      });
    }
    // Deduplicate by platform:platformId
    const seen = new Set<string>();
    const deduped: Listing[] = [];
    for (const l of filtered) {
      const key = `${l.platform}:${l.platformId}`;
      if (!seen.has(key)) { seen.add(key); deduped.push(l); }
    }
    totalFound = deduped.length;

    // Filter to unseen — DON'T mark as seen yet (mark AFTER successful notification)
    for (const listing of deduped) {
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

    // Filter by mandatory keywords in title (matches find_items logic in tools.ts)
    const mandatoryKw = (ic.mandatoryKeywords ?? []).map(k => k.toLowerCase());
    let filteredItems = result.items;
    if (mandatoryKw.length > 0) {
      filteredItems = filteredItems.filter(item => {
        const titleLower = item.title.toLowerCase();
        return mandatoryKw.every(kw => titleLower.includes(kw));
      });
    }

    totalFound = filteredItems.length;
    for (const item of filteredItems) {
      if (!isListingSeen(monitor.id, item.platform, item.platformId)) {
        newListings.push(item);
      }
    }
  }

  return { totalFound, newListings };
}

// ---------------------------------------------------------------------------
// runAllMonitors — iterate over every active monitor with polite delays
// ---------------------------------------------------------------------------

export interface MonitorResult {
  monitor: MonitorRow;
  runId: number;
  totalFound: number;
  newListings: (Listing | ItemListing)[];
  searchError: string | null;
}

export async function runAllMonitors(): Promise<MonitorResult[]> {
  const monitors = getMonitors();
  const results: MonitorResult[] = [];

  for (const monitor of monitors) {
    const runId = startMonitorRun(monitor.id);
    try {
      const { totalFound, newListings } = await runMonitor(monitor);
      results.push({ monitor, runId, totalFound, newListings, searchError: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Monitor #${monitor.id} (user ${monitor.user_id}) failed:`, err);
      // Finalize the run row immediately for failed searches; cycle() will skip it.
      finishMonitorRun(runId, { listingsFound: 0, listingsUnseen: 0, listingsDelivered: 0, errorMessage: msg });
      results.push({ monitor, runId, totalFound: 0, newListings: [], searchError: msg });
    }

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

      for (const { monitor, runId, totalFound, newListings, searchError } of results) {
        if (searchError !== null) continue; // run row already finalised by runAllMonitors
        if (newListings.length > 0) {
          console.log(`[scheduler] Monitor #${monitor.id} (${monitor.type}): ${newListings.length} new listing(s)`);
        }
        let delivered = 0;
        let cycleError: string | null = null;
        try {
        const monitorConfig = JSON.parse(monitor.config);
        for (const listing of newListings) {
          try {
            // AI-parse the listing for structured data
            let parsedData = null;
            try {
              if (monitor.type === 'rental') {
                parsedData = await parseRentalListing(listing as Listing, { monitorId: monitor.id, userId: monitor.user_id });
              } else {
                parsedData = await parseItemListing(listing as ItemListing, { monitorId: monitor.id, userId: monitor.user_id });
              }
            } catch (parseErr) {
              console.error(`[scheduler] AI parse failed:`, parseErr);
            }

            // Budget check — reject if total cost exceeds priceTo (matches find_rentals logic)
            // Uses AI total if available, falls back to price+rent even when AI parse failed
            const config = monitorConfig;
            if (monitor.type === 'rental' && config.priceTo != null) {
              const l = listing as Listing;
              const estimatedTotal = (parsedData as any)?.totalMonthlyCost
                ?? (l.price + (l.rent ?? 0));
              if (estimatedTotal > config.priceTo) {
                console.log(`[scheduler] Budget reject "${listing.title}": ${estimatedTotal} > ${config.priceTo}`);
                markListingSeen(monitor.id, listing.platform, listing.platformId, listing.url, listing.title, listing.price);
                continue;
              }
            }

            // Contract preference filter (matches find_rentals logic)
            if (
              monitor.type === 'rental' &&
              config.contractPreference === 'najem_okazjonalny' &&
              parsedData &&
              (parsedData as any).contractType != null &&
              (parsedData as any).contractType !== 'najem_okazjonalny'
            ) {
              console.log(`[scheduler] Contract reject "${listing.title}": ${(parsedData as any).contractType} != najem_okazjonalny`);
              markListingSeen(monitor.id, listing.platform, listing.platformId, listing.url, listing.title, listing.price);
              continue;
            }

            // Evaluate rejection criteria if configured (two-tier AI caching)
            if (config.rejectionCriteria && parsedData) {
              try {
                const rejectionResult = await evaluateRejection(listing, parsedData, config.rejectionCriteria as string, { monitorId: monitor.id, userId: monitor.user_id });
                if (rejectionResult.rejected) {
                  console.log(`[scheduler] Rejected "${listing.title}": ${rejectionResult.rejectionReason}`);
                  // Mark as seen so we don't re-evaluate next cycle
                  markListingSeen(monitor.id, listing.platform, listing.platformId, listing.url, listing.title, listing.price);
                  continue;
                }
              } catch (rejErr) {
                console.error(`[scheduler] Rejection eval failed:`, rejErr);
                // Don't reject on evaluation failure — let it through
              }
            }

            // Score location if monitor has amenity prefs
            let locationScore = null;
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
            delivered++;
          } catch (notifyErr) {
            console.error(`[scheduler] Notify failed for user ${monitor.user_id} — listing NOT marked as seen (will retry next cycle):`, notifyErr);
          }
        }
        } catch (perMonitorErr) {
          cycleError = perMonitorErr instanceof Error ? perMonitorErr.message : String(perMonitorErr);
          console.error(`[scheduler] Monitor #${monitor.id} pipeline error:`, perMonitorErr);
        }
        finishMonitorRun(runId, {
          listingsFound: totalFound,
          listingsUnseen: newListings.length,
          listingsDelivered: delivered,
          errorMessage: cycleError,
        });
      }

      // Purge listings older than 30 days from the seen table
      cleanOldSeen(30);

      const totalNew = results.reduce((sum, r) => sum + r.newListings.length, 0);
      console.log(`[scheduler] Cycle complete — ${results.length} monitors, ${totalNew} unseen listings`);
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
