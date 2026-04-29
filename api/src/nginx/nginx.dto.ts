import { IsString, IsNotEmpty, MaxLength, Matches } from 'class-validator';

const NO_NULL = /^[^\x00]*$/s;

export class UpdateNginxConfigDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(65536)
  @Matches(NO_NULL, { message: 'Config contains null byte' })
  config!: string;
}

/**
 * Основной /etc/nginx/nginx.conf может быть большим. Ставим щедрый лимит,
 * но всё равно отсекаем NUL, чтобы запись не обрезалась тихо.
 */
export class WriteNginxGlobalConfigDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2_000_000)
  @Matches(NO_NULL, { message: 'Config contains null byte' })
  content!: string;
}
