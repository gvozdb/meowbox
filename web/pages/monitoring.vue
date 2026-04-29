<template>
  <div class="monitoring">
    <div class="monitoring__header">
      <div>
        <h1 class="monitoring__title">Monitoring</h1>
        <p class="monitoring__subtitle">Real-time server metrics</p>
      </div>
      <div class="monitoring__refresh">
        <span class="pulse-dot" :class="{ 'pulse-dot--active': connected }" />
        <span class="monitoring__refresh-text">{{ connected ? 'Live' : 'Offline' }}</span>
      </div>
    </div>

    <!-- Gauge cards -->
    <div class="gauges">
      <div class="gauge-card">
        <div class="gauge" :style="{ '--pct': metrics.cpuUsagePercent || 0 }">
          <svg viewBox="0 0 120 120" class="gauge__ring">
            <circle cx="60" cy="60" r="52" class="gauge__track" />
            <circle cx="60" cy="60" r="52" class="gauge__fill gauge__fill--cpu" :style="{ strokeDashoffset: gaugeDash(metrics.cpuUsagePercent) }" />
          </svg>
          <div class="gauge__center">
            <span class="gauge__value">{{ metrics.cpuUsagePercent ?? '—' }}</span>
            <span class="gauge__unit">%</span>
          </div>
        </div>
        <span class="gauge-card__label">CPU Usage</span>
      </div>

      <div class="gauge-card">
        <div class="gauge" :style="{ '--pct': metrics.memoryUsagePercent || 0 }">
          <svg viewBox="0 0 120 120" class="gauge__ring">
            <circle cx="60" cy="60" r="52" class="gauge__track" />
            <circle cx="60" cy="60" r="52" class="gauge__fill gauge__fill--mem" :style="{ strokeDashoffset: gaugeDash(metrics.memoryUsagePercent) }" />
          </svg>
          <div class="gauge__center">
            <span class="gauge__value">{{ metrics.memoryUsagePercent ?? '—' }}</span>
            <span class="gauge__unit">%</span>
          </div>
        </div>
        <span class="gauge-card__label">Memory · {{ formatBytes(metrics.memoryUsedBytes) }} / {{ formatBytes(metrics.memoryTotalBytes) }}</span>
      </div>

      <div class="gauge-card">
        <div class="gauge" :style="{ '--pct': primaryDisk?.usagePercent || 0 }">
          <svg viewBox="0 0 120 120" class="gauge__ring">
            <circle cx="60" cy="60" r="52" class="gauge__track" />
            <circle cx="60" cy="60" r="52" class="gauge__fill gauge__fill--disk" :style="{ strokeDashoffset: gaugeDash(primaryDisk?.usagePercent) }" />
          </svg>
          <div class="gauge__center">
            <span class="gauge__value">{{ primaryDisk?.usagePercent ?? '—' }}</span>
            <span class="gauge__unit">%</span>
          </div>
        </div>
        <span class="gauge-card__label">Disk · {{ formatBytes(primaryDisk?.usedBytes) }} / {{ formatBytes(primaryDisk?.totalBytes) }}</span>
      </div>
    </div>

    <!-- History Charts -->
    <div class="charts-section">
      <div class="charts-header">
        <h2 class="charts-header__title">History</h2>
        <div class="range-tabs">
          <button v-for="r in ranges" :key="r.value" class="range-tab" :class="{ 'range-tab--active': selectedRange === r.value }" @click="changeRange(r.value)">
            {{ r.label }}
          </button>
        </div>
      </div>

      <div v-if="historyLoading" class="charts-loading">
        <div class="charts-loading__spinner" />
      </div>

      <div v-else-if="history.length === 0" class="charts-empty">
        <span class="charts-empty__text">No historical data yet. Metrics are recorded every minute.</span>
      </div>

      <div v-else class="charts-grid">
        <!-- CPU chart -->
        <div class="chart-card">
          <div class="chart-card__header">
            <span class="chart-card__title">CPU Usage</span>
            <span class="chart-card__value" style="color: #818cf8">{{ lastHistoryPoint?.cpu?.toFixed(1) ?? '—' }}%</span>
          </div>
          <svg class="chart-svg" :viewBox="`0 0 ${chartW} ${chartH}`" preserveAspectRatio="none">
            <defs><linearGradient :id="'grad-cpu'" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#818cf8" stop-opacity="0.25" /><stop offset="100%" stop-color="#818cf8" stop-opacity="0" /></linearGradient></defs>
            <path :d="areaPath(history, 'cpu', 100)" :fill="`url(#grad-cpu)`" />
            <polyline :points="linePath(history, 'cpu', 100)" fill="none" stroke="#818cf8" stroke-width="1.5" stroke-linejoin="round" />
          </svg>
        </div>

        <!-- Memory chart -->
        <div class="chart-card">
          <div class="chart-card__header">
            <span class="chart-card__title">Memory Usage</span>
            <span class="chart-card__value" style="color: #f472b6">{{ lastHistoryPoint?.mem?.toFixed(1) ?? '—' }}%</span>
          </div>
          <svg class="chart-svg" :viewBox="`0 0 ${chartW} ${chartH}`" preserveAspectRatio="none">
            <defs><linearGradient :id="'grad-mem'" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f472b6" stop-opacity="0.25" /><stop offset="100%" stop-color="#f472b6" stop-opacity="0" /></linearGradient></defs>
            <path :d="areaPath(history, 'mem', 100)" :fill="`url(#grad-mem)`" />
            <polyline :points="linePath(history, 'mem', 100)" fill="none" stroke="#f472b6" stroke-width="1.5" stroke-linejoin="round" />
          </svg>
        </div>

        <!-- Network RX chart -->
        <div class="chart-card">
          <div class="chart-card__header">
            <span class="chart-card__title">Network In</span>
            <span class="chart-card__value" style="color: #22d3ee">{{ formatBps(lastHistoryPoint?.netRx) }}</span>
          </div>
          <svg class="chart-svg" :viewBox="`0 0 ${chartW} ${chartH}`" preserveAspectRatio="none">
            <defs><linearGradient :id="'grad-rx'" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#22d3ee" stop-opacity="0.25" /><stop offset="100%" stop-color="#22d3ee" stop-opacity="0" /></linearGradient></defs>
            <path :d="areaPath(history, 'netRx', netMax)" :fill="`url(#grad-rx)`" />
            <polyline :points="linePath(history, 'netRx', netMax)" fill="none" stroke="#22d3ee" stroke-width="1.5" stroke-linejoin="round" />
          </svg>
        </div>

        <!-- Network TX chart -->
        <div class="chart-card">
          <div class="chart-card__header">
            <span class="chart-card__title">Network Out</span>
            <span class="chart-card__value" style="color: #fbbf24">{{ formatBps(lastHistoryPoint?.netTx) }}</span>
          </div>
          <svg class="chart-svg" :viewBox="`0 0 ${chartW} ${chartH}`" preserveAspectRatio="none">
            <defs><linearGradient :id="'grad-tx'" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#fbbf24" stop-opacity="0.25" /><stop offset="100%" stop-color="#fbbf24" stop-opacity="0" /></linearGradient></defs>
            <path :d="areaPath(history, 'netTx', netMax)" :fill="`url(#grad-tx)`" />
            <polyline :points="linePath(history, 'netTx', netMax)" fill="none" stroke="#fbbf24" stroke-width="1.5" stroke-linejoin="round" />
          </svg>
        </div>
      </div>
    </div>

    <!-- Detail cards -->
    <div class="detail-grid">
      <!-- Load Average -->
      <div class="detail-card">
        <h3 class="detail-card__title">Load Average</h3>
        <div class="load-bars">
          <div v-for="(val, i) in (metrics.loadAvg || [0, 0, 0])" :key="i" class="load-bar">
            <span class="load-bar__label">{{ ['1m', '5m', '15m'][i] }}</span>
            <div class="load-bar__track">
              <div class="load-bar__fill" :style="{ width: `${Math.min((val / cpuCount) * 100, 100)}%` }" :class="{ 'load-bar__fill--warn': val > cpuCount * 0.8, 'load-bar__fill--crit': val > cpuCount }" />
            </div>
            <span class="load-bar__value">{{ val.toFixed(2) }}</span>
          </div>
        </div>
      </div>

      <!-- Network I/O -->
      <div class="detail-card">
        <h3 class="detail-card__title">Network I/O</h3>
        <div class="net-stats">
          <div class="net-stat">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="7,17 12,12 17,17" /><line x1="12" y1="12" x2="12" y2="22" /></svg>
            <div class="net-stat__info">
              <span class="net-stat__value">{{ formatBps(metrics.network?.rxBytesPerSec) }}</span>
              <span class="net-stat__label">Incoming</span>
            </div>
          </div>
          <div class="net-stat">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17,7 12,12 7,7" /><line x1="12" y1="12" x2="12" y2="2" /></svg>
            <div class="net-stat__info">
              <span class="net-stat__value">{{ formatBps(metrics.network?.txBytesPerSec) }}</span>
              <span class="net-stat__label">Outgoing</span>
            </div>
          </div>
        </div>
      </div>

      <!-- System Info -->
      <div class="detail-card">
        <h3 class="detail-card__title">System</h3>
        <div class="sys-rows">
          <div class="sys-row"><span class="sys-row__label">Uptime</span><span class="sys-row__value">{{ formatUptime(metrics.uptimeSeconds) }}</span></div>
          <div class="sys-row"><span class="sys-row__label">Hostname</span><span class="sys-row__value mono">{{ metrics.hostname || '—' }}</span></div>
          <div class="sys-row"><span class="sys-row__label">Platform</span><span class="sys-row__value mono">{{ metrics.platform || '—' }}</span></div>
          <div class="sys-row"><span class="sys-row__label">CPUs</span><span class="sys-row__value">{{ cpuCount }} cores</span></div>
        </div>
      </div>

      <!-- Service Health -->
      <div class="detail-card">
        <h3 class="detail-card__title">Service Health</h3>
        <div class="health-list">
          <div v-for="svc in healthChecks" :key="svc.name" class="health-item">
            <span class="health-dot" :class="svc.ok ? 'health-dot--ok' : 'health-dot--err'" />
            <span class="health-item__name">{{ svc.name }}</span>
            <span class="health-item__status">{{ svc.ok ? 'Connected' : 'Unreachable' }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Disk breakdown -->
    <div v-if="(metrics.disks || []).length > 1" class="detail-card detail-card--wide">
      <h3 class="detail-card__title">Disk Partitions</h3>
      <div class="disk-table">
        <div v-for="disk in (metrics.disks || [])" :key="disk.mountPoint" class="disk-row">
          <span class="disk-row__mount mono">{{ disk.mountPoint }}</span>
          <div class="disk-row__bar">
            <div class="disk-row__bar-fill" :style="{ width: `${disk.usagePercent}%` }" :class="{ 'disk-row__bar-fill--warn': disk.usagePercent > 80, 'disk-row__bar-fill--crit': disk.usagePercent > 95 }" />
          </div>
          <span class="disk-row__pct">{{ disk.usagePercent }}%</span>
          <span class="disk-row__size">{{ formatBytes(disk.usedBytes) }} / {{ formatBytes(disk.totalBytes) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface Metrics {
  cpuUsagePercent?: number;
  memoryTotalBytes?: number;
  memoryUsedBytes?: number;
  memoryUsagePercent?: number;
  loadAvg?: number[];
  disks?: Array<{ mountPoint: string; totalBytes: number; usedBytes: number; usagePercent: number }>;
  network?: { rxBytesPerSec: number; txBytesPerSec: number };
  uptimeSeconds?: number;
  hostname?: string;
  platform?: string;
  cpuCount?: number;
}

interface HealthStatus {
  database?: boolean;
  redis?: boolean;
}

interface HistoryPoint {
  t: string;
  cpu: number;
  mem: number;
  disk: number;
  netRx: number;
  netTx: number;
}

const api = useApi();
const metrics = ref<Metrics>({});
const connected = ref(true);
const history = ref<HistoryPoint[]>([]);
const historyLoading = ref(false);
const selectedRange = ref('1h');
const ranges = [
  { label: '1h', value: '1h' },
  { label: '6h', value: '6h' },
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
  { label: '30d', value: '30d' },
];
let pollTimer: ReturnType<typeof setInterval> | undefined;

const healthChecks = ref<Array<{ name: string; ok: boolean }>>([
  { name: 'PostgreSQL', ok: true },
  { name: 'Redis', ok: true },
]);

const cpuCount = computed(() => metrics.value.cpuCount || 1);
const primaryDisk = computed(() => metrics.value.disks?.find(d => d.mountPoint === '/') || metrics.value.disks?.[0]);

const CIRCUMFERENCE = 2 * Math.PI * 52;
function gaugeDash(pct?: number) {
  return CIRCUMFERENCE - (CIRCUMFERENCE * (pct || 0)) / 100;
}

function formatBytes(bytes?: number) {
  if (!bytes) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatBps(bytes?: number) {
  if (!bytes) return '0 B/s';
  return formatBytes(bytes) + '/s';
}

function formatUptime(seconds?: number) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// --- Chart helpers ---
const chartW = 400;
const chartH = 80;

const lastHistoryPoint = computed(() => history.value.length ? history.value[history.value.length - 1] : null);
const netMax = computed(() => {
  if (!history.value.length) return 1;
  const max = Math.max(...history.value.map(p => Math.max(p.netRx, p.netTx)), 1);
  return max * 1.1; // 10% headroom
});

function linePath(points: HistoryPoint[], key: keyof HistoryPoint, maxVal: number): string {
  if (!points.length) return '';
  const stepX = chartW / Math.max(points.length - 1, 1);
  return points.map((p, i) => {
    const x = i * stepX;
    const y = chartH - (Number(p[key]) / maxVal) * chartH;
    return `${x.toFixed(1)},${Math.max(0, Math.min(chartH, y)).toFixed(1)}`;
  }).join(' ');
}

function areaPath(points: HistoryPoint[], key: keyof HistoryPoint, maxVal: number): string {
  if (!points.length) return '';
  const stepX = chartW / Math.max(points.length - 1, 1);
  let d = `M0,${chartH}`;
  points.forEach((p, i) => {
    const x = i * stepX;
    const y = chartH - (Number(p[key]) / maxVal) * chartH;
    d += ` L${x.toFixed(1)},${Math.max(0, Math.min(chartH, y)).toFixed(1)}`;
  });
  d += ` L${((points.length - 1) * stepX).toFixed(1)},${chartH} Z`;
  return d;
}

async function fetchHistory() {
  historyLoading.value = true;
  try {
    const res = await api.get<HistoryPoint[]>(`/monitoring/history?range=${selectedRange.value}`);
    history.value = res;
  } catch {
    history.value = [];
  }
  historyLoading.value = false;
}

function changeRange(range: string) {
  selectedRange.value = range;
  fetchHistory();
}

async function fetchMetrics() {
  try {
    metrics.value = await api.get<Metrics>('/system/metrics');
    connected.value = true;
  } catch {
    connected.value = false;
  }
}

async function fetchHealth() {
  try {
    const data = await api.get<HealthStatus>('/system/status');
    healthChecks.value = [
      { name: 'Database (SQLite)', ok: data.database !== false },
    ];
  } catch { /* ignore */ }
}

onMounted(async () => {
  await Promise.all([fetchMetrics(), fetchHealth(), fetchHistory()]);
  pollTimer = setInterval(fetchMetrics, 5000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style scoped>
.monitoring__header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 1.5rem; }
.monitoring__title { font-size: 1.5rem; font-weight: 700; color: var(--text-heading); margin: 0; }
.monitoring__subtitle { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.15rem; }
.monitoring__refresh { display: flex; align-items: center; gap: 0.4rem; }
.monitoring__refresh-text { font-size: 0.72rem; font-weight: 500; color: var(--text-muted); }

.pulse-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-placeholder); }
.pulse-dot--active { background: #4ade80; box-shadow: 0 0 8px rgba(74, 222, 128, 0.4); animation: pulse 2s ease infinite; }
@keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.4); } 50% { box-shadow: 0 0 0 6px rgba(74, 222, 128, 0); } }

/* Gauges */
.gauges { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin-bottom: 1.5rem; }

.gauge-card {
  display: flex; flex-direction: column; align-items: center; gap: 0.65rem;
  padding: 1.25rem 1rem; background: var(--bg-surface);
  border: 1px solid var(--border); border-radius: 14px;
}

.gauge-card__label { font-size: 0.72rem; color: var(--text-muted); text-align: center; }

.gauge { position: relative; width: 100px; height: 100px; }
.gauge__ring { width: 100%; height: 100%; transform: rotate(-90deg); }
.gauge__track { fill: none; stroke: var(--bar-bg); stroke-width: 6; }
.gauge__fill {
  fill: none; stroke-width: 6; stroke-linecap: round;
  stroke-dasharray: 326.73; transition: stroke-dashoffset 0.8s ease;
}
.gauge__fill--cpu { stroke: #818cf8; }
.gauge__fill--mem { stroke: #f472b6; }
.gauge__fill--disk { stroke: #fbbf24; }

.gauge__center {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 0.1rem;
}
.gauge__value { font-size: 1.4rem; font-weight: 700; font-family: 'JetBrains Mono', monospace; color: var(--text-primary); }
.gauge__unit { font-size: 0.7rem; font-weight: 500; color: var(--text-muted); margin-top: 0.3rem; }

/* Detail grid */
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.85rem; margin-bottom: 1.5rem; }

.detail-card {
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 14px; padding: 1rem 1.15rem;
}
.detail-card--wide { grid-column: 1 / -1; }
.detail-card__title { font-size: 0.82rem; font-weight: 600; color: var(--text-tertiary); margin: 0 0 0.85rem; }

/* Load bars */
.load-bars { display: flex; flex-direction: column; gap: 0.5rem; }
.load-bar { display: flex; align-items: center; gap: 0.6rem; }
.load-bar__label { font-size: 0.68rem; font-family: 'JetBrains Mono', monospace; color: var(--text-muted); min-width: 28px; }
.load-bar__track { flex: 1; height: 6px; background: var(--bar-bg); border-radius: 3px; overflow: hidden; }
.load-bar__fill { height: 100%; background: linear-gradient(90deg, #22c55e, #4ade80); border-radius: 3px; transition: width 0.5s ease; }
.load-bar__fill--warn { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
.load-bar__fill--crit { background: linear-gradient(90deg, #ef4444, #f87171); }
.load-bar__value { font-size: 0.72rem; font-family: 'JetBrains Mono', monospace; color: var(--text-tertiary); min-width: 36px; text-align: right; }

/* Network stats */
.net-stats { display: flex; flex-direction: column; gap: 0.85rem; }
.net-stat { display: flex; align-items: center; gap: 0.65rem; color: var(--text-muted); }
.net-stat__info { display: flex; flex-direction: column; }
.net-stat__value { font-size: 1rem; font-weight: 700; font-family: 'JetBrains Mono', monospace; color: var(--text-secondary); }
.net-stat__label { font-size: 0.68rem; color: var(--text-faint); }

/* System rows */
.sys-rows { display: flex; flex-direction: column; gap: 0.45rem; }
.sys-row { display: flex; justify-content: space-between; align-items: center; }
.sys-row__label { font-size: 0.75rem; color: var(--text-muted); }
.sys-row__value { font-size: 0.78rem; color: var(--text-secondary); }
.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; }

/* Health */
.health-list { display: flex; flex-direction: column; gap: 0.5rem; }
.health-item { display: flex; align-items: center; gap: 0.5rem; }
.health-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.health-dot--ok { background: #4ade80; box-shadow: 0 0 6px rgba(74, 222, 128, 0.3); }
.health-dot--err { background: #f87171; box-shadow: 0 0 6px rgba(248, 113, 113, 0.3); }
.health-item__name { font-size: 0.82rem; font-weight: 500; color: var(--text-secondary); flex: 1; }
.health-item__status { font-size: 0.68rem; font-family: 'JetBrains Mono', monospace; color: var(--text-muted); }

/* Disks */
.disk-table { display: flex; flex-direction: column; gap: 0.45rem; }
.disk-row { display: flex; align-items: center; gap: 0.75rem; }
.disk-row__mount { font-size: 0.72rem; color: var(--text-tertiary); min-width: 80px; }
.disk-row__bar { flex: 1; height: 6px; background: var(--bar-bg); border-radius: 3px; overflow: hidden; }
.disk-row__bar-fill { height: 100%; background: linear-gradient(90deg, #fbbf24, #f59e0b); border-radius: 3px; transition: width 0.5s ease; }
.disk-row__bar-fill--warn { background: linear-gradient(90deg, #f59e0b, #d97706); }
.disk-row__bar-fill--crit { background: linear-gradient(90deg, #ef4444, #f87171); }
.disk-row__pct { font-size: 0.72rem; font-family: 'JetBrains Mono', monospace; color: var(--text-tertiary); min-width: 36px; text-align: right; }
.disk-row__size { font-size: 0.68rem; color: var(--text-faint); min-width: 100px; text-align: right; }

/* Charts */
.charts-section { margin-bottom: 1.5rem; }

.charts-header {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.85rem;
}
.charts-header__title { font-size: 1rem; font-weight: 600; color: var(--text-heading); margin: 0; }

.range-tabs { display: flex; gap: 0.25rem; }
.range-tab {
  padding: 0.3rem 0.6rem; border-radius: 6px; border: 1px solid var(--border);
  background: transparent; color: var(--text-muted); font-size: 0.68rem; font-weight: 500;
  font-family: 'JetBrains Mono', monospace; cursor: pointer; transition: all 0.15s;
}
.range-tab:hover { color: var(--text-secondary); border-color: var(--border-strong); }
.range-tab--active {
  background: var(--primary-bg); border-color: var(--primary-border); color: var(--primary-text);
}

.charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.85rem; }

.chart-card {
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 14px; padding: 0.85rem 1rem 0.5rem; overflow: hidden;
}

.chart-card__header {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;
}
.chart-card__title { font-size: 0.75rem; font-weight: 500; color: var(--text-muted); }
.chart-card__value { font-size: 0.82rem; font-weight: 700; font-family: 'JetBrains Mono', monospace; }

.chart-svg {
  width: 100%; height: 60px; display: block;
}

.charts-loading {
  display: flex; align-items: center; justify-content: center; padding: 2rem;
}
.charts-loading__spinner {
  width: 24px; height: 24px; border: 2px solid var(--spinner-track);
  border-top-color: var(--primary); border-radius: 50%;
  animation: chart-spin 0.8s linear infinite;
}
@keyframes chart-spin { to { transform: rotate(360deg); } }

.charts-empty {
  padding: 1.5rem; text-align: center;
  background: var(--bg-surface); border: 1px solid var(--border); border-radius: 14px;
}
.charts-empty__text { font-size: 0.78rem; color: var(--text-muted); }

@media (max-width: 768px) {
  .gauges { grid-template-columns: repeat(3, 1fr); gap: 0.5rem; }
  .gauge-card { padding: 0.75rem 0.5rem; }
  .gauge { width: 72px; height: 72px; }
  .gauge__value { font-size: 1rem; }
  .gauge__unit { font-size: 0.6rem; }
  .gauge-card__label { font-size: 0.6rem; }
  .detail-grid { grid-template-columns: 1fr; }
  .charts-grid { grid-template-columns: 1fr; }
  .charts-header { flex-wrap: wrap; gap: 0.5rem; }
  .disk-row__size { display: none; }
  .monitoring__title { font-size: 1.25rem; }
  .disk-row { flex-wrap: wrap; gap: 0.4rem; }
  .disk-row__mount { min-width: 60px; font-size: 0.65rem; }
}

@media (max-width: 400px) {
  .gauges { grid-template-columns: 1fr; }
  .gauge { width: 90px; height: 90px; }
  .gauge__value { font-size: 1.25rem; }
}
</style>
