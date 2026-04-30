/**
 * Доустановка встроенного Adminer'а на панелях, где его не было/он сломан.
 *
 * Контекст:
 *   - install.sh настраивает Adminer + SSO (location /adminer/ в nginx
 *     панели + изолированный php-fpm пул meowbox-adminer + sso.php).
 *   - Старые панели (или slave-серверы, где install.sh запускался ещё
 *     до появления adminer-блока) получают 404 на /adminer/sso.php?ticket=...
 *     при клике "Открыть в Adminer".
 *
 * Что делает миграция (идемпотентно):
 *   1. ADMINER_DIR = state/adminer; mkdir -p lib.
 *   2. Скачивает adminer.php нужной версии, если нет.
 *   3. Копирует sso.php / index.php / lib/* из tools/adminer релиза.
 *   4. Создаёт meowbox-adminer user, если нет.
 *   5. chown/chmod на каталог adminer.
 *   6. ADMINER_SSO_KEY: если в .env пусто — генерирует и дописывает.
 *   7. Создаёт /etc/php/<V>/fpm/pool.d/meowbox-adminer.conf, если нет.
 *   8. systemctl restart phpV-fpm.
 *   9. Если в /etc/nginx/sites-available/meowbox-panel есть location /adminer/ —
 *      делает nginx -t && reload. Если нет — оставляет warning, чужой server-блок
 *      не патчит.
 *
 * Только Debian/Ubuntu: на других ОС логирует skip.
 */

import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import * as path from 'node:path';

import type { MigrationContext, SystemMigration } from './_types';

const ADMINER_VERSION = '4.8.1';
const ADMINER_URL = `https://github.com/vrana/adminer/releases/download/v${ADMINER_VERSION}/adminer-${ADMINER_VERSION}.php`;

async function findReleaseAdminerDir(ctx: MigrationContext): Promise<string | null> {
  try {
    const real = await ctx.exec.runShell(`readlink -f ${ctx.config.currentDir}`);
    const realPath = real.stdout.trim() || ctx.config.currentDir;
    const candidate = path.join(realPath, 'tools', 'adminer');
    if (!(await ctx.exists(candidate))) return null;
    const r = await ctx.exec.runShell(`readlink -f ${candidate}`);
    return r.stdout.trim() || candidate;
  } catch {
    return null;
  }
}

async function resolveEnvFile(ctx: MigrationContext): Promise<string | null> {
  const candidates = [
    path.join(ctx.config.stateDir, '.env'),
    path.join(ctx.config.panelDir, '.env'),
  ];
  for (const c of candidates) {
    if (await ctx.exists(c)) return c;
  }
  return null;
}

async function readSsoKeyFromEnv(ctx: MigrationContext, envFile: string | null): Promise<string | null> {
  if (!envFile) return null;
  try {
    const raw = await ctx.readFile(envFile);
    const m = raw.match(/^ADMINER_SSO_KEY=(.+)$/m);
    return m ? m[1].trim().replace(/^"|"$/g, '') : null;
  } catch {
    return null;
  }
}

async function detectPhpVersion(ctx: MigrationContext): Promise<string | null> {
  // Берём максимальную доступную версию php-fpm. Не зависим от ls /etc/php.
  const versions = ['8.4', '8.3', '8.2', '8.1', '8.0', '7.4'];
  for (const v of versions) {
    if (await ctx.exists(`/etc/php/${v}/fpm/pool.d`)) return v;
  }
  return null;
}

