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
        :class="{
          'create-site__step-dot--active': step === s,
          'create-site__step-dot--done': step > s,
        }"
        :disabled="s > step || provisioning"
        @click="s < step && !provisioning ? step = s : null"
      >
        <span v-if="step > s" class="create-site__step-check">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20,6 9,17 4,12" /></svg>
        </span>
        <span v-else>{{ s }}</span>
      </button>
    </div>

    <form v-if="!provisioning && !provisionResult" @submit.prevent="handleSubmit">
      <!-- ============================================================ -->
      <!-- STEP 1: All fields (type + basics + modules + CMS + extras)   -->
      <!-- ============================================================ -->
      <div v-if="step === 1" class="create-site__section">
        <!-- Type -->
        <h2 class="create-site__section-title">Тип сайта</h2>
        <p class="create-site__section-desc">Выберите тип сайта</p>

        <div class="create-site__types">
          <button
            v-for="t in siteTypes"
            :key="t.value"
            type="button"
            class="type-card"
            :class="{ 'type-card--selected': form.type === t.value }"
            @click="selectType(t.value)"
          >
            <SiteTypeIcon :type="t.value" />
            <div class="type-card__info">
              <span class="type-card__name">{{ t.label }}</span>
              <span class="type-card__desc">{{ t.desc }}</span>
            </div>
          </button>
        </div>

        <!-- Base identifiers -->
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
              Одновременно — имя Linux-юзера, имя БД и имя БД-юзера.
              Только lowercase: [a-z0-9_-], начинается с буквы, до 32 символов.
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
              Человекочитаемое название для списка сайтов. Если пусто — будет показано имя Linux-юзера.
            </span>
          </div>

          <div class="form-group">
            <label class="form-label">Домен <span class="form-required">*</span></label>
            <input
              v-model="form.domain"
              type="text"
              class="form-input"
              placeholder="example.com"
              maxlength="253"
              required
            />
          </div>

          <div class="form-group">
            <label class="form-label">Алиасы домена</label>
            <div class="alias-list">
              <div v-for="(_alias, idx) in form.aliases" :key="idx" class="alias-item">
                <input
                  v-model="form.aliases[idx]"
                  type="text"
                  class="form-input"
                  :placeholder="`www.${form.domain || 'example.com'}`"
                />
                <button type="button" class="alias-remove" @click="removeAlias(idx)">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
              <button type="button" class="alias-add" @click="addAlias">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Добавить алиас
              </button>
            </div>
          </div>
        </div>

        <!-- Modules -->
        <h2 class="create-site__section-title create-site__section-title--spaced">Конфигурация</h2>
        <p class="create-site__section-desc">Модули для сайта {{ typeLabel }}</p>

        <div class="create-site__modules">
          <!-- PHP Module -->
          <div class="module-card" :class="{ 'module-card--locked': isMODX }">
            <label class="module-card__header">
              <input
                type="checkbox"
                v-model="form.phpEnabled"
                class="module-card__checkbox"
                :disabled="isMODX"
              />
              <div class="module-card__title-wrap">
                <span class="module-card__title">PHP</span>
                <span class="module-card__desc">
                  {{ isMODX ? 'Обязательно для MODX' : 'PHP-FPM пул для выполнения .php скриптов' }}
                </span>
              </div>
              <span v-if="isMODX" class="module-card__badge">Всегда</span>
            </label>
            <div v-if="form.phpEnabled" class="module-card__body">
              <div class="form-group">
                <label class="form-label">Версия PHP</label>
                <div class="form-select-wrap">
                  <select v-model="form.phpVersion" class="form-select">
                    <option v-for="v in phpVersions" :key="v.value" :value="v.value">{{ v.label }}</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          <!-- Database Module -->
          <div class="module-card" :class="{ 'module-card--locked': isMODX }">
            <label class="module-card__header">
              <input
                type="checkbox"
                v-model="form.dbEnabled"
                class="module-card__checkbox"
                :disabled="isMODX"
              />
              <div class="module-card__title-wrap">
                <span class="module-card__title">База данных</span>
                <span class="module-card__desc">
                  {{ isMODX ? 'Обязательно для MODX — создаётся автоматически' : 'Автоматически создаст БД + пользователя' }}
                </span>
              </div>
              <span v-if="isMODX" class="module-card__badge">Всегда</span>
            </label>
            <div v-if="form.dbEnabled" class="module-card__body">
              <div class="form-group">
                <label class="form-label">Тип БД</label>
                <div class="form-select-wrap">
                  <select v-model="form.dbType" class="form-select" :disabled="dbEngineOptions.length === 0">
                    <option v-if="!isMODX || dbEngineOptions.length > 1" value="">Авто (определить на сервере)</option>
                    <option v-for="opt in dbEngineOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                  </select>
                </div>
                <span v-if="dbEngineOptions.length === 0" class="form-hint" style="color: var(--text-warning, var(--primary));">
                  Ни один движок БД не установлен на сервере. Открой
                  <NuxtLink to="/services" class="link">/services</NuxtLink>
                  и установи MariaDB или PostgreSQL.
                </span>
                <span v-else-if="isMODX" class="form-hint">MODX для надёжности — только MariaDB / MySQL</span>
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Имя БД</label>
                  <input
                    v-model="form.dbName"
                    type="text"
                    class="form-input form-input--mono"
                    :placeholder="defaultDbName"
                    maxlength="64"
                    pattern="^[a-zA-Z0-9_]+$"
                  />
                  <span class="form-hint">Пусто — совпадёт с именем сайта</span>
                </div>
                <div class="form-group">
                  <label class="form-label">Пользователь</label>
                  <input
                    v-model="form.dbUser"
                    type="text"
                    class="form-input form-input--mono"
                    :placeholder="defaultDbUser"
                    maxlength="32"
                    pattern="^[a-zA-Z0-9_]+$"
                  />
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">Пароль БД</label>
                <div class="form-input-group">
                  <input
                    v-model="form.dbPassword"
                    :type="showDbPassword ? 'text' : 'password'"
                    class="form-input form-input--mono form-input--with-btn"
                    placeholder="Сгенерируется автоматически"
                    maxlength="128"
                  />
                  <button type="button" class="form-input-btn" @click="showDbPassword = !showDbPassword">
                    {{ showDbPassword ? 'Скрыть' : 'Показать' }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- SSL Module -->
          <div class="module-card">
            <label class="module-card__header">
              <input
                type="checkbox"
                v-model="form.sslEnabled"
                class="module-card__checkbox"
              />
              <div class="module-card__title-wrap">
                <span class="module-card__title">SSL (Let's Encrypt)</span>
                <span class="module-card__desc">Автоматический выпуск бесплатного сертификата</span>
              </div>
            </label>
            <div v-if="form.sslEnabled" class="module-card__body">
              <label class="module-sub">
                <input type="checkbox" v-model="form.httpsRedirect" />
                <span>Редирект HTTP → HTTPS</span>
              </label>
            </div>
          </div>
        </div>

        <!-- MODX admin fields -->
        <div v-if="isMODX" class="create-site__fields create-site__fields--group">
          <h3 class="create-site__group-title">MODX-администратор</h3>

          <div class="form-group">
            <label class="form-label">Версия MODX</label>
            <select v-model="form.modxVersion" class="form-input form-input--mono">
              <option
                v-for="v in (form.type === 'MODX_3' ? modx3Versions : modxRevoVersions)"
                :key="v.value"
                :value="v.value"
              >
                {{ v.label }}
              </option>
            </select>
            <span class="form-hint">Обновить на более свежую версию можно потом на странице сайта</span>
          </div>

          <div class="form-group">
            <label class="form-label">CMS Логин</label>
            <input
              v-model="form.cmsAdminUser"
              type="text"
              class="form-input form-input--mono"
              :placeholder="form.name || 'admin'"
              maxlength="64"
            />
            <span class="form-hint">По умолчанию = имя Linux-юзера</span>
          </div>

          <div class="form-group">
            <label class="form-label">CMS Пароль</label>
            <div class="form-input-group">
              <input
                v-model="form.cmsAdminPassword"
                :type="showCmsPassword ? 'text' : 'password'"
                class="form-input form-input--mono form-input--with-btn"
                placeholder="Сгенерируется автоматически"
                maxlength="128"
              />
              <button type="button" class="form-input-btn" @click="showCmsPassword = !showCmsPassword">
                {{ showCmsPassword ? 'Скрыть' : 'Показать' }}
              </button>
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Путь к Manager</label>
              <input
                v-model="form.managerPath"
                type="text"
                class="form-input form-input--mono"
                placeholder="manager"
                maxlength="64"
                pattern="^[a-zA-Z0-9_-]+$"
              />
            </div>
            <div class="form-group">
              <label class="form-label">Путь к Connectors</label>
              <input
                v-model="form.connectorsPath"
                type="text"
                class="form-input form-input--mono"
                placeholder="connectors"
                maxlength="64"
                pattern="^[a-zA-Z0-9_-]+$"
              />
            </div>
          </div>
        </div>

        <!-- Git-репозиторий — только для CUSTOM (MODX ставится через composer/zip) -->
        <div v-if="!isMODX" class="create-site__fields create-site__fields--group">
          <h3 class="create-site__group-title">Git-деплой (опционально)</h3>

          <div class="form-group">
            <label class="form-label">Git-репозиторий</label>
            <input
              v-model="form.gitRepository"
              type="text"
              class="form-input form-input--mono"
              placeholder="git@github.com:user/repo.git"
              maxlength="512"
            />
            <span class="form-hint">Склонируется сразу после создания; дальше можно деплоить git pull</span>
          </div>

          <div v-if="form.gitRepository" class="form-group">
            <label class="form-label">Ветка деплоя</label>
            <input
              v-model="form.deployBranch"
              type="text"
              class="form-input form-input--mono"
              placeholder="main"
              maxlength="128"
            />
          </div>
        </div>
      </div>

      <!-- ============================================================ -->
      <!-- STEP 2: Review & create                                       -->
      <!-- ============================================================ -->
      <div v-if="step === 2" class="create-site__section">
        <h2 class="create-site__section-title">Проверка</h2>
        <p class="create-site__section-desc">Проверьте конфигурацию перед созданием сайта</p>

        <div class="review-card">
          <div class="review-card__header">
            <SiteTypeIcon :type="form.type" />
            <div>
              <h3 class="review-card__name">{{ form.displayName || form.name }}</h3>
              <p class="review-card__domain">{{ form.domain }}</p>
            </div>
          </div>

          <div class="review-card__grid">
            <div class="review-item">
              <span class="review-item__label">Тип</span>
              <span class="review-item__value">{{ typeLabel }}</span>
            </div>
            <div class="review-item">
              <span class="review-item__label">Имя Linux-юзера</span>
              <span class="review-item__value review-item__value--mono">{{ form.name }}</span>
            </div>
            <div class="review-item">
              <span class="review-item__label">PHP</span>
              <span class="review-item__value">{{ form.phpEnabled ? form.phpVersion : '—' }}</span>
            </div>
            <div class="review-item">
              <span class="review-item__label">База данных</span>
              <span class="review-item__value">
                {{ form.dbEnabled ? dbTypeReviewLabel : '—' }}
                <span v-if="form.dbEnabled" class="review-item__hint">({{ form.dbName || defaultDbName }})</span>
              </span>
            </div>
            <div class="review-item">
              <span class="review-item__label">SSL</span>
              <span class="review-item__value">{{ form.sslEnabled ? 'Let\'s Encrypt' : '—' }}</span>
            </div>
            <div v-if="form.sslEnabled" class="review-item">
              <span class="review-item__label">HTTPS редирект</span>
              <span class="review-item__value">{{ form.httpsRedirect ? 'Да' : 'Нет' }}</span>
            </div>
            <div v-if="form.gitRepository && !isMODX" class="review-item">
              <span class="review-item__label">Git-репозиторий</span>
              <span class="review-item__value review-item__value--mono">{{ form.gitRepository }}</span>
            </div>
            <div v-if="form.aliases.filter(a => a).length" class="review-item">
              <span class="review-item__label">Алиасы</span>
              <span class="review-item__value review-item__value--mono">{{ form.aliases.filter(a => a).join(', ') }}</span>
            </div>
            <div v-if="isMODX" class="review-item">
              <span class="review-item__label">Версия MODX</span>
              <span class="review-item__value review-item__value--mono">{{ form.modxVersion }}</span>
            </div>
            <div v-if="isMODX" class="review-item">
              <span class="review-item__label">CMS Логин</span>
              <span class="review-item__value review-item__value--mono">{{ form.cmsAdminUser || form.name }}</span>
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

      <!-- Actions -->
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
          :to="`/sites/${createdSiteId}`"
          class="create-site__btn create-site__btn--primary"
        >
          Открыть сайт
        </NuxtLink>
        <NuxtLink
          v-else-if="createdSiteId"
          :to="`/sites/${createdSiteId}`"
          class="create-site__btn create-site__btn--secondary"
        >
          Открыть сайт (в статусе ошибки)
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
definePageMeta({ middleware: 'auth' });

const api = useApi();
const { onSiteProvisionLog, onSiteProvisionDone } = useSocket();

const step = ref(1);
const submitting = ref(false);
const error = ref('');

const showCmsPassword = ref(false);
const showDbPassword = ref(false);

const createdSiteId = ref<string>('');
const provisioning = ref(false);
const provisionResult = ref<'RUNNING' | 'ERROR' | ''>('');
const provisionLog = ref<Array<{ level: 'info' | 'warn' | 'error'; line: string; timestamp: string }>>([]);
const logContainer = ref<HTMLElement | null>(null);

const form = reactive({
  name: '',
  displayName: '',
  domain: '',
  type: 'CUSTOM' as 'MODX_REVO' | 'MODX_3' | 'CUSTOM',
  // Модули
  phpEnabled: false,
  phpVersion: '8.2',
  dbEnabled: false,
  dbType: '' as '' | 'MARIADB' | 'POSTGRESQL',
  dbName: '',
  dbUser: '',
  dbPassword: '',
  sslEnabled: false,
  httpsRedirect: true,
  // Общие
  gitRepository: '',
  deployBranch: 'main',
  aliases: [] as string[],
  // CMS (MODX only)
  cmsAdminUser: '',
  cmsAdminPassword: '',
  managerPath: '',
  connectorsPath: '',
  modxVersion: '3.1.2-pl',
});

const siteTypes = [
  { value: 'MODX_REVO', label: 'MODX Revolution', desc: 'Классический MODX 2.x на PHP + MySQL' },
  { value: 'MODX_3', label: 'MODX 3', desc: 'Современный MODX 3.x' },
  { value: 'CUSTOM', label: 'Пустой', desc: 'Чистый скелет, модули подключай сам' },
];

const phpVersions = [
  { value: '7.1', label: 'PHP 7.1 (EOL)' },
  { value: '7.2', label: 'PHP 7.2 (EOL)' },
  { value: '7.3', label: 'PHP 7.3 (EOL)' },
  { value: '7.4', label: 'PHP 7.4' },
  { value: '8.0', label: 'PHP 8.0' },
  { value: '8.1', label: 'PHP 8.1' },
  { value: '8.2', label: 'PHP 8.2' },
  { value: '8.3', label: 'PHP 8.3' },
  { value: '8.4', label: 'PHP 8.4' },
];

// Версии MODX тянем с бэка (ModxVersionsService → GitHub releases, кеш 1ч).
// Стартовый фолбэк — latest-дефолты из shared/constants.ts, чтобы select не был
// пустой до того, как ответит API.
const modxRevoVersions = ref<Array<{ value: string; label: string }>>([
  { value: '2.8.8-pl', label: 'MODX Revolution 2.8.8 (latest)' },
]);
const modx3Versions = ref<Array<{ value: string; label: string }>>([
  { value: '3.1.2-pl', label: 'MODX 3.1.2 (latest)' },
]);

// Множество установленных DB-движков ('mariadb', 'postgresql').
// Загружается одним вызовом /services при mount; используется для
// фильтрации опций селекта «Тип БД» — нельзя выбрать движок, которого нет.
// Для MODX дополнительно: PostgreSQL не предлагается (CMS поддерживает только MySQL).
const installedDbEngines = ref<Set<string>>(new Set());

interface DbEngineOption { value: 'MARIADB' | 'POSTGRESQL'; label: string; engineKey: 'mariadb' | 'postgresql' }
const ALL_DB_ENGINES: DbEngineOption[] = [
  { value: 'MARIADB', label: 'MySQL / MariaDB', engineKey: 'mariadb' },
  { value: 'POSTGRESQL', label: 'PostgreSQL', engineKey: 'postgresql' },
];

const dbEngineOptions = computed<DbEngineOption[]>(() => {
  const installed = ALL_DB_ENGINES.filter((opt) => installedDbEngines.value.has(opt.engineKey));
  // MODX исторически работает только на MySQL/MariaDB. PostgreSQL для MODX
  // отрезаем, чтобы не получить полу-рабочий сайт после провижининга.
  if (form.type === 'MODX_REVO' || form.type === 'MODX_3') {
    return installed.filter((opt) => opt.engineKey === 'mariadb');
  }
  return installed;
});

// Авто-выбор первого доступного движка, когда:
//   а) пользователь включает галочку «база данных»;
//   б) список движков обновился (загрузились /services или сменился form.type).
// Юзеру было неудобно: галочка стоит, а селект «не выбран» — приходится
// вручную тыкать единственный пункт. Если выбранный движок исчез из
// доступных — тоже сбрасываем на первый из списка.
watch(
  () => [form.dbEnabled, dbEngineOptions.value] as const,
  ([enabled, opts]) => {
    if (!enabled) return;
    if (opts.length === 0) return;
    const validValues = opts.map((o) => o.value);
    if (!form.dbType || !validValues.includes(form.dbType as 'MARIADB' | 'POSTGRESQL')) {
      form.dbType = opts[0].value;
    }
  },
  { immediate: true, deep: false },
);

/**
 * Можно ли отправить форму. Бэкенд тоже валидирует, но лучше дать
 * пользователю понятный заранее блок, чтобы не создавать сайт-инвалид.
 */
const submitBlockReason = computed<string>(() => {
  if (form.dbEnabled && dbEngineOptions.value.length === 0) {
    if (form.type === 'MODX_REVO' || form.type === 'MODX_3') {
      return 'Для MODX нужен MariaDB / MySQL. Установи его на /services перед созданием сайта.';
    }
    return 'Включена БД, но ни одного движка не установлено. Установи на /services или сними галочку «База данных».';
  }
  return '';
});
const canSubmit = computed(() => !submitBlockReason.value);

// Лейбл «Тип БД» для preview-шага.
const dbTypeReviewLabel = computed<string>(() => {
  if (!form.dbType) return 'Авто';
  const opt = ALL_DB_ENGINES.find((o) => o.value === form.dbType);
  return opt ? opt.label : form.dbType;
});

async function loadInstalledDbEngines() {
  try {
    const list = await api.get<Array<{ key: string; installed: boolean }>>('/services');
    installedDbEngines.value = new Set(
      list.filter((s) => s.installed).map((s) => s.key),
    );
    // Если выбранный dbType больше не в списке — сбрасываем на 'auto'.
    if (form.dbType && !dbEngineOptions.value.some((o) => o.value === form.dbType)) {
      form.dbType = '';
    }
  } catch {
    // если /services недоступен — оставляем оба движка (бэкенд сам валидирует)
    installedDbEngines.value = new Set(['mariadb', 'postgresql']);
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
    // Если пользователь ещё не трогал select — подставляем актуальный latest
    // соответствующего мажора, чтобы не отправить в API устаревшую версию.
    if (form.type === 'MODX_3' && modx3Versions.value[0]) {
      form.modxVersion = modx3Versions.value[0].value;
    } else if (form.type === 'MODX_REVO' && modxRevoVersions.value[0]) {
      form.modxVersion = modxRevoVersions.value[0].value;
    }
  } catch { /* фолбэк ок */ }
}

onMounted(() => {
  loadModxVersions();
  loadInstalledDbEngines();
});

const isMODX = computed(() => form.type === 'MODX_REVO' || form.type === 'MODX_3');

const typeLabel = computed(() => {
  return siteTypes.find((t) => t.value === form.type)?.label || form.type;
});

// Без префиксов: имя БД = имя Linux-юзера = имя сайта. Дефисы → подчёркивания для имён БД.
const defaultDbName = computed(() => {
  return form.name.replace(/-/g, '_') || 'site';
});

const defaultDbUser = computed(() => {
  return (form.name.replace(/-/g, '_') || 'site').substring(0, 32);
});

const canProceed = computed(() => {
  if (step.value === 1) {
    return form.type && /^[a-z][a-z0-9_-]{0,31}$/.test(form.name) && form.domain.trim();
  }
  return true;
});

function selectType(type: 'MODX_REVO' | 'MODX_3' | 'CUSTOM') {
  form.type = type;
  if (type === 'MODX_REVO' || type === 'MODX_3') {
    // MODX — PHP и БД обязательны
    form.phpEnabled = true;
    form.dbEnabled = true;
    if (!form.phpVersion) form.phpVersion = '8.2';
    // Авто-подставляем latest версию MODX соответствующего мажора.
    const isMajor3 = form.modxVersion.startsWith('3.');
    if (type === 'MODX_3' && !isMajor3 && modx3Versions.value[0]) {
      form.modxVersion = modx3Versions.value[0].value;
    } else if (type === 'MODX_REVO' && isMajor3 && modxRevoVersions.value[0]) {
      form.modxVersion = modxRevoVersions.value[0].value;
    }
  }
}

function addAlias() {
  form.aliases.push('');
}

function removeAlias(idx: number) {
  form.aliases.splice(idx, 1);
}

function nextStep() {
  error.value = '';
  if (step.value === 1) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(form.name)) {
      error.value = 'Имя Linux-юзера должно начинаться с буквы и содержать только [a-z0-9_-], до 32 символов';
      return;
    }
    if (!/^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(form.domain)) {
      error.value = 'Некорректный формат домена';
      return;
    }
  }
  step.value++;
}

