<template>
  <div class="create-site">
    <!-- Header with back link -->
    <div class="create-site__header">
      <NuxtLink to="/sites" class="create-site__back">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <polyline points="15,18 9,12 15,6" />
        </svg>
        <span>Сайты</span>
      </NuxtLink>
      <h1 class="create-site__title">Создание сайта</h1>
      <p class="create-site__subtitle">Шаг {{ step }} из 2</p>
    </div>

    <!-- Progress bar -->
    <div class="create-site__progress">
      <div class="create-site__progress-bar" :style="{ width: `${(step / 2) * 100}%` }" />
    </div>

    <!-- Step indicators -->
    <div class="create-site__steps">
      <button
        v-for="s in 2"
        :key="s"
        class="create-site__step-dot"
        :class="{ 'create-site__step-dot--active': step === s, 'create-site__step-dot--done': step > s }"
        :disabled="s > step || provisioning"
        @click="s < step && !provisioning ? (step = s) : null"
      >
        <span v-if="step > s" class="create-site__step-check">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20,6 9,17 4,12" /></svg>
        </span>
        <span v-else>{{ s }}</span>
      </button>
    </div>

    <form v-if="!provisioning && !provisionResult" @submit.prevent="handleSubmit">
      <!-- ============================================================ -->
      <!-- STEP 1: Container + multi-domain application rows             -->
      <!-- ============================================================ -->
      <div v-if="step === 1" class="create-site__section">
        <h2 class="create-site__section-title">Контейнер</h2>
        <p class="create-site__section-desc">Имя контейнера — источник Linux-юзера, БД и общего пути сайта.</p>

        <div class="create-site__fields">
          <div class="form-group">
            <label class="form-label">
              Имя Linux-юзера <span class="form-required">*</span>
            </label>
            <input
              v-model="form.name"
              type="text"
              class="form-input form-input--mono"
              placeholder="username"
              maxlength="32"
              pattern="^[a-z][a-z0-9_-]{0,31}$"
              required
              @input="form.name = form.name.toLowerCase()"
            />
            <span class="form-hint">
              Одновременно — имя Linux-юзера, имя БД и имя БД-юзера. Только lowercase, до 32 символов, только [a-z0-9_-], начинается с буквы.
            </span>
          </div>

          <div class="form-group">
            <label class="form-label">Имя сайта</label>
            <input
              v-model="form.displayName"
              type="text"
              class="form-input"
              :placeholder="form.name || 'Мой сайт'"
              maxlength="128"
            />
            <span class="form-hint">
              Человекочитаемое название для списков и карточек сайта.
            </span>
          </div>
        </div>

        <div class="create-site__section-title create-site__section-title--spaced">Домены / приложения</div>
        <p class="create-site__section-desc">Первая строка всегда главный домен (primary). Его нельзя удалить и перенести.
        </p>

        <button
          type="button"
          class="create-site__add-domain"
          @click="addDomain"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Добавить приложение
        </button>

        <div class="create-site__domains">
          <article
            v-for="(domain, domainIndex) in form.domains"
            :key="domain.id"
            class="create-site__domain-card"
          >
            <header class="create-site__domain-header">
              <div class="create-site__domain-title">
                <span class="create-site__domain-title-main">Приложение {{ domainIndex + 1 }}
                  <span v-if="domainIndex === 0" class="create-site__domain-primary">Главный домен</span>
                </span>
                <span class="create-site__domain-preset">{{ presetLabel(domain.preset) }}</span>
              </div>
              <button
                v-if="domainIndex > 0"
                type="button"
                class="create-site__domain-remove"
                @click="removeDomain(domainIndex)"
                title="Удалить приложение"
                aria-label="Удалить приложение"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
                Удалить
              </button>
            </header>

            <DomainApplicationForm
              :model-value="domain"
              :php-versions="phpVersions"
              :modx-revo-versions="modxRevoVersions"
              :modx3-versions="modx3Versions"
              :installed-db-engines="installedDbEngineList"
              :default-db-name="defaultDbName"
              :default-db-user="defaultDbUser"
              :default-files-rel-path="siteDefaults.siteFilesRelativePath"
              @update:model-value="replaceDomain(domainIndex, $event)"
            />
          </article>
        </div>
      </div>

      <!-- ============================================================ -->
      <!-- STEP 2: Review & create                                       -->
      <!-- ============================================================ -->
      <div v-if="step === 2" class="create-site__section">
        <h2 class="create-site__section-title">Проверка</h2>
        <p class="create-site__section-desc">Проверьте параметры перед созданием контейнера и приложений.</p>

        <div class="review-card">
          <div class="review-card__header">
            <SiteTypeIcon :type="(primaryDomain?.preset || 'CUSTOM') as string" />
            <div>
              <h3 class="review-card__name">{{ form.displayName || form.name }}</h3>
              <p class="review-card__domain">{{ primaryDomain?.domain || '—' }}</p>
            </div>
          </div>

          <div class="review-card__grid">
            <div class="review-item">
              <span class="review-item__label">Контейнер</span>
              <span class="review-item__value">{{ form.name }}</span>
            </div>
            <div class="review-item">
              <span class="review-item__label">Приложений</span>
              <span class="review-item__value">{{ form.domains.length }}</span>
            </div>
            <div class="review-item">
              <span class="review-item__label">Главный preset</span>
              <span class="review-item__value">{{ primaryDomain?.preset || 'CUSTOM' }}</span>
            </div>
            <div class="review-item">
              <span class="review-item__label">Путь для веб файлов</span>
              <span class="review-item__value">{{ primaryDomain?.filesRelPath || '' }}</span>
            </div>
          </div>

          <div class="review-card__apps">
            <div
              v-for="(domain, domainIndex) in form.domains"
              :key="domain.id"
              class="review-card__app"
            >
              <div class="review-card__app-head">
                <span class="review-card__app-title">
                  Приложение {{ domainIndex + 1 }}
                  <span v-if="domainIndex === 0" class="review-card__app-badge">primary</span>
                </span>
                <span class="review-card__app-preset">{{ presetLabel(domain.preset) }}</span>
              </div>
              <div class="review-card__app-meta">
                <span>{{ domain.domain || '—' }}</span>
                <span v-if="domain.aliases.filter((a) => a).length">aliases: {{ domain.aliases.filter((a) => a).join(', ') }}</span>
                <span>files: {{ domain.filesRelPath }}</span>
                <span>PHP: {{ domain.phpEnabled ? domain.phpVersion : 'OFF' }}</span>
                <span>
                  DB: {{ domain.dbEnabled || isModxDomain(domain) ? (dbTypeLabel(domain) || 'AUTO') : 'OFF' }}
                </span>
                <span>SSL: {{ domain.sslEnabled ? 'ON' : 'OFF' }}{{ domain.sslEnabled ? ` (https → ${domain.httpsRedirect ? 'on' : 'off'})` : '' }}</span>
                <span v-if="domain.gitRepository && !isModxDomain(domain)">GIT: {{ domain.gitRepository }}</span>
                <span v-if="domain.envVars.some((e) => e.key || e.value)">env-vars: {{ domain.envVars.filter((e) => e.key || e.value).length }}</span>
                <span v-if="isModxDomain(domain) && domain.modxVersion">MODX {{ domain.modxVersion }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Error -->
      <div v-if="error" class="create-site__error">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        {{ error }}
      </div>

      <div class="create-site__actions">
        <button
          v-if="step > 1"
          type="button"
          class="create-site__btn create-site__btn--secondary"
          @click="step--"
        >
          Назад
        </button>
        <div class="create-site__actions-spacer" />
        <button
          v-if="step < 2"
          type="button"
          class="create-site__btn create-site__btn--primary"
          :disabled="!canProceed"
          @click="nextStep"
        >
          Далее
        </button>
        <button
          v-else
          type="submit"
          class="create-site__btn create-site__btn--primary"
          :disabled="submitting || !canSubmit"
          :title="!canSubmit ? submitBlockReason : ''"
        >
          <span v-if="submitting" class="create-site__spinner" />
          {{ submitting ? 'Создание...' : 'Создать сайт' }}
        </button>
      </div>
    </form>

    <!-- ============================================================ -->
    <!-- Live provisioning log                                         -->
    <!-- ============================================================ -->
    <div v-if="provisioning || provisionResult" class="create-site__provision">
      <div class="provision-header">
        <span v-if="provisioning" class="provision-status provision-status--running">
          <span class="create-site__spinner" />
          Идёт создание сайта...
        </span>
        <span v-else-if="provisionResult === 'RUNNING'" class="provision-status provision-status--success">
          ✓ Сайт создан
        </span>
        <span v-else class="provision-status provision-status--error">
          ✗ Ошибка при создании
        </span>
      </div>

      <div ref="logContainer" class="provision-log">
        <div
          v-for="(entry, idx) in provisionLog"
          :key="idx"
          class="provision-log__line"
          :class="`provision-log__line--${entry.level}`"
        >{{ formatTime(entry.timestamp) }} {{ entry.line }}</div>
        <div v-if="!provisionLog.length" class="provision-log__empty">Ожидаем событий от сервера...</div>
      </div>

      <div v-if="provisionResult" class="create-site__actions">
        <NuxtLink
          v-if="provisionResult === 'RUNNING' && createdSiteId"
          :to="`/sites/${createdSiteId}${getCreatedPrimaryDomainId ? `?domain=${getCreatedPrimaryDomainId}` : ''}`"
          class="create-site__btn create-site__btn--primary"
        >
          Открыть сайт
        </NuxtLink>
        <NuxtLink
          v-else-if="createdSiteId"
          :to="`/sites/${createdSiteId}`"
          class="create-site__btn create-site__btn--secondary"
        >
          Открыть сайт (статус ошибки)
        </NuxtLink>
        <NuxtLink
          v-else
          to="/sites"
          class="create-site__btn create-site__btn--secondary"
        >
          К списку сайтов
        </NuxtLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  DEFAULT_MODX_3_VERSIONS,
  DEFAULT_MODX_REVO_VERSIONS,
  DEFAULT_PHP_VERSIONS,
  buildDomainApplicationPayload,
  createDomainApplicationDraft,
  dbEngineOptionsForApplication,
  dbTypeLabel as getDbTypeLabel,
  isDomainValid,
  isModxApplication,
  presetLabel,
  validateDomainApplication,
  type DomainApplicationDraft,
  type DomainApplicationPayload,
} from '~/utils/domain-application';

