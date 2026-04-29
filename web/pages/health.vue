<template>
  <div class="health">
    <div class="health__header">
      <div>
        <h1 class="health__title">Мониторинг</h1>
        <p class="health__subtitle">Доступность сайтов (последние 24ч)</p>
      </div>
      <button class="health__refresh" :disabled="loading" @click="fetchData">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" :class="{ spinning: loading }">
          <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
        </svg>
        Обновить
      </button>
    </div>

    <!-- Sites health cards -->
    <div v-if="!sites.length && !loading" class="health__empty">Нет данных</div>

    <div class="health__grid">
      <div v-for="site in sites" :key="site.siteId" class="health-card" :class="{ 'health-card--expanded': expandedId === site.siteId }" @click="toggleExpand(site.siteId)">
        <div class="health-card__top">
          <div class="health-card__status-dot" :class="site.lastPing?.reachable ? 'health-card__status-dot--up' : 'health-card__status-dot--down'" />
          <div class="health-card__info">
            <span class="health-card__name">{{ site.siteName }}</span>
            <span class="health-card__domain">{{ site.domain }}</span>
          </div>
          <div class="health-card__metrics">
            <div class="health-card__metric">
              <span class="health-card__metric-value" :class="uptimeClass(site.uptimePercent)">{{ site.uptimePercent }}%</span>
              <span class="health-card__metric-label">Аптайм</span>
            </div>
            <div class="health-card__metric">
              <span class="health-card__metric-value">{{ site.avgResponseMs }}ms</span>
              <span class="health-card__metric-label">Среднее</span>
            </div>
            <div class="health-card__metric">
              <span class="health-card__metric-value health-card__metric-value--code">{{ site.lastPing?.statusCode ?? '—' }}</span>
              <span class="health-card__metric-label">Статус</span>
            </div>
          </div>
        </div>

        <!-- Uptime bar (mini heatmap) -->
        <div class="health-card__bar" :title="`${site.successPings}/${site.totalPings} успешных`">
          <div
            v-for="(seg, i) in getUptimeSegments(site)"
            :key="i"
            class="health-card__bar-seg"
            :class="seg ? 'health-card__bar-seg--up' : 'health-card__bar-seg--down'"
          />
        </div>

        <!-- Expanded: ping history chart -->
        <div v-if="expandedId === site.siteId" class="health-card__detail" @click.stop>
          <div v-if="pingsLoading" class="health-card__loading">Загрузка...</div>
          <template v-else-if="pings.length">
            <div class="ping-chart">
              <div class="ping-chart__bars">
                <div
                  v-for="(p, i) in pings"
                  :key="i"
                  class="ping-chart__bar"
                  :class="p.reachable ? 'ping-chart__bar--up' : 'ping-chart__bar--down'"
                  :style="{ height: pingBarHeight(p.responseTimeMs) }"
                  :title="`${formatPingTime(p.createdAt)}: ${p.responseTimeMs}ms (${p.statusCode ?? 'N/A'})`"
                />
              </div>
              <div class="ping-chart__labels">
                <span>{{ pings.length > 0 ? formatPingTime(pings[0].createdAt) : '' }}</span>
                <span>Время отклика (мс)</span>
                <span>{{ pings.length > 0 ? formatPingTime(pings[pings.length - 1].createdAt) : '' }}</span>
              </div>
            </div>
          </template>
          <div v-else class="health-card__no-data">Нет данных за период</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface SiteHealth {
  siteId: string;
  siteName: string;
  domain: string;
  uptimePercent: number;
  avgResponseMs: number;
  lastPing: {
    reachable: boolean;
    statusCode: number | null;
    responseTimeMs: number;
    createdAt: string;
  } | null;
  totalPings: number;
  successPings: number;
}

interface PingEntry {
  reachable: boolean;
  statusCode: number | null;
  responseTimeMs: number;
  createdAt: string;
}

const api = useApi();
const sites = ref<SiteHealth[]>([]);
const loading = ref(false);
const expandedId = ref<string | null>(null);
const pings = ref<PingEntry[]>([]);
const pingsLoading = ref(false);
let refreshTimer: ReturnType<typeof setInterval> | undefined;

function uptimeClass(pct: number): string {
  if (pct >= 99.5) return 'health-card__metric-value--ok';
  if (pct >= 95) return 'health-card__metric-value--warn';
  return 'health-card__metric-value--crit';
}

function getUptimeSegments(site: SiteHealth): boolean[] {
  // Generate 48 segments (30-min intervals for 24h)
  // We don't have granular data per segment, so show uniform based on uptime
  const segments: boolean[] = [];
  const total = 48;
  const downCount = Math.round(total * (1 - site.uptimePercent / 100));
  for (let i = 0; i < total; i++) {
    segments.push(i >= downCount);
  }
  return segments;
}

