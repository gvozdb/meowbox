#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import {
  parseHookArguments,
  requiredAbsolutePath,
  requiredMode,
} from './hooks/cli';
import { safeErrorMessage } from './release/redaction';
import {
  columnNumber,
  columnString,
  querySqliteJson,
} from './release/sqlite';
import type { JsonObject } from './release/types';
import {
  loadRuntimeManifest,
  type RuntimeArtifact,
  type ValidatedRuntimeManifest,
} from './runtime-manifest';

const execFileAsync = promisify(execFile);
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const PHP_VERSION_RE = /^\d+\.\d+$/;
const RUNTIME_KEY_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const MANAGED_NGINX_PREFIX = '/etc/nginx/';
const MANAGED_PHP_PREFIX = '/etc/php/';
const NGINX_STANDARD_PATHS = [
  '/usr/sbin/nginx',
  '/usr/local/sbin/nginx',
  '/sbin/nginx',
] as const;

interface DomainRuntimeRow {
  readonly domainId: string;
  readonly phpVersion: string | null;
  readonly runtimeKey: string;
  readonly expectedSocket: string | null;
  readonly applicationRoot: string;
  readonly certPath: string | null;
  readonly keyPath: string | null;
}

function requiredText(row: JsonObject, key: string): string {
  const value = columnString(row, key);
  if (!value) throw new Error(`runtime validation DB field ${key} is missing`);
  return value;
}

async function pathIsFile(file: string): Promise<boolean> {
  return fs.stat(file).then((metadata) => metadata.isFile()).catch(() => false);
}

async function pathIsDirectory(directory: string): Promise<boolean> {
  return fs.stat(directory).then((metadata) => metadata.isDirectory()).catch(() => false);
}

function containedPath(root: string, relative: string, label: string): string {
  if (relative.includes('\0') || path.isAbsolute(relative)) {
    throw new Error(`${label} is not a safe relative path`);
  }
  const normalizedRoot = path.resolve(root);
  const resolved = path.resolve(normalizedRoot, relative);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`${label} escapes its Site root`);
  }
  return resolved;
}

async function loadDomainRuntimeRows(database: string): Promise<DomainRuntimeRow[]> {
  const rows = await querySqliteJson(database, `
    SELECT
      d.id AS domain_id,
      d.php_version AS php_version,
      d.runtime_key AS runtime_key,
      d.files_rel_path AS files_rel_path,
      s.root_path AS root_path,
      c.status AS ssl_status,
      c.cert_path AS cert_path,
      c.key_path AS key_path
    FROM site_domains d
    INNER JOIN sites s ON s.id = d.site_id
    LEFT JOIN ssl_certificates c ON c.domain_id = d.id
    ORDER BY d.site_id, d.position, d.id;
  `);
  const result: DomainRuntimeRow[] = [];
  for (const row of rows) {
    const domainId = requiredText(row, 'domain_id');
    const runtimeKey = requiredText(row, 'runtime_key');
    const phpVersion = columnString(row, 'php_version');
    if (!RUNTIME_KEY_RE.test(runtimeKey)) {
      throw new Error(`SiteDomain ${domainId} has an unsafe runtimeKey`);
    }
    if (phpVersion !== null && !PHP_VERSION_RE.test(phpVersion)) {
      throw new Error(`SiteDomain ${domainId} has an invalid PHP version`);
    }
    const applicationRoot = containedPath(
      requiredText(row, 'root_path'),
      requiredText(row, 'files_rel_path'),
      `SiteDomain ${domainId} filesRelPath`,
    );
    if (!await pathIsDirectory(applicationRoot)) {
      throw new Error(`SiteDomain ${domainId} application root is missing`);
    }
    const sslStatus = columnString(row, 'ssl_status');
    const certPath = columnString(row, 'cert_path');
    const keyPath = columnString(row, 'key_path');
    if (sslStatus && ['ACTIVE', 'EXPIRING_SOON', 'EXPIRED'].includes(sslStatus)) {
      if (!certPath || !keyPath || !await pathIsFile(certPath) || !await pathIsFile(keyPath)) {
        throw new Error(`SiteDomain ${domainId} has incomplete SSL files`);
      }
    }
    result.push({
      domainId,
      phpVersion,
      runtimeKey,
      expectedSocket: phpVersion
        ? `/var/run/php/php${phpVersion}-fpm-${runtimeKey}.sock`
        : null,
      applicationRoot,
      certPath,
      keyPath,
    });
  }
  return result;
}

