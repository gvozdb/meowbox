<template>
  <div class="domains-tab">
    <div v-if="anyCoverageProblem" class="domains-tab__alert">
      <strong>SSL покрывает не все hostname.</strong>
      <span>Перевыпусти сертификат нужного приложения после изменения домена или алиасов.</span>
    </div>

    <DomainOperationProgress
      v-if="activeOperationId"
      :operation-id="activeOperationId"
      @finished="onOperationFinished"
    />

    <section class="domains-tab__card">
      <header class="domains-tab__header">
        <div>
          <h3>Домены / приложения</h3>
          <p>Каждая строка — отдельное приложение. Алиасы используют приложение своего домена.</p>
        </div>
        <button class="btn btn--primary btn--sm" :disabled="busy" @click="openAddModal">
          + Добавить приложение
        </button>
      </header>

      <div v-if="domains.length" class="domains-tab__list">
        <article
          v-for="domain in domains"
          :key="domain.id"
          class="domain-row"
          :class="{ 'domain-row--primary': domain.isPrimary }"
        >
          <button
            class="domain-row__primary"
            :class="{ 'domain-row__primary--active': domain.isPrimary }"
            :disabled="busy || domain.isPrimary"
            :title="domain.isPrimary ? 'Главное приложение сайта' : 'Сделать главным'"
            @click="onMakePrimary(domain)"
          >
            ★
          </button>

          <div class="domain-row__main">
            <div class="domain-row__title">
              <a :href="domainUrl(domain)" target="_blank" rel="noopener noreferrer">
                {{ domain.domain }}
              </a>
              <span class="domain-row__preset">{{ presetLabel(domain.preset) }}</span>
              <span class="domain-row__status" :class="`domain-row__status--${domain.appStatus.toLowerCase()}`">
                {{ appStatusLabel(domain.appStatus) }}
              </span>
              <span
                v-if="coverageState(domain) !== 'no-cert'"
                class="domain-row__ssl"
                :class="`domain-row__ssl--${coverageState(domain)}`"
                :title="coverageTitle(domain)"
              >
                {{ coverageState(domain) === 'covered' ? 'SSL ✓' : 'SSL !' }}
              </span>
            </div>

            <div class="domain-row__meta">
              <code>{{ domain.filesRelPath }}</code>
              <span>{{ domain.phpVersion ? `PHP ${domain.phpVersion}` : 'без PHP' }}</span>
              <span v-if="domain.aliases.length">
                aliases: {{ domain.aliases.map((alias) => alias.domain).join(', ') }}
              </span>
              <span v-else>без алиасов</span>
            </div>
            <p v-if="domain.appErrorMessage" class="domain-row__error">
              {{ domain.appErrorMessage }}
            </p>
          </div>

          <div class="domain-row__actions">
            <button class="btn btn--ghost btn--xs" :disabled="busy" @click="openEditModal(domain)">
              Изменить
            </button>
            <button class="btn btn--ghost btn--xs" :disabled="busy" @click="openAliasesModal(domain)">
              Алиасы
            </button>
            <button class="btn btn--ghost btn--xs" :disabled="busy" @click="emit('navigate-ssl', domain.id)">
              SSL
            </button>
            <button class="btn btn--ghost btn--xs" :disabled="busy" @click="emit('navigate-nginx', domain.id)">
              Nginx
            </button>
            <button
              class="domain-row__delete"
              :disabled="busy || domain.isPrimary || domains.length <= 1"
              :title="domain.isPrimary ? 'Сначала назначь главным другое приложение' : 'Удалить приложение'"
              @click="openDeleteModal(domain)"
            >
              ×
            </button>
          </div>
        </article>
      </div>
      <div v-else class="domains-tab__empty">Приложения не найдены.</div>
    </section>

    <Teleport to="body">
      <div v-if="addOpen && addDraft" class="domain-modal-overlay" @mousedown.self="closeAddModal">
        <section class="domain-modal domain-modal--wide">
          <header class="domain-modal__header">
            <div>
              <h3>Новое приложение</h3>
              <p>Будет создан отдельный runtime для нового основного домена.</p>
            </div>
            <button :disabled="busy" @click="closeAddModal">×</button>
          </header>

          <div class="domain-modal__body">
            <DomainApplicationForm
              v-model="addDraft"
              :php-versions="phpVersions"
              :modx-revo-versions="modxRevoVersions"
              :modx3-versions="modx3Versions"
              :installed-db-engines="installedDbEngines"
              :default-db-name="siteName || 'site'"
              :default-db-user="siteName || 'site'"
              :default-files-rel-path="defaultFilesRelPath || 'www'"
              :show-git-deploy="false"
              :show-environment="false"
              :disabled="busy"
            />
            <p v-if="addError" class="domain-modal__error">{{ addError }}</p>
          </div>

          <footer class="domain-modal__footer">
            <button class="btn btn--ghost" :disabled="busy" @click="closeAddModal">Отмена</button>
            <button class="btn btn--primary" :disabled="busy" @click="onAddDomain">
              {{ busy ? 'Создаю…' : 'Создать приложение' }}
            </button>
          </footer>
        </section>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="editTarget && editDraft" class="domain-modal-overlay" @mousedown.self="closeEditModal">
        <section class="domain-modal">
          <header class="domain-modal__header">
            <div>
              <h3>Настройки приложения</h3>
              <p>{{ presetLabel(editTarget.preset) }} · {{ editTarget.domain }}</p>
            </div>
            <button :disabled="busy" @click="closeEditModal">×</button>
          </header>

          <div class="domain-modal__body domain-modal__fields">
            <label>
              <span>Домен</span>
              <input v-model="editDraft.domain" maxlength="253" autocomplete="off" spellcheck="false" />
            </label>
            <label>
              <span>filesRelPath</span>
              <input v-model="editDraft.filesRelPath" maxlength="255" autocomplete="off" spellcheck="false" />
              <small>
                Файлы автоматически не переносятся. Новый каталог должен содержать готовое приложение.
              </small>
            </label>
            <label class="domain-modal__check">
              <input
                v-model="editDraft.phpEnabled"
                type="checkbox"
                :disabled="isModxPreset(editTarget.preset)"
              />
              <span>PHP</span>
            </label>
            <label v-if="editDraft.phpEnabled">
              <span>Версия PHP</span>
              <select v-model="editDraft.phpVersion">
                <option v-for="version in phpVersions" :key="version.value" :value="version.value">
                  {{ version.label }}
                </option>
              </select>
            </label>
            <label class="domain-modal__check">
              <input v-model="editDraft.httpsRedirect" type="checkbox" />
              <span>Редирект HTTP → HTTPS</span>
            </label>

            <p v-if="editError" class="domain-modal__error">{{ editError }}</p>
          </div>

          <footer class="domain-modal__footer">
            <button class="btn btn--ghost" :disabled="busy" @click="closeEditModal">Отмена</button>
            <button class="btn btn--primary" :disabled="busy" @click="saveEditDomain">
              {{ busy ? 'Сохраняю…' : 'Сохранить' }}
            </button>
          </footer>
        </section>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="aliasTarget" class="domain-modal-overlay" @mousedown.self="closeAliasesModal">
        <section class="domain-modal">
          <header class="domain-modal__header">
            <div>
              <h3>Алиасы</h3>
              <p>{{ aliasTarget.domain }}</p>
            </div>
            <button :disabled="aliasSaving" @click="closeAliasesModal">×</button>
          </header>

          <div class="domain-modal__body">
            <div v-if="aliasDraft.length" class="alias-list">
              <div v-for="(alias, index) in aliasDraft" :key="`${alias.domain}:${index}`" class="alias-list__row">
                <input v-model="alias.domain" autocomplete="off" spellcheck="false" />
                <label>
                  <input v-model="alias.redirect" type="checkbox" />
                  301
                </label>
                <button type="button" @click="aliasDraft.splice(index, 1)">×</button>
              </div>
            </div>
            <div class="alias-list__add">
              <input
                v-model="newAlias"
                placeholder="alias.example.com"
                autocomplete="off"
                spellcheck="false"
                @keyup.enter="addAliasDraft"
              />
              <button class="btn btn--ghost btn--sm" @click="addAliasDraft">Добавить</button>
            </div>
            <p v-if="aliasError" class="domain-modal__error">{{ aliasError }}</p>
          </div>

          <footer class="domain-modal__footer">
            <button class="btn btn--ghost" :disabled="aliasSaving" @click="closeAliasesModal">Отмена</button>
            <button class="btn btn--primary" :disabled="aliasSaving || !aliasesDirty" @click="saveAliases">
              {{ aliasSaving ? 'Сохраняю…' : 'Сохранить' }}
            </button>
          </footer>
        </section>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="deleteTarget" class="domain-modal-overlay" @mousedown.self="closeDeleteModal">
        <section class="domain-modal">
          <header class="domain-modal__header domain-modal__header--danger">
            <div>
              <h3>Удалить приложение</h3>
              <p>{{ deleteTarget.domain }}</p>
            </div>
            <button :disabled="busy" @click="closeDeleteModal">×</button>
          </header>

          <div class="domain-modal__body domain-modal__fields">
            <p class="domain-modal__warning">
              Маршрутизация и метаданные приложения будут удалены. Файлы и БД сохраняются,
              пока ты явно не включишь их удаление.
            </p>
            <label class="domain-modal__check">
              <input v-model="deleteApplicationFiles" type="checkbox" />
              <span>Удалить файлы приложения после snapshot</span>
            </label>
            <label class="domain-modal__check">
              <input v-model="deleteOwnedDatabases" type="checkbox" />
              <span>Удалить принадлежащие приложению БД после snapshot</span>
            </label>
            <label>
              <span>Введи <code>{{ deleteTarget.domain }}</code></span>
              <input
                v-model="deleteConfirmation"
                autocomplete="off"
                spellcheck="false"
                :placeholder="deleteTarget.domain"
              />
            </label>
            <p v-if="deleteError" class="domain-modal__error">{{ deleteError }}</p>
          </div>

          <footer class="domain-modal__footer">
            <button class="btn btn--ghost" :disabled="busy" @click="closeDeleteModal">Отмена</button>
            <button
              class="btn btn--danger"
              :disabled="busy || deleteConfirmation !== deleteTarget.domain"
              @click="onRemoveDomain"
            >
              {{ busy ? 'Удаляю…' : 'Удалить приложение' }}
            </button>
          </footer>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import {
  DEFAULT_MODX_3_VERSIONS,
  DEFAULT_MODX_REVO_VERSIONS,
  DEFAULT_PHP_VERSIONS,
  buildDomainApplicationPayload,
  createDomainApplicationDraft,
  isDomainValid,
  isFilesRelPathValid,
  isModxApplication,
  presetLabel,
  validateDomainApplication,
  type DomainApplicationDraft,
  type SelectOption,
  type SiteTypePreset,
} from '~/utils/domain-application';

