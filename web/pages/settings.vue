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

      <div class="settings-actions">
        <button class="settings-card__btn" :disabled="saving || generalLoading" @click="saveGeneralSettings">
          {{ saving ? 'Сохранение...' : 'Сохранить настройки' }}
        </button>
      </div>
    </div>

    <!-- Appearance (Внешний вид) — выбор цветовой гаммы для активного сервера -->
    <div v-if="activeTab === 'appearance'" class="tab-content">
      <div class="settings-card">
        <h3 class="settings-card__title">Цветовая гамма</h3>
        <p class="settings-card__desc">
          Применяется к серверу, активному в сайдбаре
          <strong v-if="activeServerLabel">({{ activeServerLabel }})</strong>.
          Каждый сервер имеет свою гамму. Гамма работает поверх светлой/тёмной темы.
        </p>
        <div class="palette-grid">
          <button
            v-for="opt in paletteOptions"
            :key="opt.id"
            type="button"
            class="palette-card"
            :class="{ 'palette-card--active': appearanceForm.palette === opt.id }"
            :disabled="appearanceLoading || appearanceSaving"
            @click="appearanceForm.palette = opt.id"
          >
            <span class="palette-card__preview" :class="`palette-preview--${opt.id}`">
              <span class="palette-preview__sw palette-preview__sw--primary" />
              <span class="palette-preview__sw palette-preview__sw--light" />
              <span class="palette-preview__sw palette-preview__sw--dark" />
              <span v-if="appearanceForm.palette === opt.id" class="palette-card__check">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12" /></svg>
              </span>
            </span>
            <span class="palette-card__title">{{ opt.label }}</span>
            <span class="palette-card__desc">{{ opt.description }}</span>
          </button>
        </div>
      </div>

      <div class="settings-actions">
        <button class="settings-card__btn" :disabled="appearanceSaving || appearanceLoading || !paletteChanged" @click="saveAppearance">
          {{ appearanceSaving ? 'Сохранение...' : 'Сохранить гамму' }}
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
            <select v-model="siteDefaultsForm.defaultPhpVersion" class="form-input" :disabled="installedPhpVersions.length === 0">
              <option v-if="installedPhpVersions.length === 0" value="" disabled>PHP не установлен — открой /php</option>
              <option v-for="v in installedPhpVersions" :key="v" :value="v">
                {{ phpVersionLabel(v) }}
              </option>
            </select>
            <span v-if="installedPhpVersions.length === 0" class="form-hint">
              На сервере не найдено ни одной установленной версии PHP-FPM. Установи через
              <NuxtLink to="/php" class="link">/php</NuxtLink>.
            </span>
          </div>
          <div class="form-group">
            <label class="form-label">Тип БД по умолчанию</label>
            <select v-model="siteDefaultsForm.defaultDbType" class="form-input" :disabled="availableDbTypes.length === 0">
              <option v-if="availableDbTypes.length === 0" value="" disabled>Ни одного движка БД не установлено — открой /services</option>
              <option v-for="t in availableDbTypes" :key="t.value" :value="t.value">{{ t.label }}</option>
            </select>
            <span v-if="availableDbTypes.length === 0" class="form-hint">
              На сервере не установлено ни MariaDB/MySQL, ни PostgreSQL. Установи на
              <NuxtLink to="/services" class="link">/services</NuxtLink>.
            </span>
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

      <!-- IP allowlist (whitelist по IP/CIDR на уровне приложения) -->
      <div class="settings-card">
        <h3 class="settings-card__title">Whitelist IP-адресов</h3>
        <p class="settings-card__desc">
          {{ ipAllowlist.enabled
            ? `Включён. Доступ к панели разрешён только с указанных IP/подсетей. Loopback (127.0.0.1, ::1) разрешён всегда — escape-hatch через SSH-туннель.`
            : 'Если включить — все запросы к панели (включая /login и /refresh) с IP, не входящих в список, будут отбиты 403. Loopback разрешён всегда.' }}
        </p>

        <div class="ip-allow__client" :class="{ 'ip-allow__client--in': ipAllowlist.clientIpAllowed }">
          <span class="ip-allow__label">Ваш IP сейчас:</span>
          <code class="ip-allow__ip">{{ ipAllowlist.clientIp || 'неизвестен' }}</code>
          <span v-if="ipAllowlist.enabled" class="ip-allow__status">
            {{ ipAllowlist.clientIpAllowed ? 'в списке' : 'НЕ в списке' }}
          </span>
        </div>

        <div class="settings-fields">
          <label class="inline-check">
            <input type="checkbox" v-model="ipAllowlist.enabled" :disabled="ipAllowlistSaving" />
            Включить allowlist
          </label>
        </div>

        <div class="ip-allow__list">
          <div v-if="ipAllowlist.entries.length === 0" class="audit-log__empty">
            <p>Список пуст. Добавьте свой IP или подсеть ниже.</p>
          </div>
          <div v-for="(e, idx) in ipAllowlist.entries" :key="e.cidr" class="ip-allow__row">
            <code class="ip-allow__row-cidr">{{ e.cidr }}</code>
            <span class="ip-allow__row-label">{{ e.label || '—' }}</span>
            <button class="session-item__revoke" :disabled="ipAllowlistSaving" @click="removeIpEntry(idx)">
              Удалить
            </button>
          </div>
        </div>

        <div class="ip-allow__add">
          <input
            v-model="ipAllowEntry.cidr"
            type="text"
            class="form-input form-input--mono"
            placeholder="например 1.2.3.4 или 10.0.0.0/24"
            :disabled="ipAllowlistSaving"
          />
          <input
            v-model="ipAllowEntry.label"
            type="text"
            class="form-input"
            placeholder="метка (home, office, ...)"
            maxlength="64"
            :disabled="ipAllowlistSaving"
          />
          <button class="settings-card__btn settings-card__btn--sm" :disabled="ipAllowlistSaving || !ipAllowEntry.cidr" @click="addIpEntry()">
            Добавить
          </button>
          <button
            class="settings-card__btn settings-card__btn--sm"
            :disabled="ipAllowlistSaving || !ipAllowlist.clientIp"
            :title="ipAllowlist.clientIp ? `Добавит ${ipAllowlist.clientIp}` : 'IP не определён'"
            @click="addClientIp()"
          >
            + мой текущий IP
          </button>
        </div>

        <div class="settings-actions">
          <button class="settings-card__btn" :disabled="ipAllowlistSaving" @click="saveIpAllowlist()">
            {{ ipAllowlistSaving ? 'Сохранение...' : 'Сохранить' }}
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
import type { PaletteId } from '~/composables/usePalette';

