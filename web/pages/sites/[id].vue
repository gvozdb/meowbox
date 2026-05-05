<template>
  <div class="site-detail">
    <!-- Loading -->
    <div v-if="loading" class="site-detail__loading">
      <div class="site-detail__loading-spinner" />
      <span>Загрузка сайта...</span>
    </div>

    <!-- Content -->
    <template v-else-if="site">
      <!-- Header -->
      <div class="site-detail__header">
        <NuxtLink to="/sites" class="site-detail__back">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <polyline points="15,18 9,12 15,6" />
          </svg>
          <span>Сайты</span>
        </NuxtLink>

        <div class="site-detail__header-main">
          <div class="site-detail__header-left">
            <SiteTypeIcon :type="site.type" />
            <div>
              <h1 class="site-detail__title">{{ site.displayName || site.name }}</h1>
              <p class="site-detail__domain">
                {{ site.domain }}
                <span v-if="site.displayName" class="site-detail__sysname">· {{ site.name }}</span>
              </p>
            </div>
          </div>
          <div class="site-detail__header-right">
            <SiteStatusBadge :status="site.status" />
            <div class="site-detail__actions-group">
              <button
                v-if="site.status === 'STOPPED'"
                class="site-detail__action-btn site-detail__action-btn--start"
                title="Запустить"
                @click="controlSite('start')"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21" /></svg>
              </button>
              <button
                v-if="site.status === 'RUNNING'"
                class="site-detail__action-btn site-detail__action-btn--stop"
                title="Остановить"
                @click="controlSite('stop')"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="12" height="16" rx="2" /></svg>
              </button>
              <button
                v-if="site.status === 'RUNNING'"
                class="site-detail__action-btn"
                title="Перезапустить"
                @click="controlSite('restart')"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <polyline points="23,4 23,10 17,10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              </button>
              <button
                class="site-detail__action-btn"
                title="Дублировать сайт"
                @click="openDuplicateDialog"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Hostpanel migration banner: SSL reissue (spec §9.4) -->
      <div v-if="hostpanelMigrationBanner" class="site-detail__hp-banner">
        <div class="site-detail__hp-banner-head">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M12 2 L2 22 L22 22 Z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <strong>Сайт перенесён со старой hostPanel</strong>
        </div>
        <p class="site-detail__hp-banner-text">
          Сертификат скопирован с источника. После того как привяжешь новый IP к домену
          <code>{{ site.domain }}</code> — нажми <strong>«Выпустить»</strong> на вкладке SSL,
          чтобы получить свежий сертификат от Let's Encrypt.
        </p>
        <div class="site-detail__hp-banner-actions">
          <button class="btn btn--primary btn--sm" @click="activeTab = 'ssl'">
            🔒 Перейти к SSL →
          </button>
          <button class="btn btn--ghost btn--sm" @click="dismissHostpanelBanner">
            Скрыть до перевыпуска
          </button>
        </div>
      </div>

      <!-- Error banner (provisioning/deploy errors) -->
      <div v-if="site.status === 'ERROR' && site.errorMessage" class="site-detail__error-banner">
        <div class="site-detail__error-banner-head">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <strong>Ошибка при создании/деплое сайта</strong>
        </div>
        <pre class="site-detail__error-banner-text">{{ site.errorMessage }}</pre>
      </div>

      <!-- Tabs -->
      <div class="site-detail__tabs">
        <button
          v-for="t in tabs"
          :key="t.id"
          class="site-detail__tab"
          :class="{ 'site-detail__tab--active': activeTab === t.id }"
          @click="activeTab = t.id"
        >
          {{ t.label }}
          <span v-if="t.count !== undefined" class="site-detail__tab-count">{{ t.count }}</span>
        </button>
      </div>

      <!-- Tab content: Overview -->
      <div v-if="activeTab === 'overview'" class="tab-content">
        <div class="info-grid">
          <!-- 1. Основное -->
          <div class="info-card">
            <h3 class="info-card__title">Основное</h3>
            <div class="info-card__rows">
              <div class="info-row">
                <span class="info-row__label">Тип</span>
                <span class="info-row__value">{{ typeLabel }}</span>
              </div>
              <div class="info-row">
                <span class="info-row__label">Корневой путь</span>
                <span class="info-row__value info-row__value--mono">{{ site.rootPath }}</span>
              </div>
              <div class="info-row">
                <span class="info-row__label">Папка с веб файлами</span>
                <span class="info-row__value info-row__value--mono">{{ site.filesRelPath || 'www' }}</span>
                <button class="info-row__btn" @click="openEditFilesRelPath" title="Изменить папку с веб файлами">
                  Изменить
                </button>
              </div>
              <div v-if="site.phpVersion" class="info-row">
                <span class="info-row__label">Версия PHP</span>
                <select
                  class="info-row__select"
                  :value="site.phpVersion"
                  :disabled="phpVersionChanging"
                  @change="changePhpVersion(($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="v in phpVersions" :key="v" :value="v">{{ v }}</option>
                </select>
              </div>
              <div v-if="site.appPort" class="info-row">
                <span class="info-row__label">Порт</span>
                <span class="info-row__value info-row__value--mono">:{{ site.appPort }}</span>
              </div>
            </div>
          </div>

          <!-- 2. SSH / SFTP -->
          <div v-if="site.systemUser" class="info-card">
            <h3 class="info-card__title">SSH / SFTP</h3>
            <div class="info-card__rows">
              <div class="info-row">
                <span class="info-row__label">Подключение</span>
                <span class="info-row__value info-row__value--mono ssh-cmd">ssh -p 22 {{ site.systemUser }}@{{ sshHost }}</span>
                <button class="info-row__btn" @click="copySshCommand" title="Копировать">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                </button>
              </div>
              <div class="info-row">
                <span class="info-row__label">Пароль</span>
                <span v-if="sshPassword" class="info-row__value info-row__value--mono">{{ sshPasswordVisible ? sshPassword : '••••••••••••' }}</span>
                <span v-else class="info-row__value info-row__value--muted">Не загружен</span>
                <button class="info-row__btn" @click="toggleSshPassword">
                  {{ sshPassword ? (sshPasswordVisible ? 'Скрыть' : 'Показать') : 'Загрузить' }}
                </button>
                <button class="info-row__btn" @click="showSshPasswordModal = true" title="Сменить пароль">
                  Сменить
                </button>
              </div>
              <div class="info-row">
                <span class="info-row__label">Домашняя директория</span>
                <span class="info-row__value info-row__value--mono">{{ site.rootPath }}</span>
              </div>
            </div>
          </div>

          <!-- 3. Домен и SSL -->
          <div class="info-card">
            <h3 class="info-card__title">Домен и SSL</h3>
            <div class="info-card__rows">
              <div class="info-row">
                <span class="info-row__label">Домен</span>
                <span class="info-row__value info-row__value--mono">{{ site.domain }}</span>
              </div>
              <div v-if="site.aliases?.length" class="info-row">
                <span class="info-row__label">Алиасы</span>
                <span class="info-row__value info-row__value--mono">{{ aliasesSummary }}</span>
              </div>
              <div v-if="site.sslCertificate" class="info-row">
                <span class="info-row__label">SSL</span>
                <span class="info-row__value" :class="sslClass">{{ sslLabel }}</span>
              </div>
              <div v-if="site.sslCertificate?.expiresAt" class="info-row">
                <span class="info-row__label">SSL истекает</span>
                <span class="info-row__value">{{ formatDate(site.sslCertificate.expiresAt) }}</span>
              </div>
            </div>
          </div>

          <!-- 4. Ресурсы -->
          <div class="info-card">
            <h3 class="info-card__title">Ресурсы</h3>
            <div class="info-card__rows">
              <div class="info-row">
                <span class="info-row__label">Базы данных</span>
                <span class="info-row__value">{{ site.databases?.length || 0 }}</span>
                <!-- Если БД есть — даём кнопку «Adminer» прямо в строке. Для одной БД сразу
                     открываем её, для нескольких — мини-меню по клику. -->
                <button
                  v-if="site.databases?.length === 1"
                  class="info-row__btn info-row__btn--text"
                  :disabled="openingAdminer === site.databases[0].id"
                  :title="`Открыть «${site.databases[0].name}» в Adminer`"
                  @click="openAdminer(site.databases[0].id)"
                >
                  <svg v-if="openingAdminer !== site.databases[0].id" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>
                  <span v-else class="spinner-small" />
                  Adminer
                </button>
                <button
                  v-else-if="(site.databases?.length || 0) > 1"
                  class="info-row__btn info-row__btn--text"
                  title="Выбрать БД для Adminer"
                  @click="adminerPickerOpen = !adminerPickerOpen"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>
                  Adminer
                </button>
              </div>
              <!-- Picker для случая нескольких БД -->
              <div v-if="adminerPickerOpen && (site.databases?.length || 0) > 1" class="adminer-picker">
                <button
                  v-for="db in site.databases"
                  :key="db.id"
                  class="adminer-picker__item"
                  :disabled="openingAdminer === db.id"
                  @click="onPickAdminer(db.id)"
                >
                  <span class="adminer-picker__name">{{ db.name }}</span>
                  <span class="adminer-picker__meta">{{ db.type }}</span>
                </button>
              </div>
              <div class="info-row">
                <span class="info-row__label">Бэкапы</span>
                <span class="info-row__value">{{ site._count?.backups || 0 }}</span>
              </div>
              <div class="info-row">
                <span class="info-row__label">Cron-задачи</span>
                <span class="info-row__value">{{ site._count?.cronJobs || 0 }}</span>
              </div>
              <div class="info-row">
                <span class="info-row__label">Создан</span>
                <span class="info-row__value">{{ formatDate(site.createdAt) }}</span>
              </div>
            </div>
          </div>

          <!-- 5. Утилиты — расширяемый список сервисных операций для сайта -->
          <div class="info-card info-card--utilities">
            <h3 class="info-card__title info-card__title--icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
              <span>Утилиты</span>
            </h3>
            <ul class="utility-list">
              <li class="utility-item">
                <div class="utility-item__icon" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                </div>
                <div class="utility-item__body">
                  <div class="utility-item__name">Нормализация прав и владельца</div>
                  <div class="utility-item__hint">{{ normalizePermsHint }}</div>
                  <div
                    v-if="normalizePermsResult"
                    class="utility-item__status"
                    :class="{ 'utility-item__status--err': normalizePermsResult.error }"
                  >
                    <span v-if="normalizePermsResult.error">Ошибка: {{ normalizePermsResult.error }}</span>
                    <span v-else>Готово. Шагов выполнено: {{ normalizePermsResult.stepCount }}.</span>
                  </div>
                </div>
                <button
                  class="utility-item__action"
                  :disabled="normalizingPerms"
                  @click="onNormalizePermissions"
                >
                  <span v-if="normalizingPerms" class="spinner-small" />
                  <span>{{ normalizingPerms ? 'Запуск…' : 'Запустить' }}</span>
                </button>
              </li>
              <!-- сюда добавятся следующие утилиты -->
            </ul>
          </div>

          <!-- 6. CMS (для не-custom; объединяет Admin + MODX-версия) -->
          <div v-if="hasCmsInfo" class="info-card">
            <h3 class="info-card__title info-card__title--icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4"/><path d="M3 17l9 4 9-4"/></svg>
              <span>{{ cmsTitle }}</span>
            </h3>
            <div v-if="site.cmsAdminUser" class="info-card__rows">
              <div class="info-row">
                <span class="info-row__label">URL админки</span>
                <span class="info-row__value info-row__value--mono">{{ site.domain }}/{{ managerPathSafe }}/</span>
                <button class="info-row__btn" :disabled="cmsAutoLoginBusy" @click="openCmsAdmin" :title="cmsAutoLoginBusy ? 'Логиню…' : 'Открыть (auto-login)'">
                  <svg v-if="!cmsAutoLoginBusy" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15,3 21,3 21,9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                  <span v-else class="spinner-small" />
                </button>
              </div>
              <div class="info-row">
                <span class="info-row__label">Логин</span>
                <span class="info-row__value info-row__value--mono">{{ site.cmsAdminUser }}</span>
              </div>
              <div class="info-row">
                <span class="info-row__label">Пароль</span>
                <span v-if="cmsPassword" class="info-row__value info-row__value--mono">{{ cmsPasswordVisible ? cmsPassword : '••••••••••••' }}</span>
                <span v-else class="info-row__value info-row__value--muted">Не загружен</span>
                <button class="info-row__btn" @click="toggleCmsPassword">
                  {{ cmsPassword ? (cmsPasswordVisible ? 'Скрыть' : 'Показать') : 'Загрузить' }}
                </button>
                <button class="info-row__btn info-row__btn--text" title="Сменить пароль MODX-админа" @click="openCmsAdminPasswordModal">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
                  Изменить
                </button>
              </div>
              <div v-if="isModxSite" class="info-row">
                <span class="info-row__label">Версия</span>
                <span v-if="site.modxVersion" class="info-row__value info-row__value--mono">{{ site.modxVersion }}</span>
                <span v-else class="info-row__value info-row__value--muted">Не установлена</span>
                <button class="info-row__btn info-row__btn--text" @click="openModxUpdateModal" title="Апгрейд версии">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23,4 23,10 17,10" /><path d="M20.49,15a9,9,0,1,1-2.12-9.36L23,10" /></svg>
                  Апгрейд
                </button>
              </div>
            </div>
            <div v-else-if="isModxSite" class="info-card__rows">
              <div class="info-row">
                <span class="info-row__label">Версия</span>
                <span v-if="site.modxVersion" class="info-row__value info-row__value--mono">{{ site.modxVersion }}</span>
                <span v-else class="info-row__value info-row__value--muted">Не установлена</span>
                <button class="info-row__btn info-row__btn--text" @click="openModxUpdateModal" title="Апгрейд версии">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23,4 23,10 17,10" /><path d="M20.49,15a9,9,0,1,1-2.12-9.36L23,10" /></svg>
                  Апгрейд
                </button>
              </div>
            </div>

            <!-- Доктор: отдельный нотис с пояснением (только для MODX) -->
            <div v-if="isModxSite" class="modx-doctor-notice">
              <div class="modx-doctor-notice__body">
                <div class="modx-doctor-notice__title">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                  Доктор
                </div>
                <div class="modx-doctor-notice__hint">
                  Диагностика типовых проблем MODX-сайта: пустой <code>eventMap</code>,
                  чужой владелец на <code>core/cache</code>, забытый <code>setup/</code>
                  и т.п. Чинит найденное по кнопке.
                </div>
              </div>
              <button class="modx-doctor-notice__btn" @click="openModxDoctor">
                Запустить
              </button>
            </div>
          </div>
        </div>

        <!-- 6. Состояние и мониторинг — широкий блок на всю ширину с графиками -->
        <section class="overview-block overview-block--monitor">
          <div class="overview-block__header">
            <h3 class="overview-block__title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-3px;margin-right:0.35rem;color:var(--primary-text);"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
              Состояние и мониторинг
            </h3>
            <button class="btn btn--sm btn--ghost" :disabled="healthLoading" @click="loadSiteHealth">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ spinning: healthLoading }"><polyline points="23,4 23,10 17,10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              Обновить
            </button>
          </div>

          <div class="monitor-grid">
            <div class="kpi-tile" :class="{ 'kpi-tile--ok': healthSummary.reachable, 'kpi-tile--err': !healthSummary.reachable && healthSummary.statusCode !== null }">
              <div class="kpi-tile__label">Доступность</div>
              <div class="kpi-tile__value">
                <span class="kpi-dot" :class="healthSummary.reachable ? 'kpi-dot--ok' : 'kpi-dot--err'"></span>
                {{ healthSummary.reachable ? 'Online' : healthSummary.statusCode !== null ? 'Down' : 'Нет данных' }}
              </div>
              <div class="kpi-tile__meta">HTTP {{ healthSummary.statusCode ?? '—' }}</div>
            </div>
            <div class="kpi-tile">
              <div class="kpi-tile__label">Uptime (24ч)</div>
              <div class="kpi-tile__value">{{ healthSummary.uptimePercent != null ? healthSummary.uptimePercent.toFixed(1) + '%' : '—' }}</div>
              <div class="kpi-tile__meta">{{ healthSummary.pingsCount }} пингов</div>
            </div>
            <div class="kpi-tile">
              <div class="kpi-tile__label">Отклик (ср.)</div>
              <div class="kpi-tile__value">{{ healthSummary.avgResponseMs != null ? Math.round(healthSummary.avgResponseMs) + ' мс' : '—' }}</div>
              <div class="kpi-tile__meta">за последние 24ч</div>
            </div>
            <div class="kpi-tile">
              <div class="kpi-tile__label">CPU</div>
              <div class="kpi-tile__value">{{ siteMetricsLoading ? '…' : siteMetricsData.cpuPercent + '%' }}</div>
              <div class="kpi-bar"><div class="kpi-bar__fill" :style="{ width: Math.min(100, siteMetricsData.cpuPercent) + '%' }"></div></div>
            </div>
            <div class="kpi-tile">
              <div class="kpi-tile__label">Память</div>
              <div class="kpi-tile__value">{{ siteMetricsLoading ? '…' : formatBytes(siteMetricsData.memoryBytes) }}</div>
              <div class="kpi-tile__meta">процессы сайта</div>
            </div>
            <div class="kpi-tile">
              <div class="kpi-tile__label">Запросы</div>
              <div class="kpi-tile__value">{{ siteMetricsLoading ? '…' : siteMetricsData.requestCount.toLocaleString() }}</div>
              <div class="kpi-tile__meta">с момента старта</div>
            </div>
          </div>

          <div class="monitor-chart">
            <div class="monitor-chart__head">
              <div class="monitor-chart__title">Отклик (24ч)</div>
              <div class="monitor-chart__legend">
                <span class="legend-dot legend-dot--ok"></span>Доступен
                <span class="legend-dot legend-dot--err"></span>Недоступен
              </div>
            </div>
            <svg v-if="healthPings.length" class="monitor-chart__svg" viewBox="0 0 600 120" preserveAspectRatio="none">
              <polyline
                class="monitor-chart__line"
                :points="healthChartPoints"
                fill="none"
              />
              <g>
                <circle
                  v-for="(p, idx) in healthChartDots"
                  :key="idx"
                  :cx="p.x"
                  :cy="p.y"
                  :r="2"
                  :class="p.ok ? 'chart-dot chart-dot--ok' : 'chart-dot chart-dot--err'"
                />
              </g>
            </svg>
            <div v-else class="monitor-chart__empty">Пингов пока нет — health-check ещё не прогонялся.</div>
          </div>
        </section>

        <!-- 7. Хранилище — формат как на /storage -->
        <section class="overview-block">
          <div class="overview-block__header">
            <h3 class="overview-block__title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-3px;margin-right:0.35rem;color:var(--primary-text);"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
              Хранилище
            </h3>
          </div>

          <div v-if="storageLoading" class="overview-block__loading">Загрузка…</div>
          <template v-else-if="storageData">
            <div class="storage-grid">
              <div class="storage-stat">
                <div class="storage-stat__label">Всего</div>
                <div class="storage-stat__value">{{ formatBytes(storageData.totalBytes) }}</div>
              </div>
              <div class="storage-stat">
                <div class="storage-stat__label">Файлы сайта (www)</div>
                <div class="storage-stat__value">{{ formatBytes(storageData.wwwBytes) }}</div>
              </div>
              <div class="storage-stat">
                <div class="storage-stat__label">Логи</div>
                <div class="storage-stat__value">{{ formatBytes(storageData.logsBytes) }}</div>
              </div>
              <div class="storage-stat">
                <div class="storage-stat__label">tmp</div>
                <div class="storage-stat__value">{{ formatBytes(storageData.tmpBytes) }}</div>
              </div>
              <div class="storage-stat">
                <div class="storage-stat__label">БД</div>
                <div class="storage-stat__value">{{ formatBytes(storageData.dbBytes) }}</div>
              </div>
            </div>

            <div class="storage-bar">
              <div
                v-for="seg in storageBarSegments"
                :key="seg.label"
                class="storage-bar__seg"
                :style="{ width: seg.percent + '%', background: seg.color }"
                :title="`${seg.label}: ${formatBytes(seg.bytes)} (${seg.percent.toFixed(1)}%)`"
              ></div>
            </div>
            <div class="storage-legend">
              <span v-for="seg in storageBarSegments" :key="seg.label" class="storage-legend__item">
                <span class="storage-legend__dot" :style="{ background: seg.color }"></span>{{ seg.label }}
              </span>
            </div>

            <div v-if="storageTopFiles.length" class="storage-files">
              <div class="storage-files__title">Топ-5 самых крупных файлов</div>
              <div v-for="f in storageTopFiles.slice(0, 5)" :key="f.path" class="storage-file">
                <span class="storage-file__path info-row__value--mono">{{ f.path }}</span>
                <span class="storage-file__size">{{ formatBytes(f.size) }}</span>
              </div>
            </div>
          </template>
          <div v-else class="overview-block__empty">Нет данных о хранилище.</div>
        </section>

        <!-- 8. Активность — audit logs для этого сайта (таймлайн как на /activity) -->
        <section class="overview-block">
          <div class="overview-block__header">
            <h3 class="overview-block__title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-3px;margin-right:0.35rem;color:var(--primary-text);"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
              Активность
            </h3>
            <div class="overview-block__actions">
              <NuxtLink to="/activity" class="btn btn--sm btn--ghost" title="Перейти на полную страницу активности">
                Все события
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
              </NuxtLink>
              <button class="btn btn--sm btn--ghost" :disabled="activityLoading" @click="loadSiteActivity()">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ spinning: activityLoading }"><polyline points="23,4 23,10 17,10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              </button>
            </div>
          </div>
          <div v-if="activityLoading && !activityEntries.length" class="overview-block__loading">Загрузка…</div>
          <div v-else-if="!activityEntries.length" class="overview-block__empty">По этому сайту ещё нет записей.</div>
          <template v-else>
            <div class="timeline">
              <div v-for="(group, gi) in activityGrouped" :key="gi" class="timeline__group">
                <div class="timeline__date">{{ group.label }}</div>
                <div class="timeline__items">
                  <div v-for="entry in group.items" :key="entry.id" class="timeline__item">
                    <div class="timeline__dot" :class="`timeline__dot--${entry.action.toLowerCase()}`" />
                    <div class="timeline__content">
                      <div class="timeline__top">
                        <span class="timeline__badge" :class="`timeline__badge--${entry.action.toLowerCase()}`">
                          {{ activityActionLabel(entry.action) }}
                        </span>
                        <span class="timeline__entity">
                          {{ entry.entity }}{{ entry.entityId ? ` #${entry.entityId.slice(0, 8)}` : '' }}
                        </span>
                      </div>
                      <div class="timeline__meta">
                        <span class="timeline__user">{{ entry.user?.username || 'system' }}</span>
                        <span class="timeline__sep">&middot;</span>
                        <span class="timeline__time">{{ activityFormatTime(entry.createdAt) }}</span>
                        <span v-if="entry.ipAddress" class="timeline__sep">&middot;</span>
                        <span v-if="entry.ipAddress" class="timeline__ip">{{ entry.ipAddress }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div v-if="activityTotalPages > 1" class="activity-pagination">
              <button class="page-btn" :disabled="activityPage <= 1 || activityLoading" @click="goActivityPage(activityPage - 1)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6" /></svg>
              </button>
              <span class="page-info">{{ activityPage }} / {{ activityTotalPages }}</span>
              <button class="page-btn" :disabled="activityPage >= activityTotalPages || activityLoading" @click="goActivityPage(activityPage + 1)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6" /></svg>
              </button>
            </div>
          </template>
        </section>

        <!-- Modal: edit files rel path (web-root внутри homedir).
             Кнопка-триггер «Изменить» лежит в info-card «Основное» этого же
             overview-таба (строка «Папка с веб файлами»). Teleport должен быть
             в одном v-if-блоке с кнопкой, иначе при кликe v-if=false и модалка
             не рендерится. -->
        <Teleport to="body">
          <div v-if="showEditFilesRelPath" class="modal-overlay" @mousedown.self="showEditFilesRelPath = false">
            <div class="domain-modal">
              <div class="domain-modal__header">
                <div class="domain-modal__title-group">
                  <div class="domain-modal__icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                  </div>
                  <div>
                    <h3 class="domain-modal__title">Папка с веб файлами</h3>
                    <p class="domain-modal__subtitle">
                      Сменит <code>root</code> в nginx. PHP-FPM пул и nginx будут перезагружены сразу.
                    </p>
                  </div>
                </div>
                <button class="domain-modal__close" :disabled="savingFilesRelPath" @click="showEditFilesRelPath = false">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              </div>

              <div class="domain-modal__body">
                <div class="domain-modal__swap">
                  <div class="domain-modal__swap-col">
                    <label class="domain-modal__label">Сейчас</label>
                    <div class="domain-modal__chip domain-modal__chip--current">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" /></svg>
                      <code>{{ site?.filesRelPath || 'www' }}</code>
                    </div>
                  </div>
                  <div class="domain-modal__arrow">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
                  </div>
                  <div class="domain-modal__swap-col">
                    <label class="domain-modal__label">Новая папка</label>
                    <div class="domain-modal__input-wrap" :class="{ 'domain-modal__input-wrap--error': !!editFilesRelPathError }">
                      <svg class="domain-modal__input-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                      <input
                        v-model="editFilesRelPathValue"
                        type="text"
                        class="domain-modal__input"
                        placeholder="www/public"
                        :disabled="savingFilesRelPath"
                        autocomplete="off"
                        spellcheck="false"
                        @keyup.enter="saveFilesRelPath"
                      />
                    </div>
                    <span v-if="editFilesRelPathError" class="domain-modal__error">{{ editFilesRelPathError }}</span>
                  </div>
                </div>

                <div class="domain-modal__impact">
                  <div class="domain-modal__impact-title">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                    Что произойдёт
                  </div>
                  <ul class="domain-modal__impact-list">
                    <li>
                      В nginx-конфиге <code>00-server.conf</code> поменяется <code>root</code> на
                      <code>{{ site?.rootPath }}/{{ editFilesRelPathValue.trim() || 'www' }}</code>.
                      Конфиг будет проверен <code>nginx -t</code> и перезагружен.
                    </li>
                    <li v-if="site?.phpVersion">
                      PHP-FPM пул сайта будет пересобран — на случай если в кастомном
                      php-конфиге (<code>php-fpm pool</code>) есть пути с прежней папкой.
                    </li>
                    <li class="domain-modal__impact-danger">
                      <b>Папка на диске НЕ переедет автоматически.</b> Перенеси содержимое сам:
                      <pre class="domain-modal__cmd">sudo -u {{ site?.systemUser }} mkdir -p {{ site?.rootPath }}/{{ editFilesRelPathValue.trim() || 'www' }}
sudo mv {{ site?.rootPath }}/{{ site?.filesRelPath || 'www' }}/* {{ site?.rootPath }}/{{ editFilesRelPathValue.trim() || 'www' }}/</pre>
                      После — проверь права на промежуточные папки (<code>chmod 750</code>),
                      чтобы nginx прошёл по дереву.
                    </li>
                    <li>
                      Если в <code>95-custom.conf</code> есть пути с прежней папкой — обнови их вручную.
                    </li>
                  </ul>
                </div>
              </div>

              <div class="domain-modal__footer">
                <button class="btn btn--ghost" :disabled="savingFilesRelPath" @click="showEditFilesRelPath = false">
                  Отмена
                </button>
                <button
                  class="btn btn--danger"
                  :disabled="savingFilesRelPath || !editFilesRelPathValue.trim() || editFilesRelPathValue.trim() === (site?.filesRelPath || 'www')"
                  @click="saveFilesRelPath"
                >
                  <svg v-if="!savingFilesRelPath" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                  {{ savingFilesRelPath ? 'Применяю...' : 'Сменить папку' }}
                </button>
              </div>
            </div>
          </div>
        </Teleport>
      </div>

      <!-- Tab content: Files -->
      <div v-if="activeTab === 'files'" class="tab-content">
        <!-- Breadcrumb -->
        <div class="fm-bar">
          <div class="fm-breadcrumb">
            <button class="fm-breadcrumb__item" @click="fmNavigate('/')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
            </button>
            <template v-for="(seg, i) in fmBreadcrumbs" :key="i">
              <span class="fm-breadcrumb__sep">/</span>
              <button class="fm-breadcrumb__item" @click="fmNavigate(seg.path)">{{ seg.name }}</button>
            </template>
          </div>
          <div class="fm-bar__actions">
            <button class="fm-bar__btn" title="Загрузить файл" @click="fmTriggerUpload()">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17,8 12,3 7,8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
            </button>
            <input ref="fmUploadInput" type="file" style="display:none" @change="fmUploadFile" />
            <button class="fm-bar__btn" title="Новый файл" @click="fmCreatePrompt('file')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14,2 14,8 20,8" /><line x1="12" y1="18" x2="12" y2="12" /><line x1="9" y1="15" x2="15" y2="15" /></svg>
            </button>
            <button class="fm-bar__btn" title="Новая папка" @click="fmCreatePrompt('directory')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /><line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" /></svg>
            </button>
            <button class="fm-bar__btn" title="Обновить" @click="fmLoad()">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23,4 23,10 17,10" /><path d="M20.49,15a9,9,0,1,1-2.12-9.36L23,10" /></svg>
            </button>
          </div>
        </div>

        <!-- File list -->
        <div v-if="fmLoading" class="fm-loading">
          <div class="fm-loading__spinner" />
        </div>

        <div v-else-if="fmFiles.length === 0" class="fm-empty">
          <span class="fm-empty__text">Пустая директория</span>
        </div>

        <div v-else class="fm-list">
          <div
            v-for="item in fmFiles"
            :key="item.path"
            class="fm-item"
            :class="{ 'fm-item--dir': item.type === 'directory' }"
            @click="item.type === 'directory' ? fmNavigate(item.path) : fmOpenFile(item)"
          >
            <div class="fm-item__icon">
              <svg v-if="item.type === 'directory'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
              <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14,2 14,8 20,8" /></svg>
            </div>
            <span class="fm-item__name">{{ item.name }}</span>
            <span class="fm-item__size mono">{{ item.type === 'directory' ? '—' : fmFormatSize(item.size) }}</span>
            <span class="fm-item__perms mono">{{ item.permissions }}</span>
            <button v-if="item.type !== 'directory'" class="fm-item__action" title="Скачать" :disabled="fmDownloading === item.path" @click.stop="fmDownloadFile(item)">
              <div v-if="fmDownloading === item.path" class="fm-item__spinner" />
              <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7,10 12,15 17,10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
            </button>
            <button class="fm-item__del" title="Удалить" @click.stop="fmDeleteItem(item)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
            </button>
          </div>
        </div>

        <!-- File editor modal -->
        <div v-if="fmEditing" class="fm-editor-overlay" @mousedown.self="fmCloseEditor()">
          <div class="fm-editor">
            <div class="fm-editor__header">
              <span class="fm-editor__path mono">{{ fmEditPath }}</span>
              <div class="fm-editor__actions">
                <button class="fm-editor__save" @click="fmSaveFile()" :disabled="fmSaving">
                  {{ fmSaving ? 'Сохранение...' : 'Сохранить' }}
                </button>
                <button class="fm-editor__close" @click="fmCloseEditor()">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              </div>
            </div>
            <textarea v-model="fmEditContent" class="fm-editor__textarea" spellcheck="false" />
          </div>
        </div>
      </div>

      <!-- Tab content: Logs -->
      <div v-if="activeTab === 'logs'" class="tab-content">
        <div class="logs-bar">
          <div class="logs-bar__types">
            <button
              v-for="lt in logTypes"
              :key="lt.id"
              class="logs-bar__type"
              :class="{ 'logs-bar__type--active': logActiveType === lt.id }"
              @click="logActiveType = lt.id; loadLogs()"
            >
              {{ lt.label }}
            </button>
          </div>
          <div class="logs-bar__actions">
            <button
              class="fm-bar__btn"
              :class="{ 'fm-bar__btn--active': logAutoRefresh }"
              title="Автообновление (каждые 3с)"
              @click="toggleLogAutoRefresh()"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" /><polyline points="12,6 12,12 16,14" /></svg>
              <span v-if="logAutoRefresh" style="font-size:0.65rem;margin-left:2px">Авто</span>
            </button>
            <button class="fm-bar__btn" title="Обновить" @click="loadLogs()">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23,4 23,10 17,10" /><path d="M20.49,15a9,9,0,1,1-2.12-9.36L23,10" /></svg>
            </button>
          </div>
        </div>

        <div v-if="logLoading" class="fm-loading">
          <div class="fm-loading__spinner" />
        </div>

        <div v-else-if="logLines.length === 0" class="fm-empty">
          <span class="fm-empty__text">Нет записей</span>
        </div>

        <pre v-else class="logs-output" ref="logOutput"><code>{{ formattedLogText }}</code></pre>
      </div>

      <!-- Tab content: Databases -->
      <div v-if="activeTab === 'databases'" class="tab-content">
        <SiteDatabasesTab
          :site-id="siteId"
          :site-name="site.name"
          :active="activeTab === 'databases'"
          @changed="reloadSiteAfterDbChange"
        />
      </div>

      <!-- Tab content: SSL -->
      <div v-if="activeTab === 'ssl'" class="tab-content">
        <div class="ssl-section">
          <!-- Current SSL status -->
          <div v-if="site.sslCertificate" class="info-card">
            <h3 class="info-card__title">Текущий сертификат</h3>
            <div class="info-card__rows">
              <div class="info-row">
                <span class="info-row__label">Статус</span>
                <span class="info-row__value" :class="sslClass">{{ sslLabel }}</span>
              </div>
              <div v-if="site.sslCertificate.expiresAt" class="info-row">
                <span class="info-row__label">Истекает</span>
                <span class="info-row__value">{{ formatDate(site.sslCertificate.expiresAt) }}</span>
              </div>
            </div>
            <div v-if="sslCanRevoke" class="ssl-actions">
              <button class="btn btn--danger btn--sm" :disabled="revokingSsl" @click="revokeSsl">
                {{ revokingSsl ? 'Отзыв…' : 'Отозвать сертификат' }}
              </button>
              <span v-if="sslActionError" class="ssl-le__error">{{ sslActionError }}</span>
              <span v-if="sslActionSuccess" class="ssl-le__progress">{{ sslActionSuccess }}</span>
            </div>
          </div>

          <!-- Import existing cert (if present on disk but not in DB) -->
          <div v-if="!sslCanRevoke" class="info-card">
            <h3 class="info-card__title">Подхватить уже выпущенный</h3>
            <p class="ssl-le__desc">Если сертификат для <strong>{{ site.domain }}</strong> уже лежит в <code>/etc/letsencrypt/live/</code> (выпущен вручную или остался с прошлой установки) — можно импортировать его в панель без нового запроса к Let's Encrypt.</p>
            <div class="ssl-le__actions">
              <button class="btn btn--secondary" :disabled="importingSsl" @click="importSsl">
                {{ importingSsl ? 'Проверка…' : 'Импортировать с диска' }}
              </button>
              <span v-if="sslImportError" class="ssl-le__error">{{ sslImportError }}</span>
            </div>
          </div>

          <!-- Let's Encrypt -->
          <div class="info-card">
            <h3 class="info-card__title">
              <template v-if="sslCanRevoke">Перевыпуск сертификата</template>
              <template v-else>Let's Encrypt</template>
            </h3>

            <!-- Алерт прямо в карточке: серт есть, но SAN не совпадает с текущим списком доменов -->
            <div
              v-if="sslCanRevoke && (missingAliasesInCert.length || mainDomainMissingInCert)"
              class="domains-cert-alert ssl-le__mismatch"
            >
              <div class="domains-cert-alert__icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <div class="domains-cert-alert__body">
                <strong>SAN не совпадает с текущим списком доменов</strong>
                <span v-if="mainDomainMissingInCert">
                  Основной домен <code>{{ site.domain }}</code> отсутствует в SAN.
                </span>
                <span v-if="missingAliasesInCert.length">
                  Не покрыт{{ missingAliasesInCert.length > 1 ? 'ы' : '' }}:
                  <template v-for="(d, i) in missingAliasesInCert" :key="d"><code>{{ d }}</code><span v-if="i < missingAliasesInCert.length - 1">, </span></template>
                </span>
                <span>Нажми «Перевыпустить» — новый серт будет выпущен с актуальным SAN.</span>
              </div>
            </div>

            <p v-if="sslCanRevoke" class="ssl-le__desc">
              Текущий сертификат будет заменён: certbot переиздаст его с актуальным списком доменов (<strong>{{ site.domain }}</strong><template v-if="sslAliasesCount"> + {{ sslAliasesCount }} алиас{{ sslAliasesCount === 1 ? '' : (sslAliasesCount < 5 ? 'а' : 'ов') }}</template>). Используется <code>--expand</code>, revoke старой версии не нужен.
            </p>
            <p v-else class="ssl-le__desc">
              Выпустить бесплатный SSL-сертификат для <strong>{{ site.domain }}</strong><template v-if="sslAliasesCount"> и {{ sslAliasesCount }} алиас{{ sslAliasesCount === 1 ? '' : (sslAliasesCount < 5 ? 'а' : 'ов') }}</template>. В SAN включаются все алиасы (в т. ч. redirect — иначе TLS-handshake падает на cert-mismatch до 301).
            </p>

            <div class="ssl-le__actions">
              <button
                class="btn btn--primary"
                :disabled="issuingSsl"
                @click="issueLetsEncrypt"
              >
                <svg v-if="!issuingSsl && !sslCanRevoke" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                <svg v-else-if="!issuingSsl && sslCanRevoke" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
                {{ issuingSsl ? (sslCanRevoke ? 'Перевыпуск...' : 'Выпуск...') : (sslCanRevoke ? 'Перевыпустить сертификат' : 'Выпустить сертификат') }}
              </button>
              <span v-if="sslProgress" class="ssl-le__progress">
                {{ sslProgress }}
                <span v-if="issuingSsl" class="ssl-le__elapsed">({{ sslElapsed }}с)</span>
              </span>
              <span v-if="sslIssueError" class="ssl-le__error">{{ sslIssueError }}</span>
            </div>
          </div>

          <!-- Upload custom certificate -->
          <div class="ssl-upload">
            <h3 class="ssl-upload__title">Загрузка сертификата</h3>
            <p class="ssl-upload__desc">Вставьте PEM-кодированный сертификат, приватный ключ и цепочку (опционально).</p>
            <div class="ssl-upload__fields">
              <div class="form-group">
                <label class="form-label">Сертификат (PEM)</label>
                <textarea v-model="sslCertPem" class="ssl-textarea" placeholder="-----BEGIN CERTIFICATE-----" spellcheck="false" />
              </div>
              <div class="form-group">
                <label class="form-label">Приватный ключ (PEM)</label>
                <textarea v-model="sslKeyPem" class="ssl-textarea" placeholder="-----BEGIN PRIVATE KEY-----" spellcheck="false" />
              </div>
              <div class="form-group">
                <label class="form-label">Цепочка (PEM, опционально)</label>
                <textarea v-model="sslChainPem" class="ssl-textarea ssl-textarea--sm" placeholder="-----BEGIN CERTIFICATE-----" spellcheck="false" />
              </div>
            </div>
            <div class="ssl-upload__actions">
              <button
                class="btn btn--primary"
                :disabled="!sslCertPem.trim() || !sslKeyPem.trim() || uploadingSsl"
                @click="uploadSsl"
              >
                {{ uploadingSsl ? 'Загрузка...' : 'Загрузить сертификат' }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Tab content: DNS -->
      <div v-if="activeTab === 'dns'" class="tab-content">
        <SiteDnsTab :site-id="siteId" :active="activeTab === 'dns'" />
      </div>

      <!-- Tab content: Domains -->
      <div v-if="activeTab === 'domains'" class="tab-content">
        <div class="domains-section">
          <!-- Алерт: у сайта есть сертификат, но часть доменов им не покрыта -->
          <div
            v-if="hasActiveCert && (missingAliasesInCert.length || mainDomainMissingInCert)"
            class="domains-cert-alert"
          >
            <div class="domains-cert-alert__icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </div>
            <div class="domains-cert-alert__body">
              <strong>Часть доменов не покрыта SSL-сертификатом</strong>
              <span v-if="mainDomainMissingInCert">
                Основной домен <code>{{ site.domain }}</code> отсутствует в SAN — перевыпусти серт.
              </span>
              <span v-if="missingAliasesInCert.length">
                Алиас{{ missingAliasesInCert.length > 1 ? 'ы' : '' }}
                <code v-for="(d, i) in missingAliasesInCert" :key="d">{{ d }}<span v-if="i < missingAliasesInCert.length - 1">, </span></code>
                не в сертификате. Перевыпусти SSL во вкладке «Overview» → «SSL-сертификат».
              </span>
            </div>
          </div>

          <div class="info-card">
            <h3 class="info-card__title">Основной домен</h3>
            <div class="info-card__rows">
              <div class="info-row">
                <span class="domain-with-cert">
                  <span
                    v-if="coverageFor(site.domain) !== 'no-cert'"
                    class="cert-badge"
                    :class="`cert-badge--${coverageFor(site.domain)}`"
                    :title="coverageFor(site.domain) === 'covered' ? 'Домен покрыт SSL-сертификатом' : 'Домена нет в SAN сертификата — перевыпусти SSL'"
                  >
                    <svg v-if="coverageFor(site.domain) === 'covered'" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                    <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </span>
                  <span class="info-row__value info-row__value--mono">{{ site.domain }}</span>
                </span>
                <button class="info-row__btn info-row__btn--inline" :disabled="savingDomains" @click="openEditMainDomain">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                  <span>Изменить</span>
                </button>
              </div>
            </div>
          </div>

          <div class="info-card">
            <div class="domains-header">
              <h3 class="info-card__title">Алиасы</h3>
              <span class="domains-hint">Тугл = редирект на основной домен</span>
            </div>
            <div v-if="domainAliases.length" class="domains-list">
              <div v-for="(alias, idx) in domainAliases" :key="alias.domain + idx" class="domain-item">
                <span
                  v-if="coverageFor(alias.domain) !== 'no-cert'"
                  class="cert-badge"
                  :class="`cert-badge--${coverageFor(alias.domain)}`"
                  :title="
                    coverageFor(alias.domain) === 'covered' ? 'Алиас покрыт SSL-сертификатом' :
                    'Алиас не в сертификате — перевыпусти SSL, чтобы добавить его в SAN (redirect-алиасы тоже должны быть в SAN, иначе TLS-handshake падает до 301)'
                  "
                >
                  <svg v-if="coverageFor(alias.domain) === 'covered'" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                  <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </span>
                <span class="domain-item__name">{{ alias.domain }}</span>
                <label class="domain-item__toggle" :title="alias.redirect ? 'Редирект на основной домен (301)' : 'Алиас отдаёт сайт (200)'">
                  <input
                    type="checkbox"
                    :checked="alias.redirect"
                    :disabled="savingDomains"
                    @change="toggleAliasRedirect(idx)"
                  />
                  <span class="domain-item__toggle-slider" />
                  <span class="domain-item__toggle-label">{{ alias.redirect ? '301' : '200' }}</span>
                </label>
                <button class="domain-item__remove" title="Удалить алиас" :disabled="savingDomains" @click="removeAlias(idx)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              </div>
            </div>
            <div v-else class="domains-empty">Алиасы не настроены</div>

            <div class="domains-add">
              <input
                v-model="newAlias"
                type="text"
                class="domains-add__input"
                placeholder="alias.example.com"
                @keyup.enter="addAlias"
              />
              <button class="btn btn--primary domains-add__btn" :disabled="!newAlias.trim() || savingDomains" @click="addAlias">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                Добавить алиас
              </button>
            </div>
          </div>
        </div>

        <!-- Modal: edit main domain -->
        <Teleport to="body">
          <div v-if="showEditMainDomain" class="modal-overlay" @mousedown.self="showEditMainDomain = false">
            <div class="domain-modal">
              <div class="domain-modal__header">
                <div class="domain-modal__title-group">
                  <div class="domain-modal__icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                      <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                    </svg>
                  </div>
                  <div>
                    <h3 class="domain-modal__title">Смена главного домена</h3>
                    <p class="domain-modal__subtitle">Изменит <code>server_name</code> в nginx и сбросит SSL</p>
                  </div>
                </div>
                <button class="domain-modal__close" :disabled="savingMainDomain" @click="showEditMainDomain = false">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              </div>

              <div class="domain-modal__body">
                <div class="domain-modal__swap">
                  <div class="domain-modal__swap-col">
                    <label class="domain-modal__label">Сейчас</label>
                    <div class="domain-modal__chip domain-modal__chip--current">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" /></svg>
                      <code>{{ site?.domain }}</code>
                    </div>
                  </div>
                  <div class="domain-modal__arrow">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
                  </div>
                  <div class="domain-modal__swap-col">
                    <label class="domain-modal__label">Новый домен</label>
                    <div class="domain-modal__input-wrap" :class="{ 'domain-modal__input-wrap--error': !!editMainDomainError }">
                      <svg class="domain-modal__input-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                      <input
                        v-model="editMainDomainValue"
                        type="text"
                        class="domain-modal__input"
                        placeholder="new.example.com"
                        :disabled="savingMainDomain"
                        autocomplete="off"
                        spellcheck="false"
                        @keyup.enter="saveMainDomain"
                      />
                    </div>
                    <span v-if="editMainDomainError" class="domain-modal__error">{{ editMainDomainError }}</span>
                  </div>
                </div>

                <div class="domain-modal__impact">
                  <div class="domain-modal__impact-title">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                    Что произойдёт
                  </div>
                  <ul class="domain-modal__impact-list">
                    <li>
                      В nginx-конфиге обновится <code>server_name</code> на <code>{{ editMainDomainValue.trim() || 'new.example.com' }}</code>.
                      Файл конфига якорится на имени сайта (<code>{{ site?.name }}.conf</code>) и не переименовывается.
                    </li>
                    <li v-if="site?.phpVersion">
                      PHP-FPM pool <b>не трогается</b> — имя сокета и pool зависят от сайта, а не от домена.
                    </li>
                    <li v-if="site?.sslCertificate && site.sslCertificate.status && site.sslCertificate.status !== 'NONE'" class="domain-modal__impact-danger">
                      <b>SSL сбросится в статус «Нет»</b> — старый серт выпущен на <code>{{ site?.domain }}</code>, для нового домена невалиден.
                      Файлы в <code>/etc/letsencrypt/live/</code> остаются (на случай отката), но панель перестаёт считать их активными.
                      После смены — выпусти новый серт кнопкой «Выпустить SSL».
                    </li>
                    <li>
                      <b>DNS</b> нового домена должен уже указывать на этот сервер, иначе сайт станет недоступен (и выпуск SSL потом обломается).
                    </li>
                    <li>
                      Ссылки в админке/БД сайта (<code>site_url</code>, MODX <code>system_settings</code>, хардкод в контенте) панель <b>не трогает</b> — правь руками.
                    </li>
                  </ul>
                </div>
              </div>

              <div class="domain-modal__footer">
                <button class="btn btn--ghost" :disabled="savingMainDomain" @click="showEditMainDomain = false">
                  Отмена
                </button>
                <button
                  class="btn btn--danger"
                  :disabled="savingMainDomain || !editMainDomainValue.trim() || editMainDomainValue.trim() === site?.domain"
                  @click="saveMainDomain"
                >
                  <svg v-if="!savingMainDomain" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                  {{ savingMainDomain ? 'Применяю...' : 'Сменить домен' }}
                </button>
              </div>
            </div>
          </div>
        </Teleport>
      </div>

      <!-- Tab content: Backups -->
      <div v-if="activeTab === 'backups'" class="tab-content">
        <div class="backups-toolbar">
          <span class="backups-toolbar__count">{{ siteBackups.length }} бэкап{{ siteBackups.length === 1 ? '' : (siteBackups.length >= 2 && siteBackups.length <= 4 ? 'а' : 'ов') }}</span>
          <div class="backups-toolbar__actions">
            <button class="btn btn--ghost btn--sm" @click="openSnapshotPicker">Снапшоты в репе…</button>
            <button class="btn btn--ghost btn--sm" @click="openResticCheckDialog">Проверки Restic…</button>
            <button class="btn btn--primary btn--sm" @click="openSiteBackupDialog">+ Создать бэкап</button>
          </div>
        </div>
        <p class="backups-note">
          Ниже — <b>все</b> бэкапы этого сайта: и автоматические (по расписанию из раздела «Бэкапы» → «Расписание»),
          и запущенные вручную. Для авто-бэкапов в конфигурации Restic устаревшие снапшоты вычищаются автоматически по retention-политике.
        </p>

        <!-- Per-site дефолты для бэкапов — применяются ко всем бэкапам этого сайта -->
        <details class="site-excludes" :open="siteExcludesEditing">
          <summary class="site-excludes__summary">
            <div class="site-excludes__head">
              <svg class="site-excludes__chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"/></svg>
              <span class="site-excludes__title-text">Исключения по умолчанию (для этого сайта)</span>
              <div class="site-excludes__counters">
                <span v-if="siteExcludesList.length > 0" class="site-excludes__badge" title="Путей в excludes">
                  📁 {{ siteExcludesList.length }}
                </span>
                <span v-if="siteExcludeTablesList.length > 0" class="site-excludes__badge site-excludes__badge--alt" title="Таблиц без данных">
                  🗄 {{ siteExcludeTablesList.length }}
                </span>
              </div>
            </div>
          </summary>

          <div class="site-excludes__body">
            <div class="site-excludes__field">
              <label class="site-excludes__label">Исключаемые пути файлов</label>
              <p class="site-excludes__hint">
                Применяются и к ручным, и к авто-бэкапам этого сайта. Пусто — fallback на глобальные.
                Пути <b>относительны корня сайта</b> (<code>{{ site?.rootPath || '' }}</code>).
                Один путь на строке. Glob (<code>*</code>, <code>**</code>) работает. <code>#</code> в начале — комментарий.
              </p>
              <textarea
                v-model="siteExcludesText"
                class="site-excludes__textarea"
                rows="8"
                spellcheck="false"
                placeholder="www/core/cache&#10;tmp&#10;www/wp-content/cache&#10;# любую строку с # игнорируем"
              />
            </div>

            <div class="site-excludes__field">
              <label class="site-excludes__label">Таблицы БД без данных (только структура)</label>
              <p class="site-excludes__hint">
                Имена таблиц по одной на строке. В дамп попадёт <code>CREATE TABLE</code>, но без <code>INSERT</code>.
                Используй для тяжёлых таблиц-кешей: <code>modx_session</code>, <code>modx_manager_log</code>, <code>wp_options</code> и т.п.
                Пусто — fallback на глобальные из раздела «Бэкапы».
              </p>
              <textarea
                v-model="siteExcludeTablesText"
                class="site-excludes__textarea"
                rows="6"
                spellcheck="false"
                placeholder="modx_session&#10;modx_manager_log&#10;modx_event_log"
              />
            </div>

            <div class="site-excludes__actions">
              <button class="btn btn--ghost btn--sm" type="button" @click="resetSiteExcludesToRecommended">Рекомендуемые для типа</button>
              <span class="site-excludes__sep" />
              <button class="btn btn--primary btn--sm" :disabled="savingSiteExcludes" @click="saveSiteExcludes">
                {{ savingSiteExcludes ? 'Сохраняю…' : 'Сохранить' }}
              </button>
            </div>
          </div>
        </details>
        <div v-if="restoringBackup && restoreProgress !== null" class="restore-banner">
          <div class="restore-banner__text">Восстановление из бэкапа...</div>
          <div class="backup-progress">
            <div class="backup-progress__fill" :style="{ width: `${restoreProgress}%` }" />
            <span class="backup-progress__label">{{ restoreProgress }}%</span>
          </div>
        </div>
        <div v-if="restoreError" class="restore-banner restore-banner--error">
          <span>{{ restoreError }}</span>
          <button class="btn-icon" @click="restoreError = ''">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <div v-if="siteBackupsLoading" class="fm-loading"><div class="fm-loading__spinner" /></div>
        <div v-else-if="!siteBackups.length" class="fm-empty">
          <span class="fm-empty__text">Бэкапов пока нет</span>
        </div>
        <div v-else class="backup-list">
          <div v-for="b in siteBackups" :key="b.id" class="backup-item">
            <div class="backup-item__icon" :class="`backup-item__icon--${(b.status || '').toLowerCase()}`">
              <svg v-if="b.status === 'COMPLETED'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20,6 9,17 4,12" /></svg>
              <svg v-else-if="b.status === 'FAILED'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              <div v-else-if="b.status === 'IN_PROGRESS'" class="backup-spinner" />
              <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" /><polyline points="12,6 12,12 16,14" /></svg>
            </div>
            <div class="backup-item__info">
              <div class="backup-item__top">
                <span class="backup-item__type">
                  {{ backupTypeLabel(b.type || 'FULL') }}
                  <span v-if="b.type === 'DIFFERENTIAL' && !b.baseBackupId" class="backup-item__orphan" title="Базовый бэкап удалён — восстановление невозможно">!</span>
                </span>
                <span v-if="b.engine" class="backup-item__badge">{{ b.engine === 'RESTIC' ? 'Restic' : 'TAR' }}</span>
                <span class="backup-item__badge backup-item__badge--storage">{{ b.storageLocation?.name || backupStorageLabel(b.storageType) }}</span>
              </div>
              <span class="backup-item__meta">{{ formatBackupDate(b.createdAt) }} &middot; {{ formatBackupSize(b.sizeBytes) }}</span>
              <div v-if="b.status === 'IN_PROGRESS' || b.status === 'PENDING'" class="backup-progress">
                <div class="backup-progress__fill" :style="{ width: `${backupLiveProgress[b.id] ?? b.progress ?? 0}%` }" />
                <span class="backup-progress__label">{{ backupLiveProgress[b.id] ?? b.progress ?? 0 }}%</span>
              </div>
              <span v-if="b.status === 'FAILED' && b.errorMessage" class="backup-item__error">{{ b.errorMessage }}</span>
            </div>
            <span class="backup-item__status" :class="`backup-item__status--${(b.status || '').toLowerCase()}`">{{ backupStatusLabel(b.status) }}</span>
            <div class="backup-item__actions">
              <button v-if="b.status === 'COMPLETED'" class="btn-icon" title="Скачать бэкап" :disabled="!!backupDownloading[b.id]" @click="onClickDownloadBackup(b)">
                <svg v-if="!backupDownloading[b.id]" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7,10 12,15 17,10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                <span v-else class="btn-icon__progress">{{ backupDownloading[b.id] }}%</span>
              </button>
              <button v-if="b.status === 'COMPLETED' && !(b.type === 'DIFFERENTIAL' && !b.baseBackupId)" class="btn btn--sm btn--ghost" :disabled="restoringBackup" title="Восстановить" @click="restoringSiteBackup = b; showSiteRestoreModal = true">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1,4 1,10 7,10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
                Восстановить
              </button>
              <button v-if="b.status === 'COMPLETED' && b.engine === 'RESTIC' && b.resticSnapshotId" class="btn btn--sm btn--ghost" title="Сравнить с другим бэкапом или текущими файлами" @click="openBackupCompare(b)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 3v18M3 9h12M21 9l-6 6 6 6"/></svg>
                Сравнить
              </button>
              <button v-if="b.status === 'COMPLETED' || b.status === 'FAILED'" class="btn-icon btn-icon--danger" title="Удалить бэкап" @click="deleteSiteBackup(b.id)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Tab content: Cron Jobs -->
      <div v-if="activeTab === 'cron'" class="tab-content">
        <div class="backups-toolbar">
          <span class="backups-toolbar__count">{{ cronJobs.length }} задач{{ cronJobs.length === 1 ? 'а' : (cronJobs.length >= 2 && cronJobs.length <= 4 ? 'и' : '') }}</span>
          <button class="btn btn--primary btn--sm" @click="openCronEditor()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            Добавить
          </button>
        </div>
        <div v-if="cronLoading" class="fm-loading"><div class="fm-loading__spinner" /></div>
        <div v-else-if="!cronJobs.length" class="fm-empty">
          <span class="fm-empty__text">Крон-задач пока нет</span>
        </div>
        <div v-else class="cron-job-list">
          <div v-for="cj in cronJobs" :key="cj.id" class="cron-job-card" :class="{ 'cron-job-card--disabled': cj.status !== 'ACTIVE' }">
            <div class="cron-job-card__main">
              <div class="cron-job-card__toggle">
                <button class="cron-toggle" :class="{ 'cron-toggle--on': cj.status === 'ACTIVE' }" :title="cj.status === 'ACTIVE' ? 'Выключить' : 'Включить'" @click="toggleCronJob(cj.id)">
                  <span class="cron-toggle__knob" />
                </button>
              </div>
              <div class="cron-job-card__info">
                <span class="cron-job-card__name">{{ cj.name }}</span>
                <code class="cron-job-card__command">{{ cj.command }}</code>
              </div>
              <div class="cron-job-card__schedule">
                <span class="cron-job-card__schedule-label">{{ describeCronSchedule(cj.schedule) }}</span>
                <code class="cron-job-card__schedule-cron">{{ cj.schedule }}</code>
              </div>
              <div class="cron-job-card__actions">
                <button v-if="cj.lastRunAt" class="cron-row-action" title="Последний запуск" @click="expandedCronId = expandedCronId === cj.id ? '' : cj.id">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" /><polyline points="12,6 12,12 16,14" /></svg>
                </button>
                <button class="cron-row-action" title="Редактировать" @click="openCronEditor(cj)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
                </button>
                <button class="cron-row-action cron-row-action--red" title="Удалить" @click="deleteCronJob(cj.id)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                </button>
              </div>
            </div>
            <div v-if="expandedCronId === cj.id && cj.lastRunAt" class="cron-job-card__log">
              <div class="cron-job-card__log-header">
                <span class="cron-job-card__log-label">Последний запуск: {{ formatCronDate(cj.lastRunAt) }}</span>
                <span class="cron-job-card__log-exit" :class="{ 'cron-job-card__log-exit--ok': cj.lastExitCode === 0, 'cron-job-card__log-exit--fail': cj.lastExitCode != null && cj.lastExitCode !== 0 }">
                  Exit {{ cj.lastExitCode ?? '?' }}
                </span>
              </div>
              <pre v-if="cj.lastOutput" class="cron-job-card__log-output">{{ cj.lastOutput }}</pre>
              <span v-else class="cron-job-card__log-empty">Нет вывода</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Cron Job Create/Edit Modal -->
      <Teleport to="body">
        <div v-if="showCronModal" class="modal-overlay" @mousedown.self="closeCronModal">
          <div class="modal">
            <h3 class="modal__title">{{ editingCronJob ? 'Редактирование крон-задачи' : 'Новая крон-задача' }}</h3>
            <div class="cron-form">
              <input v-model="cronForm.name" class="form-input" placeholder="Название" maxlength="128" />
              <div class="cron-form__schedule">
                <input v-model="cronForm.schedule" class="form-input form-input--mono" placeholder="*/5 * * * *" maxlength="64" />
                <div class="cron-form__presets">
                  <button v-for="p in cronPresets" :key="p.value" class="cron-form__preset" :class="{ 'cron-form__preset--active': cronForm.schedule === p.value }" @click="cronForm.schedule = p.value">{{ p.label }}</button>
                </div>
              </div>
              <textarea v-model="cronForm.command" class="form-input form-input--mono cron-form__command" placeholder="Команда для выполнения" maxlength="1024" rows="3" />
            </div>
            <div v-if="cronError" class="modal__error">{{ cronError }}</div>
            <div class="modal__actions">
              <button class="btn btn--ghost" @click="closeCronModal">Отмена</button>
              <button class="btn btn--primary" :disabled="creatingCron || !cronForm.name.trim() || !cronForm.schedule.trim() || !cronForm.command.trim()" @click="saveCronJob">
                {{ creatingCron ? (editingCronJob ? 'Сохранение...' : 'Создание...') : (editingCronJob ? 'Сохранить' : 'Создать') }}
              </button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- Create Backup Modal (engine + type + storage) -->
      <Teleport to="body">
        <div v-if="siteBackupDialog.open" class="modal-overlay" @mousedown.self="siteBackupDialog.open = false">
          <div class="modal">
            <h3 class="modal__title">Создать бэкап</h3>
            <div class="modal__fields">
              <div class="form-group">
                <label class="form-label">Движок</label>
                <select v-model="siteBackupDialog.form.engine" class="form-input form-input--select">
                  <option value="RESTIC">Restic (дедупликация)</option>
                  <option value="TAR">TAR (обычный архив)</option>
                </select>
                <p class="form-hint" style="margin-top:0.35rem;color:var(--text-muted);font-size:0.75rem;line-height:1.4;">
                  <template v-if="siteBackupDialog.form.engine === 'RESTIC'">
                    Restic всегда создаёт «снапшот», но физически заливает только изменившиеся чанки —
                    это и заменяет инкрементальные/дифференциальные бэкапы, и при этом каждый снапшот самодостаточен.
                  </template>
                  <template v-else>
                    TAR — обычный архив .tar.gz. Инкрементальных/дифференциальных не делает, всегда создаётся полный архив
                    по выбранному ниже типу содержимого.
                  </template>
                </p>
              </div>
              <div class="form-group">
                <label class="form-label">Что бэкапим</label>
                <select v-model="siteBackupDialog.form.type" class="form-input form-input--select">
                  <option value="FULL">Полный (файлы + БД)</option>
                  <option value="FILES_ONLY">Только файлы</option>
                  <option value="DB_ONLY">Только БД</option>
                </select>
                <p class="form-hint" style="margin-top:0.35rem;color:var(--text-muted);font-size:0.75rem;">
                  Это выбор <b>содержимого</b> бэкапа, а не «полный/инкрементальный».
                </p>
              </div>
              <div class="form-group">
                <label class="form-label">Хранилище</label>
                <select v-model="siteBackupDialog.form.storageLocationId" class="form-input form-input--select">
                  <option value="">— выбери —</option>
                  <option
                    v-for="loc in siteStorageLocations"
                    :key="loc.id"
                    :value="loc.id"
                    :disabled="siteBackupDialog.form.engine === 'RESTIC' && !loc.resticEnabled"
                  >
                    {{ loc.name }} ({{ loc.type }}){{ siteBackupDialog.form.engine === 'RESTIC' && !loc.resticEnabled ? ' — не поддерживает Restic' : '' }}
                  </option>
                </select>
                <p v-if="siteStorageLocations.length === 0" style="font-size:0.85rem;color:var(--text-tertiary);margin-top:0.25rem;">
                  Хранилищ нет. Добавь в разделе «Бэкапы» (глобальная секция).
                </p>
              </div>
              <div
                class="form-group"
                v-if="backupTypeIncludesDb && siteHasDatabases"
              >
                <label class="form-label">Какие БД бэкапим</label>
                <div class="db-pick">
                  <div class="db-pick__head">
                    <span class="db-pick__count">
                      Выбрано {{ siteBackupDialog.form.databaseIds.length }}
                      из {{ site?.databases?.length || 0 }}
                    </span>
                    <div class="db-pick__head-actions">
                      <button
                        class="btn btn--ghost btn--xs"
                        type="button"
                        @click="selectAllBackupDbs(true)"
                      >Все</button>
                      <button
                        class="btn btn--ghost btn--xs"
                        type="button"
                        @click="selectAllBackupDbs(false)"
                      >Снять</button>
                    </div>
                  </div>
                  <label
                    v-for="db in site?.databases || []"
                    :key="db.id"
                    class="db-pick__item"
                  >
                    <input
                      type="checkbox"
                      :checked="siteBackupDialog.form.databaseIds.includes(db.id)"
                      @change="toggleBackupDb(db.id)"
                    />
                    <span class="db-pick__name">{{ db.name }}</span>
                    <span class="db-pick__type">{{ db.type === 'POSTGRESQL' ? 'PostgreSQL' : 'MySQL / MariaDB' }}</span>
                  </label>
                </div>
                <p
                  v-if="siteBackupDialog.form.type === 'DB_ONLY' && siteBackupDialog.form.databaseIds.length === 0"
                  class="form-hint"
                  style="color: #f87171;"
                >Для DB_ONLY нужно выбрать минимум одну БД.</p>
              </div>

              <div class="form-group" v-if="siteBackupDialog.form.type !== 'DB_ONLY'">
                <label class="form-label">Исключить пути</label>
                <textarea
                  v-model="siteBackupDialog.form.excludesText"
                  class="form-input"
                  rows="6"
                  style="font-family: 'JetBrains Mono', monospace; font-size: 0.78rem;"
                  placeholder="Один путь на строке, относительно корня сайта"
                />
                <p class="form-hint" style="margin-top:0.35rem;color:var(--text-muted);font-size:0.72rem;line-height:1.45;">
                  Пути <b>относительны корня сайта</b> ({{ site?.rootPath || '/var/www/&lt;name&gt;' }}). Один путь на строке, glob-шаблоны работают (<code>*.log</code>, <code>**/cache</code>).
                  Строки с <code>#</code> — игнор.
                  <br>Дефолты — из настроек сайта (вкладка «Бэкапы»), либо из глобальных. Можешь править перед запуском.
                </p>
              </div>
            </div>
            <div class="modal__actions">
              <button class="btn btn--ghost" @click="siteBackupDialog.open = false">Отмена</button>
              <button
                class="btn btn--primary"
                :disabled="
                  triggeringBackup
                  || !siteBackupDialog.form.storageLocationId
                  || (siteBackupDialog.form.type === 'DB_ONLY' && siteBackupDialog.form.databaseIds.length === 0)
                "
                @click="triggerSiteBackup"
              >
                {{ triggeringBackup ? 'Запуск...' : 'Запустить' }}
              </button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- Export Backup (download) Modal -->
      <Teleport to="body">
        <div v-if="exportDialog.open" class="modal-overlay" @mousedown.self="exportDialog.open = false">
          <div class="modal modal--wide">
            <h3 class="modal__title">Скачать бэкап</h3>
            <p class="modal__text">
              Restic-бэкап нельзя скачать как файл напрямую — он хранится в виде дедуплицированных
              чанков. Здесь мы создаём <b>экспорт в .tar</b>, который можно скачать. Старые экспорты
              автоматически чистятся по истечении срока.
            </p>

            <div v-if="exportDialog.targetBackup?.engine !== 'RESTIC'" class="exp-warn">
              Этот бэкап — TAR (не Restic). Скачивание идёт обычным методом, экспорт не нужен.
            </div>

            <template v-else>
              <!-- Mode -->
              <div class="restore-scope">
                <span class="restore-scope__label">Режим скачивания</span>
                <label class="restore-scope__opt">
                  <input type="radio" v-model="exportDialog.form.mode" value="STREAM" />
                  <span>
                    <b>Прямой стрим через панель</b>
                    <span class="exp-mode-hint">restic dump → HTTP response. Без записи на диск VPS, без сокетов.</span>
                  </span>
                </label>
                <label
                  class="restore-scope__opt"
                  :class="{ 'restore-scope__opt--disabled': !exportDialog.s3Available }"
                >
                  <input
                    type="radio"
                    v-model="exportDialog.form.mode"
                    value="S3_PRESIGNED"
                    :disabled="!exportDialog.s3Available"
                  />
                  <span>
                    <b>S3 pre-signed ссылка</b>
                    <span class="exp-mode-hint">
                      <template v-if="exportDialog.s3Available">
                        Агент дампит в этот же S3-bucket → ты получаешь временную ссылку и качаешь напрямую из S3, минуя VPS.
                      </template>
                      <template v-else>
                        Доступно только если бэкап лежит на S3-хранилище. Сейчас бэкап на: {{ exportDialog.targetBackup?.storageLocation?.type || '—' }}
                      </template>
                    </span>
                  </span>
                </label>
              </div>

              <!-- TTL -->
              <div class="form-group">
                <label class="form-label">Срок жизни ссылки (часов)</label>
                <input
                  v-model.number="exportDialog.form.ttlHours"
                  type="number"
                  class="form-input"
                  min="1"
                  max="720"
                />
                <p class="form-hint">
                  По умолчанию — 7 часов. Минимум 1, максимум 720 (30 дней).
                  После истечения экспорт чистится автоматически (для S3 удаляется объект из bucket'а, для STREAM просто протухает запись).
                </p>
              </div>

              <!-- Existing exports -->
              <div v-if="exportDialog.list.length > 0" class="exp-list">
                <div class="exp-list__head">Уже созданные экспорты</div>
                <div v-for="ex in exportDialog.list" :key="ex.id" class="exp-list__item">
                  <div class="exp-list__main">
                    <div class="exp-list__row">
                      <span class="exp-list__mode">{{ ex.mode === 'STREAM' ? 'STREAM' : 'S3' }}</span>
                      <span class="exp-list__status" :class="`exp-list__status--${ex.status.toLowerCase()}`">{{ ex.status }}</span>
                      <span class="exp-list__expires">до {{ formatBackupDate(ex.expiresAt) }}</span>
                      <button
                        v-if="ex.status === 'READY' && ex.downloadUrl"
                        class="btn btn--xs btn--primary"
                        type="button"
                        @click="downloadExportRow(ex)"
                      >Скачать</button>
                      <button
                        v-else-if="ex.status === 'PROCESSING' || ex.status === 'PENDING'"
                        class="btn btn--xs btn--ghost"
                        type="button"
                        disabled
                      >
                        <span class="backup-spinner" style="display:inline-block;vertical-align:middle;margin-right:6px;width:12px;height:12px;border-width:2px;" />
                        Готовится…
                      </button>
                      <button
                        v-else-if="ex.status === 'FAILED'"
                        class="btn btn--xs btn--ghost"
                        type="button"
                        :title="ex.errorMessage || ''"
                        disabled
                      >Ошибка</button>
                      <button class="btn-icon btn-icon--danger" type="button" title="Удалить экспорт" @click="deleteExportRow(ex.id)">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
                      </button>
                    </div>
                    <!-- Прогресс активного экспорта -->
                    <div v-if="(ex.status === 'PROCESSING' || ex.status === 'PENDING')" class="exp-list__progress">
                      <div class="backup-progress" style="margin-top:0.4rem;">
                        <!--
                          Полная "длина" заранее неизвестна (restic dump не знает финальный размер
                          архива). Делаем indeterminate-стиль: бегущая полоса всегда заполнена,
                          анимация снизу. Если в будущем добавим оценку — поменяем на width.
                        -->
                        <div class="backup-progress__fill backup-progress__fill--indeterminate" />
                      </div>
                      <div class="exp-list__progress-text">
                        <span v-if="ex.progressBytesUploaded != null">
                          Загружено: {{ formatExportBytes(ex.progressBytesUploaded) }}
                        </span>
                        <span v-if="ex.progressBytesRead != null" style="margin-left:0.6rem;">
                          Прочитано: {{ formatExportBytes(ex.progressBytesRead) }}
                        </span>
                        <span v-if="ex.progressElapsedMs != null" style="margin-left:0.6rem;">
                          {{ formatExportElapsed(ex.progressElapsedMs) }}
                        </span>
                        <span v-if="ex.progressBytesRead == null && ex.progressBytesUploaded == null" style="color:var(--text-faint);">
                          Запуск… ожидаем первый тик прогресса от агента
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </template>

            <div class="modal__actions">
              <button class="btn btn--ghost" @click="exportDialog.open = false">Закрыть</button>
              <button
                v-if="exportDialog.targetBackup?.engine === 'RESTIC'"
                class="btn btn--primary"
                :disabled="exportDialog.creating"
                @click="createExport"
              >
                {{ exportDialog.creating ? 'Создание…' : 'Создать экспорт' }}
              </button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- Restore Confirmation Modal -->
      <Teleport to="body">
        <div v-if="showSiteRestoreModal" class="modal-overlay" @mousedown.self="showSiteRestoreModal = false">
          <div class="modal modal--wide">
            <h3 class="modal__title">Восстановление бэкапа</h3>
            <p class="modal__text">
              Текущие данные сайта будут перезаписаны данными из бэкапа. Это действие необратимо.
            </p>
            <p v-if="restoringSiteBackup?.engine === 'RESTIC'" class="modal__text" style="font-size:0.82rem;color:var(--text-tertiary);">
              Restic snapshot: <code>{{ restoringSiteBackup?.resticSnapshotId?.slice(0, 12) }}</code>
            </p>

            <!-- Scope: что восстанавливать -->
            <div class="restore-scope">
              <span class="restore-scope__label">Что восстанавливать</span>
              <label class="restore-scope__opt">
                <input type="radio" v-model="restoreScope" value="FILES_AND_DB" />
                <span>Файлы и базу данных</span>
              </label>
              <label class="restore-scope__opt">
                <input type="radio" v-model="restoreScope" value="FILES_ONLY" />
                <span>Только файлы</span>
              </label>
              <label class="restore-scope__opt" :class="{ 'restore-scope__opt--disabled': !backupHasDatabases }">
                <input type="radio" v-model="restoreScope" value="DB_ONLY" :disabled="!backupHasDatabases" />
                <span>Только базу данных</span>
              </label>
            </div>

            <!-- Tree picker — только для Restic + если восстанавливаем файлы -->
            <div v-if="restoringSiteBackup?.engine === 'RESTIC' && restoreScope !== 'DB_ONLY'" class="restore-tree">
              <div class="restore-tree__head">
                <span class="restore-tree__title">Папки и файлы для восстановления</span>
                <div class="restore-tree__head-actions">
                  <button class="btn btn--ghost btn--xs" type="button" :disabled="restoreTreeLoading" @click="selectAllTreeItems(true)">Все</button>
                  <button class="btn btn--ghost btn--xs" type="button" :disabled="restoreTreeLoading" @click="selectAllTreeItems(false)">Снять</button>
                </div>
              </div>
              <div v-if="restoreTreeLoading" class="restore-tree__loading">
                <div class="fm-loading__spinner" />
                <span>Читаю дерево снапшота…</span>
              </div>
              <div v-else-if="restoreTreeError" class="restore-tree__error">{{ restoreTreeError }}</div>
              <div v-else-if="restoreTree.length === 0" class="restore-tree__empty">
                Дерево пустое — нечего выбирать
              </div>
              <div v-else class="restore-tree__list">
                <label
                  v-for="item in restoreTree"
                  :key="item.name"
                  class="restore-tree__item"
                >
                  <input
                    type="checkbox"
                    :checked="restoreSelected.has(item.name)"
                    @change="toggleTreeItem(item.name)"
                  />
                  <span class="restore-tree__icon">{{ item.type === 'dir' ? '📁' : '📄' }}</span>
                  <span class="restore-tree__name">{{ item.name }}</span>
                  <span class="restore-tree__size">{{ formatBackupSize(item.size) }}</span>
                </label>
              </div>
              <p class="restore-tree__hint">
                Сняты чекбоксы → эти пути <b>останутся как есть</b> на сервере (не будут перезаписаны).
                Если включён режим «Удалить файлы, отсутствующие в бэкапе» — он применяется только к выбранным путям.
              </p>
            </div>

            <!-- Какие БД восстанавливать (только если scope включает БД) -->
            <div
              v-if="restoreScopeIncludesDb && backupHasDatabases && (site?.databases?.length || 0) > 0"
              class="db-pick"
              style="margin-top: 1rem;"
            >
              <div class="db-pick__head">
                <span class="db-pick__label">Какие БД восстанавливать</span>
                <span class="db-pick__count">
                  Выбрано {{ restoreDatabaseIds.length }}
                  из {{ site?.databases?.length || 0 }}
                </span>
                <div class="db-pick__head-actions">
                  <button class="btn btn--ghost btn--xs" type="button" @click="selectAllRestoreDbs(true)">Все</button>
                  <button class="btn btn--ghost btn--xs" type="button" @click="selectAllRestoreDbs(false)">Снять</button>
                </div>
              </div>
              <label
                v-for="db in site?.databases || []"
                :key="db.id"
                class="db-pick__item"
              >
                <input
                  type="checkbox"
                  :checked="restoreDatabaseIds.includes(db.id)"
                  @change="toggleRestoreDb(db.id)"
                />
                <span class="db-pick__name">{{ db.name }}</span>
                <span class="db-pick__type">{{ db.type === 'POSTGRESQL' ? 'PostgreSQL' : 'MySQL / MariaDB' }}</span>
              </label>
              <p
                v-if="restoreScope === 'DB_ONLY' && restoreDatabaseIds.length === 0"
                class="form-hint"
                style="color: #f87171;"
              >Для «Только БД» нужно выбрать минимум одну.</p>
            </div>

            <div class="restore-options" v-if="restoreScope !== 'DB_ONLY'">
              <label class="restore-option">
                <input v-model="restoreCleanup" type="checkbox" />
                <div>
                  <span class="restore-option__label">Удалить файлы, отсутствующие в бэкапе</span>
                  <span class="restore-option__hint">Применяется только к выбранным выше папкам/файлам.</span>
                </div>
              </label>
            </div>

            <div class="modal__actions">
              <button class="btn btn--ghost" @click="showSiteRestoreModal = false">Отмена</button>
              <button
                class="btn btn--danger"
                :disabled="restoringBackup || !canRunRestore"
                @click="doRestoreSiteBackup"
              >
                {{ restoringBackup ? 'Восстановление...' : 'Восстановить' }}
              </button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- Snapshot Picker Modal (Restic: picker произвольных snapshots из репы) -->
      <Teleport to="body">
        <div v-if="snapshotPicker.open" class="modal-overlay" @mousedown.self="snapshotPicker.open = false">
          <div class="modal modal--wide">
            <h3 class="modal__title">Снапшоты в Restic-репозитории</h3>
            <p class="modal__text" style="font-size:0.8rem;color:var(--text-tertiary);">
              Читаем список снапшотов напрямую из репы хранилища — даже если у нас в БД нет записи (например,
              после миграции или если запись была удалена). Выбрать → «Восстановить» импортирует снапшот как Backup-запись
              и запустит восстановление.
            </p>
            <div class="form-group">
              <label class="form-label">Хранилище (Restic-совместимое)</label>
              <select v-model="snapshotPicker.locationId" class="form-input form-input--select" @change="loadSnapshotsInPicker">
                <option value="">— выбери —</option>
                <option
                  v-for="loc in siteStorageLocations.filter((l) => l.resticEnabled)"
                  :key="loc.id"
                  :value="loc.id"
                >
                  {{ loc.name }} ({{ loc.type }})
                </option>
              </select>
            </div>

            <div v-if="snapshotPicker.loading" class="fm-loading"><div class="fm-loading__spinner" /></div>
            <div v-else-if="!snapshotPicker.locationId" class="fm-empty">
              <span class="fm-empty__text">Выбери хранилище выше</span>
            </div>
            <div v-else-if="snapshotPicker.error" class="modal__text" style="color:#f87171;white-space:pre-wrap;">{{ snapshotPicker.error }}</div>
            <div v-else-if="!snapshotPicker.snapshots.length" class="fm-empty">
              <span class="fm-empty__text">В репе нет снапшотов для этого сайта</span>
            </div>
            <div v-else class="snapshot-list">
              <div
                v-for="s in snapshotPicker.snapshots"
                :key="s.id"
                class="snapshot-item"
                :class="{ 'snapshot-item--selected': snapshotPicker.selectedId === s.id }"
                @click="snapshotPicker.selectedId = s.id || ''"
              >
                <div class="snapshot-item__head">
                  <code class="snapshot-item__id">{{ (s.short_id || (s.id || '').slice(0, 12)) }}</code>
                  <span class="snapshot-item__time">{{ formatBackupDate(s.time) }}</span>
                  <span v-if="s.inDatabase" class="snapshot-item__badge snapshot-item__badge--known">в БД</span>
                  <span v-else class="snapshot-item__badge snapshot-item__badge--new">не в БД</span>
                </div>
                <div class="snapshot-item__meta">
                  <span v-if="s.hostname">host: {{ s.hostname }}</span>
                  <span v-if="s.paths?.length">· paths: {{ s.paths.length }}</span>
                  <span v-if="s.summary?.total_bytes_processed">· {{ formatBackupSize(s.summary.total_bytes_processed) }}</span>
                </div>
              </div>
            </div>

            <div v-if="snapshotPicker.snapshots.length" class="restore-options" style="margin-top:0.75rem;">
              <label class="restore-option">
                <input v-model="snapshotPicker.cleanup" type="checkbox" />
                <div>
                  <span class="restore-option__label">Удалить файлы, отсутствующие в снапшоте</span>
                  <span class="restore-option__hint">Файлы, добавленные после создания снапшота, будут удалены.</span>
                </div>
              </label>
            </div>

            <div class="modal__actions">
              <button class="btn btn--ghost" @click="snapshotPicker.open = false">Закрыть</button>
              <button
                class="btn btn--danger"
                :disabled="snapshotPicker.restoring || !snapshotPicker.selectedId"
                @click="restoreFromPickedSnapshot"
              >
                {{ snapshotPicker.restoring ? 'Запуск...' : 'Восстановить из выбранного' }}
              </button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- Backup Compare Modal (Restic diff: snapshot ↔ snapshot, snapshot ↔ live) -->
      <Teleport to="body">
        <div v-if="backupCompare.open" class="modal-overlay" @mousedown.self="closeBackupCompare()">
          <div class="modal modal--wide" style="max-width:1100px;">
            <h3 class="modal__title">Сравнение бэкапов</h3>
            <p class="modal__text" style="font-size:0.8rem;color:var(--text-tertiary);">
              Diff между restic-снапшотами или со текущими файлами сайта. Список файлов с пометками
              <code>+</code> добавлен, <code>-</code> удалён, <code>M</code> изменён. Клик по изменённому файлу
              покажет содержимое-diff (только текстовые файлы &lt; 2 МБ).
            </p>

            <!-- Source / Target -->
            <div class="form-group" style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;">
              <div>
                <label class="form-label">Источник (A)</label>
                <div class="form-input" style="background:var(--bg-secondary);">
                  <code>{{ backupCompare.leftLabel }}</code>
                </div>
              </div>
              <div>
                <label class="form-label">Сравнить с (B)</label>
                <select v-model="backupCompare.rightMode" class="form-input form-input--select" @change="onBackupCompareModeChange">
                  <option value="live">Текущие файлы сайта (live)</option>
                  <option value="snapshot">Другой restic-бэкап</option>
                </select>
                <select
                  v-if="backupCompare.rightMode === 'snapshot'"
                  v-model="backupCompare.rightBackupId"
                  class="form-input form-input--select"
                  style="margin-top:0.4rem;"
                  @change="runBackupCompare"
                >
                  <option value="">— выбери бэкап —</option>
                  <option
                    v-for="b in backupCompareCandidates"
                    :key="b.id"
                    :value="b.id"
                  >
                    {{ formatBackupDate(b.createdAt) }} · {{ b.resticSnapshotId?.slice(0, 8) }} · {{ b.storageLocation?.name || '' }}
                  </option>
                </select>
              </div>
            </div>

            <!-- Stats -->
            <div v-if="backupCompare.stats" class="exp-warn" style="margin-top:0.5rem;">
              Изменено: <b>{{ backupCompare.stats.changedFiles }}</b> ·
              Добавлено: <b>{{ backupCompare.stats.addedFiles }}</b> ·
              Удалено: <b>{{ backupCompare.stats.removedFiles }}</b>
            </div>

            <div v-if="backupCompare.loading" class="fm-loading" style="margin-top:0.75rem;">
              <div class="fm-loading__spinner" />
              <span style="margin-left:0.5rem;font-size:0.85rem;color:var(--text-tertiary);">{{ backupCompare.loadingLabel || 'Считаем diff…' }}</span>
            </div>

            <div v-else-if="backupCompare.error" class="modal__text" style="color:#f87171;white-space:pre-wrap;margin-top:0.5rem;">
              {{ backupCompare.error }}
            </div>

            <!-- File list + content diff -->
            <div v-else-if="backupCompare.items.length" style="display:grid;grid-template-columns:340px 1fr;gap:0.75rem;margin-top:0.75rem;max-height:60vh;">
              <div style="overflow:auto;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-secondary);padding:0.4rem;">
                <div
                  v-for="item in backupCompare.items"
                  :key="item.path"
                  class="snapshot-item"
                  :class="{ 'snapshot-item--selected': backupCompare.selectedPath === item.path }"
                  style="padding:0.35rem 0.5rem;cursor:pointer;font-size:0.78rem;display:flex;gap:0.4rem;align-items:center;"
                  @click="onBackupCompareFileClick(item)"
                >
                  <span :style="{ color: backupModifierColor(item.modifier), fontWeight: 700, width: '12px' }">{{ item.modifier }}</span>
                  <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{{ item.path }}</span>
                </div>
              </div>

              <div style="overflow:auto;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-tertiary);padding:0.5rem;font-size:0.78rem;font-family:monospace;">
                <div v-if="backupCompare.fileLoading" class="fm-loading"><div class="fm-loading__spinner" /></div>
                <div v-else-if="backupCompare.fileError" style="color:#f87171;white-space:pre-wrap;">{{ backupCompare.fileError }}</div>
                <div v-else-if="backupCompare.fileBinary">
                  <p style="color:var(--text-tertiary);">Бинарный файл — content-diff не показывается.</p>
                  <p>Размер A: {{ backupCompare.fileSizeA }} байт · Размер B: {{ backupCompare.fileSizeB }} байт</p>
                </div>
                <pre v-else-if="backupCompare.unifiedDiff" v-html="renderUnifiedDiff(backupCompare.unifiedDiff)" style="margin:0;white-space:pre-wrap;word-break:break-all;"></pre>
                <p v-else style="color:var(--text-tertiary);">Кликни файл слева чтобы увидеть diff.</p>
                <p v-if="backupCompare.fileTruncated" style="color:var(--primary-light);margin-top:0.5rem;">⚠ Файл обрезан до 2 МБ — diff неполный.</p>
              </div>
            </div>

            <div v-else-if="backupCompare.ranAt && !backupCompare.items.length" class="fm-empty" style="margin-top:0.75rem;">
              Различий нет.
            </div>

            <div class="modal__actions" style="margin-top:1rem;">
              <button class="btn btn--ghost" @click="closeBackupCompare()">Закрыть</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- Restic Check Modal -->
      <Teleport to="body">
        <div v-if="resticCheck.open" class="modal-overlay" @mousedown.self="resticCheck.open = false">
          <div class="modal modal--wide">
            <h3 class="modal__title">Проверка целостности Restic-репы</h3>
            <p class="modal__text" style="font-size:0.8rem;color:var(--text-tertiary);">
              Запускает <code>restic check</code> на репе <b>(сайт × хранилище)</b>. Без <code>--read-data</code> —
              только структура и индексы (почти мгновенно). С <code>--read-data-subset</code> — плюс
              чтение части чанков (медленно, но ловит порчу данных).
            </p>

            <div class="form-group">
              <label class="form-label">Хранилище</label>
              <select v-model="resticCheck.locationId" class="form-input form-input--select" @change="loadResticChecks">
                <option value="">— выбери —</option>
                <option
                  v-for="loc in siteStorageLocations.filter((l) => l.resticEnabled)"
                  :key="loc.id"
                  :value="loc.id"
                >
                  {{ loc.name }} ({{ loc.type }})
                </option>
              </select>
            </div>

            <div class="check-opts">
              <label class="restore-option">
                <input v-model="resticCheck.readData" type="checkbox" />
                <div>
                  <span class="restore-option__label">Читать данные (--read-data-subset)</span>
                  <span class="restore-option__hint">Скачивает и хэширует часть pack-файлов. Для S3/remote — может быть долго.</span>
                </div>
              </label>
              <div v-if="resticCheck.readData" class="form-group" style="margin-top:0.5rem;">
                <label class="form-label">Subset</label>
                <input v-model="resticCheck.readDataSubset" class="form-input mono" placeholder="10%" />
              </div>
            </div>

            <div class="check-toolbar" style="justify-content:space-between;align-items:center;display:flex;margin-top:0.75rem;">
              <span class="form-hint">История — 50 последних запусков</span>
              <button class="btn btn--primary btn--sm" :disabled="resticCheck.running || !resticCheck.locationId" @click="runResticCheck">
                {{ resticCheck.running ? 'Запуск...' : 'Запустить проверку' }}
              </button>
            </div>

            <div v-if="resticCheck.loading" class="fm-loading"><div class="fm-loading__spinner" /></div>
            <div v-else-if="!resticCheck.locationId" class="fm-empty">
              <span class="fm-empty__text">Выбери хранилище выше</span>
            </div>
            <div v-else-if="!resticCheck.history.length" class="fm-empty">
              <span class="fm-empty__text">Проверок для этой репы ещё не было</span>
            </div>
            <div v-else class="check-history">
              <div v-for="c in resticCheck.history" :key="c.id" class="check-item">
                <div class="check-item__head">
                  <span v-if="c.completedAt && c.success" class="snapshot-item__badge snapshot-item__badge--known">OK</span>
                  <span v-else-if="c.completedAt && !c.success" class="snapshot-item__badge snapshot-item__badge--err">FAIL</span>
                  <span v-else class="snapshot-item__badge snapshot-item__badge--new">идёт…</span>
                  <span class="check-item__time">{{ formatBackupDate(c.startedAt) }}</span>
                  <span v-if="c.durationMs" class="check-item__dur">{{ Math.round(c.durationMs / 1000) }} с</span>
                  <span class="snapshot-item__badge" :class="c.source === 'manual' ? 'snapshot-item__badge--known' : 'snapshot-item__badge--new'" style="margin-left:auto;">{{ c.source === 'manual' ? 'ручная' : 'плановая' }}</span>
                </div>
                <div v-if="c.errorMessage" class="check-item__error">{{ c.errorMessage }}</div>
              </div>
            </div>

            <div class="modal__actions">
              <button class="btn btn--ghost" @click="resticCheck.open = false">Закрыть</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- Duplicate Site Modal -->
      <Teleport to="body">
        <div v-if="duplicateDialog.open" class="modal-overlay" @mousedown.self="duplicateDialog.open = false">
          <div class="modal">
            <h2 class="modal__title">Дублировать сайт</h2>
            <p class="modal__text">
              Создаётся новый сайт с отдельным Linux-юзером, БД, nginx/PHP-FPM конфигами.
              Файлы <code>{{ site.filesRelPath || 'www' }}/</code> копируются через rsync;
              БД (если есть) дампится и восстанавливается. SSL и алиасы не копируются.
            </p>
            <div class="form-row">
              <label class="form-label">Системное имя нового сайта <span style="color:#f87171;">*</span></label>
              <input
                v-model="duplicateDialog.name"
                class="form-input"
                placeholder="например: myshop-staging"
                :disabled="duplicateDialog.submitting"
              />
              <small class="form-hint">Буквы/цифры/дефис/подчёркивание, начинается с буквы, max 32.</small>
            </div>
            <div class="form-row">
              <label class="form-label">Новый главный домен <span style="color:#f87171;">*</span></label>
              <input
                v-model="duplicateDialog.domain"
                class="form-input"
                placeholder="например: staging.myshop.ru"
                :disabled="duplicateDialog.submitting"
              />
            </div>
            <div class="form-row">
              <label class="form-label">Отображаемое имя (необязательно)</label>
              <input
                v-model="duplicateDialog.displayName"
                class="form-input"
                :disabled="duplicateDialog.submitting"
              />
            </div>
            <div class="restore-options" style="margin-top:0.5rem;">
              <label class="restore-option">
                <input v-model="duplicateDialog.copyBackupConfigs" type="checkbox" :disabled="duplicateDialog.submitting" />
                <span class="restore-option__label">Копировать настройки бэкапов</span>
              </label>
              <label class="restore-option">
                <input v-model="duplicateDialog.copyCronJobs" type="checkbox" :disabled="duplicateDialog.submitting" />
                <span class="restore-option__label">Копировать cron-задачи</span>
              </label>
            </div>
            <div v-if="duplicateDialog.error" class="modal__text" style="color:#f87171;white-space:pre-wrap;margin-top:0.5rem;">
              {{ duplicateDialog.error }}
            </div>
            <div class="modal__actions">
              <button class="btn btn--ghost" :disabled="duplicateDialog.submitting" @click="duplicateDialog.open = false">Отмена</button>
              <button
                class="btn btn--primary"
                :disabled="!duplicateDialog.name || !duplicateDialog.domain || duplicateDialog.submitting"
                @click="performDuplicate"
              >
                {{ duplicateDialog.submitting ? 'Создание...' : 'Создать копию' }}
              </button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- Site Terminal Modal -->
      <Teleport to="body">
        <div v-if="showSiteTerminal" class="modal-overlay modal-overlay--terminal" @mousedown.self="closeSiteTerminal">
          <div class="site-terminal-modal">
            <div class="site-terminal-modal__header">
              <span class="site-terminal-modal__title">Терминал: {{ site.systemUser }}</span>
              <button class="site-terminal-modal__close" @click="closeSiteTerminal">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
            <div ref="siteTerminalContainer" class="site-terminal-modal__body" />
          </div>
        </div>
      </Teleport>

      <!-- Tab content: Nginx -->
      <div v-if="activeTab === 'nginx'" class="tab-content">
        <SiteNginxTab :site-id="siteId" :site-name="site.name" />
      </div>

      <!-- Tab content: PHP-FPM pool -->
      <div v-if="activeTab === 'php'" class="tab-content">
        <div class="config-view">
          <div class="config-view__header">
            <span class="config-view__path">
              /etc/php/{{ site.phpVersion }}/fpm/pool.d/{{ site.name }}.conf
            </span>
            <div class="config-view__actions">
              <button
                class="btn btn--sm btn--primary"
                :disabled="phpPoolSaving || !phpPoolDirty"
                @click="savePhpPoolConfig"
              >
                {{ phpPoolSaving ? 'Сохранение...' : 'Сохранить и перезагрузить' }}
              </button>
            </div>
          </div>
          <p class="php-pool-hint">
            Тут пишется <b>кастомный</b> INI-фрагмент — он дописывается в конец базового pool-конфига,
            поэтому <code>php_value[...]</code> и <code>php_admin_value[...]</code> ниже перезаписывают
            дефолты meowbox (last-wins). Смена версии PHP, выпуск SSL и любые другие
            регенерации pool пула — сохраняют этот блок.<br>
            <b>Запрещено</b>: новые <code>[секции]</code>, а также системные директивы
            (<code>user</code>, <code>group</code>, <code>listen</code>, <code>pm.*</code>,
            <code>open_basedir</code>, <code>session.cookie_secure</code> и т.п.) —
            бэкенд отклонит сохранение.
          </p>
          <div v-if="phpPoolLoading" class="config-view__loading">
            <span class="spinner-small" />
            <span>Загружаем актуальный pool-конфиг с сервера…</span>
          </div>
          <textarea
            v-else
            v-model="phpPoolCustom"
            class="config-view__editor"
            spellcheck="false"
            placeholder="; пример:
php_value[memory_limit] = 256M
php_value[upload_max_filesize] = 128M
php_value[post_max_size] = 128M
php_value[max_execution_time] = 300"
            :disabled="phpPoolSaving"
          />
          <p v-if="phpPoolError" class="config-view__test config-view__test--err">{{ phpPoolError }}</p>
          <p v-if="phpPoolSuccess" class="config-view__test config-view__test--ok">{{ phpPoolSuccess }}</p>

          <details v-if="phpPoolRendered" class="php-pool-rendered">
            <summary>Показать текущий pool-файл (только чтение)</summary>
            <pre class="config-view__editor config-view__editor--readonly">{{ phpPoolRendered }}</pre>
          </details>
        </div>
      </div>

      <!-- Tab content: Environment -->
      <div v-if="activeTab === 'env'" class="tab-content">
        <div class="env-section">
          <div v-if="envEntries.length" class="env-list">
            <div v-for="[key, val] in envEntries" :key="key" class="env-item">
              <span class="env-item__key">{{ key }}</span>
              <span class="env-item__eq">=</span>
              <span class="env-item__val">{{ envShowValues ? val : maskEnvValue(val) }}</span>
              <button class="env-item__del" title="Удалить" @click="removeEnvVar(key)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
          </div>
          <div v-else class="tab-empty">
            <p class="tab-empty__text">Переменные окружения не настроены</p>
          </div>
          <div class="env-add">
            <input v-model="envNewKey" class="env-add__input env-add__input--key" placeholder="KEY" spellcheck="false" @keydown.enter="addEnvVar" />
            <span class="env-add__eq">=</span>
            <input v-model="envNewVal" class="env-add__input env-add__input--val" placeholder="значение" spellcheck="false" @keydown.enter="addEnvVar" />
            <button class="btn btn--sm btn--primary" :disabled="!envNewKey.trim()" @click="addEnvVar">Добавить</button>
          </div>
          <div class="env-actions">
            <button class="btn btn--sm btn--secondary" @click="envShowValues = !envShowValues">
              {{ envShowValues ? 'Скрыть значения' : 'Показать значения' }}
            </button>
            <button v-if="envDirty" class="btn btn--sm btn--primary" :disabled="envSaving" @click="saveEnvVars">
              {{ envSaving ? 'Сохранение...' : 'Сохранить' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Tab content: Deploy -->
      <div v-if="activeTab === 'deploy'" class="tab-content">
        <div class="deploy-section">
          <!-- Deploy trigger -->
          <div class="deploy-trigger">
            <div class="deploy-trigger__info">
              <h3 class="deploy-trigger__title">Деплой из Git</h3>
              <p class="deploy-trigger__desc">
                Получить последние изменения из <span class="deploy-trigger__mono">{{ site.gitRepository || 'нет репозитория' }}</span>
                ветка <span class="deploy-trigger__mono">{{ site.deployBranch || 'main' }}</span>
              </p>
            </div>
            <button
              class="deploy-trigger__btn"
              :disabled="!site.gitRepository || deploying"
              @click="triggerDeploy"
            >
              <svg v-if="!deploying" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <polyline points="16,16 12,12 8,16" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
              </svg>
              <span v-if="deploying" class="deploy-trigger__spinner" />
              {{ deploying ? 'Деплой...' : 'Задеплоить' }}
            </button>
          </div>

          <!-- Active deploy log viewer -->
          <div v-if="activeDeployLog" class="deploy-log-viewer">
            <div class="deploy-log-viewer__header">
              <span class="deploy-log-viewer__status" :class="`deploy-log-viewer__status--${activeDeployLog.status?.toLowerCase()}`">
                {{ activeDeployLog.status }}
              </span>
              <span class="deploy-log-viewer__branch">{{ activeDeployLog.branch }}</span>
              <span v-if="activeDeployLog.commitSha" class="deploy-log-viewer__sha">{{ activeDeployLog.commitSha?.substring(0, 8) }}</span>
            </div>
            <pre ref="logContainer" class="deploy-log-viewer__output"><code>{{ activeDeployOutput }}</code></pre>
          </div>

          <!-- Deploy history -->
          <div class="deploy-history">
            <h3 class="deploy-history__title">История деплоев</h3>
            <div v-if="deployLogs.length" class="deploy-history__list">
              <div
                v-for="dl in deployLogs"
                :key="dl.id"
                class="deploy-history__item"
                :class="{ 'deploy-history__item--active': activeDeployLog?.id === dl.id }"
                @click="viewDeployLog(dl.id)"
              >
                <span class="deploy-history__dot" :class="`deploy-history__dot--${dl.status.toLowerCase()}`" />
                <div class="deploy-history__item-info">
                  <span class="deploy-history__item-branch">{{ dl.branch }}</span>
                  <span v-if="dl.commitMessage" class="deploy-history__item-msg">{{ dl.commitMessage }}</span>
                </div>
                <div class="deploy-history__item-meta">
                  <span v-if="dl.durationMs" class="deploy-history__item-duration">{{ formatDuration(dl.durationMs) }}</span>
                  <span class="deploy-history__item-time">{{ formatRelative(dl.startedAt) }}</span>
                </div>
                <button
                  v-if="dl.status === 'SUCCESS' && dl.commitSha"
                  class="deploy-history__rollback"
                  title="Откатить к этому деплою"
                  :disabled="rollingBack === dl.id"
                  @click.stop="rollbackDeploy(dl)"
                >
                  {{ rollingBack === dl.id ? '...' : 'Откат' }}
                </button>
              </div>
            </div>
            <div v-else class="tab-empty">
              <CatMascot :size="60" mood="sleepy" />
              <p class="tab-empty__text">Деплоев пока нет</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Tab content: Services (Manticore и др.) -->
      <div v-if="activeTab === 'services'" class="tab-content">
        <SiteServicesTab :site-id="siteId" :active="activeTab === 'services'" />
      </div>

      <!-- Tab content: Danger Zone -->
      <div v-if="activeTab === 'danger'" class="tab-content">
        <div class="danger-zone">
          <div v-if="serverStore.hasMultipleServers" class="danger-item danger-item--migrate">
            <div class="danger-item__info">
              <h4 class="danger-item__title">Мигрировать на другой сервер</h4>
              <p class="danger-item__desc">Перенос файлов, базы данных и конфигурации на другой сервер через облачное хранилище.</p>
            </div>
            <button
              class="danger-item__btn danger-item__btn--migrate"
              @click="showMigrateModal = true"
            >
              Мигрировать
            </button>
          </div>
          <div class="danger-item">
            <div class="danger-item__info">
              <h4 class="danger-item__title">Удалить этот сайт</h4>
              <p class="danger-item__desc">После удаления сайт и его конфигурация будут безвозвратно удалены. Это действие нельзя отменить.</p>
            </div>
            <button
              class="danger-item__btn"
              :disabled="deleting"
              @click="confirmDelete"
            >
              {{ deleting ? 'Удаление...' : 'Удалить сайт' }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- Not found -->
    <div v-else class="site-detail__empty">
      <CatMascot :size="80" mood="alert" />
      <p class="site-detail__empty-text">Сайт не найден</p>
      <NuxtLink to="/sites" class="site-detail__empty-link">Назад к сайтам</NuxtLink>
    </div>

    <!-- Delete confirmation modal -->
    <Teleport to="body">
      <div v-if="showDeleteModal" class="modal-overlay" @mousedown.self="showDeleteModal = false">
        <div class="modal modal--wide">
          <h3 class="modal__title">Удалить сайт?</h3>
          <p class="modal__text">
            Отметьте, что удалить, а что оставить. По умолчанию удаляется всё.
          </p>
          <div class="delete-opts">
            <label class="delete-opts__row">
              <input type="checkbox" v-model="deleteOpts.removeFiles" />
              <span class="delete-opts__label">Файлы сайта</span>
              <span class="delete-opts__hint">{{ site?.rootPath }}</span>
            </label>
            <label class="delete-opts__row">
              <input type="checkbox" v-model="deleteOpts.removeDatabases" />
              <span class="delete-opts__label">Базы данных</span>
              <span class="delete-opts__hint">{{ site?.databases?.length || 0 }} шт.</span>
            </label>
            <label class="delete-opts__row">
              <input type="checkbox" v-model="deleteOpts.removeSslCertificate" />
              <span class="delete-opts__label">SSL-сертификат (Let's Encrypt)</span>
              <span class="delete-opts__hint">revoke + delete</span>
            </label>
            <label class="delete-opts__row">
              <input type="checkbox" v-model="deleteOpts.removeBackupsLocal" />
              <span class="delete-opts__label">Локальные бэкапы (TAR)</span>
            </label>
            <label class="delete-opts__row">
              <input type="checkbox" v-model="deleteOpts.removeBackupsRestic" />
              <span class="delete-opts__label">Restic-снапшоты</span>
            </label>
            <label class="delete-opts__row">
              <input type="checkbox" v-model="deleteOpts.removeBackupsRemote" />
              <span class="delete-opts__label">Удалённые бэкапы</span>
              <span class="delete-opts__hint">Яндекс.Диск / Mail.ru</span>
            </label>
            <label class="delete-opts__row">
              <input type="checkbox" v-model="deleteOpts.removeNginxConfig" />
              <span class="delete-opts__label">Nginx-конфиг</span>
            </label>
            <label class="delete-opts__row">
              <input type="checkbox" v-model="deleteOpts.removePhpPool" />
              <span class="delete-opts__label">PHP-FPM пул</span>
            </label>
            <label class="delete-opts__row">
              <input type="checkbox" v-model="deleteOpts.removeSystemUser" />
              <span class="delete-opts__label">Linux-пользователь</span>
              <span class="delete-opts__hint">{{ site?.systemUser }}</span>
            </label>
          </div>
          <p class="modal__text" style="margin-top:0.75rem;">
            Введите <strong class="modal__confirm-name">{{ site?.name }}</strong> для подтверждения.
          </p>
          <input
            v-model="deleteConfirmInput"
            type="text"
            class="form-input"
            :placeholder="site?.name"
            autocomplete="off"
          />
          <div class="modal__actions">
            <button class="modal__btn modal__btn--cancel" @click="showDeleteModal = false">Отмена</button>
            <button
              class="modal__btn modal__btn--delete"
              :disabled="deleteConfirmInput !== site?.name || deleting"
              @click="deleteSite"
            >
              {{ deleting ? 'Удаление...' : 'Удалить' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- SSH password change modal -->
    <Teleport to="body">
      <div v-if="showSshPasswordModal" class="modal-overlay" @mousedown.self="!sshPasswordSaving && closeSshPasswordModal()">
        <div class="modal">
          <h3 class="modal__title">Сменить SSH-пароль</h3>
          <p class="modal__text">
            Пароль применится к Linux-юзеру <strong>{{ site?.systemUser }}</strong> немедленно (usermod). Существующие SSH-сессии останутся живы до reconnect.
          </p>
          <div class="form-group" style="margin-bottom: 0.75rem;">
            <label class="form-label">Новый пароль (мин. 12 символов)</label>
            <input
              v-model="sshPasswordInput"
              type="text"
              class="form-input form-input--mono"
              placeholder="Оставь пустым — сгенерирую сам"
              autocomplete="off"
              :disabled="sshPasswordSaving"
            />
          </div>
          <p v-if="sshPasswordError" class="modal__text" style="color: var(--danger-light); font-size: 0.8rem;">
            {{ sshPasswordError }}
          </p>
          <p v-if="sshPasswordNewValue" class="modal__text" style="color: var(--success-light); font-size: 0.8rem;">
            Новый пароль: <strong class="info-row__value--mono">{{ sshPasswordNewValue }}</strong>
          </p>
          <div class="modal__actions">
            <button
              class="modal__btn modal__btn--cancel"
              :disabled="sshPasswordSaving"
              @click="closeSshPasswordModal"
            >
              {{ sshPasswordNewValue ? 'Закрыть' : 'Отмена' }}
            </button>
            <button
              v-if="!sshPasswordNewValue"
              class="modal__btn"
              style="background: linear-gradient(135deg,var(--primary-light),var(--primary-dark)); color:#0a0a0f; border-color:transparent;"
              :disabled="sshPasswordSaving"
              @click="submitSshPasswordChange"
            >
              {{ sshPasswordSaving ? 'Сохранение...' : 'Сменить' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- MODX admin password change modal -->
    <Teleport to="body">
      <div v-if="showCmsAdminPasswordModal" class="modal-overlay" @mousedown.self="!cmsAdminPasswordSaving && closeCmsAdminPasswordModal()">
        <div class="modal">
          <h3 class="modal__title">Сменить пароль MODX-админа</h3>
          <p class="modal__text">
            Пароль будет обновлён через bootstrap MODX (<code>$user-&gt;changePassword(...)</code>) для логина
            <strong class="info-row__value--mono">{{ site?.cmsAdminUser }}</strong>. Старый пароль не нужен — мы пишем напрямую в БД сайта.
          </p>
          <div class="form-group" style="margin-bottom: 0.75rem;">
            <label class="form-label">Новый пароль (мин. 8 символов)</label>
            <input
              v-model="cmsAdminPasswordInput"
              type="text"
              class="form-input form-input--mono"
              placeholder="Оставь пустым — сгенерирую сам"
              autocomplete="off"
              :disabled="cmsAdminPasswordSaving"
              @keydown.enter="!cmsAdminPasswordSaving && !cmsAdminPasswordNewValue && submitCmsAdminPasswordChange()"
            />
          </div>
          <p v-if="cmsAdminPasswordError" class="modal__text" style="color: var(--danger-light); font-size: 0.8rem;">
            {{ cmsAdminPasswordError }}
          </p>
          <p v-if="cmsAdminPasswordNewValue" class="modal__text" style="color: var(--success-light); font-size: 0.8rem;">
            Готово. Новый пароль: <strong class="info-row__value--mono">{{ cmsAdminPasswordNewValue }}</strong>
          </p>
          <div class="modal__actions">
            <button
              class="modal__btn modal__btn--cancel"
              :disabled="cmsAdminPasswordSaving"
              @click="closeCmsAdminPasswordModal"
            >
              {{ cmsAdminPasswordNewValue ? 'Закрыть' : 'Отмена' }}
            </button>
            <button
              v-if="!cmsAdminPasswordNewValue"
              class="modal__btn"
              style="background: linear-gradient(135deg,var(--primary-light),var(--primary-dark)); color:#0a0a0f; border-color:transparent;"
              :disabled="cmsAdminPasswordSaving"
              @click="submitCmsAdminPasswordChange"
            >
              {{ cmsAdminPasswordSaving ? 'Сохранение...' : 'Сменить' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- MODX version update modal -->
    <Teleport to="body">
      <div v-if="showModxUpdateModal" class="modal-overlay" @mousedown.self="!modxUpdating && closeModxUpdateModal()">
        <div class="modal">
          <h3 class="modal__title">Апгрейд MODX</h3>
          <p class="modal__text">
            Текущая версия: <strong class="info-row__value--mono">{{ site?.modxVersion || '— (неизвестна)' }}</strong>
          </p>
          <p class="modal__text modal__text--hint">
            <span v-if="site?.type === 'MODX_3'">MODX 3 будет обновлён через <code>composer require modx/revolution</code>, затем запустится <code>setup/index.php --installmode=upgrade</code>. Выбор той же версии перезапишет файлы ядра.</span>
            <span v-else>MODX Revo: скачается ZIP указанной версии, файлы накатятся поверх (<code>config.inc.php</code> сохранится), затем запустится setup в режиме upgrade. Выбор той же версии перезапишет файлы ядра.</span>
          </p>
          <div class="form-group" style="margin-bottom: 0.75rem;">
            <label class="form-label">Целевая версия</label>
            <select v-model="modxTargetVersion" class="form-input form-input--mono" :disabled="modxUpdating">
              <option v-for="v in modxAvailableVersions" :key="v.value" :value="v.value">{{ v.label }}</option>
            </select>
          </div>
          <p v-if="modxUpdateError" class="modal__text" style="color: var(--danger-light); font-size: 0.8rem;">
            {{ modxUpdateError }}
          </p>
          <p v-if="modxUpdateSuccess" class="modal__text" style="color: var(--success-light); font-size: 0.8rem;">
            Готово: MODX обновлён до <strong class="info-row__value--mono">{{ modxUpdateSuccess }}</strong>
          </p>
          <div class="modal__actions">
            <button
              class="modal__btn modal__btn--cancel"
              :disabled="modxUpdating"
              @click="closeModxUpdateModal"
            >
              {{ modxUpdateSuccess ? 'Закрыть' : 'Отмена' }}
            </button>
            <button
              v-if="!modxUpdateSuccess"
              class="modal__btn"
              style="background: linear-gradient(135deg,#60a5fa,#2563eb); color:#fff; border-color:transparent;"
              :disabled="modxUpdating || !modxTargetVersion"
              @click="submitModxUpdate"
            >
              {{ modxUpdating ? 'Апгрейд (до 15 мин)...' : 'Апгрейд' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Migration modal -->
    <Teleport to="body">
      <div v-if="showMigrateModal" class="modal-overlay" @mousedown.self="!migrationRunning && (showMigrateModal = false)">
        <div class="modal modal--wide">
          <h3 class="modal__title">Миграция сайта</h3>

          <!-- Form (before migration starts) -->
          <template v-if="!migrationId">
            <p class="modal__text">
              Перенос <strong>{{ site?.name }}</strong> на другой сервер. Файлы передаются напрямую между серверами.
            </p>

            <div class="migrate-form">
              <label class="migrate-form__label">Целевой сервер</label>
              <select v-model="migrateTarget" class="form-input">
                <option value="" disabled>Выберите сервер</option>
                <option
                  v-for="s in migrateTargetServers"
                  :key="s.id"
                  :value="s.id"
                >
                  {{ s.name }}
                </option>
              </select>

              <div class="migrate-form__checkboxes">
                <label class="migrate-form__checkbox">
                  <input v-model="migrateReissueSsl" type="checkbox" />
                  <span>Перевыпустить SSL на целевом сервере</span>
                </label>
                <label class="migrate-form__checkbox">
                  <input v-model="migrateStopSource" type="checkbox" />
                  <span>Остановить оригинал после миграции</span>
                </label>
              </div>
            </div>

            <div v-if="migrateError" class="migrate-error">{{ migrateError }}</div>

            <div class="modal__actions">
              <button class="modal__btn modal__btn--cancel" @click="showMigrateModal = false">Отмена</button>
              <button
                class="modal__btn modal__btn--primary"
                :disabled="!migrateTarget || migrateStarting"
                @click="startMigration"
              >
                {{ migrateStarting ? 'Запуск...' : 'Начать миграцию' }}
              </button>
            </div>
          </template>

          <!-- Progress (after migration starts) -->
          <template v-else>
            <div class="migrate-progress">
              <div
                v-for="(step, idx) in migrationSteps"
                :key="step.key"
                class="migrate-step"
                :class="{
                  'migrate-step--done': idx < migrationStepIndex,
                  'migrate-step--active': idx === migrationStepIndex && !migrationError,
                  'migrate-step--error': idx === migrationStepIndex && !!migrationError,
                }"
              >
                <div class="migrate-step__icon">
                  <template v-if="idx < migrationStepIndex">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20,6 9,17 4,12" /></svg>
                  </template>
                  <template v-else-if="idx === migrationStepIndex && !migrationError">
                    <div class="migrate-step__spinner" />
                  </template>
                  <template v-else-if="idx === migrationStepIndex && migrationError">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </template>
                  <template v-else>
                    <div class="migrate-step__dot" />
                  </template>
                </div>
                <span class="migrate-step__label">{{ step.label }}</span>
              </div>
            </div>

            <div v-if="migrationError" class="migrate-error">{{ migrationError }}</div>
            <div v-if="migrationDone" class="migrate-success">Миграция завершена успешно!</div>

            <div class="modal__actions">
              <button
                v-if="migrationDone || migrationError"
                class="modal__btn modal__btn--cancel"
                @click="closeMigrateModal"
              >
                Закрыть
              </button>
            </div>
          </template>
        </div>
      </div>
    </Teleport>

    <!-- MODX Doctor modal -->
    <Teleport to="body">
      <div v-if="showDoctorModal" class="modal-overlay" @mousedown.self="closeDoctorModal">
        <div class="modal modal--wide">
          <h3 class="modal__title modal__title--with-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            <span>Доктор MODX</span>
          </h3>
          <p class="modal__text modal__text--hint">
            Read-only проверка типовых проблем MODX-сайта: владелец/права на core/cache, доступность setup/, целостность config.inc.php, и т.п. Запускайте при странном поведении админки/плагинов.
          </p>

          <!-- Loading -->
          <div v-if="doctorLoading" class="doctor-loading">
            <div class="spinner-small" /> Запускаю диагностику…
          </div>

          <!-- Error -->
          <div v-else-if="doctorError" class="doctor-error">
            Ошибка: {{ doctorError }}
          </div>

          <!-- Results -->
          <template v-else-if="doctorResult">
            <div class="doctor-meta">
              <div class="doctor-meta__row">
                <span class="doctor-meta__label">core/</span>
                <span class="doctor-meta__value info-row__value--mono">{{ doctorResult.modxCorePath || '—' }}</span>
              </div>
              <div class="doctor-meta__row">
                <span class="doctor-meta__label">Версия MODX</span>
                <span class="doctor-meta__value info-row__value--mono">{{ doctorResult.modxVersion || (site?.modxVersion || '—') }}</span>
              </div>
              <div class="doctor-meta__row">
                <span class="doctor-meta__label">config.inc.php</span>
                <span class="doctor-meta__value">
                  <span v-if="doctorResult.modxConfigOk" class="doctor-badge doctor-badge--ok">OK</span>
                  <span v-else class="doctor-badge doctor-badge--err">не найден</span>
                </span>
              </div>
            </div>

            <div v-if="!doctorResult.issues.length" class="doctor-empty">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20,6 9,17 4,12" /></svg>
              Проблем не обнаружено. Сайт здоров.
            </div>

            <div v-else class="doctor-issues">
              <div
                v-for="issue in doctorResult.issues"
                :key="issue.id"
                class="doctor-issue"
                :class="`doctor-issue--${issue.level}`"
              >
                <div class="doctor-issue__header">
                  <span class="doctor-issue__level">{{ doctorLevelLabel(issue.level) }}</span>
                  <span class="doctor-issue__title">{{ issue.title }}</span>
                </div>
                <p class="doctor-issue__desc">{{ issue.description }}</p>
                <details v-if="issue.details && issue.details.length" class="doctor-issue__details">
                  <summary>Детали ({{ issue.details.length }})</summary>
                  <ul>
                    <li v-for="(d, i) in issue.details" :key="i" class="info-row__value--mono">{{ d }}</li>
                  </ul>
                </details>
                <div v-if="issue.fix" class="doctor-issue__actions">
                  <button
                    class="doctor-fix-btn"
                    :disabled="doctorFixingId === issue.id || doctorFixingId !== null"
                    @click="runDoctorFix(issue)"
                  >
                    <span v-if="doctorFixingId === issue.id" class="spinner-small" />
                    {{ doctorFixingId === issue.id ? 'Применяю…' : doctorFixLabel(issue.fix) }}
                  </button>
                </div>
              </div>
            </div>
          </template>

          <div class="modal__actions">
            <button class="modal__btn modal__btn--cancel" @click="closeDoctorModal">Закрыть</button>
            <button
              v-if="!doctorLoading"
              class="modal__btn"
              style="background: linear-gradient(135deg,#60a5fa,#2563eb); color:#fff; border-color:transparent;"
              :disabled="doctorFixingId !== null"
              @click="runDoctor"
            >
              {{ doctorResult ? 'Перезапустить проверку' : 'Запустить проверку' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { copyToClipboard } from '~/utils/clipboard';

definePageMeta({ middleware: 'auth' });

interface SiteAlias {
  domain: string;
  redirect: boolean;
}

interface SiteDetail {
  id: string;
  name: string;
  displayName?: string | null;
  domain: string;
  // API после маппинга отдаёт массив объектов. Для старых ответов (если сервер
  // ещё не задеплоен) поддерживаем и строковый формат.
  aliases: Array<SiteAlias | string>;
  type: string;
  status: string;
  phpVersion: string | null;
  appPort: number | null;
  rootPath: string;
  filesRelPath?: string | null;
  nginxConfigPath: string;
  systemUser: string | null;
  cmsAdminUser?: string | null;
  managerPath?: string | null;
  modxVersion?: string | null;
  gitRepository: string | null;
  deployBranch: string | null;
  envVars: Record<string, string>;
  errorMessage?: string | null;
  /**
   * JSON-строка с произвольной мета-инфой о сайте. hostpanel-миграция
   * пишет сюда `requiresSslReissue: true` — UI показывает баннер
   * «после переключения DNS перевыпусти SSL» (spec §9.4).
   */
  metadata?: string | null;
  createdAt: string;
  sslCertificate: {
    status: string;
    expiresAt: string | null;
    /** SAN-домены, реально покрытые сертификатом. Массив после mapSsl на бэке. */
    domains?: string[];
  } | null;
  databases: Array<{
    id: string;
    name: string;
    type: string;
    sizeBytes: number;
  }>;
  _count?: {
    deployLogs: number;
    backups: number;
    cronJobs: number;
  };
}

const route = useRoute();
const router = useRouter();
const api = useApi();
const serverStore = useServerStore();
const { terminalOpen, terminalInput, terminalResize, terminalClose, onTerminalData, onBackupProgress, onBackupRestoreProgress } = useSocket();

const siteId = route.params.id as string;
const site = ref<SiteDetail | null>(null);
const loading = ref(true);

/**
 * Баннер «после переключения DNS перевыпусти SSL» (spec §9.4) — показываем,
 * если в `Site.metadata.requiresSslReissue === true` и оператор не нажал
 * «Скрыть» (флаг хранится в localStorage по siteId).
 */
const hostpanelBannerDismissed = ref(false);
const hostpanelMigrationBanner = computed(() => {
  if (!site.value?.metadata) return false;
  if (hostpanelBannerDismissed.value) return false;
  try {
    const meta = JSON.parse(site.value.metadata) as Record<string, unknown>;
    if (meta.importedFrom !== 'hostpanel') return false;
    if (meta.requiresSslReissue !== true) return false;
    return true;
  } catch {
    return false;
  }
});
function dismissHostpanelBanner() {
  if (!site.value) return;
  try {
    localStorage.setItem(`hp-banner-dismissed-${site.value.id}`, '1');
  } catch {
    /* ignore quota / disabled storage */
  }
  hostpanelBannerDismissed.value = true;
}

/**
 * Перезагрузка карточки сайта после CRUD-операций над БД (компонент
 * SiteDatabasesTab эмитит `changed` после create/delete/reset). Дёргаем
 * именно этот эндпоинт, чтобы таб-каунтер на «Базы данных» обновился без
 * полной навигации. Best-effort — ошибки игнорируем.
 */
async function reloadSiteAfterDbChange() {
  try {
    site.value = await api.get<SiteDetail>(`/sites/${siteId}`);
  } catch {
    /* свежих данных нет — пользователь увидит счётчик после следующей загрузки */
  }
}
const activeTab = useTabQuery(
  ['overview', 'domains', 'files', 'logs', 'databases', 'ssl', 'dns', 'backups', 'cron', 'nginx', 'php', 'env', 'deploy', 'services', 'danger'],
  'overview',
);
// Старая raw-textarea убрана — вкладка Nginx теперь рендерится компонентом
// SiteNginxTab (web/components/SiteNginxTab.vue), он сам грузит/сохраняет
// настройки через /sites/:id/nginx/{settings,custom,test,reload}.

// ─── PHP-FPM pool custom config ───
const phpPoolCustom = ref('');
const phpPoolCustomOriginal = ref('');
const phpPoolRendered = ref<string | null>(null);
const phpPoolSaving = ref(false);
const phpPoolLoading = ref(false);
const phpPoolError = ref('');
const phpPoolSuccess = ref('');
const phpPoolDirty = computed(() => phpPoolCustom.value !== phpPoolCustomOriginal.value);
const deleting = ref(false);
const showDeleteModal = ref(false);
const deleteConfirmInput = ref('');
const sshPassword = ref<string | null>(null);
const sshPasswordVisible = ref(false);
const cmsPassword = ref<string | null>(null);
const cmsPasswordVisible = ref(false);

// SSH password change modal
const showSshPasswordModal = ref(false);
const sshPasswordInput = ref('');
const sshPasswordSaving = ref(false);
const sshPasswordError = ref('');
const sshPasswordNewValue = ref('');

// MODX admin password change modal
const showCmsAdminPasswordModal = ref(false);
const cmsAdminPasswordInput = ref('');
const cmsAdminPasswordSaving = ref(false);
const cmsAdminPasswordError = ref('');
const cmsAdminPasswordNewValue = ref('');

// MODX version update modal
const showModxUpdateModal = ref(false);
const modxTargetVersion = ref('');
const modxUpdating = ref(false);
const modxUpdateError = ref('');
const modxUpdateSuccess = ref('');

// Версии MODX тянем с бэка (ModxVersionsService → GitHub releases API, кеш 1ч).
// Хардкод ниже — фолбэк на случай если эндпоинт ещё не ответил при первом рендере.
// Актуальные latest-версии синхронизированы с shared/src/constants.ts.
const MODX_VERSIONS_FALLBACK_REVO: Array<{ value: string; label: string }> = [
  { value: '2.8.8-pl', label: 'MODX Revolution 2.8.8 (latest)' },
];
const MODX_VERSIONS_FALLBACK_3: Array<{ value: string; label: string }> = [
  { value: '3.1.2-pl', label: 'MODX 3.1.2 (latest)' },
];

const isModxSite = computed(() => site.value?.type === 'MODX_REVO' || site.value?.type === 'MODX_3');
const modxRevoVersions = ref<Array<{ value: string; label: string }>>([...MODX_VERSIONS_FALLBACK_REVO]);
const modx3Versions = ref<Array<{ value: string; label: string }>>([...MODX_VERSIONS_FALLBACK_3]);
const modxVersionsLoading = ref(false);
const modxAvailableVersions = computed(() => {
  return site.value?.type === 'MODX_3' ? modx3Versions.value : modxRevoVersions.value;
});

async function loadModxVersions(forceRefresh = false) {
  if (modxVersionsLoading.value) return;
  modxVersionsLoading.value = true;
  try {
    const res = await api.get<{
      revo: Array<{ value: string; label: string; isLatest: boolean }>;
      modx3: Array<{ value: string; label: string; isLatest: boolean }>;
      source: 'github' | 'fallback';
    }>(`/sites/modx-versions${forceRefresh ? '?refresh=1' : ''}`);
    if (res?.revo?.length) modxRevoVersions.value = res.revo.map((v) => ({ value: v.value, label: v.label }));
    if (res?.modx3?.length) modx3Versions.value = res.modx3.map((v) => ({ value: v.value, label: v.label }));
  } catch { /* остаёмся на fallback */ }
  finally {
    modxVersionsLoading.value = false;
  }
}

// Domains management
const domainAliases = ref<SiteAlias[]>([]);
const newAlias = ref('');
const savingDomains = ref(false);

// Edit main domain modal
const showEditMainDomain = ref(false);
const editMainDomainValue = ref('');
const editMainDomainError = ref('');
const savingMainDomain = ref(false);

// Edit filesRelPath modal (web-root внутри homedir).
// Меняет nginx root + (если есть PHP) пересобирает FPM pool — оба идут на агента
// сразу при сохранении. Папку на диске панель НЕ переносит — это на совести админа.
const showEditFilesRelPath = ref(false);
const editFilesRelPathValue = ref('');
const editFilesRelPathError = ref('');
const savingFilesRelPath = ref(false);

/** Нормализатор: API может вернуть и string[], и объекты {domain,redirect}. */
function normalizeAliases(raw: Array<SiteAlias | string> | null | undefined): SiteAlias[] {
  if (!Array.isArray(raw)) return [];
  const out: SiteAlias[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item === 'string') {
      const d = item.trim();
      if (d && !seen.has(d)) { seen.add(d); out.push({ domain: d, redirect: false }); }
    } else if (item && typeof item === 'object' && typeof item.domain === 'string') {
      const d = item.domain.trim();
      if (d && !seen.has(d)) { seen.add(d); out.push({ domain: d, redirect: item.redirect === true }); }
    }
  }
  return out;
}

const aliasesSummary = computed(() => {
  return normalizeAliases(site.value?.aliases)
    .map((a) => (a.redirect ? `${a.domain} →` : a.domain))
    .join(', ');
});

const sslAliasesCount = computed(() => {
  // В SAN идут ВСЕ алиасы (включая redirect — иначе TLS-handshake падает с
  // cert-mismatch до того, как nginx успеет вернуть 301).
  return normalizeAliases(site.value?.aliases).length;
});

/**
 * Есть ли у сайта активный сертификат. Нужно, чтобы иконки "в сертификате/нет"
 * показывались только когда сертификат реально выпущен (иначе показывать
 * "не в сертификате" бессмысленно — у сайта серта вообще нет).
 */
const hasActiveCert = computed(() => {
  const s = site.value?.sslCertificate?.status;
  return s === 'ACTIVE' || s === 'EXPIRING_SOON' || s === 'EXPIRED';
});

/** Set доменов, покрытых текущим сертификатом (lowercase для сравнения). */
const certDomainsLower = computed(() => {
  const arr = site.value?.sslCertificate?.domains || [];
  return new Set(arr.map((d) => d.toLowerCase()));
});

/**
 * Статус покрытия домена сертификатом:
 *  - 'covered'      — в SAN
 *  - 'missing'      — сертификат есть, но домен не покрыт
 *  - 'no-cert'      — у сайта нет серта вообще, показывать нечего
 *
 * Redirect-алиасы тоже должны быть в SAN: TLS-handshake происходит ДО того,
 * как nginx может вернуть 301 — иначе браузер ругается на cert-mismatch.
 */
type CertCoverage = 'covered' | 'missing' | 'no-cert';
function coverageFor(domain: string, _isRedirectAlias = false): CertCoverage {
  if (!hasActiveCert.value) return 'no-cert';
  return certDomainsLower.value.has(domain.toLowerCase()) ? 'covered' : 'missing';
}

/** Список ВСЕХ алиасов (вкл. redirect), не покрытых текущим сертификатом. */
const missingAliasesInCert = computed(() => {
  if (!hasActiveCert.value) return [] as string[];
  return domainAliases.value
    .filter((a) => !certDomainsLower.value.has(a.domain.toLowerCase()))
    .map((a) => a.domain);
});
/** Основной домен не в сертификате (редкий, но возможный случай после смены домена). */
const mainDomainMissingInCert = computed(() => {
  if (!hasActiveCert.value || !site.value?.domain) return false;
  return !certDomainsLower.value.has(site.value.domain.toLowerCase());
});

// SSL upload
const sslCertPem = ref('');
const sslKeyPem = ref('');
const sslChainPem = ref('');
const uploadingSsl = ref(false);
const issuingSsl = ref(false);
const sslIssueError = ref('');
const sslProgress = ref('');
const sslElapsed = ref(0);
let sslElapsedTimer: ReturnType<typeof setInterval> | undefined;

// Deploy state
const deploying = ref(false);
const deployLogs = ref<Array<{
  id: string;
  status: string;
  branch: string;
  commitSha: string | null;
  commitMessage: string | null;
  durationMs: number | null;
  startedAt: string;
  completedAt: string | null;
}>>([]);
const activeDeployLog = ref<{
  id: string;
  status: string;
  branch: string;
  commitSha: string | null;
  commitMessage: string | null;
  output: string;
} | null>(null);
const activeDeployOutput = ref('');
const logContainer = ref<HTMLElement | null>(null);
const rollingBack = ref<string | null>(null);

const typeLabels: Record<string, string> = {
  MODX_REVO: 'MODX Revolution',
  MODX_3: 'MODX 3',
  CUSTOM: 'Пустой',
  // Legacy (не отображается в фильтрах, но встречается у старых записей):
  NUXT_3: 'Nuxt 3',
  REACT: 'React',
  NESTJS: 'NestJS',
  STATIC_HTML: 'Статика',
};

const typeLabel = computed(() => typeLabels[site.value?.type || ''] || site.value?.type || '');

const tabs = computed(() => [
  { id: 'overview', label: 'Обзор' },
  { id: 'domains', label: 'Домены' },
  { id: 'files', label: 'Файлы' },
  { id: 'logs', label: 'Логи' },
  { id: 'databases', label: 'Базы данных', count: site.value?.databases?.length || 0 },
  { id: 'ssl', label: 'SSL' },
  { id: 'dns', label: 'DNS' },
  { id: 'backups', label: 'Бэкапы', count: site.value?._count?.backups || 0 },
  { id: 'cron', label: 'Крон', count: site.value?._count?.cronJobs || 0 },
  { id: 'nginx', label: 'Nginx' },
  { id: 'php', label: 'PHP', hidden: !site.value?.phpVersion },
  { id: 'services', label: 'Сервисы' },
  { id: 'danger', label: 'Опасная зона' },
].filter((t: { hidden?: boolean }) => !t.hidden));

const envEntries = computed(() => {
  if (!site.value?.envVars) return [];
  return Object.entries(site.value.envVars);
});
const envShowValues = ref(false);
const envNewKey = ref('');
const envNewVal = ref('');
const envSaving = ref(false);
const envOriginal = ref('');
const envDirty = computed(() => JSON.stringify(site.value?.envVars || {}) !== envOriginal.value);

const sslLabel = computed(() => {
  const status = site.value?.sslCertificate?.status;
  const labels: Record<string, string> = {
    ACTIVE: 'Активен',
    EXPIRING_SOON: 'Скоро истекает',
    EXPIRED: 'Истёк',
    PENDING: 'Ожидание',
    NONE: 'Не настроен',
  };
  return labels[status || ''] || status || 'Неизвестно';
});

const sslClass = computed(() => {
  const status = site.value?.sslCertificate?.status;
  if (status === 'ACTIVE') return 'ssl-active';
  if (status === 'EXPIRING_SOON') return 'ssl-warning';
  if (status === 'EXPIRED') return 'ssl-error';
  return '';
});

const sshHost = computed(() => {
  if (typeof window !== 'undefined') {
    return window.location.hostname;
  }
  return 'server';
});

async function toggleSshPassword() {
  if (sshPassword.value) {
    sshPasswordVisible.value = !sshPasswordVisible.value;
    return;
  }
  try {
    const res = await api.get<{ password: string; username: string; host: string; port: number }>(`/sites/${siteId}/ssh`);
    sshPassword.value = res?.password || null;
    sshPasswordVisible.value = true;
  } catch {
    sshPassword.value = null;
  }
}

async function copySshCommand() {
  if (!site.value?.systemUser) return;
  const cmd = `ssh -p 22 ${site.value.systemUser}@${sshHost.value}`;
  await copyToClipboard(cmd);
}

function closeSshPasswordModal() {
  showSshPasswordModal.value = false;
  sshPasswordInput.value = '';
  sshPasswordError.value = '';
  sshPasswordNewValue.value = '';
}

async function submitSshPasswordChange() {
  sshPasswordError.value = '';
  const pwd = sshPasswordInput.value.trim();
  if (pwd && pwd.length < 12) {
    sshPasswordError.value = 'Минимум 12 символов';
    return;
  }
  sshPasswordSaving.value = true;
  try {
    const res = await api.post<{ password: string }>(`/sites/${siteId}/ssh-password`, {
      password: pwd || undefined,
    });
    sshPasswordNewValue.value = res?.password || '';
    // Обновим видимый пароль в info-card
    sshPassword.value = res?.password || null;
    sshPasswordVisible.value = true;
  } catch (e) {
    const msg = (e as Error)?.message || 'Не удалось сменить пароль';
    sshPasswordError.value = msg;
  } finally {
    sshPasswordSaving.value = false;
  }
}

// ─── MODX admin password change ───
function openCmsAdminPasswordModal() {
  cmsAdminPasswordInput.value = '';
  cmsAdminPasswordError.value = '';
  cmsAdminPasswordNewValue.value = '';
  showCmsAdminPasswordModal.value = true;
}

function closeCmsAdminPasswordModal() {
  if (cmsAdminPasswordSaving.value) return;
  showCmsAdminPasswordModal.value = false;
  cmsAdminPasswordInput.value = '';
  cmsAdminPasswordError.value = '';
  cmsAdminPasswordNewValue.value = '';
}

async function submitCmsAdminPasswordChange() {
  cmsAdminPasswordError.value = '';
  const pwd = cmsAdminPasswordInput.value.trim();
  if (pwd) {
    if (pwd.length < 8) {
      cmsAdminPasswordError.value = 'Минимум 8 символов';
      return;
    }
    if (pwd.length > 128) {
      cmsAdminPasswordError.value = 'Максимум 128 символов';
      return;
    }
    if (!/^[!-~]+$/.test(pwd)) {
      cmsAdminPasswordError.value = 'Только printable ASCII без пробелов';
      return;
    }
  }
  cmsAdminPasswordSaving.value = true;
  try {
    const res = await api.post<{ password: string }>(`/sites/${siteId}/cms-admin-password`, {
      password: pwd || undefined,
    });
    cmsAdminPasswordNewValue.value = res?.password || '';
    // Обновляем видимый пароль в info-card.
    cmsPassword.value = res?.password || null;
    cmsPasswordVisible.value = true;
  } catch (e) {
    cmsAdminPasswordError.value = (e as Error)?.message || 'Не удалось сменить пароль';
  } finally {
    cmsAdminPasswordSaving.value = false;
  }
}

// ─── MODX version update ───
async function openModxUpdateModal() {
  modxUpdateError.value = '';
  modxUpdateSuccess.value = '';
  showModxUpdateModal.value = true;
  // Подтягиваем актуальный список релизов из GitHub (кеш на бэке 1ч — почти всегда мгновенно).
  await loadModxVersions();
  // Preselect latest поддерживаемой major-ветки.
  const list = modxAvailableVersions.value;
  modxTargetVersion.value = list[0]?.value || '';
}

function closeModxUpdateModal() {
  if (modxUpdating.value) return;
  showModxUpdateModal.value = false;
  modxUpdateError.value = '';
  modxUpdateSuccess.value = '';
}

async function submitModxUpdate() {
  if (!modxTargetVersion.value || !site.value) return;
  modxUpdateError.value = '';
  modxUpdateSuccess.value = '';
  modxUpdating.value = true;
  try {
    const res = await api.post<{ version: string; previousVersion: string | null }>(
      `/sites/${siteId}/update-modx`,
      { targetVersion: modxTargetVersion.value },
    );
    modxUpdateSuccess.value = res?.version || modxTargetVersion.value;
    if (site.value) site.value.modxVersion = res?.version || modxTargetVersion.value;
  } catch (e) {
    modxUpdateError.value = (e as Error)?.message || 'Не удалось обновить MODX';
  } finally {
    modxUpdating.value = false;
  }
}

// ─── Открытие БД в Adminer ────────────────────────────────────────────
const openingAdminer = ref<string | null>(null);
const adminerPickerOpen = ref(false);

async function openAdminer(dbId: string) {
  if (openingAdminer.value) return;
  openingAdminer.value = dbId;
  // Open blank tab synchronously, чтобы popup-blocker не зарезал.
  const win = window.open('about:blank', '_blank');
  try {
    const data = await api.post<{ url: string }>(`/databases/${dbId}/adminer-ticket`, {});
    if (!data?.url) throw new Error('SSO endpoint вернул пустой URL');
    if (win) win.location.href = data.url;
    else window.location.href = data.url;
  } catch (e) {
    if (win) win.close();
    useMbToast().error((e as Error)?.message || 'Не удалось открыть Adminer');
  } finally {
    openingAdminer.value = null;
  }
}

function onPickAdminer(dbId: string) {
  adminerPickerOpen.value = false;
  openAdminer(dbId);
}

// ─── Утилиты: нормализация прав ───────────────────────────────────────
const normalizingPerms = ref(false);
const normalizePermsResult = ref<{ stepCount: number; error?: string } | null>(null);

const normalizePermsHint =
  'Чинит chown/chmod рекурсивно по правилу: owner=systemUser, dirs=0750, files=0640, +x — только для каталогов и уже-исполняемых файлов. Безопасно для node_modules/.bin (бинарники сохранят exec). Для MODX расширяет cache/export/packages до g+w.';

async function onNormalizePermissions() {
  if (normalizingPerms.value || !site.value) return;
  const ok = await useMbConfirm().ask({
    title: 'Нормализация прав и владельца',
    message:
      `Запустить нормализацию прав и владельца для сайта «${site.value.name}»?\n\n` +
      'Операция безопасна (chmod использует символьный X — exec на бинарниках node_modules/.bin и shell-скриптах сохраняется). На больших сайтах может занять до минуты.',
    confirmText: 'Запустить',
    cancelText: 'Отмена',
  });
  if (!ok) return;

  normalizingPerms.value = true;
  normalizePermsResult.value = null;
  const toast = useMbToast();
  try {
    const res = await api.post<{ steps: Array<{ cmd: string; ok: boolean; error?: string }>; modxCorePath?: string }>(
      `/sites/${siteId}/normalize-permissions`,
      {},
    );
    const stepCount = res?.steps?.length || 0;
    normalizePermsResult.value = { stepCount };
    toast.success(`Нормализация завершена. Шагов выполнено: ${stepCount}.`);
  } catch (e) {
    const msg = (e as Error)?.message || 'Неизвестная ошибка';
    normalizePermsResult.value = { stepCount: 0, error: msg };
    toast.error(`Не удалось нормализовать права: ${msg}`);
  } finally {
    normalizingPerms.value = false;
  }
}

// ─── MODX Doctor ──────────────────────────────────────────────────────
interface DoctorIssue {
  id: string;
  level: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  details?: string[];
  fix?: 'normalize-permissions' | 'cleanup-setup-dir' | null;
}
interface DoctorResult {
  modxCorePath?: string;
  modxVersion?: string;
  modxConfigOk: boolean;
  issues: DoctorIssue[];
}

const showDoctorModal = ref(false);
const doctorLoading = ref(false);
const doctorError = ref('');
const doctorResult = ref<DoctorResult | null>(null);
const doctorFixingId = ref<string | null>(null);

async function openModxDoctor() {
  showDoctorModal.value = true;
  doctorError.value = '';
  // Если уже был результат — оставим его, не перезапускаем автоматически
  // (юзер может ткнуть «Перезапустить проверку»). При первом открытии — гоним.
  if (!doctorResult.value) {
    await runDoctor();
  }
}

function closeDoctorModal() {
  if (doctorFixingId.value !== null) return; // не закрываем посреди fix'а
  showDoctorModal.value = false;
}

async function runDoctor() {
  doctorLoading.value = true;
  doctorError.value = '';
  try {
    const res = await api.get<DoctorResult>(`/sites/${siteId}/modx-doctor`);
    doctorResult.value = res;
  } catch (e) {
    doctorError.value = (e as Error)?.message || 'Не удалось запустить диагностику';
  } finally {
    doctorLoading.value = false;
  }
}

async function runDoctorFix(issue: DoctorIssue) {
  if (!issue.fix) return;
  const toast = useMbToast();

  // Подтверждение fix'а через кастомный диалог.
  const confirmMsg =
    issue.fix === 'normalize-permissions'
      ? 'Применить «Нормализация прав и владельца» к этому сайту?'
      : issue.fix === 'cleanup-setup-dir'
      ? 'Удалить директорию setup/? Установщик MODX будет недоступен через web.'
      : 'Применить исправление?';
  const ok = await useMbConfirm().ask({
    title: doctorFixLabel(issue.fix),
    message: confirmMsg,
    confirmText: 'Применить',
    cancelText: 'Отмена',
    danger: issue.fix === 'cleanup-setup-dir',
  });
  if (!ok) return;

  doctorFixingId.value = issue.id;
  try {
    if (issue.fix === 'normalize-permissions') {
      await api.post(`/sites/${siteId}/normalize-permissions`, {});
      toast.success('Права нормализованы.');
    } else if (issue.fix === 'cleanup-setup-dir') {
      await api.post(`/sites/${siteId}/cleanup-setup-dir`, {});
      toast.success('Директория setup/ удалена.');
    }
    // Перезапускаем диагностику, чтобы пользователь увидел, что issue ушёл.
    await runDoctor();
  } catch (e) {
    const msg = (e as Error)?.message || 'Не удалось применить fix';
    doctorError.value = msg;
    toast.error(msg);
  } finally {
    doctorFixingId.value = null;
  }
}

function doctorLevelLabel(level: 'critical' | 'warning' | 'info'): string {
  if (level === 'critical') return 'Критично';
  if (level === 'warning') return 'Внимание';
  return 'Инфо';
}

function doctorFixLabel(fix: NonNullable<DoctorIssue['fix']>): string {
  if (fix === 'normalize-permissions') return 'Нормализовать права';
  if (fix === 'cleanup-setup-dir') return 'Удалить setup/';
  return 'Починить';
}

async function toggleCmsPassword() {
  if (cmsPassword.value) {
    cmsPasswordVisible.value = !cmsPasswordVisible.value;
    return;
  }
  try {
    const res = await api.get<{ cms?: { user: string; password: string; url: string } }>(`/sites/${siteId}/ssh`);
    cmsPassword.value = res?.cms?.password || null;
    cmsPasswordVisible.value = true;
  } catch {
    cmsPassword.value = null;
  }
}

// Нормализуем managerPath: MODX разрешает кастомный путь до /manager/
// (например, /cp/ или /admin-xyz/). В UI и в auto-login должна быть
// именно кастомная папка, иначе 404.
const managerPathSafe = computed(() => {
  const raw = (site.value?.managerPath || 'manager').toString();
  // Сносим любые слеши по краям — URL строится как `/${managerPathSafe}/`.
  return raw.replace(/^\/+|\/+$/g, '') || 'manager';
});

const cmsAutoLoginBusy = ref(false);

/**
 * Открываем админку MODX с автологином.
 *
 * Почему не просто GET + кликать кнопку? MODX 3 manager — это обычная
 * HTML-форма на POST /{managerPath}/ с полями username + password
 * (+ login_context=mgr). Если в новой вкладке сделать HTML-form.submit() —
 * браузер отправит запрос, MODX создаст сессию, вернёт 302 на дашборд.
 *
 * Подводные камни (с которыми мы живём сознательно):
 *  • Пароль лежит в DOM и в POST body. Для своего dashboard-а это
 *    приемлемо — юзер уже видит пароль во вкладке «Обзор» руками.
 *  • Refresh открывшейся вкладки покажет «Отправить данные повторно?» —
 *    это редкий кейс, юзер просто отклонит и зайдёт через обычный UI.
 *  • CSRF: форма логина MODX не требует CSRF-токена (иначе нельзя было
 *    бы логиниться извне). Защищены уже ACTIONS внутри админки, не логин.
 */
async function openCmsAdmin() {
  if (!site.value?.domain || !site.value?.cmsAdminUser) return;

  // Нужен пароль. Если уже загружен — используем; иначе тянем с API.
  let password = cmsPassword.value;
  if (!password) {
    cmsAutoLoginBusy.value = true;
    try {
      const res = await api.get<{ cms?: { user: string; password: string; url: string } }>(
        `/sites/${siteId}/ssh`,
      );
      password = res?.cms?.password || null;
      if (!password) {
        // Нет пароля в системе — откроем форму без автологина.
        const schemeNP = site.value?.sslCertificate?.status === 'ACTIVE' ? 'https' : 'http';
        window.open(`${schemeNP}://${site.value.domain}/${managerPathSafe.value}/`, '_blank', 'noopener,noreferrer');
        return;
      }
      cmsPassword.value = password;
    } catch {
      // Если API отвалился — хотя бы откроем обычный URL.
      const schemeErr = site.value?.sslCertificate?.status === 'ACTIVE' ? 'https' : 'http';
      window.open(`${schemeErr}://${site.value.domain}/${managerPathSafe.value}/`, '_blank', 'noopener,noreferrer');
      return;
    } finally {
      cmsAutoLoginBusy.value = false;
    }
  }

  const scheme = site.value?.sslCertificate?.status === 'ACTIVE' ? 'https' : 'http';
  const action = `${scheme}://${site.value.domain}/${managerPathSafe.value}/`;

  // Создаём одноразовую форму, target=_blank — откроется в новой вкладке.
  // После submit удаляем её из DOM, чтобы не болталась.
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = action;
  form.target = '_blank';
  // Явный rel="noopener noreferrer" — для form Chrome/Firefox НЕ ставят
  // noopener по умолчанию (в отличие от <a target=_blank>). Без этого
  // открытое окно может через window.opener.location перенаправить
  // нашу панель на фишинг-страницу.
  form.rel = 'noopener noreferrer';
  form.style.display = 'none';
  form.enctype = 'application/x-www-form-urlencoded';

  const addField = (name: string, value: string) => {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  };
  // Полный набор полей, который ждёт manager/index.php при логине MODX:
  //   username, password        — очевидно
  //   login_context=mgr         — контекст (иначе роутит на фронт)
  //   rememberme=1              — иначе сессия мрёт через ~20 минут idle
  //   login=1                   — маркер что это именно сабмит формы логина
  //   modhash                   — пустая строка, MODX сверяет хеш поля, но
  //                                пустое значение = «без hash» (и это ок)
  //   returnUrl=/{managerPath}/ — куда редиректить после успешного логина;
  //                                без него MODX может кидать на / вместо /manager/
  const mgr = managerPathSafe.value;
  addField('username', site.value.cmsAdminUser);
  addField('password', password);
  addField('login_context', 'mgr');
  addField('rememberme', '1');
  addField('login', '1');
  addField('modhash', '');
  addField('returnUrl', `/${mgr}/`);

  document.body.appendChild(form);
  try {
    form.submit();
  } finally {
    // Чуть подождём чтобы submit стартовал, потом убираем форму.
    setTimeout(() => form.remove(), 1000);
  }
}

// ─── PHP Version ───
// Список доступен динамически — тот же, что и на /php (только реально
// установленные FPM-пулы). Хардкод раньше был [7.4, 8.0–8.3] — и на сервере,
// где доустановили 8.4 / снесли 7.4, дропдаун врал. Фолбэк = SUPPORTED_PHP_VERSIONS
// из shared (агент так же). Загружаем в onMounted через loadInstalledPhpVersions().
const phpVersions = ref<string[]>(['8.4', '8.3', '8.2', '8.1', '8.0', '7.4']);
const phpVersionChanging = ref(false);

async function loadInstalledPhpVersions() {
  try {
    const versions = await api.get<string[]>('/php/versions');
    if (Array.isArray(versions) && versions.length) {
      // sort: 8.4, 8.3, ..., 7.4 (свежие сверху, как в /php).
      phpVersions.value = [...versions].sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true }),
      );
      // Если у сайта стоит версия, которой больше нет в списке (например,
      // источник на 7.2, а на этой машине 7.2 не установлен) — добавляем
      // её в список с пометкой, чтобы select мог корректно отрендерить.
      if (site.value?.phpVersion && !phpVersions.value.includes(site.value.phpVersion)) {
        phpVersions.value = [site.value.phpVersion, ...phpVersions.value];
      }
    }
  } catch {
    /* keep fallback */
  }
}

async function changePhpVersion(newVersion: string) {
  if (!site.value || newVersion === site.value.phpVersion) return;
  phpVersionChanging.value = true;
  try {
    await api.put(`/sites/${siteId}`, { phpVersion: newVersion });
    site.value.phpVersion = newVersion;
  } catch {
    // revert dropdown on error
  } finally {
    phpVersionChanging.value = false;
  }
}

// ─── Site Terminal ───
const showSiteTerminal = ref(false);
const siteTerminalContainer = ref<HTMLElement | null>(null);
let siteTermSessionId: string | null = null;
let siteTermXterm: unknown = null;
let siteTermDataCleanup: (() => void) | null = null;

async function openSiteTerminal() {
  if (!site.value?.systemUser) return;
  showSiteTerminal.value = true;

  await nextTick();
  if (!siteTerminalContainer.value) return;

  try {
    const { Terminal } = await import('xterm');
    const { FitAddon } = await import('xterm-addon-fit');
    await import('xterm/css/xterm.css');

    const fitAddon = new FitAddon();
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
      theme: { background: '#0d0d0d', foreground: '#e0e0e0', cursor: 'var(--primary-light)' },
      scrollback: 5000,
    });

    term.loadAddon(fitAddon);
    term.open(siteTerminalContainer.value);
    fitAddon.fit();

    siteTermXterm = term;

    const { sessionId } = await terminalOpen(site.value.systemUser);
    siteTermSessionId = sessionId;

    siteTermDataCleanup = onTerminalData(({ sessionId: sid, data }) => {
      if (sid === siteTermSessionId) {
        term.write(data);
      }
    });

    term.onData((data: string) => {
      if (siteTermSessionId) terminalInput(siteTermSessionId, data);
    });

    term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      if (siteTermSessionId) terminalResize(siteTermSessionId, cols, rows);
    });

    const ro = new ResizeObserver(() => fitAddon.fit());
    ro.observe(siteTerminalContainer.value);
  } catch {
    // Terminal init failed
  }
}

function closeSiteTerminal() {
  if (siteTermSessionId) {
    terminalClose(siteTermSessionId);
    siteTermSessionId = null;
  }
  if (siteTermDataCleanup) {
    siteTermDataCleanup();
    siteTermDataCleanup = null;
  }
  if (siteTermXterm && typeof (siteTermXterm as { dispose: () => void }).dispose === 'function') {
    (siteTermXterm as { dispose: () => void }).dispose();
    siteTermXterm = null;
  }
  showSiteTerminal.value = false;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('ru-RU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function maskEnvValue(val: string): string {
  if (val.length <= 4) return '****';
  return val.slice(0, 2) + '*'.repeat(Math.min(val.length - 4, 16)) + val.slice(-2);
}

function addEnvVar() {
  const key = envNewKey.value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (!key || !site.value) return;
  site.value.envVars = { ...site.value.envVars, [key]: envNewVal.value };
  envNewKey.value = '';
  envNewVal.value = '';
}

function removeEnvVar(key: string) {
  if (!site.value?.envVars) return;
  const copy = { ...site.value.envVars };
  delete copy[key];
  site.value.envVars = copy;
}

async function saveEnvVars() {
  if (!site.value || envSaving.value) return;
  envSaving.value = true;
  try {
    await api.put(`/sites/${siteId}`, { envVars: site.value.envVars });
    envOriginal.value = JSON.stringify(site.value.envVars);
  } catch {
    // Save failed
  } finally {
    envSaving.value = false;
  }
}

// --- SSL revoke + import ---
const revokingSsl = ref(false);
const importingSsl = ref(false);
const sslActionError = ref('');
const sslActionSuccess = ref('');
const sslImportError = ref('');
// ACTIVE / EXPIRING_SOON / EXPIRED — значит серт выпущен, можно отозвать.
// PENDING / NONE / FAILED — отзывать нечего, предлагаем импорт.
const sslCanRevoke = computed(() => {
  const st = site.value?.sslCertificate?.status;
  return st === 'ACTIVE' || st === 'EXPIRING_SOON' || st === 'EXPIRED';
});

async function revokeSsl() {
  if (revokingSsl.value) return;
  const ok = await useMbConfirm().ask({
    title: 'Отзыв SSL-сертификата',
    message: 'Отозвать сертификат? Он будет revoke\'нут в Let\'s Encrypt и удалён с диска.',
    confirmText: 'Отозвать',
    danger: true,
  });
  if (!ok) return;
  revokingSsl.value = true;
  sslActionError.value = '';
  sslActionSuccess.value = '';
  try {
    const r = await api.post<{ data?: { revoked: boolean; warning: string | null } }>(
      `/sites/${siteId}/ssl/revoke`, {},
    );
    sslActionSuccess.value = r?.data?.warning || 'Сертификат отозван, сайт переключён на HTTP';
    site.value = await api.get<SiteDetail>(`/sites/${siteId}`);
  } catch (err: unknown) {
    sslActionError.value = (err as Error).message || 'Ошибка отзыва';
  } finally {
    revokingSsl.value = false;
  }
}

async function importSsl() {
  if (importingSsl.value) return;
  importingSsl.value = true;
  sslImportError.value = '';
  try {
    await api.post(`/sites/${siteId}/ssl/import`, {});
    site.value = await api.get<SiteDetail>(`/sites/${siteId}`);
  } catch (err: unknown) {
    sslImportError.value = (err as Error).message || 'Не удалось импортировать сертификат';
  } finally {
    importingSsl.value = false;
  }
}

async function issueLetsEncrypt() {
  if (issuingSsl.value) return;
  issuingSsl.value = true;
  sslIssueError.value = '';
  sslProgress.value = 'Отправка запроса агенту...';
  sslElapsed.value = 0;
  sslElapsedTimer = setInterval(() => {
    sslElapsed.value++;
    if (sslElapsed.value === 3) {
      sslProgress.value = 'Ожидание certbot (может занять до 2 минут)...';
    }
  }, 1000);
  try {
    await api.post(`/sites/${siteId}/ssl/issue`, {});
    sslProgress.value = 'Сертификат успешно выпущен';
    site.value = await api.get<SiteDetail>(`/sites/${siteId}`);
    setTimeout(() => { sslProgress.value = ''; }, 3000);
  } catch (err: unknown) {
    sslIssueError.value = (err as Error).message || 'Ошибка выпуска сертификата';
    sslProgress.value = '';
  } finally {
    issuingSsl.value = false;
    clearInterval(sslElapsedTimer);
    sslElapsedTimer = undefined;
  }
}

async function uploadSsl() {
  if (!sslCertPem.value.trim() || !sslKeyPem.value.trim() || uploadingSsl.value) return;
  uploadingSsl.value = true;
  try {
    const body: Record<string, string> = {
      certPem: sslCertPem.value,
      keyPem: sslKeyPem.value,
    };
    if (sslChainPem.value.trim()) body.chainPem = sslChainPem.value;
    await api.post(`/sites/${siteId}/ssl/custom`, body);
    sslCertPem.value = '';
    sslKeyPem.value = '';
    sslChainPem.value = '';
    // Reload site to reflect new SSL status
    site.value = await api.get<SiteDetail>(`/sites/${siteId}`);
  } catch {
    // Upload failed
  } finally {
    uploadingSsl.value = false;
  }
}

// ─── Nginx ───
// Все операции с nginx-конфигами теперь обрабатывает компонент SiteNginxTab
// (web/components/SiteNginxTab.vue): поля настроек + редактор 95-custom.conf.
// Старые функции loadNginxConfig/testNginx/saveNginxConfig здесь больше не нужны.

// ─── PHP-FPM pool editor ───
async function loadPhpPoolConfig() {
  if (!site.value) return;
  // Очищаем закешированный конфиг ДО запроса — иначе при переключении на
  // вкладку виден старый custom/rendered блок, и юзер думает что сервер
  // не знает про его правки из прошлой сессии.
  phpPoolLoading.value = true;
  phpPoolError.value = '';
  phpPoolSuccess.value = '';
  phpPoolCustom.value = '';
  phpPoolCustomOriginal.value = '';
  phpPoolRendered.value = null;
  try {
    const res = await api.get<{ custom: string; rendered: string | null; phpVersion: string }>(
      `/sites/${siteId}/php-pool-config`,
    );
    phpPoolCustom.value = res.custom || '';
    phpPoolCustomOriginal.value = phpPoolCustom.value;
    phpPoolRendered.value = res.rendered;
  } catch (err: unknown) {
    phpPoolError.value = (err as Error).message || 'Не удалось загрузить PHP-конфиг';
  } finally {
    phpPoolLoading.value = false;
  }
}

async function savePhpPoolConfig() {
  if (!site.value || phpPoolSaving.value) return;
  phpPoolSaving.value = true;
  phpPoolError.value = '';
  phpPoolSuccess.value = '';
  try {
    const res = await api.put<{ custom: string }>(
      `/sites/${siteId}/php-pool-config`,
      { custom: phpPoolCustom.value },
    );
    phpPoolCustom.value = res.custom || '';
    phpPoolCustomOriginal.value = phpPoolCustom.value;
    phpPoolSuccess.value = 'Кастомный PHP-конфиг сохранён, php-fpm перезагружен';
    // Перечитываем рендер — увидеть, что custom-блок реально попал в файл.
    const re = await api.get<{ custom: string; rendered: string | null }>(
      `/sites/${siteId}/php-pool-config`,
    );
    phpPoolRendered.value = re.rendered;
  } catch (err: unknown) {
    phpPoolError.value = (err as Error).message || 'Не удалось сохранить PHP-конфиг';
  } finally {
    phpPoolSaving.value = false;
  }
}

async function saveDomainAliases() {
  savingDomains.value = true;
  try {
    // API принимает как string[], так и [{domain,redirect}]. Шлём новый формат.
    await api.put(`/sites/${siteId}`, { aliases: domainAliases.value });
    site.value = await api.get<SiteDetail>(`/sites/${siteId}`);
    domainAliases.value = normalizeAliases(site.value?.aliases);
  } catch {
    // revert из серверного источника истины
    domainAliases.value = normalizeAliases(site.value?.aliases);
  } finally {
    savingDomains.value = false;
  }
}

function addAlias() {
  const alias = newAlias.value.trim().toLowerCase();
  if (!alias || domainAliases.value.some((a) => a.domain === alias)) return;
  domainAliases.value.push({ domain: alias, redirect: false });
  newAlias.value = '';
  saveDomainAliases();
}

function removeAlias(idx: number) {
  domainAliases.value.splice(idx, 1);
  saveDomainAliases();
}

function toggleAliasRedirect(idx: number) {
  const a = domainAliases.value[idx];
  if (!a) return;
  // Оптимистичный апдейт + сохранение. На ошибке saveDomainAliases откатит.
  domainAliases.value[idx] = { ...a, redirect: !a.redirect };
  saveDomainAliases();
}

function openEditMainDomain() {
  editMainDomainValue.value = site.value?.domain || '';
  editMainDomainError.value = '';
  showEditMainDomain.value = true;
}

async function saveMainDomain() {
  if (!site.value) return;
  const next = editMainDomainValue.value.trim().toLowerCase();
  editMainDomainError.value = '';
  if (!next || next === site.value.domain) return;
  // Лёгкая клиентская валидация; серьёзная — на API.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(next)) {
    editMainDomainError.value = 'Невалидный домен';
    return;
  }
  savingMainDomain.value = true;
  try {
    await api.put(`/sites/${siteId}`, { domain: next });
    site.value = await api.get<SiteDetail>(`/sites/${siteId}`);
    domainAliases.value = normalizeAliases(site.value?.aliases);
    showEditMainDomain.value = false;
  } catch (err: unknown) {
    editMainDomainError.value = (err as Error).message || 'Не удалось сменить домен';
  } finally {
    savingMainDomain.value = false;
  }
}

function openEditFilesRelPath() {
  editFilesRelPathValue.value = site.value?.filesRelPath || 'www';
  editFilesRelPathError.value = '';
  showEditFilesRelPath.value = true;
}

async function saveFilesRelPath() {
  if (!site.value) return;
  const next = editFilesRelPathValue.value.trim();
  editFilesRelPathError.value = '';
  const current = site.value.filesRelPath || 'www';
  if (!next || next === current) return;
  // Клиентская валидация: без leading `/`, без `..`, только [A-Za-z0-9._-] в сегментах.
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(next)) {
    editFilesRelPathError.value = 'Допустимо: «www», «public_html», «www/public» — без слеша вначале и без «..»';
    return;
  }
  savingFilesRelPath.value = true;
  try {
    await api.put(`/sites/${siteId}`, { filesRelPath: next });
    site.value = await api.get<SiteDetail>(`/sites/${siteId}`);
    showEditFilesRelPath.value = false;
  } catch (err: unknown) {
    const e = err as { data?: { message?: string | string[] }; message?: string };
    const msg = e.data?.message;
    editFilesRelPathError.value = Array.isArray(msg)
      ? msg.join('; ')
      : (msg || e.message || 'Не удалось сменить папку');
  } finally {
    savingFilesRelPath.value = false;
  }
}

async function controlSite(action: string) {
  if (!site.value) return;
  try {
    await api.post(`/sites/${siteId}/${action}`);
    // Reload site data
    site.value = await api.get<SiteDetail>(`/sites/${siteId}`);
  } catch {
    // Silently handle — status will update on next fetch
  }
}

// ---------------------------------------------------------------------------
// Дублирование сайта
// ---------------------------------------------------------------------------
const duplicateDialog = reactive({
  open: false,
  name: '',
  displayName: '',
  domain: '',
  copyBackupConfigs: false,
  copyCronJobs: false,
  submitting: false,
  error: '',
});

function openDuplicateDialog() {
  if (!site.value) return;
  duplicateDialog.open = true;
  duplicateDialog.name = `${site.value.name}-copy`.substring(0, 32);
  duplicateDialog.displayName = site.value.displayName
    ? `${site.value.displayName} (копия)`
    : '';
  duplicateDialog.domain = '';
  duplicateDialog.copyBackupConfigs = false;
  duplicateDialog.copyCronJobs = false;
  duplicateDialog.submitting = false;
  duplicateDialog.error = '';
}

async function performDuplicate() {
  if (!site.value) return;
  if (!duplicateDialog.name || !duplicateDialog.domain) return;
  duplicateDialog.submitting = true;
  duplicateDialog.error = '';
  try {
    const res = await api.post<{ id: string }>(`/sites/${siteId}/duplicate`, {
      name: duplicateDialog.name.trim(),
      domain: duplicateDialog.domain.trim(),
      displayName: duplicateDialog.displayName?.trim() || undefined,
      copyBackupConfigs: duplicateDialog.copyBackupConfigs || undefined,
      copyCronJobs: duplicateDialog.copyCronJobs || undefined,
    });
    duplicateDialog.open = false;
    // Переходим на страницу нового сайта — пользователь увидит прогресс провижининга.
    if (res?.id) {
      await navigateTo(`/sites/${res.id}`);
    }
  } catch (err: unknown) {
    duplicateDialog.error = (err as Error).message || 'Не удалось дублировать сайт';
  } finally {
    duplicateDialog.submitting = false;
  }
}

async function triggerDeploy() {
  if (!site.value?.gitRepository || deploying.value) return;
  deploying.value = true;
  activeDeployOutput.value = '';
  try {
    const result = await api.post<{ deployId: string; status: string; branch: string }>('/deploy/trigger', {
      siteId: siteId,
      branch: site.value.deployBranch || 'main',
    });
    activeDeployLog.value = {
      id: result.deployId,
      status: result.status,
      branch: result.branch,
      commitSha: null,
      commitMessage: null,
      output: '',
    };
    activeDeployOutput.value = 'Деплой запущен...\n';
    // Poll for updates
    pollDeployLog(result.deployId);
  } catch {
    deploying.value = false;
  }
}

// Хранится на уровне компонента, чтобы onBeforeUnmount мог отменить
// поллинг при уходе со страницы во время деплоя.
let deployPollTimer: ReturnType<typeof setInterval> | undefined;

async function pollDeployLog(deployId: string) {
  if (deployPollTimer) clearInterval(deployPollTimer);
  deployPollTimer = setInterval(async () => {
    try {
      const log = await api.get<{
        id: string;
        status: string;
        branch: string;
        commitSha: string | null;
        commitMessage: string | null;
        output: string;
        durationMs: number | null;
      }>(`/deploys/${deployId}`);

      activeDeployLog.value = log;
      activeDeployOutput.value = log.output || '';

      // Auto-scroll log
      nextTick(() => {
        if (logContainer.value) {
          logContainer.value.scrollTop = logContainer.value.scrollHeight;
        }
      });

      if (log.status === 'SUCCESS' || log.status === 'FAILED') {
        if (deployPollTimer) { clearInterval(deployPollTimer); deployPollTimer = undefined; }
        deploying.value = false;
        // Refresh deploy list and site status
        await loadDeployLogs();
        site.value = await api.get<SiteDetail>(`/sites/${siteId}`);
      }
    } catch {
      if (deployPollTimer) { clearInterval(deployPollTimer); deployPollTimer = undefined; }
      deploying.value = false;
    }
  }, 2000);
}

async function loadDeployLogs() {
  try {
    // Через api.get — иначе на remote-сервере фронт показал бы deploys ЛОКАЛЬНОГО
    // сайта с тем же id (это разные сайты на разных серверах). Бывший прямой
    // $fetch без proxy-префикса давал misleading данные.
    const response = await api.get<{ logs?: typeof deployLogs.value }>(
      `/sites/${siteId}/deploys?perPage=10`,
    );
    deployLogs.value = response.logs || [];
  } catch {
    // Silently fail
  }
}

async function viewDeployLog(deployId: string) {
  try {
    const log = await api.get<{
      id: string;
      status: string;
      branch: string;
      commitSha: string | null;
      commitMessage: string | null;
      output: string;
    }>(`/deploys/${deployId}`);
    activeDeployLog.value = log;
    activeDeployOutput.value = log.output || '';
  } catch {
    // Silently fail
  }
}

async function rollbackDeploy(dl: { id: string; commitSha: string | null }) {
  if (!dl.commitSha || rollingBack.value) return;
  rollingBack.value = dl.id;
  try {
    await api.post(`/deploys/${dl.id}/rollback`);
    // Reload deploy logs and site status
    await loadDeployLogs();
    site.value = await api.get<SiteDetail>(`/sites/${siteId}`);
  } catch {
    // Rollback failed
  } finally {
    rollingBack.value = null;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'только что';
  if (mins < 60) return `${mins} мин. назад`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ч. назад`;
  const days = Math.floor(hours / 24);
  return `${days} дн. назад`;
}

// ─── File Manager state ───
interface FmItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  permissions: string;
}

const fmFiles = ref<FmItem[]>([]);
const fmLoading = ref(false);
const fmCurrentPath = ref('/');
const fmEditing = ref(false);
const fmEditPath = ref('');
const fmEditContent = ref('');
const fmSaving = ref(false);
const fmUploadInput = ref<HTMLInputElement | null>(null);

const fmBreadcrumbs = computed(() => {
  const p = fmCurrentPath.value;
  if (!p || p === '/') return [];
  const parts = p.replace(/^\//, '').replace(/\/$/, '').split('/');
  return parts.map((name, i) => ({
    name,
    path: '/' + parts.slice(0, i + 1).join('/'),
  }));
});

async function fmLoad() {
  if (!site.value) return;
  fmLoading.value = true;
  try {
    const res = await api.get<FmItem[]>(
      `/sites/${siteId}/files?path=${encodeURIComponent(fmCurrentPath.value)}`,
    );
    fmFiles.value = res || [];
  } catch {
    fmFiles.value = [];
  } finally {
    fmLoading.value = false;
  }
}

function fmNavigate(path: string) {
  fmCurrentPath.value = path;
  fmLoad();
}

async function fmOpenFile(item: FmItem) {
  if (!site.value) return;
  try {
    const content = await api.get<string>(
      `/sites/${siteId}/files/read?path=${encodeURIComponent(item.path)}`,
    );
    fmEditPath.value = item.path;
    fmEditContent.value = content || '';
    fmEditing.value = true;
  } catch {
    // Could not read file
  }
}

async function fmSaveFile() {
  if (!site.value || fmSaving.value) return;
  fmSaving.value = true;
  try {
    await api.put(`/sites/${siteId}/files/write`, {
      path: fmEditPath.value,
      content: fmEditContent.value,
    });
    fmEditing.value = false;
  } catch {
    // Save failed
  } finally {
    fmSaving.value = false;
  }
}

function fmCloseEditor() {
  fmEditing.value = false;
  fmEditPath.value = '';
  fmEditContent.value = '';
}

async function fmCreatePrompt(type: 'file' | 'directory') {
  const name = await useMbConfirm().prompt({
    title: type === 'directory' ? 'Создать папку' : 'Создать файл',
    message: `Введите имя ${type === 'directory' ? 'папки' : 'файла'}:`,
    placeholder: type === 'directory' ? 'например, uploads' : 'например, index.html',
    confirmText: 'Создать',
  });
  if (!name || !site.value) return;
  try {
    await api.post(`/sites/${siteId}/files/create`, {
      path: fmCurrentPath.value === '/' ? `/${name}` : `${fmCurrentPath.value}/${name}`,
      type,
    });
    fmLoad();
  } catch {
    // Create failed
  }
}

const fmDownloading = ref('');

async function fmDownloadFile(item: FmItem) {
  if (!site.value) return;
  fmDownloading.value = item.path;
  try {
    await api.download(
      `/sites/${siteId}/files/download?path=${encodeURIComponent(item.path)}`,
      item.name,
    );
  } catch (err) {
    useMbToast().error((err as Error).message || 'Ошибка скачивания файла');
  } finally {
    fmDownloading.value = '';
  }
}

function fmTriggerUpload() {
  fmUploadInput.value?.click();
}

async function fmUploadFile(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!input.files?.length || !site.value) return;

  const file = input.files[0];
  try {
    await api.upload(
      `/sites/${siteId}/files/upload?path=${encodeURIComponent(fmCurrentPath.value)}`,
      file,
    );
    fmLoad();
  } catch {
    // Upload failed
  } finally {
    input.value = ''; // Reset input
  }
}

async function fmDeleteItem(item: FmItem) {
  if (!site.value) return;
  const ok = await useMbConfirm().ask({
    title: 'Удаление',
    message: `Удалить ${item.type === 'directory' ? 'папку' : 'файл'} «${item.name}»?`,
    confirmText: 'Удалить',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/sites/${siteId}/files?path=${encodeURIComponent(item.path)}`);
    fmLoad();
  } catch {
    // Delete failed
  }
}

function fmFormatSize(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ─── Site Metrics ───
interface SiteMetricsInfo {
  cpuPercent: number;
  memoryBytes: number;
  diskBytes: number;
  requestCount: number;
}

const siteMetricsLoading = ref(false);
const siteMetricsData = ref<SiteMetricsInfo>({
  cpuPercent: 0,
  memoryBytes: 0,
  diskBytes: 0,
  requestCount: 0,
});

async function loadSiteMetrics() {
  if (!site.value) return;
  siteMetricsLoading.value = true;
  try {
    const data = await api.get<SiteMetricsInfo>(`/sites/${siteId}/metrics`);
    siteMetricsData.value = data || { cpuPercent: 0, memoryBytes: 0, diskBytes: 0, requestCount: 0 };
  } catch {
    // Metrics unavailable
  } finally {
    siteMetricsLoading.value = false;
  }
}

// ─── Health / доступность сайта (из /health) ───
interface HealthPing {
  id: string;
  reachable: boolean;
  statusCode: number | null;
  responseTimeMs: number;
  createdAt: string;
}
interface HealthSummary {
  reachable: boolean;
  statusCode: number | null;
  uptimePercent: number | null;
  avgResponseMs: number | null;
  pingsCount: number;
}

const healthLoading = ref(false);
const healthPings = ref<HealthPing[]>([]);
const healthSummary = ref<HealthSummary>({
  reachable: false,
  statusCode: null,
  uptimePercent: null,
  avgResponseMs: null,
  pingsCount: 0,
});

async function loadSiteHealth() {
  if (!site.value) return;
  healthLoading.value = true;
  try {
    const resp = await api.get<HealthPing[] | { data: HealthPing[] }>(
      `/health/${siteId}/pings?hours=24`,
    );
    const list: HealthPing[] = Array.isArray(resp)
      ? resp
      : ((resp as { data?: HealthPing[] })?.data ?? []);
    healthPings.value = list;
    if (list.length) {
      const up = list.filter((p) => p.reachable).length;
      const avg = list.reduce((s, p) => s + (p.responseTimeMs || 0), 0) / list.length;
      const last = list[list.length - 1];
      healthSummary.value = {
        reachable: !!last?.reachable,
        statusCode: last?.statusCode ?? null,
        uptimePercent: (up / list.length) * 100,
        avgResponseMs: avg,
        pingsCount: list.length,
      };
    } else {
      healthSummary.value = {
        reachable: false,
        statusCode: null,
        uptimePercent: null,
        avgResponseMs: null,
        pingsCount: 0,
      };
    }
  } catch {
    healthPings.value = [];
  } finally {
    healthLoading.value = false;
  }
}

const healthChartPoints = computed(() => {
  const pts = healthPings.value;
  if (!pts.length) return '';
  const maxMs = Math.max(...pts.map((p) => p.responseTimeMs || 0), 100);
  const step = pts.length > 1 ? 600 / (pts.length - 1) : 0;
  return pts
    .map((p, i) => {
      const x = i * step;
      const y = 120 - ((p.responseTimeMs || 0) / maxMs) * 110 - 5;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
});
const healthChartDots = computed(() => {
  const pts = healthPings.value;
  if (!pts.length) return [] as Array<{ x: number; y: number; ok: boolean }>;
  const maxMs = Math.max(...pts.map((p) => p.responseTimeMs || 0), 100);
  const step = pts.length > 1 ? 600 / (pts.length - 1) : 0;
  return pts.map((p, i) => ({
    x: i * step,
    y: 120 - ((p.responseTimeMs || 0) / maxMs) * 110 - 5,
    ok: p.reachable,
  }));
});

// ─── Storage (из /storage, per-site) ───
interface StorageDetail {
  wwwBytes: number;
  logsBytes: number;
  tmpBytes: number;
  dbBytes: number;
  totalBytes: number;
}
interface StorageTopFile {
  path: string;
  size: number;
}

const storageLoading = ref(false);
const storageData = ref<StorageDetail | null>(null);
const storageTopFiles = ref<StorageTopFile[]>([]);

async function loadSiteStorage() {
  if (!site.value) return;
  storageLoading.value = true;
  try {
    // /storage возвращает массив по всем сайтам — фильтруем наш
    const all = await api.get<Array<StorageDetail & { siteId: string }>>('/storage');
    const mine = (Array.isArray(all) ? all : []).find((s) => s.siteId === siteId);
    storageData.value = mine
      ? {
          wwwBytes: mine.wwwBytes || 0,
          logsBytes: mine.logsBytes || 0,
          tmpBytes: mine.tmpBytes || 0,
          dbBytes: mine.dbBytes || 0,
          totalBytes: mine.totalBytes || 0,
        }
      : null;
    try {
      const tops = await api.get<StorageTopFile[] | { data: StorageTopFile[] }>(
        `/storage/${siteId}/top-files`,
      );
      storageTopFiles.value = Array.isArray(tops)
        ? tops
        : ((tops as { data?: StorageTopFile[] })?.data ?? []);
    } catch {
      storageTopFiles.value = [];
    }
  } catch {
    storageData.value = null;
  } finally {
    storageLoading.value = false;
  }
}

const storageBarSegments = computed(() => {
  const d = storageData.value;
  if (!d || !d.totalBytes) return [] as Array<{ label: string; bytes: number; percent: number; color: string }>;
  const segs = [
    { label: 'www', bytes: d.wwwBytes, color: 'var(--primary)' },
    { label: 'БД', bytes: d.dbBytes, color: '#6366f1' },
    { label: 'Логи', bytes: d.logsBytes, color: '#10b981' },
    { label: 'tmp', bytes: d.tmpBytes, color: '#94a3b8' },
  ];
  const total = d.totalBytes;
  return segs
    .filter((s) => s.bytes > 0)
    .map((s) => ({ ...s, percent: (s.bytes / total) * 100 }));
});

// ─── Activity (audit-logs, фильтр по siteId) ───
interface ActivityEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  ipAddress: string;
  createdAt: string;
  user?: { username: string } | null;
}

const activityLoading = ref(false);
const activityEntries = ref<ActivityEntry[]>([]);
const activityPage = ref(1);
const activityTotalPages = ref(1);
const ACTIVITY_PER_PAGE = 20;

const ACTIVITY_ACTIONS: Record<string, string> = {
  LOGIN: 'Вход',
  LOGOUT: 'Выход',
  CREATE: 'Создание',
  UPDATE: 'Обновление',
  DELETE: 'Удаление',
  DEPLOY: 'Деплой',
  BACKUP: 'Бэкап',
  RESTORE: 'Восстановление',
  SSL_ISSUE: 'SSL выпуск',
  SERVICE_START: 'Запуск сервиса',
  SERVICE_STOP: 'Остановка сервиса',
  SERVICE_RESTART: 'Рестарт сервиса',
};

function activityActionLabel(action: string): string {
  return ACTIVITY_ACTIONS[action] || action;
}

function activityFormatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

interface ActivityGroup { label: string; items: ActivityEntry[] }
const activityGrouped = computed<ActivityGroup[]>(() => {
  const groups: Map<string, ActivityEntry[]> = new Map();
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  for (const entry of activityEntries.value) {
    const date = new Date(entry.createdAt);
    let label: string;
    if (sameDay(date, today)) label = 'Сегодня';
    else if (sameDay(date, yesterday)) label = 'Вчера';
    else label = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(entry);
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
});

async function loadSiteActivity(page = 1) {
  if (!site.value) return;
  activityLoading.value = true;
  try {
    const res = await api.getWithMeta<ActivityEntry[]>(
      `/audit-logs?entityId=${siteId}&page=${page}&perPage=${ACTIVITY_PER_PAGE}`,
    );
    activityEntries.value = res.data || [];
    activityPage.value = page;
    activityTotalPages.value = res.meta?.totalPages || 1;
  } catch {
    activityEntries.value = [];
    activityTotalPages.value = 1;
  } finally {
    activityLoading.value = false;
  }
}

function goActivityPage(p: number) {
  if (p < 1 || p > activityTotalPages.value) return;
  loadSiteActivity(p);
}

// ─── CMS (объединённый блок Admin + версия для не-custom сайтов) ───
const hasCmsInfo = computed(() => {
  if (!site.value) return false;
  // Показываем блок для любых «не-custom» типов — сейчас это MODX_*
  const t = site.value.type;
  if (t === 'CUSTOM') return false;
  return !!(site.value.cmsAdminUser || site.value.modxVersion || isModxSite.value);
});
const cmsTitle = computed(() => {
  if (!site.value) return 'CMS';
  const t = site.value.type;
  if (t === 'MODX_REVO') return 'MODX Revolution';
  if (t === 'MODX_3') return 'MODX 3';
  return 'CMS';
});

// ─── Site Backups ───
interface SiteBackup {
  id: string;
  type: string;
  status: string;
  engine?: 'TAR' | 'RESTIC';
  storageType: string;
  storageLocationId?: string | null;
  storageLocation?: { id: string; name: string; type: string } | null;
  resticSnapshotId?: string | null;
  sizeBytes?: number;
  progress?: number;
  errorMessage?: string;
  baseBackupId?: string | null;
  createdAt: string;
}

interface SiteStorageLocation {
  id: string;
  name: string;
  type: string;
  resticEnabled: boolean;
}

const siteBackups = ref<SiteBackup[]>([]);
const siteBackupsLoading = ref(false);
const triggeringBackup = ref(false);
const showSiteRestoreModal = ref(false);
const restoringSiteBackup = ref<SiteBackup | null>(null);
const restoringBackup = ref(false);
const restoreCleanup = ref(true);
const restoreProgress = ref<number | null>(null);
const restoreError = ref('');
// Selective restore state
type RestoreScope = 'FILES_AND_DB' | 'FILES_ONLY' | 'DB_ONLY';
const restoreScope = ref<RestoreScope>('FILES_AND_DB');
interface RestoreTreeItem { name: string; type: 'dir' | 'file'; size: number }
const restoreTree = ref<RestoreTreeItem[]>([]);
const restoreTreeLoading = ref(false);
const restoreTreeError = ref('');
const restoreSelected = reactive<Set<string>>(new Set());
const backupHasDatabases = computed(() => {
  // Любой бэкап с FULL/DB_ONLY содержит БД (если у сайта они есть).
  // FILES_ONLY — нет, поэтому "Только БД" логично запретить.
  const t = restoringSiteBackup.value?.type;
  if (!t) return false;
  return t === 'FULL' || t === 'DB_ONLY' || t === 'DIFFERENTIAL';
});
// Селективный выбор БД при restore. Default — все БД сайта.
// Применяется только когда scope включает БД.
const restoreDatabaseIds = ref<string[]>([]);
const restoreScopeIncludesDb = computed(
  () => restoreScope.value === 'FILES_AND_DB' || restoreScope.value === 'DB_ONLY',
);
const restoreSelectedAllDbs = computed(() => {
  const all = site.value?.databases || [];
  if (all.length === 0) return true;
  return restoreDatabaseIds.value.length === all.length;
});
function toggleRestoreDb(dbId: string) {
  const i = restoreDatabaseIds.value.indexOf(dbId);
  if (i >= 0) restoreDatabaseIds.value.splice(i, 1);
  else restoreDatabaseIds.value.push(dbId);
}
function selectAllRestoreDbs(on: boolean) {
  restoreDatabaseIds.value = on
    ? (site.value?.databases || []).map((d) => d.id)
    : [];
}
const canRunRestore = computed(() => {
  if (restoreScope.value === 'DB_ONLY') {
    if (!backupHasDatabases.value) return false;
    // Для DB_ONLY должна быть выбрана хотя бы одна БД (если у сайта есть БД).
    if ((site.value?.databases?.length || 0) > 0 && restoreDatabaseIds.value.length === 0) {
      return false;
    }
    return true;
  }
  // Файлы: для restic + tree — должно быть выбрано хоть что-то
  if (restoringSiteBackup.value?.engine === 'RESTIC' && restoreTree.value.length > 0) {
    return restoreSelected.size > 0;
  }
  return true;
});

function toggleTreeItem(name: string) {
  if (restoreSelected.has(name)) restoreSelected.delete(name);
  else restoreSelected.add(name);
}
function selectAllTreeItems(all: boolean) {
  restoreSelected.clear();
  if (all) for (const it of restoreTree.value) restoreSelected.add(it.name);
}

async function loadRestoreTree() {
  restoreTree.value = [];
  restoreSelected.clear();
  restoreTreeError.value = '';
  if (!restoringSiteBackup.value) return;
  if (restoringSiteBackup.value.engine !== 'RESTIC') return;
  if (restoreScope.value === 'DB_ONLY') return;
  restoreTreeLoading.value = true;
  try {
    const res = await api.get<{ items: RestoreTreeItem[] }>(`/backups/${restoringSiteBackup.value.id}/tree`);
    restoreTree.value = res.items || [];
    // По умолчанию выбираем всё
    for (const it of restoreTree.value) restoreSelected.add(it.name);
  } catch (err) {
    restoreTreeError.value = (err as Error).message || 'Не удалось получить дерево';
  } finally {
    restoreTreeLoading.value = false;
  }
}

watch(showSiteRestoreModal, (open) => {
  if (open) {
    // Сброс при открытии
    restoreScope.value = 'FILES_AND_DB';
    restoreCleanup.value = true;
    restoreSelected.clear();
    restoreTree.value = [];
    restoreTreeError.value = '';
    // По умолчанию ресторим все БД сайта.
    restoreDatabaseIds.value = (site.value?.databases || []).map((d) => d.id);
    loadRestoreTree();
  }
});

watch(restoreScope, (s) => {
  if (s === 'DB_ONLY') {
    restoreTree.value = [];
    restoreSelected.clear();
  } else if (showSiteRestoreModal.value && restoreTree.value.length === 0 && restoringSiteBackup.value?.engine === 'RESTIC') {
    loadRestoreTree();
  }
});
const backupLiveProgress = reactive<Record<string, number>>({});
let cleanupBackupWs: (() => void) | undefined;
let cleanupRestoreWs: (() => void) | undefined;
// Polling-fallback: если WS потеряет событие backup:complete (agent reconnect,
// transport close и т.п.), статус "создаётся" залипнет до ручного refresh.
// Пока есть хоть один PENDING/IN_PROGRESS — полим список раз в 5 сек.
let backupStatusPollTimer: ReturnType<typeof setInterval> | null = null;

const backupTypeOptions = [
  { value: 'FULL', label: 'Полный' },
  { value: 'FILES_ONLY', label: 'Только файлы' },
  { value: 'DB_ONLY', label: 'Только БД' },
];

// Диалог создания бэкапа с выбором engine/type/storage
// Per-site backup excludes (saveable defaults)
const siteExcludesText = ref('');
const siteExcludeTablesText = ref('');
const siteExcludesEditing = ref(false);
const savingSiteExcludes = ref(false);
const siteExcludesList = computed(() =>
  (siteExcludesText.value || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#')),
);
const siteExcludeTablesList = computed(() =>
  (siteExcludeTablesText.value || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#')),
);

function syncSiteExcludesFromSite() {
  const s = site.value as { backupExcludes?: string[]; backupExcludeTables?: string[] } | null;
  const arr = s?.backupExcludes;
  siteExcludesText.value = Array.isArray(arr) && arr.length > 0 ? arr.join('\n') : '';
  const tbl = s?.backupExcludeTables;
  siteExcludeTablesText.value = Array.isArray(tbl) && tbl.length > 0 ? tbl.join('\n') : '';
}

function resetSiteExcludesToRecommended() {
  siteExcludesText.value = recommendedExcludesForSite().join('\n');
  siteExcludeTablesText.value = recommendedExcludeTablesForSite().join('\n');
}

async function saveSiteExcludes() {
  savingSiteExcludes.value = true;
  try {
    const paths = siteExcludesList.value.slice(0, 200);
    const tables = siteExcludeTablesList.value.slice(0, 200);
    await api.put(`/sites/${siteId}`, {
      backupExcludes: paths,
      backupExcludeTables: tables,
    });
    if (site.value) {
      (site.value as { backupExcludes?: string[]; backupExcludeTables?: string[] }).backupExcludes = paths;
      (site.value as { backupExcludes?: string[]; backupExcludeTables?: string[] }).backupExcludeTables = tables;
    }
  } catch (err) {
    useMbToast().error((err as Error).message || 'Не удалось сохранить');
  } finally {
    savingSiteExcludes.value = false;
  }
}

// Рекомендуемые таблицы БД (без данных) по типу сайта.
function recommendedExcludeTablesForSite(): string[] {
  const t = (site.value?.type || '').toUpperCase();
  if (t.startsWith('MODX')) {
    return ['modx_session', 'modx_manager_log', 'modx_event_log'];
  }
  if (t === 'WORDPRESS' || t === 'WP') {
    return ['wp_options'];
  }
  return [];
}

const siteBackupDialog = reactive({
  open: false,
  form: {
    engine: 'RESTIC' as 'RESTIC' | 'TAR',
    type: 'FULL' as 'FULL' | 'FILES_ONLY' | 'DB_ONLY',
    storageLocationId: '',
    excludesText: '',
    // ID БД, которые нужно включить в бэкап. По умолчанию — все БД сайта.
    // Применяется только когда type включает БД (FULL / DB_ONLY).
    databaseIds: [] as string[],
  },
});

// Включает ли текущий выбранный type БД (FULL/DB_ONLY).
const backupTypeIncludesDb = computed(
  () => siteBackupDialog.form.type === 'FULL' || siteBackupDialog.form.type === 'DB_ONLY',
);
const siteHasDatabases = computed(() => (site.value?.databases?.length || 0) > 0);
// Если type=DB_ONLY, нельзя стартовать без выбранной хотя бы одной БД.
// FULL без БД — допустим (бэкап только файлов).
const backupSelectedAllDbs = computed(() => {
  const all = site.value?.databases || [];
  if (all.length === 0) return true;
  return siteBackupDialog.form.databaseIds.length === all.length;
});
function toggleBackupDb(dbId: string) {
  const i = siteBackupDialog.form.databaseIds.indexOf(dbId);
  if (i >= 0) siteBackupDialog.form.databaseIds.splice(i, 1);
  else siteBackupDialog.form.databaseIds.push(dbId);
}
function selectAllBackupDbs(on: boolean) {
  siteBackupDialog.form.databaseIds = on
    ? (site.value?.databases || []).map((d) => d.id)
    : [];
}
const siteStorageLocations = ref<SiteStorageLocation[]>([]);

async function loadSiteStorageLocations() {
  try {
    siteStorageLocations.value = await api.get<SiteStorageLocation[]>('/storage-locations');
  } catch {
    siteStorageLocations.value = [];
  }
}

// Рекомендуемые excludes в зависимости от типа сайта.
// Всегда относительны rootPath (т.е. /var/www/<name>/...) — пишем без ведущего слеша.
// Минимум — только мусор/кеш, который точно не нужен в бэкапе.
function recommendedExcludesForSite(): string[] {
  const t = (site.value?.type || '').toUpperCase();
  // Общие — node_modules/.git/*.log агент уже жёстко исключает в коде,
  // тут даём только пользовательские дефолты.
  if (t.startsWith('MODX')) {
    return ['www/core/cache'];
  }
  if (t === 'WORDPRESS' || t === 'WP') {
    return ['www/wp-content/cache'];
  }
  return [];
}

function openSiteBackupDialog() {
  if (siteStorageLocations.value.length === 0) loadSiteStorageLocations();
  siteBackupDialog.form.engine = 'RESTIC';
  siteBackupDialog.form.type = 'FULL';
  siteBackupDialog.form.storageLocationId = '';
  // По умолчанию отмечаем все БД сайта.
  siteBackupDialog.form.databaseIds = (site.value?.databases || []).map((d) => d.id);
  // Pre-fill: per-site сохранённые > рекомендуемые по типу.
  // Если у сайта явно задан backupExcludes — используем его (это и есть «сохранил один раз»).
  const siteExcludes = (site.value as { backupExcludes?: string[] } | null)?.backupExcludes;
  if (Array.isArray(siteExcludes) && siteExcludes.length > 0) {
    siteBackupDialog.form.excludesText = siteExcludes.join('\n');
  } else {
    siteBackupDialog.form.excludesText = recommendedExcludesForSite().join('\n');
  }
  siteBackupDialog.open = true;
}

// ─── Snapshot Picker (произвольные снапшоты из репы) ───
interface ResticSnapshotItem {
  id?: string;
  short_id?: string;
  time: string;
  hostname?: string;
  paths?: string[];
  tags?: string[];
  inDatabase?: boolean;
  summary?: { total_bytes_processed?: number };
}

const snapshotPicker = reactive({
  open: false,
  locationId: '',
  loading: false,
  restoring: false,
  error: '',
  cleanup: true,
  selectedId: '',
  snapshots: [] as ResticSnapshotItem[],
});

async function openSnapshotPicker() {
  if (siteStorageLocations.value.length === 0) await loadSiteStorageLocations();
  snapshotPicker.open = true;
  snapshotPicker.locationId = '';
  snapshotPicker.snapshots = [];
  snapshotPicker.selectedId = '';
  snapshotPicker.error = '';
  snapshotPicker.cleanup = true;
}

async function loadSnapshotsInPicker() {
  if (!snapshotPicker.locationId) {
    snapshotPicker.snapshots = [];
    return;
  }
  snapshotPicker.loading = true;
  snapshotPicker.error = '';
  snapshotPicker.selectedId = '';
  try {
    const res = await api.get<ResticSnapshotItem[]>(
      `/sites/${siteId}/restic-snapshots?locationId=${encodeURIComponent(snapshotPicker.locationId)}`,
    );
    // Сортируем свежие сверху
    const arr = Array.isArray(res) ? [...res] : [];
    arr.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
    snapshotPicker.snapshots = arr;
  } catch (err: unknown) {
    snapshotPicker.error = (err as Error).message || 'Не удалось загрузить снапшоты';
    snapshotPicker.snapshots = [];
  } finally {
    snapshotPicker.loading = false;
  }
}

async function restoreFromPickedSnapshot() {
  if (!snapshotPicker.selectedId || !snapshotPicker.locationId) return;
  const ok = await useMbConfirm().ask({
    title: 'Восстановление из снапшота',
    message: 'Восстановить файлы и БД сайта из этого снапшота? Текущее содержимое будет перезаписано.',
    confirmText: 'Восстановить',
    danger: true,
  });
  if (!ok) return;
  snapshotPicker.restoring = true;
  try {
    await api.post(`/sites/${siteId}/restic-snapshots/${encodeURIComponent(snapshotPicker.selectedId)}/restore`, {
      locationId: snapshotPicker.locationId,
      cleanup: snapshotPicker.cleanup,
    });
    snapshotPicker.open = false;
    restoringBackup.value = true;
    restoreProgress.value = 0;
    await loadSiteBackups();
  } catch (err) {
    useMbToast().error((err as Error).message || 'Не удалось запустить восстановление');
  } finally {
    snapshotPicker.restoring = false;
  }
}

// ─── Restic Check (проверка целостности) ───
interface ResticCheckRow {
  id: string;
  storageLocationId: string;
  success: boolean;
  errorMessage?: string | null;
  durationMs?: number | null;
  source: 'manual' | 'scheduled';
  startedAt: string;
  completedAt?: string | null;
}

const resticCheck = reactive({
  open: false,
  locationId: '',
  loading: false,
  running: false,
  readData: false,
  readDataSubset: '10%',
  history: [] as ResticCheckRow[],
});

// ─── Backup Compare (Restic diff) ───
interface BackupCompareItem { path: string; modifier: string; }
interface BackupCompareStats { changedFiles: number; addedFiles: number; removedFiles: number; }

const backupCompare = reactive({
  open: false,
  leftBackupId: '' as string,
  leftLabel: '' as string,
  leftLocationId: '' as string,
  leftSnapshotId: '' as string,
  rightMode: 'live' as 'live' | 'snapshot',
  rightBackupId: '' as string,
  loading: false,
  loadingLabel: '' as string,
  error: '' as string,
  ranAt: 0 as number,
  items: [] as BackupCompareItem[],
  stats: null as BackupCompareStats | null,
  selectedPath: '' as string,
  fileLoading: false,
  fileError: '' as string,
  fileBinary: false,
  fileSizeA: 0,
  fileSizeB: 0,
  fileTruncated: false,
  unifiedDiff: '' as string,
});

const backupCompareCandidates = computed(() => {
  // Кандидаты для сравнения: COMPLETED restic-бэкапы из ТОЙ ЖЕ репы (одинаковый locationId).
  // Diff между разными хранилищами через restic невозможен (разные репы).
  return siteBackups.value.filter((b) =>
    b.engine === 'RESTIC'
    && b.status === 'COMPLETED'
    && !!b.resticSnapshotId
    && b.id !== backupCompare.leftBackupId
    && b.storageLocationId === backupCompare.leftLocationId,
  );
});

function openBackupCompare(b: SiteBackup) {
  if (!b.resticSnapshotId || !b.storageLocationId) return;
  backupCompare.open = true;
  backupCompare.leftBackupId = b.id;
  backupCompare.leftLocationId = b.storageLocationId;
  backupCompare.leftSnapshotId = b.resticSnapshotId;
  backupCompare.leftLabel = `${formatBackupDate(b.createdAt)} · ${b.resticSnapshotId.slice(0, 8)}`;
  backupCompare.rightMode = 'live';
  backupCompare.rightBackupId = '';
  backupCompare.items = [];
  backupCompare.stats = null;
  backupCompare.error = '';
  backupCompare.selectedPath = '';
  backupCompare.unifiedDiff = '';
  backupCompare.fileBinary = false;
  backupCompare.fileError = '';
  backupCompare.ranAt = 0;
  // Сразу запускаем live-diff (most-common case)
  runBackupCompare();
}

function closeBackupCompare() {
  backupCompare.open = false;
}

function onBackupCompareModeChange() {
  backupCompare.items = [];
  backupCompare.stats = null;
  backupCompare.error = '';
  backupCompare.selectedPath = '';
  backupCompare.unifiedDiff = '';
  backupCompare.ranAt = 0;
  if (backupCompare.rightMode === 'live') {
    runBackupCompare();
  }
}

async function runBackupCompare() {
  if (!site.value) return;
  if (backupCompare.rightMode === 'snapshot' && !backupCompare.rightBackupId) return;
  backupCompare.loading = true;
  backupCompare.loadingLabel = backupCompare.rightMode === 'live'
    ? 'Сравниваем с текущими файлами…'
    : 'Сравниваем снапшоты…';
  backupCompare.error = '';
  backupCompare.items = [];
  backupCompare.stats = null;

  try {
    if (backupCompare.rightMode === 'live') {
      const res = await api.post<{ items: BackupCompareItem[]; stats: BackupCompareStats }>(
        `/sites/${site.value.id}/restic-diff/live`,
        {
          locationId: backupCompare.leftLocationId,
          snapshotId: backupCompare.leftSnapshotId,
        },
      );
      backupCompare.items = res?.items || [];
      backupCompare.stats = res?.stats || null;
    } else {
      const right = siteBackups.value.find((b) => b.id === backupCompare.rightBackupId);
      if (!right?.resticSnapshotId) throw new Error('Бэкап-цель не найден');
      const res = await api.post<{ items: BackupCompareItem[]; stats: BackupCompareStats }>(
        `/sites/${site.value.id}/restic-diff/snapshots`,
        {
          locationId: backupCompare.leftLocationId,
          snapshotIdA: backupCompare.leftSnapshotId,
          snapshotIdB: right.resticSnapshotId,
        },
      );
      backupCompare.items = res?.items || [];
      backupCompare.stats = res?.stats || null;
    }
    backupCompare.ranAt = Date.now();
  } catch (err: any) {
    backupCompare.error = err?.message || 'Ошибка сравнения';
  } finally {
    backupCompare.loading = false;
    backupCompare.loadingLabel = '';
  }
}

async function onBackupCompareFileClick(item: BackupCompareItem) {
  if (!site.value) return;
  // Только изменённые файлы можно diff'ать содержимым; для +/- показываем уведомление.
  backupCompare.selectedPath = item.path;
  backupCompare.fileError = '';
  backupCompare.fileBinary = false;
  backupCompare.unifiedDiff = '';
  backupCompare.fileTruncated = false;
  backupCompare.fileSizeA = 0;
  backupCompare.fileSizeB = 0;

  if (item.modifier !== 'M') {
    backupCompare.fileError = item.modifier === '+'
      ? 'Файл добавлен — нет версии для сравнения.'
      : item.modifier === '-'
        ? 'Файл удалён — нет версии для сравнения.'
        : `Тип изменения "${item.modifier}" не поддерживает content-diff.`;
    return;
  }

  backupCompare.fileLoading = true;
  try {
    let res: any;
    if (backupCompare.rightMode === 'live') {
      res = await api.post(`/sites/${site.value.id}/restic-diff/file-live`, {
        locationId: backupCompare.leftLocationId,
        snapshotId: backupCompare.leftSnapshotId,
        filePath: item.path,
      });
    } else {
      const right = siteBackups.value.find((b) => b.id === backupCompare.rightBackupId);
      if (!right?.resticSnapshotId) throw new Error('Бэкап-цель не найден');
      res = await api.post(`/sites/${site.value.id}/restic-diff/file`, {
        locationId: backupCompare.leftLocationId,
        snapshotIdA: backupCompare.leftSnapshotId,
        snapshotIdB: right.resticSnapshotId,
        filePath: item.path,
      });
    }
    backupCompare.fileBinary = !!res?.binary;
    backupCompare.fileSizeA = res?.sizeA || 0;
    backupCompare.fileSizeB = res?.sizeB || 0;
    backupCompare.fileTruncated = !!res?.truncated;
    backupCompare.unifiedDiff = res?.unifiedDiff || '';
  } catch (err: any) {
    backupCompare.fileError = err?.message || 'Ошибка';
  } finally {
    backupCompare.fileLoading = false;
  }
}

function backupModifierColor(m: string): string {
  if (m === '+') return '#22c55e';
  if (m === '-') return '#ef4444';
  if (m === 'M') return 'var(--primary)';
  return 'var(--text-tertiary)';
}

function renderUnifiedDiff(diff: string): string {
  // Простая HTML-подсветка unified-diff.
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return diff.split('\n').map((line) => {
    const e = escape(line);
    if (line.startsWith('+++') || line.startsWith('---')) {
      return `<span style="color:#9ca3af;font-weight:600;">${e}</span>`;
    }
    if (line.startsWith('@@')) {
      return `<span style="color:#a78bfa;">${e}</span>`;
    }
    if (line.startsWith('+')) {
      return `<span style="color:#22c55e;background:rgba(34,197,94,0.08);">${e}</span>`;
    }
    if (line.startsWith('-')) {
      return `<span style="color:#ef4444;background:rgba(239,68,68,0.08);">${e}</span>`;
    }
    return e;
  }).join('\n');
}

async function openResticCheckDialog() {
  if (siteStorageLocations.value.length === 0) await loadSiteStorageLocations();
  resticCheck.open = true;
  resticCheck.locationId = '';
  resticCheck.history = [];
}

async function loadResticChecks() {
  if (!resticCheck.locationId) {
    resticCheck.history = [];
    return;
  }
  resticCheck.loading = true;
  try {
    const res = await api.get<ResticCheckRow[]>(
      `/sites/${siteId}/restic-checks?locationId=${encodeURIComponent(resticCheck.locationId)}&limit=50`,
    );
    resticCheck.history = Array.isArray(res) ? res : [];
  } catch {
    resticCheck.history = [];
  } finally {
    resticCheck.loading = false;
  }
}

// Хранится на уровне компонента, чтобы onBeforeUnmount остановил поллинг.
let resticCheckPollTimer: ReturnType<typeof setInterval> | undefined;

async function runResticCheck() {
  if (!resticCheck.locationId) return;
  resticCheck.running = true;
  try {
    await api.post(`/sites/${siteId}/restic-checks`, {
      locationId: resticCheck.locationId,
      readData: resticCheck.readData,
      readDataSubset: resticCheck.readData ? resticCheck.readDataSubset : undefined,
    });
    // Чек идёт в фоне, polling списка каждые 5с до 5 минут.
    let ticks = 0;
    const maxTicks = 60; // 5 минут
    if (resticCheckPollTimer) clearInterval(resticCheckPollTimer);
    resticCheckPollTimer = setInterval(async () => {
      ticks++;
      await loadResticChecks();
      const pending = resticCheck.history.some((c) => !c.completedAt);
      if (!pending || ticks >= maxTicks) {
        clearInterval(resticCheckPollTimer);
        resticCheckPollTimer = undefined;
      }
    }, 5000);
    await loadResticChecks();
  } catch (err) {
    useMbToast().error((err as Error).message || 'Не удалось запустить проверку');
  } finally {
    resticCheck.running = false;
  }
}

function backupTypeLabel(type: string) {
  const labels: Record<string, string> = {
    FULL: 'Полный',
    DIFFERENTIAL: 'Дифференциальный',
    FILES_ONLY: 'Только файлы',
    DB_ONLY: 'Только БД',
  };
  return labels[type] || type;
}

function backupStatusLabel(status: string) {
  const labels: Record<string, string> = {
    PENDING: 'В очереди',
    IN_PROGRESS: 'Выполняется',
    COMPLETED: 'Готово',
    FAILED: 'Ошибка',
  };
  return labels[status] || status;
}

function backupStorageLabel(s: string) {
  const map: Record<string, string> = { LOCAL: 'Локально', YANDEX_DISK: 'Я.Диск', CLOUD_MAIL_RU: 'Cloud Mail', S3: 'S3' };
  return map[s] || s || '';
}

const backupDownloading = reactive<Record<string, number>>({});

function setupBackupProgressWs() {
  if (cleanupBackupWs) cleanupBackupWs();
  cleanupBackupWs = onBackupProgress((payload) => {
    backupLiveProgress[payload.backupId] = payload.progress;

    // Update local status so progress bar condition matches
    const b = siteBackups.value.find((x) => x.id === payload.backupId);
    if (b && b.status === 'PENDING') b.status = 'IN_PROGRESS';

    if (payload.status === 'COMPLETED' || payload.status === 'FAILED') {
      setTimeout(() => {
        delete backupLiveProgress[payload.backupId];
        loadSiteBackups();
      }, 500);
    }
  });

  cleanupRestoreWs = onBackupRestoreProgress((payload) => {
    restoreProgress.value = payload.progress;
    if (payload.status === 'RESTORED') {
      restoringBackup.value = false;
      restoreProgress.value = null;
      loadSiteBackups();
    } else if (payload.status === 'FAILED') {
      restoringBackup.value = false;
      restoreProgress.value = null;
      restoreError.value = payload.error || 'Ошибка восстановления';
    }
  });
}

function hasActiveBackup(): boolean {
  return siteBackups.value.some(
    (b) => b.status === 'PENDING' || b.status === 'IN_PROGRESS',
  );
}

function ensureBackupStatusPoll() {
  if (backupStatusPollTimer) return;
  if (!hasActiveBackup()) return;
  backupStatusPollTimer = setInterval(async () => {
    try {
      const fresh = await api.get<SiteBackup[]>(`/sites/${siteId}/backups`);
      siteBackups.value = fresh;
      // Если активных больше нет — гасим poll
      if (!hasActiveBackup()) {
        if (backupStatusPollTimer) {
          clearInterval(backupStatusPollTimer);
          backupStatusPollTimer = null;
        }
        // Подчистим остаточный live-прогресс
        for (const id of Object.keys(backupLiveProgress)) {
          if (!fresh.some((b) => b.id === id)) delete backupLiveProgress[id];
        }
      }
    } catch {
      // транзитная ошибка сети — не паникуем, попробуем на следующем тике
    }
  }, 5000);
}

function stopBackupStatusPoll() {
  if (backupStatusPollTimer) {
    clearInterval(backupStatusPollTimer);
    backupStatusPollTimer = null;
  }
}

async function loadSiteBackups() {
  siteBackupsLoading.value = true;
  try {
    siteBackups.value = await api.get<SiteBackup[]>(`/sites/${siteId}/backups`);
  } catch { siteBackups.value = []; }
  finally {
    siteBackupsLoading.value = false;
    ensureBackupStatusPoll();
  }
}

async function triggerSiteBackup() {
  if (!siteBackupDialog.form.storageLocationId) return;
  triggeringBackup.value = true;
  try {
    const excludePaths = (siteBackupDialog.form.excludesText || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'))
      .slice(0, 200);
    // Селективный databaseIds отправляем ТОЛЬКО если type включает БД
    // и юзер снял хотя бы одну (т.е. не выбраны все). Иначе бек берёт все БД.
    const sendDbIds =
      backupTypeIncludesDb.value
      && siteHasDatabases.value
      && !backupSelectedAllDbs.value;
    await api.post('/backups/trigger', {
      siteId,
      engine: siteBackupDialog.form.engine,
      type: siteBackupDialog.form.type,
      storageLocationId: siteBackupDialog.form.storageLocationId,
      excludePaths,
      ...(sendDbIds ? { databaseIds: siteBackupDialog.form.databaseIds } : {}),
    });
    siteBackupDialog.open = false;
    await loadSiteBackups();
    ensureBackupStatusPoll();
  } catch (err) {
    useMbToast().error((err as Error).message || 'Не удалось запустить бэкап');
  }
  finally { triggeringBackup.value = false; }
}

// ─── Backup export (download) dialog ───
interface BackupExportRow {
  id: string;
  mode: 'STREAM' | 'S3_PRESIGNED';
  status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED' | 'EXPIRED';
  downloadUrl?: string | null;
  expiresAt: string;
  sizeBytes?: number | null;
  errorMessage?: string | null;
  createdAt: string;
  // Прогресс in-memory у API; null если экспорт не активен или ещё нет тиков.
  progressBytesRead?: number | null;
  progressBytesUploaded?: number | null;
  progressElapsedMs?: number | null;
  progressUpdatedAt?: number | null;
}

function formatExportBytes(b?: number | null): string {
  if (!b || b <= 0) return '0 MB';
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatExportElapsed(ms?: number | null): string {
  if (!ms || ms <= 0) return '0s';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
const exportDialog = reactive({
  open: false,
  creating: false,
  targetBackup: null as SiteBackup | null,
  s3Available: false,
  list: [] as BackupExportRow[],
  pollTimer: null as ReturnType<typeof setInterval> | null,
  form: {
    mode: 'STREAM' as 'STREAM' | 'S3_PRESIGNED',
    ttlHours: 7,
  },
});

function onClickDownloadBackup(b: SiteBackup) {
  // Для restic — открываем диалог экспорта.
  // Для TAR — старый прямой download (downloadSiteBackup).
  if (b.engine === 'RESTIC') {
    exportDialog.targetBackup = b;
    const storageType = b.storageLocation?.type;
    exportDialog.s3Available = storageType === 'S3';
    exportDialog.form.mode = exportDialog.s3Available ? 'S3_PRESIGNED' : 'STREAM';
    exportDialog.form.ttlHours = 7;
    exportDialog.open = true;
    loadExportsList();
    startExportPoll();
  } else {
    downloadSiteBackup(b);
  }
}

async function loadExportsList() {
  if (!exportDialog.targetBackup) return;
  try {
    const data = await api.get<BackupExportRow[]>(`/backups/${exportDialog.targetBackup.id}/exports`);
    exportDialog.list = data || [];
  } catch {
    exportDialog.list = [];
  }
}

function startExportPoll() {
  if (exportDialog.pollTimer) clearInterval(exportDialog.pollTimer);
  exportDialog.pollTimer = setInterval(() => {
    if (!exportDialog.open) {
      if (exportDialog.pollTimer) {
        clearInterval(exportDialog.pollTimer);
        exportDialog.pollTimer = null;
      }
      return;
    }
    if (exportDialog.list.some((e) => e.status === 'PROCESSING' || e.status === 'PENDING')) {
      loadExportsList();
    }
  }, 4000);
}

async function createExport() {
  if (!exportDialog.targetBackup) return;
  exportDialog.creating = true;
  try {
    const res = await api.post<{ id: string; mode: string; status: string; downloadUrl?: string; expiresAt: string }>(
      '/backup-exports',
      {
        backupId: exportDialog.targetBackup.id,
        mode: exportDialog.form.mode,
        ttlHours: exportDialog.form.ttlHours,
      },
    );
    if (exportDialog.form.mode === 'STREAM' && res.downloadUrl) {
      // STREAM готов сразу — открываем ссылку для скачивания
      openExportLink(res.downloadUrl);
    }
    await loadExportsList();
  } catch (err) {
    useMbToast().error((err as Error).message || 'Ошибка создания экспорта');
  } finally {
    exportDialog.creating = false;
  }
}

function openExportLink(url: string) {
  // STREAM-режим: URL вида /backup-exports/:id/download?token=<one-shot>
  // — токен в querystring, поэтому browser качает НАТИВНО через <a download>
  // без удержания файла в памяти (для 50GB это критично).
  // S3_PRESIGNED: полный https-URL pre-signed.
  let finalUrl: string;
  if (url.startsWith('http://') || url.startsWith('https://')) {
    finalUrl = url;
  } else {
    const baseUrl = (useRuntimeConfig().public.apiBase as string) || '';
    // Нормализация дублирующего /api префикса (старые записи)
    let normalizedUrl = url;
    if (baseUrl.endsWith('/api') && url.startsWith('/api/')) {
      normalizedUrl = url.slice(4);
    } else if (baseUrl.endsWith('/api/') && url.startsWith('/api/')) {
      normalizedUrl = url.slice(5);
    }
    finalUrl = `${baseUrl}${normalizedUrl}`;
  }
  // Нативный download через временный <a>
  const a = document.createElement('a');
  a.href = finalUrl;
  a.target = '_blank';
  a.rel = 'noopener';
  // Имя файла для download — браузер использует Content-Disposition с сервера,
  // но указываем fallback на случай если S3 не пришлёт правильный заголовок.
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Скачивание уже созданного экспорта.
// STREAM: запрашиваем СВЕЖИЙ download-URL (короткоживущий токен) — это не
// даёт долгоживущему токену протухнуть в БД и не светит его в logs.
// S3_PRESIGNED: используем сохранённый presigned URL напрямую.
async function downloadExportRow(ex: BackupExportRow) {
  try {
    if (ex.mode === 'STREAM') {
      const res = await api.post<{ downloadUrl: string }>(
        `/backup-exports/${ex.id}/issue-token`,
        {},
      );
      // На remote-сервере one-shot токен в querystring не сработает через
      // нативный <a> — мастер требует JWT для proxy-роута. Тянем через
      // api.download (с Authorization header) — тот сам добавит /proxy/{id}.
      // TODO(3b): для bulk-скачиваний 50GB+ переехать на signed URL прямо
      // к slave (см. proxy.service.ts::proxyRaw комментарий).
      try {
        const serverStore = useServerStore();
        if (!serverStore.isLocal && res.downloadUrl.startsWith('/api/')) {
          const dateStr = new Date(ex.createdAt).toISOString().slice(0, 10);
          const filename = `export-${dateStr}-${ex.id.slice(0, 8)}.tar.gz`;
          // Strip /api prefix — api.download сам добавит baseUrl
          const endpoint = res.downloadUrl.slice(4);
          await api.download(endpoint, filename);
          return;
        }
      } catch { /* fallback to native open */ }
      openExportLink(res.downloadUrl);
    } else if (ex.downloadUrl) {
      openExportLink(ex.downloadUrl);
    }
  } catch (err) {
    useMbToast().error((err as Error).message || 'Не удалось получить ссылку');
  }
}

async function deleteExportRow(id: string) {
  const ok = await useMbConfirm().ask({
    title: 'Удаление экспорта',
    message: 'Удалить этот экспорт?',
    confirmText: 'Удалить',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/backup-exports/${id}`);
    await loadExportsList();
  } catch (err) {
    useMbToast().error((err as Error).message || 'Ошибка удаления');
  }
}

async function downloadSiteBackup(b: SiteBackup) {
  const dateStr = new Date(b.createdAt).toISOString().slice(0, 10);
  try {
    // For differential backups, download base first, then diff
    if (b.type === 'DIFFERENTIAL' && b.baseBackupId) {
      backupDownloading[b.id] = 0;
      await api.download(
        `/backups/${b.baseBackupId}/download`,
        `backup-base-${dateStr}-${b.baseBackupId.slice(0, 8)}.tar.gz`,
        (pct) => { backupDownloading[b.id] = Math.round(pct / 2); },
      );
      await api.download(
        `/backups/${b.id}/download`,
        `backup-diff-${dateStr}-${b.id.slice(0, 8)}.tar.gz`,
        (pct) => { backupDownloading[b.id] = 50 + Math.round(pct / 2); },
      );
    } else {
      backupDownloading[b.id] = 0;
      await api.download(
        `/backups/${b.id}/download`,
        `backup-${dateStr}-${b.id.slice(0, 8)}.tar.gz`,
        (pct) => { backupDownloading[b.id] = pct; },
      );
    }
  } catch (err) {
    useMbToast().error((err as Error).message || 'Ошибка скачивания');
  } finally {
    delete backupDownloading[b.id];
  }
}

async function deleteSiteBackup(backupId: string) {
  const ok = await useMbConfirm().ask({
    title: 'Удаление бэкапа',
    message: 'Удалить этот бэкап? Файл бэкапа будет удалён с диска.',
    confirmText: 'Удалить',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/backups/${backupId}`);
    siteBackups.value = siteBackups.value.filter((b) => b.id !== backupId);
  } catch { /* ignore */ }
}

async function doRestoreSiteBackup() {
  if (!restoringSiteBackup.value) return;
  if (!canRunRestore.value) return;
  restoringBackup.value = true;
  restoreProgress.value = 0;
  restoreError.value = '';
  // includePaths — только если есть дерево и НЕ выбрано "всё"
  const usingSelective = restoringSiteBackup.value.engine === 'RESTIC'
    && restoreTree.value.length > 0
    && restoreScope.value !== 'DB_ONLY'
    && restoreSelected.size < restoreTree.value.length;
  const includePaths = usingSelective ? Array.from(restoreSelected) : undefined;
  // databaseIds: отправляем ТОЛЬКО если scope включает БД и снят хотя бы один чекбокс
  const sendDbIds =
    restoreScopeIncludesDb.value
    && (site.value?.databases?.length || 0) > 0
    && !restoreSelectedAllDbs.value;
  try {
    await api.post(`/backups/${restoringSiteBackup.value.id}/restore`, {
      cleanup: restoreCleanup.value,
      scope: restoreScope.value,
      ...(includePaths ? { includePaths } : {}),
      ...(sendDbIds ? { databaseIds: restoreDatabaseIds.value } : {}),
    });
    showSiteRestoreModal.value = false;
    restoringSiteBackup.value = null;
  } catch (err) {
    restoringBackup.value = false;
    restoreProgress.value = null;
    restoreError.value = (err as Error).message || 'Ошибка восстановления';
  }
}

function formatBackupDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatBackupSize(bytes?: number) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ─── Cron Jobs ───
interface CronJobItem {
  id: string;
  name: string;
  schedule: string;
  command: string;
  status: string;
  createdAt: string;
  lastRunAt?: string | null;
  lastExitCode?: number | null;
  lastOutput?: string | null;
}

const cronJobs = ref<CronJobItem[]>([]);
const cronLoading = ref(false);
const showCronModal = ref(false);
const creatingCron = ref(false);
const cronForm = reactive({ name: '', schedule: '', command: '' });
const editingCronJob = ref<CronJobItem | null>(null);
const expandedCronId = ref('');
const cronError = ref('');

const cronPresets = [
  { label: 'Каждую минуту', value: '*/1 * * * *' },
  { label: 'Каждый час', value: '0 * * * *' },
  { label: 'Ежедневно 3:00', value: '0 3 * * *' },
  { label: 'Еженедельно', value: '0 3 * * 0' },
];

function describeCronSchedule(sched: string): string {
  const p = cronPresets.find((x) => x.value === sched);
  if (p) return p.label;
  if (sched === '* * * * *') return 'Каждую минуту';
  if (sched === '0 * * * *') return 'Ежечасно';
  if (sched === '0 0 * * *') return 'Ежедневно в 00:00';
  if (sched === '0 0 * * 0') return 'Еженедельно (вс)';
  if (sched === '0 0 1 * *') return 'Ежемесячно (1-е)';
  return 'Кастом';
}

function formatCronDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function loadCronJobs() {
  cronLoading.value = true;
  try {
    cronJobs.value = await api.get<CronJobItem[]>(`/sites/${siteId}/cron-jobs`);
  } catch { cronJobs.value = []; }
  finally { cronLoading.value = false; }
}

function openCronEditor(job?: CronJobItem) {
  editingCronJob.value = job || null;
  cronForm.name = job?.name || '';
  cronForm.schedule = job?.schedule || '';
  cronForm.command = job?.command || '';
  cronError.value = '';
  showCronModal.value = true;
}

function closeCronModal() {
  showCronModal.value = false;
  editingCronJob.value = null;
  cronForm.name = '';
  cronForm.schedule = '';
  cronForm.command = '';
  cronError.value = '';
}

async function saveCronJob() {
  creatingCron.value = true;
  cronError.value = '';
  try {
    if (editingCronJob.value) {
      await api.put(`/cron-jobs/${editingCronJob.value.id}`, {
        name: cronForm.name.trim(),
        schedule: cronForm.schedule.trim(),
        command: cronForm.command.trim(),
      });
    } else {
      await api.post('/cron-jobs', {
        siteId,
        name: cronForm.name.trim(),
        schedule: cronForm.schedule.trim(),
        command: cronForm.command.trim(),
      });
    }
    closeCronModal();
    await loadCronJobs();
  } catch (e) {
    cronError.value = (e as Error)?.message || 'Не удалось сохранить крон-задачу';
  } finally {
    creatingCron.value = false;
  }
}

async function toggleCronJob(id: string) {
  try {
    await api.post(`/cron-jobs/${id}/toggle`);
    await loadCronJobs();
  } catch { /* ignore */ }
}

async function deleteCronJob(id: string) {
  const ok = await useMbConfirm().ask({
    title: 'Удаление крон-задачи',
    message: 'Удалить эту крон-задачу?',
    confirmText: 'Удалить',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/cron-jobs/${id}`);
    cronJobs.value = cronJobs.value.filter((c) => c.id !== id);
  } catch { /* ignore */ }
}

// ─── Site Logs ───
const logTypes = [
  { id: 'access', label: 'Лог доступа' },
  { id: 'error', label: 'Лог ошибок' },
  { id: 'php', label: 'Ошибки PHP' },
  { id: 'app', label: 'Лог приложения' },
];

const logActiveType = ref('access');
const logLoading = ref(false);
const logLines = ref<string[]>([]);
const logOutput = ref<HTMLElement | null>(null);
const logAutoRefresh = ref(false);
let logAutoRefreshTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Форматтер строк лога. PHP-FPM при логировании в stderr склеивает
 * множество `PHP message: ...` в ОДНУ физическую строку nginx-error.log
 * (без переноса). Получается простыня типа:
 *   "...stderr: \"PHP message: PHP Notice: ... PHP message: PHP Notice: ...\""
 * Чтобы это можно было читать — режем каждую строку по ` PHP message: `
 * и каждый сегмент рендерим с отступом, не теряя префикс с timestamp/error
 * перед первым `PHP message:`.
 */
const formattedLogText = computed(() => {
  return logLines.value
    .map((line) => {
      if (!line.includes('PHP message:')) return line;
      // Делим перед каждым `PHP message:`, КРОМЕ первого вхождения внутри
      // строки (тот идёт сразу за nginx-преамбулой, переносить не нужно).
      const parts = line.split(/ (?=PHP message: )/);
      if (parts.length <= 1) return line;
      return parts.map((p, i) => (i === 0 ? p : '    ' + p)).join('\n');
    })
    .join('\n');
});

function toggleLogAutoRefresh() {
  logAutoRefresh.value = !logAutoRefresh.value;
  if (logAutoRefresh.value) {
    loadLogs();
    logAutoRefreshTimer = setInterval(() => loadLogs(), 3000);
  } else {
    clearInterval(logAutoRefreshTimer);
    logAutoRefreshTimer = undefined;
  }
}

async function loadLogs() {
  if (!site.value) return;
  logLoading.value = true;
  try {
    const data = await api.get<{ type: string; path: string; lines: string[]; totalLines: number }>(
      `/sites/${siteId}/logs/read?type=${logActiveType.value}&lines=500`,
    );
    logLines.value = data?.lines || [];
    // Auto-scroll to bottom
    nextTick(() => {
      if (logOutput.value) {
        logOutput.value.scrollTop = logOutput.value.scrollHeight;
      }
    });
  } catch {
    logLines.value = [];
  } finally {
    logLoading.value = false;
  }
}

// Watch tab changes to load files/logs on demand
watch(activeTab, (tab) => {
  if (tab === 'files' && fmFiles.value.length === 0 && !fmLoading.value) {
    fmCurrentPath.value = '/';
    fmLoad();
  }
  if (tab === 'logs' && logLines.value.length === 0 && !logLoading.value) {
    loadLogs();
  }
  // Stop auto-refresh when leaving logs tab
  if (tab !== 'logs' && logAutoRefresh.value) {
    logAutoRefresh.value = false;
    clearInterval(logAutoRefreshTimer);
    logAutoRefreshTimer = undefined;
  }
  if (tab === 'backups' && siteBackups.value.length === 0 && !siteBackupsLoading.value) {
    loadSiteBackups();
    loadSiteStorageLocations();
  }
  if (tab === 'cron' && cronJobs.value.length === 0 && !cronLoading.value) {
    loadCronJobs();
  }
  // Nginx/PHP вкладки — конфиг мог измениться извне (поменяли алиасы с
  // редиректом → бэкенд перегенерил nginx; поменяли PHP-версию → новый пул).
  // Поэтому при каждом открытии вкладки перетягиваем с сервера, чтобы показать
  // актуальный конфиг, а не закешированный с первого открытия.
  // Исключение: если у юзера есть несохранённые правки (dirty) — не трогаем,
  // иначе затрём его работу.
  // (Nginx теперь обрабатывает SiteNginxTab сам — удалили loadNginxConfig.)
  if (tab === 'php' && site.value?.phpVersion && !phpPoolDirty.value) {
    loadPhpPoolConfig();
  }
});

// ===========================================================================
// Migration
// ===========================================================================

const showMigrateModal = ref(false);
const migrateTarget = ref('');
const migrateReissueSsl = ref(true);
const migrateStopSource = ref(false);
const migrateStarting = ref(false);
const migrateError = ref('');
const migrationId = ref('');
const migrationStepIndex = ref(0);
const migrationError = ref('');
const migrationDone = ref(false);
const migrationRunning = ref(false);
let migrationPollTimer: ReturnType<typeof setInterval> | undefined;

const migrationSteps = [
  { key: 'backup', label: 'Создание бэкапа' },
  { key: 'waiting_backup', label: 'Ожидание завершения бэкапа' },
  { key: 'download_token', label: 'Подготовка передачи файла' },
  { key: 'metadata', label: 'Получение метаданных сайта' },
  { key: 'create_site', label: 'Создание сайта на целевом сервере' },
  { key: 'import_pull', label: 'Передача и восстановление из бэкапа' },
  { key: 'waiting_pull', label: 'Ожидание завершения передачи' },
  { key: 'ssl', label: 'Перевыпуск SSL-сертификата' },
  { key: 'cleanup', label: 'Остановка оригинала' },
  { key: 'done', label: 'Миграция завершена' },
];

const migrateTargetServers = computed(() => {
  const currentId = serverStore.currentServerId || 'main';
  return serverStore.servers.filter(s => s.id !== currentId);
});

async function startMigration() {
  if (!migrateTarget.value) return;
  migrateStarting.value = true;
  migrateError.value = '';
  try {
    const res = await api.post<{ migrationId: string }>('/migration/start', {
      siteId,
      sourceServerId: serverStore.currentServerId || 'main',
      targetServerId: migrateTarget.value,
      reissueSsl: migrateReissueSsl.value,
      stopSource: migrateStopSource.value,
      panelUrl: window.location.origin,
    });
    migrationId.value = res?.migrationId || '';
    migrationRunning.value = true;
    migrationStepIndex.value = 0;
    migrationError.value = '';
    migrationDone.value = false;
    pollMigrationStatus();
  } catch (err) {
    migrateError.value = (err as Error).message || 'Ошибка запуска миграции';
  } finally {
    migrateStarting.value = false;
  }
}

function pollMigrationStatus() {
  if (migrationPollTimer) clearInterval(migrationPollTimer);
  migrationPollTimer = setInterval(async () => {
    if (!migrationId.value) return;
    try {
      const state = await api.get<{
        step: string;
        stepIndex: number;
        message: string;
        error?: string;
        completedAt?: string;
      }>(`/migration/${migrationId.value}/status`);
      if (!state) return;
      migrationStepIndex.value = state.stepIndex;
      if (state.step === 'done') {
        migrationDone.value = true;
        migrationRunning.value = false;
        clearInterval(migrationPollTimer);
      } else if (state.step === 'failed' || state.error) {
        migrationError.value = state.error || state.message || 'Неизвестная ошибка';
        migrationRunning.value = false;
        clearInterval(migrationPollTimer);
      }
    } catch {
      // Polling error — keep trying
    }
  }, 3000);
}

function closeMigrateModal() {
  showMigrateModal.value = false;
  migrationId.value = '';
  migrationStepIndex.value = 0;
  migrationError.value = '';
  migrationDone.value = false;
  migrationRunning.value = false;
  migrateError.value = '';
  if (migrationPollTimer) clearInterval(migrationPollTimer);
}

function confirmDelete() {
  deleteConfirmInput.value = '';
  showDeleteModal.value = true;
}

// Флаги удаления — по умолчанию всё true (полная зачистка).
const deleteOpts = ref({
  removeFiles: true,
  removeDatabases: true,
  removeSslCertificate: true,
  removeBackupsLocal: true,
  removeBackupsRestic: true,
  removeBackupsRemote: true,
  removeNginxConfig: true,
  removePhpPool: true,
  removeSystemUser: true,
});

async function deleteSite() {
  if (!site.value || deleteConfirmInput.value !== site.value.name) return;
  deleting.value = true;
  try {
    await api.del(`/sites/${siteId}`, { ...deleteOpts.value });
    await router.push('/sites');
  } catch {
    deleting.value = false;
  }
}

onMounted(async () => {
  try {
    site.value = await api.get<SiteDetail>(`/sites/${siteId}`);
    // Восстанавливаем dismissed-флаг hostpanel-баннера (spec §9.4) из
    // localStorage по siteId — иначе после refresh оператор увидит баннер
    // снова, хоть и нажал «скрыть».
    try {
      hostpanelBannerDismissed.value =
        localStorage.getItem(`hp-banner-dismissed-${siteId}`) === '1';
    } catch {
      /* ignore disabled storage */
    }
    domainAliases.value = normalizeAliases(site.value?.aliases);
    envOriginal.value = JSON.stringify(site.value?.envVars || {});
    syncSiteExcludesFromSite();
    // Load deploy logs, site metrics, and servers in background
    loadDeployLogs();
    loadSiteMetrics();
    loadSiteHealth();
    loadSiteStorage();
    loadSiteActivity();
    loadInstalledPhpVersions();
    serverStore.loadServers();
    setupBackupProgressWs();

    // При прямом заходе/F5 на URL с ?tab=... watch(activeTab, ...) НЕ срабатывает
    // (значение не меняется), поэтому контент таба остаётся пустым. Дёргаем
    // ту же ленивую загрузку руками — после того как site.value уже загружен.
    const tab = activeTab.value;
    if (tab === 'files' && fmFiles.value.length === 0 && !fmLoading.value) {
      fmCurrentPath.value = '/';
      fmLoad();
    }
    if (tab === 'logs' && logLines.value.length === 0 && !logLoading.value) {
      loadLogs();
    }
    if (tab === 'backups' && siteBackups.value.length === 0 && !siteBackupsLoading.value) {
      loadSiteBackups();
      loadSiteStorageLocations();
    }
    if (tab === 'cron' && cronJobs.value.length === 0 && !cronLoading.value) {
      loadCronJobs();
    }
    // tab === 'nginx' — компонент SiteNginxTab сам грузит данные при mount.
    if (tab === 'php' && site.value?.phpVersion && !phpPoolDirty.value) {
      loadPhpPoolConfig();
    }
  } catch {
    // Will show not found
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  if (logAutoRefreshTimer) {
    clearInterval(logAutoRefreshTimer);
  }
  if (sslElapsedTimer) {
    clearInterval(sslElapsedTimer);
  }
  if (migrationPollTimer) {
    clearInterval(migrationPollTimer);
  }
  if (deployPollTimer) {
    clearInterval(deployPollTimer);
  }
  if (resticCheckPollTimer) {
    clearInterval(resticCheckPollTimer);
  }
  if (exportDialog.pollTimer) {
    clearInterval(exportDialog.pollTimer);
  }
  if (cleanupBackupWs) {
    cleanupBackupWs();
  }
  if (cleanupRestoreWs) {
    cleanupRestoreWs();
  }
  stopBackupStatusPoll();
});
</script>

<style scoped>
.site-detail__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 4rem 2rem;
  color: var(--text-muted);
  font-size: 0.85rem;
}

.site-detail__loading-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--spinner-track);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Header */
.site-detail__header {
  margin-bottom: 1.5rem;
}

.site-detail__back {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.8rem;
  color: var(--text-muted);
  text-decoration: none;
  margin-bottom: 0.75rem;
  transition: color 0.2s;
}

.site-detail__back:hover {
  color: var(--text-secondary);
}

.site-detail__header-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.site-detail__header-left {
  display: flex;
  align-items: center;
  gap: 0.85rem;
}

.site-detail__title {
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0;
}

.site-detail__domain {
  font-size: 0.8rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-muted);
  margin: 0.1rem 0 0;
}

.site-detail__header-right {
  display: flex;
  align-items: center;
  gap: 0.85rem;
}

.site-detail__actions-group {
  display: flex;
  gap: 0.35rem;
}

.site-detail__action-btn {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-elevated);
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s;
}

.site-detail__action-btn:hover {
  background: var(--border-secondary);
  color: var(--text-secondary);
}

.site-detail__action-btn--start:hover {
  background: rgba(34, 197, 94, 0.08);
  border-color: rgba(34, 197, 94, 0.15);
  color: #4ade80;
}

.site-detail__action-btn--stop:hover {
  background: rgba(239, 68, 68, 0.08);
  border-color: rgba(239, 68, 68, 0.15);
  color: #f87171;
}

.site-detail__error-banner {
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: 10px;
  padding: 0.85rem 1rem;
  margin-bottom: 1rem;
  color: #fca5a5;
  font-size: 0.82rem;
}
.site-detail__error-banner-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.site-detail__error-banner-text {
  margin: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  color: #f87171;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow-y: auto;
}

/* Hostpanel migration banner — SSL reissue notice (spec §9.4) */
.site-detail__hp-banner {
  background: rgba(var(--primary-rgb), 0.08);
  border: 1px solid rgba(var(--primary-rgb), 0.3);
  border-radius: 10px;
  padding: 0.85rem 1rem;
  margin-bottom: 1rem;
  color: #fcd34d;
}
html.theme-light .site-detail__hp-banner {
  /* На светлой теме amber-300 (#fcd34d) сливается с фоном — используем
     более насыщенный amber-700 для заголовка и стандартный text-secondary
     для тела сообщения. */
  background: rgba(var(--primary-rgb), 0.1);
  border-color: rgba(var(--primary-rgb), 0.4);
  color: var(--primary-text);
}
.site-detail__hp-banner-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
}
.site-detail__hp-banner-text {
  margin: 0 0 0.6rem;
  font-size: 0.82rem;
  color: var(--text-secondary);
  line-height: 1.45;
}
.site-detail__hp-banner-text code {
  background: rgba(0, 0, 0, 0.3);
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  color: #fcd34d;
}
html.theme-light .site-detail__hp-banner-text code {
  background: rgba(var(--primary-rgb), 0.12);
  color: var(--primary-text);
}
.site-detail__hp-banner-actions {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

/* Tabs */
.site-detail__tabs {
  display: flex;
  gap: 0.1rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 1.5rem;
}

.site-detail__tab {
  display: flex;
  align-items: center;
  gap: 0.4rem;
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

.site-detail__tab:hover {
  color: var(--text-tertiary);
}

.site-detail__tab--active {
  color: var(--primary-text);
  border-bottom-color: var(--primary);
}

.site-detail__tab-count {
  font-size: 0.65rem;
  font-weight: 600;
  padding: 0.1rem 0.35rem;
  border-radius: 6px;
  background: var(--border);
  color: var(--text-muted);
}

.site-detail__tab--active .site-detail__tab-count {
  background: var(--primary-bg);
  color: var(--primary-text);
}

/* Overview grid */
.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.info-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  padding: 1.15rem;
}

.info-card__title {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-tertiary);
  margin: 0 0 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.info-card__rows {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.info-card__footer {
  margin-top: 1rem;
  padding-top: 0.85rem;
  border-top: 1px solid var(--border-secondary);
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.info-card__footer-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.info-card__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
}

.info-card__spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--spinner-track);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

.info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.info-row__label {
  font-size: 0.78rem;
  color: var(--text-muted);
  flex-shrink: 0;
}

.info-row__value {
  font-size: 0.82rem;
  color: var(--text-secondary);
  text-align: right;
  word-break: break-all;
}

.info-row__value--mono {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.75rem;
}

.info-row__value--muted {
  color: var(--text-muted);
  font-style: italic;
}

.info-row__btn {
  margin-left: 0.5rem;
  padding: 0.15rem 0.5rem;
  font-size: 0.7rem;
  border: 1px solid var(--border-secondary);
  border-radius: 4px;
  background: transparent;
  color: #a78bfa;
  cursor: pointer;
  transition: all 0.15s;
}
.info-row__btn:hover {
  background: var(--bg-surface-hover);
  border-color: #a78bfa;
}

.info-row__select {
  background: var(--bg-surface);
  color: var(--text-body);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 0.2rem 0.5rem;
  font-size: 0.82rem;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.15s;
}

.info-row__select:hover {
  border-color: var(--primary-text);
}

.info-row__select:disabled {
  opacity: 0.5;
  cursor: wait;
}

.ssl-active { color: #4ade80; }
.ssl-warning { color: var(--primary-text); }
.ssl-error { color: #f87171; }

/* Domains */
.domains-section { display: flex; flex-direction: column; gap: 1rem; }
.domains-header { display: flex; align-items: center; justify-content: space-between; }
.domains-header .info-card__title { margin: 0; }
.domains-list { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 0.85rem; }
.domain-item {
  display: flex; align-items: center; gap: 0.6rem;
  padding: 0.5rem 0.75rem; background: var(--bg-elevated); border-radius: 8px;
}
.domain-item__name { flex: 1; min-width: 0; font-family: 'JetBrains Mono', monospace; font-size: 0.82rem; color: var(--text-secondary); overflow-wrap: anywhere; }
.domain-item__toggle {
  display: inline-flex; align-items: center; gap: 0.4rem; cursor: pointer;
  font-size: 0.72rem; color: var(--text-muted); user-select: none;
}
.domain-item__toggle input { position: absolute; opacity: 0; pointer-events: none; }
.domain-item__toggle-slider {
  position: relative; width: 30px; height: 16px; background: var(--bg-input);
  border: 1px solid var(--border-secondary); border-radius: 16px; transition: all 0.15s;
  flex-shrink: 0;
}
.domain-item__toggle-slider::before {
  content: ''; position: absolute; left: 2px; top: 50%; transform: translateY(-50%);
  width: 10px; height: 10px; border-radius: 50%; background: var(--text-muted); transition: all 0.15s;
}
.domain-item__toggle input:checked + .domain-item__toggle-slider {
  background: rgba(99, 102, 241, 0.25); border-color: var(--primary-text);
}
.domain-item__toggle input:checked + .domain-item__toggle-slider::before {
  left: 16px; background: var(--primary-text);
}
.domain-item__toggle input:disabled ~ * { opacity: 0.6; cursor: not-allowed; }
.domain-item__toggle-label { font-family: 'JetBrains Mono', monospace; font-size: 0.7rem; min-width: 40px; }
.domain-item__remove {
  width: 26px; height: 26px; border-radius: 6px; border: none; background: transparent;
  color: var(--text-faint); display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: all 0.15s; flex-shrink: 0;
}
.domain-item__remove:hover { background: rgba(239, 68, 68, 0.1); color: #f87171; }
.domain-item__remove:disabled { opacity: 0.5; cursor: not-allowed; }
.domains-hint { font-size: 0.7rem; color: var(--text-muted); }
.domains-empty { font-size: 0.82rem; color: var(--text-muted); padding: 0.75rem 0; }
.domains-add {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
  align-items: stretch;
}
.domains-add__input {
  flex: 1;
  min-width: 0;
  padding: 0.55rem 0.85rem;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.82rem;
  background: var(--bg-input, var(--bg-elevated));
  border: 1px solid var(--border-secondary);
  border-radius: 9px;
  color: var(--text-primary);
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
.domains-add__input::placeholder { color: var(--text-faint); }
.domains-add__input:hover { border-color: var(--border); }
.domains-add__input:focus {
  border-color: var(--primary-text);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
  background: var(--bg-surface);
}
.domains-add__btn {
  flex-shrink: 0;
  padding: 0 1rem;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  white-space: nowrap;
}

/* Cert coverage badge (main domain + aliases) */
.domain-with-cert {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  flex: 1;
}
.cert-badge {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: help;
  transition: transform 0.15s;
}
.cert-badge:hover { transform: scale(1.15); }
.cert-badge--covered { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }
.cert-badge--missing { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
.cert-badge--redirect { background: rgba(148, 163, 184, 0.12); color: #94a3b8; border: 1px solid rgba(148, 163, 184, 0.25); }

/* Light-theme: светлые иконки из rgba-версий-для-тёмного-на-тёмном выглядят
   бледно и контраст иконки внутри на белом почти пропадает — делаем насыщенней */
html.theme-light .cert-badge--covered { background: rgba(34, 197, 94, 0.15); color: #15803d; border-color: rgba(34, 197, 94, 0.35); }
html.theme-light .cert-badge--missing { background: rgba(239, 68, 68, 0.15); color: #b91c1c; border-color: rgba(239, 68, 68, 0.35); }
html.theme-light .cert-badge--redirect { background: rgba(100, 116, 139, 0.12); color: #475569; border-color: rgba(100, 116, 139, 0.3); }

/* Domain→SAN mismatch alert (above domain cards) */
.domains-cert-alert {
  display: flex;
  gap: 0.75rem;
  padding: 0.8rem 1rem;
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.08), rgba(251, 146, 60, 0.08));
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: 12px;
  align-items: flex-start;
}
.domains-cert-alert__icon {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: rgba(239, 68, 68, 0.15);
  color: #f87171;
  display: flex;
  align-items: center;
  justify-content: center;
}
.domains-cert-alert__body {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.78rem;
  color: var(--text-secondary);
  line-height: 1.5;
}
.domains-cert-alert__body strong { color: #fca5a5; font-size: 0.82rem; font-weight: 600; }
.domains-cert-alert__body code {
  background: rgba(239, 68, 68, 0.12);
  color: #fca5a5;
  padding: 0.05em 0.35em;
  border-radius: 4px;
  font-size: 0.9em;
}

/* Light theme overrides для алерта: красный hex (#fca5a5) на белом теряется,
   фон-градиент слишком прозрачный. Ужесточаем контраст. */
html.theme-light .domains-cert-alert {
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.07), rgba(251, 146, 60, 0.07));
  border-color: rgba(239, 68, 68, 0.25);
}
html.theme-light .domains-cert-alert__icon {
  background: rgba(239, 68, 68, 0.12);
  color: #dc2626;
}
html.theme-light .domains-cert-alert__body strong { color: #b91c1c; }
html.theme-light .domains-cert-alert__body code {
  background: rgba(239, 68, 68, 0.1);
  color: #b91c1c;
}

/* Вариант алерта внутри info-card («Перевыпуск сертификата») — компактней */
.ssl-le__mismatch {
  margin: 0.4rem 0 0.9rem;
  padding: 0.7rem 0.85rem;
  gap: 0.6rem;
  font-size: 0.77rem;
}
.ssl-le__mismatch .domains-cert-alert__body { gap: 0.3rem; }

/* «Изменить» button на строке с доменом — теперь строго в одну строку */
.info-row__btn--inline {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  white-space: nowrap;
  flex-shrink: 0;
}
.info-row__btn--inline svg { flex-shrink: 0; }

/* ------ Domain-change modal (большая новая модалка) ------ */
.domain-modal {
  width: min(560px, calc(100vw - 2rem));
  max-height: calc(100vh - 2rem);
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
}
.domain-modal__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.1rem 1.25rem 0.9rem;
  border-bottom: 1px solid var(--border);
}
.domain-modal__title-group {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}
.domain-modal__icon {
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  border-radius: 11px;
  background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.18), rgba(239, 68, 68, 0.15));
  color: var(--primary-light);
  display: flex;
  align-items: center;
  justify-content: center;
}
.domain-modal__title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--text-heading);
  line-height: 1.2;
}
.domain-modal__subtitle {
  margin: 0.15rem 0 0;
  font-size: 0.72rem;
  color: var(--text-muted);
}
.domain-modal__subtitle code {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.9em;
  background: var(--bg-elevated);
  padding: 0.05em 0.3em;
  border-radius: 4px;
}
.domain-modal__close {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--border-secondary);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.domain-modal__close:hover:not(:disabled) { background: var(--bg-elevated); color: var(--text-primary); border-color: var(--border); }
.domain-modal__close:disabled { opacity: 0.4; cursor: not-allowed; }

.domain-modal__body {
  padding: 1.1rem 1.25rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

.domain-modal__swap {
  display: grid;
  grid-template-columns: 1fr auto 1.3fr;
  align-items: end;
  gap: 0.75rem;
}
.domain-modal__swap-col { display: flex; flex-direction: column; gap: 0.4rem; min-width: 0; }
.domain-modal__label {
  font-size: 0.68rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-faint);
}
.domain-modal__chip {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.55rem 0.75rem;
  border-radius: 9px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-secondary);
  color: var(--text-muted);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8rem;
  min-height: 38px;
  overflow-wrap: anywhere;
}
.domain-modal__chip code { background: none; color: inherit; font-size: 1em; }
.domain-modal__chip--current { color: var(--text-secondary); }
.domain-modal__arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  padding-bottom: 0.55rem;
  color: var(--text-faint);
}

.domain-modal__input-wrap {
  position: relative;
  display: flex;
  align-items: center;
  background: var(--bg-input, var(--bg-elevated));
  border: 1px solid var(--border-secondary);
  border-radius: 9px;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
  min-height: 38px;
}
.domain-modal__input-wrap:hover { border-color: var(--border); }
.domain-modal__input-wrap:focus-within {
  border-color: var(--primary-text);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
  background: var(--bg-surface);
}
.domain-modal__input-wrap--error {
  border-color: #f87171;
  box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.15);
}
.domain-modal__input-icon {
  flex-shrink: 0;
  margin-left: 0.7rem;
  color: var(--text-faint);
}
.domain-modal__input {
  flex: 1;
  min-width: 0;
  padding: 0.55rem 0.75rem 0.55rem 0.5rem;
  background: none;
  border: none;
  outline: none;
  color: var(--text-primary);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.82rem;
}
.domain-modal__input::placeholder { color: var(--text-faint); }
.domain-modal__input:disabled { opacity: 0.6; cursor: not-allowed; }
.domain-modal__error {
  font-size: 0.72rem;
  color: #f87171;
  margin-top: 0.15rem;
}

.domain-modal__impact {
  padding: 0.85rem 1rem;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle, var(--border-secondary));
  border-radius: 11px;
}
.domain-modal__impact-title {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  margin-bottom: 0.55rem;
}
.domain-modal__impact-list {
  margin: 0;
  padding-left: 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  font-size: 0.78rem;
  color: var(--text-secondary);
  line-height: 1.5;
}
.domain-modal__impact-list code {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.9em;
  background: rgba(99, 102, 241, 0.1);
  color: #a78bfa;
  padding: 0.05em 0.35em;
  border-radius: 4px;
}
.domain-modal__impact-danger { color: #fca5a5; }
.domain-modal__impact-danger code { background: rgba(239, 68, 68, 0.12); color: #fca5a5; }

/* Светлая тема: pink-300 на белом плохо читается — берём более тёмный. */
html.theme-light .domain-modal__impact-danger { color: #b91c1c; }
html.theme-light .domain-modal__impact-danger code {
  background: rgba(239, 68, 68, 0.08);
  color: #b91c1c;
}

/* Блок с готовой shell-командой внутри пункта impact-list. Используется
   для подсказки переноса папки на диске после смены filesRelPath. */
.domain-modal__cmd {
  display: block;
  margin: 0.45rem 0 0;
  padding: 0.55rem 0.7rem;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  line-height: 1.45;
  color: var(--text-secondary);
  background: var(--bg-input, var(--bg-elevated));
  border: 1px solid var(--border-subtle, var(--border-secondary));
  border-radius: 7px;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: all;
}
html.theme-light .domain-modal__cmd {
  background: rgba(0, 0, 0, 0.03);
}

.domain-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.55rem;
  padding: 0.9rem 1.25rem;
  border-top: 1px solid var(--border);
  background: var(--bg-secondary, var(--bg-surface));
}
.domain-modal__footer .btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

@media (max-width: 560px) {
  .domain-modal__swap {
    grid-template-columns: 1fr;
    gap: 0.5rem;
  }
  .domain-modal__arrow {
    transform: rotate(90deg);
    padding: 0;
    justify-self: start;
  }
}

/* Databases */
.db-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.db-item {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 0.85rem 1rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 12px;
}

.db-item__icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: rgba(139, 92, 246, 0.1);
  color: #a78bfa;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.db-item__info {
  display: flex;
  flex-direction: column;
}

.db-item__name {
  font-size: 0.85rem;
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-secondary);
}

.db-item__meta {
  font-size: 0.72rem;
  color: var(--text-muted);
  margin-top: 0.15rem;
}

.db-item__info { flex: 1; }

.db-item__action {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.45rem 0.85rem;
  border-radius: 8px;
  border: 1px solid transparent;
  background: linear-gradient(135deg, #60a5fa, #2563eb);
  color: #fff;
  font-size: 0.75rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s;
}
.db-item__action:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(59, 130, 246, 0.25);
}
.db-item__action:disabled { opacity: 0.55; cursor: wait; }

/* Adminer picker (несколько БД у сайта) */
.adminer-picker {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-top: 0.4rem;
  padding: 0.4rem;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.adminer-picker__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.4rem 0.6rem;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s;
}
.adminer-picker__item:hover:not(:disabled) {
  background: var(--bg-surface);
  border-color: var(--border);
}
.adminer-picker__item:disabled { opacity: 0.5; cursor: wait; }
.adminer-picker__name {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  color: var(--text-secondary);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.adminer-picker__meta {
  font-size: 0.66rem;
  color: var(--text-muted);
  flex-shrink: 0;
}

/* MODX Doctor — отдельный нотис под блоком CMS */
.modx-doctor-notice {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  margin-top: 0.85rem;
  padding: 0.7rem 0.85rem;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-left: 3px solid #60a5fa;
  border-radius: 8px;
}
.modx-doctor-notice__body { flex: 1; min-width: 0; }
.modx-doctor-notice__title {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-heading);
  margin-bottom: 0.2rem;
}
.modx-doctor-notice__title svg { color: #60a5fa; }
.modx-doctor-notice__hint {
  font-size: 0.7rem;
  color: var(--text-muted);
  line-height: 1.45;
}
.modx-doctor-notice__hint code {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.66rem;
  background: var(--bg-surface);
  padding: 0.05rem 0.3rem;
  border-radius: 4px;
  color: var(--text-secondary);
}
.modx-doctor-notice__btn {
  flex-shrink: 0;
  padding: 0.4rem 0.85rem;
  background: linear-gradient(135deg, #60a5fa, #2563eb);
  color: #fff;
  border: 1px solid transparent;
  border-radius: 7px;
  font-size: 0.74rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}
.modx-doctor-notice__btn:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(59,130,246,0.25); }

/* Nginx config */
.config-view {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  overflow: hidden;
}

.config-view__header {
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-code);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.config-view__actions {
  display: flex;
  gap: 0.4rem;
}

.config-view__path {
  font-size: 0.72rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-muted);
}

.config-view__code {
  padding: 1rem;
  margin: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.75rem;
  line-height: 1.6;
  color: var(--text-secondary);
  overflow-x: auto;
  white-space: pre;
}

.config-view__editor {
  width: 100%;
  min-height: 400px;
  padding: 1rem;
  margin: 0;
  background: var(--bg-code);
  color: var(--text-secondary);
  border: none;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.75rem;
  line-height: 1.6;
  resize: vertical;
  outline: none;
  tab-size: 4;
}

.config-view__editor:disabled {
  opacity: 0.6;
}

.config-view__test {
  padding: 0.5rem 1rem;
  font-size: 0.75rem;
  font-family: 'JetBrains Mono', monospace;
  border-top: 1px solid var(--border);
  margin: 0;
}

.config-view__test--ok {
  color: #4ade80;
  background: rgba(34, 197, 94, 0.05);
}

.config-view__test--err {
  color: #f87171;
  background: rgba(239, 68, 68, 0.05);
}

/* PHP-FPM pool editor */
.php-pool-hint {
  padding: 0.75rem 1rem;
  background: rgba(250, 204, 21, 0.06);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: 0.78rem;
  line-height: 1.55;
  margin: 0;
}
.php-pool-hint code {
  background: var(--bg-code);
  padding: 0.08em 0.38em;
  border-radius: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.85em;
}
.php-pool-rendered {
  border-top: 1px solid var(--border);
}
.php-pool-rendered > summary {
  padding: 0.5rem 1rem;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 0.78rem;
  user-select: none;
}
.php-pool-rendered > summary:hover {
  color: var(--text-primary);
}
.config-view__editor--readonly {
  min-height: 260px;
  font-size: 0.7rem;
  white-space: pre;
  overflow: auto;
}

/* Environment */
.env-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  padding: 1rem;
}

.env-item {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  padding: 0.3rem 0;
}

.env-item__key {
  color: var(--primary-text);
  font-weight: 500;
}

.env-item__eq {
  color: var(--text-faint);
}

.env-item__val {
  color: var(--text-tertiary);
  word-break: break-all;
}

.env-item__del {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--text-faint);
  cursor: pointer;
  padding: 0.15rem;
  border-radius: 4px;
  display: flex;
  opacity: 0;
  transition: all 0.15s;
}

.env-item:hover .env-item__del {
  opacity: 1;
}

.env-item__del:hover {
  color: #f87171;
  background: rgba(239, 68, 68, 0.1);
}

.env-section {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.env-add {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.env-add__input {
  background: var(--bg-surface);
  color: var(--text-body);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 0.4rem 0.6rem;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  outline: none;
}

.env-add__input:focus {
  border-color: var(--primary-border);
}

.env-add__input--key {
  width: 160px;
  text-transform: uppercase;
}

.env-add__input--val {
  flex: 1;
}

.env-add__eq {
  color: var(--text-faint);
  font-family: 'JetBrains Mono', monospace;
}

.env-actions {
  display: flex;
  gap: 0.5rem;
}

/* SSL section */
.ssl-section {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.ssl-le__desc {
  font-size: 0.82rem;
  color: var(--text-muted);
  margin: 0.5rem 0 0.75rem;
  line-height: 1.4;
}

.ssl-le__actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.ssl-le__actions .btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.ssl-le__progress {
  font-size: 0.78rem;
  color: var(--text-muted);
}

.ssl-le__elapsed {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  color: var(--text-faint);
}

.ssl-le__error {
  font-size: 0.78rem;
  color: #f87171;
  white-space: pre-wrap;
}

.ssl-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border-secondary);
  flex-wrap: wrap;
}

.modal--wide {
  max-width: 560px;
  width: 100%;
}

.delete-opts {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin: 0.75rem 0;
  padding: 0.75rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
}

.delete-opts__row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  cursor: pointer;
  padding: 0.2rem 0;
}

.delete-opts__row input[type="checkbox"] {
  width: 16px;
  height: 16px;
  margin: 0;
  cursor: pointer;
  accent-color: var(--primary, #10b981);
}

.delete-opts__label {
  flex: 1;
  color: var(--text-primary);
}

.delete-opts__hint {
  font-size: 0.72rem;
  color: var(--text-muted);
  font-family: 'JetBrains Mono', monospace;
}

.config-view__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 2rem 1rem;
  color: var(--text-muted);
  font-size: 0.85rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  min-height: 200px;
}

.spinner-small {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-secondary);
  border-top-color: var(--primary, #10b981);
  border-radius: 50%;
  animation: spinner-rotate 0.8s linear infinite;
}

@keyframes spinner-rotate {
  to { transform: rotate(360deg); }
}

.ssl-upload {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  padding: 1.25rem;
}

.ssl-upload__title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 0;
}

.ssl-upload__desc {
  font-size: 0.78rem;
  color: var(--text-muted);
  margin: 0.25rem 0 1rem;
}

.ssl-upload__fields {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.ssl-textarea {
  width: 100%;
  min-height: 120px;
  padding: 0.65rem 0.85rem;
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.75rem;
  line-height: 1.5;
  resize: vertical;
  outline: none;
  transition: border-color 0.2s;
  box-sizing: border-box;
}

.ssl-textarea:focus {
  border-color: var(--primary-border);
}

.ssl-textarea--sm {
  min-height: 80px;
}

.ssl-upload__actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 1rem;
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

.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.55rem 1.1rem;
  border-radius: 10px;
  border: none;
  font-size: 0.82rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.btn--primary {
  background: linear-gradient(135deg, var(--primary-light), var(--primary-dark));
  color: var(--primary-text-on);
}

.btn--primary:not(:disabled):hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(var(--primary-rgb), 0.2);
}

.btn--primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn--secondary {
  background: var(--bg-surface-hover);
  color: var(--text-body);
  border: 1px solid var(--border-subtle);
}

.btn--secondary:not(:disabled):hover {
  border-color: var(--primary-border);
  color: var(--text-primary);
}

/* Danger zone */
.danger-zone {
  border: 1px solid rgba(239, 68, 68, 0.15);
  border-radius: 14px;
  overflow: hidden;
}

.danger-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 1.25rem;
}

.danger-item__title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 0;
}

.danger-item__desc {
  font-size: 0.78rem;
  color: var(--text-muted);
  margin: 0.3rem 0 0;
}

.danger-item__btn {
  padding: 0.5rem 1rem;
  border-radius: 10px;
  border: 1px solid rgba(239, 68, 68, 0.25);
  background: rgba(239, 68, 68, 0.06);
  color: #f87171;
  font-size: 0.82rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
  flex-shrink: 0;
}

.danger-item__btn:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.12);
  border-color: rgba(239, 68, 68, 0.35);
}

.danger-item__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Tab empty */
.tab-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 3rem 2rem;
  text-align: center;
}

.tab-empty__text {
  color: var(--text-muted);
  font-size: 0.85rem;
  margin-top: 0.75rem;
}

/* Not found */
.site-detail__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem 2rem;
  text-align: center;
}

.site-detail__empty-text {
  color: var(--text-muted);
  font-size: 0.95rem;
  margin-top: 1rem;
}

.site-detail__empty-link {
  color: var(--primary-text);
  text-decoration: none;
  font-size: 0.85rem;
  margin-top: 0.5rem;
}

.site-detail__empty-link:hover {
  text-decoration: underline;
}

/* Delete modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal {
  background: var(--bg-modal);
  border: 1px solid var(--border-strong);
  border-radius: 16px;
  padding: 1.5rem;
  width: 400px;
  max-width: 90vw;
  box-shadow: var(--shadow-modal);
}

/* Modal-box — компактное модальное окно для Teleport-ом вынесенных диалогов
   (например, редактирование главного домена) */
.modal-box {
  background: var(--bg-modal);
  border: 1px solid var(--border-strong);
  border-radius: 16px;
  width: 520px;
  max-width: 92vw;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-modal);
  overflow: hidden;
}
.modal-box__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border);
}
.modal-box__header h3 {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-heading);
}
.modal-box__body {
  padding: 1rem 1.25rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}
.modal-box__footer {
  padding: 0.8rem 1.25rem;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  background: var(--bg-surface);
}
.form-input--readonly {
  background: var(--bg-surface);
  color: var(--text-muted);
  cursor: not-allowed;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.82rem;
}
.form-input--error {
  border-color: var(--danger) !important;
}
.form-hint--error {
  color: var(--danger);
  font-size: 0.75rem;
}
.warn-block {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.7rem 0.9rem;
  font-size: 0.78rem;
  color: var(--text-secondary);
  line-height: 1.45;
}
.warn-block strong {
  display: block;
  color: var(--text-heading);
  margin-bottom: 0.35rem;
  font-size: 0.8rem;
}
.warn-block ul {
  margin: 0;
  padding-left: 1.1rem;
}
.warn-block li + li {
  margin-top: 0.2rem;
}
.warn-block code {
  background: var(--bg-elevated);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
}
.warn-block__danger {
  color: var(--danger);
  font-weight: 600;
}

.modal__title {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text-heading);
  margin: 0 0 0.5rem;
}

.modal__text {
  font-size: 0.82rem;
  color: var(--text-tertiary);
  margin: 0 0 1rem;
  line-height: 1.5;
}
.modal__text--hint {
  font-size: 0.78rem;
  color: var(--text-muted);
}
.modal__text--hint code {
  background: var(--bg-input);
  color: var(--text-secondary);
  padding: 0.05rem 0.3rem;
  border-radius: 4px;
  font-size: 0.88em;
}

.modal__confirm-name {
  color: #f87171;
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
}

.modal .form-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-input);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  padding: 0.6rem 0.85rem;
  font-size: 0.85rem;
  color: var(--text-primary);
  font-family: 'JetBrains Mono', monospace;
  outline: none;
  transition: all 0.2s;
}

.modal .form-input:focus {
  border-color: rgba(239, 68, 68, 0.3);
  box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.06);
}

.modal__actions {
  display: flex;
  gap: 0.6rem;
  justify-content: flex-end;
  margin-top: 1.25rem;
}

.modal__btn {
  padding: 0.5rem 1rem;
  border-radius: 10px;
  font-size: 0.82rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
}

.modal__btn--cancel {
  background: var(--border);
  color: var(--text-tertiary);
}

.modal__btn--cancel:hover {
  background: var(--border-secondary);
}

.modal__btn--delete {
  background: rgba(239, 68, 68, 0.12);
  color: #f87171;
}

.modal__btn--delete:not(:disabled):hover {
  background: rgba(239, 68, 68, 0.2);
}

.modal__btn--delete:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

/* Deploy section */
.deploy-section {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.deploy-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 1.15rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
}

.deploy-trigger__title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 0;
}

.deploy-trigger__desc {
  font-size: 0.78rem;
  color: var(--text-muted);
  margin: 0.25rem 0 0;
}

.deploy-trigger__mono {
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-tertiary);
  font-size: 0.74rem;
}

.deploy-trigger__btn {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.55rem 1.1rem;
  border-radius: 10px;
  border: 1px solid rgba(34, 197, 94, 0.2);
  background: rgba(34, 197, 94, 0.06);
  color: #4ade80;
  font-size: 0.82rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
  flex-shrink: 0;
}

.deploy-trigger__btn:hover:not(:disabled) {
  background: rgba(34, 197, 94, 0.12);
  border-color: rgba(34, 197, 94, 0.3);
}

.deploy-trigger__btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.deploy-trigger__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(74, 222, 128, 0.2);
  border-top-color: #4ade80;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

/* Deploy log viewer */
.deploy-log-viewer {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  overflow: hidden;
}

.deploy-log-viewer__header {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.65rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-code);
}

.deploy-log-viewer__status {
  font-size: 0.68rem;
  font-weight: 700;
  padding: 0.15rem 0.45rem;
  border-radius: 6px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.deploy-log-viewer__status--pending,
.deploy-log-viewer__status--in_progress {
  background: var(--primary-bg);
  color: var(--primary-text);
}

.deploy-log-viewer__status--success {
  background: rgba(34, 197, 94, 0.1);
  color: #4ade80;
}

.deploy-log-viewer__status--failed {
  background: rgba(239, 68, 68, 0.1);
  color: #f87171;
}

.deploy-log-viewer__branch {
  font-size: 0.75rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-tertiary);
}

.deploy-log-viewer__sha {
  font-size: 0.72rem;
  font-family: 'JetBrains Mono', monospace;
  color: rgba(139, 92, 246, 0.7);
}

.deploy-log-viewer__output {
  padding: 1rem;
  margin: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  line-height: 1.65;
  color: var(--text-tertiary);
  max-height: 400px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

/* Deploy history */
.deploy-history__title {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-tertiary);
  margin: 0 0 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.deploy-history__list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.deploy-history__item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem 0.85rem;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.15s;
  background: var(--bg-code);
  border: 1px solid transparent;
}

.deploy-history__item:hover {
  background: var(--bg-elevated);
  border-color: var(--border);
}

.deploy-history__item--active {
  background: var(--primary-bg);
  border-color: var(--primary-bg);
}

.deploy-history__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.deploy-history__dot--success { background: #4ade80; }
.deploy-history__dot--failed { background: #f87171; }
.deploy-history__dot--pending,
.deploy-history__dot--in_progress { background: var(--primary-text); }

.deploy-history__item-info {
  flex: 1;
  min-width: 0;
}

.deploy-history__item-branch {
  font-size: 0.8rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-secondary);
  font-weight: 500;
}

.deploy-history__item-msg {
  display: block;
  font-size: 0.72rem;
  color: var(--text-muted);
  margin-top: 0.1rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.deploy-history__item-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.1rem;
  flex-shrink: 0;
}

.deploy-history__item-duration {
  font-size: 0.7rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-muted);
}

.deploy-history__item-time {
  font-size: 0.68rem;
  color: var(--text-faint);
}

.deploy-history__rollback {
  padding: 0.2rem 0.55rem;
  border-radius: 6px;
  border: 1px solid rgba(139, 92, 246, 0.2);
  background: rgba(139, 92, 246, 0.06);
  color: #a78bfa;
  font-size: 0.68rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}

.deploy-history__rollback:hover:not(:disabled) {
  background: rgba(139, 92, 246, 0.12);
  border-color: rgba(139, 92, 246, 0.3);
}

.deploy-history__rollback:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* File Manager */
.fm-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.6rem 0.85rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 12px;
  margin-bottom: 0.75rem;
}

.fm-breadcrumb {
  display: flex;
  align-items: center;
  gap: 0.2rem;
  font-size: 0.8rem;
  min-width: 0;
  overflow: hidden;
}

.fm-breadcrumb__item {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  padding: 0.15rem 0.35rem;
  border-radius: 4px;
  transition: all 0.15s;
  white-space: nowrap;
  display: flex;
  align-items: center;
}

.fm-breadcrumb__item:hover {
  color: var(--primary-text);
  background: var(--primary-bg);
}

.fm-breadcrumb__sep {
  color: var(--text-faint);
  font-size: 0.7rem;
  flex-shrink: 0;
}

.fm-bar__actions {
  display: flex;
  gap: 0.25rem;
  flex-shrink: 0;
}

.fm-bar__btn {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-elevated);
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;
}

.fm-bar__btn:hover {
  background: var(--border-secondary);
  color: var(--text-secondary);
}

.fm-bar__btn--active {
  background: rgba(34, 197, 94, 0.1);
  border-color: rgba(34, 197, 94, 0.25);
  color: #4ade80;
  width: auto;
  padding: 0 0.5rem;
  gap: 0.2rem;
}

.fm-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3rem;
}

.fm-loading__spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--spinner-track);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

.fm-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3rem;
}

.fm-empty__text {
  font-size: 0.82rem;
  color: var(--text-muted);
}

.fm-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 12px;
  overflow: hidden;
}

.fm-item {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.55rem 0.85rem;
  cursor: pointer;
  transition: background 0.12s;
  background: var(--bg-surface);
}

.fm-item:hover {
  background: var(--bg-surface-hover, var(--bg-elevated));
}

.fm-item + .fm-item {
  border-top: 1px solid var(--border);
}

.fm-item__icon {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--text-muted);
}

.fm-item--dir .fm-item__icon {
  background: rgba(var(--primary-rgb), 0.08);
  color: var(--primary-text);
}

.fm-item:not(.fm-item--dir) .fm-item__icon {
  background: var(--bg-code, var(--border));
  color: var(--text-muted);
}

.fm-item__name {
  flex: 1;
  font-size: 0.82rem;
  color: var(--text-secondary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fm-item--dir .fm-item__name {
  font-weight: 600;
}

.fm-item__size {
  font-size: 0.7rem;
  color: var(--text-muted);
  flex-shrink: 0;
  width: 60px;
  text-align: right;
}

.fm-item__perms {
  font-size: 0.68rem;
  color: var(--text-faint);
  flex-shrink: 0;
  width: 80px;
  text-align: right;
}

.fm-item__action,
.fm-item__del {
  opacity: 0;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}

.fm-item:hover .fm-item__action,
.fm-item:hover .fm-item__del {
  opacity: 1;
}

.fm-item__action:hover {
  background: rgba(99, 102, 241, 0.1);
  color: #818cf8;
}
.fm-item__action:disabled { opacity: 1; cursor: wait; }
.fm-item__spinner {
  width: 12px; height: 12px; border: 2px solid var(--border-secondary);
  border-top-color: #818cf8; border-radius: 50%; animation: spin 0.6s linear infinite;
}

.fm-item__del:hover {
  background: rgba(239, 68, 68, 0.1);
  color: #f87171;
}

/* File Editor */
.fm-editor-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
}

.fm-editor {
  background: var(--bg-modal);
  border: 1px solid var(--border-strong);
  border-radius: 16px;
  width: 100%;
  max-width: 800px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-modal);
  overflow: hidden;
}

.fm-editor__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-code);
  flex-shrink: 0;
}

.fm-editor__path {
  font-size: 0.72rem;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.fm-editor__actions {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-shrink: 0;
}

.fm-editor__save {
  padding: 0.35rem 0.75rem;
  border-radius: 8px;
  border: 1px solid rgba(34, 197, 94, 0.2);
  background: rgba(34, 197, 94, 0.06);
  color: #4ade80;
  font-size: 0.75rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}

.fm-editor__save:hover:not(:disabled) {
  background: rgba(34, 197, 94, 0.12);
  border-color: rgba(34, 197, 94, 0.3);
}

.fm-editor__save:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.fm-editor__close {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;
}

.fm-editor__close:hover {
  background: var(--border);
  color: var(--text-secondary);
}

.fm-editor__textarea {
  flex: 1;
  min-height: 400px;
  padding: 1rem;
  background: var(--bg-surface);
  border: none;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  line-height: 1.65;
  color: var(--text-primary);
  resize: none;
  outline: none;
  tab-size: 2;
}

.fm-editor__textarea::placeholder {
  color: var(--text-faint);
}

.mono {
  font-family: 'JetBrains Mono', monospace;
}

/* Backups tab */
.site-excludes {
  width: 100%;
  margin: 0.75rem 0 1.25rem;
  border: 1px solid var(--border-secondary);
  border-radius: 12px;
  background: var(--bg-surface);
  overflow: hidden;
  transition: border-color 0.15s;
}
.site-excludes[open] { border-color: var(--primary-border); }
.site-excludes__summary {
  cursor: pointer;
  list-style: none;
  padding: 0.85rem 1rem;
  user-select: none;
  transition: background 0.15s;
}
.site-excludes__summary:hover { background: var(--bg-surface-hover, rgba(0,0,0,0.02)); }
.site-excludes__summary::-webkit-details-marker { display: none; }
.site-excludes__head {
  display: flex; align-items: center; gap: 0.6rem; width: 100%;
}
.site-excludes__chev {
  flex-shrink: 0; color: var(--text-muted);
  transition: transform 0.2s ease;
}
.site-excludes[open] .site-excludes__chev { transform: rotate(90deg); color: var(--primary-text); }
.site-excludes__title-text {
  font-size: 0.88rem; font-weight: 600; color: var(--text-heading);
  flex: 1; min-width: 0;
}
.site-excludes__counters {
  display: flex; gap: 0.4rem; flex-shrink: 0;
}
.site-excludes__badge {
  display: inline-flex; align-items: center; gap: 0.25rem;
  padding: 0.2rem 0.55rem;
  background: var(--primary-bg); color: var(--primary-text);
  border-radius: 999px; font-size: 0.7rem; font-weight: 600;
  white-space: nowrap;
}
.site-excludes__badge--alt {
  background: rgba(168, 85, 247, 0.12); color: rgb(168, 85, 247);
}
.site-excludes__body {
  padding: 0 1rem 1rem;
  border-top: 1px solid var(--border-secondary);
  display: flex; flex-direction: column; gap: 1.25rem;
  margin-top: 0.5rem;
  padding-top: 1rem;
}
.site-excludes__field { display: flex; flex-direction: column; gap: 0.4rem; width: 100%; }
.site-excludes__label {
  font-size: 0.78rem; font-weight: 600; color: var(--text-tertiary);
  text-transform: uppercase; letter-spacing: 0.04em;
}
.site-excludes__hint {
  margin: 0 0 0.25rem;
  font-size: 0.74rem; color: var(--text-muted); line-height: 1.5;
}
.site-excludes__hint code {
  background: var(--bg-body); padding: 0.05rem 0.3rem; border-radius: 4px;
  font-family: 'JetBrains Mono', monospace; font-size: 0.72rem;
}
.site-excludes__textarea {
  width: 100%; box-sizing: border-box;
  padding: 0.7rem 0.85rem;
  background: var(--bg-body);
  border: 1px solid var(--border-secondary);
  border-radius: 8px;
  color: var(--text-primary);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8rem; line-height: 1.55;
  resize: vertical;
  min-height: 110px;
  transition: border-color 0.15s, background 0.15s;
}
.site-excludes__textarea:focus {
  outline: none;
  border-color: var(--primary-border);
  background: var(--bg-surface);
}
.site-excludes__textarea::placeholder {
  color: var(--text-muted); opacity: 0.6;
}
.site-excludes__actions {
  display: flex; gap: 0.5rem; align-items: center;
  padding-top: 0.5rem;
  border-top: 1px dashed var(--border-secondary);
}
.site-excludes__sep { flex: 1; }
.backups-toolbar {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;
}
.backups-toolbar__count { font-size: 0.78rem; color: var(--text-muted); }
.backups-toolbar__create { display: flex; gap: 0.4rem; align-items: center; }
.backups-note {
  font-size: 0.78rem;
  color: var(--text-muted);
  line-height: 1.45;
  padding: 0.65rem 0.85rem;
  margin: 0 0 1rem;
  background: var(--bg-input);
  border-left: 3px solid var(--primary-border, rgba(var(--primary-rgb), 0.35));
  border-radius: 6px;
}
.backup-list { display: flex; flex-direction: column; gap: 0.35rem; }
.backup-item {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.65rem 1rem;
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 12px;
}
.backup-item__icon {
  width: 32px; height: 32px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.backup-item__icon--completed { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
.backup-item__icon--failed { background: rgba(239, 68, 68, 0.1); color: #f87171; }
.backup-item__icon--in_progress, .backup-item__icon--pending { background: rgba(var(--primary-rgb), 0.1); color: var(--primary-light); }
.backup-item__info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.15rem; }
.backup-item__top { display: flex; align-items: center; gap: 0.4rem; }
.backup-item__type { font-size: 0.82rem; font-weight: 500; color: var(--text-secondary); }
.backup-item__meta { font-size: 0.68rem; color: var(--text-faint); }
.backup-item__error { font-size: 0.72rem; color: #f87171; margin-top: 0.2rem; white-space: pre-wrap; }
.backup-item__badge {
  display: inline-block; font-size: 0.56rem; font-weight: 600;
  font-family: 'JetBrains Mono', monospace; padding: 0.12rem 0.35rem;
  border-radius: 6px; text-transform: uppercase; letter-spacing: 0.03em;
}
.backup-item__badge--storage { background: rgba(139, 92, 246, 0.1); color: #a78bfa; }
.backup-item__status {
  display: inline-block; font-size: 0.62rem; font-weight: 600; font-family: 'JetBrains Mono', monospace;
  padding: 0.2rem 0.5rem; border-radius: 6px; text-transform: uppercase; letter-spacing: 0.03em; flex-shrink: 0;
}
.backup-item__status--completed { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
.backup-item__status--pending, .backup-item__status--in_progress { background: rgba(var(--primary-rgb), 0.1); color: var(--primary-light); }
.backup-item__status--failed { background: rgba(239, 68, 68, 0.1); color: #f87171; }
.backup-item__actions { display: flex; align-items: center; gap: 0.4rem; flex-shrink: 0; }

.backup-progress {
  position: relative; height: 6px; border-radius: 3px;
  background: var(--bg-elevated); margin-top: 0.3rem; overflow: hidden;
}
.backup-progress__fill {
  height: 100%; border-radius: 3px;
  background: linear-gradient(90deg, var(--primary-light), var(--primary-dark));
  transition: width 0.4s ease;
}
.backup-progress__label {
  position: absolute; right: 0; top: -14px;
  font-size: 0.58rem; font-family: 'JetBrains Mono', monospace; color: var(--text-faint);
}

.backup-spinner {
  width: 16px; height: 16px; border: 2px solid var(--spinner-track);
  border-top-color: var(--primary-light); border-radius: 50%; animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.btn-icon {
  background: none; border: 1px solid var(--border-secondary); border-radius: 8px;
  padding: 0.35rem; cursor: pointer; display: flex; transition: all 0.2s; color: var(--text-muted);
}
.btn-icon:hover { border-color: var(--border-strong); color: var(--text-secondary); }
.btn-icon:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-icon--danger { color: rgba(239, 68, 68, 0.35); }
.btn-icon--danger:hover { color: #f87171; border-color: rgba(239, 68, 68, 0.2); background: rgba(239, 68, 68, 0.05); }
.btn-icon__progress {
  font-size: 0.6rem; font-weight: 600; font-family: 'JetBrains Mono', monospace;
  color: var(--primary-text); min-width: 28px; text-align: center;
}

.form-select--sm {
  padding: 0.25rem 0.5rem; font-size: 0.75rem; border-radius: 6px;
  background: var(--bg-secondary); border: 1px solid var(--border-primary);
  color: var(--text-secondary); outline: none; cursor: pointer;
  appearance: auto;
}
.form-select--sm:focus { border-color: var(--primary); }
.backups-toolbar__actions {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  flex-wrap: wrap;
}

/* Snapshot Picker list */
.snapshot-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  max-height: 45vh;
  overflow-y: auto;
  padding: 0.25rem;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-input);
}
.snapshot-item {
  padding: 0.55rem 0.75rem;
  border-radius: 8px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s ease;
  background: var(--bg-surface);
}
.snapshot-item:hover {
  border-color: var(--border-strong);
}
.snapshot-item--selected {
  border-color: rgba(var(--primary-rgb), 0.4);
  background: rgba(var(--primary-rgb), 0.06);
}
.snapshot-item__head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.snapshot-item__id {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.76rem;
  color: var(--text-secondary);
  padding: 0.1rem 0.4rem;
  background: var(--bg-input);
  border-radius: 5px;
}
.snapshot-item__time {
  font-size: 0.76rem;
  color: var(--text-tertiary);
}
.snapshot-item__meta {
  font-size: 0.66rem;
  color: var(--text-faint);
  margin-top: 0.25rem;
}
.snapshot-item__badge {
  font-size: 0.6rem;
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
  padding: 0.1rem 0.4rem;
  border-radius: 5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.snapshot-item__badge--known { background: rgba(34, 197, 94, 0.12); color: #4ade80; }
.snapshot-item__badge--new { background: rgba(139, 92, 246, 0.12); color: #a78bfa; }
.snapshot-item__badge--err { background: rgba(239, 68, 68, 0.12); color: #f87171; }

/* Restic check history */
.check-opts {
  margin-top: 0.75rem;
  padding: 0.75rem;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 10px;
}
.check-history {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  max-height: 35vh;
  overflow-y: auto;
  padding: 0.25rem;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-input);
  margin-top: 0.5rem;
}
.check-item {
  padding: 0.55rem 0.75rem;
  border-radius: 8px;
  background: var(--bg-surface);
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.check-item__head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.check-item__time {
  font-size: 0.72rem;
  color: var(--text-tertiary);
}
.check-item__dur {
  font-size: 0.68rem;
  color: var(--text-faint);
}
.check-item__error {
  font-size: 0.72rem;
  color: #f87171;
  white-space: pre-wrap;
  word-break: break-word;
  margin-top: 0.2rem;
}

.backup-item__orphan {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; border-radius: 50%;
  background: rgba(239, 68, 68, 0.15); color: #f87171;
  font-size: 0.65rem; font-weight: 700; margin-left: 0.3rem;
  cursor: help;
}

/* Logs */
.logs-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.logs-bar__types {
  display: flex;
  gap: 0.25rem;
}

.logs-bar__type {
  padding: 0.4rem 0.75rem;
  border-radius: 8px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  color: var(--text-muted);
  font-size: 0.78rem;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}

.logs-bar__type:hover {
  color: var(--text-secondary);
  background: var(--bg-elevated);
}

.logs-bar__type--active {
  background: var(--primary-bg);
  border-color: var(--primary-bg);
  color: var(--primary-text);
}

.logs-output {
  padding: 1rem;
  margin: 0;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 12px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  line-height: 1.6;
  color: var(--text-tertiary);
  overflow: auto;
  white-space: pre;
  max-height: 600px;
}

@media (max-width: 768px) {
  .site-detail__header-main {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .site-detail__header-right {
    align-self: stretch;
    justify-content: space-between;
  }

  .site-detail__tabs {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    white-space: nowrap;
    scrollbar-width: none;
  }

  .site-detail__tabs::-webkit-scrollbar {
    display: none;
  }

  .site-detail__tab {
    flex-shrink: 0;
    padding: 0.55rem 0.75rem;
    font-size: 0.78rem;
  }

  .info-grid {
    grid-template-columns: 1fr;
  }

  .danger-item {
    flex-direction: column;
    align-items: stretch;
    gap: 0.85rem;
  }

  .danger-item__btn {
    align-self: flex-start;
  }

  .site-detail__title {
    font-size: 1.15rem;
  }

  .env-item {
    font-size: 0.68rem;
    flex-wrap: wrap;
  }

  .config-view__code {
    font-size: 0.65rem;
  }

  .fm-item__perms {
    display: none;
  }

  .fm-item__size {
    width: 45px;
    font-size: 0.65rem;
  }

  .fm-editor-overlay {
    padding: 0.5rem;
  }

  .fm-editor {
    max-height: 95vh;
  }

  .fm-editor__textarea {
    min-height: 250px;
    font-size: 0.7rem;
  }
}

/* ─── Backup export dialog ─── */
.exp-warn {
  margin: 0.75rem 0; padding: 0.6rem 0.85rem;
  background: rgba(var(--primary-rgb), 0.08); border: 1px solid rgba(var(--primary-rgb), 0.2);
  color: var(--primary); border-radius: 8px; font-size: 0.82rem;
}
.exp-mode-hint {
  display: block; margin-top: 0.2rem;
  font-size: 0.72rem; color: var(--text-muted); font-weight: 400;
  line-height: 1.45;
}
.exp-list {
  margin: 1rem 0 0; padding: 0.85rem;
  background: var(--bg-surface); border: 1px solid var(--border-secondary);
  border-radius: 10px;
}
.exp-list__head {
  font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--text-tertiary); margin-bottom: 0.5rem;
}
.exp-list__item {
  display: flex; align-items: stretch; gap: 0.55rem;
  padding: 0.45rem 0.55rem; border-radius: 6px;
  font-size: 0.78rem;
  transition: background 0.12s;
}
.exp-list__item + .exp-list__item { border-top: 1px solid var(--border-secondary); }
.exp-list__item:hover { background: var(--bg-body); }
.exp-list__main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.exp-list__row { display: flex; align-items: center; gap: 0.55rem; }
.exp-list__progress { display: flex; flex-direction: column; gap: 0.2rem; margin-top: 0.15rem; }
.exp-list__progress-text {
  font-size: 0.66rem; color: var(--text-muted);
  font-family: 'JetBrains Mono', monospace;
}
/* Indeterminate-режим: бегущая полоса для случая когда финальный размер неизвестен. */
.backup-progress__fill--indeterminate {
  width: 40% !important;
  background: linear-gradient(90deg, transparent, #818cf8, transparent);
  animation: backup-progress-indet 1.4s linear infinite;
}
@keyframes backup-progress-indet {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(350%); }
}
.exp-list__mode {
  font-family: 'JetBrains Mono', monospace; font-size: 0.7rem;
  padding: 0.1rem 0.35rem; background: var(--bg-body); border-radius: 4px;
  color: var(--text-tertiary); font-weight: 600;
}
.exp-list__status {
  font-size: 0.7rem; font-weight: 600; padding: 0.1rem 0.45rem; border-radius: 999px;
}
.exp-list__status--ready { background: rgba(34, 197, 94, 0.15); color: #22c55e; }
.exp-list__status--processing,
.exp-list__status--pending { background: rgba(99, 102, 241, 0.15); color: #818cf8; }
.exp-list__status--failed { background: rgba(239, 68, 68, 0.15); color: #f87171; }
.exp-list__status--expired { background: rgba(107, 114, 128, 0.2); color: var(--text-muted); }
.exp-list__expires {
  flex: 1; font-size: 0.72rem; color: var(--text-muted);
}

/* ─── Restore Scope (radio группа) ─── */
.restore-scope {
  display: flex; flex-direction: column; gap: 0.35rem;
  margin: 1rem 0 0.5rem;
  padding: 0.75rem 0.85rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
}
.restore-scope__label {
  font-size: 0.74rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--text-tertiary); margin-bottom: 0.25rem;
}
.restore-scope__opt {
  display: flex; align-items: center; gap: 0.55rem;
  cursor: pointer; padding: 0.35rem 0.45rem; border-radius: 6px;
  font-size: 0.84rem; color: var(--text-secondary);
  transition: background 0.12s;
}
.restore-scope__opt:hover { background: var(--bg-body); }
.restore-scope__opt input[type="radio"] { accent-color: var(--primary-text); }
.restore-scope__opt--disabled { opacity: 0.45; cursor: not-allowed; }
.restore-scope__opt--disabled:hover { background: transparent; }

/* ─── Restore Tree (selective чекбоксы) ─── */
.restore-tree {
  margin: 0.75rem 0;
  padding: 0.85rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
}
.restore-tree__head {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 0.6rem;
}
.restore-tree__title {
  font-size: 0.74rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--text-tertiary);
}
.restore-tree__head-actions { display: flex; gap: 0.3rem; }
.btn--xs { padding: 0.2rem 0.55rem; font-size: 0.72rem; }
.restore-tree__loading {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 1rem; color: var(--text-muted); font-size: 0.8rem;
}
.restore-tree__error {
  padding: 0.6rem 0.85rem;
  background: rgba(239, 68, 68, 0.08);
  border-radius: 6px; color: #f87171; font-size: 0.78rem;
}
.restore-tree__empty {
  padding: 1rem; color: var(--text-muted); font-size: 0.8rem;
  text-align: center;
}
.restore-tree__list {
  display: flex; flex-direction: column; gap: 0.15rem;
  max-height: 280px; overflow-y: auto;
  padding: 0.25rem; background: var(--bg-body); border-radius: 6px;
}
.restore-tree__item {
  display: grid; grid-template-columns: auto auto 1fr auto; align-items: center;
  gap: 0.5rem; padding: 0.4rem 0.55rem; border-radius: 5px;
  cursor: pointer; font-size: 0.8rem;
  transition: background 0.12s;
}
.restore-tree__item:hover { background: var(--bg-surface); }
.restore-tree__item input[type="checkbox"] { accent-color: var(--primary-text); }
.restore-tree__icon { font-size: 0.95rem; opacity: 0.8; }
.restore-tree__name {
  font-family: 'JetBrains Mono', monospace; font-size: 0.78rem;
  color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.restore-tree__size {
  font-size: 0.72rem; color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.restore-tree__hint {
  margin: 0.55rem 0 0; font-size: 0.7rem; color: var(--text-muted);
  line-height: 1.45;
}

/* ─── DB picker (выбор БД для бэкапа/рестора) ─── */
.db-pick {
  padding: 0.8rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.db-pick__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 0.2rem;
}
.db-pick__label {
  font-size: 0.74rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-tertiary);
}
.db-pick__count {
  font-size: 0.72rem;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.db-pick__head-actions { display: flex; gap: 0.3rem; margin-left: auto; }
.db-pick__item {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.55rem;
  padding: 0.45rem 0.6rem;
  border-radius: 6px;
  cursor: pointer;
  background: var(--bg-body);
  border: 1px solid transparent;
  transition: all 0.12s;
}
.db-pick__item:hover {
  border-color: var(--border-secondary);
}
.db-pick__item input[type="checkbox"] { accent-color: var(--primary, var(--primary)); }
.db-pick__name {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.82rem;
  color: var(--text-heading);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.db-pick__type {
  font-size: 0.7rem;
  color: var(--text-muted);
  padding: 0.1rem 0.45rem;
  background: var(--bg-input);
  border: 1px solid var(--border-secondary);
  border-radius: 4px;
  white-space: nowrap;
}

/* ─── Restore Options ─── */
.restore-options {
  margin: 0.75rem 0;
}

.restore-option {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  cursor: pointer;
  padding: 0.6rem 0.75rem;
  border-radius: 8px;
  background: rgba(239, 68, 68, 0.04);
  border: 1px solid rgba(239, 68, 68, 0.08);
  transition: all 0.15s;
}

.restore-option:hover {
  background: rgba(239, 68, 68, 0.07);
}

.restore-option input[type="checkbox"] {
  margin-top: 0.15rem;
  accent-color: #f87171;
  flex-shrink: 0;
}

.restore-option__label {
  display: block;
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--text-secondary);
}

.restore-option__hint {
  display: block;
  font-size: 0.72rem;
  color: var(--text-muted);
  margin-top: 0.15rem;
  line-height: 1.4;
}

/* ─── Restore Banner ─── */
.restore-banner {
  padding: 0.75rem 1rem;
  border-radius: 10px;
  background: rgba(99, 102, 241, 0.08);
  border: 1px solid rgba(99, 102, 241, 0.15);
  margin-bottom: 1rem;
}

.restore-banner__text {
  font-size: 0.82rem;
  font-weight: 500;
  color: #818cf8;
  margin-bottom: 0.5rem;
}

.restore-banner--error {
  background: rgba(239, 68, 68, 0.08);
  border-color: rgba(239, 68, 68, 0.15);
  color: #f87171;
  font-size: 0.82rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* ─── Cron Jobs (визуал синхронизирован с /cron) ─── */
.cron-job-list { display: flex; flex-direction: column; gap: 0.4rem; }

.cron-job-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  transition: border-color 0.2s;
}
.cron-job-card:hover { border-color: var(--border-secondary); }
.cron-job-card--disabled { opacity: 0.5; }

.cron-job-card__main { display: flex; align-items: center; gap: 0.85rem; padding: 0.75rem 1rem; }
.cron-job-card__toggle { flex-shrink: 0; }

.cron-toggle {
  width: 36px; height: 20px; border-radius: 10px; border: none; padding: 2px;
  background: var(--border-strong); cursor: pointer; position: relative; transition: background 0.3s;
}
.cron-toggle--on { background: rgba(34, 197, 94, 0.3); }
.cron-toggle__knob {
  display: block; width: 16px; height: 16px; border-radius: 50%;
  background: var(--text-tertiary); transition: all 0.3s;
}
.cron-toggle--on .cron-toggle__knob { transform: translateX(16px); background: #4ade80; }

.cron-job-card__info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.15rem; }
.cron-job-card__name { font-size: 0.85rem; font-weight: 600; color: var(--text-secondary); }
.cron-job-card__command {
  font-size: 0.72rem; font-family: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace;
  color: var(--text-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  background: none; padding: 0;
}

.cron-job-card__schedule {
  text-align: right; flex-shrink: 0;
  display: flex; flex-direction: column; align-items: flex-end; gap: 0.1rem;
}
.cron-job-card__schedule-label { font-size: 0.72rem; color: var(--text-tertiary); }
.cron-job-card__schedule-cron {
  font-size: 0.65rem; font-family: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace;
  color: rgba(var(--primary-rgb), 0.5); background: none; padding: 0;
}

.cron-job-card__actions { display: flex; gap: 0.3rem; flex-shrink: 0; margin-left: 0.5rem; }

.cron-row-action {
  background: none; border: 1px solid var(--border-secondary); border-radius: 8px;
  padding: 0.35rem; cursor: pointer; display: flex;
  color: var(--text-faint); transition: all 0.2s;
}
.cron-row-action:hover { color: var(--text-tertiary); border-color: var(--border-strong); }
.cron-row-action--red:hover {
  color: #f87171; border-color: rgba(239, 68, 68, 0.2); background: rgba(239, 68, 68, 0.05);
}

.cron-job-card__log {
  padding: 0.6rem 1rem 0.75rem;
  border-top: 1px solid var(--border);
}
.cron-job-card__log-header {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.4rem;
}
.cron-job-card__log-label { font-size: 0.72rem; color: var(--text-muted); }
.cron-job-card__log-exit {
  font-size: 0.65rem; font-weight: 600;
  font-family: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace;
  padding: 0.15rem 0.4rem; border-radius: 5px;
  background: rgba(148, 163, 184, 0.12); color: var(--text-muted);
}
.cron-job-card__log-exit--ok { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
.cron-job-card__log-exit--fail { background: rgba(239, 68, 68, 0.1); color: #f87171; }
.cron-job-card__log-output {
  background: var(--bg-input); border: 1px solid var(--border);
  border-radius: 8px; padding: 0.5rem 0.65rem; margin: 0;
  font-family: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace; font-size: 0.7rem;
  color: var(--text-tertiary); white-space: pre-wrap; word-break: break-all;
  max-height: 200px; overflow-y: auto;
}
.cron-job-card__log-empty { font-size: 0.72rem; color: var(--text-faint); }

@media (max-width: 768px) {
  .cron-job-card__main {
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.65rem 0.75rem;
  }
  .cron-job-card__info { width: 100%; order: 1; }
  .cron-job-card__toggle { order: 0; }
  .cron-job-card__schedule {
    text-align: left;
    align-items: flex-start;
    flex: 1;
    order: 2;
  }
  .cron-job-card__actions {
    order: 3;
    justify-content: flex-end;
  }
  .cron-job-card__command { max-width: calc(100vw - 6rem); }
}

.cron-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin: 1rem 0;
}

.cron-form__schedule {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.cron-form__presets {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.cron-form__preset {
  padding: 0.25rem 0.6rem;
  font-size: 0.7rem;
  border-radius: 6px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-input);
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.15s;
}

.cron-form__preset:hover {
  border-color: var(--border-strong);
  color: var(--text-secondary);
}

.cron-form__preset--active {
  border-color: var(--primary);
  color: var(--primary);
  background: rgba(var(--primary-rgb), 0.08);
}

.cron-form__command {
  resize: vertical;
  min-height: 60px;
}

/* ─── SSH / Terminal ─── */
.btn--sm {
  padding: 0.35rem 0.75rem;
  font-size: 0.75rem;
  border-radius: 8px;
}
.btn--ghost { background: var(--bg-input); border: 1px solid var(--border-strong); color: var(--text-tertiary); }
.btn--ghost:hover { color: var(--text-secondary); border-color: var(--border-strong); }
.btn--danger { background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.2); color: #f87171; }
.btn--danger:not(:disabled):hover { background: rgba(239, 68, 68, 0.18); }
.btn--danger:disabled { opacity: 0.4; cursor: not-allowed; }

.ssh-cmd {
  user-select: all;
  word-break: break-all;
}

/* Terminal modal */
.modal-overlay--terminal {
  z-index: 200;
  align-items: stretch;
  justify-content: stretch;
  padding: 2rem;
}

.site-terminal-modal {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: #0d0d0d;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  overflow: hidden;
  box-shadow: 0 25px 60px rgba(0, 0, 0, 0.5);
}

.site-terminal-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 1rem;
  background: rgba(255, 255, 255, 0.04);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}

.site-terminal-modal__title {
  font-size: 0.8rem;
  font-weight: 600;
  color: #e0e0e0;
  font-family: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace;
}

.site-terminal-modal__close {
  background: none;
  border: none;
  color: #999;
  cursor: pointer;
  padding: 0.25rem;
  border-radius: 6px;
  display: flex;
  transition: all 0.15s;
}

.site-terminal-modal__close:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.1);
}

.site-terminal-modal__body {
  flex: 1;
  padding: 0.5rem;
  overflow: hidden;
}

@media (max-width: 768px) {
  .modal-overlay--terminal {
    padding: 0;
  }

  .site-terminal-modal {
    border-radius: 0;
    border: none;
  }
}

/* ─── Migration Modal ─── */
.modal--wide {
  width: 480px;
}

.danger-item--migrate {
  border-color: rgba(99, 102, 241, 0.15);
  background: rgba(99, 102, 241, 0.02);
}

.danger-item__btn--migrate {
  background: rgba(99, 102, 241, 0.1) !important;
  color: #818cf8 !important;
}

.danger-item__btn--migrate:hover {
  background: rgba(99, 102, 241, 0.18) !important;
}

.migrate-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.migrate-form__label {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--text-secondary);
  margin-top: 0.25rem;
}

.migrate-form__checkboxes {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-top: 0.5rem;
}

.migrate-form__checkbox {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.82rem;
  color: var(--text-secondary);
  cursor: pointer;
}

.migrate-form__checkbox input {
  accent-color: var(--primary);
}

.modal__btn--primary {
  background: rgba(99, 102, 241, 0.12);
  color: #818cf8;
}

.modal__btn--primary:not(:disabled):hover {
  background: rgba(99, 102, 241, 0.2);
}

.modal__btn--primary:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.migrate-error {
  margin-top: 0.75rem;
  padding: 0.6rem 0.75rem;
  border-radius: 8px;
  background: rgba(239, 68, 68, 0.08);
  color: #f87171;
  font-size: 0.8rem;
  white-space: pre-wrap;
}

.migrate-success {
  margin-top: 0.75rem;
  padding: 0.6rem 0.75rem;
  border-radius: 8px;
  background: rgba(34, 197, 94, 0.08);
  color: #4ade80;
  font-size: 0.8rem;
  font-weight: 500;
}

.migrate-progress {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin: 0.75rem 0;
}

.migrate-step {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.35rem 0;
  color: var(--text-muted);
  font-size: 0.8rem;
}

.migrate-step--done {
  color: #4ade80;
}

.migrate-step--active {
  color: #818cf8;
  font-weight: 500;
}

.migrate-step--error {
  color: #f87171;
  font-weight: 500;
}

.migrate-step__icon {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.migrate-step__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(129, 140, 248, 0.2);
  border-top-color: #818cf8;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

.migrate-step__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border-secondary);
}

/* ============================================================================
   Overview — дополнительные блоки (мониторинг, хранилище, активность)
   ============================================================================ */
.overview-block {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  padding: 1.15rem 1.25rem;
  margin-top: 1rem;
}
.overview-block__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  margin-bottom: 0.9rem;
}
.overview-block__title {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-tertiary);
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  display: inline-flex;
  align-items: center;
}
.overview-block__loading,
.overview-block__empty {
  padding: 1.5rem 0;
  text-align: center;
  color: var(--text-muted);
  font-size: 0.85rem;
}
.spinning { animation: spin 0.8s linear infinite; }

/* CMS card — использует обычный .info-card фон (без градиента) */
.info-card__title--icon {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  line-height: 1;
}
.info-card__title--icon svg {
  color: var(--primary-text);
  flex-shrink: 0;
}
.info-row__btn--text {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}

/* KPI grid */
.monitor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.kpi-tile {
  background: var(--bg-input);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  padding: 0.75rem 0.9rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.kpi-tile--ok { border-color: rgba(34, 197, 94, 0.35); }
.kpi-tile--err { border-color: rgba(239, 68, 68, 0.4); }
.kpi-tile__label {
  font-size: 0.7rem;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 600;
}
.kpi-tile__value {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text-primary);
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.kpi-tile__meta {
  font-size: 0.7rem;
  color: var(--text-muted);
}
.kpi-dot {
  width: 8px; height: 8px; border-radius: 50%;
  display: inline-block;
}
.kpi-dot--ok { background: #22c55e; box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.2); }
.kpi-dot--err { background: #ef4444; box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.2); }
.kpi-bar {
  width: 100%;
  height: 4px;
  background: var(--border-secondary);
  border-radius: 2px;
  overflow: hidden;
}
.kpi-bar__fill {
  height: 100%;
  background: linear-gradient(90deg, #22c55e, var(--primary), #ef4444);
  transition: width 0.3s;
}

/* Chart */
.monitor-chart {
  background: var(--bg-input);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  padding: 0.75rem 0.9rem;
}
.monitor-chart__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.72rem;
  margin-bottom: 0.5rem;
}
.monitor-chart__title {
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 600;
}
.monitor-chart__legend {
  display: inline-flex;
  align-items: center;
  gap: 0.75rem;
  color: var(--text-muted);
}
.legend-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  display: inline-block;
  margin: 0 0.3rem 0 0.75rem;
}
.legend-dot--ok { background: #22c55e; }
.legend-dot--err { background: #ef4444; }
.monitor-chart__svg {
  width: 100%;
  height: 120px;
  display: block;
}
.monitor-chart__line {
  stroke: var(--primary-text, var(--primary));
  stroke-width: 1.5;
}
.chart-dot--ok { fill: #22c55e; }
.chart-dot--err { fill: #ef4444; }
.monitor-chart__empty {
  padding: 1rem 0;
  text-align: center;
  color: var(--text-muted);
  font-size: 0.82rem;
}

/* Storage */
.storage-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.storage-stat {
  background: var(--bg-input);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  padding: 0.7rem 0.9rem;
}
.storage-stat__label {
  font-size: 0.7rem;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 600;
  margin-bottom: 0.2rem;
}
.storage-stat__value {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
}
.storage-bar {
  display: flex;
  height: 14px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--border-secondary);
  margin-bottom: 0.5rem;
}
.storage-bar__seg { height: 100%; }
.storage-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.85rem;
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-bottom: 1rem;
}
.storage-legend__dot {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  display: inline-block;
  margin-right: 0.35rem;
  vertical-align: -1px;
}
.storage-files {
  border-top: 1px solid var(--border-secondary);
  padding-top: 0.85rem;
}
.storage-files__title {
  font-size: 0.75rem;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 600;
  margin-bottom: 0.5rem;
}
.storage-file {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.35rem 0;
  border-bottom: 1px dashed var(--border-secondary);
  font-size: 0.82rem;
}
.storage-file:last-child { border-bottom: none; }
.storage-file__path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}
.storage-file__size {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

/* Activity timeline — тот же стиль, что и /activity */
.overview-block__actions {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.timeline { position: relative; }
.timeline__group { margin-bottom: 1.25rem; }
.timeline__group:last-child { margin-bottom: 0; }
.timeline__date {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 0.6rem;
  padding-left: 2rem;
}
.timeline__items {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.timeline__item {
  display: flex;
  align-items: flex-start;
  gap: 0.85rem;
  padding: 0.55rem 0.85rem;
  border-radius: 12px;
  transition: background 0.15s;
  position: relative;
}
.timeline__item:hover { background: var(--bg-surface); }
.timeline__item::before {
  content: '';
  position: absolute;
  left: 1.35rem;
  top: 2rem;
  bottom: -2px;
  width: 1px;
  background: var(--border);
}
.timeline__item:last-child::before { display: none; }
.timeline__dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 0.3rem;
  position: relative;
  z-index: 1;
  background: var(--border);
}
.timeline__dot--login { background: #4ade80; box-shadow: 0 0 6px rgba(74, 222, 128, 0.4); }
.timeline__dot--logout { background: #94a3b8; }
.timeline__dot--create { background: #818cf8; box-shadow: 0 0 6px rgba(129, 140, 248, 0.4); }
.timeline__dot--update { background: var(--primary-light); box-shadow: 0 0 6px rgba(var(--primary-light-rgb), 0.3); }
.timeline__dot--delete { background: #f87171; box-shadow: 0 0 6px rgba(248, 113, 113, 0.4); }
.timeline__dot--deploy { background: #00dc82; box-shadow: 0 0 6px rgba(0, 220, 130, 0.4); }
.timeline__dot--backup { background: #a78bfa; box-shadow: 0 0 6px rgba(167, 139, 250, 0.3); }
.timeline__dot--restore { background: #a78bfa; box-shadow: 0 0 6px rgba(167, 139, 250, 0.3); }
.timeline__dot--ssl_issue { background: #38bdf8; box-shadow: 0 0 6px rgba(56, 189, 248, 0.4); }
.timeline__dot--service_start { background: #4ade80; box-shadow: 0 0 6px rgba(74, 222, 128, 0.3); }
.timeline__dot--service_stop { background: #f87171; box-shadow: 0 0 6px rgba(248, 113, 113, 0.3); }
.timeline__dot--service_restart { background: var(--primary-light); box-shadow: 0 0 6px rgba(var(--primary-light-rgb), 0.3); }
.timeline__content { flex: 1; min-width: 0; }
.timeline__top {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  flex-wrap: wrap;
}
.timeline__badge {
  font-size: 0.6rem;
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
  padding: 0.12rem 0.4rem;
  border-radius: 6px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  flex-shrink: 0;
  background: rgba(148, 163, 184, 0.1);
  color: #94a3b8;
}
.timeline__badge--login { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
.timeline__badge--logout { background: rgba(148, 163, 184, 0.1); color: #94a3b8; }
.timeline__badge--create { background: rgba(99, 102, 241, 0.1); color: #818cf8; }
.timeline__badge--update { background: rgba(var(--primary-rgb), 0.1); color: var(--primary-light); }
.timeline__badge--delete { background: rgba(239, 68, 68, 0.1); color: #f87171; }
.timeline__badge--deploy { background: rgba(0, 220, 130, 0.1); color: #00dc82; }
.timeline__badge--backup { background: rgba(139, 92, 246, 0.1); color: #a78bfa; }
.timeline__badge--restore { background: rgba(139, 92, 246, 0.1); color: #a78bfa; }
.timeline__badge--ssl_issue { background: rgba(56, 189, 248, 0.1); color: #38bdf8; }
.timeline__badge--service_start { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
.timeline__badge--service_stop { background: rgba(239, 68, 68, 0.1); color: #f87171; }
.timeline__badge--service_restart { background: rgba(var(--primary-rgb), 0.1); color: var(--primary-light); }
.timeline__entity {
  font-size: 0.8rem;
  color: var(--text-secondary);
  font-weight: 500;
}
.timeline__meta {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-top: 0.2rem;
  font-size: 0.68rem;
  color: var(--text-faint);
}
.timeline__user {
  font-weight: 500;
  color: var(--text-muted);
}
.timeline__ip {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.62rem;
}
.activity-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  margin-top: 1rem;
  padding-top: 0.85rem;
  border-top: 1px solid var(--border-secondary);
}
.activity-pagination .page-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.2s;
}
.activity-pagination .page-btn:hover:not(:disabled) {
  border-color: var(--primary-border);
  color: var(--primary-text);
  background: var(--primary-bg);
}
.activity-pagination .page-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.activity-pagination .page-info {
  font-size: 0.75rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-muted);
  min-width: 50px;
  text-align: center;
}
@media (max-width: 768px) {
  .timeline__date { padding-left: 1.5rem; }
  .timeline__ip { display: none; }
  .timeline__ip + .timeline__sep { display: none; }
}

/* ─── «Утилиты»: расширяемый список сервисных операций ─── */
.info-card--utilities .utility-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.utility-item {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: start;
  gap: 0.65rem 0.85rem;
  padding: 0.7rem 0;
  border-top: 1px solid var(--border);
}
.utility-item:first-child { border-top: none; padding-top: 0.4rem; }
.utility-item:last-child  { padding-bottom: 0.2rem; }

.utility-item__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  flex-shrink: 0;
  margin-top: 1px;
}
.utility-item__body {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}
.utility-item__name {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-heading);
  line-height: 1.3;
}
.utility-item__hint {
  font-size: 0.72rem;
  color: var(--text-tertiary, var(--text-muted));
  line-height: 1.45;
}
.utility-item__status {
  margin-top: 0.2rem;
  font-size: 0.74rem;
  color: var(--success);
  font-weight: 500;
}
.utility-item__status--err { color: var(--danger); }

.utility-item__action {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.85rem;
  font-size: 0.78rem;
  font-weight: 600;
  font-family: inherit;
  white-space: nowrap;
  border-radius: 7px;
  cursor: pointer;
  /* Solid amber-градиент primary-кнопки проекта — одинаково контрастен и на
     светлой, и на тёмной теме. text-on автоматически меняется (#0a0a0f / #fff). */
  background: linear-gradient(135deg, var(--primary-light), var(--primary-dark));
  color: var(--primary-text-on);
  border: 1px solid transparent;
  box-shadow: 0 1px 2px rgba(var(--primary-dark-rgb), 0.25);
  transition: filter 0.15s, transform 0.05s, box-shadow 0.15s;
  align-self: center;
}
.utility-item__action:hover:not(:disabled) {
  filter: brightness(1.05);
  box-shadow: 0 2px 8px rgba(var(--primary-dark-rgb), 0.3);
}
.utility-item__action:active:not(:disabled) { transform: translateY(1px); }
.utility-item__action:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  filter: grayscale(0.25);
}

@media (max-width: 600px) {
  .utility-item {
    grid-template-columns: auto 1fr;
    grid-template-areas:
      'icon body'
      'icon action';
  }
  .utility-item__icon { grid-area: icon; }
  .utility-item__body { grid-area: body; }
  .utility-item__action {
    grid-area: action;
    justify-self: start;
    margin-top: 0.4rem;
  }
}

/* ─── Doctor modal ─── */
.modal__title--with-icon {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
.modal__title--with-icon svg { flex-shrink: 0; }

.doctor-loading {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 1rem 0;
  color: var(--text-tertiary, var(--text-muted));
  font-size: 0.85rem;
}
.doctor-error {
  padding: 0.75rem 0.9rem;
  background: var(--danger-bg);
  border: 1px solid var(--danger-border);
  border-radius: 8px;
  color: var(--danger);
  font-size: 0.82rem;
}
.doctor-meta {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem 1rem;
  padding: 0.75rem 0.9rem;
  margin-bottom: 0.85rem;
  background: var(--bg-elevated);
  border-radius: 8px;
  border: 1px solid var(--border);
}
.doctor-meta__row {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.doctor-meta__label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-tertiary, var(--text-muted));
}
.doctor-meta__value {
  font-size: 0.82rem;
  word-break: break-all;
  color: var(--text-primary);
}
.doctor-badge {
  display: inline-block;
  padding: 0.15rem 0.55rem;
  border-radius: 4px;
  font-size: 0.72rem;
  font-weight: 700;
}
.doctor-badge--ok {
  background: var(--success-bg);
  color: var(--success);
  border: 1px solid var(--success-border);
}
.doctor-badge--err {
  background: var(--danger-bg);
  color: var(--danger);
  border: 1px solid var(--danger-border);
}

.doctor-empty {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 1rem;
  background: var(--success-bg);
  border: 1px solid var(--success-border);
  border-radius: 8px;
  color: var(--success);
  font-size: 0.88rem;
  font-weight: 500;
}

.doctor-issues {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.doctor-issue {
  padding: 0.85rem 1rem;
  border-radius: 8px;
  border: 1px solid var(--border-strong, var(--border));
  background: var(--bg-elevated);
}
/* Critical — насыщенный красный, видно на тёмной и светлой темах */
.doctor-issue--critical {
  border: 2px solid var(--danger);
  background: var(--danger-bg);
}
/* Warning — оранжевый. CSS-переменных нет, делаем явно по обе темы. */
.doctor-issue--warning {
  border: 2px solid var(--primary);
  background: rgba(var(--primary-rgb), 0.10);
}
.doctor-issue--info {
  border: 2px solid #3b82f6;
  background: rgba(59, 130, 246, 0.08);
}
.doctor-issue__header {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  margin-bottom: 0.4rem;
  flex-wrap: wrap;
}
.doctor-issue__level {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 800;
  padding: 0.18rem 0.55rem;
  border-radius: 4px;
  flex-shrink: 0;
  color: #fff;
}
.doctor-issue--critical .doctor-issue__level { background: var(--danger); }
.doctor-issue--warning  .doctor-issue__level { background: var(--primary); }
.doctor-issue--info     .doctor-issue__level { background: #3b82f6; }

.doctor-issue__title {
  font-size: 0.92rem;
  font-weight: 700;
  color: var(--text-heading);
}
.doctor-issue--critical .doctor-issue__title { color: var(--danger); }

.doctor-issue__desc {
  margin: 0 0 0.55rem 0;
  font-size: 0.8rem;
  color: var(--text-primary);
  line-height: 1.5;
}
.doctor-issue__details {
  margin-bottom: 0.55rem;
  font-size: 0.75rem;
}
.doctor-issue__details summary {
  cursor: pointer;
  color: var(--text-secondary);
  user-select: none;
  font-weight: 500;
}
.doctor-issue__details summary:hover { color: var(--text-heading); }
.doctor-issue__details ul {
  margin: 0.45rem 0 0;
  padding-left: 1.2rem;
  list-style: disc;
  color: var(--text-secondary);
}
.doctor-issue__details li { margin-bottom: 0.15rem; word-break: break-all; }
.doctor-issue__actions { margin-top: 0.55rem; }

/* Кнопка fix'а — solid background чтобы было одинаково видно на dark/light. */
.doctor-fix-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.45rem 0.95rem;
  font-size: 0.8rem;
  font-weight: 600;
  background: linear-gradient(135deg, #60a5fa, #2563eb);
  color: #fff;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  transition: filter 0.15s, transform 0.05s;
  box-shadow: 0 1px 2px rgba(37, 99, 235, 0.25);
}
.doctor-fix-btn:hover:not(:disabled) {
  filter: brightness(1.08);
}
.doctor-fix-btn:active:not(:disabled) { transform: translateY(1px); }
.doctor-fix-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  filter: grayscale(0.3);
}
/* Для critical issue — красная кнопка fix'а (нормализация прав важна, опасности нет, но семантика "лечим критичный баг") */
.doctor-issue--critical .doctor-fix-btn {
  background: linear-gradient(135deg, #ef4444, #b91c1c);
  box-shadow: 0 1px 2px rgba(185, 28, 28, 0.3);
}
</style>
