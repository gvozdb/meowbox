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
} from 'class-validator';
import {
  DOMAIN_REGEX,
  DOMAIN_MESSAGE,
  DOMAIN_MAX_LENGTH,
} from '../common/validators/site-names';
import { SiteAliasesValidator } from './sites.dto';

/** POST /sites/:id/domains — добавить новый (неглавный) основной домен. */
export class CreateSiteDomainDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(DOMAIN_MAX_LENGTH)
  @Matches(DOMAIN_REGEX, { message: DOMAIN_MESSAGE })
  domain!: string;
}

/** PUT /sites/:id/domains/:domainId — частичное обновление домена. */
export class UpdateSiteDomainDto {
  @IsOptional()
  @IsString()
  @MaxLength(DOMAIN_MAX_LENGTH)
  @Matches(DOMAIN_REGEX, { message: DOMAIN_MESSAGE })
  domain?: string;

  /**
   * web-root относительно Site.rootPath. `null` — наследовать дефолт сайта.
   * Для главного домена запись `filesRelPath` пишется в `Site.filesRelPath`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  filesRelPath?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  appPort?: number | null;

  @IsOptional()
  @IsBoolean()
  httpsRedirect?: boolean;
}

/** PUT /sites/:id/domains/:domainId/aliases — заменить алиасы домена. */
export class UpdateSiteDomainAliasesDto {
  @Validate(SiteAliasesValidator)
  aliases!: Array<string | { domain: string; redirect?: boolean }>;
}
