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

  CREATE TABLE IF NOT EXISTS rejection_cache (
    platform         TEXT NOT NULL,
    platform_id      TEXT NOT NULL,
    criteria_hash    TEXT NOT NULL,
    rejected         INTEGER NOT NULL DEFAULT 0,
    rejection_reason TEXT,
    cached_at        TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (platform, platform_id, criteria_hash)
  );

  CREATE TABLE IF NOT EXISTS ai_usage (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                    TEXT NOT NULL DEFAULT (datetime('now')),
    feature               TEXT NOT NULL,
    model                 TEXT NOT NULL,
    input_tokens          INTEGER NOT NULL DEFAULT 0,
    output_tokens         INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
    cost_usd              REAL NOT NULL DEFAULT 0,
    local_cache_hit       INTEGER NOT NULL DEFAULT 0,
    duration_ms           INTEGER,
    monitor_id            INTEGER,
    user_id               INTEGER,
    error_message         TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_ai_usage_ts
    ON ai_usage(ts);

  CREATE INDEX IF NOT EXISTS idx_ai_usage_feature_ts
    ON ai_usage(feature, ts);

  CREATE TABLE IF NOT EXISTS monitor_runs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id          INTEGER NOT NULL,
    started_at          TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at         TEXT,
    listings_found      INTEGER NOT NULL DEFAULT 0,  -- total candidates after dedup
    listings_unseen     INTEGER NOT NULL DEFAULT 0,  -- not in seen_listings yet
    listings_delivered  INTEGER NOT NULL DEFAULT 0,  -- actually sent to user (post-filter)
    error_message       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_monitor_runs_started
    ON monitor_runs(monitor_id, started_at DESC);
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

  runMigrations(db);

  return db;
}

// ---------------------------------------------------------------------------
// Migrations — additive in-place changes when the bootstrap CREATE TABLE
// IF NOT EXISTS misses a column on a pre-existing table.
// ---------------------------------------------------------------------------

function runMigrations(db: Database.Database): void {
  // 2026-04-28: monitor_runs renamed `listings_new` -> `listings_unseen` and added
  // `listings_delivered` so the dashboard can show "actually sent" vs "fetched but filtered".
  const cols = db.prepare(`PRAGMA table_info(monitor_runs)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (names.has('listings_new') && !names.has('listings_unseen')) {
    db.exec(`ALTER TABLE monitor_runs RENAME COLUMN listings_new TO listings_unseen`);
  }
  if (!names.has('listings_delivered')) {
    db.exec(`ALTER TABLE monitor_runs ADD COLUMN listings_delivered INTEGER NOT NULL DEFAULT 0`);
  }
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
// Rejection cache (two-tier AI caching)
// ---------------------------------------------------------------------------

export function getRejectionCache(
  platform: string,
  platformId: string,
  criteriaHash: string,
): { rejected: boolean; rejectionReason: string | null } | undefined {
  const db = getDb();
  const row = db.prepare(
    'SELECT rejected, rejection_reason FROM rejection_cache WHERE platform = ? AND platform_id = ? AND criteria_hash = ?',
  ).get(platform, platformId, criteriaHash) as { rejected: number; rejection_reason: string | null } | undefined;
  if (!row) return undefined;
  return {
    rejected: row.rejected === 1,
    rejectionReason: row.rejection_reason,
  };
}

export function saveRejectionCache(
  platform: string,
  platformId: string,
  criteriaHash: string,
  rejected: boolean,
  rejectionReason: string | null,
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO rejection_cache (platform, platform_id, criteria_hash, rejected, rejection_reason)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(platform, platform_id, criteria_hash) DO UPDATE SET
      rejected = excluded.rejected,
      rejection_reason = excluded.rejection_reason,
      cached_at = datetime('now')
  `).run(platform, platformId, criteriaHash, rejected ? 1 : 0, rejectionReason);
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

// ---------------------------------------------------------------------------
// AI usage tracking
// ---------------------------------------------------------------------------

export interface AiUsageRow {
  feature: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  localCacheHit: 0 | 1;
  durationMs: number | null;
  monitorId: number | null;
  userId: number | null;
  errorMessage: string | null;
}

export function insertAiUsage(row: AiUsageRow): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO ai_usage (
      feature, model,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      cost_usd, local_cache_hit, duration_ms,
      monitor_id, user_id, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.feature, row.model,
    row.inputTokens, row.outputTokens, row.cacheCreationTokens, row.cacheReadTokens,
    row.costUsd, row.localCacheHit, row.durationMs,
    row.monitorId, row.userId, row.errorMessage,
  );
}

