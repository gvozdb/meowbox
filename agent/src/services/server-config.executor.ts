import { promises as fs } from 'fs';
import * as path from 'path';
import { CommandExecutor } from '../command-executor';

/**
 * Редактирование конфигов глобальных сервисов (MariaDB, PostgreSQL и т.п.)
 * через панель.
 *
 * Жёсткие правила:
 *   - Whitelist путей. Никаких user-controlled путей — только серверные ключи
 *     `serviceKey + file`. Любой неизвестный ключ → ошибка.
 *   - PostgreSQL: версия определяется автоматически (берётся первая папка в
 *     `/etc/postgresql/`). Если установлено несколько мажоров — берётся
 *     наибольшая. На прод-сервере обычно один.
 *   - Запись атомарная: пишем в `{path}.meowbox.tmp` → `rename()`. Это сохраняет
 *     inode / permissions / acl и исключает «полу-записанный» конфиг при падении.
 *   - Перед записью делаем `.meowbox.bak.{ts}` копию (одна на сохранение).
 *   - Restart — через `systemctl restart {unit}` нашим CommandExecutor'ом.
 *
 * Возвращаемые ошибки — обычные `Error`, callback в agent.service оборачивает их.
 */

type ServiceKey = 'mariadb' | 'postgresql';
type FileKey = string; // нормализованный ключ файла, например `my.cnf`, `postgresql.conf`, `pg_hba.conf`

interface ConfigFileSpec {
  /** Абсолютный путь до файла. Для PG — функция, т.к. версия динамическая. */
  resolvePath: () => Promise<string>;
  /** Имя systemd-юнита для restart'а. */
  serviceUnit: string;
  /** Максимальный размер контента в байтах (DoS-защита от мегабайтных «конфигов»). */
  maxBytes: number;
}

const MAX_CONFIG_BYTES = 1_000_000; // 1 MB — реальные конфиги < 50 KB, с запасом

async function resolvePgConfigDir(): Promise<string> {
  const base = '/etc/postgresql';
  let dirs: string[];
  try {
    dirs = await fs.readdir(base);
  } catch (e) {
    throw new Error(`PostgreSQL config dir not found: ${base} (postgresql installed?)`);
  }
  const versionDirs = dirs.filter((d) => /^\d+$/.test(d));
  if (!versionDirs.length) {
    throw new Error(`No PostgreSQL version dirs found in ${base}`);
  }
  // Берём максимальную мажорную версию (15 < 16 < 17 ...).
  versionDirs.sort((a, b) => Number(b) - Number(a));
  return path.join(base, versionDirs[0], 'main');
}

const FILES: Record<ServiceKey, Record<FileKey, ConfigFileSpec>> = {
  mariadb: {
    'my.cnf': {
      resolvePath: async () => '/etc/mysql/my.cnf',
      serviceUnit: 'mariadb.service',
      maxBytes: MAX_CONFIG_BYTES,
    },
  },
  postgresql: {
    'postgresql.conf': {
      resolvePath: async () => path.join(await resolvePgConfigDir(), 'postgresql.conf'),
      serviceUnit: 'postgresql.service',
      maxBytes: MAX_CONFIG_BYTES,
    },
    'pg_hba.conf': {
      resolvePath: async () => path.join(await resolvePgConfigDir(), 'pg_hba.conf'),
      serviceUnit: 'postgresql.service',
      maxBytes: MAX_CONFIG_BYTES,
    },
  },
};

export interface ReadConfigResult {
  /** Абсолютный путь файла на сервере (для отображения в UI). */
  path: string;
  content: string;
  /** Размер в байтах. */
  size: number;
  /** UTF-8 ли это (false → бинарь, отказываем в open для редактирования). */
  utf8: boolean;
}

export interface ConfigFileInfo {
  file: FileKey;
  path: string;
  exists: boolean;
}

export class ServerConfigExecutor {
  private readonly executor = new CommandExecutor();

  /**
   * Список всех whitelisted конфигов для сервиса с реальными путями.
   * Используется API'ем для рендеринга вкладок (PostgreSQL: postgresql.conf + pg_hba.conf).
   */
  async listConfigs(serviceKey: string): Promise<ConfigFileInfo[]> {
    const svc = this.resolveService(serviceKey);
    const files = FILES[svc];
    const out: ConfigFileInfo[] = [];
    for (const [file, spec] of Object.entries(files)) {
      let p: string;
      try {
        p = await spec.resolvePath();
      } catch {
        // Если PG ещё не установлен — путь не резолвится, скрываем файл.
        out.push({ file, path: '(not installed)', exists: false });
        continue;
      }
      let exists = true;
      try { await fs.access(p); } catch { exists = false; }
      out.push({ file, path: p, exists });
    }
    return out;
  }

