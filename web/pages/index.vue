<template>
  <main class="operations-dashboard">
    <header class="dashboard-heading">
      <div>
        <span class="ops-section-kicker">Operations control room</span>
        <h1>Обзор системы</h1>
        <p>{{ selectedServerName }} · единый операционный снимок</p>
      </div>
    </header>

    <p class="ops-sr-only" aria-live="polite" aria-atomic="true">{{ liveMessage }}</p>

    <div v-if="legacy" class="compatibility-notice" role="status">
      <div><strong>Ограниченный режим совместимости</strong><span>Сервер не поддерживает Dashboard Overview v1. Неподтверждённые проверки помечены явно.</span></div>
      <NuxtLink v-if="snapshot?.role === 'ADMIN'" to="/updates" class="ops-link">Обновления сервера</NuxtLink>
    </div>

    <div v-if="error && snapshot" class="refresh-warning" role="status">
      <span>{{ error }}. Показан последний снимок этого сервера.</span>
      <button class="ops-button" type="button" @click="refresh">Повторить</button>
    </div>

    <div v-if="initialLoading && !snapshot" class="dashboard-skeleton" aria-label="Загрузка обзора" aria-busy="true">
      <div class="skeleton skeleton--pulse" />
      <div class="skeleton skeleton--inbox" />
      <div class="skeleton skeleton--resources" />
      <div class="skeleton-grid"><div class="skeleton skeleton--panel" /><div class="skeleton skeleton--panel" /></div>
    </div>

    <section v-else-if="!snapshot" class="dashboard-unavailable ops-panel" aria-labelledby="dashboard-unavailable-title">
      <span class="unavailable-code ops-mono">NO SNAPSHOT</span>
      <h2 id="dashboard-unavailable-title">{{ error || 'Обзор сервера недоступен' }}</h2>
      <p>Данные другого сервера не подставляются. Проверьте соединение и права доступа.</p>
      <button class="ops-button" type="button" @click="refresh">Повторить запрос</button>
    </section>

    <template v-else>
      <DashboardServerPulse
        :server="snapshot.server"
        :overall="snapshot.overall"
        :refreshing="refreshing"
        :last-success-at="lastSuccessAt || snapshot.generatedAt"
        @refresh="refresh"
      />
      <DashboardProblemsInbox :problems="snapshot.problems" :overall="snapshot.overall" />
      <DashboardResourceStrip :resources="snapshot.resources" />

      <div class="dashboard-grid dashboard-grid--workloads">
        <DashboardSitesPanel :sites="snapshot.sites" />
        <DashboardRuntimePanel :runtime="snapshot.runtime" />
      </div>

      <div class="dashboard-grid dashboard-grid--protection" :class="{ 'dashboard-grid--single': !snapshot.security }">
        <DashboardProtectionPanel :protection="snapshot.protection" />
        <DashboardSecurityPanel v-if="snapshot.security" :security="snapshot.security" />
      </div>

      <DashboardActivityPanel :activity="snapshot.activity" />
    </template>
  </main>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

const serverStore = useServerStore();
const {
  snapshot,
  initialLoading,
  refreshing,
  error,
  lastSuccessAt,
  liveMessage,
  legacy,
  refresh,
} = useDashboardOverview();

const selectedServerName = computed(() => serverStore.currentServer?.name
  ?? (serverStore.currentServerId === 'main' ? 'Этот сервер' : 'Выбранный сервер'));
</script>

<style scoped>
.operations-dashboard {
  --text-tertiary: rgba(255, 255, 255, 0.58);
  --text-muted: rgba(255, 255, 255, 0.5);
  --dashboard-status-success: var(--success-light);
  --dashboard-status-warning: var(--primary-light);
  --dashboard-status-danger: var(--danger-light);
  display: grid;
  width: 100%;
  max-width: 1400px;
  gap: 1rem;
  margin: 0 auto;
  padding-bottom: 2rem;
}

:global(html.theme-light) .operations-dashboard {
  --text-tertiary: rgba(0, 0, 0, 0.62);
  --text-muted: rgba(0, 0, 0, 0.56);
  --dashboard-status-success: #15803d;
  --dashboard-status-warning: #92400e;
  --dashboard-status-danger: #b91c1c;
}

.dashboard-heading { display: flex; align-items: flex-end; justify-content: space-between; min-height: 48px; }
.dashboard-heading h1 { margin: 0; color: var(--text-heading); font-size: 1.45rem; font-weight: 700; letter-spacing: -0.035em; }
.dashboard-heading p { margin: 0.2rem 0 0; color: var(--text-muted); font-size: 0.72rem; }
.compatibility-notice, .refresh-warning { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.75rem 0.9rem; border: 1px solid var(--primary-border); border-left: 3px solid var(--primary); border-radius: 9px; background: var(--primary-bg); }
.compatibility-notice div { min-width: 0; }
.compatibility-notice strong, .compatibility-notice span { display: block; }
.compatibility-notice strong { color: var(--dashboard-status-warning); font-size: 0.76rem; }
.compatibility-notice span, .refresh-warning span { margin-top: 0.12rem; color: var(--text-tertiary); font-size: 0.68rem; }
.refresh-warning { border-color: var(--danger-border); border-left-color: var(--danger); background: var(--danger-bg); }
.dashboard-grid { display: grid; gap: 1rem; align-items: start; }
.dashboard-grid--workloads { grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); }
.dashboard-grid--protection { grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); }
.dashboard-grid--single { grid-template-columns: 1fr; }

.dashboard-skeleton { display: grid; gap: 1rem; }
.skeleton { position: relative; overflow: hidden; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-surface); }
.skeleton::after { position: absolute; inset: 0; background: var(--bg-surface-hover); opacity: 0.25; animation: skeleton-pulse 1.5s infinite alternate; content: ''; }
.skeleton--pulse { height: 112px; }
.skeleton--inbox { height: 156px; }
.skeleton--resources { height: 150px; }
.skeleton--panel { height: 260px; }
.skeleton-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 1rem; }
@keyframes skeleton-pulse { to { opacity: 0.75; } }

.dashboard-unavailable { padding: 2rem; border-top: 2px solid var(--danger); }
.unavailable-code { color: var(--dashboard-status-danger); font-size: 0.64rem; }
.dashboard-unavailable h2 { margin: 0.5rem 0 0; color: var(--text-heading); font-size: 1.1rem; }
.dashboard-unavailable p { margin: 0.4rem 0 1rem; color: var(--text-tertiary); font-size: 0.76rem; }

@media (max-width: 900px) {
  .dashboard-grid--workloads, .dashboard-grid--protection { grid-template-columns: 1fr; }
}

@media (max-width: 620px) {
  .operations-dashboard { gap: 0.75rem; }
  .dashboard-heading { min-height: 42px; }
  .dashboard-heading h1 { font-size: 1.25rem; }
  .compatibility-notice, .refresh-warning { align-items: flex-start; }
  .compatibility-notice .ops-link { display: none; }
  .skeleton-grid { grid-template-columns: 1fr; }
  .skeleton--pulse { height: 168px; }
  .skeleton--inbox { height: 128px; }
}
</style>
