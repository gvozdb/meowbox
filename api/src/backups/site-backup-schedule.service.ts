import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { BackupsService } from './backups.service';
import { parseStringArray, stringifyStringArray } from '../common/json-array';
import {
  CreateSiteBackupScheduleDto,
  UpdateSiteBackupScheduleDto,
} from './site-backup-schedule.dto';

/**
 * Множественные глобальные шедули per-site бэкапов.
 *
 * Каждый шедуль — это пресет (engine/type/storages/schedule/retention),
 * который применяется ко ВСЕМ сайтам, у которых нет per-site BackupConfig.
 *
 * Заменяет старый одиночный `PanelSetting('backup-defaults')`. Перенос данных
 * выполняется системной миграцией 2026-05-12-001.
 */
@Injectable()
export class SiteBackupScheduleService {
  private readonly logger = new Logger('SiteBackupScheduleService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly backups: BackupsService,
  ) {}

  // =========================================================================
  // CRUD
  // =========================================================================

  async list() {
    const items = await this.prisma.siteBackupSchedule.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return items.map((s) => this.formatForApi(s));
  }

  async get(id: string) {
    const item = await this.prisma.siteBackupSchedule.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Site backup schedule not found');
    return this.formatForApi(item);
  }

  async create(dto: CreateSiteBackupScheduleDto) {
    const locIds = dto.storageLocationIds || [];
    if (locIds.length === 0) {
      throw new BadRequestException('Минимум одно хранилище должно быть выбрано');
    }
    await this.validateStorages(locIds, dto.engine || 'RESTIC');

    const created = await this.prisma.siteBackupSchedule.create({
      data: {
        name: dto.name,
        enabled: dto.enabled ?? true,
        type: dto.type || 'FULL',
        engine: dto.engine || 'RESTIC',
        storageLocationIds: stringifyStringArray(locIds),
        schedule: dto.schedule || null,
        keepDaily: dto.keepDaily ?? 7,
        keepWeekly: dto.keepWeekly ?? 4,
        keepMonthly: dto.keepMonthly ?? 6,
        keepYearly: dto.keepYearly ?? 1,
        retentionDays: dto.retentionDays ?? 7,
        excludePaths: stringifyStringArray(dto.excludePaths || []),
        excludeTableData: stringifyStringArray(dto.excludeTableData || []),
        checkEnabled: dto.checkEnabled ?? false,
        checkSchedule: dto.checkSchedule || null,
        checkReadData: dto.checkReadData ?? false,
        checkReadDataSubset: dto.checkReadDataSubset || null,
        checkMinIntervalHours: dto.checkMinIntervalHours ?? 168,
        notificationMode: dto.notificationMode || 'INSTANT',
        digestSchedule: dto.digestSchedule || null,
        storageLocations: { connect: locIds.map((id) => ({ id })) },
      },
    });
    return this.formatForApi(created);
  }