definePageMeta({ middleware: 'auth' });

type DomainApplication = DomainApplicationDraft;
type DomainPayload = DomainApplicationPayload;

interface SiteRequestPayload {
  name: string;
  displayName?: string;
  domains: DomainPayload[];
}

const api = useApi();
const { onSiteProvisionLog, onSiteProvisionDone } = useSocket();

const step = ref(1);
const submitting = ref(false);
const error = ref('');

const createdSiteId = ref<string>('');
const createdDomainId = ref<string>('');
const provisioning = ref(false);
const provisionResult = ref<'RUNNING' | 'ERROR' | ''>('');
const provisionLog = ref<Array<{ level: 'info' | 'warn' | 'error'; line: string; timestamp: string }>>([]);
const logContainer = ref<HTMLElement | null>(null);

const siteDefaults = reactive({
  siteFilesRelativePath: 'www',
});

const form = reactive({
  name: '',
  displayName: '',
  domains: [] as DomainApplication[],
});

const DEFAULT_DB_USER = 32;

const phpVersions = ref(DEFAULT_PHP_VERSIONS.map((version) => ({ ...version })));
const modxRevoVersions = ref(DEFAULT_MODX_REVO_VERSIONS.map((version) => ({ ...version })));
const modx3Versions = ref(DEFAULT_MODX_3_VERSIONS.map((version) => ({ ...version })));

