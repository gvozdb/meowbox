/**
 * Добавляет `ssl_trusted_certificate` в существующие nginx-конфиги сайтов.
 *
 * Меняли nginx-шаблон, значит по правилам проекта нужно регенерировать
 * существующие сайты. Миграция трогает только главный nginx-файл сайта:
 * managed chunks и пользовательский `95-custom.conf` не переписываются.
 *
 * Для уже импортированных custom-сертификатов в `/etc/ssl/meowbox/*` пытаемся
 * восстановить `chain.pem` из `fullchain.pem`: leaf остаётся первым, все
 * последующие PEM-блоки становятся chain.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { nginxZoneName, siteNginxOverrides } from '@meowbox/shared';

import type { MigrationContext, SystemMigration } from './_types';

const SITES_AVAILABLE = '/etc/nginx/sites-available';
const SITES_ENABLED = '/etc/nginx/sites-enabled';
const CUSTOM_SSL_DIR = '/etc/ssl/meowbox';
const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

interface RenderedNginxSite {
  mainConfig: string;
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
      httpsRedirect: boolean;
      zoneName: string;
      settings: ReturnType<typeof siteNginxOverrides>;
      customConfig?: string | null;
    }>;
  }): RenderedNginxSite;
}

interface MainBackup {
  siteName: string;
  main: string | null;
  enabledLink: string | null;
}

interface ChainBackup {
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

function certBlocks(pem: string): string[] {
  return (pem.match(PEM_CERT_RE) || []).map((block) => block.trim()).filter(Boolean);
}

function joinPem(blocks: string[]): string {
  return `${blocks.join('\n')}\n`;
}

function chainPathForFullchain(certPath: string | null | undefined): string | null {
  if (!certPath || certPath.includes('\0')) return null;
  const normalized = path.posix.normalize(certPath);
  if (!path.posix.isAbsolute(normalized)) return null;
  if (path.posix.basename(normalized) !== 'fullchain.pem') return null;
  return path.posix.join(path.posix.dirname(normalized), 'chain.pem');
}

function isCustomMeowboxFullchain(certPath: string | null | undefined): boolean {
  if (!certPath || certPath.includes('\0')) return false;
  const normalized = path.posix.normalize(certPath);
  return normalized === path.posix.join(CUSTOM_SSL_DIR, path.posix.relative(CUSTOM_SSL_DIR, normalized))
    && path.posix.basename(normalized) === 'fullchain.pem'
    && !path.posix.relative(CUSTOM_SSL_DIR, normalized).startsWith('..');
}

async function findBinary(ctx: MigrationContext, candidates: string[]): Promise<string | null> {
  for (const file of candidates) {
    if (await ctx.exists(file)) return file;
  }
  return null;
}

async function ensureCustomChainFile(
  ctx: MigrationContext,
  certPath: string | null | undefined,
  chainBackups: Map<string, ChainBackup>,
): Promise<string | null> {
  if (!isCustomMeowboxFullchain(certPath)) return null;
  const chainPath = chainPathForFullchain(certPath);
  if (!chainPath) return null;
  if (await ctx.exists(chainPath)) return chainPath;

  const fullchain = await fs.readFile(certPath!, 'utf8').catch(() => null);
  if (!fullchain) return null;
  const blocks = certBlocks(fullchain);
  if (blocks.length < 2) return null;

  if (!chainBackups.has(chainPath)) {
    chainBackups.set(chainPath, {
      file: chainPath,
      content: await fs.readFile(chainPath, 'utf8').catch(() => null),
    });
  }

  if (ctx.dryRun) {
    ctx.log(`[dry-run] would: write ${chainPath} from ${certPath}`);
    return chainPath;
  }

  await fs.writeFile(chainPath, joinPem(blocks.slice(1)), 'utf8');
  await fs.chmod(chainPath, 0o644).catch(() => {});
  ctx.log(`  chain.pem восстановлен: ${chainPath}`);
  return chainPath;
}

async function trustedPathForCert(ctx: MigrationContext, certPath: string | null | undefined): Promise<string | null> {
  const chainPath = chainPathForFullchain(certPath);
  if (!chainPath) return null;
  return await ctx.exists(chainPath) ? chainPath : null;
}

async function backupMain(siteName: string): Promise<MainBackup> {
  const mainPath = path.join(SITES_AVAILABLE, `${siteName}.conf`);
  const enabledPath = path.join(SITES_ENABLED, `${siteName}.conf`);
  let enabledLink: string | null = null;
  try {
    enabledLink = await fs.readlink(enabledPath);
  } catch {
    enabledLink = null;
  }
  return {
    siteName,
    main: await fs.readFile(mainPath, 'utf8').catch(() => null),
    enabledLink,
  };
}

async function restoreMain(backup: MainBackup): Promise<void> {
  const mainPath = path.join(SITES_AVAILABLE, `${backup.siteName}.conf`);
  const enabledPath = path.join(SITES_ENABLED, `${backup.siteName}.conf`);
  if (backup.main === null) {
    await fs.unlink(mainPath).catch(() => {});
  } else {
    await fs.mkdir(path.dirname(mainPath), { recursive: true });
    await fs.writeFile(mainPath, backup.main, 'utf8').catch(() => {});
    await fs.chmod(mainPath, 0o644).catch(() => {});
  }
  await fs.unlink(enabledPath).catch(() => {});
  if (backup.enabledLink) {
    await fs.symlink(backup.enabledLink, enabledPath).catch(() => {});
  }
}

async function restoreChainBackups(backups: Iterable<ChainBackup>): Promise<void> {
  for (const backup of backups) {
    if (backup.content === null) {
      await fs.unlink(backup.file).catch(() => {});
    } else {
      await fs.writeFile(backup.file, backup.content, 'utf8').catch(() => {});
      await fs.chmod(backup.file, 0o644).catch(() => {});
    }
  }
}

const migration: SystemMigration = {
  id: '2026-07-04-001-ssl-trusted-certificate-nginx',
  description: 'Nginx SSL: добавить ssl_trusted_certificate и восстановить chain.pem для imported/custom сертификатов',

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

    const chainBackups = new Map<string, ChainBackup>();
    const rendered: Array<{ siteName: string; mainConfig: string }> = [];

    for (const site of sites) {
      if (site.status === 'STOPPED') {
        ctx.log(`  [${site.name}] stopped — skip`);
        continue;
      }
      if (site.domains.length === 0) {
        ctx.log(`  [${site.name}] нет SiteDomain — skip`);
        continue;
      }

      const domains = [];
      for (const domain of site.domains) {
        const ssl = domain.sslCertificate;
        const sslActive = !!(ssl && ssl.status === 'ACTIVE' && ssl.certPath && ssl.keyPath);
        let trustedCertPath: string | null = null;
        if (sslActive) {
          await ensureCustomChainFile(ctx, ssl!.certPath, chainBackups);
          trustedCertPath = await trustedPathForCert(ctx, ssl!.certPath);
        }
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
          httpsRedirect: domain.httpsRedirect,
          zoneName: nginxZoneName(domain.id),
          settings: siteNginxOverrides(domain),
          customConfig: domain.nginxCustomConfig ?? null,
        });
      }

      const next = templates.renderNginxSite({
        siteName: site.name,
        rootPath: site.rootPath,
        phpEnabled: !!site.phpVersion,
        phpVersion: site.phpVersion ?? undefined,
        systemUser: site.systemUser ?? undefined,
        domains,
      }).mainConfig;

      const current = await fs.readFile(path.join(SITES_AVAILABLE, `${site.name}.conf`), 'utf8').catch(() => null);
      if (current === next) {
        ctx.log(`  [${site.name}] nginx main актуален — skip`);
        continue;
      }
      rendered.push({ siteName: site.name, mainConfig: next });
    }

    if (ctx.dryRun) {
      ctx.log(`[dry-run] would: rewrite nginx main configs for ${rendered.length} sites`);
      return;
    }

    if (rendered.length === 0 && chainBackups.size === 0) {
      ctx.log('nginx SSL trusted certificate config уже актуален');
      return;
    }

    const mainBackups = await Promise.all(rendered.map((item) => backupMain(item.siteName)));
    try {
      await fs.mkdir(SITES_AVAILABLE, { recursive: true });
      await fs.mkdir(SITES_ENABLED, { recursive: true });
      for (const item of rendered) {
        const mainPath = path.join(SITES_AVAILABLE, `${item.siteName}.conf`);
        const enabledPath = path.join(SITES_ENABLED, `${item.siteName}.conf`);
        await fs.writeFile(mainPath, item.mainConfig, 'utf8');
        await fs.chmod(mainPath, 0o644).catch(() => {});
        if (!(await ctx.exists(enabledPath))) {
          await fs.symlink(mainPath, enabledPath).catch(() => {});
        }
        ctx.log(`  [${item.siteName}] nginx main обновлён`);
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
      ctx.log(`nginx trusted certificate migration failed: ${(err as Error).message} — rollback`);
      await Promise.all(mainBackups.map((backup) => restoreMain(backup)));
      await restoreChainBackups(chainBackups.values());
      throw err;
    }

    ctx.log(`OK: nginx main configs=${rendered.length}, chain.pem restored=${chainBackups.size}`);
  },
};

export default migration;
