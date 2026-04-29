<template>
  <div class="login-page">
    <div class="login-card">
      <!-- Cat mascot -->
      <div class="login-card__mascot">
        <CatMascot :size="100" :mood="catMood" />
      </div>

      <!-- Brand -->
      <div class="login-card__brand">
        <h1 class="login-card__title">Meowbox</h1>
        <p class="login-card__subtitle">Панель управления сервером</p>
      </div>

      <!-- Divider -->
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

      <!-- Form -->
      <form class="login-form" @submit.prevent="handleLogin">
        <div class="login-form__field">
          <label class="login-form__label" for="username">Имя пользователя</label>
          <div class="login-form__input-wrap" :class="{ 'login-form__input-wrap--focus': usernameFocused }">
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
              @focus="usernameFocused = true"
              @blur="usernameFocused = false"
            />
          </div>
        </div>

        <div class="login-form__field">
          <label class="login-form__label" for="password">Пароль</label>
          <div class="login-form__input-wrap" :class="{ 'login-form__input-wrap--focus': passwordFocused }">
            <svg class="login-form__input-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            <input
              id="password"
              v-model="form.password"
              :type="showPassword ? 'text' : 'password'"
              class="login-form__input"
              placeholder="Введите пароль"
              autocomplete="current-password"
              required
              @focus="passwordFocused = true"
              @blur="passwordFocused = false"
            />
            <button
              type="button"
              class="login-form__toggle-pw"
              @click="showPassword = !showPassword"
              tabindex="-1"
            >
              <svg v-if="!showPassword" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            </button>
          </div>
        </div>

        <!-- Error -->
        <Transition name="shake">
          <div v-if="error" class="login-form__error">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
            </svg>
            <span>{{ error }}</span>
          </div>
        </Transition>

        <!-- Submit -->
        <button
          type="submit"
          class="login-form__submit"
          :class="{ 'login-form__submit--loading': loading }"
          :disabled="loading"
        >
          <span v-if="!loading">Войти</span>
          <span v-else class="login-form__spinner">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
          </span>
        </button>
      </form>

      <!-- Footer -->
      <div class="login-card__footer">
        <span>Защищено</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z" />
        </svg>
        <span>сквозным шифрованием</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'auth' });

const authStore = useAuthStore();
const api = useApi();

const form = reactive({ username: '', password: '' });
const loading = ref(false);
const error = ref('');
const showPassword = ref(false);
const usernameFocused = ref(false);
const passwordFocused = ref(false);

onMounted(async () => {
  try {
    const status = await api.publicGet<{ needsSetup: boolean }>('/setup/status');
    if (status.needsSetup) {
      navigateTo('/setup');
    }
  } catch {
    // ignore — just show login
  }
});

const catMood = computed(() => {
  if (loading.value) return 'sleepy' as const;
  if (error.value) return 'alert' as const;
  return 'happy' as const;
});

async function handleLogin() {
  loading.value = true;
  error.value = '';

  try {
    await authStore.login(form.username, form.password);
    navigateTo('/');
  } catch {
    error.value = 'Неверное имя пользователя или пароль';
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

/* ---- Card ---- */
.login-card {
  background: var(--bg-login-card);
  border: 1px solid rgba(245, 158, 11, 0.08);
  border-radius: 24px;
  padding: 2.5rem 2rem 2rem;
  backdrop-filter: blur(20px);
  box-shadow: var(--shadow-login);
  animation: card-appear 0.8s cubic-bezier(0.16, 1, 0.3, 1) both;
}

/* ---- Mascot ---- */
.login-card__mascot {
  display: flex;
  justify-content: center;
  margin-bottom: 0.5rem;
  animation: mascot-appear 1s cubic-bezier(0.16, 1, 0.3, 1) 0.2s both;
}

/* ---- Brand ---- */
.login-card__brand {
  text-align: center;
  margin-bottom: 1.5rem;
  animation: brand-appear 0.8s cubic-bezier(0.16, 1, 0.3, 1) 0.3s both;
}

.login-card__title {
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 40%, #d97706 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  margin: 0;
  line-height: 1.2;
}

.login-card__subtitle {
  color: var(--text-muted);
  font-size: 0.8rem;
  font-weight: 400;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-top: 0.25rem;
}

/* ---- Divider ---- */
.login-card__divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1.75rem;
  animation: brand-appear 0.8s cubic-bezier(0.16, 1, 0.3, 1) 0.4s both;
}

.login-card__divider-line {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(245, 158, 11, 0.15), transparent);
}