definePageMeta({ middleware: 'auth' });

const api = useApi();
const authStore = useAuthStore();

const activeTab = useTabQuery(['general', 'appearance', 'site-defaults', 'security', 'notifications'], 'general');
const saving = ref(false);
const mbToast = useMbToast();
const passwordError = ref('');

const tabs = [
  { id: 'general', label: 'Основные' },
  { id: 'appearance', label: 'Внешний вид' },
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

// ── Appearance (палитра — таб «Внешний вид») ──────────────────────────────
// Палитра хранится на МАСТЕРЕ для каждого сервера (карта { serverId → palette }).
// Сохранение всегда идёт в мастер (noProxy=true), чтобы фича работала и на
// старых slave-версиях, не знающих /panel-settings/appearance.
const serverStore = useServerStore();
const {
  options: paletteOptions,
  setForServer: applyPaletteForServer,
  loadAllFromApi: loadAllPalettesFromApi,
  saveToApi: savePaletteToApi,
} = usePalette();

const activeServerLabel = computed(() => {
  const s = serverStore.currentServer;
  return s?.name || (serverStore.currentServerId === 'main' ? 'Этот сервер' : '');
});

const appearanceForm = reactive<{ palette: PaletteId }>({ palette: 'amber' });
let appearanceInitial: PaletteId = 'amber';
const appearanceLoading = ref(false);
const appearanceSaving = ref(false);

const paletteChanged = computed(() => appearanceForm.palette !== appearanceInitial);

async function loadAppearance() {
  appearanceLoading.value = true;
  try {
    const map = await loadAllPalettesFromApi(api);
    const sid = serverStore.currentServerId || 'main';
    const current = map[sid] || 'amber';
    appearanceForm.palette = current;
    appearanceInitial = current;
  } finally {
    appearanceLoading.value = false;
  }
}

async function saveAppearance() {
  appearanceSaving.value = true;
  try {
    const sid = serverStore.currentServerId || 'main';
    const map = await savePaletteToApi(api, sid, appearanceForm.palette);
    if (!map) {
      showStatus('Не удалось сохранить гамму', true);
      return;
    }
    const next = map[sid] || appearanceForm.palette;
    appearanceInitial = next;
    appearanceForm.palette = next;
    // Применяем сразу к активному серверу — мгновенный визуальный эффект.
    applyPaletteForServer(sid, next, /* withTransition */ true);
    showStatus('Цветовая гамма обновлена');
  } finally {
    appearanceSaving.value = false;
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

// ── PHP-версии: тянем установленные с агента (тот же /php/versions, что и
// страница /php). Без этого селект показывал хардкод 7.4–8.3, в т.ч. версии,
// которых физически нет на сервере, и юзер сохранял дефолт-фантом.
const installedPhpVersions = ref<string[]>([]);

function phpVersionLabel(v: string): string {
  // 7.x — EOL legacy, помечаем как на /php-странице.
  return /^7\./.test(v) ? `PHP ${v} (EOL)` : `PHP ${v}`;
}

async function loadInstalledPhpVersions() {
  try {
    const versions = await api.get<string[]>('/php/versions');
    if (Array.isArray(versions) && versions.length > 0) {
      installedPhpVersions.value = [...versions].sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true }),
      );
      // Если сохранённый дефолт больше не среди установленных — переключаем
      // на самую высокую доступную (обычно 8.4 после свежего инсталла панели).
      if (
        siteDefaultsForm.defaultPhpVersion &&
        !installedPhpVersions.value.includes(siteDefaultsForm.defaultPhpVersion)
      ) {
        siteDefaultsForm.defaultPhpVersion = installedPhpVersions.value[0];
      }
    } else {
      installedPhpVersions.value = [];
    }
  } catch {
    // /php/versions может быть недоступен (агент offline). Не ломаем UI —
    // оставляем пустой список, шаблон покажет хинт "PHP не установлен".
    installedPhpVersions.value = [];
  }
}

