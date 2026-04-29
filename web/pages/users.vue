<template>
  <div class="users">
    <div class="users__header">
      <div>
        <h1 class="users__title">Профиль администратора</h1>
        <p class="users__subtitle">Панель однопользовательская — только один администратор</p>
      </div>
    </div>

    <div v-if="loading" class="loading-block">
      <div class="spinner" />
      <p>Загрузка...</p>
    </div>

    <div v-else-if="admin" class="profile-card">
      <div class="profile-card__header">
        <div class="profile-card__avatar">{{ admin.username.charAt(0).toUpperCase() }}</div>
        <div class="profile-card__info">
          <div class="profile-card__name">{{ admin.username }}</div>
          <div class="profile-card__email">{{ admin.email }}</div>
          <div class="profile-card__meta">
            <span class="role-badge role-badge--admin">{{ admin.role }}</span>
            <span class="totp-indicator" :class="admin.totpEnabled ? 'totp-indicator--on' : 'totp-indicator--off'">
              2FA: {{ admin.totpEnabled ? 'включена' : 'выключена' }}
            </span>
            <span class="muted">Создан: {{ formatDate(admin.createdAt) }}</span>
          </div>
        </div>
        <button class="btn btn--primary" @click="openEditor">Редактировать</button>
      </div>
    </div>

    <!-- Edit Modal -->
    <Teleport to="body">
      <div v-if="showEditor" class="modal-overlay" @mousedown.self="showEditor = false">
        <div class="modal">
          <h3 class="modal__title">Редактирование профиля</h3>
          <div class="modal__fields">
            <div class="form-group">
              <label class="form-label">Логин</label>
              <input v-model="editorForm.username" type="text" class="form-input" placeholder="admin" maxlength="32" />
              <span class="form-hint">3–32 символа, буквы/цифры/<code>_</code>/<code>.</code>/<code>-</code></span>
            </div>
            <div class="form-group">
              <label class="form-label">Email</label>
              <input v-model="editorForm.email" type="email" class="form-input" placeholder="admin@example.com" />
            </div>
            <div class="form-group">
              <label class="form-label">Новый пароль <span class="form-hint">(необязательно)</span></label>
              <input v-model="editorForm.password" type="password" class="form-input" placeholder="Минимум 12 символов" autocomplete="new-password" />
              <span class="form-hint">Оставь пустым, чтобы не менять</span>
            </div>
            <div class="form-group">
              <label class="form-label">Текущий пароль <span class="form-required">*</span></label>
              <input v-model="editorForm.currentPassword" type="password" class="form-input" placeholder="Для подтверждения изменений" autocomplete="current-password" />
              <span class="form-hint">Обязательно для любого изменения профиля</span>
            </div>
          </div>
          <div v-if="editorError" class="modal__error">{{ editorError }}</div>
          <div class="modal__actions">
            <button class="btn btn--ghost" @click="showEditor = false">Отмена</button>
            <button class="btn btn--primary" :disabled="saving" @click="saveUser">
              {{ saving ? 'Сохранение...' : 'Сохранить' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface User {
  id: string;
  username: string;
  email: string;
  role: string;
  totpEnabled: boolean;
  createdAt: string;
}

const api = useApi();
const admin = ref<User | null>(null);
const loading = ref(true);

const showEditor = ref(false);
const editorForm = reactive({ username: '', email: '', password: '', currentPassword: '' });
const editorError = ref('');
const saving = ref(false);

const toast = useMbToast();
function showToast(msg: string, isError = false) {
  if (isError) toast.error(msg);
  else toast.success(msg);
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function openEditor() {
  if (!admin.value) return;
  editorForm.username = admin.value.username;
  editorForm.email = admin.value.email;
  editorForm.password = '';
  editorForm.currentPassword = '';
  editorError.value = '';
  showEditor.value = true;
}

async function loadUsers() {
  loading.value = true;
  try {
    const users = await api.get<User[]>('/users');
    // Панель однопользовательская — берём первого ADMIN (если их больше, берём первого).
    admin.value = users.find((u) => u.role === 'ADMIN') || users[0] || null;
  } catch {
    admin.value = null;
  } finally {
    loading.value = false;
  }
}

async function saveUser() {
  editorError.value = '';
  if (!admin.value) return;

  if (!editorForm.currentPassword) {
    editorError.value = 'Введи текущий пароль для подтверждения';
    return;
  }
  if (!editorForm.username || editorForm.username.length < 3) {
    editorError.value = 'Логин должен быть минимум 3 символа';
    return;
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(editorForm.username)) {
    editorError.value = 'Логин может содержать только буквы, цифры, _ . -';
    return;
  }
  if (!editorForm.email) {
    editorError.value = 'Email обязателен';
    return;
  }
  if (editorForm.password && editorForm.password.length < 12) {
    editorError.value = 'Новый пароль должен быть минимум 12 символов';
    return;
  }

  saving.value = true;
  try {
    const payload: Record<string, string> = {
      username: editorForm.username,
      email: editorForm.email,
      currentPassword: editorForm.currentPassword,
    };
    if (editorForm.password) payload.password = editorForm.password;
    await api.put(`/users/${admin.value.id}`, payload);
    showToast('Профиль обновлён');
    showEditor.value = false;
    await loadUsers();
  } catch (e: unknown) {
    const err = e as { message?: string };
    editorError.value = err.message || 'Не удалось сохранить профиль';
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  loadUsers();
});
</script>

<style scoped>
.users__header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 1.5rem; }
.users__title { font-size: 1.5rem; font-weight: 700; color: var(--text-heading); margin: 0; }
.users__subtitle { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.15rem; }

.loading-block {
  display: flex; flex-direction: column; align-items: center; padding: 3rem 1rem;
  gap: 0.5rem; color: var(--text-muted); font-size: 0.85rem;
}

.spinner {
  width: 20px; height: 20px;
  border: 2px solid var(--border-secondary);
  border-top-color: var(--primary);
  border-radius: 50%; animation: spin 0.8s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

.profile-card {
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 16px; padding: 1.25rem;
}

.profile-card__header {
  display: flex; align-items: center; gap: 1rem;
}

.profile-card__avatar {
  width: 56px; height: 56px; border-radius: 14px; flex-shrink: 0;
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(217, 119, 6, 0.12));
  border: 1px solid var(--primary-border);
  display: flex; align-items: center; justify-content: center;
  font-size: 1.35rem; font-weight: 700; color: var(--primary);
}

.profile-card__info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.2rem; }
.profile-card__name { font-size: 1.1rem; font-weight: 600; color: var(--text-heading); }
.profile-card__email { font-size: 0.8rem; color: var(--text-muted); }
.profile-card__meta {
  display: flex; align-items: center; gap: 0.65rem; flex-wrap: wrap;
  margin-top: 0.4rem;
}

.role-badge {
  font-size: 0.62rem; font-weight: 600; font-family: 'JetBrains Mono', monospace;
  padding: 0.2rem 0.5rem; border-radius: 6px; letter-spacing: 0.03em;
}
.role-badge--admin { background: rgba(245, 158, 11, 0.1); color: #fbbf24; }

.totp-indicator { font-size: 0.7rem; font-weight: 500; font-family: 'JetBrains Mono', monospace; }
.totp-indicator--on { color: #4ade80; }
.totp-indicator--off { color: var(--text-faint); }

.muted { font-size: 0.72rem; color: var(--text-faint); }

/* Buttons */
.btn {
  display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.55rem 1rem;
  border-radius: 10px; border: none; font-size: 0.82rem; font-weight: 600;
  font-family: inherit; cursor: pointer; transition: all 0.2s; white-space: nowrap;
}
.btn--primary { background: linear-gradient(135deg, #fbbf24, #d97706); color: var(--primary-text-on); }
.btn--primary:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(245, 158, 11, 0.2); }
.btn--primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--ghost { background: var(--bg-input); border: 1px solid var(--border-strong); color: var(--text-tertiary); }
.btn--ghost:hover { color: var(--text-secondary); border-color: var(--border-strong); }

/* Form */
.form-group { display: flex; flex-direction: column; gap: 0.3rem; }
.form-label { font-size: 0.75rem; font-weight: 500; color: var(--text-tertiary); }
.form-required { color: var(--primary); }
.form-input {
  background: var(--bg-input); border: 1px solid var(--border-secondary);
  border-radius: 10px; padding: 0.55rem 0.8rem; font-size: 0.85rem;
  color: var(--text-primary); font-family: inherit; outline: none; transition: all 0.2s;
}
.form-input:focus { border-color: rgba(245, 158, 11, 0.25); box-shadow: var(--focus-ring); }
.form-hint { font-size: 0.68rem; color: var(--text-faint); }
.form-hint code { background: var(--bg-input); padding: 0 0.25rem; border-radius: 3px; }

/* Modal */
.modal-overlay {
  position: fixed; inset: 0; background: var(--bg-overlay); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center; z-index: 200; padding: 1rem;
}
.modal {
  background: var(--bg-modal-gradient);
  border: 1px solid var(--border-secondary); border-radius: 18px; padding: 1.5rem;
  width: 100%; max-width: 460px; box-shadow: var(--shadow-modal); animation: modalIn 0.25s ease;
}
.modal__title { font-size: 1.05rem; font-weight: 700; color: var(--text-heading); margin: 0 0 1rem; }
.modal__fields { display: flex; flex-direction: column; gap: 0.85rem; margin-bottom: 1rem; }
.modal__error { color: #f87171; font-size: 0.78rem; margin-bottom: 0.75rem; }
.modal__actions { display: flex; gap: 0.5rem; justify-content: flex-end; }

@keyframes modalIn { from { opacity: 0; transform: scale(0.96) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }

@media (max-width: 768px) {
  .users__header { flex-direction: column; gap: 0.75rem; }
  .users__title { font-size: 1.25rem; }
  .profile-card__header { flex-direction: column; align-items: flex-start; text-align: left; }
}
</style>
