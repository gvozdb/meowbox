<template>
  <div class="mh">
    <div class="mh__header">
      <div>
        <h1 class="mh__title">Миграция со старой hostPanel</h1>
        <p class="mh__subtitle">
          Перенос сайтов, БД, конфигов, SSL и cron'ов с устаревших серверов на текущий slave
        </p>
      </div>
      <button v-if="step === 1" class="btn btn--ghost btn--sm" @click="loadHistory">
        История миграций ({{ history.length }})
      </button>
    </div>

    <!-- Stepper -->
    <div class="stepper">
      <div v-for="(label, idx) in steps" :key="idx" class="stepper__item" :class="{
        'stepper__item--active': step === idx + 1,
        'stepper__item--done': step > idx + 1,
      }">
        <span class="stepper__num">{{ idx + 1 }}</span>
        <span class="stepper__label">{{ label }}</span>
      </div>
    </div>

    <!-- Step 1: source connection -->
    <div v-if="step === 1" class="card">
      <h2 class="card__title">🔗 Подключение к источнику</h2>

      <!-- Сохранённые пресеты. Показываем только если есть хотя бы один — пустой
           блок только засоряет UI на первом запуске. -->
      <div v-if="savedSources.length > 0" class="saved-sources">
        <div class="saved-sources__header">
          <span class="saved-sources__title">📌 Сохранённые серверы</span>
          <span class="saved-sources__hint">Клик — подставит данные в форму ниже</span>
        </div>
        <div class="saved-sources__list">
          <button
            v-for="s in savedSources"
            :key="s.id"
            type="button"
            class="saved-source"
            :class="{ 'saved-source--active': selectedSourceId === s.id }"
            @click="applySavedSource(s)"
          >
            <span class="saved-source__main">
              <span class="saved-source__name">{{ s.name }}</span>
              <span class="saved-source__addr">
                {{ s.sshUser }}@{{ s.host }}<span v-if="s.port !== 22">:{{ s.port }}</span>
              </span>
            </span>
            <span class="saved-source__meta">
              <span class="saved-source__db">db: {{ s.hostpanelDb }}</span>
              <span v-if="s.lastUsedAt" class="saved-source__last">{{ formatRelativeShort(s.lastUsedAt) }}</span>
            </span>
            <span
              class="saved-source__delete"
              role="button"
              tabindex="0"
              title="Удалить пресет"
              @click.stop="deleteSavedSource(s)"
              @keydown.enter.stop="deleteSavedSource(s)"
            >×</span>
          </button>
        </div>
      </div>

      <p class="card__hint">
        Введи SSH и MySQL доступы к серверу со старой hostPanel. Пароли передаются <strong>зашифрованно</strong> и хранятся под AES-256-GCM.
      </p>

      <!-- SSH-блок -->
      <div class="form-section">
        <div class="form-section__head">
          <span class="form-section__icon">🔐</span>
          <span class="form-section__title">SSH-доступ</span>
        </div>
        <div class="form-grid">
          <div class="form-group form-group--col2">
            <label class="form-label">Host (IP / domain)</label>
            <input v-model="src.host" class="form-input" placeholder="ip или домен сервера-источника" @input="onSrcEdit" />
          </div>
          <div class="form-group">
            <label class="form-label">Port</label>
            <input v-model.number="src.port" type="number" class="form-input" @input="onSrcEdit" />
          </div>
          <div class="form-group">
            <label class="form-label">User</label>
            <input v-model="src.sshUser" class="form-input" placeholder="root" @input="onSrcEdit" />
          </div>
          <div class="form-group form-group--col2">
            <label class="form-label">
              Пароль
              <span v-if="selectedSourceId && !src.sshPassword" class="form-label__hint">сохранён ✓</span>
            </label>
            <input
              v-model="src.sshPassword"
              type="password"
              class="form-input"
              :placeholder="selectedSourceId ? '(используется сохранённый пароль)' : '••••••••'"
            />
          </div>
        </div>
      </div>

      <!-- MySQL-блок -->
      <div class="form-section">
        <div class="form-section__head">
          <span class="form-section__icon">🗄️</span>
          <span class="form-section__title">MySQL источника</span>
        </div>
        <div class="form-grid">
          <div class="form-group form-group--col2">
            <label class="form-label">Host</label>
            <input v-model="src.mysqlHost" class="form-input" placeholder="127.0.0.1" @input="onSrcEdit" />
          </div>
          <div class="form-group">
            <label class="form-label">Port</label>
            <input v-model.number="src.mysqlPort" type="number" class="form-input" @input="onSrcEdit" />
          </div>
          <div class="form-group">
            <label class="form-label">User</label>
            <input v-model="src.mysqlUser" class="form-input" placeholder="root" @input="onSrcEdit" />
          </div>
          <div class="form-group form-group--col2">
            <label class="form-label">
              Пароль
              <span v-if="selectedSourceId && !src.mysqlPassword" class="form-label__hint">сохранён ✓</span>
            </label>
            <input
              v-model="src.mysqlPassword"
              type="password"
              class="form-input"
              :placeholder="selectedSourceId ? '(используется сохранённый пароль)' : '••••••••'"
            />
          </div>
          <div class="form-group">
            <label class="form-label">База hostpanel</label>
            <input v-model="src.hostpanelDb" class="form-input" placeholder="host" @input="onSrcEdit" />
          </div>
          <div class="form-group form-group--col2">
            <label class="form-label">Префикс таблиц hostpanel</label>
            <input v-model="src.hostpanelTablePrefix" class="form-input" placeholder="modx_host_" @input="onSrcEdit" />
          </div>
        </div>
      </div>

      <div v-if="error" class="alert alert--error">{{ error }}</div>

      <div class="card__actions">
        <button
          class="btn btn--ghost"
          :disabled="!canSaveSource || saving"
          @click="openSaveSourceDialog"
          :title="!canSaveSource ? 'Заполни SSH/MySQL пароли — без них пресет не имеет смысла' : ''"
        >
          <span v-if="!saving">💾 Сохранить доступы</span>
          <span v-else><span class="spinner spinner--sm" /> Сохраняю...</span>
        </button>
        <button class="btn btn--primary" :disabled="discovering || !canDiscover" @click="startDiscovery">
          <span v-if="!discovering">🔍 Сканировать источник</span>
          <span v-else><span class="spinner spinner--sm" /> Подключаюсь к источнику...</span>
        </button>
      </div>

      <!-- Save preset modal -->
      <div v-if="saveDialogOpen" class="modal-backdrop" @click.self="closeSaveDialog">
        <div class="modal">
          <h3 class="modal__title">💾 Сохранить доступы</h3>
          <p class="modal__hint">
            Дай этому пресету понятное имя — потом сможешь выбирать его одним кликом.
          </p>
          <div class="form-group">
            <label class="form-label">Название</label>
            <input
              v-model="saveDialogName"
              class="form-input"
              placeholder="например: vm120 prod"
              @keydown.enter="confirmSaveSource"
              ref="saveDialogInput"
            />
          </div>
          <div v-if="saveDialogError" class="alert alert--error">{{ saveDialogError }}</div>
          <div class="modal__actions">
            <button class="btn btn--ghost" @click="closeSaveDialog">Отмена</button>
            <button class="btn btn--primary" :disabled="!saveDialogName.trim() || saving" @click="confirmSaveSource">
              <span v-if="!saving">Сохранить</span>
              <span v-else><span class="spinner spinner--sm" /> ...</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Live discovery log: пока discovering = true, рендерим поток шагов
           с источника. Без этого юзер не понимает, что происходит, и
           думает что зависло. -->
      <div v-if="discovering || discoverLog.length > 0" class="discover-live">
        <div class="discover-live__header">
          <span class="discover-live__title">Сбор данных с источника</span>
          <span v-if="discoverProgress.total" class="discover-live__progress">
            шаг {{ discoverProgress.step }}/{{ discoverProgress.total }}
          </span>
        </div>
        <div v-if="discoverProgress.total" class="discover-live__bar">
          <div
            class="discover-live__bar-fill"
            :style="{ width: ((discoverProgress.step / discoverProgress.total) * 100).toFixed(0) + '%' }"
          />
        </div>
        <div class="discover-live__log" ref="discoverLogEl">
          <div v-for="(l, idx) in discoverLog" :key="idx" class="discover-live__line">
            <span class="discover-live__ts">{{ l.ts.slice(11, 19) }}</span>
            <span class="discover-live__msg">{{ l.line }}</span>
          </div>
          <div v-if="discoverLog.length === 0" class="discover-live__empty">
            Подключаюсь к источнику...
          </div>
        </div>
      </div>
    </div>

    <!-- Step 2: shortlist (быстрый probe → таблица сайтов с галочками) -->
    <div v-if="step === 2 && discovery" class="step-shortlist">
      <!-- Source meta — те же карточки что в Step 3 -->
      <div class="stats-grid">
        <div class="stat-card">
          <span class="stat-card__label">OS</span>
          <span class="stat-card__value">
            {{ discovery.discovery?.sourceMeta.distroId }} {{ discovery.discovery?.sourceMeta.distroVersion }}
          </span>
        </div>
        <div class="stat-card">
          <span class="stat-card__label">nginx</span>
          <span class="stat-card__value">{{ discovery.discovery?.sourceMeta.nginxVersion || '—' }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-card__label">MySQL</span>
          <span class="stat-card__value">{{ discovery.discovery?.sourceMeta.mysqlVersion || '—' }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-card__label">PHP versions</span>
          <span class="stat-card__value stat-card__value--wrap">
            <code v-for="v in (discovery.discovery?.sourceMeta.phpVersionsInstalled || [])" :key="v" class="chip">{{ v }}</code>
            <span v-if="!discovery.discovery?.sourceMeta.phpVersionsInstalled.length">—</span>
          </span>
        </div>
        <div class="stat-card">
          <span class="stat-card__label">Сайтов</span>
          <span class="stat-card__value">{{ discovery.items.length }}</span>
        </div>
        <div class="stat-card stat-card--wide">
          <span class="stat-card__label">Выбрано</span>
          <span class="stat-card__value">
            <strong>{{ selectedItems.size }}</strong>
            <span class="stat-card__sep">из {{ selectableItemIds.length }} доступных</span>
          </span>
        </div>
      </div>

      <!-- Manticore plate (если есть) -->
      <div v-if="discovery.discovery?.sourceMeta.manticoreInstalled" class="manticore-banner">
        <div class="manticore-banner__head">
          <span class="manticore-banner__icon">🔍</span>
          <strong>Manticore-индексы на источнике:</strong>
        </div>
        <div class="manticore-banner__chips">
          <code v-for="i in discovery.discovery.sourceMeta.manticoreIndexes" :key="i" class="chip chip--info">{{ i }}</code>
        </div>
        <p class="manticore-banner__hint">
          Индексы переноситься НЕ будут. Если на slave Manticore не установлен — поставь его в <code>/services</code>.
        </p>
      </div>

      <!-- Подсказка -->
      <div class="card">
        <h2 class="card__title">📋 Выбери сайты, которые надо мигрировать</h2>
        <p class="card__hint">
          Это быстрый shortlist — без сборки полного плана. Отметь галочки, нажми <strong>«Собрать план»</strong> —
          мы пройдём только по выбранным сайтам и посчитаем их размеры, прочитаем nginx/config.xml/SSL/cron.
          На больших серверах это спасает от 30-минутного простоя ради миграции 1-2 сайтов.
        </p>
      </div>

      <!-- Shortlist таблица -->
      <div class="sites-table sites-table--shortlist">
        <div class="sites-table__head sites-table__head--shortlist">
          <span class="col col--check">
            <input
              type="checkbox"
              class="mh-check"
              :checked="selectableItemIds.length > 0 && selectableItemIds.every((id) => selectedItems.has(id))"
              :indeterminate.prop="
                selectableItemIds.some((id) => selectedItems.has(id))
                  && !selectableItemIds.every((id) => selectedItems.has(id))
              "
              :disabled="selectableItemIds.length === 0"
              title="Выбрать/снять все"
              @change="toggleSelectAll($event)"
            />
          </span>
          <span class="col">Источник</span>
          <span class="col">Домен</span>
          <span class="col">CMS / PHP</span>
          <span class="col">DB</span>
          <span class="col col--size">Размер ≈</span>
          <span class="col">Статус</span>
        </div>
        <div
          v-for="item in discovery.items"
          :key="item.id"
          class="sites-table__row sites-table__row--shortlist"
          :class="{
            'sites-table__row--blocked': item.plan.blockedReason,
            'sites-table__row--off': !selectedItems.has(item.id),
          }"
          @click.self="!item.plan.blockedReason && toggleSelected(item.id)"
        >
          <span class="col col--check">
            <input
              type="checkbox"
              class="mh-check"
              :checked="selectedItems.has(item.id)"
              :disabled="!!item.plan.blockedReason"
              @change="toggleSelected(item.id)"
            />
          </span>
          <span class="col">
            <code class="chip">{{ item.plan.sourceUser }}</code>
            <span class="col__sub">{{ item.plan.sourceName || item.plan.sourceUser }}</span>
          </span>
          <span class="col"><code>{{ item.plan.sourceDomain || '—' }}</code></span>
          <span class="col">
            <span v-if="item.plan.sourceCms === 'modx'" class="badge badge--yellow">MODX</span>
            <span v-else class="badge">CUSTOM</span>
            <code class="chip" style="margin-left: 0.3rem">PHP {{ item.plan.sourcePhpVersion || '?' }}</code>
          </span>
          <span class="col">
            <code v-if="item.plan.sourceMysqlDb">{{ item.plan.sourceMysqlDb }}</code>
            <span v-else class="hint" style="margin: 0">—</span>
          </span>
          <span class="col col--size">
            <span v-if="item.plan.fsBytes">{{ humanBytes(item.plan.fsBytes) }}</span>
            <span v-else class="hint" style="margin: 0">—</span>
          </span>
          <span class="col">
            <span v-if="item.plan.blockedReason" class="badge badge--red" :title="item.plan.blockedReason">BLOCKED</span>
            <span v-else-if="item.plan.warnings?.length" class="badge badge--yellow" :title="item.plan.warnings.join('\n')">⚠ {{ item.plan.warnings.length }}</span>
            <span v-else class="badge badge--green">READY</span>
          </span>
        </div>
      </div>

      <!-- Live-log в режиме PROBING -->
      <div v-if="discovery.status === 'PROBING'" class="discover-live">
        <div class="discover-live__header">
          <span class="discover-live__title">Собираю полный план по выбранным сайтам</span>
          <span v-if="discoverProgress.total" class="discover-live__progress">
            шаг {{ discoverProgress.step }}/{{ discoverProgress.total }}
          </span>
        </div>
        <div v-if="discoverProgress.total" class="discover-live__bar">
          <div
            class="discover-live__bar-fill"
            :style="{ width: ((discoverProgress.step / discoverProgress.total) * 100).toFixed(0) + '%' }"
          />
        </div>
        <div class="discover-live__log" ref="discoverLogEl">
          <div v-for="(l, idx) in discoverLog" :key="idx" class="discover-live__line">
            <span class="discover-live__ts">{{ l.ts.slice(11, 19) }}</span>
            <span class="discover-live__msg">{{ l.line }}</span>
          </div>
          <div v-if="discoverLog.length === 0" class="discover-live__empty">
            Ожидаю первый шаг...
          </div>
        </div>
      </div>

      <div class="card__actions card__actions--space">
        <button class="btn btn--ghost" @click="step = 1" :disabled="discovery.status === 'PROBING'">← Назад</button>
        <button
          class="btn btn--primary"
          :disabled="selectedItems.size === 0 || probing"
          @click="startProbe"
        >
          <span v-if="!probing">Собрать план для {{ selectedItems.size }} сайтов →</span>
          <span v-else><span class="spinner spinner--sm" /> Собираю план...</span>
        </button>
      </div>
    </div>

    <!-- Step 3: plan (детальный план только по выбранным сайтам) -->
    <div v-if="step === 3 && discovery" class="step2">
      <!-- Source meta -->
      <div class="stats-grid">
        <div class="stat-card">
          <span class="stat-card__label">OS</span>
          <span class="stat-card__value">
            {{ discovery.discovery?.sourceMeta.distroId }} {{ discovery.discovery?.sourceMeta.distroVersion }}
          </span>
        </div>
        <div class="stat-card">
          <span class="stat-card__label">nginx</span>
          <span class="stat-card__value">
            {{ discovery.discovery?.sourceMeta.nginxVersion || '—' }}
          </span>
        </div>
        <div class="stat-card">
          <span class="stat-card__label">MySQL</span>
          <span class="stat-card__value">
            {{ discovery.discovery?.sourceMeta.mysqlVersion || '—' }}
          </span>
        </div>
        <div class="stat-card">
          <span class="stat-card__label">PHP versions</span>
          <span class="stat-card__value stat-card__value--wrap">
            <code
              v-for="v in (discovery.discovery?.sourceMeta.phpVersionsInstalled || [])"
              :key="v"
              class="chip"
            >{{ v }}</code>
            <span v-if="!discovery.discovery?.sourceMeta.phpVersionsInstalled.length">—</span>
          </span>
        </div>
        <div class="stat-card">
          <span class="stat-card__label">Сайтов в плане</span>
          <span class="stat-card__value">{{ planItems.length }}</span>
        </div>
        <div class="stat-card stat-card--wide">
          <span class="stat-card__label">Размер</span>
          <span class="stat-card__value">
            <strong>{{ humanBytes(totalFsBytes) }}</strong>
            <span class="stat-card__sep">files</span>
            <span class="stat-card__plus">+</span>
            <strong>{{ humanBytes(totalDbBytes) }}</strong>
            <span class="stat-card__sep">db</span>
          </span>
        </div>
      </div>

      <!-- Manticore banner -->
      <div v-if="discovery.discovery?.sourceMeta.manticoreInstalled" class="manticore-banner">
        <div class="manticore-banner__head">
          <span class="manticore-banner__icon">🔍</span>
          <strong>Manticore-индексы на источнике:</strong>
        </div>
        <div class="manticore-banner__chips">
          <code v-for="i in discovery.discovery.sourceMeta.manticoreIndexes" :key="i" class="chip chip--info">{{ i }}</code>
        </div>
        <p class="manticore-banner__hint">
          Индексы переноситься НЕ будут — это надёжнее. После миграции запусти переиндексацию вручную.
          Если на slave Manticore не установлен — поставь его в <code>/services</code> перед миграцией.
        </p>
      </div>

      <!-- Sites table -->
      <div class="sites-table">
        <div class="sites-table__head">
          <span class="col col--check">
            <input
              type="checkbox"
              class="mh-check"
              :checked="selectableItemIds.length > 0 && selectableItemIds.every((id) => selectedItems.has(id))"
              :indeterminate.prop="
                selectableItemIds.some((id) => selectedItems.has(id))
                  && !selectableItemIds.every((id) => selectedItems.has(id))
              "
              :disabled="selectableItemIds.length === 0"
              title="Выбрать/снять все"
              @change="toggleSelectAll($event)"
            />
          </span>
          <span class="col col--source">Источник</span>
          <span class="col col--name">Имя в meowbox</span>
          <span class="col col--domain">Главный домен</span>
          <span class="col col--php">PHP</span>
          <span class="col col--size">Размер</span>
          <span class="col col--status">Статус</span>
        </div>
        <template v-for="item in planItems" :key="item.id">
          <div
            class="sites-table__row"
            :class="{
              'sites-table__row--blocked': item.plan.blockedReason,
              'sites-table__row--expanded': expandedItem === item.id,
            }"
          >
            <span class="col col--check">
              <input
                type="checkbox"
                class="mh-check"
                :checked="selectedItems.has(item.id)"
                :disabled="!!item.plan.blockedReason"
                @change="toggleSelected(item.id)"
              />
            </span>
            <span class="col col--source">
              <code>{{ item.plan.sourceUser }}</code>
              <span class="col__sub">{{ item.plan.sourceDomain }}</span>
            </span>
            <span class="col col--name">
              <input
                v-model="item.plan.newName"
                class="inline-input"
                :class="{
                  'inline-input--invalid': nameValidation[item.id]?.available === false,
                  'inline-input--ok': nameValidation[item.id]?.available === true,
                }"
                @blur="validateName(item)"
              />
              <!-- spec §12.2: зелёная галочка справа при доступности -->
              <span v-if="nameValidation[item.id]?.available === true" class="col__ok" title="доступно">✓</span>
              <span v-if="nameValidation[item.id]?.available === false" class="col__err">
                {{ nameValidation[item.id]?.reason }}
              </span>
              <!-- spec §12.2: suggest альтернатив (<name>-2, ...) -->
              <span
                v-if="nameValidation[item.id]?.available === false && nameValidation[item.id]?.suggest?.length"
                class="col__suggest"
              >
                <button
                  v-for="s in nameValidation[item.id]!.suggest"
                  :key="s"
                  class="btn btn--ghost btn--sm"
                  @click="applyNameSuggest(item, s)"
                >{{ s }}</button>
              </span>
            </span>
            <span class="col col--domain">
              <input
                v-model="item.plan.newDomain"
                class="inline-input"
                :class="{
                  'inline-input--invalid': domainValidation[item.id]?.available === false,
                  'inline-input--ok': domainValidation[item.id]?.available === true,
                }"
                @blur="validateDomain(item)"
              />
              <span v-if="domainValidation[item.id]?.available === true" class="col__ok" title="доступно">✓</span>
              <span v-if="domainValidation[item.id]?.available === false" class="col__err">
                {{ domainValidation[item.id]?.reason }}
              </span>
            </span>
            <span class="col col--php">{{ item.plan.phpVersion }}</span>
            <span class="col col--size">
              {{ humanBytes(item.plan.fsBytes) }} + {{ humanBytes(item.plan.dbBytes) }}
            </span>
            <span class="col col--status">
              <span v-if="item.plan.blockedReason" class="badge badge--red">BLOCKED</span>
              <span v-else-if="item.plan.warnings?.length" class="badge badge--yellow">{{ item.plan.warnings.length }} ⚠</span>
              <span v-else class="badge badge--green">READY</span>
              <!-- Inline Force PHP — spec §4.4: «Кнопка `Force PHP X.Y` рядом» -->
              <button
                v-if="item.plan.blockedReason"
                class="btn btn--ghost btn--sm"
                style="margin-left: 0.4rem"
                @click.stop="forcePhp(item)"
                title="Принудительно мигрировать с дефолтной PHP-версией. Возможны фатальные ошибки!"
              >⚡ Force {{ defaultForcedPhp }}</button>
              <button
                class="btn-expand"
                :class="{ 'btn-expand--open': expandedItem === item.id }"
                @click="toggleExpand(item.id)"
                :title="expandedItem === item.id ? 'Скрыть детали' : 'Показать детали'"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            </span>
          </div>

          <!-- Expanded details -->
          <div v-if="expandedItem === item.id" class="sites-table__details">
            <div v-if="item.plan.blockedReason" class="alert alert--error">
              <div>{{ item.plan.blockedReason }}</div>
              <div class="alert__actions">
                <button
                  class="btn btn--ghost btn--sm"
                  @click="forcePhp(item)"
                  title="Принудительно мигрировать с дефолтной PHP-версией. Возможны фатальные ошибки!"
                >⚡ Force PHP {{ defaultForcedPhp }} (опасно)</button>
              </div>
            </div>
            <div v-for="w in item.plan.warnings" :key="w" class="alert alert--warning">{{ w }}</div>

            <!-- PHP-версия для нового сайта на slave -->
            <h4>PHP-версия</h4>
            <div class="php-pick">
              <div class="php-pick__row">
                <span class="php-pick__k">На источнике:</span>
                <code class="chip">{{ item.plan.sourcePhpVersion || '—' }}</code>
              </div>
              <div
                v-if="item.plan.sourcePhpVersion && !slavePhpVersions.includes(item.plan.sourcePhpVersion)"
                class="alert alert--warning php-pick__missing"
              >
                <strong>⚠ PHP {{ item.plan.sourcePhpVersion }} не установлен на этом сервере.</strong>
                <p>
                  Для чистого переноса —
                  <NuxtLink to="/php" class="link">установи PHP {{ item.plan.sourcePhpVersion }}</NuxtLink>
                  и перезагрузи страницу. Либо выбери ниже одну из доступных версий
                  (по умолчанию подобрана самая близкая).
                </p>
              </div>
              <div class="php-pick__row">
                <span class="php-pick__k">На slave (для нового сайта):</span>
                <select
                  v-if="slavePhpVersions.length"
                  v-model="item.plan.phpVersion"
                  class="form-select form-select--sm"
                  @change="onItemPhpChange(item)"
                >
                  <option v-for="v in slavePhpVersions" :key="v" :value="v">PHP {{ v }}</option>
                </select>
                <span v-else class="hint">
                  На slave не установлено ни одной версии PHP —
                  <NuxtLink to="/php" class="link">установи хотя бы одну</NuxtLink>.
                </span>
              </div>
            </div>

            <h4>
              Алиасы (доп. домены)
              <span v-if="item.plan.aliasesRedirectToMain" class="badge badge--yellow" style="margin-left: 0.4rem">
                301 → {{ item.plan.newDomain }}
              </span>
            </h4>
            <div class="alias-input">
              <input
                v-model="aliasDraft[item.id]"
                class="form-input"
                placeholder="добавь домен и нажми Enter"
                @keydown.enter="addAlias(item)"
              />
              <span v-for="(a, i) in item.plan.newAliases" :key="a" class="alias-tag">
                {{ a }}
                <button @click="item.plan.newAliases.splice(i, 1); savePlan(item)">×</button>
              </span>
            </div>
            <label class="check-row">
              <input
                type="checkbox"
                class="mh-check"
                :checked="!!item.plan.aliasesRedirectToMain"
                @change="(e: any) => { item.plan.aliasesRedirectToMain = e.target.checked; savePlan(item); }"
              />
              <span>Редиректить алиасы 301 на главный домен</span>
            </label>

            <h4>
              Содержимое <code>/var/www/{{ item.plan.sourceUser }}/</code>
              <span class="h4__count">{{ item.plan.homeIncludes.length }} объектов</span>
            </h4>
            <p class="hint hint--inline">
              Корневая директория хомдиры. Папки и файлы. Сними галку — пропустим при rsync.
            </p>
            <div class="file-list">
              <label
                v-for="f in sortedHomeIncludes(item.plan.homeIncludes)"
                :key="f.name"
                class="file-list__row"
                :class="{ 'file-list__row--off': !f.checked }"
              >
                <input
                  type="checkbox"
                  class="mh-check"
                  v-model="f.checked"
                  @change="savePlan(item)"
                />
                <span class="file-list__icon">{{ f.kind === 'dir' ? '📁' : '📄' }}</span>
                <span class="file-list__name">{{ f.name }}{{ f.kind === 'dir' ? '/' : '' }}</span>
                <span class="file-list__size">{{ humanBytes(f.bytes) }}</span>
              </label>
            </div>

            <h4>Дополнительные rsync exclude-патерны</h4>
            <p class="hint hint--inline">По одному паттерну в строку. Дополняет дефолты meowbox + dumper.yaml::exclude.</p>
            <textarea
              v-model="rsyncExcludesText[item.id]"
              class="form-textarea form-textarea--mono"
              rows="6"
              spellcheck="false"
              @blur="saveRsyncExcludes(item)"
            />

            <!-- Spec §5.2.3: показываем textarea ВСЕГДА (даже если backend
                 вернул пустой список — оператор может сам добавить таблицы). -->
            <h4>Таблицы БД БЕЗ данных (только структура)</h4>
            <p class="hint hint--inline">
              По одной таблице в строку (с префиксом, например <code>modx_session</code>). При импорте структура будет, данных нет.
            </p>
            <textarea
              v-model="dbExcludesText[item.id]"
              class="form-textarea form-textarea--mono"
              rows="5"
              spellcheck="false"
              placeholder="modx_session&#10;modx_manager_log&#10;modx_register_messages"
              @blur="saveDbExcludes(item)"
            />

            <h4>
              Cron-задачи
              <span class="h4__count">{{ item.plan.cronJobs.length }} шт.</span>
            </h4>
            <div v-if="item.plan.cronJobs.length" class="cron-list">
              <div
                v-for="(j, i) in item.plan.cronJobs"
                :key="i"
                class="cron-card"
                :class="{ 'cron-card--off': j.target === 'skip' }"
              >
                <!-- spec §5.2.4: «список задач с галочками» — быстро
                     включить/выключить без выпадашки. Чекбокс ↔ skip-target. -->
                <div class="cron-card__head">
                  <input
                    type="checkbox"
                    class="mh-check"
                    :checked="j.target !== 'skip'"
                    @change="(e: any) => { j.target = e.target.checked ? 'this-site' : 'skip'; savePlan(item); }"
                    title="Импортировать эту задачу"
                  />
                  <code class="cron-card__schedule">{{ j.schedule }}</code>
                  <select class="form-select form-select--sm" v-model="j.target" @change="savePlan(item)">
                    <option value="this-site">→ Этот сайт</option>
                    <option value="system-root">→ Системный (root)</option>
                    <option value="skip">пропустить</option>
                  </select>
                </div>
                <pre class="cron-card__cmd">{{ j.command }}</pre>
              </div>
            </div>
            <p v-else class="hint">Cron-задач для этого сайта не нашлось.</p>

            <h4>PHP-FPM (с источника):</h4>
            <div v-if="item.plan.phpFpm" class="fpm-preview">
              <div class="fpm-preview__row">
                <span class="fpm-preview__k">pm</span>
                <code>{{ item.plan.phpFpm.pm }}</code>
              </div>
              <div class="fpm-preview__row">
                <span class="fpm-preview__k">pm.max_children</span>
                <code>{{ item.plan.phpFpm.pmMaxChildren }}</code>
              </div>
              <div class="fpm-preview__row">
                <span class="fpm-preview__k">upload_max_filesize</span>
                <code>{{ item.plan.phpFpm.uploadMaxFilesize }}</code>
              </div>
              <div class="fpm-preview__row">
                <span class="fpm-preview__k">post_max_size</span>
                <code>{{ item.plan.phpFpm.postMaxSize }}</code>
              </div>
              <div class="fpm-preview__row">
                <span class="fpm-preview__k">memory_limit</span>
                <code>{{ item.plan.phpFpm.memoryLimit }}</code>
              </div>
              <div v-if="item.plan.phpFpm.custom" class="fpm-preview__row fpm-preview__row--full">
                <span class="fpm-preview__k">custom-блок (php_admin_value, env, ...)</span>
                <pre class="fpm-preview__custom">{{ item.plan.phpFpm.custom }}</pre>
              </div>
              <p class="hint">
                Параметры скопируются на slave. Кастом-блок переживает смену PHP-версии в UI.
                После миграции можно править через <code>/sites/{id}</code> → tab «PHP-FPM».
              </p>
            </div>
            <p v-else class="hint">PHP-FPM пул на источнике не найден — будут дефолты meowbox.</p>

            <h4>SSL</h4>
            <div v-if="item.plan.ssl">
              <label class="check-row">
                <input type="checkbox" class="mh-check" v-model="item.plan.ssl.transfer" @change="savePlan(item)" />
                <span>Перенести сертификат как есть</span>
              </label>
              <p class="hint">
                Домены в серте:
                <span class="domain-chips">
                  <code v-for="d in item.plan.ssl.domainsInCert" :key="d" class="chip">{{ d }}</code>
                </span>
              </p>
              <p class="hint">
                После переключения DNS — перевыпусти серт через UI сайта (вкладка SSL).
              </p>
            </div>
            <p v-else class="hint">SSL на источнике не найден — на новом сервере выпустишь сам.</p>

            <h4>Manticore</h4>
            <label class="check-row">
              <input
                type="checkbox"
                class="mh-check"
                v-model="item.plan.manticore.enable"
                :disabled="!discovery.discovery?.sourceMeta.manticoreInstalled"
                @change="savePlan(item)"
              />
              <span>Включить сервис Manticore для сайта</span>
            </label>
            <p v-if="!discovery.discovery?.sourceMeta.manticoreInstalled" class="hint">
              На источнике Manticore не обнаружен.
            </p>
          </div>
        </template>
      </div>

      <!-- System (root) cron jobs -->
      <div v-if="discovery.discovery?.systemCronJobs?.length" class="card">
        <h3 class="card__h3">
          Системные cron-задачи (root)
          <span class="h4__count">{{ discovery.discovery.systemCronJobs.length }} шт.</span>
        </h3>
        <p class="card__hint">Задачи root-кронтаба, не привязанные к сайтам. После миграции попадут в <code>/cron</code> → «Системный».</p>
        <div class="cron-list">
          <div v-for="(j, i) in discovery.discovery.systemCronJobs" :key="i" class="cron-card">
            <div class="cron-card__head">
              <code class="cron-card__schedule">{{ j.schedule }}</code>
            </div>
            <pre class="cron-card__cmd">{{ j.command }}</pre>
          </div>
        </div>
      </div>

      <div class="card__actions card__actions--space">
        <button class="btn btn--ghost" @click="step = 2">← К выбору сайтов</button>
        <button class="btn btn--primary" :disabled="!canStart" @click="startMigration">
          Запустить миграцию ({{ selectedItems.size }} сайтов) →
        </button>
      </div>
    </div>

    <!-- Step 4: progress -->
    <div v-if="step === 4 && discovery" class="step3">
      <div class="card">
        <div class="step3__header">
          <div>
            <h2 class="card__title">⚙ Идёт миграция...</h2>
            <p class="card__hint">
              Статус: <strong>{{ discovery.status }}</strong>
              • Готово: {{ discovery.doneSites }}/{{ discovery.totalSites }}
              • Ошибок: {{ discovery.failedSites }}
              <span v-if="discovery.paused" class="badge badge--yellow">⏸ ПАУЗА</span>
            </p>
          </div>
          <div class="step3__controls" v-if="discovery.status === 'RUNNING'">
            <button v-if="!discovery.paused" class="btn btn--ghost btn--sm" @click="doPause">⏸ Пауза</button>
            <button v-else class="btn btn--primary btn--sm" @click="doResume">▶ Продолжить</button>
            <button class="btn btn--danger btn--sm" @click="doCancel">❌ Отменить</button>
          </div>
        </div>
        <!-- Aggregate progress bar (spec §5.3) -->
        <div class="overall-progress">
          <div class="overall-progress__bar">
            <span :style="{ width: overallPercent + '%' }" />
          </div>
          <span class="overall-progress__label">{{ overallPercent }}%</span>
        </div>
      </div>

      <div v-for="item in planItems" :key="item.id" class="run-card" :class="`run-card--${item.status.toLowerCase()}`">
        <div class="run-card__head">
          <span class="run-card__name">{{ item.plan.newName }}</span>
          <span class="run-card__domain">{{ item.plan.newDomain }}</span>
          <span class="run-card__stage">
            {{ item.currentStage || '—' }}
            <em class="run-card__status">{{ item.status }}</em>
            <em
              v-if="item.verifyHttpCode"
              class="run-card__http"
              :class="{ 'run-card__http--ok': /^[23]/.test(item.verifyHttpCode), 'run-card__http--err': /^[45]/.test(item.verifyHttpCode) }"
            >HTTP {{ item.verifyHttpCode }}</em>
          </span>
          <span class="run-card__pct">{{ item.progressPercent }}%</span>
        </div>
        <!-- spec §5.3: «для rsync — реальный %, для остальных — пульсация».
             Если стейдж RUNNING и progressPercent === 0 (или известный
             non-rsync стейдж) — показываем пульсирующую полоску. -->
        <div
          class="run-card__bar"
          :class="{
            'run-card__bar--pulse':
              item.status === 'RUNNING' &&
              (item.progressPercent === 0 || (item.currentStage && !/^(rsync-files)$/.test(item.currentStage)))
          }"
        >
          <span :style="{ width: (item.progressPercent || 0) + '%' }" />
        </div>
        <details class="run-card__log">
          <summary>Лог ({{ (item.log || '').split('\n').length }} строк)</summary>
          <pre>{{ item.log }}</pre>
        </details>
        <div v-if="item.errorMsg" class="alert alert--error">{{ item.errorMsg }}</div>

        <!-- Force-retry баннер: если на slave болтаются leak'нутые артефакты
             с этим именем (linux user / homedir / mariadb db) от предыдущей
             зомби-попытки — UI предлагает их зачистить и автоматически
             повторить. Защита от случайного удаления чужого: API проверяет
             что (а) name не принадлежит реальному Site, (б) нет другой
             RUNNING миграции с этим name. -->
        <div v-if="item.status === 'FAILED'" class="force-retry-block">
          <div v-if="forceRetryCheck[item.id]?.canForceRetry" class="alert alert--warning">
            <strong>🧹 Найден leak от предыдущей попытки:</strong>
            <code v-for="src in forceRetryCheck[item.id].leakSources" :key="src" class="chip" style="margin: 0 0.3rem">{{ src }}</code>
            <span class="hint" style="margin-top: 0.4rem; display: block">
              Можно очистить эти артефакты и сразу повторить миграцию.
              Имя <code>{{ forceRetryCheck[item.id].name }}</code> НЕ занято
              ни реальным сайтом, ни другой активной миграцией — безопасно.
            </span>
          </div>
          <div v-else-if="forceRetryCheck[item.id] && !forceRetryCheck[item.id].canForceRetry" class="hint" style="font-size: 0.85em; opacity: 0.7">
            Force-retry недоступен: {{ forceRetryCheck[item.id].reason }}
          </div>
        </div>

        <!-- Per-item actions -->
        <div class="run-card__actions">
          <a
            v-if="item.status === 'DONE' && item.newSiteId"
            :href="`/sites/${item.newSiteId}`"
            class="btn btn--ghost btn--sm"
          >Открыть сайт →</a>
          <a
            v-if="item.status === 'DONE' && item.newSiteId && item.plan.ssl?.transfer"
            :href="`/sites/${item.newSiteId}?tab=ssl`"
            class="btn btn--ghost btn--sm"
          >🔒 Перевыпустить SSL после DNS →</a>
          <button
            v-if="forceRetryCheck[item.id]?.canForceRetry && item.status === 'FAILED'"
            class="btn btn--warning btn--sm"
            :disabled="forceRetrying[item.id]"
            @click="doForceRetry(item)"
          >
            <span v-if="!forceRetrying[item.id]">🧹 Очистить и повторить</span>
            <span v-else><span class="spinner spinner--sm" /> Чищу...</span>
          </button>
          <button
            v-if="['FAILED', 'SKIPPED'].includes(item.status)"
            class="btn btn--primary btn--sm"
            @click="doRetry(item)"
          >🔄 Повторить</button>
          <button
            v-if="['PLANNED', 'CONFLICT', 'BLOCKED'].includes(item.status) && discovery.status !== 'RUNNING'"
            class="btn btn--ghost btn--sm"
            @click="doSkip(item)"
          >Пропустить</button>
        </div>
      </div>

      <!-- Final state -->
      <div v-if="['DONE', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(discovery.status || '')" class="card">
        <h3>{{ discovery.status === 'DONE' ? '✅ Готово!' : discovery.status === 'PARTIAL' ? '⚠ Частично завершено' : discovery.status === 'CANCELLED' ? '❌ Отменено' : '❌ Не повезло' }}</h3>
        <p>{{ discovery.doneSites }} из {{ discovery.totalSites }} сайтов перенесены.</p>
        <p v-if="discovery.failedSites">С ошибкой: {{ discovery.failedSites }} — посмотри логи и/или нажми «Повторить».</p>
        <p class="hint">
          ⚠ После переключения DNS на новый IP — перевыпусти SSL для каждого сайта на странице сайта (вкладка SSL).
        </p>
        <div class="card__actions">
          <button class="btn btn--ghost" @click="reset">Создать ещё одну миграцию</button>
        </div>
      </div>
    </div>

    <!-- History modal -->
    <Teleport to="body">
      <div v-if="showHistory" class="modal-overlay" @mousedown.self="showHistory = false">
        <div class="modal modal--wide">
          <h3 class="modal__title">История миграций</h3>
          <div v-if="!history.length" class="hint">Пока ничего не было.</div>
          <div v-else class="history-list">
            <div v-for="m in history" :key="m.id" class="history-row">
              <span class="badge" :class="`badge--${m.status === 'DONE' ? 'green' : m.status === 'FAILED' ? 'red' : 'yellow'}`">
                {{ m.status }}
              </span>
              <span>{{ formatDate(m.createdAt) }}</span>
              <span>{{ m.doneSites }}/{{ m.totalSites }} сайтов</span>
              <button class="btn btn--ghost btn--sm" @click="loadMigration(m.id)">Открыть</button>
            </div>
          </div>
          <div class="modal__actions">
            <button class="btn btn--ghost" @click="showHistory = false">Закрыть</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface PlanItem {
  sourceSiteId: number;
  sourceUser: string;
  sourceDomain: string;
  sourceCms: 'modx' | null;
  sourcePhpVersion: string;
  newName: string;
  newDomain: string;
  newAliases: string[];
  aliasesRedirectToMain?: boolean;
  phpVersion: string;
  homeIncludes: { name: string; kind: 'file' | 'dir'; bytes: number; checked: boolean }[];
  rsyncExtraExcludes: string[];
  dbExcludeDataTables: string[];
  cronJobs: { schedule: string; command: string; target: string; raw: string }[];
  ssl: { transfer: boolean; domainsInCert: string[] } | null;
  manticore: { enable: boolean };
  phpFpm?: {
    pm: 'ondemand' | 'dynamic' | 'static';
    pmMaxChildren: number;
    uploadMaxFilesize: string;
    postMaxSize: string;
    memoryLimit: string;
    custom: string;
  };
  fsBytes: number;
  dbBytes: number;
  warnings: string[];
  blockedReason?: string;
}

