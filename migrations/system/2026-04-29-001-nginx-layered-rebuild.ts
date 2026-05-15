/**
 * Перевод существующих сайтов на layered nginx-структуру.
 *
 * До: один монолитный конфиг `/etc/nginx/sites-available/{name}.conf`,
 * который перегенерируется панелью целиком — кастомы юзера затираются при
 * любом изменении настроек.
 *
 * После:
 *   /etc/nginx/sites-available/{name}.conf  ← главный (server { include meowbox/{name}/*.conf; })
 *   /etc/nginx/meowbox/{name}/00-server.conf, 10-ssl.conf, 20-php.conf,
 *                              40-static.conf, 50-security.conf — управляются панелью
 *   /etc/nginx/meowbox/{name}/95-custom.conf  ← редактируется юзером в UI
 *
 * Что делает миграция:
 *  1. Для каждого сайта где `nginxCustomConfig` пустой/NULL — записывает в БД
 *     стартовый CMS-блок (initialCustomConfigFor по типу сайта).
 *  2. Импортирует `renderNginxBundle` из агентского `dist/nginx/templates.js`
 *     (агент уже собран на момент применения миграции) и рендерит layered-файлы
 *     прямо на диск + поднимает симлинк sites-enabled.
 *  3. `nginx -t` + `systemctl reload nginx`. Если nginx-t упал — идёт rollback
 *     из бэкапа `.legacy-monolith.conf` для каждого сайта.
 *
 * Идемпотентность:
 *  - повторный запуск НЕ перетирает 95-custom.conf (если уже есть на диске),
 *  - повторный запуск НЕ ломает БД (initialCustomConfigFor применяется только
 *    к сайтам с пустым `nginxCustomConfig`).
 *
 * ВАЖНО: миграция self-contained — НЕ требует работающего API/agent (только
 * скомпилированный agent/dist на диске). Может выполняться на свежесобранном
 * релизе перед стартом PM2.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  initialCustomConfigFor,
  siteNginxOverrides,
  type SiteNginxColumns,
} from '@meowbox/shared';

import type { SystemMigration } from './_types';

const SITES_AVAILABLE = '/etc/nginx/sites-available';
const SITES_ENABLED = '/etc/nginx/sites-enabled';
const MEOWBOX_INCLUDE_DIR = '/etc/nginx/meowbox';

interface AgentTemplatesModule {
  renderNginxBundle(p: {
    siteName: string;
    domain: string;
    aliases: Array<string | { domain: string; redirect?: boolean }>;
    rootPath: string;
    filesRelPath?: string;
    phpVersion?: string;
    phpEnabled?: boolean;
    appPort?: number;
    sslEnabled?: boolean;
    httpsRedirect?: boolean;
    certPath?: string;
    keyPath?: string;
    settings?: ReturnType<typeof siteNginxOverrides>;
  }): {
    mainConfig: string;
    chunks: Record<string, string>;
  };
}

const migration: SystemMigration = {
  id: '2026-04-29-001-nginx-layered-rebuild',
  description: 'Перевод существующих сайтов на layered nginx (meowbox/{name}/*.conf)',

  async preflight(ctx) {
    // Нужен скомпилированный agent (templates.js).
    const agentTemplatesPath = path.join(ctx.config.currentDir, 'agent', 'dist', 'nginx', 'templates.js');
    if (!(await ctx.exists(agentTemplatesPath))) {
      return { ok: false, reason: `agent/dist/nginx/templates.js не найден (${agentTemplatesPath}). Сначала make build.` };
    }
    return { ok: true };
  },

  async up(ctx) {
    const agentTemplatesPath = path.join(ctx.config.currentDir, 'agent', 'dist', 'nginx', 'templates.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const templates: AgentTemplatesModule = require(agentTemplatesPath);

    const sites = await ctx.prisma.site.findMany({
      include: { sslCertificates: true },
    });

    if (sites.length === 0) {
      ctx.log('Нет сайтов в БД — миграция no-op');
      return;
    }

    ctx.log(`Найдено сайтов: ${sites.length}`);

    let dbUpdated = 0;
    let configsRendered = 0;
    let alreadyLayered = 0;

    for (const site of sites) {
      // 1. Заполняем nginxCustomConfig стартовым CMS-блоком, если он пустой.
      let customConfigForFile = site.nginxCustomConfig ?? '';
      if (!customConfigForFile.trim()) {
        const initial = initialCustomConfigFor(site.type);
        if (!ctx.dryRun) {
          await ctx.prisma.site.update({
            where: { id: site.id },
            data: { nginxCustomConfig: initial },
          });
        }
        customConfigForFile = initial;
        dbUpdated++;
        ctx.log(`  [${site.name}] init custom-блок (${site.type}, ${initial.length} chars)`);
      }

      // 2. Если уже layered — пропускаем (быстрая проверка по сигнатуре include).
      const mainPath = path.join(SITES_AVAILABLE, `${site.name}.conf`);
      const includeDir = path.join(MEOWBOX_INCLUDE_DIR, site.name);
      try {
        const cur = await fs.readFile(mainPath, 'utf8');
        if (cur.includes(`include ${MEOWBOX_INCLUDE_DIR}/${site.name}/`)) {
          alreadyLayered++;
          ctx.log(`  [${site.name}] уже layered — skip`);
          continue;
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          ctx.log(`  [${site.name}] !! read ${mainPath}: ${(e as Error).message}`);
        }
      }

      if (ctx.dryRun) {
        ctx.log(`  [${site.name}] would render layered (dry-run)`);
        continue;
      }

      // 3. Бэкап монолита перед перезаписью.
      await fs.mkdir(includeDir, { recursive: true });
      try {
        const cur = await fs.readFile(mainPath, 'utf8').catch(() => null);
        if (cur) {
          await fs.writeFile(path.join(includeDir, '.legacy-monolith.conf'), cur, 'utf8');
        }
      } catch (e) {
        ctx.log(`  [${site.name}] !! backup failed: ${(e as Error).message}`);
      }

      // 4. Рендерим layered.
      const ssl = (site as { sslCertificates?: Array<{ status?: string; certPath?: string | null; keyPath?: string | null }> }).sslCertificates?.[0];
      const sslActive = !!(ssl && ssl.status === 'ACTIVE' && ssl.certPath && ssl.keyPath);
      const aliases = (() => {
        try { return JSON.parse(site.aliases || '[]'); } catch { return []; }
      })();

      const bundle = templates.renderNginxBundle({
        siteName: site.name,
        domain: site.domain,
        aliases,
        rootPath: site.rootPath,
        filesRelPath: site.filesRelPath ?? 'www',
        phpVersion: site.phpVersion ?? undefined,
        phpEnabled: !!site.phpVersion,
        appPort: site.appPort ?? undefined,
        sslEnabled: sslActive,
        certPath: sslActive ? ssl!.certPath ?? undefined : undefined,
        keyPath: sslActive ? ssl!.keyPath ?? undefined : undefined,
        httpsRedirect: site.httpsRedirect,
        settings: siteNginxOverrides(site as unknown as SiteNginxColumns),
      });

      // 5. Пишем чанки 00-50.
      for (const [filename, content] of Object.entries(bundle.chunks)) {
        await fs.writeFile(path.join(includeDir, filename), content, 'utf8');
        await fs.chmod(path.join(includeDir, filename), 0o644).catch(() => {});
      }

      // 6. Пишем 95-custom.conf только если на диске нет (или БД-значение появилось только что).
      const customPath = path.join(includeDir, '95-custom.conf');
      const customExists = await ctx.exists(customPath);
      if (!customExists && customConfigForFile) {
        await fs.writeFile(customPath, customConfigForFile, 'utf8');
        await fs.chmod(customPath, 0o644).catch(() => {});
      }

      // 7. Главный файл (skeleton).
      await fs.writeFile(mainPath, bundle.mainConfig, 'utf8');
      await fs.chmod(mainPath, 0o644).catch(() => {});

      // 8. Симлинк sites-enabled.
      const link = path.join(SITES_ENABLED, `${site.name}.conf`);
      await fs.unlink(link).catch(() => {});
      await fs.symlink(mainPath, link);

      configsRendered++;
      ctx.log(`  [${site.name}] rendered layered (chunks=${Object.keys(bundle.chunks).length}, custom=${customExists ? 'kept' : 'init'})`);
    }

    // 9. nginx -t + reload — финальная валидация.
    if (!ctx.dryRun && configsRendered > 0) {
      // Ищем nginx-бинарь устойчиво — в окружении миграции PATH может не
      // содержать /usr/sbin (root-юзер с ограниченным PATH через PM2/systemd).
      const nginxBin = await findBinary(ctx, ['/usr/sbin/nginx', '/usr/local/sbin/nginx', '/usr/bin/nginx']);
      if (!nginxBin) {
        ctx.log('nginx бинарь не найден (PATH + /usr/sbin + /usr/local/sbin) — пропускаю nginx -t');
        ctx.log('Перезагрузка nginx будет нужна вручную: sudo systemctl reload nginx');
        ctx.log(`OK: db_updated=${dbUpdated}, layered_rendered=${configsRendered}, already_layered=${alreadyLayered}`);
        return;
      }
      try {
        const r = await ctx.exec.run(nginxBin, ['-t']);
        ctx.log(`nginx -t OK (${(r.stderr || '').replace(/\n/g, ' ').slice(0, 200)})`);
        const systemctlBin = await findBinary(ctx, ['/usr/bin/systemctl', '/bin/systemctl']);
        if (systemctlBin) {
          await ctx.exec.run(systemctlBin, ['reload', 'nginx']).catch((e) => {
            ctx.log(`systemctl reload nginx skipped: ${(e as Error).message}`);
          });
        }
      } catch (e) {
        ctx.log(`nginx -t FAILED: ${(e as Error).message}`);
        // Откат: восстанавливаем монолит для каждого, кого только что переписали.
        for (const site of sites) {
          const mainPath = path.join(SITES_AVAILABLE, `${site.name}.conf`);
          const backupPath = path.join(MEOWBOX_INCLUDE_DIR, site.name, '.legacy-monolith.conf');
          if (await ctx.exists(backupPath)) {
            try {
              await fs.copyFile(backupPath, mainPath);
              ctx.log(`  [${site.name}] rolled back from legacy-monolith`);
            } catch (e2) {
              ctx.log(`  [${site.name}] !! rollback failed: ${(e2 as Error).message}`);
            }
          }
        }
        throw new Error(`nginx -t failed после миграции — выполнен откат к монолитам. Детали: ${(e as Error).message}`);
      }
    }

    ctx.log(`OK: db_updated=${dbUpdated}, layered_rendered=${configsRendered}, already_layered=${alreadyLayered}`);
  },
};

async function findBinary(
  ctx: Parameters<NonNullable<SystemMigration['preflight']>>[0],
  candidates: string[],
): Promise<string | null> {
  for (const p of candidates) {
    if (await ctx.exists(p)) return p;
  }
  return null;
}

export default migration;
