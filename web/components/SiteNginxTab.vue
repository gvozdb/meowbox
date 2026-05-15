<template>
  <div class="site-nginx">
    <!-- ─────── Header ─────── -->
    <div class="site-nginx__header">
      <div class="site-nginx__title-block">
        <h3 class="site-nginx__title">Nginx</h3>
        <p class="site-nginx__subtitle">
          Конфиг сайта собирается из нескольких файлов в
          <code>/etc/nginx/meowbox/{{ siteName }}/</code>:
          панель управляет файлами <code>00–50</code> через настройки ниже,
          а файл <code>95-custom.conf</code> ты редактируешь руками сам.
          После любого сохранения автоматически проверяется <code>nginx -t</code>
          и при успехе делается <code>reload</code>.
        </p>
      </div>
      <div class="site-nginx__actions">
        <button class="btn btn--ghost btn--sm" :disabled="testRunning" @click="onTest">
          {{ testRunning ? 'Проверка...' : 'nginx -t' }}
        </button>
        <button class="btn btn--ghost btn--sm" :disabled="reloadRunning" @click="onReload">
          {{ reloadRunning ? 'Reload...' : 'Reload' }}
        </button>
      </div>
    </div>

    <!-- ─────── Уведомление об ошибках/успехе (вверху, рядом с действиями) ─────── -->
    <div v-if="banner" class="site-nginx__banner" :class="`site-nginx__banner--${banner.kind}`">
      <svg v-if="banner.kind === 'ok'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12" /></svg>
      <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
      <span class="site-nginx__banner-text">{{ banner.text }}</span>
      <button class="site-nginx__banner-close" @click="banner = null">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>
    </div>

    <div v-if="loading" class="site-nginx__loading">
      <div class="spinner" /> Загрузка настроек…
    </div>

    <template v-else>
      <!-- ─────── Параметры (00..50 chunks) ─────── -->
      <div class="site-nginx__section">
        <div class="site-nginx__section-header">
          <h4 class="site-nginx__section-title">Параметры</h4>
          <p class="site-nginx__section-hint">
            Любое поле можно оставить пустым — будет применён дефолт (показан в плейсхолдере).
            Поля рендерятся в <code>20-php.conf</code> + <code>10-ssl.conf</code> + <code>40-static.conf</code>.
          </p>
        </div>

        <div class="site-nginx__grid">
          <div class="form-group">
            <label class="form-label">Max body size</label>
            <input
              v-model="form.clientMaxBodySize"
              :placeholder="defaults?.clientMaxBodySize ?? '32M'"
              class="form-input"
              maxlength="16"
            />
            <span class="form-hint">Формат: <code>32M</code>, <code>100M</code>, <code>1G</code></span>
          </div>

          <div class="form-group">
            <label class="form-label">Read timeout (сек)</label>
            <input
              v-model.number="form.fastcgiReadTimeout"
              :placeholder="String(defaults?.fastcgiReadTimeout ?? 60)"
              type="number"
              min="0"
              max="86400"
              class="form-input"
            />
            <span class="form-hint">fastcgi_read_timeout — для медленных PHP-скриптов</span>
          </div>

          <div class="form-group">
            <label class="form-label">Send timeout (сек)</label>
            <input
              v-model.number="form.fastcgiSendTimeout"
              :placeholder="String(defaults?.fastcgiSendTimeout ?? 60)"
              type="number"
              min="0"
              max="86400"
              class="form-input"
            />
            <span class="form-hint">fastcgi_send_timeout</span>
          </div>

          <div class="form-group">
            <label class="form-label">Connect timeout (сек)</label>
            <input
              v-model.number="form.fastcgiConnectTimeout"
              :placeholder="String(defaults?.fastcgiConnectTimeout ?? 60)"
              type="number"
              min="0"
              max="86400"
              class="form-input"
            />
            <span class="form-hint">fastcgi_connect_timeout</span>
          </div>

          <div class="form-group">
            <label class="form-label">Buffer size (KB)</label>
            <input
              v-model.number="form.fastcgiBufferSizeKb"
              :placeholder="String(defaults?.fastcgiBufferSizeKb ?? 32)"
              type="number"
              min="0"
              max="1024"
              class="form-input"
            />
            <span class="form-hint">fastcgi_buffer_size — для крупных headers + меньших буферов</span>
          </div>

          <div class="form-group">
            <label class="form-label">Buffer count</label>
            <input
              v-model.number="form.fastcgiBufferCount"
              :placeholder="String(defaults?.fastcgiBufferCount ?? 16)"
              type="number"
              min="0"
              max="256"
              class="form-input"
            />
            <span class="form-hint">fastcgi_buffers count</span>
          </div>
        </div>

        <div class="site-nginx__toggles">
          <label class="toggle">
            <input v-model="form.http2" type="checkbox" />
            <span>HTTP/2</span>
            <small>(только при включённом SSL)</small>
          </label>
          <label class="toggle">
            <input v-model="form.hsts" type="checkbox" />
            <span>HSTS</span>
            <small>Strict-Transport-Security: max-age=2y; includeSubDomains; preload</small>
          </label>
          <label class="toggle">
            <input v-model="form.gzip" type="checkbox" />
            <span>Gzip</span>
            <small>сжатие text/* и application/json|xml|js</small>
          </label>
        </div>

        <!-- Rate limiting -->
        <div class="site-nginx__rate-limit">
          <div class="site-nginx__rate-limit-head">
            <label class="toggle toggle--strong">
              <input v-model="form.rateLimitEnabled" type="checkbox" />
              <span>Rate limit</span>
              <small>nginx <code>limit_req_zone</code> + <code>limit_req</code> на IP</small>
            </label>
          </div>
          <div v-if="form.rateLimitEnabled" class="site-nginx__rate-limit-grid">
            <div class="form-group">
              <label class="form-label">Запросов в секунду (на IP)</label>
              <input
                v-model.number="form.rateLimitRps"
                :placeholder="String(defaults?.rateLimitRps ?? 30)"
                type="number"
                min="1"
                max="100000"
                class="form-input"
              />
              <span class="form-hint"><code>rate=Xr/s</code> в zone-объявлении</span>
            </div>
            <div class="form-group">
              <label class="form-label">Burst</label>
              <input
                v-model.number="form.rateLimitBurst"
                :placeholder="String(defaults?.rateLimitBurst ?? 60)"
                type="number"
                min="1"
                max="10000"
                class="form-input"
              />
              <span class="form-hint">сколько лишних запросов можно «занять» поверх rate</span>
            </div>
          </div>
        </div>

        <div v-if="settingsNotice" class="site-nginx__notice" :class="`site-nginx__notice--${settingsNotice.kind}`">
          {{ settingsNotice.text }}
        </div>

        <div class="site-nginx__settings-actions">
          <button class="btn btn--ghost btn--sm" :disabled="settingsSaving || !settingsDirty" @click="resetSettings">
            Сбросить изменения
          </button>
          <button class="btn btn--primary" :disabled="settingsSaving || !settingsDirty" @click="saveSettings">
            <span v-if="settingsSaving" class="spinner" />
            {{ settingsSaving ? 'Сохранение...' : 'Сохранить параметры' }}
          </button>
        </div>
      </div>

      <!-- ─────── Кастомный блок ─────── -->
      <div class="site-nginx__section">
        <div class="site-nginx__section-header">
          <h4 class="site-nginx__section-title">Кастомный блок (<code>95-custom.conf</code>)</h4>
          <p class="site-nginx__section-hint">
            Этот файл инклюдится внутрь основного <code>server { ... }</code>-блока и НИКОГДА не
            перезаписывается панелью при изменении других настроек. При установке CMS сюда
            автоматически записываются стартовые правила (try_files / rewrites) — их можно
            свободно редактировать.
          </p>
        </div>

        <textarea
          v-model="customDraft"
          class="site-nginx__editor"
          spellcheck="false"
          placeholder="# Свои директивы здесь, например:
location /api/ {
    proxy_pass http://127.0.0.1:8080;
}"
        />

        <div v-if="customNotice" class="site-nginx__notice" :class="`site-nginx__notice--${customNotice.kind}`">
          {{ customNotice.text }}
        </div>

        <div class="site-nginx__custom-actions">
          <button class="btn btn--ghost btn--sm" :disabled="customSaving || !customDirty" @click="resetCustom">
            Сбросить
          </button>
          <button class="btn btn--primary" :disabled="customSaving || !customDirty" @click="saveCustom">
            <span v-if="customSaving" class="spinner" />
            {{ customSaving ? 'Сохранение...' : 'Сохранить и применить' }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

interface ResolvedNginxSettings {
  clientMaxBodySize: string;
  fastcgiReadTimeout: number;
  fastcgiSendTimeout: number;
  fastcgiConnectTimeout: number;
  fastcgiBufferSizeKb: number;
  fastcgiBufferCount: number;
  http2: boolean;
  hsts: boolean;
  gzip: boolean;
  rateLimitEnabled: boolean;
  rateLimitRps: number;
  rateLimitBurst: number;
}

interface SiteNginxOverrides {
  clientMaxBodySize?: string | null;
  fastcgiReadTimeout?: number | null;
  fastcgiSendTimeout?: number | null;
  fastcgiConnectTimeout?: number | null;
  fastcgiBufferSizeKb?: number | null;
  fastcgiBufferCount?: number | null;
  http2?: boolean | null;
  hsts?: boolean | null;
  gzip?: boolean | null;
  rateLimitEnabled?: boolean | null;
  rateLimitRps?: number | null;
  rateLimitBurst?: number | null;
}

interface NginxSettingsResponse {
  raw: SiteNginxOverrides;
  effective: ResolvedNginxSettings;
  defaults: ResolvedNginxSettings;
  meta: { fastcgiSubBufferKb: number };
}

const props = defineProps<{
  siteId: string;
  siteName: string;
  /** Основной домен, чей nginx-конфиг редактируется. */
  domainId: string;
}>();

