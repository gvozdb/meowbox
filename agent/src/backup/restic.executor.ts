import { CommandExecutor } from '../command-executor';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { BACKUP_LOCAL_PATH, S3_DEFAULTS, BACKUP_S3, RESTIC_OPS } from '../config';
import { childProcessRegistry } from '../process-registry';

// Strict allowlist для имён БД — попадает в argv `mysql ... <name>` и
// `psql -d <name>`. Защищает от arg-flag smuggling в случае некорректных
// данных от API.
const RE_DB_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
function assertDbName(name: string): void {
  if (typeof name !== 'string' || !RE_DB_NAME.test(name)) {
    throw new Error(`Invalid database name: ${String(name).slice(0, 64)}`);
  }
}

// =============================================================================
// ResticExecutor — обёртка над `restic` для backup/restore/forget/snapshots.
//
// Архитектура:
//   - Репа = (StorageLocation, Site). Название репо-URL собирается по типу:
//       LOCAL →  `<BACKUP_LOCAL_PATH>/restic/<siteName>`
//       S3    →  `s3:<endpoint>/<bucket>/meowbox/<siteName>`
//   - Пароль репы передаётся через env `RESTIC_PASSWORD`.
//   - S3-креды: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (env).
//   - Все снапшоты сайта имеют тег `site:<siteName>` — так их можно
//     фильтровать в `snapshots --tag` и `forget --tag`.
//   - При бэкапе дамп БД сохраняется во временный файл + добавляется как
//     отдельный путь (restic не читает stdin для нескольких источников).
//
// Ограничения:
//   - Поддерживаемые storageType: LOCAL, S3 (остальные — только TAR).
//   - Репа инициализируется лениво при первом бэкапе (init → если пустая).
// =============================================================================

export interface ResticStorage {
  type: 'LOCAL' | 'S3' | 'SFTP';
  // Поля по типу:
  //   LOCAL: remotePath
  //   S3:    bucket, endpoint, region, accessKey, secretKey, prefix
  //   SFTP:  sftpHost, sftpPort, sftpUsername, sftpPath, sftpPrivateKey,
  //          sftpPassphrase (opt), sftpHostKey (opt — SHA256 fingerprint)
  config: Record<string, string>;
  password: string;
}

export interface ResticBackupParams {
  siteName: string;
  rootPath: string;
  excludePaths: string[];
  databases?: Array<{ name: string; type: string }>;
  excludeTableData?: string[];
  // FULL/FILES_ONLY/DB_ONLY — управляет тем, что включено в снапшот
  type: 'FULL' | 'FILES_ONLY' | 'DB_ONLY';
  storage: ResticStorage;
}

export interface ResticSnapshot {
  id: string;
  short_id: string;
  time: string;
  hostname: string;
  paths: string[];
  tags?: string[];
  summary?: {
    files_new?: number;
    files_changed?: number;
    files_unmodified?: number;
    data_added?: number;
    total_bytes_processed?: number;
  };
}

export interface RetentionPolicy {
  keepDaily?: number;
  keepWeekly?: number;
  keepMonthly?: number;
  keepYearly?: number;
}

type ProgressFn = (percent: number) => void;

export class ResticExecutor {
  private executor: CommandExecutor;

  constructor() {
    this.executor = new CommandExecutor();
  }

  // ---------------------------------------------------------------------------
  // Сборка repo-URL и env
  // ---------------------------------------------------------------------------

  private buildRepoUrl(siteName: string, storage: ResticStorage): string {
    // Валидация siteName (только безопасные символы — используется в путях)
    if (!/^[a-zA-Z0-9_-]+$/.test(siteName)) {
      throw new Error(`Invalid siteName for restic repo: ${siteName}`);
    }

    if (storage.type === 'LOCAL') {
      const base = storage.config.remotePath || path.join(BACKUP_LOCAL_PATH, 'restic');
      return path.join(base, siteName);
    }

    if (storage.type === 'S3') {
      const { bucket, endpoint, prefix } = storage.config;
      if (!bucket) throw new Error('S3 bucket is required');
      // endpoint может быть: https://s3.amazonaws.com (AWS), https://storage.yandexcloud.net, etc.
      const ep = endpoint || S3_DEFAULTS.ENDPOINT;
      const pfx = (prefix || S3_DEFAULTS.PREFIX).replace(/^\/+|\/+$/g, '');
      return `s3:${ep}/${bucket}/${pfx}/${siteName}`;
    }

    if (storage.type === 'SFTP') {
      const { sftpHost, sftpUsername, sftpPath } = storage.config;
      if (!sftpHost || !sftpUsername || !sftpPath) {
        throw new Error('SFTP host/username/path are required');
      }
      // Базовые проверки (defense-in-depth поверх API-валидации)
      if (!/^[a-zA-Z0-9.\-]+$/.test(sftpHost)) {
        throw new Error('Invalid sftpHost');
      }
      if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/.test(sftpUsername)) {
        throw new Error('Invalid sftpUsername');
      }
      if (!sftpPath.startsWith('/') || sftpPath.includes('..') || /\s/.test(sftpPath)) {
        throw new Error('Invalid sftpPath');
      }
      // restic SFTP URL: sftp:user@host:/abs/path/<siteName>
      // Порт прописывается в sftp.command (см. buildResticOpts).
      const base = sftpPath.replace(/\/+$/, '');
      return `sftp:${sftpUsername}@${sftpHost}:${base}/${siteName}`;
    }

