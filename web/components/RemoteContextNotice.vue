<template>
  <section v-if="notice" class="remote-context-notice" role="status" aria-live="polite">
    <span class="remote-context-notice__mark" aria-hidden="true" />
    <div class="remote-context-notice__copy">
      <span class="remote-context-notice__code">{{ notice.code }}</span>
      <span>{{ notice.message }}</span>
    </div>
    <button
      type="button"
      class="remote-context-notice__action"
      :disabled="refreshing"
      @click="refresh"
    >
      {{ refreshing ? 'Проверка…' : 'Проверить' }}
    </button>
  </section>
</template>

<script setup lang="ts">
import { remoteContextNotice } from '~/utils/remote-capability';

const serverStore = useServerStore();
const toast = useMbToast();
const refreshing = ref(false);
const notice = computed(() =>
  serverStore.isLocal ? null : remoteContextNotice(serverStore.remoteContext),
);

async function refresh() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    await serverStore.loadServers();
    await serverStore.refreshCurrentRemoteContext();
  } catch (error) {
    toast.error((error as Error).message || 'Не удалось обновить RemoteContext');
  } finally {
    refreshing.value = false;
  }
}
</script>

<style scoped>
.remote-context-notice {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
  padding: 10px 12px;
  border: 1px solid var(--primary-border);
  border-radius: 10px;
  background:
    linear-gradient(90deg, rgba(var(--primary-rgb), 0.09), transparent 42%),
    var(--bg-surface);
  color: var(--text-secondary);
  font-size: 13px;
}

.remote-context-notice__mark {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: var(--primary);
  box-shadow: 0 0 0 4px rgba(var(--primary-rgb), 0.1);
}

.remote-context-notice__copy {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 9px;
}

.remote-context-notice__code {
  flex: 0 0 auto;
  color: var(--primary-text);
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.055em;
}

.remote-context-notice__action {
  border: 0;
  background: transparent;
  color: var(--primary-text);
  cursor: pointer;
  font: inherit;
  font-weight: 600;
}

.remote-context-notice__action:disabled {
  cursor: wait;
  opacity: 0.55;
}

@media (max-width: 640px) {
  .remote-context-notice {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .remote-context-notice__copy {
    align-items: flex-start;
    flex-direction: column;
    gap: 2px;
  }

  .remote-context-notice__action {
    grid-column: 2;
    justify-self: start;
    padding: 0;
  }
}
</style>
