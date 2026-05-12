<template>
  <div class="backups">
    <div class="backups__header">
      <div>
        <h1 class="backups__title">Проверки Restic</h1>
        <p class="backups__subtitle">Целостность репозиториев — последние запуски <code>restic check</code></p>
      </div>
      <div class="header-actions">
        <NuxtLink to="/backups" class="backups__refresh" style="text-decoration:none;">← К бэкапам</NuxtLink>
        <button class="backups__refresh" :disabled="loading" @click="load">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" :class="{ spinning: loading }"><polyline points="23,4 23,10 17,10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
          Обновить
        </button>
      </div>
    </div>

    <div class="settings-card">
      <p class="section-hint">
        История запусков <code>restic check</code> — проверка целостности репозиториев.
        Показаны последние 100 записей по всем репам (сайт × хранилище).
        Запустить проверку вручную можно на странице сайта во вкладке «Бэкапы».
      </p>

      <div v-if="loading" class="empty-card empty-card--flush">Загрузка…</div>
      <div v-else-if="!checks.length" class="empty-card empty-card--flush">
        <p>Проверок ещё не было. Включи плановую проверку (в Расписании) или запусти вручную из карточки сайта.</p>
      </div>

      <table v-else class="storage-table">
        <thead>
          <tr>
            <th>Сайт</th>
            <th>Хранилище</th>
            <th>Результат</th>
            <th>Когда</th>
            <th>Длительность</th>
            <th>Источник</th>
            <th>Ошибка</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in checks" :key="c.id">
            <td>{{ c.siteName }}</td>
            <td><span class="cfg-badge">{{ c.storageLocation?.name || '—' }}</span></td>
            <td>
              <span v-if="c.completedAt && c.success" class="cfg-badge cfg-badge--ok">OK</span>
              <span v-else-if="c.completedAt && !c.success" class="cfg-badge cfg-badge--err">FAIL</span>
              <span v-else class="cfg-badge cfg-badge--muted">идёт…</span>
            </td>
            <td>{{ formatDate(c.startedAt) }}</td>
            <td>{{ c.durationMs ? Math.round(c.durationMs / 1000) + ' с' : '—' }}</td>
            <td><span class="cfg-badge" :class="c.source === 'manual' ? '' : 'cfg-badge--muted'">{{ c.source === 'manual' ? 'ручн.' : 'плановая' }}</span></td>
            <td class="check-err-cell">{{ c.errorMessage || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface ResticCheckItem {
  id: string;
  storageLocationId: string;
  siteId?: string | null;
  siteName: string;
  success: boolean;
  errorMessage?: string | null;
  durationMs?: number | null;
  source: 'manual' | 'scheduled';
  startedAt: string;
  completedAt?: string | null;
  storageLocation?: { name: string; type: string } | null;
}

const api = useApi();
const toast = useMbToast();

const checks = ref<ResticCheckItem[]>([]);
const loading = ref(false);

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

async function load() {
  loading.value = true;
  try {
    const res = await api.get<ResticCheckItem[] | { data: ResticCheckItem[] }>('/restic-checks/latest');
    const list = Array.isArray(res) ? res : (res as { data?: ResticCheckItem[] }).data;
    checks.value = Array.isArray(list) ? list : [];
  } catch (err: unknown) {
    toast.error((err as Error).message || 'Не удалось загрузить проверки');
    checks.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.backups { padding: 1.5rem; max-width: 1400px; margin: 0 auto; }
.backups__header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 1.5rem; gap: 1rem; flex-wrap: wrap; }
.backups__title { font-size: 1.5rem; font-weight: 700; color: var(--text-heading); margin: 0; }
.backups__subtitle { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.15rem; }
.header-actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }

.backups__refresh {
  display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.45rem 0.85rem;
  border-radius: 10px; border: 1px solid var(--border-secondary);
  background: var(--bg-surface); color: var(--text-tertiary);
  font-size: 0.78rem; font-weight: 500; font-family: inherit; cursor: pointer; transition: all 0.2s;
}
.backups__refresh:hover { border-color: var(--primary-border); color: var(--primary-text); background: var(--primary-bg); }
.backups__refresh:disabled { opacity: 0.5; cursor: not-allowed; }
.spinning { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.settings-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  padding: 1.25rem;
}
.section-hint { font-size: 0.8rem; color: var(--text-muted); margin: 0 0 1rem; line-height: 1.5; }
.section-hint code { background: var(--bg-body); padding: 0 0.3rem; border-radius: 4px; font-family: monospace; }
.empty-card { display: flex; flex-direction: column; align-items: center; padding: 2rem 1rem; color: var(--text-muted); font-size: 0.85rem; }
.empty-card--flush { border: none; background: transparent; }

.storage-table {
  width: 100%; border-collapse: separate; border-spacing: 0; margin-top: 0.5rem;
  background: var(--bg-input); border-radius: 12px; overflow: hidden; border: 1px solid var(--border);
}
.storage-table th, .storage-table td {
  padding: 0.7rem 0.9rem; text-align: left; border-bottom: 1px solid var(--border);
  font-size: 0.88rem; color: var(--text-primary);
}
.storage-table tbody tr:last-child td { border-bottom: none; }
.storage-table tbody tr:hover { background: var(--bg-surface); }
.storage-table th {
  font-weight: 600; color: var(--text-tertiary);
  text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.06em;
  background: var(--bg-surface);
}

.cfg-badge {
  display: inline-block; padding: 0.08rem 0.5rem;
  border-radius: 999px; background: var(--primary-bg, rgba(var(--primary-rgb), 0.12));
  color: var(--primary-text, var(--primary)); font-size: 0.72rem; font-weight: 500;
}
.cfg-badge--muted { background: var(--bg-input); color: var(--text-tertiary); }
.cfg-badge--ok { background: var(--success-bg, rgba(34,197,94,0.12)); color: var(--success, #22c55e); }
.cfg-badge--err { background: rgba(239,68,68,0.12); color: #f87171; }

.check-err-cell {
  max-width: 360px; font-size: 0.75rem; color: #f87171;
  white-space: pre-wrap; word-break: break-word;
}
</style>
