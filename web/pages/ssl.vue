<template>
  <div class="ssl">
    <div class="ssl__header">
      <div>
        <h1 class="ssl__title">SSL-сертификаты</h1>
        <p class="ssl__subtitle">Обзор всех сертификатов</p>
      </div>
      <button class="ssl__refresh" :disabled="loading" @click="fetchData">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" :class="{ spinning: loading }">
          <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
        </svg>
        Обновить
      </button>
    </div>

    <!-- Summary cards -->
    <div class="ssl__summary">
      <div class="summary-card">
        <div class="summary-card__icon summary-card__icon--ok">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
          </svg>
        </div>
        <span class="summary-card__value">{{ counts.active }}</span>
        <span class="summary-card__label">Активных</span>
      </div>
      <div class="summary-card">
        <div class="summary-card__icon summary-card__icon--warn">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
          </svg>
        </div>
        <span class="summary-card__value">{{ counts.expiring }}</span>
        <span class="summary-card__label">Истекают</span>
      </div>
      <div class="summary-card">
        <div class="summary-card__icon summary-card__icon--crit">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <span class="summary-card__value">{{ counts.expired }}</span>
        <span class="summary-card__label">Просрочены</span>
      </div>
      <div class="summary-card">
        <div class="summary-card__icon summary-card__icon--pending">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
          </svg>
        </div>
        <span class="summary-card__value">{{ counts.pending }}</span>
        <span class="summary-card__label">Ожидают</span>
      </div>
    </div>

    <!-- Warning: сайты, у которых есть алиасы, но они НЕ в сертификате -->
    <div v-if="certsWithMissing.length" class="ssl-missing">
      <div class="ssl-missing__head">
        <div class="ssl-missing__icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <div>
          <div class="ssl-missing__title">Домены вне сертификата</div>
          <div class="ssl-missing__subtitle">У этих сайтов SSL выпущен, но часть доменов не в SAN — HTTPS по ним не работает, нужно перевыпустить серт.</div>
        </div>
      </div>
      <div class="ssl-missing__list">
        <NuxtLink
          v-for="c in certsWithMissing"
          :key="c.siteId"
          :to="`/sites/${c.siteId}`"
          class="ssl-missing__item"
        >
          <span class="ssl-missing__site">{{ c.siteName }}</span>
          <span class="ssl-missing__domains">
            <code v-if="c.missingMainDomain" class="ssl-missing__domain ssl-missing__domain--main" :title="'Основной домен вне SAN'">{{ c.domain }}</code>
            <code v-for="d in c.missingAliases" :key="d" class="ssl-missing__domain">{{ d }}</code>
          </span>
          <svg class="ssl-missing__arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
        </NuxtLink>
      </div>
    </div>

    <!-- Certificates table -->
    <div class="ssl-table">
      <div class="ssl-table__head">
        <button v-for="col in columns" :key="col.key" class="ssl-table__th" :class="{ 'ssl-table__th--active': sortKey === col.key, 'ssl-table__th--right': col.align === 'right' }" @click="toggleSort(col.key)">
          {{ col.label }}
          <svg v-if="sortKey === col.key" width="10" height="10" viewBox="0 0 10 10" fill="currentColor" class="ssl-table__sort-icon" :class="{ 'ssl-table__sort-icon--asc': sortDir === 'asc' }">
            <path d="M5 7L1 3h8z" />
          </svg>
        </button>
      </div>

      <div v-if="!certs.length && !loading" class="ssl-table__empty">
        Нет сертификатов
      </div>

      <div v-for="cert in sortedCerts" :key="cert.siteId" class="ssl-row">
        <span class="ssl-row__cell ssl-row__site">{{ cert.siteName }}</span>
        <span class="ssl-row__cell ssl-row__domain">{{ cert.domain }}</span>
        <span class="ssl-row__cell ssl-row__issuer">{{ cert.issuer || '—' }}</span>
        <span class="ssl-row__cell ssl-row__status">
          <span class="status-badge" :class="`status-badge--${cert.status.toLowerCase()}`">
            {{ statusLabel(cert.status) }}
          </span>
        </span>
        <span class="ssl-row__cell ssl-row__days" :class="daysClass(cert.daysRemaining)">
          {{ cert.daysRemaining !== null ? `${cert.daysRemaining}д` : '—' }}
        </span>
        <span class="ssl-row__cell ssl-row__date">{{ cert.expiresAt ? formatDate(cert.expiresAt) : '—' }}</span>
        <span class="ssl-row__cell ssl-row__wildcard">
          <svg v-if="cert.isWildcard" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12" /></svg>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface SslCert {
  siteId: string;
  siteName: string;
  domain: string;
  domains: string[];
  /** Non-redirect алиасы сайта, отсутствующие в SAN сертификата. */
  missingAliases: string[];
  /** Основной домен не входит в SAN (возможно после смены главного домена). */
  missingMainDomain: boolean;
  status: string;
  issuer: string | null;
  isWildcard: boolean;
  issuedAt: string | null;
  expiresAt: string | null;
  daysRemaining: number | null;
}

