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

      <!-- Server selector (only when multiple servers) — кастомный dropdown,
           чтобы кругляш слева (статус) подсвечивался цветом палитры сервера.
           Native <select> отказали: в <option> нельзя стилизовать псевдо-элементы. -->
      <div
        v-if="serverStore.hasMultipleServers"
        ref="serverDropdownRef"
        class="sidebar__server"
        :class="{ 'sidebar__server--open': serverMenuOpen }"
      >
        <button
          type="button"
          class="sidebar__server-trigger"
          @click="serverMenuOpen = !serverMenuOpen"
        >
          <span
            class="sidebar__server-dot"
            :class="{ 'sidebar__server-dot--offline': !currentServerInfo?.online }"
            :style="{ '--server-dot-color': currentServerSwatch }"
          />
          <span class="sidebar__server-name">{{ currentServerInfo?.name || '—' }}</span>
          <svg class="sidebar__server-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <polyline points="6,9 12,15 18,9" />
          </svg>
        </button>
        <Transition name="dropdown">
          <div v-if="serverMenuOpen" class="sidebar__server-menu" role="listbox">
            <button
              v-for="s in serverStore.servers"
              :key="s.id"
              type="button"
              class="sidebar__server-option"
              :class="{ 'sidebar__server-option--active': s.id === serverStore.currentServerId }"
              role="option"
              :aria-selected="s.id === serverStore.currentServerId"
              @click="selectServerFromMenu(s.id)"
            >
              <span
                class="sidebar__server-dot"
                :class="{ 'sidebar__server-dot--offline': !s.online }"
                :style="{ '--server-dot-color': swatchForServer(s.id) }"
              />
              <span class="sidebar__server-name">{{ s.name }}</span>
              <svg
                v-if="s.id === serverStore.currentServerId"
                class="sidebar__server-check"
                width="13" height="13" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
              ><polyline points="20 6 9 17 4 12" /></svg>
            </button>
          </div>
        </Transition>
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
import { PALETTE_SWATCHES, type PaletteId } from '~/composables/usePalette';

const authStore = useAuthStore();
const serverStore = useServerStore();
const sidebarOpen = ref(false);
const { connect: connectSocket, disconnect: disconnectSocket } = useSocket();
const { isDark, toggle: themeToggle, init: themeInit } = useTheme();
const {
  applyForServer: applyPaletteForServer,
  setForServer: setPaletteForServer,
  readForServer: readPaletteForServer,
  loadAllFromApi: loadAllPalettesFromApi,
  DEFAULT_PALETTE,
} = usePalette();
const api = useApi();

// ── Кастомный селектор серверов (открывается по клику, дот = цвет палитры) ──
const serverMenuOpen = ref(false);
const serverDropdownRef = ref<HTMLElement | null>(null);

const currentServerInfo = computed(() =>
  serverStore.servers.find((s) => s.id === serverStore.currentServerId) ?? null,
);

/** Hex цвета палитры сервера (или дефолт если кеш пустой). */
function swatchForServer(serverId: string): string {
  const p = (readPaletteForServer(serverId) as PaletteId | null) ?? DEFAULT_PALETTE;
  return PALETTE_SWATCHES[p];
}

const currentServerSwatch = computed(() =>
  swatchForServer(serverStore.currentServerId || 'main'),
);

function selectServerFromMenu(id: string) {
  serverMenuOpen.value = false;
  if (id === serverStore.currentServerId) return;
  // Применяем cached палитру нового сервера ДО reload — иначе мигнёт
  // текущая палитра пока скрипт не перечитает cache.
  applyPaletteForServer(id, /* withTransition */ false);
  serverStore.selectServer(id);
  window.location.reload();
}

// Закрываем меню при клике мимо.
function onDocClick(e: MouseEvent) {
  if (!serverMenuOpen.value) return;
  const root = serverDropdownRef.value;
  if (!root) return;
  if (!root.contains(e.target as Node)) serverMenuOpen.value = false;
}
function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape' && serverMenuOpen.value) serverMenuOpen.value = false;
}

