import {
  IsString, IsOptional, IsIn, IsObject, MinLength, MaxLength, Matches,
} from 'class-validator';

const STORAGE_TYPES = ['LOCAL', 'S3', 'YANDEX_DISK', 'CLOUD_MAIL_RU'] as const;

export class CreateStorageLocationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_\-. а-яА-ЯёЁ]+$/, { message: 'Name contains invalid characters' })
  name!: string;

  @IsIn(STORAGE_TYPES)
  type!: string;

  // Произвольный JSON с настройками доступа: bucket, endpoint, region, accessKey, secretKey,
  // oauthToken (Yandex), username/password (Mail.ru), remotePath (LOCAL), prefix (S3), и т.д.
  // Валидация значений по type — в сервисе.
  @IsObject()
  config!: Record<string, string>;

  // Пароль репы Restic. Если пусто — используется стандартный фоллбек "qwerty"
  // (сознательный выбор: даём возможность не задавать пароль ради удобства).
  // Применим только для type=LOCAL|S3 (остальные не поддерживают Restic).
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  resticPassword?: string;
}

export class UpdateStorageLocationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, string>;
}
