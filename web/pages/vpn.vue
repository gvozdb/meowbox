<template>
  <div class="vpn">
    <div class="vpn__header">
      <div>
        <h1 class="vpn__title">VPN</h1>
        <p class="vpn__subtitle">
          Развёртывание VLESS+Reality / AmneziaWG в один клик. Установка runtime'ов — по кнопке ниже,
          ничего автоматически не ставится.
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

    <div v-if="loading" class="vpn__loading">
      <div class="spinner" />
    </div>

    <template v-else>
      <!-- ======== RUNTIME'Ы ======== -->
      <section class="vpn__section">
        <h2 class="vpn__section-title">
          Runtime'ы
          <span class="vpn__hint">— что физически установлено на сервере</span>
        </h2>

        <div class="rt-grid">
          <div class="rt-card">
            <div class="rt-card__head">
              <div class="rt-card__icon rt-card__icon--reality">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>
              <div class="rt-card__title-block">
                <div class="rt-card__title">Xray-core</div>
                <div class="rt-card__category">VLESS + Reality (TCP)</div>
              </div>
              <span
                class="rt-card__status"
                :class="installStatus.xray.installed ? 'rt-card__status--ok' : 'rt-card__status--idle'"
              >
                <span class="status-dot" :class="installStatus.xray.installed ? 'status-dot--ok' : 'status-dot--idle'" />
                {{ installStatus.xray.installed ? 'Установлен' : 'Не установлен' }}
              </span>
            </div>
            <p class="rt-card__desc">
              Обход DPI/TSPU через TLS handshake к стороннему сайту-маске.
              Подходит для РФ, Ирана, Китая.
            </p>
            <div class="rt-card__meta">
              <div class="rt-card__meta-row">
                <span class="rt-card__meta-label">Версия</span>
                <span class="rt-card__meta-value mono">{{ installStatus.xray.version || '—' }}</span>
              </div>
            </div>
            <div class="rt-card__actions">
              <button
                v-if="!installStatus.xray.installed"
                class="btn btn--primary btn--sm"
                :disabled="busy.installXray"
                @click="installRuntime('VLESS_REALITY')"
              >
                <span v-if="busy.installXray" class="btn__spinner" />
                {{ busy.installXray ? 'Установка…' : 'Установить' }}
              </button>
              <button
                v-else
                class="btn btn--danger btn--sm"
                :disabled="busy.uninstallXray || servicesByProto.VLESS_REALITY.length > 0"
                :title="servicesByProto.VLESS_REALITY.length > 0 ? 'Сначала удали все VLESS+Reality сервисы' : ''"
                @click="uninstallRuntime('VLESS_REALITY')"
              >
                <span v-if="busy.uninstallXray" class="btn__spinner" />
                {{ busy.uninstallXray ? 'Удаление…' : 'Удалить' }}
              </button>
            </div>
          </div>

          <div class="rt-card">
            <div class="rt-card__head">
              <div class="rt-card__icon rt-card__icon--awg">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
              </div>
              <div class="rt-card__title-block">
                <div class="rt-card__title">AmneziaWG</div>
                <div class="rt-card__category">Обфусцированный WireGuard (UDP)</div>
              </div>
              <span
                class="rt-card__status"
                :class="installStatus.amnezia.installed ? 'rt-card__status--ok' : 'rt-card__status--idle'"
              >
                <span class="status-dot" :class="installStatus.amnezia.installed ? 'status-dot--ok' : 'status-dot--idle'" />
                {{ installStatus.amnezia.installed ? 'Установлен' : 'Не установлен' }}
              </span>
            </div>
            <p class="rt-card__desc">
              Запасной вариант — высокая скорость UDP, обфускация заголовков handshake'а.
              Клиент Amnezia VPN на всех платформах.
            </p>
            <div class="rt-card__meta">
              <div class="rt-card__meta-row">
                <span class="rt-card__meta-label">Версия</span>
                <span class="rt-card__meta-value mono">{{ installStatus.amnezia.version || '—' }}</span>
              </div>
            </div>
            <div class="rt-card__actions">
              <button
                v-if="!installStatus.amnezia.installed"
                class="btn btn--primary btn--sm"
                :disabled="busy.installAmnezia"
                @click="installRuntime('AMNEZIA_WG')"
              >
                <span v-if="busy.installAmnezia" class="btn__spinner" />
                {{ busy.installAmnezia ? 'Установка…' : 'Установить' }}
              </button>
              <button
                v-else
                class="btn btn--danger btn--sm"
                :disabled="busy.uninstallAmnezia || servicesByProto.AMNEZIA_WG.length > 0"
                :title="servicesByProto.AMNEZIA_WG.length > 0 ? 'Сначала удали все AmneziaWG сервисы' : ''"
                @click="uninstallRuntime('AMNEZIA_WG')"
              >
                <span v-if="busy.uninstallAmnezia" class="btn__spinner" />
                {{ busy.uninstallAmnezia ? 'Удаление…' : 'Удалить' }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- ======== СЕРВИСЫ ======== -->
      <section class="vpn__section">
        <div class="vpn__section-head">
          <h2 class="vpn__section-title">
            Сервисы
            <span class="vpn__badge">{{ services.length }}</span>
          </h2>
          <button
            class="btn btn--primary btn--sm"
            :disabled="!canCreateAnyService"
            :title="!canCreateAnyService ? 'Сначала установи хотя бы один runtime' : ''"
            @click="openCreateService()"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            Развернуть
          </button>
        </div>

        <div v-if="services.length === 0" class="vpn__empty">
          <p>Сервисов нет.</p>
          <p class="vpn__empty-hint">Сначала установи runtime, потом нажми «Развернуть».</p>
        </div>

        <div v-else class="vpn__services-grid">
          <div
            v-for="s in services"
            :key="s.id"
            class="svc-card"
            :class="`svc-card--${s.status.toLowerCase()}`"
          >
            <div class="svc-card__head">
              <div class="svc-card__title-block">
                <div class="svc-card__title">
                  {{ s.label || protocolLabel(s.protocol) }}
                  <span class="svc-card__port">:{{ s.port }}</span>
                </div>
                <div class="svc-card__category">{{ protocolLabel(s.protocol) }}</div>
              </div>
              <span
                class="svc-card__status"
                :class="`svc-card__status--${s.status.toLowerCase()}`"
              >
                <span class="status-dot" :class="`status-dot--${statusDotClass(s.status)}`" />
                {{ statusLabel(s.status) }}
              </span>
            </div>

            <div class="svc-card__meta">
              <div v-if="s.sniMask" class="svc-card__meta-row">
                <span class="svc-card__meta-label">SNI-маска</span>
                <span class="svc-card__meta-value mono">
                  {{ s.sniMask }}
                  <span
                    v-if="s.sniLastCheckOk === true"
                    class="badge badge--ok"
                    title="Маска отдаёт TLS 1.3 + X25519"
                  >ok</span>
                  <span
                    v-else-if="s.sniLastCheckOk === false"
                    class="badge badge--bad"
                    :title="s.sniLastError || 'не прошла проверку'"
                  >fail</span>
                </span>
              </div>
              <div class="svc-card__meta-row">
                <span class="svc-card__meta-label">Юзеров</span>
                <span class="svc-card__meta-value">{{ s.usersCount }}</span>
              </div>
              <div v-if="s.errorMessage" class="svc-card__error">{{ s.errorMessage }}</div>
            </div>

            <div class="svc-card__actions">
              <button
                v-if="s.status === 'STOPPED'"
                class="btn btn--ghost btn--xs"
                @click="startService(s.id)"
              >Старт</button>
              <button
                v-if="s.status === 'RUNNING'"
                class="btn btn--ghost btn--xs"
                @click="stopService(s.id)"
              >Стоп</button>
              <button
                v-if="s.protocol === 'VLESS_REALITY' && s.status === 'RUNNING'"
                class="btn btn--ghost btn--xs"
                @click="openRotateSni(s)"
              >Сменить SNI</button>
              <button
                v-if="s.status === 'RUNNING'"
                class="btn btn--ghost btn--xs"
                @click="rotateKeys(s)"
              >Ротировать ключи</button>
              <button
                class="btn btn--danger btn--xs"
                @click="deleteService(s)"
              >Удалить</button>
            </div>
          </div>
        </div>
      </section>

      <!-- ======== ЮЗЕРЫ ======== -->
      <section class="vpn__section">
        <div class="vpn__section-head">
          <h2 class="vpn__section-title">
            Юзеры
            <span class="vpn__badge">{{ users.length }}</span>
          </h2>
          <button
            class="btn btn--primary btn--sm"
            :disabled="services.length === 0"
            :title="services.length === 0 ? 'Сначала разверни сервис' : ''"
            @click="openCreateUser()"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            Создать юзера
          </button>
        </div>

        <div v-if="users.length === 0" class="vpn__empty">
          <p>Юзеров нет.</p>
        </div>

        <div v-else class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Имя</th>
                <th>Сервисы</th>
                <th>Подписка</th>
                <th>Состояние</th>
                <th class="table__actions-th"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in users" :key="u.id">
                <td>{{ u.name }}</td>
                <td>
                  <span v-if="u.services.length === 0" class="text-muted">—</span>
                  <div v-else class="user-services">
                    <button
                      v-for="svc in u.services"
                      :key="svc.credId"
                      class="chip"
                      :title="`Конфиг для ${protocolLabel(svc.protocol)}:${svc.port}`"
                      @click="openAccess(u, svc.serviceId)"
                    >
                      {{ protocolShort(svc.protocol) }}:{{ svc.port }}
                    </button>
                  </div>
                </td>
                <td>
                  <button
                    class="btn btn--ghost btn--xs"
                    :disabled="u.services.length === 0"
                    :title="u.services.length === 0 ? 'У юзера нет сервисов' : 'Показать конфиги и subscription'"
                    @click="openAccess(u)"
                  >Доступ</button>
                </td>
                <td>
                  <span
                    class="badge"
                    :class="u.enabled ? 'badge--ok' : 'badge--idle'"
                  >{{ u.enabled ? 'enabled' : 'disabled' }}</span>
                </td>
                <td class="table__actions-cell">
                  <button class="btn btn--ghost btn--xs" @click="openAddToService(u)">+ Сервис</button>
                  <button class="btn btn--ghost btn--xs" @click="toggleUser(u)">{{ u.enabled ? 'Off' : 'On' }}</button>
                  <button class="btn btn--danger btn--xs" @click="deleteUser(u)">Удалить</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ======== Юридический disclaimer ======== -->
      <p class="vpn__disclaimer">
        Сервис VPN предоставляется исключительно для личных нужд администратора.
        За использование третьими лицами ответственность несёт администратор сервера.
      </p>
    </template>

    <!-- ======== Modals ======== -->
    <div
      v-if="modal.kind === 'createService'"
      class="modal-overlay"
      @mousedown.self="closeModal()"
    >
      <div class="modal">
        <header class="modal__head">
          <h3 class="modal__title">Развернуть VPN</h3>
          <button class="modal__close" aria-label="Закрыть" title="Закрыть" @click="closeModal()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
          </button>
        </header>
        <div class="modal__fields">
          <label class="field">
            <span class="field__label">Протокол</span>
            <select v-model="form.protocol" class="field__input">
              <option v-if="installStatus.xray.installed" value="VLESS_REALITY">VLESS + Reality (TCP, обход DPI)</option>
              <option v-if="installStatus.amnezia.installed" value="AMNEZIA_WG">AmneziaWG (UDP, быстрый)</option>
            </select>
          </label>
          <label class="field">
            <span class="field__label">Порт</span>
            <input v-model.number="form.port" type="number" min="1" max="65535" class="field__input" />
          </label>
          <label class="field">
            <span class="field__label">Имя сервиса (опционально)</span>
            <input v-model="form.label" maxlength="64" class="field__input" placeholder="Например: Reality main" />
          </label>

          <template v-if="form.protocol === 'VLESS_REALITY'">
            <label class="field">
              <span class="field__label">SNI-маска</span>
              <select v-model="form.sniMask" class="field__input">
                <option v-for="m in DEFAULT_SNI_MASKS" :key="m" :value="m">{{ m }}</option>
                <option value="__custom__">Своя…</option>
              </select>
            </label>
            <label v-if="form.sniMask === '__custom__'" class="field">
              <span class="field__label">Свой SNI</span>
              <input v-model="form.sniMaskCustom" class="field__input" placeholder="example.com" />
            </label>
            <button class="btn btn--ghost btn--sm" :disabled="validating" @click="testSni">
              <span v-if="validating" class="btn__spinner" />
              Проверить SNI
            </button>
            <p
              v-if="sniValidationResult"
              class="field__hint"
              :class="sniValidationResult.ok ? 'field__hint--ok' : 'field__hint--bad'"
            >
              {{
                sniValidationResult.ok
                  ? `OK: ${sniValidationResult.tlsVersion} ${sniValidationResult.group || ''}`
                  : `Не подходит: ${sniValidationResult.reason}`
              }}
            </p>
          </template>

          <template v-if="form.protocol === 'AMNEZIA_WG'">
            <label class="field">
              <span class="field__label">Подсеть</span>
              <input v-model="form.network" class="field__input" placeholder="10.13.13.0/24" />
            </label>
            <label class="field">
              <span class="field__label">DNS (через запятую)</span>
              <input v-model="form.dns" class="field__input" placeholder="1.1.1.1, 8.8.8.8" />
            </label>
            <label class="field">
              <span class="field__label">MTU</span>
              <input v-model.number="form.mtu" type="number" min="576" max="9000" class="field__input" />
            </label>
          </template>
        </div>
        <p class="modal__desc">Развёртывание занимает 10–30 секунд (genkey, валидация SNI, systemd, ufw).</p>
        <div v-if="modalError" class="modal__error">{{ modalError }}</div>
        <div class="modal__actions">
          <button class="btn btn--ghost btn--sm" @click="closeModal()">Отмена</button>
          <button class="btn btn--primary btn--sm" :disabled="creating" @click="submitCreateService">
            <span v-if="creating" class="btn__spinner" />
            Развернуть
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="modal.kind === 'createUser'"
      class="modal-overlay"
      @mousedown.self="closeModal()"
    >
      <div class="modal">
        <header class="modal__head">
          <h3 class="modal__title">Создать VPN-юзера</h3>
          <button class="modal__close" aria-label="Закрыть" title="Закрыть" @click="closeModal()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
          </button>
        </header>
        <div class="modal__fields">
          <label class="field">
            <span class="field__label">Имя</span>
            <input v-model="userForm.name" maxlength="32" class="field__input" placeholder="например, pavel-iphone" />
          </label>
          <label class="field">
            <span class="field__label">Заметки (опционально)</span>
            <input v-model="userForm.notes" maxlength="512" class="field__input" />
          </label>
          <div class="field">
            <span class="field__label">Включить в сервисы</span>
            <div class="checkbox-group">
              <label v-for="s in services" :key="s.id" class="checkbox">
                <input v-model="userForm.serviceIds" type="checkbox" :value="s.id" />
                <span>{{ s.label || protocolLabel(s.protocol) }} <span class="text-muted">:{{ s.port }}</span></span>
              </label>
              <p v-if="services.length === 0" class="field__hint">Сначала разверни сервис.</p>
            </div>
          </div>
        </div>
        <div v-if="modalError" class="modal__error">{{ modalError }}</div>
        <div class="modal__actions">
          <button class="btn btn--ghost btn--sm" @click="closeModal()">Отмена</button>
          <button class="btn btn--primary btn--sm" :disabled="creating" @click="submitCreateUser">
            <span v-if="creating" class="btn__spinner" />
            Создать
          </button>
        </div>
      </div>
    </div>

    <!-- ====== Объединённая модалка «Доступ»: Subscription + per-service конфиги ====== -->
    <div
      v-if="modal.kind === 'access'"
      class="modal-overlay"
      @mousedown.self="closeModal()"
    >
      <div class="modal modal--wide">
        <header class="modal__head">
          <h3 class="modal__title">Доступ · {{ modal.userName }}</h3>
          <button class="modal__close" aria-label="Закрыть" title="Закрыть" @click="closeModal()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
          </button>
        </header>

        <!-- Tabs -->
        <div class="tabs">
          <button
            v-if="hasVlessService"
            class="tab"
            :class="{ 'tab--active': accessTab === 'sub' }"
            @click="accessTab = 'sub'"
          >Подписка</button>
          <button
            v-for="svc in (modal.userId ? users.find((x) => x.id === modal.userId)?.services || [] : [])"
            :key="svc.credId"
            class="tab"
            :class="{ 'tab--active': accessTab === svc.serviceId }"
            @click="selectServiceTab(svc.serviceId)"
          >
            {{ protocolShort(svc.protocol) }}:{{ svc.port }}
          </button>
        </div>

        <!-- ===== Subscription tab ===== -->
        <template v-if="accessTab === 'sub'">
          <p class="modal__desc">
            Один URL = все <strong>VLESS+Reality</strong> сервисы юзера в одном subscription.
            В клиенте (Streisand / FoXray / NekoBox / v2rayNG) добавь как <strong>Subscribe URL</strong> —
            конфиги подтянутся автоматически и обновятся после ротации SNI/ключей.
            Для <strong>AmneziaWG</strong> подписка не работает — открой соответствующий таб и скачай <code>.conf</code>.
          </p>
          <div v-if="subQr" class="qr">
            <img :src="`data:image/png;base64,${subQr}`" alt="QR" />
          </div>
          <input
            v-if="subscriptionUrl"
            readonly
            :value="subscriptionUrl"
            class="field__input mono full-width"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <div class="vpn__clients">
            <div class="vpn__clients-title">Клиенты:</div>
            <div class="vpn__clients-grid">
              <div class="vpn__clients-platform">
                <strong>iOS</strong>
                <a href="https://apps.apple.com/app/streisand/id6450534064" target="_blank" rel="noopener">Streisand</a>
                <a href="https://apps.apple.com/app/amneziavpn/id1600529900" target="_blank" rel="noopener">Amnezia</a>
              </div>
              <div class="vpn__clients-platform">
                <strong>Android</strong>
                <a href="https://github.com/2dust/v2rayNG/releases/latest" target="_blank" rel="noopener">v2rayNG</a>
                <a href="https://amnezia.org/downloads" target="_blank" rel="noopener">Amnezia</a>
              </div>
              <div class="vpn__clients-platform">
                <strong>macOS</strong>
                <a href="https://apps.apple.com/app/v2box-v2ray-client/id6446814690" target="_blank" rel="noopener">V2Box</a>
                <a href="https://amnezia.org/downloads" target="_blank" rel="noopener">Amnezia</a>
              </div>
              <div class="vpn__clients-platform">
                <strong>Windows / Linux</strong>
                <a href="https://github.com/MatsuriDayo/nekoray/releases/latest" target="_blank" rel="noopener">NekoRay</a>
                <a href="https://amnezia.org/downloads" target="_blank" rel="noopener">Amnezia</a>
              </div>
            </div>
          </div>
          <div v-if="modalError" class="modal__error">{{ modalError }}</div>
          <div class="modal__actions">
            <button class="btn btn--ghost btn--sm" :disabled="!subscriptionUrl" @click="copyText(subscriptionUrl)">Скопировать URL</button>
            <button class="btn btn--danger btn--sm" :disabled="creating" @click="regenerateSubToken">
              <span v-if="creating" class="btn__spinner" />
              Перегенерировать токен
            </button>
          </div>
        </template>

        <!-- ===== Per-service tab ===== -->
        <template v-else>
          <p v-if="currentServiceMeta" class="modal__desc">
            <strong>{{ protocolLabel(currentServiceMeta.protocol) }}</strong> · порт <code>{{ currentServiceMeta.port }}</code>
            <template v-if="currentServiceMeta.protocol === 'AMNEZIA_WG'">
              · импортируй <code>.conf</code> в <strong>Amnezia</strong> или <strong>wg-quick</strong> (<code>awg-quick up ./{{ modal.userName }}.conf</code>).
            </template>
            <template v-else>
              · скан QR в любом клиенте (Streisand / v2rayNG / NekoBox / V2Box) или вставь <code>vless://</code> URL.
            </template>
          </p>
          <div v-if="!credsView" class="vpn__loading"><div class="spinner" /></div>
          <template v-else>
            <div class="qr">
              <img :src="`data:image/png;base64,${credsView.qrPng}`" alt="QR" />
            </div>
            <textarea readonly class="creds-text mono full-width" rows="8">{{ credsView.raw }}</textarea>
            <div class="modal__actions">
              <button class="btn btn--ghost btn--sm" @click="copyText(credsView.raw)">Скопировать конфиг</button>
              <button class="btn btn--ghost btn--sm" @click="copyText(credsView.configUrl)">Скопировать URL</button>
              <button class="btn btn--primary btn--sm" @click="downloadConf()">Скачать .conf</button>
            </div>
          </template>
        </template>
      </div>
    </div>

    <div
      v-if="modal.kind === 'addToService'"
      class="modal-overlay"
      @mousedown.self="closeModal()"
    >
      <div class="modal">
        <header class="modal__head">
          <h3 class="modal__title">Добавить «{{ modal.userName }}» в сервис</h3>
          <button class="modal__close" aria-label="Закрыть" title="Закрыть" @click="closeModal()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
          </button>
        </header>
        <div class="modal__fields">
          <label class="field">
            <span class="field__label">Сервис</span>
            <select v-model="addToServiceId" class="field__input">
              <option value="">— выбери —</option>
              <option v-for="s in availableServices" :key="s.id" :value="s.id">
                {{ s.label || protocolLabel(s.protocol) }} :{{ s.port }}
              </option>
            </select>
          </label>
          <p v-if="availableServices.length === 0" class="field__hint">Все сервисы уже подключены.</p>
        </div>
        <div v-if="modalError" class="modal__error">{{ modalError }}</div>
        <div class="modal__actions">
          <button class="btn btn--ghost btn--sm" @click="closeModal()">Отмена</button>
          <button
            class="btn btn--primary btn--sm"
            :disabled="!addToServiceId || creating"
            @click="submitAddToService"
          >Добавить</button>
        </div>
      </div>
    </div>

    <div
      v-if="modal.kind === 'rotateSni'"
      class="modal-overlay"
      @mousedown.self="closeModal()"
    >
      <div class="modal">
        <header class="modal__head">
          <h3 class="modal__title">Сменить SNI-маску</h3>
          <button class="modal__close" aria-label="Закрыть" title="Закрыть" @click="closeModal()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
          </button>
        </header>
        <p class="modal__desc">Текущая: <strong class="mono">{{ modal.currentSni }}</strong></p>
        <div class="modal__fields">
          <label class="field">
            <span class="field__label">Новая маска</span>
            <select v-model="newSni" class="field__input">
              <option v-for="m in DEFAULT_SNI_MASKS" :key="m" :value="m">{{ m }}</option>
              <option value="__custom__">Своя…</option>
            </select>
          </label>
          <label v-if="newSni === '__custom__'" class="field">
            <span class="field__label">Свой SNI</span>
            <input v-model="newSniCustom" class="field__input" placeholder="example.com" />
          </label>
        </div>
        <p class="modal__desc">⚠️ После смены SNI всем юзерам нужно обновить subscription в клиенте.</p>
        <div v-if="modalError" class="modal__error">{{ modalError }}</div>
        <div class="modal__actions">
          <button class="btn btn--ghost btn--sm" @click="closeModal()">Отмена</button>
          <button class="btn btn--primary btn--sm" :disabled="creating" @click="submitRotateSni">Применить</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';

definePageMeta({ middleware: 'auth' });

const DEFAULT_SNI_MASKS = [
  'www.google.com',
  'www.microsoft.com',
  'www.cloudflare.com',
  'addons.mozilla.org',
  'discord.com',
  'www.apple.com',
  'www.lovelive-anime.jp',
  'www.amazon.com',
];

interface VpnServiceListItem {
  id: string;
  label: string | null;
  protocol: string;
  port: number;
  status: string;
  errorMessage: string | null;
  sniMask: string | null;
  sniLastCheckOk: boolean | null;
  sniLastError: string | null;
  usersCount: number;
}
interface VpnUserListItem {
  id: string;
  name: string;
  enabled: boolean;
  notes: string | null;
  subToken: string;
  services: Array<{
    credId: string;
    serviceId: string;
    protocol: string;
    port: number;
    label: string | null;
    status: string;
    createdAt: string;
  }>;
}
interface VpnCredsView {
  configUrl: string;
  raw: string;
  qrPng: string;
}
interface InstallStatus {
  xray: { installed: boolean; version: string | null; details?: string };
  amnezia: { installed: boolean; version: string | null; details?: string };
}

const api = useApi();
const toast = useMbToast();
const confirm = useMbConfirm();

const services = ref<VpnServiceListItem[]>([]);
const users = ref<VpnUserListItem[]>([]);
const installStatus = ref<InstallStatus>({
  xray: { installed: false, version: null },
  amnezia: { installed: false, version: null },
});

const loading = ref(true);
const creating = ref(false);
const validating = ref(false);
const modalError = ref<string | null>(null);
const credsView = ref<VpnCredsView | null>(null);

const busy = reactive({
  installXray: false,
  installAmnezia: false,
  uninstallXray: false,
  uninstallAmnezia: false,
});

const modal = reactive<{
  kind: '' | 'createService' | 'createUser' | 'access' | 'addToService' | 'rotateSni';
  serviceId?: string;
  userId?: string;
  userName?: string;
  currentSni?: string;
}>({ kind: '' });

/**
 * Активный таб в модалке «Доступ»: 'sub' либо serviceId конкретного сервиса.
 * Существует пока модалка открыта.
 */
const accessTab = ref<string>('sub');

const form = reactive({
  protocol: 'VLESS_REALITY',
  port: 443,
  label: '',
  sniMask: 'www.google.com',
  sniMaskCustom: '',
  network: '10.13.13.0/24',
  dns: '1.1.1.1, 8.8.8.8',
  mtu: 1280,
});

const userForm = reactive({
  name: '',
  notes: '',
  serviceIds: [] as string[],
});

const sniValidationResult = ref<{ ok: boolean; tlsVersion?: string; group?: string; reason?: string } | null>(null);
const newSni = ref('www.google.com');
const newSniCustom = ref('');
const addToServiceId = ref('');
const subscriptionUrl = ref('');
const subQr = ref('');

const servicesByProto = computed(() => {
  const acc: Record<string, VpnServiceListItem[]> = { VLESS_REALITY: [], AMNEZIA_WG: [] };
  for (const s of services.value) {
    (acc[s.protocol] ?? (acc[s.protocol] = [])).push(s);
  }
  return acc;
});
const canCreateAnyService = computed(
  () => installStatus.value.xray.installed || installStatus.value.amnezia.installed,
);
const availableServices = computed(() => {
  if (!modal.userId) return [];
  const u = users.value.find((x) => x.id === modal.userId);
  if (!u) return [];
  const taken = new Set(u.services.map((s) => s.serviceId));
  return services.value.filter((s) => !taken.has(s.id));
});

/** Юзер из текущей модалки. */
const currentUser = computed<VpnUserListItem | null>(() => {
  if (!modal.userId) return null;
  return users.value.find((x) => x.id === modal.userId) || null;
});
/** Есть ли у юзера хотя бы один VLESS+Reality сервис (нужно ли показывать таб «Подписка»). */
const hasVlessService = computed(() => {
  return (currentUser.value?.services || []).some((s) => s.protocol === 'VLESS_REALITY');
});
/** Метаданные сервиса, выбранного активным табом (для шапки секции). */
const currentServiceMeta = computed<VpnUserListItem['services'][number] | null>(() => {
  if (accessTab.value === 'sub' || !currentUser.value) return null;
  return currentUser.value.services.find((s) => s.serviceId === accessTab.value) || null;
});

function protocolLabel(p: string): string {
  if (p === 'VLESS_REALITY') return 'VLESS+Reality';
  if (p === 'AMNEZIA_WG') return 'AmneziaWG';
  return p;
}
function protocolShort(p: string): string {
  if (p === 'VLESS_REALITY') return 'VLESS';
  if (p === 'AMNEZIA_WG') return 'WG';
  return p;
}
function statusLabel(s: string): string {
  return ({
    RUNNING: 'Работает',
    STOPPED: 'Остановлен',
    ERROR: 'Ошибка',
    DEPLOYING: 'Деплой',
  } as Record<string, string>)[s] || s;
}
function statusDotClass(s: string): string {
  return ({
    RUNNING: 'ok',
    STOPPED: 'idle',
    ERROR: 'err',
    DEPLOYING: 'idle',
  } as Record<string, string>)[s] || 'idle';
}

async function loadAll() {
  loading.value = true;
  try {
    const [s, u, st] = await Promise.all([
      api.get<VpnServiceListItem[]>('/vpn/services'),
      api.get<VpnUserListItem[]>('/vpn/users'),
      api.get<InstallStatus>('/vpn/install-status'),
    ]);
    services.value = s || [];
    users.value = u || [];
    installStatus.value = st || installStatus.value;
  } catch (err: unknown) {
    toast.error(`Ошибка загрузки: ${(err as Error).message}`);
  } finally {
    loading.value = false;
  }
}

async function installRuntime(protocol: 'VLESS_REALITY' | 'AMNEZIA_WG') {
  const flag = protocol === 'VLESS_REALITY' ? 'installXray' : 'installAmnezia';
  busy[flag] = true;
  try {
    await api.post(`/vpn/install/${protocol}`);
    toast.success(`${protocolLabel(protocol)} установлен`);
    await loadAll();
  } catch (err: unknown) {
    toast.error((err as Error).message);
  } finally {
    busy[flag] = false;
  }
}

async function uninstallRuntime(protocol: 'VLESS_REALITY' | 'AMNEZIA_WG') {
  const ok = await confirm.ask({
    title: `Удалить ${protocolLabel(protocol)} с сервера?`,
    message: 'Сам runtime будет снят. Сервисы и юзеры в БД останутся, но не смогут работать без runtime.',
    confirmText: 'Удалить',
    danger: true,
  });
  if (!ok) return;
  const flag = protocol === 'VLESS_REALITY' ? 'uninstallXray' : 'uninstallAmnezia';
  busy[flag] = true;
  try {
    await api.del(`/vpn/install/${protocol}`);
    toast.success('Удалено');
    await loadAll();
  } catch (err: unknown) {
    toast.error((err as Error).message);
  } finally {
    busy[flag] = false;
  }
}

function closeModal() {
  modal.kind = '';
  modal.serviceId = undefined;
  modal.userId = undefined;
  modal.userName = undefined;
  modal.currentSni = undefined;
  credsView.value = null;
  sniValidationResult.value = null;
  addToServiceId.value = '';
  modalError.value = null;
  subscriptionUrl.value = '';
  subQr.value = '';
  accessTab.value = 'sub';
}

function openCreateService() {
  // По умолчанию — первый установленный runtime.
  const defaultProto = installStatus.value.xray.installed ? 'VLESS_REALITY' : 'AMNEZIA_WG';
  Object.assign(form, {
    protocol: defaultProto,
    port: defaultProto === 'VLESS_REALITY' ? 443 : 51820,
    label: '',
    sniMask: 'www.google.com',
    sniMaskCustom: '',
    network: '10.13.13.0/24',
    dns: '1.1.1.1, 8.8.8.8',
    mtu: 1280,
  });
  sniValidationResult.value = null;
  modal.kind = 'createService';
}

function openCreateUser() {
  userForm.name = '';
  userForm.notes = '';
  userForm.serviceIds = [];
  modal.kind = 'createUser';
}

function openAddToService(u: VpnUserListItem) {
  modal.userId = u.id;
  modal.userName = u.name;
  addToServiceId.value = '';
  modal.kind = 'addToService';
}

function openRotateSni(s: VpnServiceListItem) {
  modal.serviceId = s.id;
  modal.currentSni = s.sniMask || '';
  newSni.value = 'www.google.com';
  newSniCustom.value = '';
  modal.kind = 'rotateSni';
}

async function testSni() {
  validating.value = true;
  sniValidationResult.value = null;
  try {
    const sni = form.sniMask === '__custom__' ? form.sniMaskCustom.trim() : form.sniMask;
    if (!sni) {
      toast.warning('Введи SNI');
      return;
    }
    const r = await api.post<{ ok: boolean; tlsVersion?: string; group?: string; reason?: string }>('/vpn/validate-sni', { sniMask: sni });
    sniValidationResult.value = r;
  } catch (err: unknown) {
    toast.error(`Проверка SNI: ${(err as Error).message}`);
  } finally {
    validating.value = false;
  }
}

async function submitCreateService() {
  modalError.value = null;
  creating.value = true;
  try {
    const payload: Record<string, unknown> = {
      protocol: form.protocol,
      port: form.port,
      label: form.label || undefined,
    };
    if (form.protocol === 'VLESS_REALITY') {
      const sni = form.sniMask === '__custom__' ? form.sniMaskCustom.trim() : form.sniMask;
      if (!sni) {
        modalError.value = 'SNI-маска обязательна';
        return;
      }
      payload.sniMask = sni;
    } else {
      payload.network = form.network;
      payload.dns = form.dns.split(',').map((s) => s.trim()).filter(Boolean);
      payload.mtu = form.mtu;
    }
    await api.post('/vpn/services', payload);
    toast.success('Сервис развёрнут');
    closeModal();
    await loadAll();
  } catch (err: unknown) {
    modalError.value = (err as Error).message;
  } finally {
    creating.value = false;
  }
}

async function submitCreateUser() {
  modalError.value = null;
  if (!userForm.name) {
    modalError.value = 'Имя обязательно';
    return;
  }
  creating.value = true;
  try {
    await api.post('/vpn/users', {
      name: userForm.name,
      notes: userForm.notes || undefined,
      serviceIds: userForm.serviceIds.length > 0 ? userForm.serviceIds : undefined,
    });
    toast.success('Юзер создан');
    closeModal();
    await loadAll();
  } catch (err: unknown) {
    modalError.value = (err as Error).message;
  } finally {
    creating.value = false;
  }
}

async function submitAddToService() {
  if (!modal.userId || !addToServiceId.value) return;
  modalError.value = null;
  creating.value = true;
  try {
    await api.post(`/vpn/users/${modal.userId}/services`, { serviceId: addToServiceId.value });
    toast.success('Юзер добавлен в сервис');
    closeModal();
    await loadAll();
  } catch (err: unknown) {
    modalError.value = (err as Error).message;
  } finally {
    creating.value = false;
  }
}

async function submitRotateSni() {
  if (!modal.serviceId) return;
  const sni = newSni.value === '__custom__' ? newSniCustom.value.trim() : newSni.value;
  if (!sni) return;
  modalError.value = null;
  creating.value = true;
  try {
    await api.post(`/vpn/services/${modal.serviceId}/rotate-sni`, { newSni: sni });
    toast.success('SNI сменён');
    closeModal();
    await loadAll();
  } catch (err: unknown) {
    modalError.value = (err as Error).message;
  } finally {
    creating.value = false;
  }
}

async function startService(id: string) {
  try {
    await api.post(`/vpn/services/${id}/start`);
    await loadAll();
  } catch (err: unknown) { toast.error((err as Error).message); }
}
async function stopService(id: string) {
  try {
    await api.post(`/vpn/services/${id}/stop`);
    await loadAll();
  } catch (err: unknown) { toast.error((err as Error).message); }
}
async function deleteService(s: VpnServiceListItem) {
  const ok = await confirm.ask({
    title: 'Удалить сервис?',
    message: `Все юзеры на этом сервисе потеряют доступ.${s.usersCount > 0 ? ` Активных юзеров: ${s.usersCount}.` : ''}`,
    confirmText: 'Удалить',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/vpn/services/${s.id}`);
    toast.success('Удалено');
    await loadAll();
  } catch (err: unknown) { toast.error((err as Error).message); }
}
async function rotateKeys(s: VpnServiceListItem) {
  const ok = await confirm.ask({
    title: 'Ротировать ключи?',
    message: 'Все юзеры должны будут перетянуть subscription в клиенте.',
    confirmText: 'Ротировать',
    danger: false,
  });
  if (!ok) return;
  try {
    await api.post(`/vpn/services/${s.id}/rotate-keys`);
    toast.success('Ключи ротированы');
    await loadAll();
  } catch (err: unknown) { toast.error((err as Error).message); }
}
async function deleteUser(u: VpnUserListItem) {
  const ok = await confirm.ask({
    title: `Удалить юзера ${u.name}?`,
    message: 'Доступ ко всем сервисам будет отозван.',
    confirmText: 'Удалить',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/vpn/users/${u.id}`);
    toast.success('Удалено');
    await loadAll();
  } catch (err: unknown) { toast.error((err as Error).message); }
}
async function toggleUser(u: VpnUserListItem) {
  try {
    await api.patch(`/vpn/users/${u.id}`, { enabled: !u.enabled });
    await loadAll();
  } catch (err: unknown) { toast.error((err as Error).message); }
}
/**
 * Открыть унифицированную модалку «Доступ».
 *
 * Если передан `preselectServiceId` — открывается с табом конкретного сервиса
 * (по клику на чип в таблице). Иначе — таб «Подписка» (если есть VLESS-сервисы),
 * или первый сервис юзера (если все WG).
 */
async function openAccess(u: VpnUserListItem, preselectServiceId?: string) {
  modal.userId = u.id;
  modal.userName = u.name;
  modal.kind = 'access';
  credsView.value = null;
  modalError.value = null;

  // Предзагрузим subscription URL + QR — даже если юзер сразу откроет таб сервиса,
  // переключение на «Подписка» не должно упираться в загрузку.
  subscriptionUrl.value = `${window.location.origin}/api/vpn/sub/${u.subToken}`;
  subQr.value = '';
  void renderSubQr();

  // Выбор активного таба.
  const hasVless = u.services.some((s) => s.protocol === 'VLESS_REALITY');
  if (preselectServiceId) {
    accessTab.value = preselectServiceId;
    void loadCredsForTab(preselectServiceId);
  } else if (hasVless) {
    accessTab.value = 'sub';
  } else if (u.services.length > 0) {
    accessTab.value = u.services[0].serviceId;
    void loadCredsForTab(u.services[0].serviceId);
  } else {
    accessTab.value = 'sub';
  }
}

async function selectServiceTab(serviceId: string) {
  accessTab.value = serviceId;
  await loadCredsForTab(serviceId);
}

async function loadCredsForTab(serviceId: string) {
  if (!modal.userId) return;
  credsView.value = null;
  try {
    const data = await api.get<VpnCredsView>(`/vpn/users/${modal.userId}/services/${serviceId}/creds`);
    credsView.value = data;
  } catch (err: unknown) {
    toast.error((err as Error).message);
  }
}

async function renderSubQr() {
  try {
    const QRCode = (await import('qrcode')).default;
    const dataUrl = await QRCode.toDataURL(subscriptionUrl.value, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
    });
    subQr.value = dataUrl.split(',')[1] || '';
  } catch (err: unknown) {
    toast.error(`QR: ${(err as Error).message}`);
  }
}

