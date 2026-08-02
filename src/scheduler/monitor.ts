// Monitor scheduler — runs active monitors on an interval, detects new listings,
// and calls a notification callback for each unseen result.

import { searchItems, fetchItemPhone } from '../crawlers/olx-items.js';
import { getMonitors, isListingSeen, markListingSeen, cleanOldSeen, cleanOldCachedListings, cleanOldNotifiedFingerprints, cleanOldMonitorRejections, cleanOldTelegramMessageRefs, startMonitorRun, finishMonitorRun, cacheListing, getCachedListingByPlatform, newUniqueResultId, isFingerprintNotified, markFingerprintNotified, recordMonitorRejection, getMonitorRejectionsSince, getAppState, setAppState, getFullRescanStatus, queueFullRescan, beginFullRescan, finishFullRescan, recoverInterruptedFullRescan, type FullRescanStatus, type MonitorRow } from '../storage/db.js';
import { buildRejectionReport } from './rejection-report.js';
import type { Listing, ParsedRentalData, ParsedItemData, LocationScore } from '../types.js';
import type { ItemListing } from '../crawlers/olx-items.js';
import { parseRentalListing, parseItemListing, evaluateRejection, triageRentalListing } from '../ai/parse-listing.js';
import { createUnknownLocationScore, scoreLocation } from '../ai/maps.js';
import type { AmenityPreference } from '../ai/maps.js';
import { computeRentalCost, exceedsBudgetFloor } from '../cost.js';
import { searchRentalListings, resolveCityId } from '../search/rental-search.js';
import { enrichRentalListing } from '../search/enrich-listing.js';
import { checkAmenityGate, checkCenterGate, resolveStrictAmenities } from '../search/amenity-gate.js';
import { notificationDedupKey } from '../search/listing-fingerprint.js';
import { computeFitScore, preScore } from '../search/fit-score.js';
import { genResultId } from '../utils/result-id.js';
import { seedResultIdForFamily } from '../ai/tools.js';

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
  maxCenterMinutes?: number;
  ownerType?: 'ALL' | 'PRIVATE' | 'AGENCY';
  limit?: number;
  amenities?: AmenityPreference[];
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

export interface RunMonitorOptions {
  ignoreSeen?: boolean;
}

