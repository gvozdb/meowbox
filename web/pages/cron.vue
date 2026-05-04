<template>
  <div class="cron">
    <div class="cron__header">
      <div>
        <h1 class="cron__title">Cron Jobs</h1>
        <p class="cron__subtitle">Scheduled task management</p>
      </div>
    </div>

    <!-- Scope Selector: SYSTEM (root) | конкретный сайт -->
    <div class="cron__selector">
      <label class="form-label">Scope</label>
      <select v-model="selectedScope" class="form-input form-input--select" @change="onScopeChange">
        <option value="system">★ Системный (root)</option>
        <option disabled value="-">— Сайты —</option>
        <option v-for="s in sites" :key="s.id" :value="`site:${s.id}`">{{ s.name }}</option>
      </select>
    </div>

    <div v-if="isSystemScope" class="cron__system-banner">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /></svg>
      <span>Эти задачи выполняются от имени <strong>root</strong>. Будь осторожен — у них полный доступ к системе.</span>
    </div>

    <template v-if="hasScopeSelected">
      <div class="cron__toolbar">
        <span class="cron__count">{{ jobs.length }} job{{ jobs.length === 1 ? '' : 's' }}</span>
        <button class="btn btn--primary btn--sm" @click="openEditor()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
          Add Cron Job
        </button>
      </div>

      <div v-if="!jobs.length" class="empty-card">
        <CatMascot :size="56" mood="sleepy" />
        <p>No cron jobs configured</p>
      </div>
      <div v-else class="job-list">
        <div v-for="job in jobs" :key="job.id" class="job-card" :class="{ 'job-card--disabled': job.status === 'DISABLED' }">
          <div class="job-card__main">
            <div class="job-card__toggle">
              <button class="toggle" :class="{ 'toggle--on': job.status === 'ACTIVE' }" @click="toggleJob(job)">
                <span class="toggle__knob" />
              </button>
            </div>
            <div class="job-card__info">
              <span class="job-card__name">
                <!-- spec §8.3: «иконка/значок root (например, ✦) рядом с именем» -->
                <span v-if="isSystemScope" class="job-card__root-mark" title="root cron — выполняется от имени root">✦</span>
                {{ job.name }}
                <span v-if="job.source === 'IMPORTED_HOSTPANEL'" class="job-card__badge" title="Импортирован из старой hostPanel">imported</span>
              </span>
              <code class="job-card__command">{{ job.command }}</code>
            </div>
            <div class="job-card__schedule">
              <span class="job-card__schedule-label">{{ describeSchedule(job.schedule) }}</span>
              <code class="job-card__schedule-cron">{{ job.schedule }}</code>
            </div>
            <div class="job-card__actions">
              <button v-if="job.lastRunAt" class="row-action" title="Last run" @click="expandedJobId = expandedJobId === job.id ? '' : job.id">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" /><polyline points="12,6 12,12 16,14" /></svg>
              </button>
              <button class="row-action" title="Edit" @click="openEditor(job)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
              </button>
              <button class="row-action row-action--red" title="Delete" @click="confirmDelete(job)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
              </button>
            </div>
          </div>
          <div v-if="expandedJobId === job.id && job.lastRunAt" class="job-card__log">
            <div class="job-card__log-header">
              <span class="job-card__log-label">Last run: {{ formatDate(job.lastRunAt) }}</span>
              <span class="job-card__log-exit" :class="{ 'job-card__log-exit--ok': job.lastExitCode === 0, 'job-card__log-exit--fail': job.lastExitCode !== 0 }">
                Exit {{ job.lastExitCode ?? '?' }}
              </span>
            </div>
            <pre v-if="job.lastOutput" class="job-card__log-output">{{ job.lastOutput }}</pre>
            <span v-else class="job-card__log-empty">No output captured</span>
          </div>
        </div>
      </div>
    </template>

    <div v-else class="cron__placeholder">
      <CatMascot :size="80" mood="sleepy" />
      <p>Select scope to manage cron jobs</p>
    </div>

    <!-- Create/Edit Modal -->
    <Teleport to="body">
      <div v-if="showEditor" class="modal-overlay" @mousedown.self="showEditor = false">
        <div class="modal">
          <h3 class="modal__title">{{ editingJob ? 'Edit Cron Job' : 'New Cron Job' }}</h3>
          <div class="modal__fields">
            <div class="form-group">
              <label class="form-label">Name</label>
              <input v-model="editorForm.name" type="text" class="form-input" placeholder="Cleanup temp files" />
            </div>
            <div class="form-group">
              <label class="form-label">Schedule</label>
              <div class="preset-chips">
                <button v-for="p in presets" :key="p.value" class="chip" :class="{ 'chip--active': editorForm.schedule === p.value }" @click="editorForm.schedule = p.value">{{ p.label }}</button>
              </div>
              <input v-model="editorForm.schedule" type="text" class="form-input mono" placeholder="* * * * *" />
              <span class="form-hint">minute hour day month weekday</span>
            </div>
            <div class="form-group">
              <label class="form-label">Command</label>
              <textarea v-model="editorForm.command" class="form-input mono editor-command" rows="3" maxlength="1024" placeholder="/usr/bin/php artisan schedule:run" />
            </div>
          </div>
          <div v-if="editorError" class="modal__error">{{ editorError }}</div>
          <div class="modal__actions">
            <button class="btn btn--ghost" @click="showEditor = false">Cancel</button>
            <button class="btn btn--primary" :disabled="!editorForm.name || !editorForm.schedule || !editorForm.command || saving" @click="saveJob">
              {{ saving ? 'Saving...' : (editingJob ? 'Update' : 'Create') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Delete Modal -->
    <Teleport to="body">
      <div v-if="deleteTarget" class="modal-overlay" @mousedown.self="deleteTarget = null">
        <div class="modal">
          <h3 class="modal__title">Delete Cron Job</h3>
          <p class="modal__desc">Delete <strong>{{ deleteTarget.name }}</strong>? This cannot be undone.</p>
          <div class="modal__actions">
            <button class="btn btn--ghost" @click="deleteTarget = null">Cancel</button>
            <button class="btn btn--danger" :disabled="deleting" @click="doDelete">{{ deleting ? 'Deleting...' : 'Delete' }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface CronJob { id: string; name: string; schedule: string; command: string; status: string; source?: string; comment?: string | null; lastRunAt?: string; lastExitCode?: number; lastOutput?: string; }
interface SiteItem { id: string; name: string; }

const api = useApi();
const sites = ref<SiteItem[]>([]);
// Scope: 'system' (root crontab) | 'site:<id>' (per-site crontab) | '' (none)
const selectedScope = ref<string>('system');
const jobs = ref<CronJob[]>([]);

// Производные геттеры для шаблона
const isSystemScope = computed(() => selectedScope.value === 'system');
const selectedSiteId = computed(() => {
  return selectedScope.value.startsWith('site:')
    ? selectedScope.value.slice('site:'.length)
    : '';
});
const hasScopeSelected = computed(() => isSystemScope.value || !!selectedSiteId.value);

const showEditor = ref(false);
const editingJob = ref<CronJob | null>(null);
const editorForm = reactive({ name: '', schedule: '', command: '' });
const editorError = ref('');
const saving = ref(false);

const deleteTarget = ref<CronJob | null>(null);
const deleting = ref(false);
const expandedJobId = ref('');

const toast = useMbToast();

function onScopeChange() {
  jobs.value = [];
  loadJobs();
}

const presets = [
  { label: 'Every min', value: '* * * * *' },
  { label: 'Hourly', value: '0 * * * *' },
  { label: 'Daily', value: '0 0 * * *' },
  { label: 'Weekly', value: '0 0 * * 0' },
  { label: 'Monthly', value: '0 0 1 * *' },
];

function showToast(msg: string, isError = false) {
  if (isError) toast.error(msg);
  else toast.success(msg);
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function describeSchedule(cron: string): string {
  if (cron === '* * * * *') return 'Every minute';
  if (cron === '0 * * * *') return 'Every hour';
  if (cron === '0 0 * * *') return 'Daily at midnight';
  if (cron === '0 0 * * 0') return 'Weekly (Sunday)';
  if (cron === '0 0 1 * *') return 'Monthly (1st)';
  return 'Custom';
}

function openEditor(job?: CronJob) {
  editingJob.value = job || null;
  editorForm.name = job?.name || '';
  editorForm.schedule = job?.schedule || '';
  editorForm.command = job?.command || '';
  editorError.value = '';
  showEditor.value = true;
}

async function loadJobs() {
  if (isSystemScope.value) {
    try {
      jobs.value = await api.get<CronJob[]>('/system-cron');
    } catch { jobs.value = []; }
    return;
  }
  if (!selectedSiteId.value) { jobs.value = []; return; }
  try {
    jobs.value = await api.get<CronJob[]>(`/sites/${selectedSiteId.value}/cron-jobs`);
  } catch { jobs.value = []; }
}

async function saveJob() {
  saving.value = true;
  editorError.value = '';
  try {
    if (editingJob.value) {
      const url = isSystemScope.value
        ? `/system-cron/${editingJob.value.id}`
        : `/cron-jobs/${editingJob.value.id}`;
      await api.put(url, { name: editorForm.name, schedule: editorForm.schedule, command: editorForm.command });
      showToast('Cron job updated');
    } else {
      if (isSystemScope.value) {
        await api.post('/system-cron', { name: editorForm.name, schedule: editorForm.schedule, command: editorForm.command });
      } else {
        await api.post('/cron-jobs', { siteId: selectedSiteId.value, name: editorForm.name, schedule: editorForm.schedule, command: editorForm.command });
      }
      showToast('Cron job created');
    }
    showEditor.value = false;
    await loadJobs();
  } catch {
    editorError.value = 'Failed to save cron job';
  } finally {
    saving.value = false;
  }
}

async function toggleJob(job: CronJob) {
  const url = isSystemScope.value
    ? `/system-cron/${job.id}/toggle`
    : `/cron-jobs/${job.id}/toggle`;
  try {
    await api.post(url);
    await loadJobs();
  } catch {
    showToast('Failed to toggle job', true);
  }
}

function confirmDelete(job: CronJob) { deleteTarget.value = job; }

async function doDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  const url = isSystemScope.value
    ? `/system-cron/${deleteTarget.value.id}`
    : `/cron-jobs/${deleteTarget.value.id}`;
  try {
    await api.del(url);
    showToast('Cron job deleted');
    deleteTarget.value = null;
    await loadJobs();
  } catch { showToast('Failed to delete', true); }
  finally { deleting.value = false; }
}

onMounted(async () => {
  try { sites.value = await api.get<SiteItem[]>('/sites'); } catch { /* ignore */ }
  // На загрузке — сразу показываем системные краны (как и просили).
  await loadJobs();
});
</script>

<style scoped>
.cron__header { margin-bottom: 1.5rem; }
.cron__title { font-size: 1.5rem; font-weight: 700; color: var(--text-heading); margin: 0; }
.cron__subtitle { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.15rem; }
.cron__selector { max-width: 360px; margin-bottom: 1.5rem; }
.cron__toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
.cron__count { font-size: 0.78rem; color: var(--text-muted); }
.cron__placeholder { display: flex; flex-direction: column; align-items: center; padding: 4rem 1rem; gap: 0.75rem; color: var(--text-muted); font-size: 0.85rem; }
.cron__system-banner {
  display: flex; align-items: center; gap: 0.6rem;
  padding: 0.65rem 0.85rem;
  background: rgba(var(--primary-rgb), 0.08);
  border: 1px solid rgba(var(--primary-rgb), 0.2);
  border-radius: 10px;
  font-size: 0.78rem; color: rgba(var(--primary-rgb), 0.9);
  margin-bottom: 1rem;
}
.cron__system-banner strong { color: var(--text-secondary); font-weight: 600; }
.cron__system-banner svg { flex-shrink: 0; }
.job-card__root-mark {
  display: inline-block; margin-right: 0.3rem;
  color: var(--primary-light); font-size: 0.85rem; font-weight: 700;
}
.job-card__badge {
  display: inline-block;
  margin-left: 0.4rem;
  padding: 0.05rem 0.4rem;
  font-size: 0.6rem; font-weight: 600;
  border-radius: 4px;
  background: rgba(99, 102, 241, 0.12);
  color: rgb(129, 140, 248);
  text-transform: uppercase; letter-spacing: 0.04em;
  vertical-align: middle;
}

/* Job list */
.job-list { display: flex; flex-direction: column; gap: 0.4rem; }

.job-card {
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 12px; transition: border-color 0.2s;
}
.job-card:hover { border-color: var(--border-secondary); }
.job-card--disabled { opacity: 0.5; }

.job-card__main { display: flex; align-items: center; gap: 0.85rem; padding: 0.75rem 1rem; }
.job-card__toggle { flex-shrink: 0; }

/* Toggle switch */
.toggle {
  width: 36px; height: 20px; border-radius: 10px; border: none; padding: 2px;
  background: var(--border-strong); cursor: pointer; position: relative; transition: background 0.3s;
}
.toggle--on { background: rgba(34, 197, 94, 0.3); }
.toggle__knob {
  display: block; width: 16px; height: 16px; border-radius: 50%;
  background: var(--text-tertiary); transition: all 0.3s;
}
.toggle--on .toggle__knob { transform: translateX(16px); background: #4ade80; }

.job-card__info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.15rem; }
.job-card__name { font-size: 0.85rem; font-weight: 600; color: var(--text-secondary); }
.job-card__command {
  font-size: 0.72rem; font-family: 'JetBrains Mono', monospace; color: var(--text-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: none; padding: 0;
}

.job-card__schedule { text-align: right; flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; gap: 0.1rem; }
.job-card__schedule-label { font-size: 0.72rem; color: var(--text-tertiary); }
.job-card__schedule-cron { font-size: 0.65rem; font-family: 'JetBrains Mono', monospace; color: rgba(var(--primary-rgb), 0.5); background: none; padding: 0; }

.job-card__actions { display: flex; gap: 0.3rem; flex-shrink: 0; margin-left: 0.5rem; }

/* Job log */
.job-card__log {
  padding: 0.6rem 1rem 0.75rem;
  border-top: 1px solid var(--border);
}
.job-card__log-header {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.4rem;
}
.job-card__log-label { font-size: 0.72rem; color: var(--text-muted); }
.job-card__log-exit {
  font-size: 0.65rem; font-weight: 600; font-family: 'JetBrains Mono', monospace;
  padding: 0.15rem 0.4rem; border-radius: 5px;
}
.job-card__log-exit--ok { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
.job-card__log-exit--fail { background: rgba(239, 68, 68, 0.1); color: #f87171; }
.job-card__log-output {
  background: var(--bg-input); border: 1px solid var(--border);
  border-radius: 8px; padding: 0.5rem 0.65rem; margin: 0;
  font-family: 'JetBrains Mono', monospace; font-size: 0.7rem;
  color: var(--text-tertiary); white-space: pre-wrap; word-break: break-all;
  max-height: 200px; overflow-y: auto;
}
.job-card__log-empty { font-size: 0.72rem; color: var(--text-faint); }

.row-action {
  background: none; border: 1px solid var(--border-secondary); border-radius: 8px;
  padding: 0.35rem; cursor: pointer; display: flex; color: var(--text-faint); transition: all 0.2s;
}
.row-action:hover { color: var(--text-tertiary); border-color: var(--border-strong); }
.row-action--red:hover { color: #f87171; border-color: rgba(239, 68, 68, 0.2); background: rgba(239, 68, 68, 0.05); }

.empty-card {
  display: flex; flex-direction: column; align-items: center; padding: 2.5rem 1rem;
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 14px; color: var(--text-muted); font-size: 0.82rem; gap: 0.5rem;
}

/* Preset chips */
.preset-chips { display: flex; gap: 0.3rem; margin-bottom: 0.4rem; flex-wrap: wrap; }
.chip {
  padding: 0.3rem 0.6rem; border-radius: 7px; border: 1px solid var(--border-secondary);
  background: var(--bg-surface); color: var(--text-muted); font-size: 0.68rem;
  font-weight: 500; font-family: inherit; cursor: pointer; transition: all 0.2s;
}
.chip:hover { color: var(--text-tertiary); border-color: var(--border-strong); }
.chip--active { background: var(--primary-bg); border-color: var(--primary-border); color: var(--primary-text); }

/* Form */
.form-group { display: flex; flex-direction: column; gap: 0.3rem; }
.form-label { font-size: 0.75rem; font-weight: 500; color: var(--text-tertiary); }
.form-input {
  background: var(--bg-input); border: 1px solid var(--border-secondary);
  border-radius: 10px; padding: 0.55rem 0.8rem; font-size: 0.85rem;
  color: var(--text-primary); font-family: inherit; outline: none; transition: all 0.2s;
}
.form-input:focus { border-color: rgba(var(--primary-rgb), 0.25); box-shadow: var(--focus-ring); }
.form-input.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.82rem; }
.editor-command { resize: vertical; min-height: 70px; }
.form-input--select {
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23666' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 0.75rem center; padding-right: 2rem;
}
.form-hint { font-size: 0.68rem; color: var(--text-faint); }

/* Buttons */
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

/* Modal */
.modal-overlay { position: fixed; inset: 0; background: var(--bg-overlay); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; z-index: 200; padding: 1rem; }
.modal {
  background: var(--bg-modal-gradient);
  border: 1px solid var(--border-secondary); border-radius: 18px; padding: 1.5rem;
  width: 100%; max-width: 440px; box-shadow: var(--shadow-modal); animation: modalIn 0.25s ease;
}
.modal__title { font-size: 1.05rem; font-weight: 700; color: var(--text-heading); margin: 0 0 1rem; }
.modal__desc { font-size: 0.82rem; color: var(--text-tertiary); margin: 0 0 1.25rem; line-height: 1.5; }
.modal__desc strong { color: var(--text-secondary); }
.modal__fields { display: flex; flex-direction: column; gap: 0.85rem; margin-bottom: 1rem; }
.modal__error { color: #f87171; font-size: 0.78rem; margin-bottom: 0.75rem; }
.modal__actions { display: flex; gap: 0.5rem; justify-content: flex-end; }

@keyframes modalIn { from { opacity: 0; transform: scale(0.96) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }

@media (max-width: 768px) {
  .cron__selector { max-width: none; }
  .cron__title { font-size: 1.25rem; }
  .job-card__main {
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.65rem 0.75rem;
  }
  .job-card__info { width: 100%; order: 1; }
  .job-card__toggle { order: 0; }
  .job-card__schedule {
    text-align: left;
    align-items: flex-start;
    flex: 1;
    order: 2;
  }
  .job-card__actions {
    order: 3;
    justify-content: flex-end;
  }
  .job-card__command { max-width: calc(100vw - 6rem); }
}
</style>
