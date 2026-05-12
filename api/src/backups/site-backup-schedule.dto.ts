/**
 * DTOs для SiteBackupSchedule — множественные глобальные шедули per-site
 * бэкапов (см. Prisma model SiteBackupSchedule).
 */
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

enum BackupEngine {
  TAR = 'TAR',
  RESTIC = 'RESTIC',
}

enum NotificationMode {
  INSTANT = 'INSTANT',
  DIGEST = 'DIGEST',
  FAILURES_ONLY = 'FAILURES_ONLY',
}

export class CreateSiteBackupScheduleDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsEnum(BackupType)
  type?: string;

  @IsOptional()
  @IsEnum(BackupEngine)
  engine?: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  storageLocationIds!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(CRON_SCHEDULE_REGEX, { message: 'Invalid cron schedule format' })
  schedule?: string;

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

  @IsOptional()
  @IsBoolean()
  checkEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(CRON_SCHEDULE_REGEX, { message: 'Invalid cron schedule format' })
  checkSchedule?: string;

  @IsOptional()
  @IsBoolean()
  checkReadData?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  @Matches(/^\d{1,3}%?$/, { message: 'checkReadDataSubset must be like "10" or "10%"' })
  checkReadDataSubset?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(720)
  checkMinIntervalHours?: number;

  @IsOptional()
  @IsEnum(NotificationMode)
  notificationMode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(CRON_SCHEDULE_REGEX, { message: 'Invalid cron schedule format' })
  digestSchedule?: string;
}

export class UpdateSiteBackupScheduleDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsEnum(BackupType)
  type?: string;

  @IsOptional()
  @IsEnum(BackupEngine)
  engine?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  storageLocationIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(CRON_SCHEDULE_REGEX, { message: 'Invalid cron schedule format' })
  schedule?: string;

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

  @IsOptional()
  @IsBoolean()
  checkEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(CRON_SCHEDULE_REGEX, { message: 'Invalid cron schedule format' })
  checkSchedule?: string;

  @IsOptional()
  @IsBoolean()
  checkReadData?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  @Matches(/^\d{1,3}%?$/, { message: 'checkReadDataSubset must be like "10" or "10%"' })
  checkReadDataSubset?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(720)
  checkMinIntervalHours?: number;

  @IsOptional()
  @IsEnum(NotificationMode)
  notificationMode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(CRON_SCHEDULE_REGEX, { message: 'Invalid cron schedule format' })
  digestSchedule?: string;
}