.login-card__divider-icon {
  color: rgba(245, 158, 11, 0.2);
}

/* ---- Form ---- */
.login-form {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.login-form__field {
  animation: field-appear 0.6s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.login-form__field:nth-child(1) { animation-delay: 0.45s; }
.login-form__field:nth-child(2) { animation-delay: 0.55s; }

.login-form__label {
  display: block;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--text-tertiary);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  margin-bottom: 0.5rem;
}

.login-form__input-wrap {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: var(--bg-input);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  padding: 0 1rem;
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.login-form__input-wrap--focus {
  border-color: rgba(245, 158, 11, 0.3);
  background: rgba(245, 158, 11, 0.03);
  box-shadow: var(--focus-ring);
}

.login-form__input-icon {
  color: var(--text-faint);
  flex-shrink: 0;
  transition: color 0.3s;
}

.login-form__input-wrap--focus .login-form__input-icon {
  color: rgba(245, 158, 11, 0.6);
}

.login-form__input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: var(--text-heading);
  font-family: 'DM Sans', sans-serif;
  font-size: 0.95rem;
  padding: 0.85rem 0;
  width: 100%;
}

.login-form__input::placeholder {
  color: var(--text-placeholder);
}

.login-form__toggle-pw {
  background: none;
  border: none;
  padding: 0.25rem;
  cursor: pointer;
  color: var(--text-faint);
  transition: color 0.2s;
  display: flex;
}

.login-form__toggle-pw:hover {
  color: var(--text-tertiary);
}

/* ---- Error ---- */
.login-form__error {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.65rem 1rem;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.15);
  border-radius: 12px;
  color: #fca5a5;
  font-size: 0.85rem;
  animation: field-appear 0.4s cubic-bezier(0.16, 1, 0.3, 1) both;
}

/* ---- Submit ---- */
.login-form__submit {
  position: relative;
  width: 100%;
  padding: 0.9rem;
  border: none;
  border-radius: 14px;
  font-family: 'DM Sans', sans-serif;
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: 0.01em;
  cursor: pointer;
  color: var(--primary-text-on);
  background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 50%, #d97706 100%);
  box-shadow:
    0 2px 12px rgba(245, 158, 11, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.15);
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  animation: field-appear 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.65s both;
  overflow: hidden;
}

.login-form__submit::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, transparent 40%, rgba(255, 255, 255, 0.15) 50%, transparent 60%);
  transform: translateX(-100%);
  transition: transform 0.5s;
}

.login-form__submit:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow:
    0 4px 20px rgba(245, 158, 11, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.login-form__submit:hover:not(:disabled)::before {
  transform: translateX(100%);
}

.login-form__submit:active:not(:disabled) {
  transform: translateY(0);
}

.login-form__submit--loading {
  pointer-events: none;
  opacity: 0.7;
}

.login-form__spinner {
  display: inline-flex;
  animation: spin 1s linear infinite;
}

/* ---- Footer ---- */
.login-card__footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  margin-top: 1.75rem;
  color: var(--text-placeholder);
  font-size: 0.7rem;
  letter-spacing: 0.02em;
  animation: field-appear 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.8s both;
}

/* ---- Animations ---- */
@keyframes card-appear {
  from {
    opacity: 0;
    transform: translateY(20px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes mascot-appear {
  from {
    opacity: 0;
    transform: translateY(-20px) scale(0.8);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes brand-appear {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes field-appear {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.shake-enter-active {
  animation: shake 0.4s;
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-6px); }
  50% { transform: translateX(6px); }
  75% { transform: translateX(-4px); }
}

@media (max-width: 480px) {
  .login-page {
    max-width: 100%;
  }

  .login-card {
    padding: 2rem 1.25rem 1.5rem;
    border-radius: 20px;
  }

  .login-card__title {
    font-size: 1.5rem;
  }

  .login-card__mascot :deep(svg) {
    width: 80px;
    height: 80px;
  }
}
</style>