export type UsageRange = '24h' | '7d' | '30d' | 'all';

function rangeToSqliteModifier(range: UsageRange): string | null {
  switch (range) {
    case '24h': return '-1 days';
    case '7d':  return '-7 days';
    case '30d': return '-30 days';
    case 'all': return null;
  }
}

// Bind helper: return params for a parameterised `WHERE ts >= datetime('now', ?)`
// or `null` to skip the filter entirely.
function rangeBind(range: UsageRange): string | null {
  return rangeToSqliteModifier(range);
}

export interface UsageSummary {
  range: UsageRange;
  costUsd: number;
  apiCalls: number;
  localCacheHits: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  errorCount: number;
}

export function getUsageSummary(range: UsageRange): UsageSummary {
  const db = getDb();
  const bind = rangeBind(range);
  const where = bind ? `WHERE ts >= datetime('now', ?)` : '';
  const sql = `
    SELECT
      COALESCE(SUM(cost_usd), 0)                                    AS cost_usd,
      COALESCE(SUM(CASE WHEN local_cache_hit = 0 THEN 1 ELSE 0 END), 0) AS api_calls,
      COALESCE(SUM(local_cache_hit), 0)                             AS local_cache_hits,
      COALESCE(SUM(input_tokens), 0)                                AS input_tokens,
      COALESCE(SUM(output_tokens), 0)                               AS output_tokens,
      COALESCE(SUM(cache_creation_tokens), 0)                       AS cache_creation_tokens,
      COALESCE(SUM(cache_read_tokens), 0)                           AS cache_read_tokens,
      COALESCE(SUM(CASE WHEN error_message IS NOT NULL THEN 1 ELSE 0 END), 0) AS error_count
    FROM ai_usage ${where}
  `;
  const stmt = db.prepare(sql);
  const row = (bind ? stmt.get(bind) : stmt.get()) as Record<string, number>;
  return {
    range,
    costUsd: row.cost_usd,
    apiCalls: row.api_calls,
    localCacheHits: row.local_cache_hits,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    cacheReadTokens: row.cache_read_tokens,
    errorCount: row.error_count,
  };
}