const installedDbEngines = ref<Set<string>>(new Set());
const installedDbEngineList = computed(() => [...installedDbEngines.value]);

const domainSeq = ref(1);

async function loadSiteDefaults() {
  try {
    const data = await api.get<{ siteFilesRelativePath?: string }>('/panel-settings/site-defaults');
    if (data?.siteFilesRelativePath) {
      siteDefaults.siteFilesRelativePath = data.siteFilesRelativePath;
    }
  } catch {
    /* keep fallback */
  }
  ensureDomainFilesRelPath();
}

function isModxDomain(domain: DomainApplication): boolean {
  return isModxApplication(domain);
}

function makeDomainRow(preset: DomainApplication['preset'] = 'CUSTOM'): DomainApplication {
  return createDomainApplicationDraft({
    id: domainSeq.value++,
    preset,
    filesRelPath: siteDefaults.siteFilesRelativePath || 'www',
    phpVersion: phpVersions.value[0]?.value || '8.2',
    modxRevoVersion: modxRevoVersions.value[0]?.value,
    modx3Version: modx3Versions.value[0]?.value,
  });
}

form.domains = [makeDomainRow()];

function ensureDomainFilesRelPath() {
  const fallback = siteDefaults.siteFilesRelativePath || 'www';
  for (const domain of form.domains) {
    if (!domain.filesRelPath.trim()) domain.filesRelPath = fallback;
  }
}

