<template>
  <div class="dashboard">
    <div class="dashboard__header">
      <div>
        <h1 class="dashboard__title">Дашборд</h1>
        <p class="dashboard__subtitle">Обзор системы</p>
      </div>
    </div>

    <!-- Metric cards -->
    <div class="dashboard__metrics">
      <div class="metric-card">
        <div class="metric-card__icon metric-card__icon--cpu">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
            <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
            <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
            <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
            <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
          </svg>
        </div>
        <div class="metric-card__info">
          <span class="metric-card__value">{{ metrics.cpuUsagePercent ?? '—' }}%</span>
          <span class="metric-card__label">Процессор</span>
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-card__icon metric-card__icon--memory">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M6 19v-3m4 3v-3m4 3v-3m4 3v-3M2 9h20M2 9v7a2 2 0 002 2h16a2 2 0 002-2V9M2 9V7a2 2 0 012-2h16a2 2 0 012 2v2" />
          </svg>
        </div>
        <div class="metric-card__info">
          <span class="metric-card__value">{{ metrics.memoryUsagePercent ?? '—' }}%</span>
          <span class="metric-card__label">Память ({{ formatBytes(metrics.memoryUsedBytes) }} / {{ formatBytes(metrics.memoryTotalBytes) }})</span>
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-card__icon metric-card__icon--disk">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
          </svg>
        </div>
        <div class="metric-card__info">
          <span class="metric-card__value">{{ primaryDisk?.usagePercent ?? '—' }}%</span>
          <span class="metric-card__label">Диск ({{ formatBytes(primaryDisk?.usedBytes) }} / {{ formatBytes(primaryDisk?.totalBytes) }})</span>
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-card__icon metric-card__icon--network">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <polyline points="22,12 18,12 15,21 9,3 6,12 2,12" />
          </svg>
        </div>
        <div class="metric-card__info">
          <span class="metric-card__value">{{ formatBytesPerSec(metrics.network?.rxBytesPerSec) }}</span>
          <span class="metric-card__label">Сеть вх. / {{ formatBytesPerSec(metrics.network?.txBytesPerSec) }} исх.</span>
        </div>
      </div>
    </div>

    <!-- Quick Actions -->
    <div class="dashboard__actions">
      <NuxtLink to="/sites/create" class="action-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
        Создать сайт
      </NuxtLink>
      <NuxtLink to="/backups" class="action-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
        Запустить бэкап
      </NuxtLink>
      <button class="action-btn" :disabled="nginxRestarting" @click="restartNginx">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
        {{ nginxRestarting ? 'Перезапуск...' : 'Перезапуск Nginx' }}
      </button>
    </div>

    <!-- Two-column grid: Sites + Services -->
    <div class="dashboard__grid-2">
      <!-- Sites overview -->
      <div class="dashboard__section">
        <div class="dashboard__section-header">
          <h2 class="dashboard__section-title">Сайты</h2>
          <NuxtLink to="/sites" class="dashboard__section-link">Все сайты</NuxtLink>
        </div>

        <div v-if="sites.length" class="dashboard__sites">
          <NuxtLink
            v-for="site in sites.slice(0, 6)"
            :key="site.id"
            :to="`/sites/${site.id}`"
            class="site-row"
          >
            <SiteTypeIcon :type="site.type" />
            <div class="site-row__info">
              <span class="site-row__name">{{ site.displayName || site.name }}</span>
              <span class="site-row__domain">{{ site.domain }}</span>
            </div>
            <SiteStatusBadge :status="site.status" />
          </NuxtLink>
        </div>
        <div v-else class="dashboard__empty">
          <CatMascot :size="60" mood="sleepy" />
          <p class="dashboard__empty-text">Сайтов пока нет</p>
        </div>
      </div>

      <!-- Services -->
      <div class="dashboard__section">
        <div class="dashboard__section-header">
          <h2 class="dashboard__section-title">Сервисы</h2>
        </div>
        <div class="services-card">
          <div v-for="svc in dashboard.services" :key="svc.name" class="service-item">
            <span class="service-item__dot" :class="svc.active ? 'service-item__dot--up' : 'service-item__dot--down'" />
            <span class="service-item__name">{{ svc.name }}</span>
            <span class="service-item__status">{{ svc.active ? 'Активен' : 'Не работает' }}</span>
          </div>
          <div v-if="!dashboard.services.length" class="dashboard__empty-inline">
            <span>Нет данных</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Two-column grid: Activity + Security -->
    <div class="dashboard__grid-2">
      <!-- Recent Activity -->
      <div class="dashboard__section">
        <div class="dashboard__section-header">
          <h2 class="dashboard__section-title">Последняя активность</h2>
          <NuxtLink to="/activity" class="dashboard__section-link">Все события</NuxtLink>
        </div>
        <div class="activity-card">
          <div v-for="log in dashboard.recentActivity" :key="log.id" class="activity-item">
            <span class="activity-item__badge" :class="`activity-item__badge--${log.action.toLowerCase()}`">
              {{ log.action }}
            </span>
            <div class="activity-item__info">
              <span class="activity-item__entity">{{ log.entity }}{{ log.entityId ? ` #${log.entityId.slice(0, 8)}` : '' }}</span>
              <span class="activity-item__meta">{{ log.username }} &middot; {{ timeAgo(log.createdAt) }}</span>
            </div>
          </div>
          <div v-if="!dashboard.recentActivity.length" class="dashboard__empty-inline">
            <span>Нет событий</span>
          </div>
        </div>
      </div>

      <!-- Security -->
      <div class="dashboard__section">
        <div class="dashboard__section-header">
          <h2 class="dashboard__section-title">Безопасность</h2>
          <NuxtLink to="/settings" class="dashboard__section-link">Сессии</NuxtLink>
        </div>
        <div class="security-cards">
          <div class="sec-card">
            <div class="sec-card__icon sec-card__icon--warn">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
            </div>
            <span class="sec-card__value">{{ dashboard.security.failedLogins24h }}</span>
            <span class="sec-card__label">Неудачных входов (24ч)</span>
          </div>
          <div class="sec-card">
            <div class="sec-card__icon sec-card__icon--info">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
            </div>
            <span class="sec-card__value">{{ dashboard.security.activeSessions }}</span>
            <span class="sec-card__label">Активных сессий</span>
          </div>
          <div class="sec-card">
            <div class="sec-card__icon sec-card__icon--ok">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
            </div>
            <span class="sec-card__value sec-card__value--sm">{{ dashboard.security.lastLoginAt ? formatDate(dashboard.security.lastLoginAt) : '—' }}</span>
            <span class="sec-card__label">Последний вход</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Two-column grid: Backups + SSL -->
    <div class="dashboard__grid-2">
      <!-- Backups -->
      <div class="dashboard__section">
        <div class="dashboard__section-header">
          <h2 class="dashboard__section-title">Бэкапы</h2>
          <NuxtLink to="/backups" class="dashboard__section-link">Все бэкапы</NuxtLink>
        </div>
        <div class="backups-card">
          <div v-for="b in dashboard.backups" :key="b.siteId" class="backup-row">
            <span class="backup-row__site">{{ b.siteName }}</span>
            <template v-if="b.lastBackup">
              <span class="backup-row__badge" :class="`backup-row__badge--${b.lastBackup.status.toLowerCase()}`">
                {{ b.lastBackup.status }}
              </span>
              <span class="backup-row__date">{{ formatDate(b.lastBackup.completedAt) }}</span>
              <span class="backup-row__size">{{ b.lastBackup.sizeBytes ? formatBytes(b.lastBackup.sizeBytes) : '—' }}</span>
            </template>
            <template v-else>
              <span class="backup-row__badge backup-row__badge--never">Никогда</span>
              <span class="backup-row__date">—</span>
              <span class="backup-row__size">—</span>
            </template>
          </div>
          <div v-if="!dashboard.backups.length" class="dashboard__empty-inline">
            <span>Нет сайтов</span>
          </div>
        </div>
      </div>

      <!-- SSL Certificates -->
      <div class="dashboard__section">
        <div class="dashboard__section-header">
          <h2 class="dashboard__section-title">SSL-сертификаты</h2>
        </div>
        <div class="ssl-card">
          <template v-if="expiringCerts.length">
            <div v-for="c in expiringCerts" :key="c.siteId" class="ssl-row">
              <span class="ssl-row__dot ssl-row__dot--warn" />
              <div class="ssl-row__info">
                <span class="ssl-row__domain">{{ c.domain }}</span>
                <span class="ssl-row__meta">{{ c.issuer }} &middot; {{ c.daysRemaining }} дн. осталось</span>
              </div>
            </div>
          </template>
          <div v-else-if="dashboard.ssl.length" class="ssl-card__ok">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
            <span>Все сертификаты в порядке</span>
          </div>
          <div v-else class="dashboard__empty-inline">
            <span>Нет SSL-сертификатов</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Uptime & disks -->
    <div class="dashboard__section">
      <div class="dashboard__section-header">
        <h2 class="dashboard__section-title">Система</h2>
      </div>
      <div class="dashboard__sys-info">
        <div class="sys-item">
          <span class="sys-item__label">Аптайм</span>
          <span class="sys-item__value">{{ formatUptime(metrics.uptimeSeconds) }}</span>
        </div>
        <div v-for="disk in (metrics.disks || [])" :key="disk.mountPoint" class="sys-item">
          <span class="sys-item__label">{{ disk.mountPoint }}</span>
          <div class="sys-item__bar">
            <div
              class="sys-item__bar-fill"
              :class="{ 'sys-item__bar-fill--warn': disk.usagePercent > 80, 'sys-item__bar-fill--crit': disk.usagePercent > 95 }"
              :style="{ width: `${disk.usagePercent}%` }"
            />
          </div>
          <span class="sys-item__value">{{ disk.usagePercent }}%</span>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface SiteItem {
  id: string;
  name: string;
  domain: string;
  type: string;
  status: string;
}