const MAX_LOG_LINES = 2000;

function appendLog(entry: { level: 'info' | 'warn' | 'error'; line: string; timestamp: string }) {
  provisionLog.value.push(entry);
  // Кэпим историю — composer/cli-install могут выдать сотни-тысячи строк,
  // держать все в реактивном массиве бессмысленно.
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
    const d = new Date(ts);
    return d.toLocaleTimeString('ru-RU', { hour12: false });
  } catch {
    return '';
  }
}

async function handleSubmit() {
  if (submitting.value) return;
  error.value = '';
  submitting.value = true;

  try {
    const payload: Record<string, unknown> = {
      name: form.name.trim().toLowerCase(),
      domain: form.domain.trim().toLowerCase(),
      type: form.type,
    };

    if (form.displayName.trim()) payload.displayName = form.displayName.trim();

    // Модули
    payload.phpEnabled = form.phpEnabled;
    if (form.phpEnabled) payload.phpVersion = form.phpVersion;
    payload.dbEnabled = form.dbEnabled;
    if (form.dbEnabled && form.dbType) payload.dbType = form.dbType;
    if (form.dbEnabled && form.dbName.trim()) payload.dbName = form.dbName.trim();
    if (form.dbEnabled && form.dbUser.trim()) payload.dbUser = form.dbUser.trim();
    if (form.dbEnabled && form.dbPassword.trim()) payload.dbPassword = form.dbPassword.trim();
    payload.sslEnabled = form.sslEnabled;
    payload.httpsRedirect = form.httpsRedirect;

    // Git-репо — только для CUSTOM
    if (!isMODX.value && form.gitRepository.trim()) {
      payload.gitRepository = form.gitRepository.trim();
      if (form.deployBranch && form.deployBranch !== 'main') payload.deployBranch = form.deployBranch;
    }

    const filteredAliases = form.aliases.filter((a) => a.trim());
    if (filteredAliases.length) payload.aliases = filteredAliases;

    if (isMODX.value) {
      if (form.cmsAdminUser.trim()) payload.cmsAdminUser = form.cmsAdminUser.trim();
      if (form.cmsAdminPassword.trim()) payload.cmsAdminPassword = form.cmsAdminPassword.trim();
      if (form.managerPath.trim()) payload.managerPath = form.managerPath.trim();
      if (form.connectorsPath.trim()) payload.connectorsPath = form.connectorsPath.trim();
      if (form.modxVersion) payload.modxVersion = form.modxVersion;
    }

    // API возвращает сайт сразу (провижининг идёт в фоне).
    const site = await api.post<{ id: string }>('/sites', payload);
    createdSiteId.value = site.id;

    // Переключаемся на режим live-лога.
    provisioning.value = true;
    provisionLog.value = [];
    provisionResult.value = '';
  } catch (e: unknown) {
    const err = e as { data?: { message?: string | string[] } };
    const msg = err.data?.message;
    error.value = Array.isArray(msg) ? msg.join('; ') : (msg || 'Ошибка создания сайта');
  } finally {
    submitting.value = false;
  }
}

