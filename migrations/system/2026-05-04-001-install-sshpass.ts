/**
 * Установка sshpass на существующих панелях.
 *
 * Зачем:
 *   - Фича Migrate Hostpanel (агент-сторона) использует `sshpass -e ssh ...`
 *     и `rsync -e "sshpass -e ssh ..."` для READ-ONLY копирования сайтов
 *     с источника по password-auth (см. agent/src/migration/hostpanel/ssh-source.ts).
 *   - Старые установки ставились без sshpass → агент падает с
 *     "spawn sshpass ENOENT" при попытке миграции.
 *
 * Идемпотентно: повторный запуск проверяет наличие sshpass и ничего не делает.
 * Только Debian/Ubuntu (apt-get): на других дистрибутивах логирует предупреждение.
 */

import type { SystemMigration } from './_types';

const migration: SystemMigration = {
  id: '2026-05-04-001-install-sshpass',
  description: 'Установка sshpass для Migrate Hostpanel (агент)',

  async up(ctx) {
    // 1) Уже установлен?
    try {
      const { stdout } = await ctx.exec.run('sshpass', ['-V']);
      ctx.log(`OK: sshpass уже установлен — ${stdout.split('\n')[0].trim()}`);
      return;
    } catch {
      // нет — ставим
    }

    if (ctx.dryRun) {
      ctx.log('would install sshpass via apt-get');
      return;
    }

    // 2) Только Debian/Ubuntu (apt-get).
    if (!(await ctx.exists('/usr/bin/apt-get'))) {
      ctx.log('SKIP: apt-get не найден — sshpass поддерживается только на Debian/Ubuntu');
      return;
    }

    ctx.log('Installing sshpass via apt-get...');
    await ctx.exec.runShell(`
      set -e
      DEBIAN_FRONTEND=noninteractive apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \\
        -o Dpkg::Options::=--force-confdef \\
        -o Dpkg::Options::=--force-confold sshpass
    `);

    // 3) Проверка.
    try {
      const { stdout } = await ctx.exec.run('sshpass', ['-V']);
      ctx.log(`OK: sshpass установлен — ${stdout.split('\n')[0].trim()}`);
    } catch (e) {
      ctx.log(`WARN: sshpass не отвечает после установки: ${(e as Error).message}`);
    }
  },
};

export default migration;
