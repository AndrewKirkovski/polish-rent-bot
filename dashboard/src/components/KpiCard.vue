<script setup lang="ts">
defineProps<{
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'positive' | 'warn' | 'danger';
}>();
</script>

<template>
  <div class="rounded-xl border border-slate-800/80 bg-slate-900/40 p-4 backdrop-blur transition-colors hover:border-slate-700">
    <div class="text-xs uppercase tracking-wider text-slate-500">{{ label }}</div>
    <div
      class="mt-2 text-2xl font-semibold tabular-nums"
      :class="{
        'text-emerald-300': tone === 'positive',
        'text-amber-300':   tone === 'warn',
        'text-rose-300':    tone === 'danger',
      }"
    >{{ value }}</div>
    <div v-if="hint" class="mt-1 text-xs text-slate-500">{{ hint }}</div>
  </div>
</template>
