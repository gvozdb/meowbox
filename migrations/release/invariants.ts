import { fingerprintDatabaseFiles } from './stable';
import { columnNumber, columnString, querySqliteJson, quoteIdentifier, quoteLiteral } from './sqlite';
import { redactDiagnostics } from './redaction';
import { blocker, reportOk, type Diagnostic, type JsonObject } from './types';
import {
  isModxPreset,
  isRelativePathContained,
  isSafeRuntimeKey,
  KNOWN_PRESETS,
  normalizeHostname,
  normalizeRelativePath,
  parseAliases,
  socketPathWithinLimit,
} from './validation';

export type InvariantPhase = 'legacy' | 'final';

export interface BaselineCounts {
  readonly sites: number;
  readonly siteDomains: number;
  readonly databases: number;
}

export interface InvariantOptions {
  readonly dbPath: string;
  readonly phase: InvariantPhase;
  readonly baselineCounts: BaselineCounts;
  readonly socketDirectory?: string;
  readonly socketMaxBytes?: number;
}

export interface InvariantReport {
  readonly ok: boolean;
  readonly phase: InvariantPhase;
  readonly databaseFileSha256: string;
  readonly counts: BaselineCounts;
  readonly blockers: readonly Diagnostic[];
  readonly warnings: readonly Diagnostic[];
}

interface Columns {
  readonly exists: boolean;
  readonly names: ReadonlySet<string>;
}

const FINAL_DOMAIN_COLUMNS = [
  'id', 'site_id', 'domain', 'is_primary', 'position', 'aliases',
  'preset', 'app_status', 'files_rel_path', 'runtime_key', 'php_version',
] as const;
const FINAL_DATABASE_COLUMNS = ['id', 'site_id', 'site_domain_id', 'purpose', 'type'] as const;

async function tableColumns(dbPath: string, table: string): Promise<Columns> {
  const exists = await querySqliteJson(
    dbPath,
    `SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ${quoteLiteral(table)} LIMIT 1;`,
  );
  if (exists.length === 0) return { exists: false, names: new Set() };
  const rows = await querySqliteJson(dbPath, `PRAGMA table_xinfo(${quoteIdentifier(table)});`);
  return { exists: true, names: new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === 'string')) };
}

function ensureColumns(table: string, columns: Columns, required: readonly string[], blockers: Diagnostic[]): boolean {
  if (!columns.exists) {
    blockers.push(blocker('INVARIANT_TABLE_MISSING', 'Required table is missing', { table }));
    return false;
  }
  const missing = required.filter((column) => !columns.names.has(column));
  if (missing.length > 0) {
    blockers.push(blocker('INVARIANT_COLUMN_MISSING', 'Required invariant column is missing', { table, missingColumns: [...missing] }));
    return false;
  }
  return true;
}

async function tableCount(dbPath: string, table: string): Promise<number> {
  const rows = await querySqliteJson(dbPath, `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)};`);
  const count = rows[0] === undefined ? null : columnNumber(rows[0], 'count');
  if (count === null || !Number.isInteger(count) || count < 0) throw new Error(`Could not count ${table}`);
  return count;
}

async function scalarViolationCount(dbPath: string, sql: string): Promise<number> {
  const rows = await querySqliteJson(dbPath, sql);
  const count = rows[0] === undefined ? null : columnNumber(rows[0], 'count');
  if (count === null || !Number.isInteger(count) || count < 0) throw new Error('Invariant count query returned an invalid result');
  return count;
}

function addCountMismatch(blockers: Diagnostic[], entity: keyof BaselineCounts, expected: number, actual: number): void {
  if (expected !== actual) {
    blockers.push(blocker('ROW_COUNT_CHANGED', 'Migration changed a protected row count', { entity, expected, actual }));
  }
}

async function checkIntegrity(dbPath: string, blockers: Diagnostic[]): Promise<void> {
  const integrity = await querySqliteJson(dbPath, 'PRAGMA integrity_check;');
  const messages = integrity.map((row) => Object.values(row).filter((value): value is string => typeof value === 'string')).flat();
  if (messages.length !== 1 || messages[0] !== 'ok') {
    blockers.push(blocker('SQLITE_INTEGRITY_CHECK_FAILED', 'PRAGMA integrity_check did not return ok', { resultCount: messages.length }));
  }
  const foreignKeys = await querySqliteJson(dbPath, 'PRAGMA foreign_key_check;');
  if (foreignKeys.length > 0) {
    blockers.push(blocker('SQLITE_FOREIGN_KEY_CHECK_FAILED', 'PRAGMA foreign_key_check returned violations', { violationCount: foreignKeys.length }));
  }
}

