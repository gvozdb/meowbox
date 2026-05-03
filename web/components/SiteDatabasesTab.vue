<template>
  <div class="site-dbs">
    <!-- Header: счётчик + кнопка создания -->
    <div class="site-dbs__header">
      <div class="site-dbs__title-block">
        <h3 class="site-dbs__title">Базы данных сайта</h3>
        <p class="site-dbs__subtitle">
          На сайт можно подключить несколько БД любых движков. Удалить движок с сервера
          (на <NuxtLink to="/services" class="link">/services</NuxtLink>) можно только когда
          ни одной БД этого движка не осталось.
        </p>
      </div>
      <button
        class="btn btn--primary"
        :disabled="loading || availableEngines.length === 0"
        :title="availableEngines.length === 0 ? 'Установи MariaDB или PostgreSQL на /services' : ''"
        @click="openCreate"
      >
        + Создать БД
      </button>
    </div>

    <div v-if="loading" class="site-dbs__loading">
      <div class="spinner" /> Загрузка БД…
    </div>

    <div v-else-if="!databases.length" class="site-dbs__empty">
      <p class="site-dbs__empty-text">Нет ни одной БД для этого сайта.</p>
      <p v-if="availableEngines.length === 0" class="site-dbs__empty-hint">
        Сначала установи движок на странице <NuxtLink to="/services" class="link">/services</NuxtLink>.
      </p>
    </div>

    <div v-else class="site-dbs__list">
      <div v-for="db in databases" :key="db.id" class="db-card">
        <div class="db-card__head">
          <div class="db-card__icon" :class="`db-card__icon--${badgeClass(db.type)}`">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
            </svg>
          </div>
          <div class="db-card__info">
            <span class="db-card__name">{{ db.name }}</span>
            <span class="db-card__meta">
              <span class="db-card__badge">{{ dbTypeLabel(db.type) }}</span>
              · {{ formatBytes(db.sizeBytes) }}
              <template v-if="db.dbUser"> · юзер <code>{{ db.dbUser }}</code></template>
            </span>
          </div>
        </div>
        <div class="db-card__actions">
          <button class="btn btn--ghost btn--sm" :disabled="busy[db.id] === 'adminer'" @click="openAdminer(db)">
            {{ busy[db.id] === 'adminer' ? 'Открываю…' : 'Adminer' }}
          </button>
          <button class="btn btn--ghost btn--sm" :disabled="busy[db.id] === 'export'" @click="exportDb(db)">
            {{ busy[db.id] === 'export' ? 'Экспорт…' : 'Экспорт' }}
          </button>
          <label class="btn btn--ghost btn--sm" :class="{ 'btn--disabled': busy[db.id] === 'import' }">
            <span>{{ busy[db.id] === 'import' ? 'Импорт…' : 'Импорт' }}</span>
            <input type="file" accept=".sql,.gz" hidden @change="importFile($event, db)" />
          </label>
          <button class="btn btn--ghost btn--sm" @click="resetPassword(db)">
            Сбросить пароль
          </button>
          <button class="btn btn--danger btn--sm" @click="deleteTarget = db">
            Удалить
          </button>
        </div>
      </div>
    </div>

    <!-- Create modal -->
    <Teleport to="body">
      <div v-if="showCreate" class="modal-overlay" @mousedown.self="showCreate = false">
        <div class="modal">
          <h3 class="modal__title">Создать БД для сайта «{{ siteName }}»</h3>
          <div class="modal__fields">
            <div class="form-group">
              <label class="form-label">Имя БД</label>
              <input v-model="createForm.name" type="text" class="form-input" :placeholder="defaultDbName" />
              <span class="form-hint">Латиница, цифры, подчёркивания. Пусто — возьмём имя сайта.</span>
            </div>
            <div class="form-group">
              <label class="form-label">Тип</label>
              <div class="radio-group">
                <label v-for="opt in availableEngines" :key="opt.value" class="radio-option" :class="{ 'radio-option--active': createForm.type === opt.value }">
                  <input v-model="createForm.type" type="radio" :value="opt.value" class="radio-option__input" />
                  <span class="radio-option__label">{{ opt.label }}</span>
                </label>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">DB-юзер (опционально)</label>
              <input v-model="createForm.dbUser" type="text" class="form-input" placeholder="Сгенерируется автоматически" />
            </div>
          </div>
          <div v-if="createError" class="modal__error">{{ createError }}</div>
          <div class="modal__actions">
            <button class="btn btn--ghost" @click="showCreate = false">Отмена</button>
            <button
              class="btn btn--primary"
              :disabled="!createForm.type || creating"
              @click="createDatabase"
            >
              {{ creating ? 'Создаю…' : 'Создать' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Delete confirm modal -->
    <Teleport to="body">
      <div v-if="deleteTarget" class="modal-overlay" @mousedown.self="deleteTarget = null">
        <div class="modal">
          <h3 class="modal__title">Удалить БД</h3>
          <p class="modal__desc">
            Удаляем <strong>{{ deleteTarget.name }}</strong>. БД и связанный DB-юзер
            будут безвозвратно удалены с сервера.
          </p>
          <div class="modal__actions">
            <button class="btn btn--ghost" @click="deleteTarget = null">Отмена</button>
            <button class="btn btn--danger" :disabled="deleting" @click="doDelete">
              {{ deleting ? 'Удаляю…' : 'Удалить навсегда' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Password result modal -->
    <Teleport to="body">
      <div v-if="newPassword" class="modal-overlay" @mousedown.self="newPassword = ''">
        <div class="modal">
          <h3 class="modal__title">Новый пароль</h3>
          <p class="modal__desc">
            Пароль БД <strong>{{ passwordDbName }}</strong> сброшен. Скопируй сейчас —
            больше не покажем.
          </p>
          <div class="password-display">{{ newPassword }}</div>
          <div class="modal__actions">
            <button class="btn btn--primary" @click="copyPassword">Скопировать и закрыть</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { copyToClipboard } from '~/utils/clipboard';

const props = defineProps<{
  siteId: string;
  siteName: string;
  /** Активна ли вкладка — чтобы не грузить впустую при первом mount. */
  active: boolean;
}>();

const emit = defineEmits<{
  /** Уведомить родителя, что список БД изменился (для счётчиков на табах). */
  (e: 'changed'): void;
}>();

const api = useApi();
const toast = useMbToast();

interface DbItem {
  id: string;
  name: string;
  type: string;
  dbUser?: string;
  sizeBytes?: number;
  site?: { id: string; name: string };
  createdAt: string;
}

interface DbEngineOption { value: 'MARIADB' | 'POSTGRESQL'; label: string; engineKey: 'mariadb' | 'postgresql' }
const ALL_ENGINES: DbEngineOption[] = [
  { value: 'MARIADB', label: 'MySQL / MariaDB', engineKey: 'mariadb' },
  { value: 'POSTGRESQL', label: 'PostgreSQL', engineKey: 'postgresql' },
];

const databases = ref<DbItem[]>([]);
const installedEngines = ref<Set<string>>(new Set());
const loading = ref(true);
const busy = reactive<Record<string, 'adminer' | 'export' | 'import' | undefined>>({});

const showCreate = ref(false);
const creating = ref(false);
const createError = ref('');
const createForm = reactive({ name: '', type: 'MARIADB' as 'MARIADB' | 'POSTGRESQL', dbUser: '' });

const deleteTarget = ref<DbItem | null>(null);
const deleting = ref(false);
const newPassword = ref('');
const passwordDbName = ref('');

const availableEngines = computed<DbEngineOption[]>(() =>
  ALL_ENGINES.filter((opt) => installedEngines.value.has(opt.engineKey)),
);

const defaultDbName = computed(() => props.siteName.replace(/-/g, '_'));

function dbTypeLabel(type: string): string {
  if (type === 'MARIADB' || type === 'MYSQL') return 'MySQL / MariaDB';
  if (type === 'POSTGRESQL') return 'PostgreSQL';
  return type;
}
function badgeClass(type: string): string {
  if (type === 'MARIADB' || type === 'MYSQL') return 'mariadb';
  if (type === 'POSTGRESQL') return 'postgresql';
  return type.toLowerCase();
}
function formatBytes(bytes?: number) {
  if (!bytes) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0; let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function loadDatabases() {
  loading.value = true;
  try {
    databases.value = await api.get<DbItem[]>(`/databases?siteId=${encodeURIComponent(props.siteId)}`);
  } catch {
    toast.error('Не удалось загрузить базы данных');
  } finally {
    loading.value = false;
  }
}

async function loadEngines() {
  try {
    const list = await api.get<Array<{ key: string; installed: boolean }>>('/services');
    installedEngines.value = new Set(list.filter((s) => s.installed).map((s) => s.key));
    // Если выбранный в форме движок не установлен — переключаемся на первый доступный.
    if (!ALL_ENGINES.some((e) => e.value === createForm.type && installedEngines.value.has(e.engineKey))) {
      const first = ALL_ENGINES.find((e) => installedEngines.value.has(e.engineKey));
      if (first) createForm.type = first.value;
    }
  } catch {
    // Если /services недоступен — даём оба варианта; бэкенд сам отрежет.
    installedEngines.value = new Set(['mariadb', 'postgresql']);
  }
}

function openCreate() {
  createForm.name = '';
  createForm.dbUser = '';
  if (availableEngines.value[0]) {
    createForm.type = availableEngines.value[0].value;
  }
  createError.value = '';
  showCreate.value = true;
}

async function createDatabase() {
  creating.value = true;
  createError.value = '';
  try {
    const body: Record<string, string> = {
      name: createForm.name || defaultDbName.value,
      type: createForm.type,
      siteId: props.siteId,
    };
    if (createForm.dbUser) body.dbUser = createForm.dbUser;
    await api.post('/databases', body);
    showCreate.value = false;
    toast.success('База данных создана');
    await loadDatabases();
    emit('changed');
  } catch (err) {
    createError.value = (err as Error).message || 'Не удалось создать БД';
  } finally {
    creating.value = false;
  }
}

async function doDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.del(`/databases/${deleteTarget.value.id}`);
    toast.success('БД удалена');
    deleteTarget.value = null;
    await loadDatabases();
    emit('changed');
  } catch (err) {
    toast.error((err as Error).message || 'Не удалось удалить БД');
  } finally {
    deleting.value = false;
  }
}

async function openAdminer(db: DbItem) {
  busy[db.id] = 'adminer';
  // window.open в синхронном click-handler — иначе popup-blocker зарежет.
  const win = window.open('about:blank', '_blank');
  try {
    const data = await api.post<{ url: string }>(`/databases/${db.id}/adminer-ticket`);
    if (!data?.url) throw new Error('Пустой URL от SSO');
    if (win) win.location.href = data.url;
    else window.location.href = data.url;
  } catch (err) {
    if (win) win.close();
    toast.error((err as Error).message || 'Не удалось открыть Adminer');
  } finally {
    delete busy[db.id];
  }
}

async function exportDb(db: DbItem) {
  busy[db.id] = 'export';
  try {
    const data = await api.post<{ filePath: string }>(`/databases/${db.id}/export`);
    if (!data.filePath) {
      toast.error('Экспорт не вернул путь к файлу');
      return;
    }
    const filename = data.filePath.split('/').pop() || `${db.name}.sql`;
    await api.download(`/databases/${db.id}/download?filePath=${encodeURIComponent(data.filePath)}`, filename);
    toast.success('Дамп скачан');
  } catch (err) {
    toast.error((err as Error).message || 'Ошибка экспорта');
  } finally {
    delete busy[db.id];
  }
}

async function importFile(event: Event, db: DbItem) {
  const input = event.target as HTMLInputElement;
  if (!input.files?.length) return;
  const file = input.files[0];
  busy[db.id] = 'import';
  try {
    toast.success(`Импорт ${file.name}...`);
    await api.upload(`/databases/${db.id}/import-upload`, file);
    toast.success('Импорт завершён');
    await loadDatabases();
  } catch (err) {
    toast.error((err as Error).message || 'Ошибка импорта');
  } finally {
    delete busy[db.id];
    input.value = '';
  }
}

async function resetPassword(db: DbItem) {
  try {
    const data = await api.post<{ plainPassword: string }>(`/databases/${db.id}/reset-password`);
    newPassword.value = data.plainPassword;
    passwordDbName.value = db.name;
  } catch (err) {
    toast.error((err as Error).message || 'Ошибка сброса пароля');
  }
}

async function copyPassword() {
  const ok = await copyToClipboard(newPassword.value);
  newPassword.value = '';
  if (ok) toast.success('Пароль скопирован');
  else toast.error('Не удалось скопировать');
}

// Перезагружаем при первом открытии вкладки. Если уже грузили — не дёргаем.
let loaded = false;
watch(() => props.active, (active) => {
  if (active && !loaded) {
    loaded = true;
    loadEngines();
    loadDatabases();
  }
}, { immediate: true });
</script>

<style scoped>
.site-dbs {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.site-dbs__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.site-dbs__title {
  font-size: 1.05rem;
  font-weight: 600;
  margin: 0 0 0.25rem;
  color: var(--text-heading);
}

.site-dbs__subtitle {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.45;
}

.site-dbs__loading,
.site-dbs__empty {
  padding: 2rem 1rem;
  text-align: center;
  color: var(--text-muted);
  background: var(--bg-elevated);
  border: 1px dashed var(--border);
  border-radius: 8px;
}

.site-dbs__empty-text {
  margin: 0 0 0.5rem;
  font-weight: 500;
  color: var(--text);
}

.site-dbs__empty-hint {
  margin: 0;
  font-size: 0.85rem;
}

.site-dbs__list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.db-card {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.db-card__head {
  display: flex;
  align-items: center;
  gap: 0.85rem;
}

.db-card__icon {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.db-card__icon--mariadb { background: rgba(var(--primary-rgb), 0.12); color: var(--primary-light); }
.db-card__icon--postgresql { background: rgba(59, 130, 246, 0.12); color: rgb(96, 165, 250); }

.db-card__info {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
  flex: 1;
}

.db-card__name {
  font-weight: 600;
  font-family: var(--font-mono);
  color: var(--text-heading);
  font-size: 0.95rem;
}

.db-card__meta {
  font-size: 0.78rem;
  color: var(--text-muted);
}

.db-card__badge {
  display: inline-block;
  padding: 0.1rem 0.45rem;
  border-radius: 4px;
  background: var(--bg);
  border: 1px solid var(--border);
  font-size: 0.7rem;
  font-weight: 600;
  margin-right: 0.25rem;
}

.db-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

/* ─────────── Кнопки (синхронно со стилями страницы /sites/[id]) ─────────── */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  padding: 0.55rem 1.1rem;
  border-radius: 10px;
  border: none;
  font-size: 0.82rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}
.btn--primary {
  background: linear-gradient(135deg, var(--primary-light), var(--primary-dark));
  color: var(--primary-text-on);
}
.btn--primary:not(:disabled):hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(var(--primary-rgb), 0.2);
}
.btn--primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.btn--ghost {
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  color: var(--text-tertiary);
}
.btn--ghost:hover { color: var(--text-secondary); border-color: var(--border-strong); }
.btn--ghost:disabled { opacity: 0.5; cursor: not-allowed; }
.btn--danger {
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.2);
  color: #f87171;
}
.btn--danger:not(:disabled):hover { background: rgba(239, 68, 68, 0.18); }
.btn--danger:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--sm {
  padding: 0.35rem 0.75rem;
  font-size: 0.75rem;
  border-radius: 8px;
}
.btn--disabled {
  pointer-events: none;
  opacity: 0.5;
}

/* ─────────── Модалки ─────────── */
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.modal {
  background: var(--bg-modal);
  border: 1px solid var(--border-strong);
  border-radius: 16px;
  padding: 1.5rem;
  width: 440px;
  max-width: 92vw;
  box-shadow: var(--shadow-modal);
}
.modal__title {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text-heading);
  margin: 0 0 0.5rem;
}
.modal__desc {
  font-size: 0.82rem;
  color: var(--text-tertiary);
  margin: 0 0 1rem;
  line-height: 1.5;
}
.modal__desc strong { color: var(--text-heading); }
.modal__fields {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}
.modal__error {
  margin-top: 0.85rem;
  padding: 0.6rem 0.75rem;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 8px;
  font-size: 0.78rem;
  color: #f87171;
}
.modal__actions {
  display: flex;
  gap: 0.6rem;
  justify-content: flex-end;
  margin-top: 1.25rem;
}

/* ─────────── Формы ─────────── */
.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.form-label {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--text-tertiary);
}
.form-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-input);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  padding: 0.6rem 0.85rem;
  font-size: 0.85rem;
  color: var(--text-primary);
  font-family: 'JetBrains Mono', monospace;
  outline: none;
  transition: all 0.2s;
}
.form-input:focus {
  border-color: var(--primary-border, rgba(var(--primary-rgb), 0.4));
  box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.08);
}
.form-hint {
  font-size: 0.72rem;
  color: var(--text-muted);
  line-height: 1.4;
}