interface SiteAlias {
  domain: string;
  redirect: boolean;
}

interface SslCert {
  status: string;
  domains?: string[];
  expiresAt?: string | null;
}

interface SiteDomain {
  id: string;
  siteId: string;
  domain: string;
  isPrimary: boolean;
  position: number;
  aliases: SiteAlias[];
  preset: SiteTypePreset;
  appStatus: 'PROVISIONING' | 'RUNNING' | 'DEPLOYING' | 'UPDATING' | 'ERROR';
  appErrorMessage: string | null;
  filesRelPath: string;
  phpVersion: string | null;
  gitRepository: string | null;
  deployBranch: string | null;
  envVars: Record<string, string>;
  httpsRedirect: boolean;
  sslCertificate: SslCert | null;
  createdAt: string;
  updatedAt: string;
}

interface OperationResponse {
  operationId: string;
  operationStatus: string;
}

interface OperationState {
  id: string;
  status:
    | 'PENDING' | 'QUEUED' | 'CLAIMED' | 'RUNNING' | 'RECOVERING'
    | 'CANCEL_REQUESTED' | 'CANCELLED' | 'SUCCEEDED' | 'FAILED'
    | 'UNKNOWN_RECOVERY_REQUIRED' | 'NEEDS_ATTENTION';
  currentStep: string | null;
  progress: number;
  errorMessage: string | null;
}

