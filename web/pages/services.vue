<template>
  <div class="services">
    <div class="services__header">
      <div>
        <h1 class="services__title">Сервисы</h1>
        <p class="services__subtitle">
          Глобальные демоны (БД, поиск, кэш, очереди), которыми пользуются сайты.
          Базы данных подключаются ко всем сайтам сразу, остальные — per-site.
        </p>
      </div>
      <button
        class="btn btn--ghost btn--sm btn--icon"
        :disabled="loading"
        title="Обновить"
        aria-label="Обновить"
        @click="loadAll"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23,4 23,10 17,10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
      </button>
    </div>

    <div v-if="loading" class="services__loading">
      <div class="spinner" />
    </div>

    <div v-else-if="!items.length" class="services__empty">
      <CatMascot v-if="hasCatMascot" :size="64" mood="sleepy" />
      <p>Сервисы пока не зарегистрированы</p>
    </div>

    <div v-else class="services__grid">
      <div v-for="item in items" :key="item.key" class="svc-card">
        <div class="svc-card__head">
          <div class="svc-card__icon" :class="`svc-card__icon--${item.catalog.category}`">
            <svg v-if="item.catalog.icon === 'search'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <svg v-else-if="item.catalog.icon === 'cache'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
            <svg v-else-if="item.catalog.icon === 'database'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
            </svg>
            <svg v-else width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" /></svg>
          </div>
          <div class="svc-card__title-block">
            <div class="svc-card__title">{{ item.catalog.name }}</div>
            <div class="svc-card__category">{{ categoryLabel(item.catalog.category) }}</div>
          </div>
          <span
            class="svc-card__status"
            :class="item.installed ? 'svc-card__status--ok' : 'svc-card__status--idle'"
          >
            <span class="status-dot" :class="item.installed ? 'status-dot--ok' : 'status-dot--idle'" />
            {{ item.installed ? 'Установлен' : 'Не установлен' }}
          </span>
        </div>

        <p class="svc-card__desc">{{ item.catalog.description }}</p>

        <div class="svc-card__meta">
          <div class="svc-card__meta-row">
            <span class="svc-card__meta-label">Версия</span>
            <span class="svc-card__meta-value mono">{{ item.version || '—' }}</span>
          </div>
          <div class="svc-card__meta-row">
            <span class="svc-card__meta-label">{{ item.catalog.scope === 'global' ? 'Используется на сайтах' : 'Активен на сайтах' }}</span>
            <span class="svc-card__meta-value">{{ item.sitesUsing }}</span>
          </div>
          <div v-if="item.catalog.scope === 'global'" class="svc-card__meta-row">
            <span class="svc-card__meta-label">Тип</span>
            <span class="svc-card__meta-value">Глобальный (один на сервер)</span>
          </div>
          <div v-if="item.installedAt" class="svc-card__meta-row">
            <span class="svc-card__meta-label">Установлен</span>
            <span class="svc-card__meta-value">{{ formatDate(item.installedAt) }}</span>
          </div>
          <div v-if="item.lastError" class="svc-card__error">
            {{ item.lastError }}
          </div>
        </div>

        <div class="svc-card__actions">
          <button
            v-if="!item.installed"
            class="btn btn--primary btn--sm"
            :disabled="busy[item.key] === 'install'"
            @click="installService(item)"
          >
            {{ busy[item.key] === 'install' ? 'Установка…' : 'Установить' }}
          </button>
          <template v-else>
            <button
              class="btn btn--ghost btn--sm"
              :disabled="busy[item.key] === 'refresh'"
              @click="refreshService(item)"
            >Проверить</button>
            <button
              class="btn btn--danger btn--sm"
              :disabled="item.sitesUsing > 0 || busy[item.key] === 'uninstall'"
              :title="item.sitesUsing > 0
                ? (item.catalog.scope === 'global'
                  ? 'Сначала удали все БД этого движка на странице /databases'
                  : 'Сначала отключи сервис у всех сайтов')
                : ''"
              @click="uninstallService(item)"
            >
              {{ busy[item.key] === 'uninstall' ? 'Удаление…' : 'Удалить' }}
            </button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface ServerSvc {
  key: string;
  catalog: {
    key: string;
    name: string;
    description: string;
    category: string;
    icon: string;
    /** 'per-site' — Redis/Manticore (per-site инстанс), 'global' — MariaDB/PostgreSQL */
    scope?: 'per-site' | 'global';
  };
  installed: boolean;
  version: string | null;
  installedAt: string | null;
  lastError: string | null;
  sitesUsing: number;
}

const api = useApi();
const toast = useMbToast();

const items = ref<ServerSvc[]>([]);
const loading = ref(true);
const busy = reactive<Record<string, string>>({});

// Если CatMascot не зарегистрирован глобально — не валиться. У nuxt компоненты
// auto-import, эта переменная — просто страховка для шаблона.
const hasCatMascot = true;

async function loadAll() {
  loading.value = true;
  try {
    items.value = await api.get<ServerSvc[]>('/services');
  } catch (err) {
    toast.error((err as Error).message || 'Не удалось загрузить сервисы');
    items.value = [];
  } finally {
    loading.value = false;
  }
}

async function refreshService(item: ServerSvc) {
  busy[item.key] = 'refresh';
  try {
    const updated = await api.get<ServerSvc>(`/services/${item.key}`);
    Object.assign(item, updated);
    toast.success('Статус обновлён');
  } catch (err) {
    toast.error((err as Error).message || 'Не удалось обновить статус');
  } finally {
    delete busy[item.key];
  }
}