interface MigrationItem {
  id: string;
  status: string;
  progressPercent: number;
  currentStage: string | null;
  errorMsg: string | null;
  log: string;
  newSiteId: string | null;
  plan: PlanItem;
  /** Из лога вытаскивается клиентом — формат "HTTP 200 via slave-IP". */
  verifyHttpCode?: string;
}

interface Migration {
  id: string;
  status: string;
  totalSites: number;
  doneSites: number;
  failedSites: number;
  createdAt: string;
  errorMessage: string | null;
  paused?: boolean;
  discovery: {
    sourceMeta: {
      distroId: string;
      distroVersion: string;
      nginxVersion: string | null;
      mysqlVersion: string | null;
      phpVersionsInstalled: string[];
      manticoreInstalled: boolean;
      manticoreIndexes: string[];
    };
    systemCronJobs: { schedule: string; command: string }[];
  } | null;
  items: MigrationItem[];
  log: string;
}

const api = useApi();
const toast = useMbToast();
const { connect, getSocket } = useSocket();

const steps = ['Подключение', 'Выбор сайтов', 'План', 'Выполнение'];
const step = ref(1);

const src = reactive({
  host: '',
  port: 22,
  sshUser: 'root',
  sshPassword: '',
  mysqlHost: '127.0.0.1',
  mysqlPort: 3306,
  mysqlUser: 'root',
  mysqlPassword: '',
  hostpanelDb: 'host',
  hostpanelTablePrefix: 'modx_host_',
});

