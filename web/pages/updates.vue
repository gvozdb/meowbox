<template>
  <div class="updates-page">
    <div class="updates-page__header">
      <div>
        <h1 class="updates-page__title">System Updates</h1>
        <p class="updates-page__subtitle">Manage packages and view installed software versions</p>
      </div>
      <div class="updates-page__actions">
        <button
          class="updates-page__btn updates-page__btn--check"
          :disabled="checking"
          @click="checkUpdates"
        >
          <svg v-if="!checking" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <polyline points="23,4 23,10 17,10" /><path d="M20.49,15a9,9,0,1,1-2.12-9.36L23,10" />
          </svg>
          <span v-if="checking" class="updates-page__spinner" />
          {{ checking ? 'Checking...' : 'Check for Updates' }}
        </button>
        <button
          v-if="updates.length > 0"
          class="updates-page__btn updates-page__btn--upgrade"
          :disabled="installing"
          @click="upgradeAll"
        >
          <svg v-if="!installing" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7,10 12,15 17,10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <span v-if="installing" class="updates-page__spinner" />
          {{ installing ? 'Upgrading...' : 'Upgrade All' }}
        </button>
      </div>
    </div>

    <!-- Software versions -->
    <div class="versions-section">
      <h2 class="section-title">Installed Software</h2>
      <div v-if="loadingVersions" class="versions-loading">
        <div class="updates-page__spinner" />
        <span>Loading versions...</span>
      </div>
      <div v-else class="versions-grid">
        <div v-for="(ver, name) in versions" :key="name" class="version-card">
          <div class="version-card__icon" :class="`version-card__icon--${getIconClass(name as string)}`">
            {{ getIconLabel(name as string) }}
          </div>
          <div class="version-card__info">
            <span class="version-card__name">{{ formatName(name as string) }}</span>
            <span class="version-card__ver">{{ ver }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Available updates -->
    <div class="updates-section">
      <div class="updates-section__header">
        <h2 class="section-title">
          Available Updates
          <span v-if="updates.length" class="section-badge">{{ updates.length }}</span>
        </h2>
        <span v-if="lastChecked" class="updates-section__time">
          Last checked: {{ formatRelative(lastChecked) }}
        </span>
      </div>

      <div v-if="!lastChecked && !checking" class="updates-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="opacity:0.3">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7,10 12,15 17,10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        <p class="updates-empty__text">Click "Check for Updates" to scan for available packages</p>
      </div>

      <div v-else-if="checking" class="updates-loading">
        <div class="updates-page__spinner updates-page__spinner--lg" />
        <p>Checking for updates...</p>
      </div>

      <div v-else-if="updates.length === 0" class="updates-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="1.5" stroke-linecap="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22,4 12,14.01 9,11.01" />
        </svg>
        <p class="updates-empty__text updates-empty__text--ok">System is up to date</p>
      </div>

      <template v-else>
        <!-- Group by section -->
        <div v-for="(group, section) in groupedUpdates" :key="section" class="update-group">
          <h3 class="update-group__title">{{ sectionLabels[section] || section }}</h3>
          <div class="update-group__list">
            <div v-for="pkg in group" :key="pkg.name" class="update-item">
              <div class="update-item__info">
                <span class="update-item__name">{{ pkg.name }}</span>
                <span class="update-item__versions">
                  <span class="update-item__old">{{ pkg.currentVersion }}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9,18 15,12 9,6" /></svg>
                  <span class="update-item__new">{{ pkg.newVersion }}</span>
                </span>
              </div>
              <button
                class="update-item__btn"
                :disabled="installing"
                @click="installPackage(pkg.name)"
              >
                Update
              </button>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- Meowbox Self-Update -->
    <div class="selfupdate-section">
      <div class="selfupdate-card">
        <div class="selfupdate-card__info">
          <h2 class="section-title">Meowbox Panel</h2>
          <p class="selfupdate-card__desc">Pull latest changes, rebuild all packages, and restart services.</p>
        </div>
        <button
          class="updates-page__btn updates-page__btn--selfupdate"
          :disabled="selfUpdating"
          @click="selfUpdate"
        >
          <span v-if="selfUpdating" class="updates-page__spinner" />
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <polyline points="16,16 12,12 8,16" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
          </svg>
          {{ selfUpdating ? 'Updating...' : 'Self-Update' }}
        </button>
      </div>
    </div>

    <!-- Install output -->
    <div v-if="installOutput" class="output-section">
      <div class="output-section__header">
        <h2 class="section-title">Output</h2>
        <button class="output-section__clear" @click="installOutput = ''">Clear</button>
      </div>
      <pre class="output-section__pre"><code>{{ installOutput }}</code></pre>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface UpdatablePackage {
  name: string;
  currentVersion: string;
  newVersion: string;
  section: string;
}

const api = useApi();

const checking = ref(false);
const installing = ref(false);
const selfUpdating = ref(false);
const loadingVersions = ref(true);
const updates = ref<UpdatablePackage[]>([]);
const versions = ref<Record<string, string>>({});
const lastChecked = ref('');
const installOutput = ref('');

const sectionLabels: Record<string, string> = {
  nginx: 'Nginx',
  php: 'PHP',
  mariadb: 'MariaDB / MySQL',
  postgresql: 'PostgreSQL',
  certbot: 'Certbot / SSL',
  system: 'System Packages',
};

const groupedUpdates = computed(() => {
  const groups: Record<string, UpdatablePackage[]> = {};
  for (const pkg of updates.value) {
    if (!groups[pkg.section]) groups[pkg.section] = [];
    groups[pkg.section].push(pkg);
  }
  return groups;
});

function formatName(key: string): string {
  if (key.startsWith('php')) return `PHP ${key.replace('php', '')}`;
  const labels: Record<string, string> = {
    nodejs: 'Node.js',
    nginx: 'Nginx',
    mariadb: 'MariaDB',
    postgresql: 'PostgreSQL',
    pm2: 'PM2',
  };
  return labels[key] || key;
}

function getIconLabel(key: string): string {
  if (key.startsWith('php')) return 'P';
  const icons: Record<string, string> = {
    nodejs: 'N',
    nginx: 'Nx',
    mariadb: 'M',
    postgresql: 'Pg',
    pm2: '2',
  };
  return icons[key] || key.charAt(0).toUpperCase();
}

function getIconClass(key: string): string {
  if (key.startsWith('php')) return 'php';
  return key;
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function checkUpdates() {
  checking.value = true;
  try {
    const data = await api.get<{ available: UpdatablePackage[]; lastChecked: string }>('/system/updates/check');
    updates.value = data.available || [];
    lastChecked.value = data.lastChecked || new Date().toISOString();
  } catch {
    updates.value = [];
  } finally {
    checking.value = false;
  }
}

async function installPackage(name: string) {
  if (installing.value) return;
  installing.value = true;
  try {
    const data = await api.post<{ upgraded: string[]; failed: string[]; output: string }>('/system/updates/install', {
      packages: [name],
    });
    installOutput.value = data.output || '';
    // Re-check after install
    await checkUpdates();
    await loadVersions();
  } catch {
    // Install failed
  } finally {
    installing.value = false;
  }
}

async function upgradeAll() {
  if (installing.value) return;
  installing.value = true;
  try {
    const data = await api.post<{ upgraded: string[]; failed: string[]; output: string }>('/system/updates/upgrade-all');
    installOutput.value = data.output || '';
    // Re-check after upgrade
    await checkUpdates();
    await loadVersions();
  } catch {
    // Upgrade failed
  } finally {
    installing.value = false;
  }
}

async function selfUpdate() {
  if (selfUpdating.value) return;
  selfUpdating.value = true;
  try {
    const data = await api.post<{ output: string }>('/system/self-update');
    installOutput.value = data.output || 'Self-update completed';
  } catch {
    installOutput.value = 'Self-update failed';
  } finally {
    selfUpdating.value = false;
    await loadVersions();
  }
}

async function loadVersions() {
  loadingVersions.value = true;
  try {
    const data = await api.get<Record<string, string>>('/system/versions');
    versions.value = data || {};
  } catch {
    versions.value = {};
  } finally {
    loadingVersions.value = false;
  }
}

onMounted(() => {
  loadVersions();
});
</script>

<style scoped>
.updates-page__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 2rem;
}

.updates-page__title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0;
}