function shadowPath(shadowRoot: string, target: string, sourcePrefix: string): string {
  if (!target.startsWith(sourcePrefix)) throw new Error(`target is outside ${sourcePrefix}: ${target}`);
  return path.join(shadowRoot, target.slice(sourcePrefix.length));
}

async function copyConfigTree(source: string, destination: string): Promise<void> {
  const metadata = await fs.stat(source).catch(() => null);
  if (!metadata?.isDirectory()) throw new Error(`required runtime config tree is missing: ${source}`);
  await fs.cp(source, destination, {
    recursive: true,
    dereference: true,
    force: true,
    preserveTimestamps: true,
  });
}

async function applyArtifactsToShadow(
  runtime: ValidatedRuntimeManifest,
  shadowRoot: string,
  sourcePrefix: string,
  includeDeletes: boolean,
): Promise<void> {
  for (const artifact of runtime.manifest.artifacts) {
    if (!artifact.target.startsWith(sourcePrefix)) continue;
    const target = shadowPath(shadowRoot, artifact.target, sourcePrefix);
    if (artifact.action === 'delete') {
      if (includeDeletes) await fs.unlink(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      continue;
    }
    const content = await fs.readFile(artifact.stagedPath!);
    if (content.byteLength > MAX_CONFIG_BYTES) throw new Error(`runtime config is too large: ${artifact.target}`);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, content, { mode: 0o600 });
  }
}

async function collectRegularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(absolute);
      else throw new Error(`shadow config contains an unsupported entry: ${absolute}`);
    }
  };
  await walk(root);
  return files.sort();
}

async function nginxBinary(): Promise<string> {
  const pathCandidates = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, 'nginx'));
  for (const candidate of new Set([...pathCandidates, ...NGINX_STANDARD_PATHS])) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next explicit candidate.
    }
  }
  throw new Error('Nginx binary is missing');
}

function nginxTextFile(file: string): boolean {
  return path.basename(file) === 'nginx.conf'
    || file.endsWith('.conf')
    || file.includes(`${path.sep}sites-available${path.sep}`)
    || file.includes(`${path.sep}sites-enabled${path.sep}`);
}

async function rewriteNginxShadow(shadowRoot: string): Promise<void> {
  const absolutePrefix = `${shadowRoot}${path.sep}`;
  for (const file of await collectRegularFiles(shadowRoot)) {
    if (!nginxTextFile(file)) continue;
    const encoded = await fs.readFile(file);
    if (encoded.byteLength > MAX_CONFIG_BYTES) throw new Error(`Nginx config is too large: ${file}`);
    const original = encoded.toString('utf8');
    if (!Buffer.from(original, 'utf8').equals(encoded)) throw new Error(`Nginx config is not UTF-8: ${file}`);
    const rewritten = original
      .replaceAll('/etc/nginx/', absolutePrefix)
      .replace(/^\s*pid\s+[^;]+;/gm, `pid ${path.join(shadowRoot, 'nginx.pid')};`)
      .replace(/^\s*access_log\s+[^;]+;/gm, 'access_log off;')
      .replace(/^\s*error_log\s+[^;]+;/gm, 'error_log stderr notice;');
    if (rewritten !== original) await fs.writeFile(file, rewritten, { mode: 0o600 });
  }
}

async function syncEnabledSites(shadowRoot: string): Promise<void> {
  const available = path.join(shadowRoot, 'sites-available');
  const enabled = path.join(shadowRoot, 'sites-enabled');
  const entries = await fs.readdir(enabled, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const source = path.join(available, entry.name);
    if (await pathIsFile(source)) {
      await fs.copyFile(source, path.join(enabled, entry.name), constants.COPYFILE_FICLONE);
    }
  }
}

