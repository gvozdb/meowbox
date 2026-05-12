import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CommandExecutor } from '../command-executor';

/**
 * Редактирование конфигов глобальных сервисов (MariaDB, PostgreSQL, SSH, Fail2ban)
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
 *   - Для критичных конфигов (sshd_config) — `preValidate` проверяет синтаксис
 *     ДО rename. Битый sshd_config может лишить доступа к серверу — нельзя
 *     полагаться на «откатим после рестарта».
 *   - Restart — через `systemctl restart {unit}` нашим CommandExecutor'ом.
 *
 * Возвращаемые ошибки — обычные `Error`, callback в agent.service оборачивает их.
 */

type ServiceKey = 'mariadb' | 'postgresql' | 'ssh' | 'fail2ban' | 'postfix';
type FileKey = string; // нормализованный ключ файла, например `my.cnf`, `sshd_config`, `jail.local`

interface ConfigFileSpec {
  /** Абсолютный путь до файла. Для PG — функция, т.к. версия динамическая. */
  resolvePath: () => Promise<string>;
  /** Имя systemd-юнита для restart'а. */
  serviceUnit: string;
  /** Максимальный размер контента в байтах (DoS-защита от мегабайтных «конфигов»). */
  maxBytes: number;
  /**
   * Опциональная pre-validation: проверка синтаксиса нового контента ДО rename.
   * Получает путь к временному файлу (внутри сейф-tmp в /tmp). Если бросает Error —
   * write отменяется, tmp-файл удаляется, оригинал не трогаем.
   *
   * Для sshd_config: `sshd -t -f <tmp>` — это стандартная проверка OpenSSH.
   * Без неё одна опечатка убивает SSH-доступ полностью.
   */
  preValidate?: (tmpFilePath: string, executor: CommandExecutor) => Promise<void>;
  /** Создавать файл, если он отсутствует. По умолчанию — false (требуем существования). */
  createIfMissing?: boolean;
  /**
   * Опциональный hook после успешной записи (но до restart). Используется
   * например для `newaliases` после правки /etc/aliases — postfix не подхватит
   * новые алиасы без пересборки .db. Best-effort, ошибки логируются но не валят
   * сохранение (юзер сможет нажать «Перезапустить» вручную).
   */
  postWrite?: (executor: CommandExecutor) => Promise<void>;
}

const MAX_CONFIG_BYTES = 1_000_000; // 1 MB — реальные конфиги < 50 KB, с запасом

async function resolvePgConfigDir(): Promise<string> {
  const base = '/etc/postgresql';
  let dirs: string[];
  try {
    dirs = await fs.readdir(base);
  } catch {
    throw new Error(`PostgreSQL config dir not found: ${base} (postgresql installed?)`);
  }
  const versionDirs = dirs.filter((d) => /^\d+$/.test(d));
  if (!versionDirs.length) {
    throw new Error(`No PostgreSQL version dirs found in ${base}`);
  }
  versionDirs.sort((a, b) => Number(b) - Number(a));
  return path.join(base, versionDirs[0], 'main');
}