.updates-page__subtitle {
  font-size: 0.82rem;
  color: var(--text-muted);
  margin: 0.25rem 0 0;
}

.updates-page__actions {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
}

.updates-page__btn {
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

.updates-page__btn--check {
  background: var(--bg-surface);
  border-color: var(--border-secondary);
  color: var(--text-secondary);
}

.updates-page__btn--check:hover:not(:disabled) {
  background: var(--bg-elevated);
  border-color: var(--border);
}

.updates-page__btn--upgrade {
  background: rgba(34, 197, 94, 0.06);
  border-color: rgba(34, 197, 94, 0.2);
  color: #4ade80;
}

.updates-page__btn--upgrade:hover:not(:disabled) {
  background: rgba(34, 197, 94, 0.12);
  border-color: rgba(34, 197, 94, 0.3);
}

.updates-page__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.updates-page__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--spinner-track);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

.updates-page__spinner--lg {
  width: 22px;
  height: 22px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Versions section */
.section-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 0 0 0.85rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.section-badge {
  font-size: 0.65rem;
  font-weight: 700;
  padding: 0.1rem 0.4rem;
  border-radius: 6px;
  background: var(--primary-bg);
  color: var(--primary-text);
}

.versions-section {
  margin-bottom: 2rem;
}

.versions-loading {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  color: var(--text-muted);
  font-size: 0.82rem;
  padding: 1.5rem;
}

.versions-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 0.65rem;
}

