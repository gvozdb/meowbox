/**
 * Перерендеривает `10-ssl.conf` так, чтобы OCSP stapling включался только для
 * сертификатов с реальным OCSP responder URI.
 *
 * Let's Encrypt E7-сертификаты на текущих серверах могут не содержать OCSP URI.
 * Глобальный `ssl_stapling on` в таком случае даёт warning при `nginx -t`:
 *   "ssl_stapling" ignored, no OCSP responder URL in the certificate
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { nginxZoneName, siteNginxOverrides } from '@meowbox/shared';

import type { MigrationContext, SystemMigration } from './_types';

const MEOWBOX_INCLUDE_DIR = '/etc/nginx/meowbox';

interface RenderedNginxSite {
  domains: Array<{ domainId: string; chunks: Record<string, string> }>;
}

interface AgentTemplatesModule {
  renderNginxSite(site: {
    siteName: string;
    rootPath: string;
    phpEnabled: boolean;
    phpVersion?: string;
    systemUser?: string;
    domains: Array<{
      domainId: string;
      domain: string;
      aliases: Array<{ domain: string; redirect: boolean }>;
      filesRelPath: string;
      appPort?: number | null;
      sslEnabled: boolean;
      certPath?: string | null;
      keyPath?: string | null;
      trustedCertPath?: string | null;
      ocspStapling?: boolean | null;
      httpsRedirect: boolean;
      zoneName: string;
      settings: ReturnType<typeof siteNginxOverrides>;
      customConfig?: string | null;
    }>;
  }): RenderedNginxSite;
}

interface FileBackup {
  file: string;
  content: string | null;
}

function parseAliases(raw: string | null | undefined): Array<{ domain: string; redirect: boolean }> {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: Array<{ domain: string; redirect: boolean }> = [];
  for (const item of arr) {
    if (item && typeof item === 'object' && typeof (item as { domain?: unknown }).domain === 'string') {
      const domain = (item as { domain: string }).domain.trim();
      if (domain) out.push({ domain, redirect: (item as { redirect?: unknown }).redirect === true });
    } else if (typeof item === 'string' && item.trim()) {
      out.push({ domain: item.trim(), redirect: false });
    }
  }
  return out;
}

function chainPathForFullchain(certPath: string | null | undefined): string | null {
  if (!certPath || certPath.includes('\0')) return null;
  const normalized = path.posix.normalize(certPath);
  if (!path.posix.isAbsolute(normalized)) return null;
  if (path.posix.basename(normalized) !== 'fullchain.pem') return null;
  return path.posix.join(path.posix.dirname(normalized), 'chain.pem');
}

async function certHasOcspResponder(ctx: MigrationContext, certPath: string | null | undefined): Promise<boolean> {
  if (!certPath || certPath.includes('\0')) return false;
  const normalized = path.posix.normalize(certPath);
  if (!path.posix.isAbsolute(normalized)) return false;
  try {
    const result = await ctx.exec.run('openssl', ['x509', '-in', normalized, '-noout', '-ocsp_uri']);
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function trustedPathForCert(ctx: MigrationContext, certPath: string | null | undefined): Promise<string | null> {
  const chainPath = chainPathForFullchain(certPath);
  if (!chainPath) return null;
  return await ctx.exists(chainPath) ? chainPath : null;
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
  id: '2026-07-04-002-ssl-stapling-ocsp-guard',
  description: 'Nginx SSL: отключать OCSP stapling для сертификатов без OCSP responder URI',

  async preflight(ctx) {
    const templatesPath = path.join(ctx.config.currentDir, 'agent', 'dist', 'nginx', 'templates.js');
    if (!(await ctx.exists(templatesPath))) {
      return { ok: false, reason: `agent/dist/nginx/templates.js не найден (${templatesPath}). Сначала собери agent.` };
    }
    return { ok: true };
  },

  async up(ctx) {
    const templatesPath = path.join(ctx.config.currentDir, 'agent', 'dist', 'nginx', 'templates.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const templates: AgentTemplatesModule = require(templatesPath);
    if (typeof templates.renderNginxSite !== 'function') {
      throw new Error('agent templates.js не экспортирует renderNginxSite — пересобери agent.');
    }

    const sites = await ctx.prisma.site.findMany({
      include: {
        domains: { include: { sslCertificate: true }, orderBy: { position: 'asc' } },
      },
    });

    const writes: Array<{ file: string; content: string }> = [];

    for (const site of sites) {
      if (site.status === 'STOPPED' || site.domains.length === 0) continue;

      const domains = [];
      for (const domain of site.domains) {
        const ssl = domain.sslCertificate;
        const sslActive = !!(ssl && ssl.status === 'ACTIVE' && ssl.certPath && ssl.keyPath);
        const trustedCertPath = sslActive ? await trustedPathForCert(ctx, ssl!.certPath) : null;
        const ocspStapling = sslActive && trustedCertPath
          ? await certHasOcspResponder(ctx, ssl!.certPath)
          : false;
        domains.push({
          domainId: domain.id,
          domain: domain.domain,
          aliases: parseAliases(domain.aliases),
          filesRelPath: domain.filesRelPath?.trim() || site.filesRelPath?.trim() || 'www',
          appPort: domain.appPort ?? null,
          sslEnabled: sslActive,
          certPath: sslActive ? ssl!.certPath : null,
          keyPath: sslActive ? ssl!.keyPath : null,
          trustedCertPath,
          ocspStapling,
          httpsRedirect: domain.httpsRedirect,
          zoneName: nginxZoneName(domain.id),
          settings: siteNginxOverrides(domain),
          customConfig: domain.nginxCustomConfig ?? null,
        });
      }

      const rendered = templates.renderNginxSite({
        siteName: site.name,
        rootPath: site.rootPath,
        phpEnabled: !!site.phpVersion,
        phpVersion: site.phpVersion ?? undefined,
        systemUser: site.systemUser ?? undefined,
        domains,
      });

      for (const domain of rendered.domains) {
        const content = domain.chunks['10-ssl.conf'];
        if (typeof content !== 'string') continue;
        const file = path.join(MEOWBOX_INCLUDE_DIR, site.name, domain.domainId, '10-ssl.conf');
        const current = await fs.readFile(file, 'utf8').catch(() => null);
        if (current !== content) writes.push({ file, content });
      }
    }

    if (ctx.dryRun) {
      ctx.log(`[dry-run] would: rewrite ${writes.length} SSL chunks`);
      return;
    }
    if (writes.length === 0) {
      ctx.log('OCSP stapling chunks уже актуальны');
      return;
    }

    const backups: FileBackup[] = [];
    for (const item of writes) {
      backups.push({ file: item.file, content: await fs.readFile(item.file, 'utf8').catch(() => null) });
    }

    try {
      for (const item of writes) {
        await fs.mkdir(path.dirname(item.file), { recursive: true });
        await fs.writeFile(item.file, item.content, 'utf8');
        await fs.chmod(item.file, 0o644).catch(() => {});
        ctx.log(`  updated ${item.file}`);
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
      ctx.log(`OCSP stapling migration failed: ${(err as Error).message} — rollback`);
      await restoreBackups(backups);
      throw err;
    }

    ctx.log(`OK: SSL chunks updated=${writes.length}`);
  },
};

export default migration;
