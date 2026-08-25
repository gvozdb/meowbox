<template>
  <div v-if="operation" class="operation-progress" :class="`operation-progress--${tone}`">
    <div class="operation-progress__head">
      <span>{{ statusLabel }}</span>
      <strong>{{ operation.progress }}%</strong>
    </div>
    <div class="operation-progress__track">
      <span :style="{ width: `${operation.progress}%` }" />
    </div>
    <p v-if="operation.currentStep">{{ stepLabel(operation.currentStep) }}</p>
    <p v-if="operation.errorMessage" class="operation-progress__error">
      {{ operation.errorMessage }}
    </p>
  </div>
</template>

<script setup lang="ts">
type OperationStatus =
  | 'PENDING' | 'QUEUED' | 'CLAIMED' | 'RUNNING' | 'RECOVERING'
  | 'CANCEL_REQUESTED' | 'CANCELLED' | 'SUCCEEDED' | 'FAILED'
  | 'UNKNOWN_RECOVERY_REQUIRED' | 'NEEDS_ATTENTION';

interface OperationState {
  id: string;
  status: OperationStatus;
  currentStep: string | null;
  progress: number;
  errorMessage: string | null;
}

const props = defineProps<{
  operationId: string;
}>();

const emit = defineEmits<{
  (event: 'finished', operation: OperationState): void;
}>();

const api = useRemoteApi();
const serverStore = useServerStore();
const operation = ref<OperationState | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

const terminal = computed(
  () => operation.value != null && [
    'CANCELLED', 'SUCCEEDED', 'FAILED', 'UNKNOWN_RECOVERY_REQUIRED', 'NEEDS_ATTENTION',
  ].includes(operation.value.status),
);
const tone = computed(() => {
  if (operation.value && [
    'CANCELLED', 'FAILED', 'UNKNOWN_RECOVERY_REQUIRED', 'NEEDS_ATTENTION',
  ].includes(operation.value.status)) return 'error';
  if (operation.value?.status === 'SUCCEEDED') return 'success';
  return 'running';
});
const statusLabel = computed(() => {
  if (operation.value && [
    'FAILED', 'UNKNOWN_RECOVERY_REQUIRED', 'NEEDS_ATTENTION',
  ].includes(operation.value.status)) return 'Операция требует внимания';
  if (operation.value?.status === 'CANCELLED') return 'Операция отменена';
  if (operation.value?.status === 'SUCCEEDED') return 'Операция завершена';
  if (operation.value?.status === 'PENDING' || operation.value?.status === 'QUEUED') return 'Операция ожидает запуска';
  if (operation.value?.status === 'RECOVERING') return 'Операция восстанавливается';
  if (operation.value?.status === 'CANCEL_REQUESTED') return 'Запрошена отмена';
  return 'Операция выполняется';
});

const STEP_LABELS: Record<string, string> = {
  reserve: 'Резервирование приложения',
  snapshot: 'Создание снимка',
  'configure-routing': 'Настройка маршрутизации',
  'preflight-root': 'Проверка каталога',
  database: 'Настройка базы данных',
  install: 'Установка приложения',
  'php-pool': 'Настройка PHP-FPM',
  nginx: 'Настройка Nginx',
  'health-check': 'Проверка доступности',
  ssl: 'Выпуск SSL-сертификата',
  compensate: 'Откат незавершённых изменений',
};

function stepLabel(step: string): string {
  return STEP_LABELS[step] || step;
}

function clearTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

async function poll(expectedGeneration: number, expectedContextEpoch: number): Promise<void> {
  if (
    !props.operationId ||
    expectedGeneration !== generation ||
    expectedContextEpoch !== serverStore.contextEpoch
  ) return;
  try {
    operation.value = await api.get<OperationState>(`/operations/${props.operationId}`);
    if (terminal.value) {
      emit('finished', operation.value);
      return;
    }
  } catch {
    // Temporary request failures are retried while the component stays mounted.
  }
  if (expectedGeneration === generation && expectedContextEpoch === serverStore.contextEpoch) {
    timer = setTimeout(() => void poll(expectedGeneration, expectedContextEpoch), 1500);
  }
}

watch(
  () => props.operationId,
  (operationId) => {
    generation++;
    clearTimer();
    operation.value = null;
    if (operationId) void poll(generation, serverStore.contextEpoch);
  },
  { immediate: true },
);

watch(
  () => serverStore.contextEpoch,
  () => {
    generation++;
    clearTimer();
    operation.value = null;
  },
);

onBeforeUnmount(() => {
  generation++;
  clearTimer();
});
</script>

<style scoped>
.operation-progress {
  padding: 0.8rem 0.9rem;
  border: 1px solid var(--primary-border);
  border-radius: 11px;
  background: var(--primary-bg);
}
.operation-progress--error {
  border-color: var(--danger-border);
  background: var(--danger-bg);
}
.operation-progress--success {
  border-color: rgba(34, 197, 94, 0.35);
  background: rgba(34, 197, 94, 0.08);
}
.operation-progress__head {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  color: var(--text-secondary);
  font-size: 0.78rem;
}
.operation-progress__track {
  height: 4px;
  margin-top: 0.55rem;
  overflow: hidden;
  border-radius: 999px;
  background: var(--bar-bg);
}
.operation-progress__track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--primary);
  transition: width 0.25s ease;
}
.operation-progress--error .operation-progress__track span { background: var(--danger-light); }
.operation-progress--success .operation-progress__track span { background: #4ade80; }
.operation-progress p {
  margin: 0.45rem 0 0;
  color: var(--text-muted);
  font-size: 0.72rem;
}
.operation-progress .operation-progress__error { color: var(--danger-light); }
</style>
