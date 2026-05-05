import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  IsInt,
  IsBoolean,
  Min,
  Max,
  MaxLength,
  Matches,
  IsObject,
  IsArray,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  Validate,
} from 'class-validator';
// Единый источник правды для enum'ов — shared. Дубли перечислений между
// api/web/agent провоцируют рассинхрон (напр. agent знает про 'PHP_84',
// которого нет в api) — поэтому держим их строго в shared/src/enums.ts.
// Runtime работает через symlink api/node_modules/@meowbox/shared → /opt/meowbox/shared.
import { SiteType, PhpVersion, DatabaseType } from '@meowbox/shared';
import {
  SITE_NAME_REGEX,
  SITE_NAME_MESSAGE,
  DOMAIN_REGEX,
  DOMAIN_MESSAGE,
  DOMAIN_MAX_LENGTH,
  DB_IDENT_REGEX,
  DB_NAME_MAX_LENGTH,
  DB_USER_MAX_LENGTH,
  GIT_BRANCH_REGEX,
  URL_PATH_SEGMENT_REGEX,
  MODX_VERSION_REGEX,
} from '../common/validators/site-names';

/**
 * Кастомный валидатор для поля `aliases`. Принимает два формата:
 *   - `string[]` — старые клиенты (или импорт из миграции)
 *   - `Array<{ domain: string, redirect?: boolean }>` — новый UI
 *
 * Нормализация в хранимое представление делается в sites.service через
 * `stringifySiteAliases` — здесь только валидируем каждый элемент.
 */
@ValidatorConstraint({ name: 'SiteAliases', async: false })
export class SiteAliasesValidator implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value == null) return true;
    if (!Array.isArray(value)) return false;
    if (value.length > 64) return false;
    for (const item of value) {
      if (typeof item === 'string') {
        if (item.length > DOMAIN_MAX_LENGTH || !DOMAIN_REGEX.test(item)) return false;
      } else if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        if (typeof o.domain !== 'string' || o.domain.length > DOMAIN_MAX_LENGTH) return false;
        if (!DOMAIN_REGEX.test(o.domain)) return false;
        if ('redirect' in o && typeof o.redirect !== 'boolean') return false;
      } else {
        return false;
      }
    }
    return true;
  }
  defaultMessage(): string {
    return 'aliases must be string[] or Array<{domain:string,redirect?:boolean}> with valid domain format';
  }
}

export class CreateSiteDto {
  // Системное имя сайта — оно же имя Linux-юзера, имя БД и имя БД-юзера.
  // Ограничения Linux username: начинается с буквы, [a-z0-9_-], до 32 символов.
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  @Matches(SITE_NAME_REGEX, { message: SITE_NAME_MESSAGE })
  name!: string;

  // Человекочитаемое имя сайта для списка в UI. Если не задано — UI показывает `name`.
  @IsOptional()
  @IsString()
  @MaxLength(128)
  displayName?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(DOMAIN_MAX_LENGTH)
  @Matches(DOMAIN_REGEX, { message: DOMAIN_MESSAGE })
  domain!: string;

  // Принимает как старый формат (string[]), так и новый ([{domain,redirect}]).
  // См. SiteAliasesValidator.
  @IsOptional()
  @Validate(SiteAliasesValidator)
  aliases?: Array<string | { domain: string; redirect?: boolean }>;

  @IsEnum(SiteType)
  type!: string;

  // ── PHP module ─────────────────────────────────────────────────────────
  @IsOptional()
  @IsBoolean()
  phpEnabled?: boolean;

  @IsOptional()
  @IsEnum(PhpVersion)
  phpVersion?: string;

  // ── Database module ────────────────────────────────────────────────────
  @IsOptional()
  @IsBoolean()
  dbEnabled?: boolean;

  @IsOptional()
  @IsEnum(DatabaseType)
  dbType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(DB_NAME_MAX_LENGTH)
  @Matches(DB_IDENT_REGEX, {
    message: 'Database name can only contain letters, numbers, and underscores',
  })
  dbName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(DB_USER_MAX_LENGTH)
  @Matches(DB_IDENT_REGEX, {
    message: 'Database user can only contain letters, numbers, and underscores',
  })
  dbUser?: string;

