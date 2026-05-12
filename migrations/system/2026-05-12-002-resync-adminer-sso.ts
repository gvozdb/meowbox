/**
 * Принудительный ресинк Adminer SSO на УЖЕ установленных панелях.
 *
 * Контекст бага у заказчиков:
 *   - У некоторых клиентов /adminer/sso.php?ticket=… отдаёт
 *     "Ticket невалиден или подпись не сошлась" → ключи API и PHP-FPM pool
 *     разъехались.
 *   - Корни:
 *       a) master-key bootstrap (2026-05-10-001) переписал ADMINER_SSO_KEY
 *          в state/.env, но `sync-adminer-pool-sso-key` (2026-05-11-001)
 *          пропустил pool, если в нём не было строки `env[ADMINER_SSO_KEY] = "..."`
 *          (regex требует кавычки).
 *       b) PHP-FPM не был перезапущен после правки pool — старый env остался
 *          в работающих воркерах.
 *       c) `open_basedir` в pool не включал state/.env → PHP не мог fallback'нуть
 *          на .env при пустом getenv().
 *   - Второй баг (502): user `meowbox-adminer` не создан / pool не стартует →
 *     /run/php/meowbox-adminer.sock отсутствует → nginx 502.
 *
 * Что делает (идемпотентно, безопасно повторять):
 *   1. Создаёт user `meowbox-adminer` если нет.
 *   2. Безусловно перекопирует SSO-файлы из releases/<v>/tools/adminer-src/
 *      в state/adminer/{sso.php,index.php,lib/*} — фиксит протухший код
 *      (предыдущие миграции копирования (2026-05-06-003) сработали один раз).
 *   3. Для каждого установленного php-fpm:
 *      - если pool meowbox-adminer.conf отсутствует — пропускает (создаст 006).
 *      - safely переписывает / добавляет `env[ADMINER_SSO_KEY] = "..."`
 *        из state/.env (без условий на regex с кавычками).
 *      - гарантирует `open_basedir` содержит state/.env.
 *      - рестартит php-fpm.
 *   4. Проверяет /run/php/meowbox-adminer.sock после рестарта — если нет,
 *      логирует WARN с подсказкой смотреть php-fpm logs.
 */

import * as path from 'node:path';

import type { MigrationContext, SystemMigration } from './_types';

const PHP_VERSIONS = ['8.4', '8.3', '8.2', '8.1', '8.0', '7.4'];
const POOL_SOCK = '/run/php/meowbox-adminer.sock';

async function readSsoKey(ctx: MigrationContext): Promise<string | null> {
  const envFile = path.join(ctx.config.stateDir, '.env');
  if (!(await ctx.exists(envFile))) return null;
  const raw = await ctx.readFile(envFile);
  const m = raw.match(/^\s*ADMINER_SSO_KEY\s*=\s*"?([A-Za-z0-9+/=]+)"?\s*$/m);
  return m ? m[1].trim() : null;
}

async function ensureAdminerUser(ctx: MigrationContext): Promise<void> {
  const idCheck = await ctx.exec.runShell(`id -u meowbox-adminer 2>/dev/null || true`);
  if (idCheck.stdout.trim()) {
    return;
  }
  if (ctx.dryRun) {
    ctx.log('would create user meowbox-adminer');
    return;
  }
  // useradd без --system (см. memory: на этом проекте --system не используем),
  // зато с --no-create-home и nologin — это всё равно сервисный аккаунт.
  await ctx.exec.run('useradd', [
    '--shell', '/usr/sbin/nologin', '--no-create-home',
    '--user-group', 'meowbox-adminer',
  ]);
  await ctx.exec.runShell('usermod -aG www-data meowbox-adminer || true');
  ctx.log('OK: user meowbox-adminer создан');
}

async function copySsoFiles(ctx: MigrationContext): Promise<void> {
  const adminerDir = path.join(ctx.config.stateDir, 'adminer');
  if (!(await ctx.exists(adminerDir))) {
    if (ctx.dryRun) {
      ctx.log(`would mkdir ${adminerDir}/lib`);
    } else {
      await ctx.exec.run('mkdir', ['-p', path.join(adminerDir, 'lib')]);
    }
  }

  // Резолвим реальный путь release (currentDir — симлинк).
  const real = await ctx.exec.runShell(`readlink -f ${ctx.config.currentDir}`);
  const realCurrent = real.stdout.trim() || ctx.config.currentDir;
  const src = path.join(realCurrent, 'tools', 'adminer-src');

  if (!(await ctx.exists(src))) {
    ctx.log(`WARN: ${src} не найден — релиз не содержит SSO-сорцы. Пропускаю копирование файлов.`);
    return;
  }

  const required = ['sso.php', 'index.php', 'lib/sso.php', 'lib/meowbox-plugin.php'];
  for (const rel of required) {
    if (!(await ctx.exists(path.join(src, rel)))) {
      throw new Error(`в источнике ${src} нет ${rel} — релиз битый`);
    }
  }

  if (ctx.dryRun) {
    ctx.log(`would cp ${src}/{sso.php,index.php,lib/*} → ${adminerDir}/`);
    return;
  }

  await ctx.exec.runShell(`mkdir -p ${adminerDir}/lib`);
  await ctx.exec.runShell(`cp -a ${src}/sso.php   ${adminerDir}/sso.php`);
  await ctx.exec.runShell(`cp -a ${src}/index.php ${adminerDir}/index.php`);
  await ctx.exec.runShell(`rm -f ${adminerDir}/lib/*.php`);
  await ctx.exec.runShell(`cp -a ${src}/lib/. ${adminerDir}/lib/`);
  await ctx.exec.run('chown', ['-R', 'root:www-data', adminerDir]);
  await ctx.exec.runShell(`find ${adminerDir} -type d -exec chmod 750 {} \\;`);
  await ctx.exec.runShell(`find ${adminerDir} -type f -exec chmod 640 {} \\;`);
  ctx.log(`OK: SSO-файлы перекопированы из ${src}`);
}