/**
 * Скопировать текст. Использует Clipboard API когда secure context (https/localhost),
 * иначе fallback через скрытый <textarea> + execCommand — нужно для http/IP-адресов
 * без TLS, где navigator.clipboard заблокирован браузером.
 */
async function copyText(t: string) {
  if (!t) return;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(t);
      toast.success('Скопировано');
      return;
    }
  } catch {
    /* ниже fallback */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (!ok) throw new Error('execCommand вернул false');
    toast.success('Скопировано');
  } catch {
    toast.error('Не получилось скопировать — выдели текст и нажми ⌘/Ctrl+C');
  }
}
async function regenerateSubToken() {
  if (!modal.userId) return;
  const ok = await confirm.ask({
    title: 'Перегенерировать токен subscription?',
    message: 'Старый URL перестанет работать. Юзеру нужно будет загрузить новый subscription в клиенте.',
    confirmText: 'Перегенерировать',
    danger: true,
  });
  if (!ok) return;
  creating.value = true;
  try {
    const r = await api.post<{ subToken: string }>(`/vpn/users/${modal.userId}/regenerate-sub-token`);
    toast.success('Токен пересоздан');
    // Обновим локально и перерисуем QR
    const u = users.value.find((x) => x.id === modal.userId);
    if (u) u.subToken = r.subToken;
    subscriptionUrl.value = `${window.location.origin}/api/vpn/sub/${r.subToken}`;
    await renderSubQr();
  } catch (err: unknown) {
    toast.error((err as Error).message);
  } finally {
    creating.value = false;
  }
}
function downloadConf() {
  if (!credsView.value) return;
  // Расширение зависит от протокола: WG-конфиг — .conf; vless:// URL — .txt
  // (для VLESS «скачать» это про raw текст, никакой клиент не импортит файл).
  const meta = currentServiceMeta.value;
  const isWg = meta?.protocol === 'AMNEZIA_WG';
  const ext = isWg ? 'conf' : 'txt';
  const portTag = meta ? `-${meta.port}` : '';
  const blob = new Blob([credsView.value.raw], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${modal.userName || 'vpn'}${portTag}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

onMounted(loadAll);
</script>

<style scoped>
.vpn { padding: 1.25rem 1.5rem 2rem; max-width: 1400px; }

.vpn__header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 1rem; margin-bottom: 1.5rem;
}
.vpn__title { font-size: 1.45rem; font-weight: 600; margin: 0 0 0.25rem; color: var(--text-primary); }
.vpn__subtitle { font-size: 0.85rem; color: var(--text-tertiary); margin: 0; max-width: 700px; }

.vpn__loading {
  display: flex; align-items: center; justify-content: center; padding: 4rem 2rem;
}

.vpn__section { margin-bottom: 2rem; }
.vpn__section-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.75rem; margin-bottom: 0.85rem; flex-wrap: wrap;
}
.vpn__section-title {
  font-size: 0.95rem; font-weight: 600; color: var(--text-primary);
  margin: 0 0 0.85rem; display: flex; align-items: center; gap: 0.5rem;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.vpn__section-head .vpn__section-title { margin: 0; }
.vpn__hint { color: var(--text-tertiary); font-weight: 400; text-transform: none; letter-spacing: 0; font-size: 0.8rem; }
.vpn__badge {
  background: var(--bg-input); padding: 0.1rem 0.5rem; border-radius: 999px;
  font-size: 0.7rem; font-weight: 500; color: var(--text-tertiary); letter-spacing: 0;
}

.vpn__empty {
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 12px; padding: 2rem; text-align: center; color: var(--text-tertiary);
}
.vpn__empty p { margin: 0; }
.vpn__empty-hint { font-size: 0.82rem; color: var(--text-muted); margin-top: 0.4rem; }

/* ===== Runtime cards ===== */
.rt-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 1rem;
}
.rt-card {
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 14px; padding: 1.1rem;
  display: flex; flex-direction: column; gap: 0.85rem;
  transition: border-color 0.2s;
}
.rt-card:hover { border-color: var(--border-strong); }
.rt-card__head {
  display: grid; grid-template-columns: auto 1fr auto; align-items: center;
  gap: 0.75rem;
}
.rt-card__icon {
  width: 40px; height: 40px; border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
}
.rt-card__icon--reality { background: rgba(var(--primary-rgb), 0.13); color: var(--primary-light); }
.rt-card__icon--awg { background: rgba(16, 185, 129, 0.13); color: rgb(52, 211, 153); }
.rt-card__title-block { min-width: 0; }
.rt-card__title {
  font-size: 0.97rem; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rt-card__category {
  font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--text-tertiary); margin-top: 2px;
}
.rt-card__status {
  display: inline-flex; align-items: center; gap: 0.35rem;
  font-size: 0.72rem; font-weight: 500; padding: 0.25rem 0.55rem;
  border-radius: 999px; white-space: nowrap;
}
.rt-card__status--ok { background: rgba(16, 185, 129, 0.13); color: rgb(52, 211, 153); }
.rt-card__status--idle { background: rgba(115, 115, 115, 0.18); color: var(--text-tertiary); }
.rt-card__desc { font-size: 0.82rem; color: var(--text-secondary); line-height: 1.5; margin: 0; }
.rt-card__meta { border-top: 1px solid var(--border); padding-top: 0.7rem; display: flex; flex-direction: column; gap: 0.4rem; }
.rt-card__meta-row { display: flex; justify-content: space-between; align-items: baseline; font-size: 0.8rem; }
.rt-card__meta-label { color: var(--text-tertiary); }
.rt-card__meta-value { color: var(--text-primary); font-weight: 500; }
.rt-card__actions { display: flex; gap: 0.5rem; margin-top: auto; }
.rt-card__actions .btn { flex: 1; }

