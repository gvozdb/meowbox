<template>
  <Teleport to="body">
    <Transition name="mb-confirm">
      <div v-if="current" class="mb-confirm-overlay" @mousedown.self="cancel">
        <div class="mb-confirm" role="dialog" aria-modal="true">
          <h3 class="mb-confirm__title">{{ current.title }}</h3>
          <p v-if="current.message" class="mb-confirm__message">{{ current.message }}</p>

          <div v-if="current.kind === 'prompt'" class="mb-confirm__field">
            <input
              ref="inputRef"
              v-model="inputValue"
              :type="current.inputType"
              :placeholder="current.placeholder"
              class="mb-confirm__input"
              @keyup.enter="submit"
              @keydown.esc="cancel"
            />
          </div>

          <div class="mb-confirm__actions">
            <button type="button" class="mb-confirm__btn mb-confirm__btn--ghost" @click="cancel">
              {{ current.cancelText }}
            </button>
            <button
              ref="confirmBtnRef"
              type="button"
              class="mb-confirm__btn"
              :class="(current.kind === 'ask' && current.danger) ? 'mb-confirm__btn--danger' : 'mb-confirm__btn--primary'"
              @click="submit"
            >
              {{ current.confirmText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useMbConfirm } from '~/composables/useMbConfirm';

const { queue, _close } = useMbConfirm();

const current = computed(() => queue.value[0] ?? null);

const inputValue = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
const confirmBtnRef = ref<HTMLButtonElement | null>(null);

watch(current, async (item) => {
  if (!item) return;
  if (item.kind === 'prompt') {
    inputValue.value = item.defaultValue;
    await nextTick();
    inputRef.value?.focus();
    inputRef.value?.select();
  } else {
    await nextTick();
    confirmBtnRef.value?.focus();
  }
}, { immediate: true });

function cancel() {
  if (!current.value) return;
  if (current.value.kind === 'ask') _close(current.value.id, false);
  else _close(current.value.id, null);
}

function submit() {
  if (!current.value) return;
  if (current.value.kind === 'ask') _close(current.value.id, true);
  else _close(current.value.id, inputValue.value);
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (!current.value) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
}
</script>

<style scoped>
.mb-confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 11000;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.25rem;
}

.mb-confirm {
  background: var(--bg-modal-gradient);
  border: 1px solid var(--border-strong);
  border-radius: 16px;
  padding: 1.5rem 1.5rem 1.25rem;
  width: min(460px, 100%);
  box-shadow: var(--shadow-modal, 0 24px 80px -12px rgba(0, 0, 0, 0.6));
  animation: mb-confirm-in 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}

.mb-confirm__title {
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0 0 0.5rem;
}

.mb-confirm__message {
  color: var(--text-secondary);
  font-size: 15px;
  line-height: 1.5;
  margin: 0 0 1.1rem;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.mb-confirm__field {
  margin: 0 0 1.1rem;
}

.mb-confirm__input {
  width: 100%;
  padding: 0.65rem 0.85rem;
  border-radius: 10px;
  border: 1px solid var(--border-strong);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 15px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.mb-confirm__input:focus {
  border-color: var(--primary);
  box-shadow: var(--focus-ring);
}

.mb-confirm__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
}

.mb-confirm__btn {
  padding: 0.6rem 1.15rem;
  border-radius: 10px;
  font-size: 14.5px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.15s;
  min-width: 96px;
}

.mb-confirm__btn--ghost {
  background: var(--bg-input);
  border-color: var(--border-strong);
  color: var(--text-secondary);
}
.mb-confirm__btn--ghost:hover { color: var(--text-primary); background: var(--bg-surface-hover); }

.mb-confirm__btn--primary {
  background: var(--primary);
  color: var(--primary-text-on, #fff);
}
.mb-confirm__btn--primary:hover { filter: brightness(1.08); }

.mb-confirm__btn--danger {
  background: var(--danger);
  color: #fff;
}
.mb-confirm__btn--danger:hover { filter: brightness(1.08); }

.mb-confirm-enter-active, .mb-confirm-leave-active {
  transition: opacity 0.18s ease;
}
.mb-confirm-enter-from, .mb-confirm-leave-to { opacity: 0; }

@keyframes mb-confirm-in {
  from { opacity: 0; transform: scale(0.96) translateY(8px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
</style>