/* ─────────── Radio-группа (для выбора движка БД) ─────────── */
.radio-group {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.radio-option {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.45rem 0.85rem;
  border-radius: 8px;
  background: var(--bg-input);
  border: 1px solid var(--border-secondary);
  font-size: 0.8rem;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}
.radio-option:hover { border-color: var(--border-strong); }
.radio-option--active {
  background: rgba(var(--primary-rgb), 0.08);
  border-color: rgba(var(--primary-rgb), 0.5);
  color: var(--text-heading);
}
.radio-option__input { accent-color: var(--primary, var(--primary)); }

/* ─────────── Прочее ─────────── */
.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--primary, var(--primary));
  border-radius: 50%;
  animation: site-dbs-spin 0.8s linear infinite;
  vertical-align: middle;
  margin-right: 0.4rem;
}
@keyframes site-dbs-spin { to { transform: rotate(360deg); } }

.password-display {
  margin: 0.75rem 0;
  padding: 0.75rem;
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.9rem;
  color: var(--text-heading);
  word-break: break-all;
}

.link {
  color: var(--primary, var(--primary-light));
  text-decoration: underline;
  text-underline-offset: 2px;
}
.link:hover { text-decoration: none; }

code {
  background: var(--bg-input);
  border: 1px solid var(--border-secondary);
  border-radius: 4px;
  padding: 0.05rem 0.3rem;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.85em;
  color: var(--text-secondary);
}
</style>
