import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { CommandExecutor } from '../command-executor';
import {
  PHP_FPM_CONFIG_DIR as PHP_FPM_POOL_DIR,
  PHP_LOG_DIR,
} from '../config';
import {
  validatePhpVersion,
  validateRuntimeKey,
} from '../runtime/site-domain-runtime';
import {
  renderPhpFpmPool,
  type PhpPoolRenderParams,
} from './pool-template';
import { buildPhpPoolPreflightPlan } from './pool-preflight';

// ────── Strict allowlist regex для всех значений, которые падают в pool-INI.
// Любой chars вне allowlist'а = отказ. Это второй рубеж поверх API-валидации
// (DTO), защищает от багов в вызывающем коде и от прямых socket.io вызовов.
const RE_PHP_VERSION = /^\d+\.\d+$/;
// PHP-extension package name (mbstring, mysql, xdebug, …).
// Имя идёт в `apt-get install php{ver}-{name}` и `phpenmod -v {ver} {name}`.
// Разрешаем только lowercase + цифры + `_`. Защищает от arg-flag smuggling
// (например `name="-y"` сделал бы `apt-get install -y` вместо ожидаемой
// семантики; `name="--force-yes"` тоже опасно).
const RE_PHP_EXT = /^[a-z][a-z0-9_]{0,63}$/;

function assertRegex(name: string, value: string, re: RegExp): void {
  if (!re.test(value)) {
    throw new Error(`PhpFpmManager: invalid ${name}="${value}"`);
  }
}

export class PhpFpmManager {
  private executor: CommandExecutor;

  constructor() {
    this.executor = new CommandExecutor();
  }

