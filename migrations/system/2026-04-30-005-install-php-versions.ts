/**
 * Установка дополнительных версий PHP-FPM на существующих панелях.
 *
 * Контекст:
 *   - Панель позволяет создавать сайты с phpVersion = 8.1 / 8.2 / 8.3 / 8.4.
 *   - install.sh (с v0.4.1) подключает ondrej/php (Ubuntu) или sury.org (Debian)
 *     и ставит весь набор. Но install.sh запускается только при первой установке;
 *     старые панели имеют только дистровскую версию (например 8.1 на Ubuntu 22.04),
 *     и при создании сайта на 8.2 валятся в `spawn php8.2 ENOENT` /
 *     `php8.2-fpm не установлен на сервере`.
 *
 * Что делает:
 *   1. На Ubuntu — добавляет ppa:ondrej/php (если ещё не подключён).
 *   2. На Debian — добавляет packages.sury.org (если ещё не подключён).
 *   3. Для каждой версии 8.1/8.2/8.3/8.4 — если она доступна в репо и
 *      ещё не установлена (нет `/usr/sbin/php-fpmX.Y` или нужно дополнить пакеты),
 *      ставит полный набор: cli, fpm, mysql, pgsql, sqlite3, mbstring, curl, zip,
 *      xml, gd, bcmath, intl.
 *
 * Идемпотентно: повторный запуск проверяет наличие репо и каждой версии php-fpm.
 * Только Debian/Ubuntu: на других дистрибутивах логирует предупреждение и завершается.
 */

import type { SystemMigration } from './_types';

const PHP_VERSIONS = ['8.1', '8.2', '8.3', '8.4'];
const PHP_EXTS = [
  'cli', 'fpm', 'mysql', 'pgsql', 'sqlite3',
  'mbstring', 'curl', 'zip', 'xml', 'gd', 'bcmath', 'intl',
];

const migration: SystemMigration = {
  id: '2026-04-30-005-install-php-versions',
  description: 'Доставить PHP 8.1/8.2/8.3/8.4 (ondrej/sury) на существующих панелях',

  async up(ctx) {
    // 1) Только apt-системы.
    if (!(await ctx.exists('/usr/bin/apt-get'))) {
      ctx.log('SKIP: apt-get не найден — поддерживается только Debian/Ubuntu');
      return;
    }

    // 2) Определяем дистрибутив.
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
      ctx.log(`SKIP: не удалось прочитать /etc/os-release: ${(e as Error).message}`);
      return;
    }
    ctx.log(`Distro: ${distroId} ${distroCodename || '(no codename)'}`);

    if (ctx.dryRun) {
      ctx.log('would add ondrej/sury repo and install php8.1/8.2/8.3/8.4 ext packs');
      return;
    }

    // 3) Подключаем репо для версий PHP, если ещё не подключён.
    let repoAdded = false;

    if (distroId === 'ubuntu') {
      const { stdout: lst } = await ctx.exec.runShell(
        'grep -rl "ondrej/php" /etc/apt/sources.list.d/ 2>/dev/null || true',
      );
      if (lst.trim() === '') {
        ctx.log('Adding ppa:ondrej/php...');
        try {
          // software-properties-common даёт add-apt-repository.
          await ctx.exec.runShell(
            'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq software-properties-common ca-certificates curl',
          );
          await ctx.exec.runShell('add-apt-repository -y ppa:ondrej/php');
          repoAdded = true;
        } catch (e) {
          ctx.log(`WARN: не удалось подключить ondrej/php: ${(e as Error).message}`);
        }
      } else {
        ctx.log('OK: ondrej/php уже подключён');
      }
    } else if (distroId === 'debian') {
      if (!distroCodename) {
        ctx.log('WARN: не удалось определить кодовое имя Debian — пропускаю sury.org');
      } else if (!(await ctx.exists('/etc/apt/sources.list.d/sury-php.list'))) {
        ctx.log('Adding packages.sury.org...');
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
          repoAdded = true;
        } catch (e) {
          ctx.log(`WARN: не удалось подключить sury.org: ${(e as Error).message}`);
        }
      } else {
        ctx.log('OK: sury.org уже подключён');
      }
    } else {
      ctx.log(`SKIP: неподдерживаемый дистрибутив "${distroId}" — пропускаю`);
      return;
    }

    // 4) apt-get update (если репо был добавлен — обязательно; иначе тоже не повредит,
    // чтобы apt-cache show видел свежий список).
    try {
      await ctx.exec.runShell('DEBIAN_FRONTEND=noninteractive apt-get update -qq');
    } catch (e) {
      ctx.log(`WARN: apt-get update упал: ${(e as Error).message}`);
      if (repoAdded) {
        // Если только что добавили репо и update не прошёл — дальше apt install
        // всё равно не найдёт пакетов; останавливаемся, чтоб не создавать
        // ложного впечатления успеха.
        throw e;
      }
    }

    // 5) Ставим/дополняем каждую версию.
    for (const v of PHP_VERSIONS) {
      // Доступна ли версия в репо?
      let available = false;
      try {
        await ctx.exec.runShell(`apt-cache show php${v}-cli >/dev/null 2>&1`);
        available = true;
      } catch {
        ctx.log(`SKIP: PHP ${v} не найден в репозиториях`);
        continue;
      }
      if (!available) continue;

      // Уже установлена ли php-fpm бинарь нужной версии?
      const fpmInstalled =
        (await ctx.exists(`/usr/sbin/php-fpm${v}`)) ||
        (await ctx.exists(`/usr/sbin/php${v}-fpm`));

      if (fpmInstalled) {
        ctx.log(`OK: PHP ${v} уже установлен — проверяю/докачиваю расширения`);
      } else {
        ctx.log(`Installing PHP ${v}...`);
      }

      const pkgs = PHP_EXTS.map((ext) => `php${v}-${ext}`).join(' ');
      try {
        await ctx.exec.runShell(
          `DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ` +
          `-o Dpkg::Options::=--force-confdef ` +
          `-o Dpkg::Options::=--force-confold ` +
          pkgs,
        );
        ctx.log(`OK: PHP ${v} — пакеты установлены`);
      } catch (e) {
        // Не валим всю миграцию из-за одной версии — другие могут пройти.
        ctx.log(`WARN: PHP ${v} install partial: ${(e as Error).message}`);
      }

      // Поднимаем php-fpm для версии (enable + start).
      try {
        await ctx.exec.runShell(
          `systemctl enable --now php${v}-fpm.service >/dev/null 2>&1 || true`,
        );
      } catch {
        // не критично, миграция и так свою задачу выполнила
      }
    }

    ctx.log('PHP versions migration done');
  },
};

export default migration;
