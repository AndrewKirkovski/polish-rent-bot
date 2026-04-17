import 'dotenv/config';
import { getDb } from './storage/db.js';
import { startBot, sendEnrichedNotification } from './bot/telegram.js';
import { startScheduler } from './scheduler/monitor.js';
import { closeBrowser } from './crawlers/otodom.js';

// --- Global error handlers FIRST — before anything else can throw ---

process.on('unhandledRejection', (reason, _promise) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1);
});

// --- Bootstrap ---

getDb(); // initialize DB singleton (creates tables if needed)
startBot();

const MONITOR_INTERVAL_MINUTES = 10;
const stopScheduler = startScheduler(MONITOR_INTERVAL_MINUTES, sendEnrichedNotification);

console.log(`Polish Rent Bot started. Monitoring every ${MONITOR_INTERVAL_MINUTES} minutes.`);

// --- Graceful shutdown ---

async function shutdown(signal: string): Promise<void> {
  console.log(`\nReceived ${signal}. Shutting down...`);
  stopScheduler();
  await closeBrowser();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
