// Embedded read-only dashboard API + Vue SPA static server.
// Bound to 127.0.0.1 by default — access via SSH tunnel.

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getUsageSummary,
  getUsageTimeSeries,
  getRecentUsage,
  getCacheStats,
  getMonitorsWithStats,
  getMonitorRuns,
  getMonitorListings,
  type UsageRange,
} from '../storage/db.js';

const VALID_RANGES: UsageRange[] = ['24h', '7d', '30d', 'all'];

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

export interface HttpServerHandle {
  close: () => Promise<void>;
  url: string;
}

export function startHttpServer(): HttpServerHandle | null {
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
    console.warn(`[http] WARNING: dashboard host is "${host}" (non-loopback). No auth is configured — make sure access is restricted by other means.`);
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
