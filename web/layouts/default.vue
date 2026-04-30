<template>
  <div class="app-layout">
    <!-- Mobile header -->
    <header class="mobile-header">
      <button class="mobile-header__toggle" @click="sidebarOpen = !sidebarOpen">
        <svg v-if="!sidebarOpen" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
        <svg v-else width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>
      <div class="mobile-header__brand">
        <CatMascot :size="24" mood="happy" />
        <span class="mobile-header__name">Meowbox</span>
      </div>
      <button class="mobile-header__theme" @click="themeToggle">
        <svg v-if="isDark" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
        <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      </button>
    </header>

    <!-- Sidebar overlay (mobile) -->
    <Transition name="overlay">
      <div v-if="sidebarOpen" class="sidebar-overlay" @click="sidebarOpen = false" />
    </Transition>

    <!-- Sidebar -->
    <aside class="sidebar" :class="{ 'sidebar--open': sidebarOpen }">
      <!-- Logo -->
      <div class="sidebar__brand">
        <CatMascot :size="36" mood="happy" />
        <div class="sidebar__brand-text">
          <span class="sidebar__brand-name">Meowbox</span>
          <NuxtLink
            v-if="versionInfo?.hasUpdate"
            to="/admin/updates"
            class="sidebar__brand-version sidebar__brand-version--update"
            :title="`Доступно обновление: ${versionInfo.latest}`"
          >
            <span>{{ versionInfo.current }}</span>
            <span class="sidebar__update-dot" />
            <span class="sidebar__update-arrow">→ {{ versionInfo.latest }}</span>
          </NuxtLink>
          <span v-else class="sidebar__brand-version">
            {{ versionInfo?.current ?? '...' }}
          </span>
        </div>
      </div>

      <!-- Server selector (only when multiple servers) -->
      <div v-if="serverStore.hasMultipleServers" class="sidebar__server">
        <select
          :value="serverStore.currentServerId"
          class="sidebar__server-select"
          @change="onServerChange"
        >
          <option
            v-for="s in serverStore.servers"
            :key="s.id"
            :value="s.id"
          >{{ s.online ? '\u25CF' : '\u25CB' }} {{ s.name }}</option>
        </select>
      </div>

      <!-- Navigation -->
      <nav class="sidebar__nav" @click="sidebarOpen = false">
        <div class="sidebar__section">
          <span class="sidebar__section-label">Основное</span>
          <SidebarLink to="/" icon="home" label="Дашборд" />
          <SidebarLink to="/sites" icon="globe" label="Сайты" />
          <SidebarLink to="/databases" icon="database" label="Базы данных" />
        </div>

        <div class="sidebar__section">
          <span class="sidebar__section-label">Операции</span>
          <SidebarLink to="/backups" icon="archive" label="Бэкапы" />
          <SidebarLink to="/monitoring" icon="chart" label="Мониторинг" />
          <SidebarLink to="/cron" icon="clock" label="Cron-задачи" />
          <SidebarLink to="/logs" icon="file-text" label="Логи" />
          <SidebarLink to="/storage" icon="hard-drive" label="Хранилище" />
          <SidebarLink to="/ssl" icon="lock" label="SSL" />
          <SidebarLink to="/activity" icon="activity" label="Активность" />
          <SidebarLink to="/health" icon="heart" label="Здоровье" />
          <SidebarLink to="/dns" icon="globe" label="DNS" />
        </div>

        <div class="sidebar__section">
          <span class="sidebar__section-label">Система</span>
          <SidebarLink to="/services" icon="box" label="Сервисы" />
          <SidebarLink to="/nginx" icon="server" label="Nginx" />
          <SidebarLink to="/php" icon="code" label="PHP" />
          <!-- Скрыто до реализации (см. BACKLOG.md):
               /processes, /terminal, /updates, /servers, /ai -->
          <SidebarLink to="/firewall" icon="shield" label="Файрвол" />
          <SidebarLink to="/users" icon="users" label="Пользователи" />
          <SidebarLink to="/settings" icon="settings" label="Настройки" />
        </div>
      </nav>

      <!-- Theme toggle + User section -->
      <div class="sidebar__bottom">
        <button class="sidebar__theme-toggle" @click="themeToggle">
          <svg v-if="isDark" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
          <span>{{ isDark ? 'Светлая тема' : 'Тёмная тема' }}</span>
        </button>

        <div class="sidebar__user">
          <div class="sidebar__user-info">
            <div class="sidebar__user-avatar">
              {{ authStore.user?.username?.charAt(0).toUpperCase() || 'A' }}
            </div>
            <div class="sidebar__user-meta">
              <span class="sidebar__user-name">{{ authStore.user?.username || 'admin' }}</span>
              <span class="sidebar__user-role">{{ authStore.user?.role || 'ADMIN' }}</span>
            </div>
          </div>
          <button class="sidebar__logout" title="Выход" @click="authStore.logout()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16,17 21,12 16,7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </div>
    </aside>

    <!-- Main content -->
    <main class="main">
      <div class="main__content">
        <slot />
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
const authStore = useAuthStore();
const serverStore = useServerStore();
const sidebarOpen = ref(false);
const { connect: connectSocket, disconnect: disconnectSocket } = useSocket();
const { isDark, toggle: themeToggle, init: themeInit } = useTheme();
const api = useApi();

