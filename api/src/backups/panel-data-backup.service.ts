import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { BackupEngine, BackupStatus } from '../common/enums';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service';
import { NotificationDigestService, DigestNotificationMode } from '../notifications/notification-digest.service';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import {
  CreatePanelDataBackupDto,
  UpdatePanelDataBackupDto,
} from './server-path-backup.dto';
import { parseStringArray, stringifyStringArray, parseJsonObject } from '../common/json-array';

const execFileP = promisify(execFile);

const RESTIC_COMPATIBLE = new Set(['LOCAL', 'S3']);

/**
 * Бэкап данных самой панели: БД (через VACUUM INTO), все master-keys, .env,
 * servers.json, vpn state, /etc/letsencrypt.
 *
 * UI для путей нет — preset защищает от ошибки "забыл .master-key".
 */
function panelDataPaths(stateDir: string, dbSnapshotPath: string): string[] {
  const dataDir = path.join(stateDir, 'data');
  const paths: string[] = [
    dbSnapshotPath, // ВНИМАНИЕ: это snapshot, не live БД
  ];

  // Все возможные ключи (новые и legacy)
  for (const f of fs.readdirSync(dataDir).filter((n) => /^\.(master|vpn|dns)-key/.test(n))) {
    paths.push(path.join(dataDir, f));
  }

  // state/.env
  if (fs.existsSync(`${stateDir}/.env`)) paths.push(`${stateDir}/.env`);

  // state/data/servers.json
  if (fs.existsSync(`${dataDir}/servers.json`)) paths.push(`${dataDir}/servers.json`);

  // state/vpn/ — Xray configs etc.
  if (fs.existsSync(`${stateDir}/vpn`)) paths.push(`${stateDir}/vpn/`);

  // SSL сертификаты Let's Encrypt
  if (fs.existsSync('/etc/letsencrypt')) paths.push('/etc/letsencrypt/');

  return paths;
}

@Injectable()
export class PanelDataBackupService {
  private readonly logger = new Logger('PanelDataBackupService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly notifier: NotificationDispatcherService,
    private readonly digest: NotificationDigestService,
  ) {}

  // ===========================================================================
  // CRUD
  // ===========================================================================

  async list() {
    const configs = await this.prisma.panelDataBackupConfig.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return configs.map((c) => ({
      ...c,
      storageLocationIds: parseStringArray(c.storageLocationIds),
    }));
  }

  async get(id: string) {
    const config = await this.prisma.panelDataBackupConfig.findUnique({ where: { id } });
    if (!config) throw new NotFoundException('Panel-data backup config not found');
    return {
      ...config,
      storageLocationIds: parseStringArray(config.storageLocationIds),
    };
  }

  async create(dto: CreatePanelDataBackupDto) {
    const locIds = dto.storageLocationIds;
    if (locIds.length === 0) {
      throw new BadRequestException('Минимум одно хранилище должно быть выбрано');
    }
    const locs = await this.prisma.storageLocation.findMany({
      where: { id: { in: locIds } },
      select: { id: true, resticEnabled: true, name: true },
    });
    if (locs.length !== locIds.length) {
      throw new BadRequestException('Некоторые StorageLocation не найдены');
    }
    if (dto.engine === 'RESTIC') {
      const bad = locs.filter((l) => !l.resticEnabled);
      if (bad.length > 0) {
        throw new BadRequestException(
          `Restic не поддерживается: ${bad.map((l) => l.name).join(', ')}`,
        );
      }
    }

    const created = await this.prisma.panelDataBackupConfig.create({
      data: {
        name: dto.name,
        engine: dto.engine,
        storageLocationIds: stringifyStringArray(locIds),
        schedule: dto.schedule || null,
        retention: dto.retention ?? 7,
        keepDaily: dto.keepDaily ?? 24,
        keepWeekly: dto.keepWeekly ?? 7,
        keepMonthly: dto.keepMonthly ?? 12,
        keepYearly: dto.keepYearly ?? 5,
        enabled: dto.enabled ?? true,
        notificationMode: dto.notificationMode ?? 'INSTANT',
        digestSchedule:
          dto.notificationMode === 'DIGEST' ? dto.digestSchedule ?? null : null,
        storageLocations: { connect: locIds.map((id) => ({ id })) },
      },
    });
    return this.get(created.id);
  }

