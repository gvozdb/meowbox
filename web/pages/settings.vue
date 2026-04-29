<template>
  <div class="settings">
    <div class="settings__header">
      <h1 class="settings__title">Настройки</h1>
      <p class="settings__subtitle">Аккаунт и конфигурация системы</p>
    </div>

    <!-- Tabs -->
    <div class="settings__tabs">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="settings__tab"
        :class="{ 'settings__tab--active': activeTab === t.id }"
        @click="activeTab = t.id"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- General (Основные) — мониторинг, сессии, обновления -->
    <div v-if="activeTab === 'general'" class="tab-content">
      <div class="settings-card">
        <h3 class="settings-card__title">Мониторинг</h3>
        <div class="settings-fields">
          <div class="form-group">
            <label class="form-label">Интервал health-check, сек</label>
            <input v-model.number="generalForm.healthCheckIntervalSec" type="number" class="form-input" min="10" max="3600" />
          </div>
          <div class="form-group">
            <label class="form-label">Порог алерта CPU, %</label>
            <input v-model.number="generalForm.alertCpuPercent" type="number" class="form-input" min="50" max="100" />
          </div>
          <div class="form-group">
            <label class="form-label">Порог алерта RAM, %</label>
            <input v-model.number="generalForm.alertRamPercent" type="number" class="form-input" min="50" max="100" />
          </div>
          <div class="form-group">
            <label class="form-label">Порог алерта диска, %</label>
            <input v-model.number="generalForm.alertDiskPercent" type="number" class="form-input" min="50" max="100" />
          </div>
        </div>
      </div>

      <div class="settings-card">
        <h3 class="settings-card__title">Обслуживание панели</h3>
        <div class="settings-fields">
          <label class="inline-check">
            <input type="checkbox" v-model="generalForm.autoUpdateCheck" />
            Автоматически проверять обновления
          </label>
          <div class="form-group">
            <label class="form-label">Ветка обновлений</label>
            <select v-model="generalForm.updateBranch" class="form-input">
              <option value="stable">stable (рекомендуется)</option>
              <option value="main">main (bleeding-edge)</option>
            </select>
          </div>
        </div>
      </div>

      <div class="settings-actions">
        <button class="settings-card__btn" :disabled="saving || generalLoading" @click="saveGeneralSettings">
          {{ saving ? 'Сохранение...' : 'Сохранить настройки' }}
        </button>
      </div>
    </div>

    <!-- Site defaults (Дефолты сайтов) — пути + форма создания -->
    <div v-if="activeTab === 'site-defaults'" class="tab-content">
      <div class="settings-card">
        <h3 class="settings-card__title">Корневая директория сайтов</h3>
        <p class="settings-card__desc">
          Абсолютный путь, в котором для каждого сайта создаётся home-директория Linux-юзера.
          Финальная структура: <code>{Корневая}/{safeName}/{Относительная}/</code>.
          Смена влияет только на новые сайты — существующие остаются на старом пути.
        </p>
        <div class="settings-fields">
          <div class="form-group">
            <label class="form-label">Корневая директория (абсолютный путь)</label>
            <input v-model="siteDefaultsForm.sitesBasePath" type="text" class="form-input" placeholder="/var/www" />
          </div>
          <div class="form-group">
            <label class="form-label">Относительный путь до файлов сайта</label>
            <input v-model="siteDefaultsForm.siteFilesRelativePath" type="text" class="form-input" placeholder="www" />
            <span class="form-hint">Обычно <code>www</code>. Можно сделать <code>public_html</code>, <code>htdocs</code> и т.п. — будет использоваться и nginx root, и scaffold.</span>
          </div>
        </div>
      </div>

      <div class="settings-card">
        <h3 class="settings-card__title">Дефолты формы создания сайта</h3>
        <p class="settings-card__desc">Эти значения подставляются на форме создания сайта — можно переопределить для каждого отдельно.</p>
        <div class="settings-fields">
          <div class="form-group">
            <label class="form-label">Версия PHP по умолчанию</label>
            <select v-model="siteDefaultsForm.defaultPhpVersion" class="form-input">
              <option value="7.4">PHP 7.4</option>
              <option value="8.0">PHP 8.0</option>
              <option value="8.1">PHP 8.1</option>
              <option value="8.2">PHP 8.2</option>
              <option value="8.3">PHP 8.3</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Тип БД по умолчанию</label>
            <select v-model="siteDefaultsForm.defaultDbType" class="form-input">
              <option value="MARIADB">MariaDB</option>
              <option value="MYSQL">MySQL</option>
              <option value="POSTGRESQL">PostgreSQL</option>
            </select>
          </div>
          <label class="inline-check">
            <input type="checkbox" v-model="siteDefaultsForm.defaultAutoSsl" />
            Автовыпуск SSL при создании сайта
          </label>
          <label class="inline-check">
            <input type="checkbox" v-model="siteDefaultsForm.defaultHttpsRedirect" />
            Редирект HTTP → HTTPS по умолчанию
          </label>
        </div>
      </div>

      <div class="settings-actions">
        <button class="settings-card__btn" :disabled="saving || siteDefaultsLoading" @click="saveSiteDefaults">
          {{ saving ? 'Сохранение...' : 'Сохранить настройки' }}
        </button>
      </div>
    </div>


    <!-- Security (Basic Auth + 2FA + Session security + Active sessions) -->
    <div v-if="activeTab === 'security'" class="tab-content">
      <!-- Basic Auth (дополнительный слой защиты перед основным логином) -->
      <div class="settings-card">
        <h3 class="settings-card__title">Защита входа Basic Auth</h3>
        <p class="settings-card__desc">
          {{ basicAuth.enabled
            ? `Включена. Логин: ${basicAuth.username}. Браузер будет спрашивать логин/пароль до формы логина в панель.`
            : 'Дополнительный слой защиты: браузер запрашивает логин/пароль (HTTP Basic) ДО формы входа в панель. Защищает от подбора, автосканов и известных эксплойтов.' }}
        </p>

        <!-- Enable flow -->
        <template v-if="!basicAuth.enabled">
          <div v-if="showEnableBasicAuth" class="totp-setup">
            <div class="settings-fields">
              <div class="form-group">
                <label class="form-label">Логин Basic Auth</label>
                <input v-model="basicAuthForm.username" type="text" class="form-input" placeholder="panel-user" maxlength="64" />
              </div>
              <div class="form-group">
                <label class="form-label">Пароль Basic Auth</label>
                <input v-model="basicAuthForm.password" type="password" class="form-input" placeholder="Минимум 8 символов" maxlength="128" />
              </div>
            </div>
            <div class="settings-actions">
              <button class="settings-card__btn" :disabled="basicAuthSaving" @click="enableBasicAuth">
                {{ basicAuthSaving ? 'Включаю...' : 'Подтвердить и включить' }}
              </button>
              <button class="settings-card__btn settings-card__btn--danger" @click="cancelEnableBasicAuth">Отмена</button>
            </div>
          </div>
          <button v-else class="settings-card__btn" @click="showEnableBasicAuth = true">
            Включить Basic Auth
          </button>
        </template>

        <!-- Disable flow -->
        <template v-else>
          <button class="settings-card__btn settings-card__btn--danger" :disabled="basicAuthSaving" @click="disableBasicAuth">
            {{ basicAuthSaving ? 'Отключаю...' : 'Отключить Basic Auth' }}
          </button>
        </template>
      </div>

      <div class="settings-card">
        <h3 class="settings-card__title">Двухфакторная аутентификация</h3>
        <p class="settings-card__desc">
          {{ authStore.user?.totpEnabled
            ? '2FA включена. Ваш аккаунт защищён.'
            : 'Добавьте дополнительный уровень защиты аккаунта.' }}
        </p>

        <!-- Enable flow -->
        <template v-if="!authStore.user?.totpEnabled">
          <div v-if="totpSetup.secret" class="totp-setup">
            <p class="totp-setup__info">Отсканируйте QR-код приложением-аутентификатором, затем введите код ниже.</p>
            <div v-if="totpSetup.qrDataUrl" class="totp-setup__qr">
              <img :src="totpSetup.qrDataUrl" alt="TOTP QR Code" width="200" height="200" />
            </div>
            <p class="totp-setup__manual">Не удаётся отсканировать? Введите вручную: <code class="totp-setup__secret-inline">{{ totpSetup.secret }}</code></p>
            <div class="form-group">
              <label class="form-label">Код подтверждения</label>
              <input v-model="totpSetup.code" type="text" class="form-input form-input--mono" placeholder="000000" maxlength="6" />
            </div>
            <button class="settings-card__btn" :disabled="!totpSetup.code || totpSetup.code.length !== 6" @click="confirmTotp">
              Подтвердить и включить
            </button>
          </div>
          <button v-else class="settings-card__btn" @click="startTotpSetup">
            Включить 2FA
          </button>
        </template>

        <!-- Disable flow -->
        <template v-else>
          <div v-if="showDisableTotp" class="totp-setup">
            <div class="form-group">
              <label class="form-label">Текущий пароль</label>
              <input v-model="totpDisablePassword" type="password" class="form-input" autocomplete="current-password" placeholder="Ваш пароль" />
              <span class="form-hint">Нужен, чтобы украденный access-токен не позволил отключить 2FA.</span>
            </div>
            <div class="form-group">
              <label class="form-label">TOTP-код</label>
              <input v-model="totpDisableCode" type="text" class="form-input form-input--mono" placeholder="000000" maxlength="6" />
            </div>
            <button class="settings-card__btn settings-card__btn--danger" :disabled="!totpDisableCode || totpDisableCode.length !== 6 || !totpDisablePassword" @click="disableTotp">
              Отключить 2FA
            </button>
          </div>
          <button v-else class="settings-card__btn settings-card__btn--danger" @click="showDisableTotp = true">
            Отключить 2FA
          </button>
        </template>
      </div>

      <!-- Session security (перенесено из «Основные») -->
      <div class="settings-card">
        <h3 class="settings-card__title">Безопасность сессий</h3>
        <p class="settings-card__desc">
          Правила выдачи и жизненного цикла access/refresh-токенов, а также блокировки IP при подборе пароля.
        </p>
        <div class="settings-fields">
          <div class="form-group">
            <label class="form-label">Макс. попыток логина до блокировки IP</label>
            <input v-model.number="generalForm.sessionMaxAttempts" type="number" class="form-input" min="3" max="100" />
          </div>
          <div class="form-group">
            <label class="form-label">TTL access-токена, мин</label>
            <input v-model.number="generalForm.sessionAccessTtlMinutes" type="number" class="form-input" min="1" max="1440" />
          </div>
          <div class="form-group">
            <label class="form-label">TTL refresh-токена, дней</label>
            <input v-model.number="generalForm.sessionRefreshTtlDays" type="number" class="form-input" min="1" max="90" />
          </div>
        </div>
        <div class="settings-actions">
          <button class="settings-card__btn" :disabled="saving || generalLoading" @click="saveGeneralSettings">
            {{ saving ? 'Сохранение...' : 'Сохранить' }}
          </button>
        </div>
      </div>

      <!-- Active sessions (перенесено из отдельной вкладки) -->
      <div class="settings-card">
        <div class="sessions-header">
          <h3 class="settings-card__title">Активные сессии</h3>
          <button
            v-if="sessions.length > 1"
            class="settings-card__btn settings-card__btn--danger settings-card__btn--sm"
            :disabled="sessionsLoading"
            @click="revokeAllSessions"
          >
            Отозвать все остальные
          </button>
        </div>
        <p class="settings-card__desc">Управляйте активными сессиями. Отзовите сессию, которую не узнаёте.</p>

        <div v-if="sessionsLoading" class="audit-log__empty">
          <p>Загрузка сессий...</p>
        </div>
        <div v-else-if="sessions.length" class="sessions-list">
          <div
            v-for="s in sessions"
            :key="s.jti"
            class="session-item"
            :class="{ 'session-item--current': s.isCurrent }"
          >
            <div class="session-item__icon">
              <svg v-if="s.isMobile" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <rect x="7" y="2" width="10" height="20" rx="2" />
                <line x1="12" y1="18" x2="12" y2="18.01" stroke-linecap="round" />
              </svg>
              <svg v-else width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </div>
            <div class="session-item__info">
              <div class="session-item__ua">{{ s.browserLabel }}</div>
              <div class="session-item__meta">
                {{ s.ip }}
                <span v-if="s.isCurrent" class="session-item__badge">Текущая</span>
                &middot; {{ formatDate(s.createdAt) }}
              </div>
            </div>
            <button
              v-if="!s.isCurrent"
              class="session-item__revoke"
              @click="revokeSession(s.jti)"
            >
              Отозвать
            </button>
          </div>
        </div>
        <div v-else class="audit-log__empty">
          <p>Активных сессий не найдено</p>
        </div>
      </div>
    </div>

    <!-- Notifications -->
    <div v-if="activeTab === 'notifications'" class="tab-content">
      <div class="settings-card">
        <div class="sessions-header">
          <h3 class="settings-card__title">Каналы уведомлений</h3>
          <button class="settings-card__btn settings-card__btn--sm" @click="showAddNotification = true">
            + Добавить канал
          </button>
        </div>
        <p class="settings-card__desc">Настройте, куда получать уведомления о деплоях, бэкапах, истечении SSL и неудачных входах.</p>

        <div v-if="notifLoading" class="audit-log__empty"><p>Загрузка...</p></div>
        <div v-else-if="!notifSettings.length" class="audit-log__empty"><p>Каналы уведомлений не настроены</p></div>
        <div v-else class="sessions-list">
          <div v-for="ns in notifSettings" :key="ns.id" class="session-item">
            <div class="session-item__icon">
              <svg v-if="ns.channel === 'TELEGRAM'" width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zm5.53 8.15l-1.8 8.5c-.13.6-.5.75-.99.47l-2.75-2.02-1.33 1.28c-.15.15-.27.27-.56.27l.2-2.82 5.1-4.6c.22-.2-.05-.31-.34-.12L8.7 13.4l-2.72-.85c-.6-.18-.6-.6.12-.88l10.63-4.1c.49-.18.93.12.8.58z"/></svg>
              <svg v-else-if="ns.channel === 'EMAIL'" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
              <svg v-else width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M13.73 21a2 2 0 01-3.46 0M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/></svg>
            </div>
            <div class="session-item__info">
              <div class="session-item__ua">
                {{ ns.channel }}
                <span v-if="!ns.enabled" class="notif-badge notif-badge--off">OFF</span>
              </div>
              <div class="session-item__meta">
                {{ ns.events.map(e => eventLabel(e)).join(', ') }}
              </div>
            </div>
            <div class="notif-actions">
              <button class="session-item__revoke" style="border-color: var(--primary-border); color: var(--primary-text); background: var(--primary-bg);" @click="testNotif(ns.id)">
                Тест
              </button>
              <button class="session-item__revoke" @click="editNotif(ns)">Изменить</button>
              <button class="session-item__revoke" @click="deleteNotif(ns.id)">Удалить</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Add / Edit notification modal -->
      <div v-if="showAddNotification" class="modal-backdrop" @mousedown.self="showAddNotification = false">
        <div class="modal-box">
          <h3 class="modal-box__title">{{ notifForm.id ? 'Редактировать' : 'Добавить' }} канал уведомлений</h3>
          <div class="form-group">
            <label class="form-label">Канал</label>
            <select v-model="notifForm.channel" class="form-input">
              <option value="TELEGRAM">Telegram</option>
              <option value="EMAIL">Email</option>
              <option value="WEBHOOK">Webhook</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">События</label>
            <div class="notif-events">
              <label v-for="ev in availableEvents" :key="ev" class="notif-event-check">
                <input type="checkbox" :value="ev" v-model="notifForm.events" />
                {{ eventLabel(ev) }}
              </label>
            </div>
          </div>
          <template v-if="notifForm.channel === 'TELEGRAM'">
            <div class="form-group">
              <label class="form-label">Bot Token</label>
              <input v-model="(notifForm.config as Record<string, string>).botToken" type="text" class="form-input" placeholder="123456:ABC-DEF..." />
            </div>
            <div class="form-group">
              <label class="form-label">Chat ID</label>
              <input v-model="(notifForm.config as Record<string, string>).chatId" type="text" class="form-input" placeholder="-1001234567890" />
            </div>
          </template>
          <template v-else-if="notifForm.channel === 'EMAIL'">
            <div class="form-group">
              <label class="form-label">SMTP Host</label>
              <input v-model="(notifForm.config as Record<string, string>).smtpHost" type="text" class="form-input" placeholder="smtp.example.com" />
            </div>
            <div class="form-row">
              <div class="form-group form-group--flex">
                <label class="form-label">SMTP Port</label>
                <input v-model="(notifForm.config as Record<string, string>).smtpPort" type="number" class="form-input" placeholder="587" />
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">SMTP User</label>
              <input v-model="(notifForm.config as Record<string, string>).smtpUser" type="text" class="form-input" placeholder="user@example.com" />
            </div>
            <div class="form-group">
              <label class="form-label">Пароль SMTP</label>
              <input v-model="(notifForm.config as Record<string, string>).smtpPass" type="password" class="form-input" placeholder="Пароль приложения" />
            </div>
            <div class="form-group">
              <label class="form-label">Адрес отправителя</label>
              <input v-model="(notifForm.config as Record<string, string>).from" type="email" class="form-input" placeholder="noreply@example.com" />
            </div>
            <div class="form-group">
              <label class="form-label">Адрес получателя</label>
              <input v-model="(notifForm.config as Record<string, string>).to" type="email" class="form-input" placeholder="admin@example.com" />
            </div>
          </template>
          <template v-else-if="notifForm.channel === 'WEBHOOK'">
            <div class="form-group">
              <label class="form-label">Webhook URL</label>
              <input v-model="(notifForm.config as Record<string, string>).url" type="url" class="form-input" placeholder="https://..." />
            </div>
          </template>
          <div class="form-group">
            <label class="notif-event-check">
              <input type="checkbox" v-model="notifForm.enabled" />
              Включено
            </label>
          </div>
          <div class="modal-box__actions">
            <button class="settings-card__btn" @click="saveNotif">Сохранить</button>
            <button class="settings-card__btn settings-card__btn--danger" @click="showAddNotification = false">Отмена</button>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

