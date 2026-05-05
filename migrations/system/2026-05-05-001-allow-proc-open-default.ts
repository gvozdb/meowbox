/**
 * Убираем `proc_open` из дефолтного `php_admin_value[disable_functions]`
 * во всех существующих PHP-FPM pool-файлах сайтов.
 *
 * Зачем: некоторые приложения (composer, symfony console, modx package
 * manager и т.п.) шеллят дочерние процессы через `proc_open`, без него
 * не работают. Запрет был перестраховкой, оставляем `exec`/`passthru`/
 * `shell_exec`/`system`/`popen` — реальные векторы RCE.
 *
 * Что делает миграция: для каждого сайта с phpVersion берёт его pool-файл
 * `/etc/php/{ver}/fpm/pool.d/{anchor_with_underscores}.conf` и точечно
 * заменяет строку
 *   php_admin_value[disable_functions] = exec,passthru,shell_exec,system,proc_open,popen
 * на
 *   php_admin_value[disable_functions] = exec,passthru,shell_exec,system,popen
 *
 * Идемпотентность:
 *   - если строка уже без `proc_open` — пропускаем
 *   - если строка закомментирована (`; [overridden by UI] ...`) — не трогаем
 *     (юзер сам управляет через UI custom-блок)
 *   - если её вообще нет (юзер уже заменил через customConfig) — пропускаем
 *
 * После всех правок делаем `systemctl reload php{ver}-fpm` для каждой
 * затронутой версии PHP. Reload (а не restart) — чтобы не убивать активные
 * запросы.
 */

import * as path from 'node:path';

import { artifactAnchor } from '@meowbox/shared';

import type { SystemMigration, MigrationContext } from './_types';

const PHP_FPM_BASE = '/etc/php';
const OLD_LINE = 'php_admin_value[disable_functions] = exec,passthru,shell_exec,system,proc_open,popen';
const NEW_LINE = 'php_admin_value[disable_functions] = exec,passthru,shell_exec,system,popen';

const migration: SystemMigration = {
  id: '2026-05-05-001-allow-proc-open-default',
  description: 'Убрать proc_open из дефолтного disable_functions в существующих PHP-FPM pool-файлах',

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

      const content = await ctx.readFile(poolFile);
      const lines = content.split('\n');

      let changed = false;
      const out = lines.map((line) => {
        // Точное совпадение базовой строки (без leading whitespace в нашем шаблоне).
        if (line.trimEnd() === OLD_LINE) {
          changed = true;
          return NEW_LINE;
        }
        return line;
      });

      if (!changed) {
        // Проверим — это «уже хорошо» или «юзер переопределил»?
        const hasNew = lines.some((l) => l.trimEnd() === NEW_LINE);
        if (hasNew) {
          alreadyOk++;
          ctx.log(`  [${site.name}] уже без proc_open — skip`);
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
            // reload может упасть если демон не запущен — попробуем restart
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
