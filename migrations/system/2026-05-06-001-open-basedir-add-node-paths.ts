/**
 * Дополняем `php_admin_value[open_basedir]` четырьмя путями к node_modules
 * системного уровня:
 *   /usr/lib/node_modules
 *   /usr/share/npm
 *   /usr/share/nodejs
 *   /usr/share/node_modules
 *
 * Зачем: разные дистрибутивы/способы установки node раскладывают глобальные
 * модули по разным префиксам. Без этих путей PHP, запускающий node через
 * exec/proc_open, не может прочитать nodejs-зависимости.
 *
 * Что делает миграция:
 *   - Берёт каждый сайт с phpVersion из БД, формирует homeDir.
 *   - Ищет в pool-файле строку open_basedir после v0.6.8 (с .npm-global +
 *     /usr/bin + /usr/local/bin + /usr/local/lib/node_modules) и расширяет
 *     до новой.
 *   - Также пытается обработать «совсем старый» вариант (до v0.6.7), если
 *     v0.6.8-миграция не прокатилась почему-то — переводит сразу в новый.
 *
 * Идемпотентность:
 *   - если уже расширено — skip
 *   - если строка закомментирована (`; [overridden by UI] ...`) — не трогаем
 *   - если базовая строка не найдена (custom override) — skip
 *
 * После всех правок `systemctl reload php{ver}-fpm` для затронутых версий.
 */

import * as path from 'node:path';

import { artifactAnchor } from '@meowbox/shared';

import type { SystemMigration, MigrationContext } from './_types';

const PHP_FPM_BASE = '/etc/php';
const SITES_BASE = '/var/www';

function v067Line(homeDir: string): string {
  // совсем старый дефолт (до v0.6.7)
  return `php_admin_value[open_basedir] = ${homeDir}:${homeDir}/tmp:/usr/share/php`;
}

function v068Line(homeDir: string): string {
  return `php_admin_value[open_basedir] = ${homeDir}:${homeDir}/tmp:${homeDir}/.npm-global:/usr/share/php:/usr/bin:/usr/local/bin:/usr/local/lib/node_modules`;
}

function v069Line(homeDir: string): string {
  return `php_admin_value[open_basedir] = ${homeDir}:${homeDir}/tmp:${homeDir}/.npm-global:/usr/share/php:/usr/bin:/usr/local/bin:/usr/local/lib/node_modules:/usr/lib/node_modules:/usr/share/npm:/usr/share/nodejs:/usr/share/node_modules`;
}

const migration: SystemMigration = {
  id: '2026-05-06-001-open-basedir-add-node-paths',
  description: 'Добавить /usr/lib/node_modules /usr/share/npm /usr/share/nodejs /usr/share/node_modules в open_basedir',

  async up(ctx) {
    const sites = await ctx.prisma.site.findMany();
    if (sites.length === 0) {
      ctx.log('Нет сайтов в БД — миграция no-op');
      return;
    }

    const touchedVersions = new Set<string>();
    let updated = 0;
    let alreadyOk = 0;
    let skippedNoFile = 0;
    let skippedNoMatch = 0;

    for (const site of sites) {
      const phpVersion = site.phpVersion;
      if (!phpVersion) continue;

      let anchor: string;
      try {
        anchor = artifactAnchor({ siteName: site.name, domain: site.domain });
      } catch {
        ctx.log(`  [${site.name || site.domain}] !! пустой anchor — skip`);
        continue;
      }
      const poolName = anchor.replace(/\./g, '_');
      const poolFile = path.join(PHP_FPM_BASE, phpVersion, 'fpm', 'pool.d', `${poolName}.conf`);

      if (!(await ctx.exists(poolFile))) {
        skippedNoFile++;
        ctx.log(`  [${site.name}] pool-файл не найден (${poolFile}) — skip`);
        continue;
      }

      const homeDir = path.resolve(site.rootPath || path.join(SITES_BASE, anchor));
      const NEW = v069Line(homeDir);
      const PREV_VARIANTS = [v068Line(homeDir), v067Line(homeDir)];

      const content = await ctx.readFile(poolFile);
      const lines = content.split('\n');

      let changed = false;
      const out = lines.map((line) => {
        const t = line.trimEnd();
        if (PREV_VARIANTS.includes(t)) {
          changed = true;
          return NEW;
        }
        return line;
      });

      if (!changed) {
        const hasNew = lines.some((l) => l.trimEnd() === NEW);
        if (hasNew) {
          alreadyOk++;
          ctx.log(`  [${site.name}] уже расширен — skip`);
        } else {
          skippedNoMatch++;
          ctx.log(`  [${site.name}] базовая строка не найдена (custom override?) — skip`);
        }
        continue;
      }

      if (ctx.dryRun) {
        ctx.log(`  [${site.name}] would patch ${poolFile} (dry-run)`);
        continue;
      }

      await ctx.writeFile(poolFile, out.join('\n'), 0o644);
      touchedVersions.add(phpVersion);
      updated++;
      ctx.log(`  [${site.name}] patched ${poolFile}`);
    }

    if (!ctx.dryRun && touchedVersions.size > 0) {
      const systemctl = await firstExisting(ctx, ['/usr/bin/systemctl', '/bin/systemctl']);
      if (!systemctl) {
        ctx.log('systemctl не найден — пропускаю reload, перезагрузи PHP-FPM вручную');
      } else {
        for (const ver of touchedVersions) {
          try {
            await ctx.exec.run(systemctl, ['reload', `php${ver}-fpm`]);
            ctx.log(`reloaded php${ver}-fpm`);
          } catch (e) {
            try {
              await ctx.exec.run(systemctl, ['restart', `php${ver}-fpm`]);
              ctx.log(`restarted php${ver}-fpm (reload failed: ${(e as Error).message})`);
            } catch (e2) {
              ctx.log(`!! php${ver}-fpm reload+restart failed: ${(e2 as Error).message}`);
            }
          }
        }
      }
    }

    ctx.log(`OK: updated=${updated}, already_ok=${alreadyOk}, no_file=${skippedNoFile}, no_match=${skippedNoMatch}`);
  },
};

async function firstExisting(ctx: MigrationContext, candidates: string[]): Promise<string | null> {
  for (const p of candidates) {
    if (await ctx.exists(p)) return p;
  }
  return null;
}

export default migration;