const api = useApi();
const authStore = useAuthStore();

const activeTab = useTabQuery(['general', 'site-defaults', 'security', 'notifications'], 'general');
const saving = ref(false);
const mbToast = useMbToast();
const passwordError = ref('');

const tabs = [
  { id: 'general', label: 'Основные' },
  { id: 'site-defaults', label: 'Дефолты сайтов' },
  { id: 'security', label: 'Безопасность' },
  { id: 'notifications', label: 'Уведомления' },
];

// ── Panel settings (general tab) ──────────────────────────────────────────
interface PanelSettings {
  // Мониторинг
  healthCheckIntervalSec: number;
  alertCpuPercent: number;
  alertRamPercent: number;
  alertDiskPercent: number;
  // Обслуживание
  autoUpdateCheck: boolean;
  updateBranch: 'stable' | 'main';
  // Безопасность
  sessionMaxAttempts: number;
  sessionAccessTtlMinutes: number;
  sessionRefreshTtlDays: number;
}

const generalForm = reactive<PanelSettings>({
  healthCheckIntervalSec: 60,
  alertCpuPercent: 85,
  alertRamPercent: 85,
  alertDiskPercent: 90,
  autoUpdateCheck: true,
  updateBranch: 'stable',
  sessionMaxAttempts: 5,
  sessionAccessTtlMinutes: 15,
  sessionRefreshTtlDays: 7,
});
const generalLoading = ref(false);

