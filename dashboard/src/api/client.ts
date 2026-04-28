// Thin fetch wrappers for the bot's /api/* endpoints.

export type Range = '24h' | '7d' | '30d' | 'all';

export interface UsageSummary {
  range: Range;
  costUsd: number;
  apiCalls: number;
  localCacheHits: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  errorCount: number;
}

export interface UsageBucket {
  bucket: string;
  feature: string;
  calls: number;
  localCacheHits: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
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

export interface CacheStats {
  parsedListings: { count: number; oldestTs: string | null; newestTs: string | null };
  rejectionCache: { count: number; oldestTs: string | null; newestTs: string | null };
  mapsCache: { count: number; oldestTs: string | null; newestTs: string | null; expiredCount: number };
  localHitRate24h: number;
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

export interface Health {
  ok: boolean;
  started_at: string;
  uptime_s: number;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchHealth      = () => get<Health>('/api/health');
export const fetchSummary     = (range: Range) => get<UsageSummary>(`/api/summary?range=${range}`);
export const fetchSummaryAll  = () => get<{ h24: UsageSummary; d7: UsageSummary; d30: UsageSummary; all: UsageSummary }>('/api/summary/all');
export const fetchSeries      = (range: Range, bucket: 'hour' | 'day') => get<UsageBucket[]>(`/api/usage/series?range=${range}&bucket=${bucket}`);
export const fetchRecentUsage = (limit = 100) => get<RecentUsageRow[]>(`/api/usage/recent?limit=${limit}`);
export const fetchCacheStats  = () => get<CacheStats>('/api/cache');
export const fetchMonitors    = () => get<MonitorWithStats[]>('/api/monitors');
export const fetchMonitorRuns = (id: number, limit = 50) => get<MonitorRunRow[]>(`/api/monitors/${id}/runs?limit=${limit}`);
export const fetchMonitorListings = (id: number, limit = 50) => get<SeenListingDetail[]>(`/api/monitors/${id}/listings?limit=${limit}`);

export function fmtUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

export function fmtNum(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

export function fmtFeature(f: string): string {
  return f.replace(/_/g, ' ');
}

export function fmtRelative(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  const diffMs = Date.now() - d.getTime();
  const m = Math.round(diffMs / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  return `${days} d ago`;
}