async function checkDomainPositions(dbPath: string, blockers: Diagnostic[]): Promise<void> {
  const sitesWithoutDomains = await scalarViolationCount(
    dbPath,
    `SELECT COUNT(*) AS count
       FROM sites AS s
      WHERE NOT EXISTS (SELECT 1 FROM site_domains AS d WHERE d.site_id = s.id);`,
  );
  if (sitesWithoutDomains > 0) {
    blockers.push(blocker('SITE_WITHOUT_DOMAIN', 'Every Site must own at least one SiteDomain', { siteCount: sitesWithoutDomains }));
  }
  const invalid = await scalarViolationCount(
    dbPath,
    `SELECT COUNT(*) AS count FROM (
      SELECT site_id
      FROM site_domains
      GROUP BY site_id
      HAVING SUM(CASE WHEN is_primary THEN 1 ELSE 0 END) != 1
        OR MIN(position) != 0
        OR MAX(position) != COUNT(*) - 1
        OR COUNT(DISTINCT position) != COUNT(*)
    );`,
  );
  if (invalid > 0) {
    blockers.push(blocker('DOMAIN_PRIMARY_OR_POSITION_INVALID', 'Every Site must have exactly one primary domain at contiguous position zero', { siteCount: invalid }));
  }
}

async function checkHostnameRegistry(dbPath: string, blockers: Diagnostic[]): Promise<void> {
  const rows = await querySqliteJson(dbPath, 'SELECT id, domain, aliases FROM site_domains ORDER BY id;');
  const claims = new Map<string, string>();
  for (const row of rows) {
    const id = columnString(row, 'id');
    const domain = columnString(row, 'domain');
    const aliases = columnString(row, 'aliases');
    if (id === null || domain === null || aliases === null) {
      blockers.push(blocker('DOMAIN_HOSTNAME_ROW_INVALID', 'SiteDomain hostname data is missing', {}));
      continue;
    }
    const canonical = normalizeHostname(domain);
    if (typeof canonical !== 'string') {
      blockers.push(blocker(`DOMAIN_${canonical.code}`, canonical.message, { domainId: id }));
      continue;
    }
    const parsedAliases = parseAliases(aliases);
    if (!parsedAliases.ok) {
      blockers.push(blocker(`ALIASES_${parsedAliases.failure.code}`, parsedAliases.failure.message, { domainId: id }));
      continue;
    }
    for (const hostname of [canonical, ...parsedAliases.hostnames]) {
      const owner = claims.get(hostname);
      if (owner !== undefined && owner !== id) blockers.push(blocker('HOSTNAME_CONFLICT', 'Canonical hostname or alias belongs to another SiteDomain', { hostname, domainId: id, conflictingDomainId: owner }));
      else claims.set(hostname, id);
    }
  }
}

async function checkLegacyInvariants(dbPath: string, blockers: Diagnostic[]): Promise<void> {
  await checkDomainPositions(dbPath, blockers);
  await checkHostnameRegistry(dbPath, blockers);
}

