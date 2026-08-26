<template>
  <section class="ops-panel runtime-panel" aria-labelledby="runtime-title">
    <div class="ops-section-head">
      <div><span class="ops-section-kicker">Исполнение</span><h2 id="runtime-title">Операции и сервисы</h2></div>
      <DashboardSectionState :source="runtime.source" />
    </div>
    <div v-if="runtime.source.availability === 'UNAVAILABLE'" class="ops-empty">{{ runtime.source.message || 'Runtime недоступен' }}</div>
    <template v-else>
      <div v-if="runtime.activeOperations.length" class="runtime-block">
        <h3>Активные операции</h3>
        <ul>
          <li v-for="operation in runtime.activeOperations" :key="operation.id">
            <span><strong>{{ operation.target }}</strong><small>{{ operation.type }} · {{ operation.currentStep || operation.status }}</small></span>
            <span
              class="ops-mono"
              role="progressbar"
              :aria-label="`Прогресс операции для ${operation.target}`"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="Math.round(operation.progress)"
            >{{ Math.round(operation.progress) }}%</span>
          </li>
        </ul>
      </div>
      <div class="runtime-block">
        <div class="runtime-block-title"><h3>Сервисы</h3><NuxtLink to="/services">Открыть</NuxtLink></div>
        <ul v-if="runtime.services.length" class="service-list">
          <li v-for="service in runtime.services" :key="service.id">
            <span class="service-dot" :class="`service-dot--${service.actualState.toLowerCase()}`" aria-hidden="true" />
            <span>{{ service.name }}</span>
            <strong>{{ serviceLabel(service.actualState) }}</strong>
          </li>
        </ul>
        <p v-else class="runtime-empty">{{ runtime.source.availability === 'UNSUPPORTED' ? 'Диагностика не поддерживается' : 'Нет данных диагностики сервисов' }}</p>
        <p v-if="runtime.diagnosticsPartial" class="runtime-note">Проверка большого списка продолжается</p>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import type { DashboardRuntimeSection, DashboardServiceItem } from '@meowbox/shared';
defineProps<{ runtime: DashboardRuntimeSection }>();
function serviceLabel(state: DashboardServiceItem['actualState']) {
  return ({ RUNNING: 'Работает', STOPPED: 'Остановлен', FAILED: 'Ошибка', MISSING: 'Не найден', UNKNOWN: 'Неизвестно' })[state];
}
</script>

<style scoped>
.runtime-panel { overflow: hidden; }
.runtime-block { padding: 0.78rem 0.9rem; border-bottom: 1px solid var(--border); }
.runtime-block:last-child { border-bottom: 0; }
.runtime-block h3 { margin: 0 0 0.55rem; color: var(--text-tertiary); font: 700 0.6rem 'JetBrains Mono', monospace; letter-spacing: 0.05em; text-transform: uppercase; }
.runtime-block-title { display: flex; justify-content: space-between; }
.runtime-block-title a { color: var(--primary-text); font-size: 0.67rem; }
.runtime-block ul { margin: 0; padding: 0; list-style: none; }
.runtime-block li { display: flex; align-items: center; gap: 0.55rem; min-height: 34px; padding: 0 0.25rem; border-radius: 7px; color: var(--text-primary); font-size: 0.72rem; }
.runtime-block li:hover { background: var(--bg-surface-hover); }
.runtime-block li > span:nth-child(1):not(.service-dot) { flex: 1; min-width: 0; }
.runtime-block li strong { font-size: 0.69rem; }
.runtime-block li small { display: block; margin-top: 0.1rem; color: var(--text-muted); font-size: 0.58rem; }
.service-list li > span:nth-child(2) { flex: 1; }
.service-list li > strong { padding: 0.2rem 0.34rem; border: 1px solid var(--border); border-radius: 5px; color: var(--text-tertiary); font: 650 0.56rem 'JetBrains Mono', monospace; }
.service-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); }
.service-dot--running { background: var(--success); }
.service-dot--failed, .service-dot--missing { background: var(--danger); }
.service-dot--stopped { background: var(--primary); }
.runtime-empty, .runtime-note { margin: 0; color: var(--text-muted); font-size: 0.68rem; }
.runtime-note { margin-top: 0.65rem; color: var(--dashboard-status-warning); }
</style>
