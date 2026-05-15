<template>
  <div class="ssl-tab">
    <!-- Per-domain subtab bar -->
    <div v-if="domains.length" class="subtab-bar">
      <button
        v-for="d in domains"
        :key="d.id"
        class="subtab"
        :class="{ 'subtab--active': activeDomainId === d.id }"
        @click="selectDomain(d.id)"
      >
        <svg v-if="d.isPrimary" class="subtab__crown" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M2 7l5 5 5-8 5 8 5-5v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" /></svg>
        <span>{{ d.domain }}</span>
        <span
          v-if="sslStatusFor(d) !== 'NONE'"
          class="subtab__dot"
          :class="`subtab__dot--${sslDotClass(d)}`"
        />
      </button>
    </div>

    <div v-if="!activeDomain" class="ssl-tab__empty">У сайта нет основных доменов.</div>

    <div v-else class="ssl-section">
      <!-- Current SSL status -->
      <div v-if="cert" class="info-card">
        <h3 class="info-card__title">Текущий сертификат — {{ activeDomain.domain }}</h3>
        <div class="info-card__rows">
          <div class="info-row">
            <span class="info-row__label">Статус</span>
            <span class="info-row__value" :class="sslClass">{{ sslLabel }}</span>
          </div>
          <div v-if="cert.expiresAt" class="info-row">
            <span class="info-row__label">Истекает</span>
            <span class="info-row__value">{{ formatDate(cert.expiresAt) }}</span>
          </div>
          <div v-if="cert.domains?.length" class="info-row">
            <span class="info-row__label">Покрывает (SAN)</span>
            <span class="info-row__value info-row__value--mono">{{ cert.domains.join(', ') }}</span>
          </div>
        </div>
        <div v-if="canRevoke" class="ssl-actions">
          <button class="btn btn--danger btn--sm" :disabled="revoking" @click="revoke">
            {{ revoking ? 'Отзыв…' : 'Отозвать сертификат' }}
          </button>
        </div>
      </div>

      <!-- Import existing cert -->
      <div v-if="!canRevoke" class="info-card">
        <h3 class="info-card__title">Подхватить уже выпущенный</h3>
        <p class="ssl-le__desc">
          Если сертификат для <strong>{{ activeDomain.domain }}</strong> уже лежит в
          <code>/etc/letsencrypt/live/</code> (выпущен вручную или остался с прошлой установки) —
          можно импортировать его в панель без нового запроса к Let's Encrypt.
        </p>
        <div class="ssl-le__actions">
          <button class="btn btn--secondary" :disabled="importing" @click="doImport">
            {{ importing ? 'Проверка…' : 'Импортировать с диска' }}
          </button>
        </div>
      </div>

      <!-- Let's Encrypt -->
      <div class="info-card">
        <h3 class="info-card__title">
          <template v-if="canRevoke">Перевыпуск сертификата</template>
          <template v-else>Let's Encrypt</template>
        </h3>

        <div v-if="canRevoke && missingInCert.length" class="domains-cert-alert ssl-le__mismatch">
          <div class="domains-cert-alert__icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div class="domains-cert-alert__body">
            <strong>SAN не совпадает с текущим списком доменов</strong>
            <span>
              Не покрыт{{ missingInCert.length > 1 ? 'ы' : '' }}:
              <template v-for="(d, i) in missingInCert" :key="d"><code>{{ d }}</code><span v-if="i < missingInCert.length - 1">, </span></template>
            </span>
            <span>Нажми «Перевыпустить» — новый серт будет выпущен с актуальным SAN.</span>
          </div>
        </div>

        <p v-if="canRevoke" class="ssl-le__desc">
          Текущий сертификат будет заменён: certbot переиздаст его с актуальным списком доменов
          (<strong>{{ activeDomain.domain }}</strong><template v-if="aliasesCount"> + {{ aliasesCount }} алиас{{ pluralAlias(aliasesCount) }}</template>).
          Используется <code>--expand</code>, revoke старой версии не нужен.
        </p>
        <p v-else class="ssl-le__desc">
          Выпустить бесплатный SSL-сертификат для <strong>{{ activeDomain.domain }}</strong><template v-if="aliasesCount"> и {{ aliasesCount }} алиас{{ pluralAlias(aliasesCount) }}</template>.
          В SAN включаются все алиасы (в т. ч. redirect — иначе TLS-handshake падает на cert-mismatch до 301).
        </p>

        <div class="ssl-le__actions">
          <button class="btn btn--primary" :disabled="issuing" @click="issue">
            <svg v-if="!issuing && !canRevoke" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
            <svg v-else-if="!issuing && canRevoke" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
            {{ issuing ? (canRevoke ? 'Перевыпуск...' : 'Выпуск...') : (canRevoke ? 'Перевыпустить сертификат' : 'Выпустить сертификат') }}
          </button>
          <span v-if="progress" class="ssl-le__progress">
            {{ progress }}
            <span v-if="issuing" class="ssl-le__elapsed">({{ elapsed }}с)</span>
          </span>
          <span v-if="issueError" class="ssl-le__error">{{ issueError }}</span>
        </div>
      </div>

      <!-- Upload custom certificate -->
      <div class="ssl-upload">
        <h3 class="ssl-upload__title">Загрузка сертификата</h3>
        <p class="ssl-upload__desc">Вставьте PEM-кодированный сертификат, приватный ключ и цепочку (опционально).</p>
        <div class="ssl-upload__fields">
          <div class="form-group">
            <label class="form-label">Сертификат (PEM)</label>
            <textarea v-model="certPem" class="ssl-textarea" placeholder="-----BEGIN CERTIFICATE-----" spellcheck="false" />
          </div>
          <div class="form-group">
            <label class="form-label">Приватный ключ (PEM)</label>
            <textarea v-model="keyPem" class="ssl-textarea" placeholder="-----BEGIN PRIVATE KEY-----" spellcheck="false" />
          </div>
          <div class="form-group">
            <label class="form-label">Цепочка (PEM, опционально)</label>
            <textarea v-model="chainPem" class="ssl-textarea ssl-textarea--sm" placeholder="-----BEGIN CERTIFICATE-----" spellcheck="false" />
          </div>
        </div>
        <div class="ssl-upload__actions">
          <button
            class="btn btn--primary"
            :disabled="!certPem.trim() || !keyPem.trim() || uploading"
            @click="upload"
          >
            {{ uploading ? 'Загрузка...' : 'Загрузить сертификат' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

interface SiteAlias {
  domain: string;
  redirect: boolean;
}
interface SslCert {
  status: string;
  domains?: string[];
  expiresAt?: string | null;
}
interface SiteDomain {
  id: string;
  domain: string;
  isPrimary: boolean;
  position: number;
  aliases: SiteAlias[];
  sslCertificate: SslCert | null;
}

const props = defineProps<{
  siteId: string;
  domains: SiteDomain[];
  /** id домена, чью SSL-вкладку открыть (навигация из «Домены»). */
  initialDomainId?: string | null;
}>();

const emit = defineEmits<{ (e: 'changed'): void }>();

const api = useApi();
const toast = useMbToast();
const confirm = useMbConfirm();

const activeDomainId = ref<string | null>(null);

function pickInitial() {
  const first = props.domains[0];
  if (!first) {
    activeDomainId.value = null;
    return;
  }
  const valid = props.domains.some((d) => d.id === activeDomainId.value);
  if (valid) return;
  if (props.initialDomainId && props.domains.some((d) => d.id === props.initialDomainId)) {
    activeDomainId.value = props.initialDomainId;
  } else {
    activeDomainId.value = first.id;
  }
}
pickInitial();

const activeDomain = computed(() => props.domains.find((d) => d.id === activeDomainId.value) || null);
const cert = computed<SslCert | null>(() => activeDomain.value?.sslCertificate || null);

watch(() => props.initialDomainId, (id) => {
  if (id && props.domains.some((d) => d.id === id)) activeDomainId.value = id;
});
watch(() => props.domains, () => pickInitial(), { deep: true });

function selectDomain(id: string) {
  if (activeDomainId.value === id) return;
  activeDomainId.value = id;
  resetForms();
}
function resetForms() {
  certPem.value = '';
  keyPem.value = '';
  chainPem.value = '';
  issueError.value = '';
  progress.value = '';
}

// --- status helpers ---
function sslStatusFor(d: SiteDomain): string {
  return d.sslCertificate?.status || 'NONE';
}
function sslDotClass(d: SiteDomain): string {
  const s = sslStatusFor(d);
  if (s === 'ACTIVE') return 'ok';
  if (s === 'EXPIRING_SOON') return 'warn';
  if (s === 'EXPIRED') return 'err';
  return 'idle';
}

const sslLabel = computed(() => {
  const labels: Record<string, string> = {
    ACTIVE: 'Активен',
    EXPIRING_SOON: 'Скоро истекает',
    EXPIRED: 'Истёк',
    PENDING: 'Ожидание',
    NONE: 'Не настроен',
  };
  const s = cert.value?.status;
  return labels[s || ''] || s || 'Неизвестно';
});
const sslClass = computed(() => {
  const s = cert.value?.status;
  if (s === 'ACTIVE') return 'ssl-active';
  if (s === 'EXPIRING_SOON') return 'ssl-warning';
  if (s === 'EXPIRED') return 'ssl-error';
  return '';
});
const canRevoke = computed(() => {
  const s = cert.value?.status;
  return s === 'ACTIVE' || s === 'EXPIRING_SOON' || s === 'EXPIRED';
});

const aliasesCount = computed(() => activeDomain.value?.aliases.length || 0);
function pluralAlias(n: number): string {
  return n === 1 ? '' : (n >= 2 && n <= 4 ? 'а' : 'ов');
}

/** Домены/алиасы, не попавшие в SAN текущего серта. */
const missingInCert = computed(() => {
  const d = activeDomain.value;
  if (!d || !canRevoke.value) return [] as string[];
  const set = new Set((cert.value?.domains || []).map((x) => x.toLowerCase()));
  const all = [d.domain, ...d.aliases.map((a) => a.domain)];
  return all.filter((x) => !set.has(x.toLowerCase()));
});

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
  } catch {
    return iso;
  }
}

