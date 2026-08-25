<template>
  <span
    v-if="source.availability !== 'OK' || always"
    class="section-state"
    :class="`section-state--${source.availability.toLowerCase()}`"
    :title="source.message || undefined"
  >
    {{ label }}<template v-if="showMessage && source.message"> · {{ source.message }}</template>
  </span>
</template>

<script setup lang="ts">
import type { DashboardSourceState } from '@meowbox/shared';

const props = withDefaults(defineProps<{
  source: DashboardSourceState;
  always?: boolean;
  showMessage?: boolean;
}>(), {
  always: false,
  showMessage: false,
});

const labels = {
  OK: 'Актуально',
  STALE: 'Устарело',
  UNAVAILABLE: 'Недоступно',
  UNSUPPORTED: 'Не поддерживается',
} as const;
const label = computed(() => labels[props.source.availability]);
</script>

<style scoped>
.section-state {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  color: var(--text-tertiary);
  font: 600 0.62rem/1.25 'JetBrains Mono', monospace;
  letter-spacing: 0.02em;
}

.section-state::before {
  width: 6px;
  height: 6px;
  margin-right: 0.35rem;
  border-radius: 50%;
  background: currentColor;
  content: '';
}

.section-state--ok { color: var(--dashboard-status-success); }
.section-state--stale { color: var(--dashboard-status-warning); }
.section-state--unavailable { color: var(--dashboard-status-danger); }
.section-state--unsupported { color: var(--text-tertiary); }
</style>
