<template>
  <div class="dns-page">
    <div class="dns-header">
      <div>
        <NuxtLink to="/dns" class="dns-back">← Зоны</NuxtLink>
        <h1 class="dns-title">DNS-провайдеры</h1>
        <p class="dns-subtitle">Подключённые аккаунты Cloudflare и Yandex 360</p>
      </div>
      <button class="btn btn--primary" @click="openCreate">+ Добавить</button>
    </div>

    <div v-if="!providers.length && !loading" class="dns-empty">
      Нет подключённых аккаунтов.
    </div>

    <div v-else class="dns-providers">
      <div v-for="p in providers" :key="p.id" class="provider-card">
        <div class="provider-card__head">
          <div class="provider-card__title">
            <span class="dns-badge" :class="`dns-badge--${p.type.toLowerCase()}`">{{ providerLabel(p.type) }}</span>
            <span class="provider-card__label">{{ p.label }}</span>
            <span v-if="p.status !== 'ACTIVE'" class="dns-status" :class="`dns-status--${p.status.toLowerCase()}`">{{ p.status }}</span>
          </div>
          <div class="provider-card__actions">
            <button class="btn btn--small" :disabled="busyId === p.id" @click="testProvider(p.id)">Тест</button>
            <button class="btn btn--small" :disabled="busyId === p.id" @click="syncProvider(p.id)">Sync</button>
            <button class="btn btn--small" :disabled="busyId === p.id" @click="deleteProvider(p.id)">Удалить</button>
          </div>
        </div>
        <div class="provider-card__body">
          <div class="kv">
            <span class="kv__k">Зон:</span><span class="kv__v">{{ p.zonesCount }}</span>
          </div>
          <div class="kv">
            <span class="kv__k">Sync:</span><span class="kv__v">{{ formatDate(p.lastSyncAt) }}</span>
          </div>
          <div v-if="p.scopeId" class="kv">
            <span class="kv__k">Scope:</span><span class="kv__v">{{ p.scopeId }}</span>
          </div>
          <div v-if="p.apiBaseUrl" class="kv">
            <span class="kv__k">API:</span><span class="kv__v">{{ p.apiBaseUrl }}</span>
          </div>
          <div v-if="p.lastError" class="provider-card__err">⚠ {{ p.lastError }}</div>
          <div class="provider-card__creds">
            <span v-for="(v, k) in p.credentialsHint" :key="k" class="cred-pill">{{ k }}: {{ v }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Create modal -->
    <div v-if="modalOpen" class="modal-overlay" @click.self="modalOpen = false">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dns-provider-modal-title">
        <h2 id="dns-provider-modal-title" class="modal__title">Подключить DNS-провайдера</h2>
        <div class="form">
          <label class="field">
            <span class="field__label">Тип</span>
            <select v-model="form.type" class="dns-input">
              <option value="CLOUDFLARE">Cloudflare</option>
              <option value="YANDEX_360">Yandex 360 (admin.yandex.ru)</option>
            </select>
          </label>

          <!-- Help: Cloudflare -->
          <div v-if="form.type === 'CLOUDFLARE'" class="dns-help" data-type="CLOUDFLARE">
            <div class="dns-help__title">Как получить API Token</div>
            <ol class="dns-help__list">
              <li>Открой <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer">dash.cloudflare.com → My Profile → API Tokens</a></li>
              <li>Нажми <b>Create Token</b> → выбери шаблон <b>Edit zone DNS</b> (или Custom Token)</li>
              <li>Permissions: <code>Zone → Zone → Read</code> и <code>Zone → DNS → Edit</code></li>
              <li>Zone Resources: <code>Include → All zones</code> (или конкретные зоны)</li>
              <li>Скопируй токен сразу — повторно его не покажут</li>
            </ol>
            <div class="dns-help__note">⚠ Global API Key не подойдёт — нужен именно scoped API Token.</div>
          </div>

          <!-- Help: Yandex Cloud -->
          <div v-if="form.type === 'YANDEX_CLOUD'" class="dns-help" data-type="YANDEX_CLOUD">
            <div class="dns-help__title">Как получить Service Account Key</div>
            <ol class="dns-help__list">
              <li>Открой <a href="https://console.cloud.yandex.ru/" target="_blank" rel="noopener noreferrer">console.cloud.yandex.ru</a> → нужный каталог</li>
              <li>Слева <b>Service Accounts</b> → <b>Create service account</b></li>
              <li>Назначь роль <code>dns.editor</code> (или <code>dns.admin</code>) на каталог</li>
              <li>Открой созданный SA → <b>Create new key</b> → <b>Authorized key</b> → формат <b>JSON</b></li>
              <li>Скачанный JSON (с полями <code>id</code>, <code>service_account_id</code>, <code>private_key</code>) вставь в поле ниже</li>
              <li><b>Folder ID</b> возьми из URL консоли: <code>folders/<b>b1g...</b></code></li>
            </ol>
            <div class="dns-help__note">Файл ключа можно скачать только один раз — сохрани его сразу.</div>
          </div>

          <!-- Help: Yandex 360 -->
          <div v-if="form.type === 'YANDEX_360'" class="dns-help" data-type="YANDEX_360">
            <div class="dns-help__title">Как подключить</div>
            <ol class="dns-help__list">
              <li>Подключи и подтверди домен в <a href="https://admin.yandex.ru/" target="_blank" rel="noopener noreferrer">admin.yandex.ru</a> → <b>Настройки → Домены</b></li>
              <li>Создай OAuth-приложение на <a href="https://oauth.yandex.ru/client/new" target="_blank" rel="noopener noreferrer">oauth.yandex.ru/client/new</a> — платформа <code>Веб-сервисы</code>, Redirect URI <code>https://oauth.yandex.ru/verification_code</code>. Скоупы: <code>directory:read_domains</code> + <code>directory:manage_dns</code>. Получи <b>ClientID</b> и <b>Client Secret</b>.</li>
              <li>Открой <code>https://oauth.yandex.ru/authorize?response_type=code&client_id=&lt;ClientID&gt;</code> — Яндекс выдаст <b>Authorization Code</b> (живёт ~10 мин)</li>
              <li>Заполни форму ниже. <b>Org ID</b> оставь пустым — будут синкаться все твои организации.</li>
            </ol>
            <div class="dns-help__note">✅ Бэк сам обменяет code на access+refresh токены. Дальше всё обновляется автоматически.</div>
          </div>

          <!-- Help: VK Cloud -->
          <div v-if="form.type === 'VK_CLOUD'" class="dns-help" data-type="VK_CLOUD">
            <div class="dns-help__title">Как получить Application Credential</div>
            <ol class="dns-help__list">
              <li>Открой <a href="https://mcs.mail.ru/app/" target="_blank" rel="noopener noreferrer">mcs.mail.ru/app</a> → нужный проект</li>
              <li>Меню профиля (справа сверху) → <b>API ключи</b> / <b>Application Credentials</b></li>
              <li>Нажми <b>Создать</b>: задай имя, роль <code>member</code> (или <code>admin</code>), unrestricted = off</li>
              <li>Скопируй <b>ID</b> и <b>Secret</b> — secret покажут только один раз</li>
              <li><b>Project ID</b> — UUID проекта из настроек проекта (опционально, нужен если несколько проектов)</li>
            </ol>
            <div class="dns-help__note">API Base URL менять не нужно, если не используется приватный эндпоинт.</div>
          </div>

          <label class="field">
            <span class="field__label">Название</span>
            <input v-model="form.label" type="text" class="dns-input" placeholder="напр., Production CF" />
          </label>

          <!-- Cloudflare -->
          <template v-if="form.type === 'CLOUDFLARE'">
            <label class="field">
              <span class="field__label">API Token (Zone:Read + DNS:Edit)</span>
              <input v-model="form.cfToken" type="password" class="dns-input" />
            </label>
          </template>

          <!-- Yandex 360 -->
          <template v-if="form.type === 'YANDEX_360'">
            <label class="field">
              <span class="field__label">Client ID</span>
              <input v-model="form.y360ClientId" type="text" class="dns-input" placeholder="32-символьный hex" autocomplete="off" />
            </label>
            <label class="field">
              <span class="field__label">Client Secret</span>
              <input v-model="form.y360ClientSecret" type="password" class="dns-input" autocomplete="off" />
            </label>
            <label class="field">
              <span class="field__label">Authorization Code <span class="field__hint">(одноразовый, ~10 мин)</span></span>
              <input v-model="form.y360Code" type="text" class="dns-input" placeholder="код со страницы oauth.yandex.ru" autocomplete="off" />
            </label>
            <label class="field">
              <span class="field__label">Org ID <span class="field__hint">(пусто = все ваши организации)</span></span>
              <input v-model="form.scopeId" type="text" class="dns-input" placeholder="оставь пустым, чтобы синкать все" />
            </label>
          </template>

          <!-- Yandex Cloud -->
          <template v-if="form.type === 'YANDEX_CLOUD'">
            <label class="field">
              <span class="field__label">Service Account Key (JSON)</span>
              <textarea v-model="form.ycKeyJson" class="dns-input dns-input--textarea" rows="6" placeholder='{ "id": "...", "service_account_id": "...", "private_key": "-----BEGIN PRIVATE KEY-----\n..." }' />
            </label>
            <label class="field">
              <span class="field__label">Folder ID</span>
              <input v-model="form.scopeId" type="text" class="dns-input" placeholder="b1g..." />
            </label>
          </template>

          <!-- VK Cloud -->
          <template v-if="form.type === 'VK_CLOUD'">
            <label class="field">
              <span class="field__label">Application Credential ID</span>
              <input v-model="form.vkAppId" type="text" class="dns-input" />
            </label>
            <label class="field">
              <span class="field__label">Application Credential Secret</span>
              <input v-model="form.vkAppSecret" type="password" class="dns-input" />
            </label>
            <label class="field">
              <span class="field__label">Project ID (опционально)</span>
              <input v-model="form.scopeId" type="text" class="dns-input" />
            </label>
            <label class="field">
              <span class="field__label">API Base URL (опционально, override)</span>
              <input v-model="form.apiBaseUrl" type="text" class="dns-input" placeholder="https://public-dns.mcs.mail.ru/v2" />
            </label>
          </template>

          <div class="form__actions">
            <button class="btn" :disabled="submitting" @click="modalOpen = false">Отмена</button>
            <button class="btn btn--primary" :disabled="submitting" @click="submit">{{ submitting ? 'Проверка...' : 'Подключить' }}</button>
          </div>
        </div>
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
  scopeId: string | null;
  apiBaseUrl: string | null;
  status: string;
  lastError: string | null;
  lastSyncAt: string | null;
  zonesCount: number;
  credentialsHint: Record<string, string>;
}