async function runNginxValidation(
  runtime: ValidatedRuntimeManifest,
  validationRoot: string,
  label: string,
  includeDeletes: boolean,
): Promise<void> {
  const shadowRoot = path.join(validationRoot, `nginx-${label}`);
  await copyConfigTree('/etc/nginx', shadowRoot);
  await applyArtifactsToShadow(runtime, shadowRoot, MANAGED_NGINX_PREFIX, includeDeletes);
  await syncEnabledSites(shadowRoot);
  await rewriteNginxShadow(shadowRoot);
  await execFileAsync(await nginxBinary(), ['-t', '-p', `${shadowRoot}${path.sep}`, '-c', path.join(shadowRoot, 'nginx.conf')], {
    timeout: 30_000,
    maxBuffer: 512 * 1024,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });
}

interface ParsedPool {
  readonly file: string;
  readonly name: string;
  readonly listen: string;
  readonly domainId: string | null;
  readonly maxChildren: number | null;
}

function activeDirective(content: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(`^\\s*${escaped}\\s*=\\s*(.*?)\\s*$`, 'gm');
  return [...content.matchAll(expression)].map((match) => match[1] ?? '');
}

async function parsePoolFiles(poolDirectory: string): Promise<ParsedPool[]> {
  const entries = await fs.readdir(poolDirectory, { withFileTypes: true });
  const pools: ParsedPool[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.conf')) continue;
    const file = path.join(poolDirectory, entry.name);
    const encoded = await fs.readFile(file);
    if (encoded.byteLength > MAX_CONFIG_BYTES) throw new Error(`PHP-FPM pool config is too large: ${file}`);
    const content = encoded.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(encoded)) throw new Error(`PHP-FPM pool config is not UTF-8: ${file}`);
    const sections = [...content.matchAll(/^\s*\[([^\]\r\n]+)\]\s*$/gm)].map((match) => match[1]!.trim());
    const listens = activeDirective(content, 'listen');
    if (sections.length !== 1 || listens.length !== 1 || !sections[0] || !listens[0]) {
      throw new Error(`PHP-FPM pool must define exactly one section and listen directive: ${file}`);
    }
    const domainId = content.match(/^;\s*meowbox-domain-id\s*=\s*(\S+)\s*$/m)?.[1] ?? null;
    const maxChildrenValues = activeDirective(content, 'pm.max_children');
    let maxChildren: number | null = null;
    if (domainId) {
      if (maxChildrenValues.length !== 1 || !/^\d+$/.test(maxChildrenValues[0]!)) {
        throw new Error(`managed PHP-FPM pool has no exact pm.max_children: ${file}`);
      }
      maxChildren = Number(maxChildrenValues[0]);
      if (!Number.isInteger(maxChildren) || maxChildren < 1 || maxChildren > 1024) {
        throw new Error(`managed PHP-FPM pool has invalid pm.max_children: ${file}`);
      }
    }
    pools.push({ file, name: sections[0], listen: listens[0], domainId, maxChildren });
  }
  return pools;
}

function phpFpmBinary(version: string): string {
  return `/usr/sbin/php-fpm${version}`;
}

async function validatePoolIdentity(
  pools: readonly ParsedPool[],
  domains: readonly DomainRuntimeRow[],
  version: string,
  declaredSockets: ReadonlySet<string>,
): Promise<void> {
  const names = new Set<string>();
  const listens = new Set<string>();
  const managedDomains = new Set<string>();
  for (const pool of pools) {
    if (names.has(pool.name)) throw new Error(`duplicate PHP-FPM pool name for PHP ${version}`);
    if (listens.has(pool.listen)) throw new Error(`duplicate PHP-FPM listen socket for PHP ${version}`);
    names.add(pool.name);
    listens.add(pool.listen);
    if (pool.domainId) {
      if (managedDomains.has(pool.domainId)) throw new Error(`duplicate PHP-FPM pool for SiteDomain ${pool.domainId}`);
      managedDomains.add(pool.domainId);
    }
  }
  for (const domain of domains.filter((item) => item.phpVersion === version)) {
    if (!domain.expectedSocket || !listens.has(domain.expectedSocket) || !managedDomains.has(domain.domainId)) {
      throw new Error(`SiteDomain ${domain.domainId} has no matching PHP-FPM pool`);
    }
    if (!declaredSockets.has(domain.expectedSocket)) {
      throw new Error(`SiteDomain ${domain.domainId} socket is absent from runtime manifest`);
    }
  }
}

