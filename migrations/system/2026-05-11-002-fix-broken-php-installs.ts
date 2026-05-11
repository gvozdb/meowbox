/**
 * Чинит «полу-установленные» PHP-версии: ситуация, когда `/etc/php/{V}/` есть,
 * а `php{V}-fpm.service` либо отсутствует, либо не активен.
 *
 * Причина бага: в install.sh / agent installVersion() пакет `php{V}-imagick`
 * шёл в одной apt-get install транзакции с core-пакетами. Для свежих версий
 * PHP (8.4 первые месяцы) этот пакет в ondrej/php отсутствовал → apt
 * валил всю транзакцию атомарно → ставился только `php-common` через
 * зависимости других пакетов (если они вообще успевали), а fpm — нет. UI
 * читал `/etc/php/` и показывал 8.4 как «установлен», но статус был inactive
 * и активировать нечем.
 *
 * Что делает миграция:
 *   1. Для каждой версии в /etc/php/{V} (`8.0`..`8.4`):
 *      - Если `php{V}-fpm.service` не существует → переустанавливаем core пакеты
 *        БЕЗ imagick (idempotent: apt-get install уже-установленных это no-op).
 *      - После этого `systemctl enable --now php{V}-fpm`.
 *      - Если сервис всё равно не active → пишем варн (значит реально сломано —
 *        смотри journalctl, миграцию не валим).
 *   2. imagick ставится отдельно, best-effort.
 *
 * Идемпотентно: повторный запуск проверяет state, не делает лишних действий.
 */

import type { SystemMigration } from './_types';

const PHP_VERSIONS = ['8.0', '8.1', '8.2', '8.3', '8.4'];
const CORE_EXTS = [
  'cli', 'fpm', 'common', 'mysql', 'pgsql', 'sqlite3',
  'mbstring', 'curl', 'zip', 'xml', 'gd', 'bcmath', 'intl', 'opcache',
];

const migration: SystemMigration = {
  id: '2026-05-11-002-fix-broken-php-installs',
  description: 'Чинит полу-установленные PHP-версии (отсутствует fpm.service из-за сломанного imagick)',

  async up(ctx) {
    if (!(await ctx.exists('/usr/bin/apt-get'))) {
      ctx.log('SKIP: apt-get не найден');
      return;
    }
    if (ctx.dryRun) {
      ctx.log('would scan /etc/php/{V} and reinstall broken core packages without imagick');
      return;
    }

    for (const v of PHP_VERSIONS) {
      const etcDir = `/etc/php/${v}`;
      if (!(await ctx.exists(etcDir))) {
        // Версия не установлена — нечего чинить.
        continue;
      }

      // Проверяем: существует ли вообще systemd-unit php{V}-fpm.service?
      // `systemctl list-unit-files` экзитит 0 даже если ничего не нашлось, поэтому
      // надёжнее парсить stdout.
      let fpmUnitExists = false;
      try {
        const { stdout } = await ctx.exec.runShell(
          `systemctl list-unit-files --no-legend php${v}-fpm.service 2>/dev/null || true`,
        );
        fpmUnitExists = stdout.includes(`php${v}-fpm.service`);
      } catch {
        // ничего, fpmUnitExists = false → пойдём ставить
      }

      // is-active быстро покажет статус.
      let fpmActive = false;
      try {
        const { stdout } = await ctx.exec.runShell(
          `systemctl is-active php${v}-fpm 2>/dev/null || true`,
        );
        fpmActive = stdout.trim() === 'active';
      } catch {
        fpmActive = false;
      }

      if (fpmUnitExists && fpmActive) {
        ctx.log(`OK: PHP ${v} установлен и активен — пропускаю`);
        continue;
      }

      // Версия сломана. Проверим, доступны ли core-пакеты в репах.
      let coreAvailable = false;
      try {
        await ctx.exec.runShell(`apt-cache show php${v}-cli >/dev/null 2>&1`);
        coreAvailable = true;
      } catch {
        ctx.log(`SKIP: PHP ${v} — пакетов в репозитории нет, починить нельзя`);
        continue;
      }
      if (!coreAvailable) continue;

      ctx.log(`Fixing PHP ${v}: unit=${fpmUnitExists ? 'present' : 'missing'}, active=${fpmActive}`);

      // Ставим core БЕЗ imagick. apt-get на уже-установленных пакетах — no-op,
      // на полу-установленных — доустановит. На полностью отсутствующих —
      // поставит.
      const corePkgs = CORE_EXTS.map((ext) => `php${v}-${ext}`).join(' ');
      try {
        await ctx.exec.runShell(
          `DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ` +
          `-o Dpkg::Options::=--force-confdef ` +
          `-o Dpkg::Options::=--force-confold ` +
          corePkgs,
        );
        ctx.log(`  ✓ core пакеты установлены/обновлены для PHP ${v}`);
      } catch (e) {
        ctx.log(`  WARN: PHP ${v} core install fail: ${(e as Error).message}`);
        continue;
      }

      // enable + start. `|| true` — если уже enabled/active, systemctl
      // возвращает успешно.
      try {
        await ctx.exec.runShell(
          `systemctl enable --now php${v}-fpm.service >/dev/null 2>&1 || true`,
        );
      } catch {
        // не критично
      }

      // Финальный sanity-check.
      try {
        const { stdout } = await ctx.exec.runShell(
          `systemctl is-active php${v}-fpm 2>/dev/null || true`,
        );
        if (stdout.trim() === 'active') {
          ctx.log(`  ✓ PHP ${v} теперь активен`);
        } else {
          ctx.log(`  WARN: PHP ${v} установлен, но всё ещё не активен (is-active=${stdout.trim()}). См. journalctl -xeu php${v}-fpm`);
        }
      } catch {
        // не критично
      }

      // imagick — best-effort, отдельным install. Если пакета нет в репе или
      // он сломан — продолжаем, ошибку глотаем.
      try {
        await ctx.exec.runShell(`apt-cache show php${v}-imagick >/dev/null 2>&1`);
        try {
          await ctx.exec.runShell(
            `DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ` +
            `-o Dpkg::Options::=--force-confdef ` +
            `-o Dpkg::Options::=--force-confold ` +
            `php${v}-imagick`,
          );
          ctx.log(`  ✓ optional imagick установлен для PHP ${v}`);
        } catch (e) {
          ctx.log(`  · optional imagick install fail (best-effort): ${(e as Error).message}`);
        }
      } catch {
        ctx.log(`  · optional imagick недоступен для PHP ${v} в репе — пропускаю`);
      }
    }

    ctx.log('Fix broken PHP installs — done');
  },
};

export default migration;
