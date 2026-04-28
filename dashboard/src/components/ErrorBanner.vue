<script setup lang="ts">
defineProps<{ error: unknown }>();

function asMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return String(e);
}
</script>

<template>
  <div v-if="error" class="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200 mb-4">
    <div class="flex items-start gap-2">
      <i class="pi pi-exclamation-triangle mt-0.5" />
      <div>
        <div class="font-medium">Failed to load</div>
        <div class="text-rose-300/80 text-xs mt-0.5 break-all">{{ asMessage(error) }}</div>
      </div>
    </div>
  </div>
</template>
