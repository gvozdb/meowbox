<template>
  <div class="page">
    <header class="header">
      <div>
        <h1 class="title">Бэкапы данных панели</h1>
        <p class="subtitle">БД (через VACUUM INTO), master-key, .env, vpn state, /etc/letsencrypt. Пути зашиты — менять нельзя, защита от ошибок.</p>
      </div>
      <div class="header-actions">
        <NuxtLink to="/backups" class="btn btn-ghost">← К бэкапам сайтов</NuxtLink>
        <NuxtLink to="/backups-server" class="btn btn-ghost">← Бэкапы серверных путей</NuxtLink>
        <button class="btn btn-primary" @click="openCreate()">+ Создать конфиг</button>
      </div>
    </header>

    <details class="info-box">
      <summary><b>Что попадёт в бэкап</b> (preset, нельзя менять)</summary>
      <ul>
        <li><code>state/data/meowbox.db</code> — снапшот БД (через VACUUM INTO, consistent)</li>
        <li><code>state/data/.master-key</code> + legacy <code>.vpn-key</code>, <code>.dns-key</code></li>
        <li><code>state/.env</code> — переменные окружения панели</li>
        <li><code>state/data/servers.json</code></li>
        <li><code>state/vpn/</code> — Xray runtime configs</li>
        <li><code>/etc/letsencrypt/</code> — SSL сертификаты Let's Encrypt</li>
      </ul>
      <p class="muted">Восстановление — только через CLI <code>tools/restore-panel-data.sh</code> (UI кнопки нет, нельзя рестарт через UI который сам себя останавливает).</p>
    </details>

    <div v-if="loading" class="muted">Загрузка...</div>
    <div v-else-if="!configs.length" class="empty">
      <p>Конфигов нет. Создай как минимум один — бэкап данных панели критически важен.</p>
    </div>

    <table v-else class="tbl">
      <thead>
        <tr>
          <th>Имя</th>
          <th>Cron</th>
          <th>Движок</th>
          <th>Хранилища</th>
          <th>Retention</th>
          <th>Статус</th>
          <th>Действия</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="c in configs" :key="c.id">
          <td><b>{{ c.name }}</b></td>
          <td><code>{{ c.schedule || '—' }}</code></td>
          <td>{{ c.engine }}</td>
          <td>{{ c.storageLocationIds.length }} шт.</td>
          <td><small>{{ c.keepDaily }}d / {{ c.keepWeekly }}w / {{ c.keepMonthly }}m / {{ c.keepYearly }}y</small></td>
          <td>
            <span :class="['badge', c.enabled ? 'badge-ok' : 'badge-off']">{{ c.enabled ? 'enabled' : 'disabled' }}</span>
          </td>
          <td class="row-actions">
            <button class="btn-sm" :disabled="running[c.id]" @click="runConfig(c)">{{ running[c.id] ? '...' : 'Запустить' }}</button>
            <button class="btn-sm" @click="openEdit(c)">Edit</button>
            <button class="btn-sm btn-danger" @click="deleteConfig(c)">Удалить</button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="modal.open" class="modal-overlay" @mousedown.self="closeModal">
      <div class="modal">
        <h2>{{ modal.editId ? 'Редактирование' : 'Новый конфиг бэкапа данных панели' }}</h2>
        <form @submit.prevent="submitModal">
          <label>Имя <input v-model="modal.form.name" required maxlength="120" placeholder="panel-hourly" /></label>

          <label>
            Движок
            <select v-model="modal.form.engine">
              <option value="RESTIC">RESTIC (рекомендуется — дедупликация при частых снапах)</option>
              <option value="TAR">TAR (.tar.gz)</option>
            </select>
          </label>

          <label>
            Хранилища (выбери одно или несколько — бэкап летит в каждое)
            <select v-model="modal.form.storageLocationIds" multiple size="5">
              <option v-for="s in storages" :key="s.id" :value="s.id">{{ s.name }} ({{ s.type }})</option>
            </select>
          </label>

          <label>
            Cron (опционально)
            <input v-model="modal.form.schedule" placeholder="0 * * * * (каждый час)" />
          </label>

          <div class="grid-2">
            <label>Daily<input v-model.number="modal.form.keepDaily" type="number" min="0" max="365" /></label>
            <label>Weekly<input v-model.number="modal.form.keepWeekly" type="number" min="0" max="52" /></label>
            <label>Monthly<input v-model.number="modal.form.keepMonthly" type="number" min="0" max="60" /></label>
            <label>Yearly<input v-model.number="modal.form.keepYearly" type="number" min="0" max="20" /></label>
          </div>

          <label>
            <input v-model="modal.form.enabled" type="checkbox" />
            Включён
          </label>

          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" @click="closeModal">Отмена</button>
            <button type="submit" class="btn btn-primary" :disabled="submitting">{{ modal.editId ? 'Сохранить' : 'Создать' }}</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';

definePageMeta({ middleware: ['auth'] });

interface PanelDataConfig {
  id: string;
  name: string;
  engine: 'RESTIC' | 'TAR';
  storageLocationIds: string[];
  schedule: string | null;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
  keepYearly: number;
  enabled: boolean;
}

interface StorageLoc { id: string; name: string; type: string }

const api = useApi();
const configs = ref<PanelDataConfig[]>([]);
const storages = ref<StorageLoc[]>([]);
const loading = ref(true);
const running = ref<Record<string, boolean>>({});
const submitting = ref(false);

