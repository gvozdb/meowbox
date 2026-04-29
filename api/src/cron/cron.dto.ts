import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  MaxLength,
  Matches,
} from 'class-validator';
import { CRON_SCHEDULE_REGEX } from '@meowbox/shared';

enum CronJobStatus {
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
}

/**
 * Cron command: запрещаем управляющие символы, которые могут сломать crontab.
 *
 * - `\n`/`\r` → внедрение новой строки в crontab (новый job!)
 * - `\0` → может обрезать строку в файле при записи
 * - `#` в начале команды → закомментирование маркера meowbox
 * - Маркер `# meowbox:` → poison маркера, удаление чужих записей
 *
 * Shell-метасимволы (`|`, `;`, `&`) — НЕ запрещаем. Это легитимное использование
 * в cron (пайпы, цепочки команд). Злоупотребление невозможно: команды и так
 * запускаются от имени site-юзера с ограниченными правами (fix per-user).
 */
const CRON_COMMAND_FORBIDDEN = /[\x00-\x09\x0b-\x1f\x7f]/;

function validateCronCommand(v: string): string | null {
  if (CRON_COMMAND_FORBIDDEN.test(v)) {
    return 'Command contains forbidden control characters (newlines, null bytes, etc.)';
  }
  if (v.trim().startsWith('#')) {
    return 'Command cannot start with "#"';
  }
  if (v.includes('# meowbox:')) {
    return 'Command cannot contain the reserved marker "# meowbox:"';
  }
  return null;
}

import { registerDecorator, ValidationOptions, ValidationArguments } from 'class-validator';

export function IsSafeCronCommand(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isSafeCronCommand',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') return false;
          return validateCronCommand(value) === null;
        },
        defaultMessage(args: ValidationArguments) {
          const v = args.value;
          return typeof v === 'string'
            ? validateCronCommand(v) || 'Invalid cron command'
            : 'Invalid cron command';
        },
      },
    });
  };
}

export class CreateCronJobDto {
  @IsString()
  @IsNotEmpty()
  siteId!: string;

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
}

export class UpdateCronJobDto {
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
  @IsEnum(CronJobStatus)
  status?: string;
}