function addDomain() {
  form.domains.push(makeDomainRow());
}

function removeDomain(index: number) {
  if (index === 0) return;
  form.domains.splice(index, 1);
}

function replaceDomain(index: number, domain: DomainApplication): void {
  form.domains[index] = domain;
}

async function loadInstalledPhpVersions() {
  try {
    const versions = await api.get<string[]>('/php/versions');
    if (Array.isArray(versions) && versions.length) {
      phpVersions.value = [...versions]
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map((v) => ({
          value: v,
          label: /^7\./.test(v) ? `PHP ${v} (EOL)` : `PHP ${v}`,
        }));

      for (const domain of form.domains) {
        if (domain.phpVersion && !phpVersions.value.some((p) => p.value === domain.phpVersion)) {
          domain.phpVersion = phpVersions.value[0]?.value ?? '';
        }
      }
    }
  } catch {
    /* keep fallback */
  }
}

async function loadModxVersions() {
  try {
    const res = await api.get<{
      revo: Array<{ value: string; label: string; isLatest: boolean }>;
      modx3: Array<{ value: string; label: string; isLatest: boolean }>;
    }>('/sites/modx-versions');

    if (res?.revo?.length) modxRevoVersions.value = res.revo.map((v) => ({ value: v.value, label: v.label }));
    if (res?.modx3?.length) modx3Versions.value = res.modx3.map((v) => ({ value: v.value, label: v.label }));
  } catch { /* keep fallback */ }

  for (const domain of form.domains) {
    if (isModxDomain(domain)) {
      const list = domain.preset === 'MODX_3' ? modx3Versions : modxRevoVersions;
      if (list.value[0]) domain.modxVersion = list.value[0].value;
    }
  }
}

async function loadInstalledDbEngines() {
  try {
    const list = await api.get<Array<{ key: string; installed: boolean }>>('/services');
    const values = list.filter((s) => s.installed).map((s) => s.key);
    installedDbEngines.value = new Set(values);
  } catch {
    installedDbEngines.value = new Set(['mariadb', 'postgresql']);
  }

  for (const domain of form.domains) {
    const options = dbEngineOptionsForDomain(domain);
    if (domain.dbEnabled && options.length === 0) {
      domain.dbEnabled = false;
    }
    if (domain.dbEnabled && !domain.dbType) {
      const first = options[0];
      if (first) domain.dbType = first.value;
    }
  }
}

function dbEngineOptionsForDomain(domain: DomainApplication) {
  return dbEngineOptionsForApplication(domain, installedDbEngines.value);
}

function dbTypeLabel(domain: DomainApplication): string {
  return getDbTypeLabel(domain);
}

const primaryDomain = computed(() => form.domains[0]);

const defaultDbName = computed(() => {
  return (form.name || 'site').replace(/-/g, '_').substring(0, 64);
});

