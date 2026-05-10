<template>
  <div class="backups">
    <div class="backups__header">
      <div>
        <h1 class="backups__title">Бэкапы</h1>
        <p class="backups__subtitle">Конфигурации и история резервных копий</p>
      </div>
      <button class="backups__refresh" :disabled="loading" @click="refresh">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" :class="{ spinning: loading }"><polyline points="23,4 23,10 17,10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
        Обновить
      </button>
    </div>

    <!-- Конфигурации (глобальные): две вкладки — Расписание и Хранилища -->
    <div class="backups__section">
      <div class="section-header">
        <h2 class="section-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 0.4rem; vertical-align: -2px;">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
          Конфигурации
        </h2>
      </div>

      <div class="backups__tabs">
        <button
          class="backups__tab"
          :class="{ 'backups__tab--active': cfgTab === 'schedule' }"
          @click="cfgTab = 'schedule'"
        >
          Расписание
        </button>
        <button
          class="backups__tab"
          :class="{ 'backups__tab--active': cfgTab === 'storage' }"
          @click="cfgTab = 'storage'"
        >
          Хранилища
        </button>
        <button
          class="backups__tab"
          :class="{ 'backups__tab--active': cfgTab === 'checks' }"
          @click="openChecksTab"
        >
          Проверки Restic
        </button>
      </div>

      <!-- Вкладка: Расписание (автобэкапы) -->
      <div v-if="cfgTab === 'schedule'" class="tab-content settings-card">
        <p class="section-hint">
          Глобальные параметры автоматических бэкапов. Применяются ко всем сайтам.
          Бэкап уезжает во все выбранные хранилища сразу.
        </p>
        <div class="settings-fields">
          <label class="inline-check">
            <input type="checkbox" v-model="backupDefaults.enabled" />
            Включить автобэкапы
          </label>

          <div class="form-group">
            <label class="form-label">Движок</label>
            <select v-model="backupDefaults.engine" class="form-input form-input--select">
              <option value="RESTIC">Restic (дедупликация, рекомендуется)</option>
              <option value="TAR">TAR (простой архив .tar.gz)</option>
            </select>
            <p class="form-hint">
              Restic хранит один «снапшот» на каждый запуск, но физически
              заливает только изменившиеся чанки. Экономит место и трафик.
              TAR — обычный .tar.gz: совместим со всеми хранилищами, без дедупликации.
            </p>
          </div>

          <div class="form-group">
            <label class="form-label">Что бэкапим</label>
            <select v-model="backupDefaults.type" class="form-input form-input--select">
              <option value="FULL">Полный (файлы + БД)</option>
              <option value="FILES_ONLY">Только файлы</option>
              <option value="DB_ONLY">Только БД</option>
              <option v-if="backupDefaults.engine === 'TAR'" value="DIFFERENTIAL">Дифференциальный (от последнего FULL)</option>
            </select>
            <p v-if="backupDefaults.type === 'DIFFERENTIAL'" class="form-hint">
              Для каждого сайта агент возьмёт файлы, изменившиеся с даты последнего успешного полного бэкапа, плюс свежий дамп БД. Если полного бэкапа ещё нет — агент сам сделает полный.
            </p>
          </div>

          <div class="form-group">
            <label class="form-label">Расписание (cron)</label>
            <input v-model="backupDefaults.schedule" class="form-input mono" placeholder="0 3 * * *" />
            <p class="form-hint">Пример: <code>0 3 * * *</code> — ежедневно в 3:00.</p>
          </div>

          <div class="form-group">
            <label class="form-label">Хранилища (куда писать)</label>
            <div v-if="allStorageLocations.length === 0" class="form-hint">
              Нет ни одного хранилища. Добавь во вкладке «Хранилища».
            </div>
            <label v-for="loc in allStorageLocations" :key="loc.id" class="inline-check">
              <input
                type="checkbox"
                :value="loc.id"
                :checked="backupDefaults.storageLocationIds.includes(loc.id)"
                :disabled="backupDefaults.engine === 'RESTIC' && !loc.resticEnabled"
                @change="toggleBackupLocation(loc.id)"
              />
              {{ loc.name }}
              <span class="cfg-badge">{{ loc.type }}</span>
              <span v-if="!loc.resticEnabled" class="cfg-badge cfg-badge--muted">Restic не поддерживается</span>
            </label>
          </div>

          <div v-if="backupDefaults.engine === 'RESTIC'" class="form-group">
            <label class="form-label">Retention (Restic)</label>
            <div class="retention-grid">
              <div>
                <label class="form-sublabel">По одному за день</label>
                <input v-model.number="backupDefaults.retention.keepDaily" type="number" min="0" max="365" class="form-input" />
              </div>
              <div>
                <label class="form-sublabel">По одному за неделю</label>
                <input v-model.number="backupDefaults.retention.keepWeekly" type="number" min="0" max="52" class="form-input" />
              </div>
              <div>
                <label class="form-sublabel">По одному за месяц</label>
                <input v-model.number="backupDefaults.retention.keepMonthly" type="number" min="0" max="24" class="form-input" />
              </div>
              <div>
                <label class="form-sublabel">По одному за год</label>
                <input v-model.number="backupDefaults.retention.keepYearly" type="number" min="0" max="20" class="form-input" />
              </div>
            </div>
            <p class="form-hint">
              Пример: 7 / 4 / 6 / 1 — последние 7 дней ежедневно, 4 воскресенья,
              6 последних 1-х чисел месяца, 1 последний снапшот года.
              Остальное чистится автоматически (restic forget --prune).
            </p>
          </div>

          <div v-else class="form-group">
            <label class="form-label">Срок хранения (TAR), бэкапов</label>
            <input v-model.number="backupDefaults.retentionDays" type="number" min="1" max="365" class="form-input" />
          </div>

          <!-- Плановая проверка Restic-реп (integrity check) -->
          <div class="check-block">
            <label class="inline-check">
              <input type="checkbox" v-model="backupDefaults.checkEnabled" />
              Плановая проверка целостности Restic-реп
            </label>
            <p class="form-hint">
              Запускает <code>restic check</code> по расписанию — чтобы битый pack или обрыв загрузки
              не остался незамеченным. Проверка идёт per-репа (сайт × хранилище).
              Без <code>--read-data</code> — проверяется только структура (быстро).
              C <code>--read-data-subset=N%</code> — плюс читается N% чанков (медленно, но ловит порчу данных).
            </p>

            <div v-if="backupDefaults.checkEnabled" class="check-block__fields">
              <div class="form-group">
                <label class="form-label">Расписание (cron)</label>
                <input v-model="backupDefaults.checkSchedule" class="form-input mono" placeholder="0 4 * * 0" />
                <p class="form-hint">По умолчанию: <code>0 4 * * 0</code> — воскресенье, 04:00.</p>
              </div>
              <div class="form-group">
                <label class="inline-check">
                  <input type="checkbox" v-model="backupDefaults.checkReadData" />
                  Читать данные (--read-data-subset)
                </label>
                <p class="form-hint">
                  Без флага — только проверка индексов (почти мгновенно). С флагом — скачивается N% pack-файлов
                  и хэшируется. Для S3/remote — трафик и время.
                </p>
              </div>
              <div v-if="backupDefaults.checkReadData" class="form-group">
                <label class="form-label">Subset (доля данных)</label>
                <input v-model="backupDefaults.checkReadDataSubset" class="form-input mono" placeholder="10%" />
                <p class="form-hint">Например <code>5%</code> или <code>10%</code>. Без знака процента = абсолютное число pack'ов.</p>
              </div>
              <div class="form-group">
                <label class="form-label">Минимальный интервал между проверками, часов</label>
                <input v-model.number="backupDefaults.checkMinIntervalHours" type="number" min="1" max="720" class="form-input" />
                <p class="form-hint">Страховка от двойных запусков — не чаще одного раза в N часов на репу.</p>
              </div>
            </div>
          </div>
        </div>

        <!-- Глобальные исключения путей — fallback для всех сайтов -->
        <div class="global-excludes">
          <div class="global-excludes__field">
            <label class="form-label">Глобальные исключения путей</label>
            <p class="form-hint global-excludes__hint">
              Применяются к ручным и автоматическим бэкапам, если у сайта <b>не задано</b> своих excludes.
              Per-site исключения (на странице сайта → вкладка «Бэкапы») перебивают эти.
              Один путь на строке. Glob-шаблоны (<code>*</code>, <code>**</code>) работают. Строки с <code>#</code> — игнор.
            </p>
            <textarea
              v-model="globalExcludesText"
              class="global-excludes__textarea"
              rows="7"
              spellcheck="false"
              placeholder="www/wp-content/cache&#10;www/core/cache&#10;tmp&#10;*.log&#10;# комментарий — игнорируется"
            />
          </div>

          <div class="global-excludes__field">
            <label class="form-label">Глобальные исключения таблиц БД (только структура)</label>
            <p class="form-hint global-excludes__hint">
              Список таблиц по одной на строке. В дамп попадёт <code>CREATE TABLE</code>, но без <code>INSERT</code>.
              Полезно для сессий/логов/кешей в БД, которые не нужно бэкапить.
            </p>
            <textarea
              v-model="globalExcludeTablesText"
              class="global-excludes__textarea"
              rows="5"
              spellcheck="false"
              placeholder="modx_session&#10;modx_manager_log&#10;wp_options"
            />
          </div>
        </div>

        <div class="cfg-actions">
          <button class="btn btn--primary" :disabled="savingDefaults" @click="saveBackupDefaults">
            {{ savingDefaults ? 'Сохранение...' : 'Сохранить' }}
          </button>
        </div>
      </div>

      <!-- Вкладка: Проверки Restic -->
      <div v-if="cfgTab === 'checks'" class="tab-content settings-card">
        <p class="section-hint">
          История запусков <code>restic check</code> — проверка целостности репозиториев.
          Показывается последние 100 записей по всем репам (site × storage).
          Запустить проверку вручную — на странице сайта во вкладке «Бэкапы».
        </p>
        <div class="check-toolbar">
          <button class="btn btn--ghost btn--sm" :disabled="loadingChecks" @click="loadLatestChecks">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" :class="{ spinning: loadingChecks }">
              <polyline points="23,4 23,10 17,10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            Обновить
          </button>
        </div>

        <div v-if="!latestChecks.length && !loadingChecks" class="empty-card empty-card--flush">
          <p>Проверок ещё не было. Включи плановую проверку или запусти вручную из карточки сайта.</p>
        </div>
        <table v-else class="storage-table">
          <thead>
            <tr>
              <th>Сайт</th>
              <th>Хранилище</th>
              <th>Результат</th>
              <th>Когда</th>
              <th>Длительность</th>
              <th>Источник</th>
              <th>Ошибка</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in latestChecks" :key="c.id">
              <td>{{ c.siteName }}</td>
              <td><span class="cfg-badge">{{ c.storageLocation?.name || '—' }}</span></td>
              <td>
                <span v-if="c.completedAt && c.success" class="cfg-badge cfg-badge--ok">OK</span>
                <span v-else-if="c.completedAt && !c.success" class="cfg-badge cfg-badge--err">FAIL</span>
                <span v-else class="cfg-badge cfg-badge--muted">идёт…</span>
              </td>
              <td>{{ formatDate(c.startedAt) }}</td>
              <td>{{ c.durationMs ? Math.round(c.durationMs / 1000) + ' с' : '—' }}</td>
              <td><span class="cfg-badge" :class="c.source === 'manual' ? '' : 'cfg-badge--muted'">{{ c.source === 'manual' ? 'ручн.' : 'плановая' }}</span></td>
              <td class="check-err-cell">{{ c.errorMessage || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Вкладка: Хранилища -->
      <div v-if="cfgTab === 'storage'" class="tab-content settings-card">
        <div class="cfg-panel__head">
          <p class="section-hint">
            Места, куда можно сохранять бэкапы. Одно хранилище = одна строка здесь.
            Движок <b>Restic</b> поддерживают только типы <b>LOCAL</b> и <b>S3</b>.
          </p>
          <button class="btn btn--primary btn--sm" @click="openStorageDialog(null)">+ Добавить</button>
        </div>

        <div v-if="allStorageLocations.length === 0" class="empty-card">
          <p>Ещё нет ни одного хранилища</p>
        </div>

        <table v-else class="storage-table">
          <thead>
            <tr>
              <th>Имя</th>
              <th>Тип</th>
              <th>Restic</th>
              <th>Создано</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="loc in allStorageLocations" :key="loc.id">
              <td>{{ loc.name }}</td>
              <td><span class="cfg-badge">{{ loc.type }}</span></td>
              <td>
                <span v-if="loc.resticEnabled" class="cfg-badge cfg-badge--ok">Да</span>
                <span v-else class="cfg-badge cfg-badge--muted">Нет</span>
              </td>
              <td>{{ formatDate(loc.createdAt) }}</td>
              <td class="actions-cell">
                <button class="link-btn" @click="testStorage(loc)">Тест</button>
                <button class="link-btn" @click="openStorageDialog(loc)">Изменить</button>
                <button class="link-btn link-btn--danger" @click="deleteStorage(loc)">Удалить</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Site Selector -->
    <div class="backups__selector">
      <label class="form-label">Сайт</label>
      <select v-model="selectedSiteId" class="form-input form-input--select" @change="onSiteChange">
        <option value="">Выберите сайт...</option>
        <option v-for="s in sites" :key="s.id" :value="s.id">{{ s.name }} ({{ s.domain }})</option>
      </select>
    </div>

    <template v-if="selectedSiteId">
      <!-- Ad-hoc backup -->
      <div class="backups__section">
        <div class="section-header">
          <h2 class="section-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:0.4rem;vertical-align:-2px;">
              <path d="M12 5v14M5 12h14"></path>
            </svg>
            Ручной бэкап
          </h2>
          <button class="btn btn--primary btn--sm" @click="openAdhocDialog">+ Создать бэкап</button>
        </div>
        <div class="settings-card">
          <p class="settings-card__desc" style="margin:0;">
            Одноразовый бэкап без сохранения конфигурации. Выбирается движок, тип и хранилище.
            Не влияет на автоматическое расписание.
          </p>
        </div>
      </div>

      <!-- Backup History -->
      <div class="backups__section">
        <div class="section-header">
          <h2 class="section-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:0.4rem;vertical-align:-2px;">
              <path d="M3 3v5h5"></path>
              <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"></path>
              <path d="M12 7v5l4 2"></path>
            </svg>
            История бэкапов
          </h2>
        </div>

        <div class="settings-card settings-card--list">
        <div v-if="!backups.length && !loading" class="empty-card empty-card--flush">
          <CatMascot :size="56" mood="sleepy" />
          <p>Бэкапов ещё нет</p>
        </div>
        <div v-else-if="backups.length" class="history-list">
          <div v-for="b in backups" :key="b.id" class="history-item">
            <div class="history-item__icon" :class="`history-item__icon--${b.status?.toLowerCase()}`">
              <svg v-if="b.status === 'COMPLETED'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20,6 9,17 4,12" /></svg>
              <svg v-else-if="b.status === 'FAILED'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              <div v-else-if="b.status === 'IN_PROGRESS'" class="spinner-sm" />
              <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" /><polyline points="12,6 12,12 16,14" /></svg>
            </div>
            <div class="history-item__info">
              <div class="history-item__top">
                <span class="history-item__type">{{ formatType(b.type) }}</span>
                <span v-if="b.engine" class="badge badge--engine">{{ b.engine === 'RESTIC' ? 'Restic' : 'TAR' }}</span>
                <span class="badge badge--storage badge--sm">{{ b.storageLocation?.name || formatStorage(b.storageType) }}</span>
              </div>
              <span class="history-item__meta">{{ formatDate(b.createdAt) }} · {{ formatSize(b.sizeBytes) }}</span>
              <div v-if="b.status === 'IN_PROGRESS' || b.status === 'PENDING'" class="progress-bar">
                <div class="progress-bar__fill" :style="{ width: `${liveProgress[b.id] ?? b.progress ?? 0}%` }" />
                <span class="progress-bar__label">{{ liveProgress[b.id] ?? b.progress ?? 0 }}%</span>
              </div>
              <span v-if="b.status === 'FAILED' && b.errorMessage" class="history-item__error">{{ b.errorMessage }}</span>
            </div>
            <span class="badge" :class="`badge--status-${b.status?.toLowerCase()}`">{{ formatStatus(b.status) }}</span>
            <div class="history-item__actions">
              <button v-if="b.status === 'COMPLETED'" class="btn-icon" title="Скачать бэкап" :disabled="!!downloadProgress[b.id]" @click="downloadBackup(b)">
                <svg v-if="downloadProgress[b.id] == null" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7,10 12,15 17,10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                <span v-else class="btn-icon__progress">{{ downloadProgress[b.id] }}%</span>
              </button>
              <button v-if="b.status === 'COMPLETED'" class="btn btn--sm btn--ghost" :disabled="restoring === b.id" title="Восстановить из этого бэкапа" @click="confirmRestore(b)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1,4 1,10 7,10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
                {{ restoring === b.id ? 'Восстановление...' : 'Восстановить' }}
              </button>
              <button v-if="b.status === 'COMPLETED' || b.status === 'FAILED'" class="btn-icon btn-icon--danger" title="Удалить бэкап" @click="confirmDeleteBackup(b)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
              </button>
            </div>
          </div>
        </div>
        </div>
      </div>
    </template>

    <div v-else class="backups__placeholder">
      <CatMascot :size="80" mood="sleepy" />
      <p class="backups__placeholder-text">Выберите сайт для управления бэкапами</p>
    </div>


    <!-- Storage Location Modal (создание/редактирование) -->
    <Teleport to="body">
      <div v-if="storageDialog.open" class="modal-overlay" @mousedown.self="storageDialog.open = false">
        <div class="modal modal--wide">
          <h3 class="modal__title">{{ storageDialog.editing ? 'Редактировать хранилище' : 'Новое хранилище' }}</h3>
          <div class="modal__fields">
            <div class="form-group">
              <label class="form-label">Имя</label>
              <input v-model="storageDialog.form.name" class="form-input" placeholder="Мой S3 / Yandex backup" />
            </div>

            <div class="form-group">
              <label class="form-label">Тип</label>
              <select v-model="storageDialog.form.type" class="form-input form-input--select" :disabled="!!storageDialog.editing">
                <option value="LOCAL">Локально (диск сервера)</option>
                <option value="S3">S3 / S3-совместимое</option>
                <option value="SFTP">SFTP (Restic)</option>
                <option value="YANDEX_DISK">Яндекс.Диск (только TAR)</option>
                <option value="CLOUD_MAIL_RU">Облако Mail.ru (только TAR)</option>
              </select>
            </div>

            <template v-if="storageDialog.form.type === 'LOCAL'">
              <div class="form-group">
                <label class="form-label">Путь (опционально)</label>
                <input v-model="storageDialog.form.config.remotePath" class="form-input mono" placeholder="/var/meowbox/backups (по умолчанию)" />
              </div>
            </template>

            <template v-if="storageDialog.form.type === 'S3'">
              <div class="form-group">
                <label class="form-label">Bucket</label>
                <input v-model="storageDialog.form.config.bucket" class="form-input" placeholder="my-backup-bucket" />
              </div>
              <div class="form-group">
                <label class="form-label">Endpoint</label>
                <input v-model="storageDialog.form.config.endpoint" class="form-input mono" placeholder="https://s3.amazonaws.com" />
                <span class="form-hint">
                  AWS: <code>https://s3.amazonaws.com</code> · Yandex: <code>https://storage.yandexcloud.net</code>
                  · Selectel: <code>https://s3.storage.selcloud.ru</code> · Timeweb: <code>https://s3.timeweb.cloud</code>
                </span>
              </div>
              <div class="form-group">
                <label class="form-label">Region</label>
                <input v-model="storageDialog.form.config.region" class="form-input mono" placeholder="us-east-1" />
              </div>
              <div class="form-group">
                <label class="form-label">Access Key</label>
                <input v-model="storageDialog.form.config.accessKey" class="form-input mono" />
              </div>
              <div class="form-group">
                <label class="form-label">Secret Key</label>
                <input v-model="storageDialog.form.config.secretKey" type="password" class="form-input mono" />
              </div>
              <div class="form-group">
                <label class="form-label">Prefix (опционально)</label>
                <input v-model="storageDialog.form.config.prefix" class="form-input mono" placeholder="meowbox" />
              </div>
            </template>

            <template v-if="storageDialog.form.type === 'SFTP'">
              <div class="form-group">
                <label class="form-label">Хост</label>
                <input v-model="storageDialog.form.config.sftpHost" class="form-input mono" placeholder="backups.example.com" />
              </div>
              <div class="form-group">
                <label class="form-label">Порт</label>
                <input v-model="storageDialog.form.config.sftpPort" class="form-input mono" placeholder="22" />
              </div>
              <div class="form-group">
                <label class="form-label">Username</label>
                <input v-model="storageDialog.form.config.sftpUsername" class="form-input mono" placeholder="backup" />
              </div>
              <div class="form-group">
                <label class="form-label">Путь на удалённой стороне</label>
                <input v-model="storageDialog.form.config.sftpPath" class="form-input mono" placeholder="/home/backup/restic" />
                <span class="form-hint">Абсолютный. Папки <code>/&lt;путь&gt;/&lt;имя_сайта&gt;</code> создаются автоматически.</span>
              </div>
              <div class="form-group">
                <label class="form-label">Способ авторизации</label>
                <select v-model="storageDialog.form.config.sftpAuthMode" class="form-input">
                  <option value="KEY">SSH-ключ (рекомендовано)</option>
                  <option value="PASSWORD">Пароль</option>
                </select>
                <span class="form-hint">
                  Ключ безопаснее (нечего перехватывать), но если на удалённом хосте только пароль — выбирай PASSWORD. Авторизация по паролю работает через <code>sshpass -e</code>; пароль никогда не попадает в командную строку.
                </span>
              </div>
              <template v-if="(storageDialog.form.config.sftpAuthMode || 'KEY') === 'KEY'">
                <div class="form-group">
                  <label class="form-label">SSH приватный ключ (PEM/OpenSSH)</label>
                  <textarea v-model="storageDialog.form.config.sftpPrivateKey" class="form-input mono" rows="6"
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"></textarea>
                  <span class="form-hint">
                    Ключ хранится в БД и пишется на сервер только при выполнении restic-операции (0600, /var/lib/meowbox/restic-sftp-keys/). Публичный ключ должен быть в <code>~/.ssh/authorized_keys</code> на удалённом хосте.
                  </span>
                </div>
                <div class="form-group">
                  <label class="form-label">Пасфраза ключа (опционально)</label>
                  <input v-model="storageDialog.form.config.sftpPassphrase" type="password" class="form-input mono" autocomplete="new-password" />
                </div>
              </template>
              <template v-else>
                <div class="form-group">
                  <label class="form-label">Пароль SSH-пользователя</label>
                  <input v-model="storageDialog.form.config.sftpPassword" type="password" class="form-input mono" autocomplete="new-password" placeholder="••••••••" />
                  <span class="form-hint">
                    Передаётся restic'у через переменную окружения <code>SSHPASS</code>, не виден в <code>ps</code>. Минимум 4 символа.
                  </span>
                </div>
              </template>
            </template>

            <template v-if="storageDialog.form.type === 'YANDEX_DISK'">
              <div class="form-group">
                <label class="form-label">OAuth токен</label>
                <input v-model="storageDialog.form.config.oauthToken" type="password" class="form-input mono" />
              </div>
              <div class="form-group">
                <label class="form-label">Путь на Диске</label>
                <input v-model="storageDialog.form.config.remotePath" class="form-input mono" placeholder="/meowbox-backups" />
              </div>
            </template>

            <template v-if="storageDialog.form.type === 'CLOUD_MAIL_RU'">
              <div class="form-group">
                <label class="form-label">Email (логин Mail.ru)</label>
                <input v-model="storageDialog.form.config.username" class="form-input" />
              </div>
              <div class="form-group">
                <label class="form-label">Пароль приложения</label>
                <input v-model="storageDialog.form.config.password" type="password" class="form-input mono" />
                <span class="form-hint">Создать в настройках безопасности Mail.ru</span>
              </div>
              <div class="form-group">
                <label class="form-label">Путь в облаке</label>
                <input v-model="storageDialog.form.config.remotePath" class="form-input mono" placeholder="/meowbox-backups" />
              </div>
            </template>

            <!-- Пароль Restic-репы: только для LOCAL/S3/SFTP и только при создании -->
            <template v-if="!storageDialog.editing && (storageDialog.form.type === 'LOCAL' || storageDialog.form.type === 'S3' || storageDialog.form.type === 'SFTP')">
              <div class="form-group">
                <label class="form-label">Пароль Restic (опционально)</label>
                <input v-model="storageDialog.form.resticPassword" type="text" class="form-input mono" placeholder="qwerty" autocomplete="off" />
                <span class="form-hint">
                  Если оставить пустым — будет использован стандартный пароль <code>qwerty</code>.
                  После создания пароль уже не изменить (новый пароль = потеря всех существующих снапшотов в репе).
                </span>
              </div>
            </template>
          </div>

          <div v-if="storageDialog.newPassword" class="warning-box">
            <b>Пароль Restic для этой репы:</b>
            <code class="warning-box__code">{{ storageDialog.newPassword }}</code>
            <p>Если потеряешь — данные в репе невосстановимы. Меняется только пересозданием хранилища.</p>
          </div>

          <div class="modal__actions">
            <button class="btn btn--ghost" @click="storageDialog.open = false">
              {{ storageDialog.newPassword ? 'Закрыть' : 'Отмена' }}
            </button>
            <button v-if="!storageDialog.newPassword" class="btn btn--primary" :disabled="storageDialog.saving" @click="saveStorage">
              {{ storageDialog.saving ? 'Сохранение...' : 'Сохранить' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Delete Confirmation Modal -->
    <Teleport to="body">
      <div v-if="deleteTarget" class="modal-overlay" @mousedown.self="deleteTarget = null">
        <div class="modal">
          <h3 class="modal__title">Подтверждение удаления</h3>
          <p class="modal__desc">{{ deleteMessage }}</p>
          <div class="modal__actions">
            <button class="btn btn--ghost" @click="deleteTarget = null">Отмена</button>
            <button class="btn btn--danger" :disabled="deleting" @click="doDelete">{{ deleting ? 'Удаление...' : 'Удалить' }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Restore Confirmation Modal -->
    <Teleport to="body">
      <div v-if="restoreTarget" class="modal-overlay" @mousedown.self="restoreTarget = null">
        <div class="modal">
          <h3 class="modal__title">Восстановление из бэкапа</h3>
          <p class="modal__desc">Файлы и/или базы данных сайта будут перезаписаны данными из бэкапа. Это действие нельзя отменить.</p>
          <p v-if="restoreTarget.engine === 'RESTIC'" class="modal__desc" style="font-size:0.85rem;color:#888;">
            Restic снапшот: <code>{{ restoreTarget.resticSnapshotId?.slice(0, 12) }}</code>
          </p>
          <div class="modal__actions">
            <button class="btn btn--ghost" @click="restoreTarget = null">Отмена</button>
            <button class="btn btn--primary" :disabled="!!restoring" @click="doRestore">{{ restoring ? 'Восстановление...' : 'Восстановить' }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Adhoc Backup Modal -->
    <Teleport to="body">
      <div v-if="adhocDialog.open" class="modal-overlay" @mousedown.self="adhocDialog.open = false">
        <div class="modal">
          <h3 class="modal__title">Создать бэкап вручную</h3>
          <div class="form-group">
            <label class="form-label">Движок</label>
            <select v-model="adhocDialog.form.engine" class="form-input form-input--select">
              <option value="RESTIC">Restic (дедупликация)</option>
              <option value="TAR">TAR (обычный архив)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Что бэкапим</label>
            <select v-model="adhocDialog.form.type" class="form-input form-input--select">
              <option value="FULL">Полный (файлы + БД)</option>
              <option value="FILES_ONLY">Только файлы</option>
              <option value="DB_ONLY">Только БД</option>
              <option v-if="adhocDialog.form.engine === 'TAR'" value="DIFFERENTIAL">Дифференциальный (файлы + БД, изменения с последнего полного)</option>
            </select>
            <p v-if="adhocDialog.form.type === 'DIFFERENTIAL'" class="form-hint">
              Требует существующий полный бэкап-«базу». Агент возьмёт только файлы, изменившиеся с последнего успешного FULL для этого сайта (<code>tar --newer-mtime</code>), плюс текущий дамп БД.
            </p>
            <p v-if="adhocDialog.form.engine === 'RESTIC' && adhocDialog.form.type !== 'DB_ONLY'" class="form-hint">
              У Restic отдельного «дифференциала» нет — он и так льёт только изменившиеся чанки, каждый снапшот самодостаточен.
            </p>
          </div>
          <div class="form-group">
            <label class="form-label">Хранилище</label>
            <select v-model="adhocDialog.form.storageLocationId" class="form-input form-input--select">
              <option value="">— выбери —</option>
              <option
                v-for="loc in allStorageLocations"
                :key="loc.id"
                :value="loc.id"
                :disabled="adhocDialog.form.engine === 'RESTIC' && !loc.resticEnabled"
              >
                {{ loc.name }} ({{ loc.type }}){{ adhocDialog.form.engine === 'RESTIC' && !loc.resticEnabled ? ' — не поддерживает Restic' : '' }}
              </option>
            </select>
            <p v-if="allStorageLocations.length === 0" style="font-size:0.85rem;color:#888;margin-top:0.25rem;">
              Нет ни одного хранилища. Добавь в Настройки → Хранилища.
            </p>
          </div>
          <div class="modal__actions">
            <button class="btn btn--ghost" @click="adhocDialog.open = false">Отмена</button>
            <button class="btn btn--primary" :disabled="adhocDialog.saving || !adhocDialog.form.storageLocationId" @click="runAdhocBackup">
              {{ adhocDialog.saving ? 'Запуск...' : 'Запустить' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface SiteItem { id: string; name: string; domain: string; }
interface BackupItem {
  id: string;
  type: string;
  status: string;
  engine?: 'TAR' | 'RESTIC';
  storageType: string;
  storageLocation?: { id: string; name: string; type: string } | null;
  resticSnapshotId?: string | null;
  sizeBytes?: number;
  progress?: number;
  errorMessage?: string;
  baseBackupId?: string | null;
  createdAt: string;
}

const api = useApi();
const { onBackupProgress, onBackupRestoreProgress } = useSocket();

const sites = ref<SiteItem[]>([]);
const selectedSiteId = ref('');
const backups = ref<BackupItem[]>([]);
const loading = ref(false);

const triggeringMap = reactive<Record<string, boolean>>({});
const liveProgress = reactive<Record<string, number>>({});

// Polling-fallback, чтобы статус "создаётся" не залипал при потере WS-событий
let backupStatusPollTimer: ReturnType<typeof setInterval> | null = null;
function hasActiveBackup(): boolean {
  return backups.value.some((b) => b.status === 'PENDING' || b.status === 'IN_PROGRESS');
}
function ensureBackupStatusPoll() {
  if (backupStatusPollTimer) return;
  if (!hasActiveBackup()) return;
  backupStatusPollTimer = setInterval(async () => {
    if (!selectedSiteId.value) return;
    try {
      backups.value = await api.get<BackupItem[]>(`/sites/${selectedSiteId.value}/backups`);
      if (!hasActiveBackup() && backupStatusPollTimer) {
        clearInterval(backupStatusPollTimer);
        backupStatusPollTimer = null;
      }
    } catch { /* транзитная ошибка сети — повторим на следующем тике */ }
  }, 5000);
}
function stopBackupStatusPoll() {
  if (backupStatusPollTimer) {
    clearInterval(backupStatusPollTimer);
    backupStatusPollTimer = null;
  }
}

// Вкладка внутри секции «Конфигурации»
const cfgTab = useTabQuery(['schedule', 'storage', 'checks'], 'schedule') as Ref<'schedule' | 'storage' | 'checks'>;
const latestChecks = ref<ResticCheckItem[]>([]);
const loadingChecks = ref(false);

async function openChecksTab() {
  cfgTab.value = 'checks';
  await loadLatestChecks();
}

async function loadLatestChecks() {
  loadingChecks.value = true;
  try {
    const res = await api.get<ResticCheckItem[] | { data: ResticCheckItem[] }>('/restic-checks/latest');
    const list = Array.isArray(res) ? res : (res as { data?: ResticCheckItem[] }).data;
    latestChecks.value = Array.isArray(list) ? list : [];
  } catch (err: unknown) {
    showToast((err as Error).message || 'Не удалось загрузить проверки', true);
    latestChecks.value = [];
  } finally {
    loadingChecks.value = false;
  }
}

const deleteTarget = ref<{ type: 'backup'; id: string } | null>(null);
const deleteMessage = ref('');
const deleting = ref(false);

const restoreTarget = ref<BackupItem | null>(null);
const restoring = ref<string | null>(null);

const toast = useMbToast();
function showToast(msg: string, isError = false) {
  if (isError) toast.error(msg);
  else toast.success(msg);
}

function formatType(t: string) {
  const map: Record<string, string> = { FULL: 'Полный', FILES_ONLY: 'Файлы', DB_ONLY: 'Только БД', DIFFERENTIAL: 'Дифференциальный' };
  return map[t] || t;
}

function formatStorage(s: string) {
  const map: Record<string, string> = { LOCAL: 'Локально', SFTP: 'SFTP', YANDEX_DISK: 'Я.Диск', CLOUD_MAIL_RU: 'Cloud Mail', S3: 'S3' };
  return map[s] || s;
}

function formatStatus(s?: string) {
  const map: Record<string, string> = { COMPLETED: 'Готово', FAILED: 'Ошибка', IN_PROGRESS: 'Выполняется', PENDING: 'В очереди' };
  return map[s || ''] || s || '';
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes?: number | bigint) {
  if (!bytes) return '—';
  const n = Number(bytes);
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ===== Data loading =====

async function loadSites() {
  try { sites.value = await api.get<SiteItem[]>('/sites'); } catch { /* ignore */ }
}

async function loadBackups() {
  if (!selectedSiteId.value) return;
  try { backups.value = await api.get<BackupItem[]>(`/sites/${selectedSiteId.value}/backups`); } catch { backups.value = []; }
  ensureBackupStatusPoll();
}

async function onSiteChange() {
  if (!selectedSiteId.value) { backups.value = []; return; }
  loading.value = true;
  await loadBackups();
  loading.value = false;
}

async function refresh() {
  loading.value = true;
  await Promise.all([
    loadSites(),
    loadStorageLocations(),
    loadBackupDefaults(),
    ...(selectedSiteId.value ? [loadBackups()] : []),
  ]);
  loading.value = false;
}

// ===== Adhoc (ручной) бэкап без сохранения конфига =====

interface StorageLocationOption {
  id: string;
  name: string;
  type: string;
  resticEnabled: boolean;
  config?: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}
const allStorageLocations = ref<StorageLocationOption[]>([]);
const adhocDialog = reactive({
  open: false,
  saving: false,
  form: {
    engine: 'RESTIC' as 'RESTIC' | 'TAR',
    type: 'FULL' as 'FULL' | 'FILES_ONLY' | 'DB_ONLY' | 'DIFFERENTIAL',
    storageLocationId: '',
  },
});

async function loadStorageLocations() {
  try {
    const res = await api.get<{ data: StorageLocationOption[] }>('/storage-locations');
    const list = (res as unknown as { data: StorageLocationOption[] }).data
      || (res as unknown as StorageLocationOption[]);
    allStorageLocations.value = Array.isArray(list) ? list : [];
  } catch {
    allStorageLocations.value = [];
  }
}

function openAdhocDialog() {
  if (allStorageLocations.value.length === 0) {
    loadStorageLocations();
  }
  adhocDialog.form.engine = 'RESTIC';
  adhocDialog.form.type = 'FULL';
  adhocDialog.form.storageLocationId = '';
  adhocDialog.open = true;
}

async function runAdhocBackup() {
  if (!adhocDialog.form.storageLocationId) return;
  adhocDialog.saving = true;
  try {
    await api.post('/backups/trigger', {
      siteId: selectedSiteId.value,
      engine: adhocDialog.form.engine,
      type: adhocDialog.form.type,
      storageLocationId: adhocDialog.form.storageLocationId,
    });
    showToast('Бэкап запущен');
    adhocDialog.open = false;
    setTimeout(() => loadBackups(), 1500);
  } catch (err: unknown) {
    showToast((err as Error).message || 'Ошибка запуска бэкапа', true);
  } finally {
    adhocDialog.saving = false;
  }
}

// ===== Глобальные настройки автобэкапов + StorageLocation CRUD =====

interface BackupRetention { keepDaily: number; keepWeekly: number; keepMonthly: number; keepYearly: number; }
interface BackupDefaults {
  enabled: boolean;
  schedule: string;
  engine: 'TAR' | 'RESTIC';
  type: 'FULL' | 'FILES_ONLY' | 'DB_ONLY' | 'DIFFERENTIAL';
  storageLocationIds: string[];
  retention: BackupRetention;
  retentionDays: number;
  excludePaths: string[];
  excludeTableData: string[];
  checkEnabled: boolean;
  checkSchedule: string;
  checkReadData: boolean;
  checkReadDataSubset: string;
  checkMinIntervalHours: number;
}

interface ResticCheckItem {
  id: string;
  storageLocationId: string;
  siteId?: string | null;
  siteName: string;
  success: boolean;
  errorMessage?: string | null;
  durationMs?: number | null;
  source: 'manual' | 'scheduled';
  startedAt: string;
  completedAt?: string | null;
  storageLocation?: { name: string; type: string } | null;
}

const savingDefaults = ref(false);
const backupDefaults = reactive<BackupDefaults>({
  enabled: false,
  schedule: '0 3 * * *',
  engine: 'RESTIC',
  type: 'FULL',
  storageLocationIds: [],
  retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6, keepYearly: 1 },
  retentionDays: 14,
  excludePaths: [],
  excludeTableData: [],
  checkEnabled: false,
  checkSchedule: '0 4 * * 0',
  checkReadData: false,
  checkReadDataSubset: '10%',
  checkMinIntervalHours: 20,
});

// Глобальные excludes/excludeTables — синхронизируются с backupDefaults как multiline-text
const globalExcludesText = ref('');
const globalExcludeTablesText = ref('');

function syncGlobalExcludesFromDefaults() {
  globalExcludesText.value = (backupDefaults.excludePaths || []).join('\n');
  globalExcludeTablesText.value = (backupDefaults.excludeTableData || []).join('\n');
}

function parseLines(text: string): string[] {
  return (text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
    .slice(0, 200);
}

async function loadBackupDefaults() {
  try {
    const data = await api.get<BackupDefaults>('/backups/auto-settings');
    if (!data.storageLocationIds) data.storageLocationIds = [];
    if (!data.retention) data.retention = { keepDaily: 7, keepWeekly: 4, keepMonthly: 6, keepYearly: 1 };
    if (data.checkSchedule === undefined) data.checkSchedule = '0 4 * * 0';
    if (data.checkReadDataSubset === undefined) data.checkReadDataSubset = '10%';
    if (data.checkMinIntervalHours === undefined) data.checkMinIntervalHours = 20;
    if (!data.excludePaths) data.excludePaths = [];
    if (!data.excludeTableData) data.excludeTableData = [];
    Object.assign(backupDefaults, data);
    syncGlobalExcludesFromDefaults();
  } catch { /* первый запуск — дефолты */ }
}

async function saveBackupDefaults() {
  savingDefaults.value = true;
  try {
    backupDefaults.excludePaths = parseLines(globalExcludesText.value);
    backupDefaults.excludeTableData = parseLines(globalExcludeTablesText.value);
    await api.post('/backups/auto-settings', backupDefaults);
    showToast('Настройки автобэкапов сохранены');
  } catch (e) {
    showToast((e as Error)?.message || 'Не удалось сохранить', true);
  } finally {
    savingDefaults.value = false;
  }
}

function toggleBackupLocation(id: string) {
  const i = backupDefaults.storageLocationIds.indexOf(id);
  if (i >= 0) backupDefaults.storageLocationIds.splice(i, 1);
  else backupDefaults.storageLocationIds.push(id);
}

// ---- Storage locations CRUD (уже объявлено allStorageLocations в adhoc-секции) ----

const storageDialog = reactive({
  open: false,
  editing: null as StorageLocationOption | null,
  saving: false,
  newPassword: '' as string,
  form: {
    name: '',
    type: 'S3' as 'LOCAL' | 'S3' | 'SFTP' | 'YANDEX_DISK' | 'CLOUD_MAIL_RU',
    config: {} as Record<string, string>,
    resticPassword: '' as string,
  },
});

function openStorageDialog(loc: StorageLocationOption | null) {
  storageDialog.newPassword = '';
  storageDialog.editing = loc;
  if (loc) {
    storageDialog.form.name = loc.name;
    storageDialog.form.type = loc.type as typeof storageDialog.form.type;
    // config приходит с redacted '***' секретами — если пользователь не меняет, мы их не перешлём
    storageDialog.form.config = { ...((loc as unknown as { config?: Record<string, string> }).config || {}) };
    storageDialog.form.resticPassword = '';
  } else {
    storageDialog.form.name = '';
    storageDialog.form.type = 'S3';
    storageDialog.form.config = {};
    storageDialog.form.resticPassword = '';
  }
  // Дефолтный SFTP auth mode = 'KEY', если ещё не выставлен (старые записи или новые формы)
  if (storageDialog.form.type === 'SFTP' && !storageDialog.form.config.sftpAuthMode) {
    storageDialog.form.config.sftpAuthMode = 'KEY';
  }
  storageDialog.open = true;
}

// При смене типа на SFTP — выставляем default auth mode (если оператор переключил select)
watch(() => storageDialog.form.type, (t) => {
  if (t === 'SFTP' && !storageDialog.form.config.sftpAuthMode) {
    storageDialog.form.config.sftpAuthMode = 'KEY';
  }
});

async function saveStorage() {
  storageDialog.saving = true;
  try {
    if (storageDialog.editing) {
      // PATCH: убираем секреты со звёздочками, чтобы не затереть настоящие
      const cleanCfg: Record<string, string> = {};
      for (const [k, v] of Object.entries(storageDialog.form.config || {})) {
        if (v && v !== '***') cleanCfg[k] = v;
      }
      await api.patch(`/storage-locations/${storageDialog.editing.id}`, {
        name: storageDialog.form.name,
        config: cleanCfg,
      });
      showToast('Хранилище обновлено');
      await loadStorageLocations();
      storageDialog.open = false;
    } else {
      // Пароль Restic — опционально. Если пустой, бэк подставит стандартный фоллбек «qwerty».
      // Поле уезжает только для LOCAL/S3 (только они поддерживают Restic), чтобы не мусорить.
      const resticSupported = storageDialog.form.type === 'LOCAL' || storageDialog.form.type === 'S3' || storageDialog.form.type === 'SFTP';
      const payload: Record<string, unknown> = {
        name: storageDialog.form.name,
        type: storageDialog.form.type,
        config: storageDialog.form.config,
      };
      if (resticSupported && storageDialog.form.resticPassword.trim()) {
        payload.resticPassword = storageDialog.form.resticPassword.trim();
      }
      const res = await api.post<{ location: StorageLocationOption; resticPassword?: string }>(
        '/storage-locations',
        payload,
      );
      await loadStorageLocations();
      if (res?.resticPassword) {
        storageDialog.newPassword = res.resticPassword;
      } else {
        storageDialog.open = false;
      }
      showToast('Хранилище создано');
    }
  } catch (e) {
    showToast((e as Error)?.message || 'Не удалось сохранить', true);
  } finally {
    storageDialog.saving = false;
  }
}

async function deleteStorage(loc: StorageLocationOption) {
  const ok = await useMbConfirm().ask({
    title: 'Удаление хранилища',
    message: `Удалить хранилище "${loc.name}"?`,
    confirmText: 'Удалить',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/storage-locations/${loc.id}`);
    await loadStorageLocations();
    showToast('Хранилище удалено');
  } catch (e) {
    showToast((e as Error)?.message || 'Не удалось удалить', true);
  }
}

async function testStorage(loc: StorageLocationOption) {
  showToast(`Проверяю ${loc.name}...`);
  try {
    const res = await api.post<{ success: boolean; error?: string }>(
      `/storage-locations/${loc.id}/test?siteName=_connection-test_`,
      {},
    );
    if (res.success) showToast(`${loc.name}: доступ есть`);
    else showToast(`${loc.name}: ${res.error || 'ошибка'}`, true);
  } catch (e) {
    showToast((e as Error)?.message || 'Не удалось протестировать', true);
  }
}

// ===== Download =====

const downloadProgress = reactive<Record<string, number>>({});

async function downloadBackup(b: BackupItem) {
  const dateStr = new Date(b.createdAt).toISOString().slice(0, 10);
  try {
    if (b.type === 'DIFFERENTIAL' && b.baseBackupId) {
      downloadProgress[b.id] = 0;
      await api.download(
        `/backups/${b.baseBackupId}/download`,
        `backup-base-${dateStr}-${b.baseBackupId.slice(0, 8)}.tar.gz`,
        (pct) => { downloadProgress[b.id] = Math.round(pct / 2); },
      );
      await api.download(
        `/backups/${b.id}/download`,
        `backup-diff-${dateStr}-${b.id.slice(0, 8)}.tar.gz`,
        (pct) => { downloadProgress[b.id] = 50 + Math.round(pct / 2); },
      );
    } else {
      downloadProgress[b.id] = 0;
      await api.download(
        `/backups/${b.id}/download`,
        `backup-${dateStr}-${b.id.slice(0, 8)}.tar.gz`,
        (pct) => { downloadProgress[b.id] = pct; },
      );
    }
  } catch (err: unknown) {
    showToast((err as Error).message || 'Ошибка скачивания', true);
  } finally {
    delete downloadProgress[b.id];
  }
}

// ===== Delete =====

function confirmDeleteBackup(b: BackupItem) {
  deleteTarget.value = { type: 'backup', id: b.id };
  deleteMessage.value = 'Удалить этот бэкап? Файл бэкапа будет удалён безвозвратно.';
}

async function doDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    const { id } = deleteTarget.value;
    await api.del(`/backups/${id}`);
    showToast('Бэкап удалён');
    deleteTarget.value = null;
    await loadBackups();
  } catch (err: unknown) {
    showToast((err as Error).message || 'Ошибка удаления', true);
  } finally {
    deleting.value = false;
  }
}

// ===== Restore =====

function confirmRestore(b: BackupItem) {
  restoreTarget.value = b;
}

async function doRestore() {
  if (!restoreTarget.value) return;
  const backupId = restoreTarget.value.id;
  restoring.value = backupId;
  restoreTarget.value = null;
  try {
    await api.post(`/backups/${backupId}/restore`);
    showToast('Восстановление запущено');
  } catch (err: unknown) {
    showToast((err as Error).message || 'Ошибка восстановления', true);
  } finally {
    restoring.value = null;
  }
}

// ===== WebSocket progress =====

let cleanupBackupProgress: (() => void) | undefined;
let cleanupRestoreProgress: (() => void) | undefined;

onMounted(async () => {
  await loadSites();
  loadStorageLocations();
  loadBackupDefaults();

  cleanupBackupProgress = onBackupProgress((payload) => {
    liveProgress[payload.backupId] = payload.progress;

    if (payload.status === 'COMPLETED' || payload.status === 'FAILED') {
      setTimeout(() => {
        delete liveProgress[payload.backupId];
        loadBackups();
      }, 500);
    }
  });

  cleanupRestoreProgress = onBackupRestoreProgress((payload) => {
    if (payload.status === 'RESTORED') {
      showToast('Бэкап восстановлен');
    } else if (payload.status === 'FAILED') {
      showToast(payload.error || 'Ошибка восстановления', true);
    }
  });
});

onBeforeUnmount(() => {
  cleanupBackupProgress?.();
  cleanupRestoreProgress?.();
  stopBackupStatusPoll();
});
</script>

<style scoped>
.backups__header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 1.5rem; gap: 1rem; }
.backups__title { font-size: 1.5rem; font-weight: 700; color: var(--text-heading); margin: 0; }
.backups__subtitle { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.15rem; }

.backups__refresh {
  display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.45rem 0.85rem;
  border-radius: 10px; border: 1px solid var(--border-secondary);
  background: var(--bg-surface); color: var(--text-tertiary);
  font-size: 0.78rem; font-weight: 500; font-family: inherit; cursor: pointer; transition: all 0.2s;
}
.backups__refresh:hover { border-color: var(--primary-border); color: var(--primary-text); background: var(--primary-bg); }
.backups__refresh:disabled { opacity: 0.5; cursor: not-allowed; }
.spinning { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.backups__selector { max-width: 400px; margin-bottom: 1.5rem; }

.backups__section { margin-bottom: 2rem; }
.section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; gap: 0.75rem; }
.section-title { font-size: 1rem; font-weight: 600; color: var(--text-secondary); margin: 0; }

.backups__placeholder { display: flex; flex-direction: column; align-items: center; padding: 4rem 1rem; gap: 0.75rem; }
.backups__placeholder-text { color: var(--text-muted); font-size: 0.85rem; }

/* Config cards */
.config-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0.75rem; }

.config-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  padding: 1rem 1.15rem;
  transition: opacity 0.2s;
}
.config-card--disabled { opacity: 0.5; }

.config-card__header { display: flex; gap: 0.4rem; margin-bottom: 0.85rem; flex-wrap: wrap; }
.config-card__details { display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 0.85rem; }
.config-detail { display: flex; justify-content: space-between; align-items: center; }
.config-detail__label { font-size: 0.72rem; color: var(--text-muted); }
.config-detail__value { font-size: 0.78rem; color: var(--text-secondary); }
.config-detail__value.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; }

.config-card__footer { display: flex; align-items: center; justify-content: space-between; padding-top: 0.75rem; border-top: 1px solid var(--bg-elevated); }

/* History */
.history-list { display: flex; flex-direction: column; gap: 0.35rem; }

.history-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 12px;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.history-item:hover { border-color: var(--border-strong); }

.history-item__icon {
  width: 32px; height: 32px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.history-item__icon--completed { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
.history-item__icon--failed { background: rgba(239, 68, 68, 0.1); color: #f87171; }
.history-item__icon--in_progress, .history-item__icon--pending { background: rgba(var(--primary-rgb), 0.1); color: var(--primary-light); }

.history-item__info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.15rem; }
.history-item__top { display: flex; align-items: center; gap: 0.4rem; }
.history-item__type { font-size: 0.82rem; font-weight: 500; color: var(--text-secondary); }
.history-item__meta { font-size: 0.68rem; color: var(--text-faint); }
.history-item__error { font-size: 0.72rem; color: #f87171; margin-top: 0.2rem; white-space: pre-wrap; }
.history-item__actions { display: flex; align-items: center; gap: 0.4rem; flex-shrink: 0; }

/* Progress bar */
.progress-bar {
  position: relative; height: 6px; border-radius: 3px;
  background: var(--bg-elevated); margin-top: 0.3rem; overflow: hidden;
}
.progress-bar__fill {
  height: 100%; border-radius: 3px;
  background: linear-gradient(90deg, var(--primary-light), var(--primary-dark));
  transition: width 0.4s ease;
}
.progress-bar__label {
  position: absolute; right: 0; top: -14px;
  font-size: 0.58rem; font-family: 'JetBrains Mono', monospace; color: var(--text-faint);
}

.spinner-sm {
  width: 16px; height: 16px; border: 2px solid var(--spinner-track);
  border-top-color: var(--primary-light); border-radius: 50%; animation: spin 0.6s linear infinite;
}

/* Badges */
.badge {
  display: inline-block; font-size: 0.62rem; font-weight: 600;
  font-family: 'JetBrains Mono', monospace; padding: 0.2rem 0.5rem;
  border-radius: 6px; text-transform: uppercase; letter-spacing: 0.03em;
}
.badge--sm { font-size: 0.56rem; padding: 0.12rem 0.35rem; }
.badge--full { background: rgba(99, 102, 241, 0.1); color: #818cf8; }
.badge--files-only { background: rgba(var(--primary-rgb), 0.1); color: var(--primary-light); }
.badge--db-only { background: rgba(59, 130, 246, 0.1); color: #60a5fa; }
.badge--storage { background: rgba(139, 92, 246, 0.1); color: #a78bfa; }
.badge--engine { background: rgba(14, 165, 233, 0.12); color: #38bdf8; }
.badge--off { background: rgba(148, 163, 184, 0.1); color: #94a3b8; }
.badge--status-completed { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
.badge--status-failed { background: rgba(239, 68, 68, 0.1); color: #f87171; }
.badge--status-in_progress { background: rgba(var(--primary-rgb), 0.1); color: var(--primary-light); }
.badge--status-pending { background: rgba(148, 163, 184, 0.1); color: #94a3b8; }

.empty-card {
  display: flex; flex-direction: column; align-items: center; padding: 2.5rem 1rem;
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 14px; color: var(--text-muted); font-size: 0.82rem; gap: 0.5rem;
}

/* Shared form/modal/button styles */
.form-group { display: flex; flex-direction: column; gap: 0.3rem; }
.form-label { font-size: 0.75rem; font-weight: 500; color: var(--text-tertiary); }
.form-input {
  background: var(--bg-input); border: 1px solid var(--border-secondary);
  border-radius: 10px; padding: 0.55rem 0.8rem; font-size: 0.85rem;
  color: var(--text-primary); font-family: inherit; outline: none; transition: all 0.2s;
}
.form-input:focus { border-color: rgba(var(--primary-rgb), 0.25); box-shadow: var(--focus-ring); }
.form-input--select {
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23666' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 0.75rem center; padding-right: 2rem;
}
.form-input--textarea { resize: vertical; min-height: 60px; line-height: 1.5; }
.form-hint { font-size: 0.68rem; color: var(--text-faint); }
.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }

/* Cron presets */
.cron-presets { display: flex; gap: 0.3rem; margin-bottom: 0.3rem; flex-wrap: wrap; }
.cron-preset {
  padding: 0.3rem 0.6rem; border-radius: 6px; border: 1px solid var(--border-secondary);
  background: var(--bg-surface); color: var(--text-muted); font-size: 0.68rem; font-weight: 500;
  font-family: inherit; cursor: pointer; transition: all 0.2s;
}
.cron-preset:hover { border-color: var(--border-strong); color: var(--text-secondary); }
.cron-preset--active { border-color: rgba(var(--primary-rgb), 0.25); background: rgba(var(--primary-rgb), 0.05); color: var(--primary-text); }

/* Checkbox */
.checkbox-row { display: flex; align-items: center; gap: 0.5rem; cursor: pointer; }
.checkbox-input {
  width: 16px; height: 16px; accent-color: var(--primary-dark); cursor: pointer;
}
.checkbox-label { font-size: 0.82rem; color: var(--text-secondary); }

.radio-group { display: flex; gap: 0.4rem; }
.radio-option {
  flex: 1; display: flex; align-items: center; justify-content: center;
  padding: 0.5rem 0.6rem; border-radius: 8px; border: 1px solid var(--border-secondary);
  background: var(--bg-surface); cursor: pointer; transition: all 0.2s;
}
.radio-option__label { font-size: 0.72rem; font-weight: 600; font-family: 'JetBrains Mono', monospace; color: var(--text-muted); transition: color 0.2s; }
.radio-option:hover { border-color: var(--border-strong); }
.radio-option--active { border-color: rgba(var(--primary-rgb), 0.25); background: rgba(var(--primary-rgb), 0.05); }
.radio-option--active .radio-option__label { color: var(--primary-text); }

.btn {
  display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.55rem 1rem;
  border-radius: 10px; border: none; font-size: 0.82rem; font-weight: 600;
  font-family: inherit; cursor: pointer; transition: all 0.2s; white-space: nowrap;
}
.btn--sm { padding: 0.4rem 0.8rem; font-size: 0.75rem; border-radius: 8px; }
.btn--primary { background: linear-gradient(135deg, var(--primary-light), var(--primary-dark)); color: var(--primary-text-on); }
.btn--primary:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(var(--primary-rgb), 0.2); }
.btn--primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--ghost { background: var(--bg-input); border: 1px solid var(--border-strong); color: var(--text-tertiary); }
.btn--ghost:hover { color: var(--text-secondary); border-color: var(--border-strong); }
.btn--danger { background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.2); color: #f87171; }
.btn--danger:not(:disabled):hover { background: rgba(239, 68, 68, 0.18); }
.btn--danger:disabled { opacity: 0.4; cursor: not-allowed; }

.btn-icon {
  background: none; border: 1px solid var(--border-secondary); border-radius: 8px;
  padding: 0.35rem; cursor: pointer; display: flex; transition: all 0.2s;
}
.btn-icon:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-icon--danger { color: rgba(239, 68, 68, 0.35); }
.btn-icon--danger:hover { color: #f87171; border-color: rgba(239, 68, 68, 0.2); background: rgba(239, 68, 68, 0.05); }
.btn-icon__progress {
  font-size: 0.6rem; font-weight: 600; font-family: 'JetBrains Mono', monospace;
  color: var(--primary-text); min-width: 28px; text-align: center;
}

.modal-overlay {
  position: fixed; inset: 0; background: var(--bg-overlay); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center; z-index: 200; padding: 1rem;
}
.modal {
  background: var(--bg-modal-gradient);
  border: 1px solid var(--border-secondary); border-radius: 18px; padding: 1.5rem;
  width: 100%; max-width: 480px; box-shadow: var(--shadow-modal);
  animation: modalIn 0.25s ease; max-height: 90vh; overflow-y: auto;
  color: var(--text-primary);
}
.modal--wide { max-width: 620px; }
.modal__title { font-size: 1.05rem; font-weight: 700; color: var(--text-heading); margin: 0 0 1rem; }
.modal__desc { font-size: 0.82rem; color: var(--text-tertiary); margin: 0 0 1.25rem; line-height: 1.5; }
.modal__fields { display: flex; flex-direction: column; gap: 0.85rem; margin-bottom: 1rem; }
.modal__error { color: #f87171; font-size: 0.78rem; margin-bottom: 0.75rem; }
.modal__actions { display: flex; gap: 0.5rem; justify-content: flex-end; }

@keyframes modalIn { from { opacity: 0; transform: scale(0.96) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }

@media (max-width: 768px) {
  .config-grid { grid-template-columns: 1fr; }
  .backups__selector { max-width: none; }
  .backups__title { font-size: 1.25rem; }
  .backups__header { flex-direction: column; }
  .section-header { flex-direction: column; align-items: flex-start; gap: 0.5rem; }
  .history-item { flex-wrap: wrap; gap: 0.5rem; }
  .history-item__actions { width: 100%; justify-content: flex-end; }
}

/* ============================================================================
   Tabs & cards — единый стиль с /settings
   ============================================================================ */
.backups__tabs {
  display: flex;
  gap: 0.1rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 1rem;
}
.backups__tab {
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
.backups__tab:hover { color: var(--text-tertiary); }
.backups__tab--active {
  color: var(--primary-text);
  border-bottom-color: var(--primary);
}

/* Cards: унифицировано с /settings */
.settings-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  padding: 1.25rem;
  margin-bottom: 1rem;
}
.settings-card--list {
  padding: 0.75rem;
}

.settings-card__desc {
  font-size: 0.82rem;
  color: var(--text-muted);
  margin: 0 0 1rem;
  line-height: 1.5;
}

.section-title {
  display: inline-flex;
  align-items: center;
}

.cfg-panel__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 0.75rem;
}

.section-hint {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin: 0 0 1rem;
  line-height: 1.5;
}

.empty-card--flush {
  border: none;
  background: transparent;
}
.cfg-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 1rem;
}

.global-excludes {
  margin-top: 1.75rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border-secondary);
  display: flex; flex-direction: column; gap: 1.5rem;
}
.global-excludes__field { display: flex; flex-direction: column; gap: 0.4rem; width: 100%; }
.global-excludes__hint { margin: 0 0 0.4rem; line-height: 1.5; }
.global-excludes__hint code {
  background: var(--bg-body); padding: 0.05rem 0.3rem; border-radius: 4px;
  font-family: 'JetBrains Mono', monospace; font-size: 0.72rem;
}
.global-excludes__textarea {
  width: 100%; box-sizing: border-box;
  padding: 0.7rem 0.85rem;
  background: var(--bg-body);
  border: 1px solid var(--border-secondary);
  border-radius: 8px;
  color: var(--text-primary);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8rem; line-height: 1.55;
  resize: vertical;
  min-height: 100px;
  transition: border-color 0.15s, background 0.15s;
}
.global-excludes__textarea:focus {
  outline: none;
  border-color: var(--primary-border);
  background: var(--bg-surface);
}
.global-excludes__textarea::placeholder { color: var(--text-muted); opacity: 0.6; }

.settings-fields {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.inline-check {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  color: var(--text-primary);
  font-size: 0.9rem;
}
.inline-check input { accent-color: var(--primary-text, var(--primary)); }

.form-hint {
  color: var(--text-tertiary);
  font-size: 0.82rem;
  margin: 0.3rem 0 0;
  line-height: 1.4;
}
.form-hint code {
  background: var(--bg-code);
  padding: 0 0.3rem;
  border-radius: 4px;
  font-family: monospace;
}
.form-sublabel {
  display: block;
  font-size: 0.78rem;
  color: var(--text-tertiary);
  margin-bottom: 0.3rem;
}
.retention-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.75rem;
}

.cfg-badge {
  display: inline-block;
  padding: 0.08rem 0.5rem;
  border-radius: 999px;
  background: var(--primary-bg, rgba(var(--primary-rgb), 0.12));
  color: var(--primary-text, var(--primary));
  font-size: 0.72rem;
  font-weight: 500;
  margin-left: 0.4rem;
}
.cfg-badge--muted {
  background: var(--bg-input);
  color: var(--text-tertiary);
}
.cfg-badge--ok {
  background: var(--success-bg, rgba(34,197,94,0.12));
  color: var(--success, #22c55e);
}
.cfg-badge--err {
  background: rgba(239,68,68,0.12);
  color: #f87171;
}

/* Плановая проверка Restic */
.check-block {
  margin-top: 0.5rem;
  padding-top: 1rem;
  border-top: 1px dashed var(--border);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.check-block__fields {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding-left: 1.25rem;
  border-left: 2px solid var(--border-secondary);
}
.check-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 0.75rem;
}
.check-err-cell {
  max-width: 360px;
  font-size: 0.75rem;
  color: #f87171;
  white-space: pre-wrap;
  word-break: break-word;
}

.storage-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  margin-top: 0.5rem;
  background: var(--bg-input);
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--border);
}
.storage-table th, .storage-table td {
  padding: 0.7rem 0.9rem;
  text-align: left;
  border-bottom: 1px solid var(--border);
  font-size: 0.88rem;
  color: var(--text-primary);
}
.storage-table tbody tr:last-child td { border-bottom: none; }
.storage-table tbody tr:hover { background: var(--bg-surface); }
.storage-table th {
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  font-size: 0.7rem;
  letter-spacing: 0.06em;
  background: var(--bg-surface);
}

.actions-cell {
  white-space: nowrap;
  display: flex;
  gap: 0.75rem;
}
.link-btn {
  background: none;
  border: none;
  color: var(--primary-text, var(--primary));
  cursor: pointer;
  padding: 0;
  font-size: 0.85rem;
}
.link-btn:hover { text-decoration: underline; }
.link-btn--danger { color: var(--danger, #ef4444); }

.warning-box {
  background: var(--danger-bg, rgba(239,68,68,0.08));
  border: 1px solid var(--danger-border, rgba(239,68,68,0.3));
  border-radius: 8px;
  padding: 1rem;
  margin-top: 1rem;
  color: var(--text-primary);
  font-size: 0.9rem;
}
.warning-box__code {
  display: block;
  background: var(--bg-code);
  padding: 0.5rem;
  border-radius: 6px;
  margin: 0.5rem 0;
  font-family: monospace;
  word-break: break-all;
  user-select: all;
  color: var(--text-primary);
}
</style>
