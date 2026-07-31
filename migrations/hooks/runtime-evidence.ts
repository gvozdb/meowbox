#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  columnNumber,
  columnString,
  querySqliteJson,
} from '../release/sqlite';
import { safeErrorMessage } from '../release/redaction';
import { stableJson } from '../release/stable';
import type { JsonObject } from '../release/types';
import {
  parseHookArguments,
  requiredAbsolutePath,
  requiredMode,
} from './cli';

const SITE_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const DOMAIN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PHP_VERSION_RE = /^\d+\.\d+$/;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_POOL_BYTES = 256 * 1024;

interface LegacyRuntimeRow {
  readonly siteId: string;
  readonly siteName: string;
  readonly preset: string;
  readonly siteRoot: string;
  readonly siteFilesRelPath: string | null;
  readonly phpVersion: string | null;
  readonly domainId: string;
  readonly domainFilesRelPath: string | null;
  readonly isPrimary: boolean;
}

async function boundedRead(file: string, maxBytes: number): Promise<string | null> {
  try {
    const metadata = await fs.stat(file);
    if (!metadata.isFile() || metadata.size > maxBytes) return null;
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function activeDirective(content: string, name: string): string[] {
  const values: string[] = [];
  const expression = new RegExp(`^\\s*${name.replaceAll('.', '\\.')}\\s*=\\s*([^;#\\s]+)\\s*$`, 'i');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const match = expression.exec(line);
    if (match?.[1]) values.push(match[1]);
  }
  return values;
}

async function observedPoolMaxChildren(row: LegacyRuntimeRow): Promise<number | undefined> {
  if (!row.phpVersion || !PHP_VERSION_RE.test(row.phpVersion) || !SITE_NAME_RE.test(row.siteName)) return undefined;
  const pool = path.posix.join(
    '/etc/php',
    row.phpVersion,
    'fpm',
    'pool.d',
    `${row.siteName.replace(/\./g, '_')}.conf`,
  );
  const content = await boundedRead(pool, MAX_POOL_BYTES);
  if (content === null) return undefined;
  const values = activeDirective(content, 'pm.max_children');
  if (values.length !== 1 || !/^\d+$/.test(values[0])) {
    throw new Error(`effective pm.max_children is missing or ambiguous for Site ${row.siteId}`);
  }
  const value = Number(values[0]);
  if (!Number.isInteger(value) || value < 1 || value > 1024) {
    throw new Error(`effective pm.max_children is invalid for Site ${row.siteId}`);
  }
  return value;
}

async function observedPhpEnabled(row: LegacyRuntimeRow): Promise<boolean> {
  if (row.isPrimary) return row.phpVersion !== null;
  if (!SITE_NAME_RE.test(row.siteName) || !DOMAIN_ID_RE.test(row.domainId)) {
    throw new Error(`unsafe legacy runtime identity for SiteDomain ${row.domainId}`);
  }
  const chunk = path.posix.join(
    '/etc/nginx/meowbox',
    row.siteName,
    row.domainId,
    '20-php.conf',
  );
  const content = await boundedRead(chunk, MAX_POOL_BYTES);
  return content !== null && /^\s*fastcgi_pass\s+unix:[^;]+;\s*$/m.test(content);
}

function safeWebRoot(row: LegacyRuntimeRow): string | null {
  const relative = (row.domainFilesRelPath || row.siteFilesRelPath || '').trim();
  if (!path.posix.isAbsolute(row.siteRoot) || !relative || path.posix.isAbsolute(relative)) return null;
  const root = path.resolve(row.siteRoot);
  const candidate = path.resolve(root, relative);
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) return null;
  return candidate;
}