interface Metrics {
  cpuUsagePercent?: number;
  memoryTotalBytes?: number;
  memoryUsedBytes?: number;
  memoryUsagePercent?: number;
  disks?: Array<{
    mountPoint: string;
    totalBytes: number;
    usedBytes: number;
    usagePercent: number;
  }>;
  network?: {
    rxBytesPerSec: number;
    txBytesPerSec: number;
  };
  uptimeSeconds?: number;
}

interface DashboardSummary {
  recentActivity: Array<{ id: string; action: string; entity: string; entityId?: string; ipAddress: string; createdAt: string; username: string }>;
  backups: Array<{ siteId: string; siteName: string; lastBackup: { status: string; completedAt: string; sizeBytes: number | null } | null }>;
  ssl: Array<{ siteId: string; siteName: string; domain: string; issuer: string; status: string; expiresAt: string | null; daysRemaining: number | null }>;
  services: Array<{ name: string; active: boolean }>;
  security: { failedLogins24h: number; activeSessions: number; lastLoginAt: string | null };
}

const api = useApi();
const sites = ref<SiteItem[]>([]);
const metrics = ref<Metrics>({});
const dashboard = ref<DashboardSummary>({
  recentActivity: [],
  backups: [],
  ssl: [],
  services: [],
  security: { failedLogins24h: 0, activeSessions: 0, lastLoginAt: null },
});
const nginxRestarting = ref(false);
const mbToast = useMbToast();
let metricsTimer: ReturnType<typeof setInterval> | undefined;

