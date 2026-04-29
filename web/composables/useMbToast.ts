import { ref } from 'vue';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  title?: string;
  duration: number; // 0 = sticky
}

interface ToastOptions {
  title?: string;
  duration?: number;
}

// Module-level singletons so all components share the same stack
const toasts = ref<ToastItem[]>([]);
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

const DEFAULT_DURATION: Record<ToastType, number> = {
  success: 5000,
  info: 5000,
  warning: 6000,
  error: 0, // sticky — пользователь должен прочитать
};

function dismiss(id: number) {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
  toasts.value = toasts.value.filter((x) => x.id !== id);
}

function push(type: ToastType, message: string, opts: ToastOptions = {}): number {
  const id = nextId++;
  const duration = opts.duration ?? DEFAULT_DURATION[type];
  const item: ToastItem = {
    id,
    type,
    message,
    title: opts.title,
    duration,
  };
  toasts.value = [...toasts.value, item];
  if (duration > 0) {
    const handle = setTimeout(() => dismiss(id), duration);
    timers.set(id, handle);
  }
  return id;
}

export function useMbToast() {
  return {
    toasts,
    success: (message: string, opts?: ToastOptions) => push('success', message, opts),
    error: (message: string, opts?: ToastOptions) => push('error', message, opts),
    warning: (message: string, opts?: ToastOptions) => push('warning', message, opts),
    info: (message: string, opts?: ToastOptions) => push('info', message, opts),
    dismiss,
  };
}