/** sshd -t -f <tmp> — синтаксическая валидация конфига перед rename. */
async function validateSshdConfig(tmpFilePath: string, executor: CommandExecutor): Promise<void> {
  // sshd ожидает абсолютный путь к конфигу. Запускаем под root (агент работает root).
  // exit=0 — валиден; иначе stderr содержит описание ошибки.
  const r = await executor.execute('sshd', ['-t', '-f', tmpFilePath], {
    timeout: 15_000,
    allowFailure: true,
  });
  if (r.exitCode !== 0) {
    throw new Error(
      `sshd_config валидация провалилась (sshd -t exit ${r.exitCode}): ${(r.stderr || r.stdout).trim()}`,
    );
  }
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
  ssh: {
    'sshd_config': {
      resolvePath: async () => '/etc/ssh/sshd_config',
      // На Ubuntu/Debian юнит называется `ssh.service`. RH-семейство — `sshd.service`,
      // но мы таргетим Ubuntu (см. SUPPORTED_PHP_VERSIONS / install.sh).
      serviceUnit: 'ssh.service',
      maxBytes: MAX_CONFIG_BYTES,
      preValidate: validateSshdConfig,
    },
  },
  fail2ban: {
    'jail.local': {
      resolvePath: async () => '/etc/fail2ban/jail.local',
      serviceUnit: 'fail2ban.service',
      maxBytes: MAX_CONFIG_BYTES,
      // jail.local — стандартный override-файл fail2ban. Может отсутствовать
      // после свежего apt install (есть только jail.conf). Разрешаем создание
      // через панель.
      createIfMissing: true,
    },
  },
  postfix: {
    // main.cf редактируется руками только продвинутыми юзерами; основной
    // workflow — настройка relay через модалку (postfix:apply-relay).
    // sasl_passwd НЕ открываем для прямого редактирования — там пароль,
    // нечего показывать в textarea без маски. Меняется тоже через relay-модалку.
    'main.cf': {
      resolvePath: async () => '/etc/postfix/main.cf',
      serviceUnit: 'postfix.service',
      maxBytes: MAX_CONFIG_BYTES,
    },
    'master.cf': {
      resolvePath: async () => '/etc/postfix/master.cf',
      serviceUnit: 'postfix.service',
      maxBytes: MAX_CONFIG_BYTES,
    },
    'aliases': {
      resolvePath: async () => '/etc/aliases',
      serviceUnit: 'postfix.service',
      maxBytes: MAX_CONFIG_BYTES,
      // aliases есть всегда (даже без postfix), но на всякий случай.
      createIfMissing: true,
      // postfix не подхватит /etc/aliases без `newaliases` (пересборка .db).
      postWrite: async (executor) => {
        await executor.execute('newaliases', [], { timeout: 15_000, allowFailure: true })
          .catch(() => {});
      },
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
   * Используется API'ем для рендеринга вкладок.
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
    let stat;
    try {
      stat = await fs.stat(p);
    } catch (e) {
      // Если файл может быть создан через панель (jail.local) — возвращаем
      // пустой контент с подсказкой, чтобы юзер мог сразу писать.
      if (spec.createIfMissing) {
        return { path: p, content: '', size: 0, utf8: true };
      }
      throw new Error(`Config file not found: ${p} (${(e as Error).message})`);
    }
    if (stat.size > spec.maxBytes) {
      throw new Error(`Config file too large (${stat.size} bytes > ${spec.maxBytes}). Refusing to load.`);
    }
    const buf = await fs.readFile(p);
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

    // Pre-validation: пишем во временный файл в /tmp (а не рядом с оригиналом,
    // чтобы sshd-d не споткнулся об мусор в /etc/ssh/), валидируем, потом
    // переносим в location рядом с оригиналом для rename.
    if (spec.preValidate) {
      const validateTmp = path.join(os.tmpdir(), `meowbox-validate-${path.basename(p)}.${process.pid}.${Date.now()}`);
      await fs.writeFile(validateTmp, content, { encoding: 'utf-8', mode: 0o600 });
      try {
        await spec.preValidate(validateTmp, this.executor);
      } finally {
        await fs.unlink(validateTmp).catch(() => {});
      }
    }

    let backupPath = '';
    let originalExists = true;
    try {
      await fs.access(p);
    } catch {
      originalExists = false;
    }
    if (originalExists) {
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        backupPath = `${p}.meowbox.bak.${ts}`;
        await fs.copyFile(p, backupPath);
      } catch (e) {
        throw new Error(`Failed to backup ${p}: ${(e as Error).message}`);
      }
    } else if (!spec.createIfMissing) {
      throw new Error(`Original config not found and createIfMissing=false: ${p}`);
    }

    // Атомарная запись в той же директории — rename внутри одной FS atomic.
    const tmp = `${p}.meowbox.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, content, { encoding: 'utf-8', mode: 0o644 });

    if (originalExists) {
      try {
        const stat = await fs.stat(p);
        await fs.chmod(tmp, stat.mode);
        await fs.chown(tmp, stat.uid, stat.gid);
      } catch {
        // Best-effort — fallback 0644 root:root.
      }
    } else {
      // Для новых конфигов (jail.local) — root:root 0644, стандарт для /etc.
      await fs.chmod(tmp, 0o644).catch(() => {});
    }
    await fs.rename(tmp, p);

    // Post-write hook — best-effort. Например newaliases после /etc/aliases.
    if (spec.postWrite) {
      try { await spec.postWrite(this.executor); } catch { /* ignored */ }
    }
    return { path: p, backupPath };
  }

  /**
   * Restart демона. Используется после сохранения конфига. Возвращает
   * stdout/stderr `systemctl` — пользователю покажем для диагностики.
   */
  async restartService(serviceKey: string): Promise<{ unit: string; ok: boolean; output: string }> {
    const svc = this.resolveService(serviceKey);
    const firstFile = Object.values(FILES[svc])[0];
    const unit = firstFile.serviceUnit;
    const res = await this.executor.execute('systemctl', ['restart', unit], {
      timeout: 60_000,
      allowFailure: true,
    });
    if (res.exitCode !== 0) {
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
    if (
      serviceKey !== 'mariadb' &&
      serviceKey !== 'postgresql' &&
      serviceKey !== 'ssh' &&
      serviceKey !== 'fail2ban' &&
      serviceKey !== 'postfix'
    ) {
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