const api = useApi();
const toast = useMbToast();
const confirm = useMbConfirm();

const providers = ref<Provider[]>([]);
const loading = ref(false);
const busyId = ref<string | null>(null);
const modalOpen = ref(false);
const submitting = ref(false);

const form = ref({
  type: 'CLOUDFLARE',
  label: '',
  cfToken: '',
  ycKeyJson: '',
  vkAppId: '',
  vkAppSecret: '',
  y360ClientId: '',
  y360ClientSecret: '',
  y360Code: '',
  scopeId: '',
  apiBaseUrl: '',
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
  return new Date(s).toLocaleString('ru-RU');
}

async function load() {
  loading.value = true;
  try {
    providers.value = await api.get<Provider[]>('/dns/providers');
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  form.value = {
    type: 'CLOUDFLARE', label: '',
    cfToken: '', ycKeyJson: '', vkAppId: '', vkAppSecret: '',
    y360ClientId: '', y360ClientSecret: '', y360Code: '',
    scopeId: '', apiBaseUrl: '',
  };
  modalOpen.value = true;
}

async function submit() {
  if (!form.value.label.trim()) {
    toast.error('Укажи название');
    return;
  }
  let credentials: Record<string, unknown>;
  try {
    if (form.value.type === 'CLOUDFLARE') {
      if (!form.value.cfToken) throw new Error('Укажи API Token');
      credentials = { apiToken: form.value.cfToken };
    } else if (form.value.type === 'YANDEX_CLOUD') {
      if (!form.value.ycKeyJson.trim()) throw new Error('Вставь Service Account Key JSON');
      const parsed = JSON.parse(form.value.ycKeyJson);
      credentials = { serviceAccountKey: parsed };
      if (!form.value.scopeId.trim()) throw new Error('Folder ID обязателен');
    } else if (form.value.type === 'YANDEX_360') {
      if (!form.value.y360ClientId.trim()) throw new Error('Укажи Client ID');
      if (!form.value.y360ClientSecret.trim()) throw new Error('Укажи Client Secret');
      if (!form.value.y360Code.trim()) throw new Error('Укажи Authorization Code');
      // Org ID опциональный — пусто = синкать все организации
      credentials = {
        clientId: form.value.y360ClientId.trim(),
        clientSecret: form.value.y360ClientSecret.trim(),
        code: form.value.y360Code.trim(),
      };
    } else {
      if (!form.value.vkAppId || !form.value.vkAppSecret) throw new Error('Укажи app credential');
      credentials = {
        appCredentialId: form.value.vkAppId,
        appCredentialSecret: form.value.vkAppSecret,
      };
    }
  } catch (e) {
    toast.error((e as Error).message || 'Невалидные данные');
    return;
  }

  submitting.value = true;
  try {
    const body: Record<string, unknown> = {
      type: form.value.type,
      label: form.value.label.trim(),
      credentials,
    };
    if (form.value.scopeId.trim()) body.scopeId = form.value.scopeId.trim();
    if (form.value.apiBaseUrl.trim()) body.apiBaseUrl = form.value.apiBaseUrl.trim();
    await api.post<Provider>('/dns/providers', body);
    toast.success('Провайдер подключён');
    modalOpen.value = false;
    await load();
  } catch (e) {
    toast.error((e as Error).message || 'Ошибка подключения');
  } finally {
    submitting.value = false;
  }
}

async function testProvider(id: string) {
  busyId.value = id;
  try {
    const res = await api.post<{ ok: boolean; error?: string }>(`/dns/providers/${id}/test`);
    if (res.ok) toast.success('Проверка пройдена');
    else toast.error(res.error || 'Не удалось');
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  } finally { busyId.value = null; }
}

async function syncProvider(id: string) {
  busyId.value = id;
  try {
    const res = await api.post<{ added: number; removed: number; total: number }>(`/dns/providers/${id}/sync`);
    toast.success(`Sync: +${res.added} −${res.removed} (всего ${res.total})`);
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  } finally { busyId.value = null; }
}

async function deleteProvider(id: string) {
  const p = providers.value.find((x) => x.id === id);
  const zCount = p?.zonesCount || 0;
  const ok = await confirm.ask({
    title: 'Удалить провайдера?',
    message: `Будут удалены ${zCount} зон(ы) и кеш записей. Сами зоны у провайдера останутся.`,
    danger: true,
    confirmText: 'Удалить',
  });
  if (!ok) return;
  busyId.value = id;
  try {
    await api.del(`/dns/providers/${id}`);
    toast.success('Удалено');
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  } finally { busyId.value = null; }
}

function handleEsc(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  if (modalOpen.value) { modalOpen.value = false; e.preventDefault(); }
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
.dns-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 1.5rem; gap: 1rem; }
.dns-back { font-size: 0.78rem; color: var(--text-muted); text-decoration: none; }
.dns-back:hover { color: var(--text-secondary); }
.dns-title { font-size: 1.5rem; font-weight: 700; color: var(--text-heading); margin: 0.25rem 0 0; }
.dns-subtitle { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.15rem; }

.btn {
  display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.45rem 0.85rem;
  border-radius: 10px; border: 1px solid var(--border-secondary); background: var(--bg-surface);
  color: var(--text-tertiary); font-size: 0.78rem; font-weight: 500;
  font-family: inherit; cursor: pointer; transition: all 0.2s;
}
.btn:hover:not(:disabled) { border-color: var(--primary-border); color: var(--primary-text); background: var(--primary-bg); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn--primary { background: linear-gradient(135deg, var(--primary), var(--primary-dark)); color: #fff; border-color: transparent; }
.btn--small { padding: 0.25rem 0.6rem; font-size: 0.72rem; border-radius: 6px; }

.dns-empty { padding: 3rem; text-align: center; color: var(--text-faint); background: var(--bg-surface); border-radius: 14px; }

.dns-providers { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 1rem; }

.provider-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 14px; padding: 1rem; }
.provider-card__head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; gap: 0.5rem; flex-wrap: wrap; }
.provider-card__title { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.provider-card__label { font-weight: 600; color: var(--text-heading); }
.provider-card__actions { display: flex; gap: 0.3rem; }
.provider-card__body { display: flex; flex-direction: column; gap: 0.3rem; }
.provider-card__err { font-size: 0.72rem; color: #ef4444; padding: 0.3rem 0.5rem; background: rgba(239, 68, 68, 0.1); border-radius: 6px; }
.provider-card__creds { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.4rem; }
.cred-pill { font-family: 'JetBrains Mono', monospace; font-size: 0.65rem; color: var(--text-muted); padding: 0.1rem 0.4rem; background: var(--bg-elevated); border-radius: 4px; }

.kv { display: flex; gap: 0.4rem; font-size: 0.78rem; }
.kv__k { color: var(--text-muted); }
.kv__v { color: var(--text-secondary); font-family: 'JetBrains Mono', monospace; }

.dns-badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 6px; font-size: 0.65rem; font-weight: 600; text-transform: uppercase; }
.dns-badge--cloudflare { background: rgba(244, 129, 32, 0.15); color: #f48120; }
.dns-badge--yandex_cloud { background: rgba(255, 196, 0, 0.15); color: #ffc400; }
.dns-badge--yandex_360 { background: rgba(255, 0, 0, 0.12); color: #ff3333; }
.dns-badge--vk_cloud { background: rgba(0, 119, 255, 0.15); color: #0077ff; }
.dns-status { padding: 0.1rem 0.45rem; border-radius: 4px; font-size: 0.65rem; }
.dns-status--unauthorized, .dns-status--error { background: rgba(239, 68, 68, 0.12); color: #ef4444; }

/* Modal */
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 14px; padding: 1.5rem; width: 90%; max-width: 520px; max-height: 90vh; overflow-y: auto; }
.modal__title { font-size: 1.1rem; font-weight: 700; margin: 0 0 1rem; color: var(--text-heading); }
.form { display: flex; flex-direction: column; gap: 0.85rem; }
.field { display: flex; flex-direction: column; gap: 0.3rem; }
.field__label { font-size: 0.72rem; color: var(--text-muted); font-weight: 500; }
.dns-input { padding: 0.45rem 0.7rem; border-radius: 8px; border: 1px solid var(--border-secondary); background: var(--bg-elevated); color: var(--text-secondary); font-size: 0.8rem; font-family: inherit; }
.dns-input--textarea { font-family: 'JetBrains Mono', monospace; font-size: 0.7rem; resize: vertical; min-height: 100px; }
.dns-input:focus { outline: none; border-color: var(--primary); }
.form__actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 0.5rem; }

.dns-help {
  border-radius: 10px;
  padding: 0.75rem 0.9rem;
  font-size: 0.75rem;
  line-height: 1.5;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-secondary);
}
.dns-help[data-type="CLOUDFLARE"] { border-left: 3px solid #f48120; }
.dns-help[data-type="YANDEX_CLOUD"] { border-left: 3px solid #ffc400; }
.dns-help[data-type="YANDEX_360"] { border-left: 3px solid #ff3333; }
.dns-help[data-type="VK_CLOUD"] { border-left: 3px solid #0077ff; }
.dns-help__title { font-weight: 600; color: var(--text-heading); margin-bottom: 0.4rem; font-size: 0.78rem; }
.dns-help__list { margin: 0; padding-left: 1.1rem; display: flex; flex-direction: column; gap: 0.25rem; }
.dns-help__list li { color: var(--text-tertiary); }
.dns-help__sublist { margin: 0.25rem 0 0; padding-left: 1.1rem; list-style: disc; display: flex; flex-direction: column; gap: 0.15rem; }
.dns-help__sublist li { color: var(--text-tertiary); font-size: 0.72rem; }
.dns-help__list code { font-family: 'JetBrains Mono', monospace; font-size: 0.7rem; padding: 0.05rem 0.3rem; background: var(--bg-surface); border: 1px solid var(--border-secondary); border-radius: 4px; color: var(--text-secondary); }
.dns-help__list a { color: var(--primary); text-decoration: none; }
.dns-help__list a:hover { text-decoration: underline; }
.dns-help__note { margin-top: 0.5rem; font-size: 0.7rem; color: var(--text-muted); font-style: italic; }
</style>
