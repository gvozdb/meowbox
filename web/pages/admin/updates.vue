<template>
  <div class="panel-updates">
    <!-- Hero block -->
    <section class="panel-updates__hero" :class="{ 'panel-updates__hero--update': canUpdate, 'panel-updates__hero--ok': status?.latest && status.current === status.latest }">
      <div class="panel-updates__hero-icon">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      </div>
      <div class="panel-updates__hero-text">
        <h1 class="panel-updates__title">Обновления панели</h1>
        <p class="panel-updates__subtitle">
          Скачивает релиз с GitHub (<code>{{ githubRepo }}</code>), проверяет SHA256,
          разворачивает в <code>releases/&lt;v&gt;/</code>, применяет миграции, переключает
          <code>current</code>, делает <code>pm2 reload</code>. При сбое — автооткат.
        </p>
      </div>
    </section>

    <!-- Версии и кнопка Update -->
    <section class="panel-updates__versions">
      <div class="version-card">
        <span class="version-card__label">Текущая версия</span>
        <span class="version-card__value">{{ status?.current ?? '...' }}</span>
        <span class="version-card__hint">установлено локально</span>
      </div>
      <div class="version-card" :class="{ 'version-card--has-update': canUpdate }">
        <span class="version-card__label">Доступная версия</span>
        <span class="version-card__value">
          {{ status?.latest ?? '—' }}
          <span v-if="canUpdate" class="version-card__pulse" />
        </span>
        <span v-if="status?.latestCheckedAt" class="version-card__hint">
          проверено: {{ humanTime(status.latestCheckedAt) }}
        </span>
      </div>
      <div class="version-card version-card--actions">
        <button
          class="btn btn--ghost btn--sm"
          :disabled="checkingLatest || running"
          @click="onCheckLatest"
        >
          <span v-if="checkingLatest" class="spinner" />
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <polyline points="23,4 23,10 17,10" /><path d="M20.49,15a9,9,0,1,1-2.12-9.36L23,10" />
          </svg>
          {{ checkingLatest ? 'Проверка...' : 'Проверить' }}
        </button>
        <button
          v-if="canUpdate"
          class="btn btn--primary btn--accent"
          :disabled="running"
          @click="onTriggerUpdate"
        >
          <svg v-if="!running" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7,10 12,15 17,10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <span v-else class="spinner" />
          {{ running ? 'Идёт обновление...' : `Обновить до ${status?.latest}` }}
        </button>
        <button
          v-else-if="status?.latest && status.current === status.latest"
          class="btn btn--ok"
          disabled
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <polyline points="20,6 9,17 4,12" />
          </svg>
          Установлена последняя
        </button>
      </div>
    </section>

    <!-- Прогресс активного апдейта -->
    <section v-if="running || lastFinishedRecently" class="panel-updates__progress">
      <h2 class="section-title">
        {{ running ? 'Идёт обновление' : `Завершено: ${runStatusLabel}` }}
      </h2>

      <div class="stages">
        <div
          v-for="stage in status?.stages ?? []"
          :key="stage"
          class="stage"
          :class="{
            'stage--done': isStageDone(stage),
            'stage--current': isStageCurrent(stage),
            'stage--failed': isStageFailed(stage),
          }"
        >
          <span class="stage__icon">
            <span v-if="isStageDone(stage)">✓</span>
            <span v-else-if="isStageFailed(stage)">✗</span>
            <span v-else-if="isStageCurrent(stage)" class="spinner spinner--sm" />
            <span v-else>·</span>
          </span>
          <span class="stage__name">{{ stageLabel(stage) }}</span>
        </div>
      </div>

      <div v-if="status?.state.errorMessage" class="alert alert--err">
        <strong>Ошибка:</strong> {{ status.state.errorMessage }}
      </div>

      <details v-if="status?.state.logTail" class="logs-block">
        <summary>Лог ({{ status.state.logTail.length }} символов)</summary>
        <pre class="logs-block__pre"><code>{{ status.state.logTail }}</code></pre>
      </details>
    </section>

    <!-- История обновлений -->
    <section v-if="status?.history && status.history.length" class="panel-updates__history">
      <h2 class="section-title">История обновлений</h2>
      <div class="history-table">
        <div class="history-row history-row--header">
          <span>Когда</span>
          <span>Версия</span>
          <span>Статус</span>
          <span>Длительность</span>
          <span>Кем</span>
        </div>
        <div v-for="h in status.history" :key="h.id" class="history-row" :class="`history-row--${h.status}`">
          <span class="history-row__time">{{ humanTime(h.startedAt) }}</span>
          <span class="history-row__ver">{{ h.fromVersion ?? '—' }} → {{ h.toVersion }}</span>
          <span class="history-row__status">{{ statusLabel(h.status) }}</span>
          <span class="history-row__dur">{{ humanDuration(h.durationMs) }}</span>
          <span class="history-row__by">{{ h.triggeredBy ?? '—' }}</span>
        </div>
      </div>
    </section>

    <!-- Banner -->
    <div v-if="banner" class="banner" :class="`banner--${banner.kind}`">
      {{ banner.text }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

definePageMeta({ layout: 'default', middleware: ['auth'] });

interface UpdateStatus {
  current: string;
  latest: string | null;
  latestCheckedAt: string | null;
  state: {
    status: 'idle' | 'running' | 'succeeded' | 'failed' | 'rolled_back';
    fromVersion: string | null;
    toVersion: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    pid: number | null;
    currentStage: string | null;
    errorMessage: string | null;
    logTail: string;
  };
  stages: string[];
  history: Array<{
    id: string;
    fromVersion: string | null;
    toVersion: string;
    status: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    triggeredBy: string | null;
    errorMessage: string | null;
  }>;
}

const api = useApi();
const config = useRuntimeConfig();
const githubRepo = computed(() => (config.public as { githubRepo?: string }).githubRepo || 'gvozdb/meowbox');

const status = ref<UpdateStatus | null>(null);
const checkingLatest = ref(false);
const banner = ref<{ kind: 'ok' | 'err'; text: string } | null>(null);
let bannerTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const running = computed(() => status.value?.state.status === 'running');
const lastFinishedRecently = computed(() => {
  if (!status.value?.state.finishedAt) return false;
  const t = new Date(status.value.state.finishedAt).getTime();
  return Date.now() - t < 5 * 60 * 1000; // показываем 5 минут после завершения
});
const canUpdate = computed(() => {
  if (!status.value?.latest) return false;
  if (running.value) return false;
  return status.value.current !== status.value.latest;
});
const runStatusLabel = computed(() => statusLabel(status.value?.state.status ?? ''));

function showBanner(kind: 'ok' | 'err', text: string, ttl = 4000) {
  banner.value = { kind, text };
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { banner.value = null; }, ttl);
}

