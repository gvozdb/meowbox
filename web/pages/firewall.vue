<template>
  <div class="firewall">
    <div class="firewall__header">
      <div>
        <h1 class="firewall__title">Firewall</h1>
        <p class="firewall__subtitle">Network access rules</p>
      </div>
      <div class="firewall__actions">
        <button class="btn btn--ghost" :disabled="syncing" @click="syncRules">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6" /><path d="M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
          {{ syncing ? 'Syncing...' : 'Sync to UFW' }}
        </button>
        <button class="btn btn--primary" @click="openEditor()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
          Add Rule
        </button>
      </div>
    </div>

    <!-- Warning banner -->
    <div class="firewall__warning">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" /></svg>
      <span>Be careful with firewall rules. Incorrect deny rules can lock you out of the server.</span>
    </div>

    <!-- Quick Presets -->
    <div class="presets-section">
      <h3 class="presets-title">Quick Presets</h3>
      <div class="presets-grid">
        <button
          v-for="p in presets"
          :key="p.name"
          class="preset-btn"
          :disabled="applyingPreset === p.name"
          @click="applyPreset(p.name)"
        >
          <span class="preset-btn__label">{{ p.label }}</span>
          <span class="preset-btn__count">{{ p.rules.length }} rule{{ p.rules.length > 1 ? 's' : '' }}</span>
        </button>
      </div>
    </div>

    <!-- UFW indicator -->
    <div v-if="ufwLoaded" class="ufw-indicator" :class="ufwEnabled ? 'ufw-indicator--on' : 'ufw-indicator--off'">
      <span class="ufw-indicator__dot" />
      UFW {{ ufwEnabled ? 'active' : 'inactive' }}
    </div>

    <!-- Rules table -->
    <div class="table-wrap">
      <div v-if="loading" class="table-empty">
        <div class="spinner" />
        <p>Loading rules...</p>
      </div>
      <div v-else-if="!allRules.length" class="table-empty">
        <CatMascot :size="64" mood="happy" />
        <p>No firewall rules configured</p>
      </div>
      <table v-else class="table">
        <thead>
          <tr>
            <th>Action</th>
            <th>Protocol</th>
            <th>Port</th>
            <th>Source</th>
            <th>Comment</th>
            <th class="table__actions-col">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="rule in allRules" :key="rule.id" class="table__row" :class="{ 'table__row--system': rule.source === 'system' }">
            <td>
              <span class="action-badge" :class="rule.action === 'ALLOW' ? 'action-badge--allow' : 'action-badge--deny'">
                <svg v-if="rule.action === 'ALLOW'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20,6 9,17 4,12" /></svg>
                <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                {{ rule.action }}
              </span>
            </td>
            <td><span class="mono-sm">{{ rule.protocol }}</span></td>
            <td><span class="mono-sm">{{ rule.port || '*' }}</span></td>
            <td><span class="mono-sm">{{ rule.sourceIp || 'Any' }}</span></td>
            <td>
              <span v-if="rule.source === 'system'" class="source-badge">System</span>
              <span v-else class="muted">{{ rule.comment || '—' }}</span>
            </td>
            <td>
              <div v-if="rule.source === 'panel'" class="row-actions">
                <button class="row-action" title="Edit" @click="openEditor(rule)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
                </button>
                <button class="row-action row-action--red" title="Delete" @click="confirmDelete(rule)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Create/Edit Modal -->
    <Teleport to="body">
      <div v-if="showEditor" class="modal-overlay" @mousedown.self="showEditor = false">
        <div class="modal">
          <h3 class="modal__title">{{ editingRule ? 'Edit Rule' : 'Add Firewall Rule' }}</h3>
          <div class="modal__fields">
            <div class="form-group">
              <label class="form-label">Action</label>
              <div class="radio-group">
                <label class="radio-option" :class="{ 'radio-option--active radio-option--allow': editorForm.action === 'ALLOW' }">
                  <input v-model="editorForm.action" type="radio" value="ALLOW" class="sr-only" />
                  <span class="radio-option__label">ALLOW</span>
                </label>
                <label class="radio-option" :class="{ 'radio-option--active radio-option--deny': editorForm.action === 'DENY' }">
                  <input v-model="editorForm.action" type="radio" value="DENY" class="sr-only" />
                  <span class="radio-option__label">DENY</span>
                </label>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Protocol</label>
              <div class="radio-group">
                <label v-for="p in ['TCP', 'UDP', 'BOTH']" :key="p" class="radio-option" :class="{ 'radio-option--active': editorForm.protocol === p }">
                  <input v-model="editorForm.protocol" type="radio" :value="p" class="sr-only" />
                  <span class="radio-option__label">{{ p }}</span>
                </label>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Port (optional)</label>
              <input v-model="editorForm.port" type="text" class="form-input mono" placeholder="22, 80, 443" />
              <span class="form-hint">Leave empty for all ports</span>
            </div>
            <div class="form-group">
              <label class="form-label">Source IP (optional)</label>
              <input v-model="editorForm.sourceIp" type="text" class="form-input mono" placeholder="0.0.0.0/0" />
              <span class="form-hint">Leave empty to apply to all IPs</span>
            </div>
            <div class="form-group">
              <label class="form-label">Comment (optional)</label>
              <input v-model="editorForm.comment" type="text" class="form-input" placeholder="Allow SSH access" />
            </div>
          </div>
          <div v-if="editorError" class="modal__error">{{ editorError }}</div>
          <div class="modal__actions">
            <button class="btn btn--ghost" @click="showEditor = false">Cancel</button>
            <button class="btn btn--primary" :disabled="!editorForm.action || !editorForm.protocol || saving" @click="saveRule">
              {{ saving ? 'Saving...' : (editingRule ? 'Update' : 'Create') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Delete Modal -->
    <Teleport to="body">
      <div v-if="deleteTarget" class="modal-overlay" @mousedown.self="deleteTarget = null">
        <div class="modal">
          <h3 class="modal__title">Delete Rule</h3>
          <p class="modal__desc">Delete this {{ deleteTarget.action }} rule for port <strong>{{ deleteTarget.port || 'all' }}</strong>?</p>
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

interface FirewallRule { id: string; action: string; protocol: string; port?: string; sourceIp?: string; comment?: string; }
interface UfwRule { to: string; action: string; from: string; }
interface DisplayRule { id: string; action: string; protocol: string; port: string; sourceIp: string; comment: string; source: 'panel' | 'system'; }

const api = useApi();
const rules = ref<FirewallRule[]>([]);
const loading = ref(true);

const showEditor = ref(false);
const editingRule = ref<FirewallRule | null>(null);
const editorForm = reactive({ action: 'ALLOW', protocol: 'TCP', port: '', sourceIp: '', comment: '' });
const editorError = ref('');
const saving = ref(false);

const deleteTarget = ref<FirewallRule | null>(null);
const deleting = ref(false);

const ufwParsedRules = ref<UfwRule[]>([]);
const ufwEnabled = ref(false);
const ufwLoaded = ref(false);
const syncing = ref(false);

function parseUfwTo(to: string): { port: string; protocol: string } {
  // "11862/tcp" → port=11862, protocol=TCP
  // "443" → port=443, protocol=BOTH
  // "ispmanager" → port=ispmanager, protocol=—
  const m = to.match(/^(\d+(?::\d+)?)\/?(tcp|udp)?$/i);
  if (m) return { port: m[1], protocol: m[2] ? m[2].toUpperCase() : 'BOTH' };
  return { port: to, protocol: '—' };
}

const allRules = computed<DisplayRule[]>(() => {
  const panelRules: DisplayRule[] = rules.value.map(r => ({
    id: r.id,
    action: r.action,
    protocol: r.protocol,
    port: r.port || '*',
    sourceIp: r.sourceIp || 'Any',
    comment: r.comment || '',
    source: 'panel' as const,
  }));

  // Collect panel port keys for dedup
  const panelPorts = new Set(
    rules.value.map(r => `${(r.port || '*').split('/')[0]}:${r.action}`),
  );

  const systemRules: DisplayRule[] = [];
  for (const ufw of ufwParsedRules.value) {
    // Skip IPv6 duplicates
    if (ufw.to.includes('(v6)') || ufw.from.includes('(v6)')) continue;

    const { port, protocol } = parseUfwTo(ufw.to);
    const action = ufw.action.toUpperCase();
    const key = `${port}:${action}`;

    if (panelPorts.has(key)) continue; // already in panel rules

    systemRules.push({
      id: `ufw-${port}-${action}`,
      action,
      protocol,
      port,
      sourceIp: ufw.from === 'Anywhere' ? 'Any' : ufw.from,
      comment: '',
      source: 'system',
    });
  }

  return [...panelRules, ...systemRules];
});

const toast = useMbToast();
function showToast(msg: string, isError = false) {
  if (isError) toast.error(msg);
  else toast.success(msg);
}

async function loadRules() {
  loading.value = true;
  try { rules.value = await api.get<FirewallRule[]>('/firewall'); }
  catch { showToast('Failed to load rules', true); }
  finally { loading.value = false; }
}

function openEditor(rule?: FirewallRule) {
  editingRule.value = rule || null;
  editorForm.action = rule?.action || 'ALLOW';
  editorForm.protocol = rule?.protocol || 'TCP';
  editorForm.port = rule?.port || '';
  editorForm.sourceIp = rule?.sourceIp || '';
  editorForm.comment = rule?.comment || '';
  editorError.value = '';
  showEditor.value = true;
}

async function saveRule() {
  saving.value = true;
  editorError.value = '';
  try {
    const body: Record<string, string> = { action: editorForm.action, protocol: editorForm.protocol };
    if (editorForm.port) body.port = editorForm.port;
    if (editorForm.sourceIp) body.sourceIp = editorForm.sourceIp;
    if (editorForm.comment) body.comment = editorForm.comment;
    if (editingRule.value) {
      await api.put(`/firewall/${editingRule.value.id}`, body);
      showToast('Rule updated');
    } else {
      await api.post('/firewall', body);
      showToast('Rule created');
    }
    showEditor.value = false;
    await loadRules();
  } catch { editorError.value = 'Failed to save rule'; }
  finally { saving.value = false; }
}

// Presets
interface Preset { name: string; label: string; rules: Array<{ action: string; protocol: string; port: string; comment: string }>; }
const presets = ref<Preset[]>([]);
const applyingPreset = ref<string | null>(null);

async function loadPresets() {
  try { presets.value = await api.get<Preset[]>('/firewall/presets'); } catch { /* ignore */ }
}

async function applyPreset(name: string) {
  applyingPreset.value = name;
  try {
    await api.post(`/firewall/presets/${name}/apply`);
    showToast('Preset applied');
    await loadRules();
  } catch { showToast('Failed to apply preset', true); }
  finally { applyingPreset.value = null; }
}

function confirmDelete(rule: FirewallRule) { deleteTarget.value = rule; }

async function doDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.del(`/firewall/${deleteTarget.value.id}`);
    showToast('Rule deleted');
    deleteTarget.value = null;
    await loadRules();
  } catch { showToast('Failed to delete', true); }
  finally { deleting.value = false; }
}