async function checkFinalInvariants(
  dbPath: string,
  blockers: Diagnostic[],
  socketDirectory: string,
  socketMaxBytes: number,
): Promise<void> {
  await checkDomainPositions(dbPath, blockers);
  await checkHostnameRegistry(dbPath, blockers);

  const domains = await querySqliteJson(
    dbPath,
    'SELECT d.id, d.site_id, d.preset, d.app_status, d.files_rel_path, d.runtime_key, d.php_version, d.app_port, s.root_path FROM site_domains d INNER JOIN sites s ON s.id = d.site_id ORDER BY d.id;',
  );
  const runtimeKeys = new Map<string, string>();
  for (const domain of domains) {
    const id = columnString(domain, 'id');
    const preset = columnString(domain, 'preset');
    const appStatus = columnString(domain, 'app_status');
    const filesRelPath = columnString(domain, 'files_rel_path');
    const runtimeKey = columnString(domain, 'runtime_key');
    const phpVersion = columnString(domain, 'php_version');
    const rootPath = columnString(domain, 'root_path');
    const appPort = columnNumber(domain, 'app_port');
    if (id === null || preset === null || appStatus === null || filesRelPath === null || runtimeKey === null || rootPath === null) {
      blockers.push(blocker('FINAL_DOMAIN_REQUIRED_FIELD_MISSING', 'Final SiteDomain has a null required application field'));
      continue;
    }
    if (!KNOWN_PRESETS.has(preset)) blockers.push(blocker('FINAL_DOMAIN_PRESET_INVALID', 'Final SiteDomain preset is unsupported', { domainId: id }));
    if (!['PROVISIONING', 'RUNNING', 'DEPLOYING', 'UPDATING', 'ERROR'].includes(appStatus)) {
      blockers.push(blocker('FINAL_DOMAIN_STATUS_INVALID', 'Final SiteDomain appStatus is unsupported', { domainId: id }));
    }
    const normalized = normalizeRelativePath(filesRelPath);
    if (typeof normalized !== 'string' || normalized !== filesRelPath || !isRelativePathContained(rootPath, filesRelPath)) {
      blockers.push(blocker('FINAL_DOMAIN_PATH_INVALID', 'Final SiteDomain filesRelPath is not a normalized contained relative path', { domainId: id }));
    }
    if (!isSafeRuntimeKey(runtimeKey)
      || (phpVersion !== null && !socketPathWithinLimit(runtimeKey, socketDirectory, socketMaxBytes, phpVersion))) {
      blockers.push(blocker('FINAL_RUNTIME_KEY_INVALID', 'Final SiteDomain runtimeKey is unsafe or exceeds the socket limit', { domainId: id }));
    }
    if (appPort !== null && (!Number.isInteger(appPort) || appPort < 1 || appPort > 65_535)) {
      blockers.push(blocker('FINAL_DOMAIN_APP_PORT_INVALID', 'Final SiteDomain appPort is outside the valid TCP port range', { domainId: id }));
    }
    const previous = runtimeKeys.get(runtimeKey);
    if (previous !== undefined && previous !== id) blockers.push(blocker('FINAL_RUNTIME_KEY_DUPLICATE', 'Final SiteDomain runtimeKey is not globally unique', { domainId: id, conflictingDomainId: previous }));
    else runtimeKeys.set(runtimeKey, id);
  }

  const ownershipViolations = await scalarViolationCount(
    dbPath,
    `SELECT COUNT(*) AS count FROM databases d
      LEFT JOIN site_domains sd ON sd.id = d.site_domain_id
      WHERE d.site_domain_id IS NULL OR sd.id IS NULL OR d.site_id IS NULL OR d.site_id != sd.site_id;`,
  );
  if (ownershipViolations > 0) {
    blockers.push(blocker('DATABASE_DOMAIN_OWNERSHIP_INVALID', 'Every Database must belong to a SiteDomain in the same Site', { databaseCount: ownershipViolations }));
  }
  const multiplePrimary = await scalarViolationCount(
    dbPath,
    `SELECT COUNT(*) AS count FROM (
      SELECT site_domain_id FROM databases WHERE purpose = 'APP_PRIMARY' GROUP BY site_domain_id HAVING COUNT(*) > 1
    );`,
  );
  if (multiplePrimary > 0) {
    blockers.push(blocker('DATABASE_PRIMARY_DUPLICATE', 'A SiteDomain has more than one APP_PRIMARY database', { domainCount: multiplePrimary }));
  }
  const invalidPurpose = await scalarViolationCount(
    dbPath,
    `SELECT COUNT(*) AS count FROM databases
      WHERE purpose IS NULL OR purpose NOT IN ('APP_PRIMARY', 'AUXILIARY');`,
  );
  if (invalidPurpose > 0) {
    blockers.push(blocker('DATABASE_PURPOSE_INVALID', 'Every Database purpose must be APP_PRIMARY or AUXILIARY', { databaseCount: invalidPurpose }));
  }
  const modxViolations = await scalarViolationCount(
    dbPath,
    `SELECT COUNT(*) AS count FROM site_domains sd
      WHERE sd.preset IN ('MODX_REVO', 'MODX_3')
        AND (sd.php_version IS NULL OR TRIM(sd.php_version) = '' OR (
          SELECT COUNT(*) FROM databases d
          WHERE d.site_domain_id = sd.id AND d.purpose = 'APP_PRIMARY' AND d.type IN ('MARIADB', 'MYSQL')
        ) != 1);`,
  );
  if (modxViolations > 0) {
    blockers.push(blocker('MODX_DATABASE_OR_PHP_INVALID', 'Each MODX SiteDomain needs PHP and exactly one MariaDB-compatible APP_PRIMARY database', { domainCount: modxViolations }));
  }
}

