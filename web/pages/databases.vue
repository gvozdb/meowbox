<template>
  <div class="databases">
    <div class="databases__header">
      <div>
        <h1 class="databases__title">Databases</h1>
        <p class="databases__subtitle">Manage databases across your servers</p>
      </div>
      <button class="btn btn--primary" @click="showCreateModal = true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
        Create Database
      </button>
    </div>

    <!-- Filters -->
    <div class="databases__filters">
      <div class="filter-input-wrap">
        <svg class="filter-input-wrap__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
        <input v-model="search" type="text" class="filter-input" placeholder="Search databases..." @input="debouncedLoad" />
      </div>
      <div class="filter-chips">
        <button v-for="t in typeFilters" :key="t.value" class="chip" :class="{ 'chip--active': typeFilter === t.value }" @click="typeFilter = t.value; loadDatabases()">{{ t.label }}</button>
      </div>
    </div>

    <!-- Table -->
    <div class="table-wrap">
      <div v-if="loading && !databases.length" class="table-empty">
        <div class="spinner" />
        <p>Loading databases...</p>
      </div>
      <div v-else-if="!databases.length" class="table-empty">
        <CatMascot :size="64" mood="sleepy" />
        <p>No databases found</p>
      </div>
      <table v-else class="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>User</th>
            <th>Size</th>
            <th>Linked Site</th>
            <th>Created</th>
            <th class="table__actions-col">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="db in databases" :key="db.id" class="table__row">
            <td>
              <span class="db-name">{{ db.name }}</span>
            </td>
            <td>
              <span class="badge" :class="`badge--${badgeClass(db.type)}`">{{ dbTypeLabel(db.type) }}</span>
            </td>
            <td>
              <span class="mono-text">{{ db.dbUser || '—' }}</span>
            </td>
            <td>
              <span class="mono-text">{{ formatSize(db.sizeBytes) }}</span>
            </td>
            <td>
              <NuxtLink v-if="db.site" :to="`/sites/${db.site.id}`" class="site-link">{{ db.site.name }}</NuxtLink>
              <span v-else class="muted">—</span>
            </td>
            <td>
              <span class="muted">{{ formatDate(db.createdAt) }}</span>
            </td>
            <td>
              <div class="row-actions">
                <button class="row-action" title="Экспорт и скачивание" :disabled="exporting === db.id" @click="exportDb(db)">
                  <svg v-if="exporting !== db.id" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7,10 12,15 17,10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                  <div v-else class="spinner-sm" />
                </button>
                <button class="row-action" title="Импорт SQL" @click="triggerImport(db)">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17,8 12,3 7,8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                </button>
                <input :ref="(el: any) => { if (el) importInputRefs[db.id] = el }" type="file" accept=".sql,.gz,.dump" style="display:none" @change="importFile($event, db)" />
                <button class="row-action row-action--blue" title="Открыть в Adminer" :disabled="openingAdminer === db.id" @click="openAdminer(db)">
                  <svg v-if="openingAdminer !== db.id" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>
                  <div v-else class="spinner-sm" />
                </button>
                <button class="row-action row-action--amber" title="Сброс пароля" @click="resetPassword(db)">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" /></svg>
                </button>
                <button class="row-action row-action--red" title="Удалить" @click="confirmDelete(db)">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Create Modal -->
    <Teleport to="body">
      <div v-if="showCreateModal" class="modal-overlay" @mousedown.self="showCreateModal = false">
        <div class="modal">
          <h3 class="modal__title">Create Database</h3>
          <div class="modal__fields">
            <div class="form-group">
              <label class="form-label">Database Name</label>
              <input v-model="createForm.name" type="text" class="form-input" placeholder="my_database" />
              <span class="form-hint">Alphanumeric and underscores only</span>
            </div>
            <div class="form-group">
              <label class="form-label">Тип</label>
              <div v-if="availableTypes.length > 0" class="radio-group">
                <label v-for="t in availableTypes" :key="t.value" class="radio-option" :class="{ 'radio-option--active': createForm.type === t.value }">
                  <input v-model="createForm.type" type="radio" :value="t.value" class="radio-option__input" />
                  <span class="radio-option__label">{{ t.label }}</span>
                </label>
              </div>
              <div v-else class="form-hint" style="color: var(--text-warning); padding: 0.5rem 0;">
                Ни один движок БД не установлен. Установи MariaDB или PostgreSQL на странице
                <NuxtLink to="/services" class="link">/services</NuxtLink>.
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">DB User (optional)</label>
              <input v-model="createForm.dbUser" type="text" class="form-input" placeholder="Auto-generated if empty" />
            </div>
            <div class="form-group">
              <label class="form-label">Link to Site (optional)</label>
              <select v-model="createForm.siteId" class="form-input">
                <option value="">None</option>
                <option v-for="s in sites" :key="s.id" :value="s.id">{{ s.name }}</option>
              </select>
            </div>
          </div>
          <div v-if="createError" class="modal__error">{{ createError }}</div>
          <div class="modal__actions">
            <button class="btn btn--ghost" @click="showCreateModal = false">Cancel</button>
            <button class="btn btn--primary" :disabled="!createForm.name || !createForm.type || creating" @click="createDatabase">
              {{ creating ? 'Creating...' : 'Create' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Delete Confirmation Modal -->
    <Teleport to="body">
      <div v-if="deleteTarget" class="modal-overlay" @mousedown.self="deleteTarget = null">
        <div class="modal">
          <h3 class="modal__title">Delete Database</h3>
          <p class="modal__desc">
            Are you sure you want to delete <strong>{{ deleteTarget.name }}</strong>?
            This action cannot be undone. All data will be permanently destroyed.
          </p>
          <div class="modal__actions">
            <button class="btn btn--ghost" @click="deleteTarget = null">Cancel</button>
            <button class="btn btn--danger" :disabled="deleting" @click="doDelete">
              {{ deleting ? 'Deleting...' : 'Delete Permanently' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Password Result Modal -->
    <Teleport to="body">
      <div v-if="newPassword" class="modal-overlay" @mousedown.self="newPassword = ''">
        <div class="modal">
          <h3 class="modal__title">New Password</h3>
          <p class="modal__desc">Password has been reset for <strong>{{ passwordDbName }}</strong>. Copy it now — it won't be shown again.</p>
          <div class="password-display">{{ newPassword }}</div>
          <div class="modal__actions">
            <button class="btn btn--primary" @click="copyPassword">Copy & Close</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { copyToClipboard } from '~/utils/clipboard';

definePageMeta({ middleware: 'auth' });

interface DbItem {
  id: string;
  name: string;
  type: string;
  dbUser?: string;
  sizeBytes?: number;
  site?: { id: string; name: string };
  createdAt: string;
}

interface SiteItem { id: string; name: string; }

const api = useApi();
const databases = ref<DbItem[]>([]);
const sites = ref<SiteItem[]>([]);
const loading = ref(true);
const search = ref('');
const typeFilter = ref('');

const showCreateModal = ref(false);
const creating = ref(false);
const createError = ref('');
const createForm = reactive({ name: '', type: 'MARIADB', dbUser: '', siteId: '' });

/**
 * Снимок установленных DB-сервисов (mariadb / postgresql).
 * Грузим один раз из /services при mount.
 * Используется для:
 *   - фильтрации опций в радио-группе при создании БД (нельзя выбрать
 *     движок, которого нет на сервере — всё равно упадём в API);
 *   - подсказки "ничего не установлено → /services".
 */
interface ServerService {
  key: string;
  installed: boolean;
}
const installedEngines = ref<Set<string>>(new Set());

interface DbTypeOption { label: string; value: 'MARIADB' | 'POSTGRESQL'; engineKey: 'mariadb' | 'postgresql' }
const ALL_DB_TYPES: DbTypeOption[] = [
  { label: 'MySQL / MariaDB', value: 'MARIADB', engineKey: 'mariadb' },
  { label: 'PostgreSQL', value: 'POSTGRESQL', engineKey: 'postgresql' },
];

const availableTypes = computed<DbTypeOption[]>(() =>
  ALL_DB_TYPES.filter((t) => installedEngines.value.has(t.engineKey)),
);

// Лейбл по фактическому значению Database.type (включая legacy MYSQL).
function dbTypeLabel(type: string): string {
  if (type === 'MARIADB' || type === 'MYSQL') return 'MySQL / MariaDB';
  if (type === 'POSTGRESQL') return 'PostgreSQL';
  return type;
}

// CSS-класс бейджа: MARIADB и MYSQL рисуем одним стилем (mariadb).
function badgeClass(type: string): string {
  if (type === 'MARIADB' || type === 'MYSQL') return 'mariadb';
  if (type === 'POSTGRESQL') return 'postgresql';
  return type.toLowerCase();
}

// Фильтры — один пункт "MySQL/MariaDB" фильтрует и MARIADB и MYSQL.
const typeFilters = [
  { label: 'Все', value: '' },
  { label: 'MySQL / MariaDB', value: 'MARIADB,MYSQL' },
  { label: 'PostgreSQL', value: 'POSTGRESQL' },
];

const deleteTarget = ref<DbItem | null>(null);
const deleting = ref(false);
const newPassword = ref('');
const passwordDbName = ref('');

const toast = useMbToast();
let debounceTimeout: ReturnType<typeof setTimeout> | undefined;

function showToast(msg: string, isError = false) {
  if (isError) toast.error(msg);
  else toast.success(msg);
}

function debouncedLoad() {
  if (debounceTimeout) clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(() => loadDatabases(), 300);
}

async function loadDatabases() {
  loading.value = true;
  try {
    const params = new URLSearchParams();
    if (search.value) params.set('search', search.value);
    if (typeFilter.value) params.set('type', typeFilter.value);
    const query = params.toString();
    databases.value = await api.get<DbItem[]>(`/databases${query ? '?' + query : ''}`);
  } catch {
    showToast('Failed to load databases', true);
  } finally {
    loading.value = false;
  }
}

async function loadSites() {
  try {
    sites.value = await api.get<SiteItem[]>('/sites');
  } catch { /* ignore */ }
}

async function loadInstalledEngines() {
  try {
    const list = await api.get<Array<ServerService & { key: string }>>('/services');
    const keys = new Set(list.filter((s) => s.installed).map((s) => s.key));
    installedEngines.value = keys;
    // Если в форме заранее проставленный type больше не доступен — переключаем
    // на первый из доступных (или оставляем как было, если ничего нет).
    const stillOk = ALL_DB_TYPES.some(
      (t) => t.value === createForm.type && keys.has(t.engineKey),
    );
    if (!stillOk) {
      const first = ALL_DB_TYPES.find((t) => keys.has(t.engineKey));
      if (first) createForm.type = first.value;
    }
  } catch {
    // /services может быть недоступен — просто не покажем фильтр, но создавать
    // через API всё равно дадим (бэкенд сам валидирует).
    installedEngines.value = new Set(['mariadb', 'postgresql']);
  }
}

async function createDatabase() {
  creating.value = true;
  createError.value = '';
  try {
    const body: Record<string, string> = { name: createForm.name, type: createForm.type };
    if (createForm.dbUser) body.dbUser = createForm.dbUser;
    if (createForm.siteId) body.siteId = createForm.siteId;
    await api.post('/databases', body);
    showCreateModal.value = false;
    createForm.name = '';
    createForm.dbUser = '';
    createForm.siteId = '';
    showToast('Database created');
    await loadDatabases();
  } catch {
    createError.value = 'Failed to create database';
  } finally {
    creating.value = false;
  }
}

function confirmDelete(db: DbItem) {
  deleteTarget.value = db;
}

async function doDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.del(`/databases/${deleteTarget.value.id}`);
    showToast('Database deleted');
    deleteTarget.value = null;
    await loadDatabases();
  } catch {
    showToast('Failed to delete database', true);
  } finally {
    deleting.value = false;
  }
}

async function resetPassword(db: DbItem) {
  try {
    const data = await api.post<{ plainPassword: string }>(`/databases/${db.id}/reset-password`);
    newPassword.value = data.plainPassword;
    passwordDbName.value = db.name;
  } catch {
    showToast('Ошибка сброса пароля', true);
  }
}

const openingAdminer = ref<string | null>(null);

async function openAdminer(db: DbItem) {
  openingAdminer.value = db.id;
  // Открываем вкладку СРАЗУ — иначе popup-blocker зарежет, если ждать ответ API.
  // Window.open в обработчике клика разрешён, потом подменим location.
  const win = window.open('about:blank', '_blank');
  try {
    const data = await api.post<{ url: string }>(`/databases/${db.id}/adminer-ticket`);
    if (!data?.url) throw new Error('No SSO url');
    if (win) {
      win.location.href = data.url;
    } else {
      // Popup blocker всё равно сработал — fallback на текущую вкладку.
      window.location.href = data.url;
    }
  } catch (err) {
    if (win) win.close();
    const msg = (err as Error).message || 'Не удалось открыть Adminer';
    showToast(msg, true);
  } finally {
    openingAdminer.value = null;
  }
}

const exporting = ref<string | null>(null);
const importInputRefs = reactive<Record<string, HTMLInputElement>>({});

async function exportDb(db: DbItem) {
  exporting.value = db.id;
  try {
    // Trigger export on server
    const data = await api.post<{ filePath: string }>(`/databases/${db.id}/export`);
    if (!data.filePath) {
      showToast('Экспорт не вернул путь к файлу', true);
      return;
    }
    // Download the exported file
    const filename = data.filePath.split('/').pop() || `${db.name}.sql`;
    await api.download(`/databases/${db.id}/download?filePath=${encodeURIComponent(data.filePath)}`, filename);
    showToast('Дамп скачан');
  } catch (err: unknown) {
    showToast((err as Error).message || 'Ошибка экспорта', true);
  } finally {
    exporting.value = null;
  }
}

function triggerImport(db: DbItem) {
  importInputRefs[db.id]?.click();
}

async function importFile(event: Event, db: DbItem) {
  const input = event.target as HTMLInputElement;
  if (!input.files?.length) return;

  const file = input.files[0];
  try {
    showToast(`Импорт ${file.name}...`);
    await api.upload(`/databases/${db.id}/import-upload`, file);
    showToast('Импорт завершён');
    await loadDatabases();
  } catch (err: unknown) {
    showToast((err as Error).message || 'Ошибка импорта', true);
  } finally {
    input.value = '';
  }
}

async function copyPassword() {
  const ok = await copyToClipboard(newPassword.value);
  newPassword.value = '';
  if (ok) showToast('Password copied to clipboard');
  else showToast('Не удалось скопировать в буфер', true);
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatSize(bytes?: number) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

onMounted(() => {
  loadInstalledEngines();
  loadDatabases();
  loadSites();
});
</script>

<style scoped>
.databases__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 1.5rem;
  gap: 1rem;
}

.databases__title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0;
}

.databases__subtitle {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-top: 0.15rem;
}

/* Filters */
.databases__filters {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1.25rem;
  flex-wrap: wrap;
}

.filter-input-wrap {
  position: relative;
  flex: 1;
  min-width: 200px;
  max-width: 320px;
}

.filter-input-wrap__icon {
  position: absolute;
  left: 0.75rem;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-faint);
  pointer-events: none;
}

