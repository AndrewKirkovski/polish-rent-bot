<script setup lang="ts">
import { RouterView, RouterLink } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { fetchHealth } from './api/client';

const { data: health, isError: healthError } = useQuery({
  queryKey: ['health'],
  queryFn: fetchHealth,
  refetchInterval: 30_000,
  retry: 0,
});

const navItems = [
  { to: '/',          label: 'Overview',  icon: 'pi pi-chart-line'   },
  { to: '/usage',     label: 'Usage',     icon: 'pi pi-list'         },
  { to: '/monitors',  label: 'Monitors',  icon: 'pi pi-eye'          },
  { to: '/cache',     label: 'Cache',     icon: 'pi pi-database'     },
];
</script>

<template>
  <div class="flex h-full">
    <aside class="w-60 shrink-0 border-r border-slate-800/80 bg-slate-950/60 backdrop-blur p-5 flex flex-col gap-6">
      <div>
        <div class="text-[11px] tracking-[0.2em] uppercase text-slate-500">Polish Rent Bot</div>
        <div class="text-base font-semibold mt-1">Dashboard</div>
      </div>
      <nav aria-label="Primary" class="flex flex-col gap-1 flex-1">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="group flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-slate-800/60 hover:text-white transition-colors"
          active-class="bg-sky-500/15 text-sky-200 ring-1 ring-sky-500/30"
        >
          <i :class="[item.icon, 'text-base']" />
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>
      <div class="text-[11px] leading-snug">
        <div v-if="healthError" class="flex items-center gap-2 text-rose-300">
          <span class="size-1.5 rounded-full bg-rose-400 shadow-[0_0_8px_rgb(251_113_133)]" />
          <span>API unreachable</span>
        </div>
        <div v-else-if="health" class="text-slate-500">
          <div class="flex items-center gap-2">
            <span class="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgb(52_211_153)]" />
            <span>up · {{ Math.floor(health.uptime_s / 60) }} min</span>
          </div>
          <div class="mt-1 text-slate-600 truncate">{{ new Date(health.started_at).toLocaleString() }}</div>
        </div>
        <div v-else class="text-slate-600 flex items-center gap-2">
          <i class="pi pi-spin pi-spinner text-[10px]" />
          <span>connecting…</span>
        </div>
      </div>
    </aside>

    <main class="flex-1 overflow-auto">
      <div class="px-8 py-6 max-w-7xl mx-auto">
        <RouterView />
      </div>
    </main>
  </div>
</template>