function parsedModxDatabase(content: string): string | null {
  const patterns = [
    /\$dbase\s*=\s*(['"])([^'"\\]*(?:\\.[^'"\\]*)*)\1\s*;/,
    /\$modx_dbase\s*=\s*(['"])([^'"\\]*(?:\\.[^'"\\]*)*)\1\s*;/,
    /define\(\s*(['"])dbase\1\s*,\s*(['"])([^'"\\]*(?:\\.[^'"\\]*)*)\2\s*\)\s*;/,
  ];
  for (const expression of patterns) {
    const match = expression.exec(content);
    const value = match?.[3] ?? match?.[2];
    if (value && !value.includes('\\') && value.length <= 128) return value;
  }
  return null;
}

async function observedModxDatabase(
  row: LegacyRuntimeRow,
  databaseNames: ReadonlySet<string>,
): Promise<string | undefined> {
  if (row.preset !== 'MODX_REVO' && row.preset !== 'MODX_3') return undefined;
  const webRoot = safeWebRoot(row);
  if (!webRoot) return undefined;
  const siteRoot = await fs.realpath(row.siteRoot).catch(() => null);
  if (!siteRoot) return undefined;
  for (const candidate of [
    path.join(webRoot, 'core', 'config', 'config.inc.php'),
    path.join(row.siteRoot, 'core', 'config', 'config.inc.php'),
  ]) {
    const resolved = await fs.realpath(candidate).catch(() => null);
    if (!resolved || (resolved !== siteRoot && !resolved.startsWith(`${siteRoot}${path.sep}`))) continue;
    const content = await boundedRead(resolved, MAX_CONFIG_BYTES);
    if (content === null) continue;
    const database = parsedModxDatabase(content);
    if (database && databaseNames.has(database)) return database;
  }
  return undefined;
}

async function loadLegacyRows(database: string): Promise<LegacyRuntimeRow[]> {
  const rows = await querySqliteJson(database, `
    SELECT
      s.id AS site_id,
      s.name AS site_name,
      s.type AS preset,
      s.root_path AS site_root,
      s.files_rel_path AS site_files_rel_path,
      s.php_version AS php_version,
      d.id AS domain_id,
      d.files_rel_path AS domain_files_rel_path,
      d.is_primary AS is_primary
    FROM sites s
    INNER JOIN site_domains d ON d.site_id = s.id
    ORDER BY s.id, d.position, d.id;
  `);
  return rows.map((row): LegacyRuntimeRow => {
    const siteId = columnString(row, 'site_id');
    const siteName = columnString(row, 'site_name');
    const preset = columnString(row, 'preset');
    const siteRoot = columnString(row, 'site_root');
    const domainId = columnString(row, 'domain_id');
    const isPrimary = columnNumber(row, 'is_primary');
    if (!siteId || !siteName || !preset || !siteRoot || !domainId || (isPrimary !== 0 && isPrimary !== 1)) {
      throw new Error('legacy runtime evidence query returned an invalid row');
    }
    return {
      siteId,
      siteName,
      preset,
      siteRoot,
      siteFilesRelPath: columnString(row, 'site_files_rel_path'),
      phpVersion: columnString(row, 'php_version'),
      domainId,
      domainFilesRelPath: columnString(row, 'domain_files_rel_path'),
      isPrimary: isPrimary === 1,
    };
  });
}

async function databaseNamesBySite(database: string): Promise<Map<string, Set<string>>> {
  const rows = await querySqliteJson(database, 'SELECT site_id, name FROM databases WHERE site_id IS NOT NULL ORDER BY site_id, id;');
  const result = new Map<string, Set<string>>();
  for (const row of rows) {
    const siteId = columnString(row, 'site_id');
    const name = columnString(row, 'name');
    if (!siteId || !name) continue;
    const names = result.get(siteId) ?? new Set<string>();
    names.add(name);
    result.set(siteId, names);
  }
  return result;
}

async function writeEvidence(output: string, payload: JsonObject): Promise<void> {
  await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${stableJson(payload)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, output);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const arguments_ = parseHookArguments(argv, true);
    if (arguments_.command !== 'scan') throw new Error('runtime-evidence supports only scan');
    requiredMode(arguments_);
    const database = requiredAbsolutePath(arguments_, 'db');
    const output = requiredAbsolutePath(arguments_, 'output');
    const rows = await loadLegacyRows(database);
    const namesBySite = await databaseNamesBySite(database);
    const domains: Record<string, JsonObject> = {};
    const primaryBySite = new Map(rows.filter((row) => row.isPrimary).map((row) => [row.siteId, row]));
    const budgetBySite = new Map<string, number | undefined>();
    for (const [siteId, primary] of primaryBySite) {
      budgetBySite.set(siteId, await observedPoolMaxChildren(primary));
    }
    for (const row of rows) {
      const phpEnabled = await observedPhpEnabled(row);
      const modxDatabaseName = row.isPrimary
        ? await observedModxDatabase(row, namesBySite.get(row.siteId) ?? new Set())
        : undefined;
      const poolMaxChildren = row.isPrimary ? budgetBySite.get(row.siteId) : undefined;
      domains[row.domainId] = {
        phpEnabled,
        ...(modxDatabaseName === undefined ? {} : { modxDatabaseName }),
        ...(poolMaxChildren === undefined ? {} : { poolMaxChildren }),
      };
    }
    await writeEvidence(output, { version: 1, domains });
    process.stdout.write(`[runtime-evidence] ${rows.length} SiteDomain record(s) observed\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`[runtime-evidence] ${safeErrorMessage(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
}