const defaultDbUser = computed(() => {
  return (form.name || 'site').replace(/-/g, '_').substring(0, DEFAULT_DB_USER);
});

const canProceed = computed(() => {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(form.name)) return false;
  if (!form.domains.length) return false;

  const seen = new Set<string>();
  for (const domain of form.domains) {
    if (validateDomainApplication(domain, installedDbEngines.value)) return false;
    const primary = domain.domain.trim().toLowerCase();
    if (seen.has(primary)) return false;
    seen.add(primary);

    for (const rawAlias of domain.aliases) {
      const alias = rawAlias.trim().toLowerCase();
      if (!alias) continue;
      if (!isDomainValid(alias)) return false;
      if (seen.has(alias)) return false;
      seen.add(alias);
    }
  }

  return true;
});

const submitBlockReason = computed(() => {
  for (const domain of form.domains) {
    const options = dbEngineOptionsForDomain(domain);
    if (isModxDomain(domain) && options.length === 0) {
      return 'Для MODX нужен MySQL/MariaDB. Установите MariaDB в /services перед созданием.';
    }
    if ((domain.dbEnabled || isModxDomain(domain)) && options.length === 0) {
      return 'Не найден совместимый движок БД на сервере. Проверьте /services.';
    }
  }
  return '';
});

const canSubmit = computed(() => canProceed.value && !submitBlockReason.value);

function nextStep() {
  error.value = '';
  if (!canProceed.value) {
    error.value = 'Проверьте обязательные поля: имя контейнера, каждый домен и путь к веб-файлам.';
    if (submitBlockReason.value) {
      error.value = submitBlockReason.value;
    }
    return;
  }
  if (submitBlockReason.value) {
    error.value = submitBlockReason.value;
    return;
  }
  step.value++;
}

function buildDomainPayload(domain: DomainApplication): DomainPayload {
  return buildDomainApplicationPayload(
    domain,
    phpVersions.value[0]?.value || '8.2',
  );
}

const MAX_LOG_LINES = 2000;

function appendLog(entry: { level: 'info' | 'warn' | 'error'; line: string; timestamp: string }) {
  provisionLog.value.push(entry);
  if (provisionLog.value.length > MAX_LOG_LINES) {
    provisionLog.value.splice(0, provisionLog.value.length - MAX_LOG_LINES);
  }
  nextTick(() => {
    if (logContainer.value) {
      logContainer.value.scrollTop = logContainer.value.scrollHeight;
    }
  });
}

function formatTime(ts: string): string {
  try {
    const date = new Date(ts);
    return date.toLocaleTimeString('ru-RU', { hour12: false });
  } catch {
    return '';
  }
}

async function handleSubmit() {
  if (submitting.value || !canSubmit.value) return;

  error.value = '';
  submitting.value = true;

  try {
    const payload: SiteRequestPayload = {
      name: form.name.trim().toLowerCase(),
      domains: form.domains.map(buildDomainPayload),
    };

    if (form.displayName.trim()) {
      payload.displayName = form.displayName.trim();
    }

    const site = await api.post<{ id: string; primaryDomain?: { id: string } }>(
      '/sites',
      payload,
    );
    createdSiteId.value = site.id;
    createdDomainId.value = site.primaryDomain?.id || '';
    provisioning.value = true;
    provisionLog.value = [];
    provisionResult.value = '';
  } catch (e: unknown) {
    const errorWithMessage = e as { data?: { message?: string | string[] } };
    const msg = errorWithMessage.data?.message;
    error.value = Array.isArray(msg) ? msg.join('; ') : (msg || 'Ошибка создания сайта');
  } finally {
    submitting.value = false;
  }
}

let unsubLog: (() => void) | null = null;
let unsubDone: (() => void) | null = null;

