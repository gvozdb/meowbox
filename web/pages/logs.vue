<template>
  <div class="logs">
    <div class="logs__header">
      <div>
        <h1 class="logs__title">Логи</h1>
        <p class="logs__subtitle">Просмотр логов сервера</p>
      </div>
    </div>

    <!-- Toolbar -->
    <div class="logs__toolbar">
      <div class="logs__toolbar-row">
        <!-- Source selector -->
        <div class="logs__select-wrap">
          <select v-model="selectedSource" class="logs__select" @change="onSourceChange">
            <option value="">Выберите источник</option>
            <optgroup v-if="siteSources.length" label="Сайты">
              <option v-for="s in siteSources" :key="s.id" :value="s.id">
                {{ s.name }}{{ s.domain ? ` (${s.domain})` : '' }}
              </option>
            </optgroup>
            <optgroup v-if="systemSources.length" label="Системные">
              <option v-for="s in systemSources" :key="s.id" :value="s.id">
                {{ s.name }}
              </option>
            </optgroup>
          </select>
          <svg class="logs__select-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9" /></svg>
        </div>

        <!-- Type tabs -->
        <div v-if="availableTypes.length" class="logs__tabs">
          <button
            v-for="t in availableTypes"
            :key="t"
            class="logs__tab"
            :class="{ 'logs__tab--active': selectedType === t }"
            @click="selectType(t)"
          >
            {{ typeLabel(t) }}
          </button>
        </div>

        <!-- Lines selector -->
        <div class="logs__select-wrap logs__select-wrap--small">
          <select v-model.number="linesCount" class="logs__select logs__select--small" @change="fetchLogs">
            <option :value="100">100 строк</option>
            <option :value="200">200 строк</option>
            <option :value="500">500 строк</option>
            <option :value="1000">1000 строк</option>
          </select>
          <svg class="logs__select-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9" /></svg>
        </div>
      </div>

      <div class="logs__toolbar-row">
        <!-- Search -->
        <div class="logs__search-wrap">
          <svg class="logs__search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          <input
            v-model="searchQuery"
            type="text"
            class="logs__search"
            placeholder="Фильтр..."
          />
        </div>

        <!-- Follow button -->
        <button
          class="logs__btn"
          :class="{ 'logs__btn--active': isFollowing }"
          :disabled="!selectedSource"
          @click="toggleFollow"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <template v-if="isFollowing">
              <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
            </template>
            <template v-else>
              <polygon points="5 3 19 12 5 21 5 3" />
            </template>
          </svg>
          {{ isFollowing ? 'Остановить' : 'Следить' }}
        </button>

        <!-- Clear -->
        <button class="logs__btn" :disabled="!logLines.length" @click="clearLogs">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          Очистить
        </button>

        <!-- Download -->
        <button class="logs__btn" :disabled="!filteredLines.length" @click="downloadLogs">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
          Скачать
        </button>
      </div>
    </div>

    <!-- Log path indicator -->
    <div v-if="logPath" class="logs__path">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" /><polyline points="13 2 13 9 20 9" /></svg>
      {{ logPath }}
      <span v-if="totalLines" class="logs__path-total">&middot; {{ totalLines }} строк всего</span>
      <span v-if="isFollowing" class="logs__path-live">
        <span class="logs__live-dot" />
        LIVE
      </span>
    </div>

    <!-- Log output -->
    <div class="logs__output-wrap">
      <!-- Loading -->
      <div v-if="loading" class="logs__loading">
        <div class="logs__spinner" />
        <span>Загрузка...</span>
      </div>

      <!-- Empty -->
      <div v-else-if="!selectedSource" class="logs__empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
        <span>Выберите источник логов</span>
      </div>

      <div v-else-if="!filteredLines.length && !loading" class="logs__empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M16 16s-1.5-2-4-2-4 2-4 2" />
          <line x1="9" y1="9" x2="9.01" y2="9" />
          <line x1="15" y1="9" x2="15.01" y2="9" />
        </svg>
        <span>{{ searchQuery ? 'Нет совпадений' : 'Нет логов для отображения' }}</span>
      </div>

      <!-- Log lines -->
      <div v-else ref="outputRef" class="logs__output" @scroll="onScroll">
        <div
          v-for="(line, i) in filteredLines"
          :key="i"
          class="logs__line"
          :class="lineClass(line)"
        >
          <span class="logs__line-num">{{ i + 1 }}</span>
          <span class="logs__line-text" v-html="highlightSearch(line)" />
        </div>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface LogSource {
  id: string;
  name: string;
  type: 'site' | 'system';
  types: string[];
  domain?: string;
}

