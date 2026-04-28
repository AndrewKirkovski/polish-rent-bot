<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Tag from 'primevue/tag';
import PageHeader from '../components/PageHeader.vue';
import ErrorBanner from '../components/ErrorBanner.vue';
import Loading from '../components/Loading.vue';
import { fetchMonitors, fetchMonitorRuns, fetchMonitorListings, fmtUsd, fmtNum, fmtRelative } from '../api/client';

const { data: monitors, error: monitorsError, isLoading: monitorsLoading } = useQuery({
  queryKey: ['monitors'],
  queryFn: fetchMonitors,
  refetchInterval: 30_000,
});

const selectedId = ref<number | null>(null);

// Default to first monitor; re-pin if the selected id disappears (e.g. monitor deleted).
watch(monitors, (m) => {
  if (!m || m.length === 0) {
    selectedId.value = null;
    return;
  }
  const stillExists = selectedId.value != null && m.some((x) => x.id === selectedId.value);
  if (!stillExists) selectedId.value = m[0].id;
}, { immediate: true });

const { data: runs, error: runsError } = useQuery({
  queryKey: ['monitor-runs', selectedId],
  queryFn: () => fetchMonitorRuns(selectedId.value!),
  enabled: () => selectedId.value != null,
  refetchInterval: 30_000,
});

const { data: listings, error: listingsError } = useQuery({
  queryKey: ['monitor-listings', selectedId],
  queryFn: () => fetchMonitorListings(selectedId.value!),
  enabled: () => selectedId.value != null,
  refetchInterval: 30_000,
});

const selected = computed(() => monitors.value?.find((m) => m.id === selectedId.value));

function safeParseConfig(json: string): Record<string, unknown> | null {
  try { return JSON.parse(json); } catch { return null; }
}

const selectedConfigPretty = computed(() => {
  if (!selected.value) return null;
  const obj = safeParseConfig(selected.value.config);
  return obj ? JSON.stringify(obj, null, 2) : selected.value.config; // fall back to raw string
});

function configPreview(json: string): string {
  const c = safeParseConfig(json);
  if (!c) return '—';
  const parts: string[] = [];
  if (typeof c.city === 'string') parts.push(c.city);
  if (typeof c.priceTo === 'number') parts.push(`≤ ${c.priceTo} PLN`);
  if (typeof c.roomsFrom === 'number') parts.push(`${c.roomsFrom}+ rooms`);
  if (typeof c.query === 'string') parts.push(`q="${c.query}"`);
  return parts.join(' · ') || '—';
}

function selectMonitor(id: number): void {
  selectedId.value = id;
}
</script>