.filter-input {
  width: 100%;
  background: var(--bg-elevated);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  padding: 0.55rem 0.8rem 0.55rem 2.25rem;
  font-size: 0.82rem;
  color: var(--text-primary);
  font-family: inherit;
  outline: none;
  transition: border-color 0.2s;
}

.filter-input:focus {
  border-color: var(--primary-border);
}

.filter-chips {
  display: flex;
  gap: 0.35rem;
}

.chip {
  padding: 0.35rem 0.7rem;
  border-radius: 8px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  color: var(--text-tertiary);
  font-size: 0.72rem;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
}

.chip:hover { color: var(--text-secondary); border-color: var(--border-strong); }
.chip--active { background: var(--primary-bg); border-color: var(--primary-border); color: var(--primary-text); }

/* Table */
.table-wrap {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  overflow: hidden;
}

.table {
  width: 100%;
  border-collapse: collapse;
}

.table th {
  text-align: left;
  padding: 0.7rem 1rem;
  font-size: 0.68rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--border);
}

.table td {
  padding: 0.7rem 1rem;
  font-size: 0.82rem;
  border-bottom: 1px solid var(--bg-surface);
}

.table__row:hover {
  background: var(--bg-input);
}

.table__actions-col {
  width: 90px;
  text-align: right;
}