const api = useApi();
const toast = useMbToast();

const loading = ref(false);
const settingsSaving = ref(false);
const customSaving = ref(false);
const testRunning = ref(false);
const reloadRunning = ref(false);

const defaults = ref<ResolvedNginxSettings | null>(null);

interface FormShape {
  clientMaxBodySize: string;
  fastcgiReadTimeout: number | null;
  fastcgiSendTimeout: number | null;
  fastcgiConnectTimeout: number | null;
  fastcgiBufferSizeKb: number | null;
  fastcgiBufferCount: number | null;
  http2: boolean;
  hsts: boolean;
  gzip: boolean;
  rateLimitEnabled: boolean;
  rateLimitRps: number | null;
  rateLimitBurst: number | null;
}

const form = ref<FormShape>(blankForm());
const formOriginal = ref<FormShape>(blankForm());

const customDraft = ref('');
const customOriginal = ref('');

const banner = ref<{ kind: 'ok' | 'err'; text: string } | null>(null);
let bannerTimer: ReturnType<typeof setTimeout> | null = null;

// Локальные нотисы рядом с действиями секции — видны прямо у кнопки сохранения.
const settingsNotice = ref<{ kind: 'ok' | 'err'; text: string } | null>(null);
const customNotice = ref<{ kind: 'ok' | 'err'; text: string } | null>(null);

