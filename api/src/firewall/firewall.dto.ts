import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  MaxLength,
  Matches,
} from 'class-validator';

enum FirewallRuleAction {
  ALLOW = 'ALLOW',
  DENY = 'DENY',
}

enum FirewallProtocol {
  TCP = 'TCP',
  UDP = 'UDP',
  BOTH = 'BOTH',
}

/**
 * ufw port: единичный номер (22) или диапазон (8000:9000) — оба формата.
 * Запрет других символов отсекает попытки инъекции лишних токенов.
 */
const FIREWALL_PORT = /^\d{1,5}(:\d{1,5})?$/;

/**
 * IPv4/IPv6 с опциональной CIDR-маской. Без специфики: ufw сам валидирует,
 * но мы отсекаем всё, что содержит пробелы и шеллметы заранее.
 */
const FIREWALL_SOURCE_IP = /^[0-9a-fA-F:.\/]+$/;

/** Комментарий к правилу — без control-chars. */
const FIREWALL_COMMENT_NO_CTRL = /^[^\x00-\x1f\x7f]*$/;

export class CreateFirewallRuleDto {
  @IsEnum(FirewallRuleAction)
  @IsNotEmpty()
  action!: string;

  @IsEnum(FirewallProtocol)
  @IsNotEmpty()
  protocol!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Matches(FIREWALL_PORT, { message: 'Port must be N or N:N (ranges)' })
  port?: string;

  @IsOptional()
  @IsString()
  @MaxLength(45)
  @Matches(FIREWALL_SOURCE_IP, { message: 'Invalid source IP / CIDR' })
  sourceIp?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  @Matches(FIREWALL_COMMENT_NO_CTRL, {
    message: 'Comment contains control characters',
  })
  comment?: string;
}

export class UpdateFirewallRuleDto {
  @IsOptional()
  @IsEnum(FirewallRuleAction)
  action?: string;

  @IsOptional()
  @IsEnum(FirewallProtocol)
  protocol?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Matches(FIREWALL_PORT, { message: 'Port must be N or N:N (ranges)' })
  port?: string;

  @IsOptional()
  @IsString()
  @MaxLength(45)
  @Matches(FIREWALL_SOURCE_IP, { message: 'Invalid source IP / CIDR' })
  sourceIp?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  @Matches(FIREWALL_COMMENT_NO_CTRL, {
    message: 'Comment contains control characters',
  })
  comment?: string;
}
