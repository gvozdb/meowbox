import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { CRON_SCHEDULE_REGEX } from '@meowbox/shared';
import { IsSafeCronCommand } from '../cron/cron.dto';

enum SystemCronJobStatus {
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
}

/**
 * DTO для ROOT-крона (вне привязки к Site). См. /opt/meowbox/docs/specs/2026-05-01-hostpanel-migration.md §8.3.
 *
 * Валидация имени/расписания/команды переиспользует правила per-site крона
 * (см. cron.dto.ts) — те же шаблоны и тот же IsSafeCronCommand. Команды бегут
 * под root, поэтому риски выше — будь внимателен с allow-list'ами на UI.
 */
export class CreateSystemCronJobDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(CRON_SCHEDULE_REGEX, {
    message: 'Invalid cron schedule format (5 fields separated by spaces/tabs)',
  })
  schedule!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  @IsSafeCronCommand()
  command!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  comment?: string;
}

export class UpdateSystemCronJobDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(CRON_SCHEDULE_REGEX, {
    message: 'Invalid cron schedule format (5 fields separated by spaces/tabs)',
  })
  schedule?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  @IsSafeCronCommand()
  command?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  comment?: string;

  @IsOptional()
  @IsEnum(SystemCronJobStatus)
  status?: string;
}