const api = useApi();
const certs = ref<SslCert[]>([]);
const loading = ref(false);
const sortKey = ref<string>('daysRemaining');
const sortDir = ref<'asc' | 'desc'>('asc');

const columns = [
  { key: 'siteName', label: 'Сайт', align: 'left' },
  { key: 'domain', label: 'Домен', align: 'left' },
  { key: 'issuer', label: 'Издатель', align: 'left' },
  { key: 'status', label: 'Статус', align: 'left' },
  { key: 'daysRemaining', label: 'Осталось', align: 'right' },
  { key: 'expiresAt', label: 'Истекает', align: 'right' },
  { key: '_wildcard', label: '*', align: 'right' },
];

const certsWithMissing = computed(() =>
  certs.value.filter((c) => c.missingAliases?.length || c.missingMainDomain),
);

const counts = computed(() => {
  let active = 0, expiring = 0, expired = 0, pending = 0;
  for (const c of certs.value) {
    if (c.status === 'ACTIVE') active++;
    else if (c.status === 'EXPIRING_SOON') expiring++;
    else if (c.status === 'EXPIRED') expired++;
    else if (c.status === 'PENDING') pending++;
  }
  return { active, expiring, expired, pending };
});

const sortedCerts = computed(() => {
  const key = sortKey.value as keyof SslCert;
  const dir = sortDir.value === 'asc' ? 1 : -1;
  return [...certs.value].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return 0;
  });
});

function toggleSort(key: string) {
  if (key === '_wildcard') return;
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    sortDir.value = key === 'daysRemaining' ? 'asc' : 'desc';
  }
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    ACTIVE: 'Активен',
    EXPIRING_SOON: 'Истекает',
    EXPIRED: 'Просрочен',
    PENDING: 'Ожидание',
    NONE: 'Нет',
  };
  return map[status] || status;
}

function daysClass(days: number | null): string {
  if (days === null) return '';
  if (days <= 0) return 'ssl-row__days--crit';
  if (days <= 14) return 'ssl-row__days--warn';
  return 'ssl-row__days--ok';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function fetchData() {
  loading.value = true;
  try {
    certs.value = await api.get<SslCert[]>('/ssl');
  } catch { /* ignore */ }
  loading.value = false;
}

onMounted(() => {
  fetchData();
});
</script>

<style scoped>
.ssl__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}

.ssl__title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0;
}

.ssl__subtitle {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-top: 0.15rem;
}

.ssl__refresh {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.45rem 0.85rem;
  border-radius: 10px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  color: var(--text-tertiary);
  font-size: 0.78rem;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
}

.ssl__refresh:hover {
  border-color: var(--primary-border);
  color: var(--primary-text);
  background: var(--primary-bg);
}

.ssl__refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Summary cards */
.ssl__summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.summary-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.3rem;
  padding: 1rem 0.75rem;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  text-align: center;
}

