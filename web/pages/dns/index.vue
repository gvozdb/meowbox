<template>
  <div class="dns-page">
    <div class="dns-header">
      <div>
        <h1 class="dns-title">DNS</h1>
        <p class="dns-subtitle">Зоны и записи у внешних провайдеров</p>
      </div>
      <div class="dns-actions">
        <button class="btn" :disabled="loading" @click="refreshAll">
          <span :class="{ spinning: loading }" aria-hidden="true">⟳</span>
          Обновить
        </button>
        <NuxtLink to="/dns/providers" class="btn btn--primary">Провайдеры</NuxtLink>
      </div>
    </div>

    <div class="dns-filters">
      <input v-model="search" type="text" placeholder="Поиск по домену..." class="dns-input" />
      <select v-model="filterAccount" class="dns-input">
        <option value="">Все провайдеры</option>
        <option v-for="p in providers" :key="p.id" :value="p.id">
          {{ providerLabel(p.type) }} — {{ p.label }}
        </option>
      </select>
    </div>

    <div v-if="!filteredZones.length && !loading" class="dns-empty">
      <p v-if="!providers.length">
        У тебя ещё нет подключённых DNS-провайдеров. Добавь Cloudflare, Yandex Cloud или VK Cloud, чтобы управлять записями из панели.
      </p>
      <p v-else>
        Зон не найдено. Зайди к провайдеру и нажми <strong>Sync</strong>, либо смени фильтр.
      </p>
      <div class="dns-empty__cta">
        <NuxtLink to="/dns/providers" class="btn btn--primary">
          {{ providers.length ? 'Открыть провайдеров' : 'Подключить провайдера' }}
        </NuxtLink>
      </div>
    </div>

    <div v-else class="dns-table">
      <div class="dns-table__head">
        <span>Провайдер</span>
        <span>Домен</span>
        <span>Статус</span>
        <span class="dns-table__num">Записей</span>
        <span>Сайты</span>
        <span>Последний sync</span>
        <span></span>
      </div>
      <div v-for="z in filteredZones" :key="z.id" class="dns-row">
        <span class="dns-cell">
          <span class="dns-badge" :class="`dns-badge--${z.accountType.toLowerCase()}`">{{ providerLabel(z.accountType) }}</span>
        </span>
        <span class="dns-cell dns-cell--domain">{{ z.domain }}</span>
        <span class="dns-cell">
          <span class="dns-status" :class="`dns-status--${(z.status || '').toLowerCase()}`">{{ z.status }}</span>
        </span>
        <span class="dns-cell dns-cell--num">{{ z.recordsCount }}</span>
        <span class="dns-cell dns-cell--sites" :title="sitesTooltip(z.matchedSites)">
          <template v-if="z.matchedSites && z.matchedSites.length">
            <NuxtLink
              v-for="(s, idx) in z.matchedSites.slice(0, 3)"
              :key="s.id"
              :to="`/sites/${s.id}`"
              class="site-chip"
            >{{ s.name }}<span v-if="idx < Math.min(z.matchedSites.length, 3) - 1">,</span></NuxtLink>
            <span v-if="z.matchedSites.length > 3" class="site-chip site-chip--more">+{{ z.matchedSites.length - 3 }}</span>
          </template>
          <span v-else class="dns-cell--muted">—</span>
        </span>
        <span class="dns-cell dns-cell--small">{{ formatDate(z.recordsCachedAt) }}</span>
        <span class="dns-cell dns-cell--actions">
          <button
            class="btn btn--small"
            :disabled="refreshingId === z.id"
            title="Подтянуть свежий список записей у провайдера"
            @click="refreshZone(z.id)"
          >
            <span :class="{ spinning: refreshingId === z.id }" aria-hidden="true">⟳</span>
            <span>{{ refreshingId === z.id ? 'Sync…' : 'Sync' }}</span>
          </button>
          <NuxtLink :to="`/dns/zones/${z.id}`" class="btn btn--small btn--primary">Открыть</NuxtLink>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface Provider {
  id: string;
  type: string;
  label: string;
}
interface MatchedSite { id: string; name: string; domain: string }
interface Zone {
  id: string;
  accountId: string;
  accountLabel: string;
  accountType: string;
  domain: string;
  status: string;
  recordsCount: number;
  recordsCachedAt: string | null;
  matchedSites: MatchedSite[];
}

const api = useApi();
const toast = useMbToast();

const providers = ref<Provider[]>([]);
const zones = ref<Zone[]>([]);
const loading = ref(false);
const search = ref('');
const filterAccount = ref('');
const refreshingId = ref<string | null>(null);

const filteredZones = computed(() => {
  let list = zones.value;
  if (filterAccount.value) list = list.filter((z) => z.accountId === filterAccount.value);
  if (search.value.trim()) {
    const q = search.value.trim().toLowerCase();
    list = list.filter((z) => z.domain.toLowerCase().includes(q));
  }
  return list;
});

function providerLabel(t: string) {
  if (t === 'CLOUDFLARE') return 'Cloudflare';
  if (t === 'YANDEX_CLOUD') return 'Yandex Cloud';
  if (t === 'VK_CLOUD') return 'VK Cloud';
  if (t === 'YANDEX_360') return 'Yandex 360';
  return t;
}