function blankForm(): FormShape {
  return {
    clientMaxBodySize: '',
    fastcgiReadTimeout: null,
    fastcgiSendTimeout: null,
    fastcgiConnectTimeout: null,
    fastcgiBufferSizeKb: null,
    fastcgiBufferCount: null,
    http2: true,
    hsts: false,
    gzip: true,
    rateLimitEnabled: true,
    rateLimitRps: null,
    rateLimitBurst: null,
  };
}

const settingsDirty = computed(() => JSON.stringify(form.value) !== JSON.stringify(formOriginal.value));
const customDirty = computed(() => customDraft.value !== customOriginal.value);

function showBanner(kind: 'ok' | 'err', text: string, ttl = 4000) {
  banner.value = { kind, text };
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { banner.value = null; }, ttl);
}

/** База per-domain nginx-эндпоинтов (settings / custom). */
function nginxBase(): string {
  return `/sites/${props.siteId}/domains/${props.domainId}/nginx`;
}

async function loadAll() {
  if (!props.domainId) {
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const [settings, custom] = await Promise.all([
      api.get<NginxSettingsResponse>(`${nginxBase()}/settings`),
      api.get<{ content: string }>(`${nginxBase()}/custom`),
    ]);

    defaults.value = settings.defaults;
    const f: FormShape = {
      clientMaxBodySize: settings.raw.clientMaxBodySize ?? '',
      fastcgiReadTimeout: settings.raw.fastcgiReadTimeout ?? null,
      fastcgiSendTimeout: settings.raw.fastcgiSendTimeout ?? null,
      fastcgiConnectTimeout: settings.raw.fastcgiConnectTimeout ?? null,
      fastcgiBufferSizeKb: settings.raw.fastcgiBufferSizeKb ?? null,
      fastcgiBufferCount: settings.raw.fastcgiBufferCount ?? null,
      http2: settings.raw.http2 ?? settings.defaults.http2,
      hsts: settings.raw.hsts ?? settings.defaults.hsts,
      gzip: settings.raw.gzip ?? settings.defaults.gzip,
      rateLimitEnabled: settings.raw.rateLimitEnabled ?? settings.defaults.rateLimitEnabled,
      rateLimitRps: settings.raw.rateLimitRps ?? null,
      rateLimitBurst: settings.raw.rateLimitBurst ?? null,
    };
    form.value = f;
    formOriginal.value = JSON.parse(JSON.stringify(f));

    customDraft.value = custom.content ?? '';
    customOriginal.value = customDraft.value;
  } catch (e) {
    showBanner('err', `Не удалось загрузить настройки: ${(e as Error).message}`, 6000);
  } finally {
    loading.value = false;
  }
}

