/**
 * Bootstrap rate-limit zones для существующих сайтов (one-shot).
 *
 * Что делает:
 *   1. Читает все сайты из БД.
 *   2. Генерирует `/etc/nginx/conf.d/meowbox-zones.conf`:
 *      - legacy zone `site_limit` (для старых конфигов, ещё не пере-генерены)
 *      - per-site zone `site_<name>` для каждого сайта (rate из БД или 30 по умолчанию)
 *   3. nginx -t + reload (с откатом из бэкапа при fail).
 *
 * Идемпотентно: повторный запуск просто перепишет файл с теми же значениями.
 *
 * Зачем нужна:
 *   - На свежесмигрированных серверах поле `nginx_rate_limit_*` = NULL/default.
 *   - Старые конфиги сайтов ссылаются на `site_limit` (legacy zone) — нужна fallback-зона.
 *   - Новые сайты (после миграции 3) используют per-site `site_<name>` зоны.
 */

import * as fs from 'node:fs/promises';

import type { SystemMigration } from './_types';

const ZONES_PATH = '/etc/nginx/conf.d/meowbox-zones.conf';

interface SiteRow {
  name: string;
  nginxRateLimitEnabled: boolean | null;
  nginxRateLimitRps: number | null;
}

const migration: SystemMigration = {
  id: '2026-04-30-002-rate-limit-zones-bootstrap',
  description: 'Регенерирует /etc/nginx/conf.d/meowbox-zones.conf под per-site rate-limit zones',

  async up(ctx) {
    const sites = (await ctx.prisma.site.findMany({
      select: {
        name: true,
        nginxRateLimitEnabled: true,
        nginxRateLimitRps: true,
      },
    })) as SiteRow[];

    ctx.log(`Сайтов в БД: ${sites.length}`);

    const lines: string[] = [
      '# === Meowbox global rate-limit zones (управляется агентом + миграциями) ===',
      '# Файл регенерируется при создании/удалении сайта и при изменении rate-limit настроек.',
      '# Не редактируй вручную — изменения будут затёрты.',
      '',
      '# Legacy fallback zone (для конфигов сайтов, которые ещё не пере-генерены под per-site zone).',
      'limit_req_zone $binary_remote_addr zone=site_limit:10m rate=30r/s;',
      '',
    ];

    for (const s of sites) {
      const safe = s.name.replace(/[^a-zA-Z0-9_-]/g, '_');
      if (!safe) continue;
      const rate = s.nginxRateLimitRps && s.nginxRateLimitRps > 0 ? s.nginxRateLimitRps : 30;
      lines.push(`limit_req_zone $binary_remote_addr zone=site_${safe}:1m rate=${rate}r/s;`);
    }
    const content = lines.join('\n') + '\n';

    if (ctx.dryRun) {
      ctx.log(`would write ${ZONES_PATH} (${lines.length} lines, ${sites.length} per-site zones)`);
      return;
    }

    // Бэкап существующего файла.
    const backup = `${ZONES_PATH}.bak`;
    try { await fs.copyFile(ZONES_PATH, backup); } catch { /* nothing yet */ }

    await fs.mkdir('/etc/nginx/conf.d', { recursive: true });
    await fs.writeFile(ZONES_PATH, content, 'utf8');
    await fs.chmod(ZONES_PATH, 0o644).catch(() => {});

    // nginx -t. При fail — откат.
    try {
      await ctx.exec.run('/usr/sbin/nginx', ['-t']);
      ctx.log(`OK: ${ZONES_PATH} перезаписан (${sites.length} per-site zones)`);
      // Reload (best-effort).
      await ctx.exec.run('/usr/bin/systemctl', ['reload', 'nginx']).catch(() => {});
      await fs.unlink(backup).catch(() => {});
    } catch (e) {
      try { await fs.copyFile(backup, ZONES_PATH); } catch { /* */ }
      throw new Error(`nginx -t failed после регенерации zones: ${(e as Error).message}`);
    }
  },
};

export default migration;
