import { CommandExecutor } from '../command-executor';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { BACKUP_LOCAL_PATH, BACKUP_HOSTS } from '../config';

interface BackupParams {
  backupId: string;
  siteId: string;
  siteName: string;
  rootPath: string;
  type: 'FULL' | 'DIFFERENTIAL' | 'FILES_ONLY' | 'DB_ONLY';
  storageType: 'LOCAL' | 'S3' | 'YANDEX_DISK' | 'CLOUD_MAIL_RU';
  excludePaths: string[];
  storageConfig: Record<string, string>;
  databases?: Array<{ name: string; type: string }>;
  baseTimestamp?: string;
  excludeTableData?: string[];
  keepLocalCopy?: boolean;
}

interface BackupResult {
  success: boolean;
  filePath: string;
  sizeBytes: number;
  error?: string;
}

type ProgressFn = (percent: number) => void;

// Единый источник истины для локального бэкап-хранилища — config.ts.
// `BACKUP_DIR` сохранён как alias, чтобы не переписывать десятки обращений.
const BACKUP_DIR = BACKUP_LOCAL_PATH;

// Имя БД попадает в argv `mysql -u root <db.name>` и в путь к dump-файлу.
// Допускаем только идентификаторы — буквы/цифры/`_`, начинаются с буквы.
// MySQL/MariaDB технически разрешают больше (через backticks), но имена
// сайтов в Meowbox всегда укладываются в ASCII-snake_case.
const RE_DB_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
function assertDbName(name: string): void {
  if (typeof name !== 'string' || !RE_DB_NAME.test(name)) {
    throw new Error(`Invalid database name: ${String(name).slice(0, 64)}`);
  }
}

/**
 * Executes backups: files (tar), databases (mysqldump/pg_dump),
 * then uploads to configured storage (local, Yandex Disk, Cloud Mail.ru).
 */
export class BackupExecutor {
  private executor: CommandExecutor;

  constructor() {
    this.executor = new CommandExecutor();
  }

