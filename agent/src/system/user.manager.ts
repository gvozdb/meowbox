import { CommandExecutor } from '../command-executor';
import { randomBytes } from 'crypto';
import { promises as fs, constants as fsConstants } from 'fs';

/**
 * Manages per-site Linux system users for process isolation.
 *
 * Each site gets its own OS user — имя юзера совпадает с именем сайта
 * без какого-либо префикса (раньше был `site_`, удалён в migration:
 * см. CHANGELOG #079). То есть сайт `pkgs` → linux-юзер `pkgs`.
 * PHP-FPM runs under this user, and all site files are owned by it.
 * Nginx still runs as www-data but connects to FPM via a socket owned
 * by the site user.
 *
 * Directory structure:
 *   {basePath}/{systemUser}/        ← home, SSH/SFTP landing
 *   {basePath}/{systemUser}/www/    ← web root (nginx root)
 *   {basePath}/{systemUser}/tmp/    ← PHP sessions, uploads
 *   {basePath}/{systemUser}/logs/   ← per-site logs
 */
export class SystemUserManager {
  private executor: CommandExecutor;

  constructor(executor?: CommandExecutor) {
    this.executor = executor || new CommandExecutor();
  }

  /**
   * Generate a safe Linux username from site name.
   * Linux usernames: lowercase, [a-z0-9_-], max 32 chars, must start with letter.
   *
   * Без префикса `site_`: имя сайта === имя Linux-юзера === имя БД === имя БД-юзера.
   * Проверка на совпадение с системными юзерами делается API-валидацией
   * (RESERVED_USERS в sites.service.ts) ДО вызова агента.
   */
  static generateUsername(siteName: string): string {
    const safe = siteName
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[^a-z]+/, ''); // must start with a letter

