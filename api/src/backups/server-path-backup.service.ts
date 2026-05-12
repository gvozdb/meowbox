import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { BackupEngine, BackupStatus } from '../common/enums';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service';
import { NotificationDigestService, DigestNotificationMode } from '../notifications/notification-digest.service';
import { StorageLocationsService } from '../storage-locations/storage-locations.service';
import {
  CreateServerPathBackupDto,
  UpdateServerPathBackupDto,
} from './server-path-backup.dto';
import { parseStringArray, stringifyStringArray, parseJsonObject } from '../common/json-array';
import { assertValidPath, checkPathWarnings } from './warnlist';

const RESTIC_COMPATIBLE = new Set(['LOCAL', 'S3']);

@Injectable()
export class ServerPathBackupService {
  private readonly logger = new Logger('ServerPathBackupService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly notifier: NotificationDispatcherService,
    private readonly digest: NotificationDigestService,
    private readonly storageLocations: StorageLocationsService,
  ) {}

  // ===========================================================================
  // CRUD
  // ===========================================================================

  async list() {
    const configs = await this.prisma.serverPathBackupConfig.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return configs.map((c) => ({
      ...c,
      excludePaths: parseStringArray(c.excludePaths),
      storageLocationIds: parseStringArray(c.storageLocationIds),
    }));
  }

  async get(id: string) {
    const config = await this.prisma.serverPathBackupConfig.findUnique({
      where: { id },
    });
    if (!config) throw new NotFoundException('Server-path backup config not found');
    return {
      ...config,
      excludePaths: parseStringArray(config.excludePaths),
      storageLocationIds: parseStringArray(config.storageLocationIds),
    };
  }

  async create(dto: CreateServerPathBackupDto) {
    assertValidPath(dto.path);

    // Warnings: если путь "опасный" — требуем warningAcknowledged.
    const warnings = checkPathWarnings(dto.path);
    if (warnings.length > 0 && !dto.warningAcknowledged) {
      throw new ConflictException({
        code: 'BackupPathWarning',
        message: 'Путь требует подтверждения: ' + warnings.map((w) => w.code).join(', '),
        warnings,
      });
    }

    // Storage locations: проверяем что существуют + для RESTIC compat
    const locIds = dto.storageLocationIds;
    if (locIds.length === 0) {
      throw new BadRequestException('Минимум одно хранилище должно быть выбрано');
    }
    const locs = await this.prisma.storageLocation.findMany({
      where: { id: { in: locIds } },
      select: { id: true, resticEnabled: true, name: true, type: true },
    });
    if (locs.length !== locIds.length) {
      throw new BadRequestException('Некоторые StorageLocation не найдены');
    }
    if (dto.engine === 'RESTIC') {
      const bad = locs.filter((l) => !l.resticEnabled);
      if (bad.length > 0) {
        throw new BadRequestException(
          `Restic не поддерживается хранилищами: ${bad.map((l) => l.name).join(', ')}`,
        );
      }
    }

    const created = await this.prisma.serverPathBackupConfig.create({
      data: {
        name: dto.name,
        path: dto.path.replace(/\/+$/, '') || '/',
        warningAcknowledged: warnings.length > 0 ? !!dto.warningAcknowledged : false,
        engine: dto.engine,
        storageLocationIds: stringifyStringArray(locIds),
        schedule: dto.schedule || null,
        retention: dto.retention ?? 7,
        keepDaily: dto.keepDaily ?? 7,
        keepWeekly: dto.keepWeekly ?? 4,
        keepMonthly: dto.keepMonthly ?? 6,
        keepYearly: dto.keepYearly ?? 1,
        excludePaths: stringifyStringArray(dto.excludePaths || []),
        enabled: dto.enabled ?? true,
        notificationMode: dto.notificationMode ?? 'INSTANT',
        digestSchedule:
          dto.notificationMode === 'DIGEST' ? dto.digestSchedule ?? null : null,
        // many-to-many через relation table
        storageLocations: { connect: locIds.map((id) => ({ id })) },
      },
    });
    return this.get(created.id);
  }

