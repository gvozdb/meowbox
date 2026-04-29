<template>
  <div class="procs-page">
    <div class="procs-page__header">
      <div>
        <h1 class="procs-page__title">PM2 Processes</h1>
        <p class="procs-page__subtitle">Manage running Node.js applications</p>
      </div>
      <button class="procs-page__refresh" @click="load()" :disabled="loading">
        <svg v-if="!loading" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23,4 23,10 17,10" /><path d="M20.49,15a9,9,0,1,1-2.12-9.36L23,10" /></svg>
        <span v-if="loading" class="procs-page__spinner" />
        {{ loading ? 'Loading...' : 'Refresh' }}
      </button>
    </div>

    <div v-if="loading && procs.length === 0" class="procs-loading">
      <div class="procs-page__spinner" />
      <span>Loading processes...</span>
    </div>

    <div v-else-if="procs.length === 0" class="procs-empty">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="opacity:0.3">
        <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
      </svg>
      <p>No PM2 processes running</p>
    </div>

    <div v-else class="procs-list">
      <div v-for="p in procs" :key="p.name" class="proc-card">
        <div class="proc-card__header">
          <div class="proc-card__status" :class="`proc-card__status--${p.status}`" />
          <span class="proc-card__name">{{ p.name }}</span>
          <span class="proc-card__pid mono">PID {{ p.pid }}</span>
        </div>

        <div class="proc-card__metrics">
          <div class="proc-card__metric">
            <span class="proc-card__metric-label">CPU</span>
            <span class="proc-card__metric-value">{{ p.cpu }}%</span>
          </div>
          <div class="proc-card__metric">
            <span class="proc-card__metric-label">Memory</span>
            <span class="proc-card__metric-value">{{ formatBytes(p.memory) }}</span>
          </div>
          <div class="proc-card__metric">
            <span class="proc-card__metric-label">Uptime</span>
            <span class="proc-card__metric-value">{{ formatUptime(p.uptime) }}</span>
          </div>
          <div class="proc-card__metric">
            <span class="proc-card__metric-label">Restarts</span>
            <span class="proc-card__metric-value" :class="{ 'proc-card__metric-value--warn': p.restarts > 5 }">{{ p.restarts }}</span>
          </div>
        </div>

        <div class="proc-card__actions">
          <button
            v-if="p.status === 'stopped'"
            class="proc-card__btn proc-card__btn--start"
            @click="controlProc(p.name, 'restart')"
            :disabled="acting"
          >Start</button>
          <button
            v-if="p.status === 'online'"
            class="proc-card__btn proc-card__btn--restart"
            @click="controlProc(p.name, 'restart')"
            :disabled="acting"
          >Restart</button>
          <button
            v-if="p.status === 'online'"
            class="proc-card__btn proc-card__btn--reload"
            @click="controlProc(p.name, 'reload')"
            :disabled="acting"
          >Reload</button>
          <button
            v-if="p.status === 'online'"
            class="proc-card__btn proc-card__btn--stop"
            @click="controlProc(p.name, 'stop')"
            :disabled="acting"
          >Stop</button>
          <button
            class="proc-card__btn proc-card__btn--logs"
            @click="viewLogs(p.name)"
          >Logs</button>
        </div>

        <!-- Logs panel -->
        <div v-if="logsFor === p.name" class="proc-card__logs">
          <div class="proc-card__logs-header">
            <span>Logs: {{ p.name }}</span>
            <button class="proc-card__logs-close" @click="logsFor = ''">Close</button>
          </div>
          <pre class="proc-card__logs-output"><code>{{ logsContent }}</code></pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface Pm2Proc {
  name: string;
  pid: number;
  status: string;
  cpu: number;
  memory: number;
  uptime: number;
  restarts: number;
}

const api = useApi();
const procs = ref<Pm2Proc[]>([]);
const loading = ref(true);
const acting = ref(false);
const logsFor = ref('');
const logsContent = ref('');

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatUptime(startMs: number): string {
  if (!startMs) return '—';
  const diff = Date.now() - startMs;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

async function load() {
  loading.value = true;
  try {
    procs.value = await api.get<Pm2Proc[]>('/processes') || [];
  } catch {
    procs.value = [];
  } finally {
    loading.value = false;
  }
}

async function controlProc(name: string, action: string) {
  acting.value = true;
  try {
    await api.post(`/processes/${encodeURIComponent(name)}/${action}`);
    await load();
  } catch {
    // Failed
  } finally {
    acting.value = false;
  }
}

async function viewLogs(name: string) {
  if (logsFor.value === name) {
    logsFor.value = '';
    return;
  }
  logsFor.value = name;
  logsContent.value = 'Loading...';
  try {
    const data = await api.get<{ stdout: string; stderr: string }>(`/processes/${encodeURIComponent(name)}/logs?lines=200`);
    logsContent.value = (data?.stdout || '') + (data?.stderr ? '\n--- STDERR ---\n' + data.stderr : '');
  } catch {
    logsContent.value = 'Failed to load logs';
  }
}

onMounted(load);
</script>

<style scoped>
.procs-page__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.procs-page__title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0;
}

