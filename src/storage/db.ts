import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserRow {
  telegram_id: number;
  username: string | null;
  authorized: number; // 0 | 1
  created_at: string;
}

export interface MonitorRow {
  id: number;
  user_id: number;
  type: string;       // 'rental' | 'item'
  platform: string;   // 'olx' | 'otodom' | 'all' | 'allegro' | 'multi'
  config: string;     // JSON
  active: number;     // 0 | 1
  created_at: string;
}

export interface SeenListingRow {
  id: number;
  monitor_id: number;
  platform: string;
  platform_id: string;
  url: string;
  title: string;
  price: number | null;
  first_seen_at: string;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    telegram_id   INTEGER PRIMARY KEY,
    username      TEXT,
    authorized    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS monitors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('rental', 'item')),
    platform    TEXT NOT NULL CHECK (platform IN ('olx', 'otodom', 'all', 'allegro', 'multi')),
    config      TEXT NOT NULL DEFAULT '{}',
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(telegram_id)
  );

  CREATE TABLE IF NOT EXISTS seen_listings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id    INTEGER NOT NULL,
    platform      TEXT NOT NULL,
    platform_id   TEXT NOT NULL,
    url           TEXT NOT NULL,
    title         TEXT NOT NULL,
    price         REAL,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(monitor_id, platform, platform_id),
    FOREIGN KEY (monitor_id) REFERENCES monitors(id)
  );

  CREATE INDEX IF NOT EXISTS idx_monitors_user
    ON monitors(user_id, active);

  CREATE INDEX IF NOT EXISTS idx_seen_monitor
    ON seen_listings(monitor_id, first_seen_at);

  CREATE TABLE IF NOT EXISTS conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(telegram_id)
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_user
    ON conversations(user_id, created_at);

  CREATE TABLE IF NOT EXISTS parsed_listings (
    platform        TEXT NOT NULL,
    platform_id     TEXT NOT NULL,
    parse_type      TEXT NOT NULL CHECK (parse_type IN ('rental', 'item')),
    parsed_data     TEXT NOT NULL,
    description_hash TEXT NOT NULL,
    parsed_at       TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (platform, platform_id)
  );

  CREATE TABLE IF NOT EXISTS maps_cache (
    cache_key    TEXT PRIMARY KEY,
    result       TEXT NOT NULL,
    cached_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? process.env.DB_PATH ?? './data/bot.sqlite';

  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(SCHEMA);

  return db;
}

// ---------------------------------------------------------------------------
// Lazy singleton
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db === null) {
    _db = initDb();
  }
  return _db;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function addUser(telegramId: number, username: string | null): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO users (telegram_id, username)
    VALUES (?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username
  `).run(telegramId, username);
}

export function isUserAuthorized(telegramId: number): boolean {
  const db = getDb();
  const row = db.prepare(
    'SELECT authorized FROM users WHERE telegram_id = ?',
  ).get(telegramId) as { authorized: number } | undefined;
  return row?.authorized === 1;
}

export function authorizeUser(telegramId: number): void {
  const db = getDb();
  db.prepare(
    'UPDATE users SET authorized = 1 WHERE telegram_id = ?',
  ).run(telegramId);
}

// ---------------------------------------------------------------------------
// Monitors
// ---------------------------------------------------------------------------

export function addMonitor(
  userId: number,
  type: 'rental' | 'item',
  platform: 'olx' | 'otodom' | 'all' | 'allegro' | 'multi',
  config: Record<string, unknown>,
): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO monitors (user_id, type, platform, config)
    VALUES (?, ?, ?, ?)
  `).run(userId, type, platform, JSON.stringify(config));
  return Number(result.lastInsertRowid);
}

export function getMonitors(userId?: number): MonitorRow[] {
  const db = getDb();
  if (userId !== undefined) {
    return db.prepare(
      'SELECT * FROM monitors WHERE user_id = ? AND active = 1',
    ).all(userId) as MonitorRow[];
  }
  return db.prepare(
    'SELECT * FROM monitors WHERE active = 1',
  ).all() as MonitorRow[];
}

export function getMonitor(id: number): MonitorRow | undefined {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM monitors WHERE id = ?',
  ).get(id) as MonitorRow | undefined;
}

export function deactivateMonitor(id: number): void {
  const db = getDb();
  db.prepare(
    'UPDATE monitors SET active = 0 WHERE id = ?',
  ).run(id);
}