const modal = reactive({
  open: false,
  editId: null as string | null,
  form: {
    name: '',
    engine: 'RESTIC' as 'RESTIC' | 'TAR',
    storageLocationIds: [] as string[],
    schedule: '',
    keepDaily: 24,
    keepWeekly: 7,
    keepMonthly: 12,
    keepYearly: 5,
    enabled: true,
  },
});

async function load() {
  loading.value = true;
  try {
    const [cfgRes, stRes] = await Promise.all([
      api.get<{ data: PanelDataConfig[] }>('/backups/panel-data'),
      api.get<{ data: StorageLoc[] }>('/storage-locations'),
    ]);
    configs.value = cfgRes.data;
    storages.value = stRes.data;
  } catch (e) {
    console.error(e);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  modal.editId = null;
  modal.form = { name: '', engine: 'RESTIC', storageLocationIds: [], schedule: '', keepDaily: 24, keepWeekly: 7, keepMonthly: 12, keepYearly: 5, enabled: true };
  modal.open = true;
}

function openEdit(c: PanelDataConfig) {
  modal.editId = c.id;
  modal.form = {
    name: c.name,
    engine: c.engine,
    storageLocationIds: [...c.storageLocationIds],
    schedule: c.schedule || '',
    keepDaily: c.keepDaily,
    keepWeekly: c.keepWeekly,
    keepMonthly: c.keepMonthly,
    keepYearly: c.keepYearly,
    enabled: c.enabled,
  };
  modal.open = true;
}

function closeModal() { modal.open = false; }

async function submitModal() {
  submitting.value = true;
  try {
    const body = {
      name: modal.form.name,
      engine: modal.form.engine,
      storageLocationIds: modal.form.storageLocationIds,
      schedule: modal.form.schedule || undefined,
      keepDaily: modal.form.keepDaily,
      keepWeekly: modal.form.keepWeekly,
      keepMonthly: modal.form.keepMonthly,
      keepYearly: modal.form.keepYearly,
      enabled: modal.form.enabled,
    };
    if (modal.editId) {
      await api.patch(`/backups/panel-data/${modal.editId}`, body);
    } else {
      await api.post('/backups/panel-data', body);
    }
    modal.open = false;
    await load();
  } catch (e: unknown) {
    const msg = (e as { data?: { error?: { message?: string } } })?.data?.error?.message || (e as Error).message;
    alert(`Ошибка: ${msg}`);
  } finally {
    submitting.value = false;
  }
}

async function runConfig(c: PanelDataConfig) {
  running.value[c.id] = true;
  try {
    await api.post(`/backups/panel-data/${c.id}/run`);
    alert(`Бэкап "${c.name}" запущен.`);
  } catch (e: unknown) {
    const msg = (e as { data?: { error?: { message?: string } } })?.data?.error?.message || (e as Error).message;
    alert(`Ошибка запуска: ${msg}`);
  } finally {
    running.value[c.id] = false;
  }
}

async function deleteConfig(c: PanelDataConfig) {
  if (!confirm(`Удалить конфиг "${c.name}"? История запусков тоже удалится.`)) return;
  try {
    await api.delete(`/backups/panel-data/${c.id}`);
    await load();
  } catch (e) {
    alert(`Ошибка: ${(e as Error).message}`);
  }
}

onMounted(load);
</script>

<style scoped>
.page { padding: 1.5rem; max-width: 1400px; margin: 0 auto; }
.header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1.5rem; gap: 1rem; }
.header-actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.title { font-size: 1.4rem; margin: 0; }
.subtitle { margin: 0.25rem 0 0; color: #888; font-size: 0.9rem; }
.info-box { background: #f6f9ff; border: 1px solid #c6d6ff; padding: 0.8rem 1rem; border-radius: 0.5rem; margin: 1rem 0; font-size: 0.9rem; }
.info-box summary { cursor: pointer; }
.info-box ul { margin: 0.5rem 0; padding-left: 1.2rem; }
.muted { color: #888; }
.empty { padding: 2rem; text-align: center; border: 1px dashed #ddd; border-radius: 0.5rem; }
.tbl { width: 100%; border-collapse: collapse; margin-top: 1rem; }
.tbl th, .tbl td { padding: 0.6rem 0.8rem; border-bottom: 1px solid #eee; text-align: left; font-size: 0.9rem; }
.tbl th { background: #fafafa; font-weight: 600; }
.badge { padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.75rem; }
.badge-ok { background: #d4f7d4; color: #2a5; }
.badge-off { background: #eee; color: #888; }
.btn, .btn-sm { padding: 0.5rem 0.9rem; border: 1px solid #ccc; border-radius: 0.4rem; background: #fff; cursor: pointer; font-size: 0.85rem; }
.btn-sm { padding: 0.35rem 0.6rem; font-size: 0.8rem; }
.btn-primary { background: #2a5; color: #fff; border-color: #2a5; }
.btn-ghost { background: transparent; }
.btn-danger { color: #c33; }
.row-actions { display: flex; gap: 0.4rem; }
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: #fff; padding: 1.5rem; border-radius: 0.6rem; min-width: 480px; max-width: 90vw; max-height: 90vh; overflow-y: auto; }
.modal h2 { margin: 0 0 1rem; font-size: 1.1rem; }
.modal label { display: block; margin: 0.7rem 0; font-size: 0.9rem; }
.modal label input, .modal label select { display: block; width: 100%; margin-top: 0.3rem; padding: 0.4rem; border: 1px solid #ccc; border-radius: 0.3rem; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
.modal-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; }
</style>
