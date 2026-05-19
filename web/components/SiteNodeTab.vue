<template>
  <div class="site-node">
    <div v-if="loading && !data" class="site-node__loading">
      <div class="spinner" /> Загрузка Node.js-процессов…
    </div>

    <template v-else-if="data">
      <!-- Автозагрузка + обновить -->
      <div class="site-node__bar">
        <label class="site-node__autostart">
          <input
            type="checkbox"
            class="site-node__switch"
            :checked="data.autostartEnabled"
            :disabled="autostartBusy"
            @change="toggleAutostart(($event.target as HTMLInputElement).checked)"
          />
          <span class="site-node__autostart-track" aria-hidden="true">
            <span class="site-node__autostart-thumb" />
          </span>
          <span class="site-node__autostart-text">
            <span class="site-node__autostart-title">Автозагрузка при старте сервера</span>
            <span class="site-node__autostart-hint">
              PM2-демон сайта будет подниматься автоматически при перезагрузке сервера.
            </span>
          </span>
        </label>
        <button class="btn btn--ghost btn--sm" :disabled="loading" @click="refresh">
          <svg
            width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" :class="{ 'site-node__spin': loading }"
          >
            <polyline points="23,4 23,10 17,10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
          Обновить
        </button>
      </div>

      <!-- Пустое состояние -->
      <div v-if="!data.groups.length" class="site-node__empty">
        <div class="site-node__empty-icon" aria-hidden="true">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
            <line x1="12" y1="22.08" x2="12" y2="12" />
          </svg>
        </div>
        <p class="site-node__empty-title">Нет PM2-процессов</p>
        <p class="site-node__empty-text">
          PM2-процессы берутся из ecosystem-файла в репозитории сайта
          (<code>ecosystem.config.js</code>, <code>.cjs</code> или <code>.json</code>).
          Чтобы здесь появились процессы — добавьте такой файл в код сайта.
        </p>
      </div>

      <!-- Группы процессов -->
      <div
        v-for="(group, gi) in data.groups"
        :key="group.ecosystemFile ?? `orphan-${gi}`"
        class="site-node__group"
      >
        <div class="site-node__group-head">
          <svg
            v-if="group.ecosystemFile" class="site-node__group-icon"
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <svg
            v-else class="site-node__group-icon site-node__group-icon--orphan"
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          >
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <div class="site-node__group-titles">
            <span class="site-node__group-title">
              {{ group.ecosystemFile ? (group.dir || group.ecosystemFile) : 'Вне ecosystem-файлов' }}
            </span>
            <code v-if="group.ecosystemFile" class="site-node__group-path">{{ group.ecosystemFile }}</code>
            <span v-else class="site-node__group-path site-node__group-path--muted">
              Процессы, запущенные вручную — без определения в файле.
            </span>
          </div>
        </div>

        <div class="site-node__procs">
          <div
            v-for="proc in group.processes"
            :key="proc.name"
            class="nproc"
          >
            <div class="nproc__head">
              <div class="nproc__title-block">
                <span class="nproc__name">{{ proc.name }}</span>
                <span class="nproc__badge" :class="`nproc__badge--${badgeKind(proc)}`">
                  <span class="status-dot" :class="`status-dot--${badgeKind(proc)}`" />
                  {{ statusLabel(proc) }}
                </span>
              </div>
              <div class="nproc__actions">
                <template v-if="proc.loaded">
                  <button class="btn btn--ghost btn--sm" :disabled="!!busy[proc.name]" @click="doAction(proc, 'restart')">
                    {{ busy[proc.name] === 'restart' ? 'Рестарт…' : 'Рестарт' }}
                  </button>
                  <button class="btn btn--ghost btn--sm" :disabled="!!busy[proc.name]" @click="doAction(proc, 'reload')">
                    {{ busy[proc.name] === 'reload' ? 'Reload…' : 'Reload' }}
                  </button>
                  <button class="btn btn--ghost btn--sm" :disabled="!!busy[proc.name]" @click="doAction(proc, 'stop')">
                    {{ busy[proc.name] === 'stop' ? 'Стоп…' : 'Стоп' }}
                  </button>
                  <button class="btn btn--ghost btn--sm" :disabled="!!busy[proc.name]" @click="openLogs(proc)">
                    Логи
                  </button>
                  <button class="btn btn--danger btn--sm" :disabled="!!busy[proc.name]" @click="removeProcess(proc)">
                    {{ busy[proc.name] === 'delete' ? 'Удаляю…' : 'Удалить' }}
                  </button>
                </template>
                <button
                  v-else-if="proc.defined"
                  class="btn btn--primary btn--sm"
                  :disabled="!!busy[proc.name]"
                  @click="startProcess(proc, group)"
                >
                  {{ busy[proc.name] === 'start' ? 'Запуск…' : 'Запустить' }}
                </button>
              </div>
            </div>

            <!-- Runtime-метрики -->
            <div v-if="proc.runtime" class="nproc__metrics">
              <div class="nproc__metric">
                <span class="nproc__metric-label">CPU</span>
                <span class="nproc__metric-value">{{ proc.runtime.cpu }}%</span>
              </div>
              <div class="nproc__metric">
                <span class="nproc__metric-label">Память</span>
                <span class="nproc__metric-value">{{ formatBytes(proc.runtime.memory) }}</span>
              </div>
              <div class="nproc__metric">
                <span class="nproc__metric-label">Аптайм</span>
                <span class="nproc__metric-value">{{ formatUptime(proc.runtime.uptime, proc.runtime.status) }}</span>
              </div>
              <div class="nproc__metric">
                <span class="nproc__metric-label">Рестартов</span>
                <span class="nproc__metric-value">{{ proc.runtime.restarts }}</span>
              </div>
              <div class="nproc__metric">
                <span class="nproc__metric-label">Инстансы</span>
                <span class="nproc__metric-value">
                  {{ proc.runtime.instances ?? 1 }}
                  <span class="nproc__metric-sub">{{ execModeLabel(proc.runtime.execMode) }}</span>
                </span>
              </div>
            </div>
            <div v-else class="nproc__offline">
              Процесс не запущен в PM2.
              <template v-if="proc.definition?.script">
                Скрипт: <code>{{ proc.definition.script }}</code>
              </template>
            </div>
          </div>
        </div>
      </div>
    </template>

    <div v-else-if="error" class="site-node__error">
      Ошибка загрузки Node.js: {{ error }}
    </div>

    <!-- Logs modal -->
    <Teleport to="body">
      <div v-if="logsModal.open" class="node-modal" @mousedown.self="closeLogs">
        <div class="node-modal__panel" @mousedown.stop>
          <div class="node-modal__head">
            <strong>Логи · {{ logsModal.title }}</strong>
            <div class="node-modal__head-actions">
              <button class="btn btn--primary btn--sm" :disabled="logsModal.loading" @click="reloadLogs">
                {{ logsModal.loading ? 'Загрузка…' : 'Обновить' }}
              </button>
              <button class="btn btn--ghost btn--sm" @click="closeLogs">Закрыть</button>
            </div>
          </div>
          <pre v-if="!logsModal.loading" class="node-modal__body mono">{{ logsModal.content }}</pre>
          <div v-else class="node-modal__loading"><div class="spinner" /></div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch, onBeforeUnmount } from 'vue';