async function loadStatus(refresh = false) {
  try {
    status.value = await api.get<UpdateStatus>(`/admin/update/status${refresh ? '?refresh=1' : ''}`);
  } catch (e) {
    showBanner('err', `Не удалось загрузить статус: ${(e as Error).message}`, 6000);
  }
}

async function onCheckLatest() {
  checkingLatest.value = true;
  try {
    await loadStatus(true);
  } finally {
    checkingLatest.value = false;
  }
}

async function onTriggerUpdate() {
  if (!status.value?.latest) return;
  if (!confirm(`Обновить панель до ${status.value.latest}?\n\nВо время обновления панель может быть недоступна на 10–30 секунд (pm2 reload).`)) {
    return;
  }
  try {
    await api.post('/admin/update', { version: status.value.latest });
    showBanner('ok', 'Обновление запущено. Прогресс ниже.');
    await loadStatus();
    startPolling();
  } catch (e) {
    showBanner('err', `Не удалось запустить: ${(e as Error).message}`, 8000);
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    await loadStatus();
    if (!running.value) {
      // Финальный pull истории и стоп
      stopPolling();
    }
  }, 1500);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ─── Stage helpers ───
function isStageDone(stage: string): boolean {
  if (!status.value) return false;
  const order = status.value.stages;
  const cur = status.value.state.currentStage;
  if (status.value.state.status === 'succeeded') return true;
  if (!cur) return false;
  const curIdx = order.indexOf(cur);
  const stageIdx = order.indexOf(stage);
  return curIdx > stageIdx;
}
function isStageCurrent(stage: string): boolean {
  return !!status.value && status.value.state.currentStage === stage && status.value.state.status === 'running';
}
function isStageFailed(stage: string): boolean {
  return !!status.value
    && status.value.state.currentStage === stage
    && status.value.state.status === 'failed';
}