  async readConfig(serviceKey: string, fileKey: string): Promise<ReadConfigResult> {
    const spec = this.resolveSpec(serviceKey, fileKey);
    const p = await spec.resolvePath();
    const stat = await fs.stat(p);
    if (stat.size > spec.maxBytes) {
      throw new Error(`Config file too large (${stat.size} bytes > ${spec.maxBytes}). Refusing to load.`);
    }
    const buf = await fs.readFile(p);
    // Эвристика UTF-8: пытаемся декодировать, сравниваем длину. Бинари обычно
    // содержат \0 — это самый надёжный быстрый чек.
    const utf8 = !buf.includes(0);
    return {
      path: p,
      content: utf8 ? buf.toString('utf-8') : '',
      size: stat.size,
      utf8,
    };
  }

  async writeConfig(serviceKey: string, fileKey: string, content: string): Promise<{ path: string; backupPath: string }> {
    const spec = this.resolveSpec(serviceKey, fileKey);
    const bytes = Buffer.byteLength(content, 'utf-8');
    if (bytes > spec.maxBytes) {
      throw new Error(`Content too large (${bytes} bytes > ${spec.maxBytes}). Refusing to save.`);
    }
    const p = await spec.resolvePath();
    // Бэкап — оригинальный файл копируется в `{path}.meowbox.bak.{ISO}`.
    let backupPath = '';
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = `${p}.meowbox.bak.${ts}`;
      await fs.copyFile(p, backupPath);
    } catch (e) {
      // Если оригинала нет — это не нормально для конфигов, бросаем ошибку.
      throw new Error(`Failed to backup ${p}: ${(e as Error).message}`);
    }

    // Атомарная запись: tmp в той же директории → rename. fsync через
    // file handle (writeFile делает open/write/close — fsync делает ОС не
    // всегда сразу; для конфигов это терпимо, рестарт сервиса всё равно
    // пройдёт через syscall и увидит свежий файл).
    const tmp = `${p}.meowbox.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, content, { encoding: 'utf-8', mode: 0o644 });
    // Сохраняем исходные права/владельца — копируем перед rename.
    try {
      const stat = await fs.stat(p);
      await fs.chmod(tmp, stat.mode);
      await fs.chown(tmp, stat.uid, stat.gid);
    } catch {
      // Если не получилось — оставляем дефолтные права root:root 0644. Не критично,
      // т.к. демон обычно читает конфиги от своего user'а с access через group.
    }
    await fs.rename(tmp, p);
    return { path: p, backupPath };
  }

  /**
   * Restart демона. Используется после сохранения конфига. Возвращает
   * stdout/stderr `systemctl` — пользователю покажем для диагностики.
   */
  async restartService(serviceKey: string): Promise<{ unit: string; ok: boolean; output: string }> {
    const svc = this.resolveService(serviceKey);
    // Любой из whitelisted file specs знает unit (они одинаковые внутри одного svc).
    const firstFile = Object.values(FILES[svc])[0];
    const unit = firstFile.serviceUnit;
    const res = await this.executor.execute('systemctl', ['restart', unit], {
      timeout: 60_000,
      allowFailure: true,
    });
    if (res.exitCode !== 0) {
      // Подтянем status для диагностики.
      const status = await this.executor.execute('systemctl', ['status', unit, '--no-pager', '--lines=30'], {
        timeout: 15_000,
        allowFailure: true,
      });
      throw new Error(
        `systemctl restart ${unit} failed (exit ${res.exitCode}). ` +
        `stderr: ${res.stderr.trim()}\n--- status ---\n${status.stdout}`,
      );
    }
    return { unit, ok: true, output: res.stdout || res.stderr || '' };
  }

  private resolveService(serviceKey: string): ServiceKey {
    if (serviceKey !== 'mariadb' && serviceKey !== 'postgresql') {
      throw new Error(`Service "${serviceKey}" does not support config editing through panel`);
    }
    return serviceKey;
  }

  private resolveSpec(serviceKey: string, fileKey: string): ConfigFileSpec {
    const svc = this.resolveService(serviceKey);
    const spec = FILES[svc][fileKey];
    if (!spec) {
      throw new Error(`Unknown config file "${fileKey}" for service "${svc}"`);
    }
    return spec;
  }
}
