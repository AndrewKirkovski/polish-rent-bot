import 'dotenv/config';
import { getDb, cleanOldCachedListings, cleanExpiredMapsCache, cleanOldNotifiedFingerprints, cleanOldMonitorRejections, cleanOldTelegramMessageRefs, cleanOldParsedListings, cleanOldRejectionCache } from './storage/db.js';
import { initMapsCacheMaintenance } from './ai/maps.js';
import { startBot, broadcastEnrichedNotification, broadcastText } from './bot/telegram.js';
import { startScheduler } from './scheduler/monitor.js';
import { closeBrowser } from './crawlers/otodom.js';
import { startHttpServer } from './server/http.js';

// --- Global error handlers FIRST — before anything else can throw ---

process.on('unhandledRejection', (reason, _promise) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1);
});

// --- Config sanity check (fail loud on missing required keys, warn on optional) ---

if (!process.env.TELEGRAM_TOKEN) {
  console.error('[FATAL] TELEGRAM_TOKEN is required');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[FATAL] ANTHROPIC_API_KEY is required (AI parsing/agent will fail without it)');
  process.exit(1);
}
if (!process.env.GOOGLE_MAPS_API_KEY) {
  // Not fatal: affected listings are kept with an explicit unknown-location warning.
  console.warn('[startup] GOOGLE_MAPS_API_KEY not set — location checks are unavailable; listings will be kept with warnings');
}

// --- Bootstrap ---

getDb(); // initialize DB singleton (creates tables if needed)

// One-time cache maintenance on boot — these tables otherwise grow without bound.
try {
  const prunedListings = cleanOldCachedListings();
  const prunedMaps = cleanExpiredMapsCache();
  const prunedNotified = cleanOldNotifiedFingerprints(30); // a flat re-listed >30d later is genuinely new
  const prunedRejections = cleanOldMonitorRejections(7);   // only consumed by the daily report
  const prunedMsgRefs = cleanOldTelegramMessageRefs(30);
  const prunedParses = cleanOldParsedListings(90);
  const prunedRejCache = cleanOldRejectionCache(30);
  initMapsCacheMaintenance(); // purge error-flagged nearby caches (no longer a maps.ts import side effect)
  if (prunedListings || prunedMaps || prunedNotified || prunedRejections || prunedMsgRefs || prunedParses || prunedRejCache) {
    console.log(`[startup] pruned ${prunedListings} cached listings, ${prunedMaps} maps entries, ${prunedNotified} notified fingerprints, ${prunedRejections} monitor rejections, ${prunedMsgRefs} telegram message refs, ${prunedParses} parses, ${prunedRejCache} rejection-cache entries`);
  }
} catch (err) {
  console.error('[startup] cache prune failed:', err instanceof Error ? err.message : err);
}

startBot();

const MONITOR_INTERVAL_MINUTES = 10;
const scheduler = startScheduler(
  MONITOR_INTERVAL_MINUTES,
  (_userId, listing, parsedData, locationScore, fitReason, resultId) =>
    broadcastEnrichedNotification(listing, parsedData, locationScore, fitReason, resultId),
  (text) => broadcastText(text),
);

const httpServer = startHttpServer({
  requestFullRescan: scheduler.requestFullRescan,
});

console.log(`Polish Rent Bot started. Monitoring every ${MONITOR_INTERVAL_MINUTES} minutes.`);

// --- Graceful shutdown ---

async function shutdown(signal: string): Promise<void> {
  console.log(`\nReceived ${signal}. Shutting down...`);
  scheduler.stop();
  if (httpServer) {
    try { await httpServer.close(); } catch (err) { console.error('[shutdown] http close failed:', err); }
  }
  try {
    await closeBrowser();
  } catch (err) {
    console.error('[shutdown] closeBrowser failed:', err);
  }
  process.exit(0);
}

process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