/* ===== Service cards ===== */
.vpn__services-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 1rem;
}
.svc-card {
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 14px; padding: 1.1rem;
  display: flex; flex-direction: column; gap: 0.85rem;
  transition: border-color 0.2s;
}
.svc-card:hover { border-color: var(--border-strong); }
.svc-card--running { border-color: rgba(16, 185, 129, 0.3); }
.svc-card--error { border-color: rgba(239, 68, 68, 0.35); }
.svc-card--deploying { border-color: rgba(var(--primary-rgb), 0.3); }
.svc-card__head { display: grid; grid-template-columns: 1fr auto; gap: 0.75rem; align-items: center; }
.svc-card__title {
  font-size: 0.97rem; font-weight: 600; color: var(--text-primary);
  display: flex; align-items: baseline; gap: 0.4rem;
}
.svc-card__port { color: var(--text-tertiary); font-weight: 500; font-size: 0.85rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.svc-card__category { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-tertiary); margin-top: 2px; }
.svc-card__status { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.72rem; font-weight: 500; padding: 0.25rem 0.55rem; border-radius: 999px; white-space: nowrap; }
.svc-card__status--running { background: rgba(16, 185, 129, 0.13); color: rgb(52, 211, 153); }
.svc-card__status--stopped { background: rgba(115, 115, 115, 0.18); color: var(--text-tertiary); }
.svc-card__status--error { background: rgba(239, 68, 68, 0.13); color: rgb(248, 113, 113); }
.svc-card__status--deploying { background: rgba(var(--primary-rgb), 0.13); color: var(--primary-light); }
.svc-card__meta { border-top: 1px solid var(--border); padding-top: 0.7rem; display: flex; flex-direction: column; gap: 0.4rem; }
.svc-card__meta-row { display: flex; justify-content: space-between; align-items: baseline; font-size: 0.8rem; gap: 0.5rem; }
.svc-card__meta-label { color: var(--text-tertiary); flex-shrink: 0; }
.svc-card__meta-value { color: var(--text-primary); font-weight: 500; text-align: right; word-break: break-all; }
.svc-card__error {
  font-size: 0.78rem; color: rgb(248, 113, 113);
  background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.25);
  padding: 0.4rem 0.6rem; border-radius: 6px; word-break: break-word;
}
.svc-card__actions { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-top: auto; }