function buildSettingsPayload() {
  const f = form.value;
  return {
    clientMaxBodySize: f.clientMaxBodySize.trim() || null,
    fastcgiReadTimeout: f.fastcgiReadTimeout || null,
    fastcgiSendTimeout: f.fastcgiSendTimeout || null,
    fastcgiConnectTimeout: f.fastcgiConnectTimeout || null,
    fastcgiBufferSizeKb: f.fastcgiBufferSizeKb || null,
    fastcgiBufferCount: f.fastcgiBufferCount || null,
    http2: f.http2,
    hsts: f.hsts,
    gzip: f.gzip,
    rateLimitEnabled: f.rateLimitEnabled,
    rateLimitRps: f.rateLimitRps || null,
    rateLimitBurst: f.rateLimitBurst || null,
  };
}

async function saveSettings() {
  if (!settingsDirty.value) return;
  settingsSaving.value = true;
  try {
    const r = await api.put<NginxSettingsResponse>(`${nginxBase()}/settings`, buildSettingsPayload());
    defaults.value = r.defaults;
    formOriginal.value = JSON.parse(JSON.stringify(form.value));
    showBanner('ok', 'Параметры сохранены, конфиг nginx обновлён.');
    toast.success('Nginx-параметры сохранены, конфиг обновлён');
  } catch (e) {
    showBanner('err', `Не удалось сохранить: ${(e as Error).message}`, 8000);
    toast.error(`Не удалось сохранить nginx-параметры: ${(e as Error).message}`);
  } finally {
    settingsSaving.value = false;
  }
}

function resetSettings() {
  form.value = JSON.parse(JSON.stringify(formOriginal.value));
}

async function saveCustom() {
  if (!customDirty.value) return;
  customSaving.value = true;
  try {
    const r = await api.put<{ content: string }>(`${nginxBase()}/custom`, {
      content: customDraft.value,
    });
    customOriginal.value = r.content ?? customDraft.value;
    customDraft.value = customOriginal.value;
    showBanner('ok', 'Кастом-блок сохранён и применён.');
    toast.success('Кастомный nginx-блок сохранён и применён');
  } catch (e) {
    showBanner('err', `nginx -t упал: ${(e as Error).message}`, 10000);
    toast.error(`Кастом-блок не применён: ${(e as Error).message}`);
  } finally {
    customSaving.value = false;
  }
}

function resetCustom() {
  customDraft.value = customOriginal.value;
}

async function onTest() {
  testRunning.value = true;
  try {
    const r = await api.post<{ success: boolean; error?: string }>(
      `/sites/${props.siteId}/nginx/test`, {},
    );
    if (r.success) {
      showBanner('ok', 'nginx -t: OK');
      toast.success('nginx -t: конфигурация валидна');
    } else {
      showBanner('err', `nginx -t failed: ${r.error}`, 8000);
      toast.error(`nginx -t упал: ${r.error}`);
    }
  } catch (e) {
    showBanner('err', `Test failed: ${(e as Error).message}`, 8000);
    toast.error(`Проверка nginx упала: ${(e as Error).message}`);
  } finally {
    testRunning.value = false;
  }
}

async function onReload() {
  reloadRunning.value = true;
  try {
    const r = await api.post<{ success: boolean; error?: string }>(
      `/sites/${props.siteId}/nginx/reload`, {},
    );
    if (r.success) {
      showBanner('ok', 'Nginx reloaded.');
      toast.success('Nginx перезагружен');
    } else {
      showBanner('err', `Reload failed: ${r.error}`, 8000);
      toast.error(`Reload nginx упал: ${r.error}`);
    }
  } catch (e) {
    showBanner('err', `Reload failed: ${(e as Error).message}`, 8000);
    toast.error(`Reload nginx упал: ${(e as Error).message}`);
  } finally {
    reloadRunning.value = false;
  }
}

watch(() => [props.siteId, props.domainId], () => loadAll());
onMounted(() => loadAll());
</script>

