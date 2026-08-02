/**
 * System migrations runner.
 *
 * Запускается:
 *   node migrations/dist/runner.js up           # apply all pending
 *   node migrations/dist/runner.js status       # list applied/pending
 *   node migrations/dist/runner.js down <id>    # rollback одной миграции (если есть down())
 *   node migrations/dist/runner.js up --dry-run # симуляция без записи изменений
 *
 * Применяется автоматически в make update после prisma migrate deploy.
 */
import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { PrismaClient } from '@prisma/client';

import { applySystemMigrationWithCompatibility } from './system-apply-compat';
import { planLegacySystemMigration } from './system-plan-compat';
import { assessSystemMigrationHistory } from './system-history';
import type {
  MigrationContext,
  MigrationPlan,
  SystemMigration,
} from './system/_types';

const execFileP = promisify(execFile);
const DOMAIN_APPLICATION_MIGRATION_ID = 'z20260731000000_domain_centric_applications';
const FRESH_INSTALL_BASELINE_COMMAND = 'baseline-fresh-install';

interface SqliteNameRow {
  name: string;
}

interface SqliteCountRow {
  count: bigint | number;
}

interface SqliteIntegrityRow {
  integrity_check: string;
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function countValue(rows: SqliteCountRow[], label: string): number {
  if (rows.length !== 1) {
    throw new Error(`Fresh-install baseline could not verify ${label}`);
  }
  const count = Number(rows[0].count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Fresh-install baseline received an invalid ${label} count`);
  }
  return count;
}

/**
 * Run direct system-migration invocations under the same advisory OS lock as
 * tools/update.sh.  The updater sets MEOWBOX_RELEASE_LOCK_HELD=1 after it has
 * acquired the descriptor itself, so a child runner does not attempt to nest
 * a second flock.
 */
function ensureReleaseFlock(readOnly: boolean): void {
  if (process.env.MEOWBOX_RELEASE_LOCK_HELD === '1') return;

  const panelDir = path.resolve(__dirname, '..', '..');
  const stateDir = process.env.MEOWBOX_STATE_DIR ?? path.join(panelDir, 'state');
  const migrationStateDir = process.env.MEOWBOX_MIGRATION_STATE_DIR ?? path.join(stateDir, 'data', 'migrations');
  const lockFile = process.env.MEOWBOX_RELEASE_LOCK_FILE ?? path.join(migrationStateDir, 'release-update.lock');
  if (readOnly) {
    if (!existsSync(path.dirname(lockFile)) || !existsSync(lockFile)) {
      throw new Error(
        `Read-only runner requires the pre-initialised release flock: ${lockFile}. ` +
        'Complete installation before running a dry-run or status check.',
      );
    }
  } else {
    try {
      mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new Error(`Cannot create release lock directory for ${lockFile}: ${(error as Error).message}`);
    }
  }

  const child = spawnSync(
    'flock',
    ['-n', lockFile, process.execPath, ...process.execArgv, __filename, ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: { ...process.env, MEOWBOX_RELEASE_LOCK_HELD: '1', MEOWBOX_RELEASE_LOCK_FILE: lockFile },
    },
  );
  if (child.error) {
    throw new Error(`Cannot acquire release flock (${lockFile}): ${child.error.message}`);
  }
  process.exit(child.status ?? 1);
}

async function assertNoSymlinkPathComponents(destination: string): Promise<void> {
  const absolute = path.resolve(destination);
  const parsed = path.parse(absolute);
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const component of components) {
    current = path.join(current, component);
    try {
      const metadata = await fs.lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Refusing managed write through symlink path component: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

/** Atomic write with fsync and preserved owner/mode for managed config files. */
async function atomicWriteText(
  destination: string,
  content: string,
  mode?: number,
  ownership?: { uid: number; gid: number },
): Promise<void> {
  // A managed config target must be a real file.  Following a pre-existing
  // symlink would let a permitted /etc path redirect an atomic write to an
  // unrelated file (for example /etc/passwd).  Replacing a symlink is also
  // not an implicit supported operation: the renderer must model symlinks via
  // its own explicit, validated runtime integration.
  await assertNoSymlinkPathComponents(destination);
  const destinationMetadata = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (destinationMetadata?.isSymbolicLink()) {
    throw new Error(`Refusing to write managed config through symlink: ${destination}`);
  }
  const writePath = destination;
  const dir = path.dirname(writePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPathComponents(destination);
  const existing = await fs.stat(writePath).catch(() => null);
  const finalMode = mode ?? (existing ? existing.mode & 0o7777 : undefined);
  const temporary = path.join(
    dir,
    `.${path.basename(writePath)}.meowbox-migration-${process.pid}-${randomUUID()}`,
  );
  try {
    const handle = await fs.open(temporary, 'wx', finalMode);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (ownership) {
      await fs.chown(temporary, ownership.uid, ownership.gid);
    } else if (existing) {
      await fs.chown(temporary, existing.uid, existing.gid);
    }
    if (finalMode !== undefined) await fs.chmod(temporary, finalMode);
    await fs.rename(temporary, writePath);
    const directory = await fs.open(dir, 'r').catch(() => null);
    if (directory) {
      try {
        await directory.sync().catch(() => {});
      } finally {
        await directory.close();
      }
    }
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

/**
 * Prisma exposes model delegates dynamically.  The planning context gets a
 * defensive proxy that rejects every mutator even if a future migration
 * accidentally calls `create`/`update` during `plan()` or `preflight()`.
 */
function assertReadOnlyRawQuery(args: readonly unknown[], method: string): void {
  const first = args[0] as { raw?: readonly string[] } | undefined;
  const text = typeof first === 'string'
    ? first
    : Array.isArray(first?.raw) ? first.raw.join('?') : null;
  if (text === null) {
    throw new Error(`Prisma ${method} is forbidden in a read-only migration plan without a static SQL statement`);
  }
  const statement = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim().replace(/;\s*$/, '');
  if (statement.includes(';')) {
    throw new Error(`Prisma ${method} has multiple statements in a read-only migration plan`);
  }
  const allowed = /^(?:EXPLAIN\s+)?SELECT\b/i.test(statement)
    || /^PRAGMA\s+(?:table_(?:info|xinfo)|foreign_key_check|integrity_check|application_id|user_version)\b/i.test(statement);
  if (!allowed) {
    throw new Error(`Prisma ${method} is not a permitted read-only SELECT/PRAGMA statement`);
  }
}

function readOnlyPrismaClient(prisma: PrismaClient): PrismaClient {
  const mutationMethods = new Set([
    'create', 'createMany', 'createManyAndReturn', 'update', 'updateMany',
    'updateManyAndReturn', 'upsert', 'delete', 'deleteMany',
  ]);
  const topLevelMutators = new Set([
    '$executeRaw', '$executeRawUnsafe', '$transaction', '$extends',
  ]);
  const rawReadMethods = new Set(['$queryRaw', '$queryRawUnsafe']);
  return new Proxy(prisma, {
    get(target, property, receiver) {
      if (typeof property === 'string' && topLevelMutators.has(property)) {
        return () => {
          throw new Error(`Prisma ${property} is forbidden in a read-only migration plan`);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property === 'string' && rawReadMethods.has(property)) {
        if (typeof value !== 'function') throw new Error(`Prisma ${property} is unavailable`);
        return (...args: unknown[]) => {
          assertReadOnlyRawQuery(args, property);
          return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
        };
      }
      if (!value || typeof value !== 'object' || typeof property !== 'string' || property.startsWith('$')) {
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
      return new Proxy(value, {
        get(delegate, method, delegateReceiver) {
          if (typeof method === 'string' && mutationMethods.has(method)) {
            return () => {
              throw new Error(`Prisma delegate ${property}.${method} is forbidden in a read-only migration plan`);
            };
          }
          const delegateValue = Reflect.get(delegate, method, delegateReceiver) as unknown;
          return typeof delegateValue === 'function'
            ? (delegateValue as (...args: unknown[]) => unknown).bind(delegate)
            : delegateValue;
        },
      });
    },
  }) as PrismaClient;
}

// =============================================================================
// CLI
// =============================================================================

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'status';
  const dryRun = argv.includes('--dry-run');
  const verbose = argv.includes('--verbose') || argv.includes('-v');
  ensureReleaseFlock(dryRun || cmd === 'status');

  const runner = new MigrationsRunner({ dryRun, verbose });
  try {
    if (cmd === 'up') {
      await runner.up();
    } else if (cmd === 'status') {
      await runner.status();
    } else if (cmd === 'down') {
      const id = argv[1];
      if (!id) throw new Error('Usage: runner.js down <migration-id>');
      await runner.down(id);
    } else if (cmd === FRESH_INSTALL_BASELINE_COMMAND) {
      if (!argv.includes('--fresh-install')) {
        throw new Error(
          `Usage: runner.js ${FRESH_INSTALL_BASELINE_COMMAND} --fresh-install`,
        );
      }
      if (dryRun) {
        throw new Error(`${FRESH_INSTALL_BASELINE_COMMAND} does not accept --dry-run`);
      }
      await runner.baselineFreshInstall();
    } else {
      console.error(`Unknown command: ${cmd}`);
      console.error(
        `Usage: runner.js [up|status|down <id>|${FRESH_INSTALL_BASELINE_COMMAND} --fresh-install] ` +
          '[--dry-run] [--verbose]',
      );
      process.exit(2);
    }
  } catch (e) {
    console.error('[migrate] FAILED:', (e as Error).message);
    if (verbose) console.error((e as Error).stack);
    process.exit(1);
  }
}

// =============================================================================
// Runner
// =============================================================================

interface RunnerOptions {
  dryRun: boolean;
  verbose: boolean;
}

class MigrationsRunner {
  private readonly prisma: PrismaClient;
  private readonly opts: RunnerOptions;
  private readonly systemDir: string;
  private readonly panelDir: string;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
    this.prisma = new PrismaClient();
    // runner.js лежит в migrations/dist/runner.js. Скомпилированные миграции —
    // в migrations/dist/system/*.js (рядом с runner.js).
    // panelDir = migrations/.. = /opt/meowbox (или releases/<v>/).
    this.systemDir = path.join(__dirname, 'system');
    this.panelDir = path.resolve(__dirname, '..', '..');
  }

  async up(): Promise<void> {
    const all = await this.discoverMigrations();
    const applied = await this.getApplied();
    const history = assessSystemMigrationHistory(all, applied);
    const appliedIds = new Set(applied.filter((m) => m.ok).map((m) => m.id));

    for (const accepted of history.acceptedLegacy) {
      console.log(
        `[migrate] accepted legacy history: ${accepted.id} (${accepted.kind})`,
      );
    }

    const pending = all.filter((m) => !appliedIds.has(m.id));
    if (pending.length === 0) {
      console.log('[migrate] Pending: 0. Всё применено.');
      return;
    }
    console.log(`[migrate] Pending: ${pending.length}.`);
    for (const m of pending) console.log(`  · ${m.id} — ${m.module.description}`);

    if (this.opts.dryRun) {
      // Do not call up() in a dry-run. Historical migrations predate the
      // release transaction contract and some have side effects outside the
      // database. A migration must provide a native zero-write plan or match
      // an exact reviewed artifact in the compatibility planner.
      for (const m of pending) {
        const ctx = this.makeContext();
        let plan: MigrationPlan | null;
        if (m.module.plan) {
          if (m.module.preflight) {
            const pf = await m.module.preflight(ctx);
            if (!pf.ok) throw new Error(`Preflight failed for ${m.id}: ${pf.reason ?? '(no reason)'}`);
          }
          plan = await m.module.plan(ctx);
        } else {
          plan = await planLegacySystemMigration(
            { id: m.id, checksum: m.checksum },
            ctx,
          );
        }
        if (!plan) {
          throw new Error(
            `Pending system migration ${m.id} has no native or ` +
            'checksum-bound zero-write plan; dry-run refuses to execute ' +
            'up() against production state.',
          );
        }
        console.log(`[migrate] plan ${m.id}: ${plan.summary}`);
        if (plan.fingerprint) console.log(`[migrate]   plan-fingerprint=${plan.fingerprint}`);
      }
      console.log('[migrate] --dry-run: all pending migrations planned with zero writes.');
      return;
    }

    for (const m of pending) {
      await this.applyOne(m);
    }
    console.log(`[migrate] OK: применено ${pending.length} миграций.`);
  }

  async status(): Promise<void> {
    const all = await this.discoverMigrations();
    const applied = await this.getApplied();
    const appliedMap = new Map(applied.map((a) => [a.id, a]));

    console.log('Системные миграции:');
    for (const m of all) {
      const a = appliedMap.get(m.id);
      const status = a ? (a.ok ? '✓ applied' : '✗ FAILED ') : '· pending';
      const t = a ? ` (${a.appliedAt.toISOString().slice(0, 19).replace('T', ' ')}, ${a.durationMs}ms)` : '';
      console.log(`  ${status}  ${m.id.padEnd(50)} ${m.module.description}${t}`);
    }
    const orphans = applied.filter((a) => !all.find((m) => m.id === a.id));
    if (orphans.length) {
      console.log('\nОsiротевшие записи в БД (файла миграции нет):');
      for (const o of orphans) console.log(`  ? ${o.id} (applied ${o.appliedAt.toISOString()})`);
    }
  }

  async down(id: string): Promise<void> {
    const all = await this.discoverMigrations();
    const target = all.find((m) => m.id === id);
    if (!target) throw new Error(`Миграция не найдена: ${id}`);
    if (!target.module.down) throw new Error(`У миграции ${id} нет down() — откат невозможен`);

    const applied = await this.prisma.systemMigration.findUnique({ where: { id } });
    if (!applied) throw new Error(`Миграция ${id} не применена — нечего откатывать`);

    const ctx = this.makeContext();
    if (this.opts.dryRun) {
      console.log(`[migrate] --dry-run: would call down() для ${id}`);
      return;
    }
    console.log(`[migrate] Rolling back: ${id}`);
    await target.module.down(ctx);
    await this.prisma.systemMigration.delete({ where: { id } });
    console.log(`[migrate] OK: ${id} rolled back`);
  }

  /**
   * A fresh Prisma install already represents the current release and must not
   * replay historical host mutations on its first update.  Record the exact
   * compiled artifacts only after proving that the database has the final
   * schema and contains no application or operator data.
   */
  async baselineFreshInstall(): Promise<void> {
    const all = await this.discoverMigrations();
    assessSystemMigrationHistory(all, []);

    const added = await this.prisma.$transaction(async (tx: PrismaClient) => {
      await this.assertFreshInstallDatabase(tx);

      const applied = await tx.systemMigration.findMany({ orderBy: { id: 'asc' } });
      const discovered = new Map(all.map((migration) => [migration.id, migration]));

      for (const row of applied) {
        const migration = discovered.get(row.id);
        if (!migration) {
          throw new Error(
            `Fresh-install baseline found an unknown system migration record: ${row.id}`,
          );
        }
        if (
          !row.ok ||
          row.errorLog !== null ||
          row.durationMs !== 0 ||
          row.checksum !== migration.checksum
        ) {
          throw new Error(
            `Fresh-install baseline record mismatch for ${row.id}; ` +
              'refusing to overwrite migration history',
          );
        }
      }

      const appliedIds = new Set(applied.map((migration) => migration.id));
      const pending = all.filter((migration) => !appliedIds.has(migration.id));
      if (pending.length === 0) return 0;

      for (const migration of pending) {
        await tx.systemMigration.create({
          data: {
            id: migration.id,
            durationMs: 0,
            checksum: migration.checksum,
            ok: true,
            errorLog: null,
          },
        });
      }
      return pending.length;
    });

    console.log(
      `[migrate] Fresh-install system baseline: ${all.length} known, ${added} added.`,
    );
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async assertFreshInstallDatabase(prisma: PrismaClient): Promise<void> {
    const tables = await prisma.$queryRawUnsafe<SqliteNameRow[]>(
      `SELECT "name"
       FROM "sqlite_master"
       WHERE "type" = 'table'
         AND "name" NOT LIKE 'sqlite_%'
       ORDER BY "name"`,
    );
    const tableNames = new Set(tables.map((table) => table.name));
    for (const required of ['_prisma_migrations', 'system_migrations', 'sites', 'site_domains']) {
      if (!tableNames.has(required)) {
        throw new Error(`Fresh-install baseline requires final table ${required}`);
      }
    }
    const stagingTables = tables
      .map((table) => table.name)
      .filter((name) => name.startsWith('_meowbox_'));
    if (stagingTables.length > 0) {
      throw new Error(
        `Fresh-install baseline found migration staging tables: ${stagingTables.join(', ')}`,
      );
    }

    const appliedDomainMigration = countValue(
      await prisma.$queryRawUnsafe<SqliteCountRow[]>(
        `SELECT COUNT(*) AS "count"
         FROM "_prisma_migrations"
         WHERE "migration_name" = ?
           AND "finished_at" IS NOT NULL
           AND "rolled_back_at" IS NULL
           AND "applied_steps_count" > 0`,
        DOMAIN_APPLICATION_MIGRATION_ID,
      ),
      'domain application Prisma migration',
    );
    if (appliedDomainMigration !== 1) {
      throw new Error(
        `Fresh-install baseline requires applied Prisma migration ${DOMAIN_APPLICATION_MIGRATION_ID}`,
      );
    }

    const interruptedPrismaMigrations = countValue(
      await prisma.$queryRawUnsafe<SqliteCountRow[]>(
        `SELECT COUNT(*) AS "count"
         FROM "_prisma_migrations"
         WHERE "finished_at" IS NULL OR "rolled_back_at" IS NOT NULL`,
      ),
      'interrupted Prisma migrations',
    );
    if (interruptedPrismaMigrations !== 0) {
      throw new Error('Fresh-install baseline refuses interrupted or rolled-back Prisma migrations');
    }

    const siteColumns = new Set(
      (
        await prisma.$queryRawUnsafe<SqliteNameRow[]>(
          'PRAGMA table_xinfo("sites")',
        )
      ).map((column) => column.name),
    );
    for (const removed of ['type', 'php_version', 'files_rel_path', 'app_port', 'env_vars']) {
      if (siteColumns.has(removed)) {
        throw new Error(`Fresh-install baseline found legacy sites.${removed}`);
      }
    }

    const domainColumns = new Set(
      (
        await prisma.$queryRawUnsafe<SqliteNameRow[]>(
          'PRAGMA table_xinfo("site_domains")',
        )
      ).map((column) => column.name),
    );
    for (const required of [
      'preset',
      'app_status',
      'files_rel_path',
      'runtime_key',
      'php_version',
      'app_port',
    ]) {
      if (!domainColumns.has(required)) {
        throw new Error(`Fresh-install baseline requires site_domains.${required}`);
      }
    }

    const integrity = await prisma.$queryRawUnsafe<SqliteIntegrityRow[]>(
      'PRAGMA integrity_check',
    );
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error('Fresh-install baseline requires a successful SQLite integrity_check');
    }
    const foreignKeyFailures = await prisma.$queryRawUnsafe<unknown[]>(
      'PRAGMA foreign_key_check',
    );
    if (foreignKeyFailures.length > 0) {
      throw new Error('Fresh-install baseline requires a successful SQLite foreign_key_check');
    }

    for (const table of tables) {
      if (table.name === '_prisma_migrations' || table.name === 'system_migrations') continue;
      const count = countValue(
        await prisma.$queryRawUnsafe<SqliteCountRow[]>(
          `SELECT COUNT(*) AS "count" FROM ${quoteSqliteIdentifier(table.name)}`,
        ),
        `${table.name} rows`,
      );
      if (count !== 0) {
        throw new Error(
          `Fresh-install baseline refuses non-empty application table ${table.name}`,
        );
      }
    }
  }

  private async discoverMigrations(): Promise<DiscoveredMigration[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.systemDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }

    const files = entries
      .filter((f) => (f.endsWith('.js') || f.endsWith('.ts')) && !f.startsWith('_') && f !== 'README.md')
      // в dist лежат только .js — игнорим .ts чтобы не загрузить дважды
      .filter((f) => f.endsWith('.js'));

    const out: DiscoveredMigration[] = [];
    for (const f of files) {
      const fullPath = path.join(this.systemDir, f);
      const content = await fs.readFile(fullPath, 'utf8');
      const checksum = createHash('sha256').update(content).digest('hex');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(fullPath);
      const migration: SystemMigration = mod.default ?? mod.migration;
      if (!migration || typeof migration.up !== 'function' || !migration.id) {
        throw new Error(`Файл миграции ${f}: должен экспортировать default или \`migration\` с полями { id, up }`);
      }
      const expectedId = f.replace(/\.js$/, '');
      if (migration.id !== expectedId) {
        throw new Error(`Файл ${f}: id="${migration.id}" не совпадает с именем файла "${expectedId}"`);
      }
      out.push({ id: migration.id, file: fullPath, checksum, module: migration });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  private async getApplied() {
    return this.prisma.systemMigration.findMany({ orderBy: { id: 'asc' } });
  }

