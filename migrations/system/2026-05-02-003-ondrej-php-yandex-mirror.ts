/**
 * Подключить зеркало Yandex для ondrej/php PPA на УЖЕ установленных панелях.
 *
 * Контекст:
 *   - Миграции 005/007 теперь подключают зеркало автоматически, но они
 *     отрабатывают один раз — на новых установках.
 *   - На существующих панелях (где 005/007 уже применены) нужна отдельная
 *     миграция, которая подключит зеркало.
 *   - Подробности про сам зеркало и причины — см. _ondrej-repo.ts.
 *
 * После подключения зеркала миграция повторно вызывает установку MODX/PHP
 * расширений (helper из 009 — но мы зовём apt напрямую, чтоб не плодить
 * зависимости). Это закрывает кейс "PPA лежал во время первого запуска 009 —
 * imagick не доставился — теперь launchpad жив (или жив yandex) — добивай".
 *
 * Идемпотентно. Только Ubuntu (зеркало есть только для Ubuntu codename'ов).
 */

import type { SystemMigration } from './_types';
import { ensureOndrejYandexMirror } from './_ondrej-repo';

const PHP_EXTENSIONS = [
  'mysql', 'mbstring', 'curl', 'zip', 'xml',
  'gd', 'intl', 'bcmath', 'opcache', 'imagick',
];

const migration: SystemMigration = {
  id: '2026-05-02-003-ondrej-php-yandex-mirror',
  description: 'Подключить зеркало Yandex для ondrej/php PPA + дозалить пропущенные PHP-расширения',

  async up(ctx) {
    if (!(await ctx.exists('/usr/bin/apt-get'))) {
      ctx.log('SKIP: apt-get не найден — поддерживается только Debian/Ubuntu');
      return;
    }

    let distroId = '';
    let codename = '';
    try {
      const { stdout } = await ctx.exec.runShell(
        '. /etc/os-release && echo "${ID:-unknown}|${VERSION_CODENAME:-}"',
      );
      [distroId, codename] = stdout.trim().split('|');
    } catch (e) {
      ctx.log(`SKIP: /etc/os-release недоступен: ${(e as Error).message}`);
      return;
    }
    ctx.log(`Distro: ${distroId} ${codename}`);

    if (ctx.dryRun) {
      ctx.log('would ensure yandex mirror and re-attempt php-ext install');
      return;
    }

    // 1. Подключаем зеркало.
    const result = await ensureOndrejYandexMirror(ctx, {
      distroId,
      codename,
      doAptUpdate: true,
    });
    ctx.log(`[ondrej-mirror Yandex] ${result.reason}`);

    if (!result.added && !result.reason.startsWith('OK:')) {
      // Зеркало не подключилось и его не было раньше — нет смысла дозаливать.
      ctx.log('  пропускаю дозалив расширений: зеркало не доступно');
      return;
    }

    // 2. Полный apt-get update (теперь видит зеркало). Не валим миграцию если
    // launchpad всё ещё лежит — yandex-источник уже обновлён выше.
    try {
      await ctx.exec.runShell(
        'DEBIAN_FRONTEND=noninteractive timeout 90 apt-get update -qq -o Acquire::ForceIPv4=true || true',
      );
    } catch {
      // intentional: глобальный update может зависеть от живых launchpad-источников
    }

    // 3. Дозаливаем расширения для всех установленных PHP версий.
    const { stdout } = await ctx.exec.runShell(
      "ls /etc/php 2>/dev/null | grep -E '^[0-9]+\\.[0-9]+$' | sort -V || true",
    );
    const versions = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

    if (versions.length === 0) {
      ctx.log('OK: нет установленных PHP версий — нечего дозаливать');
      return;
    }

    const summary: { installed: string[]; failed: string[]; skipped: string[]; unavailable: string[] } = {
      installed: [], failed: [], skipped: [], unavailable: [],
    };

    for (const ver of versions) {
      let installedThisVer = 0;
      for (const ext of PHP_EXTENSIONS) {
        const pkg = `php${ver}-${ext}`;

        // Уже установлен?
        const { stdout: dpkg } = await ctx.exec.runShell(
          `dpkg-query -W -f='\${Status}' ${pkg} 2>/dev/null | grep -q 'install ok installed' && echo yes || true`,
        );
        if (dpkg.trim() === 'yes') {
          summary.skipped.push(pkg);
          continue;
        }

        // Доступен в apt?
        const { stdout: avail } = await ctx.exec.runShell(
          `apt-cache show ${pkg} >/dev/null 2>&1 && echo yes || true`,
        );
        if (avail.trim() !== 'yes') {
          summary.unavailable.push(pkg);
          continue;
        }

        ctx.log(`  installing ${pkg}`);
        try {
          await ctx.exec.runShell(
            `DEBIAN_FRONTEND=noninteractive timeout 120 apt-get install -y -qq --fix-missing ` +
              `-o Acquire::ForceIPv4=true ` +
              `-o Dpkg::Options::=--force-confdef ` +
              `-o Dpkg::Options::=--force-confold ` +
              pkg,
          );
          summary.installed.push(pkg);
          installedThisVer++;
        } catch (e) {
          summary.failed.push(pkg);
          ctx.log(`    WARN: ${pkg} не поставился: ${(e as Error).message.slice(0, 200)}`);
        }
      }

      if (installedThisVer > 0) {
        await ctx.exec.runShell(
          `systemctl restart php${ver}-fpm.service >/dev/null 2>&1 || true`,
        );
      }
    }

    ctx.log('Summary:');
    ctx.log(`  installed:   ${summary.installed.length}${summary.installed.length ? ' (' + summary.installed.join(', ') + ')' : ''}`);
    ctx.log(`  already on:  ${summary.skipped.length}`);
    ctx.log(`  unavailable: ${summary.unavailable.length}${summary.unavailable.length ? ' (' + summary.unavailable.join(', ') + ')' : ''}`);
    ctx.log(`  failed:      ${summary.failed.length}${summary.failed.length ? ' (' + summary.failed.join(', ') + ')' : ''}`);
  },
};

export default migration;
