#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  columnNumber,
  columnString,
  querySqliteJson,
} from './release/sqlite';
import { safeErrorMessage } from './release/redaction';
import { stableJson } from './release/stable';
import type { JsonObject } from './release/types';
import type {
  RuntimeArtifact,
  RuntimeHttpProbe,
  RuntimeManifest,
} from './runtime-manifest';
import {
  parseHookArguments,
  requiredAbsolutePath,
  requiredMode,
} from './hooks/cli';

const execFileAsync = promisify(execFile);
const SITE_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const DOMAIN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const RUNTIME_KEY_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const PHP_VERSION_RE = /^\d+\.\d+$/;
const SSL_USABLE = new Set(['ACTIVE', 'EXPIRING_SOON', 'EXPIRED']);
const SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';

interface AgentTemplates {
  renderNginxSite(site: RuntimeSite): {
    mainConfig: string;
    domains: Array<{
      domainId: string;
      chunks: Record<string, string>;
      customChunk?: { filename: string; content: string };
    }>;
  };
}

interface AgentNginxManager {
  renderStoppedNginxSite(site: RuntimeSite): string;
}

interface AgentPoolTemplate {
  renderPhpFpmPool(params: {
    siteName: string;
    domainId: string;
    domain: string;
    phpVersion: string;
    runtimeKey: string;
    isPrimary: boolean;
    systemUser?: string;
    rootPath: string;
    filesRelPath: string;
    sslEnabled: boolean;
    customConfig?: string | null;
  }): {
    content: string;
    poolFile: string;
    runtime: { socketPath: string | null };
  };
}

interface AgentZonesTemplate {
  renderNginxZones(
    zones: ReadonlyArray<{ zoneName: string; rps: number; enabled?: boolean }>,
  ): string;
}

interface AgentLogrotateTemplate {
  renderNginxLogrotate(): string;
  renderPhpLogrotate(
    runtimes: ReadonlyArray<{ runtimeKey: string; systemUser?: string | null }>,
  ): string;
}

interface RuntimeDomain {
  readonly id: string;
  readonly siteId: string;
  readonly domain: string;
  readonly aliases: Array<{ domain: string; redirect: boolean }>;
  readonly isPrimary: boolean;
  readonly position: number;
  readonly filesRelPath: string;
  readonly preset: string;
  readonly phpVersion: string | null;
  readonly phpPoolCustom: string | null;
  readonly runtimeKey: string;
  readonly appPort: number | null;
  readonly httpsRedirect: boolean;
  readonly nginxCustomConfig: string | null;
  readonly settings: Record<string, string | number | boolean | null>;
  readonly sslEnabled: boolean;
  readonly certPath: string | null;
  readonly keyPath: string | null;
  readonly trustedCertPath: string | null;
  readonly ocspStapling: boolean;
}

interface RuntimeSite {
  readonly siteName: string;
  readonly rootPath: string;
  readonly systemUser?: string;
  readonly domains: Array<{
    domainId: string;
    domain: string;
    aliases: Array<{ domain: string; redirect: boolean }>;
    filesRelPath: string;
    preset: string;
    phpVersion: string | null;
    runtimeKey: string;
    isPrimary: boolean;
    appPort: number | null;
    sslEnabled: boolean;
    certPath: string | null;
    keyPath: string | null;
    trustedCertPath: string | null;
    ocspStapling: boolean;
    httpsRedirect: boolean;
    zoneName: string;
    settings: Record<string, string | number | boolean | null>;
    customConfig: string | null;
  }>;
}

interface LoadedSite {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly rootPath: string;
  readonly systemUser: string | null;
  readonly domains: RuntimeDomain[];
}

function requiredText(row: JsonObject, key: string): string {
  const value = columnString(row, key);
  if (!value) throw new Error(`runtime DB field ${key} is missing`);
  return value;
}

function requiredBoolean(row: JsonObject, key: string): boolean {
  const value = columnNumber(row, key);
  if (value !== 0 && value !== 1) throw new Error(`runtime DB field ${key} is not boolean`);
  return value === 1;
}

