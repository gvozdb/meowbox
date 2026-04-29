import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  IsArray,
  IsBoolean,
  IsObject,
} from 'class-validator';

enum NotificationChannel {
  TELEGRAM = 'TELEGRAM',
  EMAIL = 'EMAIL',
  WEBHOOK = 'WEBHOOK',
}

export class CreateNotificationSettingDto {
  @IsEnum(NotificationChannel)
  @IsNotEmpty()
  channel!: string;

  @IsArray()
  @IsString({ each: true })
  events!: string[];

  @IsBoolean()
  enabled!: boolean;

  @IsObject()
  config!: Record<string, unknown>;
}

export class UpdateNotificationSettingDto {
  @IsOptional()
  @IsEnum(NotificationChannel)
  channel?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}
