import { ref } from 'vue';

export interface ConfirmAskOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export interface ConfirmPromptOptions {
  title?: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  inputType?: 'text' | 'password' | 'number' | 'email';
}

interface AskState {
  kind: 'ask';
  id: number;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  danger: boolean;
  resolve: (v: boolean) => void;
}

interface PromptState {
  kind: 'prompt';
  id: number;
  title: string;
  message: string;
  defaultValue: string;
  placeholder: string;
  confirmText: string;
  cancelText: string;
  inputType: 'text' | 'password' | 'number' | 'email';
  resolve: (v: string | null) => void;
}

export type ConfirmState = AskState | PromptState;

const queue = ref<ConfirmState[]>([]);
let nextId = 1;

function close(id: number, value: boolean | string | null) {
  const item = queue.value.find((q) => q.id === id);
  if (!item) return;
  queue.value = queue.value.filter((q) => q.id !== id);
  if (item.kind === 'ask') {
    item.resolve(typeof value === 'boolean' ? value : false);
  } else {
    item.resolve(typeof value === 'string' ? value : null);
  }
}

export function useMbConfirm() {
  return {
    queue,
    ask(opts: ConfirmAskOptions): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        queue.value = [
          ...queue.value,
          {
            kind: 'ask',
            id: nextId++,
            title: opts.title ?? 'Подтверждение',
            message: opts.message,
            confirmText: opts.confirmText ?? 'Подтвердить',
            cancelText: opts.cancelText ?? 'Отмена',
            danger: !!opts.danger,
            resolve,
          },
        ];
      });
    },
    prompt(opts: ConfirmPromptOptions): Promise<string | null> {
      return new Promise<string | null>((resolve) => {
        queue.value = [
          ...queue.value,
          {
            kind: 'prompt',
            id: nextId++,
            title: opts.title ?? 'Введите значение',
            message: opts.message ?? '',
            defaultValue: opts.defaultValue ?? '',
            placeholder: opts.placeholder ?? '',
            confirmText: opts.confirmText ?? 'OK',
            cancelText: opts.cancelText ?? 'Отмена',
            inputType: opts.inputType ?? 'text',
            resolve,
          },
        ];
      });
    },
    _close: close,
  };
}