import type {
  NodeProcessesResult,
  NodeProcessView,
  NodeEcosystemGroup,
} from '@meowbox/shared';

const props = defineProps<{ siteId: string; active: boolean }>();

const api = useApi();
const toast = useMbToast();
const confirm = useMbConfirm();

const data = ref<NodeProcessesResult | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const autostartBusy = ref(false);
const busy = reactive<Record<string, 'start' | 'stop' | 'restart' | 'reload' | 'delete' | undefined>>({});

const logsModal = reactive({ open: false, loading: false, content: '', title: '', name: '' });

let loaded = false;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

async function load(silent = false) {
  if (!silent) loading.value = true;
  error.value = null;
  try {
    data.value = await api.get<NodeProcessesResult>(`/sites/${props.siteId}/node/processes`);
    loaded = true;
  } catch (e: unknown) {
    if (!silent) error.value = (e as Error).message || 'неизвестная ошибка';
  } finally {
    if (!silent) loading.value = false;
  }
}

async function refresh() {
  await load();
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    // Не мешаем активным действиям и открытой модалке.
    if (props.active && !logsModal.open && Object.keys(busy).length === 0) {
      void load(true);
    }
  }, 5000);
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

watch(
  () => props.active,
  (val) => {
    if (val) {
      if (!loaded) void load();
      startAutoRefresh();
    } else {
      stopAutoRefresh();
    }
  },
  { immediate: true },
);