interface EditDraft {
  domain: string;
  filesRelPath: string;
  phpEnabled: boolean;
  phpVersion: string;
  gitRepository: string;
  deployBranch: string;
  envVars: Array<{ key: string; value: string }>;
  httpsRedirect: boolean;
}

const props = withDefaults(
  defineProps<{
    siteId: string;
    siteName?: string;
    domains: SiteDomain[];
    defaultFilesRelPath?: string;
    siteRootPath?: string | null;
  }>(),
  {
    siteName: '',
    defaultFilesRelPath: 'www',
    siteRootPath: null,
  },
);

const emit = defineEmits<{
  (event: 'changed'): void;
  (event: 'navigate-ssl', domainId: string): void;
  (event: 'navigate-nginx', domainId: string): void;
}>();

const api = useApi();
const toast = useMbToast();
const confirm = useMbConfirm();
const busy = ref(false);
const activeOperationId = ref('');

const phpVersions = ref<SelectOption[]>(DEFAULT_PHP_VERSIONS.map((version) => ({ ...version })));
const modxRevoVersions = ref<SelectOption[]>(
  DEFAULT_MODX_REVO_VERSIONS.map((version) => ({ ...version })),
);
const modx3Versions = ref<SelectOption[]>(
  DEFAULT_MODX_3_VERSIONS.map((version) => ({ ...version })),
);
const installedDbEngines = ref<string[]>([]);

