import { CommandExecutor } from '../command-executor';

/**
 * Установка/снятие глобальных DB-движков (MariaDB, PostgreSQL) через apt.
 *
 * Архитектура:
 *   - MariaDB:    apt пакет `mariadb-server` (метапакет тянет mariadb-server-XX.Y).
 *                 Стандартный systemd unit: `mariadb.service`.
 *                 Auth: unix_socket для root → `mariadb -u root` без пароля
 *                 из-под рута (которым работает агент через CommandExecutor).
 *
 *   - PostgreSQL: apt метапакет `postgresql` (тянет postgresql-XX дистры).
 *                 Стандартный systemd unit: `postgresql.service`.
 *                 Auth: peer для роли postgres → `sudo -u postgres psql`.
 *
 * Логика серверного uninstall:
 *   - Только `apt-get remove`, НЕ purge — данные в /var/lib/mysql и
 *     /var/lib/postgresql/* остаются на случай отката. Уровнем выше
 *     (services.service.ts) уже проверено, что нет ни одной Database в Prisma,
 *     так что данных в реальном движке быть не должно — но оставить файлы на
 *     диске стоит дешевле, чем потерять чьи-то таблицы из-за рассинхрона.
 *
 * Безопасность:
 *   - DEBIAN_FRONTEND=noninteractive — не блокируемся на debconf-prompts.
 *   - timeout 600 сек на install (apt-update + основной apt install).
 *   - На каждом шаге явная проверка exitCode и читаемый Error.
 */

export interface DbEngineStatus {
  installed: boolean;
  version: string | null;
}

abstract class DbEngineExecutor {
  protected abstract readonly packageName: string;
  protected abstract readonly serviceUnit: string;
  /** Бинарь, через который определяем версию ('mariadb', 'psql'). */
  protected abstract readonly versionBinary: string;
  protected abstract readonly versionRegex: RegExp;

  constructor(protected readonly cmd: CommandExecutor) {}

  async status(): Promise<DbEngineStatus> {
    // Сначала dpkg-query на пакет: видим ли его apt вообще.
    const dpkg = await this.cmd
      .execute('dpkg-query', ['-s', this.packageName])
      .catch(() => ({ stdout: '', stderr: '', exitCode: 1 }));
    if (dpkg.exitCode !== 0 || !dpkg.stdout) return { installed: false, version: null };

    const status = /^Status:\s*(.+)$/m.exec(dpkg.stdout)?.[1]?.trim() || '';
    if (!/install ok installed/.test(status)) return { installed: false, version: null };

    // Версия — по фактическому бинарю (он отражает реальный сервер).
    const version = await this.detectVersion();
    return { installed: true, version };
  }

  protected async detectVersion(): Promise<string | null> {
    const r = await this.cmd
      .execute(this.versionBinary, ['--version'])
      .catch(() => ({ stdout: '', stderr: '', exitCode: 1 }));
    if (r.exitCode !== 0) return null;
    const m = this.versionRegex.exec(r.stdout) || this.versionRegex.exec(r.stderr);
    return m?.[1]?.trim() || null;
  }

  async install(): Promise<{ version: string }> {
    const update = await this.cmd.execute(
      'apt-get',
      ['-o', 'Acquire::Retries=3', 'update'],
      { timeout: 180_000, env: { DEBIAN_FRONTEND: 'noninteractive' } },
    );
    if (update.exitCode !== 0) {
      throw new Error(`apt-get update failed: ${update.stderr || update.stdout}`);
    }
    const install = await this.cmd.execute(
      'apt-get',
      ['install', '-y', '--no-install-recommends', this.packageName],
      { timeout: 600_000, env: { DEBIAN_FRONTEND: 'noninteractive' } },
    );
    if (install.exitCode !== 0) {
      throw new Error(
        `apt-get install ${this.packageName} failed: ${install.stderr || install.stdout}`,
      );
    }

    // Включаем systemd-юнит. apt у Debian/Ubuntu обычно сам делает enable+start,
    // но на минимальных образах с policy-rc.d=101 этого может не произойти.
    await this.cmd
      .execute('systemctl', ['enable', '--now', this.serviceUnit])
      .catch(() => {});

    const after = await this.status();
    if (!after.installed) throw new Error(`${this.packageName} не установился (dpkg-query != installed)`);
    return { version: after.version || 'unknown' };
  }

  async uninstall(): Promise<void> {
    // Останавливаем демон (best-effort).
    await this.cmd
      .execute('systemctl', ['disable', '--now', this.serviceUnit])
      .catch(() => {});

    const r = await this.cmd.execute(
      'apt-get',
      ['remove', '-y', this.packageName],
      { timeout: 300_000, env: { DEBIAN_FRONTEND: 'noninteractive' } },
    );
    if (r.exitCode !== 0) {
      throw new Error(
        `apt-get remove ${this.packageName} failed: ${r.stderr || r.stdout}`,
      );
    }
    // ВАЖНО: НЕ делаем `apt-get purge` и НЕ трогаем /var/lib/mysql
    // /var/lib/postgresql — данные остаются, при переустановке вернутся.
  }
}

/**
 * MariaDB executor.
 * Версия из `mariadb --version`: "mariadb  Ver 15.1 Distrib 10.11.6-MariaDB, …"
 * → парсим число после `Distrib`.
 */
export class MariadbEngineExecutor extends DbEngineExecutor {
  protected readonly packageName = 'mariadb-server';
  protected readonly serviceUnit = 'mariadb';
  protected readonly versionBinary = 'mariadb';
  protected readonly versionRegex = /Distrib\s+([0-9][0-9A-Za-z.\-+_]*)/;
}

/**
 * PostgreSQL executor.
 * Метапакет `postgresql` зависит от `postgresql-XX` дистры.
 * Версия из `psql --version`: "psql (PostgreSQL) 15.4 (Ubuntu 15.4-1.pgdg22.04+1)".
 */
export class PostgresqlEngineExecutor extends DbEngineExecutor {
  protected readonly packageName = 'postgresql';
  protected readonly serviceUnit = 'postgresql';
  protected readonly versionBinary = 'psql';
  protected readonly versionRegex = /\(PostgreSQL\)\s+([0-9][0-9A-Za-z.\-+_]*)/;
}