const migration: SystemMigration = {
  id: '2026-04-30-006-install-adminer-on-existing',
  description: 'Доустановить встроенный Adminer (sso.php + pool + nginx reload) на существующих панелях',

  async up(ctx) {
    if (!(await ctx.exists('/usr/bin/apt-get'))) {
      ctx.log('SKIP: apt-get не найден — поддерживается только Debian/Ubuntu');
      return;
    }

    const stateDir = ctx.config.stateDir;
    const adminerDir = path.join(stateDir, 'adminer');
    const adminerBin = path.join(adminerDir, 'adminer.php');
    const adminerLibDir = path.join(adminerDir, 'lib');

    // 1) Каталоги.
    if (ctx.dryRun) {
      ctx.log(`would mkdir ${adminerDir} and ${adminerLibDir}`);
    } else {
      await ctx.exec.run('mkdir', ['-p', adminerLibDir]);
    }

    // Симлинк tools/adminer → state/adminer (соответствует release-mode install.sh).
    const codeAdminerDir = path.join(ctx.config.currentDir, 'tools', 'adminer');
    if (!ctx.dryRun) {
      try {
        const st = await lstat(codeAdminerDir);
        if (st.isDirectory() && !st.isSymbolicLink()) {
          // Сохраняем содержимое (sso.php, lib/*) перед заменой каталога симлинком.
          await ctx.exec.runShell(`cp -an ${codeAdminerDir}/. ${adminerDir}/ || true`);
          await ctx.exec.runShell(`rm -rf ${codeAdminerDir}`);
        }
      } catch {
        // нет каталога — ок
      }
      await ctx.exec.runShell(`ln -sfn ${adminerDir} ${codeAdminerDir}`);
    }

    // 2) adminer.php — качаем если нет/версия другая.
    let needDownload = !(await ctx.exists(adminerBin));
    if (!needDownload) {
      try {
        const head = await ctx.readFile(adminerBin);
        if (!head.includes(`v${ADMINER_VERSION}`)) needDownload = true;
      } catch {
        needDownload = true;
      }
    }
    if (needDownload) {
      if (ctx.dryRun) {
        ctx.log(`would download ${ADMINER_URL}`);
      } else {
        ctx.log(`Downloading Adminer ${ADMINER_VERSION}...`);
        const tmp = `${adminerBin}.tmp`;
        await ctx.exec.run('curl', ['-fsSL', '-o', tmp, ADMINER_URL]);
        await ctx.exec.run('mv', [tmp, adminerBin]);
      }
    } else {
      ctx.log('OK: adminer.php уже на нужной версии');
    }

    // 3) sso.php / index.php / lib/* из tools/adminer релиза в state/adminer.
    if (!ctx.dryRun) {
      const releaseAdminer = await findReleaseAdminerDir(ctx);
      if (releaseAdminer && releaseAdminer !== adminerDir) {
        await ctx.exec.runShell(`cp -an ${releaseAdminer}/sso.php ${adminerDir}/sso.php 2>/dev/null || true`);
        await ctx.exec.runShell(`cp -an ${releaseAdminer}/index.php ${adminerDir}/index.php 2>/dev/null || true`);
        if (await ctx.exists(path.join(releaseAdminer, 'lib'))) {
          await ctx.exec.runShell(`cp -an ${releaseAdminer}/lib/. ${adminerLibDir}/ 2>/dev/null || true`);
        }
        ctx.log(`OK: sso.php + lib скопированы из ${releaseAdminer}`);
      } else {
        ctx.log('OK: tools/adminer уже указывает на state/adminer');
      }
    }

    // 4) Юзер meowbox-adminer.
    if (!ctx.dryRun) {
      const idCheck = await ctx.exec.runShell(`id -u meowbox-adminer 2>/dev/null || true`);
      if (!idCheck.stdout.trim()) {
        ctx.log('Creating system user meowbox-adminer...');
        await ctx.exec.run('useradd', [
          '--system', '--shell', '/usr/sbin/nologin',
          '--no-create-home', '--user-group', 'meowbox-adminer',
        ]);
      } else {
        ctx.log('OK: meowbox-adminer user уже есть');
      }
      await ctx.exec.runShell('usermod -aG www-data meowbox-adminer || true');
    }

    // 5) chown/chmod.
    if (!ctx.dryRun) {
      await ctx.exec.run('chown', ['-R', 'root:www-data', adminerDir]);
      await ctx.exec.runShell(`find ${adminerDir} -type d -exec chmod 750 {} \\;`);
      await ctx.exec.runShell(`find ${adminerDir} -type f -exec chmod 640 {} \\;`);
    }

    // 6) ADMINER_SSO_KEY в .env.
    const envFile = await resolveEnvFile(ctx);
    if (!envFile) {
      ctx.log('WARN: state/.env не найден — пропускаю установку ADMINER_SSO_KEY');
    } else {
      const envRaw = await ctx.readFile(envFile).catch(() => '');
      if (!/^ADMINER_SSO_KEY=.+$/m.test(envRaw)) {
        const key = randomBytes(32).toString('base64');
        if (ctx.dryRun) {
          ctx.log('would append ADMINER_SSO_KEY to .env');
        } else {
          const sep = envRaw === '' || envRaw.endsWith('\n') ? '' : '\n';
          await ctx.writeFile(envFile, `${envRaw}${sep}ADMINER_SSO_KEY=${key}\n`);
          ctx.log(`OK: ADMINER_SSO_KEY дописан в ${envFile}`);
        }
      } else {
        ctx.log('OK: ADMINER_SSO_KEY уже есть в .env');
      }
    }

    // 7) PHP-FPM pool.
    const phpVersion = await detectPhpVersion(ctx);
    if (!phpVersion) {
      ctx.log('WARN: ни одной версии php-fpm не установлено — pool создавать не на чем');
      return;
    }
    const poolPath = `/etc/php/${phpVersion}/fpm/pool.d/meowbox-adminer.conf`;
    if (!(await ctx.exists(poolPath))) {
      const sso = (await readSsoKeyFromEnv(ctx, envFile)) || '';
      const env = envFile || '/opt/meowbox/state/.env';
      const pool = `; Meowbox Adminer FPM pool — изолированный, без доступа к файлам сайтов.
[meowbox-adminer]
user = meowbox-adminer
group = meowbox-adminer

listen = /run/php/meowbox-adminer.sock
listen.owner = www-data
listen.group = www-data
listen.mode = 0660

pm = ondemand
pm.max_children = 10
pm.process_idle_timeout = 30s
pm.max_requests = 500

php_admin_value[open_basedir] = ${adminerDir}:/tmp:/var/lib/php/sessions:${env}
php_admin_value[upload_tmp_dir] = /tmp
php_admin_value[session.save_path] = /var/lib/php/sessions
php_admin_value[memory_limit] = 128M
php_admin_value[post_max_size] = 128M
php_admin_value[upload_max_filesize] = 128M
php_admin_value[expose_php] = 0
php_admin_flag[display_errors] = off
php_admin_flag[log_errors] = on
php_admin_value[error_log] = /var/log/meowbox-adminer.error.log

env[ADMINER_SSO_KEY] = "${sso}"
clear_env = no
`;
      if (ctx.dryRun) {
        ctx.log(`would write ${poolPath}`);
      } else {
        await ctx.writeFile(poolPath, pool);
        ctx.log(`OK: ${poolPath} создан`);
      }
    } else {
      ctx.log(`OK: pool meowbox-adminer уже есть (php${phpVersion})`);
    }

    // Сессии PHP + лог.
    if (!ctx.dryRun) {
      await ctx.exec.runShell('mkdir -p /var/lib/php/sessions');
      await ctx.exec.runShell('chown root:meowbox-adminer /var/lib/php/sessions || true');
      await ctx.exec.runShell('chmod 1730 /var/lib/php/sessions || true');
      await ctx.exec.runShell('touch /var/log/meowbox-adminer.error.log');
      await ctx.exec.runShell('chown meowbox-adminer:meowbox-adminer /var/log/meowbox-adminer.error.log || true');
      await ctx.exec.runShell('chmod 640 /var/log/meowbox-adminer.error.log || true');
    }

    // 8) restart php-fpm.
    if (!ctx.dryRun) {
      await ctx.exec.runShell(`systemctl enable --now php${phpVersion}-fpm.service || true`);
      await ctx.exec.runShell(`systemctl restart php${phpVersion}-fpm.service || true`);
      ctx.log(`OK: php${phpVersion}-fpm перезапущен`);
    }

    // 9) nginx reload — если /adminer/ блок уже есть в конфиге.
    const nginxConf = '/etc/nginx/sites-available/meowbox-panel';
    if (await ctx.exists(nginxConf)) {
      const conf = await ctx.readFile(nginxConf);
      if (!/location\s+\^?~?\s*\/adminer\//.test(conf)) {
        ctx.log(
          'WARN: в /etc/nginx/sites-available/meowbox-panel нет location /adminer/. ' +
          'Миграция не патчит чужой server-блок — добавь руками либо переинсталлируй панель.',
        );
      } else if (!ctx.dryRun) {
        try {
          await ctx.exec.run('nginx', ['-t']);
          await ctx.exec.runShell('systemctl reload nginx || nginx -s reload');
          ctx.log('OK: nginx reload');
        } catch (e) {
          ctx.log(`WARN: nginx reload упал: ${(e as Error).message}`);
        }
      }
    } else {
      ctx.log('WARN: /etc/nginx/sites-available/meowbox-panel отсутствует — пропускаю reload');
    }

    ctx.log('Adminer install/repair done');
  },
};

export default migration;
