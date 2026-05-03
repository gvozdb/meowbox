<template>
  <div class="site-services">
    <div v-if="loading" class="site-services__loading">
      <div class="spinner" /> Загрузка сервисов…
    </div>

    <template v-else>
      <div v-if="!items.length" class="site-services__empty">
        <p>Сервисы пока не зарегистрированы в панели.</p>
      </div>

      <div v-else class="site-services__list">
        <div
          v-for="item in items"
          :key="item.key"
          class="ssvc"
          :class="{ 'ssvc--active': item.active }"
        >
          <div class="ssvc__head">
            <div class="ssvc__icon" :class="`ssvc__icon--${item.catalog.category}`">
              <svg v-if="item.catalog.icon === 'search'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <svg v-else-if="item.catalog.icon === 'cache'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="12 2 2 7 12 12 22 7 12 2" />
                <polyline points="2 17 12 22 22 17" />
                <polyline points="2 12 12 17 22 12" />
              </svg>
              <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" /></svg>
            </div>
            <div class="ssvc__title-block">
              <div class="ssvc__title">{{ item.catalog.name }}</div>
              <div class="ssvc__desc">{{ item.catalog.description }}</div>
            </div>
            <div class="ssvc__status-block">
              <span v-if="item.active" class="ssvc__pill" :class="pillClass(item.status)">
                <span class="status-dot" :class="dotClass(item.status)" />
                {{ statusLabel(item.status) }}
              </span>
              <span v-else class="ssvc__pill ssvc__pill--idle">
                <span class="status-dot status-dot--idle" />
                {{ item.serverInstalled ? 'Не активирован' : 'Не установлен на сервере' }}
              </span>
            </div>
          </div>

          <!-- Активный сервис: метрики + connection + actions -->
          <div v-if="item.active && detail[item.key]" class="ssvc__body">
            <div v-if="detail[item.key].metrics.items.length" class="ssvc__metrics">
              <div
                v-for="m in detail[item.key].metrics.items"
                :key="m.label"
                class="ssvc__metric"
              >
                <div class="ssvc__metric-label">{{ m.label }}</div>
                <div class="ssvc__metric-value">{{ m.value }}</div>
              </div>
            </div>

            <div class="ssvc__connection">
              <div class="ssvc__connection-head">Connection info</div>
              <div
                v-for="c in detail[item.key].connection.items"
                :key="c.label"
                class="ssvc__conn-row"
              >
                <span class="ssvc__conn-label">{{ c.label }}</span>
                <code class="ssvc__conn-value mono">{{ c.value }}</code>
                <button
                  v-if="c.copyable !== false"
                  class="ssvc__copy"
                  title="Скопировать"
                  @click="copy(c.value)"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                </button>
              </div>
              <p v-if="detail[item.key].connection.hint" class="ssvc__hint">
                {{ detail[item.key].connection.hint }}
              </p>
            </div>

            <!-- Memory limit (per-service) -->
            <div v-if="hasMemoryControl(item.key)" class="ssvc__config">
              <label>
                Лимит памяти, MB:
                <input
                  v-model.number="memInputs[item.key]"
                  type="number"
                  :min="memBounds(item.key).min"
                  :max="memBounds(item.key).max"
                  :step="memBounds(item.key).step"
                  class="ssvc__mem-input"
                />
              </label>
              <button
                class="btn btn--ghost btn--sm"
                :disabled="busy[item.key] === 'reconfigure'"
                @click="reconfigure(item)"
              >
                {{ busy[item.key] === 'reconfigure' ? 'Применяю…' : 'Применить' }}
              </button>
            </div>

            <div v-if="item.lastError" class="ssvc__error">{{ item.lastError }}</div>

            <div class="ssvc__actions">
              <button
                v-if="item.key === 'manticore'"
                class="btn btn--blue btn--sm"
                :disabled="item.status !== 'RUNNING' || busy[item.key] === 'adminer'"
                :title="item.status === 'RUNNING' ? 'Открыть Manticore в Adminer' : 'Сервис не запущен'"
                @click="openManticoreAdminer(item)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>
                <span>{{ busy[item.key] === 'adminer' ? 'Открываю…' : 'Adminer' }}</span>
              </button>
              <button class="btn btn--ghost btn--sm" :disabled="busy[item.key] === 'logs'" @click="openLogs(item)">Логи</button>
              <button
                v-if="item.status === 'RUNNING'"
                class="btn btn--ghost btn--sm"
                :disabled="busy[item.key] === 'stop'"
                @click="stopService(item)"
              >
                {{ busy[item.key] === 'stop' ? 'Останавливаю…' : 'Выкл' }}
              </button>
              <button
                v-else
                class="btn btn--ghost btn--sm"
                :disabled="busy[item.key] === 'start'"
                @click="startService(item)"
              >
                {{ busy[item.key] === 'start' ? 'Стартую…' : 'Вкл' }}
              </button>
              <button class="btn btn--ghost btn--sm" :disabled="busy[item.key] === 'refresh'" @click="refreshOne(item)">Обновить</button>
              <button class="btn btn--danger btn--sm" :disabled="busy[item.key] === 'disable'" @click="disableService(item)">
                {{ busy[item.key] === 'disable' ? 'Отключаю…' : 'Удалить' }}
              </button>
            </div>
          </div>

          <!-- Неактивный сервис: кнопка активации -->
          <div v-else-if="!item.active" class="ssvc__body ssvc__body--idle">
            <p v-if="!item.serverInstalled" class="ssvc__warn">
              Сервис не установлен на сервере. Установи его в разделе
              <NuxtLink to="/services" class="ssvc__link">Сервисы</NuxtLink>.
            </p>
            <p v-else class="ssvc__hint">
              Активация поднимет per-site инстанс под изолированным юзером сайта.
              Конфиг таблиц/индексов задаёт код сайта — панель только обеспечивает доступ.
            </p>

            <!-- Лимит памяти при активации (per-service) -->
            <div v-if="item.serverInstalled && hasMemoryControl(item.key)" class="ssvc__config">
              <label>
                Лимит памяти, MB:
                <input
                  v-model.number="memInputs[item.key]"
                  type="number"
                  :min="memBounds(item.key).min"
                  :max="memBounds(item.key).max"
                  :step="memBounds(item.key).step"
                  class="ssvc__mem-input"
                />
              </label>
            </div>

            <div class="ssvc__actions">
              <button
                class="btn btn--primary btn--sm"
                :disabled="!item.serverInstalled || busy[item.key] === 'enable'"
                @click="enableService(item)"
              >
                {{ busy[item.key] === 'enable' ? 'Активирую…' : 'Активировать' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Logs modal -->
    <Teleport to="body">
      <div v-if="logsModal.open" class="ssvc-modal" @mousedown.self="closeLogs">
        <div class="ssvc-modal__panel" @mousedown.stop>
          <div class="ssvc-modal__head">
            <strong>Логи · {{ logsModal.title }}</strong>
            <div class="ssvc-modal__head-actions">
              <button class="btn btn--primary btn--sm" :disabled="logsModal.loading" @click="reloadLogs">
                {{ logsModal.loading ? 'Загрузка…' : 'Обновить' }}
              </button>
              <button class="btn btn--ghost btn--sm" @click="closeLogs">Закрыть</button>
            </div>
          </div>
          <pre v-if="!logsModal.loading" class="ssvc-modal__body mono">{{ logsModal.content }}</pre>
          <div v-else class="ssvc-modal__loading"><div class="spinner" /></div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ siteId: string; active: boolean }>();

interface CatalogEntry {
  key: string;
  name: string;
  description: string;
  category: string;
  icon: string;
}
interface SvcItem {
  key: string;
  catalog: CatalogEntry;
  active: boolean;
  status: 'STARTING' | 'RUNNING' | 'STOPPED' | 'ERROR';
  lastError: string | null;
  installedAt: string | null;
  config: Record<string, unknown>;
  serverInstalled: boolean;
}
interface SvcDetail {
  metrics: { items: Array<{ label: string; value: string }> };
  connection: {
    items: Array<{ label: string; value: string; copyable?: boolean }>;
    hint?: string;
  };
}

const api = useApi();
const toast = useMbToast();

const items = ref<SvcItem[]>([]);
const detail = reactive<Record<string, SvcDetail>>({});
const loading = ref(true);
const busy = reactive<Record<string, string>>({});
const memInputs = reactive<Record<string, number>>({});
const logsModal = reactive({ open: false, loading: false, content: '', key: '', title: '' });

watch(
  () => props.active,
  (v) => {
    if (v && !items.value.length) loadAll();
  },
  { immediate: true },
);

// Дефолты и границы памяти для каждого сервиса (генерик-конфиг — не хардкод
// в шаблоне). Если у сервиса нет memoryMaxMb — мы просто не показываем инпут.
const MEM_DEFAULTS: Record<string, { def: number; min: number; max: number; step: number }> = {
  manticore: { def: 128, min: 32, max: 4096, step: 32 },
  redis: { def: 64, min: 16, max: 4096, step: 16 },
};

function hasMemoryControl(key: string): boolean {
  return key in MEM_DEFAULTS;
}

function memBounds(key: string): { min: number; max: number; step: number } {
  const m = MEM_DEFAULTS[key];
  return m ? { min: m.min, max: m.max, step: m.step } : { min: 16, max: 4096, step: 16 };
}

async function loadAll() {
  loading.value = true;
  try {
    const list = await api.get<SvcItem[]>(`/sites/${props.siteId}/services`);
    items.value = list;
    for (const it of list) {
      const def = MEM_DEFAULTS[it.key]?.def ?? 128;
      const cfgMem = (it.config?.memoryMaxMb as number) ?? def;
      memInputs[it.key] = typeof cfgMem === 'number' ? cfgMem : def;
    }
    await Promise.all(list.filter((s) => s.active).map((s) => fetchDetail(s.key)));
  } catch (err) {
    toast.error((err as Error).message || 'Не удалось загрузить сервисы сайта');
    items.value = [];
  } finally {
    loading.value = false;
  }
}

async function fetchDetail(key: string) {
  try {
    const d = await api.get<SvcItem & { metrics: any; connection: any }>(`/sites/${props.siteId}/services/${key}`);
    detail[key] = { metrics: d.metrics, connection: d.connection };
    // Синхронизируем status в items
    const it = items.value.find((x) => x.key === key);
    if (it) {
      it.status = d.status;
      it.lastError = d.lastError;
    }
  } catch {
    /* ignore — сервис может быть в процессе старта */
  }
}

async function refreshOne(item: SvcItem) {
  busy[item.key] = 'refresh';
  try {
    await fetchDetail(item.key);
    toast.success('Статус обновлён');
  } finally {
    delete busy[item.key];
  }
}

async function enableService(item: SvcItem) {
  if (!confirm(`Активировать «${item.catalog.name}» для этого сайта?`)) return;
  busy[item.key] = 'enable';
  try {
    const config: Record<string, unknown> = {};
    if (hasMemoryControl(item.key)) {
      config.memoryMaxMb = memInputs[item.key] || MEM_DEFAULTS[item.key].def;
    }
    await api.post(`/sites/${props.siteId}/services/${item.key}/enable`, { config });
    toast.success(`${item.catalog.name} активирован`);
    await loadAll();
  } catch (err) {
    toast.error((err as Error).message || 'Активация провалилась');
  } finally {
    delete busy[item.key];
  }
}

async function disableService(item: SvcItem) {
  if (!confirm(`Отключить «${item.catalog.name}»? Будут удалены данные сервиса для этого сайта (data_dir, env-файлы).`)) return;
  busy[item.key] = 'disable';
  try {
    await api.del(`/sites/${props.siteId}/services/${item.key}`);
    toast.success(`${item.catalog.name} отключён`);
    delete detail[item.key];
    await loadAll();
  } catch (err) {
    toast.error((err as Error).message || 'Отключение провалилось');
  } finally {
    delete busy[item.key];
  }
}

async function startService(item: SvcItem) {
  busy[item.key] = 'start';
  try {
    await api.post(`/sites/${props.siteId}/services/${item.key}/start`);
    item.status = 'RUNNING';
    await fetchDetail(item.key);
    toast.success(`${item.catalog.name} запущен`);
  } catch (err) {
    toast.error((err as Error).message || 'Запуск провалился');
  } finally {
    delete busy[item.key];
  }
}

async function stopService(item: SvcItem) {
  if (!confirm(`Остановить «${item.catalog.name}»? Данные сохранятся, демон просто перестанет принимать запросы.`)) return;
  busy[item.key] = 'stop';
  try {
    await api.post(`/sites/${props.siteId}/services/${item.key}/stop`);
    item.status = 'STOPPED';
    await fetchDetail(item.key);
    toast.success(`${item.catalog.name} остановлен`);
  } catch (err) {
    toast.error((err as Error).message || 'Остановка провалилась');
  } finally {
    delete busy[item.key];
  }
}

async function reconfigure(item: SvcItem) {
  busy[item.key] = 'reconfigure';
  try {
    const config: Record<string, unknown> = {};
    if (hasMemoryControl(item.key)) {
      config.memoryMaxMb = memInputs[item.key] || MEM_DEFAULTS[item.key].def;
    }
    await api.patch(`/sites/${props.siteId}/services/${item.key}`, { config });
    toast.success('Настройки применены, демон перезапущен');
    await fetchDetail(item.key);
  } catch (err) {
    toast.error((err as Error).message || 'Не удалось применить настройки');
  } finally {
    delete busy[item.key];
  }
}

async function openManticoreAdminer(item: SvcItem) {
  if (busy[item.key]) return;
  busy[item.key] = 'adminer';
  // Открываем blank-таб синхронно, чтобы popup-blocker не зарезал — потом
  // подменим location, когда придёт ответ от API.
  const win = window.open('about:blank', '_blank');
  try {
    const data = await api.post<{ url: string }>(
      `/sites/${props.siteId}/services/manticore/adminer-ticket`,
      {},
    );
    if (!data?.url) throw new Error('SSO endpoint вернул пустой URL');
    if (win) win.location.href = data.url;
    else window.location.href = data.url;
  } catch (err) {
    if (win) win.close();
    toast.error((err as Error).message || 'Не удалось открыть Adminer');
  } finally {
    delete busy[item.key];
  }
}

async function openLogs(item: SvcItem) {
  logsModal.key = item.key;
  logsModal.title = item.catalog.name;
  logsModal.open = true;
  await reloadLogs();
}

async function reloadLogs() {
  if (!logsModal.key) return;
  logsModal.loading = true;
  try {
    const r = await api.get<{ content: string }>(`/sites/${props.siteId}/services/${logsModal.key}/logs?lines=300`);
    logsModal.content = r.content || '(пусто)';
  } catch (err) {
    logsModal.content = `Ошибка: ${(err as Error).message}`;
  } finally {
    logsModal.loading = false;
  }
}

function closeLogs() {
  logsModal.open = false;
  logsModal.content = '';
  logsModal.key = '';
}

function copy(value: string) {
  if (!value) return;
  if (navigator?.clipboard?.writeText) {
    navigator.clipboard.writeText(value).then(
      () => toast.success('Скопировано'),
      () => toast.error('Не удалось скопировать'),
    );
  }
}

function statusLabel(s: string): string {
  switch (s) {
    case 'RUNNING': return 'Работает';
    case 'STOPPED': return 'Остановлен';
    case 'STARTING': return 'Запуск…';
    case 'ERROR': return 'Ошибка';
    default: return s;
  }
}

function pillClass(s: string): string {
  switch (s) {
    case 'RUNNING': return 'ssvc__pill--ok';
    case 'STARTING': return 'ssvc__pill--warn';
    case 'ERROR': return 'ssvc__pill--err';
    default: return 'ssvc__pill--idle';
  }
}

function dotClass(s: string): string {
  switch (s) {
    case 'RUNNING': return 'status-dot--ok';
    case 'ERROR': return 'status-dot--err';
    case 'STARTING': return 'status-dot--warn';
    default: return 'status-dot--idle';
  }
}
</script>

<style scoped>
.site-services {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.site-services__loading,
.site-services__empty {
  padding: 2rem;
  text-align: center;
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.65rem;
}

.site-services__list {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.ssvc {
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  overflow: hidden;
  transition: border-color 0.2s;
}

.ssvc--active { border-color: rgba(16, 185, 129, 0.35); }

.ssvc__head {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 0.85rem;
  padding: 0.95rem 1.05rem;
  align-items: center;
}

.ssvc__icon {
  width: 36px;
  height: 36px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(99, 102, 241, 0.12);
  color: rgb(129, 140, 248);
}
.ssvc__icon--search { background: rgba(var(--primary-rgb), 0.13); color: var(--primary-light); }
.ssvc__icon--cache { background: rgba(16, 185, 129, 0.13); color: rgb(52, 211, 153); }
.ssvc__icon--queue { background: rgba(168, 85, 247, 0.13); color: rgb(192, 132, 252); }
.ssvc__icon--database { background: rgba(59, 130, 246, 0.13); color: rgb(96, 165, 250); }

.ssvc__title { font-weight: 600; font-size: 0.95rem; color: var(--text-primary); }
.ssvc__desc { font-size: 0.78rem; color: var(--text-tertiary); margin-top: 2px; }

.ssvc__status-block { display: flex; align-items: center; }

.ssvc__pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.74rem;
  font-weight: 500;
  padding: 0.25rem 0.6rem;
  border-radius: 999px;
  white-space: nowrap;
}
.ssvc__pill--ok { background: rgba(16, 185, 129, 0.13); color: rgb(52, 211, 153); }
.ssvc__pill--warn { background: rgba(var(--primary-rgb), 0.13); color: var(--primary-light); }
.ssvc__pill--err { background: rgba(239, 68, 68, 0.13); color: rgb(248, 113, 113); }
.ssvc__pill--idle { background: rgba(115, 115, 115, 0.16); color: var(--text-tertiary); }

.status-dot {
  width: 7px; height: 7px; border-radius: 50%;
}
.status-dot--ok { background: rgb(52, 211, 153); box-shadow: 0 0 5px rgba(52, 211, 153, 0.6); }
.status-dot--warn { background: var(--primary-light); }
.status-dot--err { background: rgb(248, 113, 113); }
.status-dot--idle { background: rgb(115, 115, 115); }

.ssvc__body {
  border-top: 1px solid var(--border-subtle);
  padding: 0.95rem 1.05rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}
.ssvc__body--idle { gap: 0.7rem; }

.ssvc__metrics {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 0.55rem;
}
.ssvc__metric {
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 0.55rem 0.7rem;
}
.ssvc__metric-label { font-size: 0.7rem; color: var(--text-tertiary); }
.ssvc__metric-value { font-size: 0.95rem; font-weight: 600; color: var(--text-primary); margin-top: 2px; }

.ssvc__connection {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 0.7rem 0.85rem;
}
.ssvc__connection-head {
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-tertiary);
  margin-bottom: 0.4rem;
}
.ssvc__conn-row {
  display: grid;
  grid-template-columns: 200px 1fr auto;
  gap: 0.55rem;
  align-items: center;
  padding: 0.25rem 0;
  font-size: 0.78rem;
}
.ssvc__conn-label { color: var(--text-tertiary); }
.ssvc__conn-value {
  color: var(--text-primary);
  background: var(--bg-code);
  border: 1px solid var(--border-subtle);
  padding: 0.2rem 0.45rem;
  border-radius: 5px;
  word-break: break-all;
}
.ssvc__copy {
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 0.25rem 0.4rem;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.15s;
}
.ssvc__copy:hover { color: var(--text-primary); border-color: var(--border-strong, rgba(255,255,255,0.2)); }

.ssvc__hint { font-size: 0.78rem; color: var(--text-tertiary); margin: 0.5rem 0 0 0; }

.ssvc__warn {
  font-size: 0.82rem;
  color: var(--primary-light);
  background: rgba(var(--primary-rgb), 0.08);
  border: 1px solid rgba(var(--primary-rgb), 0.25);
  border-radius: 6px;
  padding: 0.5rem 0.7rem;
  margin: 0;
}

.ssvc__link {
  color: var(--primary-light);
  text-decoration: underline;
}

.ssvc__error {
  font-size: 0.78rem;
  color: rgb(248, 113, 113);
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.25);
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
}

