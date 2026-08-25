import {
  IsString,
  IsNotEmpty,
  IsOptional,
  MaxLength,
  MinLength,
  Matches,
  IsUrl,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';

/**
 * Legacy-static-v0 accepts an exact public HTTPS origin only. TLS verification
 * remains mandatory even though the narrow upgrade rail uses PROXY_TOKEN.
 */
const REMOTE_URL_RULES = {
  protocols: ['https'] as string[],
  require_tld: false,
  require_protocol: true,
};

export class AddServerDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[\w .-]+$/u, { message: 'Server name contains invalid characters' })
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  @IsUrl(REMOTE_URL_RULES, { message: 'URL must be an HTTPS origin with a valid host' })
  url!: string;

  // PROXY_TOKEN удалённого сервера — hex-строка openssl rand -hex 32 = 64 символа.
  @IsString()
  @IsNotEmpty()
  @MinLength(16)
  @MaxLength(256)
  @Matches(/^[A-Za-z0-9._~-]+$/, {
    message: 'Token contains unsupported characters',
  })
  token!: string;
}

export class UpdateServerDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[\w .-]+$/u, { message: 'Server name contains invalid characters' })
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  @IsUrl(REMOTE_URL_RULES, { message: 'URL must be an HTTPS origin with a valid host' })
  url?: string;

  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(256)
  @Matches(/^[A-Za-z0-9._~-]+$/, {
    message: 'Token contains unsupported characters',
  })
  token?: string;
}

/**
 * Массовое обновление выбранных серверов до целевой версии.
 * Версия должна быть строго выше максимальной текущей среди выбранных
 * (downgrade запрещён — может сломать БД-миграции).
 */
export class UpdateBulkDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  serverIds!: string[];

  // Тег релиза, например "v0.4.0". Формат vN.N.N или semver-совместимый.
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^v?\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/, {
    message: 'version должен быть semver (например v0.4.0 или 0.4.0-beta.1)',
  })
  version!: string;
}
