import {
  ConflictException,
  ForbiddenException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { OperationAdmissionService } from '../operations/operation-admission.service';
import {
  OperationsWorkerService,
  type OperationExecutionContext,
} from '../operations/operations-worker.service';
import { SitesNginxService } from './sites-nginx.service';

const NGINX_REBUILD_ALL_ACTION = 'nginx.rebuild_all';
const MAX_RESULT_DETAILS = 200;
const MAX_RESULT_TEXT = 512;

function validateEmptyRequest(request: unknown): void {
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    Object.keys(request as Record<string, unknown>).length !== 0
  ) {
    throw new Error('Nginx rebuild request is invalid');
  }
}

function boundedText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, MAX_RESULT_TEXT);
}

@Injectable()
export class SitesNginxOperationsService implements OnModuleInit, OnModuleDestroy {
  private unregisterHandler: (() => void) | null = null;

  constructor(
    private readonly nginx: SitesNginxService,
    private readonly relay: AgentRelayService,
    private readonly admission: OperationAdmissionService,
    private readonly worker: OperationsWorkerService,
  ) {}

  onModuleInit(): void {
    this.unregisterHandler = this.worker.registerHandler(
      NGINX_REBUILD_ALL_ACTION,
      (request, context) => this.execute(request, context),
    );
  }

  onModuleDestroy(): void {
    this.unregisterHandler?.();
    this.unregisterHandler = null;
  }

  async enqueue(
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    if (actor.role !== 'ADMIN') {
      throw new ForbiddenException('Only ADMIN can rebuild all Nginx configs');
    }
    if (!this.relay.isAgentConnected()) {
      throw new ConflictException('Agent is offline; Nginx rebuild is unavailable');
    }
    return this.admission.admit({
      actionId: NGINX_REBUILD_ALL_ACTION,
      type: 'NGINX_REBUILD_ALL',
      idempotencyKey,
      actor,
      request: {},
      deadlineMs: 2 * 60 * 60_000,
      recoveryPolicy: 'RETRY_SAFE',
      retryable: true,
      maxAttempts: 3,
      globalLockKey: 'nginx:rebuild-all',
    });
  }

  private async execute(
    request: unknown,
    context: OperationExecutionContext,
  ): Promise<unknown> {
    validateEmptyRequest(request);
    if (context.actor.role !== 'ADMIN') {
      throw new ForbiddenException('Only ADMIN can rebuild all Nginx configs');
    }
    if (!this.relay.isAgentConnected()) {
      throw new Error('Agent disconnected before Nginx rebuild');
    }
    await context.throwIfCancellationRequested();
    await context.heartbeat('rebuild-nginx', 5);
    const result = await this.nginx.regenerateAll('ADMIN');
    await context.heartbeat('verify-result', 95);
    if (result.failed > 0) {
      const failedSites = result.details
        .filter((detail) => detail.status === 'failed')
        .slice(0, 5)
        .map((detail) => boundedText(detail.siteName))
        .join(', ');
      throw new Error(
        `Nginx rebuild failed for ${result.failed}/${result.total} site(s)` +
          (failedSites ? `: ${failedSites}` : ''),
      );
    }
    return {
      total: result.total,
      ok: result.ok,
      failed: 0,
      details: result.details.slice(0, MAX_RESULT_DETAILS).map((detail) => ({
        siteName: boundedText(detail.siteName),
        status: detail.status,
        ...(detail.error ? { error: boundedText(detail.error) } : {}),
      })),
      detailsTruncated: result.details.length > MAX_RESULT_DETAILS,
    };
  }
}