  async update(id: string, dto: UpdateSiteBackupScheduleDto) {
    const existing = await this.prisma.siteBackupSchedule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Schedule not found');

    let storageLocationIds: string | undefined;
    let connect: Array<{ id: string }> | undefined;
    let disconnect: Array<{ id: string }> | undefined;
    if (dto.storageLocationIds) {
      if (dto.storageLocationIds.length === 0) {
        throw new BadRequestException('Минимум одно хранилище должно быть выбрано');
      }
      await this.validateStorages(dto.storageLocationIds, dto.engine || existing.engine);
      const old = parseStringArray(existing.storageLocationIds);
      const oldSet = new Set(old);
      const newSet = new Set(dto.storageLocationIds);
      connect = dto.storageLocationIds.filter((x) => !oldSet.has(x)).map((id) => ({ id }));
      disconnect = old.filter((x) => !newSet.has(x)).map((id) => ({ id }));
      storageLocationIds = stringifyStringArray(dto.storageLocationIds);
    }

    const updated = await this.prisma.siteBackupSchedule.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.engine !== undefined && { engine: dto.engine }),
        ...(storageLocationIds !== undefined && { storageLocationIds }),
        ...(dto.schedule !== undefined && { schedule: dto.schedule || null }),
        ...(dto.keepDaily !== undefined && { keepDaily: dto.keepDaily }),
        ...(dto.keepWeekly !== undefined && { keepWeekly: dto.keepWeekly }),
        ...(dto.keepMonthly !== undefined && { keepMonthly: dto.keepMonthly }),
        ...(dto.keepYearly !== undefined && { keepYearly: dto.keepYearly }),
        ...(dto.retentionDays !== undefined && { retentionDays: dto.retentionDays }),
        ...(dto.excludePaths !== undefined && {
          excludePaths: stringifyStringArray(dto.excludePaths),
        }),
        ...(dto.excludeTableData !== undefined && {
          excludeTableData: stringifyStringArray(dto.excludeTableData),
        }),
        ...(dto.checkEnabled !== undefined && { checkEnabled: dto.checkEnabled }),
        ...(dto.checkSchedule !== undefined && { checkSchedule: dto.checkSchedule || null }),
        ...(dto.checkReadData !== undefined && { checkReadData: dto.checkReadData }),
        ...(dto.checkReadDataSubset !== undefined && {
          checkReadDataSubset: dto.checkReadDataSubset || null,
        }),
        ...(dto.checkMinIntervalHours !== undefined && {
          checkMinIntervalHours: dto.checkMinIntervalHours,
        }),
        ...(dto.notificationMode !== undefined && { notificationMode: dto.notificationMode }),
        ...(dto.digestSchedule !== undefined && { digestSchedule: dto.digestSchedule || null }),
        ...(connect && connect.length > 0 ? { storageLocations: { connect } } : {}),
        ...(disconnect && disconnect.length > 0 ? { storageLocations: { disconnect } } : {}),
      },
    });
    return this.formatForApi(updated);
  }

  async delete(id: string) {
    const existing = await this.prisma.siteBackupSchedule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Schedule not found');
    await this.prisma.siteBackupSchedule.delete({ where: { id } });
    return { ok: true };
  }

  // =========================================================================
  // Trigger: применить шедуль ко всем сайтам прямо сейчас
  // =========================================================================

  async triggerForAllSites(scheduleId: string) {
    const schedule = await this.prisma.siteBackupSchedule.findUnique({
      where: { id: scheduleId },
    });
    if (!schedule) throw new NotFoundException('Schedule not found');
    if (!schedule.enabled) {
      throw new BadRequestException('Schedule disabled');
    }
    const locIds = parseStringArray(schedule.storageLocationIds);
    if (locIds.length === 0) {
      throw new BadRequestException('Не выбрано ни одного хранилища');
    }

    // Сайты, не покрытые per-site BackupConfig (см. scheduler — та же логика).
    const coveredConfigs = await this.prisma.backupConfig.findMany({
      where: { enabled: true, schedule: { not: null } },
      select: { siteId: true },
    });
    const coveredSet = new Set(coveredConfigs.map((c) => c.siteId));

    const sites = await this.prisma.site.findMany({
      where: { id: { notIn: Array.from(coveredSet) } },
      select: { id: true, name: true, userId: true },
    });

    const launched: Array<{ siteId: string; siteName: string }> = [];
    const errors: Array<{ siteId: string; siteName: string; error: string }> = [];

    for (const site of sites) {
      // Активный бэкап?
      const active = await this.prisma.backup.findFirst({
        where: { siteId: site.id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      });
      if (active) {
        errors.push({ siteId: site.id, siteName: site.name, error: 'Активный бэкап уже идёт' });
        continue;
      }

      try {
        await this.backups.triggerBackup(
          {
            siteId: site.id,
            scheduleId: schedule.id,
            type: schedule.type,
            engine: schedule.engine,
            storageLocationIds: locIds,
            excludePaths: parseStringArray(schedule.excludePaths),
            excludeTableData: parseStringArray(schedule.excludeTableData),
          },
          site.userId,
          'ADMIN',
        );
        launched.push({ siteId: site.id, siteName: site.name });
      } catch (err) {
        errors.push({
          siteId: site.id,
          siteName: site.name,
          error: (err as Error).message,
        });
      }
    }

    return {
      schedule: { id: schedule.id, name: schedule.name },
      launched,
      errors,
    };
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private async validateStorages(ids: string[], engine: string) {
    const locs = await this.prisma.storageLocation.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, resticEnabled: true },
    });
    if (locs.length !== ids.length) {
      throw new BadRequestException('Некоторые StorageLocation не найдены');
    }
    if (engine === 'RESTIC') {
      const bad = locs.filter((l) => !l.resticEnabled);
      if (bad.length > 0) {
        throw new BadRequestException(
          `Restic не поддерживается: ${bad.map((l) => l.name).join(', ')}`,
        );
      }
    }
  }

  private formatForApi(s: {
    id: string;
    name: string;
    enabled: boolean;
    type: string;
    engine: string;
    storageLocationIds: string;
    schedule: string | null;
    keepDaily: number;
    keepWeekly: number;
    keepMonthly: number;
    keepYearly: number;
    retentionDays: number;
    excludePaths: string;
    excludeTableData: string;
    checkEnabled: boolean;
    checkSchedule: string | null;
    checkReadData: boolean;
    checkReadDataSubset: string | null;
    checkMinIntervalHours: number;
    notificationMode: string;
    digestSchedule: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      ...s,
      storageLocationIds: parseStringArray(s.storageLocationIds),
      excludePaths: parseStringArray(s.excludePaths),
      excludeTableData: parseStringArray(s.excludeTableData),
    };
  }
}
