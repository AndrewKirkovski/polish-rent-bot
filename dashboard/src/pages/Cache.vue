<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import KpiCard from '../components/KpiCard.vue';
import PageHeader from '../components/PageHeader.vue';
import ErrorBanner from '../components/ErrorBanner.vue';
import Loading from '../components/Loading.vue';
import { fetchCacheStats, fmtNum, fmtRelative } from '../api/client';

const { data: cache, error, isLoading } = useQuery({
  queryKey: ['cache'],
  queryFn: fetchCacheStats,
  refetchInterval: 30_000,
});
</script>

<template>
  <PageHeader title="Cache" subtitle="Local SQLite caches that prevent redundant API calls." />

  <ErrorBanner :error="error" />
  <Loading v-if="isLoading && !cache" />

  <div v-if="cache" class="grid grid-cols-1 md:grid-cols-3 gap-3">
    <KpiCard
      label="Parsed listings"
      :value="fmtNum(cache.parsedListings.count)"
      :hint="`oldest: ${fmtRelative(cache.parsedListings.oldestTs)} · newest: ${fmtRelative(cache.parsedListings.newestTs)}`"
    />
    <KpiCard
      label="Rejection cache"
      :value="fmtNum(cache.rejectionCache.count)"
      :hint="`oldest: ${fmtRelative(cache.rejectionCache.oldestTs)} · newest: ${fmtRelative(cache.rejectionCache.newestTs)}`"
    />
    <KpiCard
      label="Maps cache"
      :value="fmtNum(cache.mapsCache.count)"
      :hint="`${fmtNum(cache.mapsCache.expiredCount)} past 7-day TTL`"
      :tone="cache.mapsCache.expiredCount > 0 ? 'warn' : 'default'"
    />
  </div>

  <div v-if="cache" class="mt-6 grid grid-cols-1 md:grid-cols-2 gap-3">
    <KpiCard
      label="Local cache hit · 24h"
      :value="`${(cache.localHitRate24h * 100).toFixed(1)}%`"
      hint="share of last-24h AI requests served from SQLite (no API call)"
      :tone="cache.localHitRate24h > 0.5 ? 'positive' : 'default'"
    />
  </div>

  <section v-if="cache" class="mt-8 rounded-xl border border-slate-800/80 bg-slate-900/40 p-5 text-sm text-slate-300 leading-relaxed">
    <h2 class="text-xs uppercase tracking-wider text-slate-400 mb-3">How caching works</h2>
    <ul class="list-disc list-inside space-y-1.5 text-slate-400">
      <li><span class="text-slate-200">Parsed listings</span> — every rental/item gets analysed once per <code class="text-emerald-300">(platform, platformId)</code>. Re-evaluating the same listing later returns instantly with no API spend.</li>
      <li><span class="text-slate-200">Rejection cache</span> — keyed by <code class="text-emerald-300">(platform, platformId, hash(criteria))</code>. Same listing + same user criteria = no second call.</li>
      <li><span class="text-slate-200">Maps cache</span> — Google Places / Directions answers, 7-day TTL. Items past the TTL are pruned by the next clean cycle.</li>
      <li><span class="text-slate-200">Anthropic prompt cache</span> — separate concept, 5-min TTL on the API side. Tracked under "Cache reads" on the Overview page.</li>
    </ul>
  </section>
</template>
