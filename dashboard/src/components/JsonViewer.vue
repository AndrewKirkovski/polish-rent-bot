<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ raw: string | object | null | undefined }>();

const pretty = computed<string>(() => {
  if (props.raw == null) return '';
  if (typeof props.raw === 'object') return JSON.stringify(props.raw, null, 2);
  try {
    return JSON.stringify(JSON.parse(props.raw), null, 2);
  } catch {
    return String(props.raw);
  }
});

async function copy(): Promise<void> {
  try { await navigator.clipboard.writeText(pretty.value); } catch { /* no-op */ }
}
</script>

<template>
  <div class="relative">
    <button
      v-if="pretty"
      type="button"
      @click="copy"
      class="absolute top-2 right-2 text-[11px] px-2 py-1 rounded bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
      aria-label="Copy JSON"
    >
      <i class="pi pi-copy mr-1" />copy
    </button>
    <pre class="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap break-words overflow-auto max-h-[70vh] bg-slate-950/50 border border-slate-800/60 rounded-lg p-4">{{ pretty || '—' }}</pre>
  </div>
</template>
