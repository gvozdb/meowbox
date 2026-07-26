/**
 * Делает системный certbot.timer единственным владельцем авто-renew и
 * пересобирает nginx-конфиги так, чтобы HTTP-01 работал при любом значении
 * httpsRedirect.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { nginxZoneName, siteNginxOverrides, SslStatus } from '@meowbox/shared';

import type { MigrationContext, SystemMigration } from './_types';

const SITES_AVAILABLE = '/etc/nginx/sites-available';
const SITES_ENABLED = '/etc/nginx/sites-enabled';
const RENEW_HOOK_PATH = '/etc/letsencrypt/renewal-hooks/deploy/meowbox-reload-nginx';
const SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
const RENEW_HOOK_BODY = `#!/usr/bin/env bash
# Установлено Meowbox: 2026-07-26-001-ssl-renewal-reliability
set -euo pipefail
nginx -t
systemctl reload nginx
`;

interface FileBackup {
  file: string;
  content: string | null;
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
  }): {
    mainConfig: string;
  };
}

function parseAliases(raw: string | null | undefined): Array<{ domain: string; redirect: boolean }> {
  if (!raw) return [];
  let aliases: unknown;
  try {
    aliases = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(aliases)) return [];

  const result: Array<{ domain: string; redirect: boolean }> = [];
  for (const alias of aliases) {
    if (alias && typeof alias === 'object' && typeof (alias as { domain?: unknown }).domain === 'string') {
      const domain = (alias as { domain: string }).domain.trim();
      if (domain) {
        result.push({ domain, redirect: (alias as { redirect?: unknown }).redirect === true });
      }
    } else if (typeof alias === 'string' && alias.trim()) {
      result.push({ domain: alias.trim(), redirect: false });
    }
  }
  return result;
}

function isUsableSsl(ssl: { status: string; certPath: string | null; keyPath: string | null } | null): boolean {
  return !!(
    ssl &&
    (ssl.status === SslStatus.ACTIVE ||
      ssl.status === SslStatus.EXPIRING_SOON ||
      ssl.status === SslStatus.EXPIRED) &&
    ssl.certPath &&
    ssl.keyPath
  );
}

function chainPathForFullchain(certPath: string | null | undefined): string | null {
  if (!certPath || certPath.includes('\0')) return null;
  const normalized = path.posix.normalize(certPath);
  if (!path.posix.isAbsolute(normalized) || path.posix.basename(normalized) !== 'fullchain.pem') {
    return null;
  }
  return path.posix.join(path.posix.dirname(normalized), 'chain.pem');
}

async function trustedPathForCert(
  ctx: MigrationContext,
  certPath: string | null | undefined,
): Promise<string | null> {
  const chainPath = chainPathForFullchain(certPath);
  if (chainPath && await ctx.exists(chainPath)) return chainPath;
  return await ctx.exists(SYSTEM_CA_BUNDLE) ? SYSTEM_CA_BUNDLE : null;
}

async function certHasOcspResponder(
  ctx: MigrationContext,
  certPath: string | null | undefined,
): Promise<boolean> {
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

async function findBinary(ctx: MigrationContext, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await ctx.exists(candidate)) return candidate;
  }
  return null;
}

async function restoreFiles(backups: FileBackup[]): Promise<void> {
  for (const backup of backups) {
    if (backup.content === null) {
      await fs.unlink(backup.file).catch(() => {});
      continue;
    }
    await fs.mkdir(path.dirname(backup.file), { recursive: true });
    await fs.writeFile(backup.file, backup.content, 'utf8');
  }
}

const migration: SystemMigration = {
  id: '2026-07-26-001-ssl-renewal-reliability',
  description: 'Надёжный certbot.timer + ACME HTTP для SSL-доменов без HTTPS-редиректа',

  async preflight(ctx) {
    const templatesPath = path.join(ctx.config.currentDir, 'agent', 'dist', 'nginx', 'templates.js');
    if (!(await ctx.exists(templatesPath))) {
      return { ok: false, reason: `agent/dist/nginx/templates.js не найден (${templatesPath})` };
    }
    if (!(await findBinary(ctx, ['/usr/bin/certbot', '/usr/local/bin/certbot']))) {
      return { ok: false, reason: 'certbot не установлен' };
    }
    const systemctl = await findBinary(ctx, ['/usr/bin/systemctl', '/bin/systemctl']);
    if (!systemctl) return { ok: false, reason: 'systemctl не найден' };
    try {
      await ctx.exec.run(systemctl, ['cat', 'certbot.timer']);
    } catch {
      return { ok: false, reason: 'systemd unit certbot.timer не найден' };
    }
    return { ok: true };
  },

  async up(ctx) {
    const templatesPath = path.join(ctx.config.currentDir, 'agent', 'dist', 'nginx', 'templates.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const templates: AgentTemplatesModule = require(templatesPath);
    if (typeof templates.renderNginxSite !== 'function') {
      throw new Error('agent templates.js не экспортирует renderNginxSite');
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
        const sslEnabled = isUsableSsl(ssl);
        const trustedCertPath = sslEnabled ? await trustedPathForCert(ctx, ssl!.certPath) : null;
        const ocspStapling = sslEnabled && trustedCertPath
          ? await certHasOcspResponder(ctx, ssl!.certPath)
          : false;

        domains.push({
          domainId: domain.id,
          domain: domain.domain,
          aliases: parseAliases(domain.aliases),
          filesRelPath: domain.filesRelPath?.trim() || site.filesRelPath?.trim() || 'www',
          appPort: domain.appPort ?? null,
          sslEnabled,
          certPath: sslEnabled ? ssl!.certPath : null,
          keyPath: sslEnabled ? ssl!.keyPath : null,
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
      const file = path.join(SITES_AVAILABLE, `${site.name}.conf`);
      const current = await fs.readFile(file, 'utf8').catch(() => null);
      if (current !== rendered.mainConfig) writes.push({ file, content: rendered.mainConfig });
    }

    const currentHook = await fs.readFile(RENEW_HOOK_PATH, 'utf8').catch(() => null);
    const hookChanged = currentHook !== RENEW_HOOK_BODY;
    if (ctx.dryRun) {
      ctx.log(`[dry-run] would: update hook=${hookChanged}, rewrite nginx configs=${writes.length}, enable certbot.timer`);
      return;
    }

    const nginx = await findBinary(ctx, ['/usr/sbin/nginx', '/usr/local/sbin/nginx', '/usr/bin/nginx']);
    const systemctl = await findBinary(ctx, ['/usr/bin/systemctl', '/bin/systemctl']);
    if (!nginx || !systemctl) throw new Error('nginx или systemctl не найден');

    const backups: FileBackup[] = [
      { file: RENEW_HOOK_PATH, content: currentHook },
      ...await Promise.all(writes.map(async ({ file }) => ({
        file,
        content: await fs.readFile(file, 'utf8').catch(() => null),
      }))),
    ];
    const createdLinks: string[] = [];

    try {
      if (hookChanged) {
        await ctx.writeFile(RENEW_HOOK_PATH, RENEW_HOOK_BODY, 0o755);
      }
      await fs.chmod(RENEW_HOOK_PATH, 0o755);

      await ctx.exec.run(systemctl, ['enable', '--now', 'certbot.timer']);

      for (const item of writes) {
        await ctx.writeFile(item.file, item.content, 0o644);
        const enabled = path.join(SITES_ENABLED, path.basename(item.file));
        if (!(await ctx.exists(enabled))) {
          await fs.symlink(item.file, enabled);
          createdLinks.push(enabled);
        }
        ctx.log(`updated ${item.file}`);
      }

      await ctx.exec.run(nginx, ['-t']);
      if (writes.length > 0) await ctx.exec.run(systemctl, ['reload', 'nginx']);
      await ctx.exec.run(systemctl, ['is-enabled', 'certbot.timer']);
      await ctx.exec.run(systemctl, ['is-active', 'certbot.timer']);
    } catch (err) {
      ctx.log(`SSL renewal migration failed: ${(err as Error).message} — rollback`);
      for (const link of createdLinks) await fs.unlink(link).catch(() => {});
      await restoreFiles(backups);
      await fs.chmod(RENEW_HOOK_PATH, 0o755).catch(() => {});
      await ctx.exec.run(nginx, ['-t']).catch(() => {});
      await ctx.exec.run(systemctl, ['reload', 'nginx']).catch(() => {});
      throw err;
    }

    ctx.log(`OK: hook=${hookChanged ? 'updated' : 'current'}, nginx=${writes.length}, certbot.timer=active`);
  },
};

export default migration;