export interface UsageBucket {
  bucket: string;        // ISO-ish timestamp anchored to bucket start
  feature: string;
  calls: number;
  localCacheHits: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export function getUsageTimeSeries(
  range: UsageRange,
  bucket: 'hour' | 'day',
): UsageBucket[] {
  const db = getDb();
  const bind = rangeBind(range);
  const where = bind ? `WHERE ts >= datetime('now', ?)` : '';
  // bucket is gated by a typed union literal on input; safe to interpolate.
  const fmt = bucket === 'hour' ? "%Y-%m-%dT%H:00:00" : "%Y-%m-%d";
  const sql = `
    SELECT
      strftime('${fmt}', ts) AS bucket,
      feature                AS feature,
      COALESCE(SUM(CASE WHEN local_cache_hit = 0 THEN 1 ELSE 0 END), 0) AS calls,
      COALESCE(SUM(local_cache_hit), 0)        AS local_cache_hits,
      COALESCE(SUM(cost_usd), 0)               AS cost_usd,
      COALESCE(SUM(input_tokens), 0)           AS input_tokens,
      COALESCE(SUM(output_tokens), 0)          AS output_tokens,
      COALESCE(SUM(cache_creation_tokens), 0)  AS cache_creation_tokens,
      COALESCE(SUM(cache_read_tokens), 0)      AS cache_read_tokens
    FROM ai_usage
    ${where}
    GROUP BY bucket, feature
    ORDER BY bucket ASC, feature ASC
  `;
  const stmt = db.prepare(sql);
  const rows = (bind ? stmt.all(bind) : stmt.all()) as Array<Record<string, string | number>>;
  return rows.map((r) => ({
    bucket: String(r.bucket),
    feature: String(r.feature),
    calls: Number(r.calls),
    localCacheHits: Number(r.local_cache_hits),
    costUsd: Number(r.cost_usd),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheCreationTokens: Number(r.cache_creation_tokens),
    cacheReadTokens: Number(r.cache_read_tokens),
  }));
}

export interface RecentUsageRow {
  id: number;
  ts: string;
  feature: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  localCacheHit: number;
  durationMs: number | null;
  monitorId: number | null;
  userId: number | null;
  errorMessage: string | null;
}

export function getRecentUsage(limit = 100): RecentUsageRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      id, ts, feature, model,
      input_tokens          AS inputTokens,
      output_tokens         AS outputTokens,
      cache_creation_tokens AS cacheCreationTokens,
      cache_read_tokens     AS cacheReadTokens,
      cost_usd              AS costUsd,
      local_cache_hit       AS localCacheHit,
      duration_ms           AS durationMs,
      monitor_id            AS monitorId,
      user_id               AS userId,
      error_message         AS errorMessage
    FROM ai_usage
    ORDER BY id DESC
    LIMIT ?
  `).all(limit) as RecentUsageRow[];
  return rows;
}

// ---------------------------------------------------------------------------
// Cache stats (parsed_listings, rejection_cache, maps_cache)
// ---------------------------------------------------------------------------

export interface CacheStats {
  parsedListings: { count: number; oldestTs: string | null; newestTs: string | null };
  rejectionCache: { count: number; oldestTs: string | null; newestTs: string | null };
  mapsCache: { count: number; oldestTs: string | null; newestTs: string | null; expiredCount: number };
  localHitRate24h: number; // 0..1
}

export function getCacheStats(mapsTtlDays = 7): CacheStats {
  const db = getDb();
  const parsed = db.prepare(`SELECT COUNT(*) AS c, MIN(parsed_at) AS oldest, MAX(parsed_at) AS newest FROM parsed_listings`).get() as { c: number; oldest: string | null; newest: string | null };
  const rejection = db.prepare(`SELECT COUNT(*) AS c, MIN(cached_at) AS oldest, MAX(cached_at) AS newest FROM rejection_cache`).get() as { c: number; oldest: string | null; newest: string | null };
  const maps = db.prepare(`SELECT COUNT(*) AS c, MIN(cached_at) AS oldest, MAX(cached_at) AS newest FROM maps_cache`).get() as { c: number; oldest: string | null; newest: string | null };
  const expired = db.prepare(`SELECT COUNT(*) AS c FROM maps_cache WHERE cached_at < datetime('now', ? || ' days')`).get(`-${mapsTtlDays}`) as { c: number };

  const hitRow = db.prepare(`
    SELECT
      COALESCE(SUM(local_cache_hit), 0) AS hits,
      COUNT(*)                          AS total
    FROM ai_usage
    WHERE ts >= datetime('now', '-1 days')
  `).get() as { hits: number; total: number };
  const localHitRate24h = hitRow.total > 0 ? hitRow.hits / hitRow.total : 0;

  return {
    parsedListings: { count: parsed.c, oldestTs: parsed.oldest, newestTs: parsed.newest },
    rejectionCache: { count: rejection.c, oldestTs: rejection.oldest, newestTs: rejection.newest },
    mapsCache: { count: maps.c, oldestTs: maps.oldest, newestTs: maps.newest, expiredCount: expired.c },
    localHitRate24h,
  };
}

// ---------------------------------------------------------------------------
// Monitor runs tracking
// ---------------------------------------------------------------------------

export function startMonitorRun(monitorId: number): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO monitor_runs (monitor_id) VALUES (?)
  `).run(monitorId);
  return Number(result.lastInsertRowid);
}

