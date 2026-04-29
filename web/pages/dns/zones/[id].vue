<template>
  <div class="dns-page">
    <div class="dns-header">
      <div>
        <NuxtLink to="/dns" class="dns-back">← Все зоны</NuxtLink>
        <h1 class="dns-title">{{ zone?.domain || 'Загрузка...' }}</h1>
        <p v-if="zone" class="dns-subtitle">
          <span class="dns-badge" :class="`dns-badge--${zone.accountType.toLowerCase()}`">{{ providerLabel(zone.accountType) }}</span>
          {{ zone.accountLabel }} · {{ zone.recordsCount }} записей
        </p>
      </div>
      <div class="dns-actions">
        <button class="btn" :disabled="busy" title="Подтянуть свежий список записей у провайдера" @click="refresh">
          <span :class="{ spinning: busy }" aria-hidden="true">⟳</span>
          Sync
        </button>
        <button class="btn" :disabled="busy" title="Применить почтовый шаблон (SPF/DKIM/MX)" @click="openTemplate">
          <span aria-hidden="true">📧</span>
          Шаблон
        </button>
        <button class="btn btn--primary" :disabled="busy" @click="openCreate">+ Запись</button>
      </div>
    </div>

    <div v-if="zone && zone.nameservers" class="ns-row">
      <span class="ns-label">NS:</span>
      <span v-for="ns in zone.nameservers" :key="ns" class="ns-pill">{{ ns }}</span>
    </div>

    <div v-if="zone" class="records-table">
      <div
        class="records-table__head"
        :class="{ 'records-table__head--cf': zone.accountType === 'CLOUDFLARE' }"
      >
        <span>Тип</span>
        <span>Имя</span>
        <span>Значение</span>
        <span class="num">TTL</span>
        <span class="num">Prio</span>
        <span v-if="zone.accountType === 'CLOUDFLARE'">Proxied</span>
        <span></span>
      </div>
      <div
        v-for="r in zone.records" :key="r.id"
        class="records-row"
        :class="{ 'records-row--cf': zone.accountType === 'CLOUDFLARE' }"
        title="Клик — редактировать"
        @click="openEdit(r)"
      >
        <span class="cell"><span class="rec-type">{{ r.type }}</span></span>
        <span class="cell mono">{{ r.name }}</span>
        <span class="cell mono cell--content" :title="r.content">{{ r.content }}</span>
        <span class="cell num mono">{{ r.ttl }}</span>
        <span class="cell num mono">{{ r.priority ?? '—' }}</span>
        <span v-if="zone.accountType === 'CLOUDFLARE'" class="cell">{{ r.proxied ? '☁' : '—' }}</span>
        <span class="cell cell--actions">
          <button class="btn btn--small" title="Редактировать" @click.stop="openEdit(r)">
            <span aria-hidden="true">✎</span> Edit
          </button>
          <button class="btn btn--small btn--danger" title="Удалить запись" @click.stop="deleteRecord(r)">
            <span aria-hidden="true">🗑</span>
          </button>
        </span>
      </div>
      <div v-if="!zone.records.length" class="records-empty">Нет записей</div>
    </div>

    <!-- Record modal -->
    <div v-if="recordModal" class="modal-overlay" @click.self="recordModal = false">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dns-record-modal-title">
        <h2 id="dns-record-modal-title" class="modal__title">{{ editingId ? 'Редактировать запись' : 'Новая запись' }}</h2>
        <div class="form">
          <div class="form__grid">
            <label class="field">
              <span class="field__label">Тип</span>
              <select v-model="form.type" class="dns-input">
                <option v-for="t in recordTypes" :key="t" :value="t">{{ t }}</option>
              </select>
            </label>
            <label class="field">
              <span class="field__label">Имя ("@" для apex)</span>
              <input v-model="form.name" type="text" class="dns-input" />
            </label>
            <label class="field" style="grid-column: span 2;">
              <span class="field__label">Значение</span>
              <input v-model="form.content" type="text" class="dns-input mono" />
              <span v-if="formError" class="field__err">{{ formError }}</span>
            </label>
            <label class="field">
              <span class="field__label">TTL</span>
              <input v-model.number="form.ttl" type="number" min="1" class="dns-input" />
            </label>
            <label v-if="form.type === 'MX' || form.type === 'SRV'" class="field">
              <span class="field__label">Priority</span>
              <input v-model.number="form.priority" type="number" min="0" max="65535" class="dns-input" />
            </label>
            <label v-if="zone?.accountType === 'CLOUDFLARE'" class="field">
              <span class="field__label">Proxied</span>
              <input v-model="form.proxied" type="checkbox" />
            </label>
            <label class="field" style="grid-column: span 2;">
              <span class="field__label">Комментарий</span>
              <input v-model="form.comment" type="text" class="dns-input" />
            </label>
          </div>
          <div class="form__actions">
            <button class="btn" :disabled="submitting" @click="recordModal = false">Отмена</button>
            <button class="btn btn--primary" :disabled="submitting" @click="submitRecord">{{ submitting ? '...' : 'Сохранить' }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Template modal -->
    <div v-if="templateModal" class="modal-overlay" @click.self="templateModal = false">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dns-template-modal-title">
        <h2 id="dns-template-modal-title" class="modal__title">Применить почтовый шаблон</h2>
        <div class="form">
          <label class="field">
            <span class="field__label">Шаблон</span>
            <select v-model="tplForm.template" class="dns-input">
              <option value="YANDEX_MAIL">Yandex Mail</option>
              <option value="YANDEX_360">Yandex 360</option>
              <option value="VK_MAIL">VK Mail</option>
            </select>
          </label>
          <label class="field">
            <span class="field__label">DKIM ключ (опционально)</span>
            <textarea v-model="tplForm.dkim" class="dns-input dns-input--textarea" rows="3" placeholder="MIGfMA0GCSq..." />
          </label>
          <label class="field">
            <span class="field__label">Селектор DKIM (опционально)</span>
            <input v-model="tplForm.dkimSelector" type="text" class="dns-input" placeholder="mail" />
          </label>
          <p class="hint">Существующие записи с тем же type+name будут пропущены.</p>
          <div class="form__actions">
            <button class="btn" :disabled="submitting" @click="templateModal = false">Отмена</button>
            <button class="btn btn--primary" :disabled="submitting" @click="submitTemplate">{{ submitting ? '...' : 'Применить' }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Список сайтов, под которые попадает зона (динамически по domain+aliases) -->
    <div v-if="zone && zone.matchedSites && zone.matchedSites.length" class="matched-sites">
      <span class="matched-sites__label">Покрывает сайты:</span>
      <NuxtLink
        v-for="s in zone.matchedSites" :key="s.id"
        :to="`/sites/${s.id}`"
        class="site-chip"
        :title="s.domain"
      >{{ s.name }} <span class="site-chip__domain">({{ s.domain }})</span></NuxtLink>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface DnsRecord {
  id: string;
  externalId: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  priority: number | null;
  proxied: boolean | null;
  comment: string | null;
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
  nameservers: string[] | null;
  records: DnsRecord[];
}

const route = useRoute();
const api = useApi();
const toast = useMbToast();
const confirm = useMbConfirm();

const zoneId = computed(() => String(route.params.id));
const zone = ref<Zone | null>(null);
const busy = ref(false);
const recordModal = ref(false);
const templateModal = ref(false);
const submitting = ref(false);
const editingId = ref<string | null>(null);
const formError = ref('');

const recordTypes = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'];

const form = ref({
  type: 'A', name: '@', content: '', ttl: 300,
  priority: undefined as number | undefined,
  proxied: false,
  comment: '',
});

const tplForm = ref({ template: 'YANDEX_MAIL', dkim: '', dkimSelector: '' });

const templatePreview = computed(() => {
  const t = tplForm.value.template;
  const lines: string[] = [];
  if (t === 'YANDEX_MAIL' || t === 'YANDEX_360') {
    lines.push('MX  @       10 mx.yandex.net.');
    lines.push('TXT @       v=spf1 redirect=_spf.yandex.net');
    lines.push('CNAME mail  domain.mail.yandex.net.');
    lines.push('TXT _dmarc  v=DMARC1; p=none;');
    if (t === 'YANDEX_360') lines.push('CNAME _domainconnect _domainconnect.connect.domains.yandex.net.');
  }
  if (t === 'VK_MAIL') {
    lines.push('MX  @       10 emx.mail.ru.');
    lines.push('TXT @       v=spf1 redirect=_spf.mail.ru');
    lines.push('TXT _dmarc  v=DMARC1; p=none;');
  }
  if (tplForm.value.dkim.trim()) {
    const sel = tplForm.value.dkimSelector || (t.startsWith('YANDEX') ? 'mail' : 'mailru');
    lines.push(`TXT ${sel}._domainkey  v=DKIM1; k=rsa; t=s; p=...`);
  }
  return lines;
});

function providerLabel(t: string) {
  if (t === 'CLOUDFLARE') return 'Cloudflare';
  if (t === 'YANDEX_CLOUD') return 'Yandex Cloud';
  if (t === 'VK_CLOUD') return 'VK Cloud';
  if (t === 'YANDEX_360') return 'Yandex 360';
  return t;
}

async function load() {
  try {
    zone.value = await api.get<Zone>(`/dns/zones/${zoneId.value}`);
  } catch (e) {
    toast.error((e as Error).message);
  }
}

async function refresh() {
  busy.value = true;
  const before = zone.value?.recordsCount || 0;
  try {
    await api.post(`/dns/zones/${zoneId.value}/refresh`);
    await load();
    const after = zone.value?.recordsCount || 0;
    if (before > 0 && after === 0) {
      toast.warning('Локальный кеш записей очищен — провайдер вернул пустой список. Возможно, временный сбой.');
    } else {
      toast.success('Обновлено');
    }
  } catch (e) { toast.error((e as Error).message); }
  finally { busy.value = false; }
}

function openCreate() {
  editingId.value = null;
  form.value = { type: 'A', name: '@', content: '', ttl: 300, priority: undefined, proxied: false, comment: '' };
  formError.value = '';
  recordModal.value = true;
}

function openEdit(r: DnsRecord) {
  editingId.value = r.id;
  form.value = {
    type: r.type,
    name: r.name,
    content: r.content,
    ttl: r.ttl,
    priority: r.priority ?? undefined,
    proxied: !!r.proxied,
    comment: r.comment || '',
  };
  formError.value = '';
  recordModal.value = true;
}

function validateContent(): string {
  const c = form.value.content.trim();
  if (!c) return 'Значение не может быть пустым';
  if (form.value.type === 'A') {
    if (!/^(\d{1,3})(\.\d{1,3}){3}$/.test(c)) return 'Не похоже на IPv4';
  } else if (form.value.type === 'AAAA') {
    if (!/^[0-9a-fA-F:]+$/.test(c)) return 'Не похоже на IPv6';
  } else if (form.value.type === 'CNAME' || form.value.type === 'NS') {
    if (!/^[a-zA-Z0-9._-]+$/.test(c)) return 'Не похоже на hostname';
  }
  if ((form.value.type === 'MX' || form.value.type === 'SRV') && (form.value.priority === undefined || form.value.priority === null)) {
    return 'Priority обязателен для MX/SRV';
  }
  if (form.value.type === 'MX') {
    if (!/^[a-zA-Z0-9._-]+\.?$/.test(c) || c.length > 253) return 'MX: ожидается hostname (например mx.example.com)';
  }
  if (form.value.type === 'SRV') {
    const tokens = c.split(/\s+/);
    if (tokens.length !== 3 && tokens.length !== 4) return 'SRV: ожидается "weight port target" (priority в отдельном поле)';
    for (let i = 0; i < tokens.length - 1; i++) {
      if (!/^\d+$/.test(tokens[i])) return 'SRV: первые 2-3 токена должны быть числами';
    }
  }
  if (form.value.type === 'CAA') {
    if (!/^\d+\s+\w+\s+.+$/.test(c)) return 'CAA: ожидается "flags tag value" (например `0 issue "letsencrypt.org"`)';
  }
  if (form.value.type === 'TXT') {
    if (c.length > 4096) return 'TXT: слишком длинно (>4096)';
  }
  return '';
}

async function submitRecord() {
  formError.value = validateContent();
  if (formError.value) return;
  submitting.value = true;
  const body: Record<string, unknown> = {
    type: form.value.type,
    name: form.value.name.trim(),
    content: form.value.content.trim(),
    ttl: form.value.ttl,
  };
  if (form.value.priority !== undefined) body.priority = form.value.priority;
  if (zone.value?.accountType === 'CLOUDFLARE') body.proxied = form.value.proxied;
  if (form.value.comment) body.comment = form.value.comment;

  try {
    if (editingId.value) {
      await api.patch(`/dns/zones/${zoneId.value}/records/${editingId.value}`, body);
      toast.success('Запись обновлена');
    } else {
      await api.post(`/dns/zones/${zoneId.value}/records`, body);
      toast.success('Запись создана');
    }
    recordModal.value = false;
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  } finally { submitting.value = false; }
}

async function deleteRecord(r: DnsRecord) {
  const ok = await confirm.ask({
    title: 'Удалить запись?',
    message: `${r.type} ${r.name} → ${r.content}`,
    danger: true,
    confirmText: 'Удалить',
  });
  if (!ok) return;
  try {
    await api.del(`/dns/zones/${zoneId.value}/records/${r.id}`);
    toast.success('Удалено');
    await load();
  } catch (e) { toast.error((e as Error).message); }
}

function openTemplate() {
  tplForm.value = { template: 'YANDEX_MAIL', dkim: '', dkimSelector: '' };
  templateModal.value = true;
}

async function submitTemplate() {
  const ok = await confirm.ask({
    title: 'Применить шаблон?',
    message: `Будут созданы записи:\n\n${templatePreview.value.join('\n')}\n\nСуществующие записи с тем же type+name будут пропущены.`,
    confirmText: 'Применить',
  });
  if (!ok) return;
  submitting.value = true;
  try {
    const extras: Record<string, string> = {};
    if (tplForm.value.dkim.trim()) extras.dkim = tplForm.value.dkim.trim();
    if (tplForm.value.dkimSelector.trim()) extras.dkimSelector = tplForm.value.dkimSelector.trim();
    const body: Record<string, unknown> = { template: tplForm.value.template };
    if (Object.keys(extras).length) body.extras = extras;
    const res = await api.post<{ created: Array<{ type: string; name: string }>; skipped: Array<{ type: string; name: string; reason: string }> }>(
      `/dns/zones/${zoneId.value}/templates`, body,
    );
    toast.success(`Создано: ${res.created.length}, пропущено: ${res.skipped.length}`);
    templateModal.value = false;
    await load();
  } catch (e) { toast.error((e as Error).message); }
  finally { submitting.value = false; }
}

function handleEsc(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  if (recordModal.value) { recordModal.value = false; e.preventDefault(); }
  else if (templateModal.value) { templateModal.value = false; e.preventDefault(); }
}

onMounted(() => {
  load();
  if (typeof window !== 'undefined') window.addEventListener('keydown', handleEsc);
});
onUnmounted(() => {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', handleEsc);
});
</script>

<style scoped>
.dns-page { padding: 0; }
.dns-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 1.5rem; gap: 1rem; flex-wrap: wrap; }
.dns-back { font-size: 0.78rem; color: var(--text-muted); text-decoration: none; }
.dns-back:hover { color: var(--text-secondary); }
.dns-title { font-size: 1.5rem; font-weight: 700; color: var(--text-heading); margin: 0.25rem 0 0; font-family: 'JetBrains Mono', monospace; }
.dns-subtitle { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem; display: flex; align-items: center; gap: 0.5rem; }
.dns-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }

