<template>
  <span class="status-badge" :class="`status-badge--${status.toLowerCase()}`">
    <span class="status-badge__dot" />
    <span class="status-badge__label">{{ label }}</span>
  </span>
</template>

<script setup lang="ts">
const props = defineProps<{
  status: string;
}>();

const label = computed(() => {
  const labels: Record<string, string> = {
    RUNNING: 'Работает',
    STOPPED: 'Остановлен',
    ERROR: 'Ошибка',
    DEPLOYING: 'Обработка',
  };
  return labels[props.status] || props.status;
});
</script>

<style scoped>
.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.25rem 0.65rem;
  border-radius: 20px;
  font-size: 0.72rem;
  font-weight: 550;
  letter-spacing: 0.02em;
}

.status-badge__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* Running — green */
.status-badge--running {
  background: rgba(34, 197, 94, 0.1);
  color: #4ade80;
}
.status-badge--running .status-badge__dot {
  background: #22c55e;
  box-shadow: 0 0 6px rgba(34, 197, 94, 0.5);
  animation: pulse-green 2s ease-in-out infinite;
}

/* Stopped — gray */
.status-badge--stopped {
  background: rgba(148, 163, 184, 0.1);
  color: #94a3b8;
}
.status-badge--stopped .status-badge__dot {
  background: #64748b;
}

/* Error — red */
.status-badge--error {
  background: rgba(239, 68, 68, 0.1);
  color: #f87171;
}
.status-badge--error .status-badge__dot {
  background: #ef4444;
  box-shadow: 0 0 6px rgba(239, 68, 68, 0.5);
  animation: pulse-red 1s ease-in-out infinite;
}

/* Deploying — amber */
.status-badge--deploying {
  background: rgba(245, 158, 11, 0.1);
  color: #fbbf24;
}
.status-badge--deploying .status-badge__dot {
  background: #f59e0b;
  animation: pulse-amber 1.5s ease-in-out infinite;
}

@keyframes pulse-green {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
@keyframes pulse-red {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(1.2); }
}
@keyframes pulse-amber {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