const STAGE_LABELS: Record<string, string> = {
  preflight: 'Preflight',
  snapshot: 'Snapshot',
  download: 'Скачивание',
  verify: 'Проверка подписи',
  extract: 'Распаковка',
  install: 'npm install',
  migrate: 'Миграции',
  switch: 'Переключение',
  reload: 'PM2 reload',
  healthcheck: 'Healthcheck',
  cleanup: 'Очистка',
};
function stageLabel(s: string): string { return STAGE_LABELS[s] ?? s; }

function statusLabel(s: string): string {
  return ({
    idle: 'idle',
    running: 'идёт',
    succeeded: 'успех',
    failed: 'провал',
    rolled_back: 'откат',
  } as Record<string, string>)[s] ?? s;
}

function humanTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch { return iso; }
}
function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

onMounted(async () => {
  await loadStatus();
  if (running.value) startPolling();
});
onBeforeUnmount(() => stopPolling());
</script>

<style scoped>
.panel-updates {
  max-width: 1100px;
  margin: 0 auto;
  padding: 1.5rem 2rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

/* ─── Hero ─── */
.panel-updates__hero {
  display: flex;
  align-items: flex-start;
  gap: 1.1rem;
  padding: 1.4rem 1.6rem;
  border-radius: 16px;
  background:
    radial-gradient(circle at 0% 0%, rgba(245, 158, 11, 0.08), transparent 50%),
    var(--bg-surface);
  border: 1px solid var(--border-secondary);
  position: relative;
  overflow: hidden;
}
.panel-updates__hero::after {
  content: '';
  position: absolute;
  right: -60px;
  top: -60px;
  width: 200px;
  height: 200px;
  background: radial-gradient(circle, rgba(245, 158, 11, 0.07), transparent 70%);
  pointer-events: none;
}
.panel-updates__hero--update {
  background:
    radial-gradient(circle at 0% 0%, rgba(245, 158, 11, 0.18), transparent 55%),
    var(--bg-surface);
  border-color: rgba(245, 158, 11, 0.35);
  box-shadow: 0 4px 20px -8px rgba(245, 158, 11, 0.25);
}
.panel-updates__hero--ok {
  background:
    radial-gradient(circle at 0% 0%, rgba(34, 197, 94, 0.07), transparent 55%),
    var(--bg-surface);
}
.panel-updates__hero-icon {
  flex-shrink: 0;
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 14px;
  background: rgba(245, 158, 11, 0.1);
  color: var(--primary, #f59e0b);
  border: 1px solid rgba(245, 158, 11, 0.25);
}
.panel-updates__hero-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.panel-updates__title {
  font-size: 1.45rem;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0;
  letter-spacing: -0.01em;
}
.panel-updates__subtitle {
  font-size: 0.82rem;
  color: var(--text-tertiary);
  line-height: 1.55;
  margin: 0;
}

/* ─── Versions ─── */
.panel-updates__versions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.75rem;
}
.version-card {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 1rem 1.1rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  transition: all 0.2s;
  position: relative;
}
.version-card:hover { border-color: var(--border-strong); }
.version-card--has-update {
  border-color: rgba(245, 158, 11, 0.45);
  background:
    linear-gradient(135deg, rgba(245, 158, 11, 0.08), transparent 60%),
    var(--bg-surface);
  box-shadow: 0 4px 14px -6px rgba(245, 158, 11, 0.3);
}
.version-card__pulse {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-left: 0.4rem;
  border-radius: 50%;
  background: var(--primary, #f59e0b);
  vertical-align: middle;
  box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.5);
  animation: version-pulse 1.6s ease-in-out infinite;
}
@keyframes version-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.5); }
  50% { box-shadow: 0 0 0 8px rgba(245, 158, 11, 0); }
}
.version-card__label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
  color: var(--text-muted);
}
.version-card__value {
  font-size: 1.1rem;
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-heading);
}
.version-card__hint { font-size: 0.7rem; color: var(--text-muted); }
.version-card--actions {
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

/* ─── Progress ─── */
.panel-updates__progress {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 12px;
  padding: 1.25rem 1.5rem;
}
.section-title {
  font-size: 0.95rem;
  font-weight: 600;
  margin: 0 0 1rem;
  color: var(--text-heading);
}

.stages {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.stage {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.55rem 0.75rem;
  border-radius: 8px;
  background: var(--bg-input);
  border: 1px solid var(--border-secondary);
  font-size: 0.78rem;
  color: var(--text-tertiary);
}
.stage--done {
  border-color: rgba(34, 197, 94, 0.3);
  background: rgba(34, 197, 94, 0.05);
  color: #4ade80;
}
.stage--current {
  border-color: rgba(245, 158, 11, 0.45);
  background: rgba(245, 158, 11, 0.08);
  color: var(--text-heading);
}
.stage--failed {
  border-color: rgba(239, 68, 68, 0.4);
  background: rgba(239, 68, 68, 0.08);
  color: #fca5a5;
}
.stage__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  font-size: 0.85rem;
}

/* ─── History ─── */
.panel-updates__history {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 12px;
  padding: 1.25rem 1.5rem;
}
.history-table { display: flex; flex-direction: column; }
.history-row {
  display: grid;
  grid-template-columns: 1.5fr 2fr 1fr 1fr 1.2fr;
  gap: 0.75rem;
  padding: 0.55rem 0.5rem;
  font-size: 0.8rem;
  color: var(--text-secondary);
  border-bottom: 1px dashed var(--border-secondary);
}
.history-row:last-child { border-bottom: none; }
.history-row--header {
  font-weight: 600;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}
.history-row--succeeded { color: #4ade80; }
.history-row--failed { color: #fca5a5; }
.history-row__ver {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
}

.alert {
  margin-top: 0.75rem;
  padding: 0.7rem 0.95rem;
  border-radius: 8px;
  font-size: 0.82rem;
}
.alert--err {
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: #fca5a5;
}
.logs-block {
  margin-top: 0.75rem;
}
.logs-block summary {
  cursor: pointer;
  font-size: 0.78rem;
  color: var(--text-tertiary);
  user-select: none;
}
.logs-block__pre {
  margin: 0.5rem 0 0;
  background: #0f0f0f;
  border: 1px solid var(--border-secondary);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.74rem;
  line-height: 1.5;
  color: #e7e5e4;
  white-space: pre-wrap;
  max-height: 360px;
  overflow: auto;
}

.banner {
  position: fixed;
  bottom: 1.5rem;
  right: 1.5rem;
  padding: 0.7rem 1rem;
  border-radius: 10px;
  font-size: 0.84rem;
  z-index: 1000;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
}
.banner--ok { background: rgba(34, 197, 94, 0.95); color: #052e16; }
.banner--err { background: rgba(239, 68, 68, 0.95); color: #450a0a; }

/* ─── Buttons (повторяем из общего CSS — scoped изолирует) ─── */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.55rem 1rem;
  border-radius: 10px;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-primary);
  transition: all 0.15s;
  font-family: inherit;
}
.btn:hover:not(:disabled) { transform: translateY(-1px); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn--sm { padding: 0.4rem 0.75rem; font-size: 0.75rem; border-radius: 8px; }
.btn--primary {
  background: var(--primary, #f59e0b);
  color: var(--text-inverse, #1c1917);
}
.btn--primary:hover:not(:disabled) { background: var(--primary-strong, #fbbf24); }
.btn--accent {
  background: linear-gradient(135deg, var(--primary, #f59e0b), var(--primary-strong, #fbbf24));
  box-shadow: 0 4px 14px -4px rgba(245, 158, 11, 0.5);
}
.btn--accent:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 6px 20px -4px rgba(245, 158, 11, 0.6);
}
.btn--ok {
  background: rgba(34, 197, 94, 0.1);
  border-color: rgba(34, 197, 94, 0.3);
  color: #4ade80;
}
.btn--ghost {
  border-color: var(--border-secondary);
  color: var(--text-secondary);
}
.btn--ghost:hover:not(:disabled) {
  background: var(--bg-input);
  border-color: var(--border-strong);
}

.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--primary, #f59e0b);
  border-radius: 50%;
  animation: pu-spin 0.8s linear infinite;
}
.spinner--sm { width: 12px; height: 12px; }
@keyframes pu-spin { to { transform: rotate(360deg); } }

code {
  background: var(--bg-input);
  border: 1px solid var(--border-secondary);
  border-radius: 4px;
  padding: 0.05rem 0.3rem;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.85em;
}
</style>
