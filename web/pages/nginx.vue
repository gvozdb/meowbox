<template>
  <div class="nginx">
    <div class="nginx__header">
      <div>
        <h1 class="nginx__title">Nginx</h1>
        <p class="nginx__subtitle">Web server configuration</p>
      </div>
      <div class="nginx__actions">
        <button class="btn btn--ghost btn--sm" :disabled="testing" @click="testConfig">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20,6 9,17 4,12" /></svg>
          {{ testing ? 'Testing...' : 'Test Config' }}
        </button>
        <button class="btn btn--primary btn--sm" :disabled="reloading" @click="reloadNginx">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23,4 23,10 17,10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
          {{ reloading ? 'Reloading...' : 'Reload' }}
        </button>
      </div>
    </div>

    <!-- Status bar -->
    <div class="status-bar">
      <div class="status-bar__item">
        <span class="status-dot" :class="status.running ? 'status-dot--ok' : 'status-dot--err'" />
        <span class="status-bar__label">{{ status.running ? 'Running' : 'Stopped' }}</span>
      </div>
      <div v-if="status.version" class="status-bar__item">
        <span class="status-bar__label">Version</span>
        <span class="status-bar__value mono">{{ status.version }}</span>
      </div>
      <div class="status-bar__item">
        <span class="status-bar__label">Configs</span>
        <span class="status-bar__value">{{ configs.length }}</span>
      </div>
    </div>

    <!-- Global config toggle -->
    <div class="global-toggle">
      <button
        class="global-toggle__btn"
        :class="{ 'global-toggle__btn--active': !showGlobal }"
        @click="showGlobal = false"
      >Site Configs</button>
      <button
        class="global-toggle__btn"
        :class="{ 'global-toggle__btn--active': showGlobal }"
        @click="showGlobal = true; loadGlobalConfig()"
      >Global Config</button>
    </div>

    <!-- Global nginx.conf editor -->
    <div v-if="showGlobal" class="global-editor">
      <div class="editor-panel">
        <div class="editor-panel__header">
          <span class="editor-panel__filename mono">/etc/nginx/nginx.conf</span>
          <div class="editor-panel__btns">
            <button class="btn btn--ghost btn--sm" :disabled="!globalModified" @click="globalContent = globalOriginal">Discard</button>
            <button class="btn btn--primary btn--sm" :disabled="!globalModified || savingGlobal" @click="saveGlobalConfig">
              {{ savingGlobal ? 'Saving...' : 'Save & Reload' }}
            </button>
          </div>
        </div>
        <div class="editor-panel__body">
          <textarea
            v-if="!loadingGlobal"
            v-model="globalContent"
            class="editor-textarea mono"
            spellcheck="false"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
          />
          <div v-else class="editor-panel__empty">
            <div class="spinner" />
          </div>
        </div>
      </div>
    </div>

    <!-- Config list + Editor -->
    <div v-show="!showGlobal" class="nginx__body">
      <!-- Config list -->
      <div class="config-list">
        <div class="config-list__header">
          <h2 class="config-list__title">Site Configs</h2>
        </div>
        <div v-if="loadingConfigs" class="config-list__loading">
          <div class="spinner" />
        </div>
        <div v-else-if="!configs.length" class="config-list__empty">
          <p>No configs found</p>
        </div>
        <div v-else class="config-list__items">
          <button
            v-for="cfg in configs"
            :key="cfg.domain"
            class="config-item"
            :class="{ 'config-item--active': selectedDomain === cfg.domain }"
            @click="selectConfig(cfg.domain)"
          >
            <span class="config-item__domain">{{ cfg.domain }}</span>
            <span v-if="cfg.siteName" class="config-item__site">{{ cfg.siteName }}</span>
          </button>
        </div>
      </div>

      <!-- Editor -->
      <div class="editor-panel">
        <div v-if="!selectedDomain" class="editor-panel__empty">
          <CatMascot :size="64" mood="sleepy" />
          <p>Select a config to edit</p>
        </div>
        <template v-else>
          <div class="editor-panel__header">
            <span class="editor-panel__filename mono">{{ selectedDomain }}.conf</span>
            <div class="editor-panel__btns">
              <button class="btn btn--ghost btn--sm" :disabled="!configModified" @click="resetConfig">Discard</button>
              <button class="btn btn--primary btn--sm" :disabled="!configModified || saving" @click="saveConfig">
                {{ saving ? 'Saving...' : 'Save & Reload' }}
              </button>
            </div>
          </div>
          <div class="editor-panel__body">
            <textarea
              v-model="configContent"
              class="editor-textarea mono"
              spellcheck="false"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
            />
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface NginxConfig { domain: string; enabled: boolean; siteName?: string; siteId?: string; }
interface NginxStatus { running: boolean; version: string | null; }

