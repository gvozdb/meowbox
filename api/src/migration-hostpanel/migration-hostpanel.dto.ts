import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Параметры подключения к источнику. SSH/MySQL пароли в открытом виде —
 * только при первом запросе (когда оператор ввёл их в UI). На бэкенде сразу
 * шифруются через MIGRATION_SECRET и в БД хранятся как `*Enc`-base64.
 */
export class MigrationSourceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[a-z_][a-z0-9_-]{0,31}$/, {
    message: 'sshUser должен быть валидным linux-юзером',
  })
  sshUser!: string;

  /** SSH password (только при первом запросе). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  sshPassword!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  mysqlHost!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  mysqlPort!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  mysqlUser!: string;

  /** MySQL password (только при первом запросе). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  mysqlPassword!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_-]+$/)
  hostpanelDb!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_]+$/)
  hostpanelTablePrefix!: string;
}

export class StartDiscoveryDto {
  /**
   * Можно либо передать source целиком (новые креды), либо sourceId
   * (использовать сохранённый пресет — пароли подставит бэкенд).
   * Если переданы оба — приоритет у source (вдруг оператор подкорректировал
   * хост/префикс перед запуском).
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => MigrationSourceDto)
  source?: MigrationSourceDto;

  @IsOptional()
  @IsString()
  sourceId?: string;
}

/**
 * Сохранённый пресет источника. То же что и MigrationSourceDto + читаемое
 * имя для отображения в списке.
 */
export class CreateSavedSourceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[a-z_][a-z0-9_-]{0,31}$/, {
    message: 'sshUser должен быть валидным linux-юзером',
  })
  sshUser!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  sshPassword!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  mysqlHost!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  mysqlPort!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  mysqlUser!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  mysqlPassword!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_-]+$/)
  hostpanelDb!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_]+$/)
  hostpanelTablePrefix!: string;
}

/**
 * Обновление PlanItem от UI. Прилетает целиком (фронт правит локально и
 * отправляет окончательный объект). На бэкенде валидируется только базовое
 * (структура есть, размеры в пределах) — остальное доверяем агенту.
 */
export class UpdatePlanItemDto {
  /** Сериализованный PlanItem (см. plan-item.types.ts). */
  @IsString()
  @MaxLength(200_000)
  planJson!: string;
}

export class CheckNameDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[a-z][a-z0-9_-]{0,31}$/, {
    message: 'Имя должно быть валидным linux-юзером (a-z, 0-9, _, -; начинаться с буквы; до 32 симв.)',
  })
  name!: string;
}

export class CheckDomainDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(253)
  domain!: string;
}

export class StartRunDto {
  /** Список ID items'ов, которые надо реально запустить (с галкой в UI). */
  @IsArray()
  @IsString({ each: true })
  itemIds!: string[];
}

/**
 * Phase 2 — оператор выбрал сайты в shortlist'е и просит собрать полный
 * план только по ним. itemIds — это HostpanelMigrationItem.id (UUID),
 * созданные мастером после shortlist phase. Не sourceSiteId — мастер
 * замапит сам.
 */
export class StartProbeDto {
  @IsArray()
  @IsString({ each: true })
  itemIds!: string[];
}

export class RetryItemDto {
  @IsOptional()
  @IsBoolean()
  resetToPlanned?: boolean;
}
