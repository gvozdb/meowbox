<template>
  <section class="server-pulse ops-panel" aria-labelledby="server-pulse-title">
    <div class="pulse-identity">
      <span class="ops-section-kicker">Выбранный сервер</span>
      <div class="pulse-title-row">
        <span class="pulse-beacon" :class="`pulse-beacon--${overall.state.toLowerCase()}`" aria-hidden="true" />
        <div>
          <h2 id="server-pulse-title">{{ server.displayName }}</h2>
          <p>{{ server.hostname || server.id }}</p>
        </div>
      </div>
    </div>

    <dl class="pulse-facts">
      <div class="pulse-fact pulse-fact--primary">
        <dt>Состояние</dt>
        <dd :class="`pulse-status--${overall.state.toLowerCase()}`">{{ overallLabel }}</dd>
      </div>
      <div class="pulse-fact pulse-fact--primary">
        <dt>Uptime</dt>
        <dd class="ops-mono">{{ formatDashboardUptime(server.uptimeSeconds) }}</dd>
      </div>
      <div class="pulse-fact">
        <dt>Agent</dt>
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
      <NuxtLink to="/sites/create" class="ops-link">+ Создать сайт</NuxtLink>
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
  grid-template-columns: minmax(190px, 1.1fr) minmax(440px, 2.3fr) auto;
  align-items: center;
  gap: 1.2rem;
  padding: 1rem 1.1rem;
  border-top: 2px solid var(--primary);
}

.pulse-title-row { display: flex; align-items: center; gap: 0.7rem; }
.pulse-title-row h2 { margin: 0; color: var(--text-heading); font-size: 1.05rem; }
.pulse-title-row p { margin: 0.12rem 0 0; color: var(--text-muted); font: 0.65rem 'JetBrains Mono', monospace; }
.pulse-beacon { width: 10px; height: 28px; border-radius: 3px; background: var(--text-muted); }
.pulse-beacon--healthy { background: var(--success); }
.pulse-beacon--attention { background: var(--primary); }
.pulse-beacon--critical { background: var(--danger); }

.pulse-facts { display: grid; grid-template-columns: repeat(5, minmax(72px, 1fr)); gap: 0; margin: 0; }
.pulse-fact { min-width: 0; padding: 0 0.85rem; border-left: 1px solid var(--border-secondary); }
.pulse-fact dt { color: var(--text-muted); font: 0.62rem 'JetBrains Mono', monospace; text-transform: uppercase; }
.pulse-fact dd { overflow: hidden; margin: 0.28rem 0 0; color: var(--text-secondary); font-size: 0.76rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.pulse-fact--primary dd { color: var(--text-heading); font-size: 0.9rem; }
.pulse-status--healthy { color: var(--dashboard-status-success) !important; }
.pulse-status--attention { color: var(--dashboard-status-warning) !important; }
.pulse-status--critical { color: var(--dashboard-status-danger) !important; }
.pulse-actions { display: flex; gap: 0.45rem; }

@media (max-width: 1100px) {
  .server-pulse { grid-template-columns: 1fr auto; }
  .pulse-facts { grid-column: 1 / -1; grid-row: 2; }
}

@media (max-width: 620px) {
  .server-pulse { grid-template-columns: 1fr; gap: 0.8rem; padding: 0.85rem; }
  .pulse-actions { position: absolute; right: 1.1rem; align-self: start; }
  .pulse-actions .ops-link { display: none; }
  .pulse-identity { padding-right: 100px; }
  .pulse-facts { grid-column: auto; grid-template-columns: repeat(2, 1fr); }
  .pulse-fact { padding: 0.5rem 0.6rem; border-left: 0; border-top: 1px solid var(--border); }
  .pulse-fact:nth-child(n+3) { display: none; }
}
</style>
