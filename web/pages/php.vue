<template>
  <div class="php">
    <div class="php__header">
      <div>
        <h1 class="php__title">PHP</h1>
        <p class="php__subtitle">PHP-FPM versions and pools</p>
      </div>
    </div>

    <!-- Install new version -->
    <div v-if="!loading" class="install-row">
      <select v-model="installVersion" class="form-select" @change="onInstallVersionChange">
        <option value="">Install PHP version...</option>
        <optgroup label="Modern (supported)">
          <option v-for="v in availableModernVersions" :key="v" :value="v">PHP {{ v }}</option>
        </optgroup>
        <optgroup label="Legacy (EOL — only for migration)">
          <option v-for="v in availableLegacyVersions" :key="v" :value="v">PHP {{ v }} ⚠</option>
        </optgroup>
      </select>
      <button class="btn btn--primary btn--sm" :disabled="!installVersion || installing" @click="doInstall">
        {{ installing ? 'Installing...' : 'Install' }}
      </button>
    </div>

    <!-- Live install log -->
    <div v-if="installLog.length > 0" class="install-log">
      <div class="install-log__head">
        <strong>Лог установки {{ installLogVersion ? `PHP ${installLogVersion}` : '' }}</strong>
        <button v-if="!installing" class="btn btn--ghost btn--sm" @click="installLog = []; installLogVersion = ''">Очистить</button>
      </div>
      <pre ref="installLogEl" class="install-log__body">{{ installLogText }}</pre>
    </div>

    <!-- Legacy warning -->
    <div v-if="installVersion && isLegacy(installVersion)" class="legacy-warning">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
      <div>
        <strong>PHP {{ installVersion }} снят с поддержки разработчиками PHP.</strong>
        <p>Используй ТОЛЬКО для миграции старых сайтов. Новые проекты на legacy-PHP — известные уязвимости и отсутствие security-фиксов.</p>
      </div>
    </div>

    <div v-if="loading" class="php__loading">
      <div class="spinner" />
      <p>Loading PHP versions...</p>
    </div>

    <div v-else-if="!statuses.length" class="php__empty">
      <CatMascot :size="72" mood="sleepy" />
      <p>No PHP versions installed</p>
    </div>

    <div v-else class="php__grid">
      <div v-for="ver in statuses" :key="ver.version" class="version-card">
        <div class="version-card__header">
          <div class="version-card__info">
            <span class="version-card__name">PHP {{ ver.version }}</span>
            <span class="version-badge" :class="ver.running ? 'version-badge--ok' : 'version-badge--off'">
              <span class="version-badge__dot" />
              {{ ver.running ? 'Running' : 'Stopped' }}
            </span>
          </div>
          <button
            class="btn btn--ghost btn--sm"
            :disabled="restarting === ver.version"
            @click="restartVersion(ver.version!)"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23,4 23,10 17,10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
            {{ restarting === ver.version ? 'Restarting...' : 'Restart' }}
          </button>
        </div>

        <div class="version-card__stats">
          <div class="stat">
            <span class="stat__label">Pools</span>
            <span class="stat__value">{{ ver.poolCount }}</span>
          </div>
          <div class="stat">
            <span class="stat__label">Service</span>
            <span class="stat__value mono">php{{ ver.version }}-fpm</span>
          </div>
        </div>

        <div class="version-card__actions">
          <button class="btn btn--ghost btn--sm" @click="openExtensions(ver.version!)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>
            Extensions
          </button>
          <button class="btn btn--ghost btn--sm" @click="openIni(ver.version!)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14,2 14,8 20,8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>
            php.ini
          </button>
          <button
            class="btn btn--danger btn--sm"
            :disabled="uninstalling === ver.version"
            @click="doUninstall(ver.version!)"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3,6 5,6 21,6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
            {{ uninstalling === ver.version ? 'Uninstalling...' : 'Uninstall' }}
          </button>
        </div>
      </div>
    </div>

    <!-- php.ini editor modal -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showIni" class="modal-overlay" @mousedown.self="showIni = false">
          <div class="modal">
            <div class="modal__header">
              <h2 class="modal__title">php.ini — PHP {{ iniVersion }}</h2>
              <button class="modal__close" @click="showIni = false">&times;</button>
            </div>
            <div class="modal__body">
              <textarea
                v-model="iniContent"
                class="ini-editor"
                spellcheck="false"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
              />
            </div>
            <div class="modal__footer">
              <button class="btn btn--ghost btn--sm" @click="showIni = false">Cancel</button>
              <button class="btn btn--primary btn--sm" :disabled="savingIni" @click="saveIni">
                {{ savingIni ? 'Saving...' : 'Save' }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- Extensions modal -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showExt" class="modal-overlay" @mousedown.self="showExt = false">
          <div class="modal">
            <div class="modal__header">
              <h2 class="modal__title">Extensions — PHP {{ extVersion }}</h2>
              <button class="modal__close" @click="showExt = false">&times;</button>
            </div>
            <div class="modal__body">
              <div class="ext-install-row">
                <input
                  v-model="newExtName"
                  class="form-input"
                  placeholder="Extension name (e.g. redis, imagick)"
                  @keyup.enter="installExtension"
                />
                <button class="btn btn--primary btn--sm" :disabled="!newExtName.trim() || installingExt" @click="installExtension">
                  {{ installingExt ? 'Installing...' : 'Install' }}
                </button>
              </div>
              <div v-if="extInstallLog.length > 0" class="install-log install-log--inline">
                <div class="install-log__head">
                  <strong>Лог установки расширения {{ extInstallLogName || '' }}</strong>
                  <button v-if="!installingExt" class="btn btn--ghost btn--sm" @click="extInstallLog = []; extInstallLogName = ''">Очистить</button>
                </div>
                <pre ref="extInstallLogEl" class="install-log__body">{{ extInstallLogText }}</pre>
              </div>
              <div v-if="loadingExt" class="ext-loading">
                <div class="spinner" />
                <span>Loading extensions...</span>
              </div>
              <div v-else-if="!extensions.length" class="ext-empty">
                No extensions found
              </div>
              <div v-else class="ext-list">
                <div v-for="ext in extensions" :key="ext.name" class="ext-item">
                  <span class="ext-item__name mono">{{ ext.name }}</span>
                  <label class="toggle">
                    <input
                      type="checkbox"
                      :checked="ext.enabled"
                      :disabled="togglingExt === ext.name"
                      @change="toggleExtension(ext)"
                    />
                    <span class="toggle__slider" />
                  </label>
                </div>
              </div>
            </div>
            <div class="modal__footer">
              <button class="btn btn--ghost btn--sm" @click="showExt = false">Close</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface PhpVersionStatus { running: boolean; version: string | null; poolCount: number; }
interface PhpExtension { name: string; enabled: boolean; }

// Modern (актуально поддерживаемые) и Legacy (EOL — нужны только для миграций
// со старых проектов). Legacy показываются отдельной optgroup'ой с warning'ом.
const MODERN_VERSIONS = ['8.4', '8.3', '8.2', '8.1', '8.0'];
const LEGACY_VERSIONS = ['7.4', '7.3', '7.2', '7.1'];
const ALL_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

function isLegacy(v: string): boolean {
  return LEGACY_VERSIONS.includes(v);
}

const api = useApi();
const { connect: connectSocket, getSocket } = useSocket();
const statuses = ref<PhpVersionStatus[]>([]);
const loading = ref(true);
const restarting = ref<string | null>(null);

// ─── Live-log стрим установки/удаления PHP-версии ───
// Подписываемся на php:install:log в комнате php:install:<version>.
// Лог копится в реактивный массив, рендерится в <pre> с auto-scroll вниз.
interface LogLine { line: string; stream: 'stdout' | 'stderr'; ts: string }
const MAX_LOG_LINES = 800;
const installLog = ref<LogLine[]>([]);
const installLogVersion = ref('');
const installLogEl = ref<HTMLElement | null>(null);
const installLogText = computed(() =>
  installLog.value.map((l) => (l.stream === 'stderr' ? '! ' : '  ') + l.line).join('\n'),
);

// Live-лог установки extension'а (внутри Extensions модалки)
const extInstallLog = ref<LogLine[]>([]);
const extInstallLogName = ref('');
const extInstallLogEl = ref<HTMLElement | null>(null);
const extInstallLogText = computed(() =>
  extInstallLog.value.map((l) => (l.stream === 'stderr' ? '! ' : '  ') + l.line).join('\n'),
);

let phpInstallUnsub: (() => void) | null = null;
let phpExtInstallUnsub: (() => void) | null = null;

function startPhpInstallStream(version: string) {
  // Сбрасываем старый лог + слушатель.
  stopPhpInstallStream();
  installLog.value = [];
  installLogVersion.value = version;
  connectSocket();
  const socket = getSocket();
  if (!socket) return;
  socket.emit('php:install:subscribe', { version });
  const handler = (data: { version: string; line: string; stream?: 'stdout' | 'stderr'; timestamp: string }) => {
    if (data.version !== version) return;
    installLog.value.push({ line: data.line, stream: data.stream || 'stdout', ts: data.timestamp });
    if (installLog.value.length > MAX_LOG_LINES) installLog.value.splice(0, installLog.value.length - MAX_LOG_LINES);
    nextTick(() => {
      if (installLogEl.value) installLogEl.value.scrollTop = installLogEl.value.scrollHeight;
    });
  };
  socket.on('php:install:log', handler);
  phpInstallUnsub = () => {
    socket.off('php:install:log', handler);
    socket.emit('php:install:unsubscribe', { version });
  };
}

function stopPhpInstallStream() {
  if (phpInstallUnsub) { try { phpInstallUnsub(); } catch { /* ignore */ } }
  phpInstallUnsub = null;
}

function startExtInstallStream(version: string, name: string) {
  stopExtInstallStream();
  extInstallLog.value = [];
  extInstallLogName.value = name;
  connectSocket();
  const socket = getSocket();
  if (!socket) return;
  socket.emit('php:ext-install:subscribe', { version, name });
  const handler = (data: { version: string; name: string; line: string; stream?: 'stdout' | 'stderr'; timestamp: string }) => {
    if (data.version !== version || data.name !== name) return;
    extInstallLog.value.push({ line: data.line, stream: data.stream || 'stdout', ts: data.timestamp });
    if (extInstallLog.value.length > MAX_LOG_LINES) extInstallLog.value.splice(0, extInstallLog.value.length - MAX_LOG_LINES);
    nextTick(() => {
      if (extInstallLogEl.value) extInstallLogEl.value.scrollTop = extInstallLogEl.value.scrollHeight;
    });
  };
  socket.on('php:ext-install:log', handler);
  phpExtInstallUnsub = () => {
    socket.off('php:ext-install:log', handler);
    socket.emit('php:ext-install:unsubscribe', { version, name });
  };
}

function stopExtInstallStream() {
  if (phpExtInstallUnsub) { try { phpExtInstallUnsub(); } catch { /* ignore */ } }
  phpExtInstallUnsub = null;
}

onBeforeUnmount(() => {
  stopPhpInstallStream();
  stopExtInstallStream();
});

// Install
const installVersion = ref('');
const installing = ref(false);
const availableModernVersions = computed(() =>
  MODERN_VERSIONS.filter(v => !statuses.value.some(s => s.version === v)),
);
const availableLegacyVersions = computed(() =>
  LEGACY_VERSIONS.filter(v => !statuses.value.some(s => s.version === v)),
);

function onInstallVersionChange() {
  /* Реактивный warning рендерится через computed isLegacy в шаблоне */
}

// Uninstall
const uninstalling = ref<string | null>(null);

// php.ini editor
const showIni = ref(false);
const iniVersion = ref('');
const iniContent = ref('');
const savingIni = ref(false);

// Extensions
const showExt = ref(false);
const extVersion = ref('');
const extensions = ref<PhpExtension[]>([]);
const loadingExt = ref(false);
const newExtName = ref('');
const installingExt = ref(false);
const togglingExt = ref<string | null>(null);

const toast = useMbToast();
function showToast(msg: string, isError = false) {
  if (isError) toast.error(msg);
  else toast.success(msg);
}

async function loadStatuses() {
  loading.value = true;
  try {
    statuses.value = await api.get<PhpVersionStatus[]>('/php/status');
  } catch { statuses.value = []; }
  finally { loading.value = false; }
}

async function restartVersion(version: string) {
  restarting.value = version;
  try {
    await api.post(`/php/restart/${version}`);
    showToast(`PHP ${version} restarted`);
    await loadStatuses();
  } catch {
    showToast(`Failed to restart PHP ${version}`, true);
  } finally {
    restarting.value = null;
  }
}

async function doInstall() {
  const ver = installVersion.value;
  if (!ver) return;
  installing.value = true;
  startPhpInstallStream(ver);
  try {
    await api.post('/php/install', { version: ver });
    showToast(`PHP ${ver} installed successfully`);
    installVersion.value = '';
    await loadStatuses();
  } catch (e: unknown) {
    showToast((e as Error)?.message || `Failed to install PHP ${ver}`, true);
  } finally {
    installing.value = false;
    // Лог НЕ чистим — оператор может почитать что произошло.
    // Слушатель отписываем, чтобы не копились зомби-listeners при следующем install.
    stopPhpInstallStream();
  }
}

async function doUninstall(version: string) {
  const ok = await useMbConfirm().ask({
    title: `Uninstall PHP ${version}`,
    message: `Uninstall PHP ${version}? This will remove all its pools and configuration.`,
    confirmText: 'Uninstall',
    danger: true,
  });
  if (!ok) return;
  uninstalling.value = version;
  startPhpInstallStream(version);
  try {
    await api.delete(`/php/uninstall/${version}`);
    showToast(`PHP ${version} uninstalled`);
    await loadStatuses();
  } catch (e: unknown) {
    showToast((e as Error)?.message || `Failed to uninstall PHP ${version}`, true);
  } finally {
    uninstalling.value = null;
    stopPhpInstallStream();
  }
}

async function openIni(version: string) {
  iniVersion.value = version;
  iniContent.value = '';
  showIni.value = true;
  try {
    const data = await api.get<{ content: string }>(`/php/${version}/ini`);
    iniContent.value = data.content;
  } catch {
    showToast(`Failed to load php.ini for PHP ${version}`, true);
    showIni.value = false;
  }
}

async function saveIni() {
  savingIni.value = true;
  try {
    await api.post(`/php/${iniVersion.value}/ini`, { content: iniContent.value });
    showToast(`php.ini saved for PHP ${iniVersion.value}`);
    showIni.value = false;
  } catch {
    showToast(`Failed to save php.ini`, true);
  } finally {
    savingIni.value = false;
  }
}

async function openExtensions(version: string) {
  extVersion.value = version;
  extensions.value = [];
  newExtName.value = '';
  showExt.value = true;
  await loadExtensions(version);
}

async function loadExtensions(version: string) {
  loadingExt.value = true;
  try {
    extensions.value = await api.get<PhpExtension[]>(`/php/${version}/extensions`);
  } catch {
    showToast(`Failed to load extensions for PHP ${version}`, true);
  } finally {
    loadingExt.value = false;
  }
}

async function toggleExtension(ext: PhpExtension) {
  togglingExt.value = ext.name;
  const action = ext.enabled ? 'disable' : 'enable';
  try {
    await api.post(`/php/${extVersion.value}/extensions/toggle`, { name: ext.name, enable: !ext.enabled });
    ext.enabled = !ext.enabled;
    showToast(`${ext.name} ${action}d`);
  } catch {
    showToast(`Failed to ${action} ${ext.name}`, true);
  } finally {
    togglingExt.value = null;
  }
}

async function installExtension() {
  const name = newExtName.value.trim();
  if (!name) return;
  installingExt.value = true;
  startExtInstallStream(extVersion.value, name);
  try {
    await api.post(`/php/${extVersion.value}/extensions/install`, { name });
    showToast(`${name} installed for PHP ${extVersion.value}`);
    newExtName.value = '';
    await loadExtensions(extVersion.value);
  } catch (e: unknown) {
    showToast((e as Error)?.message || `Failed to install ${name}`, true);
  } finally {
    installingExt.value = false;
    stopExtInstallStream();
  }
}

onMounted(loadStatuses);
</script>

<style scoped>
.php__header { margin-bottom: 1.5rem; }
.php__title { font-size: 1.5rem; font-weight: 700; color: var(--text-heading); margin: 0; }
.php__subtitle { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.15rem; }

.php__loading, .php__empty {
  display: flex; flex-direction: column; align-items: center; padding: 3rem 1rem;
  gap: 0.75rem; color: var(--text-muted); font-size: 0.85rem;
}

.php__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 0.75rem; }

