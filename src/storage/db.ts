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
  platform: string;   // 'olx' | 'otodom' | 'all'
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
    platform    TEXT NOT NULL CHECK (platform IN ('olx', 'otodom', 'all')),
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
  platform: 'olx' | 'otodom' | 'all',
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
