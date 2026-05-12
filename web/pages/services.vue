<template>
  <div class="services">
    <div class="services__header">
      <div>
        <h1 class="services__title">Сервисы</h1>
        <p class="services__subtitle">
          Глобальные демоны (БД, поиск, кэш, очереди), которыми пользуются сайты.
          Базы данных подключаются ко всем сайтам сразу, остальные — per-site.
        </p>
      </div>
      <button
        class="btn btn--ghost btn--sm btn--icon"
        :disabled="loading"
        title="Обновить"
        aria-label="Обновить"
        @click="loadAll"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23,4 23,10 17,10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
      </button>
    </div>

    <div v-if="loading" class="services__loading">
      <div class="spinner" />
    </div>

    <div v-else-if="!items.length" class="services__empty">
      <CatMascot v-if="hasCatMascot" :size="64" mood="sleepy" />
      <p>Сервисы пока не зарегистрированы</p>
    </div>

    <div v-else class="services__grid">
      <div v-for="item in items" :key="item.key" class="svc-card">
        <div class="svc-card__head">
          <div class="svc-card__icon" :class="`svc-card__icon--${item.catalog.category}`">
            <svg v-if="item.catalog.icon === 'search'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <svg v-else-if="item.catalog.icon === 'cache'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
            <svg v-else-if="item.catalog.icon === 'database'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
            </svg>
            <svg v-else-if="item.catalog.icon === 'shield'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2 4 5v6c0 5 3.4 9.5 8 11 4.6-1.5 8-6 8-11V5l-8-3z" />
            </svg>
            <svg v-else-if="item.catalog.icon === 'mail'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
              <polyline points="22,6 12,13 2,6" />
            </svg>
            <svg v-else width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" /></svg>
          </div>
          <div class="svc-card__title-block">
            <div class="svc-card__title">{{ item.catalog.name }}</div>
            <div class="svc-card__category">{{ categoryLabel(item.catalog.category) }}</div>
          </div>
          <span
            class="svc-card__status"
            :class="item.installed ? 'svc-card__status--ok' : 'svc-card__status--idle'"
          >
            <span class="status-dot" :class="item.installed ? 'status-dot--ok' : 'status-dot--idle'" />
            {{ item.installed ? 'Установлен' : 'Не установлен' }}
          </span>
        </div>

        <p class="svc-card__desc">{{ item.catalog.description }}</p>

        <div class="svc-card__meta">
          <div class="svc-card__meta-row">
            <span class="svc-card__meta-label">Версия</span>
            <span class="svc-card__meta-value mono">{{ item.version || '—' }}</span>
          </div>
          <div class="svc-card__meta-row">
            <span class="svc-card__meta-label">{{ item.catalog.scope === 'global' ? 'Используется на сайтах' : 'Активен на сайтах' }}</span>
            <span class="svc-card__meta-value">{{ item.sitesUsing }}</span>
          </div>
          <div v-if="item.catalog.scope === 'global'" class="svc-card__meta-row">
            <span class="svc-card__meta-label">Тип</span>
            <span class="svc-card__meta-value">Глобальный (один на сервер)</span>
          </div>
          <div v-if="item.installedAt" class="svc-card__meta-row">
            <span class="svc-card__meta-label">Установлен</span>
            <span class="svc-card__meta-value">{{ formatDate(item.installedAt) }}</span>
          </div>
          <div v-if="item.lastError" class="svc-card__error">
            {{ item.lastError }}
          </div>
        </div>

        <div class="svc-card__actions">
          <!-- Install: системные сервисы (SSH) тоже могут «доустановиться» через apt
               idempotent — на нормальной Ubuntu это noop, но для аварийных машин
               без openssh-server пусть будет возможность. -->
          <button
            v-if="!item.installed"
            class="btn btn--primary btn--sm"
            :disabled="busy[item.key] === 'install'"
            @click="installService(item)"
          >
            {{ busy[item.key] === 'install' ? 'Установка…' : 'Установить' }}
          </button>
          <template v-else>
            <button
              v-if="hasPresets(item)"
              class="btn btn--primary btn--sm"
              :disabled="busy[item.key] === 'presets'"
              title="Каталог готовых fail2ban-пресетов (SSH, nginx, recidive)"
              @click="openPresetsModal(item)"
            >Пресеты</button>
            <button
              v-if="item.key === 'postfix'"
              class="btn btn--primary btn--sm"
              :disabled="busy[item.key] === 'relay'"
              title="Настройка smarthost: Gmail / Yandex / Mailgun / SendGrid / custom SMTP"
              @click="openRelayModal(item)"
            >Relay</button>
            <button
              v-if="item.key === 'postfix'"
              class="btn btn--ghost btn--sm"
              :disabled="busy[item.key] === 'test'"
              title="Отправить тестовое письмо через настроенный relay"
              @click="sendPostfixTest(item)"
            >{{ busy[item.key] === 'test' ? 'Отправляю…' : 'Тест' }}</button>
            <button
              v-if="canEditConfig(item)"
              class="btn btn--ghost btn--sm"
              :disabled="busy[item.key] === 'config'"
              :title="configTooltip(item)"
              @click="openConfigEditor(item)"
            >Конфиг</button>
            <button
              class="btn btn--ghost btn--sm"
              :disabled="busy[item.key] === 'refresh'"
              @click="refreshService(item)"
            >Проверить</button>
            <button
              class="btn btn--danger btn--sm"
              :disabled="!canUninstall(item) || item.sitesUsing > 0 || busy[item.key] === 'uninstall'"
              :title="uninstallTooltip(item)"
              @click="uninstallService(item)"
            >
              {{ busy[item.key] === 'uninstall' ? 'Удаление…' : 'Удалить' }}
            </button>
          </template>
        </div>
      </div>
    </div>

    <!-- Fail2ban presets modal -->
    <div
      v-if="presets.open"
      class="cfg-modal-overlay"
      @mousedown.self="!presets.saving && closePresetsModal()"
    >
      <div class="cfg-modal cfg-modal--narrow">
        <div class="cfg-modal__head">
          <div>
            <h3 class="cfg-modal__title">Fail2ban — пресеты защиты</h3>
            <p class="cfg-modal__path mono">{{ presets.managedFilePath || '/etc/fail2ban/jail.d/meowbox.local' }}</p>
          </div>
          <button
            class="cfg-modal__close"
            :disabled="presets.saving"
            aria-label="Закрыть"
            @click="closePresetsModal"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div class="cfg-modal__body cfg-modal__body--column">
          <div v-if="presets.loading" class="cfg-modal__loading">
            <div class="spinner" />
            <span>Загрузка пресетов…</span>
          </div>
          <div v-else-if="presets.loadError" class="cfg-modal__error">{{ presets.loadError }}</div>
          <template v-else>
            <div class="presets__defaults">
              <div class="presets__defaults-title">Дефолты [DEFAULT]</div>
              <div class="presets__defaults-grid">
                <label class="presets__field">
                  <span class="presets__field-label">bantime</span>
                  <input v-model="presets.defaults.bantime" class="presets__input mono" :disabled="presets.saving" placeholder="1h" />
                </label>
                <label class="presets__field">
                  <span class="presets__field-label">findtime</span>
                  <input v-model="presets.defaults.findtime" class="presets__input mono" :disabled="presets.saving" placeholder="10m" />
                </label>
                <label class="presets__field">
                  <span class="presets__field-label">maxretry</span>
                  <input v-model="presets.defaults.maxretry" class="presets__input mono" :disabled="presets.saving" placeholder="5" />
                </label>
              </div>
              <p class="presets__hint">Форматы: <code>30s</code>, <code>10m</code>, <code>1h</code>, <code>1d</code>, <code>1w</code> или число секунд. Применяется ко всем включённым пресетам.</p>
            </div>

            <div class="presets__list">
              <label
                v-for="p in presets.items"
                :key="p.key"
                class="preset-item"
                :class="{ 'preset-item--enabled': p.enabled }"
              >
                <input
                  type="checkbox"
                  v-model="p.enabled"
                  :disabled="presets.saving"
                  class="preset-item__check"
                />
                <div class="preset-item__body">
                  <div class="preset-item__name">{{ p.name }}</div>
                  <div class="preset-item__desc">{{ p.description }}</div>
                </div>
              </label>
            </div>
          </template>
        </div>

        <div v-if="presets.saveError" class="cfg-modal__error cfg-modal__error--inline">{{ presets.saveError }}</div>
        <div v-if="presets.saveResult" class="cfg-modal__ok">
          ✓ Пресеты применены: <span class="mono">{{ presets.saveResult.path }}</span><br />
          ✓ <span class="mono">{{ presets.saveResult.restart.unit }}</span> перезапущен.
        </div>

        <div class="cfg-modal__foot">
          <button
            class="btn btn--ghost btn--sm"
            :disabled="presets.saving"
            @click="closePresetsModal"
          >Закрыть</button>
          <button
            class="btn btn--primary btn--sm"
            :disabled="presets.saving || presets.loading || !!presets.loadError"
            @click="applyPresets"
          >
            {{ presets.saving ? 'Применяю…' : 'Применить + перезапустить' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Postfix relay modal -->
    <div
      v-if="relay.open"
      class="cfg-modal-overlay"
      @mousedown.self="!relay.saving && closeRelayModal()"
    >
      <div class="cfg-modal cfg-modal--narrow">
        <div class="cfg-modal__head">
          <div>
            <h3 class="cfg-modal__title">Postfix — relay через SMTP</h3>
            <p class="cfg-modal__path mono">{{ relay.state?.mainCfPath || '/etc/postfix/main.cf' }}</p>
          </div>
          <button
            class="cfg-modal__close"
            :disabled="relay.saving"
            aria-label="Закрыть"
            @click="closeRelayModal"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div class="cfg-modal__body cfg-modal__body--column">
          <div v-if="relay.loading" class="cfg-modal__loading">
            <div class="spinner" />
            <span>Загрузка relay-конфигурации…</span>
          </div>
          <div v-else-if="relay.loadError" class="cfg-modal__error">{{ relay.loadError }}</div>
          <template v-else>
            <div class="relay__status" v-if="relay.state?.configured">
              <span class="relay__status-dot relay__status-dot--ok"></span>
              <span>Relay настроен: <span class="mono">{{ relay.state?.host }}:{{ relay.state?.port }}</span> от <span class="mono">{{ relay.state?.username }}</span></span>
            </div>
            <div class="relay__status relay__status--warn" v-else>
              <span class="relay__status-dot relay__status-dot--warn"></span>
              <span>Relay не настроен — системные письма не отправляются никуда</span>
            </div>

            <label class="relay__field">
              <span class="relay__field-label">SMTP пресет</span>
              <select v-model="relay.form.preset" class="relay__input" :disabled="relay.saving" @change="onPresetChange">
                <option v-for="p in relay.presets" :key="p.key" :value="p.key">{{ p.name }}</option>
              </select>
            </label>

            <div v-if="currentPresetHint" class="relay__hint">{{ currentPresetHint }}</div>

            <div class="relay__row">
              <label class="relay__field relay__field--grow">
                <span class="relay__field-label">SMTP host</span>
                <input v-model="relay.form.host" class="relay__input mono" :disabled="relay.saving || relay.form.preset !== 'custom'" placeholder="smtp.example.com" />
              </label>
              <label class="relay__field relay__field--port">
                <span class="relay__field-label">Port</span>
                <input v-model.number="relay.form.port" class="relay__input mono" :disabled="relay.saving || relay.form.preset !== 'custom'" type="number" min="1" max="65535" />
              </label>
            </div>

            <label class="relay__check" v-if="relay.form.preset === 'custom'">
              <input type="checkbox" v-model="relay.form.wrapperSSL" :disabled="relay.saving" />
              <span>SMTPS (SSL wrappermode) — обычно для порта 465. Для 587 (STARTTLS) — выключить.</span>
            </label>

            <label class="relay__field">
              <span class="relay__field-label">Username (логин SMTP)</span>
              <input v-model="relay.form.username" class="relay__input mono" :disabled="relay.saving" placeholder="user@gmail.com" />
            </label>

            <label class="relay__field">
              <span class="relay__field-label">Password / App password / API key</span>
              <input
                v-model="relay.form.password"
                class="relay__input mono"
                :type="relay.showPassword ? 'text' : 'password'"
                :disabled="relay.saving"
                :placeholder="relay.state?.hasPassword ? '(сохранён, заполни чтобы перезаписать)' : 'обязательно'"
              />
              <span class="relay__field-hint">
                <button type="button" class="relay__toggle-btn" :disabled="relay.saving" @click="relay.showPassword = !relay.showPassword">
                  {{ relay.showPassword ? 'Скрыть' : 'Показать' }}
                </button>
                Сохраняется в <span class="mono">/etc/postfix/sasl_passwd</span> (root:root 0600). Через панель наружу не отдаётся.
              </span>
            </label>

            <label class="relay__field">
              <span class="relay__field-label">From: (адрес отправителя в письмах)</span>
              <input v-model="relay.form.fromEmail" class="relay__input mono" :disabled="relay.saving" placeholder="alerts@example.com" />
            </label>

            <label class="relay__field">
              <span class="relay__field-label">Куда форвардить root@/postmaster@ (admin email)</span>
              <input v-model="relay.form.adminEmail" class="relay__input mono" :disabled="relay.saving" placeholder="you@example.com" />
            </label>

            <label class="relay__field">
              <span class="relay__field-label">myhostname (HELO)</span>
              <input v-model="relay.form.myhostname" class="relay__input mono" :disabled="relay.saving" placeholder="server.example.com" />
              <span class="relay__field-hint">FQDN сервера. Обычно совпадает с обратной DNS-записью.</span>
            </label>
          </template>
        </div>

        <div v-if="relay.saveError" class="cfg-modal__error cfg-modal__error--inline">{{ relay.saveError }}</div>
        <div v-if="relay.saveResult" class="cfg-modal__ok">
          ✓ Конфиг записан: <span class="mono">{{ relay.saveResult.paths.join(', ') }}</span><br />
          ✓ <span class="mono">{{ relay.saveResult.restart.unit }}</span> перезапущен.
        </div>

        <div class="cfg-modal__foot">
          <button
            class="btn btn--ghost btn--sm"
            :disabled="relay.saving"
            @click="closeRelayModal"
          >Закрыть</button>
          <button
            class="btn btn--primary btn--sm"
            :disabled="relay.saving || relay.loading || !!relay.loadError"
            @click="applyRelay"
          >
            {{ relay.saving ? 'Применяю…' : 'Применить + перезапустить' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Config editor modal: textarea с моноширинным шрифтом, для PG — вкладки. -->
    <div
      v-if="editor.open"
      class="cfg-modal-overlay"
      @mousedown.self="!editor.saving && closeConfigEditor()"
    >
      <div class="cfg-modal">
        <div class="cfg-modal__head">
          <div>
            <h3 class="cfg-modal__title">Конфигурация — {{ editor.serviceName }}</h3>
            <p class="cfg-modal__path mono">{{ editor.currentFile?.path || '…' }}</p>
          </div>
          <button
            class="cfg-modal__close"
            :disabled="editor.saving"
            aria-label="Закрыть"
            @click="closeConfigEditor"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div v-if="editor.files.length > 1" class="cfg-modal__tabs">
          <button
            v-for="f in editor.files"
            :key="f.file"
            class="cfg-modal__tab"
            :class="{ 'cfg-modal__tab--active': f.file === editor.activeFile, 'cfg-modal__tab--dirty': editor.dirty[f.file] }"
            :disabled="editor.saving || editor.loading"
            @click="switchConfigTab(f.file)"
          >
            {{ f.file }}<span v-if="editor.dirty[f.file]"> •</span>
          </button>
        </div>

        <div class="cfg-modal__body">
          <div v-if="editor.loading" class="cfg-modal__loading">
            <div class="spinner" />
            <span>Загрузка конфига…</span>
          </div>
          <div v-else-if="editor.loadError" class="cfg-modal__error">
            {{ editor.loadError }}
          </div>
          <textarea
            v-else
            v-model="editor.content"
            class="cfg-modal__textarea"
            spellcheck="false"
            autocorrect="off"
            autocapitalize="off"
            :disabled="editor.saving"
            @input="markDirty"
          />
        </div>

        <div v-if="editor.saveError" class="cfg-modal__error cfg-modal__error--inline">{{ editor.saveError }}</div>
        <div v-if="editor.saveResult" class="cfg-modal__ok">
          ✓ Сохранено. Бэкап: <span class="mono">{{ editor.saveResult.backupPath }}</span><br />
          <template v-if="editor.restartResult">
            ✓ <span class="mono">{{ editor.restartResult.unit }}</span> перезапущен.
          </template>
        </div>

        <div class="cfg-modal__foot">
          <button
            class="btn btn--ghost btn--sm"
            :disabled="editor.saving"
            @click="closeConfigEditor"
          >Закрыть</button>
          <button
            class="btn btn--primary btn--sm"
            :disabled="editor.saving || editor.loading || !!editor.loadError || !isAnyDirty"
            @click="saveAndRestart"
          >
            {{ editor.saving ? 'Сохраняю…' : 'Сохранить + перезапустить' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface ServerSvc {
  key: string;
  catalog: {
    key: string;
    name: string;
    description: string;
    category: string;
    icon: string;
    /** 'per-site' — Redis/Manticore (per-site инстанс), 'global' — MariaDB/PostgreSQL */
    scope?: 'per-site' | 'global';
    /** Если false — кнопка «Удалить» в UI должна быть заблокирована (SSH). */
    uninstallable?: boolean;
    /**
     * Системный сервис (SSH) — установлен всегда, кнопку «Установить» скрываем,
     * «Удалить» — заблокирована с tooltip'ом «системный сервис».
     */
    systemCore?: boolean;
  };
  installed: boolean;
  version: string | null;
  installedAt: string | null;
  lastError: string | null;
  sitesUsing: number;
}

const api = useApi();
const toast = useMbToast();

const items = ref<ServerSvc[]>([]);
const loading = ref(true);
const busy = reactive<Record<string, string>>({});

// -- Config editor state --
interface ConfigFileInfo { file: string; path: string; exists: boolean; }
interface SaveResult { path: string; backupPath: string; }
interface RestartResult { unit: string; ok: boolean; output: string; }

const editor = reactive<{
  open: boolean;
  serviceKey: string;
  serviceName: string;
  loading: boolean;
  saving: boolean;
  loadError: string;
  saveError: string;
  files: ConfigFileInfo[];
  activeFile: string;
  /** Локально загруженный контент по каждому файлу — переключение вкладок без потери правок. */
  contents: Record<string, string>;
  /** Оригинальный контент (для определения dirty). */
  originals: Record<string, string>;
  /** Был ли файл изменён. */
  dirty: Record<string, boolean>;
  /** Текущий редактируемый текст (привязка к textarea). */
  content: string;
  currentFile: ConfigFileInfo | null;
  saveResult: SaveResult | null;
  restartResult: RestartResult | null;
}>({
  open: false,
  serviceKey: '',
  serviceName: '',
  loading: false,
  saving: false,
  loadError: '',
  saveError: '',
  files: [],
  activeFile: '',
  contents: {},
  originals: {},
  dirty: {},
  content: '',
  currentFile: null,
  saveResult: null,
  restartResult: null,
});

const isAnyDirty = computed(() => Object.values(editor.dirty).some((v) => v));

// -- Fail2ban presets state --
interface PresetItem { key: string; name: string; description: string; enabled: boolean; }
interface PresetsApplyResult {
  path: string;
  restart: { unit: string; ok: boolean; output: string };
}

const presets = reactive<{
  open: boolean;
  loading: boolean;
  saving: boolean;
  loadError: string;
  saveError: string;
  items: PresetItem[];
  defaults: { bantime: string; findtime: string; maxretry: string };
  managedFilePath: string;
  saveResult: PresetsApplyResult | null;
}>({
  open: false,
  loading: false,
  saving: false,
  loadError: '',
  saveError: '',
  items: [],
  defaults: { bantime: '1h', findtime: '10m', maxretry: '5' },
  managedFilePath: '',
  saveResult: null,
});

// -- Postfix relay state --
interface RelayPreset {
  key: string;
  name: string;
  description: string;
  host: string;
  port: number;
  wrapperSSL: boolean;
  hint?: string;
  defaultUsername?: string;
}

interface RelayState {
  configured: boolean;
  preset: string | null;
  host: string | null;
  port: number | null;
  wrapperSSL: boolean | null;
  username: string | null;
  hasPassword: boolean;
  fromEmail: string | null;
  adminEmail: string | null;
  myhostname: string | null;
  mainCfPath: string;
  saslPasswdPath: string;
}

interface RelayApplyResult {
  paths: string[];
  restart: { unit: string; ok: boolean; output: string };
}

const relay = reactive<{
  open: boolean;
  loading: boolean;
  saving: boolean;
  loadError: string;
  saveError: string;
  presets: RelayPreset[];
  state: RelayState | null;
  form: {
    preset: string;
    host: string;
    port: number;
    wrapperSSL: boolean;
    username: string;
    password: string;
    fromEmail: string;
    adminEmail: string;
    myhostname: string;
  };
  showPassword: boolean;
  saveResult: RelayApplyResult | null;
}>({
  open: false,
  loading: false,
  saving: false,
  loadError: '',
  saveError: '',
  presets: [],
  state: null,
  form: {
    preset: 'gmail',
    host: '',
    port: 587,
    wrapperSSL: false,
    username: '',
    password: '',
    fromEmail: '',
    adminEmail: '',
    myhostname: '',
  },
  showPassword: false,
  saveResult: null,
});

const currentPresetHint = computed(() => {
  const p = relay.presets.find((x) => x.key === relay.form.preset);
  return p?.hint || '';
});

async function openRelayModal(item: ServerSvc) {
  if (item.key !== 'postfix') return;
  relay.open = true;
  relay.loading = true;
  relay.loadError = '';
  relay.saveError = '';
  relay.saveResult = null;
  relay.showPassword = false;
  try {
    const data = await api.get<{ catalog: RelayPreset[]; state: RelayState }>('/services/postfix/relay');
    relay.presets = data.catalog;
    relay.state = data.state;
    // Префилл формы текущим состоянием. Пароль никогда не приходит — оставляем
    // пустым, юзер либо вводит новый, либо оставляет пустым (тогда применить нельзя).
    const st = data.state;
    const initialPreset = st.preset || 'gmail';
    const presetCfg = relay.presets.find((p) => p.key === initialPreset);
    relay.form.preset = initialPreset;
    relay.form.host = st.host || presetCfg?.host || '';
    relay.form.port = st.port ?? presetCfg?.port ?? 587;
    relay.form.wrapperSSL = (st.wrapperSSL ?? presetCfg?.wrapperSSL) || false;
    relay.form.username = st.username || presetCfg?.defaultUsername || '';
    relay.form.password = '';
    relay.form.fromEmail = st.fromEmail || '';
    relay.form.adminEmail = st.adminEmail || '';
    relay.form.myhostname = st.myhostname || '';
  } catch (err) {
    relay.loadError = (err as Error).message || 'Не удалось загрузить relay';
  } finally {
    relay.loading = false;
  }
}

function onPresetChange() {
  const p = relay.presets.find((x) => x.key === relay.form.preset);
  if (!p) return;
  // Custom — позволяем редактировать host/port руками; для остальных подставляем.
  if (p.key !== 'custom') {
    relay.form.host = p.host;
    relay.form.port = p.port;
    relay.form.wrapperSSL = p.wrapperSSL;
  }
  if (p.defaultUsername && !relay.form.username) {
    relay.form.username = p.defaultUsername;
  }
}

function closeRelayModal() {
  if (relay.saving) return;
  relay.open = false;
}

async function applyRelay() {
  // Минимальная валидация на фронте — основная на бэке.
  if (!relay.form.host || !relay.form.username || !relay.form.password
      || !relay.form.fromEmail || !relay.form.adminEmail || !relay.form.myhostname) {
    relay.saveError = 'Заполни все поля (включая password — он не сохраняется в форме после применения)';
    return;
  }
  if (!confirm(`Применить relay-конфиг и перезапустить Postfix?\n\nSMTP: ${relay.form.host}:${relay.form.port}\nUser: ${relay.form.username}\nFrom: ${relay.form.fromEmail}\nAdmin: ${relay.form.adminEmail}\n\nЕсли restart упадёт — настройки откатим автоматически.`)) {
    return;
  }
  relay.saving = true;
  relay.saveError = '';
  relay.saveResult = null;
  try {
    const res = await api.post<RelayApplyResult>('/services/postfix/relay', relay.form);
    relay.saveResult = res;
    // Обновим state по факту применения (без перезагрузки модалки).
    if (relay.state) {
      relay.state.configured = true;
      relay.state.host = relay.form.host;
      relay.state.port = relay.form.port;
      relay.state.wrapperSSL = relay.form.wrapperSSL;
      relay.state.username = relay.form.username;
      relay.state.hasPassword = true;
      relay.state.fromEmail = relay.form.fromEmail;
      relay.state.adminEmail = relay.form.adminEmail;
      relay.state.myhostname = relay.form.myhostname;
      relay.state.preset = relay.form.preset;
    }
    // Пароль из формы сразу затираем — больше не нужен.
    relay.form.password = '';
    toast.success('Postfix relay применён');
  } catch (err) {
    relay.saveError = (err as Error).message || 'Не удалось применить relay';
    toast.error(relay.saveError);
  } finally {
    relay.saving = false;
  }
}

async function sendPostfixTest(item: ServerSvc) {
  const to = prompt('На какой email отправить тестовое письмо?', '');
  if (!to) return;
  busy[item.key] = 'test';
  try {
    const res = await api.post<{ sent: boolean; log: string }>('/services/postfix/test-email', { toEmail: to.trim() });
    toast.success(`Тестовое письмо отправлено на ${to}`);
    // Показываем последние строки mail.log в alert — proxima diagnostic.
    if (res.log) {
      // Берём только последние 15 строк, иначе alert разрастётся.
      const tail = res.log.split(/\r?\n/).filter(Boolean).slice(-15).join('\n');
      alert(`Письмо передано в sendmail. Если на ${to} не пришло — смотри /var/log/mail.log.\n\nПоследние строки:\n${tail}`);
    }
  } catch (err) {
    toast.error((err as Error).message || 'Не удалось отправить тестовое письмо');
  } finally {
    delete busy[item.key];
  }
}

async function openPresetsModal(item: ServerSvc) {
  if (item.key !== 'fail2ban') return;
  presets.open = true;
  presets.loading = true;
  presets.loadError = '';
  presets.saveError = '';
  presets.saveResult = null;
  presets.items = [];
  try {
    const data = await api.get<{
      catalog: Array<{ key: string; name: string; description: string }>;
      state: {
        presets: PresetItem[];
        defaults: { bantime: string; findtime: string; maxretry: string };
        managedFilePath: string;
        managedFileExists: boolean;
      };
    }>('/services/fail2ban/presets');
    // Берём порядок из catalog (он стабильный), но enabled — из state.
    const stateByKey = new Map(data.state.presets.map((p) => [p.key, p]));
    presets.items = data.catalog.map((c) => ({
      key: c.key,
      name: c.name,
      description: c.description,
      enabled: stateByKey.get(c.key)?.enabled ?? false,
    }));
    presets.defaults = { ...data.state.defaults };
    presets.managedFilePath = data.state.managedFilePath;
  } catch (err) {
    presets.loadError = (err as Error).message || 'Не удалось загрузить пресеты';
  } finally {
    presets.loading = false;
  }
}

function closePresetsModal() {
  if (presets.saving) return;
  presets.open = false;
}

async function applyPresets() {
  const enabledKeys = presets.items.filter((p) => p.enabled).map((p) => p.key);
  const list = enabledKeys.length
    ? `Включаем ${enabledKeys.length} пресет(ов): ${enabledKeys.join(', ')}.`
    : 'Все пресеты будут выключены — fail2ban не будет банить ничего из ранее активированных правил.';
  if (!confirm(`Применить пресеты fail2ban и перезапустить демон?\n\n${list}\n\nЕсли рестарт упадёт — настройки откатим автоматически.`)) {
    return;
  }
  presets.saving = true;
  presets.saveError = '';
  presets.saveResult = null;
  try {
    const res = await api.post<PresetsApplyResult>('/services/fail2ban/presets', {
      enabledKeys,
      defaults: presets.defaults,
    });
    presets.saveResult = res;
    toast.success('Fail2ban перезапущен с новыми пресетами');
  } catch (err) {
    presets.saveError = (err as Error).message || 'Не удалось применить пресеты';
    toast.error(presets.saveError);
  } finally {
    presets.saving = false;
  }
}

function canEditConfig(item: ServerSvc): boolean {
  // Whitelisted сервисы с глобальным конфигом (см. API ServerConfigExecutor):
  //   mariadb     → my.cnf
  //   postgresql  → postgresql.conf + pg_hba.conf
  //   ssh         → sshd_config
  //   fail2ban    → jail.local
  return item.key === 'mariadb'
    || item.key === 'postgresql'
    || item.key === 'ssh'
    || item.key === 'fail2ban'
    || item.key === 'postfix';
}

function hasPresets(item: ServerSvc): boolean {
  return item.key === 'fail2ban';
}

function canUninstall(item: ServerSvc): boolean {
  // catalog.uninstallable===false означает «системный сервис, удаление запрещено»
  // (SSH). Без этого поля — по умолчанию true.
  return item.catalog.uninstallable !== false;
}

function isSystemCore(item: ServerSvc): boolean {
  return item.catalog.systemCore === true;
}

function configTooltip(item: ServerSvc): string {
  switch (item.key) {
    case 'mariadb': return 'Редактировать /etc/mysql/my.cnf';
    case 'postgresql': return 'Редактировать postgresql.conf + pg_hba.conf';
    case 'ssh': return 'Редактировать /etc/ssh/sshd_config (валидация через sshd -t перед сохранением)';
    case 'fail2ban': return 'Редактировать /etc/fail2ban/jail.local (ручные overrides, пресеты — отдельно)';
    case 'postfix': return 'Редактировать main.cf / master.cf / aliases (relay настраивается через отдельную модалку)';
    default: return 'Редактировать конфиг';
  }
}

function uninstallTooltip(item: ServerSvc): string {
  if (!canUninstall(item)) {
    return 'Системный сервис — удаление через панель запрещено';
  }
  if (item.sitesUsing > 0) {
    return item.catalog.scope === 'global'
      ? 'Сначала удали все БД этого движка на странице /databases'
      : 'Сначала отключи сервис у всех сайтов';
  }
  return '';
}

async function openConfigEditor(item: ServerSvc) {
  editor.open = true;
  editor.serviceKey = item.key;
  editor.serviceName = item.catalog.name;
  editor.loading = true;
  editor.saving = false;
  editor.loadError = '';
  editor.saveError = '';
  editor.saveResult = null;
  editor.restartResult = null;
  editor.files = [];
  editor.contents = {};
  editor.originals = {};
  editor.dirty = {};
  editor.activeFile = '';
  editor.content = '';
  editor.currentFile = null;
  try {
    const files = await api.get<ConfigFileInfo[]>(`/services/${item.key}/config`);
    editor.files = files;
    // Стартовая вкладка — первая existing. Если все missing → первая (покажем ошибку при попытке load).
    const first = files.find((f) => f.exists) || files[0];
    if (!first) {
      editor.loadError = 'У сервиса нет конфигурационных файлов для редактирования';
      editor.loading = false;
      return;
    }
    await loadConfigFile(first.file);
  } catch (err) {
    editor.loadError = (err as Error).message || 'Не удалось получить список конфигов';
    editor.loading = false;
  }
}

async function loadConfigFile(file: string) {
  editor.loading = true;
  editor.loadError = '';
  editor.activeFile = file;
  editor.currentFile = editor.files.find((f) => f.file === file) || null;
  try {
    // Если уже загружали — берём из локального кеша (вместе с локальными правками).
    if (file in editor.contents) {
      editor.content = editor.contents[file];
      editor.loading = false;
      return;
    }
    const data = await api.get<{ path: string; content: string; size: number; utf8: boolean }>(
      `/services/${editor.serviceKey}/config/${encodeURIComponent(file)}`,
    );
    if (!data.utf8) {
      editor.loadError = 'Файл не является UTF-8 текстом — отказ в редактировании';
      editor.loading = false;
      return;
    }
    editor.contents[file] = data.content;
    editor.originals[file] = data.content;
    editor.dirty[file] = false;
    editor.content = data.content;
    if (editor.currentFile) editor.currentFile.path = data.path;
  } catch (err) {
    editor.loadError = (err as Error).message || 'Не удалось загрузить конфиг';
  } finally {
    editor.loading = false;
  }
}

async function switchConfigTab(file: string) {
  if (file === editor.activeFile) return;
  // Сохраняем локальные правки текущей вкладки.
  if (editor.activeFile) editor.contents[editor.activeFile] = editor.content;
  await loadConfigFile(file);
}

function markDirty() {
  editor.contents[editor.activeFile] = editor.content;
  editor.dirty[editor.activeFile] = editor.content !== editor.originals[editor.activeFile];
}

async function saveAndRestart() {
  if (!isAnyDirty.value) return;
  const dirtyFiles = editor.files.filter((f) => editor.dirty[f.file]);
  if (!dirtyFiles.length) return;
  // Подтверждение — рестарт сервиса грохнет активные коннекты.
  const fileList = dirtyFiles.map((f) => f.file).join(', ');
  if (!confirm(`Сохранить изменения (${fileList}) и перезапустить ${editor.serviceName}?\n\nАктивные соединения с сервисом будут разорваны.`)) {
    return;
  }
  editor.saving = true;
  editor.saveError = '';
  editor.saveResult = null;
  editor.restartResult = null;
  try {
    let lastResult: SaveResult | null = null;
    for (const f of dirtyFiles) {
      const res = await api.post<SaveResult>(
        `/services/${editor.serviceKey}/config/${encodeURIComponent(f.file)}`,
        { content: editor.contents[f.file] },
      );
      lastResult = res;
      // Обновим origin/dirty.
      editor.originals[f.file] = editor.contents[f.file];
      editor.dirty[f.file] = false;
    }
    editor.saveResult = lastResult;
    // Restart.
    editor.restartResult = await api.post<RestartResult>(
      `/services/${editor.serviceKey}/restart`,
    );
    toast.success(`${editor.serviceName} перезапущен`);
  } catch (err) {
    editor.saveError = (err as Error).message || 'Не удалось сохранить / перезапустить';
    toast.error(editor.saveError);
  } finally {
    editor.saving = false;
  }
}

function closeConfigEditor() {
  if (editor.saving) return;
  if (isAnyDirty.value && !confirm('Есть несохранённые изменения. Закрыть без сохранения?')) {
    return;
  }
  editor.open = false;
}

// Если CatMascot не зарегистрирован глобально — не валиться. У nuxt компоненты
// auto-import, эта переменная — просто страховка для шаблона.
const hasCatMascot = true;

async function loadAll() {
  loading.value = true;
  try {
    items.value = await api.get<ServerSvc[]>('/services');
  } catch (err) {
    toast.error((err as Error).message || 'Не удалось загрузить сервисы');
    items.value = [];
  } finally {
    loading.value = false;
  }
}

async function refreshService(item: ServerSvc) {
  busy[item.key] = 'refresh';
  try {
    const updated = await api.get<ServerSvc>(`/services/${item.key}`);
    Object.assign(item, updated);
    toast.success('Статус обновлён');
  } catch (err) {
    toast.error((err as Error).message || 'Не удалось обновить статус');
  } finally {
    delete busy[item.key];
  }
}

async function installService(item: ServerSvc) {
  if (!confirm(`Установить «${item.catalog.name}» на сервер? Это поставит apt-пакет и подготовит template-unit.`)) return;
  busy[item.key] = 'install';
  try {
    const updated = await api.post<ServerSvc>(`/services/${item.key}/install`);
    Object.assign(item, updated);
    toast.success(`${item.catalog.name} установлен (${item.version || ''})`);
  } catch (err) {
    toast.error((err as Error).message || 'Установка провалилась');
  } finally {
    delete busy[item.key];
  }
}

async function uninstallService(item: ServerSvc) {
  if (!confirm(`Удалить «${item.catalog.name}» с сервера?\n\nДанные сайтов в /var/lib/${item.key}/* НЕ удаляются автоматически — отключи сервис у каждого сайта заранее.`)) return;
  busy[item.key] = 'uninstall';
  try {
    await api.del(`/services/${item.key}`);
    item.installed = false;
    item.version = null;
    item.installedAt = null;
    toast.success(`${item.catalog.name} удалён с сервера`);
  } catch (err) {
    toast.error((err as Error).message || 'Удаление провалилось');
  } finally {
    delete busy[item.key];
  }
}

function categoryLabel(c: string): string {
  switch (c) {
    case 'search': return 'Поиск';
    case 'cache': return 'Кэш';
    case 'queue': return 'Очереди';
    case 'database': return 'База данных';
    case 'security': return 'Безопасность';
    case 'mail': return 'Почта';
    default: return 'Сервис';
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

onMounted(loadAll);
</script>

<style scoped>
.services {
  padding: 1.25rem 1.5rem 2rem;
  max-width: 1400px;
}

.services__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.services__title {
  font-size: 1.45rem;
  font-weight: 600;
  margin: 0 0 0.25rem 0;
  color: var(--text-primary);
}

.services__subtitle {
  font-size: 0.85rem;
  color: var(--text-tertiary);
  margin: 0;
}

.services__loading,
.services__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 4rem 2rem;
  color: var(--text-tertiary);
}

.services__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 1rem;
}

.svc-card {
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 14px;
  padding: 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.svc-card:hover {
  border-color: var(--border-strong, rgba(255, 255, 255, 0.12));
}

.svc-card__head {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.75rem;
}

.svc-card__icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(99, 102, 241, 0.12);
  color: rgb(129, 140, 248);
}

.svc-card__icon--search {
  background: rgba(var(--primary-rgb), 0.13);
  color: var(--primary-light);
}
.svc-card__icon--cache {
  background: rgba(16, 185, 129, 0.13);
  color: rgb(52, 211, 153);
}
.svc-card__icon--queue {
  background: rgba(168, 85, 247, 0.13);
  color: rgb(192, 132, 252);
}
.svc-card__icon--database {
  background: rgba(59, 130, 246, 0.13);
  color: rgb(96, 165, 250);
}
.svc-card__icon--security {
  background: rgba(244, 114, 182, 0.13);
  color: rgb(244, 114, 182);
}
.svc-card__icon--mail {
  background: rgba(251, 146, 60, 0.13);
  color: rgb(251, 146, 60);
}

.svc-card__title-block {
  min-width: 0;
}

.svc-card__title {
  font-size: 0.97rem;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.svc-card__category {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-tertiary);
  margin-top: 2px;
}

.svc-card__status {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.72rem;
  font-weight: 500;
  padding: 0.25rem 0.55rem;
  border-radius: 999px;
  white-space: nowrap;
}

.svc-card__status--ok {
  background: rgba(16, 185, 129, 0.13);
  color: rgb(52, 211, 153);
}

.svc-card__status--idle {
  background: rgba(115, 115, 115, 0.18);
  color: var(--text-tertiary);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.status-dot--ok { background: rgb(52, 211, 153); box-shadow: 0 0 6px rgba(52, 211, 153, 0.6); }
.status-dot--idle { background: rgb(115, 115, 115); }
.status-dot--err { background: rgb(239, 68, 68); box-shadow: 0 0 6px rgba(239, 68, 68, 0.5); }

.svc-card__desc {
  font-size: 0.82rem;
  color: var(--text-secondary);
  line-height: 1.5;
  margin: 0;
}

.svc-card__meta {
  border-top: 1px solid var(--border-subtle);
  padding-top: 0.7rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.svc-card__meta-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 0.8rem;
}

.svc-card__meta-label {
  color: var(--text-tertiary);
}

.svc-card__meta-value {
  color: var(--text-primary);
  font-weight: 500;
}

.svc-card__error {
  font-size: 0.78rem;
  color: rgb(248, 113, 113);
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.25);
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
  word-break: break-word;
}

.svc-card__actions {
  display: flex;
  gap: 0.5rem;
  margin-top: auto;
}

.svc-card__actions .btn {
  flex: 1;
}

.btn {
  display: inline-flex; align-items: center; justify-content: center;
  gap: 0.4rem; padding: 0.55rem 1rem;
  border-radius: 10px; border: none; font-size: 0.82rem; font-weight: 600;
  font-family: inherit; cursor: pointer; transition: all 0.2s; white-space: nowrap;
}
.btn--sm { padding: 0.45rem 0.85rem; font-size: 0.75rem; border-radius: 8px; }
.btn--icon { padding: 0.45rem; width: 32px; height: 32px; flex: 0 0 auto; }
.btn--primary { background: linear-gradient(135deg, var(--primary-light), var(--primary-dark)); color: var(--primary-text-on); }
.btn--primary:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(var(--primary-rgb), 0.2); }
.btn--primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--ghost { background: var(--bg-input); border: 1px solid var(--border-strong); color: var(--text-tertiary); }
.btn--ghost:hover:not(:disabled) { color: var(--text-secondary); border-color: var(--border-strong); }
.btn--ghost:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--danger { background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); color: rgb(248, 113, 113); }
.btn--danger:hover:not(:disabled) { background: rgba(239, 68, 68, 0.25); }
.btn--danger:disabled { opacity: 0.4; cursor: not-allowed; }

.spinner { width: 24px; height: 24px; border: 2px solid var(--spinner-track); border-top-color: var(--primary); border-radius: 50%; animation: spin 0.8s linear infinite; }

@keyframes spin { to { transform: rotate(360deg); } }

.mono {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.78rem;
}

/* --- Config editor modal --- */
.cfg-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
}
.cfg-modal {
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 14px;
  width: min(960px, 100%);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
}
.cfg-modal__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.25rem 0.75rem;
  border-bottom: 1px solid var(--border-subtle);
}
.cfg-modal__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
}
.cfg-modal__path {
  margin: 0.2rem 0 0 0;
  font-size: 0.74rem;
  color: var(--text-tertiary);
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  word-break: break-all;
}
.cfg-modal__close {
  background: transparent;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  padding: 0.25rem;
  border-radius: 6px;
}
.cfg-modal__close:hover:not(:disabled) {
  background: var(--bg-input);
  color: var(--text-primary);
}
.cfg-modal__tabs {
  display: flex;
  gap: 0.25rem;
  padding: 0.5rem 1.25rem 0;
  border-bottom: 1px solid var(--border-subtle);
}
.cfg-modal__tab {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 0.5rem 0.85rem;
  font-size: 0.78rem;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.cfg-modal__tab:hover:not(:disabled) { color: var(--text-secondary); }
.cfg-modal__tab--active {
  color: var(--text-primary);
  border-bottom-color: var(--primary);
}
.cfg-modal__tab--dirty { color: rgb(250, 204, 21); }
.cfg-modal__tab:disabled { cursor: not-allowed; opacity: 0.5; }

.cfg-modal__body {
  flex: 1;
  display: flex;
  padding: 1rem 1.25rem;
  min-height: 320px;
  overflow: hidden;
}
.cfg-modal__loading {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.7rem;
  color: var(--text-tertiary);
}
.cfg-modal__error {
  flex: 1;
  padding: 0.9rem 1rem;
  font-size: 0.82rem;
  color: rgb(248, 113, 113);
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: 8px;
  word-break: break-word;
}
.cfg-modal__error--inline {
  margin: 0 1.25rem;
  flex: none;
}
.cfg-modal__ok {
  margin: 0 1.25rem;
  padding: 0.6rem 0.85rem;
  font-size: 0.78rem;
  color: rgb(52, 211, 153);
  background: rgba(16, 185, 129, 0.1);
  border: 1px solid rgba(16, 185, 129, 0.25);
  border-radius: 8px;
}
.cfg-modal__textarea {
  flex: 1;
  width: 100%;
  min-height: 360px;
  max-height: calc(90vh - 220px);
  resize: vertical;
  background: var(--bg-input);
  color: var(--text-primary);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  padding: 0.75rem 0.9rem;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.82rem;
  line-height: 1.45;
  tab-size: 4;
  outline: none;
  transition: border-color 0.15s;
}
.cfg-modal__textarea:focus { border-color: var(--primary); }
.cfg-modal__textarea:disabled { opacity: 0.7; }
.cfg-modal__foot {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.85rem 1.25rem;
  border-top: 1px solid var(--border-subtle);
}

.cfg-modal--narrow {
  width: min(640px, 100%);
}
.cfg-modal__body--column {
  flex-direction: column;
  gap: 1rem;
  min-height: 200px;
  overflow-y: auto;
}

.presets__defaults {
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  padding: 0.85rem;
}
.presets__defaults-title {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 0.55rem;
}
.presets__defaults-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.55rem;
}
.presets__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.presets__field-label {
  font-size: 0.72rem;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.presets__input {
  background: var(--bg-elevated);
  color: var(--text-primary);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  padding: 0.45rem 0.6rem;
  font-size: 0.82rem;
  outline: none;
  transition: border-color 0.15s;
}
.presets__input:focus { border-color: var(--primary); }
.presets__input:disabled { opacity: 0.5; }
.presets__hint {
  margin: 0.55rem 0 0 0;
  font-size: 0.72rem;
  color: var(--text-tertiary);
}
.presets__hint code {
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  padding: 0 4px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.7rem;
}

.presets__list {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.preset-item {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.65rem;
  padding: 0.7rem 0.85rem;
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.preset-item:hover { border-color: var(--border-strong); }
.preset-item--enabled {
  border-color: rgba(var(--primary-rgb), 0.5);
  background: rgba(var(--primary-rgb), 0.05);
}
.preset-item__check {
  margin-top: 4px;
  width: 16px;
  height: 16px;
  accent-color: var(--primary);
  cursor: pointer;
}
.preset-item__body { min-width: 0; }
.preset-item__name {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-primary);
}
.preset-item__desc {
  font-size: 0.76rem;
  color: var(--text-tertiary);
  margin-top: 0.15rem;
  line-height: 1.4;
}

/* === Postfix relay modal === */
.relay__status {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.6rem 0.8rem;
  background: rgba(16, 185, 129, 0.08);
  border: 1px solid rgba(16, 185, 129, 0.25);
  border-radius: 8px;
  font-size: 0.82rem;
  color: var(--text-secondary);
}
.relay__status--warn {
  background: rgba(251, 146, 60, 0.08);
  border-color: rgba(251, 146, 60, 0.3);
  color: rgb(251, 146, 60);
}
.relay__status-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}
.relay__status-dot--ok { background: rgb(52, 211, 153); box-shadow: 0 0 6px rgba(52, 211, 153, 0.5); }
.relay__status-dot--warn { background: rgb(251, 146, 60); box-shadow: 0 0 6px rgba(251, 146, 60, 0.5); }

.relay__field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.relay__field--grow { flex: 1; }
.relay__field--port { width: 110px; flex: none; }
.relay__field-label {
  font-size: 0.74rem;
  color: var(--text-secondary);
  font-weight: 500;
}
.relay__field-hint {
  font-size: 0.7rem;
  color: var(--text-tertiary);
  margin-top: 0.2rem;
  line-height: 1.4;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.relay__hint {
  font-size: 0.74rem;
  color: var(--text-tertiary);
  background: var(--bg-input);
  border-left: 3px solid rgba(var(--primary-rgb), 0.5);
  padding: 0.5rem 0.7rem;
  border-radius: 0 6px 6px 0;
  line-height: 1.5;
}
.relay__row {
  display: flex;
  gap: 0.6rem;
  align-items: flex-end;
}
.relay__input {
  background: var(--bg-elevated);
  color: var(--text-primary);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  padding: 0.5rem 0.7rem;
  font-size: 0.85rem;
  outline: none;
  transition: border-color 0.15s;
  width: 100%;
  box-sizing: border-box;
}
.relay__input:focus { border-color: var(--primary); }
.relay__input:disabled { opacity: 0.55; cursor: not-allowed; }
.relay__check {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  font-size: 0.78rem;
  color: var(--text-secondary);
  cursor: pointer;
  line-height: 1.4;
}
.relay__check input {
  margin-top: 3px;
  width: 16px;
  height: 16px;
  accent-color: var(--primary);
  cursor: pointer;
}
.relay__toggle-btn {
  background: var(--bg-elevated);
  color: var(--text-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 1px 8px;
  font-size: 0.7rem;
  cursor: pointer;
  transition: background 0.15s;
}
.relay__toggle-btn:hover:not(:disabled) { background: var(--bg-input); color: var(--text-primary); }
.relay__toggle-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
