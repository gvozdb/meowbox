import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { BackupsService } from './backups.service';

const BACKUP_DELETE_ACTION = 'backups.delete';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validateRequest(request: unknown): { backupId: string } {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new BadRequestException('Backup delete operation request is invalid');
  }
  const value = request as Record<string, unknown>;
  if (
    Object.keys(value).join(',') !== 'backupId' ||
    typeof value.backupId !== 'string' ||
    !UUID.test(value.backupId)
  ) {
    throw new BadRequestException('Backup delete operation request is invalid');
  }
  return value as { backupId: string };
}

@Injectable()
export class BackupDeleteOperationsService implements OnModuleInit, OnModuleDestroy {
  private unregisterHandler: (() => void) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly backups: BackupsService,
    private readonly admission: OperationAdmissionService,
    private readonly worker: OperationsWorkerService,
  ) {}

  onModuleInit(): void {
    this.unregisterHandler = this.worker.registerHandler(
      BACKUP_DELETE_ACTION,
      (request, context) => this.execute(request, context),
    );
  }

  onModuleDestroy(): void {
    this.unregisterHandler?.();
    this.unregisterHandler = null;
  }

  async enqueue(
    backupId: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    validateRequest({ backupId });
    const backup = await this.authorizedBackup(backupId, actor);
    if (backup.status === 'PENDING' || backup.status === 'IN_PROGRESS') {
      throw new ConflictException('Active backup cannot be deleted');
    }
    return this.admission.admit({
      actionId: BACKUP_DELETE_ACTION,
      type: 'BACKUP_DELETE',
      idempotencyKey,
      actor,
      request: { backupId },
      deadlineMs: 2 * 60 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: `backup-delete:${backupId}`,
      siteId: backup.siteId,
      lockSite: false,
    });
  }

  private async execute(
    request: unknown,
    context: OperationExecutionContext,
  ): Promise<{ backupId: string; deleted: true; result?: unknown }> {
    const { backupId } = validateRequest(request);
    const backup = await this.prisma.backup.findUnique({
      where: { id: backupId },
      select: { id: true },
    });
    if (!backup) {
      if (context.recovering) return { backupId, deleted: true };
      throw new NotFoundException('Backup not found');
    }
    if (context.recovering) {
      throw new OperationNeedsAttentionError(
        'Backup deletion was interrupted before its postcondition was confirmed',
      );
    }
    await context.throwIfCancellationRequested();
    const result = await this.backups.deleteBackup(
      backupId,
      context.actor.userId,
      context.actor.role,
    );
    return { backupId, deleted: true, result };
  }

  private async authorizedBackup(
    backupId: string,
    actor: { userId: string; role: string },
  ) {
    const backup = await this.prisma.backup.findUnique({
      where: { id: backupId },
      select: {
        id: true,
        siteId: true,
        status: true,
        site: { select: { userId: true } },
      },
    });
    if (!backup) throw new NotFoundException('Backup not found');
    if (actor.role !== 'ADMIN' && backup.site.userId !== actor.userId) {
      throw new ForbiddenException('Access denied');
    }
    return backup;
  }
}
