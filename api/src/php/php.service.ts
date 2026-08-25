import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { OperationAdmissionService } from '../operations/operation-admission.service';
import { OperationsWorkerService } from '../operations/operations-worker.service';

const PHP_OPERATION_ACTIONS = {
  INSTALL: 'php.install',
  UNINSTALL: 'php.uninstall',
  EXTENSION_INSTALL: 'php.extension.install',
} as const;

const PHP_AGENT_ACTIONS = {
  [PHP_OPERATION_ACTIONS.INSTALL]: 'agent.php.install',
  [PHP_OPERATION_ACTIONS.UNINSTALL]: 'agent.php.uninstall',
  [PHP_OPERATION_ACTIONS.EXTENSION_INSTALL]: 'agent.php.extension.install',
} as const;

function validateOperationRequest(
  request: unknown,
  withExtension: boolean,
): { version: string; name?: string } {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new BadRequestException('PHP operation request is invalid');
  }
  const value = request as Record<string, unknown>;
  const expected = withExtension ? ['name', 'version'] : ['version'];
  if (
    Object.keys(value).sort().join(',') !== expected.sort().join(',') ||
    typeof value.version !== 'string' ||
    (withExtension && typeof value.name !== 'string')
  ) {
    throw new BadRequestException('PHP operation request is invalid');
  }
  return value as { version: string; name?: string };
}

export interface PhpVersionStatus {
  running: boolean;
  version: string | null;
  poolCount: number;
}

@Injectable()
export class PhpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('PhpService');
  private unregisterHandlers: Array<() => void> = [];

  constructor(
    private readonly agentRelay: AgentRelayService,
    private readonly admission: OperationAdmissionService,
    private readonly worker: OperationsWorkerService,
  ) {}

  onModuleInit(): void {
    for (const [operationAction, agentAction] of Object.entries(PHP_AGENT_ACTIONS)) {
      this.unregisterHandlers.push(this.worker.registerHandler(
        operationAction,
        async (request, context) => {
          const payload = validateOperationRequest(
            request,
            operationAction === PHP_OPERATION_ACTIONS.EXTENSION_INSTALL,
          );
          return this.agentRelay.runAgentJob(
            {
              operationId: context.operationId,
              actionId: agentAction,
              step: 'execute',
              payload,
              deadlineAt: context.deadlineAt,
              cancelSafe: false,
            },
            () => context.isCancellationRequested(),
          );
        },
      ));
    }
  }

  onModuleDestroy(): void {
    for (const unregister of this.unregisterHandlers.splice(0)) unregister();
  }

  async listVersions(): Promise<string[]> {
    const result = await this.agentRelay.emitToAgent<string[]>(
      'php:list-versions',
      {},
    );
    if (!result.success) {
      throw new InternalServerErrorException(
        result.error || 'Failed to list PHP versions',
      );
    }
    return result.data ?? [];
  }

  async getStatus(phpVersion: string): Promise<PhpVersionStatus> {
    const result = await this.agentRelay.emitToAgent<PhpVersionStatus>(
      'php:status',
      { phpVersion },
    );
    if (!result.success) {
      throw new InternalServerErrorException(
        result.error || 'Failed to get PHP status',
      );
    }
    return result.data!;
  }

  async getAllStatuses(): Promise<PhpVersionStatus[]> {
    const versions = await this.listVersions();
    const statuses: PhpVersionStatus[] = [];

    for (const ver of versions) {
      try {
        const status = await this.getStatus(ver);
        statuses.push(status);
      } catch {
        statuses.push({ running: false, version: ver, poolCount: 0 });
      }
    }

    return statuses;
  }

  async restartVersion(phpVersion: string): Promise<void> {
    const result = await this.agentRelay.emitToAgent('php:restart', {
      phpVersion,
    });
    if (!result.success) {
      throw new InternalServerErrorException(
        result.error || 'Failed to restart PHP-FPM',
      );
    }
    this.logger.log(`PHP-FPM ${phpVersion} restarted`);
  }

  async enqueueInstallVersion(
    version: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    return this.admission.admit({
      actionId: PHP_OPERATION_ACTIONS.INSTALL,
      type: 'PHP_INSTALL',
      idempotencyKey,
      actor,
      request: { version },
      deadlineMs: 30 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: 'php:packages',
    });
  }

  async enqueueUninstallVersion(
    version: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    return this.admission.admit({
      actionId: PHP_OPERATION_ACTIONS.UNINSTALL,
      type: 'PHP_UNINSTALL',
      idempotencyKey,
      actor,
      request: { version },
      deadlineMs: 20 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: 'php:packages',
    });
  }

  async readIni(version: string) {
    const result = await this.agentRelay.emitToAgent<string>('php:read-ini', { version });
    if (!result.success) throw new InternalServerErrorException(result.error || 'Read INI failed');
    return result.data;
  }

  async writeIni(version: string, content: string): Promise<void> {
    const result = await this.agentRelay.emitToAgent('php:write-ini', { version, content });
    if (!result.success) throw new InternalServerErrorException(result.error || 'Write INI failed');
  }

  async listExtensions(version: string) {
    const result = await this.agentRelay.emitToAgent<Array<{ name: string; enabled: boolean }>>('php:extensions', { version });
    if (!result.success) throw new InternalServerErrorException(result.error || 'List extensions failed');
    return result.data;
  }

  async enqueueInstallExtension(
    version: string,
    name: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    return this.admission.admit({
      actionId: PHP_OPERATION_ACTIONS.EXTENSION_INSTALL,
      type: 'PHP_EXTENSION_INSTALL',
      idempotencyKey,
      actor,
      request: { version, name },
      deadlineMs: 10 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: 'php:packages',
    });
  }

  async toggleExtension(version: string, name: string, enable: boolean): Promise<void> {
    const result = await this.agentRelay.emitToAgent('php:extension-toggle', { version, name, enable });
    if (!result.success) throw new InternalServerErrorException(result.error || 'Toggle extension failed');
  }
}
