import * as path from 'path';
import * as fs from 'fs/promises';
import { CommandExecutor } from '../command-executor';
import { PermissionsManager } from './permissions';

/**
 * MODX Doctor — диагностика типовых проблем MODX-сайтов.
 *
 * Не делает никаких изменений: только читает фс/файлы конфига, считает
 * uid'ы файлов, проверяет наличие/отсутствие критичных каталогов.
 *
 * Результат — список issues; каждый issue имеет уровень (critical/warning/info)
 * и опциональный `fix` — id действия, которое UI может предложить выполнить
 * (через отдельные API endpoints, напр. POST /sites/:id/normalize-permissions).
 *
 * Унификация путей:
 *  - core/ берётся из `{wwwDir}/config.core.php` → MODX_CORE_PATH (если есть).
 *  - manager/connectors берутся из managerPath/connectorsPath сайта.
 */

export type DoctorIssueLevel = 'critical' | 'warning' | 'info';
export type DoctorIssueFix = 'normalize-permissions' | 'cleanup-setup-dir' | null;

export interface DoctorIssue {
  id: string;
  level: DoctorIssueLevel;
  title: string;
  description: string;
  /** Доп. детали (напр. список "плохих" файлов) — UI показывает в раскрывалке. */
  details?: string[];
  /** Действие для починки (id; UI рендерит соответствующую кнопку). */
  fix?: DoctorIssueFix;
}

export interface DoctorOptions {
  rootPath: string;
  filesRelPath?: string;
  systemUser?: string;
  managerPath?: string;
  connectorsPath?: string;
}

export interface DoctorResult {
  success: boolean;
  /** Унифицированный путь до core (из config.core.php или fallback). */
  modxCorePath?: string;
  /** Версия MODX, если удалось извлечь из core/docs/version.inc.php. */
  modxVersion?: string;
  /** Сам сайт инициализирован (config.inc.php существует и читается). */
  modxConfigOk: boolean;
  issues: DoctorIssue[];
  error?: string;
}

export class ModxDoctor {
  private executor: CommandExecutor;
  private perms: PermissionsManager;

  constructor(executor?: CommandExecutor) {
    this.executor = executor || new CommandExecutor();
    this.perms = new PermissionsManager(this.executor);
  }