  // Пароль БД. Допустимые символы: печатные ASCII без пробелов/кавычек/обратных
  // слэшей/`$` и control-chars. Причины:
  //   - MODX cli-install парсит пары `--key=value` по `=` — пустое, `=`, пробелы
  //     ломают разбор аргументов.
  //   - `$` в одинарных кавычках MySQL безопасен, но в shell-подстановках
  //     (которых у нас нет, но CommandExecutor не проходит shell) может навредить
  //     при будущих рефакторингах.
  //   - Пароль не должен начинаться с `-` — иначе argv trivial injection.
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[!#%&*+,./:;<>?@A-Za-z0-9_^()\[\]{}|~-]+$/, {
    message:
      'Database password contains unsupported characters (allowed: letters, digits, ! # % & * + , . / : ; < > ? @ _ ^ ( ) [ ] { } | ~ -)',
  })
  @Matches(/^[^-=]/, {
    message: 'Database password must not start with "-" or "="',
  })
  dbPassword?: string;

  // ── SSL module ─────────────────────────────────────────────────────────
  @IsOptional()
  @IsBoolean()
  sslEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  httpsRedirect?: boolean;

  // ── Git deploy (optional) ──────────────────────────────────────────────
  @IsOptional()
  @IsString()
  @MaxLength(512)
  gitRepository?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(GIT_BRANCH_REGEX, { message: 'Invalid branch name' })
  deployBranch?: string;

  @IsOptional()
  @IsInt()
  @Min(1024)
  @Max(65535)
  appPort?: number;

  @IsOptional()
  @IsObject()
  envVars?: Record<string, string>;

  @IsOptional()
  @IsBoolean()
  skipInstall?: boolean;

  // ── CMS (MODX) ─────────────────────────────────────────────────────────
  // Версия MODX для установки. Допустимый формат: `2.8.8-pl`, `3.1.2-pl` и т.п.
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(MODX_VERSION_REGEX, {
    message: 'Invalid MODX version format (expected e.g. 2.8.8-pl or 3.1.2-pl)',
  })
  modxVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  cmsAdminUser?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  cmsAdminPassword?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(URL_PATH_SEGMENT_REGEX, {
    message: 'Manager path can only contain letters, numbers, underscores, and hyphens',
  })
  managerPath?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(URL_PATH_SEGMENT_REGEX, {
    message: 'Connectors path can only contain letters, numbers, underscores, and hyphens',
  })
  connectorsPath?: string;

  // ── Кастомные пути сайта (override дефолтов из /settings) ───────────────
  // Корневая директория сайта (homedir Linux-юзера). Если не указано —
  // собирается как `${sitesBasePath}/${name}` из panel-settings.
  // Только absolute path, без `..` и shell-метасимволов.
  @IsOptional()
  @IsString()
  @MaxLength(256)
  @Matches(/^\/[A-Za-z0-9._/-]+$/, {
    message: 'Root path must be an absolute path with [A-Za-z0-9._/-] only',
  })
  @Matches(/^(?!.*\.\.).*$/, { message: 'Root path must not contain ".."' })
  rootPath?: string;

  // Относительный путь до web-root внутри homedir (попадает в nginx `root`).
  // Если не указано — берётся `siteFilesRelativePath` из panel-settings (default `www`).
  // Без leading `/`, без `..`. Допустимо вложенное (например `www/public`).
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, {
    message: 'Web files path must be like "www" or "www/public" — no leading slash, no ".."',
  })
  filesRelPath?: string;
}

export class UpdateSiteDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(SITE_NAME_REGEX, { message: SITE_NAME_MESSAGE })
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(DOMAIN_MAX_LENGTH)
  @Matches(DOMAIN_REGEX, { message: DOMAIN_MESSAGE })
  domain?: string;

  @IsOptional()
  @Validate(SiteAliasesValidator)
  aliases?: Array<string | { domain: string; redirect?: boolean }>;

  @IsOptional()
  @IsEnum(PhpVersion)
  phpVersion?: string;

  @IsOptional()
  @IsBoolean()
  httpsRedirect?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  gitRepository?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(GIT_BRANCH_REGEX, { message: 'Invalid branch name' })
  deployBranch?: string;

  @IsOptional()
  @IsInt()
  @Min(1024)
  @Max(65535)
  appPort?: number;

  @IsOptional()
  @IsObject()
  envVars?: Record<string, string>;

  // Per-site дефолтные excludes для бэкапов. Применяются как fallback при
  // ручном бэкапе, если в запросе excludePaths не заданы. Glob-шаблоны и
  // относительные пути от rootPath. null/[] — fallback на глобальные.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(4096, { each: true })
  backupExcludes?: string[];

  // Таблицы БД, которые дампятся без данных (только структура). null/[] —
  // fallback на глобальные. Имена валидируются на стороне БД-дампера агента.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(4096, { each: true })
  backupExcludeTables?: string[];

  // Папка с веб-файлами (попадает в nginx `root`). Допускается вложенный путь
  // вида `www/public` для front-controller паттернов (twig/symfony). Папку
  // на диске панель НЕ переносит — это на совести админа после смены значения.
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, {
    message: 'Web files path must be like "www" or "www/public" — no leading slash, no ".."',
  })
  filesRelPath?: string;
}

/**
 * Запрос на дублирование сайта. Создаёт полную копию конфигурации исходного
 * сайта под новым `name` и `domain`. Всё остальное, что обязано быть
 * уникальным в системе (Linux-юзер, SSH-пароль, БД/БД-юзер, pool-сокет,
 * nginx-файл), генерится заново. SSL — не копируется (нужен новый сертификат).
 * Дополнительные домены (aliases) — не копируются (конфликт по server_name).
 */
export class DuplicateSiteDto {
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

  /** Копировать ли настройки бэкапов (BackupConfig записи источника). */
  @IsOptional()
  @IsBoolean()
  copyBackupConfigs?: boolean;

  /** Копировать ли cron-задачи источника. */
  @IsOptional()
  @IsBoolean()
  copyCronJobs?: boolean;
}

/**
 * Опции удаления сайта. По-умолчанию всё true — сайт сносится полностью.
 * Флаги пускают пользователя "оставить" отдельные артефакты при удалении,
 * например — сохранить бэкапы, но убить сайт целиком.
 *
 * До этого в контроллере был inline-объект без валидации — class-validator
 * не проверял типы, и теоретически можно было передать "removeFiles": "'true' OR 1=1".
 */
export class DeleteSiteOptionsDto {
  @IsOptional()
  @IsBoolean()
  removeSslCertificate?: boolean;

  @IsOptional()
  @IsBoolean()
  removeBackupsLocal?: boolean;

  @IsOptional()
  @IsBoolean()
  removeBackupsRestic?: boolean;

  @IsOptional()
  @IsBoolean()
  removeBackupsRemote?: boolean;

  @IsOptional()
  @IsBoolean()
  removeDatabases?: boolean;

  @IsOptional()
  @IsBoolean()
  removeFiles?: boolean;

  @IsOptional()
  @IsBoolean()
  removeSystemUser?: boolean;

  @IsOptional()
  @IsBoolean()
  removeNginxConfig?: boolean;

  @IsOptional()
  @IsBoolean()
  removePhpPool?: boolean;
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
