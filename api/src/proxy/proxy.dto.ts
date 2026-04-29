import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  Min,
  Max,
  MaxLength,
  MinLength,
  Matches,
  IsUrl,
} from 'class-validator';

/**
 * URL ведомого сервера: только HTTPS, FQDN. Запрет http://127.0.0.1 и т.п.
 * Дополнительная runtime-проверка `assertPublicHttpUrl` в сервисе (DNS-lookup).
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
  @IsUrl(REMOTE_URL_RULES, { message: 'URL must be https:// and a valid host' })
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
  @IsUrl(REMOTE_URL_RULES, { message: 'URL must be https:// and a valid host' })
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

export class ProvisionServerDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[\w .-]+$/u, { message: 'Server name contains invalid characters' })
  name!: string;

  // Hostname или IPv4/IPv6-литерал. Дополнительная проверка `assertPublicHost`
  // в сервисе провижнинга (блок 127.0.0.1, AWS IMDS, link-local).
  @IsString()
  @IsNotEmpty()
  @MaxLength(253)
  @Matches(/^[A-Za-z0-9.:_-]+$/, {
    message: 'Host must be a hostname or IP literal',
  })
  host!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  // SSH root-пароль для первичного подключения. Не валидируем содержимое —
  // пользователь мог настроить нестандартный пароль на своей стороне.
  // Единственное ограничение — длина.
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  password!: string;
}
