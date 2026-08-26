<template>
  <section class="resources ops-panel" aria-labelledby="resources-title">
    <div class="ops-section-head">
      <div>
        <span class="ops-section-kicker">Ресурсы сервера</span>
        <h2 id="resources-title">Нагрузка и ёмкость</h2>
      </div>
      <DashboardSectionState :source="resources.source" />
    </div>

    <div v-if="resources.source.availability === 'UNAVAILABLE' || resources.source.availability === 'UNSUPPORTED'" class="ops-empty">
      {{ resources.source.message || 'Метрики недоступны' }}
    </div>
    <div v-else class="resource-grid">
      <article class="resource-cell">
        <div class="resource-label"><span>CPU</span><strong class="ops-mono">{{ percent(resources.cpuUsagePercent) }}</strong></div>
        <div v-if="cpuPercent !== null" class="meter" role="progressbar" aria-label="Загрузка процессора" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="cpuPercent"><span :style="{ width: `${cpuPercent}%` }" /></div>
        <p>Load {{ loadLabel }}<template v-if="resources.cpuCores"> · {{ resources.cpuCores }} ядер</template></p>
        <svg v-if="cpuPoints" class="spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-label="История загрузки CPU" role="img"><polyline :points="cpuPoints" /></svg>
      </article>

      <article class="resource-cell">
        <div class="resource-label"><span>Память</span><strong class="ops-mono">{{ percent(resources.memoryUsagePercent) }}</strong></div>
        <div v-if="memoryPercent !== null" class="meter" role="progressbar" aria-label="Использование памяти" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="memoryPercent"><span :style="{ width: `${memoryPercent}%` }" /></div>
        <p>{{ formatDashboardBytes(resources.memoryUsedBytes) }} / {{ formatDashboardBytes(resources.memoryTotalBytes) }}</p>
        <svg v-if="memoryPoints" class="spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-label="История использования памяти" role="img"><polyline :points="memoryPoints" /></svg>
      </article>

      <article class="resource-cell">
        <div class="resource-label"><span>Диск {{ primaryDisk?.mountPoint || '' }}</span><strong class="ops-mono">{{ percent(primaryDisk?.usagePercent) }}</strong></div>
        <div v-if="diskPercent !== null" class="meter" role="progressbar" aria-label="Использование основного диска" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="diskPercent"><span :style="{ width: `${diskPercent}%` }" /></div>
        <p v-if="primaryDisk">Свободно {{ formatDashboardBytes(primaryDisk.availableBytes) }}</p><p v-else>Диски не переданы источником</p>
        <p v-if="worstDisk && worstDisk.mountPoint !== primaryDisk?.mountPoint" class="resource-exception">Макс.: {{ worstDisk.mountPoint }} · {{ percent(worstDisk.usagePercent) }}</p>
      </article>

      <article class="resource-cell resource-cell--network">
        <div class="resource-label"><span>Сеть</span><strong>текущий поток</strong></div>
        <dl v-if="resources.network">
          <div><dt>↓ вход</dt><dd class="ops-mono">{{ formatDashboardRate(resources.network.rxBytesPerSecond) }}</dd></div>
          <div><dt>↑ исход</dt><dd class="ops-mono">{{ formatDashboardRate(resources.network.txBytesPerSecond) }}</dd></div>
        </dl>
        <p v-else>Сетевые метрики неизвестны</p>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { DashboardMetricHistoryPoint, DashboardResourceSection } from '@meowbox/shared';
import { clampDashboardPercent, formatDashboardBytes, formatDashboardRate } from '~/utils/dashboard-format';

const props = defineProps<{ resources: DashboardResourceSection }>();
const cpuPercent = computed(() => clampDashboardPercent(props.resources.cpuUsagePercent));
const memoryPercent = computed(() => clampDashboardPercent(props.resources.memoryUsagePercent));
const primaryDisk = computed(() => props.resources.disks.find((disk) => disk.mountPoint === '/') ?? props.resources.disks[0] ?? null);
const worstDisk = computed(() => [...props.resources.disks].sort((left, right) => right.usagePercent - left.usagePercent)[0] ?? null);
const diskPercent = computed(() => clampDashboardPercent(primaryDisk.value?.usagePercent));
const loadLabel = computed(() => props.resources.loadAverage
  ? props.resources.loadAverage.map((value) => value.toFixed(2)).join(' / ')
  : 'неизвестен');

function percent(value: number | null | undefined): string {
  const normalized = clampDashboardPercent(value);
  return normalized === null ? 'Неизвестно' : `${normalized.toFixed(1)}%`;
}

function sparkPoints(points: DashboardMetricHistoryPoint[]): string | null {
  const values = points.slice(-30).map((point) => point.value).filter((value) => Number.isFinite(value));
  if (values.length < 2) return null;
  return values.map((value, index) => {
    const x = (index / (values.length - 1)) * 100;
    const y = 23 - (Math.min(100, Math.max(0, value)) / 100) * 22;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

const cpuPoints = computed(() => sparkPoints(props.resources.history.cpu));
const memoryPoints = computed(() => sparkPoints(props.resources.history.memory));
</script>

<style scoped>
.resource-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.65rem; padding: 0.75rem; }
.resource-cell { position: relative; min-height: 122px; padding: 0.82rem 0.88rem; overflow: hidden; border: 1px solid var(--border); border-radius: 11px; background: var(--bg-body); }
.resource-label { display: flex; align-items: baseline; justify-content: space-between; gap: 0.6rem; }
.resource-label span { color: var(--text-tertiary); font: 700 0.61rem 'JetBrains Mono', monospace; letter-spacing: 0.04em; text-transform: uppercase; }
.resource-label strong { color: var(--text-heading); font-size: 1.05rem; font-weight: 750; letter-spacing: -0.035em; }
.resource-label strong:not(.ops-mono) { color: var(--text-muted); font-size: 0.58rem; letter-spacing: 0; text-transform: uppercase; }
.meter { height: 6px; margin: 0.72rem 0 0.58rem; overflow: hidden; border-radius: 999px; background: var(--bar-bg); }
.meter span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--primary-action), var(--primary)); }
.resource-cell p { position: relative; z-index: 1; margin: 0.45rem 0 0; color: var(--text-muted); font-size: 0.65rem; line-height: 1.4; }
.resource-exception { color: var(--dashboard-status-warning) !important; }
.spark { position: absolute; right: 0; bottom: 0; left: 0; width: 100%; height: 34px; opacity: 0.34; }
.spark polyline { fill: none; stroke: var(--primary); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.resource-cell dl { display: grid; gap: 0.48rem; margin: 0.78rem 0 0; }
.resource-cell dl div { display: flex; justify-content: space-between; gap: 0.5rem; }
.resource-cell dt { color: var(--text-muted); font-size: 0.67rem; }
.resource-cell dd { margin: 0; color: var(--text-secondary); font-size: 0.68rem; }

@media (max-width: 900px) {
  .resource-grid { grid-template-columns: repeat(2, 1fr); }
}

@media (max-width: 520px) {
  .resource-grid { grid-template-columns: 1fr; }
  .resource-cell { min-height: 106px; }
}
</style>
