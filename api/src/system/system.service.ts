import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { OperationAdmissionService } from '../operations/operation-admission.service';
import { OperationsWorkerService } from '../operations/operations-worker.service';
import * as os from 'os';

const SYSTEM_UPDATE_ACTIONS = {
  CHECK: 'system.updates.check',
  INSTALL: 'system.updates.install',
  UPGRADE_ALL: 'system.updates.upgrade_all',
} as const;

const SYSTEM_UPDATE_AGENT_ACTIONS = {
  [SYSTEM_UPDATE_ACTIONS.CHECK]: 'agent.system.updates.check',
  [SYSTEM_UPDATE_ACTIONS.INSTALL]: 'agent.system.updates.install',
  [SYSTEM_UPDATE_ACTIONS.UPGRADE_ALL]: 'agent.system.updates.upgrade_all',
} as const;

const APT_PACKAGE = /^[a-z0-9][a-z0-9+.-]*$/i;

function validateUpdateOperationRequest(
  actionId: string,
  request: unknown,
): { packages?: string[] } {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new BadRequestException('System update operation request is invalid');
  }
  const value = request as Record<string, unknown>;
  if (actionId !== SYSTEM_UPDATE_ACTIONS.INSTALL) {
    if (Object.keys(value).length !== 0) {
      throw new BadRequestException('System update operation request is invalid');
    }
    return {};
  }
  if (
    Object.keys(value).length !== 1 ||
    !Array.isArray(value.packages) ||
    value.packages.length < 1 ||
    value.packages.length > 200 ||
    value.packages.some(
      (name) => typeof name !== 'string' || name.length > 128 || !APT_PACKAGE.test(name),
    )
  ) {
    throw new BadRequestException('System update package list is invalid');
  }
  return { packages: value.packages as string[] };
}

@Injectable()
export class SystemService implements OnModuleInit, OnModuleDestroy {
  private unregisterHandlers: Array<() => void> = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly admission: OperationAdmissionService,
    private readonly worker: OperationsWorkerService,
  ) {}

  onModuleInit(): void {
    for (const [operationAction, agentAction] of Object.entries(SYSTEM_UPDATE_AGENT_ACTIONS)) {
      this.unregisterHandlers.push(this.worker.registerHandler(
        operationAction,
        async (request, context) => {
          const payload = validateUpdateOperationRequest(operationAction, request);
          await context.throwIfCancellationRequested();
          return this.agentRelay.runAgentJob(
            {
              operationId: context.operationId,
              actionId: agentAction,
              step: 'apt',
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

  async getStatus() {
    const dbStatus = await this.checkDatabase();

    return {
      status: dbStatus === 'up' ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      versions: {
        api: process.env.npm_package_version || '0.1.0',
        node: process.version,
      },
      services: {
        database: dbStatus,
      },
    };
  }

  async getMetrics() {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const uptimeSeconds = os.uptime();

    // Compute average CPU usage across all cores
    let totalIdle = 0;
    let totalTick = 0;
    for (const cpu of cpus) {
      const { user, nice, sys, idle, irq } = cpu.times;
      totalIdle += idle;
      totalTick += user + nice + sys + idle + irq;
    }
    const cpuUsagePercent = totalTick > 0
      ? Math.round(((totalTick - totalIdle) / totalTick) * 100)
      : 0;

    return {
      cpuUsagePercent,
      cpuCores: cpus.length,
      memoryTotalBytes: totalMem,
      memoryUsedBytes: usedMem,
      memoryFreeBytes: freeMem,
      memoryUsagePercent: Math.round((usedMem / totalMem) * 100),
      uptimeSeconds: Math.floor(uptimeSeconds),
      loadAverage: os.loadavg(),
    };
  }

  private async checkDatabase(): Promise<'up' | 'down'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }

  async enqueueCheckUpdates(
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    return this.admission.admit({
      actionId: SYSTEM_UPDATE_ACTIONS.CHECK,
      type: 'SYSTEM_UPDATES_CHECK',
      idempotencyKey,
      actor,
      request: {},
      deadlineMs: 15 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: 'system:apt',
    });
  }

  async enqueueInstallUpdates(
    packages: string[],
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    return this.admission.admit({
      actionId: SYSTEM_UPDATE_ACTIONS.INSTALL,
      type: 'SYSTEM_UPDATES_INSTALL',
      idempotencyKey,
      actor,
      request: { packages },
      deadlineMs: 60 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: 'system:apt',
    });
  }

  async enqueueUpgradeAll(
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    return this.admission.admit({
      actionId: SYSTEM_UPDATE_ACTIONS.UPGRADE_ALL,
      type: 'SYSTEM_UPDATES_UPGRADE_ALL',
      idempotencyKey,
      actor,
      request: {},
      deadlineMs: 4 * 60 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: 'system:apt',
    });
  }

  async getVersions() {
    const result = await this.agentRelay.emitToAgent('updates:versions', {}, 30_000);
    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to get versions');
    }
    return result.data;
  }

  async selfUpdate() {
    const result = await this.agentRelay.emitToAgent<{ output: string }>('updates:self-update', {}, 600_000);
    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Self-update failed');
    }
    return result.data;
  }
}