onBeforeUnmount(stopAutoRefresh);

async function toggleAutostart(enabled: boolean) {
  autostartBusy.value = true;
  try {
    await api.put(`/sites/${props.siteId}/node/autostart`, { enabled });
    if (data.value) data.value.autostartEnabled = enabled;
    toast.success(enabled ? 'Автозагрузка включена' : 'Автозагрузка выключена');
  } catch (e: unknown) {
    toast.error((e as Error).message || 'Не удалось изменить автозагрузку');
  } finally {
    autostartBusy.value = false;
  }
}

async function startProcess(proc: NodeProcessView, group: NodeEcosystemGroup) {
  const file = proc.ecosystemFile ?? group.ecosystemFile;
  if (!file) {
    toast.error('У процесса нет ecosystem-файла — запуск невозможен');
    return;
  }
  busy[proc.name] = 'start';
  try {
    await api.post(`/sites/${props.siteId}/node/ecosystem/start`, { file, only: proc.name });
    toast.success(`Процесс «${proc.name}» запущен`);
    await load(true);
  } catch (e: unknown) {
    toast.error((e as Error).message || 'Не удалось запустить процесс');
  } finally {
    delete busy[proc.name];
  }
}

async function doAction(proc: NodeProcessView, action: 'stop' | 'restart' | 'reload') {
  busy[proc.name] = action;
  const labels: Record<typeof action, string> = {
    stop: 'остановлен',
    restart: 'перезапущен',
    reload: 'перезагружен',
  };
  try {
    await api.post(`/sites/${props.siteId}/node/processes/${encodeURIComponent(proc.name)}/${action}`);
    toast.success(`Процесс «${proc.name}» ${labels[action]}`);
    await load(true);
  } catch (e: unknown) {
    toast.error((e as Error).message || 'Действие не выполнено');
  } finally {
    delete busy[proc.name];
  }
}

async function removeProcess(proc: NodeProcessView) {
  const ok = await confirm.ask({
    title: 'Удалить процесс',
    message: `Удалить процесс «${proc.name}» из PM2? Определение в ecosystem-файле останется — процесс можно будет запустить заново.`,
    confirmText: 'Удалить',
    danger: true,
  });
  if (!ok) return;
  busy[proc.name] = 'delete';
  try {
    await api.del(`/sites/${props.siteId}/node/processes/${encodeURIComponent(proc.name)}`);
    toast.success(`Процесс «${proc.name}» удалён из PM2`);
    await load(true);
  } catch (e: unknown) {
    toast.error((e as Error).message || 'Не удалось удалить процесс');
  } finally {
    delete busy[proc.name];
  }
}

async function openLogs(proc: NodeProcessView) {
  logsModal.name = proc.name;
  logsModal.title = proc.name;
  logsModal.open = true;
  await reloadLogs();
}

async function reloadLogs() {
  if (!logsModal.name) return;
  logsModal.loading = true;
  try {
    const r = await api.get<{ content: string }>(
      `/sites/${props.siteId}/node/processes/${encodeURIComponent(logsModal.name)}/logs?lines=200`,
    );
    logsModal.content = r.content || '(пусто)';
  } catch (e: unknown) {
    logsModal.content = `Ошибка: ${(e as Error).message}`;
  } finally {
    logsModal.loading = false;
  }
}

function closeLogs() {
  logsModal.open = false;
  logsModal.content = '';
  logsModal.name = '';
}

/** Вид бейджа по статусу процесса. */
function badgeKind(proc: NodeProcessView): 'ok' | 'idle' | 'err' | 'warn' {
  if (!proc.loaded || !proc.runtime) return 'idle';
  switch (proc.runtime.status) {
    case 'online': return 'ok';
    case 'stopped': return 'idle';
    case 'errored': return 'err';
    default: return 'warn';
  }
}

function statusLabel(proc: NodeProcessView): string {
  if (!proc.loaded || !proc.runtime) return 'Не запущен';
  switch (proc.runtime.status) {
    case 'online': return 'Работает';
    case 'stopped': return 'Остановлен';
    case 'errored': return 'Ошибка';
    case 'launching': return 'Запуск…';
    case 'stopping': return 'Остановка…';
    default: return proc.runtime.status;
  }
}