type Coverage = 'covered' | 'missing' | 'no-cert';

function hasActiveCert(domain: SiteDomain): boolean {
  return ['ACTIVE', 'EXPIRING_SOON', 'EXPIRED'].includes(
    domain.sslCertificate?.status || '',
  );
}

function certSet(domain: SiteDomain): Set<string> {
  return new Set((domain.sslCertificate?.domains || []).map((value) => value.toLowerCase()));
}

function coverageState(domain: SiteDomain): Coverage {
  if (!hasActiveCert(domain)) return 'no-cert';
  const covered = certSet(domain);
  return [domain.domain, ...domain.aliases.map((alias) => alias.domain)].every((hostname) =>
    covered.has(hostname.toLowerCase()),
  )
    ? 'covered'
    : 'missing';
}

function coverageTitle(domain: SiteDomain): string {
  return coverageState(domain) === 'covered'
    ? 'Домен и алиасы покрыты сертификатом'
    : 'Домен или алиас отсутствует в SAN сертификата';
}

function domainUrl(domain: SiteDomain): string {
  const validCertificate = ['ACTIVE', 'EXPIRING_SOON'].includes(
    domain.sslCertificate?.status || '',
  );
  const covered = certSet(domain).has(domain.domain.toLowerCase());
  return `${validCertificate && covered ? 'https' : 'http'}://${domain.domain}`;
}

const anyCoverageProblem = computed(() =>
  props.domains.some((domain) => coverageState(domain) === 'missing'),
);

function appStatusLabel(status: SiteDomain['appStatus']): string {
  return {
    PROVISIONING: 'Создаётся',
    RUNNING: 'Работает',
    DEPLOYING: 'Деплой',
    UPDATING: 'Обновляется',
    ERROR: 'Ошибка',
  }[status];
}

function isModxPreset(preset: SiteTypePreset): boolean {
  return preset === 'MODX_REVO' || preset === 'MODX_3';
}