interface VersionInfo {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  checkedAt: string | null;
}
const versionInfo = ref<VersionInfo | null>(null);
let versionTimer: ReturnType<typeof setInterval> | null = null;

async function loadVersion(refresh = false) {
  try {
    versionInfo.value = await api.get<VersionInfo>(`/admin/update/version${refresh ? '?refresh=1' : ''}`);
  } catch { /* silent */ }
}

function onServerChange(e: Event) {
  const id = (e.target as HTMLSelectElement).value;
  serverStore.selectServer(id);
  // Full reload to refetch all data for the new server
  window.location.reload();
}

onMounted(() => {
  themeInit();
  authStore.initFromStorage();
  serverStore.initFromStorage();
  if (authStore.accessToken) {
    authStore.fetchProfile().catch(() => {});
    serverStore.loadServers().catch(() => {});
    connectSocket();
    // Грузим текущую версию сразу (быстро, из кеша/файла), без ходокa в GitHub.
    loadVersion(false);
    // Раз в 6 часов форсим refresh latest через GitHub, чтобы badge появлялся.
    loadVersion(true);
    versionTimer = setInterval(() => loadVersion(true), 6 * 60 * 60 * 1000);
  }
});

onUnmounted(() => {
  disconnectSocket();
  if (versionTimer) clearInterval(versionTimer);
});
</script>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@400;500&display=swap');

.app-layout {
  min-height: 100vh;
  display: flex;
  background: var(--bg-body);
  color: var(--text-primary);
  font-family: 'DM Sans', sans-serif;
  overflow-x: hidden;
  width: 100%;
  max-width: 100vw;
}

/* ---- Mobile header ---- */
.mobile-header {
  display: none;
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 52px;
  background: var(--bg-header);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
  align-items: center;
  justify-content: space-between;
  padding: 0 0.85rem;
  z-index: 60;
}

.mobile-header__toggle {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  padding: 0.3rem;
  display: flex;
}