const api = useApi();
const status = ref<NginxStatus>({ running: false, version: null });
const configs = ref<NginxConfig[]>([]);
const loadingConfigs = ref(true);
const selectedDomain = ref('');
const configContent = ref('');
const originalContent = ref('');
const testing = ref(false);
const reloading = ref(false);
const saving = ref(false);
const showGlobal = ref(false);
const globalContent = ref('');
const globalOriginal = ref('');
const loadingGlobal = ref(false);
const savingGlobal = ref(false);
const globalModified = computed(() => globalContent.value !== globalOriginal.value);

const toast = useMbToast();
const configModified = computed(() => configContent.value !== originalContent.value);

function showToast(msg: string, isError = false) {
  if (isError) toast.error(msg);
  else toast.success(msg);
}

async function loadStatus() {
  try {
    const res = await api.get<NginxStatus>('/nginx/status');
    status.value = res;
  } catch { /* ignore */ }
}

async function loadConfigs() {
  loadingConfigs.value = true;
  try {
    configs.value = await api.get<NginxConfig[]>('/nginx/configs');
  } catch {
    configs.value = [];
  } finally {
    loadingConfigs.value = false;
  }
}

async function selectConfig(domain: string) {
  selectedDomain.value = domain;
  try {
    const content = await api.get<string>(`/nginx/configs/${domain}`);
    configContent.value = content || '';
    originalContent.value = configContent.value;
  } catch {
    showToast('Failed to load config', true);
  }
}

function resetConfig() {
  configContent.value = originalContent.value;
}

async function saveConfig() {
  saving.value = true;
  try {
    await api.put(`/nginx/configs/${selectedDomain.value}`, { config: configContent.value });
    originalContent.value = configContent.value;
    showToast('Config saved and nginx reloaded');
  } catch (err) {
    showToast((err as Error).message || 'Failed to save config (nginx -t failed)', true);
  } finally {
    saving.value = false;
  }
}

async function testConfig() {
  testing.value = true;
  try {
    const result = await api.post<{ valid: boolean; output?: string }>('/nginx/test');
    if (result.valid) {
      showToast('Config is valid');
    } else {
      showToast(`Config invalid: ${result.output}`, true);
    }
  } catch {
    showToast('Failed to test config', true);
  } finally {
    testing.value = false;
  }
}

async function loadGlobalConfig() {
  if (globalContent.value) return; // already loaded
  loadingGlobal.value = true;
  try {
    const data = await api.get<{ content: string }>('/nginx/global-config');
    globalContent.value = data.content || '';
    globalOriginal.value = globalContent.value;
  } catch {
    showToast('Failed to load global config', true);
  } finally {
    loadingGlobal.value = false;
  }
}

async function saveGlobalConfig() {
  savingGlobal.value = true;
  try {
    await api.put('/nginx/global-config', { content: globalContent.value });
    globalOriginal.value = globalContent.value;
    showToast('Global config saved and nginx reloaded');
  } catch {
    showToast('Failed to save global config (nginx -t failed?)', true);
  } finally {
    savingGlobal.value = false;
  }
}

async function reloadNginx() {
  reloading.value = true;
  try {
    await api.post('/nginx/reload');
    showToast('Nginx reloaded');
    await loadStatus();
  } catch {
    showToast('Failed to reload', true);
  } finally {
    reloading.value = false;
  }
}

onMounted(async () => {
  await Promise.all([loadStatus(), loadConfigs()]);
});
</script>

<style scoped>
.nginx__header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 1rem; gap: 1rem; }
.nginx__title { font-size: 1.5rem; font-weight: 700; color: var(--text-heading); margin: 0; }
.nginx__subtitle { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.15rem; }
.nginx__actions { display: flex; gap: 0.4rem; }