async function loadGeneralSettings() {
  generalLoading.value = true;
  try {
    const data = await api.get<Partial<PanelSettings>>('/panel-settings');
    Object.assign(generalForm, data);
  } catch {
    // эндпоинт может быть ещё не создан / первый запуск
  } finally {
    generalLoading.value = false;
  }
}

async function saveGeneralSettings() {
  saving.value = true;
  try {
    await api.put('/panel-settings', generalForm);
    showStatus('Настройки панели сохранены');
  } catch {
    showStatus('Не удалось сохранить настройки', true);
  } finally {
    saving.value = false;
  }
}

// ── Site defaults (site-defaults tab) ─────────────────────────────────────
interface SiteDefaults {
  sitesBasePath: string;
  siteFilesRelativePath: string;
  defaultPhpVersion: string;
  defaultDbType: 'MARIADB' | 'MYSQL' | 'POSTGRESQL';
  defaultAutoSsl: boolean;
  defaultHttpsRedirect: boolean;
}

const siteDefaultsForm = reactive<SiteDefaults>({
  sitesBasePath: '/var/www',
  siteFilesRelativePath: 'www',
  defaultPhpVersion: '8.2',
  defaultDbType: 'MARIADB',
  defaultAutoSsl: false,
  defaultHttpsRedirect: true,
});
const siteDefaultsLoading = ref(false);

