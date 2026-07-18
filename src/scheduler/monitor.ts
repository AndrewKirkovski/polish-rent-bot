// Monitor scheduler — runs active monitors on an interval, detects new listings,
// and calls a notification callback for each unseen result.

import { searchItems } from '../crawlers/olx-items.js';
import { getMonitors, isListingSeen, markListingSeen, cleanOldSeen, cleanOldCachedListings, startMonitorRun, finishMonitorRun, cacheListing, type MonitorRow } from '../storage/db.js';
import type { Listing, ParsedRentalData, ParsedItemData, LocationScore } from '../types.js';
import type { ItemListing } from '../crawlers/olx-items.js';
import { parseRentalListing, parseItemListing, evaluateRejection, triageRentalListing } from '../ai/parse-listing.js';
import { scoreLocation } from '../ai/maps.js';
import { computeRentalCost, exceedsBudgetFloor } from '../cost.js';
import { searchRentalListings, resolveCityId } from '../search/rental-search.js';
import { enrichRentalListing } from '../search/enrich-listing.js';
import { checkAmenityGate, resolveStrictAmenities } from '../search/amenity-gate.js';
import { notificationDedupKey } from '../search/listing-fingerprint.js';
import { computeFitScore, preScore } from '../search/fit-score.js';

// ---------------------------------------------------------------------------
// Monitor config types (what lives inside monitor.config JSON column)
// ---------------------------------------------------------------------------

interface RentalConfig {
  city?: string;
  province?: string;
  districts?: string[];
  district?: string;
  priceFrom?: number;
  priceTo?: number;
  roomsFrom?: number;
  roomsTo?: number;
  areaFrom?: number;
  areaTo?: number;
  ownerType?: 'ALL' | 'PRIVATE' | 'AGENCY';
  limit?: number;
  amenities?: Array<{ type: string; maxMinutes: number }>;
  workAddress?: string;
  commuteMode?: string;
  contractPreference?: string;
  rejectionCriteria?: string;
  strictAmenities?: boolean;
  platforms?: string;
}

interface ItemConfig {
  query: string;
  mandatoryKeywords?: string[];
  city?: string;
  priceFrom?: number;
  priceTo?: number;
  limit?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

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
    const districts = rc.districts ?? (rc.district ? [rc.district] : []);
    const roomsTo = rc.roomsTo ?? rc.roomsFrom;
    const platforms = (rc.platforms ?? monitor.platform) as 'olx' | 'otodom' | 'all';

    const deduped = await searchRentalListings({
      city: rc.city?.toLowerCase().trim() ?? '',
      districts,
      province: rc.province,
      roomsFrom: rc.roomsFrom,
      roomsTo,
      areaFrom: rc.areaFrom,
      areaTo: rc.areaTo,
      priceFrom: rc.priceFrom,
      priceTo: rc.priceTo,
      ownerType: rc.ownerType,
      platforms,
      olxMaxPages: 1,
      olxLimit: rc.limit ?? 40,
      otodomLimit: rc.limit ?? 36,
    });

    totalFound = deduped.length;