async function installService(item: ServerSvc) {
  if (!confirm(`Установить «${item.catalog.name}» на сервер? Это поставит apt-пакет и подготовит template-unit.`)) return;
  busy[item.key] = 'install';
  try {
    const updated = await api.post<ServerSvc>(`/services/${item.key}/install`);
    Object.assign(item, updated);
    toast.success(`${item.catalog.name} установлен (${item.version || ''})`);
  } catch (err) {
    toast.error((err as Error).message || 'Установка провалилась');
  } finally {
    delete busy[item.key];
  }
}

async function uninstallService(item: ServerSvc) {
  if (!confirm(`Удалить «${item.catalog.name}» с сервера?\n\nДанные сайтов в /var/lib/${item.key}/* НЕ удаляются автоматически — отключи сервис у каждого сайта заранее.`)) return;
  busy[item.key] = 'uninstall';
  try {
    await api.del(`/services/${item.key}`);
    item.installed = false;
    item.version = null;
    item.installedAt = null;
    toast.success(`${item.catalog.name} удалён с сервера`);
  } catch (err) {
    toast.error((err as Error).message || 'Удаление провалилось');
  } finally {
    delete busy[item.key];
  }
}

function categoryLabel(c: string): string {
  switch (c) {
    case 'search': return 'Поиск';
    case 'cache': return 'Кэш';
    case 'queue': return 'Очереди';
    case 'database': return 'База данных';
    default: return 'Сервис';
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

onMounted(loadAll);
</script>

<style scoped>
.services {
  padding: 1.25rem 1.5rem 2rem;
  max-width: 1400px;
}

.services__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.services__title {
  font-size: 1.45rem;
  font-weight: 600;
  margin: 0 0 0.25rem 0;
  color: var(--text-primary);
}

.services__subtitle {
  font-size: 0.85rem;
  color: var(--text-tertiary);
  margin: 0;
}

.services__loading,
.services__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 4rem 2rem;
  color: var(--text-tertiary);
}

.services__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 1rem;
}

.svc-card {
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 14px;
  padding: 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.svc-card:hover {
  border-color: var(--border-strong, rgba(255, 255, 255, 0.12));
}

.svc-card__head {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.75rem;
}

.svc-card__icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(99, 102, 241, 0.12);
  color: rgb(129, 140, 248);
}

.svc-card__icon--search {
  background: rgba(245, 158, 11, 0.13);
  color: rgb(251, 191, 36);
}
.svc-card__icon--cache {
  background: rgba(16, 185, 129, 0.13);
  color: rgb(52, 211, 153);
}
.svc-card__icon--queue {
  background: rgba(168, 85, 247, 0.13);
  color: rgb(192, 132, 252);
}
.svc-card__icon--database {
  background: rgba(59, 130, 246, 0.13);
  color: rgb(96, 165, 250);
}

.svc-card__title-block {
  min-width: 0;
}

.svc-card__title {
  font-size: 0.97rem;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.svc-card__category {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-tertiary);
  margin-top: 2px;
}

.svc-card__status {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.72rem;
  font-weight: 500;
  padding: 0.25rem 0.55rem;
  border-radius: 999px;
  white-space: nowrap;
}

.svc-card__status--ok {
  background: rgba(16, 185, 129, 0.13);
  color: rgb(52, 211, 153);
}

.svc-card__status--idle {
  background: rgba(115, 115, 115, 0.18);
  color: var(--text-tertiary);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.status-dot--ok { background: rgb(52, 211, 153); box-shadow: 0 0 6px rgba(52, 211, 153, 0.6); }
.status-dot--idle { background: rgb(115, 115, 115); }
.status-dot--err { background: rgb(239, 68, 68); box-shadow: 0 0 6px rgba(239, 68, 68, 0.5); }

.svc-card__desc {
  font-size: 0.82rem;
  color: var(--text-secondary);
  line-height: 1.5;
  margin: 0;
}

.svc-card__meta {
  border-top: 1px solid var(--border-subtle);
  padding-top: 0.7rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.svc-card__meta-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 0.8rem;
}

.svc-card__meta-label {
  color: var(--text-tertiary);
}

.svc-card__meta-value {
  color: var(--text-primary);
  font-weight: 500;
}

.svc-card__error {
  font-size: 0.78rem;
  color: rgb(248, 113, 113);
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.25);
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
  word-break: break-word;
}

.svc-card__actions {
  display: flex;
  gap: 0.5rem;
  margin-top: auto;
}

.svc-card__actions .btn {
  flex: 1;
}

.btn {
  display: inline-flex; align-items: center; justify-content: center;
  gap: 0.4rem; padding: 0.55rem 1rem;
  border-radius: 10px; border: none; font-size: 0.82rem; font-weight: 600;
  font-family: inherit; cursor: pointer; transition: all 0.2s; white-space: nowrap;
}
.btn--sm { padding: 0.45rem 0.85rem; font-size: 0.75rem; border-radius: 8px; }
.btn--icon { padding: 0.45rem; width: 32px; height: 32px; flex: 0 0 auto; }
.btn--primary { background: linear-gradient(135deg, #fbbf24, #d97706); color: var(--primary-text-on); }
.btn--primary:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(245, 158, 11, 0.2); }
.btn--primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--ghost { background: var(--bg-input); border: 1px solid var(--border-strong); color: var(--text-tertiary); }
.btn--ghost:hover:not(:disabled) { color: var(--text-secondary); border-color: var(--border-strong); }
.btn--ghost:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--danger { background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); color: rgb(248, 113, 113); }
.btn--danger:hover:not(:disabled) { background: rgba(239, 68, 68, 0.25); }
.btn--danger:disabled { opacity: 0.4; cursor: not-allowed; }

.spinner { width: 24px; height: 24px; border: 2px solid var(--spinner-track); border-top-color: var(--primary); border-radius: 50%; animation: spin 0.8s linear infinite; }

@keyframes spin { to { transform: rotate(360deg); } }

.mono {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.78rem;
}
</style>
