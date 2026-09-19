import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { OperationAdmissionService } from '../operations/operation-admission.service';
import {
  OperationFailedError,
  OperationNeedsAttentionError,
} from '../operations/operation-errors';
import {
  OperationsWorkerService,
  type OperationExecutionContext,
} from '../operations/operations-worker.service';
import { HOSTNAME_REGISTRY_LOCK } from './hostname-registry';
import { DeleteSiteOptionsDto } from './sites.dto';
import { SitesService } from './sites.service';

const SITE_DELETE_ACTION = 'sites.delete';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPTION_KEYS = [
  'confirmDataDeletion',
  'confirmSiteName',
  'removeBackupsLocal',
  'removeBackupsRemote',
  'removeBackupsRestic',
  'removeDatabases',
  'removeFiles',
  'removeMinioData',
  'removeNginxConfig',
  'removePhpPool',
  'removeSslCertificate',
  'removeSystemUser',
] as const;
const BOOLEAN_OPTION_KEYS = OPTION_KEYS.filter(
  (key) => key !== 'confirmSiteName',
);

interface SiteDeleteRequest {
  siteId: string;
  options: DeleteSiteOptionsDto;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function validateRequest(request: unknown): SiteDeleteRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new BadRequestException('Site delete operation request is invalid');
  }
  const value = request as Record<string, unknown>;
  if (!exactKeys(value, ['options', 'siteId'])) {
    throw new BadRequestException('Site delete operation request is invalid');
  }
  if (typeof value.siteId !== 'string' || !UUID.test(value.siteId)) {
    throw new BadRequestException('Site delete operation request is invalid');
  }
  if (
    !value.options ||
    typeof value.options !== 'object' ||
    Array.isArray(value.options)
  ) {
    throw new BadRequestException('Site delete operation request is invalid');
  }
  const options = value.options as Record<string, unknown>;
  if (
    !exactKeys(options, OPTION_KEYS) ||
    typeof options.confirmSiteName !== 'string' ||
    options.confirmSiteName.length === 0 ||
    options.confirmSiteName.length > 32 ||
    BOOLEAN_OPTION_KEYS.some((key) => typeof options[key] !== 'boolean') ||
    options.confirmDataDeletion !== true
  ) {
    throw new BadRequestException('Site delete operation request is invalid');
  }
  return {
    siteId: value.siteId,
    options: Object.fromEntries(
      OPTION_KEYS.map((key) => [key, options[key]]),
    ) as unknown as DeleteSiteOptionsDto,
  };
}

@Injectable()
export class SiteDeleteOperationsService
  implements OnModuleInit, OnModuleDestroy
{
  private unregisterHandler: (() => void) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SitesService,
    private readonly admission: OperationAdmissionService,
    private readonly worker: OperationsWorkerService,
  ) {}

  onModuleInit(): void {
    this.unregisterHandler = this.worker.registerHandler(
      SITE_DELETE_ACTION,
      (request, context) => this.execute(request, context),
    );
  }

  onModuleDestroy(): void {
    this.unregisterHandler?.();
    this.unregisterHandler = null;
  }

  async enqueue(
    siteId: string,
    actor: { userId: string; role: string },
    options: DeleteSiteOptionsDto,
    idempotencyKey?: string,
  ) {
    if (actor.role !== 'ADMIN') {
      throw new ForbiddenException('Only administrators can delete sites');
    }
    const request = validateRequest({ siteId, options });
    const admit = () => this.admission.admit({
      actionId: SITE_DELETE_ACTION,
      type: 'SITE_DELETE',
      idempotencyKey,
      actor,
      request,
      deadlineMs: 4 * 60 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: HOSTNAME_REGISTRY_LOCK,
      siteId: request.siteId,
      lockSite: true,
    });
    const replayKey = idempotencyKey?.trim();
    if (replayKey) {
      const existing = await this.prisma.operation.findUnique({
        where: { idempotencyKey: replayKey },
        select: { id: true },
      });
      if (existing) return admit();
    }
    await this.sites.assertDeleteReady(
      request.siteId,
      actor.userId,
      actor.role,
      request.options,
    );
    return admit();
  }

  private async execute(
    rawRequest: unknown,
    context: OperationExecutionContext,
  ): Promise<{ deletedSiteId: string; siteName: string }> {
    const request = validateRequest(rawRequest);
    if (context.actor.role !== 'ADMIN') {
      throw new OperationFailedError(
        'Only administrators can delete sites',
      );
    }

    const site = await this.prisma.site.findUnique({
      where: { id: request.siteId },
      select: { id: true },
    });
    if (!site) {
      if (!context.recovering) {
        throw new OperationFailedError('Site not found');
      }
      await this.sites.cleanupDeleteOperationSnapshots(context);
      return {
        deletedSiteId: request.siteId,
        siteName: request.options.confirmSiteName,
      };
    }
    if (context.recovering) {
      const message =
        'Site deletion was interrupted before its postcondition was confirmed';
      await this.sites.markDeleteRecoveryAttention(request.siteId, message);
      throw new OperationNeedsAttentionError(message);
    }

    return this.sites.executeDelete(
      request.siteId,
      request.options,
      context,
    );
  }
}
