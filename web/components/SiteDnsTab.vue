<template>
  <div class="site-dns">
    <div v-if="loading" class="site-dns__loading">Загрузка DNS-записей…</div>

    <template v-else-if="data">
      <!-- Список зон сайта (apex/parent zones) -->
      <div v-if="data.zones.length" class="site-dns__zones">
        <div class="site-dns__zones-head">
          <strong>Зоны сайта</strong>
          <span class="site-dns__zones-hint">
            Связь динамическая: зона показывается, если её apex покрывает {{ data.site.domain }} или один из алиасов.
          </span>
        </div>
        <div class="site-dns__zones-list">
          <div
            v-for="z in data.zones"
            :key="z.zone.id"
            class="site-dns__zone-card"
            :class="{ 'site-dns__zone-card--linked': z.isLinked }"
          >
            <span class="site-dns__provider-badge" :data-type="z.provider.accountType">
              {{ providerLabel(z.provider.accountType) }}
            </span>
            <span class="site-dns__zone-domain"><code>{{ z.zone.domain }}</code></span>
            <span class="site-dns__zone-meta">
              <span class="site-dns__provider-name">{{ z.provider.accountLabel }}</span>
              <span class="site-dns__zone-records">{{ z.zone.recordsCount }} записей</span>
            </span>
            <NuxtLink :to="`/dns/zones/${z.zone.id}`" class="btn btn--small btn--primary">
              Открыть зону →
            </NuxtLink>
          </div>
        </div>
      </div>

      <div v-else class="site-dns__empty">
        <p>Этот сайт не привязан ни к одной DNS-зоне.</p>
        <p class="site-dns__hint">
          Подключи DNS-провайдера на странице
          <NuxtLink to="/dns/providers">Провайдеры</NuxtLink> и сделай sync —
          панель автоматически свяжет зоны с сайтами по совпадению apex-домена.
        </p>
      </div>

      <!-- Группы записей по доменам (apex + aliases) -->
      <div v-for="g in data.groups" :key="g.host" class="site-dns__group">
        <div class="site-dns__group-head">
          <h3 class="site-dns__group-host">
            <code>{{ g.host }}</code>
            <span v-if="g.isAlias" class="site-dns__alias-badge">alias</span>
          </h3>
          <span class="site-dns__group-count">{{ g.entries.length }} запис{{ pluralize(g.entries.length) }}</span>
        </div>

        <table class="site-dns__table">
          <thead>
            <tr>
              <th class="col-provider">Провайдер</th>
              <th class="col-type">Тип</th>
              <th class="col-content">Значение</th>
              <th class="col-ttl">TTL</th>
              <th class="col-extra"></th>
              <th class="col-actions"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in g.entries" :key="`${e.zone.id}-${e.record.id}`">
              <td class="col-provider">
                <span class="site-dns__provider-badge" :data-type="e.provider.accountType">
                  {{ providerLabel(e.provider.accountType) }}
                </span>
                <span class="site-dns__provider-name-small">{{ e.provider.accountLabel }}</span>
              </td>
              <td class="col-type">
                <span class="site-dns__type-badge" :data-type="e.record.type">{{ e.record.type }}</span>
              </td>
              <td class="col-content">
                <code class="site-dns__content">{{ e.record.content }}</code>
              </td>
              <td class="col-ttl">{{ e.record.ttl === 1 ? 'auto' : e.record.ttl + 's' }}</td>
              <td class="col-extra">
                <span v-if="e.record.priority !== null" class="site-dns__meta">prio {{ e.record.priority }}</span>
                <span v-if="e.record.proxied" class="site-dns__meta site-dns__meta--cf">proxied</span>
                <span v-if="e.record.comment" class="site-dns__meta" :title="e.record.comment">💬</span>
              </td>
              <td class="col-actions">
                <NuxtLink :to="`/dns/zones/${e.zone.id}`" class="btn btn--small">
                  В зоне →
                </NuxtLink>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="!data.groups.length && data.zones.length" class="site-dns__empty">
        <p>В привязанных зонах нет DNS-записей, совпадающих с доменами сайта.</p>
        <p class="site-dns__hint">
          Создай A/AAAA/CNAME для <code>{{ data.site.domain }}</code>
          <span v-if="data.site.aliases.length"> или алиасов</span> на странице зоны.
        </p>
      </div>

      <p class="site-dns__note">
        Записи показаны из локального кэша. Чтобы увидеть актуальные данные провайдера —
        зайди в зону и нажми «Обновить записи».
      </p>
    </template>

    <div v-else-if="error" class="site-dns__error">
      Ошибка загрузки DNS: {{ error }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{ siteId: string; active: boolean }>();

interface DnsRecord {
  id: string; externalId: string; type: string; name: string;
  content: string; ttl: number; priority: number | null;
  proxied: boolean | null; comment: string | null; updatedAt: string;
}
interface DnsEntry {
  provider: { accountId: string; accountLabel: string; accountType: string };
  zone: { id: string; externalId: string; domain: string };
  record: DnsRecord;
}
interface DnsGroup {
  host: string; isAlias: boolean; entries: DnsEntry[];
}
interface DnsZoneRow {
  provider: { accountId: string; accountLabel: string; accountType: string };
  zone: { id: string; externalId: string; domain: string; recordsCount: number };
  isLinked: boolean;
}
interface SiteDnsView {
  site: { id: string; domain: string; aliases: string[] };
  groups: DnsGroup[];
  zones: DnsZoneRow[];
}

const api = useApi();
const data = ref<SiteDnsView | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
let loaded = false;

async function load() {
  loading.value = true;
  error.value = null;
  try {
    // useApi уже распаковывает `.data` из {success,data}-обёртки контроллера.
    data.value = await api.get<SiteDnsView>(`/dns/sites/${props.siteId}`);
    loaded = true;
  } catch (e: unknown) {
    error.value = (e as Error).message || 'неизвестная ошибка';
  } finally {
    loading.value = false;
  }
}

async function refresh() {
  loaded = false;
  await load();
}

defineExpose({ refresh });

// Лениво грузим при первой активации таба
watch(
  () => props.active,
  (val) => {
    if (val && !loaded) load();
  },
  { immediate: true },
);

function providerLabel(t: string): string {
  switch (t) {
    case 'CLOUDFLARE': return 'CF';
    case 'YANDEX_CLOUD': return 'Яндекс';
    case 'YANDEX_360': return 'Я360';
    case 'VK_CLOUD': return 'VK';
    default: return t;
  }
}

function pluralize(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'ь';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'и';
  return 'ей';
}
</script>

<style scoped>
.site-dns { display: flex; flex-direction: column; gap: 1.25rem; }

/* Кнопки в стиле панели — как на /dns и /dns/providers */
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

.site-dns__zones-hint { font-size: 0.72rem; color: var(--text-muted); font-style: italic; }

.site-dns__loading,
.site-dns__error,
.site-dns__empty {
  padding: 1.25rem;
  background: var(--card-bg, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  color: var(--text-muted, #6b7280);
}
.site-dns__error { color: #b91c1c; }
.site-dns__hint { font-size: 13px; margin-top: .5rem; }

.site-dns__zones {
  background: var(--card-bg, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  padding: 1rem;
}
.site-dns__zones-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: .75rem; }
.site-dns__zones-list { display: flex; flex-direction: column; gap: .5rem; }
.site-dns__zone-card {
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  align-items: center;
  gap: .75rem;
  padding: .6rem .75rem;
  background: var(--bg-elevated, #f9fafb);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
}
.site-dns__zone-card--linked { border-color: var(--accent, #3b82f6); }
.site-dns__zone-domain code { font-size: 14px; font-weight: 600; }
.site-dns__zone-meta { display: flex; gap: .75rem; font-size: 12px; color: var(--text-muted, #6b7280); }
.site-dns__zone-linked { color: var(--accent, #3b82f6); font-weight: 600; }

.site-dns__group {
  background: var(--card-bg, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  padding: 1rem;
}
.site-dns__group-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: .75rem; }
.site-dns__group-host { display: flex; align-items: center; gap: .5rem; margin: 0; font-size: 15px; }
.site-dns__group-host code { font-size: 14px; font-weight: 600; }
.site-dns__alias-badge {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 4px;
  background: #e0e7ff;
  color: #3730a3;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}
.site-dns__group-count { font-size: 12px; color: var(--text-muted, #6b7280); }

.site-dns__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.site-dns__table th,
.site-dns__table td {
  padding: .5rem .6rem;
  text-align: left;
  border-bottom: 1px solid var(--border-soft, #f3f4f6);
  vertical-align: middle;
}
.site-dns__table th { font-weight: 600; color: var(--text-muted, #6b7280); font-size: 11px; text-transform: uppercase; }
.site-dns__table tr:last-child td { border-bottom: none; }
.col-provider { white-space: nowrap; }
.col-content { font-family: ui-monospace, monospace; word-break: break-all; }
.col-content code { font-size: 12px; }
.col-actions, .col-extra, .col-ttl, .col-type { white-space: nowrap; }

.site-dns__provider-badge {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  margin-right: .35rem;
}
.site-dns__provider-badge[data-type="CLOUDFLARE"] { background: rgba(244, 129, 32, 0.15); color: #f48120; }
.site-dns__provider-badge[data-type="YANDEX_CLOUD"] { background: rgba(255, 196, 0, 0.18); color: #b8860b; }
.site-dns__provider-badge[data-type="YANDEX_360"] { background: rgba(255, 0, 0, 0.12); color: #c92020; }
.site-dns__provider-badge[data-type="VK_CLOUD"] { background: rgba(0, 119, 255, 0.15); color: #0077ff; }

.site-dns__provider-name-small { font-size: 11px; color: var(--text-muted, #6b7280); }
.site-dns__provider-name { font-size: 12px; }

.site-dns__type-badge {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 4px;
  background: #f3f4f6;
  color: #374151;
  font-size: 11px;
  font-weight: 600;
}
.site-dns__type-badge[data-type="A"] { background: #d1fae5; color: #065f46; }
.site-dns__type-badge[data-type="AAAA"] { background: #d1fae5; color: #065f46; }
.site-dns__type-badge[data-type="CNAME"] { background: #ede9fe; color: #5b21b6; }
.site-dns__type-badge[data-type="MX"] { background: #fef3c7; color: #92400e; }
.site-dns__type-badge[data-type="TXT"] { background: #e0e7ff; color: #3730a3; }
.site-dns__type-badge[data-type="NS"] { background: #fce7f3; color: #9d174d; }

.site-dns__meta { font-size: 11px; color: var(--text-muted, #6b7280); margin-right: .35rem; }
.site-dns__meta--cf { color: #b45309; font-weight: 600; }

.site-dns__note {
  font-size: 12px;
  color: var(--text-muted, #6b7280);
  margin-top: .5rem;
}
</style>