const error = ref('');
const discovering = ref(false);
const discovery = ref<Migration | null>(null);
// Live-лог discover'а — поток шагов сбора данных с источника. Очищается
// перед каждым новым Discover. Хранит максимум 500 последних строк (защита
// от больших серверов с 100+ сайтами × десяток шагов на сайт).
const discoverLog = ref<{ line: string; ts: string; step?: number; total?: number }[]>([]);
const discoverProgress = reactive<{ step: number; total: number }>({ step: 0, total: 0 });
const discoverLogEl = ref<HTMLDivElement | null>(null);
const expandedItem = ref<string>('');
const selectedItems = ref<Set<string>>(new Set());
const aliasDraft = reactive<Record<string, string>>({});
const rsyncExcludesText = reactive<Record<string, string>>({});
const dbExcludesText = reactive<Record<string, string>>({});
const nameValidation = reactive<Record<string, { available: boolean; reason?: string; suggest?: string[] }>>({});
const domainValidation = reactive<Record<string, { available: boolean; reason?: string }>>({});

const showHistory = ref(false);
const history = ref<{ id: string; status: string; totalSites: number; doneSites: number; createdAt: string }[]>([]);

// ─── Сохранённые пресеты источников ──────────────────────────────────────
// Список пресетов (без паролей — backend их не отдаёт). Клик по элементу
// заполняет форму выше; пароли заполняем плейсхолдером — реальные подставит
// бэкенд по sourceId если оператор не вписал свои.
interface SavedSource {
  id: string;
  name: string;
  host: string;
  port: number;
  sshUser: string;
  mysqlHost: string;
  mysqlPort: number;
  mysqlUser: string;
  hostpanelDb: string;
  hostpanelTablePrefix: string;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const savedSources = ref<SavedSource[]>([]);
const selectedSourceId = ref<string | null>(null);
const saving = ref(false);
const saveDialogOpen = ref(false);
const saveDialogName = ref('');
const saveDialogError = ref('');
const saveDialogInput = ref<HTMLInputElement | null>(null);

async function loadSavedSources() {
  try {
    const list = await api.get<SavedSource[]>('/admin/migrate-hostpanel/sources');
    savedSources.value = Array.isArray(list) ? list : [];
  } catch {
    savedSources.value = [];
  }
}

function applySavedSource(s: SavedSource) {
  selectedSourceId.value = s.id;
  src.host = s.host;
  src.port = s.port;
  src.sshUser = s.sshUser;
  src.sshPassword = ''; // пароль не передаём с бэка — backend подставит по sourceId
  src.mysqlHost = s.mysqlHost;
  src.mysqlPort = s.mysqlPort;
  src.mysqlUser = s.mysqlUser;
  src.mysqlPassword = '';
  src.hostpanelDb = s.hostpanelDb;
  src.hostpanelTablePrefix = s.hostpanelTablePrefix;
  error.value = '';
}

// Любая правка нон-секрет полей сбрасывает selectedSourceId — иначе оператор
// поправит хост, нажмёт «Сканировать» и backend проигнорит правки (использует
// сохранённый source целиком). Лучше явно показать что связь оборвана.
function onSrcEdit() {
  if (!selectedSourceId.value) return;
  // Чекаем: после правки данные ещё совпадают с пресетом? Если да — не рвём
  // связь (просто перенабор того же значения).
  const s = savedSources.value.find((x) => x.id === selectedSourceId.value);
  if (!s) {
    selectedSourceId.value = null;
    return;
  }
  const matches =
    src.host === s.host &&
    src.port === s.port &&
    src.sshUser === s.sshUser &&
    src.mysqlHost === s.mysqlHost &&
    src.mysqlPort === s.mysqlPort &&
    src.mysqlUser === s.mysqlUser &&
    src.hostpanelDb === s.hostpanelDb &&
    src.hostpanelTablePrefix === s.hostpanelTablePrefix;
  if (!matches) selectedSourceId.value = null;
}

async function deleteSavedSource(s: SavedSource) {
  if (!confirm(`Удалить сохранённый источник «${s.name}»?`)) return;
  try {
    await api.delete(`/admin/migrate-hostpanel/sources/${s.id}`);
    savedSources.value = savedSources.value.filter((x) => x.id !== s.id);
    if (selectedSourceId.value === s.id) selectedSourceId.value = null;
  } catch (e: unknown) {
    error.value = (e as Error).message || 'Не удалось удалить пресет';
  }
}

// Сохранять пресет можно только когда введены и пароли — без них preset
// бесполезен (backend не сможет подставить креды).
const canSaveSource = computed(() =>
  Boolean(
    src.host && src.sshUser && src.sshPassword && src.mysqlUser && src.mysqlPassword,
  ),
);

function openSaveSourceDialog() {
  if (!canSaveSource.value) return;
  saveDialogError.value = '';
  // Подсказываем имя по умолчанию: user@host или просто host.
  saveDialogName.value = src.sshUser && src.host
    ? `${src.sshUser}@${src.host}`
    : src.host || '';
  saveDialogOpen.value = true;
  // Фокус на инпут после рендера модалки.
  setTimeout(() => saveDialogInput.value?.focus(), 50);
}

function closeSaveDialog() {
  saveDialogOpen.value = false;
  saveDialogName.value = '';
  saveDialogError.value = '';
}

async function confirmSaveSource() {
  const name = saveDialogName.value.trim();
  if (!name) {
    saveDialogError.value = 'Имя обязательно';
    return;
  }
  saving.value = true;
  saveDialogError.value = '';
  try {
    const created = await api.post<{ id: string; name: string }>(
      '/admin/migrate-hostpanel/sources',
      {
        name,
        host: src.host,
        port: src.port,
        sshUser: src.sshUser,
        sshPassword: src.sshPassword,
        mysqlHost: src.mysqlHost,
        mysqlPort: src.mysqlPort,
        mysqlUser: src.mysqlUser,
        mysqlPassword: src.mysqlPassword,
        hostpanelDb: src.hostpanelDb,
        hostpanelTablePrefix: src.hostpanelTablePrefix,
      },
    );
    closeSaveDialog();
    await loadSavedSources();
    selectedSourceId.value = created.id;
    // Чистим вписанные пароли — теперь они в БД, при «Сканировать» backend
    // подставит по sourceId.
    src.sshPassword = '';
    src.mysqlPassword = '';
  } catch (e: unknown) {
    saveDialogError.value = (e as Error).message || 'Не удалось сохранить пресет';
  } finally {
    saving.value = false;
  }
}

function formatRelativeShort(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days} д`;
  return d.toLocaleDateString('ru');
}

// Список PHP-версий, реально установленных на этом slave (вызов /php/versions).
// Загружаем при входе в шаг 3 и при загрузке готовой миграции, чтобы:
//  1) показать селект с реальными вариантами в expanded details сайта;
//  2) автоматически подставить phpVersion = closest match если sourcePhp у нас
//     не установлен (иначе агент упадёт с "PHP-FPM service not found").
const slavePhpVersions = ref<string[]>([]);

/**
 * Подбор ближайшей PHP-версии из доступных на slave к версии-источнику.
 * Логика:
 *   1. Точное совпадение → берём.
 *   2. Сортируем по distance: сначала разница major'ов, потом minor'ов.
 *   3. При равенстве — предпочитаем более новую (выше minor).
 * Возвращает null если available пустой.
 */
function pickClosestPhp(source: string, available: string[]): string | null {
  if (!available.length) return null;
  if (available.includes(source)) return source;
  const parse = (v: string): [number, number] => {
    const [m, n] = v.split('.').map(Number);
    return [Number.isFinite(m) ? m : 0, Number.isFinite(n) ? n : 0];
  };
  const [sM, sN] = parse(source);
  const sorted = [...available].sort((a, b) => {
    const [aM, aN] = parse(a);
    const [bM, bN] = parse(b);
    const aMD = Math.abs(aM - sM);
    const bMD = Math.abs(bM - sM);
    if (aMD !== bMD) return aMD - bMD;
    const aND = Math.abs(aN - sN);
    const bND = Math.abs(bN - sN);
    if (aND !== bND) return aND - bND;
    return (bM * 100 + bN) - (aM * 100 + aN); // tiebreak: новее
  });
  return sorted[0];
}

async function loadSlavePhpVersions() {
  try {
    const list = await api.get<string[]>('/php/versions');
    slavePhpVersions.value = Array.isArray(list) ? list : [];
  } catch {
    slavePhpVersions.value = [];
  }
}

/**
 * Если на slave не установлен PHP версии источника — авто-подбираем
 * ближайшую И сохраняем план. Делаем это ОДИН раз при входе на шаг 3,
 * чтобы оператор видел уже подсунутую версию в селекте, а не должен был
 * вручную тыкать. Если оператор сам потом меняет — onItemPhpChange сохранит.
 */
async function autoPickPhpForAllItems() {
  if (!discovery.value || !slavePhpVersions.value.length) return;
  for (const item of discovery.value.items) {
    if (item.status === 'SKIPPED') continue;
    const cur = item.plan.phpVersion;
    if (cur && slavePhpVersions.value.includes(cur)) continue;
    const src = item.plan.sourcePhpVersion || cur;
    const picked = pickClosestPhp(src || '8.2', slavePhpVersions.value);
    if (picked && picked !== cur) {
      item.plan.phpVersion = picked;
      try { await savePlan(item); } catch { /* ignore */ }
    }
  }
}

async function onItemPhpChange(item: MigrationItem) {
  // Если оператор вручную выбрал версию — снимаем blockedReason, переводим в PLANNED
  // (как делает forcePhp, но без confirm, потому что выбор явный).
  if (item.plan.blockedReason) {
    item.plan.blockedReason = undefined;
    if (item.status === 'BLOCKED') item.status = 'PLANNED';
  }
  await savePlan(item);
}

// Если оператор выбрал сохранённый пресет — пароли необязательны (backend
// подставит по sourceId). Иначе — нужны все поля включая пароли.
const canDiscover = computed(() => {
  if (selectedSourceId.value) {
    return Boolean(src.host && src.sshUser && src.mysqlUser);
  }
  return Boolean(
    src.host && src.sshUser && src.sshPassword && src.mysqlUser && src.mysqlPassword,
  );
});
const canStart = computed(() => {
  if (selectedItems.value.size === 0) return false;
  // spec §12.2: «Кнопка "Запустить миграцию →" блокируется, пока есть CONFLICT»
  // + любые BLOCKED items (forced PHP перезапишет blockedReason). Валидация
  // имени/домена тоже блокирует (red-state inline-input).
  for (const id of selectedItems.value) {
    const item = discovery.value?.items.find((i) => i.id === id);
    if (!item) continue;
    if (item.status === 'CONFLICT' || item.plan.blockedReason) return false;
    if (nameValidation[id] && nameValidation[id]!.available === false) return false;
    if (domainValidation[id] && domainValidation[id]!.available === false) return false;
  }
  return true;
});

/**
 * Версия для Force PHP — берём первую установленную НА SLAVE (а не на источнике —
 * это была давняя бага: показывали source.phpVersionsInstalled, и если на slave
 * этой версии не было, миграция падала на стейдже nginx/php-fpm). Если slave
 * ещё не загружен — временный фолбэк 8.2 (агент попробует, но скорее всего
 * упадёт; оператор увидит warning и поправит вручную).
 */
const defaultForcedPhp = computed(() => {
  if (slavePhpVersions.value.length > 0) return slavePhpVersions.value[0];
  return '8.2';
});

/**
 * Айтемы, для которых реально собран план (status !== 'SKIPPED').
 * На шаге 2 оператор отмечает галочками нужные сайты, для остальных
 * deep-probe не запускается, и они получают статус SKIPPED. На шаге 3
 * (план) и шаге 4 (выполнение) показываем ТОЛЬКО реально выбранные
 * сайты — иначе в таблице мусор и оператор путается.
 */
const planItems = computed(() =>
  (discovery.value?.items || []).filter((i) => i.status !== 'SKIPPED'),
);

const totalFsBytes = computed(() => planItems.value.reduce((s, i) => s + i.plan.fsBytes, 0));
const totalDbBytes = computed(() => planItems.value.reduce((s, i) => s + i.plan.dbBytes, 0));

/**
 * Общий процент прогресса миграции по всем выбранным сайтам (spec §5.3:
 * «Сверху: общий прогресс-бар (sites: X из N, percent)»). DONE=100,
 * RUNNING — берём свой progressPercent, остальное — 0.
 */
const overallPercent = computed(() => {
  // Считаем прогресс только по реально запланированным сайтам — SKIPPED
  // не входят (см. planItems). Иначе оператор видит «50%» на стартe,
  // потому что половина items на самом деле не мигрируется.
  const tracked = planItems.value.filter((i) =>
    ['PLANNED', 'RUNNING', 'DONE', 'FAILED', 'CONFLICT', 'BLOCKED'].includes(i.status),
  );
  if (tracked.length === 0) return 0;
  const sum = tracked.reduce((acc, i) => {
    if (i.status === 'DONE' || i.status === 'FAILED') return acc + 100;
    if (i.status === 'RUNNING') return acc + (i.progressPercent || 0);
    return acc;
  }, 0);
  return Math.min(100, Math.round(sum / tracked.length));
});

/**
 * beforeunload guard (spec §5.3: «Запрос подтверждения при close страницы
 * пока миграция идёт»). Срабатывает только когда discovery.status === RUNNING
 * и operator не на паузе.
 */
function beforeUnloadHandler(e: BeforeUnloadEvent) {
  if (discovery.value?.status === 'RUNNING' && !discovery.value?.paused) {
    e.preventDefault();
    e.returnValue = ''; // Chrome требует
    return '';
  }
}
onMounted(() => {
  window.addEventListener('beforeunload', beforeUnloadHandler);
  // Грузим сохранённые пресеты для блока «Сохранённые серверы».
  void loadSavedSources();
});
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnloadHandler);
});

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}M`;
  return `${(bytes / 1024 ** 3).toFixed(1)}G`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ru');
}