.btn {
  display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.45rem 0.85rem;
  border-radius: 10px; border: 1px solid var(--border-secondary); background: var(--bg-surface);
  color: var(--text-tertiary); font-size: 0.78rem; font-weight: 500;
  font-family: inherit; cursor: pointer; transition: all 0.2s;
}
.btn:hover:not(:disabled) { border-color: var(--primary-border); color: var(--primary-text); background: var(--primary-bg); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn--primary { background: linear-gradient(135deg, var(--primary), var(--primary-dark)); color: #fff; border-color: transparent; }
.btn--small { padding: 0.25rem 0.55rem; font-size: 0.72rem; border-radius: 6px; }
.btn--danger:hover { color: #ef4444; border-color: #ef4444; background: rgba(239, 68, 68, 0.1); }

.ns-row { display: flex; gap: 0.4rem; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; }
.ns-label { font-size: 0.72rem; color: var(--text-muted); font-weight: 600; }
.ns-pill { font-family: 'JetBrains Mono', monospace; font-size: 0.7rem; color: var(--text-secondary); padding: 0.15rem 0.5rem; background: var(--bg-elevated); border-radius: 4px; }

.records-table { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
.records-table__head, .records-row {
  display: grid;
  grid-template-columns: 0.6fr 1fr 2fr 0.5fr 0.4fr 1fr;
  gap: 0.5rem; align-items: center; padding: 0.55rem 0.85rem;
}
.records-table__head--cf, .records-row--cf {
  grid-template-columns: 0.6fr 1fr 2fr 0.5fr 0.4fr 0.5fr 1fr;
}
.records-table__head { background: var(--bg-secondary); border-bottom: 1px solid var(--border); font-size: 0.68rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; }
.records-row { border-bottom: 1px solid var(--border); font-size: 0.78rem; cursor: pointer; }
.records-row:last-child { border-bottom: none; }
.records-row:hover { background: var(--bg-elevated); }
.records-row:hover .cell--actions .btn { border-color: var(--primary-border); }
.cell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cell.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; }
.cell--content { color: var(--text-secondary); }
.cell.num { text-align: right; }
.cell--actions { display: flex; gap: 0.3rem; justify-content: flex-end; }
.rec-type { font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 0.68rem; padding: 0.1rem 0.4rem; background: var(--bg-elevated); border-radius: 4px; color: var(--primary-text); }
.records-empty { padding: 2rem; text-align: center; color: var(--text-faint); font-size: 0.85rem; }

.dns-badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 6px; font-size: 0.65rem; font-weight: 600; text-transform: uppercase; }
.dns-badge--cloudflare { background: rgba(244, 129, 32, 0.15); color: #f48120; }
.dns-badge--yandex_cloud { background: rgba(255, 196, 0, 0.15); color: #ffc400; }
.dns-badge--yandex_360 { background: rgba(255, 0, 0, 0.12); color: #ff3333; }
.dns-badge--vk_cloud { background: rgba(0, 119, 255, 0.15); color: #0077ff; }

/* Modal */
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 14px; padding: 1.5rem; width: 90%; max-width: 600px; max-height: 90vh; overflow-y: auto; }
.modal__title { font-size: 1.1rem; font-weight: 700; margin: 0 0 1rem; color: var(--text-heading); }
.form { display: flex; flex-direction: column; gap: 0.85rem; }
.form__grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.85rem; }
.field { display: flex; flex-direction: column; gap: 0.3rem; }
.field__label { font-size: 0.72rem; color: var(--text-muted); font-weight: 500; }
.field__err { font-size: 0.7rem; color: #ef4444; }
.dns-input { padding: 0.45rem 0.7rem; border-radius: 8px; border: 1px solid var(--border-secondary); background: var(--bg-elevated); color: var(--text-secondary); font-size: 0.8rem; font-family: inherit; }
.dns-input.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; }
.dns-input--site-select { max-height: 300px; }
.dns-input--textarea { resize: vertical; min-height: 80px; font-family: 'JetBrains Mono', monospace; font-size: 0.7rem; }
.dns-input:focus { outline: none; border-color: var(--primary); }
.form__actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
.hint { font-size: 0.72rem; color: var(--text-muted); margin: 0; }

.spinning { display: inline-block; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.matched-sites { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-top: 1rem; padding: 0.6rem 0.85rem; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; }
.matched-sites__label { font-size: 0.72rem; color: var(--text-muted); }
.site-chip {
  display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.2rem 0.6rem; border-radius: 6px;
  background: var(--bg-elevated); border: 1px solid var(--border-secondary);
  color: var(--text-secondary); font-size: 0.72rem; text-decoration: none;
  font-family: 'JetBrains Mono', monospace;
  transition: all 0.15s;
}
.site-chip:hover { color: var(--primary-text); border-color: var(--primary-border); background: var(--primary-bg); }
.site-chip__domain { color: var(--text-muted); font-size: 0.65rem; }
</style>