.summary-card__icon {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.summary-card__icon--ok { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
.summary-card__icon--warn { background: rgba(245, 158, 11, 0.1); color: #fbbf24; }
.summary-card__icon--crit { background: rgba(239, 68, 68, 0.1); color: #f87171; }
.summary-card__icon--pending { background: rgba(99, 102, 241, 0.1); color: #818cf8; }

.summary-card__value {
  font-size: 1.5rem;
  font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-primary);
}

.summary-card__label {
  font-size: 0.68rem;
  color: var(--text-muted);
}

/* Table */
.ssl-table {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  overflow: hidden;
}

.ssl-table__head {
  display: grid;
  grid-template-columns: 1.3fr 1.5fr 1fr 0.9fr 0.7fr 1fr 0.4fr;
  padding: 0.55rem 0.85rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}

.ssl-table__th {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.68rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  background: none;
  border: none;
  padding: 0.2rem 0;
  cursor: pointer;
  font-family: inherit;
  transition: color 0.15s;
}

.ssl-table__th:hover { color: var(--text-secondary); }
.ssl-table__th--active { color: var(--primary-text); }
.ssl-table__th--right { justify-content: flex-end; }

.ssl-table__sort-icon {
  transition: transform 0.2s;
}

.ssl-table__sort-icon--asc {
  transform: rotate(180deg);
}

.ssl-table__empty {
  text-align: center;
  padding: 2.5rem;
  color: var(--text-faint);
  font-size: 0.85rem;
}

/* Row */
.ssl-row {
  display: grid;
  grid-template-columns: 1.3fr 1.5fr 1fr 0.9fr 0.7fr 1fr 0.4fr;
  align-items: center;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
  transition: background 0.15s;
}

.ssl-row:last-child {
  border-bottom: none;
}

.ssl-row:hover {
  background: var(--bg-elevated, var(--bg-secondary));
}

.ssl-row__cell {
  font-size: 0.78rem;
  color: var(--text-secondary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssl-row__site {
  font-weight: 600;
  color: var(--text-heading);
}

.ssl-row__domain {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  color: var(--text-muted);
}

.ssl-row__issuer {
  font-size: 0.72rem;
  color: var(--text-muted);
}

.ssl-row__days {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.75rem;
  font-weight: 700;
  text-align: right;
}

.ssl-row__days--ok { color: #4ade80; }
.ssl-row__days--warn { color: #fbbf24; }
.ssl-row__days--crit { color: #f87171; }

.ssl-row__date {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  color: var(--text-faint);
  text-align: right;
}

.ssl-row__wildcard {
  display: flex;
  justify-content: flex-end;
  color: var(--text-faint);
}

/* Status badge */
.status-badge {
  font-size: 0.62rem;
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
  padding: 0.15rem 0.45rem;
  border-radius: 6px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.status-badge--active { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
.status-badge--expiring_soon { background: rgba(245, 158, 11, 0.1); color: #fbbf24; }
.status-badge--expired { background: rgba(239, 68, 68, 0.1); color: #f87171; }
.status-badge--pending { background: rgba(99, 102, 241, 0.1); color: #818cf8; }
.status-badge--none { background: rgba(148, 163, 184, 0.1); color: #94a3b8; }

/* Missing aliases banner */
.ssl-missing {
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.06), rgba(251, 146, 60, 0.06));
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: 14px;
  padding: 0.9rem 1.1rem;
  margin-bottom: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.ssl-missing__head {
  display: flex;
  align-items: flex-start;
  gap: 0.7rem;
}
.ssl-missing__icon {
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
.ssl-missing__title {
  font-size: 0.85rem;
  font-weight: 700;
  color: #fca5a5;
}
.ssl-missing__subtitle {
  font-size: 0.72rem;
  color: var(--text-muted);
  margin-top: 0.15rem;
  line-height: 1.45;
}
.ssl-missing__list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.ssl-missing__item {
  display: grid;
  grid-template-columns: minmax(120px, 180px) 1fr auto;
  align-items: center;
  gap: 0.65rem;
  padding: 0.5rem 0.75rem;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid rgba(239, 68, 68, 0.15);
  border-radius: 9px;
  text-decoration: none;
  color: var(--text-secondary);
  transition: background 0.15s, border-color 0.15s;
}
.ssl-missing__item:hover {
  background: rgba(0, 0, 0, 0.3);
  border-color: rgba(239, 68, 68, 0.35);
}
.ssl-missing__site {
  font-weight: 600;
  color: var(--text-heading);
  font-size: 0.8rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ssl-missing__domains {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  min-width: 0;
}
.ssl-missing__domain {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  background: rgba(239, 68, 68, 0.12);
  color: #fca5a5;
  padding: 0.1em 0.45em;
  border-radius: 5px;
  word-break: break-all;
}
.ssl-missing__domain--main {
  background: rgba(251, 146, 60, 0.15);
  color: #fdba74;
}
.ssl-missing__arrow { color: var(--text-faint); flex-shrink: 0; }

/* Light theme overrides — на тёмной теме фон был rgba(0,0,0,0.2) и на белом
   превращался в грязно-серые карточки; на светлой берём полупрозрачный белый
   + красный бордер, без затемнения. */
html.theme-light .ssl-missing {
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.05), rgba(251, 146, 60, 0.05));
  border-color: rgba(239, 68, 68, 0.2);
}
html.theme-light .ssl-missing__icon {
  background: rgba(239, 68, 68, 0.1);
  color: #dc2626;
}
html.theme-light .ssl-missing__title { color: #b91c1c; }
html.theme-light .ssl-missing__item {
  background: #ffffff;
  border-color: rgba(239, 68, 68, 0.18);
}
html.theme-light .ssl-missing__item:hover {
  background: #fff5f5;
  border-color: rgba(239, 68, 68, 0.35);
}
html.theme-light .ssl-missing__domain {
  background: rgba(239, 68, 68, 0.1);
  color: #b91c1c;
}
html.theme-light .ssl-missing__domain--main {
  background: rgba(234, 88, 12, 0.12);
  color: #9a3412;
}

@media (max-width: 600px) {
  .ssl-missing__item {
    grid-template-columns: 1fr auto;
  }
  .ssl-missing__domains {
    grid-column: 1 / -1;
  }
}

@media (max-width: 900px) {
  .ssl__summary {
    grid-template-columns: repeat(2, 1fr);
  }

  .ssl-table__head,
  .ssl-row {
    grid-template-columns: 1.2fr 1.5fr 0.9fr 0.7fr;
  }

  .ssl-row__issuer,
  .ssl-row__date,
  .ssl-row__wildcard,
  .ssl-table__th:nth-child(3),
  .ssl-table__th:nth-child(6),
  .ssl-table__th:nth-child(7) {
    display: none;
  }
}

@media (max-width: 600px) {
  .ssl__summary {
    grid-template-columns: repeat(2, 1fr);
    gap: 0.65rem;
  }

  .ssl-table__head,
  .ssl-row {
    grid-template-columns: 1fr 0.8fr 0.6fr;
  }

  .ssl-row__domain,
  .ssl-table__th:nth-child(2) {
    display: none;
  }

  .ssl__title {
    font-size: 1.25rem;
  }

  .summary-card {
    padding: 0.75rem 0.5rem;
  }

  .summary-card__value {
    font-size: 1.2rem;
  }
}
</style>
