import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { decryptJson, encryptJson } from '../common/crypto/credentials-cipher';
import { PrismaService } from '../common/prisma.service';
import { OperationAdmissionService } from '../operations/operation-admission.service';
import { OperationNeedsAttentionError } from '../operations/operation-errors';
import {
  OperationsWorkerService,
  type OperationExecutionContext,
} from '../operations/operations-worker.service';
import { ApplyTemplateDto, CreateProviderDto } from './dns.dto';
import { DnsService } from './dns.service';

export const DNS_OPERATION_ACTIONS = {
  CREATE_PROVIDER: 'dns.provider.create',
  TEST_PROVIDER: 'dns.provider.test',
  SYNC_PROVIDER: 'dns.provider.sync',
  REFRESH_ZONE: 'dns.zone.refresh',
  APPLY_TEMPLATE: 'dns.zone.apply_template',
} as const;

type DnsOperationKind = keyof typeof DNS_OPERATION_ACTIONS;

interface BaseRequest {
  kind: DnsOperationKind;
}

interface CreateProviderRequest extends BaseRequest {
  kind: 'CREATE_PROVIDER';
  providerId: string;
  payloadEnc: string;
}

interface ProviderRequest extends BaseRequest {
  kind: 'TEST_PROVIDER' | 'SYNC_PROVIDER';
  providerId: string;
}

interface ZoneRequest extends BaseRequest {
  kind: 'REFRESH_ZONE';
  zoneId: string;
}

interface TemplateRequest extends BaseRequest {
  kind: 'APPLY_TEMPLATE';
  zoneId: string;
  template: string;
  extras?: { dkim?: string; dkimSelector?: string };
}

type DnsOperationRequest =
  | CreateProviderRequest
  | ProviderRequest
  | ZoneRequest
  | TemplateRequest;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateRequest(request: unknown): DnsOperationRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new BadRequestException('DNS operation request is invalid');
  }
  const value = request as Record<string, unknown>;
  if (typeof value.kind !== 'string' || !(value.kind in DNS_OPERATION_ACTIONS)) {
    throw new BadRequestException('DNS operation request is invalid');
  }
  if (value.kind === 'CREATE_PROVIDER') {
    if (
      !exactKeys(value, ['kind', 'providerId', 'payloadEnc']) ||
      typeof value.providerId !== 'string' ||
      !UUID.test(value.providerId) ||
      typeof value.payloadEnc !== 'string' ||
      value.payloadEnc.length < 32 ||
      value.payloadEnc.length > 1_500_000
    ) throw new BadRequestException('DNS operation request is invalid');
    return value as unknown as CreateProviderRequest;
  }
  if (value.kind === 'TEST_PROVIDER' || value.kind === 'SYNC_PROVIDER') {
    if (
      !exactKeys(value, ['kind', 'providerId']) ||
      typeof value.providerId !== 'string' ||
      !UUID.test(value.providerId)
    ) throw new BadRequestException('DNS operation request is invalid');
    return value as unknown as ProviderRequest;
  }
  if (value.kind === 'REFRESH_ZONE') {
    if (
      !exactKeys(value, ['kind', 'zoneId']) ||
      typeof value.zoneId !== 'string' ||
      !UUID.test(value.zoneId)
    ) throw new BadRequestException('DNS operation request is invalid');
    return value as unknown as ZoneRequest;
  }
  const allowedKeys = value.extras === undefined
    ? ['kind', 'zoneId', 'template']
    : ['kind', 'zoneId', 'template', 'extras'];
  if (
    !exactKeys(value, allowedKeys) ||
    typeof value.zoneId !== 'string' ||
    !UUID.test(value.zoneId) ||
    typeof value.template !== 'string'
  ) throw new BadRequestException('DNS operation request is invalid');
  validateDto(ApplyTemplateDto, {
    template: value.template,
    ...(value.extras === undefined ? {} : { extras: value.extras }),
  });
  return value as unknown as TemplateRequest;
}

function validateDto<T extends object>(type: new () => T, payload: unknown): T {
  const dto = plainToInstance(type, payload);
  const errors = validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });
  if (errors.length > 0) throw new BadRequestException('DNS operation payload is invalid');
  return dto;
}

