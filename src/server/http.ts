// Embedded read-only dashboard API + Vue SPA static server.
// Bound to 127.0.0.1 by default — access via SSH tunnel.

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getUsageSummary,
  getUsageTimeSeries,
  getRecentUsage,
  getCacheStats,
  getOperationalStats,
  resetCaches,
  getFullRescanStatus,
  getMonitorsWithStats,
  getMonitorRuns,
  getMonitorListings,
  listParsedListings,
  getParsedListingDetail,
  listRejectionCache,
  listMapsCache,
  getMapsCacheDetail,
  FullRescanAlreadyActiveError,
  type CacheResetScope,
  type FullRescanStatus,
  type UsageRange,
} from '../storage/db.js';

const VALID_RANGES: UsageRange[] = ['24h', '7d', '30d', 'all'];
const VALID_CACHE_RESET_SCOPES: CacheResetScope[] = ['all', 'location', 'maps', 'ai'];

function parseRange(raw: string | undefined, fallback: UsageRange): UsageRange {
  return VALID_RANGES.includes(raw as UsageRange) ? (raw as UsageRange) : fallback;
}

function parseLimit(raw: string | undefined, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function parseCacheResetScope(raw: unknown): CacheResetScope | null {
  return typeof raw === 'string' && VALID_CACHE_RESET_SCOPES.includes(raw as CacheResetScope)
    ? raw as CacheResetScope
    : null;
}

export function extractAdminToken(
  authorization: string | undefined,
  adminTokenHeader: string | undefined,
): string | null {
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer || adminTokenHeader?.trim() || null;
}

export function adminTokenMatches(
  expected: string | null | undefined,
  provided: string | null | undefined,
): boolean {
  if (!expected || !provided) return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  return expectedBytes.length === providedBytes.length
    && timingSafeEqual(expectedBytes, providedBytes);
}

export interface HttpServerHandle {
  close: () => Promise<void>;
  url: string;
}

export interface HttpServerOptions {
  requestFullRescan?: () => FullRescanStatus;
}

export function startHttpServer(
  options: HttpServerOptions = {},
): HttpServerHandle | null {
  const enabled = (process.env.DASHBOARD_ENABLED ?? 'true').toLowerCase() !== 'false';
  if (!enabled) {
    console.log('[http] DASHBOARD_ENABLED=false, skipping HTTP server');
    return null;
  }

  // `||` (not `??`) so an empty-string env var falls through to the loopback default
  // rather than being passed to listen() as `''` (= bind to all interfaces).
  const host = (process.env.DASHBOARD_HOST || '').trim() || '127.0.0.1';
  const port = Number(process.env.DASHBOARD_PORT ?? 8080);
  const startedAt = new Date().toISOString();

  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    console.warn(`[http] WARNING: dashboard host is "${host}" (non-loopback). Read APIs are unauthenticated; cache reset and full rescan require an admin token.`);
  }

  const app = new Hono();

  // No-store on every API response — prevents stale browser caches across SSH-tunnel reconnects.
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  app.get('/api/health', (c) => c.json({
    ok: true,
    started_at: startedAt,
    uptime_s: Math.floor(process.uptime()),
  }));

  app.get('/api/summary', (c) => {
    const range = parseRange(c.req.query('range'), '24h');
    return c.json(getUsageSummary(range));
  });

  app.get('/api/summary/all', (c) =>
    c.json({
      h24: getUsageSummary('24h'),
      d7: getUsageSummary('7d'),
      d30: getUsageSummary('30d'),
      all: getUsageSummary('all'),
    }),
  );

  app.get('/api/stats', (c) => {
    const range = parseRange(c.req.query('range'), '24h');
    return c.json(getOperationalStats(range));
  });

  app.get('/api/usage/series', (c) => {
    const range = parseRange(c.req.query('range'), '7d');
    const bucket = c.req.query('bucket') === 'hour' ? 'hour' : 'day';
    return c.json(getUsageTimeSeries(range, bucket));
  });

  app.get('/api/usage/recent', (c) => {
    const limit = parseLimit(c.req.query('limit'), 100, 500);
    return c.json(getRecentUsage(limit));
  });

  app.get('/api/cache', (c) => c.json(getCacheStats()));

  app.get('/api/rescan', (c) => c.json({
    status: getFullRescanStatus(),
  }));

  app.post('/api/rescan', async (c) => {
    if (!options.requestFullRescan) {
      return c.json({ error: 'full rescan is unavailable in this process' }, 503);
    }

    const expectedToken = (
      process.env.DASHBOARD_ADMIN_TOKEN
      || process.env.BOT_PASSWORD
      || ''
    ).trim();
    if (!expectedToken) {
      return c.json({ error: 'full rescan is disabled: no admin token is configured' }, 503);
    }

    const providedToken = extractAdminToken(
      c.req.header('Authorization'),
      c.req.header('X-Admin-Token'),
    );
    if (!adminTokenMatches(expectedToken, providedToken)) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const body = await c.req
      .json<{ confirm?: unknown }>()
      .catch(() => null);
    if (body?.confirm !== 'FULL_RESCAN') {
      return c.json({ error: 'confirmation must be exactly FULL_RESCAN' }, 400);
    }

    try {
      return c.json(options.requestFullRescan(), 202);
    } catch (err) {
      if (err instanceof FullRescanAlreadyActiveError) {
        return c.json({ error: err.message, status: getFullRescanStatus() }, 409);
      }
      return c.json({
        error: err instanceof Error ? err.message : 'failed to queue full rescan',
      }, 500);
    }
  });

  app.post('/api/cache/reset', async (c) => {
    const expectedToken = (
      process.env.DASHBOARD_ADMIN_TOKEN
      || process.env.BOT_PASSWORD
      || ''
    ).trim();
    if (!expectedToken) {
      return c.json({ error: 'cache reset is disabled: no admin token is configured' }, 503);
    }

    const providedToken = extractAdminToken(
      c.req.header('Authorization'),
      c.req.header('X-Admin-Token'),
    );
    if (!adminTokenMatches(expectedToken, providedToken)) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const body = await c.req
      .json<{ confirm?: unknown; scope?: unknown }>()
      .catch(() => null);
    if (body?.confirm !== 'RESET_CACHES') {
      return c.json({ error: 'confirmation must be exactly RESET_CACHES' }, 400);
    }

    const scope = parseCacheResetScope(body.scope);
    if (!scope) {
      return c.json({
        error: `scope must be one of: ${VALID_CACHE_RESET_SCOPES.join(', ')}`,
      }, 400);
    }

    return c.json(resetCaches(scope));
  });

  app.get('/api/cache/parsed-listings', (c) => {
    const limit = parseLimit(c.req.query('limit'), 50, 500);
    const offset = parseLimit(c.req.query('offset'), 0, 100_000);
    const platform = c.req.query('platform') || undefined;
    const parseType = c.req.query('type') || undefined;
    return c.json(listParsedListings({ limit, offset, platform, parseType }));
  });

  app.get('/api/cache/parsed-listings/:platform/:platformId', (c) => {
    const platform = c.req.param('platform');
    const platformId = c.req.param('platformId');
    const detail = getParsedListingDetail(platform, platformId);
    if (!detail) return c.json({ error: 'not found' }, 404);
    return c.json(detail);
  });

  app.get('/api/cache/rejection', (c) => {
    const limit = parseLimit(c.req.query('limit'), 50, 500);
    const offset = parseLimit(c.req.query('offset'), 0, 100_000);
    const rejectedOnly = c.req.query('rejectedOnly') === '1';
    return c.json(listRejectionCache({ limit, offset, rejectedOnly }));
  });

  app.get('/api/cache/maps', (c) => {
    const limit = parseLimit(c.req.query('limit'), 50, 500);
    const offset = parseLimit(c.req.query('offset'), 0, 100_000);
    const prefix = c.req.query('prefix') || undefined;
    return c.json(listMapsCache({ limit, offset, prefix }));
  });

  app.get('/api/cache/maps/:cacheKey', (c) => {
    const cacheKey = decodeURIComponent(c.req.param('cacheKey'));
    const detail = getMapsCacheDetail(cacheKey);
    if (!detail) return c.json({ error: 'not found' }, 404);
    return c.json(detail);
  });

  app.get('/api/monitors', (c) => c.json(getMonitorsWithStats()));

  app.get('/api/monitors/:id/runs', (c) => {
    const id = parseId(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const limit = parseLimit(c.req.query('limit'), 50, 200);
    return c.json(getMonitorRuns(id, limit));
  });

  app.get('/api/monitors/:id/listings', (c) => {
    const id = parseId(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const limit = parseLimit(c.req.query('limit'), 50, 200);
    return c.json(getMonitorListings(id, limit));
  });

  // Explicit 404 for unknown /api/* — keeps the SPA wildcard from swallowing typos.
  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  // ---- Static SPA ----
  // Resolve dashboard/dist relative to this file so it works under tsx and after build.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const repoRoot = resolve(__dirname, '..', '..');
  const distRoot = resolve(repoRoot, 'dashboard', 'dist');
  const indexHtml = join(distRoot, 'index.html');
  const hasDist = existsSync(indexHtml);

  if (hasDist) {
    app.use('/assets/*', serveStatic({ root: './dashboard/dist' }));
    app.get('/favicon.ico', serveStatic({ path: './dashboard/dist/favicon.ico' }));
    app.get('*', async (c) => {
      try {
        const html = await readFile(indexHtml, 'utf-8');
        return c.html(html);
      } catch {
        return c.text('Dashboard build not found', 500);
      }
    });
  } else {
    app.get('*', (c) => c.text(
      `Dashboard SPA not built yet.\nRun: pnpm dashboard:install && pnpm dashboard:build\nExpected build output: ${indexHtml}\nAPI is live under /api/*.`,
      503,
    ));
  }

  const server = serve({ fetch: app.fetch, hostname: host, port }) as Server;
  const url = `http://${host}:${port}`;
  console.log(`[http] Dashboard: ${url}${hasDist ? '' : ' (SPA not built — see /api/* for JSON)'}`);

  return {
    url,
    close: () =>
      new Promise<void>((res, rej) => {
        // Drop idle keep-alive connections immediately; force-close anything still open after 5s
        // so a stuck request can't pin shutdown past Docker's grace period.
        server.closeIdleConnections?.();
        const forceTimer = setTimeout(() => server.closeAllConnections?.(), 5000);
        server.close((err) => {
          clearTimeout(forceTimer);
          if (err) rej(err);
          else res();
        });
      }),
  };
}
