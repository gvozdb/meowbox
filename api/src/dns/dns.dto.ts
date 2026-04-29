import {
  IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUrl, IsUUID,
  Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DNS_PROVIDER_TYPES } from './providers/dns-provider.interface';
import { MAIL_TEMPLATES } from './templates/mail-templates';

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'] as const;

export class CreateProviderDto {
  @IsIn(DNS_PROVIDER_TYPES as unknown as string[])
  type!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  label!: string;

  // Свободный объект — provider-specific валидация делается в сервисе/провайдере.
  @IsObject()
  credentials!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  scopeId?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  @MaxLength(256)
  apiBaseUrl?: string;
}

export class CreateRecordDto {
  @IsIn(RECORD_TYPES as unknown as string[])
  type!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  content!: string;

  @IsInt()
  @Min(1)
  @Max(2147483647)
  ttl!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(65535)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  proxied?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  comment?: string;
}

export class UpdateRecordDto extends CreateRecordDto {}

export class LinkSiteDto {
  // null/undefined = отвязать. Иначе строго UUID.
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsUUID()
  siteId?: string | null;
}

export class MailTemplateExtrasDto {
  @IsOptional()
  @IsString()
  @MaxLength(4096) // DKIM-публичный ключ может быть длинным (RSA-2048 ≈ 400 байт base64)
  @Matches(/^[A-Za-z0-9+/=\s]+$/, { message: 'DKIM должен быть base64 (без управляющих символов)' })
  dkim?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9._-]+$/, { message: 'dkimSelector допускает только [a-zA-Z0-9._-]' })
  dkimSelector?: string;
}

export class ApplyTemplateDto {
  @IsIn(MAIL_TEMPLATES as unknown as string[])
  template!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MailTemplateExtrasDto)
  extras?: MailTemplateExtrasDto;
}
