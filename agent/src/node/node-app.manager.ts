import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CommandExecutor } from '../command-executor';
import { SITES_BASE_PATH, isUnderAllowedSiteRoot, TIMEOUTS } from '../config';
import { PM2_ECOSYSTEM_FILENAMES } from '@meowbox/shared';
import type {
  NodeAppDefinition,
  NodeProcessRuntime,
  NodeProcessView,
  NodeEcosystemGroup,
  NodeProcessesResult,
  DiscoveredCommand,
  DiscoveredCommandGroup,
  QuickCommandRunResult,
} from '@meowbox/shared';

/**
 * Управление Node.js-приложениями сайта через PM2.
 *
 * Архитектура:
 *   - Источник правды PM2-процессов — ecosystem-файл(ы) в репозитории сайта.
 *     Менеджер их обнаруживает и читает, НО не создаёт и не редактирует.
 *   - Все PM2/node/npm/make операции выполняются от имени системного юзера
 *     сайта (`sudo -u <user> -H ...`). `-H` выставляет HOME → PM2 использует
 *     `$HOME/.pm2` как PM2_HOME (изоляция per-site, как у php-fpm пулов).
 *   - Автозагрузка — systemd-шаблон `pm2@<user>.service` (ставится системной
 *     миграцией). Тумблер = `systemctl enable/disable` + `pm2 save`.
 */
export class NodeAppManager {
  private executor: CommandExecutor;
  private readerPath: string;