async function startDiscovery() {
  error.value = '';
  discoverLog.value = [];
  discoverProgress.step = 0;
  discoverProgress.total = 0;
  discovering.value = true;
  try {
    // Если оператор выбрал сохранённый пресет И не вводил свои пароли —
    // шлём только sourceId, backend подставит креды. Иначе шлём source целиком.
    const useSavedAsIs =
      selectedSourceId.value && !src.sshPassword && !src.mysqlPassword;
    const body = useSavedAsIs
      ? { sourceId: selectedSourceId.value }
      : { source: { ...src } };
    const created = await api.post<{ id: string }>(
      '/admin/migrate-hostpanel/discover',
      body,
    );
    // Подписываемся на live-лог СРАЗУ после получения migrationId — до того
    // как агент начнёт слать события. Иначе пропустим первые шаги
    // (SSH-коннект, distro-detect).
    subscribeDiscoverLog(created.id);
    // poll until SHORTLIST_READY/FAILED
    while (true) {
      await new Promise((r) => setTimeout(r, 2000));
      const m = await api.get<Migration>(`/admin/migrate-hostpanel/${created.id}`);
      discovery.value = m;
      if (m.status === 'SHORTLIST_READY') {
        // По дефолту — выбираем те, у кого defaultSelected=true (выставляет
        // агент: всё кроме Adminer/host/pma). BLOCKED — никогда.
        for (const it of m.items) {
          if (it.plan.blockedReason) continue;
          if ((it.plan as any).defaultSelected !== false) {
            selectedItems.value.add(it.id);
          }
        }
        step.value = 2;
        break;
      } else if (m.status === 'READY') {
        // Backward-compat: если backend по какой-то причине вернул сразу READY
        // (legacy flow без shortlist), работаем как раньше — сразу Step 3.
        for (const it of m.items) {
          if (it.plan.blockedReason) continue;
          const isAdminer =
            it.plan.sourceCms === null &&
            (it.plan.sourceUser === 'host' ||
              it.plan.newDomain.startsWith('db.') ||
              it.plan.sourceUser === 'pma');
          if (!isAdminer) selectedItems.value.add(it.id);
        }
        for (const it of m.items) {
          rsyncExcludesText[it.id] = it.plan.rsyncExtraExcludes.join('\n');
          dbExcludesText[it.id] = it.plan.dbExcludeDataTables.join('\n');
        }
        step.value = 3;
        break;
      } else if (m.status === 'FAILED') {
        error.value = m.errorMessage || 'Discovery failed';
        break;
      }
    }
  } catch (e: unknown) {
    error.value = (e as Error).message || 'Ошибка подключения';
  } finally {
    discovering.value = false;
  }
}