/**
 * Подтянуть карту палитр всех серверов с мастер-API одним запросом и
 * засинхронизировать локальный cache. Затем применяем актуальную палитру
 * текущего сервера. Молча игнорим ошибки сети — пользователь увидит cached.
 */
async function syncPaletteFromApi() {
  const map = await loadAllPalettesFromApi(api);
  const sid = serverStore.currentServerId || 'main';
  const next = map[sid];
  if (next) {
    setPaletteForServer(sid, next, /* withTransition */ false);
  }
}

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

onMounted(() => {
  themeInit();
  authStore.initFromStorage();
  serverStore.initFromStorage();
  // Применяем палитру для активного сервера сразу из cache (мгновенно).
  // После загрузки данных сервера ниже — синхронизируем с актуальным значением API.
  applyPaletteForServer(serverStore.currentServerId || 'main', /* withTransition */ false);
  document.addEventListener('mousedown', onDocClick);
  document.addEventListener('keydown', onEsc);
  if (authStore.accessToken) {
    authStore.fetchProfile().catch(() => {});
    serverStore.loadServers().catch(() => {});
    syncPaletteFromApi();
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
  document.removeEventListener('mousedown', onDocClick);
  document.removeEventListener('keydown', onEsc);
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
  color: var(--primary, var(--primary));
  font-weight: 600;
  cursor: pointer;
}
.sidebar__brand-version--update:hover { filter: brightness(1.15); }
.sidebar__update-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--primary, var(--primary));
  box-shadow: 0 0 0 0 rgba(var(--primary-rgb), 0.6);
  animation: sidebar-pulse 2s ease-in-out infinite;
}
.sidebar__update-arrow {
  font-size: 0.6rem;
  color: var(--primary, var(--primary));
  opacity: 0.85;
}
@keyframes sidebar-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(var(--primary-rgb), 0.55); }
  50% { box-shadow: 0 0 0 6px rgba(var(--primary-rgb), 0); }
}

/* Server selector — кастомный dropdown ради цветного дота палитры */
.sidebar__server {
  position: relative;
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--border);
}

.sidebar__server-trigger {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.45rem 0.65rem;
  border-radius: 8px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  text-align: left;
}
.sidebar__server-trigger:hover {
  border-color: var(--border);
}
.sidebar__server--open .sidebar__server-trigger {
  border-color: var(--primary);
  box-shadow: var(--focus-ring);
}

/* Цветной кругляш = цвет палитры сервера. Берём через CSS-переменную
   --server-dot-color (присваиваем inline). Offline — slegka dim'им. */
.sidebar__server-dot {
  flex-shrink: 0;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--server-dot-color, var(--primary));
  box-shadow: 0 0 6px color-mix(in srgb, var(--server-dot-color, var(--primary)) 35%, transparent);
}
.sidebar__server-dot--offline {
  background: transparent;
  border: 1.5px solid var(--server-dot-color, var(--text-muted));
  box-shadow: none;
  opacity: 0.65;
}

.sidebar__server-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar__server-chevron {
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform 0.18s ease;
}
.sidebar__server--open .sidebar__server-chevron {
  transform: rotate(180deg);
}

/* Меню */
.sidebar__server-menu {
  position: absolute;
  z-index: 70;
  top: calc(100% - 0.2rem);
  left: 0.75rem;
  right: 0.75rem;
  margin-top: 0.35rem;
  padding: 0.3rem;
  background: var(--bg-modal);
  background-image: var(--bg-modal-gradient);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 50vh;
  overflow-y: auto;
}

.sidebar__server-option {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.45rem 0.55rem;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s;
}
.sidebar__server-option:hover {
  background: var(--bg-surface-hover);
  color: var(--text-primary);
}
.sidebar__server-option--active {
  background: var(--primary-bg);
  color: var(--primary-text);
}
.sidebar__server-option--active:hover {
  background: var(--primary-bg-hover);
}

.sidebar__server-check {
  flex-shrink: 0;
  color: var(--primary);
}

/* Dropdown transition */
.dropdown-enter-active,
.dropdown-leave-active {
  transition: opacity 0.15s ease, transform 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}
.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px);
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
  background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.15), rgba(var(--primary-dark-rgb), 0.1));
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