interface LogReadResult {
  type: string;
  path: string;
  lines: string[];
  totalLines: number;
}

const api = useApi();
const { connected, logsTailStart, logsTailStop, onLogsTailData } = useSocket();

const sources = ref<LogSource[]>([]);
const selectedSource = ref('');
const selectedType = ref('');
const linesCount = ref(200);
const searchQuery = ref('');
const logLines = ref<string[]>([]);
const logPath = ref('');
const totalLines = ref(0);
const loading = ref(false);
const isFollowing = ref(false);
const activeTailId = ref<string | null>(null);
const userScrolledUp = ref(false);
const outputRef = ref<HTMLElement | null>(null);
const mbToast = useMbToast();

const siteSources = computed(() => sources.value.filter(s => s.type === 'site'));
const systemSources = computed(() => sources.value.filter(s => s.type === 'system'));

const availableTypes = computed(() => {
  const src = sources.value.find(s => s.id === selectedSource.value);
  return src?.types || [];
});

const filteredLines = computed(() => {
  if (!searchQuery.value) return logLines.value;
  const q = searchQuery.value.toLowerCase();
  return logLines.value.filter(line => line.toLowerCase().includes(q));
});

function typeLabel(t: string): string {
  const labels: Record<string, string> = {
    access: 'Access',
    error: 'Error',
    php: 'PHP',
    app: 'App',
  };
  return labels[t] || t;
}

function lineClass(line: string): string {
  const lower = line.toLowerCase();
  if (/\b(error|fatal|crit(ical)?|emerg(ency)?)\b/.test(lower)) return 'logs__line--error';
  if (/\b(warn(ing)?)\b/.test(lower)) return 'logs__line--warn';
  return '';
}

function highlightSearch(line: string): string {
  if (!searchQuery.value) return escapeHtml(line);
  const escaped = escapeHtml(line);
  const q = escapeHtml(searchQuery.value);
  const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return escaped.replace(regex, '<mark class="logs__highlight">$1</mark>');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showStatus(message: string, isError = false) {
  if (isError) mbToast.error(message);
  else mbToast.success(message);
}

async function loadSources() {
  try {
    sources.value = await api.get<LogSource[]>('/logs/sources');
  } catch {
    showStatus('Не удалось загрузить источники', true);
  }
}

function onSourceChange() {
  const src = sources.value.find(s => s.id === selectedSource.value);
  if (src && src.types.length) {
    selectedType.value = src.types[0];
  } else {
    selectedType.value = '';
  }
  fetchLogs();
}

function selectType(t: string) {
  selectedType.value = t;
  fetchLogs();
}

async function fetchLogs() {
  if (!selectedSource.value || !selectedType.value) {
    logLines.value = [];
    logPath.value = '';
    totalLines.value = 0;
    return;
  }

  // If following, restart tail for new source/type
  if (isFollowing.value) {
    await stopTail();
    loading.value = true;
    try {
      const result = await api.get<LogReadResult>(
        `/logs/read?source=${encodeURIComponent(selectedSource.value)}&type=${selectedType.value}&lines=${linesCount.value}`,
      );
      logLines.value = result.lines;
      logPath.value = result.path;
      totalLines.value = result.totalLines;
    } catch {
      showStatus('Не удалось загрузить логи', true);
    } finally {
      loading.value = false;
    }
    await startTail();
    return;
  }

  loading.value = true;
  try {
    const result = await api.get<LogReadResult>(
      `/logs/read?source=${encodeURIComponent(selectedSource.value)}&type=${selectedType.value}&lines=${linesCount.value}`,
    );
    logLines.value = result.lines;
    logPath.value = result.path;
    totalLines.value = result.totalLines;
    nextTick(() => scrollToBottom());
  } catch {
    showStatus('Не удалось загрузить логи', true);
  } finally {
    loading.value = false;
  }
}

async function toggleFollow() {
  if (isFollowing.value) {
    await stopTail();
  } else {
    if (!connected.value) {
      showStatus('Агент не подключён', true);
      return;
    }
    // Fetch current logs first if empty
    if (!logLines.value.length) {
      await fetchLogs();
    }
    await startTail();
  }
}

async function startTail() {
  if (!selectedSource.value || !selectedType.value) return;
  try {
    const { tailId } = await logsTailStart(selectedSource.value, selectedType.value);
    activeTailId.value = tailId;
    isFollowing.value = true;
    userScrolledUp.value = false;
  } catch (err) {
    showStatus((err as Error).message, true);
  }
}

async function stopTail() {
  if (activeTailId.value) {
    logsTailStop(activeTailId.value);
    activeTailId.value = null;
  }
  isFollowing.value = false;
}

function clearLogs() {
  logLines.value = [];
  logPath.value = '';
  totalLines.value = 0;
}

function downloadLogs() {
  const content = filteredLines.value.join('\n');
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const src = sources.value.find(s => s.id === selectedSource.value);
  a.download = `${src?.name || 'logs'}-${selectedType.value}-${new Date().toISOString().slice(0, 10)}.log`;
  a.click();
  URL.revokeObjectURL(url);
}

function scrollToBottom() {
  if (!outputRef.value) return;
  outputRef.value.scrollTop = outputRef.value.scrollHeight;
}

function onScroll() {
  if (!outputRef.value) return;
  const el = outputRef.value;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  userScrolledUp.value = !atBottom;
}

// Tail data listener
let unsubTail: (() => void) | null = null;

onMounted(() => {
  loadSources();

  unsubTail = onLogsTailData((payload) => {
    if (payload.tailId !== activeTailId.value) return;
    logLines.value.push(payload.line);
    // Cap at 5000 lines to prevent memory issues
    if (logLines.value.length > 5000) {
      logLines.value = logLines.value.slice(-4000);
    }
    if (!userScrolledUp.value) {
      nextTick(() => scrollToBottom());
    }
  });
});

onUnmounted(() => {
  if (unsubTail) unsubTail();
  if (activeTailId.value) {
    logsTailStop(activeTailId.value);
  }
});
</script>

<style scoped>
.logs__header {
  margin-bottom: 1.5rem;
}

.logs__title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0;
}