function execModeLabel(mode: string | null): string {
  if (mode === 'cluster_mode') return 'cluster';
  if (mode === 'fork_mode') return 'fork';
  return mode || 'fork';
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

function formatUptime(startedAtMs: number, status: string): string {
  if (status !== 'online' || !startedAtMs) return '—';
  let sec = Math.floor((Date.now() - startedAtMs) / 1000);
  if (sec < 0) sec = 0;
  if (sec < 60) return `${sec}с`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}м`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}ч ${min % 60}м`;
  const days = Math.floor(hours / 24);
  return `${days}д ${hours % 24}ч`;
}
</script>

<style scoped>
.site-node {
  display: flex;
  flex-direction: column;
  gap: 0.95rem;
}

.site-node__loading,
.site-node__error {
  padding: 2rem 1rem;
  text-align: center;
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.65rem;
}
.site-node__error { color: rgb(248, 113, 113); }

/* ─── Верхняя панель: автозагрузка + обновить ─── */
.site-node__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 0.85rem 1.05rem;
}

.site-node__autostart {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  cursor: pointer;
}
.site-node__switch {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}
.site-node__autostart-track {
  flex-shrink: 0;
  width: 38px;
  height: 22px;
  border-radius: 999px;
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  position: relative;
  transition: background 0.2s, border-color 0.2s;
}
.site-node__autostart-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--text-tertiary);
  transition: transform 0.2s, background 0.2s;
}
.site-node__switch:checked + .site-node__autostart-track {
  background: rgba(16, 185, 129, 0.25);
  border-color: rgba(16, 185, 129, 0.5);
}
.site-node__switch:checked + .site-node__autostart-track .site-node__autostart-thumb {
  transform: translateX(16px);
  background: rgb(52, 211, 153);
}
.site-node__switch:disabled + .site-node__autostart-track { opacity: 0.5; }
.site-node__autostart-text { display: flex; flex-direction: column; gap: 1px; }
.site-node__autostart-title { font-size: 0.86rem; font-weight: 600; color: var(--text-primary); }
.site-node__autostart-hint { font-size: 0.74rem; color: var(--text-tertiary); }

/* ─── Пустое состояние ─── */
.site-node__empty {
  padding: 2.5rem 1.5rem;
  text-align: center;
  background: var(--bg-elevated);
  border: 1px dashed var(--border-strong);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}
.site-node__empty-icon { color: var(--text-tertiary); opacity: 0.55; }
.site-node__empty-title { font-size: 0.95rem; font-weight: 600; color: var(--text-primary); margin: 0; }
.site-node__empty-text {
  font-size: 0.8rem;
  color: var(--text-tertiary);
  margin: 0;
  max-width: 460px;
  line-height: 1.5;
}

/* ─── Группа ecosystem-файла ─── */
.site-node__group {
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  overflow: hidden;
}
.site-node__group-head {
  display: flex;
  align-items: flex-start;
  gap: 0.65rem;
  padding: 0.85rem 1.05rem;
  border-bottom: 1px solid var(--border-subtle);
}
.site-node__group-icon { color: var(--primary-light); margin-top: 2px; flex-shrink: 0; }
.site-node__group-icon--orphan { color: var(--text-tertiary); }
.site-node__group-titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.site-node__group-title { font-size: 0.88rem; font-weight: 600; color: var(--text-primary); }
.site-node__group-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.72rem;
  color: var(--text-tertiary);
  word-break: break-all;
}
.site-node__group-path--muted { font-family: inherit; }

.site-node__procs {
  display: flex;
  flex-direction: column;
}

