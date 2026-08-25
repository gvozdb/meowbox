/**
 * BackupExportsService — экспорт Restic-снапшота в скачиваемый архив (.tar).
 *
 * Два режима работы:
 *
 *  STREAM (single-host):
 *    API сама спавнит `restic dump <snap> / --archive tar`, читает stdout и
 *    пишет в HTTP response. Без диска, без сокетов. Back-pressure через
 *    Node Streams. Работает только если на API-хосте установлен restic
 *    (стандартная инсталляция: API + agent на одной машине).
 *
 *  S3_PRESIGNED (S3-хранилище):
 *    Агент делает `restic dump --archive tar` и стримит stdout прямо в S3
 *    (multipart upload в тот же bucket под `exports/<id>.tar`). После
 *    завершения API возвращает pre-signed URL — клиент качает напрямую
 *    из S3, минуя VPS. После expiresAt cron-cleaner удаляет S3-объект
 *    и помечает запись EXPIRED.
 *
 * Для не-S3 хранилищ (LOCAL/Yandex/Mail.ru) доступен только STREAM.
 * Для S3 — оба, выбор юзера в UI.
 */

import {
  Injectable, Logger, NotFoundException, BadRequestException,
  ForbiddenException, ConflictException, OnModuleInit, OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { validatePublicDelivery, type ExternalProviderDelivery, type PublicDelivery } from '@meowbox/shared';
import { spawn, type ChildProcess } from 'child_process';
import { Response } from 'express';
import { PassThrough, Readable } from 'node:stream';
import { PrismaService } from '../common/prisma.service';
import { StorageLocationsService } from '../storage-locations/storage-locations.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { attachmentDisposition } from '../common/http/content-disposition';
import {
  BackupEngine, BackupStatus, BackupExportMode, BackupExportStatus,
  BackupStorageType,
} from '../common/enums';
import {
  S3Client, GetObjectCommand, DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PanelIdentityService } from '../federation/panel-identity.service';
import { TransferSessionService } from '../transfers/transfer-session.service';
import { TransferArtifactService } from '../transfers/transfer-artifact.service';
import { OperationAdmissionService } from '../operations/operation-admission.service';
import {
  OperationCancelledError,
  type OperationExecutionContext,
  OperationsWorkerService,
} from '../operations/operations-worker.service';
import { OperationNeedsAttentionError } from '../operations/operation-errors';
import { OperationsService } from '../operations/operations.service';

const STAGED_EXPORT_ACTION = 'http.post.backup-exports-staged';
const DEFAULT_STAGED_MAX_BYTES = 50 * 1024 ** 3;
const MIN_STAGED_RESERVATION_BYTES = 512 * 1024 ** 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Короткий TTL для download-токена. Токен живёт минимально, чтобы:
//   - не утечь в логи nginx надолго (replay window мал);
//   - юзер всё равно может перезапросить через /issue-token.
// Конфигурируется через DOWNLOAD_TOKEN_TTL_SEC env var (default 600 = 10 мин).
function readPositiveInt(env: ConfigService, key: string, fallback: number): number {
  const raw = env.get<string | number>(key);
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface CreateExportInput {
  backupId: string;
  mode: 'STREAM' | 'S3_PRESIGNED';
  ttlHours: number;
  userId: string;
  role: string;
}

interface CreateStagedExportInput {
  backupId: string;
  ttlHours: number;
  userId: string;
  role: string;
  idempotencyKey: string | undefined;
}

@Injectable()
export class BackupExportsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('BackupExportsService');

  // Лимиты TTL экспорта: от 1 часа до 30 дней.
  // Конфигурируется через BACKUP_EXPORT_*_TTL_HOURS, чтобы оператор мог
  // сузить (DLP/compliance) или расширить (большие архивы качаются долго).
  readonly MIN_TTL_HOURS: number;
  readonly MAX_TTL_HOURS: number;
  readonly DEFAULT_TTL_HOURS: number;

  // Лимит одновременных STREAM-экспортов per-user — DoS-protection: каждый
  // download спавнит restic-процесс. Без лимита один валидный URL можно
  // открыть N раз и убить сервер.
  private readonly maxConcurrentStreamPerUser: number;

  // Конфигурируемый retention для удаления старых EXPIRED записей из БД.
  private readonly expiredRetentionMs: number;
  // Размер batch'а в cron-cleanup. На больших объёмах поднимаем лимит +
  // делаем until-empty loop (см. cleanupExpiredExports).
  private readonly cleanupBatchSize: number;

  private readonly presignedTtlSec: number;
  private readonly generatedStreamIdleMs: number;
  private readonly stagedMaxBytes: number;
  private unregisterTransferSource: (() => void) | null = null;
  private unregisterOperationHandler: (() => void) | null = null;
  private readonly streamProcesses = new Set<ChildProcess>();
  private readonly killTimers = new Map<number, NodeJS.Timeout>();

  // Активные STREAM-сессии per-user (in-memory счётчик).
  private readonly activeStreams = new Map<string, number>();

  // In-memory прогресс агентского S3 dump'а. Ключ — exportId, значение — байты + ts.
  // Намеренно НЕ пишем в БД на каждом тике (раз в 5s × десятки экспортов = бессмысленный
  // wear). Финальный sizeBytes сохраняется в БД через handleAgentExportComplete.
  // Запись чистится в handleAgentExportComplete (success/fail) и в markFailed.
  private readonly exportProgress = new Map<string, {
    bytesRead: number;
    bytesUploaded: number;
    elapsedMs: number;
    updatedAt: number;
  }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageLocations: StorageLocationsService,
    private readonly agentRelay: AgentRelayService,
    private readonly config: ConfigService,
    private readonly transfers: TransferSessionService,
    private readonly identity: PanelIdentityService,
    private readonly artifacts: TransferArtifactService,
    private readonly admission: OperationAdmissionService,
    private readonly worker: OperationsWorkerService,
    private readonly operations: OperationsService,
  ) {
    this.MIN_TTL_HOURS = readPositiveInt(config, 'BACKUP_EXPORT_MIN_TTL_HOURS', 1);
    this.MAX_TTL_HOURS = readPositiveInt(config, 'BACKUP_EXPORT_MAX_TTL_HOURS', 24 * 30);
    this.DEFAULT_TTL_HOURS = readPositiveInt(config, 'BACKUP_EXPORT_DEFAULT_TTL_HOURS', 7);
    this.maxConcurrentStreamPerUser = readPositiveInt(
      config, 'BACKUP_EXPORT_MAX_CONCURRENT_STREAM', 2,
    );
    this.expiredRetentionMs = readPositiveInt(
      config, 'BACKUP_EXPORT_RETENTION_DAYS', 7,
    ) * 24 * 3600_000;
    this.cleanupBatchSize = readPositiveInt(
      config, 'BACKUP_EXPORT_CLEANUP_BATCH', 200,
    );
    this.presignedTtlSec = Math.min(
      readPositiveInt(config, 'BACKUP_EXPORT_PRESIGNED_TTL_SEC', 3600),
      7 * 24 * 3600,
    );
    this.generatedStreamIdleMs = readPositiveInt(
      config,
      'TRANSFER_GENERATED_STREAM_IDLE_MS',
      60_000,
    );
    this.stagedMaxBytes = Math.min(
      readPositiveInt(config, 'BACKUP_EXPORT_STAGED_MAX_BYTES', DEFAULT_STAGED_MAX_BYTES),
      DEFAULT_STAGED_MAX_BYTES,
    );
  }

  onModuleInit(): void {
    this.unregisterTransferSource = this.transfers.registerGeneratedSource('BACKUP_EXPORT', {
      stream: (resourceId, actor, response) => this.streamDownload(
        resourceId,
        actor.userId,
        actor.role,
        response,
      ),
    });
    this.unregisterOperationHandler = this.worker.registerHandler(
      STAGED_EXPORT_ACTION,
      (request, context) => this.prepareStagedExport(request, context),
    );
  }

  onModuleDestroy(): void {
    this.unregisterTransferSource?.();
    this.unregisterTransferSource = null;
    this.unregisterOperationHandler?.();
    this.unregisterOperationHandler = null;
    for (const process of this.streamProcesses) this.terminateProcess(process);
  }

  async issueDelivery(exportId: string, userId: string, role: string): Promise<PublicDelivery> {
    const row = await this.prisma.backupExport.findUnique({
      where: { id: exportId },
      include: {
        backup: {
          include: {
            site: { select: { name: true, userId: true } },
            storageLocation: true,
          },
        },
      },
    });
    if (!row) throw new NotFoundException('Export not found');
    if (role !== 'ADMIN' && row.backup.site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Экспорт истёк');
    }
    if (row.status !== BackupExportStatus.READY) {
      throw new BadRequestException(`Экспорт не готов (status=${row.status})`);
    }
    if (row.mode === BackupExportMode.STREAM) {
      if (!row.backup.resticSnapshotId) throw new BadRequestException('У бэкапа нет snapshotId');
      return this.transfers.issueGeneratedStream({
        sourceKind: 'BACKUP_EXPORT',
        resourceId: row.id,
        actor: { userId, role },
        filename: this.exportFilename(row.backup.site.name, row.backup.resticSnapshotId),
        contentType: 'application/x-tar',
        resourceExpiresAt: row.expiresAt,
      });
    }
    if (row.mode === BackupExportMode.STAGED_ARTIFACT) {
      if (!row.artifactId) throw new BadRequestException('Экспорт не имеет готового артефакта');
      return this.transfers.issueStagedArtifact({
        artifactId: row.artifactId,
        actor: { userId, role },
      });
    }
    if (
      row.mode !== BackupExportMode.S3_PRESIGNED ||
      !row.s3Key ||
      !row.backup.storageLocation
    ) {
      throw new BadRequestException('Экспорт не имеет доступного артефакта');
    }
    const loc = await this.storageLocations.getFullConfigForAgent(row.backup.storageLocation.id);
    if (loc.type !== BackupStorageType.S3) {
      throw new BadRequestException('Экспорт не связан с S3-хранилищем');
    }
    const now = Date.now();
    const deliveryExpiresAt = new Date(Math.min(
      row.expiresAt.getTime(),
      now + this.presignedTtlSec * 1000,
    ));
    if (deliveryExpiresAt.getTime() <= now + 1_000) {
      throw new BadRequestException('Экспорт истёк');
    }
    const url = await this.generatePresignedUrl(loc.config, row.s3Key, deliveryExpiresAt);
    const localIdentity = await this.identity.getLocalIdentity();
    const delivery: ExternalProviderDelivery = {
      kind: 'ExternalProvider',
      purpose: 'DOWNLOAD',
      targetInstallationId: localIdentity.installationId,
      resource: { kind: 'BACKUP_EXPORT', id: row.id },
      method: 'GET',
      allowedHeaders: [],
      cachePolicy: 'NO_STORE',
      referrerPolicy: 'NO_REFERRER',
      expiresAt: deliveryExpiresAt.toISOString(),
      browserReachabilityRequired: false,
      rangeSupported: true,
      resumeSupported: true,
      fallbackReason: null,
      url,
      reusable: true,
      provider: 'S3',
    };
    return validatePublicDelivery(delivery);
  }

  // ---------------------------------------------------------------------------
  // Создание export-записи + триггер обработки.
  // ---------------------------------------------------------------------------

  async createExport(input: CreateExportInput) {
    const { backupId, userId, role } = input;
    const ttlHours = this.clampTtl(input.ttlHours);
    const backup = await this.requireExportableBackup(backupId, userId, role);

    // S3_PRESIGNED — только для S3-хранилищ. Иначе агенту некуда заливать.
    const isS3Storage = backup.storageLocation!.type === BackupStorageType.S3;
    if (input.mode === 'S3_PRESIGNED' && !isS3Storage) {
      throw new BadRequestException(
        'Режим S3_PRESIGNED доступен только для S3-хранилищ. Используй STREAM.',
      );
    }

    // Дедуп: если уже есть активный экспорт того же режима для этого бэкапа,
    // не создаём дубль. Delivery выдаётся отдельно короткоживущей сессией.
    const existing = await this.prisma.backupExport.findFirst({
      where: {
        backupId,
        mode: input.mode,
        status: { in: [BackupExportStatus.PENDING, BackupExportStatus.PROCESSING, BackupExportStatus.READY] },
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      return this.serializeExport(existing);
    }

    const expiresAt = new Date(Date.now() + ttlHours * 3600_000);

    const exportRow = await this.prisma.backupExport.create({
      data: {
        backupId,
        mode: input.mode,
        status: input.mode === 'STREAM'
          ? BackupExportStatus.READY  // STREAM готов сразу — стриминг идёт в момент GET /download
          : BackupExportStatus.PENDING,
        expiresAt,
        createdByUserId: userId,
      },
    });

    if (input.mode === 'STREAM') {
      return this.serializeExport(exportRow);
    }

    // S3_PRESIGNED: запускаем фоновую задачу
    this.startS3Export(exportRow.id).catch((err) => {
      this.logger.error(`S3 export ${exportRow.id} failed: ${(err as Error).message}`);
    });
    return exportRow;
  }

  async createStagedExport(input: CreateStagedExportInput) {
    const { backupId, userId, role } = input;
    const ttlHours = this.clampTtl(input.ttlHours);
    const backup = await this.requireExportableBackup(backupId, userId, role);

    const existing = await this.prisma.backupExport.findFirst({
      where: {
        backupId,
        mode: BackupExportMode.STAGED_ARTIFACT,
        status: {
          in: [
            BackupExportStatus.PENDING,
            BackupExportStatus.PROCESSING,
            BackupExportStatus.READY,
          ],
        },
        expiresAt: { gt: new Date() },
        OR: [
          { status: BackupExportStatus.READY },
          { operationId: { not: null } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      const operation = existing.operationId
        ? await this.prisma.operation.findUnique({
            where: { id: existing.operationId },
            select: { status: true },
          })
        : null;
      if (existing.status !== BackupExportStatus.READY && !operation) {
        await this.prisma.backupExport.update({
          where: { id: existing.id },
          data: {
            status: BackupExportStatus.FAILED,
            errorMessage: 'Операция подготовки экспорта потеряна',
          },
        });
      } else {
        return {
          export: this.serializeExport(existing),
          operation: existing.operationId && operation
            ? {
                operationId: existing.operationId,
                state: operation.status,
                replayed: true,
                statusPath: `/api/operations/${existing.operationId}`,
                retryAfterSeconds: 1,
              }
            : null,
        };
      }
    }

    const exportRow = await this.prisma.backupExport.create({
      data: {
        backupId,
        mode: BackupExportMode.STAGED_ARTIFACT,
        status: BackupExportStatus.PENDING,
        expiresAt: new Date(Date.now() + ttlHours * 3600_000),
        createdByUserId: userId,
      },
    });
    try {
      const operation = await this.admission.admit({
        actionId: STAGED_EXPORT_ACTION,
        type: 'BACKUP_EXPORT_STAGE',
        idempotencyKey: input.idempotencyKey,
        actor: { userId, role },
        request: { exportId: exportRow.id },
        deadlineMs: 24 * 60 * 60_000,
        recoveryPolicy: 'RECONCILE_ONLY',
        retryable: false,
        globalLockKey: `backup-export:${backupId}`,
        siteId: backup.siteId,
      });
      const linked = await this.prisma.backupExport.update({
        where: { id: exportRow.id },
        data: { operationId: operation.operationId },
      });
      return { export: this.serializeExport(linked), operation };
    } catch (error) {
      await this.prisma.backupExport.deleteMany({
        where: { id: exportRow.id, operationId: null },
      });
      throw error;
    }
  }

  private async prepareStagedExport(
    request: unknown,
    context: OperationExecutionContext,
  ): Promise<unknown> {
    const exportId = this.stagedExportId(request);
    const row = await this.prisma.backupExport.findUnique({
      where: { id: exportId },
      include: {
        backup: {
          include: {
            site: { select: { name: true, rootPath: true } },
            storageLocation: true,
          },
        },
      },
    });
    if (!row || row.mode !== BackupExportMode.STAGED_ARTIFACT) {
      throw new OperationNeedsAttentionError('Staged backup export is unavailable');
    }
    if (
      context.actor.kind !== 'OPERATOR' ||
      !['ADMIN', 'MANAGER'].includes(context.actor.role) ||
      context.actor.userId !== row.createdByUserId
    ) {
      throw new OperationNeedsAttentionError('Staged backup export actor binding mismatch');
    }
    if (row.operationId === null) {
      const bound = await this.prisma.backupExport.updateMany({
        where: {
          id: row.id,
          operationId: null,
          createdByUserId: context.actor.userId,
        },
        data: { operationId: context.operationId },
      });
      if (bound.count !== 1) {
        throw new OperationNeedsAttentionError('Staged backup export operation binding changed');
      }
      row.operationId = context.operationId;
    }
    if (row.operationId !== context.operationId) {
      throw new OperationNeedsAttentionError('Staged backup export operation binding mismatch');
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      await this.prisma.backupExport.update({
        where: { id: row.id },
        data: { status: BackupExportStatus.EXPIRED, errorMessage: null },
      });
      throw new OperationNeedsAttentionError('Staged backup export expired before preparation');
    }

    if (row.artifactId) {
      const artifact = await this.prisma.transferArtifact.findUnique({
        where: { id: row.artifactId },
      });
      if (
        artifact?.state === 'READY' &&
        !artifact.deletedAt &&
        artifact.sourceKind === 'BACKUP_EXPORT' &&
        artifact.resourceId === row.id &&
        artifact.createdByUserId === row.createdByUserId &&
        artifact.expiresAt.getTime() > Date.now() &&
        artifact.sizeBytes !== null &&
        artifact.sha256
      ) {
        await this.prisma.backupExport.update({
          where: { id: row.id },
          data: {
            status: BackupExportStatus.READY,
            sizeBytes: artifact.sizeBytes,
            errorMessage: null,
          },
        });
        return {
          exportId: row.id,
          artifactId: artifact.id,
          sizeBytes: Number(artifact.sizeBytes),
          sha256: artifact.sha256,
          reconciled: context.recovering,
        };
      }
      await this.artifacts.revoke({
        artifactId: row.artifactId,
        sourceKind: 'BACKUP_EXPORT',
        resourceId: row.id,
        createdByUserId: row.createdByUserId,
      });
      await this.prisma.backupExport.update({
        where: { id: row.id },
        data: { artifactId: null },
      });
    }

    if (context.recovering) {
      await this.prisma.backupExport.update({
        where: { id: row.id },
        data: {
          status: BackupExportStatus.FAILED,
          errorMessage: 'Подготовка была прервана; требуется новый экспорт',
        },
      });
      throw new OperationNeedsAttentionError(
        'Interrupted staged export has no complete artifact and cannot be resumed',
      );
    }

    if (!row.backup.storageLocation || !row.backup.resticSnapshotId) {
      await this.failStagedExport(row.id, context.operationId, 'Хранилище или snapshot недоступны');
      throw new OperationNeedsAttentionError('Backup storage or snapshot is unavailable');
    }
    let location: Awaited<ReturnType<StorageLocationsService['getFullConfigForAgent']>>;
    try {
      location = await this.storageLocations.getFullConfigForAgent(
        row.backup.storageLocation.id,
      );
    } catch (error) {
      await this.failStagedExport(row.id, context.operationId, 'Не удалось открыть хранилище');
      throw error;
    }
    if (!location.resticPassword) {
      await this.failStagedExport(row.id, context.operationId, 'У хранилища нет Restic-пароля');
      throw new OperationNeedsAttentionError('Backup storage has no Restic password');
    }
    const expectedMaxBytes = this.expectedStagedBytes(row.backup.sizeBytes);
    const repository = this.buildResticRepoUrl(
      location.type,
      location.config,
      row.backup.site.name,
    );
    const resticArgs = [
      '-r', repository,
      ...(location.type === BackupStorageType.S3 ? ['-o', 's3.connections=32'] : []),
      'dump', row.backup.resticSnapshotId,
      row.backup.site.rootPath,
      '--archive', 'tar',
    ];
    const child = spawn('restic', resticArgs, {
      env: this.buildResticEnv(location.type, location.config, location.resticPassword),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.streamProcesses.add(child);
    child.once('close', () => {
      this.streamProcesses.delete(child);
      this.clearKillTimer(child.pid);
    });
    // Drain stderr so Restic cannot block on a full pipe. Its contents may
    // contain storage endpoints and never enter API logs or operation results.
    child.stderr.resume();

    let cancellationObserved = false;
    let deadlineExceeded = false;
    let cancellationCheckRunning = false;
    const cancellationTimer = setInterval(() => {
      if (cancellationCheckRunning || cancellationObserved) return;
      cancellationCheckRunning = true;
      void context.isCancellationRequested()
        .then((requested) => {
          if (requested) {
            cancellationObserved = true;
            this.terminateProcess(child);
          }
        })
        .finally(() => { cancellationCheckRunning = false; });
    }, 500);
    cancellationTimer.unref();
    const deadlineTimer = setTimeout(() => {
      deadlineExceeded = true;
      this.terminateProcess(child);
    }, Math.max(1, context.deadlineAt.getTime() - Date.now()));
    deadlineTimer.unref();

    try {
      await this.prisma.backupExport.update({
        where: { id: row.id },
        data: { status: BackupExportStatus.PROCESSING, errorMessage: null },
      });
      await context.heartbeat('stage_artifact', 1);
      const staged = await this.artifacts.stage({
        sourceKind: 'BACKUP_EXPORT',
        resourceId: row.id,
        actor: { userId: row.createdByUserId, role: context.actor.role },
        filename: this.exportFilename(row.backup.site.name, row.backup.resticSnapshotId),
        contentType: 'application/x-tar',
        expiresAt: row.expiresAt,
        expectedMaxBytes,
        source: this.validatedResticOutput(child),
        onArtifactCreated: async (artifactId) => {
          const linked = await this.prisma.backupExport.updateMany({
            where: {
              id: row.id,
              operationId: context.operationId,
              artifactId: null,
              status: BackupExportStatus.PROCESSING,
            },
            data: { artifactId },
          });
          if (linked.count !== 1) throw new Error('Backup export artifact link changed');
        },
        onProgress: async (sizeBytes) => {
          const progress = Math.max(1, Math.min(95, Math.floor(
            sizeBytes / Math.max(1, expectedMaxBytes) * 95,
          )));
          await context.heartbeat('stage_artifact', progress);
        },
      });
      const finalized = await this.prisma.backupExport.updateMany({
        where: {
          id: row.id,
          operationId: context.operationId,
          artifactId: staged.artifactId,
          status: BackupExportStatus.PROCESSING,
        },
        data: {
          status: BackupExportStatus.READY,
          sizeBytes: BigInt(staged.sizeBytes),
          errorMessage: null,
        },
      });
      if (finalized.count !== 1) throw new Error('Backup export finalization changed');
      return {
        exportId: row.id,
        artifactId: staged.artifactId,
        sizeBytes: staged.sizeBytes,
        sha256: staged.sha256,
        reconciled: false,
      };
    } catch (error) {
      this.terminateProcess(child);
      const cancelled = cancellationObserved || await context
        .isCancellationRequested()
        .catch(() => false);
      const errorMessage = cancelled
        ? 'Подготовка экспорта отменена'
        : deadlineExceeded
          ? 'Истёк срок подготовки экспорта'
          : 'Не удалось подготовить экспорт';
      await this.prisma.backupExport.updateMany({
        where: { id: row.id, operationId: context.operationId },
        data: { status: BackupExportStatus.FAILED, errorMessage },
      });
      if (cancelled) throw new OperationCancelledError();
      throw error;
    } finally {
      clearInterval(cancellationTimer);
      clearTimeout(deadlineTimer);
    }
  }

  private stagedExportId(request: unknown): string {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new OperationNeedsAttentionError('Staged backup export request is invalid');
    }
    const record = request as Record<string, unknown>;
    if (
      Object.keys(record).length !== 1 ||
      typeof record.exportId !== 'string' ||
      !UUID.test(record.exportId)
    ) {
      throw new OperationNeedsAttentionError('Staged backup export request is invalid');
    }
    return record.exportId;
  }

  private async failStagedExport(
    exportId: string,
    operationId: string,
    errorMessage: string,
  ): Promise<void> {
    await this.prisma.backupExport.updateMany({
      where: { id: exportId, operationId },
      data: {
        status: BackupExportStatus.FAILED,
        errorMessage: errorMessage.slice(0, 500),
      },
    });
  }

  private expectedStagedBytes(logicalBytes: bigint | null): number {
    if (logicalBytes === null || logicalBytes <= 0n || logicalBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
      return this.stagedMaxBytes;
    }
    const logical = Number(logicalBytes);
    return Math.min(
      this.stagedMaxBytes,
      Math.max(MIN_STAGED_RESERVATION_BYTES, logical * 2),
    );
  }

  private validatedResticOutput(child: ChildProcess): Readable {
    if (!child.stdout) throw new Error('Restic output pipe is unavailable');
    const output = new PassThrough();
    child.stdout.pipe(output, { end: false });
    child.stdout.once('error', (error) => output.destroy(error));
    child.once('error', (error) => output.destroy(error));
    child.once('close', (code, signal) => {
      if (code === 0) {
        output.end();
        return;
      }
      output.destroy(new Error(
        signal
          ? `Restic export process terminated by ${signal}`
          : `Restic export process exited with code ${code ?? 'unknown'}`,
      ));
    });
    return output;
  }

  private async requireExportableBackup(backupId: string, userId: string, role: string) {
    const backup = await this.prisma.backup.findUnique({
      where: { id: backupId },
      include: {
        site: { select: { name: true, userId: true, rootPath: true } },
        storageLocation: true,
      },
    });
    if (!backup) throw new NotFoundException('Backup not found');
    if (role !== 'ADMIN' && backup.site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    if (backup.status !== BackupStatus.COMPLETED) {
      throw new BadRequestException('Только завершённые бэкапы можно экспортировать');
    }
    if (backup.engine !== BackupEngine.RESTIC) {
      throw new BadRequestException(
        'Экспорт в архив доступен только для Restic-бэкапов. Для TAR-бэкапов используй обычное «Скачать».',
      );
    }
    if (!backup.resticSnapshotId || !backup.storageLocation) {
      throw new BadRequestException('У этого бэкапа нет snapshotId или удалено хранилище');
    }
    return backup;
  }

  private clampTtl(h: number): number {
    if (!Number.isFinite(h)) return this.DEFAULT_TTL_HOURS;
    return Math.max(
      this.MIN_TTL_HOURS,
      Math.min(this.MAX_TTL_HOURS, Math.floor(h)),
    );
  }

  // ---------------------------------------------------------------------------
  // S3-экспорт: пнуть агента, дождаться завершения, сгенерировать pre-signed URL.
  // ---------------------------------------------------------------------------

  private async startS3Export(exportId: string) {
    await this.prisma.backupExport.update({
      where: { id: exportId },
      data: { status: BackupExportStatus.PROCESSING },
    });

    const row = await this.prisma.backupExport.findUnique({
      where: { id: exportId },
      include: {
        backup: {
          include: {
            site: { select: { name: true, rootPath: true } },
            storageLocation: true,
          },
        },
      },
    });
    if (!row || !row.backup.storageLocation || !row.backup.resticSnapshotId) {
      await this.markFailed(exportId, 'Backup record disappeared');
      return;
    }

    const loc = await this.storageLocations.getFullConfigForAgent(row.backup.storageLocation.id);
    if (!loc.resticPassword) {
      await this.markFailed(exportId, 'У хранилища нет Restic-пароля');
      return;
    }

    const s3Key = `exports/${exportId}.tar`;

    // Сохраняем s3Key сразу — даже если агент потеряет коннект на полпути,
    // мы знаем какой объект чистить через cleanup.
    await this.prisma.backupExport.update({
      where: { id: exportId },
      data: { s3Key },
    });

    this.logger.log(
      `S3 export ${exportId}: emitting restic:dump-to-s3 to agent (snap=${row.backup.resticSnapshotId.slice(0, 8)}, key=${s3Key})`,
    );

    // Длинная задача: socket.io ack-таймаут не годится — агент может работать
    // часами над крупным бэкапом. Делаем fire-and-forget: эмитим event без
    // ожидания ack, агент по завершении сам пушит `backup-export:complete`,
    // который ловит agent.gateway.ts и обновляет запись в БД.
    try {
      this.agentRelay.emitToAgentAsync('restic:dump-to-s3', {
        exportId,
        siteName: row.backup.site.name,
        snapshotId: row.backup.resticSnapshotId,
        rootPath: row.backup.site.rootPath,
        storage: { type: loc.type, config: loc.config, password: loc.resticPassword },
        targetKey: s3Key,
      });
    } catch (err) {
      await this.markFailed(exportId, `agent emit failed: ${(err as Error).message}`);
      return;
    }
    // Дальше ждём backup-export:complete event от агента (см. handleAgentExportComplete).
  }

  // Вызывается из agent.gateway.ts на каждый тик прогресса от агента (раз в 5s).
  // Чисто in-memory — НЕ пишем в БД, чтобы не DDoS'ить SQLite/Postgres.
  recordExportProgress(payload: {
    exportId: string;
    bytesRead: number;
    bytesUploaded: number;
    elapsedMs: number;
  }) {
    if (!payload || typeof payload.exportId !== 'string') return;
    this.exportProgress.set(payload.exportId, {
      bytesRead: Number(payload.bytesRead) || 0,
      bytesUploaded: Number(payload.bytesUploaded) || 0,
      elapsedMs: Number(payload.elapsedMs) || 0,
      updatedAt: Date.now(),
    });
    // Anti-leak: ограничиваем размер map'а — на случай если экспорты не завершаются
    // и старые ключи копятся. 1000 — условный потолок на одну инсталляцию.
    if (this.exportProgress.size > 1000) {
      const oldest = [...this.exportProgress.entries()]
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
        .slice(0, this.exportProgress.size - 1000);
      for (const [k] of oldest) this.exportProgress.delete(k);
    }
  }

  // Вызывается из agent.gateway.ts когда агент сообщил о завершении экспорта.
  async handleAgentExportComplete(payload: {
    exportId: string;
    success: boolean;
    sizeBytes?: number;
    error?: string;
  }) {
    const row = await this.prisma.backupExport.findUnique({
      where: { id: payload.exportId },
      include: {
        backup: { include: { storageLocation: true } },
      },
    });
    if (!row) {
      this.logger.warn(`Got dump-to-s3 complete for unknown export ${payload.exportId}`);
      this.exportProgress.delete(payload.exportId);
      return;
    }
    // Прогресс больше не нужен — экспорт финализирован.
    this.exportProgress.delete(payload.exportId);
    if (!payload.success) {
      await this.markFailed(payload.exportId, payload.error || 'agent reported failure');
      return;
    }
    if (!row.backup.storageLocation || !row.s3Key) {
      await this.markFailed(payload.exportId, 'Storage location или s3Key пропали');
      return;
    }
    try {
      await this.prisma.backupExport.update({
        where: { id: payload.exportId },
        data: {
          status: BackupExportStatus.READY,
          downloadUrl: null,
          sizeBytes: payload.sizeBytes ? BigInt(payload.sizeBytes) : null,
        },
      });
      this.logger.log(`S3 export ${payload.exportId} ready (${payload.sizeBytes || '?'} bytes)`);
    } catch (err) {
      await this.markFailed(payload.exportId, `finalize failed: ${(err as Error).message}`);
    }
  }

  private async markFailed(exportId: string, msg: string) {
    this.exportProgress.delete(exportId);
    await this.prisma.backupExport.update({
      where: { id: exportId },
      data: { status: BackupExportStatus.FAILED, errorMessage: msg.slice(0, 500) },
    });
    this.logger.warn(`Export ${exportId} failed: ${msg}`);
  }

  // ---------------------------------------------------------------------------
  // Pre-signed URL — TTL вычисляем как (expiresAt - now).
  // ---------------------------------------------------------------------------

  private async generatePresignedUrl(
    s3Config: Record<string, string>,
    key: string,
    expiresAt: Date,
  ): Promise<string> {
    const client = this.buildS3Client(s3Config);
    const cmd = new GetObjectCommand({
      Bucket: s3Config.bucket,
      Key: key,
      // Имя файла при скачивании из браузера
      ResponseContentDisposition: `attachment; filename="${key.split('/').pop()}"`,
    });
    const ttlSec = Math.max(60, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    return getSignedUrl(client, cmd, { expiresIn: ttlSec });
  }

  private buildS3Client(cfg: Record<string, string>): S3Client {
    const region = cfg.region || this.config.get<string>('S3_DEFAULT_REGION') || 'us-east-1';
    // Если endpoint кастомный (не AWS) — используем path-style, как делает restic.
    const isCustomEndpoint = !!cfg.endpoint && !/amazonaws\.com/i.test(cfg.endpoint);
    return new S3Client({
      region,
      endpoint: cfg.endpoint || undefined,
      forcePathStyle: isCustomEndpoint,
      credentials: {
        accessKeyId: cfg.accessKey || '',
        secretAccessKey: cfg.secretKey || '',
      },
    });
  }

  // ---------------------------------------------------------------------------
  // STREAM-режим: спавним restic dump, пайпим stdout в HTTP response.
  // ---------------------------------------------------------------------------

  async streamDownload(exportId: string, userId: string, role: string, res: Response) {
    const row = await this.prisma.backupExport.findUnique({
      where: { id: exportId },
      include: {
        backup: {
          include: {
            site: { select: { name: true, rootPath: true, userId: true } },
            storageLocation: true,
          },
        },
      },
    });
    if (!row) throw new NotFoundException('Export not found');
    if (role !== 'ADMIN' && row.backup.site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      await this.prisma.backupExport.update({
        where: { id: exportId },
        data: { status: BackupExportStatus.EXPIRED },
      });
      throw new BadRequestException('Экспорт истёк, создайте новый');
    }
    if (row.mode !== BackupExportMode.STREAM) {
      throw new BadRequestException('Этот экспорт не в STREAM-режиме');
    }
    if (row.status !== BackupExportStatus.READY) {
      throw new BadRequestException(`Экспорт не готов (status=${row.status})`);
    }
    if (!row.backup.storageLocation || !row.backup.resticSnapshotId) {
      throw new BadRequestException('У бэкапа нет snapshotId или удалено хранилище');
    }

    const loc = await this.storageLocations.getFullConfigForAgent(row.backup.storageLocation.id);
    if (!loc.resticPassword) {
      throw new BadRequestException('У хранилища нет Restic-пароля');
    }

    // Per-user лимит одновременных STREAM-сессий: каждая = отдельный
    // restic-процесс + сетевой трафик. Без лимита один валидный URL
    // открытый N раз = DoS.
    const active = this.activeStreams.get(userId) || 0;
    if (active >= this.maxConcurrentStreamPerUser) {
      throw new ConflictException(
        `Превышен лимит одновременных скачиваний (${this.maxConcurrentStreamPerUser}). Дождитесь завершения текущих.`,
      );
    }
    this.activeStreams.set(userId, active + 1);
    const releaseSlot = () => {
      const cur = this.activeStreams.get(userId) || 0;
      if (cur <= 1) this.activeStreams.delete(userId);
      else this.activeStreams.set(userId, cur - 1);
    };

    const env = this.buildResticEnv(loc.type, loc.config, loc.resticPassword);
    const repo = this.buildResticRepoUrl(loc.type, loc.config, row.backup.site.name);

    // -o s3.connections=32 — параллельные коннекты к S3 backend.
    // restic dump делает много мелких range-запросов на pack-блобы.
    // С default=5 узкое место — TTFB ~140ms на каждый запрос, итого 100KB/s.
    // 32 параллельных коннекта перекрывают RTT-задержки и дают близкое
    // к реальному channel throughput скачивание.
    const isS3 = loc.type === 'S3';
    const args = [
      '-r', repo,
      ...(isS3 ? ['-o', 's3.connections=32'] : []),
      'dump', row.backup.resticSnapshotId,
      row.backup.site.rootPath,
      '--archive', 'tar',
    ];

    const filename = this.exportFilename(row.backup.site.name, row.backup.resticSnapshotId);

    this.logger.log(
      `STREAM export ${exportId}: spawning Restic source`,
    );

    // Сначала — спавним и буферизуем стартовое поведение, чтобы понять упал
    // restic или нет, ДО того как отправлять headers. Если стартовая ошибка
    // (типа repo unreachable / wrong password) — пользователь получит 500
    // c JSON-ошибкой, а не пустой tar-файл с status 200.
    const proc = spawn('restic', args, {
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.streamProcesses.add(proc);

    let earlyExitFired = false;
    proc.stderr.resume();

    // Если клиент отменил скачивание — убиваем restic + освобождаем слот.
    res.on('close', () => this.terminateProcess(proc));
    // Гарантированное освобождение слота при любом исходе.
    let slotReleased = false;
    const releaseOnce = () => { if (!slotReleased) { slotReleased = true; releaseSlot(); } };
    proc.on('exit', () => {
      this.streamProcesses.delete(proc);
      this.clearKillTimer(proc.pid);
      releaseOnce();
    });
    proc.on('error', () => {
      this.streamProcesses.delete(proc);
      this.clearKillTimer(proc.pid);
      releaseOnce();
    });
    res.on('close', releaseOnce);

    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        this.logger.warn(`STREAM export ${exportId}: idle timeout`);
        res.locals.transferFailureCode = 'IDLE_TIMEOUT';
        this.terminateProcess(proc);
        if (!res.destroyed) res.destroy(new Error('Generated stream idle timeout'));
      }, this.generatedStreamIdleMs);
      idleTimer.unref();
    };
    resetIdleTimer();
    proc.stdout.on('data', resetIdleTimer);
    const clearIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };
    proc.once('exit', clearIdleTimer);
    proc.once('error', clearIdleTimer);
    res.once('close', clearIdleTimer);

    proc.on('error', () => {
      this.logger.error(`STREAM export ${exportId}: Restic source failed to start`);
      res.locals.transferFailureCode = 'SOURCE_FAILED';
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'Backup export source failed to start' });
      }
    });

    // Ждём ЛИБО первый chunk stdout (значит стрим живой), ЛИБО exit-ошибку.
    // Это ловит быстрые failures (restic init / auth / снапшот не найден).
    // Pipe запускается только после получения первого chunk.
    let headersSent = false;
    const sendHeadersIfNeeded = () => {
      if (headersSent || res.headersSent) return;
      headersSent = true;
      res.setHeader('Content-Type', 'application/x-tar');
      // attachmentDisposition() — RFC 6266 + защита от CRLF/header-injection
      // даже если в будущем имя файла начнёт строиться из менее жёстких
      // источников (defense-in-depth).
      res.setHeader('Content-Disposition', attachmentDisposition(filename));
      // Cache-Control — чтобы прокси не трогали стрим
      res.setHeader('Cache-Control', 'no-store');
    };

    proc.stdout.once('data', (chunk: Buffer) => {
      // Первый байт пришёл — restic жив, отправляем headers и продолжаем pipe
      sendHeadersIfNeeded();
      this.logger.log(`STREAM export ${exportId}: first chunk received (${chunk.length} bytes)`);
      // Записываем первый chunk вручную, потом pipe остальное
      res.write(chunk);
      proc.stdout.pipe(res);
    });

    proc.on('exit', (code) => {
      if (earlyExitFired) return;
      earlyExitFired = true;
      this.logger.log(`STREAM export ${exportId}: Restic source exit code=${code}`);

      if (code === 0) {
        // Если был exit=0 ДО первого chunk — значит вывода не было вообще
        // (странно, но возможно — пустой rootPath?). Отдадим пустой tar.
        if (!headersSent) {
          sendHeadersIfNeeded();
          res.end();
        }
        // Если pipe уже шёл — он сам завершил response через 'end' event
      } else {
        res.locals.transferFailureCode = 'SOURCE_FAILED';
        if (!headersSent) {
          // Ничего ещё не отправили — можем отдать JSON-ошибку
          res.status(500).json({
            success: false,
            error: `Backup export source failed (exit ${code})`,
          });
        } else {
          // Стрим уже шёл — закрываем response с ошибкой
          res.destroy(new Error(`Backup export source failed (exit ${code})`));
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Вспомогательные: сборка repo-URL и env для restic.
  // Дублируем часть логики из agent/restic.executor.ts — это сознательный выбор:
  // нести этот код в shared — overkill, агент и API знают про restic-хранилища
  // одинаково (логика короткая, не меняется).
  // ---------------------------------------------------------------------------

  // Конвенции совпадают с agent/src/backup/restic.executor.ts:
  //   LOCAL → cfg.remotePath (default из BACKUP_LOCAL_PATH env) + /<siteName>
  //   S3    → s3:<endpoint>/<bucket>/<prefix>/<siteName>
  // Дефолты вынесены в env (BACKUP_LOCAL_PATH, S3_DEFAULT_ENDPOINT,
  // BACKUP_S3_PREFIX) чтобы исключить дрейф между API и agent.
  private buildResticRepoUrl(
    storageType: string,
    cfg: Record<string, string>,
    siteName: string,
  ): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(siteName)) {
      throw new Error(`Invalid siteName for restic repo: ${siteName}`);
    }
    if (storageType === BackupStorageType.LOCAL) {
      const fallback = this.config.get<string>('BACKUP_LOCAL_PATH') || '/var/backups/meowbox';
      const base = cfg.remotePath || fallback;
      return `${base.replace(/\/+$/, '')}/${siteName}`;
    }
    if (storageType === BackupStorageType.S3) {
      const { bucket, endpoint, prefix } = cfg;
      if (!bucket) throw new Error('S3 bucket is required');
      const ep = endpoint || this.config.get<string>('S3_DEFAULT_ENDPOINT') || 'https://s3.amazonaws.com';
      const defaultPfx = this.config.get<string>('BACKUP_S3_PREFIX') || 'meowbox';
      const pfx = (prefix || defaultPfx).replace(/^\/+|\/+$/g, '');
      return `s3:${ep}/${bucket}/${pfx}/${siteName}`;
    }
    throw new Error(`Unsupported storage type for Restic: ${storageType}`);
  }

  private terminateProcess(child: ChildProcess): void {
    const pid = child.pid;
    if (!pid || child.exitCode !== null || this.killTimers.has(pid)) return;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try { child.kill('SIGTERM'); } catch { return; }
    }
    const timer = setTimeout(() => {
      this.killTimers.delete(pid);
      if (child.exitCode !== null) return;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }
    }, 5_000);
    timer.unref();
    this.killTimers.set(pid, timer);
  }

  private clearKillTimer(pid: number | undefined): void {
    if (!pid) return;
    const timer = this.killTimers.get(pid);
    if (timer) clearTimeout(timer);
    this.killTimers.delete(pid);
  }

  private exportFilename(siteName: string, snapshotId: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(siteName) || !/^[A-Za-z0-9_-]{8,128}$/.test(snapshotId)) {
      throw new BadRequestException('Некорректные метаданные бэкапа');
    }
    return `backup-${siteName}-${snapshotId.slice(0, 8)}.tar`;
  }

  // Изолированный env для restic-процесса: НЕ пробрасываем весь process.env,
  // только PATH (чтобы найти restic) + специфичные креды. Это снижает риск
  // утечки секретов API-процесса в /proc/<pid>/environ дочернего restic'а.
  private buildResticEnv(
    storageType: string,
    cfg: Record<string, string>,
    password: string,
  ): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG,
      RESTIC_PASSWORD: password,
    };
    if (storageType === BackupStorageType.S3) {
      const { accessKey, secretKey, region } = cfg;
      if (!accessKey || !secretKey) {
        throw new Error('S3 accessKey/secretKey are required');
      }
      env.AWS_ACCESS_KEY_ID = accessKey;
      env.AWS_SECRET_ACCESS_KEY = secretKey;
      const fallbackRegion = this.config.get<string>('S3_DEFAULT_REGION') || 'us-east-1';
      env.AWS_DEFAULT_REGION = region || fallbackRegion;
    }
    return env;
  }

  // ---------------------------------------------------------------------------
  // Получение/удаление экспортов (для UI).
  // ---------------------------------------------------------------------------

  // Delivery URL никогда не попадает в list/get: он выдаётся отдельным
  // короткоживущим типизированным контрактом после повторной авторизации.
  private serializeExport(r: {
    id: string; backupId: string; mode: string; status: string;
    downloadUrl: string | null; expiresAt: Date; sizeBytes: bigint | null;
    errorMessage: string | null; createdAt: Date; operationId?: string | null;
  }) {
    // Прогресс in-memory — отдаём только пока статус не финальный (PROCESSING/PENDING).
    // Для финальных статусов прогресс не имеет смысла + map уже очищена в handleAgentExportComplete.
    const isActive = r.status === BackupExportStatus.PROCESSING || r.status === BackupExportStatus.PENDING;
    const prog = isActive ? this.exportProgress.get(r.id) : undefined;
    return {
      id: r.id,
      backupId: r.backupId,
      mode: r.mode,
      status: r.status,
      deliveryAvailable: r.status === BackupExportStatus.READY,
      expiresAt: r.expiresAt,
      sizeBytes: r.sizeBytes ? Number(r.sizeBytes) : null,
      errorMessage: r.errorMessage,
      createdAt: r.createdAt,
      operationId: r.operationId ?? null,
      operationStatusPath: r.operationId ? `/api/operations/${r.operationId}` : null,
      // Прогресс отдаём только если есть (нет тиков от агента / не активный экспорт = null).
      progressBytesRead: prog ? prog.bytesRead : null,
      progressBytesUploaded: prog ? prog.bytesUploaded : null,
      progressElapsedMs: prog ? prog.elapsedMs : null,
      progressUpdatedAt: prog ? prog.updatedAt : null,
    };
  }

  async getExport(exportId: string, userId: string, role: string) {
    const row = await this.prisma.backupExport.findUnique({
      where: { id: exportId },
      include: {
        backup: { select: { site: { select: { userId: true } } } },
      },
    });
    if (!row) throw new NotFoundException('Export not found');
    if (role !== 'ADMIN' && row.backup.site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    return this.serializeExport(row);
  }

  async listExportsForBackup(backupId: string, userId: string, role: string) {
    const backup = await this.prisma.backup.findUnique({
      where: { id: backupId },
      select: { site: { select: { userId: true } } },
    });
    if (!backup) throw new NotFoundException('Backup not found');
    if (role !== 'ADMIN' && backup.site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    const rows = await this.prisma.backupExport.findMany({
      where: { backupId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => this.serializeExport(r));
  }

  async deleteExport(exportId: string, userId: string, role: string) {
    const row = await this.prisma.backupExport.findUnique({
      where: { id: exportId },
      include: {
        backup: {
          include: {
            site: { select: { userId: true } },
            storageLocation: true,
          },
        },
      },
    });
    if (!row) throw new NotFoundException('Export not found');
    if (role !== 'ADMIN' && row.backup.site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    await this.cleanupExportArtifacts(row);
    await this.prisma.backupExport.delete({ where: { id: exportId } });
  }

  private async cleanupExportArtifacts(row: {
    id: string; mode: string; s3Key: string | null; artifactId: string | null;
    operationId: string | null;
    createdByUserId: string;
    backup: { storageLocation: { id: string; type: string } | null };
  }) {
    await this.cancelExportOperation(row.operationId, row.createdByUserId);
    if (row.mode === BackupExportMode.STAGED_ARTIFACT && row.artifactId) {
      await this.artifacts.revoke({
        artifactId: row.artifactId,
        sourceKind: 'BACKUP_EXPORT',
        resourceId: row.id,
        createdByUserId: row.createdByUserId,
      });
    }
    if (row.mode === BackupExportMode.S3_PRESIGNED && row.s3Key && row.backup.storageLocation) {
      try {
        const loc = await this.storageLocations.getFullConfigForAgent(row.backup.storageLocation.id);
        if (loc.type !== BackupStorageType.S3) {
          throw new Error('S3 export storage type changed');
        }
        const client = this.buildS3Client(loc.config);
        await client.send(new DeleteObjectCommand({
          Bucket: loc.config.bucket,
          Key: row.s3Key,
        }));
      } catch (err) {
        this.logger.warn(`S3 cleanup failed for ${row.s3Key}: ${(err as Error).message}`);
        throw err;
      }
    }
  }

  private async cancelExportOperation(
    operationId: string | null,
    createdByUserId: string,
  ): Promise<void> {
    if (!operationId) return;
    const operation = await this.prisma.operation.findUnique({
      where: { id: operationId },
      select: { status: true },
    });
    if (!operation) return;
    if ([
      'PENDING', 'QUEUED', 'CLAIMED', 'RUNNING', 'RECOVERING', 'CANCEL_REQUESTED',
    ].includes(operation.status)) {
      await this.operations.requestCancellation(operationId, createdByUserId, 'ADMIN');
      return;
    }
    if (['UNKNOWN_RECOVERY_REQUIRED', 'NEEDS_ATTENTION'].includes(operation.status)) {
      throw new ConflictException('Сначала разрешите состояние связанной операции');
    }
  }

  // Чистим S3-артефакты ВСЕХ экспортов для одного бэкапа.
  // Вызывается из deleteBackup ПЕРЕД cascade-удалением — иначе записи
  // BackupExport удалятся автоматически (Cascade), а S3-объекты останутся
  // навсегда (биллинг утечёт). Сами DB-записи здесь не трогаем — их подберёт
  // каскад `Backup.delete()`.
  async cleanupArtifactsForBackup(backupId: string): Promise<void> {
    await this.cleanupArtifactsForBackups([backupId]);
  }

  async cleanupArtifactsForBackups(backupIds: string[]): Promise<void> {
    if (backupIds.length === 0) return;
    const rows = await this.prisma.backupExport.findMany({
      where: {
        backupId: { in: backupIds },
        OR: [
          { mode: BackupExportMode.S3_PRESIGNED, s3Key: { not: null } },
          { mode: BackupExportMode.STAGED_ARTIFACT },
        ],
      },
      include: { backup: { include: { storageLocation: true } } },
    });
    for (const row of rows) {
      await this.cleanupExportArtifacts(row);
    }
  }

  // То же для удаления юзера (cascade `User → BackupExport`).
  async cleanupArtifactsForUser(userId: string): Promise<void> {
    const rows = await this.prisma.backupExport.findMany({
      where: {
        createdByUserId: userId,
        OR: [
          { mode: BackupExportMode.S3_PRESIGNED, s3Key: { not: null } },
          { mode: BackupExportMode.STAGED_ARTIFACT },
        ],
      },
      include: { backup: { include: { storageLocation: true } } },
    });
    for (const row of rows) {
      await this.cleanupExportArtifacts(row);
    }
  }

  // ---------------------------------------------------------------------------
  // Cron: чистим всё, что просрочено по expiresAt.
  // ---------------------------------------------------------------------------

  @Cron(CronExpression.EVERY_HOUR, { name: 'backup-exports-cleanup' })
  async cleanupExpiredExports() {
    let totalProcessed = 0;
    // Until-empty loop: при больших всплесках (>batch) отрабатываем все,
    // а не только первую порцию (иначе S3 продолжает копить $$).
    // Безопасный потолок 50 итераций × batch = достаточно для любого нормального
    // объёма; при аварии (>50×batch истёкших) лучше не блокировать cron часами.
    for (let iter = 0; iter < 50; iter++) {
      const now = new Date();
      const expired = await this.prisma.backupExport.findMany({
        where: {
          expiresAt: { lte: now },
          status: { not: BackupExportStatus.EXPIRED },
        },
        include: {
          backup: { include: { storageLocation: true } },
        },
        take: this.cleanupBatchSize,
      });
      if (expired.length === 0) break;
      totalProcessed += expired.length;

      for (const row of expired) {
        try {
          await this.cleanupExportArtifacts(row);
          await this.prisma.backupExport.update({
            where: { id: row.id },
            data: { status: BackupExportStatus.EXPIRED, downloadUrl: null },
          });
        } catch (err) {
          this.logger.warn(`Failed to cleanup export ${row.id}: ${(err as Error).message}`);
        }
      }
      if (expired.length < this.cleanupBatchSize) break;
    }

    if (totalProcessed > 0) {
      this.logger.log(`Backup-exports cleanup: processed ${totalProcessed} expired record(s)`);
    }

    // Окончательное удаление EXPIRED-записей старше retention периода.
    // BACKUP_EXPORT_RETENTION_DAYS (default 7) — после этого UI не показывает
    // кладбище. История остаётся в audit-логе.
    const cutoff = new Date(Date.now() - this.expiredRetentionMs);
    await this.prisma.backupExport.deleteMany({
      where: {
        status: BackupExportStatus.EXPIRED,
        expiresAt: { lt: cutoff },
      },
    });
  }
}
