import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  beginFullRescan,
  finishFullRescan,
  FullRescanAlreadyActiveError,
  getOperationalStats,
  queueFullRescan,
  resetCaches,
} from '../src/storage/db.js';

function createOperationsDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE parsed_listings (parsed_at TEXT NOT NULL);
    CREATE TABLE rejection_cache (cached_at TEXT NOT NULL);
    CREATE TABLE maps_cache (cached_at TEXT NOT NULL);
    CREATE TABLE monitors (id INTEGER PRIMARY KEY, active INTEGER NOT NULL);
    CREATE TABLE seen_listings (monitor_id INTEGER NOT NULL);
    CREATE TABLE monitor_rejections (monitor_id INTEGER NOT NULL);
    CREATE TABLE notified_fingerprints (fingerprint TEXT PRIMARY KEY);
    CREATE TABLE cached_listings (platform TEXT NOT NULL);
    CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE monitor_runs (
      started_at TEXT NOT NULL,
      listings_found INTEGER NOT NULL,
      listings_unseen INTEGER NOT NULL,
      listings_delivered INTEGER NOT NULL,
      error_message TEXT
    );
    CREATE TABLE ai_usage (
      ts TEXT NOT NULL,
      feature TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_creation_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      local_cache_hit INTEGER NOT NULL,
      duration_ms INTEGER,
      error_message TEXT
    );
  `);
  return db;
}

test('operational stats aggregate tokens, cost, latency, monitors, and caches', () => {
  const db = createOperationsDatabase();
  try {
    db.exec(`
      INSERT INTO parsed_listings VALUES (datetime('now'));
      INSERT INTO rejection_cache VALUES (datetime('now'));
      INSERT INTO maps_cache VALUES (datetime('now'));
      INSERT INTO monitors (id, active) VALUES (1, 1), (2, 0);
      INSERT INTO monitor_runs VALUES (datetime('now'), 8, 3, 2, NULL);
      INSERT INTO monitor_runs VALUES (datetime('now'), 0, 0, 0, 'crawler failed');
      INSERT INTO ai_usage VALUES
        (datetime('now'), 'rental-parse', 'priced-model', 100, 20, 10, 50, 0.0125, 0, 400, NULL),
        (datetime('now'), 'rental-parse', 'priced-model', 0, 0, 0, 0, 0, 1, 5, NULL),
        (datetime('now'), 'fit-score', 'unpriced-model', 40, 10, 0, 0, 0, 0, 100, 'timeout');
    `);

    const stats = getOperationalStats('24h', db);
    assert.equal(stats.usage.apiCalls, 2);
    assert.equal(stats.usage.localCacheHits, 1);
    assert.equal(stats.usage.recordedEvents, 3);
    assert.equal(stats.usage.errorCount, 1);
    assert.equal(stats.usage.totalTokens, 230);
    assert.equal(stats.usage.estimatedCostUsd, 0.0125);
    assert.equal(stats.latencyMs.average, 250);
    assert.equal(stats.latencyMs.p50, 100);
    assert.equal(stats.latencyMs.p95, 400);
    assert.equal(stats.monitors.active, 1);
    assert.equal(stats.monitors.runs, 2);
    assert.equal(stats.monitors.failedRuns, 1);
    assert.deepEqual(stats.unpricedModels, [
      { model: 'unpriced-model', calls: 1, tokens: 50 },
    ]);
    assert.equal(stats.caches.mapsCache.count, 1);
  } finally {
    db.close();
  }
});

test('full rescan queues safely, clears active analysis state, and preserves notification history', () => {
  const db = createOperationsDatabase();
  try {
    db.exec(`
      INSERT INTO monitors (id, active) VALUES (1, 1), (2, 0);
      INSERT INTO parsed_listings VALUES (datetime('now'));
      INSERT INTO rejection_cache VALUES (datetime('now'));
      INSERT INTO maps_cache VALUES (datetime('now'));
      INSERT INTO seen_listings VALUES (1), (2);
      INSERT INTO monitor_rejections VALUES (1), (2);
      INSERT INTO notified_fingerprints VALUES ('already-alerted');
      INSERT INTO cached_listings VALUES ('olx');
      INSERT INTO ai_usage VALUES
        (datetime('now'), 'rental-parse', 'model', 10, 2, 0, 0, 0.001, 0, 100, NULL);
    `);

    const queued = queueFullRescan(db);
    assert.equal(queued.state, 'queued');
    assert.equal(queued.notificationsSuppressed, true);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM parsed_listings').get() as { count: number }).count,
      1,
    );
    assert.throws(() => queueFullRescan(db), FullRescanAlreadyActiveError);

    const running = beginFullRescan(db);
    assert.equal(running.state, 'running');
    assert.deepEqual(running.cleared, {
      parsedListings: 1,
      rejectionCache: 1,
      mapsCache: 1,
      seenListings: 1,
      monitorRejections: 0, // rescan no longer wipes the daily-digest log (bounded by cleanOldMonitorRejections)
    });
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM seen_listings WHERE monitor_id = 2').get() as { count: number }).count,
      1,
    );
    // monitor_rejections is the daily-digest log, not analysis state — the rescan must PRESERVE it so
    // rejections accumulated since the last digest (incl. flats since delisted) aren't lost.
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM monitor_rejections').get() as { count: number }).count,
      2,
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM notified_fingerprints').get() as { count: number }).count,
      1,
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM cached_listings').get() as { count: number }).count,
      1,
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM ai_usage').get() as { count: number }).count,
      1,
    );

    const completed = finishFullRescan({
      totalFound: 88,
      attempted: 88,
      processingErrors: 0,
    }, db);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.totalFound, 88);
    assert.equal(completed.attempted, 88);
    assert.equal(completed.processingErrors, 0);
  } finally {
    db.close();
  }
});

test('all-cache reset clears derived rows and preserves usage telemetry', () => {
  const db = createOperationsDatabase();
  try {
    db.exec(`
      INSERT INTO parsed_listings VALUES (datetime('now'));
      INSERT INTO rejection_cache VALUES (datetime('now'));
      INSERT INTO maps_cache VALUES (datetime('now'));
      INSERT INTO ai_usage VALUES
        (datetime('now'), 'rental-parse', 'model', 10, 2, 0, 0, 0.001, 0, 100, NULL);
    `);

    const result = resetCaches('all', db);
    assert.deepEqual(result.deleted, {
      parsedListings: 1,
      rejectionCache: 1,
      mapsCache: 1,
    });
    assert.equal(result.after.parsedListings.count, 0);
    assert.equal(result.after.rejectionCache.count, 0);
    assert.equal(result.after.mapsCache.count, 0);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM ai_usage').get() as { count: number }).count,
      1,
    );
    assert.ok(result.preserved.includes('ai_usage'));
  } finally {
    db.close();
  }
});