/* ===== status dots ===== */
.status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.status-dot--ok { background: rgb(52, 211, 153); box-shadow: 0 0 6px rgba(52, 211, 153, 0.6); }
.status-dot--idle { background: rgb(115, 115, 115); }
.status-dot--err { background: rgb(239, 68, 68); box-shadow: 0 0 6px rgba(239, 68, 68, 0.5); }

/* ===== badges ===== */
.badge {
  display: inline-flex; align-items: center; font-size: 0.65rem; font-weight: 600;
  padding: 0.1rem 0.45rem; border-radius: 6px; text-transform: uppercase; letter-spacing: 0.04em;
  margin-left: 0.35rem;
}
.badge--ok { background: rgba(16, 185, 129, 0.13); color: rgb(52, 211, 153); }
.badge--bad { background: rgba(239, 68, 68, 0.13); color: rgb(248, 113, 113); }
.badge--idle { background: rgba(115, 115, 115, 0.18); color: var(--text-tertiary); }

/* ===== users table ===== */
.table-wrap {
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 12px; overflow: hidden;
}
.table { width: 100%; border-collapse: collapse; }
.table th, .table td {
  padding: 0.65rem 0.95rem; text-align: left;
  border-bottom: 1px solid var(--border); font-size: 0.85rem;
  vertical-align: middle;
}
.table th {
  background: var(--bg-input); font-size: 0.7rem;
  text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--text-tertiary); font-weight: 600;
}
.table tbody tr:last-child td { border-bottom: 0; }
.table tbody tr:hover { background: var(--bg-surface-hover); }
.table__actions-th { width: 1px; }
.table__actions-cell {
  display: flex; gap: 0.35rem; flex-wrap: nowrap;
  justify-content: flex-end; white-space: nowrap;
}
.table__actions-cell .btn { flex: 0 0 auto; }

