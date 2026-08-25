import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { OperationAdmissionService } from '../operations/operation-admission.service';
import { OperationNeedsAttentionError } from '../operations/operation-errors';
import {
  OperationsWorkerService,
  type OperationExecutionContext,
} from '../operations/operations-worker.service';
import { FirewallService, type FirewallRuleSnapshot } from './firewall.service';

const FIREWALL_OPERATION_ACTIONS = {
  SYNC: 'firewall.sync',
  APPLY_PRESET: 'firewall.apply_preset',
} as const;

type FirewallOperationRequest =
  | { kind: 'SYNC'; rules: FirewallRuleSnapshot[] }
  | { kind: 'APPLY_PRESET'; presetName: string };

const PRESET_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function validateRule(rule: unknown): FirewallRuleSnapshot {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new BadRequestException('Firewall operation rule is invalid');
  }
  const value = rule as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !== 'action,comment,port,protocol,sourceIp' ||
    !['ALLOW', 'DENY'].includes(String(value.action)) ||
    !['TCP', 'UDP', 'BOTH'].includes(String(value.protocol)) ||
    ![value.port, value.sourceIp, value.comment].every((item) => item === null || typeof item === 'string') ||
    (typeof value.port === 'string' && !/^\d{1,5}(:\d{1,5})?$/.test(value.port)) ||
    (typeof value.sourceIp === 'string' && !/^[0-9a-fA-F:.\/]+$/.test(value.sourceIp)) ||
    (typeof value.comment === 'string' && (value.comment.length > 256 || /[\x00-\x1f\x7f]/.test(value.comment)))
  ) throw new BadRequestException('Firewall operation rule is invalid');
  return value as unknown as FirewallRuleSnapshot;
}

function validateRequest(request: unknown): FirewallOperationRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new BadRequestException('Firewall operation request is invalid');
  }
  const value = request as Record<string, unknown>;
  if (value.kind === 'SYNC') {
    if (
      Object.keys(value).sort().join(',') !== 'kind,rules' ||
      !Array.isArray(value.rules) ||
      value.rules.length > 5_000
    ) throw new BadRequestException('Firewall operation request is invalid');
    return { kind: 'SYNC', rules: value.rules.map(validateRule) };
  }
  if (
    value.kind !== 'APPLY_PRESET' ||
    Object.keys(value).sort().join(',') !== 'kind,presetName' ||
    typeof value.presetName !== 'string' ||
    !PRESET_NAME.test(value.presetName)
  ) throw new BadRequestException('Firewall operation request is invalid');
  return { kind: 'APPLY_PRESET', presetName: value.presetName };
}

@Injectable()
export class FirewallOperationsService implements OnModuleInit, OnModuleDestroy {
  private unregisterHandlers: Array<() => void> = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly firewall: FirewallService,
    private readonly admission: OperationAdmissionService,
    private readonly worker: OperationsWorkerService,
  ) {}

  onModuleInit(): void {
    this.unregisterHandlers.push(
      this.worker.registerHandler(
        FIREWALL_OPERATION_ACTIONS.SYNC,
        (request, context) => this.execute('SYNC', request, context),
      ),
      this.worker.registerHandler(
        FIREWALL_OPERATION_ACTIONS.APPLY_PRESET,
        (request, context) => this.execute('APPLY_PRESET', request, context),
      ),
    );
  }

  onModuleDestroy(): void {
    for (const unregister of this.unregisterHandlers.splice(0)) unregister();
  }

  async enqueueSync(
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    const rows = await this.prisma.firewallRule.findMany({
      select: {
        action: true,
        protocol: true,
        port: true,
        sourceIp: true,
        comment: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 5_001,
    });
    if (rows.length > 5_000) {
      throw new BadRequestException('Firewall contains too many rules for one sync operation');
    }
    const rules = rows.map((row) => validateRule(row));
    return this.admission.admit({
      actionId: FIREWALL_OPERATION_ACTIONS.SYNC,
      type: 'FIREWALL_SYNC',
      idempotencyKey,
      actor,
      request: { kind: 'SYNC', rules } satisfies FirewallOperationRequest,
      deadlineMs: 15 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: 'firewall:runtime',
    });
  }

  async enqueuePreset(
    presetName: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    if (!PRESET_NAME.test(presetName)) throw new NotFoundException('Firewall preset not found');
    const exists = this.firewall.getPresets().some((preset) => preset.name === presetName);
    if (!exists) throw new NotFoundException('Firewall preset not found');
    return this.admission.admit({
      actionId: FIREWALL_OPERATION_ACTIONS.APPLY_PRESET,
      type: 'FIREWALL_APPLY_PRESET',
      idempotencyKey,
      actor,
      request: { kind: 'APPLY_PRESET', presetName } satisfies FirewallOperationRequest,
      deadlineMs: 15 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: 'firewall:runtime',
    });
  }

  private async execute(
    expectedKind: FirewallOperationRequest['kind'],
    request: unknown,
    context: OperationExecutionContext,
  ): Promise<unknown> {
    const payload = validateRequest(request);
    if (payload.kind !== expectedKind) {
      throw new BadRequestException('Firewall operation action does not match its payload');
    }
    if (context.recovering) {
      throw new OperationNeedsAttentionError(
        'Firewall mutation was interrupted; reconcile DB and UFW state before retrying',
      );
    }
    await context.throwIfCancellationRequested();
    if (payload.kind === 'SYNC') {
      return this.firewall.applyRuleSnapshots(payload.rules);
    }
    const rules = await this.firewall.applyPreset(payload.presetName);
    return { presetName: payload.presetName, created: rules.length };
  }
}