    throw new Error(`Unsupported storage type for restic: ${storage.type}`);
  }

  private buildEnv(storage: ResticStorage): Record<string, string> {
    const env: Record<string, string> = {
      RESTIC_PASSWORD: storage.password,
    };
    if (storage.type === 'S3') {
      const { accessKey, secretKey, region } = storage.config;
      if (!accessKey || !secretKey) {
        throw new Error('S3 accessKey/secretKey are required');
      }
      env.AWS_ACCESS_KEY_ID = accessKey;
      env.AWS_SECRET_ACCESS_KEY = secretKey;
      if (region) env.AWS_DEFAULT_REGION = region;
    }
    if (storage.type === 'LOCAL') {
      // Убедиться, что локальная директория существует
      const base = storage.config.remotePath || path.join(BACKUP_LOCAL_PATH, 'restic');
      try { fs.mkdirSync(base, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
    }
    if (storage.type === 'SFTP') {
      const { sftpAuthMode, sftpPassword } = storage.config;
      // sshpass читает пароль из ENV SSHPASS (флаг -e). Это безопаснее, чем
      // -p <pwd> в командной строке (видно в `ps -ef`).
      // Дочерний sshpass-процесс наследует env от restic, который у нас тут.
      if (sftpAuthMode === 'PASSWORD') {
        if (!sftpPassword) throw new Error('SFTP password is required (auth mode = PASSWORD)');
        env.SSHPASS = sftpPassword;
      }
    }
    return env;
  }

  // ---------------------------------------------------------------------------
  // SFTP-specific: пишем приватный ключ на диск (0600) и возвращаем путь.
  // Имя файла = sha256(privateKey) → ключ переиспользуется между вызовами,
  // и idempotent — рестарты агента и concurrent restic-процессы безопасны.
  //
  // /var/lib/meowbox/restic-sftp-keys/ создаётся как 0700 (только root).
  //
  // Stale keys (если оператор удалил StorageLocation) НЕ чистим автоматически —
  // занятая запись на диске — мелкая утечка, не критично; cleanup можно
  // добавить отдельным cron'ом если разрастётся.
  // ---------------------------------------------------------------------------
  private static readonly SFTP_KEYS_DIR = '/var/lib/meowbox/restic-sftp-keys';

  private ensureSftpKeyFile(privateKey: string): string {
    const dir = ResticExecutor.SFTP_KEYS_DIR;
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
    // Жёстко 0700 — даже если кто-то уже создал директорию ранее
    try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
    const sha = createHash('sha256').update(privateKey).digest('hex').slice(0, 32);
    const file = path.join(dir, `${sha}.key`);
    if (!fs.existsSync(file)) {
      // OpenSSH/PEM ключи требуют trailing newline для корректного парсинга
      const body = privateKey.endsWith('\n') ? privateKey : privateKey + '\n';
      fs.writeFileSync(file, body, { mode: 0o600 });
    } else {
      try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
    }
    return file;
  }

  /**
   * Restic args, специфичные для backend'а (например, -o sftp.command=...).
   * Возвращает массив, который добавляется к `-r repo` в каждом restic-вызове.
   */
  private buildBackendOpts(storage: ResticStorage): string[] {
    if (storage.type !== 'SFTP') return [];
    const {
      sftpHost, sftpPort, sftpUsername, sftpPrivateKey, sftpHostKey,
      sftpAuthMode, sftpPassword,
    } = storage.config;
    const port = sftpPort && /^\d+$/.test(sftpPort) ? sftpPort : '22';
    const mode = sftpAuthMode === 'PASSWORD' ? 'PASSWORD' : 'KEY';

    // UserKnownHostsFile per-storage (sha от стабильного идентификатора —
    // host+user+port, т.к. ключ может отсутствовать в PASSWORD-режиме).
    const idHash = createHash('sha256')
      .update(`${sftpUsername}@${sftpHost}:${port}`)
      .digest('hex').slice(0, 16);
    const knownHostsFile = path.join(ResticExecutor.SFTP_KEYS_DIR, `${idHash}.known_hosts`);
    try { fs.mkdirSync(ResticExecutor.SFTP_KEYS_DIR, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }

    if (sftpHostKey && /^SHA256:[A-Za-z0-9+/=]+$/.test(sftpHostKey) && !fs.existsSync(knownHostsFile)) {
      // TODO: записать через ssh-keyscan + верифицировать fingerprint.
      // Пока fallback на accept-new (TOFU).
    }
    void sftpHostKey;

    if (mode === 'KEY') {
      if (!sftpPrivateKey) throw new Error('SFTP privateKey is required (auth mode = KEY)');
      const keyFile = this.ensureSftpKeyFile(sftpPrivateKey);
      // BatchMode=yes — не запрашивать пароль интерактивно (только key-auth).
      const sshCmd = [
        'ssh',
        '-i', keyFile,
        '-p', port,
        '-o', 'BatchMode=yes',
        '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', `UserKnownHostsFile=${knownHostsFile}`,
        '-o', 'ConnectTimeout=15',
        '-o', 'ServerAliveInterval=30',
        `${sftpUsername}@${sftpHost}`,
        '-s', 'sftp',
      ].join(' ');
      return ['-o', `sftp.command=${sshCmd}`];
    }

    // PASSWORD mode: sshpass -e ssh ...  (читает пароль из env SSHPASS,
    // который выставляет buildEnv).
    if (!sftpPassword) throw new Error('SFTP password is required (auth mode = PASSWORD)');
    const sshCmd = [
      'sshpass', '-e',
      'ssh',
      '-p', port,
      '-o', 'PreferredAuthentications=password,keyboard-interactive',
      '-o', 'PubkeyAuthentication=no',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${knownHostsFile}`,
      '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=30',
      `${sftpUsername}@${sftpHost}`,
      '-s', 'sftp',
    ].join(' ');
    return ['-o', `sftp.command=${sshCmd}`];
  }

  /**
   * Унифицированная сборка `[-r repo, ...backend-opts]` для всех restic-команд.
   */
  private buildResticBaseArgs(siteName: string, storage: ResticStorage): string[] {
    const repo = this.buildRepoUrl(siteName, storage);
    return ['-r', repo, ...this.buildBackendOpts(storage)];
  }

  // ---------------------------------------------------------------------------
  // Init (идемпотентно — если уже init, возвращаем success)
  // ---------------------------------------------------------------------------

  async ensureRepoInit(
    siteName: string,
    storage: ResticStorage,
  ): Promise<{ success: boolean; error?: string }> {
    const base = this.buildResticBaseArgs(siteName, storage);
    const env = this.buildEnv(storage);

    // Проверка: snapshots --json требует инициализированную репу; exit 0 → есть
    const check = await this.executor.execute(
      'restic',
      [...base, 'snapshots', '--json', '--no-lock'],
      { env, timeout: 30_000, allowFailure: true },
    );

    if (check.exitCode === 0) {
      return { success: true };
    }

    // Если репа не инициализирована — restic печатает "unable to open config file" или "does not exist"
    const notInit =
      /config file does not exist|unable to open config file|Is there a repository at the following location|wrong password|not contain a repository/i.test(
        check.stderr,
      );
    if (!notInit && check.stderr.includes('wrong password')) {
      return { success: false, error: 'Неверный пароль репозитория Restic' };
    }

    // Инициализируем
    const init = await this.executor.execute(
      'restic',
      [...base, 'init'],
      { env, timeout: 60_000, allowFailure: true },
    );
    if (init.exitCode !== 0) {
      return {
        success: false,
        error: `restic init failed: ${init.stderr.substring(0, 500)}`,
      };
    }
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Backup
  // ---------------------------------------------------------------------------

  async backup(
    params: ResticBackupParams,
    onProgress: ProgressFn,
  ): Promise<{
    success: boolean;
    snapshotId?: string;
    sizeBytes?: number;
    error?: string;
  }> {
    const { siteName, rootPath, excludePaths, storage, databases, type, excludeTableData } = params;

    try {
      onProgress(5);

      // 1. Ensure репо
      const ensure = await this.ensureRepoInit(siteName, storage);
      if (!ensure.success) {
        return { success: false, error: ensure.error };
      }

      const base = this.buildResticBaseArgs(siteName, storage);
      const env = this.buildEnv(storage);

      onProgress(10);

      // 2. Дамп БД (если нужно) → tmp-файлы, они тоже попадут в снапшот
      const tempFiles: string[] = [];
      const tmpDbDir = path.join(BACKUP_LOCAL_PATH, 'restic-tmp', siteName);
      if (type !== 'FILES_ONLY' && databases?.length) {
        fs.mkdirSync(tmpDbDir, { recursive: true, mode: 0o700 });
        for (const db of databases) {
          assertDbName(db.name);
          const dumpPath = path.join(tmpDbDir, `${db.name}.sql`);
          await this.dumpDatabase(db.name, db.type, dumpPath, excludeTableData);
          tempFiles.push(dumpPath);
        }
      }

      onProgress(25);

      // 3. Формируем список путей для backup
      const paths: string[] = [];
      if (type !== 'DB_ONLY') paths.push(rootPath);
      paths.push(...tempFiles);

      if (paths.length === 0) {
        return { success: false, error: 'Нет путей для бэкапа' };
      }

      // 4. Запускаем restic backup с тегом сайта и --json для прогресса
      const args = [
        ...base,
        'backup',
        '--tag', `site:${siteName}`,
        '--json',
      ];
      // Excludes — только то, что задал юзер. Жёстких "common excludes" больше нет:
      // подконтрольность важнее «удобных дефолтов».
      for (const ex of excludePaths) {
        args.push('--exclude', ex);
      }
      args.push(...paths);

      let snapshotId: string | undefined;
      let totalBytes = 0;

      // Прогресс из JSON: { message_type: "status", percent_done: 0.42 }
      // Завершение:       { message_type: "summary", snapshot_id: "...", total_bytes_processed: N }
      const result = await this.runResticStreaming(args, env, (line, stream) => {
        if (stream !== 'stdout') return;
        try {
          const msg = JSON.parse(line) as {
            message_type?: string;
            percent_done?: number;
            snapshot_id?: string;
            total_bytes_processed?: number;
          };
          if (msg.message_type === 'status' && typeof msg.percent_done === 'number') {
            // 25..90 — прогресс backup-процесса
            onProgress(25 + Math.round(msg.percent_done * 65));
          } else if (msg.message_type === 'summary') {
            if (msg.snapshot_id) snapshotId = msg.snapshot_id;
            if (msg.total_bytes_processed) totalBytes = msg.total_bytes_processed;
          }
        } catch {
          /* не JSON (rare) — игнорируем */
        }
      });

      // 5. Cleanup tmp db dumps
      for (const f of tempFiles) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
      try { fs.rmdirSync(tmpDbDir); } catch { /* ignore */ }

      if (result.exitCode !== 0) {
        return {
          success: false,
          error: `restic backup failed: ${result.stderr.substring(0, 500)}`,
        };
      }

      onProgress(95);

      // Если snapshotId не пришёл из summary — fallback: latest snapshot с нашим тегом
      if (!snapshotId) {
        const latest = await this.executor.execute(
          'restic',
          [...base, 'snapshots', '--json', '--tag', `site:${siteName}`, '--latest', '1'],
          { env, timeout: 30_000, allowFailure: true },
        );
        if (latest.exitCode === 0) {
          try {
            const arr = JSON.parse(latest.stdout) as ResticSnapshot[];
            if (arr.length > 0) snapshotId = arr[arr.length - 1].id;
          } catch { /* ignore */ }
        }
      }

      onProgress(100);
      return {
        success: true,
        snapshotId,
        sizeBytes: totalBytes,
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // Snapshots list
  // ---------------------------------------------------------------------------

  async listSnapshots(
    siteName: string,
    storage: ResticStorage,
  ): Promise<{ success: boolean; snapshots?: ResticSnapshot[]; error?: string }> {
    try {
      const ensure = await this.ensureRepoInit(siteName, storage);
      if (!ensure.success) {
        return { success: false, error: ensure.error };
      }
      const base = this.buildResticBaseArgs(siteName, storage);
      const env = this.buildEnv(storage);

      const r = await this.executor.execute(
        'restic',
        [...base, 'snapshots', '--json', '--tag', `site:${siteName}`],
        { env, timeout: 60_000, allowFailure: true },
      );
      if (r.exitCode !== 0) {
        return { success: false, error: r.stderr.substring(0, 500) };
      }
      const snapshots = JSON.parse(r.stdout) as ResticSnapshot[];
      return { success: true, snapshots };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // Restore
  // ---------------------------------------------------------------------------

  async restore(params: {
    siteName: string;
    snapshotId: string;
    rootPath: string;
    cleanup?: boolean; // чистое восстановление
    databases?: Array<{ name: string; type: string }>;
    storage: ResticStorage;
    // scope: FILES_AND_DB | FILES_ONLY | DB_ONLY (по умолчанию FILES_AND_DB)
    scope?: 'FILES_AND_DB' | 'FILES_ONLY' | 'DB_ONLY';
    // selective list (относительные от rootPath). Пусто/undefined — всё.
    // Применяется только если scope включает FILES.
    includePaths?: string[];
  }, onProgress: ProgressFn): Promise<{ success: boolean; error?: string }> {
    const { siteName, snapshotId, rootPath, cleanup, databases, storage } = params;
    const scope = params.scope || 'FILES_AND_DB';
    const restoreFiles = scope === 'FILES_AND_DB' || scope === 'FILES_ONLY';
    const restoreDb = scope === 'FILES_AND_DB' || scope === 'DB_ONLY';
    // Жёсткая фильтрация (defense-in-depth — даже если API скомпрометирован).
    // Отсечь dot-only/empty/абсолютные/null-byte/backslash/'..'  — иначе пустой
    // rel вызовет копирование ВСЕГО extractedRoot и обойдёт selective restore.
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
      const base = this.buildResticBaseArgs(siteName, storage);
      const env = this.buildEnv(storage);

      onProgress(5);

      // 1. Восстанавливаем в temp-директорию (снапшот содержит rootPath + tmp/*.sql)
      const restoreTemp = path.join(BACKUP_LOCAL_PATH, `restic-restore-${Date.now()}`);
      fs.mkdirSync(restoreTemp, { recursive: true, mode: 0o700 });

      const result = await this.executor.execute(
        'restic',
        [...base, 'restore', snapshotId, '--target', restoreTemp],
        { env, timeout: 1800_000, allowFailure: true }, // 30 минут
      );

      if (result.exitCode !== 0) {
        await this.executor.execute('rm', ['-rf', restoreTemp]);
        return { success: false, error: `restic restore failed: ${result.stderr.substring(0, 500)}` };
      }

      onProgress(50);

      // 2. Восстанавливаем БД из .sql дампов (если есть в снапшоте)
      if (restoreDb) {
        const dbTmpPath = path.join(restoreTemp, BACKUP_LOCAL_PATH, 'restic-tmp', siteName).replace(/\/+/g, '/');
        if (databases?.length) {
          for (const db of databases) {
            assertDbName(db.name);
            const dumpFile = path.join(dbTmpPath, `${db.name}.sql`);
            if (!fs.existsSync(dumpFile)) continue;

            // Защита: путь должен быть внутри restoreTemp
            const safeDump = path.resolve(dumpFile);
            if (!/^[A-Za-z0-9_./-]+$/.test(safeDump) || !safeDump.startsWith(restoreTemp + path.sep)) {
              continue;
            }

            if (db.type === 'POSTGRESQL') {
              await this.executor.execute('sudo', ['-u', 'postgres', 'psql', '-d', db.name, '-f', safeDump], { timeout: 600_000, allowFailure: true });
            } else {
              const cmd = db.type === 'MARIADB' ? 'mariadb' : 'mysql';
              await this.executor.execute(cmd, ['-u', 'root', db.name, '-e', `source ${safeDump}`], { timeout: 600_000, allowFailure: true });
            }
          }
        }
      }

      onProgress(70);

      // 3. Восстанавливаем файлы сайта (тот сегмент дерева, что был rootPath)
      if (restoreFiles) {
        const extractedRoot = path.join(restoreTemp, rootPath.replace(/^\//, ''));
        if (fs.existsSync(extractedRoot)) {
          if (includePaths.length === 0) {
            // Без selective: весь корень
            if (cleanup) {
              await this.executor.execute('rsync', [
                '-a', '--delete',
                `${extractedRoot}/`,
                `${rootPath}/`,
              ], { timeout: 600_000, allowFailure: true });
            } else {
              await this.executor.execute('cp', ['-a', `${extractedRoot}/.`, rootPath], { timeout: 600_000, allowFailure: true });
            }
          } else {
            // Selective: только указанные пути первого уровня (и дальше).
            // Каждый путь rsync'им/cp'им отдельно из extractedRoot/<rel> в rootPath/<rel>.
            for (const rel of includePaths) {
              const src = path.resolve(extractedRoot, rel);
              const dst = path.resolve(rootPath, rel);
              const extRootResolved = path.resolve(extractedRoot);
              const rootResolved = path.resolve(rootPath);
              // Защита от traversal: src/dst ДОЛЖНЫ быть СТРОГО ВНУТРИ корней
              // (НЕ равны корню — иначе selective скопирует весь rootPath
              // и --delete снесёт всё лишнее).
              if (src === extRootResolved || dst === rootResolved) continue;
              if (!src.startsWith(extRootResolved + path.sep)) continue;
              if (!dst.startsWith(rootResolved + path.sep)) continue;
              if (!fs.existsSync(src)) continue;
              const isDir = fs.statSync(src).isDirectory();
              // Гарантируем что родительская директория цели существует
              await this.executor.execute('mkdir', ['-p', path.dirname(dst)], { timeout: 30_000 });
              if (isDir) {
                if (cleanup) {
                  await this.executor.execute('rsync', ['-a', '--delete', `${src}/`, `${dst}/`], { timeout: 600_000, allowFailure: true });
                } else {
                  await this.executor.execute('rsync', ['-a', `${src}/`, `${dst}/`], { timeout: 600_000, allowFailure: true });
                }
              } else {
                await this.executor.execute('cp', ['-a', src, dst], { timeout: 60_000 });
              }
            }
          }
        }
      }

      onProgress(95);

      await this.executor.execute('rm', ['-rf', restoreTemp]);

      onProgress(100);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // Export-to-S3 — restic dump --archive tar | upload в exports/<id>.tar
  // Используется для скачивания бэкапа с pre-signed URL (без записи на диск VPS).
  // Только для S3-хранилищ.
  // ---------------------------------------------------------------------------

  async dumpToS3(params: {
    siteName: string;
    snapshotId: string;
    rootPath: string;
    storage: ResticStorage;
    targetKey: string;
  }, onProgress?: (p: { bytesRead: number; bytesUploaded: number; elapsedMs: number }) => void): Promise<{ success: boolean; error?: string; sizeBytes?: number }> {
    if (params.storage.type !== 'S3') {
      return { success: false, error: 'dump-to-s3 поддерживает только S3-хранилища' };
    }
    if (!/^[a-fA-F0-9]{6,64}$/.test(params.snapshotId)) {
      return { success: false, error: 'Некорректный snapshotId' };
    }
    if (!/^exports\/[a-zA-Z0-9._-]+\.tar$/.test(params.targetKey)) {
      return { success: false, error: 'Некорректный targetKey' };
    }

    try {
      console.log(`[restic.dumpToS3] start: site=${params.siteName} snap=${params.snapshotId.slice(0,8)} key=${params.targetKey}`);

      // Проверяем доступность S3 SDK ленивой загрузкой — модуль может
      // отсутствовать в старых сборках агента, но работать без него.
      const sdk: typeof import('@aws-sdk/client-s3') = require('@aws-sdk/client-s3');
      const { S3Client, PutObjectCommand } = sdk;
      let UploadCtor: typeof import('@aws-sdk/lib-storage').Upload | undefined;
      try {
        const libStorage: typeof import('@aws-sdk/lib-storage') = require('@aws-sdk/lib-storage');
        UploadCtor = libStorage.Upload;
        console.log('[restic.dumpToS3] @aws-sdk/lib-storage loaded — will use multipart upload');
      } catch (e) {
        console.warn(`[restic.dumpToS3] @aws-sdk/lib-storage missing: ${(e as Error).message}`);
      }

      const cfg = params.storage.config;
      const bucket = cfg.bucket;
      if (!bucket) return { success: false, error: 'S3 bucket не задан' };
      const region = cfg.region || S3_DEFAULTS.REGION;
      const isCustomEndpoint = !!cfg.endpoint && !/amazonaws\.com/i.test(cfg.endpoint);

      const client = new S3Client({
        region,
        endpoint: cfg.endpoint || undefined,
        forcePathStyle: isCustomEndpoint,
        credentials: {
          accessKeyId: cfg.accessKey || '',
          secretAccessKey: cfg.secretKey || '',
        },
      });

      // Спавним restic dump --archive tar.
      // env изолированно: только PATH/HOME/LANG + restic-специфичные креды.
      // Не пробрасываем весь process.env — снижаем риск утечки секретов
      // агента (AGENT_SECRET и т.п.) в /proc/<pid>/environ дочернего restic'а.
      const baseArgs = this.buildResticBaseArgs(params.siteName, params.storage);
      const env: Record<string, string> = {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        LANG: process.env.LANG || 'C',
        ...this.buildEnv(params.storage),
      };
      console.log(`[restic.dumpToS3] spawning restic dump: repo=${baseArgs[1]}`);
      // -o s3.connections=32 — параллельные коннекты к S3 backend.
      // Узкое место restic dump = TTFB на каждый range-запрос pack-блобов.
      // Прямой curl показал 8MB/s от S3 firstvds, restic dump — 100KB/s.
      // Подняли с 5 (default) до 32 для перекрытия RTT-задержек множеством
      // параллельных запросов. Память не страдает — connections дешёвые.
      const isS3Repo = params.storage.type === 'S3';
      const proc = spawn('restic', [
        ...baseArgs,
        ...(isS3Repo ? ['-o', 's3.connections=32'] : []),
        'dump', params.snapshotId,
        params.rootPath,
        '--archive', 'tar',
      ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      // Регистрируем в реестре — на shutdown агента registry убьёт
      // restic SIGTERM'ом, чтобы не оставлять зомби-процессы.
      const procHandle = childProcessRegistry.track(
        proc,
        `restic-dump-to-s3:${params.targetKey.slice(0, 40)}`,
      );

      let stderrBuf = '';
      proc.stderr.on('data', (d) => {
        const s = d.toString();
        stderrBuf += s;
        if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
        // Логируем stderr restic'а сразу — чтобы видеть проблемы в реальном времени
        console.log(`[restic.dumpToS3] restic stderr: ${s.trim()}`);
      });

      // uploadedBytes объявлен ниже, но heartbeat читает его — поэтому
      // объявляем тут как closure-переменную.
      let uploadedBytes = 0;

      // Heartbeat: каждые 30s логируем сколько прочитано из stdout — чтобы
      // видеть жив ли pipe (зависший SDK не даст прогресса, и мы поймём это).
      let lastReadBytes = 0;
      let totalReadBytes = 0;
      const startedAt = Date.now();
      proc.stdout.on('data', (chunk: Buffer) => { totalReadBytes += chunk.length; });
      const heartbeat = setInterval(() => {
        const delta = totalReadBytes - lastReadBytes;
        const intervalSec = Math.max(1, Math.round(BACKUP_S3.HEARTBEAT_MS / 1000));
        console.log(
          `[restic.dumpToS3] heartbeat: read=${Math.round(totalReadBytes / 1024 / 1024)}MB (+${Math.round(delta / 1024 / 1024)}MB/${intervalSec}s), uploaded=${Math.round(uploadedBytes / 1024 / 1024)}MB`,
        );
        lastReadBytes = totalReadBytes;
      }, BACKUP_S3.HEARTBEAT_MS);

      // Прогресс-эмиттер каждые 5s — отдельный интервал, чтобы heartbeat-лог не дёргать чаще,
      // а UI не лагал. onProgress передаёт байты обратно к API → in-memory map для polling из UI.
      const progressTick = setInterval(() => {
        if (!onProgress) return;
        try {
          onProgress({
            bytesRead: totalReadBytes,
            bytesUploaded: uploadedBytes,
            elapsedMs: Date.now() - startedAt,
          });
        } catch {
          /* не валим dump из-за ошибки в emit'е */
        }
      }, 5000);

      // CRITICAL: всё, что после setInterval, заворачиваем в try/finally —
      // ранее три ветки (upload.done() failure, FALLBACK_MAX_BYTES, исключение
      // в outer catch) выходили мимо clearInterval(heartbeat) и оставляли
      // навечно живой setInterval, спамящий console каждые 30s.
      try {
        // Multipart upload через @aws-sdk/lib-storage (если доступен) — он сам
        // разруливает back-pressure и ретраи. Иначе — простой PutObject со
        // сборкой в Buffer, что нормально только для маленьких бэкапов.
        if (UploadCtor) {
          console.log(`[restic.dumpToS3] starting multipart upload to ${bucket}/${params.targetKey}`);
          const upload = new UploadCtor({
            client,
            params: {
              Bucket: bucket,
              Key: params.targetKey,
              Body: proc.stdout,
              ContentType: 'application/x-tar',
            },
            // partSize/queueSize конфигурируются через env (BACKUP_S3_PART_SIZE_BYTES,
            // BACKUP_S3_QUEUE_SIZE) — поднимать на быстрых каналах, опускать
            // на слабых VPS.
            partSize: BACKUP_S3.PART_SIZE_BYTES,
            queueSize: BACKUP_S3.QUEUE_SIZE,
          });
          upload.on('httpUploadProgress', (p) => {
            if (typeof p.loaded === 'number') {
              uploadedBytes = p.loaded;
              // Логируем прогресс каждые ~50MB чтобы видеть что не висит
              if (Math.floor(p.loaded / (50 * 1024 * 1024)) > Math.floor((uploadedBytes - (p.part || 1) * 1024 * 1024) / (50 * 1024 * 1024))) {
                console.log(`[restic.dumpToS3] uploaded ~${Math.round(p.loaded / 1024 / 1024)}MB`);
              }
            }
          });
          try {
            await upload.done();
            console.log(`[restic.dumpToS3] upload complete: ${uploadedBytes} bytes`);
          } catch (uErr) {
            console.error(`[restic.dumpToS3] upload failed: ${(uErr as Error).message}`);
            if (!proc.killed) try { proc.kill('SIGTERM'); } catch { /* ignore */ }
            return { success: false, error: `S3 upload failed: ${(uErr as Error).message}` };
          }
        } else {
          // Fallback: накапливаем в память. Для больших бэкапов плохо —
          // в проде установлен lib-storage. Этот путь подстрахует.
          const chunks: Buffer[] = [];
          let total = 0;
          for await (const chunk of proc.stdout) {
            chunks.push(chunk as Buffer);
            total += (chunk as Buffer).length;
            if (total > BACKUP_S3.FALLBACK_MAX_BYTES) {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              return {
                success: false,
                error: `lib-storage отсутствует — fallback-ветка ограничена ${Math.round(BACKUP_S3.FALLBACK_MAX_BYTES / 1024 / 1024)}MB`,
              };
            }
          }
          const body = Buffer.concat(chunks);
          await client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: params.targetKey,
            Body: body,
            ContentType: 'application/x-tar',
          }));
          uploadedBytes = total;
        }

        // Ждём завершения процесса restic. Если завершился с ошибкой — это уже
        // после успешного upload-а, странно но возможно (ошибка в самом конце
        // потока). Сообщаем об ошибке, но объект остаётся (оператор может
        // удалить через API).
        const exit: number = await new Promise((resolve) => {
          if (proc.exitCode !== null) resolve(proc.exitCode);
          else proc.on('exit', (code) => resolve(code ?? 1));
        });
        if (exit !== 0) {
          return {
            success: false,
            error: `restic dump exit ${exit}: ${stderrBuf.slice(0, 500)}`,
            sizeBytes: uploadedBytes,
          };
        }

        return { success: true, sizeBytes: uploadedBytes };
      } finally {
        clearInterval(heartbeat);
        clearInterval(progressTick);
        // Снимаем с реестра — process.on('exit') уже это делает,
        // но явный untrack защищает от race при упавшем upload (когда
        // proc не завершился, а мы ушли).
        procHandle.untrack();
        // Если процесс жив — добиваем его, чтобы не оставлять зомби.
        if (proc.exitCode === null && !proc.killed) {
          try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        }
      }
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // Listing tree (для UI selective restore — первый уровень rootPath)
  // ---------------------------------------------------------------------------

  /**
   * Возвращает листинг первого уровня rootPath внутри снапшота: имя, тип, размер.
   * Размер для директорий — сумма размеров всех файлов внутри (агрегируется здесь).
   * Используется для UI диалога восстановления с чекбоксами.
   */
  async listTopLevel(params: {
    siteName: string;
    snapshotId: string;
    rootPath: string;
    storage: ResticStorage;
  }): Promise<{
    success: boolean;
    error?: string;
    items?: Array<{ name: string; type: 'dir' | 'file'; size: number }>;
  }> {
    try {
      const { siteName, snapshotId, rootPath, storage } = params;
      const base = this.buildResticBaseArgs(siteName, storage);
      const env = this.buildEnv(storage);

      // restic ls --long --json --recursive — NDJSON листинг рекурсивно.
      // БЕЗ --recursive restic ls показывает только прямое содержимое
      // директории (файлы первого уровня, без вложенных), и тогда размеры
      // папок не агрегируются — они остаются 0. С --recursive получаем
      // ВСЕ файлы внутри rootPath, и наш агрегатор корректно суммирует.
      //
      // Стримим через executeStreaming с discardOutputBuffer:true, парсим NDJSON
      // построчно в onLine — иначе на больших репах stdout > 10 MB и execFile
      // падает с "stdout maxBuffer length exceeded".
      const rootPrefix = rootPath.replace(/\/+$/, '');
      // Map от имени первого уровня к { type, size }. type определяется по записи самого первого уровня.
      const byTop = new Map<string, { type: 'dir' | 'file'; size: number }>();

      const result = await this.executor.executeStreaming(
        'restic',
        [...base, 'ls', '--long', '--json', '--recursive', snapshotId, rootPath],
        {
          env,
          timeout: RESTIC_OPS.LS_TIMEOUT_MS,
          discardOutputBuffer: true,
          onLine: (line, stream) => {
            if (stream !== 'stdout') return;
            if (!line.trim()) return;
            let obj: { name?: string; type?: string; path?: string; size?: number };
            try { obj = JSON.parse(line); } catch { return; }
            // Snapshot-метадата идёт первой строкой (там нет path/name) — пропускаем.
            if (!obj.path || typeof obj.path !== 'string') return;
            if (!obj.name || typeof obj.name !== 'string') return;
            if (!obj.path.startsWith(rootPrefix + '/')) return;
            const rel = obj.path.slice(rootPrefix.length + 1);
            if (!rel) return;
            const top = rel.split('/')[0];
            if (!top) return;
            const isThisLevel = !rel.includes('/');
            const fileSize = typeof obj.size === 'number' ? obj.size : 0;
            const isFile = obj.type === 'file';
            const existing = byTop.get(top);
            if (isThisLevel) {
              const t = obj.type === 'dir' ? 'dir' : 'file';
              byTop.set(top, {
                type: t,
                size: (existing?.size || 0) + (t === 'file' ? fileSize : 0),
              });
            } else {
              if (!existing) {
                byTop.set(top, { type: 'dir', size: isFile ? fileSize : 0 });
              } else if (isFile) {
                existing.size += fileSize;
              }
            }
          },
        },
      );
      if (result.exitCode !== 0) {
        return { success: false, error: `restic ls failed: ${result.stderr.substring(0, 500)}` };
      }

      const items = Array.from(byTop.entries())
        .map(([name, v]) => ({ name, type: v.type, size: v.size }))
        .sort((a, b) => {
          // папки сначала, потом по имени
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      return { success: true, items };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // Forget / Prune (retention)
  // ---------------------------------------------------------------------------

  async forget(
    siteName: string,
    storage: ResticStorage,
    policy: RetentionPolicy,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const base = this.buildResticBaseArgs(siteName, storage);
      const env = this.buildEnv(storage);

      const args = [...base, 'forget', '--tag', `site:${siteName}`, '--prune'];
      const beforeKeepLen = args.length;
      if (policy.keepDaily) args.push('--keep-daily', String(policy.keepDaily));
      if (policy.keepWeekly) args.push('--keep-weekly', String(policy.keepWeekly));
      if (policy.keepMonthly) args.push('--keep-monthly', String(policy.keepMonthly));
      if (policy.keepYearly) args.push('--keep-yearly', String(policy.keepYearly));

      // Если ни одного keep-* не задано — не запускаем, иначе restic удалит всё.
      if (args.length === beforeKeepLen) {
        return { success: true };
      }

      const r = await this.executor.execute('restic', args, { env, timeout: 600_000, allowFailure: true });
      if (r.exitCode !== 0) {
        return { success: false, error: r.stderr.substring(0, 500) };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // Delete single snapshot
  // ---------------------------------------------------------------------------

  async deleteSnapshot(
    siteName: string,
    snapshotId: string,
    storage: ResticStorage,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const base = this.buildResticBaseArgs(siteName, storage);
      const env = this.buildEnv(storage);
      if (!/^[a-f0-9]+$/i.test(snapshotId)) {
        return { success: false, error: 'Invalid snapshot id' };
      }

      const r = await this.executor.execute(
        'restic',
        [...base, 'forget', snapshotId, '--prune'],
        { env, timeout: 600_000, allowFailure: true },
      );
      if (r.exitCode !== 0) {
        return { success: false, error: r.stderr.substring(0, 500) };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // Test connection / check
  // ---------------------------------------------------------------------------

  async testConnection(
    siteName: string,
    storage: ResticStorage,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Используем init-ensure: если репы нет, будет init; если есть — snapshots ok.
      const ensure = await this.ensureRepoInit(siteName, storage);
      return ensure;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // Check (verify repo integrity)
  //
  // `restic check` — обход структуры репы, проверка индексов и pack-файлов.
  // `--read-data` — читает и хэширует каждый pack (медленно и дорого по трафику).
  // `--read-data-subset=N%` — читает только часть (для S3/remote — экономит).
  //
  // По умолчанию запускаем без --read-data: только структурная проверка.
  // Подробный режим с subset включается отдельным флагом в scheduler.
  // ---------------------------------------------------------------------------

  async check(
    siteName: string,
    storage: ResticStorage,
    opts?: { readData?: boolean; readDataSubset?: string },
  ): Promise<{ success: boolean; output?: string; error?: string; durationMs: number }> {
    const start = Date.now();
    try {
      // Если репы нет — нечего проверять: считаем не-ошибкой, но success=false.
      // ensureRepoInit создаст пустую репу — тогда check пройдёт (по факту пустая).
      // Решаем проще: не зовём ensureRepoInit, а делаем сразу check — если репы нет,
      // `restic check` выдаст ошибку, которую мы и вернём.
      const base = this.buildResticBaseArgs(siteName, storage);
      const env = this.buildEnv(storage);

      const args = [...base, 'check'];
      if (opts?.readData) {
        if (opts.readDataSubset && /^\d{1,3}%?$/.test(opts.readDataSubset)) {
          args.push(`--read-data-subset=${opts.readDataSubset}`);
        } else {
          args.push('--read-data');
        }
      }

      // RESTIC_CHECK_TIMEOUT_MS — для огромных реп можно увеличить.
      const r = await this.executor.execute('restic', args, { env, timeout: RESTIC_OPS.CHECK_TIMEOUT_MS, allowFailure: true });
      const durationMs = Date.now() - start;

      if (r.exitCode === 0) {
        return { success: true, output: r.stdout.substring(0, 4000), durationMs };
      }
      return {
        success: false,
        error: (r.stderr || r.stdout || '').substring(0, 2000) || `restic check exit=${r.exitCode}`,
        output: r.stdout.substring(0, 4000),
        durationMs,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        durationMs: Date.now() - start,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers: streaming + DB dump (дубликат из BackupExecutor — shared helper мог
  // бы быть, но чтобы не трогать TAR — делаю локально)
  // ---------------------------------------------------------------------------

  private async runResticStreaming(
    args: string[],
    env: Record<string, string>,
    onLine: (line: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      // Изоляция env: только PATH (чтобы найти restic) + restic-специфика.
      // НЕ пробрасываем весь process.env, иначе AGENT_SECRET и др. попадут
      // в /proc/<pid>/environ дочернего restic'а.
      const child = spawn('restic', args, {
        env: {
          PATH: process.env.PATH || '',
          HOME: process.env.HOME || '',
          ...env,
          LC_ALL: 'C',
          LANG: 'C',
        },
      });
      // Трекаем в реестре: shutdown агента прибьёт всех восставших.
      // Метка короткая — берём первый осмысленный аргумент (subcommand).
      const subcmd = args.find(
        (a) => !a.startsWith('-') && !/^[A-Za-z0-9+/=:._-]{20,}$/.test(a),
      ) || 'restic';
      const procHandle = childProcessRegistry.track(child, `restic-stream:${subcmd}`);

      let stdoutBuf = '';
      let stderrBuf = '';
      let stdoutTail = '';
      let stderrTail = '';

      const flush = (chunk: string, tail: string, kind: 'stdout' | 'stderr'): string => {
        const combined = tail + chunk;
        const lines = combined.split('\n');
        const newTail = lines.pop() || '';
        for (const raw of lines) {
          const line = raw.replace(/\r$/, '').trim();
          if (line) onLine(line, kind);
        }
        return newTail;
      };

      child.stdout.on('data', (chunk: Buffer) => {
        const s = chunk.toString('utf8');
        stdoutBuf += s;
        stdoutTail = flush(s, stdoutTail, 'stdout');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const s = chunk.toString('utf8');
        stderrBuf += s;
        stderrTail = flush(s, stderrTail, 'stderr');
      });

      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, RESTIC_OPS.CHECK_TIMEOUT_MS);

      child.on('error', () => {
        clearTimeout(timer);
        procHandle.untrack();
        resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode: 1 });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        procHandle.untrack();
        resolve({
          stdout: stdoutBuf,
          stderr: stderrBuf,
          exitCode: typeof code === 'number' ? code : 1,
        });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Diff: snapshot ↔ snapshot, snapshot ↔ live files
  // ---------------------------------------------------------------------------

  /**
   * Diff между двумя снапшотами одного сайта/репы.
   * Использует `restic diff --json snapA snapB` — поток JSON-событий по файлам:
   *   {"message_type":"change","path":"/...","modifier":"+|-|M|T|U"}
   *   modifier: + добавлен, - удалён, M изменён, T тип изменился, U umask
   *   {"message_type":"statistics", ...}
   *
   * Возвращает плоский список изменений (агрегированный) + статистика.
   * Для файлов с modifier='M' вызывающий может потом запросить content-diff
   * через diffFileBetweenSnapshots().
   */
  async diffSnapshots(params: {
    siteName: string;
    storage: ResticStorage;
    snapshotIdA: string;
    snapshotIdB: string;
  }): Promise<{
    success: boolean;
    error?: string;
    items?: Array<{ path: string; modifier: string }>;
    stats?: {
      changedFiles: number;
      addedFiles: number;
      removedFiles: number;
      addedBytes: number;
      removedBytes: number;
    };
  }> {
    try {
      const { siteName, storage, snapshotIdA, snapshotIdB } = params;
      if (!/^[a-f0-9]+$/i.test(snapshotIdA) || !/^[a-f0-9]+$/i.test(snapshotIdB)) {
        return { success: false, error: 'Invalid snapshot id' };
      }
      const base = this.buildResticBaseArgs(siteName, storage);
      const env = this.buildEnv(storage);

      const r = await this.executor.execute(
        'restic',
        [...base, 'diff', '--json', snapshotIdA, snapshotIdB],
        { env, timeout: RESTIC_OPS.LS_TIMEOUT_MS, allowFailure: true },
      );
      if (r.exitCode !== 0) {
        return { success: false, error: `restic diff failed: ${r.stderr.substring(0, 500)}` };
      }

      const items: Array<{ path: string; modifier: string }> = [];
      let stats = {
        changedFiles: 0,
        addedFiles: 0,
        removedFiles: 0,
        addedBytes: 0,
        removedBytes: 0,
      };

      for (const line of r.stdout.split('\n')) {
        if (!line.trim()) continue;
        let obj: {
          message_type?: string;
          path?: string;
          modifier?: string;
          changed_files?: number;
          added?: { files?: number; bytes?: number };
          removed?: { files?: number; bytes?: number };
        };
        try { obj = JSON.parse(line); } catch { continue; }

        if (obj.message_type === 'change' && obj.path && obj.modifier) {
          items.push({ path: obj.path, modifier: obj.modifier });
        } else if (obj.message_type === 'statistics') {
          stats = {
            changedFiles: obj.changed_files || 0,
            addedFiles: obj.added?.files || 0,
            removedFiles: obj.removed?.files || 0,
            addedBytes: obj.added?.bytes || 0,
            removedBytes: obj.removed?.bytes || 0,
          };
        }
      }

      return { success: true, items, stats };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Diff: снапшот vs текущие live-файлы сайта.
   * Делаем рекурсивный обход: тянем `restic ls --recursive --long --json` по
   * указанному rootPath снапшота, сравниваем с реальной ФС по {liveRoot}/{rel}.
   *
   * Алгоритм:
   *   1) Собираем мапу snapshot {relPath → {type, size}} из restic ls.
   *   2) Идём по реальной ФС (rsync-like walker) — считаем live-файлы.
   *   3) Сравниваем:
   *        - есть в снапе, нет вживую → '-'
   *        - нет в снапе, есть вживую → '+'
   *        - размер отличается → 'M' (более глубокое сравнение по размеру/mtime)
   *        - совпадает по размеру → пропускаем (файлы скорее всего идентичны)
   *
   * Это быстрая эвристика. Для точного content-diff конкретного файла →
   * diffFileWithLive().
   */
  async diffSnapshotWithLive(params: {
    siteName: string;
    storage: ResticStorage;
    snapshotId: string;
    snapshotRoot: string; // путь внутри снапа, относительно которого diff
    liveRoot: string;     // соответствующий путь в реальной ФС
  }): Promise<{
    success: boolean;
    error?: string;
    items?: Array<{ path: string; modifier: string }>;
    stats?: {
      changedFiles: number;
      addedFiles: number;
      removedFiles: number;
    };
  }> {
    try {
      const { siteName, storage, snapshotId, snapshotRoot, liveRoot } = params;
      if (!/^[a-f0-9]+$/i.test(snapshotId)) {
        return { success: false, error: 'Invalid snapshot id' };
      }
      // Безопасность: liveRoot — должен быть под SITES_BASE (валидируем по фикс. префиксу).
      // restic dump на бэк не пишет, но live-walker читает реальные файлы — паранойя
      // защищает от случайного '/etc' от баги выше по стеку.
      if (!liveRoot.startsWith('/') || liveRoot.includes('..')) {
        return { success: false, error: 'Invalid liveRoot' };
      }

      const base = this.buildResticBaseArgs(siteName, storage);
      const env = this.buildEnv(storage);

      // 1) Снапшот → мапа. Стримим NDJSON, чтоб не упереться в maxBuffer.
      const snapPrefix = snapshotRoot.replace(/\/+$/, '');
      const snapMap = new Map<string, { type: 'file' | 'dir'; size: number }>();
      const ls = await this.executor.executeStreaming(
        'restic',
        [...base, 'ls', '--long', '--json', '--recursive', snapshotId, snapshotRoot],
        {
          env,
          timeout: RESTIC_OPS.LS_TIMEOUT_MS,
          discardOutputBuffer: true,
          onLine: (line, stream) => {
            if (stream !== 'stdout') return;
            if (!line.trim()) return;
            let obj: { name?: string; type?: string; path?: string; size?: number };
            try { obj = JSON.parse(line); } catch { return; }
            if (!obj.path || !obj.path.startsWith(snapPrefix + '/')) return;
            const rel = obj.path.slice(snapPrefix.length + 1);
            if (!rel) return;
            if (obj.type !== 'file' && obj.type !== 'dir') return;
            snapMap.set(rel, {
              type: obj.type as 'file' | 'dir',
              size: typeof obj.size === 'number' ? obj.size : 0,
            });
          },
        },
      );
      if (ls.exitCode !== 0) {
        return { success: false, error: `restic ls failed: ${ls.stderr.substring(0, 500)}` };
      }

      // 2) Live → мапа.
      const liveMap = new Map<string, { type: 'file' | 'dir'; size: number }>();
      const walk = async (absDir: string, relDir: string): Promise<void> => {
        let entries: fs.Dirent[];
        try {
          entries = await fs.promises.readdir(absDir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const abs = path.join(absDir, e.name);
          const rel = relDir ? `${relDir}/${e.name}` : e.name;
          if (e.isDirectory()) {
            liveMap.set(rel, { type: 'dir', size: 0 });
            await walk(abs, rel);
          } else if (e.isFile()) {
            try {
              const st = await fs.promises.stat(abs);
              liveMap.set(rel, { type: 'file', size: st.size });
            } catch {
              /* skip — может быть удалён в гонке */
            }
          }
          // симлинки/прочее игнорируем — restic их тоже не сравнивает корректно с ФС
        }
      };
      try {
        await walk(liveRoot, '');
      } catch (err) {
        return { success: false, error: `live walk failed: ${(err as Error).message}` };
      }

      // 3) Сравнение.
      const items: Array<{ path: string; modifier: string }> = [];
      let changedFiles = 0;
      let addedFiles = 0;
      let removedFiles = 0;

      // a) что есть в снапе но нет вживую → '-' (удалён)
      for (const [rel, snapVal] of snapMap) {
        const liveVal = liveMap.get(rel);
        if (!liveVal) {
          items.push({ path: rel, modifier: '-' });
          if (snapVal.type === 'file') removedFiles++;
        } else if (snapVal.type === 'file' && liveVal.type === 'file') {
          // разный размер → M (грубая эвристика)
          if (snapVal.size !== liveVal.size) {
            items.push({ path: rel, modifier: 'M' });
            changedFiles++;
          }
          // одинаковый размер — мы НЕ читаем содержимое (дорого);
          // если юзер захочет content-diff — diffFileWithLive() для конкретного файла
        } else if (snapVal.type !== liveVal.type) {
          items.push({ path: rel, modifier: 'T' });
        }
      }

      // b) что есть вживую но нет в снапе → '+' (добавлен)
      for (const [rel, liveVal] of liveMap) {
        if (!snapMap.has(rel)) {
          items.push({ path: rel, modifier: '+' });
          if (liveVal.type === 'file') addedFiles++;
        }
      }

      // Сортируем: изменённые/добавленные/удалённые по алфавиту.
      items.sort((a, b) => a.path.localeCompare(b.path));

      return {
        success: true,
        items,
        stats: { changedFiles, addedFiles, removedFiles },
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Текстовый diff конкретного файла между двумя снапшотами.
   * - Тянет содержимое обоих через `restic dump <snap> <path>` в tmp-файлы.
   * - Если хотя бы один — бинарный (NUL внутри первых 8KB) → отдаём { binary: true }.
   * - Иначе зовём `diff -u` и возвращаем unified-diff.
   * - Лимит размера файла — 2 МБ (защита от загрузки гигабайтного дампа в RAM).
   */
  async diffFileBetweenSnapshots(params: {
    siteName: string;
    storage: ResticStorage;
    snapshotIdA: string;
    snapshotIdB: string;
    filePath: string;
  }): Promise<{
    success: boolean;
    error?: string;
    binary?: boolean;
    sizeA?: number;
    sizeB?: number;
    unifiedDiff?: string;
    truncated?: boolean;
  }> {
    const { siteName, storage, snapshotIdA, snapshotIdB, filePath } = params;
    if (!/^[a-f0-9]+$/i.test(snapshotIdA) || !/^[a-f0-9]+$/i.test(snapshotIdB)) {
      return { success: false, error: 'Invalid snapshot id' };
    }

    const tmpA = await this.makeTempFile('restic-diff-a-');
    const tmpB = await this.makeTempFile('restic-diff-b-');
    try {
      await this.dumpToFile(siteName, storage, snapshotIdA, filePath, tmpA);
      await this.dumpToFile(siteName, storage, snapshotIdB, filePath, tmpB);
      return await this.computeUnifiedDiff(tmpA, tmpB);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    } finally {
      await fs.promises.unlink(tmpA).catch(() => {});
      await fs.promises.unlink(tmpB).catch(() => {});
    }
  }

  /**
   * Текстовый diff: версия из снапа vs текущий live-файл.
   * filePath — путь внутри снапа (абсолютный, так как restic так хранит);
   * livePath — реальный путь на ФС.
   */
  async diffFileWithLive(params: {
    siteName: string;
    storage: ResticStorage;
    snapshotId: string;
    snapshotFilePath: string;
    livePath: string;
  }): Promise<{
    success: boolean;
    error?: string;
    binary?: boolean;
    sizeA?: number;
    sizeB?: number;
    unifiedDiff?: string;
    truncated?: boolean;
  }> {
    const { siteName, storage, snapshotId, snapshotFilePath, livePath } = params;
    if (!/^[a-f0-9]+$/i.test(snapshotId)) {
      return { success: false, error: 'Invalid snapshot id' };
    }
    if (!livePath.startsWith('/') || livePath.includes('..')) {
      return { success: false, error: 'Invalid livePath' };
    }

    const tmpSnap = await this.makeTempFile('restic-diff-snap-');
    try {
      await this.dumpToFile(siteName, storage, snapshotId, snapshotFilePath, tmpSnap);

      // live может не существовать — это валидный кейс ("файл удалён локально")
      let liveExists = true;
      try {
        await fs.promises.access(livePath, fs.constants.F_OK);
      } catch {
        liveExists = false;
      }

      if (!liveExists) {
        const stA = await fs.promises.stat(tmpSnap);
        return {
          success: true,
          binary: false,
          sizeA: stA.size,
          sizeB: 0,
          unifiedDiff: `--- ${snapshotFilePath} (snapshot)\n+++ ${livePath} (live, missing)\n@@ file removed live @@\n`,
        };
      }

      return await this.computeUnifiedDiff(tmpSnap, livePath);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    } finally {
      await fs.promises.unlink(tmpSnap).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Diff helpers
  // ---------------------------------------------------------------------------

  private static readonly DIFF_MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB

  private async makeTempFile(prefix: string): Promise<string> {
    const name = `${prefix}${randomBytes(8).toString('hex')}`;
    return path.join(os.tmpdir(), name);
  }

  /**
   * Стримит `restic dump <snap> <path>` в файл, ограничивая размер.
   * Если файл больше DIFF_MAX_FILE_BYTES — обрезается, и помечается truncated.
   */
  private async dumpToFile(
    siteName: string,
    storage: ResticStorage,
    snapshotId: string,
    filePath: string,
    outputPath: string,
  ): Promise<{ truncated: boolean; size: number }> {
    const base = this.buildResticBaseArgs(siteName, storage);
    const env = this.buildEnv(storage);

    return new Promise((resolve, reject) => {
      const child = spawn('restic', [...base, 'dump', snapshotId, filePath], {
        env: {
          PATH: process.env.PATH || '',
          HOME: process.env.HOME || '',
          ...env,
          LC_ALL: 'C',
          LANG: 'C',
        },
      });
      const procHandle = childProcessRegistry.track(child, `restic-dump:${snapshotId.substring(0, 8)}`);

      const out = fs.createWriteStream(outputPath, { flags: 'w', mode: 0o600 });
      let written = 0;
      let truncated = false;
      let stderrBuf = '';

      child.stdout.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const remaining = ResticExecutor.DIFF_MAX_FILE_BYTES - written;
        if (remaining <= 0) {
          truncated = true;
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
          return;
        }
        if (chunk.length > remaining) {
          out.write(chunk.subarray(0, remaining));
          written += remaining;
          truncated = true;
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
        } else {
          out.write(chunk);
          written += chunk.length;
        }
      });
      child.stderr.on('data', (c: Buffer) => { stderrBuf += c.toString('utf8'); });

      const finalize = (code: number | null) => {
        out.end(() => {
          procHandle.untrack();
          if (truncated || code === 0) {
            resolve({ truncated, size: written });
          } else {
            reject(new Error(`restic dump exit=${code}: ${stderrBuf.substring(0, 500)}`));
          }
        });
      };
      child.on('error', (err) => {
        procHandle.untrack();
        out.end();
        reject(err);
      });
      child.on('close', finalize);

      // hard timeout — 60s на дамп одного файла должно хватать
      setTimeout(() => {
        if (!child.killed) {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, 60_000);
    });
  }

  /**
   * Запускает `diff -u a b`. Перед этим определяет binary (NUL в первых 8KB)
   * и ограничивает по размеру.
   */
  private async computeUnifiedDiff(
    pathA: string,
    pathB: string,
  ): Promise<{
    success: boolean;
    binary?: boolean;
    sizeA?: number;
    sizeB?: number;
    unifiedDiff?: string;
    truncated?: boolean;
    error?: string;
  }> {
    const stA = await fs.promises.stat(pathA).catch(() => null);
    const stB = await fs.promises.stat(pathB).catch(() => null);
    const sizeA = stA?.size || 0;
    const sizeB = stB?.size || 0;

    const truncated =
      sizeA >= ResticExecutor.DIFF_MAX_FILE_BYTES ||
      sizeB >= ResticExecutor.DIFF_MAX_FILE_BYTES;

    // Бинарь-чек: читаем первые 8KB из каждого, ищем NUL.
    const isBinary = async (p: string): Promise<boolean> => {
      try {
        const fd = await fs.promises.open(p, 'r');
        try {
          const buf = Buffer.alloc(8192);
          const { bytesRead } = await fd.read(buf, 0, 8192, 0);
          for (let i = 0; i < bytesRead; i++) {
            if (buf[i] === 0) return true;
          }
          return false;
        } finally {
          await fd.close();
        }
      } catch {
        return false;
      }
    };

    if ((await isBinary(pathA)) || (await isBinary(pathB))) {
      return { success: true, binary: true, sizeA, sizeB, truncated };
    }

    // diff -u: exit 0 = идентичны, 1 = разные (норма), 2+ = реальная ошибка.
    // allowFailure обязателен — иначе CommandError бросится на любых различиях.
    const r = await this.executor.execute('diff', ['-u', pathA, pathB], {
      timeout: 30_000,
      allowFailure: true,
    });
    if (r.exitCode > 1) {
      return {
        success: false,
        error: `diff exit=${r.exitCode}: ${r.stderr.substring(0, 500)}`,
      };
    }
    return {
      success: true,
      binary: false,
      sizeA,
      sizeB,
      unifiedDiff: r.stdout,
      truncated,
    };
  }

  // ---------------------------------------------------------------------------
  // dumpDatabase (legacy — for backup execution)
  // ---------------------------------------------------------------------------

  private async dumpDatabase(
    name: string,
    type: string,
    outputPath: string,
    excludeTableData?: string[],
  ): Promise<void> {
    const excluded = excludeTableData?.length ? excludeTableData : [];

    if (type === 'POSTGRESQL') {
      const args = ['-U', 'postgres', '-Fp', '-f', outputPath];
      for (const t of excluded) args.push(`--exclude-table-data=${t}`);
      args.push(name);
      const r = await this.executor.execute('pg_dump', args, { timeout: 600_000, allowFailure: true });
      if (r.exitCode !== 0) throw new Error(`pg_dump failed: ${r.stderr}`);
    } else {
      const cmd = type === 'MARIADB' ? 'mariadb-dump' : 'mysqldump';
      if (excluded.length) {
        const args1 = ['-u', 'root', '--single-transaction', '--quick', '--routines', '--triggers'];
        for (const t of excluded) args1.push(`--ignore-table=${name}.${t}`);
        args1.push(`--result-file=${outputPath}`, name);
        const r1 = await this.executor.execute(cmd, args1, { timeout: 600_000, allowFailure: true });
        if (r1.exitCode !== 0) throw new Error(`${cmd} failed: ${r1.stderr}`);

        const args2 = ['-u', 'root', '--no-data', name, ...excluded];
        const r2 = await this.executor.execute(cmd, args2, { timeout: 600_000, allowFailure: true });
        if (r2.exitCode === 0) fs.appendFileSync(outputPath, r2.stdout);
      } else {
        const args = [
          '-u', 'root',
          '--single-transaction', '--quick', '--routines', '--triggers',
          `--result-file=${outputPath}`, name,
        ];
        const r = await this.executor.execute(cmd, args, { timeout: 600_000, allowFailure: true });
        if (r.exitCode !== 0) throw new Error(`${cmd} failed: ${r.stderr}`);
      }
    }
  }
}