  async execute(params: BackupParams, onProgress: ProgressFn): Promise<BackupResult> {
    try {
      // Ensure backup dir exists
      await this.executor.execute('mkdir', ['-p', BACKUP_DIR]);

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const typeLabel = params.type === 'DIFFERENTIAL' ? 'diff' : params.type.toLowerCase();
      const archiveName = `${params.siteName}_${typeLabel}_${timestamp}.tar.gz`;
      const archivePath = path.join(BACKUP_DIR, archiveName);

      onProgress(5);

      const tempFiles: string[] = [];

      // Step 1: Dump databases if needed
      if (params.type !== 'FILES_ONLY' && params.databases?.length) {
        for (const db of params.databases) {
          assertDbName(db.name);
          const dumpPath = path.join(BACKUP_DIR, `${db.name}.sql`);
          await this.dumpDatabase(db.name, db.type, dumpPath, params.excludeTableData);
          tempFiles.push(dumpPath);
        }
      }

      onProgress(30);

      // Step 2: Create tar archive
      const newerThan = params.type === 'DIFFERENTIAL' && params.baseTimestamp
        ? params.baseTimestamp : undefined;

      if (params.type === 'DB_ONLY') {
        // Only databases — archive the SQL dumps
        if (tempFiles.length) {
          await this.createArchive(archivePath, tempFiles, BACKUP_DIR, []);
        }
      } else {
        // Files (and optionally DB dumps)
        const allPaths = [params.rootPath, ...tempFiles];
        await this.createArchive(archivePath, allPaths, '/', params.excludePaths, newerThan);
      }

      onProgress(60);

      // Clean up temp SQL dumps
      for (const f of tempFiles) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }

      // Verify archive exists
      if (!fs.existsSync(archivePath)) {
        return { success: false, filePath: '', sizeBytes: 0, error: 'Archive was not created' };
      }

      const stats = fs.statSync(archivePath);
      onProgress(70);

      // Step 3: Upload to storage
      let remotePath = archivePath;

      if (params.storageType === 'YANDEX_DISK') {
        remotePath = await this.uploadToYandexDisk(archivePath, archiveName, params.storageConfig);
        onProgress(95);
        if (!params.keepLocalCopy) {
          try { fs.unlinkSync(archivePath); } catch { /* ignore */ }
        }
      } else if (params.storageType === 'CLOUD_MAIL_RU') {
        remotePath = await this.uploadToCloudMailRu(archivePath, archiveName, params.storageConfig);
        onProgress(95);
        if (!params.keepLocalCopy) {
          try { fs.unlinkSync(archivePath); } catch { /* ignore */ }
        }
      }

      onProgress(100);

      return {
        success: true,
        filePath: remotePath,
        sizeBytes: Number(stats.size),
      };
    } catch (err: unknown) {
      return {
        success: false,
        filePath: '',
        sizeBytes: 0,
        error: (err as Error).message || 'Backup failed',
      };
    }
  }

  async restore(
    params: {
      backupId: string;
      siteId: string;
      siteName: string;
      rootPath: string;
      filePath: string;
      storageType: string;
      storageConfig: Record<string, string>;
      cleanup?: boolean;
      databases?: Array<{ name: string; type: string }>;
      baseFilePath?: string;
      baseStorageType?: string;
      baseStorageConfig?: Record<string, string>;
      scope?: 'FILES_AND_DB' | 'FILES_ONLY' | 'DB_ONLY';
      includePaths?: string[];
    },
    onProgress: ProgressFn,
  ): Promise<{ success: boolean; error?: string }> {
    const scope = params.scope || 'FILES_AND_DB';
    const restoreFiles = scope === 'FILES_AND_DB' || scope === 'FILES_ONLY';
    const restoreDb = scope === 'FILES_AND_DB' || scope === 'DB_ONLY';
    // Жёсткая фильтрация (defense-in-depth — даже если API скомпрометирован).
    // См. подробнее в restic.executor.ts — пустой/dot-only rel вызывает
    // полное копирование корня и обход selective restore.
    const includePaths = (params.includePaths || [])
      .map((p) => String(p || '').trim().replace(/^\.\/+/, '').replace(/\/+$/, ''))
      .filter((p) =>
        p.length > 0
        && p !== '.'
        && !p.includes('..')
        && !p.includes('\0')
        && !p.includes('\\')
        && !p.startsWith('/'),
      );
    try {
      onProgress(5);

      const isDifferential = !!params.baseFilePath;
      const filesToClean: string[] = [];

      // Download diff archive
      let localDiffPath = params.filePath;
      localDiffPath = await this.downloadIfRemote(
        params.filePath, params.storageType, params.storageConfig,
        `restore_diff_${params.backupId}.tar.gz`,
      );
      if (localDiffPath !== params.filePath) filesToClean.push(localDiffPath);

      if (!fs.existsSync(localDiffPath)) {
        return { success: false, error: 'Backup file not found' };
      }

      // Download base archive for differential
      let localBasePath: string | undefined;
      if (isDifferential && params.baseFilePath) {
        localBasePath = await this.downloadIfRemote(
          params.baseFilePath,
          params.baseStorageType || params.storageType,
          params.baseStorageConfig || params.storageConfig,
          `restore_base_${params.backupId}.tar.gz`,
        );
        if (localBasePath !== params.baseFilePath) filesToClean.push(localBasePath);

        if (!fs.existsSync(localBasePath)) {
          return { success: false, error: 'Base backup file not found (required for differential restore)' };
        }
      }

      onProgress(20);

      const tempDir = path.join(BACKUP_DIR, `restore_${params.backupId}`);
      await this.executor.execute('mkdir', ['-p', tempDir]);

      // Параметры tar для restore:
      //   --no-same-owner / --no-same-permissions — не доверяем uid/perms
      //     из архива (бэкап мог быть подменён на скомпрометированном S3).
      //   --no-overwrite-dir — не сменяем атрибуты уже существующих директорий.
      //   -P НЕ передаём — tar по умолчанию режет ведущий `/` и компоненты
      //     `..`, что и нужно.
      const TAR_RESTORE_FLAGS = ['--no-same-owner', '--no-same-permissions', '--no-overwrite-dir'];

      if (isDifferential && localBasePath) {
        // Step 1: Extract base (full) backup
        const r1 = await this.executor.execute('tar', ['-xzf', localBasePath, '-C', tempDir, ...TAR_RESTORE_FLAGS], { timeout: 600_000, allowFailure: true });
        if (r1.exitCode !== 0) {
          return { success: false, error: `Base extract failed: ${r1.stderr}` };
        }
        onProgress(35);

        // Step 2: Extract diff on top — overwrites changed files
        const r2 = await this.executor.execute('tar', ['-xzf', localDiffPath, '-C', tempDir, ...TAR_RESTORE_FLAGS], { timeout: 600_000, allowFailure: true });
        if (r2.exitCode !== 0) {
          return { success: false, error: `Diff extract failed: ${r2.stderr}` };
        }
        onProgress(50);
      } else {
        // Full / FILES_ONLY / DB_ONLY — single extraction
        const extract = await this.executor.execute('tar', ['-xzf', localDiffPath, '-C', tempDir, ...TAR_RESTORE_FLAGS], { timeout: 600_000, allowFailure: true });
        if (extract.exitCode !== 0) {
          return { success: false, error: `Extract failed: ${extract.stderr}` };
        }
        onProgress(50);
      }

      // Защита от symlink/hardlink-attack: после распаковки проходим по
      // tempDir и удаляем все симлинки/хардлинки на файлы вне корня.
      // Архив, подменённый на скомпрометированном WebDAV/S3, мог содержать
      // симлинк `tempDir/etc/passwd → /etc/passwd` — тогда последующий
      // `cp -a tempDir/. /var/www/site` создаст в сайте симлинк, и
      // PHP-скрипт сайта прочитает что захочет. После удаления симлинков
      // restore работает только с реальными файлами из архива.
      this.sanitizeExtractedTree(tempDir);

      // Restore database dumps (from diff archive for DIFFERENTIAL — it has full DB dump)
      if (restoreDb && params.databases?.length) {
        for (const db of params.databases) {
          // Имя БД идёт в argv `mysql ... <name>` и `psql -d <name>` —
          // arg-flag smuggling (`name="-e SELECT..."`) недопустим.
          assertDbName(db.name);
          const dumpFile = path.join(tempDir, `${db.name}.sql`);
          const altDumpFile = path.join(tempDir, 'var', 'meowbox', 'backups', `${db.name}.sql`);
          const actualDump = fs.existsSync(dumpFile) ? dumpFile : fs.existsSync(altDumpFile) ? altDumpFile : null;

          if (actualDump) {
            // Путь собран нами из tempDir (под BACKUP_LOCAL_PATH) + имени БД
            // (имя БД прошло валидацию на уровне API). Но всё равно перестрахуемся:
            // запрещаем метасимволы, проверяем что файл внутри tempDir.
            const safeDump = path.resolve(actualDump);
            if (!/^[A-Za-z0-9_./-]+$/.test(safeDump) || !safeDump.startsWith(tempDir + path.sep)) {
              return { success: false, error: `Invalid dump path: ${actualDump}` };
            }
            if (db.type === 'POSTGRESQL') {
              await this.executor.execute('sudo', ['-u', 'postgres', 'psql', '-d', db.name, '-f', safeDump], { timeout: 600_000 });
            } else {
              const cmd = db.type === 'MARIADB' ? 'mariadb' : 'mysql';
              await this.executor.execute(cmd, ['-u', 'root', db.name, '-e', `source ${safeDump}`], { timeout: 600_000 });
            }
          }
        }
      }

      onProgress(75);

      // Restore files to rootPath
      if (restoreFiles) {
        const extractedRoot = path.join(tempDir, params.rootPath.replace(/^\//, ''));
        if (fs.existsSync(extractedRoot)) {
          if (includePaths.length === 0) {
            // Без selective: весь корень
            if (params.cleanup) {
              await this.executor.execute('rsync', [
                '-a', '--delete',
                `${extractedRoot}/`,
                `${params.rootPath}/`,
              ], { timeout: 300_000 });
            } else {
              await this.executor.execute('cp', ['-a', `${extractedRoot}/.`, params.rootPath], { timeout: 300_000 });
            }
          } else {
            // Selective: только указанные пути первого уровня
            for (const rel of includePaths) {
              const src = path.resolve(extractedRoot, rel);
              const dst = path.resolve(params.rootPath, rel);
              const extRootResolved = path.resolve(extractedRoot);
              const rootResolved = path.resolve(params.rootPath);
              // Strict containment: НЕ равны корню — иначе обход selective.
              if (src === extRootResolved || dst === rootResolved) continue;
              if (!src.startsWith(extRootResolved + path.sep)) continue;
              if (!dst.startsWith(rootResolved + path.sep)) continue;
              if (!fs.existsSync(src)) continue;
              const isDir = fs.statSync(src).isDirectory();
              await this.executor.execute('mkdir', ['-p', path.dirname(dst)], { timeout: 30_000 });
              if (isDir) {
                if (params.cleanup) {
                  await this.executor.execute('rsync', ['-a', '--delete', `${src}/`, `${dst}/`], { timeout: 300_000 });
                } else {
                  await this.executor.execute('rsync', ['-a', `${src}/`, `${dst}/`], { timeout: 300_000 });
                }
              } else {
                await this.executor.execute('cp', ['-a', src, dst], { timeout: 60_000 });
              }
            }
          }
        }
      }

      onProgress(95);

      // Cleanup
      await this.executor.execute('rm', ['-rf', tempDir]);
      for (const f of filesToClean) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }

      onProgress(100);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Рекурсивно проходит по дереву и удаляет все симлинки.
   * Защита от tar-extract-with-symlink атаки: бэкап на ненадёжном
   * хранилище (S3/WebDAV) мог быть подменён, и симлинк в архиве
   * был бы скопирован при последующем `cp -a` в реальную директорию
   * сайта, давая чтение/запись произвольных файлов вне рута.
   *
   * Используем lstat (не stat — иначе симлинки резолвятся), и только
   * lchown/unlink не нужны — нам достаточно unlink самой ссылки.
   */
  private sanitizeExtractedTree(root: string): void {
    const stack: string[] = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isSymbolicLink()) {
          try { fs.unlinkSync(full); } catch { /* best-effort */ }
        } else if (ent.isDirectory()) {
          stack.push(full);
        }
      }
    }
  }

  private async downloadIfRemote(
    filePath: string,
    storageType: string,
    storageConfig: Record<string, string>,
    localName: string,
  ): Promise<string> {
    if (storageType === 'YANDEX_DISK' && filePath.startsWith('yandex-disk:')) {
      const remotePath = filePath.replace('yandex-disk:', '');
      const localPath = path.join(BACKUP_DIR, localName);
      await this.downloadFromYandexDisk(remotePath, localPath, storageConfig);
      return localPath;
    }
    if (storageType === 'CLOUD_MAIL_RU' && filePath.startsWith('cloud-mail-ru:')) {
      const remotePath = filePath.replace('cloud-mail-ru:', '');
      const localPath = path.join(BACKUP_DIR, localName);
      await this.downloadFromCloudMailRu(remotePath, localPath, storageConfig);
      return localPath;
    }
    return filePath;
  }

  private async downloadFromYandexDisk(remotePath: string, localPath: string, config: Record<string, string>): Promise<void> {
    const oauthToken = config.oauthToken;
    if (!oauthToken) throw new Error('Yandex Disk OAuth token required');

    const response = await this.yandexDiskRequest(
      'GET',
      `/v1/disk/resources/download?path=${encodeURIComponent(remotePath)}`,
      oauthToken,
    );
    const data = JSON.parse(response) as { href?: string };
    if (!data.href) throw new Error('Failed to get download URL');

    await this.downloadFileFromUrl(data.href, localPath);
  }

  private async downloadFromCloudMailRu(remotePath: string, localPath: string, config: Record<string, string>): Promise<void> {
    const { username, password } = config;
    if (!username || !password) throw new Error('Cloud Mail.ru credentials required');
    await this.webdavDownloadFile(remotePath, localPath, username, password, BACKUP_HOSTS.CLOUD_MAILRU_WEBDAV);
  }

  /**
   * Скачивание файла по URL с явной проверкой HTTP статуса и аккуратной
   * очисткой ресурсов на ошибках. Раньше любой не-2xx ответ (HTML 401/500
   * с auth-прокси) писался как «бэкап» — потом restore падал на повреждённом
   * файле без понятной причины.
   */
  private downloadFileFromUrl(url: string, localPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stream: fs.WriteStream | null = null;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        if (stream) {
          stream.destroy();
          fs.promises.unlink(localPath).catch(() => { /* best-effort */ });
        }
        reject(err);
      };
      const urlObj = new URL(url);
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
      }, (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume(); // drain to free socket
          fail(new Error(`Download HTTP ${res.statusCode || '???'}`));
          return;
        }
        stream = fs.createWriteStream(localPath);
        stream.on('error', (err) => fail(err));
        res.on('error', (err) => fail(err));
        res.pipe(stream);
        stream.on('finish', () => {
          if (settled) return;
          settled = true;
          stream!.close();
          resolve();
        });
      });
      req.on('error', (err) => fail(err));
      req.setTimeout(600000, () => { req.destroy(new Error('Download timeout')); });
      req.end();
    });
  }

  private webdavDownloadFile(remotePath: string, localPath: string, username: string, password: string, hostname: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stream: fs.WriteStream | null = null;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        if (stream) {
          stream.destroy();
          fs.promises.unlink(localPath).catch(() => { /* best-effort */ });
        }
        reject(err);
      };
      const auth = Buffer.from(`${username}:${password}`).toString('base64');
      const req = https.request({
        hostname,
        path: remotePath,
        method: 'GET',
        headers: { 'Authorization': `Basic ${auth}` },
      }, (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          fail(new Error(`WebDAV download HTTP ${res.statusCode || '???'}`));
          return;
        }
        stream = fs.createWriteStream(localPath);
        stream.on('error', (err) => fail(err));
        res.on('error', (err) => fail(err));
        res.pipe(stream);
        stream.on('finish', () => {
          if (settled) return;
          settled = true;
          stream!.close();
          resolve();
        });
      });
      req.on('error', (err) => fail(err));
      req.setTimeout(600000, () => { req.destroy(new Error('Download timeout')); });
      req.end();
    });
  }

  // ===========================================================================
  // Database dumps
  // ===========================================================================

  private async dumpDatabase(
    name: string,
    type: string,
    outputPath: string,
    excludeTableData?: string[],
  ): Promise<void> {
    const excluded = excludeTableData?.length ? excludeTableData : [];

    if (type === 'POSTGRESQL') {
      const args = ['-U', 'postgres', '-Fp', '-f', outputPath];
      for (const table of excluded) {
        args.push(`--exclude-table-data=${table}`);
      }
      args.push(name);

      const result = await this.executor.execute('pg_dump', args, { timeout: 600_000, allowFailure: true });
      if (result.exitCode !== 0) {
        throw new Error(`Database dump failed for ${name}: ${result.stderr}`);
      }
    } else {
      // MariaDB / MySQL
      const cmd = type === 'MARIADB' ? 'mariadb-dump' : 'mysqldump';

      if (excluded.length > 0) {
        // Pass 1: full dump except excluded tables
        const args1 = [
          '-u', 'root',
          '--single-transaction', '--quick', '--routines', '--triggers',
        ];
        for (const table of excluded) {
          args1.push(`--ignore-table=${name}.${table}`);
        }
        args1.push(`--result-file=${outputPath}`, name);

        const r1 = await this.executor.execute(cmd, args1, { timeout: 600_000, allowFailure: true });
        if (r1.exitCode !== 0) {
          throw new Error(`Database dump failed for ${name}: ${r1.stderr}`);
        }

        // Pass 2: schema-only for excluded tables (append)
        const args2 = ['-u', 'root', '--no-data', name, ...excluded];
        const r2 = await this.executor.execute(cmd, args2, { timeout: 600_000, allowFailure: true });
        if (r2.exitCode !== 0) {
          throw new Error(`Schema dump failed for ${name}: ${r2.stderr}`);
        }
        // Append schema-only output to the dump file
        fs.appendFileSync(outputPath, r2.stdout);
      } else {
        // No exclusions — single pass
        const args = [
          '-u', 'root',
          '--single-transaction', '--quick', '--routines', '--triggers',
          `--result-file=${outputPath}`, name,
        ];
        const result = await this.executor.execute(cmd, args, { timeout: 600_000, allowFailure: true });
        if (result.exitCode !== 0) {
          throw new Error(`Database dump failed for ${name}: ${result.stderr}`);
        }
      }
    }
  }

  // ===========================================================================
  // Archive creation
  // ===========================================================================

  private async createArchive(
    archivePath: string,
    paths: string[],
    basePath: string,
    excludePaths: string[],
    newerThan?: string,
  ): Promise<void> {
    const args = ['-czf', archivePath, '-C', basePath];

    if (newerThan) {
      args.push(`--newer-mtime=${newerThan}`);
    }

    // Excludes — только то, что задал юзер. Жёстких "common excludes" больше нет:
    // подконтрольность важнее «удобных дефолтов» (юзер требовал явность).
    for (const ep of excludePaths) {
      args.push(`--exclude=${ep}`);
    }

    for (const p of paths) {
      // Make paths relative to basePath
      const relative = path.relative(basePath, p) || p;
      args.push(relative);
    }

    const result = await this.executor.execute('tar', args, { timeout: 600_000, allowFailure: true });

    if (result.exitCode !== 0) {
      throw new Error(`Archive creation failed: ${result.stderr}`);
    }
  }

  // ===========================================================================
  // Yandex Disk (WebDAV API)
  // ===========================================================================

  private async uploadToYandexDisk(
    filePath: string,
    fileName: string,
    config: Record<string, string>,
  ): Promise<string> {
    const oauthToken = config.oauthToken;
    if (!oauthToken) {
      throw new Error('Yandex Disk OAuth token is required');
    }

    const remoteFolderPath = config.remotePath || BACKUP_HOSTS.REMOTE_ROOT;
    const remoteFilePath = `${remoteFolderPath}/${fileName}`;

    // Step 1: Create folder if needed
    await this.yandexDiskRequest('PUT', `/v1/disk/resources?path=${encodeURIComponent(remoteFolderPath)}`, oauthToken);

    // Step 2: Get upload URL
    const uploadUrl = await this.yandexDiskGetUploadUrl(remoteFilePath, oauthToken);

    // Step 3: Upload file
    await this.uploadFileToUrl(uploadUrl, filePath);

    return `yandex-disk:${remoteFilePath}`;
  }

  private yandexDiskRequest(method: string, path: string, token: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: BACKUP_HOSTS.YANDEX_DISK_API,
        path,
        method,
        headers: {
          'Authorization': `OAuth ${token}`,
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
      });

      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(new Error('Timeout')); });
      req.end();
    });
  }

  private async yandexDiskGetUploadUrl(remotePath: string, token: string): Promise<string> {
    const response = await this.yandexDiskRequest(
      'GET',
      `/v1/disk/resources/upload?path=${encodeURIComponent(remotePath)}&overwrite=true`,
      token,
    );

    const data = JSON.parse(response) as { href?: string };
    if (!data.href) {
      throw new Error('Failed to get Yandex Disk upload URL');
    }

    return data.href;
  }

  // ===========================================================================
  // Cloud Mail.ru (WebDAV)
  // ===========================================================================

  private async uploadToCloudMailRu(
    filePath: string,
    fileName: string,
    config: Record<string, string>,
  ): Promise<string> {
    const username = config.username;
    const password = config.password; // App-specific password
    if (!username || !password) {
      throw new Error('Cloud Mail.ru username and app-password are required');
    }

    const remoteFolderPath = config.remotePath || BACKUP_HOSTS.REMOTE_ROOT;
    const remoteFilePath = `${remoteFolderPath}/${fileName}`;

    // Cloud Mail.ru supports WebDAV at webdav.cloud.mail.ru
    // Step 1: Create directory
    await this.webdavRequest('MKCOL', remoteFilePath.replace(`/${fileName}`, ''), username, password, BACKUP_HOSTS.CLOUD_MAILRU_WEBDAV);

    // Step 2: Upload file via WebDAV PUT
    await this.webdavUploadFile(remoteFilePath, filePath, username, password, BACKUP_HOSTS.CLOUD_MAILRU_WEBDAV);

    return `cloud-mail-ru:${remoteFilePath}`;
  }

  private webdavRequest(
    method: string,
    remotePath: string,
    username: string,
    password: string,
    hostname: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const auth = Buffer.from(`${username}:${password}`).toString('base64');

      const req = https.request({
        hostname,
        path: remotePath,
        method,
        headers: {
          'Authorization': `Basic ${auth}`,
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
      });

      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(new Error('Timeout')); });
      req.end();
    });
  }

  private webdavUploadFile(
    remotePath: string,
    localPath: string,
    username: string,
    password: string,
    hostname: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const auth = Buffer.from(`${username}:${password}`).toString('base64');
      const fileStream = fs.createReadStream(localPath);
      const stats = fs.statSync(localPath);

      const req = https.request({
        hostname,
        path: remotePath,
        method: 'PUT',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Length': stats.size,
          'Content-Type': 'application/octet-stream',
        },
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed with status ${res.statusCode}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(600000, () => { req.destroy(new Error('Upload timeout')); });
      fileStream.pipe(req);
    });
  }

  // ===========================================================================
  // Remote delete (Yandex Disk + Cloud Mail.ru)
  // ===========================================================================

  /**
   * Удаляет ранее загруженный бэкап в облаке. Маршрутизатор по префиксу
   * в filePath: `yandex-disk:/PATH` или `cloud-mail-ru:/PATH`.
   * Ошибка сети/404 не бросается наружу — возвращает {success:false, error}.
   */
  async deleteRemoteBackup(
    filePath: string,
    storageConfig: Record<string, string>,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (filePath.startsWith('yandex-disk:')) {
        const remotePath = filePath.replace(/^yandex-disk:/, '');
        return await this.deleteFromYandexDisk(remotePath, storageConfig);
      }
      if (filePath.startsWith('cloud-mail-ru:')) {
        const remotePath = filePath.replace(/^cloud-mail-ru:/, '');
        return await this.deleteFromCloudMailRu(remotePath, storageConfig);
      }
      return { success: false, error: `Unknown remote prefix: ${filePath.substring(0, 20)}` };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  private deleteFromYandexDisk(
    remotePath: string,
    config: Record<string, string>,
  ): Promise<{ success: boolean; error?: string }> {
    const token = config.oauthToken;
    if (!token) {
      return Promise.resolve({ success: false, error: 'Yandex Disk OAuth token missing' });
    }
    return new Promise((resolve) => {
      const req = https.request({
        hostname: BACKUP_HOSTS.YANDEX_DISK_API,
        path: `/v1/disk/resources?path=${encodeURIComponent(remotePath)}&permanently=true`,
        method: 'DELETE',
        headers: { 'Authorization': `OAuth ${token}` },
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          const code = res.statusCode || 0;
          // 204 No Content — удалено; 202 Accepted — async delete (очередь);
          // 404 — уже нет (считаем успехом, бэкапа и так нет).
          if (code === 204 || code === 202 || code === 404) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: `Yandex Disk DELETE ${code}: ${body.substring(0, 200)}` });
          }
        });
      });
      req.on('error', (err) => resolve({ success: false, error: err.message }));
      req.setTimeout(30_000, () => { req.destroy(new Error('Yandex Disk delete timeout')); });
      req.end();
    });
  }

  private deleteFromCloudMailRu(
    remotePath: string,
    config: Record<string, string>,
  ): Promise<{ success: boolean; error?: string }> {
    const username = config.username;
    const password = config.password;
    if (!username || !password) {
      return Promise.resolve({ success: false, error: 'Cloud Mail.ru credentials missing' });
    }
    return new Promise((resolve) => {
      const auth = Buffer.from(`${username}:${password}`).toString('base64');
      const req = https.request({
        hostname: BACKUP_HOSTS.CLOUD_MAILRU_WEBDAV,
        path: remotePath,
        method: 'DELETE',
        headers: { 'Authorization': `Basic ${auth}` },
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          const code = res.statusCode || 0;
          // WebDAV: 204 No Content; 404 — уже нет.
          if ((code >= 200 && code < 300) || code === 404) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: `WebDAV DELETE ${code}: ${body.substring(0, 200)}` });
          }
        });
      });
      req.on('error', (err) => resolve({ success: false, error: err.message }));
      req.setTimeout(30_000, () => { req.destroy(new Error('WebDAV delete timeout')); });
      req.end();
    });
  }

  // ===========================================================================
  // Generic file upload
  // ===========================================================================

  private uploadFileToUrl(uploadUrl: string, filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(uploadUrl);
      // Допускаем только https (upload-эндпоинты облаков). Локальный http
      // — потенциальный SSRF на внутренние сервисы.
      if (url.protocol !== 'https:') {
        return reject(new Error(`Unsupported upload protocol: ${url.protocol}`));
      }
      const protocol = https;
      const fileStream = fs.createReadStream(filePath);
      const stats = fs.statSync(filePath);

      const req = protocol.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'PUT',
        headers: {
          'Content-Length': stats.size,
          'Content-Type': 'application/gzip',
        },
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed with status ${res.statusCode}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(600000, () => { req.destroy(new Error('Upload timeout')); });
      fileStream.pipe(req);
    });
  }
}
