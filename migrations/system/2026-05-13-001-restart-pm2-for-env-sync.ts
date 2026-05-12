/**
 * Принудительный pm2 reload с пересозданием процессов для подхвата нового
 * ecosystem.config.js (в нём добавлен спред `...envVars` в COMMON_ENV).
 *
 * Контекст:
 *   - До v0.6.31 `ecosystem.config.js` не пробрасывал ADMINER_SSO_KEY (и другие
 *     криптоключи из state/.env) в PM2 env API. NestJS ConfigModule читал
 *     `../.env` относительно cwd, что в release-раскладке указывает на
 *     `current/.env` (которого нет — env живёт в state/.env).
 *   - В результате API получал ADMINER_SSO_KEY из shell-env, в котором pm2
 *     был запущен изначально (через установщик или systemd unit). При смене
 *     master-key bootstrap'ом ADMINER_SSO_KEY в state/.env обновлялся, PHP-FPM
 *     pool тоже обновлялся через миграцию resync-adminer-sso → но API
 *     продолжал шифровать тикеты старым ключом → "Ticket невалиден" в PHP.
 *   - Исправлено в v0.6.31 двумя путями:
 *       a) `ecosystem.config.js` теперь делает `...envVars` в COMMON_ENV
 *          (все переменные из state/.env, включая ADMINER_SSO_KEY, попадают в env).
 *       b) `api/src/app.module.ts` ConfigModule.envFilePath = DOTENV_PATH
 *          (резолвится в state/.env), fallback на `../.env`.
 *
 * Зачем эта миграция:
 *   - `pm2 restart <name> --update-env` НЕ перечитывает ecosystem.config.js,
 *     он только обновляет env процесса из in-memory PM2 конфига. То есть
 *     `make update` сам по себе НЕ применит новый ecosystem.config.js.
 *   - Чтобы PM2 перечитал файл, нужен либо `pm2 delete <name> && pm2 start file`,
 *     либо `pm2 reload file`.
 *
 * Что делает (идемпотентно):
 *   1. Читает ADMINER_SSO_KEY из state/.env, считает fingerprint.
 *   2. Находит pid процесса meowbox-api, читает /proc/<pid>/environ →
 *      ADMINER_SSO_KEY value → fingerprint.
 *   3. Если fingerprint совпадает → миграция уже была применена / env синхронен,
 *      пропускает.
 *   4. Иначе → `pm2 delete meowbox-api meowbox-agent meowbox-web ; pm2 start ecosystem.config.js`
 *      (delete тоже идемпотентен: если процесс уже удалён → ок).
 *   5. Ждёт 5 секунд, проверяет статус online и повторно сверяет fingerprint.
 */

import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

import type { MigrationContext, SystemMigration } from './_types';

const PROCESSES = ['meowbox-api', 'meowbox-agent', 'meowbox-web'];

function fingerprint(b64: string | null | undefined): string {
  if (!b64) return 'empty';
  try {
    const raw = Buffer.from(b64.trim(), 'base64');
    if (raw.length !== 32) return `badlen:${raw.length}`;
    return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
  } catch {
    return 'invalid-base64';
  }
}

async function readSsoKeyFromEnv(ctx: MigrationContext): Promise<string | null> {
  const envFile = path.join(ctx.config.stateDir, '.env');
  if (!(await ctx.exists(envFile))) return null;
  const raw = await ctx.readFile(envFile);
  const m = raw.match(/^\s*ADMINER_SSO_KEY\s*=\s*"?([A-Za-z0-9+/=]+)"?\s*$/m);
  return m ? m[1].trim() : null;
}

interface Pm2Process {
  name?: string;
  pid?: number;
  pm2_env?: { status?: string };
}

async function pm2List(ctx: MigrationContext): Promise<Pm2Process[]> {
  try {
    const res = await ctx.exec.run('pm2', ['jlist'], { env: process.env });
    const parsed = JSON.parse(res.stdout || '[]');
    return Array.isArray(parsed) ? (parsed as Pm2Process[]) : [];
  } catch {
    return [];
  }
}

function readProcEnv(pid: number): Record<string, string> {
  try {
    const buf = fs.readFileSync(`/proc/${pid}/environ`);
    const out: Record<string, string> = {};
    for (const chunk of buf.toString('utf8').split('\0')) {
      const eq = chunk.indexOf('=');
      if (eq <= 0) continue;
      out[chunk.slice(0, eq)] = chunk.slice(eq + 1);
    }
    return out;
  } catch {
    return {};
  }
}

