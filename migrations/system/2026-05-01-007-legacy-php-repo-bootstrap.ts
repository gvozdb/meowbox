/**
 * Bootstrap репозитория для legacy-версий PHP (7.1/7.2/7.3).
 *
 * Контекст:
 *   - Миграция со старой hostPanel требует тащить сайты на тех же версиях PHP,
 *     что и на источнике (как правило 7.1–7.4 для MODX 2.7+).
 *   - Версия 7.4 уже установлена через 005-install-php-versions (если есть в репо).
 *   - 7.1, 7.2, 7.3 требуют отдельного источника:
 *       Ubuntu: ppa:ondrej/php (есть, проверено)
 *       Debian: packages.sury.org/php (есть)
 *
 * Что делает:
 *   1. Проверяет, что репо ondrej/sury уже подключён (это сделано миграцией 005).
 *      Если нет — пытается подключить тут (повторно, идемпотентно).
 *   2. Делает `apt-get update -qq` чтобы обновить кэш madison.
 *   3. Для каждой legacy-версии 7.1/7.2/7.3 пишет в лог, доступна ли она
 *      в репозитории через `apt-cache madison php<v>-cli`. УСТАНОВКА не
 *      запускается — это решает оператор через UI /php кнопкой "Установить".
 *
 * Идемпотентно. Только Ubuntu/Debian.
 */

import type { SystemMigration } from './_types';
import { ensureOndrejYandexMirror } from './_ondrej-repo';

const LEGACY_VERSIONS = ['7.3', '7.2', '7.1'];

const migration: SystemMigration = {
  id: '2026-05-01-007-legacy-php-repo-bootstrap',
  description:
    'Подготовить репозиторий ondrej/sury для установки PHP 7.1/7.2/7.3 (без auto-install)',

  async up(ctx) {
    if (!(await ctx.exists('/usr/bin/apt-get'))) {
      ctx.log('SKIP: apt-get не найден — поддерживается только Debian/Ubuntu');
      return;
    }

    let distroId = '';
    let distroCodename = '';
    try {
      const { stdout } = await ctx.exec.runShell(
        '. /etc/os-release && echo "${ID:-unknown}|${VERSION_CODENAME:-}"',
      );
      const [id, code] = stdout.trim().split('|');
      distroId = id;
      distroCodename = code || '';
    } catch (e) {
      ctx.log(`SKIP: /etc/os-release недоступен: ${(e as Error).message}`);
      return;
    }
    ctx.log(`Distro: ${distroId} ${distroCodename}`);

    if (ctx.dryRun) {
      ctx.log('would ensure ondrej/sury repo is present and check legacy PHP availability');
      return;
    }

    // 1) Подключаем репо (идемпотентно — повторение операции из 005, на случай
    // если 005 не отработала или панель установлена ДО 005-й миграции).
    if (distroId === 'ubuntu') {
      const { stdout: lst } = await ctx.exec.runShell(
        'grep -rl "ondrej/php" /etc/apt/sources.list.d/ 2>/dev/null || true',
      );
      if (lst.trim() === '') {
        ctx.log('Adding ppa:ondrej/php (was not present)...');
        try {
          await ctx.exec.runShell(
            'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq software-properties-common ca-certificates curl',
          );
          await ctx.exec.runShell('add-apt-repository -y ppa:ondrej/php');
        } catch (e) {
          ctx.log(`WARN: не удалось подключить ondrej/php: ${(e as Error).message}`);
        }
      } else {
        ctx.log('OK: ondrej/php уже подключён');
      }

      // Зеркало Yandex как fallback (см. _ondrej-repo.ts).
      const mirror = await ensureOndrejYandexMirror(ctx, {
        distroId,
        codename: distroCodename,
        doAptUpdate: false,
      });
      ctx.log(`[ondrej-mirror Yandex] ${mirror.reason}`);
    } else if (distroId === 'debian') {
      if (!distroCodename) {
        ctx.log('WARN: не определено кодовое имя Debian — пропускаю sury.org');
      } else if (!(await ctx.exists('/etc/apt/sources.list.d/sury-php.list'))) {
        ctx.log('Adding packages.sury.org (was not present)...');
        try {
          const script = `
            set -e
            DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl
            install -m 0755 -d /etc/apt/keyrings
            curl -fsSL https://packages.sury.org/php/apt.gpg \\
              -o /etc/apt/keyrings/sury-php.gpg
            chmod a+r /etc/apt/keyrings/sury-php.gpg
            echo "deb [signed-by=/etc/apt/keyrings/sury-php.gpg] https://packages.sury.org/php/ ${distroCodename} main" \\
              > /etc/apt/sources.list.d/sury-php.list
          `;
          await ctx.exec.runShell(script);
        } catch (e) {
          ctx.log(`WARN: не удалось подключить sury.org: ${(e as Error).message}`);
        }
      } else {
        ctx.log('OK: sury.org уже подключён');
      }
    } else {
      ctx.log(`SKIP: неподдерживаемый дистрибутив "${distroId}"`);
      return;
    }

    // 2) Обновляем кэш apt — нужно для madison-проверки.
    try {
      await ctx.exec.runShell('DEBIAN_FRONTEND=noninteractive apt-get update -qq');
    } catch (e) {
      ctx.log(`WARN: apt-get update упал: ${(e as Error).message}`);
    }

    // 3) Информационная проверка доступности legacy-версий.
    for (const v of LEGACY_VERSIONS) {
      try {
        const { stdout } = await ctx.exec.runShell(
          `apt-cache madison php${v}-cli 2>/dev/null | head -1 || true`,
        );
        if (stdout.trim()) {
          ctx.log(`OK: PHP ${v} доступен в репо (для установки через /php)`);
        } else {
          ctx.log(`WARN: PHP ${v} НЕ найден в подключённых репозиториях`);
        }
      } catch (e) {
        ctx.log(`WARN: madison check ${v} failed: ${(e as Error).message}`);
      }
    }

    ctx.log('Legacy PHP repo bootstrap done — установка из UI /php');
  },
};

export default migration;
