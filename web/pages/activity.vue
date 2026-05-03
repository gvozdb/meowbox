<template>
  <div class="activity">
    <div class="activity__header">
      <div>
        <h1 class="activity__title">Активность</h1>
        <p class="activity__subtitle">Лента событий сервера</p>
      </div>
      <div class="activity__controls">
        <select v-model="actionFilter" class="activity__filter" @change="resetAndFetch">
          <option value="">Все действия</option>
          <option v-for="a in actions" :key="a.value" :value="a.value">{{ a.label }}</option>
        </select>
        <button class="activity__refresh" :disabled="loading" @click="resetAndFetch">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" :class="{ spinning: loading }">
            <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Timeline -->
    <div class="timeline">
      <div v-for="(group, gi) in groupedEntries" :key="gi" class="timeline__group">
        <div class="timeline__date">{{ group.label }}</div>
        <div class="timeline__items">
          <div v-for="entry in group.items" :key="entry.id" class="timeline__item">
            <div class="timeline__dot" :class="`timeline__dot--${entry.action.toLowerCase()}`" />
            <div class="timeline__content">
              <div class="timeline__top">
                <span class="timeline__badge" :class="`timeline__badge--${entry.action.toLowerCase()}`">
                  {{ actionLabel(entry.action) }}
                </span>
                <span class="timeline__entity">
                  {{ entry.entity }}{{ entry.entityId ? ` #${entry.entityId.slice(0, 8)}` : '' }}
                </span>
              </div>
              <div class="timeline__meta">
                <span class="timeline__user">{{ entry.username }}</span>
                <span class="timeline__sep">&middot;</span>
                <span class="timeline__time">{{ formatTime(entry.createdAt) }}</span>
                <span class="timeline__sep">&middot;</span>
                <span class="timeline__ip">{{ entry.ipAddress }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="!entries.length && !loading" class="timeline__empty">
        Нет событий
      </div>
    </div>

    <!-- Pagination -->
    <div v-if="totalPages > 1" class="activity__pagination">
      <button class="page-btn" :disabled="page <= 1" @click="goPage(page - 1)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6" /></svg>
      </button>
      <span class="page-info">{{ page }} / {{ totalPages }}</span>
      <button class="page-btn" :disabled="page >= totalPages" @click="goPage(page + 1)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6" /></svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface AuditRawEntry {
  id: string;
  action: string;
  entity: string;
  entityId?: string;
  ipAddress: string;
  createdAt: string;
  user?: { username: string };
}

interface AuditEntry {
  id: string;
  action: string;
  entity: string;
  entityId?: string;
  ipAddress: string;
  createdAt: string;
  username: string;
}

interface GroupedEntries {
  label: string;
  items: AuditEntry[];
}

const api = useApi();
const entries = ref<AuditEntry[]>([]);
const loading = ref(false);
const page = ref(1);
const totalPages = ref(1);
const actionFilter = ref('');
const perPage = 50;

const actions = [
  { value: 'LOGIN', label: 'Вход' },
  { value: 'LOGOUT', label: 'Выход' },
  { value: 'CREATE', label: 'Создание' },
  { value: 'UPDATE', label: 'Обновление' },
  { value: 'DELETE', label: 'Удаление' },
  { value: 'DEPLOY', label: 'Деплой' },
  { value: 'BACKUP', label: 'Бэкап' },
  { value: 'RESTORE', label: 'Восстановление' },
  { value: 'SSL_ISSUE', label: 'SSL выпуск' },
  { value: 'SERVICE_START', label: 'Запуск сервиса' },
  { value: 'SERVICE_STOP', label: 'Остановка сервиса' },
  { value: 'SERVICE_RESTART', label: 'Рестарт сервиса' },
];

const groupedEntries = computed<GroupedEntries[]>(() => {
  const groups: Map<string, AuditEntry[]> = new Map();
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  for (const entry of entries.value) {
    const date = new Date(entry.createdAt);
    let label: string;
    if (isSameDay(date, today)) {
      label = 'Сегодня';
    } else if (isSameDay(date, yesterday)) {
      label = 'Вчера';
    } else {
      label = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    }
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(entry);
  }

  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
});

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function actionLabel(action: string): string {
  const found = actions.find((a) => a.value === action);
  return found ? found.label : action;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function fetchData() {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page.value), perPage: String(perPage) });
    if (actionFilter.value) params.set('action', actionFilter.value);
    const res = await api.getWithMeta<AuditRawEntry[]>(`/audit-logs?${params}`);
    entries.value = res.data.map((e) => ({
      id: e.id,
      action: e.action,
      entity: e.entity,
      entityId: e.entityId,
      ipAddress: e.ipAddress,
      createdAt: e.createdAt,
      username: e.user?.username || '—',
    }));
    totalPages.value = res.meta?.totalPages || 1;
  } catch { /* ignore */ }
  loading.value = false;
}

function resetAndFetch() {
  page.value = 1;
  fetchData();
}

function goPage(p: number) {
  page.value = p;
  fetchData();
}

onMounted(() => {
  fetchData();
});
</script>

<style scoped>
.activity__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}

.activity__title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0;
}

.activity__subtitle {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-top: 0.15rem;
}