function escapePoolValue(v: string): string {
  return v.replace(/[\\"$`]/g, '\\$&');
}

async function syncPool(ctx: MigrationContext, phpVersion: string, sso: string): Promise<boolean> {
  const poolPath = `/etc/php/${phpVersion}/fpm/pool.d/meowbox-adminer.conf`;
  if (!(await ctx.exists(poolPath))) {
    ctx.log(`SKIP php${phpVersion}: ${poolPath} нет — pool ещё не создан (см. 2026-04-30-006)`);
    return false;
  }
  const conf = await ctx.readFile(poolPath);
  const envFile = path.join(ctx.config.stateDir, '.env');
  const expected = `env[ADMINER_SSO_KEY] = "${escapePoolValue(sso)}"`;

  let next = conf;
  let touched = false;

  // 1) Ключ.
  const envKeyRe = /^env\[ADMINER_SSO_KEY\]\s*=.*$/m;
  if (envKeyRe.test(next)) {
    const current = next.match(envKeyRe)?.[0];
    if (current !== expected) {
      next = next.replace(envKeyRe, expected);
      touched = true;
      ctx.log(`  ${poolPath}: env[ADMINER_SSO_KEY] обновлён`);
    }
  } else {
    // Добавим перед `clear_env = ...` (или в конец), сохраним финальный \n.
    if (/^clear_env\s*=/m.test(next)) {
      next = next.replace(/^clear_env\s*=.*$/m, `${expected}\nclear_env = no`);
    } else {
      next = next.replace(/\n*$/, `\n\n${expected}\nclear_env = no\n`);
    }
    touched = true;
    ctx.log(`  ${poolPath}: env[ADMINER_SSO_KEY] добавлен`);
  }

  // 2) open_basedir должен содержать state/.env.
  const obRe = /^php_admin_value\[open_basedir\]\s*=\s*(.+)$/m;
  const obMatch = next.match(obRe);
  if (obMatch) {
    const parts = obMatch[1].split(':').map((s) => s.trim()).filter(Boolean);
    if (!parts.includes(envFile)) {
      parts.push(envFile);
      next = next.replace(obRe, `php_admin_value[open_basedir] = ${parts.join(':')}`);
      touched = true;
      ctx.log(`  ${poolPath}: open_basedir дополнен state/.env`);
    }
  } else {
    ctx.log(`  WARN ${poolPath}: нет open_basedir — пропускаю (странный pool, не трогаю)`);
  }

  if (!touched) {
    ctx.log(`OK php${phpVersion}: pool уже синхронизирован`);
    return false;
  }

  if (ctx.dryRun) {
    ctx.log(`(dry-run) would write ${poolPath} + restart php${phpVersion}-fpm`);
    return false;
  }

  await ctx.writeFile(poolPath, next);

  // 3) Рестарт.
  try {
    await ctx.exec.runShell(`systemctl restart php${phpVersion}-fpm.service`);
    ctx.log(`OK: php${phpVersion}-fpm перезапущен`);
  } catch (e) {
    ctx.log(`WARN: не смог перезапустить php${phpVersion}-fpm: ${(e as Error).message}`);
  }
  return true;
}

const migration: SystemMigration = {
  id: '2026-05-12-002-resync-adminer-sso',
  description: 'Принудительный ресинк Adminer SSO (ключ pool ↔ .env, копия sso.php, user, sock check)',

  async up(ctx) {
    if (!(await ctx.exists('/usr/bin/apt-get'))) {
      ctx.log('SKIP: apt-get не найден — поддерживается только Debian/Ubuntu');
      return;
    }

    // 1) user meowbox-adminer.
    await ensureAdminerUser(ctx);

    // 2) SSO-файлы из release.
    await copySsoFiles(ctx);

    // 3) ADMINER_SSO_KEY в pool.
    const sso = await readSsoKey(ctx);
    if (!sso) {
      ctx.log('WARN: ADMINER_SSO_KEY в state/.env не найден. Пропускаю sync pool — Adminer SSO работать не будет, пока ключ не появится в .env (запусти master-key bootstrap).');
      return;
    }

    let touchedAny = false;
    for (const v of PHP_VERSIONS) {
      if (await syncPool(ctx, v, sso)) touchedAny = true;
    }
    if (!touchedAny) {
      ctx.log('Pool уже синхронизирован во всех версиях php-fpm.');
    }

    // 4) Проверка sock.
    if (ctx.dryRun) return;
    // Дать php-fpm пару секунд на создание сокета.
    await new Promise((r) => setTimeout(r, 1500));
    if (await ctx.exists(POOL_SOCK)) {
      ctx.log(`OK: ${POOL_SOCK} существует — pool meowbox-adminer запущен`);
    } else {
      ctx.log(
        `WARN: ${POOL_SOCK} НЕ существует после рестарта php-fpm. ` +
        'Это причина 502 на /adminer/. Проверь логи: ' +
        '`journalctl -u php*-fpm -n 50` и `/var/log/php*-fpm.log`. ' +
        'Возможные причины: syntax error в pool, user meowbox-adminer без прав на /run/php, ' +
        'либо ни одна версия php-fpm не имеет meowbox-adminer.conf (запусти 2026-04-30-006).',
      );
    }
  },
};

export default migration;