const probing = ref(false);

/**
 * Phase 2 — оператор выбрал галочками сайты в shortlist'е и жмёт «Собрать план».
 * Шлёт POST /:id/probe с itemIds выбранных, поллит до READY → переходим в Step 3.
 */
async function startProbe() {
  if (!discovery.value) return;
  if (selectedItems.value.size === 0) return;
  probing.value = true;
  // Чистим лог и подписываемся заново — теперь будут события phase=plan
  discoverLog.value = [];
  discoverProgress.step = 0;
  discoverProgress.total = 0;
  subscribeDiscoverLog(discovery.value.id);
  try {
    await api.post(`/admin/migrate-hostpanel/${discovery.value.id}/probe`, {
      itemIds: Array.from(selectedItems.value),
    });
    // Poll
    while (true) {
      await new Promise((r) => setTimeout(r, 2000));
      const m = await api.get<Migration>(`/admin/migrate-hostpanel/${discovery.value.id}`);
      discovery.value = m;
      if (m.status === 'READY' || m.status === 'PARTIAL') {
        // selectedItems уже содержит UUID'ы выбранных, сохраняем выборку.
        // Не-выбранные стали SKIPPED на бэкенде, но мы их не выкидываем —
        // оператор может посмотреть список в Step 3.
        for (const it of m.items) {
          rsyncExcludesText[it.id] = (it.plan.rsyncExtraExcludes || []).join('\n');
          dbExcludesText[it.id] = (it.plan.dbExcludeDataTables || []).join('\n');
        }
        step.value = 3;
        // Грузим список slave-PHP-версий и авто-фиксим phpVersion у тех
        // сайтов, где source-версия не установлена. Делаем после step=3,
        // чтобы UI уже отрендерил селекты и оператор сразу видел корректные
        // дефолты.
        await loadSlavePhpVersions();
        await autoPickPhpForAllItems();
        break;
      } else if (m.status === 'FAILED') {
        toast.error(m.errorMessage || 'Deep probe failed');
        break;
      }
    }
  } catch (e: unknown) {
    toast.error((e as Error).message || 'Ошибка probe');
  } finally {
    probing.value = false;
  }
}

function toggleExpand(id: string) {
  expandedItem.value = expandedItem.value === id ? '' : id;
}

function toggleSelected(id: string) {
  if (selectedItems.value.has(id)) selectedItems.value.delete(id);
  else selectedItems.value.add(id);
}

/**
 * IDs всех «выбираемых» сайтов — без BLOCKED. На них работает галка
 * «Выбрать все»: если все selectable выбраны → checked, частично → indeterminate,
 * ничего → unchecked.
 */
const selectableItemIds = computed<string[]>(() =>
  (discovery.value?.items || [])
    // BLOCKED — нельзя; SKIPPED — оператор уже отверг на shortlist'е,
    // на step 3 их вообще не показываем (см. planItems)
    .filter((it) => !it.plan.blockedReason && it.status !== 'SKIPPED')
    .map((it) => it.id),
);

function toggleSelectAll(e: Event) {
  const target = e.target as HTMLInputElement;
  if (target.checked) {
    for (const id of selectableItemIds.value) selectedItems.value.add(id);
  } else {
    for (const id of selectableItemIds.value) selectedItems.value.delete(id);
  }
}

/**
 * Сортировка содержимого хомдиры: сначала папки (alphabetically), потом
 * файлы. Скрытые (точка-имя) — в конец каждой группы. Удобнее листать,
 * чем кашу из всех вперемешку.
 */