/** Run all SQL/data invariants in read-only SQLite mode. */
export async function checkMigrationInvariants(options: InvariantOptions): Promise<InvariantReport> {
  const blockers: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const databaseFile = await fingerprintDatabaseFiles(options.dbPath);
  const [sitesColumns, domainsColumns, databasesColumns] = await Promise.all([
    tableColumns(options.dbPath, 'sites'),
    tableColumns(options.dbPath, 'site_domains'),
    tableColumns(options.dbPath, 'databases'),
  ]);
  const sitesReady = ensureColumns('sites', sitesColumns, ['id', 'root_path'], blockers);
  const domainsReady = ensureColumns(
    'site_domains',
    domainsColumns,
    options.phase === 'final' ? FINAL_DOMAIN_COLUMNS : ['id', 'site_id', 'domain', 'is_primary', 'position', 'aliases'],
    blockers,
  );
  const databasesReady = ensureColumns('databases', databasesColumns, options.phase === 'final' ? FINAL_DATABASE_COLUMNS : ['id', 'site_id'], blockers);

  let counts: BaselineCounts = { sites: 0, siteDomains: 0, databases: 0 };
  if (sitesReady && domainsReady && databasesReady) {
    const [sites, siteDomains, databases] = await Promise.all([
      tableCount(options.dbPath, 'sites'),
      tableCount(options.dbPath, 'site_domains'),
      tableCount(options.dbPath, 'databases'),
    ]);
    counts = { sites, siteDomains, databases };
    addCountMismatch(blockers, 'sites', options.baselineCounts.sites, sites);
    addCountMismatch(blockers, 'siteDomains', options.baselineCounts.siteDomains, siteDomains);
    addCountMismatch(blockers, 'databases', options.baselineCounts.databases, databases);
    await checkIntegrity(options.dbPath, blockers);
    if (options.phase === 'legacy') await checkLegacyInvariants(options.dbPath, blockers);
    else await checkFinalInvariants(options.dbPath, blockers, options.socketDirectory ?? '/run/php', options.socketMaxBytes ?? 107);
  }
  return {
    ok: reportOk(blockers),
    phase: options.phase,
    databaseFileSha256: databaseFile.combined,
    counts,
    blockers: redactDiagnostics(blockers),
    warnings: redactDiagnostics(warnings),
  };
}

export function invariantReportJson(report: InvariantReport): JsonObject {
  return {
    ok: report.ok,
    phase: report.phase,
    databaseFileSha256: report.databaseFileSha256,
    counts: {
      sites: report.counts.sites,
      siteDomains: report.counts.siteDomains,
      databases: report.counts.databases,
    },
    blockers: report.blockers.map(diagnosticJson),
    warnings: report.warnings.map(diagnosticJson),
  };
}

function diagnosticJson(value: Diagnostic): JsonObject {
  return value.details === undefined
    ? { code: value.code, severity: value.severity, message: value.message }
    : { code: value.code, severity: value.severity, message: value.message, details: value.details };
}

/** Parse the CLI/file baseline count contract, accepting snake_case aliases. */
export function parseBaselineCounts(value: unknown): BaselineCounts {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('baseline counts must be a JSON object');
  const input = value as Record<string, unknown>;
  const extract = (camel: string, snake: string): number => {
    const raw = input[camel] ?? input[snake];
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) throw new Error(`baseline counts.${camel} must be a non-negative integer`);
    return raw;
  };
  return {
    sites: extract('sites', 'sites'),
    siteDomains: extract('siteDomains', 'site_domains'),
    databases: extract('databases', 'databases'),
  };
}

export async function loadBaselineCounts(filePath: string): Promise<BaselineCounts> {
  const { readFile } = await import('node:fs/promises');
  return parseBaselineCounts(JSON.parse(await readFile(filePath, 'utf8')));
}

void isModxPreset;