onMounted(() => {
  loadModxVersions();
  loadInstalledDbEngines();
  loadInstalledPhpVersions();
  loadSiteDefaults();

  unsubLog = onSiteProvisionLog((payload) => {
    if (!createdSiteId.value || payload.siteId !== createdSiteId.value) return;
    appendLog({ level: payload.level, line: payload.line, timestamp: payload.timestamp });
  });

  unsubDone = onSiteProvisionDone((payload) => {
    if (!createdSiteId.value || payload.siteId !== createdSiteId.value) return;
    provisioning.value = false;
    provisionResult.value = payload.status;
    if (payload.error) {
      appendLog({ level: 'error', line: `Ошибка: ${payload.error}`, timestamp: payload.timestamp });
    }
  });
});

onBeforeUnmount(() => {
  unsubLog?.();
  unsubDone?.();
});

const getCreatedPrimaryDomainId = computed(() => createdDomainId.value);
</script>

<style scoped>
.create-site {
  max-width: 640px;
}

.create-site__header { margin-bottom: 1.5rem; }

.create-site__back {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.8rem;
  color: var(--text-muted);
  text-decoration: none;
  margin-bottom: 0.75rem;
  transition: color 0.2s;
}

.create-site__back:hover { color: var(--text-secondary); }

.create-site__title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0;
}

.create-site__subtitle {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-top: 0.15rem;
}

.create-site__progress {
  height: 3px;
  background: var(--bar-bg);
  border-radius: 3px;
  margin-bottom: 1.25rem;
  overflow: hidden;
}

.create-site__progress-bar {
  height: 100%;
  background: linear-gradient(90deg, var(--primary), var(--primary-light));
  border-radius: 3px;
  transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

.create-site__steps {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 2rem;
}

.create-site__step-dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1.5px solid var(--border-strong);
  background: var(--bg-surface);
  color: var(--text-faint);
  font-size: 0.7rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s;
}

.create-site__step-dot:disabled { cursor: default; }

.create-site__step-dot--active {
  border-color: var(--primary-text);
  background: var(--primary-bg);
  color: var(--primary-text);
}

.create-site__step-dot--done {
  border-color: rgba(34, 197, 94, 0.3);
  background: rgba(34, 197, 94, 0.1);
  color: var(--success-text);
}

.create-site__step-check { display: flex; }

.create-site__section { margin-bottom: 1.5rem; }

.create-site__section-title {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 0.25rem;
}

.create-site__section-title--spaced { margin-top: 2rem; }

.create-site__section-desc {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin: 0 0 1.25rem;
}

.create-site__domains { display: flex; flex-direction: column; gap: 1rem; }

.create-site__add-domain {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  border: 1px dashed var(--border-strong);
  background: none;
  color: var(--text-muted);
  border-radius: 10px;
  padding: 0.55rem 0.95rem;
  font-size: 0.75rem;
  margin-bottom: 1rem;
  cursor: pointer;
  transition: all 0.2s;
}

.create-site__add-domain:hover {
  color: var(--text-tertiary);
  border-color: var(--border-strong);
}

.create-site__domain-card {
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  background: var(--bg-surface);
  padding: 0.95rem;
}

.create-site__domain-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
}

.create-site__domain-title {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.create-site__domain-title-main {
  font-size: 0.82rem;
  color: var(--text-secondary);
  font-weight: 600;
}

.create-site__domain-primary {
  margin-left: 0.4rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: var(--primary-bg);
  color: var(--primary-text);
  font-size: 0.62rem;
  font-weight: 600;
  text-transform: uppercase;
}

.create-site__domain-preset {
  display: inline-flex;
  align-items: center;
  font-size: 0.68rem;
  color: var(--text-faint);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.create-site__domain-remove {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: none;
  color: var(--text-faint);
  padding: 0.35rem 0.6rem;
  font-size: 0.72rem;
  cursor: pointer;
}

.create-site__domain-remove:hover {
  color: var(--danger-text);
  border-color: var(--danger-border);
}

/* Modules */
.create-site__modules {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-bottom: 1.25rem;
}

.module-card {
  border: 1px solid var(--border-secondary);
  border-radius: 12px;
  background: var(--bg-surface);
  overflow: hidden;
}

.module-card__header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  cursor: pointer;
  user-select: none;
}

.module-card--locked .module-card__header { cursor: default; }

.module-card__checkbox {
  width: 18px;
  height: 18px;
  accent-color: var(--primary-text);
  cursor: pointer;
}

.module-card__checkbox:disabled { cursor: default; }

.module-card__title-wrap {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  flex: 1;
  min-width: 0;
}

.module-card__title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-primary);
}