async function loadSiteDefaults() {
  siteDefaultsLoading.value = true;
  try {
    const data = await api.get<Partial<SiteDefaults>>('/panel-settings/site-defaults');
    Object.assign(siteDefaultsForm, data);
  } catch {
    /* first run */
  } finally {
    siteDefaultsLoading.value = false;
  }
}

async function saveSiteDefaults() {
  saving.value = true;
  try {
    await api.put('/panel-settings/site-defaults', siteDefaultsForm);
    showStatus('Настройки дефолтов сайтов сохранены');
  } catch (e) {
    const msg = (e as Error)?.message || 'Не удалось сохранить настройки';
    showStatus(msg, true);
  } finally {
    saving.value = false;
  }
}

// ── Basic Auth (security tab — дополнительный блок) ───────────────────────
interface BasicAuthState {
  enabled: boolean;
  username: string;
}
const basicAuth = reactive<BasicAuthState>({ enabled: false, username: '' });
const basicAuthForm = reactive({ username: '', password: '' });
const basicAuthSaving = ref(false);
const showEnableBasicAuth = ref(false);

function cancelEnableBasicAuth() {
  showEnableBasicAuth.value = false;
  basicAuthForm.password = '';
}

async function loadBasicAuth() {
  try {
    const data = await api.get<BasicAuthState>('/auth/basic-auth');
    basicAuth.enabled = data.enabled;
    basicAuth.username = data.username || '';
    basicAuthForm.username = data.username || '';
  } catch {
    // может не поддерживаться старым API
  }
}