<style scoped>
.site-nginx {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.site-nginx__header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
.site-nginx__title-block {
  flex: 1;
  min-width: 0;
}
.site-nginx__title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-heading);
  margin: 0 0 0.3rem;
}
.site-nginx__subtitle {
  font-size: 0.78rem;
  color: var(--text-tertiary);
  line-height: 1.5;
  margin: 0;
}
.site-nginx__actions {
  display: flex;
  gap: 0.4rem;
}

.site-nginx__loading {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: var(--text-tertiary);
  padding: 1.5rem 0;
}

.site-nginx__section {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 12px;
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}
.site-nginx__section-header {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.site-nginx__section-title {
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--text-heading);
  margin: 0;
}
.site-nginx__section-hint {
  font-size: 0.74rem;
  color: var(--text-tertiary);
  line-height: 1.5;
  margin: 0;
}

.site-nginx__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.75rem;
}

.site-nginx__toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 0.85rem;
  padding-top: 0.3rem;
  border-top: 1px dashed var(--border-secondary);
  padding: 0.75rem 0 0;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: var(--text-secondary);
  cursor: pointer;
}
.toggle input { accent-color: var(--primary, var(--primary)); }
.toggle small {
  color: var(--text-muted);
  font-size: 0.72rem;
}
.toggle--strong { font-weight: 600; color: var(--text-heading); }

.site-nginx__rate-limit {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  padding: 0.85rem 0.95rem;
  border: 1px dashed var(--border-secondary);
  border-radius: 10px;
  background: rgba(var(--primary-rgb), 0.04);
}
.site-nginx__rate-limit-head { }
.site-nginx__rate-limit-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.75rem;
}

.site-nginx__settings-actions,
.site-nginx__custom-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.25rem;
}

.site-nginx__editor {
  width: 100%;
  box-sizing: border-box;
  min-height: 320px;
  background: var(--bg-input);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  padding: 0.85rem 1rem;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.82rem;
  line-height: 1.55;
  color: var(--text-primary);
  resize: vertical;
  outline: none;
  white-space: pre;
  tab-size: 4;
}
.site-nginx__editor:focus {
  border-color: rgba(var(--primary-rgb), 0.5);
  box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.08);
}

.site-nginx__banner {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.7rem 0.9rem;
  border-radius: 10px;
  font-size: 0.82rem;
  line-height: 1.45;
  word-break: break-word;
}
.site-nginx__banner svg { flex-shrink: 0; margin-top: 0.1rem; }
.site-nginx__banner-text { flex: 1; min-width: 0; }
.site-nginx__banner-close {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: currentColor;
  opacity: 0.65;
  cursor: pointer;
  border-radius: 6px;
  transition: opacity 0.15s, background 0.15s;
}
.site-nginx__banner-close:hover { opacity: 1; background: rgba(255, 255, 255, 0.08); }
.site-nginx__banner--ok {
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.35);
  color: #4ade80;
}
.site-nginx__banner--err {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.35);
  color: #fca5a5;
}
.site-nginx__banner--err .site-nginx__banner-text {
  white-space: pre-wrap;
  font-family: 'JetBrains Mono', monospace;
}

/* ─────────── shared (повторяет SiteDatabasesTab — scoped CSS изолирован, надо своё) ─────────── */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.55rem 1rem;
  border-radius: 10px;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-primary);
  transition: all 0.15s;
  font-family: inherit;
}
.btn:hover:not(:disabled) { transform: translateY(-1px); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn--sm { padding: 0.4rem 0.75rem; font-size: 0.75rem; border-radius: 8px; }
.btn--primary {
  background: var(--primary, var(--primary));
  color: var(--text-inverse, #1c1917);
}
.btn--primary:hover:not(:disabled) { background: var(--primary-strong, var(--primary-light)); }
.btn--ghost {
  border-color: var(--border-secondary);
  color: var(--text-secondary);
  background: transparent;
}
.btn--ghost:hover:not(:disabled) {
  background: var(--bg-input);
  border-color: var(--border-strong);
}

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
  padding: 0.55rem 0.8rem;
  font-size: 0.85rem;
  color: var(--text-primary);
  font-family: 'JetBrains Mono', monospace;
  outline: none;
  transition: all 0.2s;
}
.form-input:focus {
  border-color: rgba(var(--primary-rgb), 0.4);
  box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.08);
}
.form-hint {
  font-size: 0.72rem;
  color: var(--text-muted);
  line-height: 1.4;
}

.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--primary, var(--primary));
  border-radius: 50%;
  animation: site-nginx-spin 0.8s linear infinite;
  vertical-align: middle;
  margin-right: 0.3rem;
}
@keyframes site-nginx-spin { to { transform: rotate(360deg); } }

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