async function runPhpValidation(
  runtime: ValidatedRuntimeManifest,
  domains: readonly DomainRuntimeRow[],
  validationRoot: string,
  label: string,
  includeDeletes: boolean,
): Promise<void> {
  const declaredSockets = new Set(runtime.manifest.socketPaths ?? []);
  const versions = [...new Set(domains.flatMap((domain) => domain.phpVersion ? [domain.phpVersion] : []))].sort();
  for (const version of versions) {
    const sourceRoot = `/etc/php/${version}/fpm`;
    const shadowRoot = path.join(validationRoot, `php-${version}-${label}`);
    await copyConfigTree(sourceRoot, shadowRoot);
    await applyArtifactsToShadow(runtime, shadowRoot, `${sourceRoot}/`, includeDeletes);
    const poolDirectory = path.join(shadowRoot, 'pool.d');
    const pools = await parsePoolFiles(poolDirectory);
    await validatePoolIdentity(pools, domains, version, declaredSockets);

    const masterConfig = path.join(shadowRoot, 'php-fpm.conf');
    const validationErrorLog = path.join(shadowRoot, 'php-fpm-error.log');
    await fs.writeFile(validationErrorLog, '', { mode: 0o600 });
    const master = await fs.readFile(masterConfig, 'utf8');
    const rewritten = master
      .replaceAll(`${sourceRoot}/`, `${shadowRoot}${path.sep}`)
      .replace(/^\s*pid\s*=\s*.*$/gm, `pid = ${path.join(shadowRoot, 'php-fpm.pid')}`)
      .replace(/^\s*error_log\s*=\s*.*$/gm, `error_log = ${validationErrorLog}`);
    await fs.writeFile(masterConfig, rewritten, { mode: 0o600 });
    const binary = phpFpmBinary(version);
    if (!await pathIsFile(binary)) throw new Error(`PHP-FPM binary is missing for PHP ${version}`);
    await execFileAsync(binary, ['-tt', '-y', masterConfig], {
      timeout: 30_000,
      maxBuffer: 512 * 1024,
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    });
  }
}

function hasPostCommitDeletes(artifacts: readonly RuntimeArtifact[]): boolean {
  return artifacts.some((artifact) => artifact.action === 'delete' && artifact.postCommitOnly === true);
}

async function validateRuntime(
  runtime: ValidatedRuntimeManifest,
  domains: readonly DomainRuntimeRow[],
): Promise<void> {
  const expectedSockets = domains.flatMap((domain) => domain.expectedSocket ? [domain.expectedSocket] : []).sort();
  const declaredSockets = [...(runtime.manifest.socketPaths ?? [])].sort();
  if (JSON.stringify(expectedSockets) !== JSON.stringify(declaredSockets)) {
    throw new Error('runtime manifest PHP socket set does not match migrated SiteDomain rows');
  }

  const validationRoot = path.join(runtime.stageRoot, 'validation');
  if (path.dirname(validationRoot) !== runtime.stageRoot) throw new Error('invalid runtime validation directory');
  await fs.rm(validationRoot, { recursive: true, force: true });
  await fs.mkdir(validationRoot, { recursive: true, mode: 0o700 });

  await runNginxValidation(runtime, validationRoot, 'precommit', false);
  await runPhpValidation(runtime, domains, validationRoot, 'precommit', false);
  if (hasPostCommitDeletes(runtime.manifest.artifacts)) {
    await runNginxValidation(runtime, validationRoot, 'final', true);
    await runPhpValidation(runtime, domains, validationRoot, 'final', true);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const arguments_ = parseHookArguments(argv);
    requiredMode(arguments_);
    const database = requiredAbsolutePath(arguments_, 'db');
    const stageRoot = requiredAbsolutePath(arguments_, 'stage');
    const manifestPath = requiredAbsolutePath(arguments_, 'manifest');
    const runtime = await loadRuntimeManifest(manifestPath, stageRoot);
    const domains = await loadDomainRuntimeRows(database);
    await validateRuntime(runtime, domains);
    process.stdout.write(`[runtime-validator] ${domains.length} SiteDomain runtime row(s) validated\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`[runtime-validator] ${safeErrorMessage(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