@Injectable()
export class DnsOperationsService implements OnModuleInit, OnModuleDestroy {
  private unregisterHandlers: Array<() => void> = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly dns: DnsService,
    private readonly admission: OperationAdmissionService,
    private readonly worker: OperationsWorkerService,
  ) {}

  onModuleInit(): void {
    for (const kind of Object.keys(DNS_OPERATION_ACTIONS) as DnsOperationKind[]) {
      this.unregisterHandlers.push(this.worker.registerHandler(
        DNS_OPERATION_ACTIONS[kind],
        (request, context) => this.execute(kind, request, context),
      ));
    }
  }

  onModuleDestroy(): void {
    for (const unregister of this.unregisterHandlers.splice(0)) unregister();
  }

  async enqueueCreateProvider(
    dto: CreateProviderDto,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    const providerId = randomUUID();
    return this.admission.admit({
      actionId: DNS_OPERATION_ACTIONS.CREATE_PROVIDER,
      type: 'DNS_PROVIDER_CREATE',
      idempotencyKey,
      actor,
      request: {
        kind: 'CREATE_PROVIDER',
        providerId,
        payloadEnc: encryptJson(dto),
      } satisfies CreateProviderRequest,
      deadlineMs: 15 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: `dns-provider:${providerId}`,
    });
  }

  async enqueueProvider(
    kind: 'TEST_PROVIDER' | 'SYNC_PROVIDER',
    providerId: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    await this.assertProvider(providerId);
    return this.admission.admit({
      actionId: DNS_OPERATION_ACTIONS[kind],
      type: kind === 'TEST_PROVIDER' ? 'DNS_PROVIDER_TEST' : 'DNS_PROVIDER_SYNC',
      idempotencyKey,
      actor,
      request: { kind, providerId } satisfies ProviderRequest,
      deadlineMs: kind === 'TEST_PROVIDER' ? 5 * 60_000 : 15 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: `dns-provider:${providerId}`,
    });
  }

  async enqueueRefreshZone(
    zoneId: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    const zone = await this.assertZone(zoneId);
    return this.admission.admit({
      actionId: DNS_OPERATION_ACTIONS.REFRESH_ZONE,
      type: 'DNS_ZONE_REFRESH',
      idempotencyKey,
      actor,
      request: { kind: 'REFRESH_ZONE', zoneId } satisfies ZoneRequest,
      deadlineMs: 10 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: `dns-provider:${zone.accountId}`,
    });
  }

  async enqueueApplyTemplate(
    zoneId: string,
    dto: ApplyTemplateDto,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    const zone = await this.assertZone(zoneId);
    return this.admission.admit({
      actionId: DNS_OPERATION_ACTIONS.APPLY_TEMPLATE,
      type: 'DNS_ZONE_APPLY_TEMPLATE',
      idempotencyKey,
      actor,
      request: {
        kind: 'APPLY_TEMPLATE',
        zoneId,
        template: dto.template,
        ...(dto.extras ? { extras: { ...dto.extras } } : {}),
      } satisfies TemplateRequest,
      deadlineMs: 15 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: `dns-provider:${zone.accountId}`,
    });
  }

  private async execute(
    expectedKind: DnsOperationKind,
    request: unknown,
    context: OperationExecutionContext,
  ): Promise<unknown> {
    const payload = validateRequest(request);
    if (payload.kind !== expectedKind) {
      throw new BadRequestException('DNS operation action does not match its payload');
    }
    if (context.recovering) {
      if (payload.kind === 'CREATE_PROVIDER') {
        const existing = await this.prisma.dnsProviderAccount.findUnique({
          where: { id: payload.providerId },
          select: { id: true },
        });
        if (existing) return { providerId: existing.id, recovered: true };
      }
      throw new OperationNeedsAttentionError(
        'DNS provider operation was interrupted; reconcile provider state before retrying',
      );
    }
    await context.throwIfCancellationRequested();
    if (payload.kind === 'CREATE_PROVIDER') {
      let decrypted: unknown;
      try {
        decrypted = decryptJson(payload.payloadEnc);
      } catch {
        throw new BadRequestException('DNS provider operation credentials cannot be decrypted');
      }
      const dto = validateDto(CreateProviderDto, decrypted);
      const provider = await this.dns.createProvider(dto, payload.providerId);
      return { providerId: provider.id, provider };
    }
    if (payload.kind === 'TEST_PROVIDER') {
      return this.dns.testProvider(payload.providerId);
    }
    if (payload.kind === 'SYNC_PROVIDER') {
      return this.dns.syncProviderFull(payload.providerId);
    }
    if (payload.kind === 'REFRESH_ZONE') {
      await this.dns.refreshRecords(payload.zoneId);
      return { zoneId: payload.zoneId, refreshed: true };
    }
    if (payload.kind !== 'APPLY_TEMPLATE') {
      throw new BadRequestException('DNS operation request is invalid');
    }
    return this.dns.applyMailTemplate(payload.zoneId, validateDto(ApplyTemplateDto, {
      template: payload.template,
      ...(payload.extras ? { extras: payload.extras } : {}),
    }));
  }

  private async assertProvider(providerId: string): Promise<void> {
    const provider = await this.prisma.dnsProviderAccount.findUnique({
      where: { id: providerId },
      select: { id: true },
    });
    if (!provider) throw new NotFoundException('DNS provider not found');
  }

  private async assertZone(zoneId: string): Promise<{ accountId: string }> {
    const zone = await this.prisma.dnsZone.findUnique({
      where: { id: zoneId },
      select: { accountId: true },
    });
    if (!zone) throw new NotFoundException('DNS zone not found');
    return zone;
  }
}
