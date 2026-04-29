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
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { PrismaClient } from '@prisma/client';

import type { MigrationContext, SystemMigration } from './system/_types';

const execFileP = promisify(execFile);

// =============================================================================
// CLI
// =============================================================================

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'status';
  const dryRun = argv.includes('--dry-run');
  const verbose = argv.includes('--verbose') || argv.includes('-v');

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
    } else {
      console.error(`Unknown command: ${cmd}`);
      console.error('Usage: runner.js [up|status|down <id>] [--dry-run] [--verbose]');
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
    const appliedIds = new Set(applied.map((m) => m.id));

    // Проверяем чексумы уже применённых — warning если кто-то задним числом отредактировал.
    for (const m of all) {
      if (appliedIds.has(m.id)) {
        const stored = applied.find((a) => a.id === m.id);
        if (stored && stored.checksum !== m.checksum) {
          console.warn(
            `[migrate] WARNING: миграция ${m.id} была изменена после применения (` +
              `stored=${stored.checksum.slice(0, 12)}, current=${m.checksum.slice(0, 12)}). ` +
              `Это значит, кто-то отредактировал файл миграции после её применения. Не делай так.`,
          );
        }
      }
    }

    const pending = all.filter((m) => !appliedIds.has(m.id));
    if (pending.length === 0) {
      console.log('[migrate] Pending: 0. Всё применено.');
      return;
    }
    console.log(`[migrate] Pending: ${pending.length}.`);
    for (const m of pending) console.log(`  · ${m.id} — ${m.module.description}`);

    if (this.opts.dryRun) {
      console.log('[migrate] --dry-run: миграции не применяются.');
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

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

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
      await m.module.up(ctx);
    } catch (e) {
      ok = false;
      errMsg = (e as Error).stack ?? (e as Error).message;
      logBuffer += `\nERROR: ${errMsg}\n`;
    }

    const durationMs = Date.now() - start;
    await this.prisma.systemMigration.create({
      data: {
        id: m.id,
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
    const stateDir = process.env.MEOWBOX_STATE_DIR ?? path.join(this.panelDir, 'state');
    const currentDir = process.env.MEOWBOX_CURRENT_DIR ?? this.panelDir;
    return {
      prisma: this.prisma,
      exec: {
        async run(cmd, args, opts) {
          const r = await execFileP(cmd, args, { cwd: opts?.cwd, env: opts?.env, maxBuffer: 50 * 1024 * 1024 });
          return { stdout: r.stdout.toString(), stderr: r.stderr.toString() };
        },
        async runShell(script, opts) {
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
      async writeFile(p: string, content: string, mode?: number) {
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, content, { mode });
      },
      log: (msg: string) => console.log(`[migrate]     ${msg}`),
      config: {
        panelDir: this.panelDir,
        currentDir,
        stateDir,
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