.module-card__desc {
  font-size: 0.72rem;
  color: var(--text-muted);
}

.module-card__badge {
  font-size: 0.65rem;
  padding: 0.15rem 0.5rem;
  background: var(--primary-bg);
  color: var(--primary-text);
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.module-card__body {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  padding: 0.85rem 1rem 1rem;
  border-top: 1px solid var(--bar-bg);
}

.module-sub {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  color: var(--text-secondary);
  cursor: pointer;
}

.module-sub input { accent-color: var(--primary-text); }

.create-site__group-title {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 0 0 0.25rem;
}

.create-site__group-desc {
  font-size: 0.78rem;
  color: var(--text-muted);
  margin: -0.1rem 0 0.5rem;
  line-height: 1.5;
}

.create-site__group-desc .link {
  color: var(--primary-text);
  text-decoration: none;
}

.create-site__group-desc .link:hover {
  text-decoration: underline;
}

/* Form fields */
.create-site__fields {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

.create-site__fields--group { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--bar-bg); }

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.85rem;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.form-label {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--text-tertiary);
}

.form-required { color: var(--primary-text); }

.form-input {
  background: var(--bg-input);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  padding: 0.6rem 0.85rem;
  font-size: 0.85rem;
  color: var(--text-primary);
  font-family: inherit;
  outline: none;
  transition: all 0.2s;
}

.form-input:focus {
  border-color: var(--primary-border);
  background: var(--bg-input);
  box-shadow: var(--focus-ring);
}

.form-input--mono {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8rem;
}

.form-input--error { border-color: var(--danger-border); }

.form-select-wrap { position: relative; }

.form-select {
  appearance: none;
  width: 100%;
  background: var(--bg-input);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  padding: 0.6rem 2rem 0.6rem 0.85rem;
  font-size: 0.85rem;
  color: var(--text-primary);
  font-family: inherit;
  outline: none;
  cursor: pointer;
  transition: all 0.2s;
}

.form-select:focus {
  border-color: var(--primary-border);
  background: var(--bg-input);
}

.form-select-wrap::after {
  content: '';
  position: absolute;
  right: 0.85rem;
  top: 50%;
  transform: translateY(-50%);
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid var(--text-faint);
  pointer-events: none;
}

.form-input-group { display: flex; gap: 0; }

.form-input--with-btn {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  flex: 1;
}

.form-input-btn {
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border-secondary);
  border-left: none;
  border-radius: 0 10px 10px 0;
  background: var(--bg-surface);
  color: var(--text-muted);
  font-size: 0.72rem;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s;
}

.form-input-btn:hover {
  background: var(--bg-input);
  color: var(--text-secondary);
}

.form-hint {
  font-size: 0.68rem;
  color: var(--text-faint);
}

.alias-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.alias-item {
  display: flex;
  gap: 0.4rem;
}

.alias-item .form-input { flex: 1; }

.alias-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  flex-shrink: 0;
  border-radius: 10px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  color: var(--text-faint);
  cursor: pointer;
  transition: all 0.2s;
}

.alias-remove:hover {
  color: var(--danger-text);
  background: var(--danger-bg);
  border-color: var(--danger-border);
}

.alias-add {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.45rem 0.75rem;
  border-radius: 8px;
  border: 1px dashed var(--border-strong);
  background: none;
  color: var(--text-muted);
  font-size: 0.75rem;
  cursor: pointer;
  transition: all 0.2s;
  align-self: flex-start;
}

.alias-add:hover {
  color: var(--text-tertiary);
  border-color: var(--border-strong);
}

.create-site__env-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.create-site__env-item {
  display: flex;
  gap: 0.45rem;
}

