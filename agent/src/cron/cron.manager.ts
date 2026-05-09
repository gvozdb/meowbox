import { CommandExecutor } from '../command-executor';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const MEOWBOX_MARKER = '# meowbox:';

/**
 * Allowlist для имени Linux-юзера, под которым запускается crontab.
 * ВАЖНО: это значение попадает в argv `crontab -u {user}` (через execFile,
 * без shell). Но на всякий случай ещё и валидируем — defense in depth.
 */
const SAFE_USER = /^[a-z_][a-z0-9_-]{0,31}$/;

/**
 * Запрещаем управляющие символы в команде — иначе пользователь может внедрить
 * новую строку в crontab-файл. API-уровень тоже валидирует, но тут — последний
 * рубеж (на случай, если вызов agent'а произошёл из другого пути).
 */
const FORBIDDEN_CONTROL = /[\x00-\x09\x0b-\x1f\x7f]/;

interface CronJob {
  id: string;
  schedule: string;
  command: string;
  enabled: boolean;
  /**
   * Linux-юзер, под которым выполнять cron-задачу. Обязательный для per-site
   * изоляции. Fallback на `root` — для legacy API-вызовов без этого поля.
   */
  user?: string;
}

interface CronResult {
  success: boolean;
  error?: string;
}

export class CronManager {
  private executor: CommandExecutor;

