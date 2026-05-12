<template>
  <div class="backups">
    <div class="backups__header">
      <div>
        <h1 class="backups__title">Хранилища бэкапов</h1>
        <p class="backups__subtitle">Куда складываются архивы и Restic-репы</p>
      </div>
      <div class="header-actions">
        <NuxtLink to="/backups" class="backups__refresh" style="text-decoration:none;">← К бэкапам</NuxtLink>
        <button class="backups__refresh" :disabled="loading" @click="load">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" :class="{ spinning: loading }"><polyline points="23,4 23,10 17,10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
          Обновить
        </button>
        <button class="btn btn--primary btn--sm" @click="openStorageDialog(null)">+ Добавить</button>
      </div>
    </div>

    <div class="settings-card">
      <p class="section-hint">
        Места, куда можно сохранять бэкапы. Одно хранилище = одна строка здесь.
        Движок <b>Restic</b> поддерживают только типы <b>LOCAL</b>, <b>S3</b> и <b>SFTP</b>.
      </p>

      <div v-if="loading" class="empty-card empty-card--flush">Загрузка…</div>
      <div v-else-if="locations.length === 0" class="empty-card empty-card--flush">
        <p>Ещё нет ни одного хранилища</p>
      </div>

      <table v-else class="storage-table">
        <thead>
          <tr>
            <th>Имя</th>
            <th>Тип</th>
            <th>Restic</th>
            <th>Создано</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="loc in locations" :key="loc.id">
            <td>{{ loc.name }}</td>
            <td><span class="cfg-badge">{{ loc.type }}</span></td>
            <td>
              <span v-if="loc.resticEnabled" class="cfg-badge cfg-badge--ok">Да</span>
              <span v-else class="cfg-badge cfg-badge--muted">Нет</span>
            </td>
            <td>{{ formatDate(loc.createdAt) }}</td>
            <td class="actions-cell">
              <button class="link-btn" @click="testStorage(loc)">Тест</button>
              <button class="link-btn" @click="openStorageDialog(loc)">Изменить</button>
              <button class="link-btn link-btn--danger" @click="deleteStorage(loc)">Удалить</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Storage Location Modal -->
    <Teleport to="body">
      <div v-if="dialog.open" class="modal-overlay" @mousedown.self="dialog.open = false">
        <div class="modal modal--wide">
          <h3 class="modal__title">{{ dialog.editing ? 'Редактировать хранилище' : 'Новое хранилище' }}</h3>
          <div class="modal__fields">
            <div class="form-group">
              <label class="form-label">Имя</label>
              <input v-model="dialog.form.name" class="form-input" placeholder="Мой S3 / Yandex backup" />
            </div>

            <div class="form-group">
              <label class="form-label">Тип</label>
              <select v-model="dialog.form.type" class="form-input form-input--select" :disabled="!!dialog.editing">
                <option value="LOCAL">Локально (диск сервера)</option>
                <option value="S3">S3 / S3-совместимое</option>
                <option value="SFTP">SFTP (Restic)</option>
                <option value="YANDEX_DISK">Яндекс.Диск (только TAR)</option>
                <option value="CLOUD_MAIL_RU">Облако Mail.ru (только TAR)</option>
              </select>
            </div>

            <template v-if="dialog.form.type === 'LOCAL'">
              <div class="form-group">
                <label class="form-label">Путь (опционально)</label>
                <input v-model="dialog.form.config.remotePath" class="form-input mono" placeholder="/var/meowbox/backups (по умолчанию)" />
              </div>
            </template>

            <template v-if="dialog.form.type === 'S3'">
              <div class="form-group"><label class="form-label">Bucket</label>
                <input v-model="dialog.form.config.bucket" class="form-input" placeholder="my-backup-bucket" />
              </div>
              <div class="form-group"><label class="form-label">Endpoint</label>
                <input v-model="dialog.form.config.endpoint" class="form-input mono" placeholder="https://s3.amazonaws.com" />
                <span class="form-hint">
                  AWS: <code>https://s3.amazonaws.com</code> · Yandex: <code>https://storage.yandexcloud.net</code>
                </span>
              </div>
              <div class="form-group"><label class="form-label">Region</label>
                <input v-model="dialog.form.config.region" class="form-input mono" placeholder="us-east-1" />
              </div>
              <div class="form-group"><label class="form-label">Access Key</label>
                <input v-model="dialog.form.config.accessKey" class="form-input mono" />
              </div>
              <div class="form-group"><label class="form-label">Secret Key</label>
                <input v-model="dialog.form.config.secretKey" type="password" class="form-input mono" />
              </div>
              <div class="form-group"><label class="form-label">Prefix (опционально)</label>
                <input v-model="dialog.form.config.prefix" class="form-input mono" placeholder="meowbox" />
              </div>
            </template>

            <template v-if="dialog.form.type === 'SFTP'">
              <div class="form-group"><label class="form-label">Хост</label>
                <input v-model="dialog.form.config.sftpHost" class="form-input mono" placeholder="backups.example.com" />
              </div>
              <div class="form-group"><label class="form-label">Порт</label>
                <input v-model="dialog.form.config.sftpPort" class="form-input mono" placeholder="22" />
              </div>
              <div class="form-group"><label class="form-label">Username</label>
                <input v-model="dialog.form.config.sftpUsername" class="form-input mono" placeholder="backup" />
              </div>
              <div class="form-group"><label class="form-label">Путь</label>
                <input v-model="dialog.form.config.sftpPath" class="form-input mono" placeholder="/home/backup/restic" />
              </div>
              <div class="form-group"><label class="form-label">Способ авторизации</label>
                <select v-model="dialog.form.config.sftpAuthMode" class="form-input form-input--select">
                  <option value="KEY">SSH-ключ (рекомендовано)</option>
                  <option value="PASSWORD">Пароль</option>
                </select>
              </div>
              <template v-if="(dialog.form.config.sftpAuthMode || 'KEY') === 'KEY'">
                <div class="form-group"><label class="form-label">SSH приватный ключ</label>
                  <textarea v-model="dialog.form.config.sftpPrivateKey" class="form-input mono" rows="6"
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"></textarea>
                </div>
                <div class="form-group"><label class="form-label">Пасфраза ключа (опц.)</label>
                  <input v-model="dialog.form.config.sftpPassphrase" type="password" class="form-input mono" autocomplete="new-password" />
                </div>
              </template>
              <template v-else>
                <div class="form-group"><label class="form-label">Пароль SSH</label>
                  <input v-model="dialog.form.config.sftpPassword" type="password" class="form-input mono" autocomplete="new-password" placeholder="••••••••" />
                </div>
              </template>
            </template>

            <template v-if="dialog.form.type === 'YANDEX_DISK'">
              <div class="form-group"><label class="form-label">OAuth токен</label>
                <input v-model="dialog.form.config.oauthToken" type="password" class="form-input mono" />
              </div>
              <div class="form-group"><label class="form-label">Путь на Диске</label>
                <input v-model="dialog.form.config.remotePath" class="form-input mono" placeholder="/meowbox-backups" />
              </div>
            </template>

            <template v-if="dialog.form.type === 'CLOUD_MAIL_RU'">
              <div class="form-group"><label class="form-label">Email (Mail.ru)</label>
                <input v-model="dialog.form.config.username" class="form-input" />
              </div>
              <div class="form-group"><label class="form-label">Пароль приложения</label>
                <input v-model="dialog.form.config.password" type="password" class="form-input mono" />
              </div>
              <div class="form-group"><label class="form-label">Путь в облаке</label>
                <input v-model="dialog.form.config.remotePath" class="form-input mono" placeholder="/meowbox-backups" />
              </div>
            </template>

            <template v-if="!dialog.editing && (dialog.form.type === 'LOCAL' || dialog.form.type === 'S3' || dialog.form.type === 'SFTP')">
              <div class="form-group">
                <label class="form-label">Пароль Restic (опц.)</label>
                <input v-model="dialog.form.resticPassword" type="text" class="form-input mono" placeholder="qwerty" autocomplete="off" />
                <span class="form-hint">Если пусто — стандартный <code>qwerty</code>. После создания пароль уже не изменить.</span>
              </div>
            </template>
          </div>

          <div v-if="dialog.newPassword" class="warning-box">
            <b>Пароль Restic для этой репы:</b>
            <code class="warning-box__code">{{ dialog.newPassword }}</code>
            <p>Если потеряешь — данные в репе невосстановимы.</p>
          </div>

          <div class="modal__actions">
            <button class="btn btn--ghost" @click="dialog.open = false">
              {{ dialog.newPassword ? 'Закрыть' : 'Отмена' }}
            </button>
            <button v-if="!dialog.newPassword" class="btn btn--primary" :disabled="dialog.saving" @click="saveStorage">
              {{ dialog.saving ? 'Сохранение…' : 'Сохранить' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface StorageLocationOption {
  id: string;
  name: string;
  type: string;
  resticEnabled: boolean;
  config?: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}

const api = useApi();
const toast = useMbToast();

const locations = ref<StorageLocationOption[]>([]);
const loading = ref(false);

const dialog = reactive({
  open: false,
  editing: null as StorageLocationOption | null,
  saving: false,
  newPassword: '' as string,
  form: {
    name: '',
    type: 'S3' as 'LOCAL' | 'S3' | 'SFTP' | 'YANDEX_DISK' | 'CLOUD_MAIL_RU',
    config: {} as Record<string, string>,
    resticPassword: '' as string,
  },
});

function formatDate(iso?: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function load() {
  loading.value = true;
  try {
    const res = await api.get<{ data: StorageLocationOption[] }>('/storage-locations');
    const list = (res as unknown as { data: StorageLocationOption[] }).data
      || (res as unknown as StorageLocationOption[]);
    locations.value = Array.isArray(list) ? list : [];
  } catch (e) {
    toast.error((e as Error).message || 'Не удалось загрузить хранилища');
  } finally {
    loading.value = false;
  }
}

function openStorageDialog(loc: StorageLocationOption | null) {
  dialog.newPassword = '';
  dialog.editing = loc;
  if (loc) {
    dialog.form.name = loc.name;
    dialog.form.type = loc.type as typeof dialog.form.type;
    dialog.form.config = { ...((loc as unknown as { config?: Record<string, string> }).config || {}) };
    dialog.form.resticPassword = '';
  } else {
    dialog.form.name = '';
    dialog.form.type = 'S3';
    dialog.form.config = {};
    dialog.form.resticPassword = '';
  }
  if (dialog.form.type === 'SFTP' && !dialog.form.config.sftpAuthMode) {
    dialog.form.config.sftpAuthMode = 'KEY';
  }
  dialog.open = true;
}

watch(() => dialog.form.type, (t) => {
  if (t === 'SFTP' && !dialog.form.config.sftpAuthMode) {
    dialog.form.config.sftpAuthMode = 'KEY';
  }
});

async function saveStorage() {
  dialog.saving = true;
  try {
    if (dialog.editing) {
      const cleanCfg: Record<string, string> = {};
      for (const [k, v] of Object.entries(dialog.form.config || {})) {
        if (v && v !== '***') cleanCfg[k] = v;
      }
      await api.patch(`/storage-locations/${dialog.editing.id}`, {
        name: dialog.form.name,
        config: cleanCfg,
      });
      toast.success('Хранилище обновлено');
      await load();
      dialog.open = false;
    } else {
      const resticSupported = dialog.form.type === 'LOCAL' || dialog.form.type === 'S3' || dialog.form.type === 'SFTP';
      const payload: Record<string, unknown> = {
        name: dialog.form.name,
        type: dialog.form.type,
        config: dialog.form.config,
      };
      if (resticSupported && dialog.form.resticPassword.trim()) {
        payload.resticPassword = dialog.form.resticPassword.trim();
      }
      const res = await api.post<{ location: StorageLocationOption; resticPassword?: string }>(
        '/storage-locations',
        payload,
      );
      await load();
      if (res?.resticPassword) {
        dialog.newPassword = res.resticPassword;
      } else {
        dialog.open = false;
      }
      toast.success('Хранилище создано');
    }
  } catch (e) {
    toast.error((e as Error)?.message || 'Не удалось сохранить');
  } finally {
    dialog.saving = false;
  }
}

async function deleteStorage(loc: StorageLocationOption) {
  const ok = await useMbConfirm().ask({
    title: 'Удаление хранилища',
    message: `Удалить хранилище "${loc.name}"?`,
    confirmText: 'Удалить',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/storage-locations/${loc.id}`);
    await load();
    toast.success('Хранилище удалено');
  } catch (e) {
    toast.error((e as Error)?.message || 'Не удалось удалить');
  }
}

async function testStorage(loc: StorageLocationOption) {
  toast.info(`Проверяю ${loc.name}…`);
  try {
    const res = await api.post<{ success: boolean; error?: string }>(
      `/storage-locations/${loc.id}/test?siteName=_connection-test_`,
      {},
    );
    if (res.success) toast.success(`${loc.name}: доступ есть`);
    else toast.error(`${loc.name}: ${res.error || 'ошибка'}`);
  } catch (e) {
    toast.error((e as Error)?.message || 'Не удалось протестировать');
  }
}

onMounted(load);
</script>

<style scoped>
.backups { padding: 1.5rem; max-width: 1400px; margin: 0 auto; }
.backups__header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 1.5rem; gap: 1rem; flex-wrap: wrap; }
.backups__title { font-size: 1.5rem; font-weight: 700; color: var(--text-heading); margin: 0; }
.backups__subtitle { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.15rem; }
.header-actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }

.backups__refresh {
  display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.45rem 0.85rem;
  border-radius: 10px; border: 1px solid var(--border-secondary);
  background: var(--bg-surface); color: var(--text-tertiary);
  font-size: 0.78rem; font-weight: 500; font-family: inherit; cursor: pointer; transition: all 0.2s;
}
.backups__refresh:hover { border-color: var(--primary-border); color: var(--primary-text); background: var(--primary-bg); }
.backups__refresh:disabled { opacity: 0.5; cursor: not-allowed; }
.spinning { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.settings-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  padding: 1.25rem;
}
.section-hint { font-size: 0.8rem; color: var(--text-muted); margin: 0 0 1rem; line-height: 1.5; }
.empty-card { display: flex; flex-direction: column; align-items: center; padding: 2rem 1rem; color: var(--text-muted); font-size: 0.85rem; }
.empty-card--flush { border: none; background: transparent; }

.form-group { display: flex; flex-direction: column; gap: 0.3rem; }
.form-label { font-size: 0.75rem; font-weight: 500; color: var(--text-tertiary); }
.form-input {
  background: var(--bg-input); border: 1px solid var(--border-secondary);
  border-radius: 10px; padding: 0.55rem 0.8rem; font-size: 0.85rem;
  color: var(--text-primary); font-family: inherit; outline: none; transition: all 0.2s;
}
.form-input:focus { border-color: rgba(var(--primary-rgb), 0.25); box-shadow: var(--focus-ring); }
.form-input--select {
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23666' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 0.75rem center; padding-right: 2rem;
}
.form-hint { font-size: 0.7rem; color: var(--text-faint); }
.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; }

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

.modal-overlay {
  position: fixed; inset: 0; background: var(--bg-overlay); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center; z-index: 200; padding: 1rem;
}
.modal {
  background: var(--bg-modal-gradient);
  border: 1px solid var(--border-secondary); border-radius: 18px; padding: 1.5rem;
  width: 100%; max-width: 480px; box-shadow: var(--shadow-modal);
  animation: modalIn 0.25s ease; max-height: 90vh; overflow-y: auto;
  color: var(--text-primary);
}
.modal--wide { max-width: 620px; }
.modal__title { font-size: 1.05rem; font-weight: 700; color: var(--text-heading); margin: 0 0 1rem; }
.modal__fields { display: flex; flex-direction: column; gap: 0.85rem; margin-bottom: 1rem; }
.modal__actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
@keyframes modalIn { from { opacity: 0; transform: scale(0.96) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }

.storage-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  margin-top: 0.5rem;
  background: var(--bg-input);
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--border);
}
.storage-table th, .storage-table td {
  padding: 0.7rem 0.9rem;
  text-align: left;
  border-bottom: 1px solid var(--border);
  font-size: 0.88rem;
  color: var(--text-primary);
}
.storage-table tbody tr:last-child td { border-bottom: none; }
.storage-table tbody tr:hover { background: var(--bg-surface); }
.storage-table th {
  font-weight: 600; color: var(--text-tertiary);
  text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.06em;
  background: var(--bg-surface);
}
.cfg-badge {
  display: inline-block; padding: 0.08rem 0.5rem;
  border-radius: 999px; background: var(--primary-bg, rgba(var(--primary-rgb), 0.12));
  color: var(--primary-text, var(--primary)); font-size: 0.72rem; font-weight: 500;
}
.cfg-badge--muted { background: var(--bg-input); color: var(--text-tertiary); }
.cfg-badge--ok { background: var(--success-bg, rgba(34,197,94,0.12)); color: var(--success, #22c55e); }
.actions-cell { white-space: nowrap; display: flex; gap: 0.75rem; }
.link-btn {
  background: none; border: none; color: var(--primary-text, var(--primary));
  cursor: pointer; padding: 0; font-size: 0.85rem;
}
.link-btn:hover { text-decoration: underline; }
.link-btn--danger { color: var(--danger, #ef4444); }

.warning-box {
  background: var(--danger-bg, rgba(239,68,68,0.08));
  border: 1px solid var(--danger-border, rgba(239,68,68,0.3));
  border-radius: 8px; padding: 1rem; margin-top: 1rem;
  color: var(--text-primary); font-size: 0.9rem;
}
.warning-box__code {
  display: block; background: var(--bg-code);
  padding: 0.5rem; border-radius: 6px; margin: 0.5rem 0;
  font-family: monospace; word-break: break-all; user-select: all; color: var(--text-primary);
}
</style>
