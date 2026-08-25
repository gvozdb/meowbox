import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ClaimedOperation,
  OperationsService,
} from './operations.service';
import {
  OperationFailedError,
  OperationNeedsAttentionError,
} from './operation-errors';

export interface OperationExecutionContext {
  readonly operationId: string;
  readonly attempt: number;
  readonly recovering: boolean;
  readonly deadlineAt: Date;
  readonly actor: {
    kind: 'OPERATOR' | 'SERVICE';
    userId: string;
    role: 'ADMIN' | 'MANAGER' | 'VIEWER' | 'SERVICE';
  };
  heartbeat(step?: string, progress?: number): Promise<void>;
  isCancellationRequested(): Promise<boolean>;
  throwIfCancellationRequested(): Promise<void>;
}

export type OperationHandler = (
  request: unknown,
  context: OperationExecutionContext,
) => Promise<unknown>;

export class OperationCancelledError extends Error {
  constructor() {
    super('Operation cancellation requested');
    this.name = OperationCancelledError.name;
  }
}

@Injectable()
export class OperationsWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OperationsWorkerService.name);
  private readonly workerId = `worker:${process.pid}:${randomUUID()}`;
  private readonly handlers = new Map<string, OperationHandler>();
  private readonly active = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = false;
  private autoPolling = false;

  constructor(private readonly operations: OperationsService) {}

  registerHandler(actionId: string, handler: OperationHandler): () => void {
    if (this.handlers.has(actionId)) {
      throw new Error(`Operation handler already registered: ${actionId}`);
    }
    this.handlers.set(actionId, handler);
    return () => {
      if (this.handlers.get(actionId) === handler) this.handlers.delete(actionId);
    };
  }

  onModuleInit(): void {
    this.autoPolling = true;
    this.schedule(0);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.autoPolling = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      while (!this.stopped && this.active.size < 2) {
        const operation = await this.operations.claimNext(this.workerId);
        if (!operation) break;
        const execution = this.execute(operation)
          .catch((error: unknown) => {
            this.logger.error(
              `Operation ${operation.id} worker failure: ${error instanceof Error ? error.message : 'unknown'}`,
            );
          })
          .finally(() => {
            this.active.delete(operation.id);
            if (this.autoPolling) this.schedule(0);
          });
        this.active.set(operation.id, execution);
      }
    } finally {
      this.polling = false;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped || !this.autoPolling || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollOnce().finally(() => this.schedule(1_000));
    }, delayMs);
    this.timer.unref();
  }

  private async execute(operation: ClaimedOperation): Promise<void> {
    const handler = this.handlers.get(operation.actionId);
    if (!handler) {
      await this.operations.requireAttention(
        operation.id,
        this.workerId,
        'No registered handler for queued action',
      );
      return;
    }

    await this.operations.startClaimed(
      operation.id,
      this.workerId,
      operation.recovering ? 'reconcile' : 'start',
    );
    let leaseLost = false;
    const heartbeatTimer = setInterval(() => {
      void this.operations
        .heartbeatClaim(operation.id, this.workerId)
        .then((renewed) => {
          if (!renewed) {
            leaseLost = true;
            clearInterval(heartbeatTimer);
          }
        })
        .catch(() => {
          leaseLost = true;
          clearInterval(heartbeatTimer);
        });
    }, 10_000);
    heartbeatTimer.unref();

    const context: OperationExecutionContext = {
      operationId: operation.id,
      attempt: operation.attempt,
      recovering: operation.recovering,
      deadlineAt: operation.deadlineAt,
      actor: {
        kind: operation.policySnapshot.actorKind,
        userId: operation.policySnapshot.subject,
        role: operation.policySnapshot.role,
      },
      heartbeat: async (step, progress) => {
        if (leaseLost) throw new Error('Operation lease was lost');
        const renewed = await this.operations.heartbeatClaim(
          operation.id,
          this.workerId,
          step,
          progress,
        );
        if (!renewed) {
          leaseLost = true;
          throw new Error('Operation lease was lost');
        }
      },
      isCancellationRequested: () =>
        this.operations.isCancellationRequested(operation.id, this.workerId),
      throwIfCancellationRequested: async () => {
        if (await this.operations.isCancellationRequested(operation.id, this.workerId)) {
          throw new OperationCancelledError();
        }
      },
    };

    try {
      const result = await handler(operation.request, context);
      if (leaseLost) throw new Error('Operation lease was lost');
      const cancelTooLate = await context.isCancellationRequested();
      await this.operations.succeedClaimed(
        operation.id,
        this.workerId,
        result,
        cancelTooLate,
      );
    } catch (error) {
      if (error instanceof OperationFailedError) {
        await this.operations.failClaimed(
          operation.id,
          this.workerId,
          error.message,
        );
      } else if (error instanceof OperationNeedsAttentionError) {
        await this.operations.requireAttention(
          operation.id,
          this.workerId,
          error.message,
        );
      } else if (
        error instanceof OperationCancelledError ||
        await this.operations.isCancellationRequested(operation.id, this.workerId)
      ) {
        await this.operations.cancelClaimed(operation.id, this.workerId);
      } else {
        await this.operations.retryOrRequireAttention(
          operation,
          this.workerId,
          error,
        );
      }
    } finally {
      clearInterval(heartbeatTimer);
    }
  }
}
