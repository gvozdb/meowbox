/**
 * Расширяем дефолтный `php_admin_value[open_basedir]` в существующих
 * PHP-FPM pool-файлах сайтов:
 *
 *   было:  {homeDir}:{homeDir}/tmp:/usr/share/php
 *   стало: {homeDir}:{homeDir}/tmp:{homeDir}/.npm-global:/usr/share/php:
 *          /usr/bin:/usr/local/bin:/usr/local/lib/node_modules
 *
 * Зачем: чтобы PHP-скрипты сайта могли запускать `node`, `npm`, читать
 * глобальные node_modules и писать в локальный `.npm-global`. Без этого
 * билдеры (npm/yarn/pnpm), запускаемые из PHP, тыкаются в open_basedir
 * restriction и падают.
 *
 * Для каждого сайта берём pool-файл `/etc/php/{ver}/fpm/pool.d/{anchor}.conf`
 * и точечно заменяем строку — homeDir у каждого сайта свой, поэтому
 * формируем «было/стало» индивидуально.
 *
 * Идемпотентность:
 *   - если строка уже расширена — skip
 *   - если строка закомментирована (`; [overridden by UI] ...`) — не трогаем
 *   - если её вообще нет (юзер сам переопределил через customConfig) — skip
 *
 * После всех правок `systemctl reload php{ver}-fpm` для затронутых версий.
 */

import * as path from 'node:path';

import { artifactAnchor } from '@meowbox/shared';

import type { SystemMigration, MigrationContext } from './_types';

const PHP_FPM_BASE = '/etc/php';
const SITES_BASE = '/var/www';

function oldLine(homeDir: string): string {
  return `php_admin_value[open_basedir] = ${homeDir}:${homeDir}/tmp:/usr/share/php`;
}

function newLine(homeDir: string): string {
  return `php_admin_value[open_basedir] = ${homeDir}:${homeDir}/tmp:${homeDir}/.npm-global:/usr/share/php:/usr/bin:/usr/local/bin:/usr/local/lib/node_modules`;
}

const migration: SystemMigration = {
  id: '2026-05-05-002-expand-open-basedir-defaults',
  description: 'Расширить open_basedir в существующих PHP-FPM pool-файлах (npm-global + node bins)',

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
      const OLD = oldLine(homeDir);
      const NEW = newLine(homeDir);

      const content = await ctx.readFile(poolFile);
      const lines = content.split('\n');

      let changed = false;
      const out = lines.map((line) => {
        if (line.trimEnd() === OLD) {
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
