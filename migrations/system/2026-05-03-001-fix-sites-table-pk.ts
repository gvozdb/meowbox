import type { SystemMigration } from './_types';
import * as path from 'path';

/**
 * Фиксит структуру таблицы `sites` в SQLite.
 *
 * История бага: в какой-то момент таблица `sites` была пересоздана (видимо,
 * через `prisma db push` или ручной ALTER), и при этом потерялся
 * `PRIMARY KEY` на `id` и `UNIQUE INDEX` на `name`. SQLite разрешает
 * создавать FK-ссылки на колонку без PK, но при INSERT/UPDATE возвращает
 * `foreign key mismatch - "X" referencing "sites"`, как только включён
 * `PRAGMA foreign_keys=ON` (Prisma включает его per-connection).
 *
 * Симптом: миграция hostpanel падает на финальном persist Site/site_services
 * с PrismaClientKnownRequestError → SqliteError code 1 "foreign key mismatch".
 *
 * Лечение: пересобрать таблицу с правильной структурой через CLI sqlite3
 * (Prisma не даёт удобно делать DDL+PRAGMA в одной транзакции).
 *
 * Идемпотентность: если на колонке `id` уже стоит `pk=1` И существует индекс
 * `sites_name_key` — выходим без изменений.
 */

const migration: SystemMigration = {
  id: '2026-05-03-001-fix-sites-table-pk',
  description: 'Восстановить PRIMARY KEY на sites.id и UNIQUE на sites.name (фикс foreign key mismatch при создании сайтов)',

  async preflight(ctx) {
    const dbPath = resolveDbPath(ctx);
    if (!dbPath) {
      return { ok: false, reason: 'не удалось определить путь к meowbox.db (DATABASE_URL пустой или не file:)' };
    }
    if (!(await ctx.exists(dbPath))) {
      return { ok: false, reason: `SQLite файл не найден: ${dbPath}` };
    }
    try {
      await ctx.exec.run('which', ['sqlite3']);
    } catch {
      return { ok: false, reason: 'sqlite3 CLI не установлен' };
    }
    return { ok: true };
  },

  async up(ctx) {
    const dbPath = resolveDbPath(ctx)!;

    // Проверка текущего состояния. PRAGMA table_info возвращает по строке на колонку:
    // cid|name|type|notnull|dflt_value|pk
    const tableInfo = await runSqlite(ctx, dbPath, `PRAGMA table_info(sites);`);
    if (!tableInfo.trim()) {
      ctx.log('таблица sites не существует — миграция пропущена (свежая инсталляция?)');
      return;
    }

    let idIsPk = false;
    for (const line of tableInfo.split('\n')) {
      const parts = line.split('|');
      if (parts[1] === 'id') {
        idIsPk = parts[5] === '1';
        break;
      }
    }
    const indexCheck = await runSqlite(
      ctx,
      dbPath,
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sites' AND name='sites_name_key';`,
    );
    const hasNameIdx = indexCheck.trim() === 'sites_name_key';

    if (idIsPk && hasNameIdx) {
      ctx.log('✓ sites.id уже PRIMARY KEY, sites_name_key уже существует — skip');
      return;
    }
    ctx.log(`ремонтируем sites: id.pk=${idIsPk} name_idx=${hasNameIdx}`);

    if (ctx.dryRun) {
      ctx.log('[dry-run] пересобрал бы таблицу sites с PK + unique index');
      return;
    }

    const beforeCountStr = await runSqlite(ctx, dbPath, `SELECT COUNT(*) FROM sites;`);
    const beforeCount = parseInt(beforeCountStr.trim(), 10);
    ctx.log(`текущее число строк: ${beforeCount}`);

    // Список колонок берём из table_info — переносим только то, что реально есть.
    const colNames = tableInfo
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => l.split('|')[1])
      .filter(Boolean)
      .map((n) => `"${n}"`)
      .join(', ');

    // PRAGMA foreign_keys должен быть OFF ВНЕ транзакции (SQLite docs).
    // Поэтому собираем всю операцию в один heredoc-скрипт sqlite3.
    const sql = `
PRAGMA foreign_keys = OFF;
BEGIN;

CREATE TABLE "sites_new" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "display_name" TEXT,
  "domain" TEXT NOT NULL,
  "aliases" TEXT NOT NULL DEFAULT '[]',
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'STOPPED',
  "error_message" TEXT,
  "php_version" TEXT,
  "git_repository" TEXT,
  "deploy_branch" TEXT,
  "app_port" INTEGER,
  "env_vars" TEXT NOT NULL DEFAULT '{}',
  "root_path" TEXT NOT NULL,
  "nginx_config_path" TEXT NOT NULL,
  "site_user" TEXT,
  "ssh_password" TEXT,
  "cms_admin_user" TEXT,
  "cms_admin_password" TEXT,
  "manager_path" TEXT,
  "connectors_path" TEXT,
  "modx_version" TEXT,
  "php_pool_custom" TEXT,
  "db_enabled" BOOLEAN NOT NULL DEFAULT 0,
  "https_redirect" BOOLEAN NOT NULL DEFAULT 1,
  "files_rel_path" TEXT,
  "nginx_client_max_body_size" TEXT,
  "nginx_fastcgi_read_timeout" INTEGER,
  "nginx_fastcgi_send_timeout" INTEGER,
  "nginx_fastcgi_connect_timeout" INTEGER,
  "nginx_fastcgi_buffer_size_kb" INTEGER,
  "nginx_fastcgi_buffer_count" INTEGER,
  "nginx_http2" BOOLEAN NOT NULL DEFAULT 1,
  "nginx_hsts" BOOLEAN NOT NULL DEFAULT 0,
  "nginx_gzip" BOOLEAN NOT NULL DEFAULT 1,
  "nginx_rate_limit_enabled" BOOLEAN NOT NULL DEFAULT 0,
  "nginx_rate_limit_rps" INTEGER,
  "nginx_rate_limit_burst" INTEGER,
  "nginx_custom_config" TEXT,
  "backup_excludes" TEXT,
  "backup_exclude_tables" TEXT,
  "user_id" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  "metadata" TEXT
);

INSERT INTO sites_new (${colNames}) SELECT ${colNames} FROM sites;
DROP TABLE sites;
ALTER TABLE sites_new RENAME TO sites;
DROP INDEX IF EXISTS "sites_name_key";
CREATE UNIQUE INDEX "sites_name_key" ON "sites"("name");

COMMIT;
PRAGMA foreign_keys = ON;
`;

    // sqlite3 -bail остановится на первой ошибке.
    await ctx.exec.runShell(
      `sqlite3 -bail ${shellQuote(dbPath)} <<'__SQL__'\n${sql}\n__SQL__`,
    );

    // Проверка целостности.
    const fkErrors = await runSqlite(ctx, dbPath, `PRAGMA foreign_key_check;`);
    if (fkErrors.trim()) {
      throw new Error(`foreign_key_check после recreate выдал ошибки: ${fkErrors}`);
    }
    const afterCountStr = await runSqlite(ctx, dbPath, `SELECT COUNT(*) FROM sites;`);
    const afterCount = parseInt(afterCountStr.trim(), 10);
    if (afterCount !== beforeCount) {
      throw new Error(`данные потеряны: было ${beforeCount}, стало ${afterCount}`);
    }
    ctx.log(`✓ sites пересобран, строк: ${afterCount}, FK integrity OK`);
  },
};

/**
 * Достаём путь к SQLite-файлу из DATABASE_URL.
 * Формат Prisma SQLite: `file:./../data/meowbox.db` или `file:/abs/path.db`.
 * Резолвим относительно `api/prisma/` (стандартное cwd для Prisma).
 */
function resolveDbPath(ctx: { config: { panelDir: string; currentDir: string } }): string | null {
  const url = process.env.DATABASE_URL || '';
  if (!url.startsWith('file:')) {
    return null;
  }
  const raw = url.slice('file:'.length);
  if (path.isAbsolute(raw)) {
    return raw;
  }
  const prismaDir = path.join(ctx.config.currentDir, 'api', 'prisma');
  return path.resolve(prismaDir, raw);
}

async function runSqlite(
  ctx: { exec: { run: (cmd: string, args: string[]) => Promise<{ stdout: string }> } },
  dbPath: string,
  sql: string,
): Promise<string> {
  const r = await ctx.exec.run('sqlite3', ['-bail', dbPath, sql]);
  return r.stdout;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export default migration;