/* Status bar */
.status-bar {
  display: flex; align-items: center; gap: 1.5rem; padding: 0.65rem 1rem;
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 12px; margin-bottom: 1rem;
}
.status-bar__item { display: flex; align-items: center; gap: 0.4rem; }
.status-bar__label { font-size: 0.72rem; color: var(--text-muted); }
.status-bar__value { font-size: 0.78rem; color: var(--text-secondary); }
.status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.status-dot--ok { background: #4ade80; box-shadow: 0 0 6px rgba(74, 222, 128, 0.4); }
.status-dot--err { background: #f87171; box-shadow: 0 0 6px rgba(248, 113, 113, 0.4); }

/* Global toggle */
.global-toggle {
  display: flex; gap: 0.25rem; margin-bottom: 1rem;
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 10px; padding: 0.25rem; width: fit-content;
}
.global-toggle__btn {
  padding: 0.4rem 0.85rem; border-radius: 8px; border: none;
  background: transparent; color: var(--text-muted);
  font-size: 0.78rem; font-weight: 600; font-family: inherit;
  cursor: pointer; transition: all 0.15s;
}
.global-toggle__btn:hover { color: var(--text-secondary); }
.global-toggle__btn--active {
  background: var(--primary-bg); color: var(--primary-text);
}

.global-editor { min-height: 500px; display: flex; flex-direction: column; }
.global-editor .editor-panel { flex: 1; display: flex; flex-direction: column; }
.global-editor .editor-panel__body { flex: 1; }
.global-editor .editor-textarea { min-height: 460px; }

/* Body layout */
.nginx__body { display: grid; grid-template-columns: 240px 1fr; gap: 0.75rem; min-height: 500px; }

/* Config list */
.config-list {
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 14px; overflow: hidden; display: flex; flex-direction: column;
}
.config-list__header { padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); }
.config-list__title { font-size: 0.78rem; font-weight: 600; color: var(--text-tertiary); margin: 0; text-transform: uppercase; letter-spacing: 0.04em; }
.config-list__loading { display: flex; justify-content: center; padding: 2rem; }
.config-list__empty { display: flex; justify-content: center; padding: 2rem; color: var(--text-muted); font-size: 0.8rem; }
.config-list__items { flex: 1; overflow-y: auto; padding: 0.35rem; }

.config-item {
  display: flex; flex-direction: column; gap: 0.1rem; width: 100%;
  padding: 0.55rem 0.75rem; border: none; background: none;
  border-radius: 8px; cursor: pointer; text-align: left;
  transition: all 0.15s; font-family: inherit;
}
.config-item:hover { background: var(--bg-elevated); }
.config-item--active { background: var(--primary-bg); }
.config-item__domain { font-size: 0.8rem; font-weight: 500; color: var(--text-secondary); }
.config-item--active .config-item__domain { color: var(--primary-text); }
.config-item__site { font-size: 0.65rem; color: var(--text-faint); }
.config-item--active .config-item__site { color: var(--text-muted); }

/* Editor panel */
.editor-panel {
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 14px; overflow: hidden; display: flex; flex-direction: column;
}
.editor-panel__empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex: 1; gap: 0.75rem; color: var(--text-muted); font-size: 0.85rem;
}
.editor-panel__header {
  display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
  padding: 0.65rem 1rem; border-bottom: 1px solid var(--border);
}
.editor-panel__filename { font-size: 0.78rem; color: var(--text-tertiary); }
.editor-panel__btns { display: flex; gap: 0.35rem; }
.editor-panel__body { flex: 1; position: relative; }

.editor-textarea {
  width: 100%; height: 100%; min-height: 460px; resize: none;
  padding: 1rem; border: none; outline: none;
  background: var(--bg-code); color: var(--text-primary);
  font-size: 0.78rem; line-height: 1.55; tab-size: 4;
}

/* Shared */
.mono { font-family: 'JetBrains Mono', monospace; }

.spinner { width: 20px; height: 20px; border: 2px solid var(--spinner-track); border-top-color: var(--primary); border-radius: 50%; animation: spin 0.8s linear infinite; }

.btn {
  display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.55rem 1rem;
  border-radius: 10px; border: none; font-size: 0.82rem; font-weight: 600;
  font-family: inherit; cursor: pointer; transition: all 0.2s; white-space: nowrap;
}
.btn--sm { padding: 0.4rem 0.8rem; font-size: 0.75rem; border-radius: 8px; }
.btn--primary { background: linear-gradient(135deg, #fbbf24, #d97706); color: var(--primary-text-on); }
.btn--primary:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(245, 158, 11, 0.2); }
.btn--primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--ghost { background: var(--bg-input); border: 1px solid var(--border-strong); color: var(--text-tertiary); }
.btn--ghost:hover:not(:disabled) { color: var(--text-secondary); border-color: var(--border-strong); }
.btn--ghost:disabled { opacity: 0.4; cursor: not-allowed; }

@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 768px) {
  .nginx__header { flex-direction: column; gap: 0.75rem; }
  .nginx__title { font-size: 1.25rem; }
  .nginx__body { grid-template-columns: 1fr; min-height: auto; }
  .config-list { max-height: 200px; }
  .editor-textarea { min-height: 320px; }
  .status-bar { flex-wrap: wrap; gap: 0.75rem; }
}
</style>