  async update(id: string, dto: UpdatePanelDataBackupDto) {
    const existing = await this.prisma.panelDataBackupConfig.findUnique({ where: { id } });
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

    await this.prisma.panelDataBackupConfig.update({
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
    const existing = await this.prisma.panelDataBackupConfig.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Config not found');
    await this.prisma.panelDataBackupConfig.delete({ where: { id } });
    return { ok: true };
  }

  // ===========================================================================
  // Trigger backup — VACUUM INTO + agent dispatch
  // ===========================================================================

  async triggerBackup(configId: string) {
    const config = await this.prisma.panelDataBackupConfig.findUnique({
      where: { id: configId },
    });
    if (!config) throw new NotFoundException('Config not found');
    if (!config.enabled) {
      throw new BadRequestException('Config disabled');
    }

    const active = await this.prisma.panelDataBackup.findFirst({
      where: {
        configId,
        status: { in: [BackupStatus.PENDING, BackupStatus.IN_PROGRESS] },
      },
    });
    if (active) {
      throw new BadRequestException('Active panel-data backup already running');
    }

    // 1) Делаем VACUUM INTO snapshot БД во временный файл
    const stateDir = process.env.MEOWBOX_STATE_DIR?.trim() || '/opt/meowbox/state';
    const dbFile = `${stateDir}/data/meowbox.db`;
    const snapshotsDir = `${stateDir}/data/snapshots`;
    fs.mkdirSync(snapshotsDir, { recursive: true });
    const ts = Date.now();
    const dbSnapshotPath = `${snapshotsDir}/panel-backup-${ts}.db`;

    try {
      await execFileP('sqlite3', [dbFile, `VACUUM INTO '${dbSnapshotPath}'`]);
    } catch (e) {
      throw new InternalServerErrorException(
        `VACUUM INTO failed: ${(e as Error).message}`,
      );
    }

    // 2) Собираем все пути для бэкапа
    const allPaths = panelDataPaths(stateDir, dbSnapshotPath);

    // 3) Загружаем хранилища, создаём отдельный Backup на каждое
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
      const backup = await this.prisma.panelDataBackup.create({
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
        paths: allPaths,
        engine: config.engine as BackupEngine,
        dbSnapshotPath,
        location: {
          id: loc.id,
          name: loc.name,
          type: loc.type,
          config: parseJsonObject<Record<string, string>>(loc.config, {}),
          resticPassword: loc.resticPassword,
        },
      }).catch((err) => {
        this.logger.error(`Dispatch failed for ${backup.id}: ${(err as Error).message}`);
        this.prisma.panelDataBackup
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

    return { backups: created, config: { id: config.id, name: config.name }, snapshotPath: dbSnapshotPath };
  }

  private async dispatchBackup(params: {
    backupId: string;
    configName: string;
    paths: string[];
    engine: BackupEngine;
    dbSnapshotPath: string;
    location: {
      id: string;
      name: string;
      type: string;
      config: Record<string, string>;
      resticPassword: string | null;
    };
  }): Promise<void> {
    const { backupId, configName, paths, engine, location } = params;

    if (engine === BackupEngine.RESTIC) {
      if (!RESTIC_COMPATIBLE.has(location.type) || !location.resticPassword) {
        throw new Error(`Restic не поддерживает location ${location.name}`);
      }
      this.agentRelay.emitToAgentAsync('restic:backup-paths', {
        backupId,
        scope: 'PANEL_DATA',
        repoName: this.slugify(configName),
        paths,
        excludePaths: [],
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
      scope: 'PANEL_DATA',
      archiveName: this.slugify(configName),
      paths,
      excludePaths: [],
      storageType: location.type,
      storageConfig: location.config,
    });
  }

  private slugify(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'panel-data';
  }

  // ===========================================================================
  // Callbacks
  // ===========================================================================

  async updateProgress(backupId: string, progress: number) {
    await this.prisma.panelDataBackup.updateMany({
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
    const backup = await this.prisma.panelDataBackup.findUnique({
      where: { id: backupId },
      include: { config: { select: { id: true, name: true, notificationMode: true } } },
    });
    if (!backup) return;

    await this.prisma.panelDataBackup.update({
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

    // Cleanup DB snapshot файла (regex выводим из filePath, если был передан, иначе ищем самый свежий)
    try {
      const snapshotsDir = path.join(
        process.env.MEOWBOX_STATE_DIR?.trim() || '/opt/meowbox/state',
        'data',
        'snapshots',
      );
      if (fs.existsSync(snapshotsDir)) {
        const entries = fs
          .readdirSync(snapshotsDir)
          .filter((f) => /^panel-backup-\d+\.db$/.test(f));
        // удаляем все panel-backup-*.db, оставляя только последние 3 (для отладки)
        const sorted = entries.sort();
        if (sorted.length > 3) {
          for (const f of sorted.slice(0, sorted.length - 3)) {
            fs.unlinkSync(path.join(snapshotsDir, f));
          }
        }
      }
    } catch (e) {
      this.logger.warn(`Snapshot cleanup failed: ${(e as Error).message}`);
    }

    const mode = (backup.config.notificationMode || 'INSTANT') as DigestNotificationMode;
    this.digest
      .handleCompletion(
        {
          configType: 'PANEL_DATA',
          configId: backup.config.id,
          configName: backup.config.name,
          resourceLabel: backup.config.name,
          success,
          sizeBytes,
          errorMessage,
        },
        mode,
      )
      .catch((err) => this.logger.error(`Notification failed: ${(err as Error).message}`));
  }

  async listBackups(configId: string, page = 1, perPage = 20) {
    const take = Math.min(perPage, 50);
    const skip = (page - 1) * take;
    const [backups, total] = await Promise.all([
      this.prisma.panelDataBackup.findMany({
        where: { configId },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: { storageLocation: { select: { id: true, name: true, type: true } } },
      }),
      this.prisma.panelDataBackup.count({ where: { configId } }),
    ]);
    return {
      backups,
      meta: { page, perPage: take, total, totalPages: Math.ceil(total / take) },
    };
  }
}