// --- actions ---
const revoking = ref(false);
const importing = ref(false);
const issuing = ref(false);
const uploading = ref(false);
const issueError = ref('');
const progress = ref('');
const elapsed = ref(0);
let elapsedTimer: ReturnType<typeof setInterval> | undefined;

const certPem = ref('');
const keyPem = ref('');
const chainPem = ref('');

function basePath(): string {
  return `/sites/${props.siteId}/domains/${activeDomainId.value}/ssl`;
}

async function revoke() {
  if (!activeDomain.value || revoking.value) return;
  const ok = await confirm.ask({
    title: 'Отзыв SSL-сертификата',
    message: `Отозвать сертификат для ${activeDomain.value.domain}? Он будет revoke'нут в Let's Encrypt и удалён с диска.`,
    confirmText: 'Отозвать',
    danger: true,
  });
  if (!ok) return;
  revoking.value = true;
  try {
    await api.post(`${basePath()}/revoke`, {});
    toast.success('Сертификат отозван, домен переключён на HTTP');
    emit('changed');
  } catch (e) {
    toast.error((e as Error).message || 'Ошибка отзыва сертификата');
  } finally {
    revoking.value = false;
  }
}

async function doImport() {
  if (!activeDomain.value || importing.value) return;
  importing.value = true;
  try {
    await api.post(`${basePath()}/import`, {});
    toast.success('Сертификат импортирован с диска');
    emit('changed');
  } catch (e) {
    toast.error((e as Error).message || 'Не удалось импортировать сертификат');
  } finally {
    importing.value = false;
  }
}