function sortedHomeIncludes(arr: { name: string; kind: 'file' | 'dir'; bytes: number; checked: boolean }[]) {
  return [...arr].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    const ah = a.name.startsWith('.');
    const bh = b.name.startsWith('.');
    if (ah !== bh) return ah ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

function addAlias(item: MigrationItem) {
  const v = (aliasDraft[item.id] || '').trim();
  if (!v) return;
  if (!item.plan.newAliases.includes(v)) item.plan.newAliases.push(v);
  aliasDraft[item.id] = '';
  savePlan(item);
}

async function savePlan(item: MigrationItem) {
  if (!discovery.value) return;
  try {
    await api.patch(`/admin/migrate-hostpanel/${discovery.value.id}/items/${item.id}`, {
      planJson: JSON.stringify(item.plan),
    });
  } catch {
    toast.error('Не удалось сохранить план');
  }
}

function saveRsyncExcludes(item: MigrationItem) {
  item.plan.rsyncExtraExcludes = (rsyncExcludesText[item.id] || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  savePlan(item);
}
function saveDbExcludes(item: MigrationItem) {
  item.plan.dbExcludeDataTables = (dbExcludesText[item.id] || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  savePlan(item);
}

// Seq-tokens для защиты от race: если оператор быстро вбил два значения,
// старый ответ может прилететь после нового — без token'а он перезатрёт
// корректный результат.
const validationSeq: Record<string, { name: number; domain: number }> = {};
function nextSeq(itemId: string, kind: 'name' | 'domain') {
  if (!validationSeq[itemId]) validationSeq[itemId] = { name: 0, domain: 0 };
  return ++validationSeq[itemId]![kind];
}
async function validateName(item: MigrationItem) {
  const mySeq = nextSeq(item.id, 'name');
  const valueAtCall = item.plan.newName;
  try {
    const r = await api.get<{ available: boolean; reason?: string; suggest?: string[] }>(
      `/admin/migrate-hostpanel/check-name?name=${encodeURIComponent(valueAtCall)}`,
    );
    if (validationSeq[item.id]?.name !== mySeq) return; // stale
    nameValidation[item.id] = r;
    if (r.available) await savePlan(item);
  } catch { /* ignore */ }
}
async function validateDomain(item: MigrationItem) {
  // spec §12.2: «GET /admin/migrate-hostpanel/check-domain → {available}».
  // Раньше было только `savePlan(item)` без проверки — оператор мог вбить
  // дублирующий домен и узнать об этом только при start.
  const mySeq = nextSeq(item.id, 'domain');
  const valueAtCall = item.plan.newDomain;
  try {
    const r = await api.get<{ available: boolean; reason?: string }>(
      `/admin/migrate-hostpanel/check-domain?domain=${encodeURIComponent(valueAtCall)}`,
    );
    if (validationSeq[item.id]?.domain !== mySeq) return; // stale
    domainValidation[item.id] = r;
    if (r.available) await savePlan(item);
  } catch { /* ignore */ }
}
function applyNameSuggest(item: MigrationItem, suggested: string) {
  item.plan.newName = suggested;
  validateName(item);
}

async function startMigration() {
  if (!discovery.value) return;
  try {
    await api.post(`/admin/migrate-hostpanel/${discovery.value.id}/start`, {
      itemIds: Array.from(selectedItems.value),
    });
    step.value = 4;
    subscribeProgress();
    pollDiscovery();
  } catch (e: unknown) {
    toast.error((e as Error).message || 'Не удалось запустить');
  }
}

/**
 * Подписка на live-лог discovery (ещё до того, как пользователь нажал «Запустить»).
 * Канал тот же `migrate-hostpanel:{id}`, событие `migrate-hostpanel:discover-log`.
 * Subscribe можно дёргать многократно — backend просто join'ит room.
 */
function subscribeDiscoverLog(migrationId: string) {
  connect();
  const socket = getSocket();
  if (!socket) return;
  socket.emit('migrate-hostpanel:subscribe', { migrationId });
  // Снимаем старый listener (если переоткрыли страницу) — иначе двойные строки.
  socket.off('migrate-hostpanel:discover-log');
  socket.on(
    'migrate-hostpanel:discover-log',
    (data: { migrationId: string; line: string; step?: number; total?: number; timestamp: string }) => {
      if (data.migrationId !== migrationId) return;
      discoverLog.value.push({
        line: data.line,
        ts: data.timestamp,
        step: data.step,
        total: data.total,
      });
      // Cap: последние 500 строк (хватает на лог 50 сайтов × 10 шагов)
      if (discoverLog.value.length > 500) {
        discoverLog.value.splice(0, discoverLog.value.length - 500);
      }
      if (typeof data.step === 'number') discoverProgress.step = data.step;
      if (typeof data.total === 'number') discoverProgress.total = data.total;
      // Autoscroll к последней строке
      nextTick(() => {
        if (discoverLogEl.value) {
          discoverLogEl.value.scrollTop = discoverLogEl.value.scrollHeight;
        }
      });
    },
  );
}

function subscribeProgress() {
  if (!discovery.value) return;
  connect();
  const socket = getSocket();
  if (!socket) return;
  socket.emit('migrate-hostpanel:subscribe', { migrationId: discovery.value.id });
  // Снимаем старые listener'ы — иначе при повторных вызовах (retry,
  // force-retry, navigate) один и тот же event приходит N раз, либо новые
  // не приходят (если room после complete был покинут).
  socket.off('migrate-hostpanel:item:log');
  socket.off('migrate-hostpanel:item:progress');
  socket.off('migrate-hostpanel:item:status');
  socket.off('migrate-hostpanel:complete');
  socket.on('migrate-hostpanel:item:log', (data: { itemId: string; line: string }) => {
    const item = discovery.value?.items.find((i) => i.id === data.itemId);
    if (item) {
      item.log = (item.log || '') + data.line + '\n';
      // Surface verify HTTP-кода в UI (см. spec §6.1 stage 12)
      const httpMatch = data.line.match(/HTTP\s+(\d{3})\s+via slave-IP/);
      if (httpMatch?.[1]) item.verifyHttpCode = httpMatch[1];
    }
  });
  socket.on('migrate-hostpanel:item:progress', (data: { itemId: string; stage: string; progress: number }) => {
    const item = discovery.value?.items.find((i) => i.id === data.itemId);
    if (item) {
      item.currentStage = data.stage;
      item.progressPercent = data.progress;
    }
  });
  socket.on('migrate-hostpanel:item:status', (data: { itemId: string; status: string; errorMsg?: string }) => {
    const item = discovery.value?.items.find((i) => i.id === data.itemId);
    if (item) {
      item.status = data.status;
      if (data.errorMsg) item.errorMsg = data.errorMsg;
    }
  });
  // spec §15.5: терминальный сигнал миграции (broadcast мастером в
  // recomputeMigrationFinalStatus). Без него UI узнает о финале только
  // через 5-секундный poll — здесь обновляем сразу.
  socket.on('migrate-hostpanel:complete', (data: { migrationId: string; status: string; totalDone: number; totalFailed: number }) => {
    if (!discovery.value || data.migrationId !== discovery.value.id) return;
    discovery.value.status = data.status;
    discovery.value.doneSites = data.totalDone;
    discovery.value.failedSites = data.totalFailed;
  });
}

let pollTimer: number | null = null;
function pollDiscovery() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = window.setTimeout(async () => {
    if (!discovery.value) return;
    try {
      const m = await api.get<Migration>(`/admin/migrate-hostpanel/${discovery.value.id}`);
      // Общие поля
      discovery.value.status = m.status;
      discovery.value.doneSites = m.doneSites;
      discovery.value.failedSites = m.failedSites;
      discovery.value.paused = m.paused;
      // Подтягиваем status / newSiteId / progressPercent для каждого item.
      // Лог не перетираем — он стримится через WS.
      let anyJustFailed = false;
      for (const it of m.items) {
        const local = discovery.value.items.find((i) => i.id === it.id);
        if (!local) continue;
        if (local.status !== 'FAILED' && it.status === 'FAILED') anyJustFailed = true;
        local.status = it.status;
        local.progressPercent = it.progressPercent;
        local.currentStage = it.currentStage;
        local.errorMsg = it.errorMsg;
        local.newSiteId = it.newSiteId;
      }
      // Если хотя бы один свежеупавший item — спрашиваем агента, есть ли
      // leak'и для force-retry. Делаем по тем, по которым ещё не спрашивали.
      if (anyJustFailed || ['FAILED', 'PARTIAL'].includes(m.status)) {
        void refreshForceRetryChecks();
      }
      if (!['DONE', 'FAILED', 'PARTIAL', 'CANCELLED'].includes(m.status)) {
        pollDiscovery();
      }
    } catch { /* ignore */ }
  }, 5000);
}

async function doPause() {
  if (!discovery.value) return;
  try {
    await api.post(`/admin/migrate-hostpanel/${discovery.value.id}/pause`, {});
    discovery.value.paused = true;
    toast.success('Пауза будет применена после текущего сайта');
  } catch (e: unknown) {
    toast.error((e as Error).message || 'Не удалось поставить на паузу');
  }
}

async function doResume() {
  if (!discovery.value) return;
  try {
    await api.post(`/admin/migrate-hostpanel/${discovery.value.id}/resume`, {});
    discovery.value.paused = false;
    pollDiscovery();
    toast.success('Продолжаем');
  } catch (e: unknown) {
    toast.error((e as Error).message || 'Не удалось продолжить');
  }
}

async function doCancel() {
  if (!discovery.value) return;
  if (!confirm('Отменить миграцию? Текущий сайт будет откатан, остальные пометятся SKIPPED.')) return;
  try {
    await api.post(`/admin/migrate-hostpanel/${discovery.value.id}/cancel`, {});
    discovery.value.status = 'CANCELLED';
    toast.success('Миграция отменена');
  } catch (e: unknown) {
    toast.error((e as Error).message || 'Не удалось отменить');
  }
}

async function doRetry(item: MigrationItem) {
  if (!discovery.value) return;
  try {
    await api.post(
      `/admin/migrate-hostpanel/${discovery.value.id}/items/${item.id}/retry`,
      {},
    );
    item.status = 'RUNNING';
    item.progressPercent = 0;
    item.errorMsg = null;
    item.currentStage = null;
    item.log = '';
    discovery.value.status = 'RUNNING';
    delete forceRetryCheck.value[item.id]; // re-check после следующего fail'а
    // Re-subscribe: сервер выходит из room после migration:complete, поэтому
    // без re-subscribe новые WS-логи retry не приходят.
    subscribeProgress();
    pollDiscovery();
    toast.success(`Повторяем ${item.plan.newName}`);
  } catch (e: unknown) {
    toast.error((e as Error).message || 'Не удалось повторить');
  }
}

/**
 * Force-retry: API на сервере подтверждает что есть leak именно от этой
 * миграции (а не чужой работающий сайт), вызывает агента почистить
 * артефакты и потом стандартный retry. Для FAILED-айтемов с leak'нутыми
 * остатками (linux user, db, /var/www/<name>) — кнопка показывается
 * только если check-leak вернул canForceRetry=true.
 */
const forceRetryCheck = ref<Record<string, {
  canForceRetry: boolean;
  reason?: string;
  name?: string;
  leakSources?: string[];
}>>({});
const forceRetrying = ref<Record<string, boolean>>({});

async function refreshForceRetryChecks() {
  if (!discovery.value) return;
  // Опрашиваем агент только по тем айтемам, которые FAILED И ещё не
  // проверены (ИЛИ изменился errorMsg — простая эвристика: проверяем 1 раз).
  const tasks = (discovery.value.items || [])
    .filter((it) => it.status === 'FAILED' && !forceRetryCheck.value[it.id])
    .map(async (it) => {
      try {
        type Resp = {
          success: boolean;
          data: { canForceRetry: boolean; reason?: string; name?: string; leakSources?: string[] };
        };
        const r = await api.get<Resp['data']>(
          `/admin/migrate-hostpanel/${discovery.value!.id}/items/${it.id}/force-retry-check`,
        );
        forceRetryCheck.value[it.id] = r;
      } catch {
        forceRetryCheck.value[it.id] = { canForceRetry: false, reason: 'check-leak недоступен' };
      }
    });
  await Promise.all(tasks);
}

async function doForceRetry(item: MigrationItem) {
  if (!discovery.value) return;
  const check = forceRetryCheck.value[item.id];
  if (!check?.canForceRetry) return;
  if (!confirm(
    `Очистить leak'нутые артефакты для '${check.name}' (${(check.leakSources || []).join(', ')}) и повторить миграцию?\n\n` +
    `Это безвозвратно снесёт linux-юзера, /var/www/${check.name}, БД с этим именем. ` +
    `Имя НЕ принадлежит реальному сайту в meowbox — мы проверили.`,
  )) return;
  forceRetrying.value[item.id] = true;
  try {
    await api.post(
      `/admin/migrate-hostpanel/${discovery.value.id}/items/${item.id}/force-retry`,
      {},
    );
    item.status = 'RUNNING';
    item.progressPercent = 0;
    item.errorMsg = null;
    item.currentStage = null;
    item.log = '';
    discovery.value.status = 'RUNNING';
    // Сбрасываем кэш — после успешного retry leak уже не должен быть
    delete forceRetryCheck.value[item.id];
    // Re-subscribe: те же причины, что и в doRetry.
    subscribeProgress();
    pollDiscovery();
    toast.success(`Очистка ОК, повторяем ${item.plan.newName}`);
  } catch (e: unknown) {
    toast.error((e as Error).message || 'Не удалось force-retry');
  } finally {
    forceRetrying.value[item.id] = false;
  }
}

/**
 * Принудительный PHP override для BLOCKED-сайта (несовместимая версия).
 * См. spec §4.4. Снимает blockedReason локально, апгрейдит phpVersion и
 * сохраняет план. Дальше можно ставить галочку для запуска.
 */
async function forcePhp(item: MigrationItem) {
  if (!confirm(
    `Принудительно мигрировать ${item.plan.newName} на PHP ${defaultForcedPhp.value}? ` +
    `Сайт может не работать (deprecated API, fatal errors). Используй ТОЛЬКО если знаешь, что делаешь.`,
  )) return;
  item.plan.phpVersion = defaultForcedPhp.value;
  item.plan.blockedReason = undefined;
  if (item.status === 'BLOCKED') item.status = 'PLANNED';
  if (!item.plan.warnings) item.plan.warnings = [];
  item.plan.warnings.push(
    `⚡ Force PHP ${defaultForcedPhp.value} (исходная версия ${item.plan.sourcePhpVersion} несовместима)`,
  );
  await savePlan(item);
  // По умолчанию выбираем сайт после force
  selectedItems.value.add(item.id);
  toast.success(`Force PHP ${defaultForcedPhp.value} применён к ${item.plan.newName}`);
}

async function doSkip(item: MigrationItem) {
  if (!discovery.value) return;
  if (!confirm(`Пропустить сайт ${item.plan.newName}?`)) return;
  try {
    await api.post(
      `/admin/migrate-hostpanel/${discovery.value.id}/items/${item.id}/skip`,
      {},
    );
    item.status = 'SKIPPED';
  } catch (e: unknown) {
    toast.error((e as Error).message || 'Не удалось пропустить');
  }
}

async function loadHistory() {
  try {
    history.value = await api.get('/admin/migrate-hostpanel');
    showHistory.value = true;
  } catch { toast.error('Не удалось загрузить историю'); }
}

async function loadMigration(id: string) {
  showHistory.value = false;
  try {
    const m = await api.get<Migration>(`/admin/migrate-hostpanel/${id}`);
    discovery.value = m;
    if (m.status === 'DISCOVERING') {
      step.value = 1; // ждём shortlist
    } else if (m.status === 'SHORTLIST_READY' || m.status === 'PROBING') {
      // Восстанавливаем галочки (если это reload страницы)
      for (const it of m.items) {
        if (it.status === 'PLANNED' && (it.plan as any).defaultSelected !== false) {
          selectedItems.value.add(it.id);
        }
      }
      step.value = 2;
    } else if (m.status === 'READY' || m.status === 'PARTIAL') {
      // Все non-SKIPPED items — выбраны
      for (const it of m.items) {
        if (it.status === 'PLANNED') selectedItems.value.add(it.id);
        rsyncExcludesText[it.id] = (it.plan.rsyncExtraExcludes || []).join('\n');
        dbExcludesText[it.id] = (it.plan.dbExcludeDataTables || []).join('\n');
      }
      step.value = 3;
      await loadSlavePhpVersions();
      await autoPickPhpForAllItems();
    } else {
      step.value = 4; // RUNNING/DONE/FAILED/CANCELLED
      // Если уже есть FAILED-item'ы — сразу спросим про leak'и для force-retry
      if (m.items.some((it) => it.status === 'FAILED')) {
        void refreshForceRetryChecks();
      }
      if (m.status === 'RUNNING') pollDiscovery();
    }
  } catch { toast.error('Не удалось загрузить миграцию'); }
}

function reset() {
  step.value = 1;
  discovery.value = null;
  selectedItems.value.clear();
  expandedItem.value = '';
  src.host = '';
  src.sshPassword = '';
  src.mysqlPassword = '';
}

onMounted(() => {
  // Если в URL есть ?id=... — открываем эту миграцию
  const route = useRoute();
  const id = route.query.id as string | undefined;
  if (id) loadMigration(id);
});

onUnmounted(() => {
  if (pollTimer) clearTimeout(pollTimer);
});
</script>

<style scoped>
.mh { max-width: 1280px; margin: 0 auto; padding: 1rem; }
.mh__header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 1.5rem; }
.mh__title { font-size: 1.5rem; font-weight: 700; color: var(--text-heading); margin: 0; }
.mh__subtitle { font-size: 0.85rem; color: var(--text-muted); margin-top: 0.2rem; }

.stepper { display: flex; gap: 1rem; margin-bottom: 1.5rem; }
.stepper__item { display: flex; align-items: center; gap: 0.5rem; opacity: 0.45; }
.stepper__item--active, .stepper__item--done { opacity: 1; }
.stepper__num {
  width: 28px; height: 28px; border-radius: 50%;
  background: var(--bg-input); border: 1px solid var(--border-strong);
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 0.8rem;
}
.stepper__item--active .stepper__num { background: var(--primary); color: #fff; border-color: var(--primary); }
.stepper__item--done .stepper__num { background: rgba(34, 197, 94, 0.3); }
.stepper__label { font-size: 0.85rem; font-weight: 500; }

.card {
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 14px; padding: 1.25rem; margin-bottom: 1rem;
}
.card__title { margin: 0 0 0.5rem 0; font-size: 1rem; font-weight: 700; color: var(--text-heading); }
.card__hint { font-size: 0.82rem; color: var(--text-muted); margin: 0 0 1rem 0; line-height: 1.5; }
.card__hint strong { color: var(--text-secondary); }
.card__actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1rem; }
.card__actions--space { justify-content: space-between; }

.form-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.85rem; margin-bottom: 1rem; }
.form-grid__divider {
  grid-column: 1 / -1;
  font-size: 0.78rem; font-weight: 600; color: var(--text-tertiary);
  padding-top: 0.5rem; padding-bottom: 0.25rem;
  border-top: 1px dashed var(--border);
  margin-top: 0.5rem;
}
.form-group { display: flex; flex-direction: column; gap: 0.3rem; }
.form-group--col2 { grid-column: span 2; }
.form-label { font-size: 0.72rem; font-weight: 500; color: var(--text-tertiary); }
.form-input {
  background: var(--bg-input); border: 1px solid var(--border-secondary);
  border-radius: 8px; padding: 0.5rem 0.75rem; font-size: 0.85rem;
  color: var(--text-primary); font-family: inherit;
}
.form-input:focus { outline: none; border-color: var(--primary); }

