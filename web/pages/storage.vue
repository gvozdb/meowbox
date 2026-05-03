<template>
  <div class="storage">
    <div class="storage__header">
      <div>
        <h1 class="storage__title">Хранилище</h1>
        <p class="storage__subtitle">Дисковое пространство по сайтам</p>
      </div>
      <button class="storage__refresh" :disabled="loading" @click="refresh">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" :class="{ spinning: loading }">
          <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
        </svg>
        Обновить
      </button>
    </div>

    <!-- Server disk overview -->
    <div class="server-disk">
      <div class="server-disk__header">
        <div class="server-disk__icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="22" y1="12" x2="2" y2="12" /><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" /><line x1="6" y1="16" x2="6.01" y2="16" /><line x1="10" y1="16" x2="10.01" y2="16" />
          </svg>
        </div>
        <div class="server-disk__info">
          <span class="server-disk__label">Сервер</span>
          <span class="server-disk__values">
            <span class="server-disk__used">{{ formatBytes(serverDisk.used) }}</span>
            <span class="server-disk__sep">/</span>
            <span class="server-disk__total">{{ formatBytes(serverDisk.total) }}</span>
          </span>
        </div>
        <span class="server-disk__pct" :class="{ 'server-disk__pct--warn': serverDisk.percent > 80, 'server-disk__pct--crit': serverDisk.percent > 95 }">
          {{ serverDisk.percent }}%
        </span>
      </div>
      <div class="server-disk__bar">
        <div
          class="server-disk__bar-fill"
          :class="{ 'server-disk__bar-fill--warn': serverDisk.percent > 80, 'server-disk__bar-fill--crit': serverDisk.percent > 95 }"
          :style="{ width: `${serverDisk.percent}%` }"
        />
      </div>
    </div>

    <!-- Sites storage table -->
    <div class="storage-table">
      <div class="storage-table__head">
        <button v-for="col in columns" :key="col.key" class="storage-table__th" :class="{ 'storage-table__th--active': sortKey === col.key, 'storage-table__th--right': col.align === 'right' }" @click="toggleSort(col.key)">
          {{ col.label }}
          <svg v-if="sortKey === col.key" width="10" height="10" viewBox="0 0 10 10" fill="currentColor" class="storage-table__sort-icon" :class="{ 'storage-table__sort-icon--asc': sortDir === 'asc' }">
            <path d="M5 7L1 3h8z" />
          </svg>
        </button>
      </div>

      <div v-if="!sites.length && !loading" class="storage-table__empty">
        Нет данных
      </div>

      <div v-for="site in sortedSites" :key="site.siteId" class="storage-row-wrap">
        <button class="storage-row" :class="{ 'storage-row--expanded': expandedId === site.siteId }" @click="toggleExpand(site.siteId)">
          <span class="storage-row__cell storage-row__name">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" class="storage-row__chevron" :class="{ 'storage-row__chevron--open': expandedId === site.siteId }">
              <path d="M4 2l4 4-4 4" />
            </svg>
            {{ site.siteName }}
          </span>
          <span class="storage-row__cell storage-row__domain">{{ site.domain }}</span>
          <span class="storage-row__cell storage-row__bytes">{{ formatBytes(site.wwwBytes) }}</span>
          <span class="storage-row__cell storage-row__bytes">{{ formatBytes(site.logsBytes) }}</span>
          <span class="storage-row__cell storage-row__bytes">{{ formatBytes(site.tmpBytes) }}</span>
          <span class="storage-row__cell storage-row__bytes">{{ formatBytes(site.dbBytes) }}</span>
          <span class="storage-row__cell storage-row__bytes storage-row__bytes--total">{{ formatBytes(site.totalBytes) }}</span>
          <span class="storage-row__cell storage-row__bar-cell">
            <span class="storage-row__mini-bar">
              <span class="storage-row__mini-fill storage-row__mini-fill--www" :style="{ width: barSegment(site.wwwBytes, site.totalBytes) }" />
              <span class="storage-row__mini-fill storage-row__mini-fill--logs" :style="{ width: barSegment(site.logsBytes, site.totalBytes) }" />
              <span class="storage-row__mini-fill storage-row__mini-fill--tmp" :style="{ width: barSegment(site.tmpBytes, site.totalBytes) }" />
              <span class="storage-row__mini-fill storage-row__mini-fill--db" :style="{ width: barSegment(site.dbBytes, site.totalBytes) }" />
            </span>
          </span>
        </button>

        <!-- Expanded details -->
        <div v-if="expandedId === site.siteId" class="storage-detail">
          <div class="storage-detail__grid">
            <!-- Top files -->
            <div class="storage-detail__section">
              <h3 class="storage-detail__title">Топ файлов</h3>
              <div v-if="topFilesLoading" class="storage-detail__loading">Загрузка...</div>
              <div v-else-if="topFiles.length" class="top-files">
                <div v-for="(f, i) in topFiles" :key="i" class="top-file">
                  <span class="top-file__rank">{{ i + 1 }}</span>
                  <span class="top-file__path">{{ f.path }}</span>
                  <span class="top-file__size">{{ formatBytes(f.size) }}</span>
                </div>
              </div>
              <div v-else class="storage-detail__empty">Нет данных</div>
            </div>

            <!-- Trend -->
            <div class="storage-detail__section">
              <h3 class="storage-detail__title">Тренд (30 дней)</h3>
              <div v-if="trendLoading" class="storage-detail__loading">Загрузка...</div>
              <div v-else-if="trend.length" class="trend-chart">
                <div class="trend-chart__bars">
                  <div
                    v-for="(point, i) in trend"
                    :key="i"
                    class="trend-bar"
                    :title="`${formatDate(point.date)}: ${formatBytes(point.totalBytes)}`"
                  >
                    <div class="trend-bar__fill" :style="{ height: trendBarHeight(point.totalBytes) }" />
                  </div>
                </div>
                <div class="trend-chart__labels">
                  <span>{{ trend.length > 0 ? formatDateShort(trend[0].date) : '' }}</span>
                  <span>{{ trend.length > 0 ? formatDateShort(trend[trend.length - 1].date) : '' }}</span>
                </div>
              </div>
              <div v-else class="storage-detail__empty">Нет исторических данных</div>
            </div>
          </div>

          <!-- Legend -->
          <div class="storage-detail__legend">
            <span class="legend-item"><span class="legend-dot legend-dot--www" /> WWW</span>
            <span class="legend-item"><span class="legend-dot legend-dot--logs" /> Логи</span>
            <span class="legend-item"><span class="legend-dot legend-dot--tmp" /> Tmp</span>
            <span class="legend-item"><span class="legend-dot legend-dot--db" /> БД</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface SiteStorageInfo {
  siteId: string;
  siteName: string;
  domain: string;
  wwwBytes: number;
  logsBytes: number;
  tmpBytes: number;
  dbBytes: number;
  totalBytes: number;
}