/* ─── Карточка процесса ─── */
.nproc {
  padding: 0.9rem 1.05rem;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.nproc + .nproc { border-top: 1px solid var(--border-subtle); }

.nproc__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.85rem;
  flex-wrap: wrap;
}
.nproc__title-block { display: flex; align-items: center; gap: 0.6rem; }
.nproc__name {
  font-weight: 600;
  font-size: 0.92rem;
  color: var(--text-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.nproc__badge {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.72rem;
  font-weight: 500;
  padding: 0.22rem 0.55rem;
  border-radius: 999px;
  white-space: nowrap;
}
.nproc__badge--ok { background: rgba(16, 185, 129, 0.13); color: rgb(52, 211, 153); }
.nproc__badge--idle { background: rgba(115, 115, 115, 0.16); color: var(--text-tertiary); }
.nproc__badge--err { background: rgba(239, 68, 68, 0.13); color: rgb(248, 113, 113); }
.nproc__badge--warn { background: rgba(var(--primary-rgb), 0.13); color: var(--primary-light); }

.status-dot { width: 7px; height: 7px; border-radius: 50%; }
.status-dot--ok { background: rgb(52, 211, 153); box-shadow: 0 0 5px rgba(52, 211, 153, 0.6); }
.status-dot--idle { background: rgb(115, 115, 115); }
.status-dot--err { background: rgb(248, 113, 113); }
.status-dot--warn { background: var(--primary-light); }

.nproc__actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }

.nproc__metrics {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 0.5rem;
}
.nproc__metric {
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 0.5rem 0.65rem;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nproc__metric-label {
  font-size: 0.68rem;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.nproc__metric-value { font-size: 0.92rem; font-weight: 600; color: var(--text-primary); }
.nproc__metric-sub { font-size: 0.68rem; font-weight: 500; color: var(--text-tertiary); margin-left: 0.25rem; }

.nproc__offline {
  font-size: 0.78rem;
  color: var(--text-tertiary);
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 0.5rem 0.7rem;
}

code {
  background: var(--bg-code);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  padding: 0.05rem 0.3rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.86em;
  color: var(--text-secondary);
}

.site-node__spin { animation: nodeSpin 0.8s linear infinite; }
.spinner {
  width: 24px; height: 24px;
  border: 2px solid var(--spinner-track, var(--border-subtle));
  border-top-color: var(--primary, var(--primary-light));
  border-radius: 50%;
  animation: nodeSpin 0.8s linear infinite;
}
@keyframes nodeSpin { to { transform: rotate(360deg); } }

/* ─── Logs modal ─── */
.node-modal {
  position: fixed;
  inset: 0;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  padding: 1rem;
  animation: nodeModalFade 0.18s ease;
}
.node-modal__panel {
  background: var(--bg-modal-gradient, var(--bg-modal));
  border: 1px solid var(--border-secondary, var(--border-subtle));
  border-radius: 14px;
  width: min(900px, 100%);
  height: min(80vh, 700px);
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-modal, 0 20px 50px rgba(0, 0, 0, 0.35));
  color: var(--text-primary);
  animation: nodeModalIn 0.22s ease;
}
.node-modal__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.95rem 1.1rem;
  border-bottom: 1px solid var(--border-subtle);
}
.node-modal__head-actions { display: flex; gap: 0.5rem; }
.node-modal__body {
  flex: 1;
  overflow: auto;
  padding: 1rem 1.1rem;
  margin: 0;
  font-size: 0.78rem;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-secondary);
  background: var(--bg-code);
}
.node-modal__loading { flex: 1; display: flex; align-items: center; justify-content: center; }
@keyframes nodeModalFade { from { opacity: 0; } to { opacity: 1; } }
@keyframes nodeModalIn {
  from { opacity: 0; transform: scale(0.97) translateY(8px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}

.mono {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.78rem;
}

/* ─── Кнопки ─── */
.btn {
  display: inline-flex; align-items: center; justify-content: center;
  gap: 0.4rem; padding: 0.55rem 1rem;
  border-radius: 10px; border: none; font-size: 0.82rem; font-weight: 600;
  font-family: inherit; cursor: pointer; transition: all 0.2s; white-space: nowrap;
}
.btn--sm { padding: 0.4rem 0.75rem; font-size: 0.74rem; border-radius: 8px; }
.btn--primary { background: linear-gradient(135deg, var(--primary-light), var(--primary-dark)); color: var(--primary-text-on); }
.btn--primary:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(var(--primary-rgb), 0.2); }
.btn--primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--ghost { background: var(--bg-input); border: 1px solid var(--border-strong); color: var(--text-tertiary); }
.btn--ghost:hover:not(:disabled) { color: var(--text-secondary); border-color: var(--border-strong); }
.btn--ghost:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--danger { background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); color: rgb(248, 113, 113); }
.btn--danger:hover:not(:disabled) { background: rgba(239, 68, 68, 0.25); }
.btn--danger:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
