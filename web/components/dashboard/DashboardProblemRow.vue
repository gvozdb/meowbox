<template>
  <article class="problem-row" :class="`problem-row--${problem.severity.toLowerCase()}`">
    <div class="problem-severity">{{ severityLabel }}</div>
    <div class="problem-copy">
      <div class="problem-heading">
        <h3>{{ problem.title }}</h3>
        <span>{{ problem.entity.label }}</span>
      </div>
      <p>{{ problem.summary }}</p>
      <time v-if="problem.occurredAt" :datetime="problem.occurredAt">{{ formatDashboardAge(problem.occurredAt) }}</time>
    </div>
    <NuxtLink v-if="route" :to="route" class="ops-link problem-action">{{ problem.action?.label }}</NuxtLink>
  </article>
</template>

<script setup lang="ts">
import type { DashboardProblem } from '@meowbox/shared';
import { formatDashboardAge } from '~/utils/dashboard-format';
import { dashboardActionRoute } from '~/utils/dashboard-navigation';

const props = defineProps<{ problem: DashboardProblem }>();
const severityLabel = computed(() => ({
  CRITICAL: 'Критично',
  WARNING: 'Внимание',
  INFO: 'Инфо',
})[props.problem.severity]);
const route = computed(() => props.problem.action ? dashboardActionRoute(props.problem.action) : null);
</script>

<style scoped>
.problem-row {
  position: relative;
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr) auto;
  gap: 0.9rem;
  align-items: center;
  padding: 0.85rem 1rem 0.85rem 1.15rem;
  border-bottom: 1px solid var(--border);
}

.problem-row::before { position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--text-muted); content: ''; }
.problem-row--critical::before { background: var(--danger); }
.problem-row--warning::before { background: var(--primary); }
.problem-row:last-child { border-bottom: 0; }
.problem-severity { color: var(--text-tertiary); font: 700 0.62rem 'JetBrains Mono', monospace; text-transform: uppercase; }
.problem-row--critical .problem-severity { color: var(--dashboard-status-danger); }
.problem-row--warning .problem-severity { color: var(--dashboard-status-warning); }
.problem-copy { min-width: 0; }
.problem-heading { display: flex; align-items: baseline; gap: 0.55rem; }
.problem-heading h3 { overflow: hidden; margin: 0; color: var(--text-heading); font-size: 0.82rem; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.problem-heading span { min-width: 0; overflow: hidden; color: var(--text-muted); font: 0.62rem 'JetBrains Mono', monospace; text-overflow: ellipsis; white-space: nowrap; }
.problem-copy p { margin: 0.24rem 0 0; color: var(--text-tertiary); font-size: 0.72rem; line-height: 1.45; }
.problem-copy time { display: block; margin-top: 0.22rem; color: var(--text-muted); font-size: 0.62rem; }
.problem-action { white-space: nowrap; }

@media (max-width: 620px) {
  .problem-row { grid-template-columns: 1fr auto; gap: 0.55rem; padding: 0.75rem 0.8rem 0.75rem 1rem; }
  .problem-severity { grid-column: 1; }
  .problem-copy { grid-column: 1 / -1; }
  .problem-action { grid-column: 2; grid-row: 1; }
  .problem-heading { display: block; }
  .problem-heading span { display: block; margin-top: 0.2rem; }
}
</style>