export async function runMonitor(
  monitor: MonitorRow,
  options: RunMonitorOptions = {},
): Promise<RunMonitorResult> {
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
      if (options.ignoreSeen || !isListingSeen(monitor.id, listing.platform, listing.platformId)) {
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
      if (options.ignoreSeen || !isListingSeen(monitor.id, item.platform, item.platformId)) {
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

export async function runAllMonitors(options: RunMonitorOptions = {}): Promise<MonitorResult[]> {
  const monitors = getMonitors();
  const results: MonitorResult[] = [];

  for (const monitor of monitors) {
    const runId = startMonitorRun(monitor.id);
    try {
      const { totalFound, newListings } = await runMonitor(monitor, options);
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

// ---------------------------------------------------------------------------
// Once-per-day monitor rejection report (~09:00 Europe/Warsaw)
// ---------------------------------------------------------------------------

const DAILY_REPORT_HOUR = 9; // fire when the Warsaw local hour reaches this

/** Warsaw-local date ('YYYY-MM-DD') and hour (0-23), timezone-safe regardless of the host clock. */
function warsawDateHour(now: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const hour = parseInt(get('hour'), 10) % 24; // some engines render midnight as '24'
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour };
}

/** UTC timestamp in SQLite's 'YYYY-MM-DD HH:MM:SS' format so it compares lexically with datetime('now'). */
function sqliteUtc(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/** Sends one aggregated rejection digest per Warsaw day (once the local hour reaches
 *  DAILY_REPORT_HOUR). Retries on the next cycle if the broadcast fails; advances the
 *  window with nothing sent when there was nothing to report. */
async function maybeSendDailyRejectionReport(reportFn: (text: string) => void | Promise<void>): Promise<void> {
  const now = new Date();
  const { date: today, hour } = warsawDateHour(now);
  if (hour < DAILY_REPORT_HOUR) return;
  if (getAppState('rejectionReport.lastDate') === today) return; // already handled today

  const lastAt = getAppState('rejectionReport.lastAt') ?? sqliteUtc(new Date(now.getTime() - 24 * 3600_000));
  const rows = getMonitorRejectionsSince(lastAt);
  const report = buildRejectionReport(rows);

  if (!report) {
    // Nothing to report — still advance the marker so we don't recompute every cycle today.
    setAppState('rejectionReport.lastDate', today);
    setAppState('rejectionReport.lastAt', sqliteUtc(now));
    console.log('[scheduler] Daily rejection report: nothing to report');
    return;
  }

  try {
    await reportFn(report);
    setAppState('rejectionReport.lastDate', today);
    setAppState('rejectionReport.lastAt', sqliteUtc(now));
    console.log(`[scheduler] Daily rejection report sent (${rows.length} rejections since ${lastAt})`);
  } catch (err) {
    // Leave the markers untouched so the next cycle retries within the same day.
    console.error('[scheduler] Daily rejection report send failed (will retry next cycle):', err instanceof Error ? err.message : err);
  }
}

export function shouldSkipNotifiedFingerprint(
  alreadyNotified: boolean,
  fullRescan: boolean,
): boolean {
  return alreadyNotified && !fullRescan;
}

export function shouldEmitMonitorNotification(fullRescan: boolean): boolean {
  return !fullRescan;
}

export interface SchedulerHandle {
  stop: () => void;
  requestFullRescan: () => FullRescanStatus | null; // null when the scheduler is stopped
}

export function startScheduler(
  intervalMinutes: number,
  notifyFn: (
    userId: number,
    listing: Listing | ItemListing,
    parsedData?: ParsedRentalData | ParsedItemData | null,
    locationScore?: LocationScore | null,
    fitReason?: string | null,
    resultId?: string | null,
  ) => void | Promise<void>,
  reportFn?: (text: string) => void | Promise<void>,
): SchedulerHandle {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  recoverInterruptedFullRescan();

  async function cycle(): Promise<void> {
    if (stopped || running) return;
    running = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }

    console.log(`[scheduler] Starting monitor cycle at ${new Date().toISOString()}`);

    let fullRescan = false;
    let rescanAttempted = 0;
    let rescanProcessingErrors = 0;
    let rescanTotalFound = 0;
    let rescanBeginFailed = false;

    try {
      fullRescan = getFullRescanStatus()?.state === 'queued';
      if (fullRescan) {
        try {
          const status = beginFullRescan();
          console.log(`[scheduler] Full rescan ${status.id} started for ${status.activeMonitors} active monitor(s); notifications suppressed`);
        } catch (beginErr) {
          // Don't let a failing beginFullRescan() (SQLITE_BUSY, disk full, …) hot-loop the cycle at
          // 0 ms: skip the rescan this cycle and fall back to the normal interval (retried next tick).
          console.error('[scheduler] Full rescan failed to begin; skipping this cycle:', beginErr instanceof Error ? beginErr.message : beginErr);
          fullRescan = false;
          rescanBeginFailed = true;
        }
      }

      const results = await runAllMonitors({ ignoreSeen: fullRescan });
      rescanTotalFound = results.reduce((sum, result) => sum + result.totalFound, 0);

      for (const { monitor, runId, totalFound, newListings, searchError } of results) {
        if (searchError !== null) {
          if (fullRescan) rescanProcessingErrors++;
          continue;
        }
        if (newListings.length > 0) {
          const candidateKind = fullRescan ? 'full-rescan candidate' : 'new listing';
          console.log(`[scheduler] Monitor #${monitor.id} (${monitor.type}): ${newListings.length} ${candidateKind}(s)`);
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
          const perCycleCap = fullRescan ? Number.POSITIVE_INFINITY : 25;
          const ordered = monitor.type === 'rental'
            ? [...newListings].sort((a, b) => preScore(b as Listing) - preScore(a as Listing))
            : newListings;
          const toProcess = ordered.slice(0, perCycleCap);
          if (newListings.length > perCycleCap) {
            console.log(`[scheduler] Monitor #${monitor.id}: capping ${newListings.length} new listings at ${perCycleCap} this cycle`);
          }

          for (const listing of toProcess) {
            if (fullRescan) rescanAttempted++;
            try {
              // Cross-monitor notification dedup — persistent (across cycles + monitors), so a
              // shared flat isn't re-alerted when one monitor defers it past the per-cycle cap.
              // Key from the PRE-enrich listing so enrichment can't shift it between check and mark.
              const dedupKey = monitor.type === 'rental'
                ? notificationDedupKey(listing as Listing)
                : `item:${listing.platform}:${listing.platformId}`;
              if (shouldSkipNotifiedFingerprint(isFingerprintNotified(dedupKey), fullRescan)) {
                markListingSeen(monitor.id, listing.platform, listing.platformId, listing.url, listing.title, listing.price);
                continue;
              }

              // Pre-parse budget short-circuit: base rent alone over budget → skip enrich + AI.
              if (monitor.type === 'rental' && monitorConfig.priceTo != null) {
                const l = listing as Listing;
                if (exceedsBudgetFloor(l, monitorConfig.priceTo)) {
                  console.log(`[scheduler] Budget pre-reject "${l.title}": аренда ${l.price} > ${monitorConfig.priceTo} (no AI call)`);
                  recordMonitorRejection(monitor.id, l, 'budget_floor', `аренда ${l.price} zł > ${monitorConfig.priceTo} zł`);
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
                  const category = !triage.apartment ? 'room_coliving' : 'room_count';
                  const reason = !triage.apartment ? 'комната/подселение, не отдельная квартира' : `${effRooms}-комн. — не по числу комнат`;
                  recordMonitorRejection(monitor.id, l, category, reason);
                  markListingSeen(monitor.id, l.platform, l.platformId, l.url, l.title, l.price);
                  continue;
                }
              }

              let workingListing = listing;
              if (monitor.type === 'rental') {
                workingListing = await enrichRentalListing(listing as Listing);
              } else if (!(listing as ItemListing).phone) {
                // Mirror find_items: fetch the contact phone best-effort so scheduled item
                // alerts carry 📞 too. Doesn't change platform/platformId, so seen/dedup stay stable.
                try {
                  const phone = await fetchItemPhone(listing.platformId);
                  if (phone) workingListing = { ...(listing as ItemListing), phone };
                } catch (e) { console.warn('[scheduler] item phone fetch failed:', e instanceof Error ? e.message : e); }
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
                recordMonitorRejection(monitor.id, workingListing, 'not_concrete', 'не конкретная квартира');
                markListingSeen(monitor.id, workingListing.platform, workingListing.platformId, workingListing.url, workingListing.title, workingListing.price);
                continue;
              }

              try {
                // Best-effort early cache without ID — recall for rejected listings is low value.
                // Delivered alerts overwrite with a real resultId below.
                cacheListing({
                  platform: workingListing.platform,
                  platformId: workingListing.platformId,
                  kind: monitor.type === 'rental' ? 'rental' : 'item',
                  resultId: getCachedListingByPlatform(workingListing.platform, workingListing.platformId)?.resultId ?? null,
                  listing: workingListing,
                });
              } catch (cacheErr) {
                console.error('[scheduler] cacheListing failed:', cacheErr instanceof Error ? cacheErr.message : cacheErr);
              }

              const config = monitorConfig;
              if (monitor.type === 'rental' && (config.priceTo != null || config.priceFrom != null)) {
                const l = workingListing as Listing;
                const cost = computeRentalCost(l, parsedData as ParsedRentalData | null);
                // A base rent already over the cap is a certain reject regardless of parse state.
                if (config.priceTo != null && cost.najem > config.priceTo) {
                  console.log(`[scheduler] Budget reject "${l.title}": najem ${cost.najem} > ${config.priceTo}`);
                  recordMonitorRejection(monitor.id, l, 'budget_max', `аренда ${cost.najem} zł > ${config.priceTo} zł`);
                  markListingSeen(monitor.id, l.platform, l.platformId, l.url, l.title, l.price);
                  continue;
                }
                // Parse failed (transient AI/API error) → czynsz/media unknown, total unverifiable.
                // DEFER: don't deliver a possibly-over-budget flat, and don't mark seen, so it is
                // re-attempted next cycle instead of silently passing on the base rent alone.
                if (!parsedData) {
                  console.log(`[scheduler] Defer (parse failed — budget unverifiable) "${l.title}"`);
                  continue;
                }
                // "Zapytaj o cenę" (no base rent): czynsz+media is NOT the real cost — can't verify budget.
                if (!cost.basePriceKnown) {
                  console.log(`[scheduler] Budget reject "${l.title}": цена не указана`);
                  recordMonitorRejection(monitor.id, l, 'budget_max', 'цена не указана — бюджет не проверить');
                  markListingSeen(monitor.id, l.platform, l.platformId, l.url, l.title, l.price);
                  continue;
                }
                const estimatedTotal = cost.total;
                if (config.priceTo != null && estimatedTotal > config.priceTo) {
                  console.log(`[scheduler] Budget reject "${l.title}": ${estimatedTotal} > ${config.priceTo}`);
                  recordMonitorRejection(monitor.id, l, 'budget_max', `итог ~${estimatedTotal} zł > ${config.priceTo} zł`);
                  markListingSeen(monitor.id, l.platform, l.platformId, l.url, l.title, l.price);
                  continue;
                }
                // priceFrom = min TOTAL, enforced here (not by the platform base-rent filter).
                if (config.priceFrom != null && estimatedTotal < config.priceFrom) {
                  console.log(`[scheduler] Below-min reject "${l.title}": ${estimatedTotal} < ${config.priceFrom}`);
                  recordMonitorRejection(monitor.id, l, 'budget_min', `итог ~${estimatedTotal} zł < ${config.priceFrom} zł`);
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
                recordMonitorRejection(monitor.id, workingListing, 'contract', `тип договора ${(parsedData as ParsedRentalData).contractType?.replace(/_/g, ' ')}`);
                markListingSeen(monitor.id, workingListing.platform, workingListing.platformId, workingListing.url, workingListing.title, workingListing.price);
                continue;
              }

              if (config.rejectionCriteria && parsedData) {
                try {
                  const rejectionResult = await evaluateRejection(workingListing, parsedData, config.rejectionCriteria, { monitorId: monitor.id, userId: monitor.user_id });
                  if (rejectionResult.rejected) {
                    recordMonitorRejection(monitor.id, workingListing, 'criteria', rejectionResult.rejectionReason ?? 'по вашим критериям');
                    markListingSeen(monitor.id, workingListing.platform, workingListing.platformId, workingListing.url, workingListing.title, workingListing.price);
                    continue;
                  }
                } catch (rejErr) {
                  console.error('[scheduler] Rejection eval failed:', rejErr);
                }
              }

              let locationScore: LocationScore | null = null;
              // Always enrich rentals: every card now shows nearest metro + Warszawa Centralna,
              // even when no amenity/workAddress filter was requested.
              if (monitor.type === 'rental') {
                try {
                  const { enrichListingLocation } = await import('../ai/location.js');
                  const enriched = await enrichListingLocation(workingListing as Listing, parsedData as ParsedRentalData | null);
                  if (enriched.lat != null && enriched.lng != null) {
                    if (enriched.precision === 'exact' || enriched.precision === 'street') {
                      (workingListing as Listing).lat = enriched.lat;
                      (workingListing as Listing).lng = enriched.lng;
                    }
                    locationScore = await scoreLocation(
                      enriched.lat,
                      enriched.lng,
                      config.amenities ?? [],
                      config.workAddress,
                      config.commuteMode,
                      enriched,
                    );
                  } else {
                    locationScore = createUnknownLocationScore(
                      config.amenities ?? [],
                      (workingListing as Listing).city,
                      `точное местоположение не удалось определить (${enriched.source})`,
                      enriched.evidence,
                    );
                  }
                } catch (mapErr) {
                  console.error('[scheduler] Location enrich/scoring failed:', mapErr);
                  locationScore = createUnknownLocationScore(
                    config.amenities ?? [],
                    (workingListing as Listing).city,
                    'местоположение или расстояния не удалось проверить',
                  );
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
                  recordMonitorRejection(monitor.id, workingListing, 'amenity', gate.reason ?? 'далеко до удобств');
                  markListingSeen(monitor.id, workingListing.platform, workingListing.platformId, workingListing.url, workingListing.title, workingListing.price);
                  continue;
                }

                const centerGate = checkCenterGate(locationScore, config.maxCenterMinutes, locationScore?.precision);
                if (!centerGate.pass) {
                  console.log(`[scheduler] Center reject "${workingListing.title}": ${centerGate.reason}`);
                  recordMonitorRejection(monitor.id, workingListing, 'amenity', centerGate.reason ?? 'далеко от центра');
                  markListingSeen(monitor.id, workingListing.platform, workingListing.platformId, workingListing.url, workingListing.title, workingListing.price);
                  continue;
                }
              }

              let fitReason: string | null = null;
              if (monitor.type === 'rental') {
                const fit = computeFitScore(workingListing as Listing, parsedData as ParsedRentalData | null, locationScore);
                fitReason = `${fit.score}${fit.reason ? ' · ' + fit.reason : ''}`;
              }

              // Reuse a prior search/monitor result ID when present so one flat ↔ one code.
              const existingId = getCachedListingByPlatform(workingListing.platform, workingListing.platformId)?.resultId;
              const resultId = existingId ?? newUniqueResultId();
              try {
                cacheListing({
                  platform: workingListing.platform,
                  platformId: workingListing.platformId,
                  kind: monitor.type === 'rental' ? 'rental' : 'item',
                  resultId,
                  listing: workingListing,
                });
              } catch (cacheErr) {
                console.error('[scheduler] cacheListing (deliver) failed:', cacheErr instanceof Error ? cacheErr.message : cacheErr);
              }
              seedResultIdForFamily(resultId, workingListing, monitor.user_id);

              if (shouldEmitMonitorNotification(fullRescan)) {
                await notifyFn(
                  monitor.user_id,
                  workingListing,
                  parsedData,
                  locationScore,
                  fitReason,
                  resultId,
                );
                markFingerprintNotified(dedupKey); // household-wide, so no other monitor re-alerts it
                delivered++;
              }
              markListingSeen(monitor.id, workingListing.platform, workingListing.platformId, workingListing.url, workingListing.title, workingListing.price);
            } catch (listingErr) {
              if (fullRescan) rescanProcessingErrors++;
              console.error('[scheduler] Listing processing failed — listing NOT marked as seen (will retry next cycle):', listingErr);
            }
          }
        } catch (perMonitorErr) {
          if (fullRescan) rescanProcessingErrors++;
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

      if (fullRescan) {
        const status = finishFullRescan({
          totalFound: rescanTotalFound,
          attempted: rescanAttempted,
          processingErrors: rescanProcessingErrors,
          error: rescanProcessingErrors > 0
            ? `${rescanProcessingErrors} search or listing processing error(s)`
            : null,
        });
        console.log(`[scheduler] Full rescan ${status.id} ${status.state}: ${status.attempted}/${status.totalFound ?? 0} candidate(s) attempted, ${status.processingErrors} error(s), notifications suppressed`);
      }

      cleanOldSeen(30);
      cleanOldCachedListings(90);
      cleanOldNotifiedFingerprints(30);
      cleanOldMonitorRejections(7); // consumed by the daily report; keep a small buffer
      cleanOldTelegramMessageRefs(30);

      // Once-per-day aggregated rejection digest (monitors are silent per-listing).
      if (reportFn && !fullRescan) {
        try {
          await maybeSendDailyRejectionReport(reportFn);
        } catch (err) {
          console.error('[scheduler] Daily rejection report check failed:', err instanceof Error ? err.message : err);
        }
      }

      const totalNew = results.reduce((sum, r) => sum + r.newListings.length, 0);
      console.log(`[scheduler] Cycle complete — ${results.length} monitors, ${totalNew} unseen listings`);
    } catch (err) {
      console.error('[scheduler] Cycle error:', err);
      if (fullRescan && getFullRescanStatus()?.state === 'running') {
        try {
          finishFullRescan({
            totalFound: rescanTotalFound,
            attempted: rescanAttempted,
            processingErrors: rescanProcessingErrors + 1,
            error: err instanceof Error ? err.message : String(err),
          });
        } catch (finishErr) {
          console.error('[scheduler] Failed to persist full rescan failure state:', finishErr);
        }
      }
    } finally {
      running = false;
      if (!stopped) {
        // Fast-follow a queued rescan only when begin succeeded this cycle; a failed begin falls back
        // to the normal interval so a persistent begin error can't hot-loop the scheduler.
        const rescanQueued = getFullRescanStatus()?.state === 'queued';
        timer = setTimeout(cycle, rescanQueued && !rescanBeginFailed ? 0 : intervalMinutes * 60 * 1000);
      }
    }
  }

  void cycle();

  return {
    stop: () => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      console.log('[scheduler] Stopped');
    },
    requestFullRescan: () => {
      // Don't queue on a stopped scheduler — the persisted 'queued' state would silently fire on the
      // next process boot with nobody having asked for it.
      if (stopped) return getFullRescanStatus();
      const status = queueFullRescan();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (!running) {
        timer = setTimeout(cycle, 0);
      }
      return status;
    },
  };
}
