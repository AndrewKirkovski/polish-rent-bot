<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import Chart from 'primevue/chart';
import Select from 'primevue/select';
import KpiCard from '../components/KpiCard.vue';
import PageHeader from '../components/PageHeader.vue';
import ErrorBanner from '../components/ErrorBanner.vue';
import Loading from '../components/Loading.vue';
import { fetchSummaryAll, fetchSeries, fmtUsd, fmtNum, type Range } from '../api/client';

const rangeOptions: { label: string; value: Range; bucket: 'hour' | 'day' }[] = [
  { label: 'Last 24 hours', value: '24h', bucket: 'hour' },
  { label: 'Last 7 days',   value: '7d',  bucket: 'day'  },
  { label: 'Last 30 days',  value: '30d', bucket: 'day'  },
];
const range = ref<Range>('7d');

const { data: summary, error: summaryError, isLoading: summaryLoading } = useQuery({
  queryKey: ['summary-all'],
  queryFn: fetchSummaryAll,
  refetchInterval: 30_000,
});

const { data: series, error: seriesError } = useQuery({
  queryKey: ['series', range],
  queryFn: () => {
    const opt = rangeOptions.find((o) => o.value === range.value)!;
    return fetchSeries(opt.value, opt.bucket);
  },
  refetchInterval: 30_000,
});

const FEATURE_COLORS: Record<string, string> = {
  agent_initial:    'rgba(56, 189, 248, 0.85)',  // sky
  agent_tool_loop:  'rgba(168, 85, 247, 0.85)',  // purple
  parse_rental:     'rgba(34, 197, 94, 0.85)',   // emerald
  parse_item:       'rgba(234, 179, 8, 0.85)',   // amber
  rejection_eval:   'rgba(239, 68, 68, 0.85)',   // rose
};

const chartData = computed(() => {
  const rows = series.value ?? [];
  const buckets = Array.from(new Set(rows.map((r) => r.bucket))).sort();
  const features = Array.from(new Set(rows.map((r) => r.feature))).sort();
  const datasets = features.map((feature) => {
    const map = new Map(rows.filter((r) => r.feature === feature).map((r) => [r.bucket, r.costUsd]));
    return {
      label: feature,
      data: buckets.map((b) => Number((map.get(b) ?? 0).toFixed(4))),
      backgroundColor: FEATURE_COLORS[feature] ?? 'rgba(148, 163, 184, 0.85)',
      borderColor: FEATURE_COLORS[feature] ?? 'rgba(148, 163, 184, 0.85)',
      borderWidth: 0,
      stack: 'cost',
    };
  });
  return { labels: buckets, datasets };
});

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index' as const, intersect: false },
  plugins: {
    legend: { labels: { color: '#cbd5e1' } },
    tooltip: { callbacks: { label: (ctx: { dataset: { label: string }; parsed: { y: number } }) => `${ctx.dataset.label}: $${ctx.parsed.y.toFixed(4)}` } },
  },
  scales: {
    x: { stacked: true, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,0.08)' } },
    y: { stacked: true, ticks: { color: '#94a3b8', callback: (v: string | number) => `$${Number(v).toFixed(2)}` }, grid: { color: 'rgba(148,163,184,0.08)' } },
  },
};

const hitRate24h = computed(() => {
  const s = summary.value?.h24;
  if (!s) return 0;
  const total = s.apiCalls + s.localCacheHits;
  return total > 0 ? s.localCacheHits / total : 0;
});
</script>

<template>
  <PageHeader title="Overview" subtitle="Token spend and cache health across the bot's AI calls." />

  <ErrorBanner :error="summaryError" />
  <Loading v-if="summaryLoading && !summary" />

  <div v-if="summary" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
    <KpiCard label="Cost · 24h" :value="fmtUsd(summary.h24.costUsd)" :hint="`${fmtNum(summary.h24.apiCalls)} API call${summary.h24.apiCalls === 1 ? '' : 's'}`" />
    <KpiCard label="Cost · 7d"  :value="fmtUsd(summary.d7.costUsd)"  :hint="`${fmtNum(summary.d7.apiCalls)} calls`" />
    <KpiCard label="Cost · 30d" :value="fmtUsd(summary.d30.costUsd)" :hint="`${fmtNum(summary.d30.apiCalls)} calls`" />
    <KpiCard
      label="Local cache hit · 24h"
      :value="`${(hitRate24h * 100).toFixed(1)}%`"
      :hint="`${fmtNum(summary.h24.localCacheHits)} hits / ${fmtNum(summary.h24.localCacheHits + summary.h24.apiCalls)} total`"
      :tone="hitRate24h > 0.5 ? 'positive' : 'default'"
    />
  </div>

  <div v-if="summary" class="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
    <KpiCard label="Input tokens · 7d"  :value="fmtNum(summary.d7.inputTokens)" />
    <KpiCard label="Output tokens · 7d" :value="fmtNum(summary.d7.outputTokens)" />
    <KpiCard label="Cache reads · 7d"   :value="fmtNum(summary.d7.cacheReadTokens)" hint="prompt-cache reads (10% input price)" />
    <KpiCard label="Errors · 7d"        :value="fmtNum(summary.d7.errorCount)" :tone="summary.d7.errorCount > 0 ? 'danger' : 'default'" />
  </div>

  <section class="mt-8 rounded-xl border border-slate-800/80 bg-slate-900/40 p-5">
    <div class="flex items-center justify-between mb-3">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-300">Cost by feature</h2>
      <Select v-model="range" :options="rangeOptions" optionLabel="label" optionValue="value" class="w-44" />
    </div>
    <ErrorBanner :error="seriesError" />
    <div class="h-72">
      <Chart type="bar" :data="chartData" :options="chartOptions" class="h-full" />
    </div>
  </section>
</template>