.user-services { display: flex; gap: 0.35rem; flex-wrap: wrap; }
.chip {
  background: var(--bg-input); border: 1px solid var(--border-strong);
  padding: 0.2rem 0.55rem; border-radius: 6px; font-size: 0.72rem;
  cursor: pointer; color: var(--text-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  transition: all 0.15s;
}
.chip:hover { background: var(--primary-bg); border-color: var(--primary-border); color: var(--primary-text); }

.text-muted { color: var(--text-muted); }

/* ===== buttons ===== */
.btn {
  display: inline-flex; align-items: center; justify-content: center;
  gap: 0.4rem; padding: 0.55rem 1rem;
  border-radius: 10px; border: none; font-size: 0.82rem; font-weight: 600;
  font-family: inherit; cursor: pointer; transition: all 0.2s; white-space: nowrap;
}
.btn--xs { padding: 0.3rem 0.65rem; font-size: 0.72rem; border-radius: 7px; }
.btn--sm { padding: 0.45rem 0.85rem; font-size: 0.75rem; border-radius: 8px; }
.btn--icon { padding: 0.45rem; width: 32px; height: 32px; flex: 0 0 auto; }
.btn--primary { background: linear-gradient(135deg, var(--primary-light), var(--primary-dark)); color: var(--primary-text-on); }
.btn--primary:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(var(--primary-rgb), 0.2); }
.btn--primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--ghost { background: var(--bg-input); border: 1px solid var(--border-strong); color: var(--text-secondary); }
.btn--ghost:hover:not(:disabled) { color: var(--text-primary); border-color: var(--border-strong); background: var(--bg-surface-hover); }
.btn--ghost:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--danger { background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.25); color: rgb(248, 113, 113); }
.btn--danger:not(:disabled):hover { background: rgba(239, 68, 68, 0.2); }
.btn--danger:disabled { opacity: 0.4; cursor: not-allowed; }

