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
  Validate,
  ValidateNested,
  IsEnum,
  IsIn,
  IsObject,
} from 'class-validator';
import {
  DatabaseType,
  SiteType,
  SUPPORTED_PHP_VERSIONS,
} from '@meowbox/shared';
import {
  DB_IDENT_REGEX,
  DB_NAME_MAX_LENGTH,
  DB_USER_MAX_LENGTH,
  DOMAIN_REGEX,
  DOMAIN_MESSAGE,
  DOMAIN_MAX_LENGTH,
  GIT_BRANCH_REGEX,
  MODX_VERSION_REGEX,
  URL_PATH_SEGMENT_REGEX,
} from '../common/validators/site-names';
import { SiteAliasesValidator } from './site-aliases.validator';

/** POST /sites/:id/domains — добавить новый (неглавный) основной домен. */
export class CreateSiteDomainDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(DOMAIN_MAX_LENGTH)
  @Matches(DOMAIN_REGEX, { message: DOMAIN_MESSAGE })
  domain!: string;

  @IsOptional()
  @Validate(SiteAliasesValidator)
  aliases?: Array<string | { domain: string; redirect?: boolean }>;

  @IsEnum(SiteType)
  preset!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, {
    message: 'Web files path must be like "www" or "www/public"',
  })
  filesRelPath!: string;

  @IsOptional()
  @IsIn(SUPPORTED_PHP_VERSIONS as unknown as string[])
  phpVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  @Matches(/^[^\x00]*$/s, { message: 'PHP pool config contains null byte' })
  phpPoolCustom?: string;

  @IsOptional()
  @IsEnum(DatabaseType)
  dbType?: string;

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

  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[!#%&*+,./:;<>?@A-Za-z0-9_^()[\]{}|~-]+$/)
  @Matches(/^[^-=]/)
  dbPassword?: string;

  @IsOptional()
  @IsBoolean()
  sslEnabled?: boolean;

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
  @Matches(GIT_BRANCH_REGEX)
  deployBranch?: string;

  @IsOptional()
  @IsObject()
  envVars?: Record<string, string>;

  @IsOptional()
  @IsBoolean()
  skipInstall?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(MODX_VERSION_REGEX)
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
  @MaxLength(32)
  @Matches(/^[a-z][a-z0-9_]*_$/)
  cmsTablePrefix?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(URL_PATH_SEGMENT_REGEX)
  managerPath?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(URL_PATH_SEGMENT_REGEX)
  connectorsPath?: string;
}

/** PUT /sites/:id/domains/:domainId — частичное обновление домена. */
export class UpdateSiteDomainDto {
  @IsOptional()
  @IsString()
  @MaxLength(DOMAIN_MAX_LENGTH)
  @Matches(DOMAIN_REGEX, { message: DOMAIN_MESSAGE })
  domain?: string;

  /**
   * web-root относительно Site.rootPath. Каждый домен хранит его явно.
   */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, {
    message: 'Web files path must be like "www" or "www/public"',
  })
  filesRelPath?: string;

  @IsOptional()
  @IsIn(SUPPORTED_PHP_VERSIONS as unknown as string[])
  phpVersion?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  gitRepository?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(GIT_BRANCH_REGEX)
  deployBranch?: string | null;

  @IsOptional()
  @IsObject()
  envVars?: Record<string, string>;

  @IsOptional()
  @IsBoolean()
  httpsRedirect?: boolean;
}

/** PUT /sites/:id/domains/:domainId/aliases — заменить алиасы домена. */
export class UpdateSiteDomainAliasesDto {
  @Validate(SiteAliasesValidator)
  aliases!: Array<string | { domain: string; redirect?: boolean }>;
}

export class DeleteSiteDomainDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(DOMAIN_MAX_LENGTH)
  confirmDomain!: string;

  @IsOptional()
  @IsBoolean()
  deleteApplicationFiles?: boolean;

  @IsOptional()
  @IsBoolean()
  deleteOwnedDatabases?: boolean;
}
