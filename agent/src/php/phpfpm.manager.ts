import * as fs from 'fs/promises';
import * as path from 'path';
import { CommandExecutor } from '../command-executor';
import {
  PHP_FPM_CONFIG_DIR as PHP_FPM_POOL_DIR,
  PHP_FPM_SOCKET_DIR,
  PHP_LOG_DIR,
  SITES_BASE_PATH,
  isUnderAllowedSiteRoot,
} from '../config';
import {
  DEFAULT_PHP_MEMORY_LIMIT_MB,
  DEFAULT_PHP_UPLOAD_MAX_FILESIZE_MB,
  DEFAULT_PHP_POST_MAX_SIZE_MB,
  artifactAnchor,
} from '@meowbox/shared';

// ────── Strict allowlist regex для всех значений, которые падают в pool-INI.
// Любой chars вне allowlist'а = отказ. Это второй рубеж поверх API-валидации
// (DTO), защищает от багов в вызывающем коде и от прямых socket.io вызовов.
const RE_ANCHOR = /^[a-z][a-z0-9._-]{0,63}$/;
const RE_LINUX_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
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

/** Запрещаем символы, которые могут ломать INI или инжектить новые директивы. */
function assertSafePathValue(name: string, p: string): void {
  if (p.includes('\n') || p.includes('\r') || p.includes('\0')) {
    throw new Error(`PhpFpmManager: ${name} contains control chars`);
  }
  // php-fpm INI: `=` и `;` — разделители. Path не должен их содержать.
  if (/[=;\n\r\0$`]/.test(p)) {
    throw new Error(`PhpFpmManager: ${name} contains forbidden chars`);
  }
}

export class PhpFpmManager {
  private executor: CommandExecutor;

  constructor() {
    this.executor = new CommandExecutor();
  }

  /**
   * Create a PHP-FPM pool for a site.
   * Each site gets its own pool with its own socket for isolation.
   *
   * `sslEnabled` управляет флагом `session.cookie_secure`:
   *   - true → `On`   (браузер отдаёт cookie только по HTTPS — корректно для HTTPS-сайтов)
   *   - false → `Off` (без этого флага на HTTP-сайте cookie с Secure не
   *     сохраняется и админка/логин-форма зациклится, потому что сессия
   *     теряется между запросами)
   */
  async createPool(params: {
    /**
     * Системное имя сайта (Site.name = Linux-юзер) — неизменно. К нему
     * якорятся pool-файл, сокет, error_log. При смене главного домена
     * сайта ничего из этого НЕ меняется, поэтому pool не пересоздаётся.
     * Fallback на `domain` — для legacy-вызовов до миграции.
     */
    siteName?: string;
    domain: string;
    phpVersion: string;
    user?: string;
    rootPath?: string;
    sslEnabled?: boolean;
    /**
     * Кастомный INI-фрагмент пула, заданный пользователем в UI. Дописывается
     * В КОНЕЦ базового шаблона → в php-fpm директивы last-wins внутри одной
     * секции пула, так что юзер может переопределить, например, `memory_limit`
     * или `upload_max_filesize`. Секции пула (`[name]`) и системные директивы
     * (user/group/listen/pm/open_basedir/...) валидируются на стороне API и
     * сюда в чистом виде попасть не должны.
     */
    customConfig?: string | null;
  }): Promise<{ success: boolean; error?: string }> {
    const { domain, phpVersion, user = 'www-data', rootPath } = params;
    const cookieSecure = params.sslEnabled ? 'On' : 'Off';

    // Валидация всех входных значений (defense in depth: API уже валидирует,
    // но agent — последняя линия защиты от template injection).
    const anchor = artifactAnchor({ siteName: params.siteName, domain });
    assertRegex('anchor', anchor, RE_ANCHOR);
    assertRegex('phpVersion', phpVersion, RE_PHP_VERSION);
    assertRegex('user', user, RE_LINUX_USER);

    // Home-dir по-умолчанию: SITES_BASE_PATH/<anchor>. rootPath явный приоритет.
    const homeDirRaw = rootPath || path.join(SITES_BASE_PATH, anchor);
    const homeDir = path.resolve(homeDirRaw);
    assertSafePathValue('homeDir', homeDir);
    // homeDir должен быть внутри allowlist — иначе pool получит `open_basedir`
    // куда-то в /etc или /root, что недопустимо.
    if (!isUnderAllowedSiteRoot(homeDir)) {
      throw new Error(`PhpFpmManager: homeDir "${homeDir}" is outside allowed site roots`);
    }

    // poolName и пути — от siteName (неизменяемый якорь). Если siteName не
    // передан (legacy) — fallback на старое поведение (по домену).
    const poolName = anchor.replace(/\./g, '_');
    const socketPath = `${PHP_FPM_SOCKET_DIR}/php${phpVersion}-fpm-${anchor}.sock`;
    const poolDir = `${PHP_FPM_POOL_DIR}/${phpVersion}/fpm/pool.d`;
    const poolFile = `${poolDir}/${poolName}.conf`;

    // Low resource consumption pool config.
    // ВАЖНО: php-fpm в режиме PHP_INI_SYSTEM игнорирует повторное определение
    // одного и того же `php_admin_value[X]` / `php_value[X]` — побеждает ПЕРВОЕ.
    // Поэтому если юзер переопределяет директиву в customConfig, базовую строку
    // надо ВЫРЕЗАТЬ, иначе кастом будет тихо игнорироваться.
    const overriddenKeys = this.extractDirectiveKeys(params.customConfig);
    const baseLines: string[] = [
      `[${poolName}]`,
      `user = ${user}`,
      `group = ${user}`,
      `listen = ${socketPath}`,
      `listen.owner = www-data`,
      `listen.group = www-data`,
      `listen.mode = 0660`,
      ``,
      `; Process manager — ondemand uses minimal resources when idle`,
      `pm = ondemand`,
      `pm.max_children = 8`,
      `pm.process_idle_timeout = 10s`,
      `pm.max_requests = 500`,
      ``,
      `; Limits`,
      `request_terminate_timeout = 300`,
      `rlimit_files = 4096`,
      ``,
      `; Security — per-site isolation`,
      `php_admin_value[open_basedir] = ${homeDir}:${homeDir}/tmp:${homeDir}/.npm-global:/usr/share/php:/usr/bin:/usr/local/bin:/usr/local/lib/node_modules`,
      `php_admin_value[sys_temp_dir] = ${homeDir}/tmp`,
      `php_admin_value[upload_tmp_dir] = ${homeDir}/tmp`,
      `php_admin_value[session.save_path] = ${homeDir}/tmp`,
      `php_admin_value[disable_functions] = exec,passthru,shell_exec,system,popen`,
      `php_admin_value[expose_php] = Off`,
      `php_admin_value[allow_url_fopen] = Off`,
      `php_admin_value[session.cookie_httponly] = On`,
      `php_admin_value[session.cookie_secure] = ${cookieSecure}`,
      `php_admin_value[session.use_strict_mode] = On`,
      ``,
      `; Logging`,
      `php_admin_value[error_log] = ${PHP_LOG_DIR}/${anchor}-error.log`,
      `php_admin_flag[log_errors] = On`,
      ``,
      `; Performance`,
      `php_value[memory_limit] = ${DEFAULT_PHP_MEMORY_LIMIT_MB}M`,
      `php_value[upload_max_filesize] = ${DEFAULT_PHP_UPLOAD_MAX_FILESIZE_MB}M`,
      `php_value[post_max_size] = ${DEFAULT_PHP_POST_MAX_SIZE_MB}M`,
      `php_value[max_execution_time] = 120`,
      `php_value[opcache.enable] = 1`,
      `php_value[opcache.memory_consumption] = 64`,
    ];

    const filteredBase = baseLines.map((line) => {
      const key = this.extractKeyFromLine(line);
      if (key && overriddenKeys.has(key)) {
        return `; [overridden by UI] ${line}`;
      }
      return line;
    });

    const poolConfig = `${filteredBase.join('\n')}\n${this.renderCustomBlock(params.customConfig)}`;

    try {
      // Ensure pool directory exists
      await fs.mkdir(poolDir, { recursive: true });

      await fs.writeFile(poolFile, poolConfig, 'utf-8');

      // Legacy cleanup: если сайт раньше жил под старой схемой (pool по
      // имени домена), удаляем осиротевший файл — иначе php-fpm загрузит
      // ДВА пула с одинаковым listen-сокетом → конфликт на рестарте.
      if (params.siteName && params.domain && params.domain !== anchor) {
        const legacyPoolName = params.domain.replace(/\./g, '_');
        if (legacyPoolName !== poolName) {
          const legacyPoolFile = `${poolDir}/${legacyPoolName}.conf`;
          await fs.unlink(legacyPoolFile).catch(() => {});
        }
      }

      // Ensure log directory exists
      await this.executor.execute('mkdir', ['-p', PHP_LOG_DIR]);

      // Restart PHP-FPM for this version
      const result = await this.executor.execute('systemctl', [
        'restart',
        `php${phpVersion}-fpm`,
      ]);

      if (result.exitCode !== 0) {
        const errMsg = result.stderr || '';
        // Rollback poolFile — нельзя оставлять дохлый конфиг.
        await fs.unlink(poolFile).catch(() => {});
        // Особый случай: сервис php{V}-fpm не установлен на системе. Раньше
        // здесь silently возвращался success — это приводило к "успешному"
        // созданию сайта с несуществующим upstream (запросы 502 forever).
        // Теперь явная ошибка с подсказкой.
        if (
          errMsg.includes('not found') ||
          errMsg.includes('No such file') ||
          errMsg.includes('could not be found')
        ) {
          return {
            success: false,
            error: `php${phpVersion}-fpm не установлен на сервере. Установи: apt install php${phpVersion}-fpm php${phpVersion}-cli (на Ubuntu/Debian подключи ondrej/php PPA или sury.org), либо выбери другую версию PHP при создании сайта.`,
          };
        }
        return { success: false, error: errMsg };
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Обёртка: превращает пользовательский INI-фрагмент в суффикс pool-файла.
   * Пусто/whitespace → пустая строка (ничего не дописываем).
   * Иначе — комментарий-разделитель + сам фрагмент с нормализованным EOL.
   */
  private renderCustomBlock(custom: string | null | undefined): string {
    const s = (custom || '').trim();
    if (!s) return '';
    return `
; --- Custom overrides (meowbox UI) ---
${s}
`;
  }

  /**
   * Достаёт левую часть `key = value` (или `key[sub] = value`) из одной строки
   * INI-конфига. Возвращает null для пустых/комментариев/секций/мусора.
   * Ключи нормализуем по регистру (php-fpm case-sensitive только по `[brackets]`).
   */
  private extractKeyFromLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith(';') || trimmed.startsWith('#')) return null;
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) return null; // section
    const eq = trimmed.indexOf('=');
    if (eq <= 0) return null;
    const key = trimmed.substring(0, eq).trim();
    if (!key) return null;
    return key;
  }

  /**
   * Парсит кастомный INI-фрагмент юзера и возвращает Set ключей, которые он
   * переопределяет. Используется чтобы вырезать соответствующие строки из
   * базового шаблона (см. `createPool`).
   */
  private extractDirectiveKeys(custom: string | null | undefined): Set<string> {
    const keys = new Set<string>();
    const s = (custom || '').trim();
    if (!s) return keys;
    for (const line of s.split(/\r?\n/)) {
      const k = this.extractKeyFromLine(line);
      if (k) keys.add(k);
    }
    return keys;
  }

  /**
   * Читает текущий pool-файл сайта с диска. Используется UI-редактором для
   * превью «как сейчас выглядит конфиг». Возвращает null если файла нет.
   * Параметр `anchor` — либо siteName (новая схема), либо domain (legacy).
   */
  async readPool(anchor: string, phpVersion: string): Promise<string | null> {
    assertRegex('anchor', anchor, RE_ANCHOR);
    assertRegex('phpVersion', phpVersion, RE_PHP_VERSION);
    const poolName = anchor.replace(/\./g, '_');
    const poolFile = `${PHP_FPM_POOL_DIR}/${phpVersion}/fpm/pool.d/${poolName}.conf`;
    try {
      return await fs.readFile(poolFile, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Remove a PHP-FPM pool (по siteName или legacy-domain).
   */
  async removePool(anchor: string, phpVersion: string): Promise<void> {
    assertRegex('anchor', anchor, RE_ANCHOR);
    assertRegex('phpVersion', phpVersion, RE_PHP_VERSION);
    const poolName = anchor.replace(/\./g, '_');
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
      await this.executor.executeStreaming(
        'apt-get', ['update'],
        { timeout: 120_000, onLine: log, stdin: 'ignore' },
      );

      const packages = [
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
        `php${version}-imagick`,
      ];

      log(`→ apt-get install ${packages.length} packages...`);
      const result = await this.executor.executeStreaming(
        'apt-get', ['install', '-y', ...packages],
        {
          timeout: 600_000,
          onLine: log,
          stdin: 'ignore',
          env: { DEBIAN_FRONTEND: 'noninteractive' },
        },
      );

      if (result.exitCode !== 0) {
        log(`✗ apt-get install exit=${result.exitCode}`, 'stderr');
        return { success: false, error: result.stderr || `apt-get install exit ${result.exitCode}` };
      }

      log(`→ systemctl enable php${version}-fpm`);
      await this.executor.execute('systemctl', ['enable', `php${version}-fpm`]);
      log(`→ systemctl start php${version}-fpm`);
      await this.executor.execute('systemctl', ['start', `php${version}-fpm`]);

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
        { timeout: 120_000, onLine: log, stdin: 'ignore', env: { DEBIAN_FRONTEND: 'noninteractive' } },
      );
      if (deps.exitCode !== 0) throw new Error(deps.stderr || 'Failed to install PPA dependencies');

      log(`  add-apt-repository ppa:ondrej/php`);
      const add = await this.executor.executeStreaming(
        'add-apt-repository',
        ['-y', 'ppa:ondrej/php'],
        { timeout: 120_000, onLine: log, stdin: 'ignore' },
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
        { timeout: 120_000 },
      );
      if (deps.exitCode !== 0) throw new Error(deps.stderr || 'Failed to install sury.org dependencies');

      await this.executor.execute('mkdir', ['-p', '/etc/apt/keyrings']);
      const key = await this.executor.execute(
        'curl',
        ['-fsSL', 'https://packages.sury.org/php/apt.gpg', '-o', '/etc/apt/keyrings/sury-php.gpg'],
        { timeout: 120_000 },
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
      await this.executor.execute('systemctl', ['stop', `php${version}-fpm`]);
      log(`→ apt-get remove --purge php${version}-*`);
      const result = await this.executor.executeStreaming(
        'apt-get', ['remove', '-y', '--purge', `php${version}-*`],
        {
          timeout: 300_000,
          onLine: log,
          stdin: 'ignore',
          env: { DEBIAN_FRONTEND: 'noninteractive' },
        },
      );
      if (result.exitCode !== 0) {
        return { success: false, error: result.stderr || `apt-get remove exit ${result.exitCode}` };
      }
      log(`→ apt-get autoremove --purge`);
      await this.executor.executeStreaming(
        'apt-get', ['autoremove', '-y', '--purge'],
        { timeout: 120_000, onLine: log, stdin: 'ignore', env: { DEBIAN_FRONTEND: 'noninteractive' } },
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
      const result = await this.executor.execute('dpkg', ['--list', `php${version}-*`]);
      const installed: Array<{ name: string; enabled: boolean }> = [];

      if (result.exitCode === 0) {
        const lines = result.stdout.split('\n');
        for (const line of lines) {
          const match = line.match(/^ii\s+php[\d.]+-(\S+)/);
          if (match && !['fpm', 'cli', 'common'].includes(match[1])) {
            // Check if module is enabled
            const modCheck = await this.executor.execute(`php${version}`, ['-m']);
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
      const result = await this.executor.execute(cmd, ['-v', version, name]);
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
