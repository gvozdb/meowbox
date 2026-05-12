<template>
  <div class="backups">
    <div class="backups__header">
      <div>
        <h1 class="backups__title">Бэкапы</h1>
        <p class="backups__subtitle">Конфигурации, расписания и общая история резервных копий</p>
      </div>
      <div class="header-actions">
        <NuxtLink to="/backup-storages" class="backups__refresh" style="text-decoration:none;">🗄 Хранилища</NuxtLink>
        <NuxtLink to="/backup-checks" class="backups__refresh" style="text-decoration:none;">🔬 Проверки Restic</NuxtLink>
        <button class="backups__refresh" :disabled="loadingHistory" @click="refreshAll">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" :class="{ spinning: loadingHistory }"><polyline points="23,4 23,10 17,10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
          Обновить
        </button>
      </div>
    </div>

    <div class="backups__tabs">
      <button class="backups__tab" :class="{ 'backups__tab--active': tab === 'schedule' }" @click="tab = 'schedule'">Расписание</button>
      <button class="backups__tab" :class="{ 'backups__tab--active': tab === 'server' }" @click="tab = 'server'">Серверные пути</button>
      <button class="backups__tab" :class="{ 'backups__tab--active': tab === 'panel' }" @click="tab = 'panel'">Данные панели</button>
    </div>

    <!-- ===== Tab: Расписание (множественные шедули per-site бэкапов) ===== -->
    <div v-if="tab === 'schedule'" class="settings-card">
      <div class="cfg-panel__head">
        <p class="section-hint">
          Множественные шедули автоматических бэкапов <b>сайтов</b>. Каждый шедуль —
          отдельный пресет (своё расписание, движок, набор хранилищ, retention).
          Применяются ко всем сайтам, кроме тех, у кого свой per-site конфиг.
        </p>
        <button class="btn btn--primary btn--sm" @click="openScheduleDialog(null)">+ Создать конфиг</button>
      </div>

      <div v-if="loadingSchedules" class="empty-card empty-card--flush">Загрузка…</div>
      <div v-else-if="!schedules.length" class="empty-card empty-card--flush">
        <p>Шедулей нет. Создай хотя бы один — иначе автобэкапы сайтов не пойдут.</p>
      </div>

      <table v-else class="storage-table">
        <thead>
          <tr>
            <th>Имя</th>
            <th>Cron</th>
            <th>Движок</th>
            <th>Тип</th>
            <th>Хранилища</th>
            <th>Уведомления</th>
            <th>Статус</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in schedules" :key="c.id">
            <td><b>{{ c.name }}</b></td>
            <td><code class="mono">{{ c.schedule || '—' }}</code></td>
            <td><span class="cfg-badge">{{ c.engine }}</span></td>
            <td><small>{{ formatType(c.type) }}</small></td>
            <td>{{ c.storageLocationIds.length }} шт.</td>
            <td>
              <span class="cfg-badge">{{ notificationModeLabel(c.notificationMode) }}</span>
              <small v-if="c.notificationMode === 'DIGEST' && c.digestSchedule" class="muted-text mono">
                {{ c.digestSchedule }}
              </small>
            </td>
            <td>
              <span :class="['cfg-badge', c.enabled ? 'cfg-badge--ok' : 'cfg-badge--muted']">{{ c.enabled ? 'enabled' : 'disabled' }}</span>
            </td>
            <td class="actions-cell">
              <button class="link-btn" :disabled="runningSchedule[c.id]" @click="runSchedule(c)">{{ runningSchedule[c.id] ? '…' : 'Запустить' }}</button>
              <button class="link-btn" @click="openScheduleDialog(c)">Изменить</button>
              <button class="link-btn link-btn--danger" @click="deleteSchedule(c)">Удалить</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ===== Tab: Серверные пути ===== -->
    <div v-if="tab === 'server'" class="settings-card">
      <div class="cfg-panel__head">
        <p class="section-hint">
          Бэкапы произвольных серверных директорий (<code>/etc</code>, <code>/opt</code>, <code>/root</code>, …).
          Каждый путь — отдельный конфиг со своим расписанием.
        </p>
        <button class="btn btn--primary btn--sm" @click="openServerDialog(null)">+ Создать конфиг</button>
      </div>

      <div v-if="loadingServer" class="empty-card empty-card--flush">Загрузка…</div>
      <div v-else-if="!serverConfigs.length" class="empty-card empty-card--flush">
        <p>Конфигов нет. Создай первый, чтобы бэкапить системные директории.</p>
      </div>

      <table v-else class="storage-table">
        <thead>
          <tr>
            <th>Имя</th>
            <th>Путь</th>
            <th>Cron</th>
            <th>Движок</th>
            <th>Хранилища</th>
            <th>Статус</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in serverConfigs" :key="c.id">
            <td><b>{{ c.name }}</b></td>
            <td><code class="mono">{{ c.path }}</code></td>
            <td><code class="mono">{{ c.schedule || '—' }}</code></td>
            <td><span class="cfg-badge">{{ c.engine }}</span></td>
            <td>{{ c.storageLocationIds.length }} шт.</td>
            <td>
              <span :class="['cfg-badge', c.enabled ? 'cfg-badge--ok' : 'cfg-badge--muted']">{{ c.enabled ? 'enabled' : 'disabled' }}</span>
            </td>
            <td class="actions-cell">
              <button class="link-btn" :disabled="runningServer[c.id]" @click="runServer(c)">{{ runningServer[c.id] ? '…' : 'Запустить' }}</button>
              <button class="link-btn" @click="openServerDialog(c)">Изменить</button>
              <button class="link-btn link-btn--danger" @click="deleteServer(c)">Удалить</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ===== Tab: Данные панели ===== -->
    <div v-if="tab === 'panel'" class="settings-card">
      <div class="cfg-panel__head">
        <p class="section-hint">
          Бэкап БД (через VACUUM INTO), master-key, .env, vpn state, <code>/etc/letsencrypt</code>.
          Пути зашиты в коде — защита от ошибки «забыл .master-key».
        </p>
        <button class="btn btn--primary btn--sm" @click="openPanelDialog(null)">+ Создать конфиг</button>
      </div>

      <details class="info-box">
        <summary><b>Что попадёт в бэкап</b> (preset, нельзя менять)</summary>
        <ul>
          <li><code class="mono">state/data/meowbox.db</code> — снапшот БД (VACUUM INTO)</li>
          <li><code class="mono">state/data/.master-key</code> + legacy <code class="mono">.vpn-key</code>, <code class="mono">.dns-key</code></li>
          <li><code class="mono">state/.env</code></li>
          <li><code class="mono">state/data/servers.json</code></li>
          <li><code class="mono">state/vpn/</code> — Xray runtime configs</li>
          <li><code class="mono">/etc/letsencrypt/</code></li>
        </ul>
        <p class="form-hint">
          Восстановление — только через CLI <code class="mono">tools/restore-panel-data.sh</code>
          (UI кнопки нет, нельзя рестарт через UI который сам себя останавливает).
        </p>
      </details>

      <div v-if="loadingPanel" class="empty-card empty-card--flush">Загрузка…</div>
      <div v-else-if="!panelConfigs.length" class="empty-card empty-card--flush">
        <p>Конфигов нет. Создай как минимум один — бэкап данных панели критически важен.</p>
      </div>

      <table v-else class="storage-table">
        <thead>
          <tr>
            <th>Имя</th>
            <th>Cron</th>
            <th>Движок</th>
            <th>Хранилища</th>
            <th>Retention</th>
            <th>Статус</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in panelConfigs" :key="c.id">
            <td><b>{{ c.name }}</b></td>
            <td><code class="mono">{{ c.schedule || '—' }}</code></td>
            <td><span class="cfg-badge">{{ c.engine }}</span></td>
            <td>{{ c.storageLocationIds.length }} шт.</td>
            <td><small>{{ c.keepDaily }}d / {{ c.keepWeekly }}w / {{ c.keepMonthly }}m / {{ c.keepYearly }}y</small></td>
            <td>
              <span :class="['cfg-badge', c.enabled ? 'cfg-badge--ok' : 'cfg-badge--muted']">{{ c.enabled ? 'enabled' : 'disabled' }}</span>
            </td>
            <td class="actions-cell">
              <button class="link-btn" :disabled="runningPanel[c.id]" @click="runPanel(c)">{{ runningPanel[c.id] ? '…' : 'Запустить' }}</button>
              <button class="link-btn" @click="openPanelDialog(c)">Изменить</button>
              <button class="link-btn link-btn--danger" @click="deletePanel(c)">Удалить</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ===== Global History ===== -->
    <div class="backups__section">
      <div class="section-header">
        <h2 class="section-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:0.4rem;vertical-align:-2px;">
            <path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l4 2" />
          </svg>
          История бэкапов
        </h2>
      </div>

      <div class="settings-card settings-card--list">
        <div v-if="loadingHistory && !history.length" class="empty-card empty-card--flush">Загрузка…</div>
        <div v-else-if="!history.length" class="empty-card empty-card--flush">
          <CatMascot :size="56" mood="sleepy" />
          <p>Бэкапов ещё нет</p>
        </div>
        <div v-else class="history-list">
          <div v-for="b in history" :key="b.kind + ':' + b.id" class="history-item">
            <div class="history-item__icon" :class="`history-item__icon--${b.status?.toLowerCase()}`">
              <svg v-if="b.status === 'COMPLETED'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20,6 9,17 4,12" /></svg>
              <svg v-else-if="b.status === 'FAILED'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              <div v-else-if="b.status === 'IN_PROGRESS'" class="spinner-sm" />
              <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" /><polyline points="12,6 12,12 16,14" /></svg>
            </div>
            <div class="history-item__info">
              <div class="history-item__top">
                <span class="history-item__type">{{ b.sourceName }}</span>
                <span class="badge" :class="kindClass(b.kind)">{{ kindLabel(b.kind) }}</span>
                <span v-if="b.engine" class="badge badge--engine">{{ b.engine === 'RESTIC' ? 'Restic' : 'TAR' }}</span>
                <span v-if="b.storageLocation" class="badge badge--storage badge--sm">{{ b.storageLocation.name }}</span>
                <span v-if="b.kind === 'SITE'" class="badge badge--full badge--sm">{{ formatType(b.type) }}</span>
              </div>
              <span class="history-item__meta">
                <span v-if="b.sourceSubtitle">{{ b.sourceSubtitle }} · </span>
                {{ formatDate(b.createdAt) }} · {{ formatSize(b.sizeBytes) }}
              </span>
              <div v-if="b.status === 'IN_PROGRESS' || b.status === 'PENDING'" class="progress-bar">
                <div class="progress-bar__fill" :style="{ width: `${liveProgress[b.id] ?? b.progress ?? 0}%` }" />
                <span class="progress-bar__label">{{ liveProgress[b.id] ?? b.progress ?? 0 }}%</span>
              </div>
              <span v-if="b.status === 'FAILED' && b.errorMessage" class="history-item__error">{{ b.errorMessage }}</span>
            </div>
            <span class="badge" :class="`badge--status-${b.status?.toLowerCase()}`">{{ formatStatus(b.status) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== Modal: server path config ===== -->
    <Teleport to="body">
      <div v-if="serverDialog.open" class="modal-overlay" @mousedown.self="serverDialog.open = false">
        <div class="modal modal--wide">
          <h3 class="modal__title">{{ serverDialog.editId ? 'Редактировать конфиг (серверный путь)' : 'Новый конфиг (серверный путь)' }}</h3>
          <div class="modal__fields">
            <div class="form-group">
              <label class="form-label">Имя</label>
              <input v-model="serverDialog.form.name" class="form-input" placeholder="etc daily" maxlength="120" />
            </div>
            <div v-if="!serverDialog.editId" class="form-group">
              <label class="form-label">Путь</label>
              <input v-model="serverDialog.form.path" class="form-input mono" placeholder="/etc" maxlength="4096" @input="checkServerWarnings" />
            </div>
            <div v-if="serverWarnings.length" class="warning-box">
              <p><b>⚠ Предупреждения:</b></p>
              <ul>
                <li v-for="(w, i) in serverWarnings" :key="i">{{ w.message }}</li>
              </ul>
              <label class="inline-check">
                <input v-model="serverDialog.form.warningAcknowledged" type="checkbox" />
                Я понимаю риски и всё равно хочу бэкапить
              </label>
            </div>
            <div class="form-group">
              <label class="form-label">Движок</label>
              <select v-model="serverDialog.form.engine" class="form-input form-input--select">
                <option value="RESTIC">Restic (дедупликация)</option>
                <option value="TAR">TAR (.tar.gz)</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Хранилища</label>
              <label v-for="s in storages" :key="s.id" class="inline-check">
                <input type="checkbox" :value="s.id"
                  :checked="serverDialog.form.storageLocationIds.includes(s.id)"
                  @change="toggleServerStorage(s.id)" />
                {{ s.name }} <span class="cfg-badge">{{ s.type }}</span>
              </label>
            </div>
            <div class="form-group">
              <label class="form-label">Cron (опц.)</label>
              <input v-model="serverDialog.form.schedule" class="form-input mono" placeholder="0 3 * * *" />
            </div>
            <div class="form-group">
              <label class="form-label">Retention (Restic)</label>
              <div class="retention-grid retention-grid--4">
                <div><label class="form-sublabel">По одному за день</label>
                  <input v-model.number="serverDialog.form.keepDaily" type="number" min="0" max="365" class="form-input" /></div>
                <div><label class="form-sublabel">По одному за неделю</label>
                  <input v-model.number="serverDialog.form.keepWeekly" type="number" min="0" max="52" class="form-input" /></div>
                <div><label class="form-sublabel">По одному за месяц</label>
                  <input v-model.number="serverDialog.form.keepMonthly" type="number" min="0" max="60" class="form-input" /></div>
                <div><label class="form-sublabel">По одному за год</label>
                  <input v-model.number="serverDialog.form.keepYearly" type="number" min="0" max="20" class="form-input" /></div>
              </div>
              <p class="form-hint">
                Пример: 7 / 4 / 6 / 1 — последние 7 дней ежедневно, 4 воскресенья,
                6 последних 1-х чисел месяца, 1 последний снапшот года.
                Остальное чистится автоматически (<code>restic forget --prune</code>).
              </p>
            </div>
            <div class="form-group">
              <label class="form-label">Режим уведомлений</label>
              <select v-model="serverDialog.form.notificationMode" class="form-input form-input--select">
                <option value="INSTANT">Мгновенно — каждое событие</option>
                <option value="DIGEST">Дайджест — копить и слать по cron</option>
                <option value="FAILURES_ONLY">Только при ошибке</option>
              </select>
              <p class="form-hint">
                Для частых бэкапов выбери дайджест — события накопятся и придут сводным сообщением.
              </p>
            </div>
            <div v-if="serverDialog.form.notificationMode === 'DIGEST'" class="form-group">
              <label class="form-label">Cron дайджеста</label>
              <input v-model="serverDialog.form.digestSchedule" class="form-input mono" placeholder="0 9 * * *" />
              <p class="form-hint">Когда отправить накопленные события. Пример: <code>0 9 * * *</code> — ежедневно в 9:00.</p>
            </div>
            <label class="inline-check">
              <input type="checkbox" v-model="serverDialog.form.enabled" />
              Включён
            </label>
          </div>
          <div class="modal__actions">
            <button class="btn btn--ghost" @click="serverDialog.open = false">Отмена</button>
            <button class="btn btn--primary" :disabled="serverDialog.saving" @click="saveServer">
              {{ serverDialog.saving ? 'Сохранение…' : (serverDialog.editId ? 'Сохранить' : 'Создать') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ===== Modal: panel data config ===== -->
    <Teleport to="body">
      <div v-if="panelDialog.open" class="modal-overlay" @mousedown.self="panelDialog.open = false">
        <div class="modal modal--wide">
          <h3 class="modal__title">{{ panelDialog.editId ? 'Редактировать конфиг (данные панели)' : 'Новый конфиг (данные панели)' }}</h3>
          <div class="modal__fields">
            <div class="form-group">
              <label class="form-label">Имя</label>
              <input v-model="panelDialog.form.name" class="form-input" placeholder="panel-hourly" maxlength="120" />
            </div>
            <div class="form-group">
              <label class="form-label">Движок</label>
              <select v-model="panelDialog.form.engine" class="form-input form-input--select">
                <option value="RESTIC">Restic (рекомендуется — дедупликация частых снапов)</option>
                <option value="TAR">TAR (.tar.gz)</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Хранилища</label>
              <label v-for="s in storages" :key="s.id" class="inline-check">
                <input type="checkbox" :value="s.id"
                  :checked="panelDialog.form.storageLocationIds.includes(s.id)"
                  @change="togglePanelStorage(s.id)" />
                {{ s.name }} <span class="cfg-badge">{{ s.type }}</span>
              </label>
            </div>
            <div class="form-group">
              <label class="form-label">Cron (опц.)</label>
              <input v-model="panelDialog.form.schedule" class="form-input mono" placeholder="0 * * * *" />
            </div>
            <div class="form-group">
              <label class="form-label">Retention (Restic)</label>
              <div class="retention-grid retention-grid--4">
                <div><label class="form-sublabel">По одному за день</label>
                  <input v-model.number="panelDialog.form.keepDaily" type="number" min="0" max="365" class="form-input" /></div>
                <div><label class="form-sublabel">По одному за неделю</label>
                  <input v-model.number="panelDialog.form.keepWeekly" type="number" min="0" max="52" class="form-input" /></div>
                <div><label class="form-sublabel">По одному за месяц</label>
                  <input v-model.number="panelDialog.form.keepMonthly" type="number" min="0" max="60" class="form-input" /></div>
                <div><label class="form-sublabel">По одному за год</label>
                  <input v-model.number="panelDialog.form.keepYearly" type="number" min="0" max="20" class="form-input" /></div>
              </div>
              <p class="form-hint">
                Пример: 7 / 4 / 6 / 1 — последние 7 дней ежедневно, 4 воскресенья,
                6 последних 1-х чисел месяца, 1 последний снапшот года.
                Остальное чистится автоматически (<code>restic forget --prune</code>).
              </p>
            </div>
            <div class="form-group">
              <label class="form-label">Режим уведомлений</label>
              <select v-model="panelDialog.form.notificationMode" class="form-input form-input--select">
                <option value="INSTANT">Мгновенно — каждое событие</option>
                <option value="DIGEST">Дайджест — копить и слать по cron</option>
                <option value="FAILURES_ONLY">Только при ошибке</option>
              </select>
              <p class="form-hint">
                Для частых бэкапов выбери дайджест — события накопятся и придут сводным сообщением.
              </p>
            </div>
            <div v-if="panelDialog.form.notificationMode === 'DIGEST'" class="form-group">
              <label class="form-label">Cron дайджеста</label>
              <input v-model="panelDialog.form.digestSchedule" class="form-input mono" placeholder="0 9 * * *" />
              <p class="form-hint">Когда отправить накопленные события. Пример: <code>0 9 * * *</code> — ежедневно в 9:00.</p>
            </div>
            <label class="inline-check">
              <input type="checkbox" v-model="panelDialog.form.enabled" />
              Включён
            </label>
          </div>
          <div class="modal__actions">
            <button class="btn btn--ghost" @click="panelDialog.open = false">Отмена</button>
            <button class="btn btn--primary" :disabled="panelDialog.saving" @click="savePanel">
              {{ panelDialog.saving ? 'Сохранение…' : (panelDialog.editId ? 'Сохранить' : 'Создать') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ===== Modal: site backup schedule (вкладка «Расписание») ===== -->
    <Teleport to="body">
      <div v-if="scheduleDialog.open" class="modal-overlay" @mousedown.self="scheduleDialog.open = false">
        <div class="modal modal--wide">
          <h3 class="modal__title">{{ scheduleDialog.editId ? 'Редактировать шедуль' : 'Новый шедуль' }}</h3>
          <div class="modal__fields">
            <div class="form-group">
              <label class="form-label">Имя</label>
              <input v-model="scheduleDialog.form.name" class="form-input" placeholder="hourly DB to local" maxlength="120" />
            </div>
            <div class="form-group">
              <label class="form-label">Движок</label>
              <select v-model="scheduleDialog.form.engine" class="form-input form-input--select">
                <option value="RESTIC">Restic (дедупликация)</option>
                <option value="TAR">TAR (.tar.gz)</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Что бэкапим</label>
              <select v-model="scheduleDialog.form.type" class="form-input form-input--select">
                <option value="FULL">Полный (файлы + БД)</option>
                <option value="FILES_ONLY">Только файлы</option>
                <option value="DB_ONLY">Только БД</option>
                <option v-if="scheduleDialog.form.engine === 'TAR'" value="DIFFERENTIAL">Дифференциальный</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Хранилища</label>
              <div v-if="storages.length === 0" class="form-hint">
                Нет ни одного хранилища. Создай на странице <NuxtLink to="/backup-storages">Хранилища</NuxtLink>.
              </div>
              <label v-for="s in storages" :key="s.id" class="inline-check">
                <input type="checkbox" :value="s.id"
                  :checked="scheduleDialog.form.storageLocationIds.includes(s.id)"
                  :disabled="scheduleDialog.form.engine === 'RESTIC' && !s.resticEnabled"
                  @change="toggleScheduleStorage(s.id)" />
                {{ s.name }} <span class="cfg-badge">{{ s.type }}</span>
                <span v-if="!s.resticEnabled" class="cfg-badge cfg-badge--muted">Restic не поддерживается</span>
              </label>
            </div>
            <div class="form-group">
              <label class="form-label">Cron</label>
              <input v-model="scheduleDialog.form.schedule" class="form-input mono" placeholder="0 3 * * *" />
              <p class="form-hint">Пример: <code>0 3 * * *</code> — ежедневно в 3:00, <code>0 * * * *</code> — каждый час.</p>
            </div>
            <div v-if="scheduleDialog.form.engine === 'RESTIC'" class="form-group">
              <label class="form-label">Retention (Restic)</label>
              <div class="retention-grid retention-grid--4">
                <div><label class="form-sublabel">По одному за день</label>
                  <input v-model.number="scheduleDialog.form.keepDaily" type="number" min="0" max="365" class="form-input" /></div>
                <div><label class="form-sublabel">По одному за неделю</label>
                  <input v-model.number="scheduleDialog.form.keepWeekly" type="number" min="0" max="52" class="form-input" /></div>
                <div><label class="form-sublabel">По одному за месяц</label>
                  <input v-model.number="scheduleDialog.form.keepMonthly" type="number" min="0" max="24" class="form-input" /></div>
                <div><label class="form-sublabel">По одному за год</label>
                  <input v-model.number="scheduleDialog.form.keepYearly" type="number" min="0" max="20" class="form-input" /></div>
              </div>
            </div>
            <div v-else class="form-group">
              <label class="form-label">Срок хранения (TAR), бэкапов</label>
              <input v-model.number="scheduleDialog.form.retentionDays" type="number" min="1" max="365" class="form-input" />
            </div>

            <div class="form-group">
              <label class="form-label">Глобальные исключения путей</label>
              <p class="form-hint">Если у сайта <b>не задано</b> своих excludes — применяются эти. Один путь на строке.</p>
              <textarea v-model="scheduleExcludesText" class="form-input" rows="4" spellcheck="false"
                placeholder="www/wp-content/cache&#10;tmp&#10;*.log" />
            </div>
            <div class="form-group">
              <label class="form-label">Глобальные исключения таблиц БД</label>
              <p class="form-hint">Список таблиц по одной на строке. CREATE TABLE попадёт, INSERT — нет.</p>
              <textarea v-model="scheduleExcludeTablesText" class="form-input" rows="3" spellcheck="false"
                placeholder="modx_session&#10;wp_options" />
            </div>

            <div class="check-block">
              <label class="inline-check">
                <input type="checkbox" v-model="scheduleDialog.form.checkEnabled" />
                Плановая проверка целостности Restic-реп
              </label>
              <div v-if="scheduleDialog.form.checkEnabled" class="check-block__fields">
                <div class="form-group">
                  <label class="form-label">Cron проверки</label>
                  <input v-model="scheduleDialog.form.checkSchedule" class="form-input mono" placeholder="0 4 * * 0" />
                </div>
                <div class="form-group">
                  <label class="inline-check">
                    <input type="checkbox" v-model="scheduleDialog.form.checkReadData" />
                    Читать данные (--read-data-subset)
                  </label>
                </div>
                <div v-if="scheduleDialog.form.checkReadData" class="form-group">
                  <label class="form-label">Subset</label>
                  <input v-model="scheduleDialog.form.checkReadDataSubset" class="form-input mono" placeholder="10%" />
                </div>
                <div class="form-group">
                  <label class="form-label">Минимальный интервал, часов</label>
                  <input v-model.number="scheduleDialog.form.checkMinIntervalHours" type="number" min="0" max="720" class="form-input" />
                </div>
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Режим уведомлений</label>
              <select v-model="scheduleDialog.form.notificationMode" class="form-input form-input--select">
                <option value="INSTANT">Мгновенно — каждое событие</option>
                <option value="DIGEST">Дайджест — копить и слать по cron</option>
                <option value="FAILURES_ONLY">Только при ошибке</option>
              </select>
              <p class="form-hint">
                Для частых бэкапов (например, ежечасных) выбери дайджест — события накопятся и придут одним сообщением.
              </p>
            </div>
            <div v-if="scheduleDialog.form.notificationMode === 'DIGEST'" class="form-group">
              <label class="form-label">Cron дайджеста</label>
              <input v-model="scheduleDialog.form.digestSchedule" class="form-input mono" placeholder="0 9 * * *" />
              <p class="form-hint">Когда отправить накопленные события. Пример: <code>0 9 * * *</code> — ежедневно в 9:00.</p>
            </div>

            <label class="inline-check">
              <input type="checkbox" v-model="scheduleDialog.form.enabled" />
              Включён
            </label>
          </div>
          <div class="modal__actions">
            <button class="btn btn--ghost" @click="scheduleDialog.open = false">Отмена</button>
            <button class="btn btn--primary" :disabled="scheduleDialog.saving" @click="saveSchedule">
              {{ scheduleDialog.saving ? 'Сохранение…' : (scheduleDialog.editId ? 'Сохранить' : 'Создать') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface StorageLoc { id: string; name: string; type: string; resticEnabled: boolean }

interface UnifiedRow {
  id: string;
  kind: 'SITE' | 'SERVER_PATH' | 'PANEL_DATA';
  type: string;
  status: string;
  engine: string;
  sourceName: string;
  sourceSubtitle: string;
  sourceId: string | null;
  sizeBytes: number | null;
  progress: number;
  errorMessage: string | null;
  resticSnapshotId: string | null;
  storageLocation: { id: string; name: string; type: string } | null;
  createdAt: string;
}

type NotificationMode = 'INSTANT' | 'DIGEST' | 'FAILURES_ONLY';

interface ServerPathConfig {
  id: string;
  name: string;
  path: string;
  engine: 'RESTIC' | 'TAR';
  storageLocationIds: string[];
  schedule: string | null;
  keepDaily: number; keepWeekly: number; keepMonthly: number; keepYearly: number;
  enabled: boolean;
  warningAcknowledged: boolean;
  notificationMode: NotificationMode;
  digestSchedule: string | null;
}

interface PanelDataConfig {
  id: string;
  name: string;
  engine: 'RESTIC' | 'TAR';
  storageLocationIds: string[];
  schedule: string | null;
  keepDaily: number; keepWeekly: number; keepMonthly: number; keepYearly: number;
  enabled: boolean;
  notificationMode: NotificationMode;
  digestSchedule: string | null;
}

interface SiteBackupSchedule {
  id: string;
  name: string;
  enabled: boolean;
  type: 'FULL' | 'FILES_ONLY' | 'DB_ONLY' | 'DIFFERENTIAL';
  engine: 'RESTIC' | 'TAR';
  storageLocationIds: string[];
  schedule: string | null;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
  keepYearly: number;
  retentionDays: number;
  excludePaths: string[];
  excludeTableData: string[];
  checkEnabled: boolean;
  checkSchedule: string | null;
  checkReadData: boolean;
  checkReadDataSubset: string | null;
  checkMinIntervalHours: number;
  notificationMode: NotificationMode;
  digestSchedule: string | null;
}

const api = useApi();
const toast = useMbToast();
const { onBackupProgress } = useSocket();

const tab = useTabQuery(['schedule', 'server', 'panel'], 'schedule') as Ref<'schedule' | 'server' | 'panel'>;

const storages = ref<StorageLoc[]>([]);
const history = ref<UnifiedRow[]>([]);
const loadingHistory = ref(false);
const liveProgress = reactive<Record<string, number>>({});

const serverConfigs = ref<ServerPathConfig[]>([]);
const loadingServer = ref(false);
const runningServer = ref<Record<string, boolean>>({});

const panelConfigs = ref<PanelDataConfig[]>([]);
const loadingPanel = ref(false);
const runningPanel = ref<Record<string, boolean>>({});

const schedules = ref<SiteBackupSchedule[]>([]);
const loadingSchedules = ref(false);
const runningSchedule = ref<Record<string, boolean>>({});

function notificationModeLabel(m: string | null | undefined) {
  return ({ INSTANT: 'Мгновенно', DIGEST: 'Дайджест', FAILURES_ONLY: 'Только ошибки' } as Record<string, string>)[m || ''] || (m || '—');
}

// -------- helpers --------
function kindLabel(k: string) {
  return ({ SITE: 'Сайт', SERVER_PATH: 'Серверный путь', PANEL_DATA: 'Данные панели' } as Record<string, string>)[k] || k;
}
function kindClass(k: string) {
  return ({ SITE: 'badge--full', SERVER_PATH: 'badge--files-only', PANEL_DATA: 'badge--db-only' } as Record<string, string>)[k] || '';
}
function formatType(t: string) {
  return ({ FULL: 'Полный', FILES_ONLY: 'Файлы', DB_ONLY: 'Только БД', DIFFERENTIAL: 'Дифф.' } as Record<string, string>)[t] || t;
}
function formatStatus(s?: string) {
  return ({ COMPLETED: 'Готово', FAILED: 'Ошибка', IN_PROGRESS: 'Выполняется', PENDING: 'В очереди' } as Record<string, string>)[s || ''] || s || '';
}
function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function formatSize(bytes?: number | bigint | null) {
  if (!bytes) return '—';
  const n = Number(bytes);
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
function parseLines(text: string): string[] {
  return (text || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')).slice(0, 200);
}

// -------- loaders --------
async function loadStorages() {
  try {
    const res = await api.get<{ data: StorageLoc[] } | StorageLoc[]>('/storage-locations');
    const list = Array.isArray(res) ? res : (res as { data?: StorageLoc[] }).data;
    storages.value = Array.isArray(list) ? list : [];
  } catch { storages.value = []; }
}

async function loadHistory() {
  loadingHistory.value = true;
  try {
    const res = await api.get<{ data: UnifiedRow[] } | UnifiedRow[]>('/backups/history?perPage=80');
    const list = Array.isArray(res) ? res : (res as { data?: UnifiedRow[] }).data;
    history.value = Array.isArray(list) ? list : [];
  } catch (e) {
    toast.error((e as Error).message || 'Не удалось загрузить историю');
    history.value = [];
  } finally {
    loadingHistory.value = false;
  }
}

async function loadServer() {
  loadingServer.value = true;
  try {
    const res = await api.get<{ data: ServerPathConfig[] }>('/backups/server-paths');
    serverConfigs.value = (res as unknown as { data: ServerPathConfig[] }).data || (res as unknown as ServerPathConfig[]) || [];
  } catch { serverConfigs.value = []; }
  finally { loadingServer.value = false; }
}

async function loadPanel() {
  loadingPanel.value = true;
  try {
    const res = await api.get<{ data: PanelDataConfig[] }>('/backups/panel-data');
    panelConfigs.value = (res as unknown as { data: PanelDataConfig[] }).data || (res as unknown as PanelDataConfig[]) || [];
  } catch { panelConfigs.value = []; }
  finally { loadingPanel.value = false; }
}

async function loadSchedules() {
  loadingSchedules.value = true;
  try {
    const res = await api.get<{ data: SiteBackupSchedule[] }>('/backups/site-schedules');
    schedules.value = (res as unknown as { data: SiteBackupSchedule[] }).data || (res as unknown as SiteBackupSchedule[]) || [];
  } catch { schedules.value = []; }
  finally { loadingSchedules.value = false; }
}

async function refreshAll() {
  await Promise.all([loadStorages(), loadHistory(), loadServer(), loadPanel(), loadSchedules()]);
}

// -------- server-paths CRUD --------
const serverDialog = reactive({
  open: false,
  editId: null as string | null,
  saving: false,
  form: {
    name: '', path: '', engine: 'RESTIC' as 'RESTIC' | 'TAR',
    storageLocationIds: [] as string[],
    schedule: '',
    keepDaily: 7, keepWeekly: 4, keepMonthly: 6, keepYearly: 1,
    enabled: true,
    warningAcknowledged: false,
    notificationMode: 'INSTANT' as NotificationMode,
    digestSchedule: '',
  },
});
const serverWarnings = ref<{ code: string; message: string }[]>([]);

function checkServerWarnings() {
  const p = (serverDialog.form.path || '').replace(/\/+$/, '') || '/';
  const w: { code: string; message: string }[] = [];
  if (/^\/$/.test(p)) w.push({ code: 'ROOT', message: 'Корень ФС — включит /proc, /sys, /dev и сам бэкап.' });
  if (/^\/proc(\/|$)/.test(p)) w.push({ code: 'PSEUDO', message: '/proc — pseudo-fs, бэкап бессмыслен.' });
  if (/^\/sys(\/|$)/.test(p)) w.push({ code: 'PSEUDO', message: '/sys — pseudo-fs, бэкап бессмыслен.' });
  if (/^\/dev(\/|$)/.test(p)) w.push({ code: 'PSEUDO', message: '/dev — устройства, бэкап опасен.' });
  if (/^\/var\/log(\/|$)/.test(p)) w.push({ code: 'LOG', message: '/var/log — логи, обычно не нужно.' });
  if (/^\/var\/lib\/(mysql|postgresql)(\/|$)/.test(p)) w.push({ code: 'DB_RAW', message: 'Сырые файлы БД — inconsistent state на ходу. Используй per-site backup.' });
  serverWarnings.value = w;
}

function openServerDialog(c: ServerPathConfig | null) {
  if (c) {
    serverDialog.editId = c.id;
    serverDialog.form = {
      name: c.name, path: c.path, engine: c.engine,
      storageLocationIds: [...c.storageLocationIds],
      schedule: c.schedule || '',
      keepDaily: c.keepDaily, keepWeekly: c.keepWeekly,
      keepMonthly: c.keepMonthly, keepYearly: c.keepYearly,
      enabled: c.enabled, warningAcknowledged: c.warningAcknowledged,
      notificationMode: (c.notificationMode || 'INSTANT') as NotificationMode,
      digestSchedule: c.digestSchedule || '',
    };
  } else {
    serverDialog.editId = null;
    serverDialog.form = {
      name: '', path: '', engine: 'RESTIC', storageLocationIds: [],
      schedule: '', keepDaily: 7, keepWeekly: 4, keepMonthly: 6, keepYearly: 1,
      enabled: true, warningAcknowledged: false,
      notificationMode: 'INSTANT', digestSchedule: '',
    };
  }
  serverWarnings.value = [];
  serverDialog.open = true;
}

function toggleServerStorage(id: string) {
  const i = serverDialog.form.storageLocationIds.indexOf(id);
  if (i >= 0) serverDialog.form.storageLocationIds.splice(i, 1);
  else serverDialog.form.storageLocationIds.push(id);
}

async function saveServer() {
  serverDialog.saving = true;
  try {
    const notifFields = {
      notificationMode: serverDialog.form.notificationMode,
      digestSchedule: serverDialog.form.notificationMode === 'DIGEST'
        ? (serverDialog.form.digestSchedule || undefined)
        : null,
    };
    if (serverDialog.editId) {
      await api.patch(`/backups/server-paths/${serverDialog.editId}`, {
        name: serverDialog.form.name,
        storageLocationIds: serverDialog.form.storageLocationIds,
        schedule: serverDialog.form.schedule || null,
        keepDaily: serverDialog.form.keepDaily,
        keepWeekly: serverDialog.form.keepWeekly,
        keepMonthly: serverDialog.form.keepMonthly,
        keepYearly: serverDialog.form.keepYearly,
        enabled: serverDialog.form.enabled,
        ...notifFields,
      });
    } else {
      await api.post('/backups/server-paths', {
        name: serverDialog.form.name,
        path: serverDialog.form.path,
        engine: serverDialog.form.engine,
        storageLocationIds: serverDialog.form.storageLocationIds,
        schedule: serverDialog.form.schedule || undefined,
        keepDaily: serverDialog.form.keepDaily,
        keepWeekly: serverDialog.form.keepWeekly,
        keepMonthly: serverDialog.form.keepMonthly,
        keepYearly: serverDialog.form.keepYearly,
        enabled: serverDialog.form.enabled,
        warningAcknowledged: serverDialog.form.warningAcknowledged,
        ...notifFields,
      });
    }
    toast.success('Сохранено');
    serverDialog.open = false;
    await loadServer();
  } catch (e: unknown) {
    const msg = (e as { data?: { error?: { message?: string } } })?.data?.error?.message || (e as Error).message;
    toast.error(msg);
  } finally {
    serverDialog.saving = false;
  }
}

async function runServer(c: ServerPathConfig) {
  runningServer.value[c.id] = true;
  try {
    await api.post(`/backups/server-paths/${c.id}/run`);
    toast.success(`Бэкап "${c.name}" запущен`);
    setTimeout(loadHistory, 1500);
  } catch (e: unknown) {
    toast.error((e as Error).message || 'Ошибка запуска');
  } finally {
    runningServer.value[c.id] = false;
  }
}

async function deleteServer(c: ServerPathConfig) {
  const ok = await useMbConfirm().ask({
    title: 'Удаление конфига',
    message: `Удалить "${c.name}"? История запусков тоже удалится.`,
    confirmText: 'Удалить', danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/backups/server-paths/${c.id}`);
    await loadServer();
    toast.success('Удалено');
  } catch (e) {
    toast.error((e as Error).message);
  }
}

// -------- panel-data CRUD --------
const panelDialog = reactive({
  open: false,
  editId: null as string | null,
  saving: false,
  form: {
    name: '', engine: 'RESTIC' as 'RESTIC' | 'TAR',
    storageLocationIds: [] as string[],
    schedule: '',
    keepDaily: 24, keepWeekly: 7, keepMonthly: 12, keepYearly: 5,
    enabled: true,
    notificationMode: 'INSTANT' as NotificationMode,
    digestSchedule: '',
  },
});

function openPanelDialog(c: PanelDataConfig | null) {
  if (c) {
    panelDialog.editId = c.id;
    panelDialog.form = {
      name: c.name, engine: c.engine,
      storageLocationIds: [...c.storageLocationIds],
      schedule: c.schedule || '',
      keepDaily: c.keepDaily, keepWeekly: c.keepWeekly,
      keepMonthly: c.keepMonthly, keepYearly: c.keepYearly,
      enabled: c.enabled,
      notificationMode: (c.notificationMode || 'INSTANT') as NotificationMode,
      digestSchedule: c.digestSchedule || '',
    };
  } else {
    panelDialog.editId = null;
    panelDialog.form = {
      name: '', engine: 'RESTIC', storageLocationIds: [],
      schedule: '', keepDaily: 24, keepWeekly: 7, keepMonthly: 12, keepYearly: 5,
      enabled: true,
      notificationMode: 'INSTANT', digestSchedule: '',
    };
  }
  panelDialog.open = true;
}

function togglePanelStorage(id: string) {
  const i = panelDialog.form.storageLocationIds.indexOf(id);
  if (i >= 0) panelDialog.form.storageLocationIds.splice(i, 1);
  else panelDialog.form.storageLocationIds.push(id);
}

async function savePanel() {
  panelDialog.saving = true;
  try {
    const common = {
      name: panelDialog.form.name,
      storageLocationIds: panelDialog.form.storageLocationIds,
      schedule: panelDialog.form.schedule || undefined,
      keepDaily: panelDialog.form.keepDaily,
      keepWeekly: panelDialog.form.keepWeekly,
      keepMonthly: panelDialog.form.keepMonthly,
      keepYearly: panelDialog.form.keepYearly,
      enabled: panelDialog.form.enabled,
      notificationMode: panelDialog.form.notificationMode,
      digestSchedule: panelDialog.form.notificationMode === 'DIGEST'
        ? (panelDialog.form.digestSchedule || undefined)
        : null,
    };
    if (panelDialog.editId) {
      // engine иммутабелен — не шлём в PATCH (иначе forbidNonWhitelisted → 400)
      await api.patch(`/backups/panel-data/${panelDialog.editId}`, common);
    } else {
      await api.post('/backups/panel-data', { ...common, engine: panelDialog.form.engine });
    }
    toast.success('Сохранено');
    panelDialog.open = false;
    await loadPanel();
  } catch (e: unknown) {
    const msg = (e as { data?: { error?: { message?: string } } })?.data?.error?.message || (e as Error).message;
    toast.error(msg);
  } finally {
    panelDialog.saving = false;
  }
}

async function runPanel(c: PanelDataConfig) {
  runningPanel.value[c.id] = true;
  try {
    await api.post(`/backups/panel-data/${c.id}/run`);
    toast.success(`Бэкап "${c.name}" запущен`);
    setTimeout(loadHistory, 1500);
  } catch (e: unknown) {
    toast.error((e as Error).message || 'Ошибка запуска');
  } finally {
    runningPanel.value[c.id] = false;
  }
}

async function deletePanel(c: PanelDataConfig) {
  const ok = await useMbConfirm().ask({
    title: 'Удаление конфига',
    message: `Удалить "${c.name}"? История запусков тоже удалится.`,
    confirmText: 'Удалить', danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/backups/panel-data/${c.id}`);
    await loadPanel();
    toast.success('Удалено');
  } catch (e) {
    toast.error((e as Error).message);
  }
}

// -------- site-backup-schedules CRUD --------
const scheduleDialog = reactive({
  open: false,
  editId: null as string | null,
  saving: false,
  form: {
    name: '',
    enabled: true,
    type: 'FULL' as 'FULL' | 'FILES_ONLY' | 'DB_ONLY' | 'DIFFERENTIAL',
    engine: 'RESTIC' as 'RESTIC' | 'TAR',
    storageLocationIds: [] as string[],
    schedule: '',
    keepDaily: 7, keepWeekly: 4, keepMonthly: 6, keepYearly: 1,
    retentionDays: 14,
    checkEnabled: false,
    checkSchedule: '0 4 * * 0',
    checkReadData: false,
    checkReadDataSubset: '10%',
    checkMinIntervalHours: 168,
    notificationMode: 'INSTANT' as NotificationMode,
    digestSchedule: '',
  },
});
const scheduleExcludesText = ref('');
const scheduleExcludeTablesText = ref('');

function openScheduleDialog(c: SiteBackupSchedule | null) {
  if (c) {
    scheduleDialog.editId = c.id;
    scheduleDialog.form = {
      name: c.name,
      enabled: c.enabled,
      type: c.type,
      engine: c.engine,
      storageLocationIds: [...c.storageLocationIds],
      schedule: c.schedule || '',
      keepDaily: c.keepDaily, keepWeekly: c.keepWeekly,
      keepMonthly: c.keepMonthly, keepYearly: c.keepYearly,
      retentionDays: c.retentionDays,
      checkEnabled: c.checkEnabled,
      checkSchedule: c.checkSchedule || '0 4 * * 0',
      checkReadData: c.checkReadData,
      checkReadDataSubset: c.checkReadDataSubset || '10%',
      checkMinIntervalHours: c.checkMinIntervalHours,
      notificationMode: (c.notificationMode || 'INSTANT') as NotificationMode,
      digestSchedule: c.digestSchedule || '',
    };
    scheduleExcludesText.value = (c.excludePaths || []).join('\n');
    scheduleExcludeTablesText.value = (c.excludeTableData || []).join('\n');
  } else {
    scheduleDialog.editId = null;
    scheduleDialog.form = {
      name: '', enabled: true, type: 'FULL', engine: 'RESTIC',
      storageLocationIds: [], schedule: '0 3 * * *',
      keepDaily: 7, keepWeekly: 4, keepMonthly: 6, keepYearly: 1,
      retentionDays: 14,
      checkEnabled: false, checkSchedule: '0 4 * * 0',
      checkReadData: false, checkReadDataSubset: '10%',
      checkMinIntervalHours: 168,
      notificationMode: 'INSTANT', digestSchedule: '',
    };
    scheduleExcludesText.value = '';
    scheduleExcludeTablesText.value = '';
  }
  scheduleDialog.open = true;
}

function toggleScheduleStorage(id: string) {
  const i = scheduleDialog.form.storageLocationIds.indexOf(id);
  if (i >= 0) scheduleDialog.form.storageLocationIds.splice(i, 1);
  else scheduleDialog.form.storageLocationIds.push(id);
}

async function saveSchedule() {
  scheduleDialog.saving = true;
  try {
    const body: Record<string, unknown> = {
      name: scheduleDialog.form.name,
      enabled: scheduleDialog.form.enabled,
      type: scheduleDialog.form.type,
      engine: scheduleDialog.form.engine,
      storageLocationIds: scheduleDialog.form.storageLocationIds,
      schedule: scheduleDialog.form.schedule || undefined,
      keepDaily: scheduleDialog.form.keepDaily,
      keepWeekly: scheduleDialog.form.keepWeekly,
      keepMonthly: scheduleDialog.form.keepMonthly,
      keepYearly: scheduleDialog.form.keepYearly,
      retentionDays: scheduleDialog.form.retentionDays,
      excludePaths: parseLines(scheduleExcludesText.value),
      excludeTableData: parseLines(scheduleExcludeTablesText.value),
      checkEnabled: scheduleDialog.form.checkEnabled,
      checkSchedule: scheduleDialog.form.checkEnabled
        ? (scheduleDialog.form.checkSchedule || undefined)
        : undefined,
      checkReadData: scheduleDialog.form.checkReadData,
      checkReadDataSubset: scheduleDialog.form.checkReadData
        ? (scheduleDialog.form.checkReadDataSubset || undefined)
        : undefined,
      checkMinIntervalHours: scheduleDialog.form.checkMinIntervalHours,
      notificationMode: scheduleDialog.form.notificationMode,
      digestSchedule: scheduleDialog.form.notificationMode === 'DIGEST'
        ? (scheduleDialog.form.digestSchedule || undefined)
        : null,
    };
    if (scheduleDialog.editId) {
      await api.patch(`/backups/site-schedules/${scheduleDialog.editId}`, body);
    } else {
      await api.post('/backups/site-schedules', body);
    }
    toast.success('Сохранено');
    scheduleDialog.open = false;
    await loadSchedules();
  } catch (e: unknown) {
    const msg = (e as { data?: { error?: { message?: string } } })?.data?.error?.message || (e as Error).message;
    toast.error(msg);
  } finally {
    scheduleDialog.saving = false;
  }
}

async function runSchedule(c: SiteBackupSchedule) {
  runningSchedule.value[c.id] = true;
  try {
    const res = await api.post<{ data: { launched: { siteId: string }[]; errors: unknown[] } }>(
      `/backups/site-schedules/${c.id}/run`,
    );
    const launched = (res as { data?: { launched?: unknown[] } })?.data?.launched?.length ?? 0;
    toast.success(`Шедуль "${c.name}" — запущен на ${launched} сайт(ах)`);
    setTimeout(loadHistory, 1500);
  } catch (e: unknown) {
    toast.error((e as Error).message || 'Ошибка запуска');
  } finally {
    runningSchedule.value[c.id] = false;
  }
}

async function deleteSchedule(c: SiteBackupSchedule) {
  const ok = await useMbConfirm().ask({
    title: 'Удаление шедуля',
    message: `Удалить "${c.name}"? Автобэкапы по этому шедулю остановятся.`,
    confirmText: 'Удалить', danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/backups/site-schedules/${c.id}`);
    await loadSchedules();
    toast.success('Удалено');
  } catch (e) {
    toast.error((e as Error).message);
  }
}

// -------- WS progress --------
let cleanupBackupProgress: (() => void) | undefined;

onMounted(async () => {
  await refreshAll();
  cleanupBackupProgress = onBackupProgress((payload) => {
    liveProgress[payload.backupId] = payload.progress;
    if (payload.status === 'COMPLETED' || payload.status === 'FAILED') {
      setTimeout(() => {
        delete liveProgress[payload.backupId];
        loadHistory();
      }, 500);
    }
  });
});

onBeforeUnmount(() => {
  cleanupBackupProgress?.();
});
</script>

<style scoped>
.backups { padding: 1.5rem; max-width: 1400px; margin: 0 auto; }

.backups__header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 1.5rem; gap: 1rem; flex-wrap: wrap; }
.backups__title { font-size: 1.5rem; font-weight: 700; color: var(--text-heading); margin: 0; }
.backups__subtitle { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.15rem; }
.header-actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }

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

.backups__tabs {
  display: flex; gap: 0.1rem; border-bottom: 1px solid var(--border); margin-bottom: 1rem;
}
.backups__tab {
  padding: 0.65rem 1rem; font-size: 0.82rem; font-weight: 500; color: var(--text-muted);
  background: none; border: none; border-bottom: 2px solid transparent;
  cursor: pointer; transition: all 0.2s; font-family: inherit; margin-bottom: -1px;
}
.backups__tab:hover { color: var(--text-tertiary); }
.backups__tab--active { color: var(--primary-text); border-bottom-color: var(--primary); }

.backups__section { margin-top: 1.5rem; }
.section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; gap: 0.75rem; }
.section-title { font-size: 1rem; font-weight: 600; color: var(--text-secondary); margin: 0; display: inline-flex; align-items: center; }

.settings-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  padding: 1.25rem;
}
.settings-card--list { padding: 0.75rem; }
.section-hint { font-size: 0.8rem; color: var(--text-muted); margin: 0 0 1rem; line-height: 1.5; }
.section-hint code { background: var(--bg-body); padding: 0 0.3rem; border-radius: 4px; font-family: monospace; }
.empty-card { display: flex; flex-direction: column; align-items: center; padding: 2rem 1rem; color: var(--text-muted); font-size: 0.85rem; gap: 0.5rem; }
.empty-card--flush { border: none; background: transparent; }

.cfg-panel__head {
  display: flex; justify-content: space-between; align-items: flex-start;
  gap: 1rem; margin-bottom: 0.75rem;
}

.info-box {
  background: var(--bg-input);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  padding: 0.7rem 0.9rem;
  margin: 0.5rem 0 1rem;
  font-size: 0.82rem;
  color: var(--text-secondary);
}
.info-box summary { cursor: pointer; color: var(--text-tertiary); }
.info-box ul { margin: 0.5rem 0; padding-left: 1.2rem; }
.info-box code { background: var(--bg-body); padding: 0 0.3rem; border-radius: 4px; font-family: monospace; }

/* History */
.history-list { display: flex; flex-direction: column; gap: 0.35rem; }
.history-item {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.75rem 1rem;
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 12px;
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
.history-item__top { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
.history-item__type { font-size: 0.82rem; font-weight: 500; color: var(--text-secondary); }
.history-item__meta { font-size: 0.68rem; color: var(--text-faint); }
.history-item__error { font-size: 0.72rem; color: #f87171; margin-top: 0.2rem; white-space: pre-wrap; }

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
.badge--status-completed { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
.badge--status-failed { background: rgba(239, 68, 68, 0.1); color: #f87171; }
.badge--status-in_progress { background: rgba(var(--primary-rgb), 0.1); color: var(--primary-light); }
.badge--status-pending { background: rgba(148, 163, 184, 0.1); color: #94a3b8; }

/* Forms */
.settings-fields { display: flex; flex-direction: column; gap: 1rem; }
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
.form-hint { font-size: 0.7rem; color: var(--text-faint); margin: 0; }
.form-hint code { background: var(--bg-body); padding: 0 0.3rem; border-radius: 4px; font-family: monospace; }
.form-sublabel { display: block; font-size: 0.78rem; color: var(--text-tertiary); margin-bottom: 0.3rem; }
.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; }

.inline-check {
  display: flex; align-items: center; gap: 0.5rem; cursor: pointer;
  color: var(--text-primary); font-size: 0.9rem;
}
.inline-check input { accent-color: var(--primary-text, var(--primary)); }

.retention-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.75rem;
}
.retention-grid--4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
@media (max-width: 560px) {
  .retention-grid--4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

.cfg-badge {
  display: inline-block; padding: 0.08rem 0.5rem; border-radius: 999px;
  background: var(--primary-bg, rgba(var(--primary-rgb), 0.12));
  color: var(--primary-text, var(--primary));
  font-size: 0.72rem; font-weight: 500; margin-left: 0.4rem;
}
.cfg-badge--muted { background: var(--bg-input); color: var(--text-tertiary); }
.cfg-badge--ok { background: var(--success-bg, rgba(34,197,94,0.12)); color: var(--success, #22c55e); }

.muted-text {
  color: var(--text-muted);
  font-size: 0.7rem;
  margin-left: 0.4rem;
}

.check-block {
  margin-top: 0.5rem; padding-top: 1rem;
  border-top: 1px dashed var(--border);
  display: flex; flex-direction: column; gap: 0.75rem;
}
.check-block__fields {
  display: flex; flex-direction: column; gap: 0.75rem;
  padding-left: 1.25rem; border-left: 2px solid var(--border-secondary);
}

.global-excludes {
  margin-top: 1.75rem; padding-top: 1.5rem;
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
  width: 100%; box-sizing: border-box; padding: 0.7rem 0.85rem;
  background: var(--bg-body); border: 1px solid var(--border-secondary);
  border-radius: 8px; color: var(--text-primary);
  font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; line-height: 1.55;
  resize: vertical; min-height: 100px;
  transition: border-color 0.15s, background 0.15s;
}
.global-excludes__textarea:focus { outline: none; border-color: var(--primary-border); background: var(--bg-surface); }

.cfg-actions { display: flex; justify-content: flex-end; margin-top: 1rem; }

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

/* Tables */
.storage-table {
  width: 100%; border-collapse: separate; border-spacing: 0; margin-top: 0.5rem;
  background: var(--bg-input); border-radius: 12px; overflow: hidden; border: 1px solid var(--border);
}
.storage-table th, .storage-table td {
  padding: 0.7rem 0.9rem; text-align: left;
  border-bottom: 1px solid var(--border); font-size: 0.88rem; color: var(--text-primary);
}
.storage-table tbody tr:last-child td { border-bottom: none; }
.storage-table tbody tr:hover { background: var(--bg-surface); }
.storage-table th {
  font-weight: 600; color: var(--text-tertiary);
  text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.06em;
  background: var(--bg-surface);
}

.actions-cell { white-space: nowrap; display: flex; gap: 0.75rem; }
.link-btn {
  background: none; border: none; color: var(--primary-text, var(--primary));
  cursor: pointer; padding: 0; font-size: 0.85rem;
}
.link-btn:hover { text-decoration: underline; }
.link-btn:disabled { color: var(--text-muted); cursor: not-allowed; }
.link-btn--danger { color: var(--danger, #ef4444); }

/* Modal */
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
.modal__fields { display: flex; flex-direction: column; gap: 0.85rem; margin-bottom: 1rem; }
.modal__actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
@keyframes modalIn { from { opacity: 0; transform: scale(0.96) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }

.warning-box {
  background: var(--danger-bg, rgba(239,68,68,0.08));
  border: 1px solid var(--danger-border, rgba(239,68,68,0.3));
  border-radius: 8px; padding: 0.7rem 0.9rem; margin: 0.5rem 0;
  color: var(--text-primary); font-size: 0.85rem;
}
.warning-box ul { margin: 0.4rem 0; padding-left: 1.2rem; }

@media (max-width: 768px) {
  .backups__title { font-size: 1.25rem; }
  .backups__header { flex-direction: column; }
  .section-header { flex-direction: column; align-items: flex-start; gap: 0.5rem; }
  .history-item { flex-wrap: wrap; gap: 0.5rem; }
}
</style>