.procs-page__subtitle {
  font-size: 0.82rem;
  color: var(--text-muted);
  margin: 0.25rem 0 0;
}

.procs-page__refresh {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.5rem 1rem;
  border-radius: 10px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 0.82rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
  flex-shrink: 0;
}

.procs-page__refresh:hover:not(:disabled) {
  background: var(--bg-elevated);
  border-color: var(--border);
}

.procs-page__refresh:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.procs-page__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--spinner-track);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

.procs-loading, .procs-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding: 3rem;
  color: var(--text-muted);
  font-size: 0.85rem;
}

.procs-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.proc-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  padding: 1rem 1.15rem;
}

.proc-card__header {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  margin-bottom: 0.85rem;
}

.proc-card__status {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.proc-card__status--online { background: #4ade80; box-shadow: 0 0 6px rgba(74, 222, 128, 0.4); }
.proc-card__status--stopped { background: var(--text-faint); }
.proc-card__status--errored { background: #f87171; box-shadow: 0 0 6px rgba(248, 113, 113, 0.4); }
.proc-card__status--launching { background: var(--primary-text); animation: pulse 1s infinite; }

@keyframes pulse { 50% { opacity: 0.5; } }

.proc-card__name {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-secondary);
}

.proc-card__pid {
  font-size: 0.7rem;
  color: var(--text-faint);
  margin-left: auto;
}

.proc-card__metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.65rem;
  margin-bottom: 0.85rem;
}

.proc-card__metric {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.proc-card__metric-label {
  font-size: 0.68rem;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 600;
}

.proc-card__metric-value {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-secondary);
  font-family: 'JetBrains Mono', monospace;
}

.proc-card__metric-value--warn { color: var(--primary-text); }

.proc-card__actions {
  display: flex;
  gap: 0.35rem;
  flex-wrap: wrap;
}

.proc-card__btn {
  padding: 0.3rem 0.7rem;
  border-radius: 7px;
  font-size: 0.72rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
  border: 1px solid;
}

.proc-card__btn--start, .proc-card__btn--restart {
  background: rgba(34, 197, 94, 0.06);
  border-color: rgba(34, 197, 94, 0.2);
  color: #4ade80;
}
.proc-card__btn--start:hover, .proc-card__btn--restart:hover { background: rgba(34, 197, 94, 0.12); }

.proc-card__btn--reload {
  background: rgba(59, 130, 246, 0.06);
  border-color: rgba(59, 130, 246, 0.2);
  color: #60a5fa;
}
.proc-card__btn--reload:hover { background: rgba(59, 130, 246, 0.12); }

.proc-card__btn--stop {
  background: rgba(239, 68, 68, 0.06);
  border-color: rgba(239, 68, 68, 0.2);
  color: #f87171;
}
.proc-card__btn--stop:hover { background: rgba(239, 68, 68, 0.12); }

.proc-card__btn--logs {
  background: var(--bg-elevated);
  border-color: var(--border-secondary);
  color: var(--text-muted);
}
.proc-card__btn--logs:hover { color: var(--text-secondary); border-color: var(--border); }

.proc-card__btn:disabled { opacity: 0.35; cursor: not-allowed; }

/* Logs panel */
.proc-card__logs {
  margin-top: 0.85rem;
  border-top: 1px solid var(--border);
  padding-top: 0.75rem;
}

.proc-card__logs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 0.5rem;
}

.proc-card__logs-close {
  padding: 0.2rem 0.5rem;
  border-radius: 6px;
  border: 1px solid var(--border-secondary);
  background: transparent;
  color: var(--text-muted);
  font-size: 0.68rem;
  font-family: inherit;
  cursor: pointer;
}

.proc-card__logs-close:hover {
  background: var(--border);
  color: var(--text-secondary);
}

.proc-card__logs-output {
  padding: 0.75rem;
  margin: 0;
  background: var(--bg-code);
  border-radius: 10px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.68rem;
  line-height: 1.6;
  color: var(--text-tertiary);
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 300px;
}

.mono { font-family: 'JetBrains Mono', monospace; }

@media (max-width: 768px) {
  .procs-page__header { flex-direction: column; gap: 0.75rem; }
  .procs-page__title { font-size: 1.2rem; }
  .proc-card__metrics { grid-template-columns: repeat(2, 1fr); }
}
</style>
