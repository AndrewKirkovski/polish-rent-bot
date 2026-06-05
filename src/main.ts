import 'dotenv/config';
import { getDb, cleanOldCachedListings, cleanExpiredMapsCache } from './storage/db.js';
import { startBot, sendEnrichedNotification } from './bot/telegram.js';
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

// --- Bootstrap ---

getDb(); // initialize DB singleton (creates tables if needed)

// One-time cache maintenance on boot — these tables otherwise grow without bound.
try {
  const prunedListings = cleanOldCachedListings();
  const prunedMaps = cleanExpiredMapsCache();
  if (prunedListings || prunedMaps) {
    console.log(`[startup] pruned ${prunedListings} old cached listings, ${prunedMaps} expired maps entries`);
  }
} catch (err) {
  console.error('[startup] cache prune failed:', err instanceof Error ? err.message : err);
}

startBot();

const MONITOR_INTERVAL_MINUTES = 10;
const stopScheduler = startScheduler(MONITOR_INTERVAL_MINUTES, sendEnrichedNotification);

const httpServer = startHttpServer();

console.log(`Polish Rent Bot started. Monitoring every ${MONITOR_INTERVAL_MINUTES} minutes.`);

// --- Graceful shutdown ---

async function shutdown(signal: string): Promise<void> {
  console.log(`\nReceived ${signal}. Shutting down...`);
  stopScheduler();
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
