<script setup lang="ts">
defineProps<{ title: string; subtitle?: string }>();
</script>

<template>
  <header class="mb-6">
    <h1 class="text-xl font-semibold tracking-tight">{{ title }}</h1>
    <p v-if="subtitle" class="mt-1 text-sm text-slate-400">{{ subtitle }}</p>
  </header>
</template>