.btn__spinner {
  width: 12px; height: 12px;
  border: 2px solid currentColor; border-top-color: transparent;
  border-radius: 50%; animation: spin 0.8s linear infinite; flex: 0 0 auto;
}

.spinner {
  width: 24px; height: 24px;
  border: 2px solid var(--spinner-track); border-top-color: var(--primary);
  border-radius: 50%; animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ===== modal ===== */
.modal-overlay {
  position: fixed; inset: 0; background: var(--bg-overlay);
  backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center;
  z-index: 200; padding: 1rem;
}
.modal {
  background: var(--bg-modal-gradient); border: 1px solid var(--border-secondary);
  border-radius: 18px; padding: 1.5rem; width: 100%; max-width: 460px;
  max-height: 92vh; overflow-y: auto;
  box-shadow: var(--shadow-modal); animation: modalIn 0.25s ease;
}
.modal--wide { max-width: 600px; }
.modal__head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 0.75rem; margin: 0 0 1rem;
}
.modal__title { font-size: 1.05rem; font-weight: 700; color: var(--text-heading); margin: 0; flex: 1; }
.modal__close {
  flex: 0 0 auto; width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: 1px solid transparent; border-radius: 8px;
  color: var(--text-tertiary); cursor: pointer; padding: 0; transition: all 0.15s;
}
.modal__close:hover {
  color: var(--text-primary); background: var(--bg-input); border-color: var(--border-strong);
}