async function enableBasicAuth() {
  if (!basicAuthForm.username || !basicAuthForm.password) {
    showStatus('Введи логин и пароль для Basic Auth', true);
    return;
  }
  basicAuthSaving.value = true;
  try {
    await api.post('/auth/basic-auth', {
      enabled: true,
      username: basicAuthForm.username,
      password: basicAuthForm.password,
    });
    basicAuth.enabled = true;
    basicAuth.username = basicAuthForm.username;
    basicAuthForm.password = '';
    showEnableBasicAuth.value = false;
    showStatus('Basic Auth включён');
  } catch (e) {
    const msg = (e as Error)?.message || 'Не удалось включить Basic Auth';
    showStatus(msg, true);
  } finally {
    basicAuthSaving.value = false;
  }
}

async function disableBasicAuth() {
  basicAuthSaving.value = true;
  try {
    await api.post('/auth/basic-auth', { enabled: false });
    basicAuth.enabled = false;
    showStatus('Basic Auth отключён');
  } catch {
    showStatus('Не удалось отключить Basic Auth', true);
  } finally {
    basicAuthSaving.value = false;
  }
}

const profileForm = reactive({
  email: authStore.user?.email || '',
});

const passwordForm = reactive({
  password: '',
  confirm: '',
});

// TOTP state
const totpSetup = reactive({ secret: '', code: '', qrDataUrl: '' });
const showDisableTotp = ref(false);
const totpDisableCode = ref('');
const totpDisablePassword = ref('');

// Session state
interface SessionEntry {
  jti: string;
  ip: string;
  userAgent: string;
  createdAt: string;
  isCurrent: boolean;
  isMobile: boolean;
  browserLabel: string;
}

const sessions = ref<SessionEntry[]>([]);
const sessionsLoading = ref(false);

function parseBrowserLabel(ua: string): string {
  if (!ua) return 'Неизвестно';
  if (ua.includes('Firefox')) return 'Firefox';
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('Chrome')) return 'Chrome';
  if (ua.includes('Safari')) return 'Safari';
  if (ua.includes('Opera') || ua.includes('OPR')) return 'Opera';
  return ua.substring(0, 40);
}

function isMobileUA(ua: string): boolean {
  return /Mobile|Android|iPhone|iPad/i.test(ua);
}