function optionalBoolean(row: JsonObject, key: string): boolean | null {
  const value = columnNumber(row, key);
  if (value === null) return null;
  if (value !== 0 && value !== 1) throw new Error(`runtime DB field ${key} is not boolean`);
  return value === 1;
}

function parseAliases(raw: string): Array<{ domain: string; redirect: boolean }> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error('SiteDomain aliases is invalid JSON');
  }
  if (!Array.isArray(decoded)) throw new Error('SiteDomain aliases must be an array');
  return decoded.map((value) => {
    if (typeof value === 'string' && value.trim()) return { domain: value.trim(), redirect: false };
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (typeof record.domain === 'string' && record.domain.trim()) {
        return { domain: record.domain.trim(), redirect: record.redirect === true };
      }
    }
    throw new Error('SiteDomain aliases contains an invalid item');
  });
}

function zoneName(domainId: string): string {
  return `mb_${domainId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 24)}`;
}

function chainPathForFullchain(certPath: string | null): string | null {
  if (!certPath || certPath.includes('\0')) return null;
  const normalized = path.posix.normalize(certPath);
  if (!path.posix.isAbsolute(normalized) || path.posix.basename(normalized) !== 'fullchain.pem') return null;
  return path.posix.join(path.posix.dirname(normalized), 'chain.pem');
}

async function fileExists(file: string): Promise<boolean> {
  return fs.stat(file).then((metadata) => metadata.isFile()).catch(() => false);
}

async function trustedCertificate(certPath: string | null): Promise<string | null> {
  const chain = chainPathForFullchain(certPath);
  if (chain && await fileExists(chain)) return chain;
  return await fileExists(SYSTEM_CA_BUNDLE) ? SYSTEM_CA_BUNDLE : null;
}