interface TopFile {
  size: number;
  path: string;
}

interface DiskTrendPoint {
  date: string;
  wwwBytes: number;
  logsBytes: number;
  tmpBytes: number;
  dbBytes: number;
  totalBytes: number;
}

interface ServerDisk {
  total: number;
  used: number;
  percent: number;
}

const api = useApi();
const sites = ref<SiteStorageInfo[]>([]);
const serverDisk = ref<ServerDisk>({ total: 0, used: 0, percent: 0 });
const loading = ref(false);
const expandedId = ref<string | null>(null);
const topFiles = ref<TopFile[]>([]);
const topFilesLoading = ref(false);
const trend = ref<DiskTrendPoint[]>([]);
const trendLoading = ref(false);
const sortKey = ref<string>('totalBytes');
const sortDir = ref<'asc' | 'desc'>('desc');
let refreshTimer: ReturnType<typeof setInterval> | undefined;

// Cache for already-loaded details
const detailsCache = new Map<string, { topFiles: TopFile[]; trend: DiskTrendPoint[] }>();

const columns = [
  { key: 'siteName', label: 'Сайт', align: 'left' },
  { key: 'domain', label: 'Домен', align: 'left' },
  { key: 'wwwBytes', label: 'WWW', align: 'right' },
  { key: 'logsBytes', label: 'Логи', align: 'right' },
  { key: 'tmpBytes', label: 'Tmp', align: 'right' },
  { key: 'dbBytes', label: 'БД', align: 'right' },
  { key: 'totalBytes', label: 'Итого', align: 'right' },
  { key: '_bar', label: '', align: 'right' },
];

const sortedSites = computed(() => {
  const key = sortKey.value as keyof SiteStorageInfo;
  const dir = sortDir.value === 'asc' ? 1 : -1;
  return [...sites.value].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return 0;
  });
});