.db-name {
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.mono-text {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  color: var(--text-tertiary);
}

.muted { color: var(--text-faint); font-size: 0.78rem; }

.site-link {
  color: var(--primary-text);
  text-decoration: none;
  font-size: 0.82rem;
  font-weight: 500;
}

.site-link:hover { text-decoration: underline; }

.badge {
  display: inline-block;
  font-size: 0.62rem;
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
  padding: 0.2rem 0.5rem;
  border-radius: 6px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.badge--mariadb { background: rgba(99, 102, 241, 0.1); color: #818cf8; }
.badge--mysql { background: rgba(245, 158, 11, 0.1); color: #fbbf24; }
.badge--postgresql { background: rgba(59, 130, 246, 0.1); color: #60a5fa; }

.row-actions {
  display: flex;
  gap: 0.3rem;
  justify-content: flex-end;
}

.row-action {
  background: none;
  border: 1px solid var(--border-secondary);
  border-radius: 8px;
  padding: 0.35rem;
  cursor: pointer;
  display: flex;
  transition: all 0.2s;
}

.row-action--amber { color: rgba(245, 158, 11, 0.4); }
.row-action--amber:hover { color: var(--primary-text); border-color: var(--primary-border); background: var(--primary-bg); }
.row-action--red { color: rgba(239, 68, 68, 0.4); }
.row-action--red:hover { color: #f87171; border-color: rgba(239, 68, 68, 0.2); background: rgba(239, 68, 68, 0.05); }
.row-action--blue { color: rgba(59, 130, 246, 0.55); }
.row-action--blue:hover:not(:disabled) { color: #60a5fa; border-color: rgba(59, 130, 246, 0.3); background: rgba(59, 130, 246, 0.08); }
.row-action:disabled { opacity: 0.5; cursor: wait; }

.table-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 3rem 1rem;
  gap: 0.5rem;
  color: var(--text-muted);
  font-size: 0.85rem;
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
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
  background: linear-gradient(135deg, #fbbf24, #d97706);
  color: var(--primary-text-on);
}

.btn--primary:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(245, 158, 11, 0.2); }
.btn--primary:disabled { opacity: 0.4; cursor: not-allowed; }

.btn--ghost {
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  color: var(--text-tertiary);
}

.btn--ghost:hover { color: var(--text-secondary); border-color: var(--border-strong); }

.btn--danger {
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.2);
  color: #f87171;
}

.btn--danger:not(:disabled):hover { background: rgba(239, 68, 68, 0.18); }
.btn--danger:disabled { opacity: 0.4; cursor: not-allowed; }

/* Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  padding: 1rem;
}

.modal {
  background: var(--bg-modal-gradient);
  border: 1px solid var(--border-secondary);
  border-radius: 18px;
  padding: 1.5rem;
  width: 100%;
  max-width: 440px;
  box-shadow: 0 24px 80px -12px var(--shadow-modal);
  animation: modalIn 0.25s ease;
}

.modal__title {
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0 0 1rem;
}

.modal__desc {
  font-size: 0.82rem;
  color: var(--text-tertiary);
  margin: 0 0 1.25rem;
  line-height: 1.5;
}

.modal__desc strong { color: var(--text-secondary); }

.modal__fields {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  margin-bottom: 1rem;
}

.modal__error {
  color: #f87171;
  font-size: 0.78rem;
  margin-bottom: 0.75rem;
}

.modal__actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

/* Forms */
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
  background: var(--bg-elevated);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  padding: 0.55rem 0.8rem;
  font-size: 0.85rem;
  color: var(--text-primary);
  font-family: inherit;
  outline: none;
  transition: all 0.2s;
}

.form-input:focus { border-color: var(--primary-border); box-shadow: var(--focus-ring); }

.form-hint {
  font-size: 0.68rem;
  color: var(--text-faint);
}

select.form-input {
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23666' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.75rem center;
  padding-right: 2rem;
}

.radio-group {
  display: flex;
  gap: 0.4rem;
}

.radio-option {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem 0.6rem;
  border-radius: 8px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  cursor: pointer;
  transition: all 0.2s;
}

.radio-option__input { display: none; }

.radio-option__label {
  font-size: 0.7rem;
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-muted);
  transition: color 0.2s;
}

.radio-option:hover { border-color: var(--border-strong); }
.radio-option--active { border-color: var(--primary-border); background: var(--primary-bg); }
.radio-option--active .radio-option__label { color: var(--primary-text); }

/* Password display */
.password-display {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.9rem;
  color: var(--primary-text);
  background: var(--primary-bg);
  border: 1px solid var(--primary-border);
  border-radius: 10px;
  padding: 0.75rem;
  margin-bottom: 1.25rem;
  word-break: break-all;
  user-select: all;
  text-align: center;
  letter-spacing: 0.05em;
}

/* Spinner */
.spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--spinner-track);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.spinner-sm {
  width: 14px;
  height: 14px;
  border: 2px solid var(--spinner-track);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }
@keyframes modalIn { from { opacity: 0; transform: scale(0.96) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }

@media (max-width: 768px) {
  .databases__header { flex-direction: column; align-items: stretch; gap: 0.75rem; }
  .databases__header .btn { align-self: flex-start; }
  .databases__filters { flex-direction: column; align-items: stretch; }
  .filter-input-wrap { max-width: none; min-width: 0; }
  .filter-chips { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .table { min-width: 500px; }
  .databases__title { font-size: 1.25rem; }
}
</style>
