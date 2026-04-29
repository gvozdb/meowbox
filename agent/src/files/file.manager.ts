import * as fs from 'fs/promises';
import * as path from 'path';
import { FILES } from '../config';

export interface FileItem {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modifiedAt: string;
  permissions: string;
}

// Лимит текстового превью файла. Override через env FILES_MAX_READ_SIZE_BYTES.
const MAX_READ_SIZE = FILES.MAX_READ_SIZE_BYTES;

export class FileManager {
  /**
   * List directory contents. Validates path stays within rootPath.
   */
  async list(rootPath: string, relativePath: string): Promise<{ success: boolean; data?: FileItem[]; error?: string }> {
    const resolved = await this.resolveSafe(rootPath, relativePath);
    if (!resolved) return { success: false, error: 'Invalid path' };

    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const items: FileItem[] = [];

      for (const entry of entries) {
        try {
          const fullPath = path.join(resolved, entry.name);
          // lstat чтобы не follow симлинки (защищает от "раскрытия" target'ов).
          const stat = await fs.lstat(fullPath).catch(() => null);
          items.push({
            name: entry.name,
            path: path.join(relativePath || '/', entry.name),
            type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
            size: stat?.size ?? 0,
            modifiedAt: stat?.mtime?.toISOString() ?? '',
            permissions: stat ? this.formatPermissions(stat.mode) : '---',
          });
        } catch {
          // Skip unreadable entries
        }
      }

      // Sort: directories first, then alphabetical
      items.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      });

      return { success: true, data: items };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Read file contents (text only, up to 2MB).
   */
  async read(rootPath: string, relativePath: string): Promise<{ success: boolean; data?: string; error?: string }> {
    const resolved = await this.resolveSafe(rootPath, relativePath);
    if (!resolved) return { success: false, error: 'Invalid path' };

    try {
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) return { success: false, error: 'Cannot read a directory' };
      if (stat.size > MAX_READ_SIZE) return { success: false, error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max: 2MB` };

      const content = await fs.readFile(resolved, 'utf-8');
      return { success: true, data: content };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Write/update file contents.
   */
  async write(rootPath: string, relativePath: string, content: string): Promise<{ success: boolean; error?: string }> {
    // allowNonExistent — write может создавать новый файл в существующей директории.
    const resolved = await this.resolveSafe(rootPath, relativePath, { allowNonExistent: true });
    if (!resolved) return { success: false, error: 'Invalid path' };

    try {
      await fs.writeFile(resolved, content, 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Create a new file or directory.
   */
  async create(rootPath: string, relativePath: string, type: 'file' | 'directory'): Promise<{ success: boolean; error?: string }> {
    const resolved = await this.resolveSafe(rootPath, relativePath, { allowNonExistent: true });
    if (!resolved) return { success: false, error: 'Invalid path' };

    try {
      if (type === 'directory') {
        await fs.mkdir(resolved, { recursive: true });
      } else {
        // Ensure parent directory exists
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, '', 'utf-8');
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Delete a file or directory.
   */
  async remove(rootPath: string, relativePath: string): Promise<{ success: boolean; error?: string }> {
    const resolved = await this.resolveSafe(rootPath, relativePath);
    if (!resolved) return { success: false, error: 'Invalid path' };

    // Don't allow deleting the root itself
    const rootResolved = await fs.realpath(path.resolve(rootPath)).catch(() => path.resolve(rootPath));
    if (resolved === rootResolved) {
      return { success: false, error: 'Cannot delete the site root directory' };
    }

    try {
      const stat = await fs.lstat(resolved);
      if (stat.isDirectory()) {
        await fs.rm(resolved, { recursive: true, force: true });
      } else {
        await fs.unlink(resolved);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Rename/move a file or directory.
   */
  async rename(rootPath: string, oldPath: string, newPath: string): Promise<{ success: boolean; error?: string }> {
    const resolvedOld = await this.resolveSafe(rootPath, oldPath);
    const resolvedNew = await this.resolveSafe(rootPath, newPath, { allowNonExistent: true });
    if (!resolvedOld || !resolvedNew) return { success: false, error: 'Invalid path' };

    try {
      await fs.rename(resolvedOld, resolvedNew);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Resolve a path safely, preventing directory traversal AND symlink escape.
   *
   * Два слоя защиты:
   *  1) path.resolve — нормализует `../`.
   *  2) fs.realpath — резолвит симлинки, чтобы `rootPath/escape → /etc/passwd`
   *     не обошёл проверку startsWith.
   *
   * `allowNonExistent: true` — для create/rename, где целевой файл ещё
   * не существует. В этом случае делаем realpath для ПАРЕНТА и дописываем
   * basename, следя что парент лежит в руте.
   */
  private async resolveSafe(
    rootPath: string,
    relativePath: string,
    opts: { allowNonExistent?: boolean } = {},
  ): Promise<string | null> {
    const rootLexical = path.resolve(rootPath);
    const resolvedLexical = path.resolve(rootLexical, relativePath.replace(/^\/+/, ''));

    // Первичная лексическая проверка — блокирует явные `../` атаки.
    if (!resolvedLexical.startsWith(rootLexical + path.sep) && resolvedLexical !== rootLexical) {
      return null;
    }

    // Реальный путь рута — должен существовать. Если нет — возвращаем null,
    // чтобы не создавать что-то вне его.
    let rootReal: string;
    try {
      rootReal = await fs.realpath(rootLexical);
    } catch {
      return null;
    }

    // Пробуем резолвнуть итоговый путь. Если не существует и allowNonExistent —
    // проверяем парент-директорию.
    try {
      const real = await fs.realpath(resolvedLexical);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        return null;
      }
      return real;
    } catch (err) {
      if (!opts.allowNonExistent) return null;
      const parent = path.dirname(resolvedLexical);
      let parentReal: string;
      try {
        parentReal = await fs.realpath(parent);
      } catch {
        // Парент тоже не существует → отказ. Мы не создаём глубокие пути
        // через file:rename/file:create без явного mkdir.
        // (Исключение: file:create с type=directory — оно делает mkdir recursive,
        //  но и там парент должен быть в руте, иначе create запишется за его пределы.)
        return null;
      }
      if (parentReal !== rootReal && !parentReal.startsWith(rootReal + path.sep)) {
        return null;
      }
      return path.join(parentReal, path.basename(resolvedLexical));
      void err;
    }
  }

  private formatPermissions(mode: number): string {
    const perms = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
    const owner = perms[(mode >> 6) & 7];
    const group = perms[(mode >> 3) & 7];
    const other = perms[mode & 7];
    return `${owner}${group}${other}`;
  }
}
