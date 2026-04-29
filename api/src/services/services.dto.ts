import {
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  IsInt,
} from 'class-validator';

export class EnableSiteServiceDto {
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class ReconfigureSiteServiceDto {
  @IsObject()
  config!: Record<string, unknown>;
}

export class ManticoreConfigDto {
  @IsOptional()
  @IsInt()
  @Min(32)
  @Max(4096)
  memoryMaxMb?: number;
}

/** Параметр :key для service-роутов. Регэксп жёсткий — слова-в-нижнем-регистре. */
export const SERVICE_KEY_REGEX = /^[a-z][a-z0-9_-]{0,31}$/;

export class ServiceKeyParamDto {
  @IsString()
  @Matches(SERVICE_KEY_REGEX)
  key!: string;
}