.version-card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 12px;
  transition: border-color 0.15s;
}

.version-card:hover {
  border-color: var(--border);
}

.version-card__icon {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.72rem;
  font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
  flex-shrink: 0;
}

.version-card__icon--nodejs {
  background: rgba(34, 197, 94, 0.08);
  color: #4ade80;
}

.version-card__icon--nginx {
  background: rgba(34, 197, 94, 0.08);
  color: #4ade80;
}

.version-card__icon--php {
  background: rgba(139, 92, 246, 0.08);
  color: #a78bfa;
}

.version-card__icon--mariadb {
  background: rgba(59, 130, 246, 0.08);
  color: #60a5fa;
}

.version-card__icon--postgresql {
  background: rgba(59, 130, 246, 0.08);
  color: #60a5fa;
}

.version-card__icon--redis {
  background: rgba(239, 68, 68, 0.08);
  color: #f87171;
}

.version-card__icon--pm2 {
  background: rgba(245, 158, 11, 0.08);
  color: var(--primary-text);
}

.version-card__info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.version-card__name {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-secondary);
}

.version-card__ver {
  font-size: 0.72rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-muted);
  margin-top: 0.1rem;
}

/* Updates section */
.updates-section {
  margin-bottom: 2rem;
}

.updates-section__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.85rem;
}

.updates-section__header .section-title {
  margin: 0;
}

.updates-section__time {
  font-size: 0.72rem;
  color: var(--text-faint);
}

.updates-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 3rem;
  gap: 0.75rem;
}

.updates-empty__text {
  font-size: 0.82rem;
  color: var(--text-muted);
  margin: 0;
}

.updates-empty__text--ok {
  color: #4ade80;
}

.updates-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 3rem;
  gap: 0.75rem;
  color: var(--text-muted);
  font-size: 0.82rem;
}

/* Update groups */
.update-group {
  margin-bottom: 1.25rem;
}

.update-group__title {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 0 0 0.5rem;
}

.update-group__list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 12px;
  overflow: hidden;
}

.update-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.65rem 0.85rem;
  background: var(--bg-surface);
}

.update-item + .update-item {
  border-top: 1px solid var(--border);
}

.update-item__info {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}

.update-item__name {
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--text-secondary);
  font-family: 'JetBrains Mono', monospace;
}

.update-item__versions {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
}

.update-item__old {
  color: var(--text-faint);
}

.update-item__new {
  color: #4ade80;
}

.update-item__versions svg {
  color: var(--text-faint);
}

.update-item__btn {
  padding: 0.3rem 0.7rem;
  border-radius: 7px;
  border: 1px solid rgba(139, 92, 246, 0.2);
  background: rgba(139, 92, 246, 0.06);
  color: #a78bfa;
  font-size: 0.72rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}

.update-item__btn:hover:not(:disabled) {
  background: rgba(139, 92, 246, 0.12);
  border-color: rgba(139, 92, 246, 0.3);
}

.update-item__btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* Self-update section */
.selfupdate-section {
  margin-bottom: 2rem;
}

.selfupdate-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 1.15rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
}

.selfupdate-card__desc {
  font-size: 0.78rem;
  color: var(--text-muted);
  margin: 0.25rem 0 0;
}

.updates-page__btn--selfupdate {
  background: rgba(139, 92, 246, 0.06);
  border-color: rgba(139, 92, 246, 0.2);
  color: #a78bfa;
  flex-shrink: 0;
}

.updates-page__btn--selfupdate:hover:not(:disabled) {
  background: rgba(139, 92, 246, 0.12);
  border-color: rgba(139, 92, 246, 0.3);
}

/* Output section */
.output-section {
  margin-bottom: 2rem;
}

.output-section__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.output-section__header .section-title {
  margin: 0;
}

.output-section__clear {
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

.output-section__clear:hover {
  background: var(--border);
  color: var(--text-secondary);
}

.output-section__pre {
  padding: 1rem;
  margin: 0;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 12px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  line-height: 1.6;
  color: var(--text-tertiary);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 400px;
  overflow-y: auto;
}

@media (max-width: 768px) {
  .updates-page__header {
    flex-direction: column;
    gap: 0.75rem;
  }

  .updates-page__actions {
    width: 100%;
  }

  .updates-page__btn {
    flex: 1;
    justify-content: center;
    padding: 0.55rem 0.75rem;
    font-size: 0.78rem;
  }

  .versions-grid {
    grid-template-columns: 1fr 1fr;
  }

  .updates-page__title {
    font-size: 1.2rem;
  }
}
</style>
