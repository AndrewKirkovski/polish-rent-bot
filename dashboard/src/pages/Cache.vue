<script setup lang="ts">
import { ref, computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Tag from 'primevue/tag';
import Drawer from 'primevue/drawer';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import KpiCard from '../components/KpiCard.vue';
import PageHeader from '../components/PageHeader.vue';
import ErrorBanner from '../components/ErrorBanner.vue';
import Loading from '../components/Loading.vue';
import JsonViewer from '../components/JsonViewer.vue';
import {
  fetchCacheStats,
  fetchParsedListings, fetchParsedListingDetail,
  fetchRejectionCache,
  fetchMapsCache, fetchMapsCacheDetail,
  fmtNum, fmtBytes, fmtRelative,
  type ParsedListingDetail, type MapsCacheDetail,
} from '../api/client';

// ---- KPI summary (existing /api/cache aggregate) ----
const { data: stats, error: statsError, isLoading: statsLoading } = useQuery({
  queryKey: ['cache-stats'],
  queryFn: fetchCacheStats,
  refetchInterval: 30_000,
});

// ---- Tab state ----
const tab = ref<'parsed' | 'rejection' | 'maps'>('parsed');

// ---- Parsed listings ----
const parsedTypeOptions = [
  { label: 'All types', value: '' },
  { label: 'Rental',    value: 'rental' },
  { label: 'Item',      value: 'item' },
];
const parsedTypeFilter = ref('');
const { data: parsedRows, error: parsedError, isLoading: parsedLoading } = useQuery({
  queryKey: ['cache-parsed', parsedTypeFilter],
  queryFn: () => fetchParsedListings({ limit: 200, type: parsedTypeFilter.value || undefined }),
  refetchInterval: 60_000,
});

// ---- Rejection cache ----
const rejectedOnly = ref(false);
const { data: rejectionRows, error: rejectionError, isLoading: rejectionLoading } = useQuery({
  queryKey: ['cache-rejection', rejectedOnly],
  queryFn: () => fetchRejectionCache({ limit: 200, rejectedOnly: rejectedOnly.value }),
  refetchInterval: 60_000,
});

// ---- Maps cache ----
const mapsPrefix = ref('');
const { data: mapsRows, error: mapsError, isLoading: mapsLoading } = useQuery({
  queryKey: ['cache-maps', mapsPrefix],
  queryFn: () => fetchMapsCache({ limit: 200, prefix: mapsPrefix.value || undefined }),
  refetchInterval: 60_000,
});

// ---- Drawer state ----
type DrawerKind = 'parsed' | 'maps' | 'rejection';
const drawerOpen = ref(false);
const drawerKind = ref<DrawerKind | null>(null);
const drawerTitle = ref('');
const drawerSubtitle = ref('');
const drawerLoading = ref(false);
const drawerError = ref<unknown>(null);
const drawerPayload = ref<ParsedListingDetail | MapsCacheDetail | Record<string, unknown> | null>(null);
const drawerPayloadJson = computed<string | object | null>(() => {
  const p = drawerPayload.value;
  if (!p) return null;
  // For parsed-listing detail, extract the actual parsedData JSON; otherwise show the whole envelope.
  if (drawerKind.value === 'parsed' && 'parsedData' in p) return (p as ParsedListingDetail).parsedData;
  if (drawerKind.value === 'maps' && 'result' in p) return (p as MapsCacheDetail).result;
  return p;
});

async function openParsed(row: { platform: string; platformId: string; title: string | null }): Promise<void> {
  drawerOpen.value = true;
  drawerKind.value = 'parsed';
  drawerTitle.value = row.title ?? `${row.platform}:${row.platformId}`;
  drawerSubtitle.value = `${row.platform} · ${row.platformId}`;
  drawerLoading.value = true;
  drawerError.value = null;
  drawerPayload.value = null;
  try {
    drawerPayload.value = await fetchParsedListingDetail(row.platform, row.platformId);
  } catch (e) { drawerError.value = e; }
  finally { drawerLoading.value = false; }
}

function openRejection(row: { platform: string; platformId: string; title: string | null; rejected: number; rejectionReason: string | null; criteriaHash: string; cachedAt: string }): void {
  drawerOpen.value = true;
  drawerKind.value = 'rejection';
  drawerTitle.value = row.title ?? `${row.platform}:${row.platformId}`;
  drawerSubtitle.value = `${row.platform} · ${row.platformId}`;
  drawerError.value = null;
  drawerLoading.value = false;
  drawerPayload.value = {
    rejected: row.rejected === 1,
    rejectionReason: row.rejectionReason,
    criteriaHash: row.criteriaHash,
    cachedAt: row.cachedAt,
  };
}

async function openMaps(row: { cacheKey: string }): Promise<void> {
  drawerOpen.value = true;
  drawerKind.value = 'maps';
  drawerTitle.value = row.cacheKey;
  drawerSubtitle.value = '';
  drawerLoading.value = true;
  drawerError.value = null;
  drawerPayload.value = null;
  try {
    drawerPayload.value = await fetchMapsCacheDetail(row.cacheKey);
  } catch (e) { drawerError.value = e; }
  finally { drawerLoading.value = false; }
}
</script>

<template>
  <PageHeader title="Cache" subtitle="Local SQLite caches that prevent redundant API calls. Click any row to inspect." />

  <ErrorBanner :error="statsError" />
  <Loading v-if="statsLoading && !stats" />

  <div v-if="stats" class="grid grid-cols-1 md:grid-cols-4 gap-3">
    <KpiCard label="Parsed listings" :value="fmtNum(stats.parsedListings.count)" :hint="`newest: ${fmtRelative(stats.parsedListings.newestTs)}`" />
    <KpiCard label="Rejection cache" :value="fmtNum(stats.rejectionCache.count)" :hint="`newest: ${fmtRelative(stats.rejectionCache.newestTs)}`" />
    <KpiCard label="Maps cache"      :value="fmtNum(stats.mapsCache.count)"      :hint="`${fmtNum(stats.mapsCache.expiredCount)} past 7-day TTL`" :tone="stats.mapsCache.expiredCount > 0 ? 'warn' : 'default'" />
    <KpiCard label="Local hit · 24h" :value="`${(stats.localHitRate24h * 100).toFixed(1)}%`" hint="share of last-24h AI requests served from SQLite" :tone="stats.localHitRate24h > 0.5 ? 'positive' : 'default'" />
  </div>

  <section class="mt-8 rounded-xl border border-slate-800/80 bg-slate-900/40 overflow-hidden">
    <Tabs :value="tab" @update:value="(v) => (tab = v as typeof tab.value)" class="!bg-transparent">
      <TabList>
        <Tab value="parsed">Parsed listings</Tab>
        <Tab value="rejection">Rejection cache</Tab>
        <Tab value="maps">Maps cache</Tab>
      </TabList>
      <TabPanels class="!bg-transparent">
        <!-- ============ Parsed listings ============ -->
        <TabPanel value="parsed">
          <div class="flex items-center gap-3 mb-3">
            <span class="text-xs text-slate-400">Filter:</span>
            <Select v-model="parsedTypeFilter" :options="parsedTypeOptions" optionLabel="label" optionValue="value" class="w-40" />
          </div>
          <ErrorBanner :error="parsedError" />
          <Loading v-if="parsedLoading && !parsedRows" />
          <DataTable
            :value="parsedRows ?? []"
            :rows="50"
            paginator
            stripedRows
            size="small"
            class="text-sm"
            :pt="{ row: { class: 'cursor-pointer' } }"
            @row-click="(e) => openParsed(e.data)"
          >
            <template #empty>
              <div class="py-6 text-center text-sm text-slate-500">No parsed listings cached yet.</div>
            </template>
            <Column header="Platform" style="width: 6rem">
              <template #body="{ data }">
                <Tag :value="data.platform" :severity="data.platform === 'olx' ? 'warn' : data.platform === 'otodom' ? 'info' : 'secondary'" />
              </template>
            </Column>
            <Column field="platformId" header="ID" style="width: 8rem">
              <template #body="{ data }">
                <span class="font-mono text-xs text-slate-400">{{ data.platformId }}</span>
              </template>
            </Column>
            <Column header="Type" style="width: 5rem">
              <template #body="{ data }">
                <Tag :value="data.parseType" severity="secondary" />
              </template>
            </Column>
            <Column header="Title">
              <template #body="{ data }">
                <span v-if="data.title" class="text-slate-200">{{ data.title }}</span>
                <span v-else class="text-slate-600 italic">no longer in seen listings</span>
              </template>
            </Column>
            <Column header="Size" style="width: 6rem">
              <template #body="{ data }">
                <span class="tabular-nums text-slate-400">{{ fmtBytes(data.byteSize) }}</span>
              </template>
            </Column>
            <Column header="Parsed" style="width: 9rem">
              <template #body="{ data }">{{ fmtRelative(data.parsedAt) }}</template>
            </Column>
            <Column header="" style="width: 3rem">
              <template #body>
                <i class="pi pi-angle-right text-slate-500" />
              </template>
            </Column>
          </DataTable>
        </TabPanel>

        <!-- ============ Rejection cache ============ -->
        <TabPanel value="rejection">
          <div class="flex items-center gap-3 mb-3">
            <label class="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
              <input type="checkbox" v-model="rejectedOnly" class="accent-rose-500" />
              Show only rejected
            </label>
          </div>
          <ErrorBanner :error="rejectionError" />
          <Loading v-if="rejectionLoading && !rejectionRows" />
          <DataTable
            :value="rejectionRows ?? []"
            :rows="50"
            paginator
            stripedRows
            size="small"
            class="text-sm"
            :pt="{ row: { class: 'cursor-pointer' } }"
            @row-click="(e) => openRejection(e.data)"
          >
            <template #empty>
              <div class="py-6 text-center text-sm text-slate-500">No rejection-cache entries yet.</div>
            </template>
            <Column header="Platform" style="width: 6rem">
              <template #body="{ data }">
                <Tag :value="data.platform" severity="secondary" />
              </template>
            </Column>
            <Column header="ID" style="width: 8rem">
              <template #body="{ data }">
                <span class="font-mono text-xs text-slate-400">{{ data.platformId }}</span>
              </template>
            </Column>
            <Column header="Title">
              <template #body="{ data }">
                <span v-if="data.title" class="text-slate-200">{{ data.title }}</span>
                <span v-else class="text-slate-600 italic">no longer in seen listings</span>
              </template>
            </Column>
            <Column header="Status" style="width: 8rem">
              <template #body="{ data }">
                <Tag v-if="data.rejected" value="rejected" severity="danger" />
                <Tag v-else value="passed" severity="success" />
              </template>
            </Column>
            <Column header="Reason">
              <template #body="{ data }">
                <span v-if="data.rejectionReason" class="text-slate-300 text-xs">{{ data.rejectionReason }}</span>
                <span v-else class="text-slate-600">—</span>
              </template>
            </Column>
            <Column header="Cached" style="width: 9rem">
              <template #body="{ data }">{{ fmtRelative(data.cachedAt) }}</template>
            </Column>
          </DataTable>
        </TabPanel>

        <!-- ============ Maps cache ============ -->
        <TabPanel value="maps">
          <div class="flex items-center gap-3 mb-3">
            <span class="text-xs text-slate-400">Prefix:</span>
            <InputText v-model="mapsPrefix" placeholder="e.g. nearby_" class="w-60" size="small" />
            <span class="text-xs text-slate-500">{{ (mapsRows ?? []).length }} entries shown</span>
          </div>
          <ErrorBanner :error="mapsError" />
          <Loading v-if="mapsLoading && !mapsRows" />
          <DataTable
            :value="mapsRows ?? []"
            :rows="50"
            paginator
            stripedRows
            size="small"
            class="text-sm"
            :pt="{ row: { class: 'cursor-pointer' } }"
            @row-click="(e) => openMaps(e.data)"
          >
            <template #empty>
              <div class="py-6 text-center text-sm text-slate-500">No maps-cache entries yet.</div>
            </template>
            <Column header="Cache key">
              <template #body="{ data }">
                <span class="font-mono text-xs text-slate-300 break-all">{{ data.cacheKey }}</span>
              </template>
            </Column>
            <Column header="Size" style="width: 6rem">
              <template #body="{ data }">
                <span class="tabular-nums text-slate-400">{{ fmtBytes(data.byteSize) }}</span>
              </template>
            </Column>
            <Column header="Cached" style="width: 9rem">
              <template #body="{ data }">{{ fmtRelative(data.cachedAt) }}</template>
            </Column>
            <Column header="State" style="width: 6rem">
              <template #body="{ data }">
                <Tag v-if="data.expired" value="expired" severity="warn" />
                <Tag v-else value="fresh" severity="success" />
              </template>
            </Column>
          </DataTable>
        </TabPanel>
      </TabPanels>
    </Tabs>
  </section>

  <Drawer
    v-model:visible="drawerOpen"
    :header="drawerTitle"
    position="right"
    :modal="true"
    class="!w-full md:!w-[640px]"
  >
    <template #header>
      <div class="flex flex-col gap-0.5 min-w-0">
        <span class="text-sm font-semibold truncate">{{ drawerTitle }}</span>
        <span v-if="drawerSubtitle" class="text-xs text-slate-500 truncate font-mono">{{ drawerSubtitle }}</span>
      </div>
    </template>

    <ErrorBanner :error="drawerError" />
    <Loading v-if="drawerLoading" />

    <div v-if="!drawerLoading && drawerPayload" class="space-y-3">
      <div v-if="drawerKind === 'parsed' && (drawerPayload as ParsedListingDetail).url" class="text-xs">
        <a :href="(drawerPayload as ParsedListingDetail).url ?? '#'" target="_blank" rel="noopener noreferrer"
           class="text-sky-300 hover:text-sky-200 underline-offset-2 hover:underline">
          <i class="pi pi-external-link mr-1" />open original listing
        </a>
      </div>
      <JsonViewer :raw="drawerPayloadJson" />
    </div>
  </Drawer>
</template>
