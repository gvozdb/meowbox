/**
 * Восстановить sso.php / index.php / lib/* в ADMINER_DIR.
 *
 * Контекст бага:
 *   - install.sh при переходе на release-mode превращает tools/adminer в
 *     симлинк на state/adminer, а реальные исходники sso.php / index.php /
 *     lib/* теряются — в репо их больше нет.
 *   - Старая миграция 2026-04-30-006 пыталась копировать из
 *     tools/adminer → но это симлинк на пустой state/adminer, копировать
 *     было нечего (silent no-op).
 *   - Новые установки через `MEOWBOX_REF=main` получают пустой state/adminer
 *     с одним только adminer.php → /adminer/sso.php?ticket=… отдаёт 404
 *     (try_files /sso.php =404), Adminer SSO не работает.
 *
 * Фикс:
 *   - В git восстановлен каталог-источник `tools/adminer-src/` (содержит
 *     sso.php, index.php, lib/sso.php, lib/meowbox-plugin.php).
 *   - install.sh теперь копирует его в ADMINER_DIR при инсталле.
 *   - Эта миграция чинит уже установленные панели: копирует те же файлы
 *     из releases/<v>/tools/adminer-src/ в state/adminer/, выставляет права.
 *
 * Идемпотентность:
 *   - Перезаписываем файлы безусловно (источник правды — git, локальные
 *     правки в state/adminer/{sso,index}.php недопустимы — они откатятся
 *     любым ре-инсталлом). Это сознательно.
 *   - Если tools/adminer-src отсутствует — skip с warning (старый релиз).
 */

import * as path from 'node:path';

import type { MigrationContext, SystemMigration } from './_types';

async function resolveAdminerDir(ctx: MigrationContext): Promise<string> {
  // Совпадает с install.sh: release-mode → state/adminer; legacy → tools/adminer.
  const stateAdminer = path.join(ctx.config.stateDir, 'adminer');
  if (await ctx.exists(stateAdminer)) return stateAdminer;
  return path.join(ctx.config.currentDir, 'tools', 'adminer');
}

async function resolveAdminerSrc(ctx: MigrationContext): Promise<string | null> {
  // tools/adminer-src лежит внутри release. currentDir может быть симлинком
  // на releases/<v>/, поэтому резолвим явно.
  const real = await ctx.exec.runShell(`readlink -f ${ctx.config.currentDir}`);
  const realPath = real.stdout.trim() || ctx.config.currentDir;
  const src = path.join(realPath, 'tools', 'adminer-src');
  return (await ctx.exists(src)) ? src : null;
}

const migration: SystemMigration = {
  id: '2026-05-06-003-restore-adminer-sso-files',
  description: 'Восстановить sso.php/index.php/lib в state/adminer (фикс 404 для свежих установок)',

  async up(ctx) {
    if (!(await ctx.exists('/usr/bin/apt-get'))) {
      ctx.log('SKIP: apt-get не найден — поддерживается только Debian/Ubuntu');
      return;
    }

    const adminerDir = await resolveAdminerDir(ctx);
    ctx.log(`ADMINER_DIR = ${adminerDir}`);

    if (!(await ctx.exists(adminerDir))) {
      if (ctx.dryRun) {
        ctx.log(`would mkdir ${adminerDir}/lib`);
      } else {
        await ctx.exec.run('mkdir', ['-p', path.join(adminerDir, 'lib')]);
      }
    }

    const src = await resolveAdminerSrc(ctx);
    if (!src) {
      ctx.log(
        'WARN: tools/adminer-src/ не найден в release. ' +
        'Этот релиз ещё не содержит исходники SSO-обёрток — обнови панель ' +
        'и перезапусти миграцию. Adminer SSO работать не будет до ре-инсталла.',
      );
      return;
    }
    ctx.log(`source: ${src}`);

    // Список ожидаемых файлов источника (на случай частично битого релиза).
    const required = ['sso.php', 'index.php', 'lib/sso.php', 'lib/meowbox-plugin.php'];
    for (const rel of required) {
      if (!(await ctx.exists(path.join(src, rel)))) {
        throw new Error(`в источнике ${src} нет ${rel} — релиз битый, не выкатываю`);
      }
    }

    if (ctx.dryRun) {
      ctx.log(`would cp ${src}/{sso.php,index.php,lib/*} → ${adminerDir}/`);
      ctx.log(`would chown root:www-data + chmod 750/640 на ${adminerDir}`);
      return;
    }

    // Копируем безусловно (источник правды — git/release).
    await ctx.exec.runShell(`mkdir -p ${adminerDir}/lib`);
    await ctx.exec.runShell(`cp -a ${src}/sso.php   ${adminerDir}/sso.php`);
    await ctx.exec.runShell(`cp -a ${src}/index.php ${adminerDir}/index.php`);
    // Чистим lib/ от старых файлов и перенаполняем (на случай переименований).
    await ctx.exec.runShell(`rm -f ${adminerDir}/lib/*.php`);
    await ctx.exec.runShell(`cp -a ${src}/lib/. ${adminerDir}/lib/`);
    ctx.log('files copied');

    // Права как в install.sh: владелец root, группа www-data (php-fpm читает
    // через aG www-data у пользователя meowbox-adminer), 750 на каталоги, 640 на файлы.
    await ctx.exec.run('chown', ['-R', 'root:www-data', adminerDir]);
    await ctx.exec.runShell(`find ${adminerDir} -type d -exec chmod 750 {} \\;`);
    await ctx.exec.runShell(`find ${adminerDir} -type f -exec chmod 640 {} \\;`);
    ctx.log('OK: SSO-файлы восстановлены, права выставлены');
  },
};

export default migration;