const primaryDisk = computed(() => {
  return metrics.value.disks?.find((d) => d.mountPoint === '/') || metrics.value.disks?.[0];
});

const expiringCerts = computed(() => {
  return dashboard.value.ssl.filter((c) => c.daysRemaining !== null && c.daysRemaining <= 14);
});

function formatBytes(bytes?: number | null) {
  if (!bytes) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatBytesPerSec(bytes?: number) {
  if (!bytes) return '0 B/s';
  return formatBytes(bytes) + '/s';
}

function formatUptime(seconds?: number) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}д ${h}ч ${m}м`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'только что';
  if (mins < 60) return `${mins} мин. назад`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} ч. назад`;
  const days = Math.floor(hrs / 24);
  return `${days} дн. назад`;
}

function showStatus(message: string, isError = false) {
  if (isError) mbToast.error(message);
  else mbToast.success(message);
}

async function restartNginx() {
  const ok = await useMbConfirm().ask({
    title: 'Перезапуск Nginx',
    message: 'Перезапустить Nginx? Активные соединения будут кратковременно прерваны.',
    confirmText: 'Перезапустить',
  });
  if (!ok) return;
  nginxRestarting.value = true;
  try {
    await api.post('/nginx/reload');
    showStatus('Nginx перезапущен');
  } catch {
    showStatus('Ошибка перезапуска Nginx', true);
  } finally {
    nginxRestarting.value = false;
  }
}