// Подписка на WS-события провижининга. Фильтруем по createdSiteId.
let unsubLog: (() => void) | null = null;
let unsubDone: (() => void) | null = null;

onMounted(() => {
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
  border-color: var(--primary);
  background: var(--primary-bg);
  color: var(--primary-text);
}

.create-site__step-dot--done {
  border-color: rgba(34, 197, 94, 0.3);
  background: rgba(34, 197, 94, 0.1);
  color: #4ade80;
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

.create-site__types {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.6rem;
  margin-bottom: 1.5rem;
}

.type-card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem;
  border-radius: 12px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  cursor: pointer;
  text-align: left;
  transition: all 0.2s;
}

.type-card:hover {
  background: var(--bg-input);
  border-color: var(--border-strong);
}

.type-card--selected {
  background: var(--primary-bg);
  border-color: var(--primary-border);
  box-shadow: 0 0 0 1px var(--primary-bg);
}

.type-card__info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.type-card__name {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-secondary);
}

.type-card__desc {
  font-size: 0.7rem;
  color: var(--text-muted);
  margin-top: 0.1rem;
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

.module-card--locked .module-card__header {
  cursor: default;
}

.module-card__checkbox {
  width: 18px;
  height: 18px;
  accent-color: var(--primary);
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

.module-sub input { accent-color: var(--primary); }

/* Form fields */
.create-site__fields {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

.create-site__fields--group {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--bar-bg);
}

.create-site__group-title {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 0 0 0.25rem;
}

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

.form-required { color: var(--primary); }

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

.form-input::placeholder { color: var(--text-placeholder); }

.form-input--mono {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8rem;
}

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

.form-select option {
  background: var(--select-bg);
  color: var(--text-primary);
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

.form-input-group {
  display: flex;
  gap: 0;
}

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

/* Aliases */
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
  color: var(--danger-light);
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

/* Review card */
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

.review-item__value--mono {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.75rem;
  word-break: break-all;
}

.review-item__hint {
  font-size: 0.7rem;
  color: var(--text-muted);
  margin-left: 0.25rem;
  font-family: 'JetBrains Mono', monospace;
}

.create-site__error {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.65rem 1rem;
  border-radius: 10px;
  background: var(--danger-bg);
  border: 1px solid var(--danger-border);
  color: var(--danger-light);
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
  background: linear-gradient(135deg, var(--primary-light), var(--primary-dark));
  color: var(--primary-text-on);
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
  border-top-color: var(--primary-text-on);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Live provisioning log */
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
.provision-status--success { color: #4ade80; }
.provision-status--error { color: var(--danger-light); }

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

.provision-log__line--warn { color: var(--primary-light); }
.provision-log__line--error { color: #f87171; }

@media (max-width: 768px) {
  .create-site { max-width: 100%; }
  .form-row { grid-template-columns: 1fr; }
  .create-site__title { font-size: 1.25rem; }
  .review-card__grid { grid-template-columns: 1fr; }
  .create-site__actions { flex-wrap: wrap; }
}
</style>
