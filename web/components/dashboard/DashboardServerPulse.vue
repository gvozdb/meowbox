<template>
  <section class="server-pulse ops-panel" aria-labelledby="server-pulse-title">
    <div class="pulse-identity">
      <span class="ops-section-kicker">Выбранный сервер</span>
      <div class="pulse-title-row">
        <span class="pulse-beacon" :class="`pulse-beacon--${overall.state.toLowerCase()}`" aria-hidden="true" />
        <div class="pulse-copy">
          <div class="pulse-name-line">
            <h2 id="server-pulse-title">{{ server.displayName }}</h2>
            <span class="pulse-status" :class="`pulse-status--${overall.state.toLowerCase()}`">{{ overallLabel }}</span>
          </div>
          <p>{{ server.hostname || server.id }}</p>
        </div>
      </div>
    </div>

    <dl class="pulse-facts">
      <div class="pulse-fact pulse-fact--primary">
        <dt>Работает</dt>
        <dd class="ops-mono">{{ formatDashboardUptime(server.uptimeSeconds) }}</dd>
      </div>
      <div class="pulse-fact">
        <dt>Агент</dt>
        <dd>{{ agentLabel }}</dd>
      </div>
      <div class="pulse-fact">
        <dt>Версия</dt>
        <dd class="ops-mono">{{ server.installedVersion || 'Неизвестно' }}</dd>
      </div>
      <div class="pulse-fact">
        <dt>Снимок</dt>
        <dd>{{ refreshing ? 'Обновляется…' : formatDashboardAge(lastSuccessAt || server.source.observedAt) }}</dd>
      </div>
    </dl>

    <div class="pulse-actions">
      <NuxtLink to="/sites/create" class="ops-link pulse-create">Создать сайт</NuxtLink>
      <button class="ops-button" type="button" :disabled="refreshing" @click="$emit('refresh')">
        {{ refreshing ? 'Обновление…' : 'Обновить' }}
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { DashboardOverallState, DashboardServerPulse } from '@meowbox/shared';
import { formatDashboardAge, formatDashboardUptime } from '~/utils/dashboard-format';

const props = defineProps<{
  server: DashboardServerPulse;
  overall: DashboardOverallState;
  refreshing: boolean;
  lastSuccessAt: string | null;
}>();

defineEmits<{ refresh: [] }>();

const overallLabels = {
  HEALTHY: 'В норме',
  ATTENTION: 'Нужно внимание',
  CRITICAL: 'Критично',
  UNKNOWN: 'Неизвестно',
} as const;
const agentLabels = {
  CONNECTED: 'Подключён',
  DISCONNECTED: 'Отключён',
  UNKNOWN: 'Неизвестно',
} as const;
const overallLabel = computed(() => overallLabels[props.overall.state]);
const agentLabel = computed(() => agentLabels[props.server.agentState]);
</script>

<style scoped>
.server-pulse {
  position: relative;
  display: grid;
  grid-template-columns: minmax(260px, 1.15fr) minmax(430px, 1.75fr) auto;
  align-items: center;
  gap: 1rem;
  padding: 1rem 1.1rem 1rem 1.3rem;
  overflow: hidden;
}
.server-pulse::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: 4px;
  background: var(--primary);
  content: '';
}

.pulse-title-row { display: flex; align-items: center; gap: 0.7rem; }
.pulse-copy { min-width: 0; }
.pulse-name-line { display: flex; min-width: 0; align-items: center; gap: 0.6rem; }
.pulse-title-row h2 { overflow: hidden; margin: 0; color: var(--text-heading); font-size: 1.05rem; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
.pulse-title-row p { overflow: hidden; margin: 0.18rem 0 0; color: var(--text-muted); font: 0.64rem 'JetBrains Mono', monospace; text-overflow: ellipsis; white-space: nowrap; }
.pulse-beacon { width: 11px; height: 34px; flex: 0 0 auto; border-radius: 4px; background: var(--text-muted); box-shadow: 0 0 0 5px var(--bg-body); }
.pulse-beacon--healthy { background: var(--success); }
.pulse-beacon--attention { background: var(--primary); }
.pulse-beacon--critical { background: var(--danger); }
.pulse-status { flex: 0 0 auto; padding: 0.22rem 0.42rem; border: 1px solid currentColor; border-radius: 999px; font: 700 0.56rem/1 'JetBrains Mono', monospace; letter-spacing: 0.02em; }

.pulse-facts { display: grid; grid-template-columns: repeat(4, minmax(80px, 1fr)); gap: 0; margin: 0; padding: 0.65rem 0.15rem; border: 1px solid var(--border); border-radius: 11px; background: var(--bg-body); }
.pulse-fact { min-width: 0; padding: 0 0.8rem; border-left: 1px solid var(--border-secondary); }
.pulse-fact:first-child { border-left: 0; }
.pulse-fact dt { color: var(--text-muted); font: 700 0.57rem 'JetBrains Mono', monospace; letter-spacing: 0.045em; text-transform: uppercase; }
.pulse-fact dd { overflow: hidden; margin: 0.28rem 0 0; color: var(--text-primary); font-size: 0.75rem; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.pulse-fact--primary dd { color: var(--text-heading); font-size: 0.84rem; }
.pulse-status--healthy { color: var(--dashboard-status-success) !important; }
.pulse-status--attention { color: var(--dashboard-status-warning) !important; }
.pulse-status--critical { color: var(--dashboard-status-danger) !important; }
.pulse-actions { display: flex; gap: 0.45rem; }
.pulse-create { border-color: transparent; background: linear-gradient(135deg, var(--primary-action), var(--primary-action-hover)); color: var(--primary-action-text); box-shadow: var(--shadow-button); }
.pulse-create:hover { border-color: transparent; background: var(--primary-action-hover); color: var(--primary-action-text); box-shadow: var(--shadow-button-hover); }

@media (max-width: 1100px) {
  .server-pulse { grid-template-columns: 1fr auto; }
  .pulse-facts { grid-column: 1 / -1; grid-row: 2; }
}

@media (max-width: 620px) {
  .server-pulse { grid-template-columns: 1fr; gap: 0.8rem; padding: 0.85rem; }
  .pulse-actions { position: absolute; right: 1.1rem; align-self: start; }
  .pulse-actions .ops-link { display: none; }
  .pulse-identity { padding-right: 100px; }
  .pulse-facts { grid-column: auto; grid-template-columns: repeat(2, 1fr); padding: 0; }
  .pulse-fact { padding: 0.5rem 0.6rem; border-left: 0; border-top: 1px solid var(--border); }
  .pulse-fact:nth-child(odd) { border-right: 1px solid var(--border); }
  .pulse-fact:nth-child(-n+2) { border-top: 0; }
}
</style>
