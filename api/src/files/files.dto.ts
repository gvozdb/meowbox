import {
  IsString,
  IsNotEmpty,
  MaxLength,
  IsIn,
  Matches,
} from 'class-validator';

/**
 * Path внутри site-директории. Нельзя содержать NUL, абсолютные корневые
 * пути (`/etc/...`) и прочую дичь — резолвится и проверяется в сервисе
 * через assertSafeFilePath, но DTO делает первичный фильтр.
 */
const PATH_MAX = 4096;
const PATH_FORBID = /[\x00]/;

export class WriteFileDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(PATH_MAX)
  @Matches(/^(?!.*\x00).+$/s, { message: 'Path contains null byte' })
  path!: string;

  // Максимальный размер контента на запись через /files/write.
  // 50 МБ обычно хватает для любого конфига; для больших апдейтов есть /upload.
  @IsString()
  @MaxLength(50 * 1024 * 1024)
  content!: string;
}

export class CreateItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(PATH_MAX)
  path!: string;

  @IsIn(['file', 'directory'], { message: 'type must be file or directory' })
  type!: 'file' | 'directory';
}

export class RenameItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(PATH_MAX)
  oldPath!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(PATH_MAX)
  newPath!: string;
}

// Небольшой runtime-хелпер для чек-элементов, не вписывающихся в class-validator.
export function assertNoNullByte(s: string, field: string): void {
  if (PATH_FORBID.test(s)) {
    throw new Error(`${field} contains null byte`);
  }
}