<template>
  <PageHeader title="Monitors" subtitle="Active and inactive scheduled searches." />

  <ErrorBanner :error="monitorsError" />
  <Loading v-if="monitorsLoading && !monitors" />

  <div class="grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-5">
    <section class="rounded-xl border border-slate-800/80 bg-slate-900/40 overflow-hidden">
      <div class="px-4 py-2 border-b border-slate-800/80 text-xs uppercase tracking-wider text-slate-400">Monitors</div>
      <ul role="listbox" aria-label="Monitors" class="divide-y divide-slate-800/60">
        <li
          v-for="m in monitors ?? []"
          :key="m.id"
          role="option"
          tabindex="0"
          :aria-selected="selectedId === m.id"
          @click="selectMonitor(m.id)"
          @keydown.enter.prevent="selectMonitor(m.id)"
          @keydown.space.prevent="selectMonitor(m.id)"
          class="px-4 py-3 cursor-pointer hover:bg-slate-800/40 focus-visible:bg-slate-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 transition-colors"
          :class="{ 'bg-sky-500/10': selectedId === m.id }"
        >
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <Tag :value="m.type" severity="info" />
              <span class="text-sm font-medium">#{{ m.id }} · {{ m.platform }}</span>
              <Tag v-if="!m.active" value="off" severity="secondary" />
            </div>
            <span class="text-xs text-slate-500">{{ fmtRelative(m.lastRunAt) }}</span>
          </div>
          <div class="mt-1 text-xs text-slate-400">{{ configPreview(m.config) }}</div>
          <div class="mt-1 flex items-center gap-3 text-xs text-slate-500">
            <span>{{ fmtNum(m.listingsSeenTotal) }} seen</span>
            <span>·</span>
            <span>{{ fmtUsd(m.costUsd30d) }} / 30d</span>
            <span v-if="m.lastRunError" class="text-rose-300">· error</span>
          </div>
        </li>
        <li v-if="monitors && monitors.length === 0" class="px-4 py-6 text-center text-sm text-slate-500">
          No monitors yet. Create one via Telegram.
        </li>
      </ul>
    </section>

    <section v-if="selected" class="space-y-5">
      <div class="rounded-xl border border-slate-800/80 bg-slate-900/40 p-4">
        <div class="text-xs uppercase tracking-wider text-slate-400 mb-1">Config</div>
        <pre class="text-xs text-slate-300 overflow-x-auto whitespace-pre">{{ selectedConfigPretty }}</pre>
      </div>

      <div class="rounded-xl border border-slate-800/80 bg-slate-900/40 overflow-hidden">
        <div class="px-4 py-2 border-b border-slate-800/80 text-xs uppercase tracking-wider text-slate-400">Recent runs</div>
        <ErrorBanner :error="runsError" />
        <DataTable :value="runs ?? []" size="small" class="text-sm" :rows="20" paginator stripedRows>
          <template #empty>
            <div class="py-6 text-center text-sm text-slate-500">No runs recorded yet.</div>
          </template>
          <Column header="Started">
            <template #body="{ data }">{{ fmtRelative(data.startedAt) }}</template>
          </Column>
          <Column header="Duration">
            <template #body="{ data }">
              <span v-if="data.durationMs != null" class="text-slate-400 tabular-nums">{{ (data.durationMs / 1000).toFixed(1) }}s</span>
              <span v-else-if="!data.finishedAt" class="text-amber-300 text-xs">running…</span>
              <span v-else class="text-slate-500">—</span>
            </template>
          </Column>
          <Column field="listingsFound"     header="Found" />
          <Column field="listingsUnseen"    header="Unseen" />
          <Column field="listingsDelivered" header="Delivered" />
          <Column header="Status">
            <template #body="{ data }">
              <span v-if="data.errorMessage" class="text-rose-300 text-xs">{{ data.errorMessage }}</span>
              <span v-else-if="data.finishedAt" class="text-emerald-300 text-xs">ok</span>
              <span v-else class="text-amber-300 text-xs">running</span>
            </template>
          </Column>
        </DataTable>
      </div>

      <div class="rounded-xl border border-slate-800/80 bg-slate-900/40 overflow-hidden">
        <div class="px-4 py-2 border-b border-slate-800/80 text-xs uppercase tracking-wider text-slate-400">Recent listings sent</div>
        <ErrorBanner :error="listingsError" />
        <DataTable :value="listings ?? []" size="small" class="text-sm" :rows="20" paginator stripedRows>
          <template #empty>
            <div class="py-6 text-center text-sm text-slate-500">No listings delivered yet.</div>
          </template>
          <Column header="Seen">
            <template #body="{ data }">{{ fmtRelative(data.firstSeenAt) }}</template>
          </Column>
          <Column field="platform" header="Platform" style="width: 6rem" />
          <Column header="Title">
            <template #body="{ data }">
              <a :href="data.url" target="_blank" rel="noopener noreferrer" class="text-sky-300 hover:text-sky-200 underline-offset-2 hover:underline">{{ data.title }}</a>
            </template>
          </Column>
          <Column field="price" header="Price" style="width: 7rem">
            <template #body="{ data }">
              <span class="tabular-nums">{{ data.price != null ? `${fmtNum(data.price)} PLN` : '—' }}</span>
            </template>
          </Column>
        </DataTable>
      </div>
    </section>
  </div>
</template>
