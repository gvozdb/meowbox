<template>
  <section class="ops-panel activity-panel" aria-labelledby="activity-title">
    <div class="ops-section-head">
      <div><span class="ops-section-kicker">Аудит</span><h2 id="activity-title">Последняя активность</h2></div>
      <div class="section-actions"><DashboardSectionState :source="activity.source" /><NuxtLink to="/activity" class="ops-link">Журнал</NuxtLink></div>
    </div>
    <div v-if="activity.source.availability === 'UNAVAILABLE' || activity.source.availability === 'UNSUPPORTED'" class="ops-empty">{{ activity.source.message || 'Активность недоступна' }}</div>
    <div v-else-if="!activity.items.length" class="ops-empty">Событий пока нет</div>
    <ol v-else class="activity-list">
      <li v-for="item in activity.items" :key="item.id">
        <span class="result" :class="`result--${item.result.toLowerCase()}`">{{ resultLabel(item.result) }}</span>
        <span class="activity-copy"><strong>{{ item.action }}</strong><small>{{ item.actor }} · {{ item.target }}</small></span>
        <time :datetime="item.occurredAt">{{ formatDashboardAge(item.occurredAt) }}</time>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import type { DashboardActivityItem, DashboardActivitySection } from '@meowbox/shared';
import { formatDashboardAge } from '~/utils/dashboard-format';
defineProps<{ activity: DashboardActivitySection }>();
function resultLabel(result: DashboardActivityItem['result']) {
  return ({ SUCCESS: 'Успех', FAILED: 'Ошибка', UNKNOWN: 'Неизв.' })[result];
}
</script>

<style scoped>
.section-actions { display: flex; align-items: center; gap: 0.7rem; }
.activity-panel { overflow: hidden; }
.activity-list { margin: 0; padding: 0.28rem 0.75rem; list-style: none; }
.activity-list li { display: grid; grid-template-columns: 66px minmax(0, 1fr) auto; align-items: center; gap: 0.72rem; min-height: 48px; padding: 0.45rem 0.35rem; border-bottom: 1px solid var(--border); }
.activity-list li:last-child { border-bottom: 0; }
.result { justify-self: start; padding: 0.22rem 0.34rem; border: 1px solid currentColor; border-radius: 5px; color: var(--text-muted); font: 700 0.54rem 'JetBrains Mono', monospace; text-transform: uppercase; }
.result--success { color: var(--dashboard-status-success); }
.result--failed { color: var(--dashboard-status-danger); }
.activity-copy { min-width: 0; }
.activity-copy strong, .activity-copy small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.activity-copy strong { color: var(--text-primary); font-size: 0.72rem; }
.activity-copy small { margin-top: 0.1rem; color: var(--text-muted); font-size: 0.62rem; }
.activity-list time { color: var(--text-muted); font-size: 0.62rem; }

@media (max-width: 520px) {
  .activity-list li { grid-template-columns: 55px 1fr; }
  .activity-list time { display: none; }
}
</style>