.logs__subtitle {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-top: 0.15rem;
}

/* Toolbar */
.logs__toolbar {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  margin-bottom: 0.75rem;
}

.logs__toolbar-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

/* Select */
.logs__select-wrap {
  position: relative;
  min-width: 180px;
}

.logs__select-wrap--small {
  min-width: 120px;
}

.logs__select {
  width: 100%;
  appearance: none;
  padding: 0.45rem 2rem 0.45rem 0.75rem;
  border-radius: 10px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-family: inherit;
  cursor: pointer;
  outline: none;
  transition: border-color 0.2s;
}

.logs__select:focus {
  border-color: var(--primary-border);
  box-shadow: var(--focus-ring);
}

.logs__select--small {
  padding: 0.45rem 1.6rem 0.45rem 0.6rem;
  font-size: 0.72rem;
}

.logs__select option,
.logs__select optgroup {
  background: var(--select-bg);
  color: var(--text-secondary);
}

.logs__select-chevron {
  position: absolute;
  right: 0.55rem;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
  pointer-events: none;
}

/* Tabs */
.logs__tabs {
  display: flex;
  gap: 0.2rem;
  background: var(--bg-surface);
  border-radius: 10px;
  padding: 0.15rem;
  border: 1px solid var(--border);
}

.logs__tab {
  padding: 0.35rem 0.75rem;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 0.72rem;
  font-weight: 500;
  font-family: 'JetBrains Mono', monospace;
  cursor: pointer;
  transition: all 0.2s;
}

.logs__tab:hover {
  color: var(--text-secondary);
  background: var(--bg-elevated);
}

.logs__tab--active {
  background: var(--primary-bg);
  color: var(--primary-text);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

/* Search */
.logs__search-wrap {
  position: relative;
  flex: 1;
  min-width: 140px;
  max-width: 280px;
}

.logs__search-icon {
  position: absolute;
  left: 0.6rem;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
  pointer-events: none;
}

.logs__search {
  width: 100%;
  padding: 0.45rem 0.65rem 0.45rem 2rem;
  border-radius: 10px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-family: inherit;
  outline: none;
  transition: border-color 0.2s;
}

.logs__search::placeholder {
  color: var(--text-placeholder);
}

.logs__search:focus {
  border-color: var(--primary-border);
  box-shadow: var(--focus-ring);
}

/* Buttons */
.logs__btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.45rem 0.75rem;
  border-radius: 10px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  color: var(--text-tertiary);
  font-size: 0.72rem;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s;
}

.logs__btn:hover:not(:disabled) {
  border-color: var(--primary-border);
  color: var(--primary-text);
  background: var(--primary-bg);
}

.logs__btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.logs__btn--active {
  background: var(--success-bg);
  border-color: var(--success-border);
  color: var(--success-light);
}

.logs__btn--active:hover:not(:disabled) {
  background: rgba(34, 197, 94, 0.12);
  border-color: rgba(34, 197, 94, 0.25);
  color: var(--success-light);
}

