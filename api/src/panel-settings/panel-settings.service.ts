import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

/**
 * KV-стор глобальных настроек панели.
 * Значения хранятся в SQLite как JSON-строки и парсятся при чтении.
 *
 * Ключи:
 *   - `general`        — мониторинг, автопроверка обновлений, сессии (ТТЛ/лимиты)
 *   - `site-defaults`  — дефолты формы создания сайта + пути хранения файлов
 *   - `backup-defaults`— авто-бэкапы: расписание, хранилище, retention
 */
@Injectable()
export class PanelSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly defaults = {
    general: {
      healthCheckIntervalSec: 60,
      alertCpuPercent: 85,
      alertRamPercent: 85,
      alertDiskPercent: 90,
      autoUpdateCheck: true,
      updateBranch: 'stable',
      sessionMaxAttempts: 5,
      sessionAccessTtlMinutes: 15,
      sessionRefreshTtlDays: 7,
    },
    'site-defaults': {
      // Базовый путь, в котором для каждого сайта создаётся home-директория юзера.
      // Структура: `{sitesBasePath}/{safeName}/{siteFilesRelativePath}` — здесь лежат файлы сайта.
      sitesBasePath: '/var/www',
      // Относительный путь внутри home-директории, куда укладываются сами файлы сайта (nginx root).
      siteFilesRelativePath: 'www',
      // Дефолты формы создания сайта
      defaultPhpVersion: '8.2',
      defaultDbType: 'MARIADB',
      defaultAutoSsl: false,
      defaultHttpsRedirect: true,
    },
    // Глобальные настройки авто-бэкапов (применяются ко всем сайтам,
    // если per-site BackupConfig отсутствует).
    // engine:             TAR | RESTIC (по умолчанию RESTIC — дедупликация)
    // storageLocationIds: список StorageLocation.id — в каждое из них уедет бэкап
    // retention:          для RESTIC — keep-daily/weekly/monthly/yearly
    // retentionDays:      для TAR — кол-во бэкапов, которые держим (legacy)
    'backup-defaults': {
      enabled: false,
      schedule: '0 3 * * *',
      engine: 'RESTIC' as 'TAR' | 'RESTIC',
      type: 'FULL' as 'FULL' | 'FILES_ONLY' | 'DB_ONLY',
      storageLocationIds: [] as string[],
      retention: {
        keepDaily: 7,
        keepWeekly: 4,
        keepMonthly: 6,
        keepYearly: 1,
      },
      retentionDays: 14,
      excludePaths: [] as string[],
      excludeTableData: [] as string[],
      // Плановый `restic check` (verify repo integrity):
      //   checkEnabled       — включить плановую проверку
      //   checkSchedule      — cron (по умолчанию — еженедельно, вс в 04:00)
      //   checkReadData      — делать ли `--read-data`/subset (дорого, но надёжно)
      //   checkReadDataSubset— выборка для --read-data-subset (например "10%")
      //   checkMinIntervalHours — не запускать чаще чем раз в N часов на репу
      checkEnabled: false,
      checkSchedule: '0 4 * * 0',
      checkReadData: false,
      checkReadDataSubset: '10%',
      checkMinIntervalHours: 20,
    },
  } as const;

  async get<T>(key: keyof typeof this.defaults): Promise<T> {
    const row = await this.prisma.panelSetting.findUnique({ where: { key } });
    const fallback = this.defaults[key];
    if (!row) return fallback as unknown as T;
    try {
      const parsed = JSON.parse(row.value);
      return { ...(fallback as object), ...parsed } as T;
    } catch {
      return fallback as unknown as T;
    }
  }

  async set(key: keyof typeof this.defaults, value: unknown): Promise<void> {
    const json = JSON.stringify(value);
    await this.prisma.panelSetting.upsert({
      where: { key },
      create: { key, value: json },
      update: { value: json },
    });
  }

  // Шорткаты для типизации в сервисах:
  async getSiteDefaults(): Promise<{
    sitesBasePath: string;
    siteFilesRelativePath: string;
    defaultPhpVersion: string;
    defaultDbType: string;
    defaultAutoSsl: boolean;
    defaultHttpsRedirect: boolean;
  }> {
    return this.get('site-defaults');
  }

  async getBackupDefaults(): Promise<{
    enabled: boolean;
    schedule: string;
    engine: 'TAR' | 'RESTIC';
    type: 'FULL' | 'FILES_ONLY' | 'DB_ONLY';
    storageLocationIds: string[];
    retention: {
      keepDaily: number;
      keepWeekly: number;
      keepMonthly: number;
      keepYearly: number;
    };
    retentionDays: number;
    excludePaths: string[];
    excludeTableData: string[];
    checkEnabled: boolean;
    checkSchedule: string;
    checkReadData: boolean;
    checkReadDataSubset: string;
    checkMinIntervalHours: number;
  }> {
    return this.get('backup-defaults');
  }
}