    for (const listing of deduped) {
      if (!isListingSeen(monitor.id, listing.platform, listing.platformId)) {
        newListings.push(listing);
      }
    }
  } else if (monitor.type === 'item') {
    const ic = config as ItemConfig;
    const cityId = resolveCityId(ic.city ?? '');

    const result = await searchItems({
      query: ic.query,
      cityId,
      priceFrom: ic.priceFrom,
      priceTo: ic.priceTo,
      limit: ic.limit,
    });

    const mandatoryKw = (ic.mandatoryKeywords ?? []).map((k) => k.toLowerCase());
    let filteredItems = result.items;
    if (mandatoryKw.length > 0) {
      filteredItems = filteredItems.filter((item) => {
        const titleLower = item.title.toLowerCase();
        return mandatoryKw.every((kw) => titleLower.includes(kw));
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
      finishMonitorRun(runId, { listingsFound: 0, listingsUnseen: 0, listingsDelivered: 0, errorMessage: msg });
      results.push({ monitor, runId, totalFound: 0, newListings: [], searchError: msg });
    }

    if (monitor !== monitors[monitors.length - 1]) {
      await randomDelay(2000, 5000);
    }
  }

  return results;
}

export function startScheduler(
  intervalMinutes: number,
  notifyFn: (
    userId: number,
    listing: Listing | ItemListing,
    parsedData?: ParsedRentalData | ParsedItemData | null,
    locationScore?: LocationScore | null,
    fitReason?: string | null,
  ) => void | Promise<void>,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function cycle(): Promise<void> {
    if (stopped) return;

    console.log(`[scheduler] Starting monitor cycle at ${new Date().toISOString()}`);

    try {
      const results = await runAllMonitors();
      const notifiedFingerprints = new Set<string>();
      const notifiedItemKeys = new Set<string>();

      for (const { monitor, runId, totalFound, newListings, searchError } of results) {
        if (searchError !== null) continue;
        if (newListings.length > 0) {
          console.log(`[scheduler] Monitor #${monitor.id} (${monitor.type}): ${newListings.length} new listing(s)`);
        }
        let delivered = 0;
        let cycleError: string | null = null;
        try {
          const monitorConfig = JSON.parse(monitor.config) as RentalConfig;
          const strictAmenities = resolveStrictAmenities(monitorConfig.strictAmenities);

          // Cap per cycle (like the interactive path) so a brand-new monitor doesn't fire
          // 100+ enrich+parse calls at once. Overflow stays unseen for the next cycle.
          // Best-fit first (rentals) so the cap keeps the strongest candidates, matching
          // the interactive path's preScore ordering.
          const PER_CYCLE_CAP = 25;
          const ordered = monitor.type === 'rental'
            ? [...newListings].sort((a, b) => preScore(b as Listing) - preScore(a as Listing))
            : newListings;
          const toProcess = ordered.slice(0, PER_CYCLE_CAP);
          if (newListings.length > PER_CYCLE_CAP) {
            console.log(`[scheduler] Monitor #${monitor.id}: capping ${newListings.length} new → ${PER_CYCLE_CAP} this cycle (rest next cycle)`);
          }

          for (const listing of toProcess) {
            try {
              // Compute the cross-monitor dedup key from the PRE-enrich listing and reuse it
              // for the post-delivery add, so enrichment can't shift the fingerprint between
              // the has()-check and the add() (which would let the same flat notify twice).
              let dedupKey: string | null = null;
              if (monitor.type === 'rental') {
                dedupKey = notificationDedupKey(listing as Listing);
                if (notifiedFingerprints.has(dedupKey)) {
                  markListingSeen(monitor.id, listing.platform, listing.platformId, listing.url, listing.title, listing.price);
                  continue;
                }
              } else {
                const itemKey = `${listing.platform}:${listing.platformId}`;
                if (notifiedItemKeys.has(itemKey)) {
                  markListingSeen(monitor.id, listing.platform, listing.platformId, listing.url, listing.title, listing.price);
                  continue;
                }
              }

              // Pre-parse budget short-circuit: base rent alone over budget → skip enrich + AI.
              if (monitor.type === 'rental' && monitorConfig.priceTo != null) {
                const l = listing as Listing;
                if (exceedsBudgetFloor(l, monitorConfig.priceTo)) {
                  console.log(`[scheduler] Budget pre-reject "${l.title}": аренда ${l.price} > ${monitorConfig.priceTo} (no AI call)`);
                  markListingSeen(monitor.id, l.platform, l.platformId, l.url, l.title, l.price);
                  continue;
                }
              }

              // Cheap AI triage before the expensive enrich + full parse: drop room/coliving/
              // non-apartment listings and enforce the room count when the platform didn't report it.
              if (monitor.type === 'rental') {
                const l = listing as Listing;
                const triage = await triageRentalListing(l, { monitorId: monitor.id, userId: monitor.user_id });
                const effRooms = l.rooms ?? triage.rooms;
                const roomsTo = monitorConfig.roomsTo ?? monitorConfig.roomsFrom;
                const roomMismatch = effRooms != null
                  && ((monitorConfig.roomsFrom != null && effRooms < monitorConfig.roomsFrom)
                    || (roomsTo != null && effRooms > roomsTo));
                if (!triage.apartment || roomMismatch) {
                  console.log(`[scheduler] Triage drop "${l.title}": ${!triage.apartment ? 'room/coliving' : `${effRooms} rooms`}`);
                  markListingSeen(monitor.id, l.platform, l.platformId, l.url, l.title, l.price);
                  continue;
                }
              }

              let workingListing = listing;
              if (monitor.type === 'rental') {
                workingListing = await enrichRentalListing(listing as Listing);
              }

              let parsedData: ParsedRentalData | import('../types.js').ParsedItemData | null = null;
              try {
                if (monitor.type === 'rental') {
                  parsedData = await parseRentalListing(workingListing as Listing, { monitorId: monitor.id, userId: monitor.user_id });
                } else {
                  parsedData = await parseItemListing(workingListing as ItemListing, { monitorId: monitor.id, userId: monitor.user_id });
                }
              } catch (parseErr) {
                console.error('[scheduler] AI parse failed:', parseErr);
              }

              if (monitor.type === 'rental' && (parsedData as ParsedRentalData | null)?.isConcreteApartment === false) {
                console.log(`[scheduler] Drop "${workingListing.title}": не конкретная квартира`);
                markListingSeen(monitor.id, workingListing.platform, workingListing.platformId, workingListing.url, workingListing.title, workingListing.price);
                continue;
              }

              try {
                cacheListing({
                  platform: workingListing.platform,
                  platformId: workingListing.platformId,
                  kind: monitor.type === 'rental' ? 'rental' : 'item',
                  resultId: null,
                  listing: workingListing,
                });
              } catch (cacheErr) {
                console.error('[scheduler] cacheListing failed:', cacheErr instanceof Error ? cacheErr.message : cacheErr);
              }

              const config = monitorConfig;
              if (monitor.type === 'rental' && config.priceTo != null) {
                const l = workingListing as Listing;
                const estimatedTotal = computeRentalCost(l, parsedData as ParsedRentalData | null).total;
                if (estimatedTotal > config.priceTo) {
                  console.log(`[scheduler] Budget reject "${l.title}": ${estimatedTotal} > ${config.priceTo}`);
                  markListingSeen(monitor.id, l.platform, l.platformId, l.url, l.title, l.price);
                  continue;
                }
              }

              if (
                monitor.type === 'rental' &&
                config.contractPreference === 'najem_okazjonalny' &&
                parsedData &&
                (parsedData as ParsedRentalData).contractType != null &&
                (parsedData as ParsedRentalData).contractType !== 'najem_okazjonalny'
              ) {
                markListingSeen(monitor.id, workingListing.platform, workingListing.platformId, workingListing.url, workingListing.title, workingListing.price);
                continue;
              }

              if (config.rejectionCriteria && parsedData) {
                try {
                  const rejectionResult = await evaluateRejection(workingListing, parsedData, config.rejectionCriteria, { monitorId: monitor.id, userId: monitor.user_id });
                  if (rejectionResult.rejected) {
                    markListingSeen(monitor.id, workingListing.platform, workingListing.platformId, workingListing.url, workingListing.title, workingListing.price);
                    continue;
                  }
                } catch (rejErr) {
                  console.error('[scheduler] Rejection eval failed:', rejErr);
                }
              }

              let locationScore: LocationScore | null = null;
              if (monitor.type === 'rental' && ((config.amenities?.length ?? 0) > 0 || config.workAddress)) {
                try {
                  const { enrichListingLocation } = await import('../ai/location.js');
                  const enriched = await enrichListingLocation(workingListing as Listing, parsedData as { addressHint?: string | null } | null);
                  if (enriched.lat != null && enriched.lng != null) {
                    (workingListing as Listing).lat = enriched.lat;
                    (workingListing as Listing).lng = enriched.lng;
                    locationScore = await scoreLocation(
                      enriched.lat,
                      enriched.lng,
                      config.amenities ?? [],
                      config.workAddress,
                      config.commuteMode,
                    );
                    if (locationScore) locationScore.precision = enriched.precision;
                  }
                } catch (mapErr) {
                  console.error('[scheduler] Location enrich/scoring failed:', mapErr);
                }
              }

              if (monitor.type === 'rental') {
                const gate = checkAmenityGate(
                  locationScore,
                  config.amenities ?? [],
                  locationScore?.precision,
                  strictAmenities,
                );
                if (!gate.pass) {
                  console.log(`[scheduler] Amenity reject "${workingListing.title}": ${gate.reason}`);
                  markListingSeen(monitor.id, workingListing.platform, workingListing.platformId, workingListing.url, workingListing.title, workingListing.price);
                  continue;
                }
              }

              let fitReason: string | null = null;
              if (monitor.type === 'rental') {
                const fit = computeFitScore(workingListing as Listing, parsedData as ParsedRentalData | null, locationScore);
                fitReason = `${fit.score}${fit.reason ? ' · ' + fit.reason : ''}`;
              }
              await notifyFn(
                monitor.user_id,
                workingListing,
                parsedData,
                locationScore,
                fitReason,
              );
              if (monitor.type === 'rental') {
                if (dedupKey) notifiedFingerprints.add(dedupKey);
              } else {
                notifiedItemKeys.add(`${workingListing.platform}:${workingListing.platformId}`);
              }
              markListingSeen(monitor.id, workingListing.platform, workingListing.platformId, workingListing.url, workingListing.title, workingListing.price);
              delivered++;
            } catch (notifyErr) {
              console.error(`[scheduler] Notify failed — listing NOT marked as seen (will retry next cycle):`, notifyErr);
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

      cleanOldSeen(30);
      cleanOldCachedListings(90);

      const totalNew = results.reduce((sum, r) => sum + r.newListings.length, 0);
      console.log(`[scheduler] Cycle complete — ${results.length} monitors, ${totalNew} unseen listings`);
    } catch (err) {
      console.error('[scheduler] Cycle error:', err);
    }

    if (!stopped) {
      timer = setTimeout(cycle, intervalMinutes * 60 * 1000);
    }
  }

  cycle();

  return () => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    console.log('[scheduler] Stopped');
  };
}