.version-card {
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 14px; padding: 1rem 1.15rem;
}

.version-card__header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 0.85rem;
}
.version-card__info { display: flex; align-items: center; gap: 0.6rem; }
.version-card__name { font-size: 1rem; font-weight: 700; color: var(--text-heading); }

.version-badge {
  display: inline-flex; align-items: center; gap: 0.3rem;
  font-size: 0.65rem; font-weight: 600; padding: 0.2rem 0.5rem; border-radius: 6px;
}
.version-badge__dot { width: 6px; height: 6px; border-radius: 50%; }
.version-badge--ok { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
.version-badge--ok .version-badge__dot { background: #22c55e; box-shadow: 0 0 4px rgba(34, 197, 94, 0.5); }
.version-badge--off { background: rgba(148, 163, 184, 0.1); color: #94a3b8; }
.version-badge--off .version-badge__dot { background: #64748b; }

.version-card__stats { display: flex; gap: 1.5rem; }
.stat { display: flex; flex-direction: column; gap: 0.1rem; }
.stat__label { font-size: 0.68rem; color: var(--text-muted); }
.stat__value { font-size: 0.82rem; font-weight: 500; color: var(--text-secondary); }
.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; }

.spinner { width: 20px; height: 20px; border: 2px solid var(--spinner-track); border-top-color: var(--primary); border-radius: 50%; animation: spin 0.8s linear infinite; }

.btn {
  display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.55rem 1rem;
  border-radius: 10px; border: none; font-size: 0.82rem; font-weight: 600;
  font-family: inherit; cursor: pointer; transition: all 0.2s; white-space: nowrap;
}
.btn--sm { padding: 0.4rem 0.8rem; font-size: 0.75rem; border-radius: 8px; }
.btn--ghost { background: var(--bg-input); border: 1px solid var(--border-strong); color: var(--text-tertiary); }
.btn--ghost:hover:not(:disabled) { color: var(--text-secondary); border-color: var(--border-strong); }
.btn--ghost:disabled { opacity: 0.4; cursor: not-allowed; }

@keyframes spin { to { transform: rotate(360deg); } }

/* Install row */
.install-row {
  display: flex; gap: 0.5rem; margin-bottom: 1rem; align-items: center;
}

/* Live log panel */
.install-log {
  margin-bottom: 1rem; max-width: 100%;
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg-input); overflow: hidden;
}
.install-log--inline { margin-top: 0.6rem; margin-bottom: 0.6rem; }
.install-log__head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.5rem 0.85rem; border-bottom: 1px solid var(--border);
  font-size: 0.78rem; color: var(--text-secondary);
}
.install-log__body {
  margin: 0; padding: 0.6rem 0.85rem; max-height: 280px;
  overflow-y: auto; font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem; line-height: 1.45; color: var(--text-secondary);
  white-space: pre-wrap; word-break: break-word;
}

/* Legacy warning */
.legacy-warning {
  display: flex; gap: 0.7rem; align-items: flex-start;
  padding: 0.7rem 0.9rem; margin-bottom: 1rem;
  background: rgba(239, 68, 68, 0.06);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 10px;
  color: #fca5a5;
  max-width: 720px;
}
.legacy-warning svg { flex-shrink: 0; color: #f87171; margin-top: 0.1rem; }
.legacy-warning strong { display: block; color: #fda4a4; font-size: 0.85rem; margin-bottom: 0.2rem; font-weight: 600; }
.legacy-warning p { margin: 0; font-size: 0.78rem; line-height: 1.5; color: rgba(252, 165, 165, 0.85); }
.form-select {
  flex: 1; max-width: 280px; padding: 0.45rem 0.75rem; border-radius: 8px;
  border: 1px solid var(--border-strong); background: var(--bg-input); color: var(--text-secondary);
  font-size: 0.82rem; font-family: inherit; cursor: pointer;
  appearance: none; -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2'%3E%3Cpolyline points='6,9 12,15 18,9'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 0.6rem center;
  padding-right: 2rem;
}
.form-select:focus { outline: none; border-color: var(--primary); }
.form-input {
  flex: 1; padding: 0.45rem 0.75rem; border-radius: 8px;
  border: 1px solid var(--border-strong); background: var(--bg-input); color: var(--text-secondary);
  font-size: 0.82rem; font-family: inherit;
}
.form-input:focus { outline: none; border-color: var(--primary); }
.form-input::placeholder { color: var(--text-muted); }

/* Primary and danger button styles */
.btn--primary {
  background: var(--primary); color: #fff; border: none;
}
.btn--primary:hover:not(:disabled) { filter: brightness(1.1); }
.btn--primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--danger {
  background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); color: #f87171;
}
.btn--danger:hover:not(:disabled) { background: rgba(239, 68, 68, 0.18); }
.btn--danger:disabled { opacity: 0.4; cursor: not-allowed; }

/* Version card actions */
.version-card__actions {
  display: flex; gap: 0.4rem; margin-top: 0.85rem; padding-top: 0.75rem;
  border-top: 1px solid var(--border); flex-wrap: wrap;
}

/* Modal */
.modal-overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center; z-index: 400; padding: 1rem;
}
.modal {
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 16px; width: 100%; max-width: 680px; max-height: 85vh;
  display: flex; flex-direction: column; box-shadow: 0 25px 50px rgba(0, 0, 0, 0.4);
}
.modal__header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 1rem 1.25rem; border-bottom: 1px solid var(--border);
}
.modal__title { font-size: 1rem; font-weight: 700; color: var(--text-heading); margin: 0; }
.modal__close {
  background: none; border: none; font-size: 1.4rem; color: var(--text-muted);
  cursor: pointer; padding: 0 0.25rem; line-height: 1;
}
.modal__close:hover { color: var(--text-secondary); }
.modal__body { padding: 1rem 1.25rem; overflow-y: auto; flex: 1; }
.modal__footer {
  display: flex; justify-content: flex-end; gap: 0.5rem;
  padding: 0.85rem 1.25rem; border-top: 1px solid var(--border);
}