.mobile-header__brand {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.mobile-header__name {
  font-size: 0.95rem;
  font-weight: 700;
  background: linear-gradient(135deg, var(--primary-light), var(--primary-dark));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.mobile-header__theme {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  padding: 0.3rem;
  display: flex;
}

/* ---- Sidebar overlay ---- */
.sidebar-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: var(--bg-overlay);
  z-index: 55;
}

/* ---- Sidebar ---- */
.sidebar {
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;
  width: 240px;
  display: flex;
  flex-direction: column;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  z-index: 50;
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

/* Brand */
.sidebar__brand {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1.25rem 1.25rem 1rem;
  border-bottom: 1px solid var(--border);
}

.sidebar__brand-text {
  display: flex;
  flex-direction: column;
}

.sidebar__brand-name {
  font-size: 1.1rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  background: linear-gradient(135deg, var(--primary-light), var(--primary-dark));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.sidebar__brand-version {
  font-size: 0.65rem;
  color: var(--text-faint);
  font-family: 'JetBrains Mono', monospace;
  letter-spacing: 0.02em;
}
.sidebar__brand-version--update {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  text-decoration: none;
  color: var(--primary, #f59e0b);
  font-weight: 600;
  cursor: pointer;
}
.sidebar__brand-version--update:hover { filter: brightness(1.15); }
.sidebar__update-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--primary, #f59e0b);
  box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.6);
  animation: sidebar-pulse 2s ease-in-out infinite;
}
.sidebar__update-arrow {
  font-size: 0.6rem;
  color: var(--primary, #f59e0b);
  opacity: 0.85;
}
@keyframes sidebar-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.55); }
  50% { box-shadow: 0 0 0 6px rgba(245, 158, 11, 0); }
}

/* Server selector */
.sidebar__server {
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--border);
}

.sidebar__server-select {
  width: 100%;
  padding: 0.45rem 0.65rem;
  border-radius: 8px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.15s;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpolyline points='6,9 12,15 18,9'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.5rem center;
  padding-right: 1.5rem;
}

.sidebar__server-select:hover {
  border-color: var(--border);
}

.sidebar__server-select:focus {
  outline: none;
  border-color: var(--primary);
}

/* Navigation */
.sidebar__nav {
  flex: 1;
  overflow-y: auto;
  padding: 0.75rem;
}

.sidebar__section {
  margin-bottom: 1.25rem;
}

.sidebar__section-label {
  display: block;
  font-size: 0.65rem;
  font-weight: 600;
  color: var(--text-faint);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 0 0.75rem;
  margin-bottom: 0.5rem;
}

/* Theme toggle */
.sidebar__bottom {
  border-top: 1px solid var(--border);
}

.sidebar__theme-toggle {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  padding: 0.6rem 1rem;
  background: none;
  border: none;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.75rem;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
}

.sidebar__theme-toggle:hover {
  color: var(--text-secondary);
  background: var(--bg-surface);
}

/* User */
.sidebar__user {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  background: var(--bg-user);
}

.sidebar__user-info {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.sidebar__user-avatar {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(217, 119, 6, 0.1));
  border: 1px solid var(--primary-border);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--primary);
}

.sidebar__user-meta {
  display: flex;
  flex-direction: column;
}

.sidebar__user-name {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--text-secondary);
}

.sidebar__user-role {
  font-size: 0.6rem;
  font-weight: 500;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-muted);
  letter-spacing: 0.04em;
}

.sidebar__logout {
  background: none;
  border: none;
  padding: 0.4rem;
  border-radius: 8px;
  color: var(--text-faint);
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
}

.sidebar__logout:hover {
  color: var(--danger);
  background: var(--danger-bg);
}

/* ---- Main ---- */
.main {
  flex: 1;
  margin-left: 240px;
  min-height: 100vh;
  min-width: 0;
  overflow-x: hidden;
}

.main__content {
  padding: 2rem 2.5rem;
  max-width: 1400px;
  width: 100%;
  box-sizing: border-box;
}

/* ---- Overlay transition ---- */
.overlay-enter-active,
.overlay-leave-active {
  transition: opacity 0.3s;
}

.overlay-enter-from,
.overlay-leave-to {
  opacity: 0;
}

/* ---- Mobile responsive ---- */
@media (max-width: 768px) {
  .mobile-header {
    display: flex;
  }

  .sidebar-overlay {
    display: block;
  }

  .sidebar {
    transform: translateX(-100%);
    z-index: 60;
    top: 0;
  }

  .sidebar--open {
    transform: translateX(0);
  }

  .main {
    margin-left: 0;
    padding-top: 52px;
    width: 100%;
    max-width: 100vw;
  }

  .main__content {
    padding: 1rem 0.85rem;
    max-width: 100%;
  }
}
</style>