  async update(id: string, dto: UpdateServerPathBackupDto) {
    const existing = await this.prisma.serverPathBackupConfig.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Config not found');

    let storageLocationIds: string | undefined;
    let connect: Array<{ id: string }> | undefined;
    let disconnect: Array<{ id: string }> | undefined;
    if (dto.storageLocationIds) {
      const old = parseStringArray(existing.storageLocationIds);
      const oldSet = new Set(old);
      const newSet = new Set(dto.storageLocationIds);
      connect = dto.storageLocationIds.filter((x) => !oldSet.has(x)).map((id) => ({ id }));
      disconnect = old.filter((x) => !newSet.has(x)).map((id) => ({ id }));
      storageLocationIds = stringifyStringArray(dto.storageLocationIds);
    }

    await this.prisma.serverPathBackupConfig.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(storageLocationIds !== undefined && { storageLocationIds }),
        ...(dto.schedule !== undefined && { schedule: dto.schedule || null }),
        ...(dto.retention !== undefined && { retention: dto.retention }),
        ...(dto.keepDaily !== undefined && { keepDaily: dto.keepDaily }),
        ...(dto.keepWeekly !== undefined && { keepWeekly: dto.keepWeekly }),
        ...(dto.keepMonthly !== undefined && { keepMonthly: dto.keepMonthly }),
        ...(dto.keepYearly !== undefined && { keepYearly: dto.keepYearly }),
        ...(dto.excludePaths !== undefined && {
          excludePaths: stringifyStringArray(dto.excludePaths),
        }),
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        ...(dto.notificationMode !== undefined && {
          notificationMode: dto.notificationMode,
          digestSchedule:
            dto.notificationMode === 'DIGEST'
              ? dto.digestSchedule ?? existing.digestSchedule ?? null
              : null,
        }),
        ...(dto.notificationMode === undefined && dto.digestSchedule !== undefined && {
          digestSchedule: dto.digestSchedule || null,
        }),
        ...(connect && connect.length > 0 ? { storageLocations: { connect } } : {}),
        ...(disconnect && disconnect.length > 0 ? { storageLocations: { disconnect } } : {}),
      },
    });
    return this.get(id);
  }

  async delete(id: string) {
    const existing = await this.prisma.serverPathBackupConfig.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Config not found');
    await this.prisma.serverPathBackupConfig.delete({ where: { id } });
    return { ok: true };
  }

  // ===========================================================================
  // Trigger backup
  // ===========================================================================

  /**
   * Запуск бэкапа: для каждой выбранной storageLocation создаётся отдельная
   * ServerPathBackup-запись + диспатчится агенту.
   */
  async triggerBackup(configId: string) {
    const config = await this.prisma.serverPathBackupConfig.findUnique({
      where: { id: configId },
    });
    if (!config) throw new NotFoundException('Config not found');
    if (!config.enabled) {
      throw new BadRequestException('Config disabled');
    }

    const active = await this.prisma.serverPathBackup.findFirst({
      where: {
        configId,
        status: { in: [BackupStatus.PENDING, BackupStatus.IN_PROGRESS] },
      },
    });
    if (active) {
      throw new BadRequestException('Active backup already running for this config');
    }

    const locIds = parseStringArray(config.storageLocationIds);
    const locations = await this.prisma.storageLocation.findMany({
      where: { id: { in: locIds } },
    });
    const created: Array<{ id: string; locationName: string }> = [];

    for (const loc of locations) {
      if (config.engine === BackupEngine.RESTIC && !loc.resticEnabled) {
        this.logger.warn(`Skip ${loc.name}: Restic not supported`);
        continue;
      }

      const backup = await this.prisma.serverPathBackup.create({
        data: {
          configId,
          engine: config.engine,
          status: BackupStatus.PENDING,
          storageLocationId: loc.id,
        },
      });

      this.dispatchBackup({
        backupId: backup.id,
        configName: config.name,
        path: config.path,
        engine: config.engine as BackupEngine,
        excludePaths: parseStringArray(config.excludePaths),
        location: {
          id: loc.id,
          name: loc.name,
          type: loc.type,
          config: parseJsonObject<Record<string, string>>(loc.config, {}),
          resticPassword: loc.resticPassword,
        },
        retention: {
          keepDaily: config.keepDaily,
          keepWeekly: config.keepWeekly,
          keepMonthly: config.keepMonthly,
          keepYearly: config.keepYearly,
        },
      }).catch((err) => {
        this.logger.error(`Dispatch failed for ${backup.id}: ${(err as Error).message}`);
        this.prisma.serverPathBackup
          .update({
            where: { id: backup.id },
            data: {
              status: BackupStatus.FAILED,
              errorMessage: `Dispatch failed: ${(err as Error).message}`,
              completedAt: new Date(),
            },
          })
          .catch(() => {});
      });

      created.push({ id: backup.id, locationName: loc.name });
    }

    return { backups: created, config: { id: config.id, name: config.name } };
  }

  // ===========================================================================
  // Agent dispatch
  // ===========================================================================

  private async dispatchBackup(params: {
    backupId: string;
    configName: string;
    path: string;
    engine: BackupEngine;
    excludePaths: string[];
    location: {
      id: string;
      name: string;
      type: string;
      config: Record<string, string>;
      resticPassword: string | null;
    };
    retention: { keepDaily: number; keepWeekly: number; keepMonthly: number; keepYearly: number };
  }): Promise<void> {
    const { backupId, configName, path, engine, excludePaths, location } = params;

    if (engine === BackupEngine.RESTIC) {
      if (!RESTIC_COMPATIBLE.has(location.type) || !location.resticPassword) {
        throw new Error(`Restic не поддерживает location ${location.name}`);
      }
      this.agentRelay.emitToAgentAsync('restic:backup-paths', {
        backupId,
        scope: 'SERVER_PATH',
        repoName: this.slugifyForRepo(configName),
        paths: [path],
        excludePaths,
        storage: {
          type: location.type,
          config: location.config,
          password: location.resticPassword,
        },
      });
      return;
    }

    // TAR
    this.agentRelay.emitToAgentAsync('backup:execute-paths', {
      backupId,
      scope: 'SERVER_PATH',
      archiveName: this.slugifyForRepo(configName),
      paths: [path],
      excludePaths,
      storageType: location.type,
      storageConfig: location.config,
    });
  }

  private slugifyForRepo(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'server-path';
  }

  // ===========================================================================
  // Progress + Completion callbacks (для агентских событий)
  // ===========================================================================

  async updateProgress(backupId: string, progress: number) {
    await this.prisma.serverPathBackup.updateMany({
      where: {
        id: backupId,
        status: { in: [BackupStatus.PENDING, BackupStatus.IN_PROGRESS] },
      },
      data: {
        progress: Math.min(progress, 100),
        status: BackupStatus.IN_PROGRESS,
        ...(progress === 0 ? { startedAt: new Date() } : {}),
      },
    });
  }

  async completeBackup(
    backupId: string,
    success: boolean,
    filePath?: string,
    sizeBytes?: number,
    errorMessage?: string,
    snapshotId?: string,
  ) {
    const backup = await this.prisma.serverPathBackup.findUnique({
      where: { id: backupId },
      include: { config: { select: { id: true, name: true, path: true, notificationMode: true } } },
    });
    if (!backup) return;

    await this.prisma.serverPathBackup.update({
      where: { id: backupId },
      data: {
        status: success ? BackupStatus.COMPLETED : BackupStatus.FAILED,
        filePath: filePath || '',
        resticSnapshotId: snapshotId || null,
        sizeBytes: sizeBytes ? BigInt(sizeBytes) : null,
        errorMessage,
        completedAt: new Date(),
        progress: success ? 100 : 0,
      },
    });

    const mode = (backup.config.notificationMode || 'INSTANT') as DigestNotificationMode;
    this.digest
      .handleCompletion(
        {
          configType: 'SERVER_PATH',
          configId: backup.config.id,
          configName: backup.config.name,
          resourceLabel: backup.config.path,
          success,
          sizeBytes,
          errorMessage,
        },
        mode,
      )
      .catch((err) => this.logger.error(`Notification failed: ${(err as Error).message}`));
  }

  // ===========================================================================
  // List backups (per-config)
  // ===========================================================================

  async listBackups(configId: string, page = 1, perPage = 20) {
    const take = Math.min(perPage, 50);
    const skip = (page - 1) * take;
    const [backups, total] = await Promise.all([
      this.prisma.serverPathBackup.findMany({
        where: { configId },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: { storageLocation: { select: { id: true, name: true, type: true } } },
      }),
      this.prisma.serverPathBackup.count({ where: { configId } }),
    ]);
    return {
      backups,
      meta: { page, perPage: take, total, totalPages: Math.ceil(total / take) },
    };
  }
}
