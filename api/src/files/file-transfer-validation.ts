import { BadRequestException } from '@nestjs/common';
import { UPLOAD_BLOCKED_EXTENSIONS } from '@meowbox/shared';

const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;
const MAX_FILENAME_BYTES = 255;

export function validateUploadFilename(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException('Invalid filename');
  }
  const filename = value.normalize('NFC');
  if (
    !filename ||
    filename === '.' ||
    filename === '..' ||
    CONTROL_CHARACTERS.test(filename) ||
    filename.includes('/') ||
    filename.includes('\\') ||
    Buffer.byteLength(filename, 'utf8') > MAX_FILENAME_BYTES
  ) {
    throw new BadRequestException('Invalid filename');
  }

  for (const segment of filename.toLowerCase().split('.').slice(1)) {
    if ((UPLOAD_BLOCKED_EXTENSIONS as readonly string[]).includes(segment)) {
      throw new BadRequestException(
        `Загрузка файлов с расширением .${segment} запрещена по соображениям безопасности`,
      );
    }
  }
  return filename;
}
