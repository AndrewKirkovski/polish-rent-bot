<script setup lang="ts">
import { ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Tag from 'primevue/tag';
import Select from 'primevue/select';
import PageHeader from '../components/PageHeader.vue';
import ErrorBanner from '../components/ErrorBanner.vue';
import Loading from '../components/Loading.vue';
import { fetchRecentUsage, fmtUsd, fmtNum, fmtFeature, fmtRelative, type RecentUsageRow } from '../api/client';

const limitOptions = [50, 100, 250, 500];
const limit = ref(100);

const { data: rows, error, isFetching, isLoading } = useQuery({
  queryKey: ['recent-usage', limit],
  queryFn: () => fetchRecentUsage(limit.value),
  refetchInterval: 15_000,
});

const featureSeverity: Record<string, 'success' | 'info' | 'warn' | 'danger' | 'secondary'> = {
  agent_initial:    'info',
  agent_tool_loop:  'secondary',
  parse_rental:     'success',
  parse_item:       'warn',
  rejection_eval:   'danger',
};

function tokensTotal(r: RecentUsageRow): number {
  return r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens;
}
</script>

<template>
  <PageHeader title="Usage" subtitle="Every AI call recorded by the wrapper. Most-recent first." />

  <ErrorBanner :error="error" />
  <Loading v-if="isLoading && !rows" />

  <div class="flex items-center gap-3 mb-3">
    <span class="text-xs text-slate-400">Show:</span>
    <Select v-model="limit" :options="limitOptions" class="w-32" />
    <span class="text-xs text-slate-500" v-if="isFetching">refreshing…</span>
  </div>

  <div class="rounded-xl border border-slate-800/80 bg-slate-900/40 overflow-hidden">
    <DataTable
      :value="rows ?? []"
      :rows="50"
      paginator
      stripedRows
      size="small"
      class="text-sm"
    >
      <Column field="ts" header="When" style="width: 9rem">
        <template #body="{ data }">
          <span class="text-slate-300">{{ fmtRelative(data.ts) }}</span>
        </template>
      </Column>
      <Column field="feature" header="Feature" style="width: 10rem">
        <template #body="{ data }">
          <Tag :value="fmtFeature(data.feature)" :severity="featureSeverity[data.feature] ?? 'secondary'" />
        </template>
      </Column>
      <Column header="Cache" style="width: 5rem">
        <template #body="{ data }">
          <span v-if="data.localCacheHit" class="inline-flex items-center gap-1 text-emerald-300">
            <i class="pi pi-bolt text-xs" /> hit
          </span>
          <span v-else class="text-slate-500">—</span>
        </template>
      </Column>
      <Column header="Tokens" style="width: 9rem">
        <template #body="{ data }">
          <span class="tabular-nums">{{ fmtNum(tokensTotal(data)) }}</span>
        </template>
      </Column>
      <Column header="In / Out / CR / CW" style="width: 14rem">
        <template #body="{ data }">
          <span class="tabular-nums text-slate-400">
            {{ fmtNum(data.inputTokens) }} ·
            {{ fmtNum(data.outputTokens) }} ·
            <span class="text-emerald-400">{{ fmtNum(data.cacheReadTokens) }}</span> ·
            <span class="text-amber-400">{{ fmtNum(data.cacheCreationTokens) }}</span>
          </span>
        </template>
      </Column>
      <Column header="Cost" style="width: 6rem">
        <template #body="{ data }">
          <span class="tabular-nums">{{ fmtUsd(data.costUsd) }}</span>
        </template>
      </Column>
      <Column header="Latency" style="width: 6rem">
        <template #body="{ data }">
          <span class="tabular-nums text-slate-400">{{ data.durationMs != null ? `${data.durationMs} ms` : '—' }}</span>
        </template>
      </Column>
      <Column header="Origin" style="width: 9rem">
        <template #body="{ data }">
          <span class="text-xs text-slate-400">
            <template v-if="data.monitorId">monitor #{{ data.monitorId }}</template>
            <template v-else-if="data.userId">user {{ data.userId }}</template>
            <template v-else>—</template>
          </span>
        </template>
      </Column>
      <Column header="Error">
        <template #body="{ data }">
          <span v-if="data.errorMessage" class="text-rose-300 text-xs">{{ data.errorMessage }}</span>
          <span v-else class="text-slate-600">—</span>
        </template>
      </Column>
    </DataTable>
  </div>
</template>