// ── БД-движки: тянем фактически установленные с сервера через /services
// (тот же endpoint, что в databases.vue / sites/create.vue). Унифицируем
// MariaDB и MySQL под одной опцией "MySQL / MariaDB" — пакет mariadb-server
// обслуживает оба исторических типа, см. databases.service.ts:281.
interface DbTypeOption { value: 'MARIADB' | 'POSTGRESQL'; label: string; engineKey: 'mariadb' | 'postgresql' }
const ALL_DB_TYPES: DbTypeOption[] = [
  { value: 'MARIADB',    label: 'MySQL / MariaDB', engineKey: 'mariadb' },
  { value: 'POSTGRESQL', label: 'PostgreSQL',      engineKey: 'postgresql' },
];
const installedDbEngines = ref<Set<string>>(new Set());
const availableDbTypes = computed<DbTypeOption[]>(() =>
  ALL_DB_TYPES.filter((t) => installedDbEngines.value.has(t.engineKey)),
);

async function loadInstalledDbEngines() {
  try {
    const list = await api.get<Array<{ key: string; installed: boolean }>>('/services');
    installedDbEngines.value = new Set(
      list.filter((s) => s.installed).map((s) => s.key),
    );
    // Сохранённый дефолт может быть legacy 'MYSQL' (от старых версий панели —
    // мы такую опцию больше не показываем) или движком, которого нет на этом
    // сервере. В обоих случаях — переключаем на первый доступный.
    const isMysqlLegacy = (siteDefaultsForm.defaultDbType as string) === 'MYSQL';
    const stillOk = availableDbTypes.value.some((t) => t.value === siteDefaultsForm.defaultDbType);
    if (isMysqlLegacy || !stillOk) {
      const first = availableDbTypes.value[0];
      if (first) siteDefaultsForm.defaultDbType = first.value;
    }
  } catch {
    // /services недоступен — не показываем фильтр (пустой computed → hint).
    installedDbEngines.value = new Set();
  }
}

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
  // Грузим списки параллельно, не блокируем форму.
  await Promise.all([loadInstalledPhpVersions(), loadInstalledDbEngines()]);
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

