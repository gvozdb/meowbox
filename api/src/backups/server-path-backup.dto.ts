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
  ArrayMaxSize,
} from 'class-validator';
import { CRON_SCHEDULE_REGEX } from '@meowbox/shared';

export enum BackupEngineDto {
  TAR = 'TAR',
  RESTIC = 'RESTIC',
}

export class CreateServerPathBackupDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  name!: string;

  @IsString() @IsNotEmpty() @MaxLength(4096)
  @Matches(/^\/[^\0\n\r]*$/, { message: 'Путь должен быть абсолютным и без управляющих символов' })
  path!: string;

  @IsEnum(BackupEngineDto)
  engine!: BackupEngineDto;

  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  storageLocationIds!: string[];

  @IsString() @IsOptional()
  @Matches(CRON_SCHEDULE_REGEX, { message: 'Невалидный cron schedule' })
  schedule?: string;

  @IsInt() @Min(1) @Max(365) @IsOptional()
  retention?: number;

  @IsInt() @Min(0) @Max(365) @IsOptional()
  keepDaily?: number;
  @IsInt() @Min(0) @Max(52) @IsOptional()
  keepWeekly?: number;
  @IsInt() @Min(0) @Max(60) @IsOptional()
  keepMonthly?: number;
  @IsInt() @Min(0) @Max(20) @IsOptional()
  keepYearly?: number;

  @IsArray() @IsOptional() @ArrayMaxSize(200)
  @IsString({ each: true })
  excludePaths?: string[];

  @IsBoolean() @IsOptional()
  enabled?: boolean;

  /** Подтверждение, что юзер прочитал warning'и о dangerous path. */
  @IsBoolean() @IsOptional()
  warningAcknowledged?: boolean;
}

export class UpdateServerPathBackupDto {
  @IsString() @IsOptional() @MaxLength(120)
  name?: string;

  @IsArray() @IsOptional() @ArrayMaxSize(8)
  @IsString({ each: true })
  storageLocationIds?: string[];

  @IsString() @IsOptional()
  @Matches(CRON_SCHEDULE_REGEX, { message: 'Невалидный cron schedule' })
  schedule?: string;

  @IsInt() @Min(1) @Max(365) @IsOptional()
  retention?: number;

  @IsInt() @Min(0) @Max(365) @IsOptional()
  keepDaily?: number;
  @IsInt() @Min(0) @Max(52) @IsOptional()
  keepWeekly?: number;
  @IsInt() @Min(0) @Max(60) @IsOptional()
  keepMonthly?: number;
  @IsInt() @Min(0) @Max(20) @IsOptional()
  keepYearly?: number;

  @IsArray() @IsOptional() @ArrayMaxSize(200)
  @IsString({ each: true })
  excludePaths?: string[];

  @IsBoolean() @IsOptional()
  enabled?: boolean;
}

export class CreatePanelDataBackupDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  name!: string;

  @IsEnum(BackupEngineDto)
  engine!: BackupEngineDto;

  @IsArray() @ArrayMaxSize(8)
  @IsString({ each: true })
  storageLocationIds!: string[];

  @IsString() @IsOptional()
  @Matches(CRON_SCHEDULE_REGEX, { message: 'Невалидный cron schedule' })
  schedule?: string;

  @IsInt() @Min(1) @Max(365) @IsOptional()
  retention?: number;

  @IsInt() @Min(0) @Max(365) @IsOptional()
  keepDaily?: number;
  @IsInt() @Min(0) @Max(52) @IsOptional()
  keepWeekly?: number;
  @IsInt() @Min(0) @Max(60) @IsOptional()
  keepMonthly?: number;
  @IsInt() @Min(0) @Max(20) @IsOptional()
  keepYearly?: number;

  @IsBoolean() @IsOptional()
  enabled?: boolean;
}