// ---------------------------------------------------------------------------
// Seen listings (dedup)
// ---------------------------------------------------------------------------

export function isListingSeen(
  monitorId: number,
  platform: string,
  platformId: string,
): boolean {
  const db = getDb();
  const row = db.prepare(
    'SELECT 1 FROM seen_listings WHERE monitor_id = ? AND platform = ? AND platform_id = ?',
  ).get(monitorId, platform, platformId);
  return row !== undefined;
}

export function markListingSeen(
  monitorId: number,
  platform: string,
  platformId: string,
  url: string,
  title: string,
  price: number | null,
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO seen_listings (monitor_id, platform, platform_id, url, title, price)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(monitor_id, platform, platform_id) DO NOTHING
  `).run(monitorId, platform, platformId, url, title, price);
}

export function getSeenCount(monitorId: number): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) AS cnt FROM seen_listings WHERE monitor_id = ?',
  ).get(monitorId) as { cnt: number };
  return row.cnt;
}

export function cleanOldSeen(olderThanDays: number): number {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM seen_listings
    WHERE first_seen_at < datetime('now', ? || ' days')
  `).run(`-${olderThanDays}`);
  return result.changes;
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export function saveConversation(userId: number, role: 'user' | 'assistant', content: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO conversations (user_id, role, content)
    VALUES (?, ?, ?)
  `).run(userId, role, content);
}

export function getConversationHistory(userId: number, limit = 20): { role: string; content: string }[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT role, content FROM conversations
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, limit) as { role: string; content: string }[];
  // Return in chronological order (oldest first)
  return rows.reverse();
}

export function clearConversation(userId: number): void {
  const db = getDb();
  db.prepare('DELETE FROM conversations WHERE user_id = ?').run(userId);
}

// ---------------------------------------------------------------------------
// Parsed listings cache
// ---------------------------------------------------------------------------

export function getParsedListing(
  platform: string,
  platformId: string,
): { parsed_data: string; description_hash: string } | undefined {
  const db = getDb();
  return db.prepare(
    'SELECT parsed_data, description_hash FROM parsed_listings WHERE platform = ? AND platform_id = ?',
  ).get(platform, platformId) as { parsed_data: string; description_hash: string } | undefined;
}

export function saveParsedListing(
  platform: string,
  platformId: string,
  parseType: string,
  data: string,
  descriptionHash: string,
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO parsed_listings (platform, platform_id, parse_type, parsed_data, description_hash)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(platform, platform_id) DO UPDATE SET
      parse_type = excluded.parse_type,
      parsed_data = excluded.parsed_data,
      description_hash = excluded.description_hash,
      parsed_at = datetime('now')
  `).run(platform, platformId, parseType, data, descriptionHash);
}

// ---------------------------------------------------------------------------
// Maps cache
// ---------------------------------------------------------------------------

export function getMapsCacheEntry(cacheKey: string): string | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT result FROM maps_cache WHERE cache_key = ?',
  ).get(cacheKey) as { result: string } | undefined;
  return row?.result ?? null;
}

export function setMapsCacheEntry(cacheKey: string, result: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO maps_cache (cache_key, result)
    VALUES (?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      result = excluded.result,
      cached_at = datetime('now')
  `).run(cacheKey, result);
}

export function cleanExpiredMapsCache(maxAgeDays = 7): number {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM maps_cache
    WHERE cached_at < datetime('now', ? || ' days')
  `).run(`-${maxAgeDays}`);
  return result.changes;
}

/** Delete cache entries where the stored result has empty places (error-cached data). */
export function clearEmptyMapsCache(): number {
  const db = getDb();
  // Matches cached AmenityResult objects where places array is empty: "places":[]
  const result = db.prepare(`
    DELETE FROM maps_cache
    WHERE cache_key LIKE 'nearby%'
      AND result LIKE '%"places":[]%'
  `).run();
  return result.changes;
}

// ---------------------------------------------------------------------------
// Monitor config update
// ---------------------------------------------------------------------------

export function updateMonitorConfig(monitorId: number, config: Record<string, unknown>): void {
  const db = getDb();
  db.prepare(
    'UPDATE monitors SET config = ? WHERE id = ?',
  ).run(JSON.stringify(config), monitorId);
}
