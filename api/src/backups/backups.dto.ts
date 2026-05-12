import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  IsArray,
  IsInt,
  Min,
  Max,
  IsBoolean,
  IsObject,
  MaxLength,
  Matches,
  ArrayMinSize,
} from 'class-validator';
import { CRON_SCHEDULE_REGEX } from '@meowbox/shared';

enum BackupType {
  FULL = 'FULL',
  DIFFERENTIAL = 'DIFFERENTIAL',
  FILES_ONLY = 'FILES_ONLY',
  DB_ONLY = 'DB_ONLY',
}

enum BackupStorageType {
  LOCAL = 'LOCAL',
  S3 = 'S3',
  YANDEX_DISK = 'YANDEX_DISK',
  CLOUD_MAIL_RU = 'CLOUD_MAIL_RU',
}

enum BackupEngine {
  TAR = 'TAR',
  RESTIC = 'RESTIC',
}

export class CreateBackupConfigDto {
  @IsString()
  @IsNotEmpty()
  siteId!: string;

  @IsEnum(BackupType)
  type!: string;

  // Движок бэкапа. Если не задан — TAR (back-compat).
  @IsOptional()
  @IsEnum(BackupEngine)
  engine?: string;

  // Новая схема: список StorageLocation.id. Если указан — legacy storageType/storageConfig
  // игнорируются.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  storageLocationIds?: string[];

  // Legacy (back-compat со старыми формами)
  @IsOptional()
  @IsEnum(BackupStorageType)
  storageType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(CRON_SCHEDULE_REGEX, {
    message: 'Invalid cron schedule format',
  })
  schedule?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  retention?: number;

  // Restic retention (применимо если engine = RESTIC)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  keepDaily?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(52)
  keepWeekly?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(24)
  keepMonthly?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  keepYearly?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  excludePaths?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  excludeTableData?: string[];

  @IsOptional()
  @IsObject()
  storageConfig?: Record<string, string>;

  @IsOptional()
  @IsBoolean()
  keepLocalCopy?: boolean;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class TriggerBackupDto {
  @IsString()
  @IsNotEmpty()
  siteId!: string;

  @IsOptional()
  @IsString()
  configId?: string;

  @IsOptional()
  @IsEnum(BackupType)
  type?: string;

  @IsOptional()
  @IsEnum(BackupEngine)
  engine?: string;

  // Для ручного бэкапа: StorageLocation.id (одно место).
  @IsOptional()
  @IsString()
  storageLocationId?: string;

  // Для запуска из scheduler (SiteBackupSchedule) — список хранилищ,
  // создаст по бэкапу на каждое (как в server-path/panel-data flow).
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  storageLocationIds?: string[];

  // Legacy (back-compat)
  @IsOptional()
  @IsEnum(BackupStorageType)
  storageType?: string;

  @IsOptional()
  @IsObject()
  storageConfig?: Record<string, string>;

  // Одноразовые overrides — если переданы, перебивают глобальные дефолты.
  // Пустой массив = явное "без excludes", undefined = взять дефолты из settings.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  excludePaths?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  excludeTableData?: string[];

  // Селективный выбор БД для бэкапа. Применяется ТОЛЬКО если backupType
  // включает БД (FULL / DIFFERENTIAL / DB_ONLY). undefined — все БД сайта.
  // Пустой массив для DB_ONLY/FULL — отказ (нет смысла).
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  databaseIds?: string[];
}

// Глобальные настройки авто-бэкапов (PanelSetting key: "backup-defaults")
export class UpdateAutoBackupSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(CRON_SCHEDULE_REGEX, {
    message: 'Invalid cron schedule format',
  })
  schedule?: string;

  @IsOptional()
  @IsEnum(BackupEngine)
  engine?: string;

  @IsOptional()
  @IsEnum(BackupType)
  type?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  storageLocationIds?: string[];

  @IsOptional()
  @IsObject()
  retention?: {
    keepDaily?: number;
    keepWeekly?: number;
    keepMonthly?: number;
    keepYearly?: number;
  };

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  retentionDays?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  excludePaths?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  excludeTableData?: string[];

  // ── Restic check (структурная/глубокая проверка репозиториев) ──
  @IsOptional()
  @IsBoolean()
  checkEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(CRON_SCHEDULE_REGEX, {
    message: 'Invalid cron schedule format',
  })
  checkSchedule?: string;