async function hasOcspResponder(certPath: string | null): Promise<boolean> {
  if (!certPath || !path.posix.isAbsolute(certPath) || certPath.includes('\0')) return false;
  try {
    const result = await execFileAsync('openssl', ['x509', '-in', certPath, '-noout', '-ocsp_uri'], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function loadSites(database: string): Promise<LoadedSite[]> {
  const rows = await querySqliteJson(database, `
    SELECT
      s.id AS site_id,
      s.name AS site_name,
      s.status AS site_status,
      s.root_path AS root_path,
      s.site_user AS system_user,
      d.id AS domain_id,
      d.domain AS domain,
      d.aliases AS aliases,
      d.is_primary AS is_primary,
      d.position AS position,
      d.files_rel_path AS files_rel_path,
      d.preset AS preset,
      d.php_version AS php_version,
      d.php_pool_custom AS php_pool_custom,
      d.runtime_key AS runtime_key,
      d.app_port AS app_port,
      d.https_redirect AS https_redirect,
      d.nginx_client_max_body_size AS nginx_client_max_body_size,
      d.nginx_fastcgi_read_timeout AS nginx_fastcgi_read_timeout,
      d.nginx_fastcgi_send_timeout AS nginx_fastcgi_send_timeout,
      d.nginx_fastcgi_connect_timeout AS nginx_fastcgi_connect_timeout,
      d.nginx_fastcgi_buffer_size_kb AS nginx_fastcgi_buffer_size_kb,
      d.nginx_fastcgi_buffer_count AS nginx_fastcgi_buffer_count,
      d.nginx_http2 AS nginx_http2,
      d.nginx_hsts AS nginx_hsts,
      d.nginx_gzip AS nginx_gzip,
      d.nginx_rate_limit_enabled AS nginx_rate_limit_enabled,
      d.nginx_rate_limit_rps AS nginx_rate_limit_rps,
      d.nginx_rate_limit_burst AS nginx_rate_limit_burst,
      d.nginx_custom_config AS nginx_custom_config,
      c.status AS ssl_status,
      c.cert_path AS cert_path,
      c.key_path AS key_path
    FROM sites s
    INNER JOIN site_domains d ON d.site_id = s.id
    LEFT JOIN ssl_certificates c ON c.domain_id = d.id
    ORDER BY s.id, d.position, d.id;
  `);

  const sites = new Map<string, LoadedSite>();
  for (const row of rows) {
    const siteId = requiredText(row, 'site_id');
    const siteName = requiredText(row, 'site_name');
    const domainId = requiredText(row, 'domain_id');
    const runtimeKey = requiredText(row, 'runtime_key');
    const phpVersion = columnString(row, 'php_version');
    if (!SITE_NAME_RE.test(siteName)) throw new Error(`unsafe Site name for runtime render: ${siteId}`);
    if (!DOMAIN_ID_RE.test(domainId)) throw new Error(`unsafe SiteDomain id for runtime render: ${domainId}`);
    if (!RUNTIME_KEY_RE.test(runtimeKey)) throw new Error(`unsafe runtimeKey for SiteDomain ${domainId}`);
    if (phpVersion !== null && !PHP_VERSION_RE.test(phpVersion)) {
      throw new Error(`invalid PHP version for SiteDomain ${domainId}`);
    }

    let site = sites.get(siteId);
    if (!site) {
      site = {
        id: siteId,
        name: siteName,
        status: requiredText(row, 'site_status'),
        rootPath: requiredText(row, 'root_path'),
        systemUser: columnString(row, 'system_user'),
        domains: [],
      };
      sites.set(siteId, site);
    } else if (site.name !== siteName || site.rootPath !== requiredText(row, 'root_path')) {
      throw new Error(`inconsistent Site envelope for ${siteId}`);
    }

    const sslStatus = columnString(row, 'ssl_status');
    const certPath = columnString(row, 'cert_path');
    const keyPath = columnString(row, 'key_path');
    const sslEnabled = !!sslStatus && SSL_USABLE.has(sslStatus) && !!certPath && !!keyPath;
    const trustedCertPath = sslEnabled ? await trustedCertificate(certPath) : null;
    const ocspStapling = sslEnabled && !!trustedCertPath && await hasOcspResponder(certPath);
    const position = columnNumber(row, 'position');
    const appPort = columnNumber(row, 'app_port');
    if (position === null || !Number.isInteger(position) || position < 0) {
      throw new Error(`invalid SiteDomain position for ${domainId}`);
    }
    if (appPort !== null && (!Number.isInteger(appPort) || appPort < 1 || appPort > 65_535)) {
      throw new Error(`invalid appPort for SiteDomain ${domainId}`);
    }
    site.domains.push({
      id: domainId,
      siteId,
      domain: requiredText(row, 'domain'),
      aliases: parseAliases(requiredText(row, 'aliases')),
      isPrimary: requiredBoolean(row, 'is_primary'),
      position,
      filesRelPath: requiredText(row, 'files_rel_path'),
      preset: requiredText(row, 'preset'),
      phpVersion,
      phpPoolCustom: columnString(row, 'php_pool_custom'),
      runtimeKey,
      appPort,
      httpsRedirect: requiredBoolean(row, 'https_redirect'),
      nginxCustomConfig: columnString(row, 'nginx_custom_config'),
      settings: {
        clientMaxBodySize: columnString(row, 'nginx_client_max_body_size'),
        fastcgiReadTimeout: columnNumber(row, 'nginx_fastcgi_read_timeout'),
        fastcgiSendTimeout: columnNumber(row, 'nginx_fastcgi_send_timeout'),
        fastcgiConnectTimeout: columnNumber(row, 'nginx_fastcgi_connect_timeout'),
        fastcgiBufferSizeKb: columnNumber(row, 'nginx_fastcgi_buffer_size_kb'),
        fastcgiBufferCount: columnNumber(row, 'nginx_fastcgi_buffer_count'),
        http2: optionalBoolean(row, 'nginx_http2'),
        hsts: optionalBoolean(row, 'nginx_hsts'),
        gzip: optionalBoolean(row, 'nginx_gzip'),
        rateLimitEnabled: optionalBoolean(row, 'nginx_rate_limit_enabled'),
        rateLimitRps: columnNumber(row, 'nginx_rate_limit_rps'),
        rateLimitBurst: columnNumber(row, 'nginx_rate_limit_burst'),
      },
      sslEnabled,
      certPath: sslEnabled ? certPath : null,
      keyPath: sslEnabled ? keyPath : null,
      trustedCertPath,
      ocspStapling,
    });
  }
  for (const site of sites.values()) {
    const primaries = site.domains.filter((domain) => domain.isPrimary);
    if (primaries.length !== 1 || site.domains[0]?.position !== 0 || !site.domains[0]?.isPrimary) {
      throw new Error(`Site ${site.id} has an invalid primary-domain ordering`);
    }
  }
  return [...sites.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function loadAgentModule<T>(releaseRoot: string, relativePath: string): T {
  const file = path.join(releaseRoot, 'agent', 'dist', relativePath);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(file) as T;
}

function stagePathForTarget(stageRoot: string, target: string): string {
  return path.join(stageRoot, 'artifacts', target.slice(1));
}

async function addDesiredArtifact(
  artifacts: RuntimeArtifact[],
  stageRoot: string,
  target: string,
  content: string,
): Promise<void> {
  const encoded = Buffer.from(content, 'utf8');
  const metadata = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (metadata && !metadata.isFile()) throw new Error(`managed runtime target is not a regular file: ${target}`);
  const current = metadata ? await fs.readFile(target) : null;
  if (current?.equals(encoded)) return;
  const stagedPath = stagePathForTarget(stageRoot, target);
  await fs.mkdir(path.dirname(stagedPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(stagedPath, encoded, { mode: 0o600 });
  artifacts.push({
    action: metadata ? 'replace' : 'create',
    target,
    stagedPath,
    sha256: createHash('sha256').update(encoded).digest('hex'),
    mode: 0o644,
    uid: 0,
    gid: 0,
  });
}

async function collectFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`managed runtime tree contains a symlink: ${absolute}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) result.push(absolute);
      else throw new Error(`managed runtime tree contains an unsupported entry: ${absolute}`);
    }
  };
  await walk(root);
  return result.sort();
}

function runtimeSite(site: LoadedSite): RuntimeSite {
  return {
    siteName: site.name,
    rootPath: site.rootPath,
    systemUser: site.systemUser ?? undefined,
    domains: site.domains.map((domain) => ({
      domainId: domain.id,
      domain: domain.domain,
      aliases: domain.aliases,
      filesRelPath: domain.filesRelPath,
      preset: domain.preset,
      phpVersion: domain.phpVersion,
      runtimeKey: domain.runtimeKey,
      isPrimary: domain.isPrimary,
      appPort: domain.appPort,
      sslEnabled: domain.sslEnabled,
      certPath: domain.certPath,
      keyPath: domain.keyPath,
      trustedCertPath: domain.trustedCertPath,
      ocspStapling: domain.ocspStapling,
      httpsRedirect: domain.httpsRedirect,
      zoneName: zoneName(domain.id),
      settings: domain.settings,
      customConfig: domain.nginxCustomConfig,
    })),
  };
}

async function writeManifest(manifestPath: string, manifest: RuntimeManifest): Promise<void> {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  const temporary = `${manifestPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${stableJson(manifest as unknown as JsonObject)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, manifestPath);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const arguments_ = parseHookArguments(argv);
    requiredMode(arguments_);
    const database = requiredAbsolutePath(arguments_, 'db');
    const stageRoot = requiredAbsolutePath(arguments_, 'stage');
    const manifestPath = requiredAbsolutePath(arguments_, 'manifest');
    const stageMetadata = await fs.stat(stageRoot);
    if (!stageMetadata.isDirectory()) throw new Error('--stage must point to a directory');

    const releaseRoot = arguments_.values.has('release-root')
      ? requiredAbsolutePath(arguments_, 'release-root')
      : path.resolve(__dirname, '..', '..');
    const templates = loadAgentModule<AgentTemplates>(releaseRoot, 'nginx/templates.js');
    const stopped = loadAgentModule<AgentNginxManager>(releaseRoot, 'nginx/nginx.manager.js');
    const pools = loadAgentModule<AgentPoolTemplate>(releaseRoot, 'php/pool-template.js');
    const zones = loadAgentModule<AgentZonesTemplate>(releaseRoot, 'nginx/zones-template.js');
    const logrotate = loadAgentModule<AgentLogrotateTemplate>(releaseRoot, 'runtime/logrotate-template.js');
    if (typeof templates.renderNginxSite !== 'function'
      || typeof stopped.renderStoppedNginxSite !== 'function'
      || typeof pools.renderPhpFpmPool !== 'function'
      || typeof zones.renderNginxZones !== 'function'
      || typeof logrotate.renderNginxLogrotate !== 'function'
      || typeof logrotate.renderPhpLogrotate !== 'function') {
      throw new Error('candidate agent runtime render API is incomplete');
    }

    const sites = await loadSites(database);
    const artifacts: RuntimeArtifact[] = [];
    const desiredTargets = new Set<string>();
    const desiredPoolByDomain = new Map<string, string>();
    const phpServices = new Set<string>();
    const socketPaths = new Set<string>();
    const phpLogRuntimes: Array<{ runtimeKey: string; systemUser?: string | null }> = [];
    const probes: RuntimeHttpProbe[] = [];

    for (const site of sites) {
      const payload = runtimeSite(site);
      const rendered = templates.renderNginxSite(payload);
      const mainTarget = `/etc/nginx/sites-available/${site.name}.conf`;
      desiredTargets.add(mainTarget);
      await addDesiredArtifact(
        artifacts,
        stageRoot,
        mainTarget,
        site.status === 'STOPPED' ? stopped.renderStoppedNginxSite(payload) : rendered.mainConfig,
      );
      const enabledTarget = `/etc/nginx/sites-enabled/${site.name}.conf`;
      const linkTarget = await fs.readlink(enabledTarget).catch(() => null);
      if (linkTarget === null || path.resolve(path.dirname(enabledTarget), linkTarget) !== mainTarget) {
        throw new Error(`managed Nginx enabled link is missing or invalid for Site ${site.id}`);
      }

      for (const renderedDomain of rendered.domains) {
        for (const [filename, content] of Object.entries(renderedDomain.chunks)) {
          const target = `/etc/nginx/meowbox/${site.name}/${renderedDomain.domainId}/${filename}`;
          desiredTargets.add(target);
          await addDesiredArtifact(artifacts, stageRoot, target, content);
        }
        const sourceDomain = site.domains.find((domain) => domain.id === renderedDomain.domainId)!;
        const customTarget = `/etc/nginx/meowbox/${site.name}/${renderedDomain.domainId}/95-custom.conf`;
        if (renderedDomain.customChunk) {
          desiredTargets.add(customTarget);
          await addDesiredArtifact(artifacts, stageRoot, customTarget, renderedDomain.customChunk.content);
        } else if (await fileExists(customTarget)) {
          desiredTargets.add(customTarget);
        }

        if (sourceDomain.phpVersion) {
          const pool = pools.renderPhpFpmPool({
            siteName: site.name,
            domainId: sourceDomain.id,
            domain: sourceDomain.domain,
            phpVersion: sourceDomain.phpVersion,
            runtimeKey: sourceDomain.runtimeKey,
            isPrimary: sourceDomain.isPrimary,
            systemUser: site.systemUser ?? undefined,
            rootPath: site.rootPath,
            filesRelPath: sourceDomain.filesRelPath,
            sslEnabled: sourceDomain.sslEnabled,
            customConfig: sourceDomain.phpPoolCustom,
          });
          desiredTargets.add(pool.poolFile);
          desiredPoolByDomain.set(sourceDomain.id, pool.poolFile);
          await addDesiredArtifact(artifacts, stageRoot, pool.poolFile, pool.content);
          phpServices.add(`php${sourceDomain.phpVersion}-fpm`);
          if (!pool.runtime.socketPath) throw new Error(`PHP socket missing for SiteDomain ${sourceDomain.id}`);
          socketPaths.add(pool.runtime.socketPath);
          phpLogRuntimes.push({ runtimeKey: sourceDomain.runtimeKey, systemUser: site.systemUser });
        }

        probes.push({
          url: `${sourceDomain.sslEnabled ? 'https' : 'http'}://${sourceDomain.domain}/`,
          expectedStatus: site.status === 'STOPPED'
            ? [503]
            : [200, 204, 301, 302, 307, 308, 401, 403, 404],
        });
      }

      for (const existing of await collectFiles(`/etc/nginx/meowbox/${site.name}`)) {
        if (!desiredTargets.has(existing)) {
          artifacts.push({ action: 'delete', target: existing, postCommitOnly: true });
        }
      }
    }

    const zonesTarget = '/etc/nginx/conf.d/meowbox-zones.conf';
    desiredTargets.add(zonesTarget);
    await addDesiredArtifact(
      artifacts,
      stageRoot,
      zonesTarget,
      zones.renderNginxZones(sites.flatMap((site) => site.domains.map((domain) => ({
        zoneName: zoneName(domain.id),
        rps: typeof domain.settings.rateLimitRps === 'number' && domain.settings.rateLimitRps > 0
          ? domain.settings.rateLimitRps
          : 30,
        enabled: domain.settings.rateLimitEnabled !== false,
      })))),
    );
    await addDesiredArtifact(
      artifacts,
      stageRoot,
      '/etc/logrotate.d/meowbox',
      logrotate.renderNginxLogrotate(),
    );
    await addDesiredArtifact(
      artifacts,
      stageRoot,
      '/etc/logrotate.d/meowbox-php',
      logrotate.renderPhpLogrotate(phpLogRuntimes),
    );

    const finalDomainIds = new Set(sites.flatMap((site) => site.domains.map((domain) => domain.id)));
    for (const versionDirectory of await fs.readdir('/etc/php', { withFileTypes: true }).catch(() => [])) {
      if (!versionDirectory.isDirectory() || !PHP_VERSION_RE.test(versionDirectory.name)) continue;
      const poolDirectory = `/etc/php/${versionDirectory.name}/fpm/pool.d`;
      const files = await fs.readdir(poolDirectory, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.conf')) continue;
        const target = path.posix.join(poolDirectory, file.name);
        const content = await fs.readFile(target, 'utf8').catch(() => '');
        const domainId = content.match(/^;\s*meowbox-domain-id\s*=\s*(\S+)\s*$/m)?.[1];
        if (!domainId) continue;
        const desired = desiredPoolByDomain.get(domainId);
        if (!finalDomainIds.has(domainId) || (desired && desired !== target)) {
          artifacts.push({ action: 'delete', target, postCommitOnly: true });
        }
      }
    }

    artifacts.sort((left, right) => left.target.localeCompare(right.target));
    const seenTargets = new Set<string>();
    for (const artifact of artifacts) {
      if (seenTargets.has(artifact.target)) throw new Error(`duplicate rendered artifact: ${artifact.target}`);
      seenTargets.add(artifact.target);
    }
    const manifest: RuntimeManifest = {
      version: 1,
      requiresRuntimeCutover: artifacts.length > 0,
      artifacts,
      phpServices: [...phpServices].sort(),
      socketPaths: [...socketPaths].sort(),
      httpProbes: probes.sort((left, right) => left.url.localeCompare(right.url)),
      validations: [
        'all SiteDomain runtime identities are unique',
        'complete staged Nginx configuration validates',
        'complete staged PHP-FPM configurations validate',
        'legacy PHP worker ceiling is preserved by the migration map',
      ],
    };
    await writeManifest(manifestPath, manifest);
    process.stdout.write(`[runtime-renderer] ${sites.length} Site(s), ${artifacts.length} artifact change(s)\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`[runtime-renderer] ${safeErrorMessage(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
}
