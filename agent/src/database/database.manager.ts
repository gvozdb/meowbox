import { CommandExecutor } from '../command-executor';
import * as fs from 'fs';
import * as path from 'path';
import { isUnderBackupStorage, DB_EXPORTS_DIR } from '../config';

/**
 * Валидация пути к SQL-дампу перед передачей в `mysql -e "source …"` /
 * `psql -f …`. Возвращает абсолютный путь или кидает.
 *
 * Почему это важно: MySQL CLI передаёт путь `source` собственному парсеру,
 * который поддерживает пробелы/метасимволы. Если в имя файла затесался
 * символ `;` или `'`, можно завершить команду и вставить произвольный SQL.
 */
function validateDumpPath(filePath: string): string {
  const abs = path.resolve(filePath);
  if (!/^[A-Za-z0-9_./-]+$/.test(abs)) {
    throw new Error('Invalid dump path: unsafe characters');
  }
  if (!fs.existsSync(abs)) {
    throw new Error(`Dump file not found: ${abs}`);
  }
  // Дополнительно ограничиваем набор локаций — только бэкап-хранилище и
  // тмп каталог меовбокса.
  const allowedPrefixes = [
    '/tmp/meowbox-',
    '/var/meowbox/',
  ];
  if (!isUnderBackupStorage(abs) && !allowedPrefixes.some((p) => abs.startsWith(p))) {
    throw new Error(`Dump path not allowed: ${abs}`);
  }
  return abs;
}

interface CreateDbParams {
  name: string;
  type: 'MARIADB' | 'MYSQL' | 'POSTGRESQL';
  dbUser: string;
  password: string;
}

interface DbResult {
  success: boolean;
  error?: string;
}

/**
 * Manages user databases (MariaDB, MySQL, PostgreSQL).
 * Uses CLI tools (mysql/mariadb, psql) with secure argument passing.
 */
export class DatabaseManager {
  private executor: CommandExecutor;

  constructor() {
    this.executor = new CommandExecutor();
  }

  async createDatabase(params: CreateDbParams): Promise<DbResult> {
    switch (params.type) {
      case 'MARIADB':
      case 'MYSQL':
        return this.createMysqlDb(params);
      case 'POSTGRESQL':
        return this.createPostgresDb(params);
      default:
        return { success: false, error: `Unknown database type: ${params.type}` };
    }
  }

  async dropDatabase(name: string, type: string, dbUser: string): Promise<DbResult> {
    switch (type) {
      case 'MARIADB':
      case 'MYSQL':
        return this.dropMysqlDb(name, dbUser);
      case 'POSTGRESQL':
        return this.dropPostgresDb(name, dbUser);
      default:
        return { success: false, error: `Unknown database type: ${type}` };
    }
  }

  /**
   * Меняет пароль существующего пользователя БД. Используется при ресете
   * пароля из панели — нужен, чтобы реальный пароль в MariaDB/Postgres
   * совпадал с тем, что зашифрован в meowbox.db (иначе Adminer попытается
   * подключиться с новым паролем и получит 1045 «access denied»).
   */
  async resetDatabasePassword(params: { name: string; type: string; dbUser: string; password: string }): Promise<DbResult> {
    switch (params.type) {
      case 'MARIADB':
      case 'MYSQL': {
        const cmd = await this.detectMysqlCmd();
        const sql = `ALTER USER '${this.escapeMysqlStr(params.dbUser)}'@'localhost' IDENTIFIED BY '${this.escapeMysqlStr(params.password)}'; FLUSH PRIVILEGES`;
        const result = await this.executor.execute(cmd, ['-u', 'root', '-e', sql]);
        if (result.exitCode !== 0) return { success: false, error: result.stderr };
        return { success: true };
      }
      case 'POSTGRESQL': {
        const result = await this.psql(
          `ALTER ROLE "${this.escapePgId(params.dbUser)}" WITH PASSWORD '${this.escapePgStr(params.password)}'`,
        );
        if (result.exitCode !== 0) return { success: false, error: result.stderr };
        return { success: true };
      }
      default:
        return { success: false, error: `Unknown database type: ${params.type}` };
    }
  }

  async getDatabaseSize(name: string, type: string): Promise<number> {
    switch (type) {
      case 'MARIADB':
      case 'MYSQL':
        return this.getMysqlDbSize(name);
      case 'POSTGRESQL':
        return this.getPostgresDbSize(name);
      default:
        return 0;
    }
  }