  async diagnose(opts: DoctorOptions): Promise<DoctorResult> {
    const issues: DoctorIssue[] = [];

    if (!opts.rootPath || !path.isAbsolute(opts.rootPath)) {
      return {
        success: false,
        modxConfigOk: false,
        issues,
        error: `Некорректный rootPath: ${opts.rootPath}`,
      };
    }

    const wwwDir = path.join(
      opts.rootPath,
      (opts.filesRelPath || 'www').replace(/^\/+|\/+$/g, '').replace(/\.\.+/g, ''),
    );

    try {
      await fs.access(wwwDir);
    } catch {
      return {
        success: false,
        modxConfigOk: false,
        issues,
        error: `Web-root не существует: ${wwwDir}`,
      };
    }

    // Унифицированный путь до core (config.core.php или дефолт).
    const modxCorePath = await this.perms.resolveModxCorePath(wwwDir);

    // 1. config.inc.php существует?
    const configIncPhp = path.join(modxCorePath, 'config', 'config.inc.php');
    let modxConfigOk = false;
    try {
      await fs.access(configIncPhp);
      modxConfigOk = true;
    } catch {
      issues.push({
        id: 'no-config-inc',
        level: 'critical',
        title: 'core/config/config.inc.php не найден',
        description: `MODX не сможет загрузиться. Проверял путь: ${configIncPhp}`,
      });
    }

    // 2. Root-owned файлы в core/cache (главный симптом нашей старой беды).
    if (modxConfigOk && opts.systemUser) {
      const cacheDir = path.join(modxCorePath, 'cache');
      try {
        await fs.access(cacheDir);
        const expectedUid = await this.resolveUid(opts.systemUser);
        if (expectedUid !== null) {
          const bad = await this.findForeignOwned(cacheDir, expectedUid, 50);
          if (bad.length > 0) {
            issues.push({
              id: 'cache-foreign-owner',
              level: 'critical',
              title: `В core/cache есть файлы, которыми не владеет ${opts.systemUser}`,
              description:
                'PHP-FPM (под пользователем сайта) не может перезаписать эти файлы. ' +
                'Самое больное последствие — не пересобирается eventMap, и плагины MODX не срабатывают ни на одном событии. ' +
                'Решается нормализацией прав.',
              details: bad.slice(0, 20),
              fix: 'normalize-permissions',
            });
          }
        }
      } catch {
        issues.push({
          id: 'no-cache-dir',
          level: 'warning',
          title: 'core/cache не существует',
          description: `MODX создаёт его при первом запуске. Если сайт уже работал — значит каталог удалён вручную: ${cacheDir}`,
        });
      }

      // 2.b — то же самое для всего wwwDir (общая проверка владельца).
      try {
        const expectedUid = await this.resolveUid(opts.systemUser);
        if (expectedUid !== null) {
          const badRoot = await this.findForeignOwned(wwwDir, expectedUid, 50, [
            path.join(wwwDir, 'core', 'cache'), // уже проверили выше
          ]);
          if (badRoot.length > 0) {
            issues.push({
              id: 'www-foreign-owner',
              level: 'warning',
              title: `В web-root есть файлы с чужим владельцем (≠ ${opts.systemUser})`,
              description:
                'Скорее всего, follow-up запуска от root (composer/npm/git pull). ' +
                'Не критично, но при дальнейшей работе может ломаться запись в неожиданных местах.',
              details: badRoot.slice(0, 20),
              fix: 'normalize-permissions',
            });
          }
        }
      } catch {
        /* ignore */
      }
    }

    // 3. setup/ оставлен публично доступным.
    const setupDir = path.join(wwwDir, 'setup');
    try {
      await fs.access(setupDir);
      issues.push({
        id: 'setup-dir-exposed',
        level: 'warning',
        title: 'Директория setup/ доступна публично',
        description:
          'Установщик MODX оставлен на сайте. На production его нужно удалить — он может выдать форму инсталляции/апгрейда без авторизации.',
        details: [setupDir],
        fix: 'cleanup-setup-dir',
      });
    } catch {
      /* норм — нет setup/ */
    }

    // 4. Версия MODX (info-only, не issue).
    let modxVersion: string | undefined;
    if (modxConfigOk) {
      const versionFile = path.join(modxCorePath, 'docs', 'version.inc.php');
      try {
        const txt = await fs.readFile(versionFile, 'utf-8');
        const m = txt.match(/full_version\s*=\s*['"]([^'"]+)/);
        if (m) modxVersion = m[1];
      } catch {
        /* для MODX 3 файл может быть в другом месте — не обязательно */
      }
      if (!modxVersion) {
        // MODX 3 хранит в core/src/Revolution/modX.php константу VERSION
        const modxPhp = path.join(modxCorePath, 'src', 'Revolution', 'modX.php');
        try {
          const txt = await fs.readFile(modxPhp, 'utf-8');
          const m = txt.match(/(?:const|public\s+static\s+\$?)\s*VERSION\s*=\s*['"]([^'"]+)/);
          if (m) modxVersion = m[1];
        } catch {
          /* ignore */
        }
      }
    }

    // 5. core/cache существует и читается, но размер 0 (после reset кэша) —
    //    это норма; не репортим. А вот context_settings/web/context.cache.php
    //    с пустым eventMap при наличии активных плагин-событий — отдельный
    //    симптом, но его проверять надёжно сложно (зависит от формата кэша).
    //    Пока опускаем — root-owned-проверка выше покрывает кейс косвенно.

    // 6. config.inc.php read-test (синтаксис не парсим — могут быть кастомные
    //    значения, но проверим базовое наличие переменных).
    if (modxConfigOk) {
      try {
        const txt = await fs.readFile(configIncPhp, 'utf-8');
        const hasDb =
          /\$database_(server|user|password|dsn)/.test(txt) ||
          /\$dbase\s*=/.test(txt);
        if (!hasDb) {
          issues.push({
            id: 'config-inc-broken',
            level: 'critical',
            title: 'core/config/config.inc.php выглядит сломанным',
            description: 'В файле не нашёл стандартных MODX-переменных БД. Проверь содержимое вручную.',
            details: [configIncPhp],
          });
        }
      } catch {
        issues.push({
          id: 'config-inc-unreadable',
          level: 'critical',
          title: 'core/config/config.inc.php нечитаем',
          description: `Не удалось прочитать файл (права/энкодинг): ${configIncPhp}`,
          fix: 'normalize-permissions',
        });
      }
    }

    return {
      success: true,
      modxCorePath,
      modxVersion,
      modxConfigOk,
      issues,
    };
  }

  /**
   * Резолвит uid юзера через `id -u`. Возвращает null, если юзер не найден.
   * Кэшируем минимально — на масштабах одного запроса doctor'а вызовов мало.
   */
  private async resolveUid(user: string): Promise<number | null> {
    if (!/^[a-z_][a-z0-9_-]*$/i.test(user)) return null;
    const r = await this.executor.execute('id', ['-u', user], { allowFailure: true });
    if (r.exitCode !== 0) return null;
    const uid = parseInt(r.stdout.trim(), 10);
    return Number.isFinite(uid) ? uid : null;
  }

  /**
   * Возвращает список путей, чей владелец != expectedUid.
   *
   * Делаем через Node fs.lstat (без shell `find`, потому что find не в
   * allowlist'е CommandExecutor'а, плюс stat-ить файлы из кода надёжнее —
   * не словим IO-ошибку посередине).
   *
   * @param dir          корневой каталог обхода
   * @param expectedUid  ожидаемый uid владельца
   * @param limit        стоп после N плохих записей (чтобы не висеть на гигантских деревьях)
   * @param skipPaths    абсолютные пути для пропуска (целые поддеревья)
   */
  private async findForeignOwned(
    dir: string,
    expectedUid: number,
    limit: number,
    skipPaths: string[] = [],
  ): Promise<string[]> {
    const bad: string[] = [];
    const skipSet = new Set(skipPaths.map((p) => path.resolve(p)));

    // Безопасно ограничиваем глубину обхода — на больших сайтах (vendor,
    // node_modules) full-walk может занять десятки секунд. Для diagnostic'а
    // достаточно ловить первые отклонения.
    const maxDepth = 10;
    const maxEntries = 20_000;
    let visitedEntries = 0;

    interface Frame { dir: string; depth: number; }
    const stack: Frame[] = [{ dir, depth: 0 }];

    while (stack.length > 0 && bad.length < limit && visitedEntries < maxEntries) {
      const frame = stack.pop();
      if (!frame) break;
      if (skipSet.has(path.resolve(frame.dir))) continue;
      if (frame.depth > maxDepth) continue;

      let entries: import('fs').Dirent[];
      try {
        entries = await fs.readdir(frame.dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (bad.length >= limit) break;
        visitedEntries++;
        if (visitedEntries >= maxEntries) break;
        const full = path.join(frame.dir, entry.name);
        if (skipSet.has(path.resolve(full))) continue;

        let st;
        try {
          st = await fs.lstat(full);
        } catch {
          continue;
        }
        if (st.uid !== expectedUid) {
          bad.push(full);
        }
        // Symlinks не разворачиваем — могут вести в /, vendor и т.п.
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          stack.push({ dir: full, depth: frame.depth + 1 });
        }
      }
    }

    return bad;
  }
}