/* tabs (внутри модалки «Доступ») */
.tabs {
  display: flex; flex-wrap: wrap; gap: 0.25rem;
  border-bottom: 1px solid var(--border); margin-bottom: 0.85rem;
}
.tab {
  background: transparent; border: 0; padding: 0.5rem 0.85rem;
  font-size: 0.78rem; font-weight: 500; color: var(--text-tertiary);
  cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px;
  font-family: inherit; transition: all 0.15s;
}
.tab:hover { color: var(--text-secondary); }
.tab--active {
  color: var(--text-primary); border-bottom-color: var(--primary);
}

/* full-width вход (URL/textarea в модалках) */
.full-width { width: 100%; box-sizing: border-box; display: block; }
.modal__desc { font-size: 0.82rem; color: var(--text-tertiary); margin: 0.5rem 0 0; line-height: 1.5; }
.modal__desc strong { color: var(--text-secondary); }
.modal__fields { display: flex; flex-direction: column; gap: 0.85rem; margin-bottom: 1rem; }
.modal__error {
  color: rgb(248, 113, 113); font-size: 0.78rem; margin: 0.5rem 0;
  padding: 0.5rem 0.75rem; background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.25); border-radius: 8px;
}
.modal__actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1rem; }

@keyframes modalIn {
  from { opacity: 0; transform: scale(0.96) translateY(8px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}

.field { display: flex; flex-direction: column; gap: 0.35rem; }
.field__label { font-size: 0.72rem; color: var(--text-tertiary); font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; }
.field__input {
  padding: 0.55rem 0.75rem; background: var(--bg-input);
  border: 1px solid var(--border-strong); border-radius: 8px;
  color: var(--text-primary); font-size: 0.85rem; font-family: inherit;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.field__input:focus { outline: none; border-color: var(--primary); box-shadow: var(--focus-ring); }
.field__hint { font-size: 0.75rem; color: var(--text-tertiary); margin: 0; }
.field__hint--ok { color: rgb(52, 211, 153); }
.field__hint--bad { color: rgb(248, 113, 113); }

.checkbox-group { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.25rem 0; }
.checkbox { display: flex; align-items: center; gap: 0.5rem; cursor: pointer; padding: 0.25rem 0; font-size: 0.85rem; color: var(--text-primary); }
.checkbox input { accent-color: var(--primary); }

/* ===== creds modal: QR + textarea ===== */
.qr {
  display: flex; justify-content: center; padding: 1rem;
  background: #ffffff; border-radius: 12px; margin-bottom: 0.85rem;
}
.qr img { display: block; max-width: 100%; max-height: 320px; }
.creds-text {
  width: 100%; padding: 0.75rem; font-size: 0.72rem;
  background: var(--bg-input); border: 1px solid var(--border-strong);
  border-radius: 8px; color: var(--text-primary); resize: vertical; box-sizing: border-box;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.78rem;
}

/* ===== legal disclaimer ===== */
.vpn__disclaimer {
  font-size: 0.7rem; color: var(--text-muted); line-height: 1.5;
  border-top: 1px solid var(--border); padding-top: 1rem; margin: 1.5rem 0 0;
  max-width: 800px;
}

/* ===== clients grid in subscription modal ===== */
.vpn__clients {
  margin-top: 1rem; padding: 0.75rem; background: var(--bg-input);
  border: 1px solid var(--border); border-radius: 8px;
}
.vpn__clients-title {
  font-size: 0.7rem; color: var(--text-tertiary); text-transform: uppercase;
  letter-spacing: 0.04em; font-weight: 600; margin-bottom: 0.5rem;
}
.vpn__clients-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 0.5rem;
}
.vpn__clients-platform {
  display: flex; flex-direction: column; gap: 0.15rem;
  font-size: 0.78rem;
}
.vpn__clients-platform strong { color: var(--text-secondary); font-size: 0.7rem; text-transform: uppercase; }
.vpn__clients-platform a { color: var(--primary-light); text-decoration: none; }
.vpn__clients-platform a:hover { text-decoration: underline; }

@media (max-width: 768px) {
  .vpn { padding: 1rem 0.85rem 2rem; }
  .vpn__header { flex-direction: column; align-items: stretch; }
  .vpn__title { font-size: 1.25rem; }
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .table { min-width: 600px; }
  .modal { padding: 1.1rem; }
}
</style>