.ssvc__config {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  font-size: 0.82rem;
  color: var(--text-secondary);
}
.ssvc__mem-input {
  width: 90px;
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  color: var(--text-primary);
  padding: 0.3rem 0.5rem;
  font-family: ui-monospace, monospace;
  margin-left: 0.4rem;
}
.ssvc__mem-input:focus {
  outline: none;
  border-color: var(--border-strong, rgba(0, 0, 0, 0.3));
}

.ssvc__actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.78rem;
}

/* Logs modal */
.ssvc-modal {
  position: fixed;
  inset: 0;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  padding: 1rem;
  animation: ssvcModalFadeIn 0.18s ease;
}
.ssvc-modal__panel {
  background: var(--bg-modal-gradient, var(--bg-modal));
  border: 1px solid var(--border-secondary, var(--border-subtle));
  border-radius: 14px;
  width: min(900px, 100%);
  height: min(80vh, 700px);
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-modal, 0 20px 50px rgba(0, 0, 0, 0.35));
  color: var(--text-primary);
  animation: ssvcModalPanelIn 0.22s ease;
}
.ssvc-modal__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.95rem 1.1rem;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-heading, var(--text-primary));
}
.ssvc-modal__head-actions { display: flex; gap: 0.5rem; }
.ssvc-modal__body {
  flex: 1;
  overflow: auto;
  padding: 1rem 1.1rem;
  margin: 0;
  font-size: 0.78rem;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-secondary);
  background: var(--bg-code);
}
.ssvc-modal__loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.spinner {
  width: 24px; height: 24px;
  border: 2px solid var(--spinner-track, var(--border-subtle));
  border-top-color: var(--primary, var(--primary-light));
  border-radius: 50%;
  animation: ssvcSpin 0.8s linear infinite;
}
@keyframes ssvcSpin { to { transform: rotate(360deg); } }
@keyframes ssvcModalFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes ssvcModalPanelIn {
  from { opacity: 0; transform: scale(0.97) translateY(8px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}

/* ─── Кнопки (унифицированы со стилями /services и других страниц) ─── */
.btn {
  display: inline-flex; align-items: center; justify-content: center;
  gap: 0.4rem; padding: 0.55rem 1rem;
  border-radius: 10px; border: none; font-size: 0.82rem; font-weight: 600;
  font-family: inherit; cursor: pointer; transition: all 0.2s; white-space: nowrap;
}
.btn--sm { padding: 0.45rem 0.85rem; font-size: 0.75rem; border-radius: 8px; }
.btn--primary { background: linear-gradient(135deg, var(--primary-light), var(--primary-dark)); color: var(--primary-text-on); }
.btn--primary:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(var(--primary-rgb), 0.2); }
.btn--primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--ghost { background: var(--bg-input); border: 1px solid var(--border-strong); color: var(--text-tertiary); }
.btn--ghost:hover:not(:disabled) { color: var(--text-secondary); border-color: var(--border-strong); }
.btn--ghost:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--danger { background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); color: rgb(248, 113, 113); }
.btn--danger:hover:not(:disabled) { background: rgba(239, 68, 68, 0.25); }
.btn--danger:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--blue { background: rgba(59, 130, 246, 0.12); border: 1px solid rgba(59, 130, 246, 0.35); color: rgb(96, 165, 250); }
.btn--blue:hover:not(:disabled) { background: rgba(59, 130, 246, 0.22); border-color: rgba(59, 130, 246, 0.5); color: rgb(147, 197, 253); }
.btn--blue:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