.btn { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.55rem 1.1rem; border-radius: 10px;
  border: none; font-size: 0.82rem; font-weight: 600; cursor: pointer; transition: all 0.18s ease; }
.btn--sm { padding: 0.4rem 0.8rem; font-size: 0.75rem; border-radius: 8px; }
.btn--primary {
  background: linear-gradient(135deg, var(--primary-light), var(--primary-dark));
  color: var(--primary-text-on);
  box-shadow: var(--shadow-button);
}
.btn--primary:hover:not(:disabled) { box-shadow: var(--shadow-button-hover); transform: translateY(-1px); }
.btn--primary:disabled { opacity: 0.45; cursor: not-allowed; }
.btn--ghost {
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  color: var(--text-secondary);
}
.btn--ghost:hover:not(:disabled) { background: var(--bg-surface-hover); color: var(--text-heading); }

.alert { padding: 0.65rem 0.85rem; border-radius: 10px; font-size: 0.82rem; margin-bottom: 0.75rem; }
.alert--error { background: var(--danger-bg); border: 1px solid var(--danger-border); color: var(--danger-light); }
.alert--warning { background: var(--primary-bg); border: 1px solid var(--primary-border); color: var(--primary-text); }
.alert__hint { width: 100%; font-size: 0.75rem; opacity: 0.75; margin-top: 0.4rem; }

.alert code { background: var(--bg-input); padding: 0.1rem 0.35rem; border-radius: 4px; font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; color: var(--text-secondary); }

.spinner {
  display: inline-block; width: 14px; height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.3); border-top-color: #fff;
  border-radius: 50%; animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ────── Source-meta как сетка карточек ────── */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.6rem;
  margin-bottom: 1rem;
}
.stat-card {
  display: flex; flex-direction: column; gap: 0.3rem;
  padding: 0.7rem 0.9rem;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow-card);
  min-width: 0;
}
.stat-card--wide { grid-column: span 2; }
@media (max-width: 768px) {
  .stat-card--wide { grid-column: span 1; }
}
.stat-card__label {
  font-size: 0.66rem;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
}
.stat-card__value {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-heading);
  display: flex; align-items: center; flex-wrap: wrap; gap: 0.35rem;
  word-break: break-word;
}
.stat-card__value--wrap { gap: 0.3rem; }
.stat-card__sep { font-size: 0.7rem; color: var(--text-muted); font-weight: 400; }
.stat-card__plus { color: var(--text-muted); font-weight: 400; margin: 0 0.1rem; }

/* ────── Manticore-плашка (нормально на обеих темах) ────── */
.manticore-banner {
  background: var(--primary-bg);
  border: 1px solid var(--primary-border);
  border-radius: 12px;
  padding: 0.8rem 1rem;
  margin-bottom: 1rem;
}
.manticore-banner__head {
  display: flex; align-items: center; gap: 0.5rem;
  color: var(--text-heading);
  font-size: 0.88rem;
}
.manticore-banner__icon { font-size: 1.05rem; }
.manticore-banner__chips { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.5rem; }
.manticore-banner__hint {
  font-size: 0.78rem; color: var(--text-secondary); margin: 0.55rem 0 0;
  line-height: 1.5;
}
.manticore-banner__hint code {
  background: var(--bg-input);
  padding: 0.05rem 0.3rem;
  border-radius: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
}

/* ────── Универсальный chip ────── */
.chip {
  display: inline-flex; align-items: center;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.74rem;
  padding: 0.15rem 0.5rem;
  border-radius: 6px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  white-space: nowrap;
}
.chip--info {
  background: var(--primary-bg);
  border-color: var(--primary-border);
  color: var(--primary-text);
}

.sites-table { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; margin-bottom: 1rem; }
.sites-table__head, .sites-table__row {
  display: grid; grid-template-columns: 36px 200px 220px 220px 60px 130px 130px;
  gap: 0.75rem; padding: 0.7rem 1rem; align-items: center;
}
.sites-table__head { background: var(--bg-input); font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
.sites-table__row { border-top: 1px solid var(--border); font-size: 0.82rem; transition: background 0.12s ease; }
.sites-table__row:hover { background: var(--bg-surface-hover); }
.sites-table__row--blocked { opacity: 0.6; background: var(--danger-bg); }
.sites-table__row--off { opacity: 0.55; }
.sites-table__row--expanded { background: var(--bg-input); }

/* Shortlist-таблица: чуть другая раскладка колонок (нет phpVersion отдельно,
   нет колонки status с force-php-кнопкой). 7 колонок: chk + source + domain
   + cms/php + db + size + status. */
.sites-table--shortlist .sites-table__head--shortlist,
.sites-table--shortlist .sites-table__row--shortlist {
  grid-template-columns: 36px 200px 1fr 180px 140px 110px 110px;
}
.sites-table__row--shortlist { cursor: pointer; }
.sites-table__row--shortlist .col__sub { font-size: 0.72rem; color: var(--text-muted); margin-top: 0.15rem; }

.col code { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; }
.col__sub { display: block; font-size: 0.7rem; color: var(--text-muted); margin-top: 0.1rem; }
.col__err { display: block; font-size: 0.7rem; color: var(--danger-light); margin-top: 0.1rem; }
.col__ok { display: inline-block; margin-left: 0.3rem; font-size: 0.85rem; color: var(--success-light); font-weight: 700; }
.col--check { display: flex; align-items: center; justify-content: center; }
.col__suggest { display: block; margin-top: 0.25rem; }
.col__suggest .btn { margin-right: 0.25rem; padding: 0.1rem 0.5rem; font-size: 0.7rem; }

/* Live-progress блок discovery — пока probe обходит источник */
.discover-live {
  margin-top: 1rem;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 0.85rem 1rem;
}
.discover-live__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}
.discover-live__title { font-weight: 700; font-size: 0.88rem; color: var(--text-heading); }
.discover-live__progress {
  font-size: 0.78rem; color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  background: var(--bg-input);
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
}
.discover-live__bar {
  height: 5px;
  background: var(--bar-bg);
  border-radius: 3px; overflow: hidden; margin-bottom: 0.7rem;
}
.discover-live__bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--primary-light), var(--primary-dark));
  transition: width 0.4s ease;
}
.discover-live__log {
  max-height: 320px;
  overflow-y: auto;
  font-family: 'JetBrains Mono', 'SF Mono', Menlo, monospace;
  font-size: 0.76rem;
  line-height: 1.55;
  background: var(--bg-input);
  padding: 0.6rem 0.8rem;
  border-radius: 8px;
  border: 1px solid var(--border);
}
.discover-live__line {
  display: flex;
  gap: 0.7rem;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-primary);
  padding: 0.05rem 0;
}
.discover-live__ts {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}
.discover-live__msg { flex: 1; }
.discover-live__empty { color: var(--text-muted); font-style: italic; }

.inline-input {
  width: 100%; background: var(--bg-input); border: 1px solid var(--border-secondary);
  border-radius: 6px; padding: 0.3rem 0.5rem; font-size: 0.78rem; font-family: inherit;
  color: var(--text-secondary);
}
.inline-input--invalid { border-color: var(--danger); box-shadow: 0 0 0 3px var(--danger-bg); }
.inline-input--ok { border-color: var(--success); }

.badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 5px; font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.badge--green { background: var(--success-bg); border: 1px solid var(--success-border); color: var(--success-light); }
.badge--red { background: var(--danger-bg); border: 1px solid var(--danger-border); color: var(--danger-light); }
.badge--yellow { background: var(--primary-bg); border: 1px solid var(--primary-border); color: var(--primary-text); }

/* ────── Кнопка-раскрывашка деталей сайта ────── */
.btn-expand {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px;
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  color: var(--text-tertiary);
  cursor: pointer;
  margin-left: 0.4rem;
  transition: all 0.15s ease;
  flex-shrink: 0;
}
.btn-expand:hover {
  background: var(--bg-surface-hover);
  border-color: var(--primary-border);
  color: var(--text-heading);
}
.btn-expand svg { transition: transform 0.18s ease; }
.btn-expand--open {
  background: var(--primary-bg);
  border-color: var(--primary-border);
  color: var(--primary-text);
}
.btn-expand--open svg { transform: rotate(180deg); }

.sites-table__details { padding: 1rem 1.25rem; background: var(--bg-elevated); border-top: 1px solid var(--border); }
.sites-table__details h4 {
  font-size: 0.85rem; font-weight: 700; color: var(--text-heading);
  margin: 1.1rem 0 0.4rem 0;
  display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
}
.sites-table__details h4:first-child { margin-top: 0; }
.sites-table__details h4 code {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  font-weight: 500;
  background: var(--bg-input);
  padding: 0.1rem 0.4rem;
  border-radius: 5px;
  color: var(--text-secondary);
}
.h4__count {
  font-size: 0.7rem;
  font-weight: 500;
  color: var(--text-muted);
  background: var(--bg-input);
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  text-transform: none;
  letter-spacing: 0;
}
.card__h3 { display: flex; align-items: center; gap: 0.6rem; margin: 0 0 0.4rem; font-size: 0.95rem; font-weight: 700; color: var(--text-heading); }

/* ────── Алиасы ────── */
.alias-input { display: flex; flex-wrap: wrap; gap: 0.45rem; align-items: center; }
.alias-input .form-input { flex: 1 1 200px; min-width: 200px; }
.alias-tag {
  display: inline-flex; align-items: center; gap: 0.35rem;
  padding: 0.25rem 0.55rem; border-radius: 7px;
  background: var(--primary-bg);
  border: 1px solid var(--primary-border);
  color: var(--primary-text);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.76rem;
  font-weight: 500;
}
.alias-tag button {
  background: none; border: none; color: inherit;
  cursor: pointer; font-size: 1rem; line-height: 1;
  padding: 0 0.1rem; opacity: 0.6;
}
.alias-tag button:hover { opacity: 1; }