async function fetchMetrics() {
  try {
    metrics.value = await api.get<Metrics>('/system/metrics');
  } catch { /* ignore */ }
}

async function fetchDashboard() {
  try {
    dashboard.value = await api.get<DashboardSummary>('/dashboard/summary');
  } catch { /* ignore */ }
}

onMounted(async () => {
  try {
    sites.value = await api.get<SiteItem[]>('/sites');
  } catch { /* ignore */ }

  await Promise.all([fetchMetrics(), fetchDashboard()]);
  metricsTimer = setInterval(fetchMetrics, 15000);
});

onUnmounted(() => {
  if (metricsTimer) clearInterval(metricsTimer);
});
</script>

<style scoped>
.dashboard__header {
  margin-bottom: 1.5rem;
}

.dashboard__title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0;
}

.dashboard__subtitle {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-top: 0.15rem;
}

/* Metrics */
.dashboard__metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;
  margin-bottom: 1.25rem;
}

.metric-card {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 1rem 1.15rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
}

.metric-card__icon {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.metric-card__icon--cpu { background: rgba(99, 102, 241, 0.1); color: #818cf8; }
.metric-card__icon--memory { background: rgba(236, 72, 153, 0.1); color: #f472b6; }
.metric-card__icon--disk { background: rgba(245, 158, 11, 0.1); color: #fbbf24; }
.metric-card__icon--network { background: rgba(34, 197, 94, 0.1); color: #4ade80; }

.metric-card__info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.metric-card__value {
  font-size: 1.15rem;
  font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-primary);
}

.metric-card__label {
  font-size: 0.68rem;
  color: var(--text-muted);
  margin-top: 0.1rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Quick Actions */
.dashboard__actions {
  display: flex;
  gap: 0.65rem;
  margin-bottom: 2rem;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.5rem 1rem;
  border-radius: 10px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  color: var(--text-tertiary);
  font-size: 0.78rem;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  text-decoration: none;
  transition: all 0.2s;
}

.action-btn:hover {
  border-color: var(--primary-border);
  color: var(--primary-text);
  background: var(--primary-bg);
}

.action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Sections */
.dashboard__section {
  margin-bottom: 2rem;
}

.dashboard__section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
}

.dashboard__section-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 0;
}

.dashboard__section-link {
  font-size: 0.78rem;
  color: var(--primary-text);
  text-decoration: none;
}

.dashboard__section-link:hover {
  text-decoration: underline;
}

/* Two-column grid */
.dashboard__grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
}

.dashboard__grid-2 .dashboard__section {
  margin-bottom: 0.5rem;
}

/* Sites grid */
.dashboard__sites {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.site-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 0.85rem;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  text-decoration: none;
  color: inherit;
  transition: all 0.2s;
}

.site-row:hover {
  background: var(--bg-elevated);
  border-color: var(--primary-border);
}

.site-row__info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.site-row__name {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.site-row__domain {
  font-size: 0.68rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-muted);
  margin-top: 0.1rem;
}

/* Empty states */
.dashboard__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 2rem;
}

.dashboard__empty-text {
  color: var(--text-muted);
  font-size: 0.85rem;
  margin-top: 0.5rem;
}

.dashboard__empty-inline {
  text-align: center;
  padding: 1.5rem;
  color: var(--text-faint);
  font-size: 0.82rem;
}

/* Services */
.services-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 0.85rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.service-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.service-item__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.service-item__dot--up {
  background: #4ade80;
  box-shadow: 0 0 6px rgba(74, 222, 128, 0.4);
}

.service-item__dot--down {
  background: #f87171;
  box-shadow: 0 0 6px rgba(248, 113, 113, 0.4);
}

.service-item__name {
  font-size: 0.82rem;
  color: var(--text-secondary);
  flex: 1;
}

.service-item__status {
  font-size: 0.7rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-faint);
}