    return safe.substring(0, 32);
  }

  /**
   * Create a system user for a site with SSH/SFTP access.
   * - Bash shell for full SSH
   * - Home directory = site root path
   * - Added to www-data group so Nginx can read via FPM socket
   * - Password set for SSH/SFTP login
   *
   * filesRelPath — относительный путь к web-root внутри homedir. По умолчанию
   * `www`. Допускается вложенный путь (например `www/public` для front-controller
   * паттернов: twig/symfony/laravel) — все промежуточные папки создаются с
   * правами 750, чтобы nginx (через group www-data) мог пройти по дереву.
   */
  async createUser(
    username: string,
    homeDir: string,
    password?: string,
    filesRelPath?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const exists = await this.userExists(username);
    if (exists) {
      if (password) {
        await this.setPassword(username, password);
      }
      return { success: true };
    }

    const result = await this.executor.execute('useradd', [
      '--create-home',
      '--home-dir', homeDir,
      '--shell', '/bin/bash',
      '--user-group',
      username,
    ], { allowFailure: true });

    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr || `useradd failed (code ${result.exitCode})` };
    }

    // Add user to www-data group (for FPM socket access)
    await this.executor.execute('usermod', ['-aG', 'www-data', username]);

    // Add www-data to user's group (so nginx can read site files with 750 perms)
    await this.executor.execute('usermod', ['-aG', username, 'www-data']);

    // Set password for SSH/SFTP access
    if (password) {
      await this.setPassword(username, password);
    }

    // Web-root: дефолт `www`, валидируем — без leading `/`, без `..`,
    // только [A-Za-z0-9._-] в каждом сегменте.
    const safeRel = (filesRelPath || 'www').trim();
    const validRel = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(safeRel);
    const webRel = validRel ? safeRel : 'www';

    // Create standard directory structure: <webRel>, tmp, logs.
    for (const dir of [webRel, 'tmp', 'logs']) {
      await this.executor.execute('mkdir', ['-p', `${homeDir}/${dir}`]);
    }

    // Set ownership and permissions
    await this.executor.execute('chown', ['-R', `${username}:${username}`, homeDir]);
    await this.executor.execute('chmod', ['750', homeDir]);

    // Все промежуточные сегменты webRel должны быть 750, чтобы www-data
    // (через group user) мог по ним пройти. Для `www/public` — и `www/`, и `www/public/`.
    let acc = homeDir;
    for (const seg of webRel.split('/').filter(Boolean)) {
      acc = `${acc}/${seg}`;
      await this.executor.execute('chmod', ['750', acc]);
    }
    await this.executor.execute('chmod', ['700', `${homeDir}/tmp`]);
    await this.executor.execute('chmod', ['750', `${homeDir}/logs`]);

    return { success: true };
  }

  /**
   * Set password for a system user.
   * Uses openssl to generate SHA-512 crypt hash, then usermod --password.
   */
  async setPassword(
    username: string,
    password: string,
  ): Promise<{ success: boolean; error?: string }> {
    const salt = randomBytes(12).toString('base64').replace(/[+/=]/g, '.').substring(0, 16);

    // Generate SHA-512 password hash via openssl
    const hashResult = await this.executor.execute('openssl', [
      'passwd', '-6', '-salt', salt, password,
    ], { allowFailure: true });

    if (hashResult.exitCode !== 0) {
      return { success: false, error: 'Failed to generate password hash' };
    }

    const hash = hashResult.stdout.trim();

    const result = await this.executor.execute('usermod', [
      '--password', hash,
      username,
    ], { allowFailure: true });

    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr || 'Failed to set password' };
    }

    return { success: true };
  }

  /**
   * Set ownership of site directory to the site user.
   */
  async setOwnership(
    username: string,
    rootPath: string,
  ): Promise<{ success: boolean; error?: string }> {
    const result = await this.executor.execute('chown', [
      '-R', `${username}:${username}`, rootPath,
    ], { allowFailure: true });

    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr };
    }

    await this.executor.execute('chmod', ['750', rootPath]);

    return { success: true };
  }

  /**
   * Delete a system user (when site is deleted).
   * Does NOT delete home directory (site files managed separately).
   */
  async deleteUser(username: string): Promise<{ success: boolean; error?: string }> {
    const exists = await this.userExists(username);
    if (!exists) {
      return { success: true };
    }

    // gpasswd может вернуть !=0 если юзер не в группе — это норма.
    await this.executor.execute('gpasswd', ['-d', 'www-data', username], { allowFailure: true }).catch(() => {});

    const result = await this.executor.execute('userdel', [username], { allowFailure: true });

    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr || `userdel failed (code ${result.exitCode})` };
    }

    return { success: true };
  }

  /**
   * Check if a system user exists.
   */
  async userExists(username: string): Promise<boolean> {
    // `id -u` возвращает 1 если юзера нет — это нормальная проверка существования.
    const result = await this.executor.execute('id', ['-u', username], { allowFailure: true });
    return result.exitCode === 0;
  }

  /**
   * Настроить per-user CLI-шим, чтобы команда `php` в SSH/SFTP-сессии юзера
   * вызывала ту версию PHP, которая активирована на его сайте.
   *
   * Создаём симлинки в `~/bin/`:
   *   php       → /usr/bin/php{version}
   *   phpize    → /usr/bin/phpize{version}    (если есть)
   *   php-cgi   → /usr/bin/php-cgi{version}   (если есть)
   *   php-config → /usr/bin/php-config{version} (если есть)
   *   pecl      → /usr/bin/pecl{version}      (если есть)
   *
   * И добавляем `export PATH="$HOME/bin:$PATH"` в `~/.bashrc` (идемпотентно).
   *
   * Если phpVersion == null/'' → вычищаем шим (удаляем симлинки и строку из bashrc).
   */
  async setupPhpShim(
    username: string,
    homeDir: string,
    phpVersion: string | null | undefined,
  ): Promise<{ success: boolean; error?: string }> {
    if (!username || !homeDir) {
      return { success: false, error: 'username and homeDir required' };
    }

    // Validate username — letters, digits, _ - only (no shell metachars).
    if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(username)) {
      return { success: false, error: 'Invalid username' };
    }

    const exists = await this.userExists(username);
    if (!exists) {
      return { success: false, error: `User "${username}" does not exist` };
    }

    const binDir = `${homeDir}/bin`;
    const bashrcPath = `${homeDir}/.bashrc`;
    const profilePath = `${homeDir}/.profile`;
    const shimMarker = '# meowbox-php-shim';
    const pathExport = `export PATH="$HOME/bin:$PATH" ${shimMarker}`;

    // Имена шимов: { user-facing → suffix }
    const shimMap: Array<{ user: string; sys: string }> = [
      { user: 'php', sys: 'php' },
      { user: 'phpize', sys: 'phpize' },
      { user: 'php-cgi', sys: 'php-cgi' },
      { user: 'php-config', sys: 'php-config' },
      { user: 'pecl', sys: 'pecl' },
      { user: 'phar', sys: 'phar' },
    ];

    try {
      // 1) Гарантируем существование ~/bin (через Node fs — без exec'а)
      await fs.mkdir(binDir, { recursive: true, mode: 0o755 });

      // Получаем uid/gid юзера через `id -u`/`id -g`
      const ids = await this.lookupUserIds(username);
      if (!ids) {
        return { success: false, error: `Failed to resolve uid/gid for ${username}` };
      }

      await fs.chown(binDir, ids.uid, ids.gid).catch(() => {});
      await fs.chmod(binDir, 0o755).catch(() => {});

      // 2) Чистим старые шимы (на случай смены версии)
      for (const { user } of shimMap) {
        await fs.unlink(`${binDir}/${user}`).catch(() => {});
      }

      // 3) Если PHP отключён на сайте — снимаем PATH-инъекцию и выходим
      if (!phpVersion || !phpVersion.trim()) {
        await this.removeShimPathExport(bashrcPath, shimMarker);
        await this.removeShimPathExport(profilePath, shimMarker);
        return { success: true };
      }

      // 4) Валидация PHP-версии (формат XX.YY)
      if (!/^\d+\.\d+$/.test(phpVersion)) {
        return { success: false, error: `Invalid phpVersion: ${phpVersion}` };
      }

      // 5) Проверяем, что нужный php-бинарь установлен
      const phpBin = `/usr/bin/php${phpVersion}`;
      try {
        await fs.access(phpBin, fsConstants.X_OK);
      } catch {
        return { success: false, error: `Binary ${phpBin} not installed or not executable` };
      }

      // 6) Создаём симлинки только для тех бинарей, которые реально установлены
      for (const { user, sys } of shimMap) {
        const target = `/usr/bin/${sys}${phpVersion}`;
        try {
          await fs.access(target, fsConstants.F_OK);
        } catch {
          continue; // нет такого бинаря — скипаем
        }
        const linkPath = `${binDir}/${user}`;
        // На всякий случай удалим, если что-то осталось
        await fs.unlink(linkPath).catch(() => {});
        await fs.symlink(target, linkPath);
        // lchown — меняет владельца самого симлинка, не цели
        await fs.lchown(linkPath, ids.uid, ids.gid).catch(() => {});
      }

      // 7) Добавляем PATH-инъекцию в ~/.bashrc и ~/.profile (идемпотентно)
      await this.ensureShimPathExport(bashrcPath, pathExport, shimMarker, ids);
      await this.ensureShimPathExport(profilePath, pathExport, shimMarker, ids);

      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Резолвит uid/gid юзера через `id`.
   */
  private async lookupUserIds(
    username: string,
  ): Promise<{ uid: number; gid: number } | null> {
    const u = await this.executor.execute('id', ['-u', username], { allowFailure: true });
    const g = await this.executor.execute('id', ['-g', username], { allowFailure: true });
    if (u.exitCode !== 0 || g.exitCode !== 0) return null;
    const uid = parseInt(u.stdout.trim(), 10);
    const gid = parseInt(g.stdout.trim(), 10);
    if (!Number.isFinite(uid) || !Number.isFinite(gid)) return null;
    return { uid, gid };
  }

  /**
   * Идемпотентно добавляет строку с PATH-инъекцией в rc-файл юзера.
   * Если строка уже есть (по маркеру) — не дублирует.
   * Если файла нет — создаёт.
   */
  private async ensureShimPathExport(
    rcPath: string,
    line: string,
    marker: string,
    ids: { uid: number; gid: number },
  ): Promise<void> {
    let existing = '';
    try {
      existing = await fs.readFile(rcPath, 'utf8');
    } catch (err: unknown) {
      // ENOENT — файл просто не существует, создадим
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }

    if (existing.includes(marker)) {
      return; // уже есть
    }

    const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    const next = existing + sep + line + '\n';

    await fs.writeFile(rcPath, next, { mode: 0o644 });
    await fs.chown(rcPath, ids.uid, ids.gid).catch(() => {});
  }

  /**
   * Удаляет строку с маркером шима из rc-файла (in-place перезапись).
   */
  private async removeShimPathExport(rcPath: string, marker: string): Promise<void> {
    let existing = '';
    try {
      existing = await fs.readFile(rcPath, 'utf8');
    } catch {
      return; // нет файла — нечего чистить
    }
    if (!existing.includes(marker)) return;
    const filtered = existing
      .split('\n')
      .filter((l) => !l.includes(marker))
      .join('\n');
    await fs.writeFile(rcPath, filtered);
  }
}
