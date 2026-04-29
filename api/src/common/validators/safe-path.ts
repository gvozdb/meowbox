/**
 * Защита от path traversal для endpoint'ов, принимающих путь к файлу.
 *
 * Правила:
 *   1) Абсолютный путь, начинающийся с одного из `allowedPrefixes`.
 *   2) После `path.resolve()` (убирает `..`, `.`, дубли слэшей) остаётся под
 *      одним из allowed-префиксов — защищает от `/tmp/../etc/passwd`.
 *   3) Файл не symlink (чтобы не обойти через `ln -s /etc/passwd /tmp/x`).
 *
 * Возвращает нормализованный resolved-path или бросает ошибку.
 */

import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export const ALLOWED_DB_FILE_PREFIXES = ['/tmp/', '/var/meowbox/'];

export interface SafePathOptions {
  mustExist?: boolean;
  /** Разрешённые расширения (без точки). Например `['sql', 'gz']`. */
  extensions?: string[];
  /** Запрещает symlink. По-умолчанию true. */
  forbidSymlinks?: boolean;
  /** Максимальный размер файла (bytes). */
  maxSize?: number;
}

export function assertSafeFilePath(
  input: string | undefined | null,
  allowedPrefixes: string[],
  opts: SafePathOptions = {},
): string {
  if (!input || typeof input !== 'string') {
    throw new BadRequestException('File path is required');
  }
  if (input.includes('\0')) {
    throw new BadRequestException('File path contains null byte');
  }
  if (input.length > 4096) {
    throw new BadRequestException('File path too long');
  }
  if (!path.isAbsolute(input)) {
    throw new BadRequestException('File path must be absolute');
  }

  // После resolve: path может стать короче (`//` → `/`, убрать `..`).
  const resolved = path.resolve(input);

  const under = allowedPrefixes.some((prefix) => {
    const normPrefix = path.resolve(prefix);
    return resolved === normPrefix || resolved.startsWith(normPrefix + path.sep);
  });
  if (!under) {
    throw new BadRequestException(
      `File path must be under: ${allowedPrefixes.join(', ')}`,
    );
  }

  if (opts.extensions && opts.extensions.length > 0) {
    const ext = path.extname(resolved).replace(/^\./, '').toLowerCase();
    if (!opts.extensions.includes(ext)) {
      throw new BadRequestException(
        `File extension must be one of: ${opts.extensions.join(', ')}`,
      );
    }
  }

  if (opts.mustExist) {
    let stat: fs.Stats;
    try {
      // lstat — не следует за symlink'ами.
      stat = fs.lstatSync(resolved);
    } catch {
      throw new BadRequestException('File not found');
    }
    if (opts.forbidSymlinks !== false && stat.isSymbolicLink()) {
      throw new BadRequestException('Symlinks are not allowed');
    }
    if (!stat.isFile()) {
      throw new BadRequestException('Path is not a regular file');
    }
    if (opts.maxSize && stat.size > opts.maxSize) {
      throw new BadRequestException(
        `File too large (max ${opts.maxSize} bytes)`,
      );
    }
  }

  return resolved;
}