// ── IP allowlist ───────────────────────────────────────────────────────────
interface IpAllowEntry { cidr: string; label: string }
interface IpAllowConfig {
  enabled: boolean;
  entries: IpAllowEntry[];
  clientIp?: string;
  clientIpAllowed?: boolean;
}
const ipAllowlist = reactive<IpAllowConfig>({
  enabled: false,
  entries: [],
  clientIp: '',
  clientIpAllowed: true,
});
const ipAllowEntry = reactive<IpAllowEntry>({ cidr: '', label: '' });
const ipAllowlistSaving = ref(false);

async function loadIpAllowlist() {
  try {
    const data = await api.get<IpAllowConfig>('/admin/ip-allowlist');
    ipAllowlist.enabled = !!data.enabled;
    ipAllowlist.entries = Array.isArray(data.entries) ? [...data.entries] : [];
    ipAllowlist.clientIp = data.clientIp || '';
    ipAllowlist.clientIpAllowed = !!data.clientIpAllowed;
  } catch {
    /* эндпоинт может быть на старой версии */
  }
}

function removeIpEntry(idx: number) {
  ipAllowlist.entries.splice(idx, 1);
}

async function addIpEntry() {
  const cidr = ipAllowEntry.cidr.trim();
  if (!cidr) return;
  ipAllowlist.entries.push({ cidr, label: ipAllowEntry.label.trim() });
  ipAllowEntry.cidr = '';
  ipAllowEntry.label = '';
}

async function addClientIp() {
  if (!ipAllowlist.clientIp) return;
  const exists = ipAllowlist.entries.some((e) => e.cidr === ipAllowlist.clientIp || e.cidr.startsWith(`${ipAllowlist.clientIp}/`));
  if (exists) {
    showStatus('Этот IP уже в списке');
    return;
  }
  ipAllowlist.entries.push({ cidr: ipAllowlist.clientIp, label: 'мой текущий IP' });
}

