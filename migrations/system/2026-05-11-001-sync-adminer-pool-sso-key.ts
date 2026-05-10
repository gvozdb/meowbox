/**
 * Синхронизирует `env[ADMINER_SSO_KEY]` в php-fpm пуле `meowbox-adminer.conf`
 * с актуальным значением из `state/.env`.
 *
 * Контекст:
 *   - Миграция `2026-05-10-001-master-key-bootstrap` переписывает
 *     `ADMINER_SSO_KEY` в `.env` (теперь он деривится из master-key через HKDF).
 *   - Миграция `2026-04-30-006-install-adminer-on-existing` создаёт пул только
 *     если его ещё нет (`if (!exists)`), и НЕ обновляет существующий.
 *   - В результате php-fpm пул носит старый ADMINER_SSO_KEY и отдаёт его
 *     через `env[]` в процесс adminer. `lib/sso.php::meowbox_load_key()`
 *     читает `getenv()` приоритетнее `.env`, расшифровывает ticket старым
 *     ключом — GCM auth tag не сходится → "Ticket невалиден или подпись
 *     не сошлась" на /adminer/sso.php?ticket=…
 *
 * Что делает (идемпотентно):
 *   1. Находит ADMINER_SSO_KEY в state/.env (если нет — skip).
 *   2. Перебирает все версии php-fpm `/etc/php/<V>/fpm/pool.d/meowbox-adminer.conf`.
 *   3. Если в файле строка `env[ADMINER_SSO_KEY] = "..."` совпадает с .env — skip.
 *   4. Иначе sed-заменой подменяет значение, рестартит phpV-fpm.
 *
 * Что НЕ делает:
 *   - Не создаёт пул с нуля (это делает 2026-04-30-006).
 *   - Не трогает .env (это делает master-key bootstrap).
 */

import * as path from 'node:path';

import type { MigrationContext, SystemMigration } from './_types';

const PHP_VERSIONS = ['8.4', '8.3', '8.2', '8.1', '8.0', '7.4'];

async function readSsoKey(ctx: MigrationContext): Promise<string | null> {
  const envFile = path.join(ctx.config.stateDir, '.env');
  if (!(await ctx.exists(envFile))) return null;
  const raw = await ctx.readFile(envFile);
  const m = raw.match(/^\s*ADMINER_SSO_KEY\s*=\s*"?([A-Za-z0-9+/=]+)"?\s*$/m);
  return m ? m[1].trim() : null;
}

function escapeForReplacement(s: string): string {
  // sed/replace в JS — экранируем только символы, опасные внутри double-quoted
  // строки php-fpm.conf. Ключ — base64 → ничего особенного, но на всякий случай:
  return s.replace(/[\\"$`]/g, '\\$&');
}

const migration: SystemMigration = {
  id: '2026-05-11-001-sync-adminer-pool-sso-key',
  description: 'Синхронизировать env[ADMINER_SSO_KEY] в php-fpm пуле adminer с state/.env',

  async up(ctx) {
    const sso = await readSsoKey(ctx);
    if (!sso) {
      ctx.log('SKIP: ADMINER_SSO_KEY в state/.env не найден — нечего синхронизировать');
      return;
    }

    let touched = 0;
    for (const v of PHP_VERSIONS) {
      const poolPath = `/etc/php/${v}/fpm/pool.d/meowbox-adminer.conf`;
      if (!(await ctx.exists(poolPath))) continue;

      const conf = await ctx.readFile(poolPath);
      const current = conf.match(/^env\[ADMINER_SSO_KEY\]\s*=\s*"([^"]*)"/m)?.[1];
      if (current === sso) {
        ctx.log(`OK: php${v} pool уже синхронизирован с .env`);
        continue;
      }

      if (current === undefined) {
        ctx.log(`WARN: ${poolPath} — нет строки env[ADMINER_SSO_KEY]=..., пропускаю (нечего обновлять)`);
        continue;
      }

      if (ctx.dryRun) {
        ctx.log(`would rewrite env[ADMINER_SSO_KEY] in ${poolPath} (was: ${current.slice(0, 8)}..., new: ${sso.slice(0, 8)}...)`);
        continue;
      }

      const replaced = conf.replace(
        /^env\[ADMINER_SSO_KEY\]\s*=\s*"[^"]*"\s*$/m,
        `env[ADMINER_SSO_KEY] = "${escapeForReplacement(sso)}"`,
      );
      if (replaced === conf) {
        ctx.log(`WARN: ${poolPath} — regex не сматчился при записи, пропускаю`);
        continue;
      }
      await ctx.writeFile(poolPath, replaced);
      ctx.log(`OK: ${poolPath} — обновил env[ADMINER_SSO_KEY] (${current.slice(0, 8)}... → ${sso.slice(0, 8)}...)`);

      // Рестарт php-fpm — иначе процесс продолжает носить старый env.
      try {
        await ctx.exec.runShell(`systemctl restart php${v}-fpm.service`);
        ctx.log(`OK: php${v}-fpm перезапущен`);
      } catch (e) {
        ctx.log(`WARN: не смог перезапустить php${v}-fpm: ${(e as Error).message}`);
      }
      touched += 1;
    }

    if (touched === 0) {
      ctx.log('Нечего обновлять (все пулы уже синхронизированы либо их нет)');
    }
  },
};

export default migration;