export interface MonitorRunFinish {
  listingsFound: number;
  listingsUnseen: number;
  listingsDelivered: number;
  errorMessage?: string | null;
}

export function finishMonitorRun(runId: number, finish: MonitorRunFinish): void {
  const db = getDb();
  db.prepare(`
    UPDATE monitor_runs
    SET finished_at        = datetime('now'),
        listings_found     = ?,
        listings_unseen    = ?,
        listings_delivered = ?,
        error_message      = ?
    WHERE id = ?
  `).run(
    finish.listingsFound,
    finish.listingsUnseen,
    finish.listingsDelivered,
    finish.errorMessage ?? null,
    runId,
  );
}

export interface MonitorRunRow {
  id: number;
  monitorId: number;
  startedAt: string;
  finishedAt: string | null;
  listingsFound: number;
  listingsUnseen: number;
  listingsDelivered: number;
  errorMessage: string | null;
  durationMs: number | null;
}

export function getMonitorRuns(monitorId: number, limit = 50): MonitorRunRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      id,
      monitor_id         AS monitorId,
      started_at         AS startedAt,
      finished_at        AS finishedAt,
      listings_found     AS listingsFound,
      listings_unseen    AS listingsUnseen,
      listings_delivered AS listingsDelivered,
      error_message      AS errorMessage,
      CASE
        WHEN finished_at IS NULL THEN NULL
        ELSE CAST((julianday(finished_at) - julianday(started_at)) * 86400000 AS INTEGER)
      END AS durationMs
    FROM monitor_runs
    WHERE monitor_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(monitorId, limit) as MonitorRunRow[];
  return rows;
}

export interface MonitorWithStats {
  id: number;
  userId: number;
  type: string;
  platform: string;
  config: string;
  active: number;
  createdAt: string;
  lastRunAt: string | null;
  lastRunDelivered: number | null;
  lastRunError: string | null;
  listingsSeenTotal: number;
  costUsd30d: number;
}

export function getMonitorsWithStats(): MonitorWithStats[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      m.id           AS id,
      m.user_id      AS userId,
      m.type         AS type,
      m.platform     AS platform,
      m.config       AS config,
      m.active       AS active,
      m.created_at   AS createdAt,
      (SELECT started_at         FROM monitor_runs WHERE monitor_id = m.id ORDER BY id DESC LIMIT 1) AS lastRunAt,
      (SELECT listings_delivered FROM monitor_runs WHERE monitor_id = m.id ORDER BY id DESC LIMIT 1) AS lastRunDelivered,
      (SELECT error_message      FROM monitor_runs WHERE monitor_id = m.id ORDER BY id DESC LIMIT 1) AS lastRunError,
      (SELECT COUNT(*)           FROM seen_listings WHERE monitor_id = m.id) AS listingsSeenTotal,
      (SELECT COALESCE(SUM(cost_usd), 0) FROM ai_usage WHERE monitor_id = m.id AND ts >= datetime('now', '-30 days')) AS costUsd30d
    FROM monitors m
    ORDER BY m.active DESC, m.id DESC
  `).all() as MonitorWithStats[];
  return rows;
}

export interface SeenListingDetail {
  id: number;
  monitorId: number;
  platform: string;
  platformId: string;
  url: string;
  title: string;
  price: number | null;
  firstSeenAt: string;
}

export function getMonitorListings(monitorId: number, limit = 50): SeenListingDetail[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      id,
      monitor_id    AS monitorId,
      platform,
      platform_id   AS platformId,
      url, title, price,
      first_seen_at AS firstSeenAt
    FROM seen_listings
    WHERE monitor_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(monitorId, limit) as SeenListingDetail[];
  return rows;
}