async function issue() {
  if (!activeDomain.value || issuing.value) return;
  issuing.value = true;
  issueError.value = '';
  progress.value = 'Отправка запроса агенту...';
  elapsed.value = 0;
  elapsedTimer = setInterval(() => {
    elapsed.value++;
    if (elapsed.value === 3) progress.value = 'Ожидание certbot (может занять до 2 минут)...';
  }, 1000);
  try {
    await api.post(`${basePath()}/issue`, {});
    progress.value = 'Сертификат успешно выпущен';
    toast.success(`SSL-сертификат для ${activeDomain.value.domain} выпущен`);
    emit('changed');
    setTimeout(() => { progress.value = ''; }, 3000);
  } catch (e) {
    issueError.value = (e as Error).message || 'Ошибка выпуска сертификата';
    progress.value = '';
    toast.error(issueError.value);
  } finally {
    issuing.value = false;
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = undefined; }
  }
}

async function upload() {
  if (!activeDomain.value || !certPem.value.trim() || !keyPem.value.trim() || uploading.value) return;
  uploading.value = true;
  try {
    const body: Record<string, string> = { certPem: certPem.value, keyPem: keyPem.value };
    if (chainPem.value.trim()) body.chainPem = chainPem.value;
    await api.post(`${basePath()}/custom`, body);
    certPem.value = '';
    keyPem.value = '';
    chainPem.value = '';
    toast.success('Сертификат загружен');
    emit('changed');
  } catch (e) {
    toast.error((e as Error).message || 'Не удалось загрузить сертификат');
  } finally {
    uploading.value = false;
  }
}

