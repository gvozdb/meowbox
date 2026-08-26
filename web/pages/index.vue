<template>
  <main class="operations-dashboard">
    <header class="dashboard-heading">
      <div class="dashboard-heading__copy">
        <span class="ops-section-kicker">Операционный центр</span>
        <h1>Обзор системы</h1>
        <p><strong>{{ selectedServerName }}</strong><span aria-hidden="true">/</span> ключевые сигналы сервера в одном экране</p>
      </div>
      <div class="dashboard-heading__freshness"><span aria-hidden="true" />Автообновление · 30 сек</div>
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
  --dashboard-status-success: var(--success-text);
  --dashboard-status-warning: var(--warning-text);
  --dashboard-status-danger: var(--danger-text);
  position: relative;
  display: grid;
  width: 100%;
  max-width: 1280px;
  gap: 0.9rem;
  margin: 0 auto;
  padding-bottom: 2.5rem;
}

.dashboard-heading {
  display: flex;
  min-height: 68px;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.25rem 0.2rem 0.35rem;
}
.dashboard-heading h1 { margin: 0; color: var(--text-heading); font-size: clamp(1.45rem, 2vw, 1.75rem); font-weight: 750; letter-spacing: -0.045em; }
.dashboard-heading p { display: flex; align-items: center; gap: 0.45rem; margin: 0.28rem 0 0; color: var(--text-tertiary); font-size: 0.73rem; }
.dashboard-heading p strong { color: var(--text-secondary); font-weight: 700; }
.dashboard-heading p span { color: var(--text-faint); }
.dashboard-heading__freshness { display: inline-flex; align-items: center; gap: 0.45rem; padding-bottom: 0.18rem; color: var(--text-muted); font: 650 0.62rem/1 'JetBrains Mono', monospace; }
.dashboard-heading__freshness span { width: 7px; height: 7px; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 4px var(--success-bg); }
.compatibility-notice, .refresh-warning { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.75rem 0.9rem; border: 1px solid var(--primary-border); border-left: 3px solid var(--primary); border-radius: 9px; background: var(--primary-bg); }
.compatibility-notice div { min-width: 0; }
.compatibility-notice strong, .compatibility-notice span { display: block; }
.compatibility-notice strong { color: var(--dashboard-status-warning); font-size: 0.76rem; }
.compatibility-notice span, .refresh-warning span { margin-top: 0.12rem; color: var(--text-tertiary); font-size: 0.68rem; }
.refresh-warning { border-color: var(--danger-border); border-left-color: var(--danger-text); background: var(--danger-bg); }
.dashboard-grid { display: grid; gap: 0.9rem; align-items: stretch; }
.dashboard-grid > :deep(.ops-panel) { height: 100%; }
.dashboard-grid--workloads { grid-template-columns: minmax(0, 1.65fr) minmax(300px, 1fr); }
.dashboard-grid--protection { grid-template-columns: minmax(0, 1.45fr) minmax(300px, 1fr); }
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
  .dashboard-heading { min-height: 58px; align-items: flex-start; }
  .dashboard-heading h1 { font-size: 1.25rem; }
  .dashboard-heading p { display: block; line-height: 1.45; }
  .dashboard-heading p span { display: none; }
  .dashboard-heading__freshness { display: none; }
  .compatibility-notice, .refresh-warning { align-items: flex-start; }
  .compatibility-notice .ops-link { display: none; }
  .skeleton-grid { grid-template-columns: 1fr; }
  .skeleton--pulse { height: 168px; }
  .skeleton--inbox { height: 128px; }
}
</style>