function formatDate(s: string | null) {
  if (!s) return '—';
  return new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function sitesTooltip(sites: MatchedSite[] | undefined): string {
  if (!sites || !sites.length) return 'Сайтов с этим доменом или субдоменом нет';
  return sites.map((s) => `${s.name} (${s.domain})`).join('\n');
}

async function refreshAll() {
  loading.value = true;
  try {
    const [provs, zns] = await Promise.all([
      api.get<Provider[]>('/dns/providers'),
      api.get<Zone[]>('/dns/zones'),
    ]);
    providers.value = provs;
    zones.value = zns;
  } catch (e) {
    toast.error((e as Error).message || 'Не удалось загрузить зоны');
  } finally {
    loading.value = false;
  }
}

async function refreshZone(zoneId: string) {
  refreshingId.value = zoneId;
  try {
    await api.post(`/dns/zones/${zoneId}/refresh`);
    toast.success('Записи обновлены');
    await refreshAll();
  } catch (e) {
    toast.error((e as Error).message || 'Ошибка refresh');
  } finally {
    refreshingId.value = null;
  }
}

onMounted(() => { refreshAll(); });
</script>

<style scoped>
.dns-page { padding: 0; }
.dns-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 1.5rem; gap: 1rem; flex-wrap: wrap; }
.dns-title { font-size: 1.5rem; font-weight: 700; color: var(--text-heading); margin: 0; }
.dns-subtitle { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.15rem; }
.dns-actions { display: flex; gap: 0.5rem; }

.btn {
  display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.45rem 0.85rem;
  border-radius: 10px; border: 1px solid var(--border-secondary); background: var(--bg-surface);
  color: var(--text-tertiary); font-size: 0.78rem; font-weight: 500;
  font-family: inherit; cursor: pointer; transition: all 0.2s; text-decoration: none;
}
.btn:hover:not(:disabled) { border-color: var(--primary-border); color: var(--primary-text); background: var(--primary-bg); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn--primary { background: linear-gradient(135deg, var(--primary), var(--primary-dark)); color: #fff; border-color: transparent; }
.btn--primary:hover:not(:disabled) { background: linear-gradient(135deg, var(--primary-dark), var(--primary)); color: #fff; }
.btn--small { padding: 0.25rem 0.6rem; font-size: 0.72rem; border-radius: 6px; }

.spinning { display: inline-block; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.dns-filters { display: flex; gap: 0.6rem; margin-bottom: 1rem; }
.dns-input {
  padding: 0.45rem 0.7rem; border-radius: 8px; border: 1px solid var(--border-secondary);
  background: var(--bg-elevated); color: var(--text-secondary); font-size: 0.8rem;
  font-family: inherit; min-width: 200px;
}
.dns-input:focus { outline: none; border-color: var(--primary); }

.dns-empty { padding: 3rem; text-align: center; color: var(--text-faint); background: var(--bg-surface); border-radius: 14px; border: 1px solid var(--border); }
.dns-empty p { margin: 0 0 1rem 0; }
.dns-empty__cta { display: flex; justify-content: center; }

.dns-table { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
.dns-table__head, .dns-row {
  display: grid;
  grid-template-columns: 1.1fr 1.8fr 0.8fr 0.7fr 1.6fr 1fr 1.7fr;
  gap: 0.5rem; align-items: center; padding: 0.55rem 0.85rem;
}
.dns-table__head { background: var(--bg-secondary); border-bottom: 1px solid var(--border); font-size: 0.68rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.dns-row { border-bottom: 1px solid var(--border); font-size: 0.8rem; }
.dns-row:last-child { border-bottom: none; }
.dns-row:hover { background: var(--bg-elevated); }

.dns-cell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dns-cell--domain { font-family: 'JetBrains Mono', monospace; font-weight: 600; color: var(--text-heading); }
.dns-cell--num { text-align: right; font-family: 'JetBrains Mono', monospace; }
.dns-cell--small { font-size: 0.72rem; color: var(--text-muted); }
.dns-cell--muted { color: var(--text-faint); }
.dns-cell--actions { display: flex; gap: 0.35rem; justify-content: flex-end; }
.dns-cell--sites { display: flex; gap: 0.3rem; flex-wrap: nowrap; overflow: hidden; }
.dns-table__num { text-align: right; }

.site-chip {
  display: inline-flex; align-items: center; padding: 0.1rem 0.45rem; border-radius: 5px;
  background: var(--bg-elevated); color: var(--text-secondary); border: 1px solid var(--border-secondary);
  font-size: 0.7rem; font-family: 'JetBrains Mono', monospace; text-decoration: none;
  max-width: 130px; overflow: hidden; text-overflow: ellipsis;
  transition: all 0.15s;
}
.site-chip:hover { color: var(--primary-text); border-color: var(--primary-border); background: var(--primary-bg); }
.site-chip--more { background: transparent; color: var(--text-muted); cursor: default; }
.site-chip--more:hover { color: var(--text-muted); border-color: var(--border-secondary); background: transparent; }

.dns-badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 6px; font-size: 0.65rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.dns-badge--cloudflare { background: rgba(244, 129, 32, 0.15); color: #f48120; }
.dns-badge--yandex_cloud { background: rgba(255, 196, 0, 0.15); color: #ffc400; }
.dns-badge--yandex_360 { background: rgba(255, 0, 0, 0.12); color: #ff3333; }
.dns-badge--vk_cloud { background: rgba(0, 119, 255, 0.15); color: #0077ff; }

.dns-status { display: inline-block; padding: 0.1rem 0.45rem; border-radius: 4px; font-size: 0.65rem; text-transform: uppercase; }
.dns-status--active { background: rgba(34, 197, 94, 0.12); color: #22c55e; }
.dns-status--error { background: rgba(239, 68, 68, 0.12); color: #ef4444; }
</style>