  // Системный юзер сайта (= Site.name): буква/подчёркивание, [a-z0-9_-], ≤32.
  private static readonly USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
  // Имя PM2-процесса.
  private static readonly PROC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
  // npm-скрипт / make-таргет.
  private static readonly TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,99}$/;
  private static readonly ECOSYSTEM_NAMES: ReadonlySet<string> = new Set(
    PM2_ECOSYSTEM_FILENAMES,
  );
  // Директории, которые НЕ обходим при сканировании.
  private static readonly SKIP_DIRS: ReadonlySet<string> = new Set([
    'node_modules',
    '.git',
    '.nuxt',
    '.output',
    'dist',
    '.cache',
    'vendor',
    'tmp',
    'logs',
    'coverage',
  ]);
  private static readonly MAX_SCAN_DEPTH = 4;
  private static readonly MAX_ECOSYSTEM_FILES = 30;
  private static readonly MAX_COMMAND_FILES = 60;
  private static readonly MAX_PKG_JSON_BYTES = 512 * 1024;
  private static readonly MAX_MAKEFILE_BYTES = 256 * 1024;

  private static readonly READER_SCRIPT = `'use strict';
try {
  var file = process.argv[2];
  if (!file) { process.stderr.write('no file arg'); process.exit(2); }
  var mod = require(file);
  var apps = [];
  if (mod && Array.isArray(mod.apps)) apps = mod.apps;
  else if (Array.isArray(mod)) apps = mod;
  else if (mod && typeof mod === 'object' && mod.name) apps = [mod];
  var out = apps.map(function (a) {
    a = a || {};
    return {
      name: typeof a.name === 'string' ? a.name : null,
      script: typeof a.script === 'string' ? a.script : null,
      cwd: typeof a.cwd === 'string' ? a.cwd : null,
      interpreter: typeof a.interpreter === 'string' ? a.interpreter : null,
      execMode: typeof a.exec_mode === 'string' ? a.exec_mode : null,
      instances: typeof a.instances === 'number' ? a.instances : null,
    };
  });
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  process.stderr.write(String((e && e.message) || e));
  process.exit(1);
}
`;

  constructor() {
    this.executor = new CommandExecutor();
    this.readerPath = path.join(os.tmpdir(), 'meowbox-pm2-ecosystem-reader.cjs');
  }

  // ------------------------------------------------------------------
  // Пути сайта
  // ------------------------------------------------------------------

  /** Домашняя директория сайта = `{SITES_BASE_PATH}/{user}`. */
  private siteHome(user: string): string {
    if (!NodeAppManager.USER_RE.test(user)) {
      throw new Error(`Invalid site user: ${user}`);
    }
    const home = path.join(SITES_BASE_PATH, user);
    if (!isUnderAllowedSiteRoot(home)) {
      throw new Error(`Site home outside allowed root: ${home}`);
    }
    return home;
  }

  /** Web-root сайта (директория, где лежит код) — `home/{filesRelPath}`. */
  private webRoot(user: string, filesRelPath: string): string {
    const home = this.siteHome(user);
    const rel = (filesRelPath || 'www').replace(/^\/+|\/+$/g, '');
    const root = path.resolve(home, rel);
    if (root !== home && !root.startsWith(home + path.sep)) {
      throw new Error(`Web root escapes site home: ${root}`);
    }
    return root;
  }

  /** Проверяет, что путь лежит строго внутри домашней директории сайта. */
  private assertWithinHome(user: string, target: string): string {
    const home = this.siteHome(user);
    const abs = path.resolve(target);
    if (abs !== home && !abs.startsWith(home + path.sep)) {
      throw new Error(`Path outside site home: ${abs}`);
    }
    return abs;
  }

  // ------------------------------------------------------------------
  // Запуск команд от имени юзера сайта
  // ------------------------------------------------------------------

  /** `sudo -u <user> -H <bin> <args>`. `-H` → HOME юзера → PM2_HOME=~/.pm2. */
  private async runAsUser(
    user: string,
    bin: string,
    args: string[],
    opts: { cwd?: string; timeout?: number; allowFailure?: boolean } = {},
  ) {
    return this.executor.execute('sudo', ['-u', user, '-H', bin, ...args], {
      cwd: opts.cwd,
      timeout: opts.timeout,
      allowFailure: opts.allowFailure,
    });
  }

  // ------------------------------------------------------------------
  // PM2 runtime (live)
  // ------------------------------------------------------------------

  /** Запущен ли PM2-демон сайта (по pid-файлу). */
  private daemonRunning(user: string): boolean {
    try {
      const pidFile = path.join(this.siteHome(user), '.pm2', 'pm2.pid');
      if (!fs.existsSync(pidFile)) return false;
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (!Number.isInteger(pid) || pid <= 0) return false;
      process.kill(pid, 0); // throws ESRCH если процесса нет
      return true;
    } catch {
      return false;
    }
  }

  /**
   * `pm2 jlist` от имени юзера. Чтобы не плодить idle-демоны на сайтах без
   * Node-приложений — вызываем только если директория `.pm2` уже существует.
   */
  private async listRuntime(user: string): Promise<NodeProcessRuntime[]> {
    const pm2Dir = path.join(this.siteHome(user), '.pm2');
    if (!fs.existsSync(pm2Dir)) return [];

    const res = await this.runAsUser(user, 'pm2', ['jlist'], {
      timeout: TIMEOUTS.SHORT,
      allowFailure: true,
    });
    if (res.exitCode !== 0) return [];

    let raw: unknown;
    try {
      raw = JSON.parse(res.stdout);
    } catch {
      // PM2 иногда печатает баннер перед JSON — пробуем вырезать массив.
      const start = res.stdout.indexOf('[');
      const end = res.stdout.lastIndexOf(']');
      if (start < 0 || end <= start) return [];
      try {
        raw = JSON.parse(res.stdout.slice(start, end + 1));
      } catch {
        return [];
      }
    }
    if (!Array.isArray(raw)) return [];

    return raw
      .map((p): NodeProcessRuntime | null => {
        const proc = p as {
          name?: string;
          pm_id?: number;
          pid?: number;
          monit?: { cpu?: number; memory?: number };
          pm2_env?: {
            status?: string;
            pm_uptime?: number;
            restart_time?: number;
            exec_mode?: string;
            instances?: number;
          };
        };
        if (typeof proc.name !== 'string') return null;
        return {
          name: proc.name,
          pmId: typeof proc.pm_id === 'number' ? proc.pm_id : -1,
          pid: typeof proc.pid === 'number' && proc.pid > 0 ? proc.pid : null,
          status: proc.pm2_env?.status || 'unknown',
          cpu: proc.monit?.cpu || 0,
          memory: proc.monit?.memory || 0,
          uptime: proc.pm2_env?.pm_uptime || 0,
          restarts: proc.pm2_env?.restart_time || 0,
          execMode: proc.pm2_env?.exec_mode || null,
          instances:
            typeof proc.pm2_env?.instances === 'number'
              ? proc.pm2_env.instances
              : null,
        };
      })
      .filter((p): p is NodeProcessRuntime => p !== null);
  }

  // ------------------------------------------------------------------
  // Discovery: ecosystem-файлы
  // ------------------------------------------------------------------

  /** Рекурсивно ищет файлы по предикату (depth-limited, skip служебных дир). */
  private async walk(
    root: string,
    accept: (name: string) => boolean,
    limit: number,
  ): Promise<string[]> {
    const found: string[] = [];
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (found.length >= limit || depth > NodeAppManager.MAX_SCAN_DEPTH) return;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (found.length >= limit) return;
        if (e.isDirectory()) {
          if (e.name.startsWith('.') || NodeAppManager.SKIP_DIRS.has(e.name)) {
            continue;
          }
          await visit(path.join(dir, e.name), depth + 1);
        } else if (e.isFile() && accept(e.name)) {
          found.push(path.join(dir, e.name));
        }
      }
    };
    await visit(root, 0);
    return found;
  }

  /** Записывает reader-скрипт во временный файл (идемпотентно). */
  private ensureReader(): void {
    try {
      fs.writeFileSync(this.readerPath, NodeAppManager.READER_SCRIPT, {
        mode: 0o644,
      });
      fs.chmodSync(this.readerPath, 0o644);
    } catch (err) {
      throw new Error(`Cannot write ecosystem reader: ${(err as Error).message}`);
    }
  }

  /**
   * Читает ecosystem-файл, исполняя его в node от имени юзера сайта.
   * Безопасно: код исполняется с правами unprivileged-юзера сайта (тот же
   * уровень доверия, что и сам запуск приложения).
   */
  private async readEcosystem(
    user: string,
    file: string,
  ): Promise<NodeAppDefinition[]> {
    const abs = this.assertWithinHome(user, file);
    this.ensureReader();
    const res = await this.runAsUser(user, 'node', [this.readerPath, abs], {
      cwd: path.dirname(abs),
      timeout: 15_000,
      allowFailure: true,
    });
    if (res.exitCode !== 0) return [];
    try {
      const parsed = JSON.parse(res.stdout) as NodeAppDefinition[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------
  // Публичное API менеджера
  // ------------------------------------------------------------------

  /**
   * Полная картина PM2-процессов сайта: определённые в ecosystem-файлах ∪
   * живые в PM2-демоне. Объединение по имени процесса.
   */
  async getProcesses(
    user: string,
    filesRelPath: string,
  ): Promise<NodeProcessesResult> {
    const home = this.siteHome(user);
    const webRoot = this.webRoot(user, filesRelPath);

    const ecoFiles = fs.existsSync(webRoot)
      ? await this.walk(
          webRoot,
          (n) => NodeAppManager.ECOSYSTEM_NAMES.has(n),
          NodeAppManager.MAX_ECOSYSTEM_FILES,
        )
      : [];
    ecoFiles.sort();

    const runtime = await this.listRuntime(user);
    const runtimeByName = new Map(runtime.map((r) => [r.name, r]));
    const consumed = new Set<string>();

    const groups: NodeEcosystemGroup[] = [];
    for (const file of ecoFiles) {
      const defs = await this.readEcosystem(user, file);
      const processes: NodeProcessView[] = [];
      for (const def of defs) {
        if (!def.name) continue; // без имени процессом не поуправляешь
        const rt = runtimeByName.get(def.name) || null;
        if (rt) consumed.add(def.name);
        processes.push({
          name: def.name,
          defined: true,
          loaded: rt !== null,
          ecosystemFile: file,
          definition: def,
          runtime: rt,
        });
      }
      groups.push({
        ecosystemFile: file,
        dir: path.relative(webRoot, path.dirname(file)) || '.',
        processes,
      });
    }

    // Сироты — процессы в PM2-демоне, не описанные ни одним ecosystem-файлом.
    const orphans: NodeProcessView[] = runtime
      .filter((r) => !consumed.has(r.name))
      .map((r) => ({
        name: r.name,
        defined: false,
        loaded: true,
        ecosystemFile: null,
        definition: null,
        runtime: r,
      }));
    if (orphans.length > 0) {
      groups.push({ ecosystemFile: null, dir: null, processes: orphans });
    }

    return {
      groups,
      ecosystemCount: ecoFiles.length,
      daemonRunning: this.daemonRunning(user),
      autostartEnabled: await this.getAutostart(user),
    };
  }

  /** Запускает приложения из ecosystem-файла (всё или одно по `only`). */
  async startEcosystem(
    user: string,
    file: string,
    only?: string,
  ): Promise<void> {
    const abs = this.assertWithinHome(user, file);
    if (!fs.existsSync(abs)) {
      throw new Error(`Ecosystem file not found: ${abs}`);
    }
    const args = ['start', abs];
    if (only) {
      if (!NodeAppManager.PROC_NAME_RE.test(only)) {
        throw new Error(`Invalid process name: ${only}`);
      }
      args.push('--only', only);
    }
    await this.runAsUser(user, 'pm2', args, {
      cwd: path.dirname(abs),
      timeout: TIMEOUTS.MEDIUM,
    });
    await this.save(user);
  }

  /** stop | restart | reload | delete для конкретного процесса. */
  async controlProcess(
    user: string,
    action: 'stop' | 'restart' | 'reload' | 'delete',
    name: string,
  ): Promise<void> {
    if (!NodeAppManager.PROC_NAME_RE.test(name)) {
      throw new Error(`Invalid process name: ${name}`);
    }
    await this.runAsUser(user, 'pm2', [action, name], {
      timeout: TIMEOUTS.MEDIUM,
    });
    if (action === 'delete' || action === 'stop') {
      await this.save(user);
    }
  }

  /** `pm2 save` — фиксирует текущий список процессов для resurrect. */
  private async save(user: string): Promise<void> {
    try {
      await this.runAsUser(user, 'pm2', ['save'], { timeout: TIMEOUTS.SHORT });
    } catch {
      // pm2 save не критичен для самой операции — не валим всю команду.
    }
  }

  /** Логи процесса из PM2 (без стрима). */
  async getLogs(user: string, name: string, lines = 200): Promise<string> {
    if (!NodeAppManager.PROC_NAME_RE.test(name)) {
      throw new Error(`Invalid process name: ${name}`);
    }
    const safeLines = Math.min(Math.max(1, Math.floor(lines)), 2000);
    const res = await this.runAsUser(
      user,
      'pm2',
      ['logs', name, '--lines', String(safeLines), '--nostream', '--raw'],
      { timeout: TIMEOUTS.SHORT, allowFailure: true },
    );
    return (res.stdout || '') + (res.stderr ? `\n${res.stderr}` : '');
  }

  // ------------------------------------------------------------------
  // Автозагрузка (systemd-шаблон pm2@<user>.service)
  // ------------------------------------------------------------------

  /** Включена ли автозагрузка PM2-демона сайта при старте сервера. */
  async getAutostart(user: string): Promise<boolean> {
    if (!NodeAppManager.USER_RE.test(user)) return false;
    const res = await this.executor.execute(
      'systemctl',
      ['is-enabled', `pm2@${user}`],
      { timeout: TIMEOUTS.SHORT, allowFailure: true },
    );
    return res.stdout.trim() === 'enabled';
  }

  /** Включает/выключает автозагрузку. На enable дополнительно делает `pm2 save`. */
  async setAutostart(user: string, enable: boolean): Promise<void> {
    if (!NodeAppManager.USER_RE.test(user)) {
      throw new Error(`Invalid site user: ${user}`);
    }
    const unit = `pm2@${user}`;
    await this.executor.execute(
      'systemctl',
      [enable ? 'enable' : 'disable', unit],
      { timeout: TIMEOUTS.SHORT },
    );
    if (enable) {
      // resurrect на старте сервера читает dump.pm2 — фиксируем текущий набор.
      await this.save(user);
    }
  }

  // ------------------------------------------------------------------
  // Быстрые команды (Makefile / package.json scripts)
  // ------------------------------------------------------------------

  /** Сканирует web-root: package.json scripts + Makefile-таргеты. */
  async scanCommands(
    user: string,
    filesRelPath: string,
  ): Promise<DiscoveredCommandGroup[]> {
    const webRoot = this.webRoot(user, filesRelPath);
    if (!fs.existsSync(webRoot)) return [];

    const files = await this.walk(
      webRoot,
      (n) => n === 'package.json' || n === 'Makefile' || n === 'makefile',
      NodeAppManager.MAX_COMMAND_FILES,
    );
    files.sort();

    const groups: DiscoveredCommandGroup[] = [];
    for (const file of files) {
      const base = path.basename(file);
      const dir = path.relative(webRoot, path.dirname(file)) || '.';
      try {
        if (base === 'package.json') {
          const cmds = await this.parsePackageScripts(file);
          if (cmds.length > 0) {
            groups.push({ source: 'npm', file, dir, commands: cmds });
          }
        } else {
          const cmds = await this.parseMakefileTargets(file);
          if (cmds.length > 0) {
            groups.push({ source: 'make', file, dir, commands: cmds });
          }
        }
      } catch {
        // Битый файл — просто пропускаем.
      }
    }
    return groups;
  }

  private async parsePackageScripts(file: string): Promise<DiscoveredCommand[]> {
    const stat = await fsp.stat(file);
    if (stat.size > NodeAppManager.MAX_PKG_JSON_BYTES) return [];
    const raw = await fsp.readFile(file, 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    if (!pkg.scripts || typeof pkg.scripts !== 'object') return [];
    const cmds: DiscoveredCommand[] = [];
    for (const [name, body] of Object.entries(pkg.scripts)) {
      if (!NodeAppManager.TARGET_RE.test(name)) continue;
      cmds.push({
        source: 'npm',
        target: name,
        preview: typeof body === 'string' ? body.slice(0, 200) : null,
      });
    }
    return cmds;
  }

  private async parseMakefileTargets(file: string): Promise<DiscoveredCommand[]> {
    const stat = await fsp.stat(file);
    if (stat.size > NodeAppManager.MAX_MAKEFILE_BYTES) return [];
    const raw = await fsp.readFile(file, 'utf8');
    const lines = raw.split(/\r?\n/);
    // Имя цели в начале строки + `:` (но не `:=` — это присваивание переменной).
    const targetRe = /^([A-Za-z0-9][A-Za-z0-9_.\-/]*)\s*:(?!=)(.*)$/;
    const seen = new Set<string>();
    const cmds: DiscoveredCommand[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = targetRe.exec(lines[i]);
      if (!m) continue;
      const target = m[1];
      if (seen.has(target)) continue;
      if (!NodeAppManager.TARGET_RE.test(target)) continue;
      seen.add(target);
      // Превью: зависимости на той же строке, либо первая строка рецепта.
      let preview = m[2].trim();
      if (!preview) {
        for (let j = i + 1; j < lines.length && j < i + 8; j++) {
          if (lines[j].startsWith('\t')) {
            preview = lines[j].trim();
            break;
          }
          if (lines[j].trim() !== '') break;
        }
      }
      cmds.push({
        source: 'make',
        target,
        preview: preview ? preview.slice(0, 200) : null,
      });
    }
    return cmds;
  }

  /**
   * Выполняет быструю команду (npm run <target> | make <target>) от имени
   * юзера сайта в директории `cwd`. Возвращает собранный вывод.
   */
  async runQuickCommand(
    user: string,
    source: 'npm' | 'make',
    target: string,
    cwd: string,
  ): Promise<QuickCommandRunResult> {
    if (source !== 'npm' && source !== 'make') {
      throw new Error(`Invalid command source: ${source}`);
    }
    if (!NodeAppManager.TARGET_RE.test(target)) {
      throw new Error(`Invalid command target: ${target}`);
    }
    const absCwd = this.assertWithinHome(user, cwd);
    if (!fs.existsSync(absCwd)) {
      throw new Error(`Working directory not found: ${absCwd}`);
    }

    const bin = source === 'npm' ? 'npm' : 'make';
    const args = source === 'npm' ? ['run', target] : [target];
    const lines: string[] = [];
    const started = Date.now();
    const res = await this.executor.executeStreaming(
      'sudo',
      ['-u', user, '-H', bin, ...args],
      {
        cwd: absCwd,
        timeout: TIMEOUTS.LONG,
        stdin: 'ignore',
        allowFailure: true,
        onLine: (line) => {
          if (lines.length < 5000) lines.push(line);
        },
      },
    );
    return {
      exitCode: res.exitCode,
      output: lines.join('\n'),
      durationMs: Date.now() - started,
    };
  }
}