function pingBarHeight(ms: number): string {
  if (!pings.value.length) return '0%';
  const max = Math.max(...pings.value.map((p) => p.responseTimeMs), 1);
  return `${Math.max((ms / max) * 100, 3)}%`;
}

function formatPingTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

async function fetchData() {
  loading.value = true;
  try {
    sites.value = await api.get<SiteHealth[]>('/health');
  } catch { /* ignore */ }
  loading.value = false;
}

async function loadPings(siteId: string) {
  pingsLoading.value = true;
  try {
    pings.value = await api.get<PingEntry[]>(`/health/${siteId}/pings?hours=24`);
  } catch {
    pings.value = [];
  }
  pingsLoading.value = false;
}

async function toggleExpand(siteId: string) {
  if (expandedId.value === siteId) {
    expandedId.value = null;
    return;
  }
  expandedId.value = siteId;
  await loadPings(siteId);
}

onMounted(async () => {
  await fetchData();
  refreshTimer = setInterval(fetchData, 60000);
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<style scoped>
.health__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}

.health__title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0;
}

.health__subtitle {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-top: 0.15rem;
}

.health__refresh {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.45rem 0.85rem;
  border-radius: 10px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  color: var(--text-tertiary);
  font-size: 0.78rem;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
}

.health__refresh:hover {
  border-color: var(--primary-border);
  color: var(--primary-text);
  background: var(--primary-bg);
}

.health__refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.health__empty {
  text-align: center;
  padding: 3rem;
  color: var(--text-faint);
  font-size: 0.85rem;
}

/* Grid */
.health__grid {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

/* Card */
.health-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 1rem 1.15rem;
  cursor: pointer;
  transition: all 0.2s;
}

.health-card:hover {
  border-color: var(--border-secondary);
}

.health-card--expanded {
  border-color: var(--primary-border);
}

.health-card__top {
  display: flex;
  align-items: center;
  gap: 0.85rem;
}

.health-card__status-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex-shrink: 0;
}

.health-card__status-dot--up {
  background: #4ade80;
  box-shadow: 0 0 8px rgba(74, 222, 128, 0.5);
}

.health-card__status-dot--down {
  background: #f87171;
  box-shadow: 0 0 8px rgba(248, 113, 113, 0.5);
}

.health-card__info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.health-card__name {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-heading);
}

.health-card__domain {
  font-size: 0.68rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-muted);
  margin-top: 0.1rem;
}

.health-card__metrics {
  display: flex;
  gap: 1.25rem;
  flex-shrink: 0;
}

.health-card__metric {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 50px;
}

.health-card__metric-value {
  font-size: 1rem;
  font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-primary);
}

.health-card__metric-value--ok { color: #4ade80; }
.health-card__metric-value--warn { color: #fbbf24; }
.health-card__metric-value--crit { color: #f87171; }
.health-card__metric-value--code { font-size: 0.85rem; }

.health-card__metric-label {
  font-size: 0.6rem;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin-top: 0.1rem;
}

/* Uptime bar */
.health-card__bar {
  display: flex;
  gap: 1px;
  margin-top: 0.85rem;
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
}

.health-card__bar-seg {
  flex: 1;
  min-width: 1px;
  border-radius: 1px;
}

.health-card__bar-seg--up {
  background: #4ade80;
}

.health-card__bar-seg--down {
  background: #f87171;
}

/* Expanded detail */
.health-card__detail {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
  animation: slideDown 0.2s ease;
}

@keyframes slideDown {
  from { opacity: 0; max-height: 0; }
  to { opacity: 1; max-height: 400px; }
}

.health-card__loading {
  font-size: 0.78rem;
  color: var(--text-faint);
  padding: 0.5rem 0;
}

.health-card__no-data {
  font-size: 0.78rem;
  color: var(--text-faint);
  padding: 0.5rem 0;
}

/* Ping chart */
.ping-chart {
  padding: 0.25rem 0;
}

.ping-chart__bars {
  display: flex;
  align-items: flex-end;
  gap: 1px;
  height: 100px;
}

.ping-chart__bar {
  flex: 1;
  min-width: 1px;
  border-radius: 1px 1px 0 0;
  transition: height 0.2s ease;
}

.ping-chart__bar--up {
  background: linear-gradient(180deg, #818cf8, #6366f1);
}

.ping-chart__bar--down {
  background: #f87171;
}

.ping-chart__labels {
  display: flex;
  justify-content: space-between;
  margin-top: 0.35rem;
  font-size: 0.6rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-faint);
}

@media (max-width: 768px) {
  .health-card__metrics {
    gap: 0.75rem;
  }

  .health-card__metric {
    min-width: 40px;
  }

  .health-card__metric-value {
    font-size: 0.85rem;
  }

  .health__title {
    font-size: 1.25rem;
  }
}

@media (max-width: 480px) {
  .health-card__metric-value--code,
  .health-card__metric:last-child {
    display: none;
  }
}
</style>