.activity__controls {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.activity__filter {
  padding: 0.45rem 0.75rem;
  border-radius: 10px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-family: inherit;
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpolyline points='6,9 12,15 18,9'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.5rem center;
  padding-right: 1.75rem;
}

.activity__filter:focus {
  outline: none;
  border-color: var(--primary);
}

.activity__refresh {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.2s;
}

.activity__refresh:hover {
  border-color: var(--primary-border);
  color: var(--primary-text);
  background: var(--primary-bg);
}

.activity__refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Timeline */
.timeline {
  position: relative;
}

.timeline__group {
  margin-bottom: 1.5rem;
}

.timeline__date {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 0.75rem;
  padding-left: 2rem;
}

.timeline__items {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.timeline__item {
  display: flex;
  align-items: flex-start;
  gap: 0.85rem;
  padding: 0.6rem 0.85rem;
  border-radius: 12px;
  transition: background 0.15s;
  position: relative;
}

.timeline__item:hover {
  background: var(--bg-surface);
}

/* Timeline line */
.timeline__item::before {
  content: '';
  position: absolute;
  left: 1.35rem;
  top: 2rem;
  bottom: -2px;
  width: 1px;
  background: var(--border);
}

.timeline__item:last-child::before {
  display: none;
}

.timeline__dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 0.3rem;
  position: relative;
  z-index: 1;
}

.timeline__dot--login { background: #4ade80; box-shadow: 0 0 6px rgba(74, 222, 128, 0.4); }
.timeline__dot--logout { background: #94a3b8; }
.timeline__dot--create { background: #818cf8; box-shadow: 0 0 6px rgba(129, 140, 248, 0.4); }
.timeline__dot--update { background: var(--primary-light); box-shadow: 0 0 6px rgba(var(--primary-light-rgb), 0.3); }
.timeline__dot--delete { background: #f87171; box-shadow: 0 0 6px rgba(248, 113, 113, 0.4); }
.timeline__dot--deploy { background: #00dc82; box-shadow: 0 0 6px rgba(0, 220, 130, 0.4); }
.timeline__dot--backup { background: #a78bfa; box-shadow: 0 0 6px rgba(167, 139, 250, 0.3); }
.timeline__dot--restore { background: #a78bfa; box-shadow: 0 0 6px rgba(167, 139, 250, 0.3); }
.timeline__dot--ssl_issue { background: #38bdf8; box-shadow: 0 0 6px rgba(56, 189, 248, 0.4); }
.timeline__dot--service_start { background: #4ade80; box-shadow: 0 0 6px rgba(74, 222, 128, 0.3); }
.timeline__dot--service_stop { background: #f87171; box-shadow: 0 0 6px rgba(248, 113, 113, 0.3); }
.timeline__dot--service_restart { background: var(--primary-light); box-shadow: 0 0 6px rgba(var(--primary-light-rgb), 0.3); }

.timeline__content {
  flex: 1;
  min-width: 0;
}

.timeline__top {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  flex-wrap: wrap;
}

.timeline__badge {
  font-size: 0.6rem;
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
  padding: 0.12rem 0.4rem;
  border-radius: 6px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  flex-shrink: 0;
}

.timeline__badge--login { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
.timeline__badge--logout { background: rgba(148, 163, 184, 0.1); color: #94a3b8; }
.timeline__badge--create { background: rgba(99, 102, 241, 0.1); color: #818cf8; }
.timeline__badge--update { background: rgba(var(--primary-rgb), 0.1); color: var(--primary-light); }
.timeline__badge--delete { background: rgba(239, 68, 68, 0.1); color: #f87171; }
.timeline__badge--deploy { background: rgba(0, 220, 130, 0.1); color: #00dc82; }
.timeline__badge--backup { background: rgba(139, 92, 246, 0.1); color: #a78bfa; }
.timeline__badge--restore { background: rgba(139, 92, 246, 0.1); color: #a78bfa; }
.timeline__badge--ssl_issue { background: rgba(56, 189, 248, 0.1); color: #38bdf8; }
.timeline__badge--service_start { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
.timeline__badge--service_stop { background: rgba(239, 68, 68, 0.1); color: #f87171; }
.timeline__badge--service_restart { background: rgba(var(--primary-rgb), 0.1); color: var(--primary-light); }

.timeline__entity {
  font-size: 0.8rem;
  color: var(--text-secondary);
  font-weight: 500;
}

.timeline__meta {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-top: 0.2rem;
  font-size: 0.68rem;
  color: var(--text-faint);
}

.timeline__user {
  font-weight: 500;
  color: var(--text-muted);
}

.timeline__ip {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.62rem;
}

.timeline__empty {
  text-align: center;
  padding: 3rem;
  color: var(--text-faint);
  font-size: 0.85rem;
}

/* Pagination */
.activity__pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  margin-top: 1.5rem;
}

.page-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.2s;
}

.page-btn:hover:not(:disabled) {
  border-color: var(--primary-border);
  color: var(--primary-text);
  background: var(--primary-bg);
}

.page-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.page-info {
  font-size: 0.75rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-muted);
  min-width: 50px;
  text-align: center;
}

@media (max-width: 768px) {
  .activity__controls {
    flex-wrap: wrap;
  }

  .timeline__date {
    padding-left: 1.5rem;
  }

  .timeline__ip {
    display: none;
  }

  .timeline__ip + .timeline__sep {
    display: none;
  }

  .activity__title {
    font-size: 1.25rem;
  }
}
</style>