/* Path */
.logs__path {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.75rem;
  margin-bottom: 0.5rem;
  font-size: 0.68rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-muted);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.logs__path-total {
  color: var(--text-faint);
}

.logs__path-live {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  margin-left: auto;
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--success-light);
}

.logs__live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4ade80;
  box-shadow: 0 0 8px rgba(74, 222, 128, 0.6);
  animation: livePulse 1.5s ease-in-out infinite;
}

@keyframes livePulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 8px rgba(74, 222, 128, 0.6); }
  50% { opacity: 0.4; box-shadow: 0 0 4px rgba(74, 222, 128, 0.3); }
}

/* Output area */
.logs__output-wrap {
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  overflow: hidden;
  background: #0a0c10;
  min-height: 420px;
  position: relative;
}

:root.theme-light .logs__output-wrap {
  background: #f0f1f4;
}

.logs__output {
  height: calc(100vh - 340px);
  min-height: 420px;
  overflow-y: auto;
  overflow-x: auto;
  padding: 0.5rem 0;
  scroll-behavior: smooth;
}

/* Custom scrollbar */
.logs__output::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.logs__output::-webkit-scrollbar-track {
  background: transparent;
}

.logs__output::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.08);
  border-radius: 3px;
}

.logs__output::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.15);
}

:root.theme-light .logs__output::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.1);
}

/* Lines */
.logs__line {
  display: flex;
  align-items: flex-start;
  padding: 0 0.85rem;
  line-height: 1.55;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  transition: background 0.1s;
}

.logs__line:hover {
  background: rgba(255, 255, 255, 0.02);
}

:root.theme-light .logs__line:hover {
  background: rgba(0, 0, 0, 0.03);
}

.logs__line-num {
  user-select: none;
  min-width: 3.2rem;
  text-align: right;
  padding-right: 0.85rem;
  color: rgba(255, 255, 255, 0.1);
  flex-shrink: 0;
  border-right: 1px solid rgba(255, 255, 255, 0.04);
  margin-right: 0.85rem;
}

:root.theme-light .logs__line-num {
  color: rgba(0, 0, 0, 0.15);
  border-right-color: rgba(0, 0, 0, 0.06);
}

.logs__line-text {
  white-space: pre;
  color: rgba(255, 255, 255, 0.55);
  word-break: break-all;
}

:root.theme-light .logs__line-text {
  color: rgba(0, 0, 0, 0.55);
}

/* Highlighted lines */
.logs__line--error {
  background: rgba(239, 68, 68, 0.06);
}

.logs__line--error .logs__line-text {
  color: #f87171;
}

.logs__line--warn {
  background: rgba(var(--primary-rgb), 0.05);
}

.logs__line--warn .logs__line-text {
  color: var(--primary-light);
}

:root.theme-light .logs__line--error {
  background: rgba(239, 68, 68, 0.06);
}

:root.theme-light .logs__line--error .logs__line-text {
  color: #dc2626;
}

:root.theme-light .logs__line--warn {
  background: rgba(var(--primary-rgb), 0.05);
}

:root.theme-light .logs__line--warn .logs__line-text {
  color: var(--primary-dark);
}

/* Search highlight */
.logs__line-text :deep(.logs__highlight) {
  background: rgba(var(--primary-rgb), 0.25);
  color: var(--primary-light);
  border-radius: 2px;
  padding: 0 1px;
}

:root.theme-light .logs__line-text :deep(.logs__highlight) {
  background: rgba(var(--primary-rgb), 0.2);
  color: #92400e;
}

/* Loading */
.logs__loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  color: var(--text-muted);
  font-size: 0.82rem;
}

.logs__spinner {
  width: 28px;
  height: 28px;
  border: 2px solid var(--spinner-track);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Empty */
.logs__empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  color: var(--text-muted);
  font-size: 0.82rem;
}

.logs__empty svg {
  opacity: 0.3;
}

@media (max-width: 768px) {
  .logs__toolbar-row {
    flex-wrap: wrap;
  }

  .logs__select-wrap {
    min-width: 100%;
  }

  .logs__select-wrap--small {
    min-width: 100px;
  }

  .logs__search-wrap {
    max-width: 100%;
    min-width: 100%;
  }

  .logs__tabs {
    width: 100%;
    overflow-x: auto;
  }

  .logs__output {
    height: calc(100vh - 420px);
    min-height: 300px;
  }

  .logs__title {
    font-size: 1.25rem;
  }

  .logs__line {
    font-size: 0.62rem;
  }

  .logs__line-num {
    min-width: 2.5rem;
    padding-right: 0.5rem;
    margin-right: 0.5rem;
  }
}
</style>