/* ────── Список файлов хомдиры (вертикальный) ────── */
.file-list {
  display: flex; flex-direction: column; gap: 0;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  margin-top: 0.4rem;
}
.file-list__row {
  display: grid;
  grid-template-columns: 22px 24px 1fr 90px;
  gap: 0.65rem;
  align-items: center;
  padding: 0.5rem 0.85rem;
  font-size: 0.82rem;
  cursor: pointer;
  border-top: 1px solid var(--border);
  transition: background 0.12s ease;
}
.file-list__row:first-child { border-top: none; }
.file-list__row:hover { background: var(--bg-surface-hover); }
.file-list__row--off { opacity: 0.5; }
.file-list__row--off:hover { opacity: 0.75; }
.file-list__icon { font-size: 1rem; line-height: 1; text-align: center; }
.file-list__name {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.82rem;
  color: var(--text-primary);
  word-break: break-all;
}
.file-list__size {
  font-size: 0.72rem;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

/* ────── Cron-карточки (одна задача = одна карточка с командой на отдельной строке) ────── */
.cron-list { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.4rem; }
.cron-card {
  display: flex; flex-direction: column; gap: 0.4rem;
  padding: 0.6rem 0.8rem;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  transition: border-color 0.15s ease;
}
.cron-card:hover { border-color: var(--border-strong); }
.cron-card--off { opacity: 0.55; }
.cron-card--off:hover { opacity: 0.85; }
.cron-card__head {
  display: flex; align-items: center; gap: 0.55rem; flex-wrap: wrap;
}
.cron-card__schedule {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--primary-text);
  background: var(--primary-bg);
  border: 1px solid var(--primary-border);
  padding: 0.2rem 0.5rem;
  border-radius: 6px;
  white-space: nowrap;
}
.cron-card__cmd {
  margin: 0;
  padding: 0.5rem 0.65rem;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.74rem;
  line-height: 1.55;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  overflow-x: auto;
}

/* ────── Текстарии (rsync/db excludes) ────── */
.form-textarea {
  display: block;
  width: 100%;
  background: var(--bg-input);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  padding: 0.65rem 0.8rem;
  font-size: 0.85rem;
  color: var(--text-primary);
  font-family: inherit;
  line-height: 1.55;
  resize: vertical;
  min-height: 80px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.form-textarea:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: var(--focus-ring);
}
.form-textarea--mono {
  font-family: 'JetBrains Mono', 'SF Mono', Menlo, monospace;
  font-size: 0.78rem;
}
.form-textarea::placeholder { color: var(--text-placeholder); }

/* ────── form-select (общий выпадайщик) ────── */
.form-select {
  background: var(--select-bg);
  border: 1px solid var(--border-secondary);
  border-radius: 8px;
  padding: 0.35rem 0.6rem;
  font-size: 0.78rem;
  color: var(--text-primary);
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.15s ease;
}
.form-select:hover { border-color: var(--border-strong); }
.form-select:focus { outline: none; border-color: var(--primary); }
.form-select--sm { padding: 0.25rem 0.5rem; font-size: 0.74rem; border-radius: 6px; }

/* ────── Чекбоксы (унифицированный стиль через accent-color) ────── */
.mh-check {
  width: 16px; height: 16px;
  margin: 0;
  cursor: pointer;
  accent-color: var(--primary);
  flex-shrink: 0;
}
.mh-check:disabled { cursor: not-allowed; opacity: 0.45; }

.check-row {
  display: inline-flex; align-items: center; gap: 0.55rem;
  font-size: 0.85rem;
  color: var(--text-primary);
  margin: 0.5rem 0;
  cursor: pointer;
  user-select: none;
}
.check-row:has(input:disabled) { cursor: not-allowed; opacity: 0.55; }

/* Домены в SSL-серте — chips с зазорами, чтобы не слипались */
.domain-chips { display: inline-flex; flex-wrap: wrap; gap: 0.3rem; margin-left: 0.3rem; vertical-align: middle; }
.domain-chips .chip { font-size: 0.72rem; }

.hint { font-size: 0.78rem; color: var(--text-tertiary); line-height: 1.5; margin: 0.3rem 0 0.6rem; }
.hint--inline { margin-top: 0; margin-bottom: 0.5rem; }
.hint code {
  background: var(--bg-input);
  padding: 0.05rem 0.3rem;
  border-radius: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  color: var(--text-secondary);
}

.step3__header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
.step3__controls { display: flex; gap: 0.4rem; flex-wrap: wrap; }
.overall-progress { display: flex; align-items: center; gap: 0.6rem; margin-top: 0.6rem; }
.overall-progress__bar { flex: 1; height: 8px; background: var(--bg-input); border-radius: 4px; overflow: hidden; }
.overall-progress__bar > span { display: block; height: 100%; background: linear-gradient(90deg, #34d399, #059669); transition: width 0.3s; }
.overall-progress__label { font-weight: 600; font-size: 0.78rem; color: var(--text-secondary); min-width: 3rem; text-align: right; }
.btn--danger { background: var(--danger-bg); border: 1px solid var(--danger-border); color: var(--danger-light); }
.btn--danger:hover { background: var(--danger-bg); border-color: var(--danger); color: var(--danger); }

/* btn--warning — амбер, в стиле alert--warning. Раньше класса не было,
   и кнопка «🧹 Очистить и повторить» рендерилась с белым фоном. */
.btn--warning {
  background: var(--primary-bg);
  border: 1px solid var(--primary-border);
  color: var(--primary-text);
  display: inline-flex; align-items: center; gap: 0.35rem;
}
.btn--warning:hover:not(:disabled) {
  background: var(--primary-bg-hover);
  border-color: var(--primary);
}
.btn--warning:disabled { opacity: 0.5; cursor: not-allowed; }

/* PHP picker block в expanded details (шаг 3) */
.php-pick { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 0.85rem; }
.php-pick__row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; font-size: 0.82rem; }
.php-pick__k { color: var(--text-muted); min-width: 200px; }
.php-pick__missing { font-size: 0.82rem; }
.php-pick__missing strong { display: block; margin-bottom: 0.25rem; }
.php-pick__missing p { margin: 0; line-height: 1.5; opacity: 0.9; }
.link { color: var(--primary-text); text-decoration: underline; text-underline-offset: 2px; }
.link:hover { filter: brightness(1.15); }
.run-card__status { font-style: normal; font-size: 0.65rem; padding: 0.1rem 0.4rem; border-radius: 4px; background: var(--bg-input); color: var(--text-muted); margin-left: 0.4rem; }
.run-card__http { font-style: normal; font-size: 0.65rem; padding: 0.1rem 0.4rem; border-radius: 4px; margin-left: 0.3rem; background: var(--bg-input); color: var(--text-muted); }
.run-card__http--ok { background: var(--success-bg); color: var(--success-light); }
.run-card__http--err { background: var(--danger-bg); color: var(--danger-light); }
.run-card__actions { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-top: 0.6rem; padding-top: 0.6rem; border-top: 1px solid var(--border); }
.run-card__actions a, .run-card__actions button { text-decoration: none; }
.run-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; padding: 0.85rem; margin-bottom: 0.5rem; }
.run-card--done { border-color: rgba(34, 197, 94, 0.3); }
.run-card--failed { border-color: rgba(239, 68, 68, 0.3); }
.run-card--running { border-color: rgba(var(--primary-rgb), 0.3); }
.run-card__head { display: grid; grid-template-columns: 1fr 1fr 1fr 60px; gap: 0.5rem; font-size: 0.82rem; align-items: center; margin-bottom: 0.4rem; }
.run-card__name { font-weight: 600; }
.run-card__domain { color: var(--text-muted); }
.run-card__stage { font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; color: var(--text-tertiary); }
.run-card__pct { text-align: right; font-weight: 600; color: var(--primary); }
.run-card__bar { background: var(--bg-input); height: 4px; border-radius: 2px; overflow: hidden; margin-bottom: 0.4rem; position: relative; }
.run-card__bar > span { display: block; height: 100%; background: linear-gradient(90deg, var(--primary-light), var(--primary-dark)); transition: width 0.3s; }
/* spec §5.3 pulse: для не-rsync стейджей — индикативная анимация без точного процента */
.run-card__bar--pulse::after {
  content: ''; position: absolute; top: 0; left: -30%; width: 30%; height: 100%;
  background: linear-gradient(90deg, transparent, rgba(var(--primary-light-rgb), 0.7), transparent);
  animation: mb-bar-pulse 1.4s ease-in-out infinite;
}
@keyframes mb-bar-pulse {
  0%   { left: -30%; }
  100% { left: 100%; }
}
.run-card__log summary { cursor: pointer; font-size: 0.72rem; color: var(--text-muted); }

.alert__actions { margin-top: 0.5rem; display: flex; gap: 0.4rem; }
.checkbox-row { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.78rem; color: var(--text-secondary); margin: 0.5rem 0; cursor: pointer; }
.fpm-preview { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem 0.85rem; padding: 0.5rem 0; }
.fpm-preview__row { display: flex; justify-content: space-between; align-items: center; padding: 0.3rem 0.5rem; border-radius: 6px; background: var(--bg-surface); font-size: 0.78rem; }
.fpm-preview__row--full { grid-column: 1 / -1; flex-direction: column; align-items: stretch; }
.fpm-preview__k { color: var(--text-muted); font-size: 0.72rem; }
.fpm-preview__custom { margin: 0.3rem 0 0; padding: 0.4rem 0.5rem; background: var(--bg-input); border-radius: 4px; font-family: 'JetBrains Mono', monospace; font-size: 0.7rem; max-height: 160px; overflow: auto; white-space: pre-wrap; }
.run-card__log pre { margin: 0.4rem 0 0; padding: 0.5rem 0.65rem; background: var(--bg-input); border-radius: 6px; font-family: 'JetBrains Mono', monospace; font-size: 0.7rem; max-height: 280px; overflow: auto; white-space: pre-wrap; word-break: break-all; }

.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(4px); z-index: 200; display: flex; align-items: center; justify-content: center; padding: 1rem; }
.modal { background: var(--bg-modal-gradient); border: 1px solid var(--border-secondary); border-radius: 14px; padding: 1.25rem; width: 100%; max-width: 480px; }
.modal--wide { max-width: 720px; }
.modal__title { font-size: 1rem; font-weight: 700; color: var(--text-heading); margin: 0 0 1rem; }
.modal__actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1rem; }

.history-list { display: flex; flex-direction: column; gap: 0.4rem; }
.history-row { display: grid; grid-template-columns: 80px 1fr 1fr 100px; align-items: center; gap: 0.5rem; padding: 0.55rem 0.7rem; border-radius: 8px; background: var(--bg-input); font-size: 0.82rem; }

@media (max-width: 1100px) {
  .sites-table__head, .sites-table__row { grid-template-columns: 32px 1fr 1fr 1fr 50px 110px 110px; }
}
@media (max-width: 768px) {
  .form-grid { grid-template-columns: 1fr; }
  .form-group--col2 { grid-column: span 1; }
}

/* ────── Saved sources list ────── */
.saved-sources {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 0.85rem 1rem;
  margin-bottom: 1rem;
}
.saved-sources__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 0.65rem;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.saved-sources__title {
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--text-heading);
}
.saved-sources__hint {
  font-size: 0.72rem;
  color: var(--text-muted);
}
.saved-sources__list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 0.5rem;
}
.saved-source {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.65rem 0.85rem;
  padding-right: 1.85rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  text-align: left;
  cursor: pointer;
  transition: all 0.18s ease;
  font-family: inherit;
  color: var(--text-primary);
}
.saved-source:hover {
  border-color: var(--primary);
  background: var(--bg-surface-hover);
  transform: translateY(-1px);
}
.saved-source--active {
  border-color: var(--primary);
  background: var(--primary-bg);
  box-shadow: 0 0 0 2px var(--primary-border) inset;
}
.saved-source__main {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.saved-source__name {
  font-size: 0.88rem;
  font-weight: 700;
  color: var(--text-heading);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.saved-source__addr {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.saved-source__meta {
  display: flex;
  justify-content: space-between;
  font-size: 0.7rem;
  color: var(--text-muted);
  gap: 0.4rem;
}
.saved-source__db {
  font-family: 'JetBrains Mono', monospace;
}
.saved-source__last {
  white-space: nowrap;
}
.saved-source__delete {
  position: absolute;
  top: 0.35rem;
  right: 0.5rem;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 1.05rem;
  line-height: 1;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
  transition: all 0.15s ease;
}
.saved-source__delete:hover {
  background: var(--danger-bg);
  color: var(--danger-light);
}

/* ────── Form sections (SSH/MySQL grouping) ────── */
.form-section {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 0.9rem 1rem;
  margin-bottom: 0.85rem;
}
.form-section__head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.7rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px dashed var(--border);
}
.form-section__icon {
  font-size: 0.95rem;
}
.form-section__title {
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--text-heading);
  letter-spacing: 0.02em;
}
.form-section .form-grid {
  margin-bottom: 0;
}

.form-label__hint {
  font-size: 0.68rem;
  font-weight: 500;
  color: var(--success-light, #4ade80);
  margin-left: 0.4rem;
}

/* ────── Save preset modal ────── */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}
.modal {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 1.5rem;
  max-width: 420px;
  width: 100%;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
}
.modal__title {
  margin: 0 0 0.5rem 0;
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--text-heading);
}
.modal__hint {
  font-size: 0.82rem;
  color: var(--text-muted);
  margin: 0 0 1rem 0;
  line-height: 1.5;
}
.modal__actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  margin-top: 1.25rem;
}
</style>
