<template>
  <Teleport to="body">
    <div class="mb-toast-container" role="region" aria-label="Уведомления">
      <TransitionGroup name="mb-toast">
        <div
          v-for="t in toasts"
          :key="t.id"
          class="mb-toast"
          :class="`mb-toast--${t.type}`"
          role="alert"
        >
          <div class="mb-toast__icon" aria-hidden="true">
            <!-- success -->
            <svg v-if="t.type === 'success'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
            <!-- error -->
            <svg v-else-if="t.type === 'error'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            <!-- warning -->
            <svg v-else-if="t.type === 'warning'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
            <!-- info -->
            <svg v-else width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
          </div>
          <div class="mb-toast__body">
            <div v-if="t.title" class="mb-toast__title">{{ t.title }}</div>
            <div class="mb-toast__msg">{{ t.message }}</div>
          </div>
          <button class="mb-toast__close" type="button" aria-label="Закрыть" @click="dismiss(t.id)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { useMbToast } from '~/composables/useMbToast';

const { toasts, dismiss } = useMbToast();
</script>

<style scoped>
.mb-toast-container {
  position: fixed;
  top: 1.25rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10000;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  width: min(440px, calc(100vw - 2rem));
  pointer-events: none;
}

.mb-toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.95rem 1.1rem;
  border-radius: 14px;
  border: 1px solid var(--border-strong);
  background: var(--bg-modal-gradient);
  color: var(--text-primary);
  box-shadow: 0 12px 36px -8px rgba(0, 0, 0, 0.45), 0 2px 8px rgba(0, 0, 0, 0.2);
  font-size: 15px;
  line-height: 1.45;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

.mb-toast__icon {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mb-toast__body {
  flex: 1;
  min-width: 0;
  padding-top: 4px;
}

.mb-toast__title {
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 0.2rem;
  color: var(--text-heading);
}

.mb-toast__msg {
  font-size: 15px;
  font-weight: 500;
  word-wrap: break-word;
  overflow-wrap: anywhere;
  color: var(--text-primary);
}

.mb-toast__close {
  flex: 0 0 auto;
  background: transparent;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.mb-toast__close:hover { color: var(--text-primary); background: var(--bg-surface-hover); }

/* Type-specific colors */
.mb-toast--success {
  border-color: var(--success-border);
}
.mb-toast--success .mb-toast__icon {
  background: var(--success-bg);
  color: var(--success-light);
}

.mb-toast--error {
  border-color: var(--danger-border);
}
.mb-toast--error .mb-toast__icon {
  background: var(--danger-bg);
  color: var(--danger-light);
}

.mb-toast--warning {
  border-color: rgba(var(--primary-rgb), 0.25);
}
.mb-toast--warning .mb-toast__icon {
  background: var(--primary-bg);
  color: var(--primary-light);
}

.mb-toast--info {
  border-color: var(--border-strong);
}
.mb-toast--info .mb-toast__icon {
  background: var(--bg-input);
  color: var(--text-primary);
}

/* Animations */
.mb-toast-enter-active, .mb-toast-leave-active {
  transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s ease;
}
.mb-toast-enter-from {
  opacity: 0;
  transform: translateY(-16px) scale(0.96);
}
.mb-toast-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.96);
}
.mb-toast-move {
  transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}

@media (max-width: 640px) {
  .mb-toast-container {
    top: 0.75rem;
    width: calc(100vw - 1.25rem);
  }
  .mb-toast {
    padding: 0.85rem 0.95rem;
    font-size: 14.5px;
    border-radius: 12px;
  }
}
</style>
