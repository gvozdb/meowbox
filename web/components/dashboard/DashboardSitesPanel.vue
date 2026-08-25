<template>
  <section class="ops-panel sites-panel" aria-labelledby="sites-title">
    <div class="ops-section-head">
      <div><span class="ops-section-kicker">Workloads</span><h2 id="sites-title">Сайты</h2></div>
      <div class="section-actions"><DashboardSectionState :source="sites.source" /><NuxtLink to="/sites" class="ops-link">Все сайты</NuxtLink></div>
    </div>
    <dl class="site-totals">
      <div><dt>Всего</dt><dd>{{ sites.total }}</dd></div>
      <div><dt>Работают</dt><dd>{{ sites.running }}</dd></div>
      <div><dt>Ошибки</dt><dd :class="{ danger: sites.error > 0 }">{{ sites.error }}</dd></div>
      <div><dt>Домены</dt><dd>{{ sites.managedDomains }}</dd></div>
    </dl>
    <div v-if="sites.source.availability === 'UNAVAILABLE'" class="ops-empty">{{ sites.source.message || 'Сайты недоступны' }}</div>
    <div v-else-if="!sites.items.length" class="ops-empty">
      Сайтов нет. <NuxtLink to="/sites/create">Создать первый сайт</NuxtLink>
    </div>
    <ul v-else class="site-list">
      <li v-for="site in sites.items" :key="site.id">
        <NuxtLink :to="siteRoute(site.id)" class="site-row ops-row-link">
          <span class="site-state" :class="`site-state--${site.status.toLowerCase()}`" aria-hidden="true" />
          <span class="site-name"><strong>{{ site.displayName }}</strong><small>{{ site.primaryDomain || 'Домен не назначен' }}</small></span>
          <span class="site-availability"><small>Доступность</small><strong class="ops-mono">{{ availability(site.availabilityPercent, site.availabilitySampleCount) }}</strong></span>
          <span class="site-status">{{ site.activeOperation ? 'Операция…' : site.status }}</span>
        </NuxtLink>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import type { DashboardSitesSection } from '@meowbox/shared';

defineProps<{ sites: DashboardSitesSection }>();
function siteRoute(id: string) { return `/sites/${encodeURIComponent(id)}`; }
function availability(value: number | null, samples: number) {
  return value === null || samples === 0 ? 'Неизвестно' : `${value.toFixed(1)}%`;
}
</script>

<style scoped>
.section-actions { display: flex; align-items: center; gap: 0.7rem; }
.site-totals { display: grid; grid-template-columns: repeat(4, 1fr); margin: 0; padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); }
.site-totals div { padding: 0 0.7rem; border-right: 1px solid var(--border); }
.site-totals div:last-child { border-right: 0; }
.site-totals dt { color: var(--text-muted); font-size: 0.62rem; }
.site-totals dd { margin: 0.15rem 0 0; color: var(--text-heading); font: 700 0.9rem 'JetBrains Mono', monospace; }
.site-totals .danger { color: var(--dashboard-status-danger); }
.site-list { margin: 0; padding: 0; list-style: none; }
.site-row { display: grid; grid-template-columns: 8px minmax(0, 1fr) minmax(110px, auto) 86px; align-items: center; gap: 0.7rem; padding: 0.65rem 1rem; border-bottom: 1px solid var(--border); }
.site-row:hover { background: var(--bg-surface-hover); }
.site-list li:last-child .site-row { border-bottom: 0; }
.site-state { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); }
.site-state--running { background: var(--success); }
.site-state--error { background: var(--danger); }
.site-state--deploying { background: var(--primary); }
.site-name { min-width: 0; }
.site-name strong, .site-name small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.site-name strong { color: var(--text-secondary); font-size: 0.76rem; }
.site-name small, .site-availability small { color: var(--text-muted); font-size: 0.62rem; }
.site-availability { text-align: right; }
.site-availability strong { display: block; margin-top: 0.1rem; color: var(--text-tertiary); font-size: 0.63rem; }
.site-status { color: var(--text-tertiary); font: 0.61rem 'JetBrains Mono', monospace; text-align: right; }
.ops-empty a { color: var(--primary-text); }

@media (max-width: 620px) {
  .site-totals { grid-template-columns: repeat(2, 1fr); row-gap: 0.6rem; }
  .site-row { grid-template-columns: 8px minmax(0, 1fr) auto; }
  .site-availability { display: none; }
  .section-actions :deep(.section-state) { display: none; }
}
</style>