  @IsOptional()
  @IsBoolean()
  checkReadData?: boolean;

  // Формат: число или процент ('10', '10%'). См. agent/src/backup/restic.executor.ts.
  @IsOptional()
  @IsString()
  @MaxLength(8)
  @Matches(/^\d{1,3}%?$/, {
    message: 'checkReadDataSubset must be like "10" or "10%"',
  })
  checkReadDataSubset?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(720)
  checkMinIntervalHours?: number;
}

// ─── Restore & Restic check DTOs ───

import { IsUUID } from 'class-validator';

// Что восстанавливать целиком: файлы и БД, только файлы, только БД.
// Радиокнопка верхнего уровня в диалоге восстановления.
enum RestoreScope {
  FILES_AND_DB = 'FILES_AND_DB',
  FILES_ONLY = 'FILES_ONLY',
  DB_ONLY = 'DB_ONLY',
}

export class RestoreBackupDto {
  @IsOptional()
  @IsBoolean()
  cleanup?: boolean;

  // Что восстанавливать. По умолчанию (если не указано) — FILES_AND_DB
  // (полное восстановление), сохраняет старое поведение API.
  @IsOptional()
  @IsEnum(RestoreScope)
  scope?: string;

  // Селектив-restore: какие пути (относительно rootPath) восстанавливать.
  // Только для scope=FILES_AND_DB | FILES_ONLY. undefined/[] — всё (старое поведение).
  // Glob не поддерживается — это явный список путей первого уровня из дерева снапшота.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  includePaths?: string[];

  // Селектив-restore по БД. Применяется только для scope = FILES_AND_DB | DB_ONLY.
  // undefined → все БД сайта (back-compat). Пустой массив → ни одна не ресторится.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  databaseIds?: string[];
}

export class RestoreResticSnapshotDto {
  @IsUUID()
  locationId!: string;

  @IsOptional()
  @IsBoolean()
  cleanup?: boolean;

  @IsOptional()
  @IsEnum(RestoreScope)
  scope?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  includePaths?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  databaseIds?: string[];
}

export class RunResticCheckDto {
  @IsUUID()
  locationId!: string;

  @IsOptional()
  @IsBoolean()
  readData?: boolean;

  // restic принимает формат `<N>%` (1-100) или `<N>/<M>`. Не пропускаем ничего
  // другого — команда формируется через execFile, но доверять unvalidated-строке
  // в shell-безопасных флагах — плохая привычка.
  @IsOptional()
  @IsString()
  @Matches(/^(\d{1,3}%|\d+\/\d+)$/, {
    message: 'readDataSubset must be "N%" or "N/M"',
  })
  readDataSubset?: string;
}

// =============================================================================
// Restic diff: snapshot ↔ snapshot, snapshot ↔ live
// =============================================================================

export class DiffResticSnapshotsDto {
  @IsUUID()
  locationId!: string;

  @IsString()
  @Matches(/^[a-f0-9]{6,64}$/i, { message: 'snapshotIdA: hex, 6-64 chars' })
  snapshotIdA!: string;

  @IsString()
  @Matches(/^[a-f0-9]{6,64}$/i, { message: 'snapshotIdB: hex, 6-64 chars' })
  snapshotIdB!: string;
}

export class DiffResticLiveDto {
  @IsUUID()
  locationId!: string;

  @IsString()
  @Matches(/^[a-f0-9]{6,64}$/i, { message: 'snapshotId: hex, 6-64 chars' })
  snapshotId!: string;
}

export class DiffResticFileDto {
  @IsUUID()
  locationId!: string;

  @IsString()
  @Matches(/^[a-f0-9]{6,64}$/i, { message: 'snapshotIdA: hex, 6-64 chars' })
  snapshotIdA!: string;

  @IsString()
  @Matches(/^[a-f0-9]{6,64}$/i, { message: 'snapshotIdB: hex, 6-64 chars' })
  snapshotIdB!: string;

  @IsString()
  @MaxLength(4096)
  filePath!: string;
}

export class DiffResticFileLiveDto {
  @IsUUID()
  locationId!: string;

  @IsString()
  @Matches(/^[a-f0-9]{6,64}$/i, { message: 'snapshotId: hex, 6-64 chars' })
  snapshotId!: string;

  @IsString()
  @MaxLength(4096)
  filePath!: string;
}
