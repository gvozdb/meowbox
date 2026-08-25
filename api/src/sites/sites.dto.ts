import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsBoolean,
  Min,
  Max,
  MaxLength,
  Matches,
  IsObject,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  Equals,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  SITE_NAME_REGEX,
  SITE_NAME_MESSAGE,
  DOMAIN_REGEX,
  DOMAIN_MESSAGE,
  DOMAIN_MAX_LENGTH,
  DB_IDENT_REGEX,
  DB_NAME_MAX_LENGTH,
  DB_USER_MAX_LENGTH,
  MODX_VERSION_REGEX,
} from '../common/validators/site-names';
import { CreateSiteDomainDto } from './site-domains.dto';

export { SiteAliasesValidator } from './site-aliases.validator';

export class ConsumeModxLoginHandoffDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token!: string;
}

export class CreateSiteRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  @Matches(SITE_NAME_REGEX, { message: SITE_NAME_MESSAGE })
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  displayName?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CreateSiteDomainDto)
  domains!: CreateSiteDomainDto[];
}

export class UpdateSiteContainerDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  displayName?: string | null;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown> | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(4096, { each: true })
  backupExcludes?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(4096, { each: true })
  backupExcludeTables?: string[];
}

export class DuplicateDatabaseMappingDto {
  @IsUUID()
  sourceDatabaseId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(DB_NAME_MAX_LENGTH)
  @Matches(DB_IDENT_REGEX)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(DB_USER_MAX_LENGTH)
  @Matches(DB_IDENT_REGEX)
  dbUser!: string;
}

/** Клонирование выбранного доменного приложения в новый Site. */
export class DuplicateSiteDto {
  @IsUUID()
  siteDomainId!: string;

  /** Новое системное имя (безопасное для Linux/БД/nginx). Уникальное. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  @Matches(SITE_NAME_REGEX, { message: SITE_NAME_MESSAGE })
  name!: string;

  /** Человекочитаемое имя (опционально). */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  displayName?: string;

  /** Новый главный домен. Должен быть свободен. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(DOMAIN_MAX_LENGTH)
  @Matches(DOMAIN_REGEX, { message: DOMAIN_MESSAGE })
  domain!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, {
    message: 'Web files path must be like "www" or "www/public"',
  })
  filesRelPath!: string;

  @IsOptional()
  @IsString()
  @MaxLength(DB_NAME_MAX_LENGTH)
  @Matches(DB_IDENT_REGEX)
  dbName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(DB_USER_MAX_LENGTH)
  @Matches(DB_IDENT_REGEX)
  dbUser?: string;

  /**
   * Explicit mapping for applications that own more than one database.
   * For one APP_PRIMARY database, dbName/dbUser remain the compact form.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => DuplicateDatabaseMappingDto)
  databaseMappings?: DuplicateDatabaseMappingDto[];
}

/**
 * Явное подтверждение удаления сайта и точный план очистки его артефактов.
 * Все флаги обязательны: старый/закешированный клиент не должен внезапно
 * получить новые destructive-дефолты после обновления API.
 */
export class DeleteSiteOptionsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  confirmSiteName!: string;

  @IsBoolean()
  @Equals(true, { message: 'confirmDataDeletion must be true' })
  confirmDataDeletion!: boolean;

  @IsBoolean()
  removeSslCertificate!: boolean;

  @IsBoolean()
  removeBackupsLocal!: boolean;

  @IsBoolean()
  removeBackupsRestic!: boolean;

  @IsBoolean()
  removeBackupsRemote!: boolean;

  @IsBoolean()
  removeDatabases!: boolean;

  @IsBoolean()
  removeFiles!: boolean;

  /** Удаляет bucket и IAM-доступы MinIO сайта, если сервис был активирован. */
  @IsBoolean()
  removeMinioData!: boolean;

  @IsBoolean()
  removeSystemUser!: boolean;

  @IsBoolean()
  removeNginxConfig!: boolean;

  @IsBoolean()
  removePhpPool!: boolean;
}

/** Запрос на обновление версии MODX установленного сайта. */
export class UpdateModxVersionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  @Matches(MODX_VERSION_REGEX, {
    message: 'Invalid MODX version format (expected e.g. 2.8.8-pl or 3.1.2-pl)',
  })
  targetVersion!: string;
}

/**
 * DTO для смены SSH-пароля сайта. Если `password` пустой — генерится случайный.
 * При указании валидируем длину и символы (bash/openssl-safe).
 */
export class ChangeSshPasswordDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[!-~]+$/, {
    message: 'SSH password must contain only printable ASCII characters',
  })
  password?: string;
}

/**
 * DTO для смены пароля администратора MODX. Если `password` пустой — генерим
 * случайный 16-байтовый base64url. Допускаем только printable ASCII (без пробела
 * и контрольных) — этот же набор валиден для argv exec'а на агенте и для
 * MODX-формы логина.
 */
export class ChangeCmsAdminPasswordDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[!-~]+$/, {
    message: 'Пароль может содержать только printable ASCII без пробелов',
  })
  password?: string;
}

/**
 * Дополнительный фрагмент php-fpm pool-конфига. Не должен содержать NUL
 * и быть монструозно большим — агент всё равно перегенерирует пул при любом
 * чихе, так что 10 КБ с запасом.
 */
export class UpdatePhpPoolConfigDto {
  @IsString()
  @MaxLength(10_000, { message: 'PHP pool config is too large' })
  @Matches(/^[^\x00]*$/s, { message: 'Config contains null byte' })
  custom!: string;
}

// =============================================================================
// Layered nginx settings (вкладка «Nginx» страницы сайта)
// =============================================================================

/**
 * Поля nginx-настроек сайта (рендерятся в /etc/nginx/meowbox/{name}/*.conf).
 * Все опциональные: undefined → не меняем; null/0/'' → сбрасываем на дефолт
 * из shared/nginx-defaults.ts.
 */
export class UpdateSiteNginxSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(16)
  clientMaxBodySize?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86400)
  fastcgiReadTimeout?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86400)
  fastcgiSendTimeout?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86400)
  fastcgiConnectTimeout?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1024)
  fastcgiBufferSizeKb?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(256)
  fastcgiBufferCount?: number | null;

  @IsOptional()
  @IsBoolean()
  http2?: boolean;

  @IsOptional()
  @IsBoolean()
  hsts?: boolean;

  @IsOptional()
  @IsBoolean()
  gzip?: boolean;

  @IsOptional()
  @IsBoolean()
  rateLimitEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  rateLimitRps?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  rateLimitBurst?: number | null;
}

/**
 * Содержимое 95-custom.conf — текстовый блок директив, инклюдится внутрь
 * основного server-блока сайта. Перед сохранением проходит nginx -t.
 *
 * Лимит 256KB — достаточный sanity-cap, обычно файлы 1-5 KB.
 */
export class UpdateSiteNginxCustomDto {
  @IsString()
  @MaxLength(256 * 1024, { message: 'Custom config too large (max 256KB)' })
  @Matches(/^[^\x00]*$/s, { message: 'Custom config contains null byte' })
  content!: string;
}
