import 'dotenv/config';
import { initDb } from './storage/db.js';
import { startBot, sendNewListingNotification } from './bot/telegram.js';
import { startScheduler } from './scheduler/monitor.js';
import { closeBrowser } from './crawlers/otodom.js';

// --- Bootstrap ---

initDb();
startBot();

const MONITOR_INTERVAL_MINUTES = 10;
const stopScheduler = startScheduler(MONITOR_INTERVAL_MINUTES, sendNewListingNotification);

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