  private async applyOne(m: DiscoveredMigration): Promise<void> {
    const ctx = this.makeContext();
    console.log(`[migrate] → ${m.id}`);

    if (m.module.preflight) {
      const pf = await m.module.preflight(ctx);
      if (!pf.ok) throw new Error(`Preflight failed for ${m.id}: ${pf.reason ?? '(no reason)'}`);
    }

    const start = Date.now();
    let ok = true;
    let errMsg: string | undefined;
    let logBuffer = '';
    const origLog = ctx.log;
    ctx.log = (msg: string) => {
      logBuffer += `${msg}\n`;
      origLog(msg);
    };

    try {
      await applySystemMigrationWithCompatibility(
        { id: m.id, checksum: m.checksum },
        m.module,
        ctx,
      );
    } catch (e) {
      ok = false;
      errMsg = (e as Error).stack ?? (e as Error).message;
      logBuffer += `\nERROR: ${errMsg}\n`;
    }

    const durationMs = Date.now() - start;
    await this.prisma.systemMigration.upsert({
      where: { id: m.id },
      create: {
        id: m.id,
        durationMs,
        checksum: m.checksum,
        ok,
        errorLog: ok ? null : logBuffer.slice(-32 * 1024),
      },
      update: {
        appliedAt: new Date(),
        durationMs,
        checksum: m.checksum,
        ok,
        errorLog: ok ? null : logBuffer.slice(-32 * 1024),
      },
    });

    if (!ok) throw new Error(`Migration ${m.id} failed: ${errMsg}`);
    console.log(`[migrate]   ✓ ${m.id} (${durationMs}ms)`);
  }

