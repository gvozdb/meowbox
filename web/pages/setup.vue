<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-card__mascot">
        <CatMascot :size="100" mood="happy" />
      </div>

      <div class="login-card__brand">
        <h1 class="login-card__title">Добро пожаловать в Meowbox!</h1>
        <p class="login-card__subtitle">Создайте аккаунт администратора</p>
      </div>

      <div class="login-card__divider">
        <span class="login-card__divider-line" />
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" class="login-card__divider-icon">
          <ellipse cx="12" cy="16" rx="5" ry="4.5" />
          <circle cx="7" cy="9" r="2.5" />
          <circle cx="17" cy="9" r="2.5" />
          <circle cx="4" cy="13" r="2" />
          <circle cx="20" cy="13" r="2" />
        </svg>
        <span class="login-card__divider-line" />
      </div>

      <form class="login-form" @submit.prevent="handleSetup">
        <div class="login-form__field">
          <label class="login-form__label" for="username">Имя пользователя</label>
          <div class="login-form__input-wrap" :class="{ 'login-form__input-wrap--focus': focusedField === 'username' }">
            <svg class="login-form__input-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21v-1a6 6 0 0 1 12 0v1" />
            </svg>
            <input
              id="username"
              v-model="form.username"
              type="text"
              class="login-form__input"
              placeholder="admin"
              autocomplete="username"
              required
              @focus="focusedField = 'username'"
              @blur="focusedField = ''"
            />
          </div>
        </div>

        <div class="login-form__field">
          <label class="login-form__label" for="email">Email</label>
          <div class="login-form__input-wrap" :class="{ 'login-form__input-wrap--focus': focusedField === 'email' }">
            <svg class="login-form__input-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
              <polyline points="22,6 12,13 2,6" />
            </svg>
            <input
              id="email"
              v-model="form.email"
              type="email"
              class="login-form__input"
              placeholder="admin@example.com"
              autocomplete="email"
              required
              @focus="focusedField = 'email'"
              @blur="focusedField = ''"
            />
          </div>
        </div>

        <div class="login-form__field">
          <label class="login-form__label" for="password">Пароль (мин. 12 символов)</label>
          <div class="login-form__input-wrap" :class="{ 'login-form__input-wrap--focus': focusedField === 'password' }">
            <svg class="login-form__input-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            <input
              id="password"
              v-model="form.password"
              type="password"
              class="login-form__input"
              placeholder="Надёжный пароль"
              autocomplete="new-password"
              required
              :minlength="PASSWORD_POLICY.MIN_LENGTH"
              :maxlength="PASSWORD_POLICY.MAX_LENGTH"
              @focus="focusedField = 'password'"
              @blur="focusedField = ''"
            />
          </div>
        </div>

        <Transition name="shake">
          <div v-if="error" class="login-form__error">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
            </svg>
            <span>{{ error }}</span>
          </div>
        </Transition>

        <Transition name="shake">
          <div v-if="success" class="login-form__success">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
            </svg>
            <span>Администратор создан! Перенаправление на вход...</span>
          </div>
        </Transition>

        <button
          type="submit"
          class="login-form__submit"
          :class="{ 'login-form__submit--loading': loading }"
          :disabled="loading"
        >
          <span v-if="!loading">Создать аккаунт</span>
          <span v-else class="login-form__spinner">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
          </span>
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { PASSWORD_POLICY } from '~/utils/shared-constants';

definePageMeta({ layout: 'auth' });

const form = reactive({ username: '', email: '', password: '' });
const loading = ref(false);
const error = ref('');
const success = ref(false);
const focusedField = ref('');

