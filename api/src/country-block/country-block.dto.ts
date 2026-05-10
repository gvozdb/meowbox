import {
  IsString, IsOptional, IsBoolean, IsIn, MaxLength, Matches,
} from 'class-validator';

const PROTOCOLS = ['TCP', 'UDP', 'BOTH'] as const;
const SOURCES = ['IPDENY', 'GITHUB_HERRBISCH'] as const;

export class CreateCountryBlockDto {
  /** ISO 3166-1 alpha-2, например "RU", "CN". */
  @IsString()
  @Matches(/^[A-Za-z]{2}$/, { message: 'country должен быть кодом ISO 3166-1 alpha-2' })
  country!: string;

  /** CSV портов (22,80,443) или диапазон 8000:9000. Пусто = все порты. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[\d,:\s-]*$/, { message: 'ports содержит недопустимые символы' })
  ports?: string;

  @IsIn(PROTOCOLS)
  protocol!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  comment?: string;
}

export class UpdateCountryBlockDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[\d,:\s-]*$/, { message: 'ports содержит недопустимые символы' })
  ports?: string;

  @IsOptional()
  @IsIn(PROTOCOLS)
  protocol?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  comment?: string;
}

export class UpdateCountryBlockSettingsDto {
  /** Master switch — глобальное включение блокировки на сервере. */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** cron-выражение для daily refresh CIDR-баз. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[\d*/,\-\s]+$/, { message: 'updateSchedule должен быть cron-выражением' })
  updateSchedule?: string;

  /** Источник CIDR (primary; остальные — автоматический fallback). */
  @IsOptional()
  @IsIn(SOURCES)
  primarySource?: string;
}

export class RefreshDbDto {
  /** Список ISO-кодов для обновления. Пусто = все страны из rules. */
  @IsOptional()
  countries?: string[];
}