.create-site__env-item .form-input {
  flex: 1;
}

.create-site__env-remove {
  width: 36px;
  border-radius: 10px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  color: var(--text-faint);
  cursor: pointer;
  transition: all 0.2s;
}

.create-site__env-remove:hover {
  color: var(--danger-text);
  background: var(--danger-bg);
  border-color: var(--danger-border);
}

.review-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 16px;
  padding: 1.25rem;
}

.review-card__header {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  margin-bottom: 1.25rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--bar-bg);
}

.review-card__name {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text-heading);
  margin: 0;
}

.review-card__domain {
  font-size: 0.8rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-muted);
  margin: 0.15rem 0 0;
}

.review-card__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.85rem;
  margin-bottom: 1rem;
}

.review-item {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.review-item__label {
  font-size: 0.68rem;
  font-weight: 500;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.review-item__value {
  font-size: 0.82rem;
  color: var(--text-secondary);
}

.review-card__apps {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.review-card__app {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.7rem;
  border: 1px solid var(--bar-bg);
  border-radius: 10px;
  background: var(--bg-surface);
}

.review-card__app-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
}

.review-card__app-title {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.78rem;
  color: var(--text-secondary);
  font-weight: 600;
}

.review-card__app-badge {
  font-size: 0.62rem;
  border-radius: 999px;
  padding: 0.06rem 0.4rem;
  background: var(--primary-bg);
  color: var(--primary-text);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.review-card__app-preset {
  display: inline-flex;
  font-size: 0.64rem;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.review-card__app-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.42rem;
  font-size: 0.72rem;
  color: var(--text-muted);
}

.review-card__app-meta span {
  padding: 0.12rem 0.38rem;
  border-radius: 6px;
  background: var(--bg-surface);
  border: 1px solid var(--bar-bg);
}

.create-site__error {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.65rem 1rem;
  border-radius: 10px;
  background: var(--danger-bg);
  border: 1px solid var(--danger-border);
  color: var(--danger-text);
  font-size: 0.82rem;
  margin-bottom: 1rem;
}

.create-site__actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--bar-bg);
}

.create-site__actions-spacer { flex: 1; }

.create-site__btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.6rem 1.25rem;
  border-radius: 10px;
  font-size: 0.85rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
  text-decoration: none;
}

.create-site__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.create-site__btn--primary {
  background: linear-gradient(135deg, var(--primary-action), var(--primary-action-hover));
  color: var(--primary-action-text);
  box-shadow: var(--shadow-button);
}

.create-site__btn--primary:not(:disabled):hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-button-hover);
}

.create-site__btn--secondary {
  background: var(--bg-input);
  color: var(--text-secondary);
  border: 1px solid var(--border-secondary);
}

.create-site__btn--secondary:hover {
  background: var(--border-secondary);
  color: var(--text-secondary);
}

.create-site__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--spinner-track);
  border-top-color: var(--primary-action-text);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.create-site__provision {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 16px;
  padding: 1.25rem;
}

.provision-header {
  margin-bottom: 1rem;
}

.provision-status {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  font-weight: 600;
}

.provision-status--running { color: var(--primary-text); }
.provision-status--success { color: var(--success-text); }
.provision-status--error { color: var(--danger-text); }

.provision-log {
  background: #0f0f13;
  border: 1px solid var(--border-secondary);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  line-height: 1.55;
  max-height: 560px;
  overflow-y: auto;
  color: #cbd5e1;
  white-space: pre-wrap;
  word-break: break-word;
}

.provision-log__empty {
  color: #64748b;
  font-style: italic;
}

.provision-log__line {
  padding: 1px 0;
}

.provision-log__line--warn { color: var(--primary-text); }
.provision-log__line--error { color: var(--danger-text); }

@media (max-width: 768px) {
  .create-site { max-width: 100%; }
  .form-row { grid-template-columns: 1fr; }
  .create-site__title { font-size: 1.25rem; }
  .review-card__grid { grid-template-columns: 1fr; }
  .create-site__actions { flex-wrap: wrap; }
}
</style>