  constructor() {
    this.executor = new CommandExecutor();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private resolveUser(u?: string): string {
    const user = (u || 'root').trim();
    if (!SAFE_USER.test(user)) {
      throw new Error(`Invalid cron user: "${user}"`);
    }
    return user;
  }

  private validateJob(job: CronJob): void {
    // Schedule: 5 полей через пробел/таб, только [\d*,/-]
    if (!/^[\d*,/-]+(?:[ \t]+[\d*,/-]+){4}$/.test(job.schedule)) {
      throw new Error('Invalid cron schedule');
    }
    if (FORBIDDEN_CONTROL.test(job.command)) {
      throw new Error('Command contains forbidden control characters');
    }
    if (job.command.includes(MEOWBOX_MARKER)) {
      throw new Error('Command cannot contain reserved marker');
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(job.id)) {
      throw new Error('Invalid job id');
    }
  }

  private async readUserCrontab(user: string): Promise<string[]> {
    // `crontab -l` возвращает 1 если crontab пустой — это норма, не ошибка.
    const r = await this.executor.execute('crontab', ['-u', user, '-l'], { allowFailure: true });
    if (r.exitCode !== 0) return [];
    return r.stdout.split('\n');
  }

  private async writeUserCrontab(user: string, lines: string[]): Promise<void> {
    const content = lines.filter((l) => l !== '').join('\n') + '\n';
    const tmpFile = path.join(
      os.tmpdir(),
      `meowbox-crontab-${user}-${Date.now()}-${process.pid}`,
    );
    await fs.writeFile(tmpFile, content, { mode: 0o600 });
    try {
      // Хотим контекстную ошибку (включая stderr crontab) — allowFailure + throw.
      const r = await this.executor.execute('crontab', ['-u', user, tmpFile], { allowFailure: true });
      if (r.exitCode !== 0) {
        throw new Error(r.stderr || 'crontab install failed');
      }
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Sync: перезапись всех meowbox-managed entries в crontab ЦЕЛЕВОГО юзера.
   * Все jobs должны быть ОДНОГО user'а (группировка делается на API).
   */
  async syncJobs(jobs: CronJob[], userHint?: string): Promise<CronResult> {
    try {
      if (jobs.length === 0 && !userHint) return { success: true };
      const user = this.resolveUser(jobs[0]?.user || userHint);
      for (const j of jobs) {
        if (this.resolveUser(j.user) !== user) {
          throw new Error('All jobs in sync must belong to the same user');
        }
        this.validateJob(j);
      }

      const current = await this.readUserCrontab(user);
      const other = current.filter((l) => !l.includes(MEOWBOX_MARKER));
      const meow = jobs.map((j) => {
        const prefix = j.enabled ? '' : '# ';
        return `${prefix}${j.schedule} ${j.command} ${MEOWBOX_MARKER}${j.id}`;
      });

      await this.writeUserCrontab(user, [...other, ...meow]);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async addJob(job: CronJob): Promise<CronResult> {
    try {
      this.validateJob(job);
      const user = this.resolveUser(job.user);
      const current = await this.readUserCrontab(user);

      const filtered = current
        .filter((l) => l.trim())
        .filter((l) => !l.includes(`${MEOWBOX_MARKER}${job.id}`));

      const prefix = job.enabled ? '' : '# ';
      filtered.push(
        `${prefix}${job.schedule} ${job.command} ${MEOWBOX_MARKER}${job.id}`,
      );

      await this.writeUserCrontab(user, filtered);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async removeJob(jobId: string, userHint?: string): Promise<CronResult> {
    try {
      if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) throw new Error('Invalid job id');
      const user = this.resolveUser(userHint);
      const current = await this.readUserCrontab(user);
      if (current.length === 0) return { success: true };

      const lines = current
        .filter((l) => !l.includes(`${MEOWBOX_MARKER}${jobId}`))
        .filter((l) => l.trim());

      await this.writeUserCrontab(user, lines);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Миграция: переносит meowbox-entries из root crontab в per-user crontabs.
   * Вызывается один раз при старте API. `resolve(id) → user` — колбэк с
   * маппингом jobId → systemUser (API знает по БД). Entries без маппинга
   * остаются в root и логируются как orphans.
   */
  async migrateFromRoot(
    resolve: (id: string) => string | undefined,
  ): Promise<{ moved: number; orphans: string[]; errors: string[] }> {
    const moved: Array<{ user: string; line: string; id: string }> = [];
    const orphans: string[] = [];
    const errors: string[] = [];

    const rootCron = await this.readUserCrontab('root');
    const meowLines = rootCron.filter((l) => l.includes(MEOWBOX_MARKER));
    if (meowLines.length === 0) return { moved: 0, orphans: [], errors: [] };

    // Парсим id каждой строки.
    for (const line of meowLines) {
      const m = line.match(new RegExp(`${MEOWBOX_MARKER}([a-zA-Z0-9_-]+)`));
      if (!m) continue;
      const id = m[1];
      const user = resolve(id);
      if (!user) {
        orphans.push(id);
        continue;
      }
      moved.push({ user, line, id });
    }

    // Группируем по user'у и добавляем в их crontab.
    const byUser = new Map<string, string[]>();
    for (const m of moved) {
      const arr = byUser.get(m.user) || [];
      arr.push(m.line);
      byUser.set(m.user, arr);
    }
    for (const [user, lines] of byUser) {
      try {
        const safeUser = this.resolveUser(user);
        const current = await this.readUserCrontab(safeUser);
        const withoutOld = current.filter(
          (l) => !moved.some((m) => m.user === safeUser && l.includes(`${MEOWBOX_MARKER}${m.id}`)),
        );
        await this.writeUserCrontab(safeUser, [...withoutOld, ...lines]);
      } catch (e) {
        errors.push(`${user}: ${(e as Error).message}`);
      }
    }

    // Чистим root crontab: удаляем только те meowbox-entries, которые
    // успешно перенесены (orphans оставляем — иначе можно потерять данные).
    try {
      const movedIds = new Set(moved.map((m) => m.id));
      const rootKept = rootCron.filter((l) => {
        if (!l.includes(MEOWBOX_MARKER)) return true;
        const m = l.match(new RegExp(`${MEOWBOX_MARKER}([a-zA-Z0-9_-]+)`));
        if (!m) return true;
        return !movedIds.has(m[1]); // keep orphans
      });
      await this.writeUserCrontab('root', rootKept);
    } catch (e) {
      errors.push(`root cleanup: ${(e as Error).message}`);
    }

    return { moved: moved.length, orphans, errors };
  }
}
