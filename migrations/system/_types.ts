/**
 * Контракт системной миграции.
 *
 * Системные миграции — операции над состоянием сервера, не над схемой БД.
 * Запускаются runner'ом (migrations/runner.ts) последовательно по `id`.
 */
import type { PrismaClient } from '@prisma/client';

export interface MigrationContext {
  /** Prisma клиент для чтения/записи в SQLite. */
  prisma: PrismaClient;

  /** Запуск внешних команд (allowlisted). Бросает при non-zero exit code. */
  exec: {
    run(cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }>;
    runShell(script: string, opts?: { cwd?: string }): Promise<{ stdout: string; stderr: string }>;
  };

  /** Проверка существования файла/директории. */
  exists(path: string): Promise<boolean>;

  /** Чтение файла как строки (UTF-8). */
  readFile(path: string): Promise<string>;

  /** Запись строки в файл (создаёт директории по пути). */
  writeFile(path: string, content: string, mode?: number): Promise<void>;

  /** Прогресс-лог, попадает в stdout runner'а и в `system_migrations.error_log` при падении. */
  log(msg: string): void;

  /** Параметры окружения панели — пути, версии, токены. */
  config: {
    panelDir: string;          // /opt/meowbox
    currentDir: string;        // /opt/meowbox/current  (или сам panelDir в legacy-раскладке)
    stateDir: string;          // /opt/meowbox/state    (или panelDir/data/.env в legacy)
    sitesBasePath: string;     // /var/www
    nodeEnv: 'production' | 'development';
  };

  /** dry-run флаг — миграция должна логировать, что бы сделала, но не делать. */
  dryRun: boolean;
}

export interface SystemMigration {
  /** Уникальный отсортированный id. Формат: `<YYYY-MM-DD>-<NNN>-<slug>`. */
  id: string;

  /** Человекочитаемое описание (одной строкой). */
  description: string;

  /** Pre-flight проверка. Если { ok: false } — миграция не запускается, runner падает с reason. */
  preflight?(ctx: MigrationContext): Promise<{ ok: boolean; reason?: string }>;

  /** Главная логика. ИДЕМПОТЕНТНАЯ. */
  up(ctx: MigrationContext): Promise<void>;

  /** Опциональный откат. Вызывается только вручную (`runner.js down <id>`). */
  down?(ctx: MigrationContext): Promise<void>;
}