/* Recent Activity */
.activity-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 0.65rem 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.activity-item {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.35rem 0;
}

.activity-item + .activity-item {
  border-top: 1px solid var(--border);
}

.activity-item__badge {
  font-size: 0.58rem;
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
  padding: 0.15rem 0.4rem;
  border-radius: 6px;
  flex-shrink: 0;
  min-width: 52px;
  text-align: center;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.activity-item__badge--login { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
.activity-item__badge--logout { background: rgba(148, 163, 184, 0.1); color: #94a3b8; }
.activity-item__badge--create { background: rgba(99, 102, 241, 0.1); color: #818cf8; }
.activity-item__badge--update { background: rgba(245, 158, 11, 0.1); color: #fbbf24; }
.activity-item__badge--delete { background: rgba(239, 68, 68, 0.1); color: #f87171; }
.activity-item__badge--deploy { background: rgba(0, 220, 130, 0.1); color: #00dc82; }
.activity-item__badge--backup { background: rgba(139, 92, 246, 0.1); color: #a78bfa; }
.activity-item__badge--restore { background: rgba(139, 92, 246, 0.1); color: #a78bfa; }
.activity-item__badge--ssl_issue { background: rgba(56, 189, 248, 0.1); color: #38bdf8; }
.activity-item__badge--service_start { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
.activity-item__badge--service_stop { background: rgba(239, 68, 68, 0.1); color: #f87171; }
.activity-item__badge--service_restart { background: rgba(245, 158, 11, 0.1); color: #fbbf24; }

.activity-item__info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.activity-item__entity {
  font-size: 0.78rem;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.activity-item__meta {
  font-size: 0.65rem;
  color: var(--text-faint);
  margin-top: 0.05rem;
}

/* Security cards */
.security-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.65rem;
}

.sec-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.3rem;
  padding: 1rem 0.75rem;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  text-align: center;
}

.sec-card__icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sec-card__icon--warn { background: rgba(245, 158, 11, 0.1); color: #fbbf24; }
.sec-card__icon--info { background: rgba(99, 102, 241, 0.1); color: #818cf8; }
.sec-card__icon--ok { background: rgba(34, 197, 94, 0.1); color: #4ade80; }

.sec-card__value {
  font-size: 1.25rem;
  font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-primary);
}

.sec-card__value--sm {
  font-size: 0.78rem;
  font-weight: 600;
}

.sec-card__label {
  font-size: 0.65rem;
  color: var(--text-muted);
}

/* Backups */
.backups-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 0.65rem 0.85rem;
}

.backup-row {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.45rem 0;
}

.backup-row + .backup-row {
  border-top: 1px solid var(--border);
}

.backup-row__site {
  font-size: 0.8rem;
  color: var(--text-secondary);
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.backup-row__badge {
  font-size: 0.6rem;
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
  padding: 0.1rem 0.35rem;
  border-radius: 6px;
  text-transform: uppercase;
  flex-shrink: 0;
}

.backup-row__badge--completed { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
.backup-row__badge--failed { background: rgba(239, 68, 68, 0.1); color: #f87171; }
.backup-row__badge--pending,
.backup-row__badge--in_progress { background: rgba(245, 158, 11, 0.1); color: #fbbf24; }
.backup-row__badge--never { background: rgba(148, 163, 184, 0.1); color: #94a3b8; }

.backup-row__date {
  font-size: 0.7rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-faint);
  flex-shrink: 0;
  min-width: 80px;
}

.backup-row__size {
  font-size: 0.7rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-faint);
  flex-shrink: 0;
  min-width: 50px;
  text-align: right;
}

/* SSL */
.ssl-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 0.85rem 1rem;
}

.ssl-row {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.4rem 0;
}

.ssl-row + .ssl-row {
  border-top: 1px solid var(--border);
}

.ssl-row__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.ssl-row__dot--warn {
  background: #fbbf24;
  box-shadow: 0 0 6px rgba(251, 191, 36, 0.4);
}

.ssl-row__info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.ssl-row__domain {
  font-size: 0.82rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-secondary);
}

.ssl-row__meta {
  font-size: 0.65rem;
  color: var(--text-faint);
  margin-top: 0.05rem;
}

.ssl-card__ok {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  color: #4ade80;
  font-size: 0.85rem;
  font-weight: 500;
}

/* System info */
.dashboard__sys-info {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 1rem 1.15rem;
}

.sys-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.sys-item__label {
  font-size: 0.78rem;
  color: var(--text-muted);
  min-width: 80px;
  font-family: 'JetBrains Mono', monospace;
}

.sys-item__bar {
  flex: 1;
  height: 6px;
  background: var(--border);
  border-radius: 3px;
  overflow: hidden;
}

.sys-item__bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #22c55e, #4ade80);
  border-radius: 3px;
  transition: width 0.5s ease;
}

.sys-item__bar-fill--warn {
  background: linear-gradient(90deg, #f59e0b, #fbbf24);
}

.sys-item__bar-fill--crit {
  background: linear-gradient(90deg, #ef4444, #f87171);
}

.sys-item__value {
  font-size: 0.78rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-secondary);
  min-width: 48px;
  text-align: right;
}

@media (max-width: 768px) {
  .dashboard__metrics {
    grid-template-columns: 1fr 1fr;
    gap: 0.65rem;
  }

  .metric-card {
    padding: 0.75rem 0.85rem;
  }

  .metric-card__icon {
    width: 34px;
    height: 34px;
    border-radius: 10px;
  }

  .metric-card__value {
    font-size: 1rem;
  }

  .metric-card__label {
    font-size: 0.62rem;
  }

  .dashboard__grid-2 {
    grid-template-columns: 1fr;
    gap: 0;
  }

  .dashboard__actions {
    flex-wrap: wrap;
  }

  .security-cards {
    grid-template-columns: repeat(3, 1fr);
    gap: 0.45rem;
  }

  .sec-card {
    padding: 0.75rem 0.45rem;
  }

  .sec-card__value {
    font-size: 1rem;
  }

  .dashboard__title {
    font-size: 1.25rem;
  }

  .sys-item__label {
    min-width: 60px;
    font-size: 0.7rem;
  }

  .backup-row__date,
  .backup-row__size {
    display: none;
  }
}

@media (max-width: 400px) {
  .dashboard__metrics {
    grid-template-columns: 1fr;
  }
}
</style>
