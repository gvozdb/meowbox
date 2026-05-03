<template>
  <div class="servers-page">
    <div class="servers-page__header">
      <div>
        <h1 class="servers-page__title">Серверы</h1>
        <p class="servers-page__subtitle">Управление подключёнными серверами</p>
      </div>
      <div class="servers-page__actions">
        <button
          class="servers-page__btn servers-page__btn--primary"
          @click="openAddModal"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Добавить сервер
        </button>
        <button
          class="servers-page__btn servers-page__btn--provision"
          @click="openProvisionModal"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2" /><rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
            <line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
          </svg>
          Провизия
        </button>
        <button
          class="servers-page__btn servers-page__btn--refresh"
          :disabled="refreshing"
          @click="refresh"
        >
          <svg v-if="!refreshing" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <polyline points="23,4 23,10 17,10" /><path d="M20.49,15a9,9,0,1,1-2.12-9.36L23,10" />
          </svg>
          <span v-if="refreshing" class="servers-page__spinner" />
          {{ refreshing ? 'Обновление...' : 'Обновить' }}
        </button>
        <button
          v-if="serverStore.servers.length > 0"
          class="servers-page__btn servers-page__btn--update"
          :disabled="updating || selectedIds.size === 0"
          :title="selectedIds.size === 0 ? 'Выбери серверы галкой на карточке' : `Обновить ${selectedIds.size} серверов`"
          @click="openBulkUpdateModal"
        >
          <svg v-if="!updating" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <polyline points="16,16 12,12 8,16" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
          </svg>
          <span v-if="updating" class="servers-page__spinner" />
          {{ updating ? 'Обновление...' : `Обновить выбранные${selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}` }}
        </button>
      </div>
    </div>

    <!-- Loading state -->
    <div v-if="serverStore.loading && serverStore.servers.length === 0" class="servers-page__loading">
      <div class="servers-page__spinner servers-page__spinner--lg" />
      <p>Загрузка серверов...</p>
    </div>

    <!-- Empty state -->
    <div v-else-if="serverStore.servers.length === 0" class="servers-page__empty">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" style="opacity:0.25">
        <rect x="2" y="2" width="20" height="8" rx="2" ry="2" /><rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
        <line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
      </svg>
      <p class="servers-page__empty-text">Серверы не настроены</p>
      <p class="servers-page__empty-hint">Добавьте сервер вручную или настройте через SSH</p>
    </div>

    <!-- Server cards -->
    <template v-else>
      <h2 class="servers-page__section-title">
        Подключённые серверы
        <span class="servers-page__badge">{{ serverStore.servers.length }}</span>
        <span v-if="selectedIds.size > 0" class="servers-page__selection">
          выбрано: {{ selectedIds.size }}
          <button class="servers-page__selection-clear" @click="clearSelection">сбросить</button>
        </span>
      </h2>
      <div class="servers-grid">
        <div
          v-for="server in serverStore.servers"
          :key="server.id"
          class="server-card"
          :class="{
            'server-card--selected': server.id === serverStore.currentServerId,
            'server-card--checked': selectedIds.has(server.id),
            'server-card--has-update': server.hasUpdate,
          }"
        >
          <div class="server-card__header">
            <label class="server-card__checkbox" :title="server.online ? 'Выбрать для массового обновления' : 'Сервер офлайн'">
              <input
                type="checkbox"
                :checked="selectedIds.has(server.id)"
                :disabled="!server.online"
                @change="toggleSelected(server.id)"
              />
              <span class="server-card__checkbox-mark" />
            </label>
            <div class="server-card__status" :class="server.online ? 'server-card__status--online' : 'server-card__status--offline'" />
            <span class="server-card__name">{{ server.name }}</span>
            <span v-if="server.hasUpdate" class="server-card__update-badge" :title="`Доступна ${server.latestVersion}`">
              <span class="server-card__update-dot" />
              update
            </span>
            <div class="server-card__actions">
              <button class="server-card__action" title="Edit" @click="openEditModal(server)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </button>
              <button class="server-card__action server-card__action--danger" title="Delete" @click="confirmDelete(server)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
              </button>
            </div>
          </div>
          <div class="server-card__details">
            <div class="server-card__row">
              <span class="server-card__label">Статус</span>
              <span class="server-card__value" :class="server.online ? 'server-card__value--online' : 'server-card__value--offline'">
                {{ server.online ? 'Онлайн' : 'Офлайн' }}
              </span>
            </div>
            <div class="server-card__row">
              <span class="server-card__label">URL</span>
              <span class="server-card__value server-card__value--mono">{{ server.url }}</span>
            </div>
            <div v-if="server.version" class="server-card__row">
              <span class="server-card__label">Версия</span>
              <span class="server-card__value server-card__value--mono">
                {{ server.version }}
                <span v-if="server.hasUpdate && server.latestVersion" class="server-card__version-arrow">→ {{ server.latestVersion }}</span>
              </span>
            </div>
            <div v-if="!server.online && server.lastError" class="server-card__row">
              <span class="server-card__label">Ошибка</span>
              <span class="server-card__value server-card__value--error" :title="server.lastError">{{ truncate(server.lastError, 40) }}</span>
            </div>
            <div class="server-card__row">
              <span class="server-card__label">Гамма</span>
              <div class="server-card__palette">
                <button
                  v-for="opt in paletteOptions"
                  :key="opt.id"
                  type="button"
                  class="palette-swatch"
                  :class="[
                    `palette-swatch--${opt.id}`,
                    { 'palette-swatch--active': serverPalettes[server.id] === opt.id },
                  ]"
                  :disabled="paletteSavingId === server.id"
                  :title="opt.label"
                  @click="changeServerPalette(server, opt.id)"
                >
                  <svg v-if="serverPalettes[server.id] === opt.id" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                </button>
                <span v-if="paletteSavingId === server.id" class="server-card__palette-spinner" />
              </div>
            </div>
          </div>
          <button
            class="server-card__select"
            :class="{ 'server-card__select--active': server.id === serverStore.currentServerId }"
            @click="selectServer(server.id)"
          >
            {{ server.id === serverStore.currentServerId ? 'Выбран' : 'Выбрать' }}
          </button>
        </div>
      </div>
    </template>

    <!-- Update results -->
    <div v-if="updateResults.length > 0" class="results-section">
      <div class="results-section__header">
        <h2 class="servers-page__section-title" style="margin-bottom: 0">Результаты обновления</h2>
        <button class="results-section__clear" @click="updateResults = []">Очистить</button>
      </div>
      <div class="results-list">
        <div
          v-for="result in updateResults"
          :key="result.id"
          class="result-item"
          :class="result.success ? 'result-item--success' : 'result-item--fail'"
        >
          <div class="result-item__indicator" />
          <div class="result-item__info">
            <span class="result-item__name">{{ result.name }}</span>
            <span v-if="result.error" class="result-item__error">{{ result.error }}</span>
          </div>
          <span class="result-item__status">{{ result.success ? 'Обновлён' : 'Ошибка' }}</span>
        </div>
      </div>
    </div>

    <!-- Add/Edit Server Modal -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showServerModal" class="modal-overlay" @mousedown.self="closeServerModal">
          <div class="modal">
            <div class="modal__header">
              <h3 class="modal__title">{{ editingServer ? 'Редактирование сервера' : 'Добавление сервера' }}</h3>
              <button class="modal__close" @click="closeServerModal">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <form class="modal__body" @submit.prevent="submitServer">
              <div class="modal__field">
                <label class="modal__label">Название</label>
                <input
                  v-model="serverForm.name"
                  class="modal__input"
                  type="text"
                  placeholder="Frankfurt #1"
                  required
                />
              </div>
              <div class="modal__field">
                <label class="modal__label">URL</label>
                <input
                  v-model="serverForm.url"
                  class="modal__input modal__input--mono"
                  type="url"
                  placeholder="http://10.0.0.5:3000"
                  required
                />
              </div>
              <div class="modal__field">
                <label class="modal__label">Токен</label>
                <input
                  v-model="serverForm.token"
                  class="modal__input modal__input--mono"
                  type="text"
                  placeholder="Токен авторизации прокси"
                  :required="!editingServer"
                />
                <span v-if="editingServer" class="modal__hint">Оставьте пустым, чтобы сохранить текущий токен</span>
              </div>
              <div v-if="serverFormError" class="modal__error">{{ serverFormError }}</div>
              <div class="modal__actions">
                <button type="button" class="modal__btn modal__btn--cancel" @click="closeServerModal">Отмена</button>
                <button type="submit" class="modal__btn modal__btn--submit" :disabled="serverFormLoading">
                  <span v-if="serverFormLoading" class="servers-page__spinner" />
                  {{ serverFormLoading ? 'Сохранение...' : (editingServer ? 'Сохранить' : 'Добавить') }}
                </button>
              </div>
            </form>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- Delete Confirm Modal -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showDeleteModal" class="modal-overlay" @mousedown.self="closeDeleteModal">
          <div class="modal modal--sm">
            <div class="modal__header">
              <h3 class="modal__title">Удаление сервера</h3>
              <button class="modal__close" @click="closeDeleteModal">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div class="modal__body">
              <p class="modal__confirm-text">
                Удалить сервер <strong>{{ deletingServer?.name }}</strong>? Это действие необратимо.
              </p>
              <div v-if="deleteError" class="modal__error">{{ deleteError }}</div>
              <div class="modal__actions">
                <button class="modal__btn modal__btn--cancel" @click="closeDeleteModal">Отмена</button>
                <button class="modal__btn modal__btn--danger" :disabled="deleteLoading" @click="executeDelete">
                  <span v-if="deleteLoading" class="servers-page__spinner" />
                  {{ deleteLoading ? 'Удаление...' : 'Удалить' }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- Provision Modal -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showProvisionModal" class="modal-overlay" @mousedown.self="!provisionLoading && closeProvisionModal()">
          <div class="modal modal--lg">
            <div class="modal__header">
              <h3 class="modal__title">Провизия сервера</h3>
              <button v-if="!provisionLoading" class="modal__close" @click="closeProvisionModal">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <form v-if="!provisionStarted" class="modal__body" @submit.prevent="startProvision">
              <p class="modal__desc">Подключение к серверу по SSH и автоматическая установка Meowbox.</p>
              <div class="modal__field">
                <label class="modal__label">Имя сервера</label>
                <input
                  v-model="provisionForm.name"
                  class="modal__input"
                  type="text"
                  placeholder="Frankfurt #1"
                  required
                />
              </div>
              <div class="modal__row">
                <div class="modal__field modal__field--grow">
                  <label class="modal__label">Хост (IP)</label>
                  <input
                    v-model="provisionForm.host"
                    class="modal__input modal__input--mono"
                    type="text"
                    placeholder="10.0.0.5"
                    required
                  />
                </div>
                <div class="modal__field modal__field--port">
                  <label class="modal__label">Порт</label>
                  <input
                    v-model.number="provisionForm.port"
                    class="modal__input modal__input--mono"
                    type="number"
                    min="1"
                    max="65535"
                  />
                </div>
              </div>
              <div class="modal__field">
                <label class="modal__label">Root-пароль</label>
                <input
                  v-model="provisionForm.password"
                  class="modal__input modal__input--mono"
                  type="password"
                  placeholder="SSH root-пароль"
                  required
                />
              </div>
              <div v-if="provisionError" class="modal__error">{{ provisionError }}</div>
              <div class="modal__actions">
                <button type="button" class="modal__btn modal__btn--cancel" @click="closeProvisionModal">Отмена</button>
                <button type="submit" class="modal__btn modal__btn--submit">
                  Начать провизию
                </button>
              </div>
            </form>
            <div v-else class="modal__body">
              <div class="provision-log">
                <div class="provision-log__header">
                  <span v-if="provisionLoading" class="provision-log__status provision-log__status--running">
                    <span class="servers-page__spinner" />
                    Установка...
                  </span>
                  <span v-else-if="provisionResult?.online" class="provision-log__status provision-log__status--done">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                    Готово
                  </span>
                  <span v-else class="provision-log__status provision-log__status--warn">
                    Завершено (серверу может понадобиться время для запуска)
                  </span>
                </div>
                <div ref="logContainer" class="provision-log__output">
                  <div v-for="(line, i) in provisionLogs" :key="i" class="provision-log__line">
                    <span class="provision-log__prefix">$</span> {{ line }}
                  </div>
                  <div v-if="provisionLoading" class="provision-log__cursor" />
                </div>
              </div>
              <div v-if="provisionError" class="modal__error">{{ provisionError }}</div>
              <div class="modal__actions">
                <button
                  class="modal__btn modal__btn--cancel"
                  :disabled="provisionLoading"
                  @click="closeProvisionModal"
                >
                  {{ provisionLoading ? 'Выполнение...' : 'Закрыть' }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- Bulk Update Modal -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showBulkUpdateModal" class="modal-overlay" @mousedown.self="!updating && closeBulkUpdateModal()">
          <div class="modal modal--lg">
            <div class="modal__header">
              <h3 class="modal__title">Массовое обновление панели</h3>
              <button v-if="!updating" class="modal__close" @click="closeBulkUpdateModal">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div class="modal__body">
              <p class="modal__desc">
                Будет обновлено <strong>{{ selectedServers.length }}</strong> серверов.
                Целевая версия должна быть строго выше максимальной текущей —
                downgrade запрещён, чтобы не сломать БД-миграции.
              </p>

              <div class="bulk-targets">
                <div
                  v-for="srv in selectedServers"
                  :key="srv.id"
                  class="bulk-targets__item"
                  :class="{ 'bulk-targets__item--offline': !srv.online }"
                >
                  <span class="bulk-targets__indicator" :class="srv.online ? 'bulk-targets__indicator--online' : 'bulk-targets__indicator--offline'" />
                  <span class="bulk-targets__name">{{ srv.name }}</span>
                  <span class="bulk-targets__current">{{ srv.version || '?' }}</span>
                </div>
              </div>

              <div v-if="maxCurrentVersion" class="bulk-info">
                Максимальная текущая версия среди выбранных: <strong>{{ maxCurrentVersion }}</strong>
              </div>

              <div class="modal__field">
                <label class="modal__label">Целевая версия</label>
                <select v-model="bulkTargetVersion" class="modal__input modal__input--mono" :disabled="updating">
                  <option value="" disabled>— выбери из списка релизов —</option>
                  <option
                    v-for="t in availableTags"
                    :key="t.tag"
                    :value="t.tag"
                    :disabled="!isVersionAllowed(t.tag)"
                  >
                    {{ t.tag }}{{ t.prerelease ? ' (prerelease)' : '' }}{{ !isVersionAllowed(t.tag) ? ' — недоступно (≤ текущей)' : '' }}
                  </option>
                </select>
                <span class="modal__hint">
                  Список релизов взят с GitHub.
                  <button type="button" class="modal__inline-btn" :disabled="loadingTags" @click="loadTags(true)">
                    {{ loadingTags ? 'обновление...' : 'обновить' }}
                  </button>
                </span>
              </div>

              <div v-if="bulkUpdateError" class="modal__error">{{ bulkUpdateError }}</div>

              <div class="modal__actions">
                <button class="modal__btn modal__btn--cancel" :disabled="updating" @click="closeBulkUpdateModal">Отмена</button>
                <button
                  class="modal__btn modal__btn--submit"
                  :disabled="updating || !bulkTargetVersion || !isVersionAllowed(bulkTargetVersion)"
                  @click="executeBulkUpdate"
                >
                  <span v-if="updating" class="servers-page__spinner" />
                  {{ updating ? 'Запуск обновления...' : `Обновить ${selectedServers.length} сервер(ов) до ${bulkTargetVersion || '?'}` }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

  </div>
</template>

<script setup lang="ts">
import type { PaletteId } from '~/composables/usePalette';

definePageMeta({ middleware: 'auth' });

interface ServerInfo {
  id: string;
  name: string;
  url: string;
  token: string;
  online: boolean;
  version?: string;
  latestVersion?: string | null;
  hasUpdate?: boolean;
  lastCheckedAt?: string;
  lastError?: string;
}

interface UpdateResult {
  id: string;
  name: string;
  success: boolean;
  error?: string;
}

interface ReleaseTag {
  tag: string;
  publishedAt: string | null;
  prerelease: boolean;
}

function compareSemver(a: string, b: string): number {
  const norm = (v: string) => v.replace(/^v/i, '').split(/[.-]/);
  const aa = norm(a);
  const bb = norm(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const ai = aa[i] ?? '0';
    const bi = bb[i] ?? '0';
    const an = Number(ai);
    const bn = Number(bi);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      if (an !== bn) return an < bn ? -1 : 1;
    } else {
      if (ai !== bi) return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const api = useApi();
const serverStore = useServerStore();
const {
  options: paletteOptions,
  setForServer: setPaletteForServer,
  updateCache: updatePaletteCache,
  loadAllFromApi: loadAllPalettesFromApi,
  saveToApi: savePaletteToApi,
} = usePalette();

const refreshing = ref(false);

// ── Палитра per-server ─────────────────────────────────────────────────────
// reactive map: { serverId → palette id (или null если ещё не загрузили) }
const serverPalettes = reactive<Record<string, PaletteId | null>>({});
const paletteSavingId = ref<string | null>(null);

/**
 * Подтягиваем карту палитр всех серверов с мастера одним запросом.
 * Бэк хранит { palettes: { serverId → palette } } в master-локальной БД,
 * slave при этом не дёргается совсем (см. usePalette.loadAllFromApi).
 */
async function loadAllPalettes() {
  const map = await loadAllPalettesFromApi(api);
  for (const s of serverStore.servers) {
    serverPalettes[s.id] = map[s.id] ?? null;
  }
}

/**
 * Меняет палитру сервера. PUT на мастер (NOT через proxy). Обновляет local map
 * и cache. Если сервер сейчас активен — применяет класс на html сразу.
 */
async function changeServerPalette(server: ServerInfo, palette: PaletteId) {
  if (serverPalettes[server.id] === palette) return;
  paletteSavingId.value = server.id;
  try {
    const map = await savePaletteToApi(api, server.id, palette);
    if (!map) {
      showStatus('Не удалось сохранить гамму', true);
      return;
    }
    const next = map[server.id] || palette;
    serverPalettes[server.id] = next;
    if (server.id === serverStore.currentServerId) {
      // Применяем мгновенно с transition.
      setPaletteForServer(server.id, next, /* withTransition */ true);
    } else {
      updatePaletteCache(server.id, next);
    }
    showStatus(`«${server.name}»: гамма «${paletteOptions.find((o) => o.id === next)?.label}»`);
  } finally {
    paletteSavingId.value = null;
  }
}
const updating = ref(false);
const updateResults = ref<UpdateResult[]>([]);

// ── Selection (для массового обновления) ──
const selectedIds = ref<Set<string>>(new Set());

function toggleSelected(id: string) {
  // Хитрость с Set: чтобы Vue реактивно перерисовывал — пересоздаём Set.
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

function clearSelection() {
  selectedIds.value = new Set();
}

const selectedServers = computed(() =>
  serverStore.servers.filter((s: ServerInfo) => selectedIds.value.has(s.id)),
);

const maxCurrentVersion = computed(() => {
  const versions = selectedServers.value
    .map((s) => s.version)
    .filter((v): v is string => !!v && v !== 'unknown');
  if (versions.length === 0) return null;
  return versions.reduce((a, b) => (compareSemver(a, b) >= 0 ? a : b));
});

function isVersionAllowed(tag: string): boolean {
  if (!maxCurrentVersion.value) return true;
  return compareSemver(tag, maxCurrentVersion.value) > 0;
}

// ── Bulk update modal ──
const showBulkUpdateModal = ref(false);
const bulkTargetVersion = ref('');
const bulkUpdateError = ref('');
const availableTags = ref<ReleaseTag[]>([]);
const loadingTags = ref(false);

async function loadTags(refresh = false) {
  loadingTags.value = true;
  try {
    const tags = await api.get<ReleaseTag[]>(`/admin/update/tags${refresh ? '?refresh=1' : ''}`);
    availableTags.value = tags || [];
  } catch (err) {
    console.warn('loadTags failed:', err);
  } finally {
    loadingTags.value = false;
  }
}

async function openBulkUpdateModal() {
  bulkTargetVersion.value = '';
  bulkUpdateError.value = '';
  showBulkUpdateModal.value = true;
  // Подгружаем теги при открытии (если кеш пустой).
  if (availableTags.value.length === 0) {
    await loadTags(false);
  }
  // Авто-выбор первого подходящего тега.
  const firstAllowed = availableTags.value.find((t) => !t.prerelease && isVersionAllowed(t.tag));
  if (firstAllowed) bulkTargetVersion.value = firstAllowed.tag;
}

function closeBulkUpdateModal() {
  if (updating.value) return;
  showBulkUpdateModal.value = false;
}

async function executeBulkUpdate() {
  if (!bulkTargetVersion.value) return;
  if (!isVersionAllowed(bulkTargetVersion.value)) {
    bulkUpdateError.value = `Версия ${bulkTargetVersion.value} не выше максимальной текущей (${maxCurrentVersion.value}).`;
    return;
  }
  updating.value = true;
  bulkUpdateError.value = '';
  updateResults.value = [];
  try {
    const data = await api.post<{ version: string; results: UpdateResult[] }>('/servers/update-bulk', {
      serverIds: Array.from(selectedIds.value),
      version: bulkTargetVersion.value,
    });
    updateResults.value = data?.results || [];
    showStatus(`Обновление запущено на ${updateResults.value.filter((r) => r.success).length}/${updateResults.value.length} серверов`);
    closeBulkUpdateModal();
    clearSelection();
    // Подождём чуть и обновим статусы — slave запустит update.sh в фоне.
    setTimeout(() => serverStore.loadServers(), 5000);
  } catch (err: unknown) {
    bulkUpdateError.value = (err as Error).message || 'Ошибка массового обновления';
  } finally {
    updating.value = false;
  }
}

// Status toast
const mbToast = useMbToast();
function showStatus(msg: string, isError = false) {
  if (isError) mbToast.error(msg);
  else mbToast.success(msg);
}

// ── Add/Edit Modal ──

const showServerModal = ref(false);
const editingServer = ref<ServerInfo | null>(null);
const serverForm = reactive({ name: '', url: '', token: '' });
const serverFormError = ref('');
const serverFormLoading = ref(false);

function openAddModal() {
  editingServer.value = null;
  serverForm.name = '';
  serverForm.url = '';
  serverForm.token = '';
  serverFormError.value = '';
  showServerModal.value = true;
}

function openEditModal(server: ServerInfo) {
  editingServer.value = server;
  serverForm.name = server.name;
  serverForm.url = server.url;
  serverForm.token = '';
  serverFormError.value = '';
  showServerModal.value = true;
}

function closeServerModal() {
  showServerModal.value = false;
}

async function submitServer() {
  serverFormLoading.value = true;
  serverFormError.value = '';
  try {
    if (editingServer.value) {
      const data: Record<string, string> = {};
      if (serverForm.name !== editingServer.value.name) data.name = serverForm.name;
      if (serverForm.url !== editingServer.value.url) data.url = serverForm.url;
      if (serverForm.token) data.token = serverForm.token;
      await serverStore.updateServer(editingServer.value.id, data);
      showStatus('Сервер обновлён');
    } else {
      await serverStore.addServer({
        name: serverForm.name,
        url: serverForm.url,
        token: serverForm.token,
      });
      showStatus('Сервер добавлен');
    }
    closeServerModal();
  } catch (err: unknown) {
    serverFormError.value = (err as Error).message || 'Ошибка сохранения сервера';
  } finally {
    serverFormLoading.value = false;
  }
}

// ── Delete Modal ──

const showDeleteModal = ref(false);
const deletingServer = ref<ServerInfo | null>(null);
const deleteLoading = ref(false);
const deleteError = ref('');

function confirmDelete(server: ServerInfo) {
  deletingServer.value = server;
  deleteError.value = '';
  showDeleteModal.value = true;
}

function closeDeleteModal() {
  showDeleteModal.value = false;
}

async function executeDelete() {
  if (!deletingServer.value) return;
  deleteLoading.value = true;
  deleteError.value = '';
  try {
    await serverStore.deleteServer(deletingServer.value.id);
    showStatus(`Сервер «${deletingServer.value.name}» удалён`);
    closeDeleteModal();
  } catch (err: unknown) {
    deleteError.value = (err as Error).message || 'Ошибка удаления сервера';
  } finally {
    deleteLoading.value = false;
  }
}

// ── Provision Modal ──

const showProvisionModal = ref(false);
const provisionForm = reactive({ name: '', host: '', port: 22, password: '' });
const provisionStarted = ref(false);
const provisionLoading = ref(false);
const provisionLogs = ref<string[]>([]);
const provisionError = ref('');
const provisionResult = ref<{ online: boolean; version?: string } | null>(null);
const logContainer = ref<HTMLElement | null>(null);

function openProvisionModal() {
  provisionForm.name = '';
  provisionForm.host = '';
  provisionForm.port = 22;
  provisionForm.password = '';
  provisionStarted.value = false;
  provisionLoading.value = false;
  provisionLogs.value = [];
  provisionError.value = '';
  provisionResult.value = null;
  showProvisionModal.value = true;
}

function closeProvisionModal() {
  if (provisionLoading.value) return;
  showProvisionModal.value = false;
}

async function startProvision() {
  provisionStarted.value = true;
  provisionLoading.value = true;
  provisionError.value = '';
  provisionLogs.value = ['Подключение к серверу...'];

  try {
    const result = await serverStore.provisionServer({
      name: provisionForm.name,
      host: provisionForm.host,
      port: provisionForm.port || 22,
      password: provisionForm.password,
    });

    provisionResult.value = { online: result.online, version: result.version };
    provisionLogs.value = result.logs;

    // Scroll log to bottom
    await nextTick();
    if (logContainer.value) {
      logContainer.value.scrollTop = logContainer.value.scrollHeight;
    }

    showStatus(result.online ? 'Сервер успешно настроен' : 'Провизия завершена');
    await serverStore.loadServers();
  } catch (err: unknown) {
    provisionError.value = (err as Error).message || 'Ошибка провизии';
    provisionLogs.value.push(`Error: ${provisionError.value}`);
  } finally {
    provisionLoading.value = false;
  }
}

// ── Existing actions ──

async function refresh() {
  refreshing.value = true;
  try {
    // Триггерим явный refresh на бэке (пинг + обновление statusCache),
    // потом перечитываем список. Так UI получает свежие данные сразу.
    await api.post('/servers/refresh');
    await serverStore.loadServers();
  } finally {
    refreshing.value = false;
  }
}

function selectServer(id: string) {
  serverStore.selectServer(id);
  navigateTo('/');
}

onMounted(async () => {
  if (serverStore.servers.length === 0) {
    await serverStore.loadServers();
  }
  loadAllPalettes();
});

// Перезагрузка списка серверов (refresh / add / delete) — повторно подтягиваем
// палитры. Используем length+id-string как зависимость, чтобы не дёргать на
// каждое изменение поля внутри объекта (online/lastError mutation refresh'ом).
watch(
  () => serverStore.servers.map((s: ServerInfo) => s.id).join(','),
  () => loadAllPalettes(),
);
</script>

<style scoped>
/* ── Header ── */
.servers-page__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 2rem;
}

.servers-page__title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0;
}

.servers-page__subtitle {
  font-size: 0.82rem;
  color: var(--text-muted);
  margin: 0.25rem 0 0;
}

.servers-page__actions {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.servers-page__btn {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.5rem 1rem;
  border-radius: 10px;
  font-size: 0.82rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
  border: 1px solid;
}

.servers-page__btn--primary {
  background: var(--primary-bg);
  border-color: var(--primary-border);
  color: var(--primary-text);
}

.servers-page__btn--primary:hover {
  background: var(--primary-bg-hover);
  border-color: var(--primary);
  box-shadow: var(--shadow-button);
}

.servers-page__btn--provision {
  background: rgba(99, 102, 241, 0.06);
  border-color: rgba(99, 102, 241, 0.15);
  color: #818cf8;
}

.servers-page__btn--provision:hover {
  background: rgba(99, 102, 241, 0.12);
  border-color: rgba(99, 102, 241, 0.25);
}

.servers-page__btn--refresh {
  background: var(--bg-surface);
  border-color: var(--border-secondary);
  color: var(--text-secondary);
}

.servers-page__btn--refresh:hover:not(:disabled) {
  background: var(--bg-elevated);
  border-color: var(--border);
}

.servers-page__btn--update {
  background: rgba(139, 92, 246, 0.06);
  border-color: rgba(139, 92, 246, 0.2);
  color: #a78bfa;
}

.servers-page__btn--update:hover:not(:disabled) {
  background: rgba(139, 92, 246, 0.12);
  border-color: rgba(139, 92, 246, 0.3);
}

.servers-page__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ── Spinner ── */
.servers-page__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--spinner-track);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}

.servers-page__spinner--lg {
  width: 22px;
  height: 22px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Section ── */
.servers-page__section-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 0 0 0.85rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.servers-page__badge {
  font-size: 0.65rem;
  font-weight: 700;
  padding: 0.1rem 0.4rem;
  border-radius: 6px;
  background: var(--primary-bg);
  color: var(--primary-text);
}

/* ── Loading ── */
.servers-page__loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 3rem;
  gap: 0.75rem;
  color: var(--text-muted);
  font-size: 0.82rem;
}

/* ── Empty ── */
.servers-page__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 3rem;
  gap: 0.5rem;
}

.servers-page__empty-text {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text-muted);
  margin: 0;
}

.servers-page__empty-hint {
  font-size: 0.75rem;
  color: var(--text-faint);
  margin: 0;
}

/* ── Server cards grid ── */
.servers-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 0.75rem;
  margin-bottom: 2rem;
}