async function handleSetup() {
  loading.value = true;
  error.value = '';

  if (form.password.length < PASSWORD_POLICY.MIN_LENGTH) {
    error.value = `Пароль должен быть не менее ${PASSWORD_POLICY.MIN_LENGTH} символов`;
    loading.value = false;
    return;
  }
  if (form.password.length > PASSWORD_POLICY.MAX_LENGTH) {
    error.value = `Пароль слишком длинный (максимум ${PASSWORD_POLICY.MAX_LENGTH})`;
    loading.value = false;
    return;
  }

  try {
    const api = useApi();
    await api.publicPost('/setup/init', {
      username: form.username,
      email: form.email,
      password: form.password,
    });

    success.value = true;
    setTimeout(() => navigateTo('/login'), 2000);
  } catch {
    error.value = 'Не удалось создать аккаунт администратора';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&display=swap');

.login-page {
  width: 100%;
  max-width: 420px;
  font-family: 'DM Sans', sans-serif;
}

.login-card {
  background: var(--bg-login-card);
  border: 1px solid rgba(var(--primary-rgb), 0.08);
  border-radius: 24px;
  padding: 2.5rem 2rem 2rem;
  backdrop-filter: blur(20px);
  box-shadow: var(--shadow-login);
  animation: card-appear 0.8s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.login-card__mascot { display: flex; justify-content: center; margin-bottom: 0.5rem; }
.login-card__brand { text-align: center; margin-bottom: 1.5rem; }
.login-card__title { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; background: linear-gradient(135deg, var(--primary-light), var(--primary-dark)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; margin: 0; }
.login-card__subtitle { color: var(--text-muted); font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; margin-top: 0.25rem; }

.login-card__divider { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1.75rem; }
.login-card__divider-line { flex: 1; height: 1px; background: linear-gradient(90deg, transparent, rgba(var(--primary-rgb), 0.15), transparent); }
.login-card__divider-icon { color: rgba(var(--primary-rgb), 0.2); }

.login-form { display: flex; flex-direction: column; gap: 1.25rem; }
.login-form__field { animation: field-appear 0.6s cubic-bezier(0.16, 1, 0.3, 1) both; }
.login-form__field:nth-child(1) { animation-delay: 0.3s; }
.login-form__field:nth-child(2) { animation-delay: 0.4s; }
.login-form__field:nth-child(3) { animation-delay: 0.5s; }

.login-form__label { display: block; font-size: 0.75rem; font-weight: 500; color: var(--text-tertiary); letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 0.5rem; }

.login-form__input-wrap { display: flex; align-items: center; gap: 0.75rem; background: var(--bg-input); border: 1px solid var(--border-secondary); border-radius: 14px; padding: 0 1rem; transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
.login-form__input-wrap--focus { border-color: rgba(var(--primary-rgb), 0.3); background: rgba(var(--primary-rgb), 0.03); box-shadow: var(--focus-ring); }

.login-form__input-icon { color: var(--text-faint); flex-shrink: 0; transition: color 0.3s; }
.login-form__input-wrap--focus .login-form__input-icon { color: rgba(var(--primary-rgb), 0.6); }

.login-form__input { flex: 1; background: none; border: none; outline: none; color: var(--text-heading); font-family: 'DM Sans', sans-serif; font-size: 0.95rem; padding: 0.85rem 0; width: 100%; }
.login-form__input::placeholder { color: var(--text-placeholder); }

.login-form__error { display: flex; align-items: center; gap: 0.5rem; padding: 0.65rem 1rem; background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.15); border-radius: 12px; color: #fca5a5; font-size: 0.85rem; }

.login-form__success { display: flex; align-items: center; gap: 0.5rem; padding: 0.65rem 1rem; background: rgba(34, 197, 94, 0.08); border: 1px solid rgba(34, 197, 94, 0.15); border-radius: 12px; color: #86efac; font-size: 0.85rem; }

.login-form__submit { width: 100%; padding: 0.9rem; border: none; border-radius: 14px; font-family: 'DM Sans', sans-serif; font-size: 0.95rem; font-weight: 600; cursor: pointer; color: var(--primary-text-on); background: linear-gradient(135deg, var(--primary-light) 0%, var(--primary) 50%, var(--primary-dark) 100%); box-shadow: 0 2px 12px rgba(var(--primary-rgb), 0.2); transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
.login-form__submit:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 20px rgba(var(--primary-rgb), 0.3); }
.login-form__submit--loading { pointer-events: none; opacity: 0.7; }
.login-form__spinner { display: inline-flex; animation: spin 1s linear infinite; }

@keyframes card-appear { from { opacity: 0; transform: translateY(20px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
@keyframes field-appear { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.shake-enter-active { animation: shake 0.4s; }
@keyframes shake { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-6px); } 50% { transform: translateX(6px); } 75% { transform: translateX(-4px); } }

@media (max-width: 480px) {
  .login-page { max-width: 100%; }
  .login-card { padding: 2rem 1.25rem 1.5rem; border-radius: 20px; }
  .login-card__title { font-size: 1.25rem; }
}
</style>
