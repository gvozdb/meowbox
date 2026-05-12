import {
  Injectable,
  Inject,
  forwardRef,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { BackupType, BackupStatus, BackupStorageType, BackupEngine } from '../common/enums';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service';
import { StorageLocationsService } from '../storage-locations/storage-locations.service';
import { PanelSettingsService } from '../panel-settings/panel-settings.service';
import { BackupExportsService } from './backup-exports.service';
import {
  CreateBackupConfigDto,
  TriggerBackupDto,
  UpdateAutoBackupSettingsDto,
} from './backups.dto';
import { parseStringArray, stringifyStringArray, parseJsonObject } from '../common/json-array';

export interface UnifiedBackupRow {
  id: string;
  kind: 'SITE' | 'SERVER_PATH' | 'PANEL_DATA';
  type: string;
  status: string;
  engine: string;
  sourceName: string;
  sourceSubtitle: string;
  sourceId: string | null;
  sizeBytes: bigint | number | null;
  progress: number;
  errorMessage: string | null;
  resticSnapshotId: string | null;
  filePath: string;
  storageLocation: { id: string; name: string; type: string } | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

// ============================================================================
// Нюансы движков:
//
// TAR (legacy, совместим со всеми storageType):
//   - На агент идёт `backup:execute` с storageType + storageConfig (JSON).
//   - Backup.filePath хранит полный путь к .tar.gz (локальный или remote-prefix).
//
// RESTIC (новый, дедупликация):
//   - На агент идёт `restic:backup` с { storage: {type,config,password} }.
//   - Backup.resticSnapshotId хранит id снапшота в репе.
//   - После успешного бэкапа вызывается restic:forget с retention-policy из config.
//   - Multi-target: создаётся по одной Backup-записи на каждое выбранное хранилище.
// ============================================================================

// Агент принимает `storage` только для LOCAL/S3 (остальные — не поддерживаются Restic'ом).
const RESTIC_COMPATIBLE = new Set(['LOCAL', 'S3']);

interface LocationFull {
  id: string;
  name: string;
  type: string;
  config: Record<string, string>;
  resticPassword: string | null;
}

@Injectable()
export class BackupsService {
  private readonly logger = new Logger('BackupsService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly notifier: NotificationDispatcherService,
    private readonly storageLocations: StorageLocationsService,
    private readonly panelSettings: PanelSettingsService,
    // forwardRef защищает от потенциального цикла на старте Nest, хотя
    // BackupExportsService не зависит от BackupsService напрямую сейчас.
    @Inject(forwardRef(() => BackupExportsService))
    private readonly backupExports: BackupExportsService,
  ) {}

  // ===========================================================================
  // Backup Configs (per-site)
  // ===========================================================================

  async getConfigs(siteId: string, userId: string, role: string) {
    await this.assertSiteAccess(siteId, userId, role);

    const configs = await this.prisma.backupConfig.findMany({
      where: { siteId },
      orderBy: { createdAt: 'desc' },
    });
    return configs.map((c) => ({
      ...c,
      excludePaths: parseStringArray(c.excludePaths),
      excludeTableData: parseStringArray(c.excludeTableData),
      storageLocationIds: parseStringArray(c.storageLocationIds),
      storageConfig: parseJsonObject(c.storageConfig, {}),
    }));
  }

  async createConfig(dto: CreateBackupConfigDto, userId: string, role: string) {
    await this.assertSiteAccess(dto.siteId, userId, role);

    const engine = (dto.engine as BackupEngine) || BackupEngine.TAR;

    // Если указаны storageLocationIds — проверяем, что они существуют
    const locationIds = dto.storageLocationIds || [];
    if (locationIds.length > 0) {
      const found = await this.prisma.storageLocation.findMany({
        where: { id: { in: locationIds } },
        select: { id: true, resticEnabled: true },
      });
      if (found.length !== locationIds.length) {
        throw new BadRequestException('Некоторые StorageLocation не найдены');
      }
      if (engine === BackupEngine.RESTIC) {
        const incompatible = found.filter((l) => !l.resticEnabled);
        if (incompatible.length > 0) {
          throw new BadRequestException(
            `Хранилища ${incompatible.map((l) => l.id).join(', ')} не поддерживают Restic`,
          );
        }
      }
    } else if (!dto.storageType) {
      // Legacy-путь требует storageType
      throw new BadRequestException('Укажите storageLocationIds или storageType');
    }

    const created = await this.prisma.backupConfig.create({
      data: {
        siteId: dto.siteId,
        type: dto.type as BackupType,
        engine,
        storageLocationIds: stringifyStringArray(locationIds),
        storageType: (dto.storageType as BackupStorageType) || null,
        schedule: dto.schedule || null,
        retention: dto.retention || 7,
        keepDaily: dto.keepDaily ?? 7,
        keepWeekly: dto.keepWeekly ?? 4,
        keepMonthly: dto.keepMonthly ?? 6,
        keepYearly: dto.keepYearly ?? 1,
        excludePaths: stringifyStringArray(dto.excludePaths || []),
        excludeTableData: stringifyStringArray(dto.excludeTableData || []),
        storageConfig: JSON.stringify(dto.storageConfig || {}),
        keepLocalCopy: dto.keepLocalCopy ?? false,
        enabled: dto.enabled ?? true,
      },
    });
    return {
      ...created,
      excludePaths: parseStringArray(created.excludePaths),
      excludeTableData: parseStringArray(created.excludeTableData),
      storageLocationIds: parseStringArray(created.storageLocationIds),
      storageConfig: parseJsonObject(created.storageConfig, {}),
    };
  }

  async deleteConfig(configId: string, userId: string, role: string) {
    const config = await this.prisma.backupConfig.findUnique({
      where: { id: configId },
      include: { site: { select: { userId: true } } },
    });

    if (!config) throw new NotFoundException('Backup config not found');
    if (role !== 'ADMIN' && config.site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    await this.prisma.backupConfig.delete({ where: { id: configId } });
  }

  // ===========================================================================
  // Auto-Backup Settings (глобальные)
  // ===========================================================================

  async getAutoBackupSettings() {
    return this.panelSettings.getBackupDefaults();
  }

  async updateAutoBackupSettings(dto: UpdateAutoBackupSettingsDto) {
    const current = await this.panelSettings.getBackupDefaults();
    const merged = { ...current, ...dto, retention: { ...current.retention, ...(dto.retention || {}) } };

    // Валидация: если выбран RESTIC и storageLocationIds не пустые — все должны быть Restic-compatible
    if (merged.engine === 'RESTIC' && merged.storageLocationIds.length > 0) {
      const locations = await this.prisma.storageLocation.findMany({
        where: { id: { in: merged.storageLocationIds } },
        select: { id: true, resticEnabled: true, name: true },
      });
      const bad = locations.filter((l) => !l.resticEnabled);
      if (bad.length > 0) {
        throw new BadRequestException(
          `Для движка RESTIC нельзя выбрать: ${bad.map((l) => l.name).join(', ')} (поддерживаются только LOCAL и S3)`,
        );
      }
    }
    await this.panelSettings.set('backup-defaults', merged);
    return merged;
  }

  // ===========================================================================
  // Trigger Backup (ручной или из scheduler)
  // ===========================================================================

  async triggerBackup(dto: TriggerBackupDto, userId: string, role: string) {
    const site = await this.prisma.site.findUnique({
      where: { id: dto.siteId },
      select: {
        id: true,
        name: true,
        domain: true,
        rootPath: true,
        userId: true,
        backupExcludes: true,
        backupExcludeTables: true,
        databases: { select: { id: true, name: true, type: true } },
      },
    });

    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    // ---- Сбор параметров: из config | из глобальных настроек | из dto ----
    let backupType: BackupType = BackupType.FULL;
    let engine: BackupEngine = BackupEngine.TAR;
    let excludePaths: string[] = [];
    let excludeTableData: string[] = [];
    let keepLocalCopy = false;
    let locationIds: string[] = [];
    let legacyStorageType: BackupStorageType | null = null;
    let legacyStorageConfig: Record<string, string> = {};
    let configId: string | null = null;
    let retentionPolicy = { keepDaily: 7, keepWeekly: 4, keepMonthly: 6, keepYearly: 1 };

    if (dto.configId) {
      // Используем явно указанный BackupConfig
      const config = await this.prisma.backupConfig.findUnique({
        where: { id: dto.configId },
      });
      if (!config) throw new NotFoundException('Backup config not found');
      backupType = config.type as BackupType;
      engine = (config.engine as BackupEngine) || BackupEngine.TAR;
      excludePaths = parseStringArray(config.excludePaths);
      excludeTableData = parseStringArray(config.excludeTableData);
      locationIds = parseStringArray(config.storageLocationIds);
      legacyStorageType = (config.storageType as BackupStorageType | null) || null;
      legacyStorageConfig = parseJsonObject<Record<string, string>>(config.storageConfig, {});
      keepLocalCopy = config.keepLocalCopy;
      configId = config.id;
      retentionPolicy = {
        keepDaily: config.keepDaily,
        keepWeekly: config.keepWeekly,
        keepMonthly: config.keepMonthly,
        keepYearly: config.keepYearly,
      };
    } else {
      // Ручной запуск — берём параметры из dto, дефолты из глобальных settings
      const defaults = await this.panelSettings.getBackupDefaults();
      backupType = (dto.type as BackupType) || (defaults.type as BackupType);
      engine = (dto.engine as BackupEngine) || (defaults.engine as BackupEngine);
      // Иерархия excludes: dto > site.backupExcludes > global defaults.
      // Пустой массив в dto — явное "без excludes", undefined — fallback по цепочке.
      const siteExcludes = parseStringArray(site.backupExcludes as string | null | undefined);
      const siteExcludeTables = parseStringArray(site.backupExcludeTables as string | null | undefined);
      excludePaths = dto.excludePaths !== undefined
        ? dto.excludePaths
        : (siteExcludes.length > 0 ? siteExcludes : defaults.excludePaths);
      excludeTableData = dto.excludeTableData !== undefined
        ? dto.excludeTableData
        : (siteExcludeTables.length > 0 ? siteExcludeTables : defaults.excludeTableData);
      retentionPolicy = defaults.retention;

      if (dto.storageLocationIds && dto.storageLocationIds.length > 0) {
        // Запуск из SiteBackupSchedule — список хранилищ передан явно
        locationIds = dto.storageLocationIds;
      } else if (dto.storageLocationId) {
        // Юзер выбрал одно конкретное хранилище
        locationIds = [dto.storageLocationId];
      } else if (dto.storageType) {
        // Legacy: прямо задан storageType + config
        legacyStorageType = dto.storageType as BackupStorageType;
        legacyStorageConfig = dto.storageConfig || {};
      } else if (defaults.storageLocationIds.length > 0) {
        // Fallback на глобальные дефолты
        locationIds = defaults.storageLocationIds;
      } else {
        throw new BadRequestException('Не выбрано хранилище бэкапа');
      }
    }

    // ---- Селективный выбор БД ----
    // Применяется только если backupType включает БД (FULL/DIFFERENTIAL/DB_ONLY).
    // FILES_ONLY игнорирует выбор полностью — БД и так не бэкапятся.
    const backupIncludesDb =
      backupType === BackupType.FULL ||
      backupType === BackupType.DIFFERENTIAL ||
      backupType === BackupType.DB_ONLY;
    let selectedDatabases = site.databases;
    if (backupIncludesDb && Array.isArray(dto.databaseIds)) {
      const allowed = new Set(site.databases.map((d) => d.id));
      const requested = dto.databaseIds.filter((id) => allowed.has(id));
      if (requested.length === 0) {
        throw new BadRequestException(
          'Не выбрано ни одной БД для бэкапа (databaseIds пуст или не принадлежат сайту)',
        );
      }
      selectedDatabases = site.databases.filter((d) => requested.includes(d.id));
    }
    if (backupType === BackupType.DB_ONLY && selectedDatabases.length === 0) {
      throw new BadRequestException('У сайта нет БД — DB_ONLY бэкап невозможен');
    }
    // Полезный список для нижестоящих вызовов агента: { name, type } — только то,
    // что реально надо дампить. site.databases используется тут только для проверок.
    const dbsForAgent = selectedDatabases.map((d) => ({ name: d.name, type: d.type }));

    // Active-check
    const active = await this.prisma.backup.findFirst({
      where: {
        siteId: dto.siteId,
        status: { in: [BackupStatus.PENDING, BackupStatus.IN_PROGRESS] },
      },
    });
    if (active) {
      throw new BadRequestException('A backup is already in progress for this site');
    }

    // =========================================================================
    // Режим: либо через StorageLocation-id (новая схема), либо legacy
    // =========================================================================

    const createdBackups: Array<{ id: string; locationName?: string }> = [];

    if (locationIds.length > 0) {
      // Новая схема: создаём по одной Backup-записи на каждое хранилище
      const locations = await this.prisma.storageLocation.findMany({
        where: { id: { in: locationIds } },
      });
      const byId = new Map(locations.map((l) => [l.id, l]));

      for (const locId of locationIds) {
        const loc = byId.get(locId);
        if (!loc) continue;

        // Restic: хранилище должно поддерживать
        if (engine === BackupEngine.RESTIC && !loc.resticEnabled) {
          this.logger.warn(
            `Пропускаю ${loc.name}: не поддерживает Restic (type=${loc.type})`,
          );
          continue;
        }

        const backup = await this.prisma.backup.create({
          data: {
            siteId: dto.siteId,
            configId,
            type: backupType,
            engine,
            status: BackupStatus.PENDING,
            storageType: loc.type,
            storageLocationId: loc.id,
          },
        });

        // Диспатчим агенту отдельный вызов на каждую локацию
        const fullCfg = parseJsonObject<Record<string, string>>(loc.config, {});
        const locFull: LocationFull = {
          id: loc.id,
          name: loc.name,
          type: loc.type,
          config: fullCfg,
          resticPassword: loc.resticPassword,
        };

        this.dispatchBackup({
          backupId: backup.id,
          site: { ...site, databases: dbsForAgent },
          engine,
          backupType,
          location: locFull,
          excludePaths,
          excludeTableData,
          keepLocalCopy,
          retention: retentionPolicy,
        }).catch((err) => {
          this.logger.error(
            `Failed to dispatch backup ${backup.id}: ${(err as Error).message}`,
          );
          this.prisma.backup
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

        createdBackups.push({ id: backup.id, locationName: loc.name });
      }
    } else {
      // Legacy: один бэкап без StorageLocation
      const backup = await this.prisma.backup.create({
        data: {
          siteId: dto.siteId,
          configId,
          type: backupType,
          engine,
          status: BackupStatus.PENDING,
          storageType: legacyStorageType as string,
        },
      });

      if (engine === BackupEngine.RESTIC) {
        throw new BadRequestException('Restic требует явно выбранного StorageLocation');
      }

      try {
        this.agentRelay.emitToAgentAsync('backup:execute', {
          backupId: backup.id,
          siteId: site.id,
          siteName: site.name,
          rootPath: site.rootPath,
          type: backupType,
          storageType: legacyStorageType,
          excludePaths,
          excludeTableData,
          storageConfig: legacyStorageConfig,
          keepLocalCopy,
          databases: site.databases.map((db) => ({
            name: db.name,
            type: db.type,
          })),
        });
      } catch (err) {
        this.logger.error(`Failed to dispatch backup: ${(err as Error).message}`);
        await this.prisma.backup.update({
          where: { id: backup.id },
          data: {
            status: BackupStatus.FAILED,
            errorMessage: `Agent unavailable: ${(err as Error).message}`,
            completedAt: new Date(),
          },
        });
      }

      createdBackups.push({ id: backup.id });
    }

    this.logger.log(
      `Triggered ${createdBackups.length} backup(s) for "${site.name}" (engine=${engine}, type=${backupType})`,
    );

    return {
      backups: createdBackups,
      site: { id: site.id, name: site.name },
    };
  }

  // ===========================================================================
  // Dispatch backup to agent (поддерживает TAR и RESTIC)
  // ===========================================================================

  private async dispatchBackup(params: {
    backupId: string;
    site: { id: string; name: string; rootPath: string; databases: { name: string; type: string }[] };
    engine: BackupEngine;
    backupType: BackupType;
    location: LocationFull;
    excludePaths: string[];
    excludeTableData: string[];
    keepLocalCopy: boolean;
    retention: { keepDaily: number; keepWeekly: number; keepMonthly: number; keepYearly: number };
  }): Promise<void> {
    const { backupId, site, engine, backupType, location, excludePaths, excludeTableData, retention } = params;

    if (engine === BackupEngine.RESTIC) {
      if (!RESTIC_COMPATIBLE.has(location.type) || !location.resticPassword) {
        throw new Error(`Restic not supported for location ${location.name} (type=${location.type})`);
      }

      this.agentRelay.emitToAgentAsync('restic:backup', {
        backupId,
        siteName: site.name,
        rootPath: site.rootPath,
        type: backupType,
        excludePaths,
        excludeTableData,
        databases: site.databases,
        storage: {
          type: location.type,
          config: location.config,
          password: location.resticPassword,
        },
      });

      // После ответа о бэкапе scheduler пнёт retention; здесь не вызываем напрямую,
      // т.к. backup ещё не завершён. Forget вызывается в completeBackup.
      return;
    }

    // TAR
    this.agentRelay.emitToAgentAsync('backup:execute', {
      backupId,
      siteId: site.id,
      siteName: site.name,
      rootPath: site.rootPath,
      type: backupType,
      storageType: location.type,
      excludePaths,
      excludeTableData,
      storageConfig: location.config,
      keepLocalCopy: params.keepLocalCopy,
      databases: site.databases,
    });
  }

  // ===========================================================================
  // Progress + Completion callbacks
  // ===========================================================================

  async updateBackupProgress(backupId: string, progress: number) {
    await this.prisma.backup.updateMany({
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
    await this.prisma.backup.update({
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

    // Для Restic — применяем retention сразу после успешного бэкапа
    if (success) {
      await this.applyResticRetentionIfNeeded(backupId).catch((err) =>
        this.logger.warn(`Restic retention failed for ${backupId}: ${(err as Error).message}`),
      );
    }

    const backup = await this.prisma.backup.findUnique({
      where: { id: backupId },
      select: {
        site: { select: { name: true } },
        type: true,
        engine: true,
      },
    });
    this.notifier.dispatch({
      event: success ? 'BACKUP_COMPLETED' : 'BACKUP_FAILED',
      title: success ? 'Backup Completed' : 'Backup Failed',
      message: success
        ? `${backup?.engine || 'TAR'} / ${backup?.type || 'FULL'} backup completed${sizeBytes ? ` (${(sizeBytes / 1048576).toFixed(1)} MB)` : ''}`
        : `Backup failed: ${errorMessage || 'unknown error'}`,
      siteName: backup?.site?.name,
      timestamp: new Date(),
    }).catch((err) => this.logger.error(`Notification failed: ${(err as Error).message}`));
  }

  // Вычисляет retention-policy для этого бэкапа и зовёт restic:forget.
  private async applyResticRetentionIfNeeded(backupId: string) {
    const b = await this.prisma.backup.findUnique({
      where: { id: backupId },
      include: {
        site: { select: { name: true } },
        config: { select: { keepDaily: true, keepWeekly: true, keepMonthly: true, keepYearly: true } },
      },
    });
    if (!b || b.engine !== BackupEngine.RESTIC || !b.storageLocationId) return;

    const loc = await this.storageLocations.getFullConfigForAgent(b.storageLocationId);
    if (!loc.resticPassword || !RESTIC_COMPATIBLE.has(loc.type)) return;

    // Policy: если у бэкапа есть config — берём оттуда, иначе из глобальных настроек
    let policy = { keepDaily: 7, keepWeekly: 4, keepMonthly: 6, keepYearly: 1 };
    if (b.config) {
      policy = {
        keepDaily: b.config.keepDaily,
        keepWeekly: b.config.keepWeekly,
        keepMonthly: b.config.keepMonthly,
        keepYearly: b.config.keepYearly,
      };
    } else {
      const defaults = await this.panelSettings.getBackupDefaults();
      policy = defaults.retention;
    }

    // Вызываем forget на агенте
    const res = await this.agentRelay.emitToAgent<{ success: boolean; error?: string }>(
      'restic:forget',
      {
        siteName: b.site.name,
        storage: { type: loc.type, config: loc.config, password: loc.resticPassword },
        policy,
      },
      600_000,
    );
    if (!res.success) {
      this.logger.warn(`restic:forget failed: ${res.error}`);
      return;
    }

    // Синхронизация БД: получаем актуальный список snapshots и удаляем
    // Backup-записи, чьи resticSnapshotId больше не присутствуют в репе.
    const listRes = await this.agentRelay.emitToAgent<{ snapshots: { id: string }[] }>(
      'restic:snapshots',
      {
        siteName: b.site.name,
        storage: { type: loc.type, config: loc.config, password: loc.resticPassword },
      },
      60_000,
    );
    if (listRes.success && listRes.data?.snapshots) {
      const aliveIds = new Set(listRes.data.snapshots.map((s) => s.id));
      await this.prisma.backup.updateMany({
        where: {
          storageLocationId: b.storageLocationId,
          engine: BackupEngine.RESTIC,
          resticSnapshotId: { not: null },
          NOT: { resticSnapshotId: { in: Array.from(aliveIds) } },
          status: BackupStatus.COMPLETED,
        },
        data: {
          status: BackupStatus.COMPLETED, // оставим completed, но пометим файл удалённым
          errorMessage: 'Snapshot удалён из репозитория (retention)',
          filePath: '',
        },
      });
      // Альтернатива — удалить записи совсем. Пока что помечаем как "прибранные".
      // Если пользователь захочет — можно добавить полное удаление.
    }
  }

  // ===========================================================================
  // Restore
  // ===========================================================================

  async restoreBackup(
    backupId: string,
    userId: string,
    role: string,
    cleanup = false,
    scope?: string,
    includePaths?: string[],
    databaseIds?: string[],
  ) {
    const safeScope = (scope === 'FILES_AND_DB' || scope === 'FILES_ONLY' || scope === 'DB_ONLY')
      ? scope
      : 'FILES_AND_DB';
    // Жёсткая фильтрация includePaths:
    //  - Не пустые/dot-only (".", "./", "/" → агент копировал бы ВЕСЬ корень
    //    и обходил selective restore — см. H1 в audit).
    //  - Без `..` и null-bytes (path-traversal через нормализацию).
    //  - Только относительные, без backslash (Windows-style sep).
    //  - Каждый сегмент ≤ 4096 символов, всего ≤ 200 шт.
    const safeInclude = Array.isArray(includePaths)
      ? includePaths
          .map((s) => String(s).trim().replace(/^\.\/+/, '').replace(/\/+$/, ''))
          .filter((s) =>
            s.length > 0
            && s.length <= 4096
            && s !== '.'
            && !s.includes('..')
            && !s.includes('\0')
            && !s.includes('\\')
            && !s.startsWith('/'),
          )
          .slice(0, 200)
      : [];
    const backup = await this.prisma.backup.findUnique({
      where: { id: backupId },
      include: {
        site: {
          select: {
            id: true,
            name: true,
            rootPath: true,
            userId: true,
            databases: { select: { id: true, name: true, type: true } },
          },
        },
        storageLocation: true,
        config: { select: { storageConfig: true, storageType: true } },
        baseBackup: {
          select: {
            id: true,
            filePath: true,
            storageType: true,
            status: true,
            config: { select: { storageConfig: true } },
          },
        },
      },
    });

    if (!backup) throw new NotFoundException('Backup not found');
    if (role !== 'ADMIN' && backup.site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    if (backup.status !== BackupStatus.COMPLETED) {
      throw new BadRequestException('Only completed backups can be restored');
    }

    // ---- Селективный выбор БД для restore ----
    // Применяется только когда scope включает БД (FILES_AND_DB | DB_ONLY).
    // undefined → все БД (back-compat). Пустой массив с DB_ONLY → ошибка.
    const restoreIncludesDb = safeScope === 'FILES_AND_DB' || safeScope === 'DB_ONLY';
    let dbsToRestore = backup.site.databases;
    if (restoreIncludesDb && Array.isArray(databaseIds)) {
      const allowed = new Set(backup.site.databases.map((d) => d.id));
      const requested = databaseIds.filter((id) => allowed.has(id));
      if (safeScope === 'DB_ONLY' && requested.length === 0) {
        throw new BadRequestException(
          'Не выбрано ни одной БД для восстановления (DB_ONLY с пустым databaseIds)',
        );
      }
      dbsToRestore = backup.site.databases.filter((d) => requested.includes(d.id));
    }
    const dbsForAgent = dbsToRestore.map((d) => ({ name: d.name, type: d.type }));

    // ---- Restic-ветка ----
    if (backup.engine === BackupEngine.RESTIC) {
      if (!backup.resticSnapshotId) {
        throw new BadRequestException('У этого Restic-бэкапа нет snapshotId');
      }
      if (!backup.storageLocation) {
        throw new BadRequestException('Хранилище этого бэкапа удалено — восстановление невозможно');
      }
      const loc = await this.storageLocations.getFullConfigForAgent(backup.storageLocation.id);
      if (!loc.resticPassword) {
        throw new BadRequestException('У хранилища нет пароля Restic');
      }

      this.agentRelay.emitToAgentAsync('restic:restore', {
        backupId: backup.id,
        siteName: backup.site.name,
        snapshotId: backup.resticSnapshotId,
        rootPath: backup.site.rootPath,
        cleanup,
        databases: dbsForAgent,
        scope: safeScope,
        includePaths: safeInclude,
        storage: {
          type: loc.type,
          config: loc.config,
          password: loc.resticPassword,
        },
      });
      this.logger.log(`Restic restore triggered for backup ${backup.id}`);
      return backup;
    }

    // ---- TAR-ветка (legacy) ----
    // DIFFERENTIAL: base backup должен быть completed
    if (backup.type === BackupType.DIFFERENTIAL) {
      if (!backup.baseBackup) {
        throw new BadRequestException('Base backup not found — differential restore is impossible');
      }
      if (backup.baseBackup.status !== BackupStatus.COMPLETED) {
        throw new BadRequestException('Base backup is not completed');
      }
    }

    let storageConfig: Record<string, string> = parseJsonObject(backup.config?.storageConfig, {});
    let storageType = backup.storageType;

    // Если бэкап привязан к StorageLocation (новая схема) — используем её креды
    if (backup.storageLocation) {
      const loc = await this.storageLocations.getFullConfigForAgent(backup.storageLocation.id);
      storageConfig = loc.config;
      storageType = loc.type;
    }

    const restoreParams: Record<string, unknown> = {
      backupId: backup.id,
      siteId: backup.site.id,
      siteName: backup.site.name,
      rootPath: backup.site.rootPath,
      filePath: backup.filePath,
      storageType,
      storageConfig,
      cleanup,
      databases: dbsForAgent,
      scope: safeScope,
      includePaths: safeInclude,
    };

    if (backup.type === BackupType.DIFFERENTIAL && backup.baseBackup) {
      restoreParams.baseFilePath = backup.baseBackup.filePath;
      restoreParams.baseStorageType = backup.baseBackup.storageType;
      restoreParams.baseStorageConfig = backup.baseBackup.config?.storageConfig
        ? parseJsonObject<Record<string, string>>(backup.baseBackup.config.storageConfig, storageConfig)
        : storageConfig;
    }

    this.agentRelay.emitToAgentAsync('backup:restore', restoreParams);
    this.logger.log(`TAR restore triggered for backup ${backup.id}`);
    return backup;
  }

  // ===========================================================================
  // Restic snapshots — list snapshots from repo (не из БД)
  // ===========================================================================

  async listResticSnapshotsForSite(
    siteId: string,
    locationId: string,
    userId: string,
    role: string,
  ) {
    await this.assertSiteAccess(siteId, userId, role);
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { name: true },
    });
    if (!site) throw new NotFoundException('Site not found');

    const loc = await this.storageLocations.getFullConfigForAgent(locationId);
    if (!loc.resticPassword) {
      throw new BadRequestException('У этого хранилища нет Restic-пароля');
    }

    const res = await this.agentRelay.emitToAgent<{ snapshots: unknown[] }>(
      'restic:snapshots',
      {
        siteName: site.name,
        storage: { type: loc.type, config: loc.config, password: loc.resticPassword },
      },
      60_000,
    );
    if (!res.success) {
      throw new BadRequestException(res.error || 'Failed to list snapshots');
    }

    // Сопоставляем snapshotId → уже есть ли в БД (Backup-запись). UI рисует "B"
    // рядом с теми, что известны системе, чтобы юзер видел "новые" снапшоты,
    // по которым у нас нет локальной Backup-записи.
    const raw = res.data?.snapshots || [];
    const snapshotIds = (raw as Array<{ id?: string }>)
      .map((s) => s.id)
      .filter((x): x is string => typeof x === 'string');
    let knownIds = new Set<string>();
    if (snapshotIds.length > 0) {
      const rows = await this.prisma.backup.findMany({
        where: {
          siteId,
          storageLocationId: locationId,
          engine: BackupEngine.RESTIC,
          resticSnapshotId: { in: snapshotIds },
        },
        select: { resticSnapshotId: true },
      });
      knownIds = new Set(rows.map((r) => r.resticSnapshotId).filter((x): x is string => !!x));
    }
    return (raw as Array<{ id?: string }>).map((s) => ({
      ...s,
      inDatabase: typeof s.id === 'string' ? knownIds.has(s.id) : false,
    }));
  }

  // ===========================================================================
  // Restore из произвольного snapshot (не из Backup-записи в БД).
  //
  // Поток:
  //   1. Берём snapshotId (id или short_id) из репы, валидируем hex.
  //   2. Создаём синтетическую Backup-запись (status=COMPLETED, engine=RESTIC,
  //      resticSnapshotId, storageLocationId) — чтобы снапшот появился в UI
  //      "Истории" и дальше был виден как нормальный бэкап. Следующий
  //      применённый retention (forget --prune) почистит дубликаты/сиротства.
  //   3. Запускаем обычный restoreBackup(backup.id, …).
  //
  // Зачем синтетическая запись, а не просто "пни restic:restore":
  //   - прогресс-события уже завязаны на backupId (socket event: backup:restore:progress)
  //   - пользователь видит, что именно он восстанавливал, в общей истории
  //   - следующий повтор (например — откат) не требует лазать в репу снова
  // ===========================================================================

  async restoreFromResticSnapshot(params: {
    siteId: string;
    locationId: string;
    snapshotId: string;
    cleanup: boolean;
    userId: string;
    role: string;
    scope?: string;
    includePaths?: string[];
    databaseIds?: string[];
  }) {
    const { siteId, locationId, snapshotId, cleanup, userId, role, scope, includePaths, databaseIds } = params;

    await this.assertSiteAccess(siteId, userId, role);

    // snapshotId: restic принимает как полный 64-hex id, так и короткий (8+).
    if (!/^[a-f0-9]{6,64}$/i.test(snapshotId)) {
      throw new BadRequestException('Некорректный snapshotId (ожидается hex-строка)');
    }

    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: {
        id: true,
        name: true,
        rootPath: true,
        userId: true,
        databases: { select: { name: true, type: true } },
      },
    });
    if (!site) throw new NotFoundException('Site not found');

    // Active backup/restore check — чтобы не ходить друг другу по голове.
    const active = await this.prisma.backup.findFirst({
      where: {
        siteId,
        status: { in: [BackupStatus.PENDING, BackupStatus.IN_PROGRESS] },
      },
    });
    if (active) {
      throw new BadRequestException('Для этого сайта уже идёт операция с бэкапом/восстановлением');
    }

    const loc = await this.storageLocations.getFullConfigForAgent(locationId);
    if (!loc.resticPassword) {
      throw new BadRequestException('У этого хранилища нет Restic-пароля');
    }

    // Если пользователь уже импортировал этот снапшот раньше — переиспользуем запись.
    // Это защищает от мусорных дублей в истории.
    const existing = await this.prisma.backup.findFirst({
      where: {
        siteId,
        storageLocationId: locationId,
        engine: BackupEngine.RESTIC,
        resticSnapshotId: snapshotId,
      },
      select: { id: true },
    });

    let backupId: string;
    if (existing) {
      backupId = existing.id;
    } else {
      // Импортируем snapshot в БД как завершённый бэкап.
      // sizeBytes/filePath мы достоверно не знаем (это снапшот из репы),
      // но UI справится без них — это не критичное поле.
      const created = await this.prisma.backup.create({
        data: {
          siteId,
          configId: null,
          type: BackupType.FULL,
          engine: BackupEngine.RESTIC,
          status: BackupStatus.COMPLETED,
          storageType: loc.type,
          storageLocationId: locationId,
          resticSnapshotId: snapshotId,
          filePath: `restic:${snapshotId}`,
          progress: 100,
          errorMessage: 'Импортирован из репозитория (picker)',
          startedAt: new Date(),
          completedAt: new Date(),
        },
      });
      backupId = created.id;
      this.logger.log(`Imported restic snapshot ${snapshotId} as backup ${backupId} for "${site.name}"`);
    }

    // Дальше идём по обычному пути restore — весь прогресс и обработка ошибок
    // уже там отлажены.
    await this.restoreBackup(backupId, userId, role, cleanup, scope, includePaths, databaseIds);
    return { backupId, imported: !existing };
  }

  // ===========================================================================
  // Selective restore: листинг первого уровня rootPath в снапшоте.
  // Только для Restic-бэкапов.
  // ===========================================================================

  async listBackupTopLevel(backupId: string, userId: string, role: string) {
    const backup = await this.prisma.backup.findUnique({
      where: { id: backupId },
      include: {
        site: { select: { name: true, rootPath: true, userId: true } },
        storageLocation: true,
      },
    });
    if (!backup) throw new NotFoundException('Backup not found');
    if (role !== 'ADMIN' && backup.site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    if (backup.engine !== BackupEngine.RESTIC) {
      throw new BadRequestException('Selective restore доступен только для Restic-бэкапов');
    }
    if (!backup.resticSnapshotId) {
      throw new BadRequestException('У этого бэкапа нет snapshotId');
    }
    if (!backup.storageLocation) {
      throw new BadRequestException('Хранилище удалено');
    }
    const loc = await this.storageLocations.getFullConfigForAgent(backup.storageLocation.id);
    if (!loc.resticPassword) {
      throw new BadRequestException('У хранилища нет пароля Restic');
    }
    const res = await this.agentRelay.emitToAgent<{ items: Array<{ name: string; type: 'dir' | 'file'; size: number }> }>(
      'restic:list-tree',
      {
        siteName: backup.site.name,
        snapshotId: backup.resticSnapshotId,
        rootPath: backup.site.rootPath,
        storage: { type: loc.type, config: loc.config, password: loc.resticPassword },
      },
      120_000,
    );
    if (!res.success) {
      throw new BadRequestException(res.error || 'Не удалось получить дерево снапшота');
    }
    return res.data?.items || [];
  }

  async listResticSnapshotTopLevel(params: {
    siteId: string;
    snapshotId: string;
    locationId: string;
    userId: string;
    role: string;
  }) {
    const { siteId, snapshotId, locationId, userId, role } = params;
    await this.assertSiteAccess(siteId, userId, role);

    if (!/^[a-f0-9]{6,64}$/i.test(snapshotId)) {
      throw new BadRequestException('Некорректный snapshotId');
    }

    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { name: true, rootPath: true },
    });
    if (!site) throw new NotFoundException('Site not found');

    const loc = await this.storageLocations.getFullConfigForAgent(locationId);
    if (!loc.resticPassword) {
      throw new BadRequestException('У этого хранилища нет Restic-пароля');
    }
    const res = await this.agentRelay.emitToAgent<{ items: Array<{ name: string; type: 'dir' | 'file'; size: number }> }>(
      'restic:list-tree',
      {
        siteName: site.name,
        snapshotId,
        rootPath: site.rootPath,
        storage: { type: loc.type, config: loc.config, password: loc.resticPassword },
      },
      120_000,
    );
    if (!res.success) {
      throw new BadRequestException(res.error || 'Не удалось получить дерево снапшота');
    }
    return res.data?.items || [];
  }

  // ===========================================================================
  // List backups (per-site, как раньше но теперь возвращаем engine + locationId)
  // ===========================================================================

  async listBackups(siteId: string, userId: string, role: string, page = 1, perPage = 20) {
    await this.assertSiteAccess(siteId, userId, role);

    const take = Math.min(perPage, 50);
    const skip = (page - 1) * take;

    const [backups, total] = await Promise.all([
      this.prisma.backup.findMany({
        where: { siteId },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        select: {
          id: true,
          type: true,
          status: true,
          engine: true,
          storageType: true,
          storageLocationId: true,
          resticSnapshotId: true,
          filePath: true,
          sizeBytes: true,
          progress: true,
          startedAt: true,
          completedAt: true,
          errorMessage: true,
          baseBackupId: true,
          createdAt: true,
          storageLocation: { select: { id: true, name: true, type: true } },
        },
      }),
      this.prisma.backup.count({ where: { siteId } }),
    ]);

    return {
      backups,
      meta: { page, perPage: take, total, totalPages: Math.ceil(total / take) },
    };
  }

  async findStuckBackups() {
    return this.prisma.backup.findMany({
      where: {
        status: { in: [BackupStatus.PENDING, BackupStatus.IN_PROGRESS] },
      },
      select: { id: true, filePath: true, storageType: true },
    });
  }

  // Единая лента истории бэкапов — сайты + серверные пути + данные панели.
  // Объединяет 3 таблицы (Backup, ServerPathBackup, PanelDataBackup), сортирует
  // по createdAt desc и пагинирует. Чтобы не тянуть всё в память при больших
  // объёмах — каждая таблица отдаётся первыми (skip + take) записями,
  // мерджится, сортируется и режется. Для админ-панели хватает с запасом.
  async listUnifiedHistory(page = 1, perPage = 30) {
    const take = Math.min(perPage, 100);
    const skip = Math.max(0, (page - 1) * take);
    const fetchN = skip + take; // сколько берём из каждой таблицы

    const [siteBackups, serverBackups, panelBackups, siteTotal, serverTotal, panelTotal] = await Promise.all([
      this.prisma.backup.findMany({
        orderBy: { createdAt: 'desc' },
        take: fetchN,
        select: {
          id: true,
          type: true,
          status: true,
          engine: true,
          storageType: true,
          resticSnapshotId: true,
          filePath: true,
          sizeBytes: true,
          progress: true,
          errorMessage: true,
          baseBackupId: true,
          createdAt: true,
          startedAt: true,
          completedAt: true,
          storageLocation: { select: { id: true, name: true, type: true } },
          site: { select: { id: true, name: true, domain: true } },
        },
      }),
      this.prisma.serverPathBackup.findMany({
        orderBy: { createdAt: 'desc' },
        take: fetchN,
        select: {
          id: true,
          status: true,
          engine: true,
          resticSnapshotId: true,
          filePath: true,
          sizeBytes: true,
          progress: true,
          errorMessage: true,
          createdAt: true,
          startedAt: true,
          completedAt: true,
          storageLocation: { select: { id: true, name: true, type: true } },
          config: { select: { id: true, name: true, path: true } },
        },
      }),
      this.prisma.panelDataBackup.findMany({
        orderBy: { createdAt: 'desc' },
        take: fetchN,
        select: {
          id: true,
          status: true,
          engine: true,
          resticSnapshotId: true,
          filePath: true,
          sizeBytes: true,
          progress: true,
          errorMessage: true,
          createdAt: true,
          startedAt: true,
          completedAt: true,
          storageLocation: { select: { id: true, name: true, type: true } },
          config: { select: { id: true, name: true } },
        },
      }),
      this.prisma.backup.count(),
      this.prisma.serverPathBackup.count(),
      this.prisma.panelDataBackup.count(),
    ]);

    const rows: UnifiedBackupRow[] = [];
    for (const b of siteBackups) {
      rows.push({
        id: b.id,
        kind: 'SITE',
        type: b.type,
        status: b.status,
        engine: b.engine,
        sourceName: b.site?.name || '—',
        sourceSubtitle: b.site?.domain || '',
        sourceId: b.site?.id || null,
        sizeBytes: b.sizeBytes ?? null,
        progress: b.progress,
        errorMessage: b.errorMessage,
        resticSnapshotId: b.resticSnapshotId,
        filePath: b.filePath,
        storageLocation: b.storageLocation,
        createdAt: b.createdAt,
        startedAt: b.startedAt,
        completedAt: b.completedAt,
      });
    }
    for (const b of serverBackups) {
      rows.push({
        id: b.id,
        kind: 'SERVER_PATH',
        type: 'FULL',
        status: b.status,
        engine: b.engine,
        sourceName: b.config?.name || '—',
        sourceSubtitle: b.config?.path || '',
        sourceId: b.config?.id || null,
        sizeBytes: b.sizeBytes ?? null,
        progress: b.progress,
        errorMessage: b.errorMessage,
        resticSnapshotId: b.resticSnapshotId,
        filePath: b.filePath,
        storageLocation: b.storageLocation,
        createdAt: b.createdAt,
        startedAt: b.startedAt,
        completedAt: b.completedAt,
      });
    }
    for (const b of panelBackups) {
      rows.push({
        id: b.id,
        kind: 'PANEL_DATA',
        type: 'FULL',
        status: b.status,
        engine: b.engine,
        sourceName: b.config?.name || 'Данные панели',
        sourceSubtitle: 'Панель Meowbox',
        sourceId: b.config?.id || null,
        sizeBytes: b.sizeBytes ?? null,
        progress: b.progress,
        errorMessage: b.errorMessage,
        resticSnapshotId: b.resticSnapshotId,
        filePath: b.filePath,
        storageLocation: b.storageLocation,
        createdAt: b.createdAt,
        startedAt: b.startedAt,
        completedAt: b.completedAt,
      });
    }

    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const items = rows.slice(skip, skip + take);
    const total = siteTotal + serverTotal + panelTotal;
    return {
      items,
      meta: { page, perPage: take, total, totalPages: Math.ceil(total / take) },
    };
  }

  async getBackupForDownload(backupId: string, userId: string, role: string) {
    const backup = await this.prisma.backup.findUnique({
      where: { id: backupId },
      select: {
        id: true,
        type: true,
        engine: true,
        filePath: true,
        status: true,
        storageType: true,
        baseBackupId: true,
        site: { select: { userId: true } },
      },
    });

    if (!backup) throw new NotFoundException('Backup not found');
    if (role !== 'ADMIN' && backup.site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    if (backup.status !== BackupStatus.COMPLETED) {
      throw new BadRequestException('Only completed backups can be downloaded');
    }
    if (backup.engine === BackupEngine.RESTIC) {
      throw new BadRequestException('Restic-бэкапы нельзя скачать как файл — только восстановить в сайт');
    }
    return backup;
  }

  async getBaseBackupFilePath(baseBackupId: string): Promise<string | null> {
    const base = await this.prisma.backup.findUnique({
      where: { id: baseBackupId },
      select: { filePath: true, status: true },
    });
    if (!base || base.status !== BackupStatus.COMPLETED || !base.filePath) return null;
    return base.filePath;
  }

  async deleteBackup(backupId: string, userId: string, role: string) {
    const backup = await this.prisma.backup.findUnique({
      where: { id: backupId },
      include: {
        site: { select: { userId: true, name: true } },
        differentials: { select: { id: true } },
        storageLocation: true,
      },
    });

    if (!backup) throw new NotFoundException('Backup not found');
    if (role !== 'ADMIN' && backup.site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    // Сиротим дифференциальные бэкапы, зависящие от этого FULL
    if (backup.differentials?.length) {
      await this.prisma.backup.updateMany({
        where: { baseBackupId: backupId },
        data: { baseBackupId: null },
      });
    }

    // --- Restic: удалить снапшот из репы ---
    if (backup.engine === BackupEngine.RESTIC && backup.resticSnapshotId && backup.storageLocation) {
      try {
        const loc = await this.storageLocations.getFullConfigForAgent(backup.storageLocation.id);
        if (loc.resticPassword) {
          await this.agentRelay.emitToAgent('restic:delete-snapshot', {
            siteName: backup.site.name,
            snapshotId: backup.resticSnapshotId,
            storage: { type: loc.type, config: loc.config, password: loc.resticPassword },
          }, 300_000);
        }
      } catch (err) {
        this.logger.warn(`Failed to delete restic snapshot: ${(err as Error).message}`);
      }
    }

    // --- TAR: удалить файл локально ---
    if (
      backup.engine !== BackupEngine.RESTIC &&
      backup.filePath && backup.storageType === 'LOCAL' &&
      this.agentRelay.isAgentConnected()
    ) {
      try {
        await this.agentRelay.emitToAgent('backup:delete-file', { filePath: backup.filePath });
      } catch (err) {
        this.logger.warn(`Failed to delete backup file: ${(err as Error).message}`);
      }
    }

    // Чистим S3-объекты экспортов ДО cascade-удаления записей BackupExport.
    // Иначе SQL-каскад снесёт записи, а S3-объекты останутся «навсегда».
    try {
      await this.backupExports.cleanupArtifactsForBackup(backupId);
    } catch (err) {
      this.logger.warn(`Failed to cleanup export artifacts for backup ${backupId}: ${(err as Error).message}`);
    }

    await this.prisma.backup.delete({ where: { id: backupId } });

    return {
      filePath: backup.filePath,
      storageType: backup.storageType,
      engine: backup.engine,
      orphanedDiffs: backup.differentials?.length || 0,
    };
  }

  async cleanupOldBackups() {
    // Для TAR — как раньше (по retention count на config)
    const configs = await this.prisma.backupConfig.findMany({
      where: { enabled: true },
      select: { id: true, engine: true, retention: true },
    });

    for (const config of configs) {
      if (config.engine === BackupEngine.RESTIC) {
        // Restic ретеншн делается в applyResticRetentionIfNeeded после каждого бэкапа
        continue;
      }
      const backups = await this.prisma.backup.findMany({
        where: {
          configId: config.id,
          status: BackupStatus.COMPLETED,
        },
        orderBy: { createdAt: 'desc' },
        skip: config.retention,
        select: { id: true, filePath: true },
      });

      for (const backup of backups) {
        await this.prisma.backup.delete({ where: { id: backup.id } });
      }
    }
  }

  // ===========================================================================
  // Restic diff: snapshot ↔ snapshot, snapshot ↔ live
  // ===========================================================================

  /**
   * Diff между двумя снапшотами (по их restic-snapshot id) одной репы (одно
   * хранилище для обоих). Возвращает плоский список изменений + статистика.
   */
  async diffResticSnapshots(params: {
    siteId: string;
    locationId: string;
    snapshotIdA: string;
    snapshotIdB: string;
    userId: string;
    role: string;
  }) {
    const { siteId, locationId, snapshotIdA, snapshotIdB, userId, role } = params;
    await this.assertSiteAccess(siteId, userId, role);

    if (!/^[a-f0-9]{6,64}$/i.test(snapshotIdA) || !/^[a-f0-9]{6,64}$/i.test(snapshotIdB)) {
      throw new BadRequestException('Некорректный snapshotId');
    }
    if (snapshotIdA === snapshotIdB) {
      throw new BadRequestException('Снапшоты идентичны — нечего сравнивать');
    }

    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { name: true },
    });
    if (!site) throw new NotFoundException('Site not found');

    const loc = await this.storageLocations.getFullConfigForAgent(locationId);
    if (!loc.resticPassword) {
      throw new BadRequestException('У этого хранилища нет Restic-пароля');
    }

    const res = await this.agentRelay.emitToAgent<{
      items: Array<{ path: string; modifier: string }>;
      stats: {
        changedFiles: number;
        addedFiles: number;
        removedFiles: number;
        addedBytes: number;
        removedBytes: number;
      };
    }>(
      'restic:diff-snapshots',
      {
        siteName: site.name,
        storage: { type: loc.type, config: loc.config, password: loc.resticPassword },
        snapshotIdA,
        snapshotIdB,
      },
      300_000,
    );
    if (!res.success) {
      throw new BadRequestException(res.error || 'Не удалось получить diff');
    }
    return res.data;
  }

  /**
   * Diff: снапшот vs текущие live-файлы сайта. snapshotRoot и liveRoot
   * рассчитываются автоматически по rootPath сайта.
   */
  async diffResticSnapshotWithLive(params: {
    siteId: string;
    locationId: string;
    snapshotId: string;
    userId: string;
    role: string;
  }) {
    const { siteId, locationId, snapshotId, userId, role } = params;
    await this.assertSiteAccess(siteId, userId, role);

    if (!/^[a-f0-9]{6,64}$/i.test(snapshotId)) {
      throw new BadRequestException('Некорректный snapshotId');
    }

    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { name: true, rootPath: true },
    });
    if (!site) throw new NotFoundException('Site not found');

    const loc = await this.storageLocations.getFullConfigForAgent(locationId);
    if (!loc.resticPassword) {
      throw new BadRequestException('У этого хранилища нет Restic-пароля');
    }

    const res = await this.agentRelay.emitToAgent<{
      items: Array<{ path: string; modifier: string }>;
      stats: { changedFiles: number; addedFiles: number; removedFiles: number };
    }>(
      'restic:diff-live',
      {
        siteName: site.name,
        storage: { type: loc.type, config: loc.config, password: loc.resticPassword },
        snapshotId,
        snapshotRoot: site.rootPath,
        liveRoot: site.rootPath,
      },
      600_000,
    );
    if (!res.success) {
      throw new BadRequestException(res.error || 'Не удалось получить diff');
    }
    return res.data;
  }

  /**
   * Diff содержимого одного файла между двумя снапами.
   * filePath — путь внутри снапа (абсолютный, как restic его хранит).
   */
  async diffResticFile(params: {
    siteId: string;
    locationId: string;
    snapshotIdA: string;
    snapshotIdB: string;
    filePath: string;
    userId: string;
    role: string;
  }) {
    const { siteId, locationId, snapshotIdA, snapshotIdB, filePath, userId, role } = params;
    await this.assertSiteAccess(siteId, userId, role);

    if (!/^[a-f0-9]{6,64}$/i.test(snapshotIdA) || !/^[a-f0-9]{6,64}$/i.test(snapshotIdB)) {
      throw new BadRequestException('Некорректный snapshotId');
    }
    if (typeof filePath !== 'string' || !filePath.startsWith('/') || filePath.includes('..')) {
      throw new BadRequestException('Некорректный путь файла');
    }

    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { name: true, rootPath: true },
    });
    if (!site) throw new NotFoundException('Site not found');

    // Безопасность: путь должен быть под rootPath сайта (нельзя сравнивать /etc/...).
    if (!filePath.startsWith(site.rootPath + '/') && filePath !== site.rootPath) {
      throw new BadRequestException('Файл вне корня сайта');
    }

    const loc = await this.storageLocations.getFullConfigForAgent(locationId);
    if (!loc.resticPassword) {
      throw new BadRequestException('У этого хранилища нет Restic-пароля');
    }

    const res = await this.agentRelay.emitToAgent<{
      binary?: boolean;
      sizeA?: number;
      sizeB?: number;
      unifiedDiff?: string;
      truncated?: boolean;
    }>(
      'restic:diff-file',
      {
        siteName: site.name,
        storage: { type: loc.type, config: loc.config, password: loc.resticPassword },
        snapshotIdA,
        snapshotIdB,
        filePath,
      },
      120_000,
    );
    if (!res.success) {
      throw new BadRequestException(res.error || 'Не удалось получить diff файла');
    }
    return res.data;
  }

  /**
   * Diff содержимого одного файла: версия из снапа vs текущий live-файл.
   * filePath — путь внутри снапа (= live-путь, у нас они совпадают, restic
   * хранит абсолютные пути относительно ФС агента).
   */
  async diffResticFileWithLive(params: {
    siteId: string;
    locationId: string;
    snapshotId: string;
    filePath: string;
    userId: string;
    role: string;
  }) {
    const { siteId, locationId, snapshotId, filePath, userId, role } = params;
    await this.assertSiteAccess(siteId, userId, role);

    if (!/^[a-f0-9]{6,64}$/i.test(snapshotId)) {
      throw new BadRequestException('Некорректный snapshotId');
    }
    if (typeof filePath !== 'string' || !filePath.startsWith('/') || filePath.includes('..')) {
      throw new BadRequestException('Некорректный путь файла');
    }

    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { name: true, rootPath: true },
    });
    if (!site) throw new NotFoundException('Site not found');

    if (!filePath.startsWith(site.rootPath + '/') && filePath !== site.rootPath) {
      throw new BadRequestException('Файл вне корня сайта');
    }

    const loc = await this.storageLocations.getFullConfigForAgent(locationId);
    if (!loc.resticPassword) {
      throw new BadRequestException('У этого хранилища нет Restic-пароля');
    }

    const res = await this.agentRelay.emitToAgent<{
      binary?: boolean;
      sizeA?: number;
      sizeB?: number;
      unifiedDiff?: string;
      truncated?: boolean;
    }>(
      'restic:diff-file-live',
      {
        siteName: site.name,
        storage: { type: loc.type, config: loc.config, password: loc.resticPassword },
        snapshotId,
        snapshotFilePath: filePath,
        livePath: filePath,
      },
      120_000,
    );
    if (!res.success) {
      throw new BadRequestException(res.error || 'Не удалось получить diff файла');
    }
    return res.data;
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private async assertSiteAccess(siteId: string, userId: string, role: string) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { userId: true },
    });

    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
  }
}