onBeforeUnmount(() => {
  if (elapsedTimer) clearInterval(elapsedTimer);
});
</script>

<style scoped>
.ssl-tab { display: flex; flex-direction: column; gap: 1.25rem; }

/* Subtab bar */
.subtab-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  padding-bottom: 0.85rem;
  border-bottom: 1px solid var(--border-secondary);
}
.subtab {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.8rem;
  border-radius: 8px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-elevated);
  color: var(--text-muted);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  cursor: pointer;
  transition: all 0.15s;
}
.subtab:hover { color: var(--text-secondary); border-color: var(--border); }
.subtab--active {
  color: var(--primary-text);
  border-color: var(--primary-text);
  background: var(--primary-bg, rgba(99, 102, 241, 0.1));
}
.subtab__crown { color: #fbbf24; flex-shrink: 0; }
.subtab__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.subtab__dot--ok { background: #4ade80; }
.subtab__dot--warn { background: #fbbf24; }
.subtab__dot--err { background: #f87171; }
.subtab__dot--idle { background: var(--text-faint); }

.ssl-tab__empty {
  font-size: 0.85rem;
  color: var(--text-muted);
  padding: 1.5rem 0;
}

.ssl-section { display: flex; flex-direction: column; gap: 1.25rem; }

.info-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  padding: 1.15rem;
}
.info-card__title {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-tertiary);
  margin: 0 0 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.info-card__rows { display: flex; flex-direction: column; gap: 0.6rem; }
.info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.info-row__label { font-size: 0.78rem; color: var(--text-muted); flex-shrink: 0; }
.info-row__value {
  font-size: 0.82rem;
  color: var(--text-secondary);
  text-align: right;
  word-break: break-all;
}
.info-row__value--mono { font-family: 'JetBrains Mono', monospace; font-size: 0.74rem; }

.ssl-active { color: #4ade80; }
.ssl-warning { color: var(--primary-text); }
.ssl-error { color: #f87171; }

.ssl-le__desc {
  font-size: 0.82rem;
  color: var(--text-muted);
  margin: 0.5rem 0 0.75rem;
  line-height: 1.4;
}
.ssl-le__actions { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.ssl-le__actions .btn { display: inline-flex; align-items: center; gap: 0.35rem; }
.ssl-le__progress { font-size: 0.78rem; color: var(--text-muted); }
.ssl-le__elapsed { font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; color: var(--text-faint); }
.ssl-le__error { font-size: 0.78rem; color: #f87171; white-space: pre-wrap; }

.ssl-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border-secondary);
  flex-wrap: wrap;
}

.domains-cert-alert {
  display: flex;
  gap: 0.75rem;
  padding: 0.8rem 1rem;
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.08), rgba(251, 146, 60, 0.08));
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: 12px;
  align-items: flex-start;
}
.domains-cert-alert__icon {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: rgba(239, 68, 68, 0.15);
  color: #f87171;
  display: flex;
  align-items: center;
  justify-content: center;
}
.domains-cert-alert__body {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.78rem;
  color: var(--text-secondary);
  line-height: 1.5;
}
.domains-cert-alert__body strong { color: #fca5a5; font-size: 0.82rem; font-weight: 600; }
.domains-cert-alert__body code {
  background: rgba(239, 68, 68, 0.12);
  color: #fca5a5;
  padding: 0.05em 0.35em;
  border-radius: 4px;
  font-size: 0.9em;
}
html.theme-light .domains-cert-alert {
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.07), rgba(251, 146, 60, 0.07));
  border-color: rgba(239, 68, 68, 0.25);
}
html.theme-light .domains-cert-alert__icon { background: rgba(239, 68, 68, 0.12); color: #dc2626; }
html.theme-light .domains-cert-alert__body strong { color: #b91c1c; }
html.theme-light .domains-cert-alert__body code { background: rgba(239, 68, 68, 0.1); color: #b91c1c; }
.ssl-le__mismatch {
  margin: 0.4rem 0 0.9rem;
  padding: 0.7rem 0.85rem;
  gap: 0.6rem;
  font-size: 0.77rem;
}
.ssl-le__mismatch .domains-cert-alert__body { gap: 0.3rem; }

.ssl-upload {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  padding: 1.25rem;
}
.ssl-upload__title { font-size: 0.9rem; font-weight: 600; color: var(--text-secondary); margin: 0; }
.ssl-upload__desc { font-size: 0.78rem; color: var(--text-muted); margin: 0.25rem 0 1rem; }
.ssl-upload__fields { display: flex; flex-direction: column; gap: 0.85rem; }
.ssl-textarea {
  width: 100%;
  min-height: 120px;
  padding: 0.65rem 0.85rem;
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.75rem;
  line-height: 1.5;
  resize: vertical;
  outline: none;
  transition: border-color 0.2s;
  box-sizing: border-box;
}
.ssl-textarea:focus { border-color: var(--primary-border); }
.ssl-textarea--sm { min-height: 80px; }
.ssl-upload__actions { display: flex; justify-content: flex-end; margin-top: 1rem; }

.form-group { display: flex; flex-direction: column; gap: 0.3rem; }
.form-label { font-size: 0.75rem; font-weight: 500; color: var(--text-tertiary); }

.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.55rem 1.1rem;
  border-radius: 10px;
  border: none;
  font-size: 0.82rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}
.btn--sm { padding: 0.4rem 0.8rem; font-size: 0.75rem; border-radius: 8px; }
.btn--primary {
  background: linear-gradient(135deg, var(--primary-light), var(--primary-dark));
  color: var(--primary-text-on);
}
.btn--primary:not(:disabled):hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(var(--primary-rgb), 0.2);
}
.btn--primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--secondary {
  background: var(--bg-surface-hover);
  color: var(--text-body);
  border: 1px solid var(--border-subtle);
}
.btn--secondary:not(:disabled):hover { border-color: var(--primary-border); color: var(--text-primary); }
.btn--danger { background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.2); color: #f87171; }
.btn--danger:not(:disabled):hover { background: rgba(239, 68, 68, 0.18); }
.btn--danger:disabled { opacity: 0.4; cursor: not-allowed; }

code {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.85em;
  background: var(--bg-elevated);
  border-radius: 4px;
  padding: 0.05em 0.3em;
  color: var(--text-secondary);
}
</style>