function toggleSort(key: string) {
  if (key === '_bar') return;
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    sortDir.value = 'desc';
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function formatDateShort(iso: string) {
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function barSegment(value: number, total: number): string {
  if (!total) return '0%';
  return `${Math.max((value / total) * 100, 0.5)}%`;
}

function trendBarHeight(bytes: number): string {
  if (!trend.value.length) return '0%';
  const max = Math.max(...trend.value.map((p) => p.totalBytes));
  if (!max) return '0%';
  return `${Math.max((bytes / max) * 100, 2)}%`;
}

async function fetchData() {
  loading.value = true;
  try {
    const [sitesData, diskData] = await Promise.all([
      api.get<SiteStorageInfo[]>('/storage'),
      api.get<ServerDisk>('/storage/server'),
    ]);
    sites.value = sitesData;
    serverDisk.value = diskData;
  } catch { /* ignore */ }
  loading.value = false;
}

async function refresh() {
  detailsCache.clear();
  await fetchData();
  // Re-load expanded details if any
  if (expandedId.value) {
    await loadDetails(expandedId.value);
  }
}

async function loadDetails(siteId: string) {
  const cached = detailsCache.get(siteId);
  if (cached) {
    topFiles.value = cached.topFiles;
    trend.value = cached.trend;
    return;
  }

  topFilesLoading.value = true;
  trendLoading.value = true;

  try {
    const [files, trendData] = await Promise.all([
      api.get<TopFile[]>(`/storage/${siteId}/top-files`),
      api.get<DiskTrendPoint[]>(`/storage/${siteId}/trend?days=30`),
    ]);
    topFiles.value = files;
    trend.value = trendData;
    detailsCache.set(siteId, { topFiles: files, trend: trendData });
  } catch {
    topFiles.value = [];
    trend.value = [];
  }

  topFilesLoading.value = false;
  trendLoading.value = false;
}

async function toggleExpand(siteId: string) {
  if (expandedId.value === siteId) {
    expandedId.value = null;
    return;
  }
  expandedId.value = siteId;
  await loadDetails(siteId);
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
.storage__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}

.storage__title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0;
}

.storage__subtitle {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-top: 0.15rem;
}

.storage__refresh {
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

.storage__refresh:hover {
  border-color: var(--primary-border);
  color: var(--primary-text);
  background: var(--primary-bg);
}

.storage__refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Server disk overview */
.server-disk {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 1rem 1.25rem;
  margin-bottom: 1.5rem;
}

.server-disk__header {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  margin-bottom: 0.75rem;
}

.server-disk__icon {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(var(--primary-rgb), 0.1);
  color: var(--primary-light);
  flex-shrink: 0;
}

.server-disk__info {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.server-disk__label {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.server-disk__values {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.85rem;
  color: var(--text-secondary);
  margin-top: 0.1rem;
}

.server-disk__used {
  color: var(--text-heading);
  font-weight: 600;
}

.server-disk__sep {
  color: var(--text-faint);
  margin: 0 0.25rem;
}

.server-disk__total {
  color: var(--text-muted);
}

.server-disk__pct {
  font-family: 'JetBrains Mono', monospace;
  font-size: 1.25rem;
  font-weight: 700;
  color: #4ade80;
}

.server-disk__pct--warn { color: var(--primary-light); }
.server-disk__pct--crit { color: #f87171; }

.server-disk__bar {
  height: 8px;
  background: var(--border);
  border-radius: 4px;
  overflow: hidden;
}

.server-disk__bar-fill {
  height: 100%;
  border-radius: 4px;
  background: linear-gradient(90deg, #22c55e, #4ade80);
  transition: width 0.6s ease;
}

.server-disk__bar-fill--warn {
  background: linear-gradient(90deg, var(--primary), var(--primary-light));
}

.server-disk__bar-fill--crit {
  background: linear-gradient(90deg, #ef4444, #f87171);
}

/* Storage table */
.storage-table {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  overflow: hidden;
}

.storage-table__head {
  display: grid;
  grid-template-columns: 1.4fr 1.4fr 0.7fr 0.7fr 0.7fr 0.7fr 0.8fr 1fr;
  padding: 0.55rem 0.85rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}

.storage-table__th {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.68rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  background: none;
  border: none;
  padding: 0.2rem 0;
  cursor: pointer;
  font-family: inherit;
  transition: color 0.15s;
}

.storage-table__th:hover {
  color: var(--text-secondary);
}

.storage-table__th--active {
  color: var(--primary-text);
}

.storage-table__th--right {
  justify-content: flex-end;
}

.storage-table__sort-icon {
  transition: transform 0.2s;
}

.storage-table__sort-icon--asc {
  transform: rotate(180deg);
}

.storage-table__empty {
  text-align: center;
  padding: 2.5rem;
  color: var(--text-faint);
  font-size: 0.85rem;
}

/* Row */
.storage-row-wrap {
  border-bottom: 1px solid var(--border);
}

.storage-row-wrap:last-child {
  border-bottom: none;
}

.storage-row {
  display: grid;
  grid-template-columns: 1.4fr 1.4fr 0.7fr 0.7fr 0.7fr 0.7fr 0.8fr 1fr;
  align-items: center;
  width: 100%;
  padding: 0.6rem 0.85rem;
  background: none;
  border: none;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
  text-align: left;
}

.storage-row:hover {
  background: var(--bg-elevated, var(--bg-secondary));
}

.storage-row--expanded {
  background: var(--bg-secondary);
}

.storage-row__cell {
  font-size: 0.78rem;
  color: var(--text-secondary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.storage-row__name {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 600;
  color: var(--text-heading);
}

.storage-row__chevron {
  flex-shrink: 0;
  color: var(--text-faint);
  transition: transform 0.2s;
}

.storage-row__chevron--open {
  transform: rotate(90deg);
}

.storage-row__domain {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  color: var(--text-muted);
}

.storage-row__bytes {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  text-align: right;
  color: var(--text-secondary);
}

.storage-row__bytes--total {
  font-weight: 700;
  color: var(--text-heading);
}

.storage-row__bar-cell {
  padding-left: 0.5rem;
}

.storage-row__mini-bar {
  display: flex;
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--border);
}

.storage-row__mini-fill {
  height: 100%;
  min-width: 1px;
}

.storage-row__mini-fill--www { background: #818cf8; }
.storage-row__mini-fill--logs { background: var(--primary-light); }
.storage-row__mini-fill--tmp { background: #94a3b8; }
.storage-row__mini-fill--db { background: #f472b6; }

/* Expanded detail panel */
.storage-detail {
  padding: 0.75rem 1.25rem 1rem;
  background: var(--bg-secondary);
  animation: slideDown 0.2s ease;
}

@keyframes slideDown {
  from { opacity: 0; max-height: 0; }
  to { opacity: 1; max-height: 600px; }
}

.storage-detail__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
}

.storage-detail__section {
  min-width: 0;
}

.storage-detail__title {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin: 0 0 0.65rem;
}

.storage-detail__loading {
  font-size: 0.78rem;
  color: var(--text-faint);
  padding: 1rem 0;
}

.storage-detail__empty {
  font-size: 0.78rem;
  color: var(--text-faint);
  padding: 0.5rem 0;
}

/* Top files */
.top-files {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 320px;
  overflow-y: auto;
}

.top-file {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0.5rem;
  border-radius: 6px;
}

.top-file:hover {
  background: var(--bg-surface);
}

.top-file__rank {
  font-size: 0.62rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-faint);
  width: 18px;
  text-align: right;
  flex-shrink: 0;
}

.top-file__path {
  flex: 1;
  font-size: 0.72rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

.top-file__size {
  font-size: 0.68rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-muted);
  flex-shrink: 0;
  min-width: 55px;
  text-align: right;
}

/* Trend chart */
.trend-chart {
  padding: 0.5rem 0;
}

.trend-chart__bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 120px;
}

.trend-bar {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: flex-end;
}

.trend-bar__fill {
  width: 100%;
  background: linear-gradient(180deg, #818cf8, #6366f1);
  border-radius: 2px 2px 0 0;
  min-height: 2px;
  transition: height 0.3s ease;
}

.trend-chart__labels {
  display: flex;
  justify-content: space-between;
  margin-top: 0.35rem;
  font-size: 0.6rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-faint);
}

/* Legend */
.storage-detail__legend {
  display: flex;
  gap: 1rem;
  margin-top: 0.85rem;
  padding-top: 0.65rem;
  border-top: 1px solid var(--border);
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.68rem;
  color: var(--text-muted);
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

.legend-dot--www { background: #818cf8; }
.legend-dot--logs { background: var(--primary-light); }
.legend-dot--tmp { background: #94a3b8; }
.legend-dot--db { background: #f472b6; }

@media (max-width: 900px) {
  .storage-table__head,
  .storage-row {
    grid-template-columns: 1.5fr 0.8fr 0.8fr 0.8fr;
  }

  .storage-row__domain,
  .storage-row__bar-cell,
  .storage-table__th:nth-child(2),
  .storage-table__th:nth-child(8) {
    display: none;
  }

  .storage-row__bytes:nth-child(5),
  .storage-table__th:nth-child(5) {
    display: none;
  }

  .storage-detail__grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 600px) {
  .storage-table__head,
  .storage-row {
    grid-template-columns: 1fr 1fr;
  }

  .storage-row__bytes:not(.storage-row__bytes--total),
  .storage-table__th:nth-child(n+3):nth-child(-n+6) {
    display: none;
  }

  .storage__title {
    font-size: 1.25rem;
  }
}
</style>
