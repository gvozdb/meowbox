import { createIdempotencyKey } from '~/utils/idempotency-key';

export const OPERATION_TERMINAL_STATES = [
  'CANCELLED',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN_RECOVERY_REQUIRED',
  'NEEDS_ATTENTION',
] as const;

export type OperationTerminalState = (typeof OPERATION_TERMINAL_STATES)[number];
export type OperationStateName =
  | 'PENDING'
  | 'QUEUED'
  | 'CLAIMED'
  | 'RUNNING'
  | 'RECOVERING'
  | 'CANCEL_REQUESTED'
  | OperationTerminalState;

export interface AcceptedOperation {
  operationId: string;
  requestId: string;
  state: OperationStateName;
  replayed: boolean;
  statusPath: string;
  retryAfterSeconds: number;
}

export interface OperationState {
  id: string;
  status: OperationStateName;
  currentStep: string | null;
  progress: number;
  result: unknown;
  errorMessage: string | null;
  cancelOutcome: string | null;
  deadlineAt: string | null;
}

export class OperationFailedError extends Error {
  constructor(readonly operation: OperationState) {
    super(operation.errorMessage || `Operation ended in ${operation.status}`);
    this.name = 'OperationFailedError';
  }
}

export function operationIdempotencyKey(prefix: string): string {
  return createIdempotencyKey(prefix);
}

const operationWatchControllers = new Set<AbortController>();

export function cancelOperationWatches(): void {
  for (const controller of operationWatchControllers) controller.abort();
  operationWatchControllers.clear();
}

export function useOperation() {
  const api = useRemoteApi();

  async function waitForOperation(
    operationId: string,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onUpdate?: (operation: OperationState) => void;
    } = {},
  ): Promise<OperationState> {
    const controller = new AbortController();
    operationWatchControllers.add(controller);
    const abort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    const signal = controller.signal;

    try {
      const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
      while (Date.now() <= deadline) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const operation = await api.get<OperationState>(
          `/operations/${operationId}`,
          { signal },
        );
        options.onUpdate?.(operation);
        if (OPERATION_TERMINAL_STATES.includes(operation.status as OperationTerminalState)) {
          if (operation.status === 'SUCCEEDED') return operation;
          throw new OperationFailedError(operation);
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, 1_000);
          const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(new DOMException('Aborted', 'AbortError'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }
      throw new Error('Operation is still running; check its status in Operations');
    } finally {
      options.signal?.removeEventListener('abort', abort);
      operationWatchControllers.delete(controller);
    }
  }

  return { waitForOperation };
}