  private makeContext(): MigrationContext {
    const readOnly = this.opts.dryRun;
    const stateDir = process.env.MEOWBOX_STATE_DIR ?? path.join(this.panelDir, 'state');
    const currentDir = process.env.MEOWBOX_CURRENT_DIR ?? this.panelDir;
    const migrationStateDir = process.env.MEOWBOX_MIGRATION_STATE_DIR ?? path.join(stateDir, 'data', 'migrations');
    const releaseLockFile = process.env.MEOWBOX_RELEASE_LOCK_FILE ?? path.join(migrationStateDir, 'release-update.lock');
    const checkpointPath = (migrationId: string): string => {
      if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{3}-[a-z0-9-]+$/.test(migrationId)) {
        throw new Error(`Unsafe system migration checkpoint id: ${migrationId}`);
      }
      return path.join(migrationStateDir, `${migrationId}.json`);
    };
    return {
      prisma: readOnly ? readOnlyPrismaClient(this.prisma) : this.prisma,
      exec: {
        async run(cmd, args, opts) {
          if (readOnly) {
            throw new Error(`External command is forbidden in a read-only migration plan: ${cmd} ${args.join(' ')}`);
          }
          const r = await execFileP(cmd, args, { cwd: opts?.cwd, env: opts?.env, maxBuffer: 50 * 1024 * 1024 });
          return { stdout: r.stdout.toString(), stderr: r.stderr.toString() };
        },
        async runShell(script, opts) {
          if (readOnly) {
            throw new Error(`Shell execution is forbidden in a read-only migration plan: ${script.slice(0, 120)}`);
          }
          const r = await execFileP('/bin/bash', ['-c', script], { cwd: opts?.cwd, maxBuffer: 50 * 1024 * 1024 });
          return { stdout: r.stdout.toString(), stderr: r.stderr.toString() };
        },
      },
      async exists(p: string) {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      },
      async readFile(p: string) {
        return fs.readFile(p, 'utf8');
      },
      async writeFile(p: string, content: string, mode?: number, ownership?: { uid: number; gid: number }) {
        if (readOnly) throw new Error(`File write is forbidden in a read-only migration plan: ${p}`);
        await atomicWriteText(p, content, mode, ownership);
      },
      checkpoints: {
        async read<T>(migrationId: string): Promise<T | null> {
          const file = checkpointPath(migrationId);
          try {
            return JSON.parse(await fs.readFile(file, 'utf8')) as T;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw new Error(`Cannot read checkpoint ${file}: ${(error as Error).message}`);
          }
        },
        async write<T>(migrationId: string, value: T): Promise<void> {
          if (readOnly) throw new Error(`Checkpoint write is forbidden in a read-only migration plan: ${migrationId}`);
          const file = checkpointPath(migrationId);
          await atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`, 0o600);
        },
        async remove(migrationId: string): Promise<void> {
          if (readOnly) throw new Error(`Checkpoint removal is forbidden in a read-only migration plan: ${migrationId}`);
          await fs.unlink(checkpointPath(migrationId)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        },
        pathFor: checkpointPath,
      },
      log: (msg: string) => console.log(`[migrate]     ${msg}`),
      config: {
        panelDir: this.panelDir,
        currentDir,
        stateDir,
        migrationStateDir,
        releaseLockFile,
        sitesBasePath: process.env.SITES_BASE_PATH ?? '/var/www',
        nodeEnv: (process.env.NODE_ENV as 'production' | 'development') ?? 'production',
      },
      dryRun: this.opts.dryRun,
    };
  }
}

interface DiscoveredMigration {
  id: string;
  file: string;
  checksum: string;
  module: SystemMigration;
}

main();