  async exportDatabase(name: string, type: string): Promise<{ success: boolean; filePath?: string; error?: string }> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dumpDir = DB_EXPORTS_DIR;
    // Дополнительная защита: имя БД используется в имени файла — в нём не должно быть
    // слэша/нулл-байта, иначе получим запись по произвольному пути.
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      return { success: false, error: 'Invalid database name' };
    }
    await this.executor.execute('mkdir', ['-p', dumpDir]);

    if (type === 'POSTGRESQL') {
      const filePath = `${dumpDir}/${name}_${timestamp}.sql`;
      const result = await this.executor.execute('pg_dump', [
        '-U', 'postgres', '-f', filePath, name,
      ], { timeout: 600_000 });
      if (result.exitCode !== 0) return { success: false, error: result.stderr };
      return { success: true, filePath };
    } else {
      const cmd = type === 'MARIADB' ? 'mariadb-dump' : 'mysqldump';
      const filePath = `${dumpDir}/${name}_${timestamp}.sql`;
      const result = await this.executor.execute(cmd, [
        '-u', 'root', '--single-transaction', '--quick',
        '--routines', '--triggers', `--result-file=${filePath}`, name,
      ], { timeout: 600_000 });
      if (result.exitCode !== 0) return { success: false, error: result.stderr };
      return { success: true, filePath };
    }
  }

  async importDatabase(name: string, type: string, filePath: string): Promise<DbResult> {
    let safePath: string;
    try {
      safePath = validateDumpPath(filePath);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
    if (type === 'POSTGRESQL') {
      const result = await this.executor.execute('sudo', [
        '-u', 'postgres', 'psql', '-d', name, '-f', safePath,
      ], { timeout: 600_000 });
      if (result.exitCode !== 0) return { success: false, error: result.stderr };
      return { success: true };
    } else {
      const cmd = type === 'MARIADB' ? 'mariadb' : 'mysql';
      const result = await this.executor.execute(cmd, [
        '-u', 'root', name, '-e', `source ${safePath}`,
      ], { timeout: 600_000 });
      if (result.exitCode !== 0) return { success: false, error: result.stderr };
      return { success: true };
    }
  }

  /**
   * Detect which database engines are actually available on the server.
   */
  async detectAvailable(): Promise<{ available: string[]; preferred: string | null }> {
    const available: string[] = [];

    // Check MariaDB
    const mariadb = await this.executor.execute('mariadb', ['--version']);
    if (mariadb.exitCode === 0) available.push('MARIADB');

    // Check MySQL (only if no MariaDB)
    if (!available.includes('MARIADB')) {
      const mysql = await this.executor.execute('mysql', ['--version']);
      if (mysql.exitCode === 0) available.push('MYSQL');
    }

    // Check PostgreSQL (verify actual connectivity, not just binary)
    const pgCheck = await this.executor.execute('sudo', ['-u', 'postgres', 'psql', '-c', 'SELECT 1']);
    if (pgCheck.exitCode === 0) available.push('POSTGRESQL');

    return {
      available,
      preferred: available[0] || null,
    };
  }

  // ===========================================================================
  // MySQL/MariaDB
  // ===========================================================================

  private async createMysqlDb(params: CreateDbParams): Promise<DbResult> {
    const cmd = params.type === 'MARIADB' ? 'mariadb' : 'mysql';

    // Create database
    const createDb = await this.executor.execute(cmd, [
      '-u', 'root',
      '-e', `CREATE DATABASE IF NOT EXISTS \`${this.escapeMysqlId(params.name)}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    ]);

    if (createDb.exitCode !== 0) {
      return { success: false, error: createDb.stderr };
    }

    // Create user and grant privileges
    const createUser = await this.executor.execute(cmd, [
      '-u', 'root',
      '-e', `CREATE USER IF NOT EXISTS '${this.escapeMysqlStr(params.dbUser)}'@'localhost' IDENTIFIED BY '${this.escapeMysqlStr(params.password)}'`,
    ]);

    if (createUser.exitCode !== 0) {
      return { success: false, error: createUser.stderr };
    }

    const grant = await this.executor.execute(cmd, [
      '-u', 'root',
      '-e', `GRANT ALL PRIVILEGES ON \`${this.escapeMysqlId(params.name)}\`.* TO '${this.escapeMysqlStr(params.dbUser)}'@'localhost'; FLUSH PRIVILEGES`,
    ]);

    if (grant.exitCode !== 0) {
      return { success: false, error: grant.stderr };
    }

    return { success: true };
  }

  private async dropMysqlDb(name: string, dbUser: string): Promise<DbResult> {
    // Try mariadb first, fallback to mysql
    const cmd = await this.detectMysqlCmd();

    const dropDb = await this.executor.execute(cmd, [
      '-u', 'root',
      '-e', `DROP DATABASE IF EXISTS \`${this.escapeMysqlId(name)}\``,
    ]);

    if (dropDb.exitCode !== 0) {
      return { success: false, error: dropDb.stderr };
    }

    // Drop user
    await this.executor.execute(cmd, [
      '-u', 'root',
      '-e', `DROP USER IF EXISTS '${this.escapeMysqlStr(dbUser)}'@'localhost'`,
    ]);

    return { success: true };
  }

  private async getMysqlDbSize(name: string): Promise<number> {
    const cmd = await this.detectMysqlCmd();

    const result = await this.executor.execute(cmd, [
      '-u', 'root',
      '-N', '-B',
      '-e', `SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.TABLES WHERE table_schema = '${this.escapeMysqlStr(name)}'`,
    ]);

    if (result.exitCode !== 0) return 0;
    return parseInt(result.stdout.trim(), 10) || 0;
  }

  private async detectMysqlCmd(): Promise<string> {
    const check = await this.executor.execute('mariadb', ['--version']);
    return check.exitCode === 0 ? 'mariadb' : 'mysql';
  }

  private escapeMysqlId(str: string): string {
    // Allow alphanumerics, underscores, dashes (safe inside backtick-quoted identifiers)
    // Remove backticks to prevent escaping out of the identifier
    return str.replace(/[^a-zA-Z0-9_-]/g, '');
  }

  private escapeMysqlStr(str: string): string {
    // Порядок имеет значение: сперва null/control-bytes (они способны
    // обойти последующий quote-escaping), затем обратный слеш (двойное
    // экранирование), и в самом конце — одиночная кавычка.
    return str
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "''");
  }

  // ===========================================================================
  // PostgreSQL
  // ===========================================================================

  private async createPostgresDb(params: CreateDbParams): Promise<DbResult> {
    // Create user
    const createUser = await this.psql(
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${this.escapePgStr(params.dbUser)}') THEN CREATE ROLE "${this.escapePgId(params.dbUser)}" LOGIN PASSWORD '${this.escapePgStr(params.password)}'; END IF; END $$`,
    );

    if (createUser.exitCode !== 0) {
      return { success: false, error: createUser.stderr };
    }

    // Create database
    const createDb = await this.psql(
      `CREATE DATABASE "${this.escapePgId(params.name)}" OWNER "${this.escapePgId(params.dbUser)}" ENCODING 'UTF8'`,
    );

    if (createDb.exitCode !== 0 && !createDb.stderr.includes('already exists')) {
      return { success: false, error: createDb.stderr };
    }

    // Grant privileges
    await this.psql(
      `GRANT ALL PRIVILEGES ON DATABASE "${this.escapePgId(params.name)}" TO "${this.escapePgId(params.dbUser)}"`,
    );

    return { success: true };
  }

  private async dropPostgresDb(name: string, dbUser: string): Promise<DbResult> {
    // Terminate connections
    await this.psql(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${this.escapePgStr(name)}' AND pid <> pg_backend_pid()`,
    );

    const dropDb = await this.psql(
      `DROP DATABASE IF EXISTS "${this.escapePgId(name)}"`,
    );

    if (dropDb.exitCode !== 0) {
      return { success: false, error: dropDb.stderr };
    }

    // Drop user
    await this.psql(
      `DROP ROLE IF EXISTS "${this.escapePgId(dbUser)}"`,
    );

    return { success: true };
  }

  private async getPostgresDbSize(name: string): Promise<number> {
    const result = await this.executor.execute('sudo', [
      '-u', 'postgres',
      'psql', '-t', '-A',
      '-c', `SELECT pg_database_size('${this.escapePgStr(name)}')`,
    ]);

    if (result.exitCode !== 0) return 0;
    return parseInt(result.stdout.trim(), 10) || 0;
  }

  private escapePgId(str: string): string {
    // Allow alphanumerics, underscores, dashes (safe inside double-quoted identifiers)
    // Remove double quotes to prevent escaping out
    return str.replace(/[^a-zA-Z0-9_-]/g, '');
  }

  private escapePgStr(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str.replace(/[\x00-\x1f\x7f]/g, '').replace(/'/g, "''");
  }

  /**
   * Run psql as postgres user via sudo (peer auth).
   */
  private psql(sql: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.executor.execute('sudo', [
      '-u', 'postgres',
      'psql', '-c', sql,
    ]);
  }
}
