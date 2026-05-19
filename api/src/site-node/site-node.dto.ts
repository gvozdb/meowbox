import {
  IsString,
  IsBoolean,
  IsIn,
  IsOptional,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  MaxLength,
  MinLength,
  Matches,
  IsInt,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

// Абсолютный путь без NUL-байта. Защита от обхода (`..`) — на стороне агента
// (`assertWithinHome` резолвит путь и проверяет вхождение в домашнюю дир сайта).
const ABS_PATH = /^\/[^\0]*$/;
// npm-скрипт / make-таргет.
const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,99}$/;
// Имя PM2-процесса.
const PROC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export class EcosystemStartDto {
  @IsString()
  @MaxLength(512)
  @Matches(ABS_PATH, { message: 'file must be an absolute path' })
  file!: string;

  /** Запустить только одно приложение из ecosystem-файла (по имени). */
  @IsOptional()
  @IsString()
  @Matches(PROC_NAME_RE, { message: 'invalid process name' })
  only?: string;
}

export class AutostartDto {
  @IsBoolean()
  enabled!: boolean;
}

export class QuickCommandInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  label!: string;

  @IsIn(['npm', 'make'])
  source!: 'npm' | 'make';

  @IsString()
  @Matches(TARGET_RE, { message: 'invalid command target' })
  target!: string;

  @IsString()
  @MaxLength(512)
  @Matches(ABS_PATH, { message: 'cwd must be an absolute path' })
  cwd!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class QuickCommandsReplaceDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => QuickCommandInputDto)
  commands!: QuickCommandInputDto[];
}