.server-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  padding: 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  transition: border-color 0.15s;
}

.server-card:hover {
  border-color: var(--border);
}

.server-card--selected {
  border-color: var(--primary-border);
}

.server-card__header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.server-card__status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.server-card__status--online {
  background: #4ade80;
  box-shadow: 0 0 6px rgba(74, 222, 128, 0.4);
}

.server-card__status--offline {
  background: #f87171;
  box-shadow: 0 0 6px rgba(248, 113, 113, 0.3);
}

.server-card__name {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-heading);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.server-card__actions {
  display: flex;
  gap: 0.25rem;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;
}

.server-card:hover .server-card__actions {
  opacity: 1;
}

.server-card__action {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: 1px solid var(--border-secondary);
  background: transparent;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;
}

.server-card__action:hover {
  background: var(--bg-elevated);
  border-color: var(--border);
  color: var(--text-secondary);
}

.server-card__action--danger:hover {
  background: var(--danger-bg);
  border-color: var(--danger-border);
  color: var(--danger-light);
}

.server-card__details {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.server-card__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.server-card__label {
  font-size: 0.72rem;
  color: var(--text-faint);
  flex-shrink: 0;
}

.server-card__value {
  font-size: 0.75rem;
  color: var(--text-tertiary);
  text-align: right;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.server-card__value--mono {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
}

.server-card__value--online {
  color: #4ade80;
  font-weight: 500;
}

.server-card__value--offline {
  color: #f87171;
  font-weight: 500;
}

.server-card__palette {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.palette-swatch {
  position: relative;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid var(--bg-elevated);
  box-shadow: 0 0 0 1px var(--border-secondary), 0 1px 3px rgba(0, 0, 0, 0.18);
  cursor: pointer;
  transition: transform 0.12s ease, box-shadow 0.18s ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  padding: 0;
}
.palette-swatch:hover:not(:disabled) {
  transform: scale(1.08);
}
.palette-swatch:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.palette-swatch--active {
  box-shadow: 0 0 0 2px var(--primary), 0 1px 3px rgba(0, 0, 0, 0.22);
}
.palette-swatch--amber    { background: #f59e0b; }
.palette-swatch--violet   { background: #8b5cf6; }
.palette-swatch--emerald  { background: #10b981; }
.palette-swatch--sapphire { background: #3b82f6; }
.palette-swatch--rose     { background: #f43f5e; }
.palette-swatch--teal     { background: #14b8a6; }
.palette-swatch--fuchsia  { background: #d946ef; }

.server-card__palette-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--spinner-track);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.server-card__select {
  width: 100%;
  padding: 0.45rem;
  border-radius: 9px;
  border: 1px solid var(--border-secondary);
  background: transparent;
  color: var(--text-muted);
  font-size: 0.78rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}

.server-card__select:hover {
  background: var(--bg-elevated);
  border-color: var(--border);
  color: var(--text-secondary);
}

.server-card__select--active {
  background: var(--primary-bg);
  border-color: var(--primary-border);
  color: var(--primary-text);
  cursor: default;
}

.server-card__select--active:hover {
  background: var(--primary-bg);
  border-color: var(--primary-border);
  color: var(--primary-text);
}

/* ── Results section ── */
.results-section {
  margin-bottom: 2rem;
}

.results-section__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.65rem;
}

.results-section__clear {
  padding: 0.2rem 0.5rem;
  border-radius: 6px;
  border: 1px solid var(--border-secondary);
  background: transparent;
  color: var(--text-muted);
  font-size: 0.7rem;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}

.results-section__clear:hover {
  background: var(--border);
  color: var(--text-secondary);
}

.results-list {
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 12px;
  overflow: hidden;
}

.result-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem 0.95rem;
}

.result-item + .result-item {
  border-top: 1px solid var(--border);
}

.result-item__indicator {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.result-item--success .result-item__indicator { background: #4ade80; }
.result-item--fail .result-item__indicator { background: #f87171; }

.result-item__info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.result-item__name {
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--text-secondary);
}

.result-item__error {
  font-size: 0.7rem;
  color: #f87171;
  font-family: 'JetBrains Mono', monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-item__status {
  font-size: 0.72rem;
  font-weight: 600;
  flex-shrink: 0;
}

.result-item--success .result-item__status { color: #4ade80; }
.result-item--fail .result-item__status { color: #f87171; }

/* ── Modal ── */
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: var(--bg-overlay);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

.modal {
  background: var(--bg-modal);
  background-image: var(--bg-modal-gradient);
  border: 1px solid var(--border-secondary);
  border-radius: 18px;
  width: 100%;
  max-width: 440px;
  box-shadow: var(--shadow-modal);
  overflow: hidden;
}

.modal--sm {
  max-width: 380px;
}

.modal--lg {
  max-width: 540px;
}

.modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.15rem 1.25rem 0;
}

.modal__title {
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0;
}

.modal__close {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.modal__close:hover {
  background: var(--bg-elevated);
  color: var(--text-secondary);
}

.modal__body {
  padding: 1.15rem 1.25rem 1.25rem;
}

.modal__desc {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin: 0 0 1rem;
  line-height: 1.5;
}

.modal__field {
  margin-bottom: 0.85rem;
}

.modal__row {
  display: flex;
  gap: 0.75rem;
}

.modal__field--grow {
  flex: 1;
}

.modal__field--port {
  width: 90px;
  flex-shrink: 0;
}

.modal__label {
  display: block;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-tertiary);
  margin-bottom: 0.4rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.modal__input {
  width: 100%;
  padding: 0.55rem 0.75rem;
  border-radius: 10px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 0.85rem;
  font-family: inherit;
  transition: all 0.15s;
  outline: none;
}

.modal__input--mono {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8rem;
}

.modal__input:focus {
  border-color: var(--primary-border);
  box-shadow: var(--focus-ring);
}

.modal__input::placeholder {
  color: var(--text-placeholder);
}

.modal__hint {
  font-size: 0.68rem;
  color: var(--text-faint);
  margin-top: 0.3rem;
  display: block;
}

.modal__confirm-text {
  font-size: 0.85rem;
  color: var(--text-secondary);
  margin: 0 0 1rem;
  line-height: 1.55;
}

.modal__confirm-text strong {
  color: var(--text-heading);
  font-weight: 600;
}

.modal__error {
  font-size: 0.78rem;
  color: var(--danger-light);
  background: var(--danger-bg);
  border: 1px solid var(--danger-border);
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.85rem;
}

.modal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.25rem;
}

.modal__btn {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 1.1rem;
  border-radius: 10px;
  font-size: 0.82rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
  border: 1px solid;
}

.modal__btn--cancel {
  background: transparent;
  border-color: var(--border-secondary);
  color: var(--text-muted);
}

.modal__btn--cancel:hover:not(:disabled) {
  background: var(--bg-elevated);
  color: var(--text-secondary);
}

.modal__btn--submit {
  background: var(--primary-bg);
  border-color: var(--primary-border);
  color: var(--primary-text);
}

.modal__btn--submit:hover:not(:disabled) {
  background: var(--primary-bg-hover);
  border-color: var(--primary);
  box-shadow: var(--shadow-button);
}

.modal__btn--danger {
  background: var(--danger-bg);
  border-color: var(--danger-border);
  color: var(--danger-light);
}

.modal__btn--danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.15);
  border-color: rgba(239, 68, 68, 0.3);
}

.modal__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ── Provision log ── */
.provision-log {
  border: 1px solid var(--border-secondary);
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 1rem;
}

.provision-log__header {
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
}

.provision-log__status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.78rem;
  font-weight: 600;
}

.provision-log__status--running {
  color: var(--primary-text);
}

.provision-log__status--done {
  color: #4ade80;
}

.provision-log__status--warn {
  color: var(--primary-light);
}

.provision-log__output {
  padding: 0.75rem 0.85rem;
  max-height: 260px;
  overflow-y: auto;
  background: var(--bg-code);
  scrollbar-width: thin;
  scrollbar-color: var(--border-secondary) transparent;
}

.provision-log__line {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  line-height: 1.6;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}

.provision-log__prefix {
  color: var(--primary-text);
  margin-right: 0.4rem;
  user-select: none;
}

.provision-log__cursor {
  display: inline-block;
  width: 7px;
  height: 14px;
  background: var(--primary-text);
  opacity: 0.6;
  animation: blink 1s step-end infinite;
  vertical-align: text-bottom;
  margin-top: 0.25rem;
}

@keyframes blink {
  50% { opacity: 0; }
}

/* ── Modal transitions ── */
.modal-enter-active {
  transition: opacity 0.2s ease;
}
.modal-enter-active .modal {
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
}
.modal-leave-active {
  transition: opacity 0.15s ease;
}
.modal-leave-active .modal {
  transition: transform 0.15s ease, opacity 0.15s ease;
}
.modal-enter-from {
  opacity: 0;
}
.modal-enter-from .modal {
  opacity: 0;
  transform: scale(0.96) translateY(8px);
}
.modal-leave-to {
  opacity: 0;
}
.modal-leave-to .modal {
  opacity: 0;
  transform: scale(0.96) translateY(4px);
}

/* ── Responsive ── */
@media (max-width: 768px) {
  .servers-page__header {
    flex-direction: column;
    gap: 0.75rem;
  }

  .servers-page__actions {
    width: 100%;
  }

  .servers-page__btn {
    flex: 1;
    justify-content: center;
    padding: 0.55rem 0.75rem;
    font-size: 0.78rem;
  }

  .servers-grid {
    grid-template-columns: 1fr;
  }

  .servers-page__title {
    font-size: 1.2rem;
  }

  .server-card__actions {
    opacity: 1;
  }

  .modal {
    max-width: 100%;
    border-radius: 14px;
  }

  .modal--lg {
    max-width: 100%;
  }

  .modal__row {
    flex-direction: column;
    gap: 0;
  }

  .modal__field--port {
    width: 100%;
  }
}

/* ── Selection / checkbox / update badge ── */
.servers-page__selection {
  margin-left: 0.5rem;
  font-size: 0.8rem;
  color: var(--text-muted);
  font-weight: 500;
}

.servers-page__selection-clear {
  margin-left: 0.4rem;
  background: transparent;
  border: none;
  font-size: 0.78rem;
  color: var(--primary);
  cursor: pointer;
  text-decoration: underline;
  padding: 0;
  font-family: inherit;
}

.server-card__checkbox {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  margin-right: 0.5rem;
  flex-shrink: 0;
}

.server-card__checkbox input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.server-card__checkbox-mark {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 1.5px solid var(--border-strong);
  border-radius: 4px;
  background: var(--surface-elevated);
  position: relative;
  transition: all 0.15s;
}

.server-card__checkbox input:checked + .server-card__checkbox-mark {
  background: var(--primary);
  border-color: var(--primary);
}

.server-card__checkbox input:checked + .server-card__checkbox-mark::after {
  content: '';
  position: absolute;
  left: 4px;
  top: 1px;
  width: 4px;
  height: 8px;
  border: solid white;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

.server-card__checkbox input:disabled + .server-card__checkbox-mark {
  opacity: 0.35;
  cursor: not-allowed;
}

.server-card--checked {
  border-color: var(--primary);
  box-shadow: 0 0 0 1px var(--primary);
}

.server-card--has-update {
  border-color: rgba(var(--primary-rgb), 0.4);
}

.server-card__update-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  margin-left: auto;
  margin-right: 0.5rem;
  padding: 0.15rem 0.45rem;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: rgba(var(--primary-rgb), 0.12);
  border: 1px solid rgba(var(--primary-rgb), 0.3);
  border-radius: 6px;
  color: var(--primary);
}

.server-card__update-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--primary);
  animation: pulse-update 2s ease-in-out infinite;
}

@keyframes pulse-update {
  0%, 100% { opacity: 0.5; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.3); box-shadow: 0 0 8px rgba(var(--primary-rgb), 0.6); }
}

.server-card__version-arrow {
  margin-left: 0.4rem;
  color: var(--primary);
  font-size: 0.78rem;
  font-weight: 600;
}

.server-card__value--error {
  color: var(--danger, #ef4444);
  font-size: 0.78rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Bulk update modal ── */
.bulk-targets {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  max-height: 200px;
  overflow-y: auto;
  padding: 0.5rem;
  background: var(--surface-elevated);
  border-radius: 8px;
  margin-bottom: 1rem;
}

.bulk-targets__item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.4rem 0.6rem;
  background: var(--surface);
  border-radius: 6px;
  font-size: 0.85rem;
}

.bulk-targets__item--offline {
  opacity: 0.5;
}

.bulk-targets__indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.bulk-targets__indicator--online { background: #10b981; }
.bulk-targets__indicator--offline { background: #6b7280; }

.bulk-targets__name {
  flex: 1;
  font-weight: 500;
}

.bulk-targets__current {
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.78rem;
  color: var(--text-muted);
}

.bulk-info {
  padding: 0.55rem 0.75rem;
  background: rgba(99, 102, 241, 0.06);
  border: 1px solid rgba(99, 102, 241, 0.15);
  border-radius: 8px;
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-bottom: 1rem;
}

.bulk-info strong {
  color: var(--text-heading);
  font-family: ui-monospace, SFMono-Regular, monospace;
}

.modal__inline-btn {
  background: transparent;
  border: none;
  color: var(--primary);
  cursor: pointer;
  text-decoration: underline;
  font-family: inherit;
  font-size: inherit;
  padding: 0;
}

.modal__inline-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