async function loadSessions() {
  sessionsLoading.value = true;
  try {
    const data = await api.get<Array<{ jti: string; ip: string; userAgent: string; createdAt: string }>>(
      '/auth/sessions',
    );
    const currentUA = navigator.userAgent;
    sessions.value = (data || []).map((s) => ({
      ...s,
      isCurrent: s.userAgent === currentUA,
      isMobile: isMobileUA(s.userAgent),
      browserLabel: parseBrowserLabel(s.userAgent),
    }));
    // Sort: current first, then by date desc
    sessions.value.sort((a, b) => {
      if (a.isCurrent && !b.isCurrent) return -1;
      if (!a.isCurrent && b.isCurrent) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  } catch {
    showStatus('Не удалось загрузить сессии', true);
  } finally {
    sessionsLoading.value = false;
  }
}

async function revokeSession(jti: string) {
  try {
    await api.del(`/auth/sessions/${jti}`);
    sessions.value = sessions.value.filter((s) => s.jti !== jti);
    showStatus('Сессия отозвана');
  } catch {
    showStatus('Не удалось отозвать сессию', true);
  }
}

async function revokeAllSessions() {
  try {
    await api.del('/auth/sessions/all');
    sessions.value = sessions.value.filter((s) => s.isCurrent);
    showStatus('Все остальные сессии отозваны');
  } catch {
    showStatus('Не удалось отозвать сессии', true);
  }
}

function showStatus(message: string, isError = false) {
  if (isError) mbToast.error(message);
  else mbToast.success(message);
}

async function saveProfile() {
  saving.value = true;
  try {
    await api.put('/auth/me', { email: profileForm.email });
    showStatus('Профиль обновлён');
    await authStore.fetchProfile();
  } catch {
    showStatus('Не удалось обновить профиль', true);
  } finally {
    saving.value = false;
  }
}

async function changePassword() {
  passwordError.value = '';
  if (passwordForm.password.length < 8) {
    passwordError.value = 'Пароль должен быть не менее 8 символов';
    return;
  }
  if (passwordForm.password !== passwordForm.confirm) {
    passwordError.value = 'Пароли не совпадают';
    return;
  }

  saving.value = true;
  try {
    await api.put('/auth/me', { password: passwordForm.password });
    passwordForm.password = '';
    passwordForm.confirm = '';
    showStatus('Пароль обновлён');
  } catch {
    showStatus('Не удалось обновить пароль', true);
  } finally {
    saving.value = false;
  }
}

async function startTotpSetup() {
  try {
    const data = await api.post<{ secret: string; otpauthUrl: string }>('/auth/totp/enable');
    totpSetup.secret = data.secret;
    totpSetup.code = '';
    totpSetup.qrDataUrl = '';
    // Generate QR code from otpauthUrl
    if (data.otpauthUrl) {
      const QRCode = await import('qrcode');
      totpSetup.qrDataUrl = await QRCode.toDataURL(data.otpauthUrl, {
        width: 200,
        margin: 2,
        color: { dark: '#e2e8f0', light: '#0a0a0f' },
      });
    }
  } catch {
    showStatus('Не удалось начать настройку 2FA', true);
  }
}

async function confirmTotp() {
  try {
    await api.post('/auth/totp/confirm', { code: totpSetup.code });
    totpSetup.secret = '';
    totpSetup.code = '';
    totpSetup.qrDataUrl = '';
    showStatus('2FA успешно включена');
    await authStore.fetchProfile();
  } catch {
    showStatus('Неверный код. Попробуйте ещё раз.', true);
  }
}

async function disableTotp() {
  try {
    await api.post('/auth/totp/disable', {
      code: totpDisableCode.value,
      currentPassword: totpDisablePassword.value,
    });
    showDisableTotp.value = false;
    totpDisableCode.value = '';
    totpDisablePassword.value = '';
    showStatus('2FA отключена');
    await authStore.fetchProfile();
  } catch {
    showStatus('Неверный код', true);
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Notifications state
interface NotifSetting {
  id: string;
  channel: string;
  events: string[];
  enabled: boolean;
  config: Record<string, unknown>;
}

const notifSettings = ref<NotifSetting[]>([]);
const notifLoading = ref(false);
const showAddNotification = ref(false);
const availableEvents = [
  'DEPLOY_SUCCESS',
  'DEPLOY_FAILED',
  'BACKUP_COMPLETED',
  'BACKUP_FAILED',
  'SSL_EXPIRING',
  'SITE_DOWN',
  'HIGH_LOAD',
  'DISK_FULL',
  'LOGIN_FAILED',
];

const eventLabels: Record<string, string> = {
  DEPLOY_SUCCESS: 'Успешный деплой',
  DEPLOY_FAILED: 'Ошибка деплоя',
  BACKUP_COMPLETED: 'Бэкап завершён',
  BACKUP_FAILED: 'Ошибка бэкапа',
  SSL_EXPIRING: 'Истекает SSL',
  SITE_DOWN: 'Сайт недоступен',
  HIGH_LOAD: 'Высокая нагрузка',
  DISK_FULL: 'Диск заполнен',
  LOGIN_FAILED: 'Неудачный вход',
};

function eventLabel(ev: string): string {
  return eventLabels[ev] || ev;
}

const notifForm = reactive({
  id: '' as string | null,
  channel: 'TELEGRAM',
  events: [] as string[],
  enabled: true,
  config: {} as Record<string, unknown>,
});

function resetNotifForm() {
  notifForm.id = null;
  notifForm.channel = 'TELEGRAM';
  notifForm.events = [];
  notifForm.enabled = true;
  notifForm.config = {};
}

async function loadNotifications() {
  notifLoading.value = true;
  try {
    const data = await api.get<NotifSetting[]>('/notifications');
    notifSettings.value = data || [];
  } catch {
    showStatus('Не удалось загрузить уведомления', true);
  } finally {
    notifLoading.value = false;
  }
}

function editNotif(ns: NotifSetting) {
  notifForm.id = ns.id;
  notifForm.channel = ns.channel;
  notifForm.events = [...ns.events];
  notifForm.enabled = ns.enabled;
  notifForm.config = { ...(ns.config as Record<string, unknown>) };
  showAddNotification.value = true;
}

async function saveNotif() {
  try {
    await api.post('/notifications', {
      channel: notifForm.channel,
      events: notifForm.events,
      enabled: notifForm.enabled,
      config: notifForm.config,
    });
    showAddNotification.value = false;
    resetNotifForm();
    showStatus('Канал уведомлений сохранён');
    await loadNotifications();
  } catch {
    showStatus('Не удалось сохранить канал', true);
  }
}

async function deleteNotif(id: string) {
  try {
    await api.del(`/notifications/${id}`);
    notifSettings.value = notifSettings.value.filter((n) => n.id !== id);
    showStatus('Канал уведомлений удалён');
  } catch {
    showStatus('Не удалось удалить канал', true);
  }
}

async function testNotif(id: string) {
  try {
    await api.post(`/notifications/${id}/test`);
    showStatus('Тестовое уведомление отправлено');
  } catch {
    showStatus('Не удалось отправить тестовое уведомление', true);
  }
}

watch(activeTab, (tab) => {
  if (tab === 'notifications') loadNotifications();
  if (tab === 'general') loadGeneralSettings();
  if (tab === 'site-defaults') loadSiteDefaults();
  if (tab === 'security') {
    loadBasicAuth();
    loadGeneralSettings(); // для полей «Безопасность сессий», которые теперь тут
    loadSessions();
  }
});

onMounted(() => {
  if (authStore.user) {
    profileForm.email = authStore.user.email || '';
  }
  // первая вкладка = general
  loadGeneralSettings();
});
</script>

<style scoped>
.settings__header {
  margin-bottom: 1.5rem;
}

.settings__title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0;
}

.settings__subtitle {
  font-size: 0.8rem;
  color: var(--bg-elevated);
  margin-top: 0.15rem;
}

/* Tabs */
.settings__tabs {
  display: flex;
  gap: 0.1rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 1.5rem;
}

.settings__tab {
  padding: 0.65rem 1rem;
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--text-muted);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: all 0.2s;
  font-family: inherit;
  margin-bottom: -1px;
}

.settings__tab:hover {
  color: var(--text-tertiary);
}

.settings__tab--active {
  color: var(--primary-text);
  border-bottom-color: var(--primary);
}

/* Cards */
.settings-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  padding: 1.25rem;
  margin-bottom: 1rem;
}

.settings-card__title {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 0 0 0.75rem;
}

.settings-card__desc {
  font-size: 0.82rem;
  color: var(--text-muted);
  margin: 0 0 1rem;
}

.settings-fields {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  margin-bottom: 1rem;
  max-width: 400px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.form-label {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--text-tertiary);
}

.form-hint {
  font-size: 0.72rem;
  color: var(--text-muted);
  margin-top: 0.15rem;
}

.form-hint code,
.settings-card__desc code {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  color: var(--primary-text);
  background: var(--primary-bg);
  border: 1px solid var(--primary-border);
  border-radius: 4px;
  padding: 0.1rem 0.3rem;
}

.form-input {
  background: var(--bg-input);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  padding: 0.55rem 0.8rem;
  font-size: 0.85rem;
  color: var(--text-primary);
  font-family: inherit;
  outline: none;
  transition: all 0.2s;
}

.form-input:focus {
  border-color: var(--primary-border);
  box-shadow: var(--focus-ring);
}

.form-input:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.form-input--mono {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.9rem;
  letter-spacing: 0.15em;
  text-align: center;
}

.settings-card__btn {
  padding: 0.55rem 1.1rem;
  border-radius: 10px;
  border: none;
  font-size: 0.82rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
  background: linear-gradient(135deg, #fbbf24, #d97706);
  color: var(--primary-text-on);
}

.settings-card__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.settings-card__btn:not(:disabled):hover {
  transform: translateY(-1px);
}

.settings-card__btn--danger {
  background: var(--danger-bg);
  color: var(--danger-light);
  border: 1px solid var(--danger-border);
}

.settings-card__btn--danger:not(:disabled):hover {
  background: rgba(239, 68, 68, 0.15);
}

.settings-card__error {
  color: var(--danger-light);
  font-size: 0.78rem;
  margin-bottom: 0.75rem;
}

.inline-check {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.82rem;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
}

.inline-check input { accent-color: #f59e0b; }

.settings-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

/* TOTP setup */
.totp-setup {
  margin-top: 0.75rem;
}

.totp-setup__info {
  font-size: 0.82rem;
  color: var(--text-tertiary);
  margin-bottom: 0.75rem;
}

.totp-setup__qr {
  display: flex;
  justify-content: center;
  margin-bottom: 0.75rem;
}

.totp-setup__qr img {
  border-radius: 8px;
  border: 1px solid var(--border-secondary);
}

.totp-setup__manual {
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-bottom: 1rem;
}

.totp-setup__secret-inline {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  color: var(--primary-text);
  background: var(--primary-bg);
  border: 1px solid var(--primary-border);
  border-radius: 4px;
  padding: 0.15rem 0.35rem;
  word-break: break-all;
  user-select: all;
}

.totp-setup .form-group {
  margin-bottom: 0.75rem;
  max-width: 200px;
}

/* Audit log */
.audit-log__list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.audit-item {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 0.6rem 0.85rem;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.audit-item__action {
  font-size: 0.65rem;
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
  padding: 0.2rem 0.45rem;
  border-radius: 6px;
  flex-shrink: 0;
  min-width: 60px;
  text-align: center;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.audit-item__action--login { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
.audit-item__action--logout { background: rgba(148, 163, 184, 0.1); color: #94a3b8; }
.audit-item__action--create { background: rgba(99, 102, 241, 0.1); color: #818cf8; }
.audit-item__action--update { background: rgba(245, 158, 11, 0.1); color: #fbbf24; }
.audit-item__action--delete { background: rgba(239, 68, 68, 0.1); color: #f87171; }
.audit-item__action--deploy { background: rgba(0, 220, 130, 0.1); color: #00dc82; }
.audit-item__action--backup { background: rgba(139, 92, 246, 0.1); color: #a78bfa; }

.audit-item__info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.audit-item__entity {
  font-size: 0.82rem;
  color: var(--text-secondary);
}

.audit-item__meta {
  font-size: 0.68rem;
  color: var(--text-faint);
  margin-top: 0.1rem;
}

.audit-log__empty {
  text-align: center;
  padding: 2rem;
  color: var(--bg-elevated);
  font-size: 0.85rem;
}

.audit-log__pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  margin-top: 1rem;
}

.audit-log__page-btn {
  padding: 0.4rem 0.8rem;
  border-radius: 8px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-input);
  color: var(--text-tertiary);
  font-size: 0.78rem;
  font-family: inherit;
  cursor: pointer;
}

.audit-log__page-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.audit-log__page-info {
  font-size: 0.78rem;
  color: var(--text-muted);
  font-family: 'JetBrains Mono', monospace;
}

/* Sessions */
.sessions-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.sessions-header .settings-card__title {
  margin: 0;
}

.settings-card__btn--sm {
  padding: 0.35rem 0.75rem;
  font-size: 0.75rem;
}

.sessions-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.session-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.65rem 0.85rem;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 10px;
  transition: border-color 0.2s;
}

.session-item--current {
  border-color: var(--primary-border);
  background: var(--primary-bg);
}

.session-item__icon {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--bg-surface);
  color: var(--text-muted);
}

.session-item--current .session-item__icon {
  color: var(--primary-text);
}

.session-item__info {
  flex: 1;
  min-width: 0;
}

.session-item__ua {
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--text-secondary);
}

.session-item__meta {
  font-size: 0.7rem;
  color: var(--text-faint);
  margin-top: 0.1rem;
}

.session-item__badge {
  display: inline-block;
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  font-size: 0.6rem;
  font-weight: 600;
  background: var(--primary);
  color: var(--primary-text-on);
  margin-left: 0.25rem;
  vertical-align: middle;
}

.session-item__revoke {
  flex-shrink: 0;
  padding: 0.3rem 0.65rem;
  border-radius: 8px;
  border: 1px solid var(--danger-border);
  background: var(--danger-bg);
  color: var(--danger-light);
  font-size: 0.72rem;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
}

.session-item__revoke:hover {
  background: rgba(239, 68, 68, 0.15);
}

.tab-content {
  max-width: 640px;
}

/* Form helpers */
.form-row { display: flex; gap: 0.75rem; }
.form-group--flex { flex: 1; }

/* Notifications */
.notif-actions {
  display: flex;
  gap: 0.35rem;
  flex-shrink: 0;
}

.notif-badge {
  display: inline-block;
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  font-size: 0.6rem;
  font-weight: 600;
  margin-left: 0.35rem;
  vertical-align: middle;
}

.notif-badge--off {
  background: var(--danger-bg);
  color: var(--danger-light);
}

.notif-events {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.notif-event-check {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.8rem;
  color: var(--text-tertiary);
  cursor: pointer;
}

.notif-event-check input[type="checkbox"] {
  accent-color: var(--primary);
}

/* Modal */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.modal-box {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 16px;
  padding: 1.5rem;
  width: 440px;
  max-width: 92vw;
  max-height: 85vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.modal-box__title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-heading);
  margin: 0;
}

.modal-box__actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  margin-top: 0.5rem;
}


@media (max-width: 768px) {
  .settings__tabs {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    white-space: nowrap;
    scrollbar-width: none;
  }

  .settings__tabs::-webkit-scrollbar {
    display: none;
  }

  .settings__tab {
    flex-shrink: 0;
  }

  .tab-content {
    max-width: 100%;
  }

  .settings-fields {
    max-width: 100%;
  }

  .settings__title {
    font-size: 1.25rem;
  }

  .audit-item {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.4rem;
  }

  .audit-item__action {
    min-width: unset;
  }
}
</style>
