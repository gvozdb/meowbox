/**
 * Переводит все HTTP-01 challenge на стабильный общий webroot.
 *
 * Certbot сохраняет webroot в renewal/*.conf. Если webroot домена меняется
 * после выпуска сертификата, renew начинает получать 404. Общая директория
 * разрывает эту зависимость.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { nginxZoneName, siteNginxOverrides, SslStatus } from '@meowbox/shared';

import type { MigrationContext, SystemMigration } from './_types';

const ACME_WEBROOT = '/var/www/meowbox-acme';
const RENEWAL_DIR = '/etc/letsencrypt/renewal';
const SITES_AVAILABLE = '/etc/nginx/sites-available';
const SITES_ENABLED = '/etc/nginx/sites-enabled';
const MEOWBOX_INCLUDE_DIR = '/etc/nginx/meowbox';
const SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';

interface FileWrite {
  file: string;
  content: string;
  mode: number;
}

interface FileBackup {
  file: string;
  content: string | null;
  mode: number;
}

interface SiteRenderInput {
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
}

interface AgentTemplatesModule {
  renderNginxSite(site: SiteRenderInput): {
    mainConfig: string;
    domains: Array<{ domainId: string; chunks: Record<string, string> }>;
  };
}

interface AgentNginxManagerModule {
  renderStoppedNginxSite(site: SiteRenderInput): string;
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

function rewriteRenewalWebroot(content: string): string {
  if (!/^authenticator\s*=\s*webroot\s*$/m.test(content)) return content;

  let inWebrootMap = false;
  return content
    .split('\n')
    .map((line) => {
      if (/^\s*\[\[webroot_map\]\]\s*$/.test(line)) {
        inWebrootMap = true;
        return line;
      }
      if (/^\s*\[/.test(line)) inWebrootMap = false;
      if (/^webroot_path\s*=/.test(line)) {
        return `webroot_path = ${ACME_WEBROOT},`;
      }
      if (inWebrootMap) {
        const mapEntry = line.match(/^(\s*[^#=\s][^=]*?)\s*=\s*.*$/);
        if (mapEntry) return `${mapEntry[1].trim()} = ${ACME_WEBROOT}`;
      }
      return line;
    })
    .join('\n');
}

async function findBinary(ctx: MigrationContext, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await ctx.exists(candidate)) return candidate;
  }
  return null;
}

async function currentMode(file: string, fallback: number): Promise<number> {
  return fs.stat(file).then((stat) => stat.mode & 0o777).catch(() => fallback);
}

async function restoreFiles(backups: FileBackup[]): Promise<void> {
  for (const backup of backups) {
    if (backup.content === null) {
      await fs.unlink(backup.file).catch(() => {});
      continue;
    }
    await fs.mkdir(path.dirname(backup.file), { recursive: true });
    await fs.writeFile(backup.file, backup.content, 'utf8');
    await fs.chmod(backup.file, backup.mode).catch(() => {});
  }
}

const migration: SystemMigration = {
  id: '2026-07-26-003-stable-acme-webroot',
  description: 'Стабильный общий ACME webroot для выпуска и продления сертификатов',

  async preflight(ctx) {
    const templatesPath = path.join(ctx.config.currentDir, 'agent', 'dist', 'nginx', 'templates.js');
    const managerPath = path.join(ctx.config.currentDir, 'agent', 'dist', 'nginx', 'nginx.manager.js');
    if (!(await ctx.exists(templatesPath)) || !(await ctx.exists(managerPath))) {
      return { ok: false, reason: 'Собранные agent nginx modules не найдены' };
    }
    if (!(await findBinary(ctx, ['/usr/sbin/nginx', '/usr/local/sbin/nginx', '/usr/bin/nginx']))) {
      return { ok: false, reason: 'nginx не найден' };
    }
    return { ok: true };
  },

  async up(ctx) {
    const templatesPath = path.join(ctx.config.currentDir, 'agent', 'dist', 'nginx', 'templates.js');
    const managerPath = path.join(ctx.config.currentDir, 'agent', 'dist', 'nginx', 'nginx.manager.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const templates: AgentTemplatesModule = require(templatesPath);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const manager: AgentNginxManagerModule = require(managerPath);
    if (typeof templates.renderNginxSite !== 'function' || typeof manager.renderStoppedNginxSite !== 'function') {
      throw new Error('Agent nginx renderer exports не найдены');
    }

    const writes: FileWrite[] = [];
    const sites = await ctx.prisma.site.findMany({
      include: {
        domains: { include: { sslCertificate: true }, orderBy: { position: 'asc' } },
      },
    });

    for (const site of sites) {
      if (site.domains.length === 0) continue;

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

      const input: SiteRenderInput = {
        siteName: site.name,
        rootPath: site.rootPath,
        phpEnabled: !!site.phpVersion,
        phpVersion: site.phpVersion ?? undefined,
        systemUser: site.systemUser ?? undefined,
        domains,
      };
      const mainPath = path.join(SITES_AVAILABLE, `${site.name}.conf`);

      if (site.status === 'STOPPED') {
        const content = manager.renderStoppedNginxSite(input);
        const current = await fs.readFile(mainPath, 'utf8').catch(() => null);
        if (current !== content) writes.push({ file: mainPath, content, mode: 0o644 });
        continue;
      }

      const rendered = templates.renderNginxSite(input);
      const currentMain = await fs.readFile(mainPath, 'utf8').catch(() => null);
      if (currentMain !== rendered.mainConfig) {
        writes.push({ file: mainPath, content: rendered.mainConfig, mode: 0o644 });
      }
      for (const domain of rendered.domains) {
        for (const [filename, content] of Object.entries(domain.chunks)) {
          const file = path.join(MEOWBOX_INCLUDE_DIR, site.name, domain.domainId, filename);
          const current = await fs.readFile(file, 'utf8').catch(() => null);
          if (current !== content) writes.push({ file, content, mode: 0o644 });
        }
      }
    }

    const renewalFiles = await fs.readdir(RENEWAL_DIR).catch(() => []);
    for (const filename of renewalFiles.filter((file) => file.endsWith('.conf'))) {
      const file = path.join(RENEWAL_DIR, filename);
      const current = await fs.readFile(file, 'utf8').catch(() => null);
      if (current === null) continue;
      const content = rewriteRenewalWebroot(current);
      if (content !== current) {
        writes.push({ file, content, mode: await currentMode(file, 0o600) });
      }
    }

    if (ctx.dryRun) {
      ctx.log(`[dry-run] would: ensure ${ACME_WEBROOT}, rewrite files=${writes.length}`);
      return;
    }

    const nginx = await findBinary(ctx, ['/usr/sbin/nginx', '/usr/local/sbin/nginx', '/usr/bin/nginx']);
    const systemctl = await findBinary(ctx, ['/usr/bin/systemctl', '/bin/systemctl']);
    if (!nginx || !systemctl) throw new Error('nginx или systemctl не найден');

    const backups: FileBackup[] = await Promise.all(writes.map(async ({ file, mode }) => ({
      file,
      content: await fs.readFile(file, 'utf8').catch(() => null),
      mode: await currentMode(file, mode),
    })));
    const createdLinks: string[] = [];

    try {
      await fs.mkdir(ACME_WEBROOT, { recursive: true, mode: 0o755 });
      await fs.chmod(ACME_WEBROOT, 0o755);

      for (const item of writes) {
        await ctx.writeFile(item.file, item.content, item.mode);
        if (item.file.startsWith(`${SITES_AVAILABLE}/`)) {
          const enabled = path.join(SITES_ENABLED, path.basename(item.file));
          if (!(await ctx.exists(enabled))) {
            await fs.symlink(item.file, enabled);
            createdLinks.push(enabled);
          }
        }
        ctx.log(`updated ${item.file}`);
      }

      await ctx.exec.run(nginx, ['-t']);
      if (writes.length > 0) await ctx.exec.run(systemctl, ['reload', 'nginx']);
    } catch (err) {
      ctx.log(`Stable ACME migration failed: ${(err as Error).message} — rollback`);
      for (const link of createdLinks) await fs.unlink(link).catch(() => {});
      await restoreFiles(backups);
      await ctx.exec.run(nginx, ['-t']).catch(() => {});
      await ctx.exec.run(systemctl, ['reload', 'nginx']).catch(() => {});
      throw err;
    }

    ctx.log(`OK: ACME webroot=${ACME_WEBROOT}, files=${writes.length}`);
  },
};

export default migration;
