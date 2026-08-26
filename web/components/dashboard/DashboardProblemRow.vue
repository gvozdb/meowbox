<template>
  <article class="problem-row" :class="`problem-row--${problem.severity.toLowerCase()}`">
    <div class="problem-severity">{{ severityLabel }}</div>
    <div class="problem-copy">
      <h3>{{ problem.title }}</h3>
      <p>{{ problem.summary }}</p>
      <div class="problem-meta">
        <span>{{ problem.entity.label }}</span>
        <time v-if="problem.occurredAt" :datetime="problem.occurredAt">{{ formatDashboardAge(problem.occurredAt) }}</time>
      </div>
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
  grid-template-columns: 88px minmax(0, 1fr) auto;
  gap: 0.8rem;
  align-items: center;
  min-height: 76px;
  padding: 0.72rem 1rem;
  border-bottom: 1px solid var(--border);
  transition: background-color 0.15s ease;
}

.problem-row:hover { background: var(--bg-surface-hover); }
.problem-row::before { position: absolute; inset: 0 auto 0 0; width: 4px; background: var(--text-muted); content: ''; }
.problem-row--critical::before { background: var(--danger); }
.problem-row--warning::before { background: var(--primary); }
.problem-row:last-child { border-bottom: 0; }
.problem-severity { justify-self: start; padding: 0.27rem 0.42rem; border: 1px solid currentColor; border-radius: 6px; color: var(--text-tertiary); font: 700 0.56rem 'JetBrains Mono', monospace; letter-spacing: 0.025em; text-transform: uppercase; }
.problem-row--critical .problem-severity { color: var(--dashboard-status-danger); }
.problem-row--warning .problem-severity { color: var(--dashboard-status-warning); }
.problem-copy { min-width: 0; }
.problem-copy h3 { overflow: hidden; margin: 0; color: var(--text-heading); font-size: 0.8rem; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.problem-copy p { overflow: hidden; margin: 0.18rem 0 0; color: var(--text-tertiary); font-size: 0.69rem; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.problem-meta { display: flex; min-width: 0; align-items: center; gap: 0.45rem; margin-top: 0.2rem; color: var(--text-muted); font: 0.58rem 'JetBrains Mono', monospace; }
.problem-meta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.problem-meta time { flex: 0 0 auto; }
.problem-meta time::before { margin-right: 0.45rem; color: var(--text-faint); content: '·'; }
.problem-action { white-space: nowrap; }
.problem-action::after { margin-left: 0.38rem; content: '→'; }

@media (max-width: 620px) {
  .problem-row { grid-template-columns: 1fr auto; gap: 0.5rem; min-height: 0; padding: 0.72rem 0.75rem 0.72rem 0.9rem; }
  .problem-severity { grid-column: 1; }
  .problem-copy { grid-column: 1 / -1; }
  .problem-action { grid-column: 2; grid-row: 1; }
  .problem-copy p { white-space: normal; }
}
</style>