async function saveIpAllowlist() {
  ipAllowlistSaving.value = true;
  try {
    const data = await api.put<IpAllowConfig>('/admin/ip-allowlist', {
      enabled: ipAllowlist.enabled,
      entries: ipAllowlist.entries.map((e) => ({ cidr: e.cidr, label: e.label })),
    });
    ipAllowlist.enabled = !!data.enabled;
    ipAllowlist.entries = Array.isArray(data.entries) ? [...data.entries] : [];
    showStatus('Whitelist IP сохранён');
    // Перечитываем чтобы получить свежий clientIpAllowed.
    await loadIpAllowlist();
  } catch (e) {
    const msg = (e as Error)?.message || 'Не удалось сохранить allowlist';
    showStatus(msg, true);
  } finally {
    ipAllowlistSaving.value = false;
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
  'VPN_SNI_FAILED',
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
  VPN_SNI_FAILED: 'VPN: SNI-маска недоступна',
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

// Загрузка данных конкретной вкладки. Вынесено отдельно, чтобы и
// onMounted (учитывая ?tab= из URL), и watcher на смену вкладки шли через
// один путь — иначе при F5/прямой ссылке на /settings?tab=site-defaults
// данные нужного таба не подтягивались (watch без immediate, а onMounted
// слепо звал только loadGeneralSettings).
function loadDataForTab(tab: string) {
  if (tab === 'notifications') loadNotifications();
  if (tab === 'general') loadGeneralSettings();
  if (tab === 'appearance') loadAppearance();
  if (tab === 'site-defaults') loadSiteDefaults();
  if (tab === 'security') {
    loadBasicAuth();
    loadGeneralSettings(); // для полей «Безопасность сессий», которые теперь тут
    loadSessions();
    loadIpAllowlist();
  }
}

watch(activeTab, (tab) => loadDataForTab(tab));

onMounted(() => {
  if (authStore.user) {
    profileForm.email = authStore.user.email || '';
  }
  // Грузим данные текущей вкладки (учитываем ?tab= в URL после F5/ссылки).
  loadDataForTab(activeTab.value);
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
  background: linear-gradient(135deg, var(--primary-light), var(--primary-dark));
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

.inline-check input { accent-color: var(--primary); }

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
.audit-item__action--update { background: rgba(var(--primary-rgb), 0.1); color: var(--primary-light); }
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

/* ========== IP allowlist ========== */
.ip-allow__client {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.55rem 0.75rem;
  border-radius: 8px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  font-size: 0.8rem;
  margin-bottom: 0.85rem;
}
.ip-allow__client--in {
  border-color: var(--primary-border);
  background: var(--primary-bg);
}
.ip-allow__label {
  color: var(--text-muted);
}
.ip-allow__ip {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  color: var(--text-heading);
}
.ip-allow__status {
  margin-left: auto;
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.15rem 0.5rem;
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-tertiary);
}
.ip-allow__client--in .ip-allow__status {
  color: #4ade80;
}
.ip-allow__list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin: 0.85rem 0;
}
.ip-allow__row {
  display: grid;
  grid-template-columns: 1.4fr 2fr auto;
  gap: 0.6rem;
  align-items: center;
  padding: 0.45rem 0.65rem;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.ip-allow__row-cidr {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8rem;
  color: var(--text-secondary);
}
.ip-allow__row-label {
  font-size: 0.78rem;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ip-allow__add {
  display: grid;
  grid-template-columns: 1.5fr 1.5fr auto auto;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
@media (max-width: 768px) {
  .ip-allow__add {
    grid-template-columns: 1fr;
  }
  .ip-allow__row {
    grid-template-columns: 1fr;
    gap: 0.3rem;
  }
}

/* ========== Палитра (таб «Внешний вид») ========== */
.palette-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0.8rem;
  margin-top: 0.4rem;
}

.palette-card {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.55rem;
  padding: 0.85rem;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 12px;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: var(--text-primary);
  transition: border-color 0.18s ease, background 0.18s ease, transform 0.12s ease, box-shadow 0.18s ease;
}
.palette-card:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--bg-surface-hover);
}
.palette-card:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.palette-card--active {
  border-color: var(--primary);
  background: var(--primary-bg);
  box-shadow: var(--focus-ring);
}

.palette-card__preview {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0.7rem 0.8rem;
  border-radius: 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  min-height: 48px;
}

.palette-preview__sw {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid var(--bg-elevated);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
}

/* Цвета swatch'ей фиксированы — это превью, не зависит от текущей палитры. */
.palette-preview--amber .palette-preview__sw--primary { background: #f59e0b; }
.palette-preview--amber .palette-preview__sw--light   { background: #fbbf24; }
.palette-preview--amber .palette-preview__sw--dark    { background: #d97706; }

.palette-preview--violet .palette-preview__sw--primary { background: #8b5cf6; }
.palette-preview--violet .palette-preview__sw--light   { background: #a78bfa; }
.palette-preview--violet .palette-preview__sw--dark    { background: #7c3aed; }

.palette-preview--emerald .palette-preview__sw--primary { background: #10b981; }
.palette-preview--emerald .palette-preview__sw--light   { background: #34d399; }
.palette-preview--emerald .palette-preview__sw--dark    { background: #059669; }

.palette-preview--sapphire .palette-preview__sw--primary { background: #3b82f6; }
.palette-preview--sapphire .palette-preview__sw--light   { background: #60a5fa; }
.palette-preview--sapphire .palette-preview__sw--dark    { background: #2563eb; }

.palette-preview--rose .palette-preview__sw--primary { background: #f43f5e; }
.palette-preview--rose .palette-preview__sw--light   { background: #fb7185; }
.palette-preview--rose .palette-preview__sw--dark    { background: #e11d48; }

.palette-preview--teal .palette-preview__sw--primary { background: #14b8a6; }
.palette-preview--teal .palette-preview__sw--light   { background: #2dd4bf; }
.palette-preview--teal .palette-preview__sw--dark    { background: #0d9488; }

.palette-preview--fuchsia .palette-preview__sw--primary { background: #d946ef; }
.palette-preview--fuchsia .palette-preview__sw--light   { background: #e879f9; }
.palette-preview--fuchsia .palette-preview__sw--dark    { background: #c026d3; }

.palette-card__check {
  position: absolute;
  top: 50%;
  right: 0.7rem;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--primary);
  color: var(--primary-text-on);
}

.palette-card__title {
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--text-heading);
}

.palette-card__desc {
  font-size: 0.8rem;
  color: var(--text-tertiary);
  line-height: 1.35;
}
</style>
