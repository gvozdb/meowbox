/**
 * Удаляет stale `10-ssl.conf` у доменов, где SSL уже не активен в БД.
 *
 * В мульти-доменной раскладке главный server-блок всегда включает
 * `/etc/nginx/meowbox/<site>/<domainId>/*.conf`. Если SSL выключили, но старый
 * `10-ssl.conf` остался на диске, SSL-директивы продолжают попадать в обычный
 * HTTP server-блок. `NginxManager.createSiteConfig()` это чистит, миграция
 * доводит уже существующие сайты до того же состояния.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { SslStatus } from '@meowbox/shared';

import type { MigrationContext, SystemMigration } from './_types';

const MEOWBOX_INCLUDE_DIR = '/etc/nginx/meowbox';

interface FileBackup {
  file: string;
  content: string | null;
}

async function findBinary(ctx: MigrationContext, candidates: string[]): Promise<string | null> {
  for (const file of candidates) {
    if (await ctx.exists(file)) return file;
  }
  return null;
}

async function restoreBackups(backups: FileBackup[]): Promise<void> {
  for (const backup of backups) {
    if (backup.content === null) {
      await fs.unlink(backup.file).catch(() => {});
    } else {
      await fs.mkdir(path.dirname(backup.file), { recursive: true }).catch(() => {});
      await fs.writeFile(backup.file, backup.content, 'utf8').catch(() => {});
      await fs.chmod(backup.file, 0o644).catch(() => {});
    }
  }
}

const migration: SystemMigration = {
  id: '2026-07-04-003-remove-stale-ssl-chunks',
  description: 'Nginx SSL: удалить stale 10-ssl.conf у доменов без активного SSL',

  async up(ctx) {
    const sites = await ctx.prisma.site.findMany({
      include: {
        domains: { include: { sslCertificate: true } },
      },
    });

    const files: string[] = [];
    for (const site of sites) {
      for (const domain of site.domains) {
        const ssl = domain.sslCertificate;
        const sslActive = !!(
          ssl &&
          ssl.status === SslStatus.ACTIVE &&
          ssl.certPath &&
          ssl.keyPath
        );
        if (sslActive) continue;
        const file = path.join(MEOWBOX_INCLUDE_DIR, site.name, domain.id, '10-ssl.conf');
        if (await ctx.exists(file)) files.push(file);
      }
    }

    if (ctx.dryRun) {
      ctx.log(`[dry-run] would: remove ${files.length} stale SSL chunks`);
      return;
    }
    if (files.length === 0) {
      ctx.log('stale SSL chunks не найдены');
      return;
    }

    const backups: FileBackup[] = [];
    for (const file of files) {
      backups.push({ file, content: await fs.readFile(file, 'utf8').catch(() => null) });
    }

    try {
      for (const file of files) {
        await fs.unlink(file).catch(() => {});
        ctx.log(`  removed ${file}`);
      }

      const nginxBin = await findBinary(ctx, ['/usr/sbin/nginx', '/usr/local/sbin/nginx', '/usr/bin/nginx']);
      if (nginxBin) {
        await ctx.exec.run(nginxBin, ['-t']);
        const systemctlBin = await findBinary(ctx, ['/usr/bin/systemctl', '/bin/systemctl']);
        if (systemctlBin) {
          await ctx.exec.run(systemctlBin, ['reload', 'nginx']).catch((err) => {
            ctx.log(`systemctl reload nginx skipped: ${(err as Error).message}`);
          });
        }
      } else {
        ctx.log('nginx бинарь не найден — пропускаю nginx -t/reload');
      }
    } catch (err) {
      ctx.log(`remove stale SSL chunks failed: ${(err as Error).message} — rollback`);
      await restoreBackups(backups);
      throw err;
    }

    ctx.log(`OK: removed stale SSL chunks=${files.length}`);
  },
};

export default migration;
