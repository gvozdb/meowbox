import * as path from 'path';
import * as fs from 'fs/promises';
import { CommandExecutor } from '../command-executor';

/**
 * Универсальный менеджер прав/владельца для сайтов meowbox.
 *
 * Используется:
 *  - кнопкой «Нормализация прав и владельца» из UI
 *  - MODX Doctor'ом как fix-step для проблем с владельцем
 *  - install/upgrade flow косвенно (через installer.finalizeModxPermissions —
 *    там оптимизированно, но логика та же)
 *
 * Принципы chmod:
 *  - Используем символьный синтаксис с большим `X`: exec ставится **только**
 *    для каталогов и уже-исполняемых файлов. Это важно для node_modules/.bin
 *    и shell-скриптов в backend-сайтах (Node/Python/Go) — они должны
 *    остаться исполняемыми после нормализации, иначе приложение умрёт.
 *  - Регулярные файлы (.php, .js, .json, .css, .html и т.п.) получают 0640.
 *  - Каталоги — 0750.
 *  - Other (мир) — снимаем всё (0).
 *
 * Для MODX отдельно расширяем right на writable-каталогах (cache/export/
 * packages/assets) до g+w, чтобы PHP-FPM мог писать в них (eventMap,
 * lexicon-cache, snippet-cache и т.п.). Без этого root-owned файлы в
 * core/cache блокируют пересборку eventMap → плагины не срабатывают.
 */
export interface NormalizeOptions {
  rootPath: string;
  filesRelPath?: string;
  systemUser: string;
  /**
   * Абсолютный путь до `core/` для MODX-сайта. Если задан — расширяем
   * права на cache/export/packages внутри него (на случай нестандартного
   * расположения core, см. config.core.php → MODX_CORE_PATH).
   */
  modxCorePath?: string;
}

export interface NormalizeStep {
  cmd: string;
  ok: boolean;
  error?: string;
}

export interface NormalizeResult {
  success: boolean;
  steps: NormalizeStep[];
  error?: string;
}

export class PermissionsManager {
  private executor: CommandExecutor;

  constructor(executor?: CommandExecutor) {
    this.executor = executor || new CommandExecutor();
  }

  async normalize(opts: NormalizeOptions): Promise<NormalizeResult> {
    const steps: NormalizeStep[] = [];
    if (!opts.systemUser || !/^[a-z_][a-z0-9_-]*$/i.test(opts.systemUser)) {
      return {
        success: false,
        steps,
        error: `Некорректный systemUser: ${opts.systemUser || '(пусто)'}`,
      };
    }
    if (!opts.rootPath || !path.isAbsolute(opts.rootPath)) {
      return {
        success: false,
        steps,
        error: `Некорректный rootPath: ${opts.rootPath}`,
      };
    }

    const wwwDir = path.join(
      opts.rootPath,
      (opts.filesRelPath || 'www').replace(/^\/+|\/+$/g, '').replace(/\.\.+/g, ''),
    );

    try {
      await fs.access(opts.rootPath);
    } catch {
      return {
        success: false,
        steps,
        error: `rootPath не существует: ${opts.rootPath}`,
      };
    }

    const owner = `${opts.systemUser}:${opts.systemUser}`;

    // 1. Восстанавливаем владельца на всё дерево сайта (включая tmp/logs).
    await this.run(steps, 'chown', ['-R', owner, opts.rootPath]);

    // 2. Базовые права для wwwDir.
    //    `X` (заглавная) — exec только для каталогов и уже-исполняемых файлов.
    //    Сохраняет +x на бинарниках в node_modules/.bin и shell-скриптах
    //    (важно для Node/Python/Go проектов), но не делает обычные файлы
    //    исполняемыми.
    try {
      await fs.access(wwwDir);
      await this.run(steps, 'chmod', ['-R', 'u=rwX,g=rX,o-rwx', wwwDir]);
    } catch {
      // wwwDir отсутствует — не критично (напр. свежесозданный сайт без файлов)
    }

    // 3. MODX writable-каталоги — даём g+w (для случая, когда PHP-FPM работает
    //    под другим юзером в системной группе сайта).
    if (opts.modxCorePath) {
      const writableSubdirs = [
        path.join(opts.modxCorePath, 'cache'),
        path.join(opts.modxCorePath, 'export'),
        path.join(opts.modxCorePath, 'packages'),
        path.join(wwwDir, 'assets'),
      ];
      for (const dir of writableSubdirs) {
        try {
          await fs.access(dir);
          await this.run(steps, 'chmod', ['-R', 'u=rwX,g=rwX,o-rwx', dir]);
        } catch {
          // отсутствует — пропускаем
        }
      }
    }

    // 4. Стандартные служебные каталоги (tmp/logs) — фикс владельца + 0750
    //    (не должны лежать с group/other правами).
    for (const sub of ['tmp', 'logs']) {
      const dir = path.join(opts.rootPath, sub);
      try {
        await fs.access(dir);
        await this.run(steps, 'chmod', ['750', dir]);
      } catch {
        /* нет */
      }
    }

    const failed = steps.filter((s) => !s.ok);
    if (failed.length) {
      return {
        success: false,
        steps,
        error: failed.map((f) => `${f.cmd}: ${f.error || 'failed'}`).join('; '),
      };
    }

    return { success: true, steps };
  }

  /**
   * Унификация пути до MODX core.
   *
   * 1. Читаем `{wwwDir}/config.core.php` — стандартный MODX-bootstrap, в нём
   *    `define('MODX_CORE_PATH', '/some/path/core/')`. Может указывать
   *    куда угодно (core часто выносят за пределы webroot для безопасности).
   * 2. Если файл не найден или формат не парсится — fallback `{wwwDir}/core`.
   *
   * Возвращает абсолютный путь без trailing slash.
   */
  async resolveModxCorePath(wwwDir: string): Promise<string> {
    const cfgFile = path.join(wwwDir, 'config.core.php');
    try {
      const txt = await fs.readFile(cfgFile, 'utf-8');
      const m = txt.match(
        /define\s*\(\s*['"]MODX_CORE_PATH['"]\s*,\s*['"]([^'"]+)['"]/,
      );
      if (m && m[1]) {
        return m[1].replace(/\/+$/, '');
      }
    } catch {
      /* fallback */
    }
    return path.join(wwwDir, 'core');
  }

  private async run(
    steps: NormalizeStep[],
    cmd: string,
    args: string[],
  ): Promise<void> {
    const display = `${cmd} ${args.join(' ')}`;
    try {
      const r = await this.executor.execute(cmd, args, { allowFailure: true });
      if (r.exitCode === 0) {
        steps.push({ cmd: display, ok: true });
      } else {
        steps.push({
          cmd: display,
          ok: false,
          error: (r.stderr || `exit ${r.exitCode}`).substring(0, 300),
        });
      }
    } catch (err) {
      steps.push({
        cmd: display,
        ok: false,
        error: (err as Error).message.substring(0, 300),
      });
    }
  }
}
