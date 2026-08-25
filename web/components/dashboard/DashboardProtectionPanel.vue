<template>
  <section class="ops-panel protection-panel" aria-labelledby="protection-title">
    <div class="ops-section-head">
      <div><span class="ops-section-kicker">Защита данных и трафика</span><h2 id="protection-title">Бэкапы и SSL</h2></div>
      <DashboardSectionState :source="protection.source" />
    </div>
    <div v-if="protection.source.availability === 'UNAVAILABLE' || protection.source.availability === 'UNSUPPORTED'" class="ops-empty">{{ protection.source.message || 'Данные защиты недоступны' }}</div>
    <div v-else class="protection-grid">
      <article>
        <div class="protection-title"><h3>Бэкапы</h3><NuxtLink to="/backups">Открыть</NuxtLink></div>
        <strong class="protection-value ops-mono">{{ protection.backup.protectedSiteCount }} / {{ protection.backup.eligibleSiteCount }}</strong>
        <span class="protection-label">сайтов защищено</span>
        <dl>
          <div><dt>Последний успешный</dt><dd>{{ formatDashboardAge(protection.backup.latestSuccessfulAt) }}</dd></div>
          <div><dt>Сбоев за 24 ч</dt><dd :class="{ danger: protection.backup.failedLast24Hours }">{{ protection.backup.failedLast24Hours }}</dd></div>
          <div><dt>Просрочено</dt><dd :class="{ warning: protection.backup.overdueScheduleCount }">{{ protection.backup.overdueScheduleCount }}</dd></div>
          <div><dt>Репозиторий</dt><dd>{{ repositoryLabel }}</dd></div>
        </dl>
      </article>
      <article>
        <div class="protection-title"><h3>SSL</h3><NuxtLink to="/ssl">Открыть</NuxtLink></div>
        <strong class="protection-value ops-mono">{{ protection.ssl.valid }}</strong>
        <span class="protection-label">действительных сертификатов</span>
        <dl>
          <div><dt>Истекают</dt><dd :class="{ warning: protection.ssl.expiring }">{{ protection.ssl.expiring }}</dd></div>
          <div><dt>Ошибка / истёк</dt><dd :class="{ danger: protection.ssl.expiredOrError }">{{ protection.ssl.expiredOrError }}</dd></div>
          <div><dt>Ближайший срок</dt><dd>{{ nearestExpiry }}</dd></div>
        </dl>
        <ul v-if="protection.ssl.exceptions.length" class="ssl-exceptions">
          <li v-for="item in protection.ssl.exceptions.slice(0, 3)" :key="item.certificateId">
            <span>{{ item.domain }}</span><strong>{{ item.daysRemaining === null ? item.status : `${item.daysRemaining} д` }}</strong>
          </li>
        </ul>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { DashboardProtectionSection } from '@meowbox/shared';
import { formatDashboardAge } from '~/utils/dashboard-format';

const props = defineProps<{ protection: DashboardProtectionSection }>();
const repositoryLabel = computed(() => ({
  OK: 'Проверен', FAILED: 'Ошибка', UNKNOWN: 'Неизвестно', UNCONFIGURED: 'Не настроен',
})[props.protection.backup.repositoryCheckState]);
const nearestExpiry = computed(() => props.protection.ssl.nearestExpiryDays === null
  ? 'Неизвестно'
  : `${props.protection.ssl.nearestExpiryDays} д · ${props.protection.ssl.nearestExpiryDomain || 'сертификат'}`);
</script>

<style scoped>
.protection-grid { display: grid; grid-template-columns: 1fr 1fr; }
.protection-grid article { min-width: 0; padding: 1rem; }
.protection-grid article + article { border-left: 1px solid var(--border); }
.protection-title { display: flex; align-items: center; justify-content: space-between; }
.protection-title h3 { margin: 0; color: var(--text-tertiary); font: 650 0.64rem 'JetBrains Mono', monospace; text-transform: uppercase; }
.protection-title a { color: var(--primary-text); font-size: 0.67rem; }
.protection-value { display: block; margin-top: 0.85rem; color: var(--text-heading); font-size: 1.25rem; }
.protection-label { color: var(--text-muted); font-size: 0.65rem; }
.protection-grid dl { display: grid; gap: 0.45rem; margin: 0.8rem 0 0; }
.protection-grid dl div { display: flex; justify-content: space-between; gap: 0.7rem; }
.protection-grid dt { color: var(--text-muted); font-size: 0.65rem; }
.protection-grid dd { margin: 0; overflow: hidden; color: var(--text-tertiary); font: 0.63rem 'JetBrains Mono', monospace; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.warning { color: var(--dashboard-status-warning) !important; }
.danger { color: var(--dashboard-status-danger) !important; }
.ssl-exceptions { margin: 0.75rem 0 0; padding: 0.55rem 0 0; border-top: 1px solid var(--border); list-style: none; }
.ssl-exceptions li { display: flex; justify-content: space-between; color: var(--text-tertiary); font-size: 0.64rem; }
.ssl-exceptions strong { color: var(--dashboard-status-warning); }

@media (max-width: 620px) {
  .protection-grid { grid-template-columns: 1fr; }
  .protection-grid article + article { border-top: 1px solid var(--border); border-left: 0; }
}
</style>