/* Modal transitions */
.modal-enter-active { animation: modalIn 0.25s ease; }
.modal-leave-active { animation: modalIn 0.15s ease reverse; }
@keyframes modalIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }

/* INI editor */
.ini-editor {
  width: 100%; min-height: 400px; padding: 0.75rem; border-radius: 10px;
  border: 1px solid var(--border-strong); background: var(--bg-input); color: var(--text-secondary);
  font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; line-height: 1.6;
  resize: vertical; tab-size: 4;
}
.ini-editor:focus { outline: none; border-color: var(--primary); }

/* Extensions */
.ext-install-row { display: flex; gap: 0.5rem; margin-bottom: 0.85rem; }
.ext-loading {
  display: flex; align-items: center; gap: 0.5rem; padding: 1.5rem 0;
  color: var(--text-muted); font-size: 0.82rem; justify-content: center;
}
.ext-empty {
  text-align: center; padding: 1.5rem 0; color: var(--text-muted); font-size: 0.82rem;
}
.ext-list {
  display: flex; flex-direction: column; gap: 0.15rem;
  max-height: 360px; overflow-y: auto;
}
.ext-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.5rem 0.6rem; border-radius: 8px;
}
.ext-item:hover { background: var(--bg-input); }
.ext-item__name { font-size: 0.82rem; color: var(--text-secondary); }

/* Toggle switch */
.toggle { position: relative; display: inline-block; width: 36px; height: 20px; }
.toggle input { opacity: 0; width: 0; height: 0; }
.toggle__slider {
  position: absolute; cursor: pointer; inset: 0; border-radius: 20px;
  background: var(--border-strong); transition: all 0.25s;
}
.toggle__slider::before {
  content: ''; position: absolute; width: 14px; height: 14px;
  left: 3px; bottom: 3px; border-radius: 50%;
  background: var(--text-muted); transition: all 0.25s;
}
.toggle input:checked + .toggle__slider { background: var(--primary); }
.toggle input:checked + .toggle__slider::before { transform: translateX(16px); background: #fff; }
.toggle input:disabled + .toggle__slider { opacity: 0.4; cursor: not-allowed; }

@media (max-width: 768px) {
  .php__title { font-size: 1.25rem; }
  .php__grid { grid-template-columns: 1fr; }
  .version-card__header { flex-direction: column; gap: 0.5rem; align-items: flex-start; }
  .install-row { flex-direction: column; }
  .form-select { max-width: 100%; }
  .modal { max-width: 100%; max-height: 90vh; }
  .version-card__actions { flex-direction: column; }
}
</style>