  /**
   * Read-only target validation used before a transfer creates any Site state.
   * It renders the exact future pools, verifies PHP packages/services, and
   * rejects orphan pool/socket collisions on disk.
   */
  async preflightPools(
    params: readonly PhpPoolRenderParams[],
  ): Promise<{
    success: boolean;
    data?: { phpVersions: string[]; poolCount: number };
    error?: string;
  }> {
    try {
      const plan = buildPhpPoolPreflightPlan(params);
      const installedVersions = new Set(await this.listVersions());
      const errors: string[] = [];

      for (const version of plan.phpVersions) {
        if (!installedVersions.has(version)) {
          errors.push(`PHP ${version} configuration is not installed`);
          continue;
        }

        const cliPath = `/usr/bin/php${version}`;
        try {
          await fs.access(cliPath);
        } catch {
          errors.push(`PHP ${version} CLI is not installed (${cliPath})`);
        }

        const service = await this.executor.execute(
          'systemctl',
          ['show', '-p', 'LoadState', '--value', `php${version}-fpm`],
          { allowFailure: true, timeout: 10_000 },
        );
        if (service.exitCode !== 0 || service.stdout.trim() !== 'loaded') {
          errors.push(`php${version}-fpm service is not installed`);
        }
      }

      for (const pool of plan.pools) {
        if (await this.pathExists(pool.poolFile)) {
          errors.push(
            `runtimeKey "${pool.runtime.runtimeKey}" collides with existing pool ${pool.poolFile}`,
          );
        }
        const socketPath = pool.runtime.socketPath!;
        if (await this.pathExists(socketPath)) {
          errors.push(
            `runtimeKey "${pool.runtime.runtimeKey}" collides with existing socket ${socketPath}`,
          );
        }
      }

      if (errors.length > 0) {
        return { success: false, error: errors.join('; ') };
      }
      return {
        success: true,
        data: {
          phpVersions: plan.phpVersions,
          poolCount: plan.pools.length,
        },
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Create/update one PHP-FPM pool for one SiteDomain. Pools sharing a PHP
   * version intentionally share only the `phpX.Y-fpm` service; their pool,
   * socket, temp/session paths and error log are runtimeKey-owned.
   */
  async createPool(params: PhpPoolRenderParams): Promise<{ success: boolean; error?: string }> {
    const rendered = renderPhpFpmPool(params);
    const {
      content: poolConfig,
      homeDir,
      tempDir,
      sessionDir,
      poolFile,
      phpVersion: version,
      runtime,
      user,
    } = rendered;
    const socketPath = runtime.socketPath!;
    const poolDir = path.dirname(poolFile);

    let previous: string | null = null;
    try { previous = await fs.readFile(poolFile, 'utf-8'); } catch { /* new pool */ }
    if (params.domainId && previous) {
      const previousDomainId = previous.match(/^;\s*meowbox-domain-id\s*=\s*(\S+)$/m)?.[1];
      if (previousDomainId && previousDomainId !== params.domainId) {
        return {
          success: false,
          error: `runtimeKey collision: pool ${runtime.runtimeKey} already belongs to SiteDomain ${previousDomainId}`,
        };
      }
    }

    try {
      await fs.mkdir(poolDir, { recursive: true });
      await this.writeAtomic(poolFile, poolConfig, 0o644);
      await fs.mkdir(tempDir, { recursive: true, mode: 0o750 });
      await fs.mkdir(sessionDir, { recursive: true, mode: 0o750 });
      await fs.chmod(tempDir, 0o750).catch(() => {});
      await fs.chmod(sessionDir, 0o750).catch(() => {});
      if (user !== 'www-data') {
        await this.executor.execute('chown', ['-R', `${user}:${user}`, tempDir]);
        if (sessionDir !== tempDir) await this.executor.execute('chown', ['-R', `${user}:${user}`, sessionDir]);
      }
      await this.executor.execute('mkdir', ['-p', PHP_LOG_DIR]);

      // One shared service per version; the pool identity is never a service.
      const result = await this.executor.execute('systemctl', ['restart', `php${version}-fpm`], { allowFailure: true });
      if (result.exitCode !== 0) {
        const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
        await this.restorePool(poolFile, previous, version);
        if (/not found|No such file|could not be found/i.test(detail)) {
          return {
            success: false,
            error: `php${version}-fpm не установлен на сервере. Установи php${version}-fpm и php${version}-cli, либо выбери другую версию PHP.`,
          };
        }
        return { success: false, error: detail };
      }

      if (!(await this.waitForSocket(socketPath))) {
        const detail = `PHP-FPM service php${version}-fpm restarted but socket was not created: ${socketPath}`;
        await this.restorePool(poolFile, previous, version);
        return { success: false, error: detail };
      }
      return { success: true };
    } catch (err) {
      await this.restorePool(poolFile, previous, version).catch(() => {});
      return { success: false, error: (err as Error).message };
    }
  }

  private async writeAtomic(filePath: string, content: string, mode: number): Promise<void> {
    const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.writeFile(tempPath, content, { encoding: 'utf-8', mode });
      await fs.chmod(tempPath, mode).catch(() => {});
      await fs.rename(tempPath, filePath);
    } finally {
      await fs.unlink(tempPath).catch(() => {});
    }
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return false;
      throw err;
    }
  }

  private async restorePool(
    poolFile: string,
    previous: string | null,
    phpVersion: string,
  ): Promise<void> {
    if (previous === null) {
      await fs.unlink(poolFile).catch(() => {});
    } else {
      await this.writeAtomic(poolFile, previous, 0o644).catch(() => {});
    }
    await this.executor.execute('systemctl', ['restart', `php${phpVersion}-fpm`], { allowFailure: true }).catch(() => {});
  }

  private async waitForSocket(socketPath: string, timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      try {
        await fs.access(socketPath);
        return true;
      } catch {
        if (Date.now() >= deadline) return false;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
    } while (Date.now() < deadline);
    return false;
  }

  /**
   * Читает текущий pool-файл сайта с диска. Используется UI-редактором для
   * превью «как сейчас выглядит конфиг». Возвращает null если файла нет.
   * Параметр `anchor` — либо siteName (новая схема), либо domain (legacy).
   */
  async readPool(anchor: string, phpVersion: string): Promise<string | null> {
    const runtimeKey = validateRuntimeKey(anchor);
    assertRegex('phpVersion', phpVersion, RE_PHP_VERSION);
    const poolName = runtimeKey.replace(/\./g, '_');
    const poolFile = `${PHP_FPM_POOL_DIR}/${phpVersion}/fpm/pool.d/${poolName}.conf`;
    try {
      return await fs.readFile(poolFile, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Remove a PHP-FPM pool by stable runtime key.
   */
  async removePool(anchor: string, phpVersion: string): Promise<void> {
    const runtimeKey = validateRuntimeKey(anchor);
    assertRegex('phpVersion', phpVersion, RE_PHP_VERSION);
    const poolName = runtimeKey.replace(/\./g, '_');
    const poolFile = `${PHP_FPM_POOL_DIR}/${phpVersion}/fpm/pool.d/${poolName}.conf`;

    await fs.unlink(poolFile).catch(() => {});
    await this.executor.execute('systemctl', ['restart', `php${phpVersion}-fpm`]);
  }

  /**
   * Get status of a PHP-FPM version.
   */
  async status(phpVersion: string): Promise<{
    running: boolean;
    version: string | null;
    poolCount: number;
  }> {
    const statusResult = await this.executor.execute('systemctl', [
      'is-active',
      `php${phpVersion}-fpm`,
    ]);
    const running = statusResult.stdout.trim() === 'active';

    let poolCount = 0;
    try {
      const poolDir = `${PHP_FPM_POOL_DIR}/${phpVersion}/fpm/pool.d`;
      const files = await fs.readdir(poolDir);
      poolCount = files.filter((f) => f.endsWith('.conf')).length;
    } catch {
      // Directory doesn't exist
    }

    return { running, version: phpVersion, poolCount };
  }

  /**
   * List installed PHP versions.
   */
  async listVersions(): Promise<string[]> {
    try {
      const entries = await fs.readdir(PHP_FPM_POOL_DIR);
      return entries.filter((e) => /^\d+\.\d+$/.test(e)).sort();
    } catch {
      return [];
    }
  }

  async installVersion(
    version: string,
    onLog?: (line: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      assertRegex('phpVersion', version, RE_PHP_VERSION);
      const log = (l: string, s: 'stdout' | 'stderr' = 'stdout') => {
        try { onLog?.(l, s); } catch { /* ignore */ }
      };
      log(`▶ Installing PHP ${version}`);
      log(`→ ensurePhpRepository...`);
      await this.ensurePhpRepository(onLog);

      log(`→ apt-get update`);
      // apt-get update иногда выдаёт warnings + non-zero — продолжаем,
      // главное чтобы install прошёл; allowFailure: true.
      await this.executor.executeStreaming(
        'apt-get', ['update'],
        { timeout: 120_000, onLine: log, stdin: 'ignore', allowFailure: true },
      );

      // CORE — обязательные пакеты. Без них fpm не запустится. Транзакция
      // должна успешно завершиться, иначе мы НЕ хотим оставлять огрызок
      // /etc/php/{V}/ без php{V}-fpm.service (классический баг: 8.4 показывается
      // в гриде как «установлен», но статус inactive и активировать нечем —
      // потому что fpm на самом деле не доехал).
      const corePackages = [
        `php${version}-fpm`,
        `php${version}-cli`,
        `php${version}-common`,
        `php${version}-mysql`,
        `php${version}-pgsql`,
        `php${version}-sqlite3`,
        `php${version}-curl`,
        `php${version}-gd`,
        `php${version}-mbstring`,
        `php${version}-xml`,
        `php${version}-zip`,
        `php${version}-intl`,
        `php${version}-bcmath`,
        `php${version}-opcache`,
      ];

      log(`→ apt-get install core (${corePackages.length} packages)...`);
      const coreResult = await this.executor.executeStreaming(
        'apt-get', ['install', '-y', ...corePackages],
        {
          timeout: 600_000,
          onLine: log,
          stdin: 'ignore',
          env: { DEBIAN_FRONTEND: 'noninteractive' },
          allowFailure: true,
        },
      );

      if (coreResult.exitCode !== 0) {
        log(`✗ apt-get install CORE exit=${coreResult.exitCode}`, 'stderr');
        return { success: false, error: coreResult.stderr || `apt-get install core exit ${coreResult.exitCode}` };
      }

      // OPTIONAL — может отсутствовать в репах для конкретной версии (классика:
      // php8.4-imagick первые месяцы после релиза 8.4 не было в ondrej/php).
      // Ставим по одному, отвалы НЕ ломают всю установку.
      const optionalPackages = [`php${version}-imagick`];
      for (const pkg of optionalPackages) {
        log(`→ apt-get install optional ${pkg} (best-effort)...`);
        const r = await this.executor.executeStreaming(
          'apt-get', ['install', '-y', pkg],
          {
            timeout: 300_000,
            onLine: log,
            stdin: 'ignore',
            env: { DEBIAN_FRONTEND: 'noninteractive' },
            allowFailure: true,
          },
        );
        if (r.exitCode !== 0) {
          log(`! optional ${pkg} install failed — пропускаю (exit=${r.exitCode})`, 'stderr');
        }
      }

      log(`→ systemctl enable php${version}-fpm`);
      await this.executor.execute('systemctl', ['enable', `php${version}-fpm`]);
      log(`→ systemctl start php${version}-fpm`);
      await this.executor.execute('systemctl', ['start', `php${version}-fpm`]);

      // Sanity-check: после enable+start сервис должен быть active. Если нет —
      // возвращаем error с подсказкой посмотреть journalctl, чтобы UI не врал
      // «installed успешно», когда на самом деле fpm лежит.
      const check = await this.executor.execute(
        'systemctl', ['is-active', `php${version}-fpm`],
        { allowFailure: true },
      );
      const isActive = check.stdout.trim() === 'active';
      if (!isActive) {
        log(`✗ php${version}-fpm не активен после установки (is-active=${check.stdout.trim()})`, 'stderr');
        return {
          success: false,
          error: `PHP ${version} установлен, но сервис php${version}-fpm не запустился. Посмотри: journalctl -xeu php${version}-fpm`,
        };
      }

      log(`✓ PHP ${version} installed`);
      return { success: true };
    } catch (err) {
      const msg = (err as Error).message;
      try { onLog?.(`✗ ${msg}`, 'stderr'); } catch { /* ignore */ }
      return { success: false, error: msg };
    }
  }

  private async ensurePhpRepository(
    onLog?: (line: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<void> {
    const log = (l: string, s: 'stdout' | 'stderr' = 'stdout') => {
      try { onLog?.(l, s); } catch { /* ignore */ }
    };
    const osRelease = await this.readOsRelease();

    if (osRelease.ID === 'ubuntu') {
      if (await this.aptSourceContains('ondrej/php')) {
        log(`  ondrej/php PPA уже настроен — пропускаем`);
        return;
      }

      log(`  apt-get install deps (software-properties-common, ca-certificates, curl)`);
      const deps = await this.executor.executeStreaming(
        'apt-get',
        ['install', '-y', 'software-properties-common', 'ca-certificates', 'curl'],
        { timeout: 120_000, onLine: log, stdin: 'ignore', env: { DEBIAN_FRONTEND: 'noninteractive' }, allowFailure: true },
      );
      if (deps.exitCode !== 0) throw new Error(deps.stderr || 'Failed to install PPA dependencies');

      log(`  add-apt-repository ppa:ondrej/php`);
      const add = await this.executor.executeStreaming(
        'add-apt-repository',
        ['-y', 'ppa:ondrej/php'],
        { timeout: 120_000, onLine: log, stdin: 'ignore', allowFailure: true },
      );
      if (add.exitCode !== 0) throw new Error(add.stderr || 'Failed to add ondrej/php PPA');
      return;
    }

    if (osRelease.ID === 'debian') {
      const codename = osRelease.VERSION_CODENAME;
      if (!codename) throw new Error('Cannot detect Debian VERSION_CODENAME for sury.org PHP repository');
      const sourcePath = '/etc/apt/sources.list.d/sury-php.list';
      if (await this.fileExists(sourcePath)) return;

      const deps = await this.executor.execute(
        'apt-get',
        ['install', '-y', '-qq', 'ca-certificates', 'curl'],
        { timeout: 120_000, allowFailure: true },
      );
      if (deps.exitCode !== 0) throw new Error(deps.stderr || 'Failed to install sury.org dependencies');

      await this.executor.execute('mkdir', ['-p', '/etc/apt/keyrings']);
      const key = await this.executor.execute(
        'curl',
        ['-fsSL', 'https://packages.sury.org/php/apt.gpg', '-o', '/etc/apt/keyrings/sury-php.gpg'],
        { timeout: 120_000, allowFailure: true },
      );
      if (key.exitCode !== 0) throw new Error(key.stderr || 'Failed to download sury.org apt key');

      await this.executor.execute('chmod', ['a+r', '/etc/apt/keyrings/sury-php.gpg']);
      await fs.writeFile(
        sourcePath,
        `deb [signed-by=/etc/apt/keyrings/sury-php.gpg] https://packages.sury.org/php/ ${codename} main\n`,
        'utf-8',
      );
      return;
    }

    throw new Error(`Unsupported distro for PHP repository: ${osRelease.ID || 'unknown'}`);
  }

  private async readOsRelease(): Promise<Record<string, string>> {
    const content = await fs.readFile('/etc/os-release', 'utf-8');
    const result: Record<string, string> = {};
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match) continue;
      result[match[1]] = match[2].replace(/^"/, '').replace(/"$/, '');
    }
    return result;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async aptSourceContains(needle: string): Promise<boolean> {
    const files = ['/etc/apt/sources.list'];
    try {
      const entries = await fs.readdir('/etc/apt/sources.list.d');
      for (const entry of entries) {
        if (entry.endsWith('.list') || entry.endsWith('.sources')) {
          files.push(path.join('/etc/apt/sources.list.d', entry));
        }
      }
    } catch {
      // directory can be absent on stripped-down images
    }

    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        if (content.includes(needle)) return true;
      } catch {
        // ignore unreadable/missing source files
      }
    }
    return false;
  }

  async uninstallVersion(
    version: string,
    onLog?: (line: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      assertRegex('phpVersion', version, RE_PHP_VERSION);
      const log = (l: string, s: 'stdout' | 'stderr' = 'stdout') => {
        try { onLog?.(l, s); } catch { /* ignore */ }
      };
      log(`▶ Uninstalling PHP ${version}`);
      log(`→ systemctl stop php${version}-fpm`);
      // stop может фейлиться если юнит не существует — best-effort.
      await this.executor.execute('systemctl', ['stop', `php${version}-fpm`], { allowFailure: true });
      log(`→ apt-get remove --purge php${version}-*`);
      const result = await this.executor.executeStreaming(
        'apt-get', ['remove', '-y', '--purge', `php${version}-*`],
        {
          timeout: 300_000,
          onLine: log,
          stdin: 'ignore',
          env: { DEBIAN_FRONTEND: 'noninteractive' },
          allowFailure: true,
        },
      );
      if (result.exitCode !== 0) {
        return { success: false, error: result.stderr || `apt-get remove exit ${result.exitCode}` };
      }
      log(`→ apt-get autoremove --purge`);
      await this.executor.executeStreaming(
        'apt-get', ['autoremove', '-y', '--purge'],
        { timeout: 120_000, onLine: log, stdin: 'ignore', env: { DEBIAN_FRONTEND: 'noninteractive' }, allowFailure: true },
      );
      // apt-get --purge не всегда подчищает /etc/php/{version}/ (если внутри
      // лежат файлы, не зарегистрированные dpkg, например пользовательские
      // pool.d/*.conf). Без удаления каталога listVersions() продолжает
      // возвращать эту версию как «установленную» — версия зависает в гриде
      // /php и не появляется в селекторе для повторной установки.
      const versionDir = `${PHP_FPM_POOL_DIR}/${version}`;
      log(`→ rm -rf ${versionDir}`);
      try {
        await fs.rm(versionDir, { recursive: true, force: true });
      } catch (err) {
        log(`⚠ не смог удалить ${versionDir}: ${(err as Error).message}`, 'stderr');
      }
      log(`✓ PHP ${version} uninstalled`);
      return { success: true };
    } catch (err) {
      const msg = (err as Error).message;
      try { onLog?.(`✗ ${msg}`, 'stderr'); } catch { /* ignore */ }
      return { success: false, error: msg };
    }
  }

  async readIni(version: string): Promise<{ success: boolean; data?: string; error?: string }> {
    try {
      const iniPath = `${PHP_FPM_POOL_DIR}/${version}/fpm/php.ini`;
      const content = await fs.readFile(iniPath, 'utf-8');
      return { success: true, data: content };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async writeIni(version: string, content: string): Promise<{ success: boolean; error?: string }> {
    try {
      const iniPath = `${PHP_FPM_POOL_DIR}/${version}/fpm/php.ini`;
      await fs.writeFile(iniPath, content, 'utf-8');
      // Restart PHP-FPM to apply changes
      await this.executor.execute('systemctl', ['restart', `php${version}-fpm`]);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async listExtensions(version: string): Promise<{ success: boolean; data?: Array<{ name: string; enabled: boolean }>; error?: string }> {
    try {
      // List all installed extensions
      // dpkg --list возвращает >0 если ничего не найдено — это валидный сценарий.
      const result = await this.executor.execute('dpkg', ['--list', `php${version}-*`], { allowFailure: true });
      const installed: Array<{ name: string; enabled: boolean }> = [];

      if (result.exitCode === 0) {
        const lines = result.stdout.split('\n');
        for (const line of lines) {
          const match = line.match(/^ii\s+php[\d.]+-(\S+)/);
          if (match && !['fpm', 'cli', 'common'].includes(match[1])) {
            // Check if module is enabled — `php -m` может фейлиться если расширение битое.
            const modCheck = await this.executor.execute(`php${version}`, ['-m'], { allowFailure: true });
            const modName = match[1].replace(/-/g, '');
            const enabled = modCheck.stdout.toLowerCase().includes(modName.toLowerCase());
            installed.push({ name: match[1], enabled });
          }
        }
      }

      return { success: true, data: installed };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async installExtension(
    version: string,
    name: string,
    onLog?: (line: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      assertRegex('phpVersion', version, RE_PHP_VERSION);
      assertRegex('extensionName', name, RE_PHP_EXT);
      const log = (l: string, s: 'stdout' | 'stderr' = 'stdout') => {
        try { onLog?.(l, s); } catch { /* ignore */ }
      };
      log(`▶ Installing extension php${version}-${name}`);
      const result = await this.executor.executeStreaming(
        'apt-get', ['install', '-y', `php${version}-${name}`],
        {
          timeout: 180_000,
          onLine: log,
          stdin: 'ignore',
          env: { DEBIAN_FRONTEND: 'noninteractive' },
          allowFailure: true,
        },
      );
      if (result.exitCode !== 0) {
        log(`✗ apt-get install exit=${result.exitCode}`, 'stderr');
        return { success: false, error: result.stderr || `apt-get install exit ${result.exitCode}` };
      }
      log(`→ systemctl restart php${version}-fpm`);
      await this.executor.execute('systemctl', ['restart', `php${version}-fpm`]);
      log(`✓ Extension php${version}-${name} installed`);
      return { success: true };
    } catch (err) {
      const msg = (err as Error).message;
      try { onLog?.(`✗ ${msg}`, 'stderr'); } catch { /* ignore */ }
      return { success: false, error: msg };
    }
  }

  async toggleExtension(version: string, name: string, enable: boolean): Promise<{ success: boolean; error?: string }> {
    try {
      assertRegex('phpVersion', version, RE_PHP_VERSION);
      assertRegex('extensionName', name, RE_PHP_EXT);
      const cmd = enable ? 'phpenmod' : 'phpdismod';
      const result = await this.executor.execute(cmd, ['-v', version, name], { allowFailure: true });
      if (result.exitCode !== 0) {
        return { success: false, error: result.stderr };
      }
      await this.executor.execute('systemctl', ['restart', `php${version}-fpm`]);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
}