async function getApiSsoFingerprint(ctx: MigrationContext): Promise<string | null> {
  const list = await pm2List(ctx);
  const api = list.find((p) => p.name === 'meowbox-api');
  if (!api?.pid) return null;
  const env = readProcEnv(api.pid);
  return fingerprint(env.ADMINER_SSO_KEY ?? null);
}

const migration: SystemMigration = {
  id: '2026-05-13-001-restart-pm2-for-env-sync',
  description: 'Восстановить env API/agent/web из обновлённого ecosystem.config.js (фикс рассинхрона Adminer SSO)',

  async up(ctx) {
    const ecosystem = path.join(ctx.config.panelDir, 'ecosystem.config.js');
    if (!(await ctx.exists(ecosystem))) {
      ctx.log(`ecosystem.config.js не найден на ${ecosystem} — skip`);
      return;
    }

    const envKey = await readSsoKeyFromEnv(ctx);
    if (!envKey) {
      ctx.log('ADMINER_SSO_KEY в state/.env отсутствует — пропускаю (master-key bootstrap должен был его создать)');
      return;
    }
    const envFp = fingerprint(envKey);
    ctx.log(`ADMINER_SSO_KEY fingerprint в state/.env: ${envFp}`);

    const apiFpBefore = await getApiSsoFingerprint(ctx);
    if (apiFpBefore === envFp) {
      ctx.log(`API уже использует тот же ключ (fp=${apiFpBefore}) — env синхронен, skip`);
      return;
    }
    ctx.log(`API использует другой ключ (fp=${apiFpBefore ?? 'unknown'}) — требуется пересоздать процессы`);

    if (ctx.dryRun) {
      ctx.log(`would: pm2 delete ${PROCESSES.join(' ')} && pm2 start ${ecosystem} --update-env`);
      return;
    }

    // pm2 delete каждого по очереди — best-effort, не падаем если процесса нет.
    for (const name of PROCESSES) {
      try {
        await ctx.exec.runShell(`timeout 15 pm2 delete ${name} 2>&1 || true`);
      } catch {
        /* ok */
      }
    }

    // Старт из обновлённого ecosystem.config.js — гарантированно перечитает
    // ...envVars (новое поведение) и пробросит ADMINER_SSO_KEY в env.
    try {
      await ctx.exec.runShell(`timeout 60 pm2 start ${ecosystem} --update-env 2>&1`);
    } catch (err) {
      throw new Error(
        `pm2 start ${ecosystem} упал: ${(err as Error).message}. ` +
          `Проверь pm2 logs; возможно потребуется ручной запуск.`,
      );
    }

    // Сохраним dump чтобы pm2 поднял процессы автоматически после reboot.
    try {
      await ctx.exec.runShell('pm2 save 2>&1 || true');
    } catch {
      /* not critical */
    }

    // Дать API подняться и проверить что env действительно подхватился.
    await new Promise((r) => setTimeout(r, 5000));
    const apiFpAfter = await getApiSsoFingerprint(ctx);
    if (apiFpAfter !== envFp) {
      throw new Error(
        `После pm2 start API всё ещё использует другой ключ (fp=${apiFpAfter ?? 'unknown'}, ожидался ${envFp}). ` +
          `Возможные причины: ecosystem.config.js устарел (требуется make update), shell env переопределяет ADMINER_SSO_KEY. ` +
          `Проверь: cat /proc/$(pgrep -f api/dist/main.js | head -1)/environ | tr '\\0' '\\n' | grep ADMINER_SSO_KEY`,
      );
    }
    ctx.log(`OK: API подхватил правильный ключ (fp=${apiFpAfter})`);

    // Также проверим статус всех трёх процессов.
    const list = await pm2List(ctx);
    for (const name of PROCESSES) {
      const proc = list.find((p) => p.name === name);
      const status = proc?.pm2_env?.status ?? 'missing';
      if (status !== 'online') {
        ctx.log(`WARN: ${name} в статусе '${status}' (ожидался 'online')`);
      } else {
        ctx.log(`OK: ${name} online`);
      }
    }
  },
};

export default migration;