function idempotencyKey(prefix: string): string {
  const suffix =
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}:${suffix}`;
}

async function loadFormOptions(): Promise<void> {
  const [phpResult, modxResult, servicesResult] = await Promise.allSettled([
    api.get<string[]>('/php/versions'),
    api.get<{
      revo: Array<{ value: string; label: string }>;
      modx3: Array<{ value: string; label: string }>;
    }>('/sites/modx-versions'),
    api.get<Array<{ key: string; installed: boolean }>>('/services'),
  ]);

  if (phpResult.status === 'fulfilled' && phpResult.value.length) {
    phpVersions.value = [...phpResult.value]
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .map((version) => ({
        value: version,
        label: /^7\./.test(version) ? `PHP ${version} (EOL)` : `PHP ${version}`,
      }));
  }
  if (modxResult.status === 'fulfilled') {
    if (modxResult.value.revo.length) modxRevoVersions.value = modxResult.value.revo;
    if (modxResult.value.modx3.length) modx3Versions.value = modxResult.value.modx3;
  }
  if (servicesResult.status === 'fulfilled') {
    installedDbEngines.value = servicesResult.value
      .filter((service) => service.installed)
      .map((service) => service.key);
  }
}

const addOpen = ref(false);
const addDraft = ref<DomainApplicationDraft | null>(null);
const addError = ref('');

function openAddModal(): void {
  addDraft.value = createDomainApplicationDraft({
    id: idempotencyKey('draft'),
    filesRelPath: props.defaultFilesRelPath || 'www',
    phpVersion: phpVersions.value[0]?.value || '8.2',
    modxRevoVersion: modxRevoVersions.value[0]?.value,
    modx3Version: modx3Versions.value[0]?.value,
  });
  addError.value = '';
  addOpen.value = true;
}

function closeAddModal(): void {
  if (busy.value) return;
  addOpen.value = false;
  addDraft.value = null;
}

function validateHostnames(application: DomainApplicationDraft): string | null {
  const known = new Set<string>();
  for (const domain of props.domains) {
    known.add(domain.domain.toLowerCase());
    for (const alias of domain.aliases) known.add(alias.domain.toLowerCase());
  }
  const requested = [
    application.domain.trim().toLowerCase(),
    ...application.aliases.map((alias) => alias.trim().toLowerCase()).filter(Boolean),
  ];
  const local = new Set<string>();
  for (const hostname of requested) {
    if (known.has(hostname)) return `${hostname} уже используется этим сайтом.`;
    if (local.has(hostname)) return `${hostname} указан повторно.`;
    local.add(hostname);
  }
  return null;
}

async function onAddDomain(): Promise<void> {
  if (!addDraft.value || busy.value) return;
  addError.value =
    validateDomainApplication(addDraft.value, new Set(installedDbEngines.value)) ||
    validateHostnames(addDraft.value) ||
    '';
  if (addError.value) return;

  busy.value = true;
  try {
    const response = await api.post<OperationResponse>(
      `/sites/${props.siteId}/domains`,
      buildDomainApplicationPayload(
        addDraft.value,
        phpVersions.value[0]?.value || '8.2',
      ),
      { headers: { 'Idempotency-Key': idempotencyKey('domain-create') } },
    );
    activeOperationId.value = response.operationId;
    addOpen.value = false;
    addDraft.value = null;
    toast.success('Приложение зарезервировано. Идёт установка.');
    emit('changed');
  } catch (error) {
    addError.value = (error as Error).message || 'Не удалось создать приложение';
  } finally {
    busy.value = false;
  }
}

function onOperationFinished(operation: OperationState): void {
  emit('changed');
  if (operation.status === 'SUCCEEDED') toast.success('Операция завершена');
  else toast.error(operation.errorMessage || 'Операция завершилась с ошибкой');
}

async function onMakePrimary(domain: SiteDomain): Promise<void> {
  if (domain.isPrimary || busy.value) return;
  const approved = await confirm.ask({
    title: 'Смена главного приложения',
    message: `Сделать ${domain.domain} главным доменом контейнера? Приложения и их runtime не перемещаются.`,
    confirmText: 'Сделать главным',
  });
  if (!approved) return;

  busy.value = true;
  try {
    await api.post(
      `/sites/${props.siteId}/domains/${domain.id}/make-primary`,
      {},
      { headers: { 'Idempotency-Key': idempotencyKey('domain-primary') } },
    );
    toast.success(`${domain.domain} — главный домен`);
    emit('changed');
  } catch (error) {
    toast.error((error as Error).message || 'Не удалось сменить главный домен');
  } finally {
    busy.value = false;
  }
}

const editTarget = ref<SiteDomain | null>(null);
const editDraft = ref<EditDraft | null>(null);
const editError = ref('');

function openEditModal(domain: SiteDomain): void {
  editTarget.value = domain;
  editDraft.value = {
    domain: domain.domain,
    filesRelPath: domain.filesRelPath,
    phpEnabled: domain.phpVersion !== null,
    phpVersion: domain.phpVersion || phpVersions.value[0]?.value || '8.2',
    gitRepository: domain.gitRepository || '',
    deployBranch: domain.deployBranch || 'main',
    envVars: Object.entries(domain.envVars || {}).map(([key, value]) => ({ key, value })),
    httpsRedirect: domain.httpsRedirect,
  };
  editError.value = '';
}

function closeEditModal(): void {
  if (busy.value) return;
  editTarget.value = null;
  editDraft.value = null;
}

function envRecord(items: EditDraft['envVars']): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const item of items) {
    const key = item.key.trim();
    if (!key) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) {
      editError.value = `Невалидное имя env: ${key}`;
      return null;
    }
    if (Object.hasOwn(result, key)) {
      editError.value = `Переменная ${key} указана повторно`;
      return null;
    }
    result[key] = item.value;
  }
  return result;
}

async function saveEditDomain(): Promise<void> {
  if (!editTarget.value || !editDraft.value || busy.value) return;
  editError.value = '';
  if (!isDomainValid(editDraft.value.domain)) {
    editError.value = 'Невалидный домен';
    return;
  }
  if (!isFilesRelPathValid(editDraft.value.filesRelPath)) {
    editError.value = 'Невалидный filesRelPath';
    return;
  }
  const envVars = envRecord(editDraft.value.envVars);
  if (!envVars) return;

  const payload = {
    domain: editDraft.value.domain.trim().toLowerCase(),
    filesRelPath: editDraft.value.filesRelPath.trim(),
    phpVersion:
      editDraft.value.phpEnabled || isModxPreset(editTarget.value.preset)
        ? editDraft.value.phpVersion
        : null,
    gitRepository:
      editTarget.value.preset === 'CUSTOM'
        ? editDraft.value.gitRepository.trim() || null
        : editTarget.value.gitRepository,
    deployBranch:
      editTarget.value.preset === 'CUSTOM'
        ? editDraft.value.deployBranch.trim() || null
        : editTarget.value.deployBranch,
    envVars,
    httpsRedirect: editDraft.value.httpsRedirect,
  };

  busy.value = true;
  try {
    await api.put(
      `/sites/${props.siteId}/domains/${editTarget.value.id}`,
      payload,
      { headers: { 'Idempotency-Key': idempotencyKey('domain-update') } },
    );
    toast.success('Настройки приложения сохранены');
    editTarget.value = null;
    editDraft.value = null;
    emit('changed');
  } catch (error) {
    editError.value = (error as Error).message || 'Не удалось сохранить настройки';
  } finally {
    busy.value = false;
  }
}

const aliasTarget = ref<SiteDomain | null>(null);
const aliasDraft = ref<SiteAlias[]>([]);
const newAlias = ref('');
const aliasError = ref('');
const aliasSaving = ref(false);

function openAliasesModal(domain: SiteDomain): void {
  aliasTarget.value = domain;
  aliasDraft.value = domain.aliases.map((alias) => ({ ...alias }));
  newAlias.value = '';
  aliasError.value = '';
}

function closeAliasesModal(): void {
  if (aliasSaving.value) return;
  aliasTarget.value = null;
}

const aliasesDirty = computed(() =>
  aliasTarget.value
    ? JSON.stringify(aliasDraft.value) !== JSON.stringify(aliasTarget.value.aliases)
    : false,
);

function addAliasDraft(): void {
  const alias = newAlias.value.trim().toLowerCase();
  aliasError.value = '';
  if (!isDomainValid(alias)) {
    aliasError.value = 'Невалидный алиас';
    return;
  }
  if (
    alias === aliasTarget.value?.domain.toLowerCase() ||
    aliasDraft.value.some((entry) => entry.domain.toLowerCase() === alias)
  ) {
    aliasError.value = 'Такой hostname уже указан';
    return;
  }
  aliasDraft.value.push({ domain: alias, redirect: false });
  newAlias.value = '';
}

async function saveAliases(): Promise<void> {
  if (!aliasTarget.value || !aliasesDirty.value || aliasSaving.value) return;
  aliasError.value = '';
  const seen = new Set<string>();
  for (const alias of aliasDraft.value) {
    const canonical = alias.domain.trim().toLowerCase();
    if (!isDomainValid(canonical)) {
      aliasError.value = `Невалидный алиас: ${alias.domain}`;
      return;
    }
    if (canonical === aliasTarget.value.domain.toLowerCase() || seen.has(canonical)) {
      aliasError.value = `Hostname ${canonical} указан повторно`;
      return;
    }
    seen.add(canonical);
    alias.domain = canonical;
  }

  aliasSaving.value = true;
  try {
    await api.put(
      `/sites/${props.siteId}/domains/${aliasTarget.value.id}/aliases`,
      { aliases: aliasDraft.value },
      { headers: { 'Idempotency-Key': idempotencyKey('domain-aliases') } },
    );
    toast.success('Алиасы сохранены');
    aliasTarget.value = null;
    emit('changed');
  } catch (error) {
    aliasError.value = (error as Error).message || 'Не удалось сохранить алиасы';
  } finally {
    aliasSaving.value = false;
  }
}

const deleteTarget = ref<SiteDomain | null>(null);
const deleteConfirmation = ref('');
const deleteApplicationFiles = ref(false);
const deleteOwnedDatabases = ref(false);
const deleteError = ref('');

function openDeleteModal(domain: SiteDomain): void {
  if (domain.isPrimary) return;
  deleteTarget.value = domain;
  deleteConfirmation.value = '';
  deleteApplicationFiles.value = false;
  deleteOwnedDatabases.value = false;
  deleteError.value = '';
}

function closeDeleteModal(): void {
  if (busy.value) return;
  deleteTarget.value = null;
}

async function onRemoveDomain(): Promise<void> {
  if (
    !deleteTarget.value ||
    deleteConfirmation.value !== deleteTarget.value.domain ||
    busy.value
  ) {
    return;
  }

  busy.value = true;
  try {
    const response = await api.delete<OperationResponse>(
      `/sites/${props.siteId}/domains/${deleteTarget.value.id}`,
      {
        confirmDomain: deleteConfirmation.value,
        deleteApplicationFiles: deleteApplicationFiles.value,
        deleteOwnedDatabases: deleteOwnedDatabases.value,
      },
      { headers: { 'Idempotency-Key': idempotencyKey('domain-delete') } },
    );
    activeOperationId.value = response.operationId;
    deleteTarget.value = null;
    toast.success('Удаление приложения запущено');
  } catch (error) {
    deleteError.value = (error as Error).message || 'Не удалось удалить приложение';
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  void loadFormOptions();
});
</script>

<style scoped>
.domains-tab { display: flex; flex-direction: column; gap: 1rem; }
.domains-tab__alert {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.75rem 0.9rem;
  border: 1px solid var(--danger-border);
  border-radius: 11px;
  background: var(--danger-bg);
  color: var(--danger-light);
  font-size: 0.76rem;
}
.domains-tab__card {
  overflow: hidden;
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  background: var(--bg-surface);
}
.domains-tab__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem;
  border-bottom: 1px solid var(--bar-bg);
}
.domains-tab__header h3 { margin: 0; color: var(--text-primary); font-size: 0.95rem; }
.domains-tab__header p { margin: 0.25rem 0 0; color: var(--text-muted); font-size: 0.72rem; }
.domains-tab__list { display: flex; flex-direction: column; }
.domain-row {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid var(--bar-bg);
}
.domain-row:last-child { border-bottom: 0; }
.domain-row--primary { background: var(--primary-bg); }
.domain-row__primary {
  width: 28px;
  height: 28px;
  border: 1px solid var(--border-secondary);
  border-radius: 8px;
  background: var(--bg-surface);
  color: var(--text-faint);
  cursor: pointer;
}
.domain-row__primary--active { border-color: var(--primary-border); color: var(--primary); }
.domain-row__main { min-width: 0; }
.domain-row__title,
.domain-row__meta,
.domain-row__actions { display: flex; align-items: center; gap: 0.45rem; }
.domain-row__title { flex-wrap: wrap; }
.domain-row__title a {
  color: var(--text-primary);
  font-weight: 600;
  font-size: 0.84rem;
  text-decoration: none;
}
.domain-row__preset,
.domain-row__status,
.domain-row__ssl {
  padding: 0.12rem 0.38rem;
  border-radius: 5px;
  background: var(--bg-input);
  color: var(--text-muted);
  font-size: 0.62rem;
}
.domain-row__status--running,
.domain-row__ssl--covered { color: #4ade80; }
.domain-row__status--error,
.domain-row__ssl--missing { color: var(--danger-light); }
.domain-row__meta { flex-wrap: wrap; margin-top: 0.28rem; color: var(--text-muted); font-size: 0.68rem; }
.domain-row__meta code { color: var(--text-secondary); }
.domain-row__error { margin: 0.35rem 0 0; color: var(--danger-light); font-size: 0.7rem; }
.domain-row__actions { justify-content: flex-end; flex-wrap: wrap; }
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  min-height: 36px;
  padding: 0.52rem 0.9rem;
  border: 1px solid transparent;
  border-radius: 9px;
  font: 600 0.78rem/1 'DM Sans', sans-serif;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s, background 0.15s, color 0.15s;
}
.btn:disabled { opacity: 0.42; cursor: not-allowed; }
.btn--xs { min-height: 28px; padding: 0.3rem 0.62rem; border-radius: 7px; font-size: 0.7rem; }
.btn--sm { min-height: 32px; padding: 0.4rem 0.75rem; border-radius: 8px; font-size: 0.74rem; }
.btn--primary {
  background: linear-gradient(135deg, var(--primary-light), var(--primary-dark));
  color: var(--primary-text-on);
}
.btn--primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: var(--shadow-button-hover); }
.btn--ghost {
  border-color: var(--border-strong);
  background: var(--bg-input);
  color: var(--text-tertiary);
}
.btn--ghost:hover:not(:disabled) {
  border-color: var(--primary-border);
  background: var(--bg-surface-hover);
  color: var(--text-primary);
}
.btn--danger {
  border-color: var(--danger-border);
  background: var(--danger-bg);
  color: var(--danger-light);
}
.btn--danger:hover:not(:disabled) { border-color: var(--danger); background: rgba(239, 68, 68, 0.16); }
.domain-row__delete {
  width: 28px;
  height: 28px;
  border: 1px solid var(--danger-border);
  border-radius: 8px;
  background: transparent;
  color: var(--danger-light);
  cursor: pointer;
}
.domain-row__delete:hover:not(:disabled) { background: var(--danger-bg); border-color: var(--danger); }
.domain-row__delete:disabled { opacity: 0.35; cursor: not-allowed; }
.domains-tab__empty { padding: 2rem; color: var(--text-muted); text-align: center; }

.domain-modal-overlay {
  position: fixed;
  z-index: 1200;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.68);
  backdrop-filter: blur(3px);
}
.domain-modal {
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  max-height: calc(100vh - 2rem);
  overflow: hidden;
  border: 1px solid var(--border-secondary);
  border-radius: 15px;
  background-color: var(--bg-modal);
  background-image: var(--bg-modal-gradient);
  box-shadow: var(--shadow-modal);
  isolation: isolate;
}
.domain-modal--wide { width: min(760px, 100%); }
.domain-modal__header,
.domain-modal__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.9rem 1rem;
}
.domain-modal__header { border-bottom: 1px solid var(--bar-bg); }
.domain-modal__header--danger { border-color: var(--danger-border); }
.domain-modal__header h3 { margin: 0; color: var(--text-primary); font-size: 0.95rem; }
.domain-modal__header p { margin: 0.2rem 0 0; color: var(--text-muted); font-size: 0.72rem; }
.domain-modal__header > button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  border: 1px solid var(--border-secondary);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-muted);
  font-size: 1.25rem;
  cursor: pointer;
}
.domain-modal__header > button:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--bg-surface-hover);
  color: var(--text-primary);
}
.domain-modal__body { padding: 1rem; overflow: auto; }
.domain-modal__footer { border-top: 1px solid var(--bar-bg); justify-content: flex-end; }
.domain-modal__fields { display: flex; flex-direction: column; gap: 0.85rem; }
.domain-modal__fields > label,
.domain-modal__env { display: flex; flex-direction: column; gap: 0.35rem; }
.domain-modal__fields label > span,
.domain-modal__env > span { color: var(--text-tertiary); font-size: 0.76rem; }
.domain-modal input,
.domain-modal select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 0.58rem 0.75rem;
  border: 1px solid var(--border-secondary);
  border-radius: 9px;
  background: var(--bg-input);
  color: var(--text-primary);
  font: inherit;
  font-size: 0.8rem;
}
.domain-modal small { color: var(--text-faint); font-size: 0.68rem; }
.domain-modal__check { flex-direction: row !important; align-items: center; }
.domain-modal__check input { width: auto; }
.domain-modal__error { margin: 0; color: var(--danger-light); font-size: 0.74rem; }
.domain-modal__warning {
  margin: 0;
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--danger-border);
  border-radius: 9px;
  background: var(--danger-bg);
  color: var(--danger-light);
  font-size: 0.72rem;
  line-height: 1.5;
}
.domain-modal__env { gap: 0.5rem; }
.domain-modal__env-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 34px;
  gap: 0.4rem;
}
.domain-modal__env-row button,
.alias-list__row > button {
  border: 1px solid var(--danger-border);
  border-radius: 8px;
  background: transparent;
  color: var(--danger-light);
  cursor: pointer;
}
.domain-modal__add-row {
  align-self: flex-start;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  padding: 0.4rem 0.65rem;
  cursor: pointer;
}
.alias-list { display: flex; flex-direction: column; gap: 0.5rem; }
.alias-list__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 34px;
  align-items: center;
  gap: 0.45rem;
}
.alias-list__row label { display: flex; align-items: center; gap: 0.3rem; color: var(--text-muted); font-size: 0.72rem; }
.alias-list__row label input { width: auto; }
.alias-list__add { display: flex; gap: 0.45rem; margin-top: 0.75rem; }
.alias-list__add input { flex: 1; }

@media (max-width: 780px) {
  .domains-tab__header { flex-direction: column; }
  .domain-row { grid-template-columns: 28px minmax(0, 1fr); }
  .domain-row__actions { grid-column: 1 / -1; justify-content: flex-start; }
  .domain-modal__env-row { grid-template-columns: 1fr 34px; }
  .domain-modal__env-row input:nth-child(2) { grid-column: 1; }
  .domain-modal__env-row button { grid-column: 2; grid-row: 1 / span 2; }
}
</style>
