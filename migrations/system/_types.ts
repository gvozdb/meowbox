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

  /**
   * Atomic text write (creates parent directories).  Existing mode/owner are
   * retained unless explicit metadata is supplied for a newly managed file.
   */
  writeFile(path: string, content: string, mode?: number, ownership?: { uid: number; gid: number }): Promise<void>;

  /**
   * Durable, atomic checkpoint storage for resumable system migrations.
   *
   * Checkpoints deliberately live outside SQLite: a release rollback restores
   * the database snapshot, while the journal must still explain which runtime
   * artifacts were prepared before an interruption.  The runner owns the
   * directory and writes through an fsync + rename boundary.
   */
  checkpoints: {
    read<T>(migrationId: string): Promise<T | null>;
    write<T>(migrationId: string, value: T): Promise<void>;
    remove(migrationId: string): Promise<void>;
    pathFor(migrationId: string): string;
  };

  /** Прогресс-лог, попадает в stdout runner'а и в `system_migrations.error_log` при падении. */
  log(msg: string): void;

  /** Параметры окружения панели — пути, версии, токены. */
  config: {
    panelDir: string;          // /opt/meowbox
    currentDir: string;        // /opt/meowbox/current  (или сам panelDir в legacy-раскладке)
    stateDir: string;          // /opt/meowbox/state    (или panelDir/data/.env в legacy)
    migrationStateDir: string; // <stateDir>/data/migrations
    releaseLockFile: string;   // общий OS flock updater/runner/startup-repair
    sitesBasePath: string;     // /var/www
    nodeEnv: 'production' | 'development';
  };

  /** dry-run флаг — миграция должна логировать, что бы сделала, но не делать. */
  dryRun: boolean;
}

export interface MigrationPlan {
  /** Stable, redacted summary suitable for the release dry-run report. */
  summary: string;
  /** SHA-256 or another stable identifier of the planned artifact set. */
  fingerprint?: string;
  /** Optional machine-readable details.  Must not contain plaintext secrets. */
  details?: Record<string, unknown>;
}

export interface SystemMigration {
  /** Уникальный отсортированный id. Формат: `<YYYY-MM-DD>-<NNN>-<slug>`. */
  id: string;

  /** Человекочитаемое описание (одной строкой). */
  description: string;

  /** Pre-flight проверка. Если { ok: false } — миграция не запускается, runner падает с reason. */
  preflight?(ctx: MigrationContext): Promise<{ ok: boolean; reason?: string }>;

  /**
   * Zero-write planning hook.  The runner calls this for `up --dry-run`; a
   * pending migration without a plan is rejected rather than risk executing
   * an old `up()` implementation against production state.
   */
  plan?(ctx: MigrationContext): Promise<MigrationPlan>;

  /** Главная логика. ИДЕМПОТЕНТНАЯ. */
  up(ctx: MigrationContext): Promise<void>;

  /** Опциональный откат. Вызывается только вручную (`runner.js down <id>`). */
  down?(ctx: MigrationContext): Promise<void>;
}