async function loadUfwStatus() {
  try {
    const data = await api.get<{ enabled: boolean; rules: UfwRule[] }>('/firewall/status');
    ufwEnabled.value = data.enabled;
    ufwParsedRules.value = data.rules;
    ufwLoaded.value = true;
  } catch { /* ignore */ }
}

async function syncRules() {
  syncing.value = true;
  try {
    await api.post('/firewall/sync');
    showToast('Rules synced to UFW');
    await loadUfwStatus();
  } catch { showToast('Sync failed', true); }
  finally { syncing.value = false; }
}

onMounted(() => { loadRules(); loadPresets(); loadUfwStatus(); });
</script>

<style scoped>
.firewall__header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 1rem; gap: 1rem; }
.firewall__title { font-size: 1.5rem; font-weight: 700; color: var(--text-heading); margin: 0; }
.firewall__subtitle { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.15rem; }

/* Warning */
.firewall__warning {
  display: flex; align-items: center; gap: 0.65rem; padding: 0.7rem 1rem;
  background: var(--primary-bg); border: 1px solid rgba(245, 158, 11, 0.12);
  border-radius: 12px; margin-bottom: 1.25rem; color: rgba(245, 158, 11, 0.7); font-size: 0.78rem;
}

/* Presets */
.presets-section { margin-bottom: 1.25rem; }
.presets-title { font-size: 0.82rem; font-weight: 600; color: var(--text-tertiary); margin: 0 0 0.6rem; }
.presets-grid { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.preset-btn {
  display: flex; flex-direction: column; gap: 0.15rem; padding: 0.55rem 1rem;
  background: var(--bg-surface); border: 1px solid var(--border-secondary);
  border-radius: 10px; cursor: pointer; transition: all 0.2s; font-family: inherit;
}
.preset-btn:hover:not(:disabled) { border-color: var(--primary-border); background: var(--primary-bg); }
.preset-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.preset-btn__label { font-size: 0.78rem; font-weight: 600; color: var(--text-secondary); }
.preset-btn__count { font-size: 0.65rem; color: var(--text-faint); }

/* Table */
.table-wrap {
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 14px; overflow: hidden;
}

.table { width: 100%; border-collapse: collapse; }

.table th {
  text-align: left; padding: 0.7rem 1rem; font-size: 0.68rem; font-weight: 600;
  color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;
  border-bottom: 1px solid var(--border);
}

.table td { padding: 0.65rem 1rem; font-size: 0.82rem; border-bottom: 1px solid var(--bg-surface); }
.table__row:hover { background: var(--bg-surface-hover); }
.table__actions-col { width: 80px; text-align: right; }

.mono-sm { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; color: var(--text-tertiary); }
.muted { color: var(--text-faint); font-size: 0.78rem; }

.action-badge {
  display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.65rem; font-weight: 700;
  font-family: 'JetBrains Mono', monospace; padding: 0.2rem 0.55rem; border-radius: 6px;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.action-badge--allow { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
.action-badge--deny { background: rgba(239, 68, 68, 0.1); color: #f87171; }

.row-actions { display: flex; gap: 0.3rem; justify-content: flex-end; }
.row-action {
  background: none; border: 1px solid var(--border-secondary); border-radius: 8px;
  padding: 0.35rem; cursor: pointer; display: flex; color: var(--text-faint); transition: all 0.2s;
}
.row-action:hover { color: var(--text-tertiary); border-color: var(--border-strong); }
.row-action--red:hover { color: #f87171; border-color: rgba(239, 68, 68, 0.2); background: rgba(239, 68, 68, 0.05); }

.table-empty {
  display: flex; flex-direction: column; align-items: center; padding: 3rem 1rem;
  gap: 0.5rem; color: var(--text-muted); font-size: 0.85rem;
}

.spinner { width: 24px; height: 24px; border: 2px solid var(--spinner-track); border-top-color: var(--primary); border-radius: 50%; animation: spin 0.8s linear infinite; }

/* Form/Modal */
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }

.radio-group { display: flex; gap: 0.4rem; }
.radio-option {
  flex: 1; display: flex; align-items: center; justify-content: center;
  padding: 0.5rem 0.6rem; border-radius: 8px; border: 1px solid var(--border-secondary);
  background: var(--bg-surface); cursor: pointer; transition: all 0.2s;
}
.radio-option__label { font-size: 0.72rem; font-weight: 600; font-family: 'JetBrains Mono', monospace; color: var(--text-muted); transition: color 0.2s; }
.radio-option:hover { border-color: var(--border-strong); }
.radio-option--active { border-color: var(--primary-border); background: var(--primary-bg); }
.radio-option--active .radio-option__label { color: var(--primary-text); }
.radio-option--allow.radio-option--active { border-color: rgba(34, 197, 94, 0.25); background: rgba(34, 197, 94, 0.05); }
.radio-option--allow.radio-option--active .radio-option__label { color: #4ade80; }
.radio-option--deny.radio-option--active { border-color: rgba(239, 68, 68, 0.25); background: rgba(239, 68, 68, 0.05); }
.radio-option--deny.radio-option--active .radio-option__label { color: #f87171; }

.form-group { display: flex; flex-direction: column; gap: 0.3rem; }
.form-label { font-size: 0.75rem; font-weight: 500; color: var(--text-tertiary); }
.form-input {
  background: var(--bg-input); border: 1px solid var(--border-secondary);
  border-radius: 10px; padding: 0.55rem 0.8rem; font-size: 0.85rem;
  color: var(--text-primary); font-family: inherit; outline: none; transition: all 0.2s;
}
.form-input:focus { border-color: rgba(245, 158, 11, 0.25); box-shadow: var(--focus-ring); }
.form-input.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.82rem; }
.form-hint { font-size: 0.68rem; color: var(--text-faint); }

.btn {
  display: inline-flex; align-items: center; gap: 0.45rem; padding: 0.55rem 1.1rem;
  border-radius: 10px; border: none; font-size: 0.82rem; font-weight: 600;
  font-family: inherit; cursor: pointer; transition: all 0.2s; white-space: nowrap;
}
.btn--primary { background: linear-gradient(135deg, #fbbf24, #d97706); color: var(--primary-text-on); }
.btn--primary:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(245, 158, 11, 0.2); }
.btn--primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--ghost { background: var(--bg-input); border: 1px solid var(--border-strong); color: var(--text-tertiary); }
.btn--ghost:hover { color: var(--text-secondary); border-color: var(--border-strong); }
.btn--danger { background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.2); color: #f87171; }
.btn--danger:not(:disabled):hover { background: rgba(239, 68, 68, 0.18); }
.btn--danger:disabled { opacity: 0.4; cursor: not-allowed; }

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

/* UFW indicator */
.ufw-indicator {
  display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.72rem; font-weight: 600;
  padding: 0.3rem 0.7rem; border-radius: 8px; margin-bottom: 0.75rem;
  font-family: 'JetBrains Mono', monospace; text-transform: uppercase; letter-spacing: 0.04em;
}
.ufw-indicator--on { background: rgba(34, 197, 94, 0.08); color: #4ade80; }
.ufw-indicator--off { background: rgba(239, 68, 68, 0.08); color: #f87171; }
.ufw-indicator__dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

/* System rows */
.table__row--system { opacity: 0.65; }
.source-badge {
  display: inline-flex; align-items: center; font-size: 0.6rem; font-weight: 700;
  padding: 0.15rem 0.45rem; border-radius: 5px; text-transform: uppercase; letter-spacing: 0.05em;
  background: rgba(99, 102, 241, 0.1); color: rgba(129, 140, 248, 0.8);
}

.firewall__actions { display: flex; gap: 0.5rem; align-items: center; }

@keyframes spin { to { transform: rotate(360deg); } }
@keyframes modalIn { from { opacity: 0; transform: scale(0.96) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }

@media (max-width: 768px) {
  .firewall__header { flex-direction: column; align-items: stretch; gap: 0.75rem; }
  .firewall__header .btn { align-self: flex-start; }
  .firewall__title { font-size: 1.25rem; }
  .firewall__warning { font-size: 0.72rem; }
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .table { min-width: 480px; }
}
</style>
